import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Dialog } from "./Dialog";
import { Highlight } from "./Highlight";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, XIcon } from "./icons";
import { RefreshIcon } from "./RefreshIcon";

type JsonLine = { n: number; text: string };

/** One inspect sheet's subject: the object, the command that answers for it, and the
 *  payload or the failure. The command stays so the window can re-run itself. */
export type InspectTarget = { kind: string; name: string; cmd: string; args: Record<string, unknown>; raw: string | null; error: string | null };

/** The Inspect sheet is the Logs window for one payload: same chrome, same search,
 *  same line numbers. It portals to the body because it is opened from table rows,
 *  where a fixed sheet would be clipped by the cell. */
export function InspectModal({ kind, name, raw, error, onReload, onClose }: {
  kind: string;
  name: string;
  /** Pretty-printed inspect output; `null` while the command runs. */
  raw: string | null;
  error?: string | null;
  onReload?: () => void;
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [wrap, setWrap] = useState(true);
  const [cursor, setCursor] = useState(0);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLDivElement>(null);

  const loading = raw === null && !error;
  const parsed = useMemo<JsonLine[]>(
    () => (raw === null ? [] : raw.replace(/\r\n/g, "\n").split("\n").map((text, i) => ({ n: i + 1, text }))),
    [raw],
  );
  const needle = query.trim().toLowerCase();
  const matches = useMemo(
    () => (needle ? parsed.filter((l) => l.text.toLowerCase().includes(needle)) : []),
    [parsed, needle],
  );
  useEffect(() => { setCursor(0); }, [needle]);

  const hitIndex = useMemo(() => {
    const map = new Map<number, number>();
    if (needle) {
      let i = 0;
      for (const l of parsed) if (l.text.toLowerCase().includes(needle)) map.set(l.n, i++);
    }
    return map;
  }, [parsed, needle]);

  function jump(delta: number) {
    if (!needle || matches.length === 0) return;
    const next = (cursor + delta + matches.length) % matches.length;
    setCursor(next);
    bodyRef.current?.querySelector<HTMLElement>(`[data-hit="${next}"]`)?.scrollIntoView({ block: "center" });
  }

  const currentLine = needle && matches.length ? matches[cursor]?.n : undefined;

  return createPortal(
    <Dialog label={`Inspect · ${name}`} className="logs-modal inspect-modal" onClose={onClose}>
      <div className="logs-head">
        <div className="logs-title">
          <h2>Inspect · {name}</h2>
          <span className="muted">
            {error ? "inspect failed" : loading ? "reading…" : `${kind} · ${parsed.length} lines${needle ? ` · ${matches.length} matches` : ""}`}
          </span>
        </div>
        <div className="logs-actions">
          {onReload && (
            <button className="icon-plain" onClick={onReload} disabled={loading} aria-label="Re-inspect" title="Re-inspect">
              <RefreshIcon size={15} spinning={loading} />
            </button>
          )}
          <button
            className="icon-plain"
            aria-label="Copy JSON"
            title="Copy JSON"
            disabled={raw === null}
            onClick={async () => {
              try {
                await navigator.clipboard?.writeText(raw ?? "");
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              } catch { /* clipboard denied; the text stays selectable */ }
            }}
          >
            {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
          </button>
          <button className="icon-plain" onClick={onClose} aria-label="Close inspect" title="Close"><XIcon /></button>
        </div>
      </div>

      <div className="logs-toolbar">
        <input
          className="search logs-search"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          placeholder="Search JSON…"
          aria-label="Search JSON"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") { e.preventDefault(); jump(e.shiftKey ? -1 : 1); }
          }}
        />
        {needle && (
          <>
            <span className="logs-count">{matches.length ? `${cursor + 1}/${matches.length}` : "0 matches"}</span>
            <button className="icon-btn" onClick={() => jump(-1)} disabled={!matches.length} aria-label="Previous match"><ChevronUpIcon size={14} /></button>
            <button className="icon-btn" onClick={() => jump(1)} disabled={!matches.length} aria-label="Next match"><ChevronDownIcon size={14} /></button>
          </>
        )}
        <button className={`chip ${wrap ? "active" : ""}`} aria-pressed={wrap} onClick={() => setWrap((v) => !v)}>Wrap</button>
      </div>

      <div ref={bodyRef} className={`logs-body ${wrap ? "wrap" : "nowrap"}`}>
        {error ? (
          <div className="logs-empty">{error}</div>
        ) : loading ? (
          <div className="logs-empty">Loading…</div>
        ) : parsed.length === 0 ? (
          <div className="logs-empty">(no output)</div>
        ) : (
          parsed.map((l) => (
            <div
              key={l.n}
              className={`log-line ${currentLine === l.n ? "current" : ""}`}
              data-hit={hitIndex.get(l.n)}
            >
              <span className="log-n">{l.n}</span>
              <span className="log-text"><Highlight text={l.text} query={query.trim()} /></span>
            </div>
          ))
        )}
      </div>
    </Dialog>,
    document.body,
  );
}
