import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { VolumeContents as Listing } from "../types";
import { fmtSize } from "../lib/format";
import { FileIcon, FolderIcon } from "./icons";
import { RefreshIcon } from "./RefreshIcon";

/** Rows drawn before the browser offers the next page. Comfortably past one screen. */
const ENTRY_PAGE = 200;
/** The backend's cap: there is no reason to ask for more than it will send. */
const MAX_PAGE = 5000;

/**
 * One directory level of a volume, read-only through `colima ssh -- sudo find`.
 * Directories navigate in place; nothing here writes to the volume.
 */
export function VolumeContents({ profile, name }: { profile: string; name: string }) {
  // The path belongs to one volume: a profile or volume switch reads as the root again
  // without a second fetch against the previous directory.
  const owner = `${profile}/${name}`;
  const [place, setPlace] = useState({ owner, rel: "" });
  const rel = place.owner === owner ? place.rel : "";
  const key = JSON.stringify([owner, rel]);
  // Each directory level costs one SSH round trip (~0.4 s), so keep the levels already
  // read: walking back up the breadcrumb and revisiting a directory must not pay again.
  // A failed path is never cached, the reload button evicts the current level, and the
  // cache dies with the volume view.
  const listings = useRef(new Map<string, Listing>());
  const [, rerender] = useState(0);
  const [failure, setFailure] = useState<{ key: string; message: string } | null>(null);
  const [nonce, setNonce] = useState(0);
  const listing = listings.current.get(key) ?? null;
  const error = failure?.key === key ? failure.message : null;
  // A node_modules-sized directory can hold thousands of entries; drawing all of them — or
  // even sending them across the IPC boundary — wastes both. A level asks for one page plus
  // a sentinel row that proves there is more, and "Show N more" asks for a bigger page.
  const [reveal, setReveal] = useState({ key, n: ENTRY_PAGE });
  const shown = reveal.key === key ? reveal.n : ENTRY_PAGE;
  const wanted = Math.min(shown + 1, MAX_PAGE);

  useEffect(() => {
    if (!name) return;
    const cached = listings.current.get(key);
    // Enough rows already in hand: either the page, or the whole directory.
    if (cached && (cached.entries.length >= wanted || !cached.truncated)) return;
    let alive = true;
    invoke<Listing>("volume_contents_cmd", { profile, name, path: rel, limit: wanted })
      .then((next) => {
        if (!alive) return;
        if (listings.current.size >= 16) {
          const oldest = listings.current.keys().next().value;
          if (oldest !== undefined) listings.current.delete(oldest);
        }
        listings.current.set(key, next);
        rerender((n) => n + 1);
      })
      .catch((e) => { if (alive) setFailure({ key, message: String(e) }); });
    return () => { alive = false; };
  }, [profile, name, rel, key, nonce, wanted]);

  const reload = () => {
    listings.current.delete(key);
    setNonce((n) => n + 1);
  };

  const crumbs = rel ? rel.split("/") : [];
  const count = listing?.entries.length ?? 0;
  const more = shown < count || !!listing?.truncated;

  return (
    <section className="panel inv-wide">
      <div className="inv-panel-head">
        <h3>Contents {listing && <span className="inv-count">{count}</span>}</h3>
        <span className="muted inv-note">read-only · via colima ssh</span>
        <button
          className="icon-plain"
          onClick={reload}
          aria-label="Reload contents"
          title="Reload contents"
        >
          <RefreshIcon size={15} />
        </button>
      </div>

      <nav className="inv-breadcrumb" aria-label="Volume path" title={listing?.root}>
        {crumbs.length === 0
          ? <span className="inv-crumb current">{name}</span>
          : <button className="inv-crumb" onClick={() => setPlace({ owner, rel: "" })}>{name}</button>}
        {crumbs.map((part, i) => (
          <span className="inv-breadcrumb-step" key={`${i}-${part}`}>
            <span className="inv-crumb-sep">/</span>
            {i === crumbs.length - 1
              ? <span className="inv-crumb current">{part}</span>
              : <button className="inv-crumb" onClick={() => setPlace({ owner, rel: crumbs.slice(0, i + 1).join("/") })}>{part}</button>}
          </span>
        ))}
      </nav>

      {listing ? (
        listing.entries.length === 0 ? (
          <p className="muted">empty directory</p>
        ) : (
          <>
            <div className="inv-files">
              {listing.entries.slice(0, shown).map((entry) => {
                const dir = entry.kind === "dir";
                const label = (
                  <>
                    {dir ? <FolderIcon size={15} /> : <FileIcon size={15} />}
                    <span className="inv-file-name" title={entry.name}>
                      {entry.name}
                      {entry.kind === "link" && entry.link ? ` → ${entry.link}` : ""}
                    </span>
                  </>
                );
                return (
                  <div
                    className="inv-file-row"
                    key={entry.name}
                    title={`${entry.user}:${entry.group} · ${entry.mode} · ${entry.kind}`}
                  >
                    {dir ? (
                      <button className="inv-file-name-btn" onClick={() => setPlace({ owner, rel: [...crumbs, entry.name].join("/") })}>
                        {label}
                      </button>
                    ) : (
                      <span className="inv-file-name-btn static">{label}</span>
                    )}
                    <span className="inv-file-size">{dir ? "—" : fmtSize(entry.size)}</span>
                    <span className="inv-file-when">
                      {entry.modified ? entry.modified.replace("T", " ").replace(/\.\d+$/, "") : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
            {more && (
              <button className="btn inv-more" onClick={() => setReveal({ key, n: Math.min(shown + ENTRY_PAGE, MAX_PAGE) })}>
                Show {Math.min(ENTRY_PAGE, MAX_PAGE - shown)} more
              </button>
            )}
            {listing.truncated && <p className="muted">{shown} shown · more in this directory</p>}
          </>
        )
      ) : error ? (
        <p className="muted">{error}</p>
      ) : (
        <p className="muted">reading…</p>
      )}
    </section>
  );
}
