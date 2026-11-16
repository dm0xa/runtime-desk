import { memo, useEffect, useMemo, useRef, useState } from "react";
import { Select } from "./Select";
import { CheckIcon, ChevronDownIcon, ChevronUpIcon, CopyIcon, XIcon } from "./icons";
import { RefreshIcon } from "./RefreshIcon";
import { Dialog } from "./Dialog";
import { Highlight } from "./Highlight";
import { isKubernetesName } from "../lib/origin";

type LogLine = { n: number; time: string; text: string; level: "error" | "warn" | "info" | null };

/** Lines mounted at once; a longer tail is read page by page. */
const LOG_PAGE = 500;

/** Docker prefixes each line with an RFC3339 timestamp; ANSI colour codes come from
 *  the app inside the container and only add noise here. */
const TS = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\s?(.*)$/;
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

function parseLines(raw: string): LogLine[] {
  return (typeof raw === "string" ? raw : "")
    .replace(ANSI, "")
    .replace(/\r\n/g, "\n")
    .split("\n")
    .filter((line, i, all) => line.length > 0 || i < all.length - 1)
    .map((line, i) => {
      const m = TS.exec(line);
      const body = (m ? m[2] : line).replace(ANSI, "");
      const level = /\b(FATAL|ERROR|ERR|PANIC|EXCEPTION)\b/i.test(body)
        ? "error"
        : /\b(WARN|WARNING)\b/i.test(body)
          ? "warn"
          : /\b(INFO|NOTICE)\b/i.test(body)
            ? "info"
            : null;
      return { n: i + 1, time: m ? m[1].slice(11, 23) : "", text: body, level };
    });
}

/** One rendered line. Memoized because a 5 000-line tail is rebuilt on every cursor move
 *  and every keystroke otherwise, and only the two lines that changed need to re-render. */
const LogRow = memo(function LogRow({ line, query, hit, current }: {
  line: LogLine;
  query: string;
  hit: number | undefined;
  current: boolean;
}) {
  return (
    <div
      className={`log-line ${line.level ? `log-${line.level}` : ""} ${current ? "current" : ""}`}
      data-hit={hit}
    >
      <span className="log-n">{line.n}</span>
      {line.time && <span className="log-ts">{line.time}</span>}
      <span className="log-text"><Highlight text={line.text} query={query} /></span>
    </div>
  );
});

export function LogsModal({ name, tail, onClose, onLoad }: {
  name: string;
  tail: number;
  onClose: () => void;
  onLoad: (tail: number) => Promise<string>;
}) {
  const [raw, setRaw] = useState("");
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [onlyMatches, setOnlyMatches] = useState(false);
  const [wrap, setWrap] = useState(false);
  const [lines, setLines] = useState<number>(tail);
  const [cursor, setCursor] = useState(0);
  const [copied, setCopied] = useState(false);
  // 5 000 lines at four nodes each is 20 000 elements mounted before the first paint; a page
  // of 500 covers several screens, and `Match only` still filters the whole tail.
  const [shown, setShown] = useState(LOG_PAGE);
  const bodyRef = useRef<HTMLDivElement>(null);

  async function load(size: number) {
    setLoading(true);
    setRaw(await onLoad(size));
    setLoading(false);
  }
  useEffect(() => { void load(lines); }, [lines]);

  const parsed = useMemo(() => parseLines(raw), [raw]);
  const needle = query.trim().toLowerCase();
  // One pass for both answers: the match list drives jump/only-matches, the index stamps each
  // row for scrolling. Two passes over a 5000-line tail was two full lowercases per keystroke.
  const { matches, hitIndex } = useMemo(() => {
    const found: LogLine[] = [];
    const index = new Map<number, number>();
    if (needle) {
      for (const line of parsed) {
        if (line.text.toLowerCase().includes(needle)) {
          index.set(line.n, found.length);
          found.push(line);
        }
      }
    }
    return { matches: found, hitIndex: index };
  }, [parsed, needle]);
  const visible = onlyMatches && needle ? matches : parsed;

  useEffect(() => { setCursor(0); }, [needle, onlyMatches]);
  useEffect(() => { setShown(LOG_PAGE); }, [visible]);

  function jump(delta: number) {
    if (!needle || matches.length === 0) return;
    const next = (cursor + delta + matches.length) % matches.length;
    setCursor(next);
    const line = matches[next];
    const reveal = (index: number, attempt = 0) => {
      const target = bodyRef.current?.querySelector<HTMLElement>(`[data-hit="${next}"]`);
      if (target) {
        target.scrollIntoView({ block: "center" });
        return;
      }
      // The match sits past the mounted page: grow the page to it, then scroll next frame.
      if (index < visible.length && attempt < 2) {
        setShown(Math.min(visible.length, index + LOG_PAGE));
        requestAnimationFrame(() => reveal(index, attempt + 1));
      }
    };
    reveal(visible.findIndex((l) => l.n === line.n));
  }

  const currentLine = needle && matches.length ? matches[cursor]?.n : undefined;

  return (
    <Dialog label={`Logs · ${name}`} className="logs-modal" onClose={onClose}>
        <div className="logs-head">
          <div className="logs-title">
            <h2>Logs · {isKubernetesName(name) && <span className="k8s-chip" title="Created by the profile's Kubernetes cluster">k8s</span>}{name}</h2>
            <span className="muted">{loading ? "loading…" : `${visible.length} lines${needle ? ` · ${matches.length} matches` : ""}`}</span>
          </div>
          <div className="logs-actions">
            <Select
              minWidth={96}
              value={String(lines)}
              options={[{ value: "100", label: "100 lines" }, { value: "500", label: "500 lines" }, { value: "1000", label: "1 000 lines" }, { value: "5000", label: "5 000 lines" }]}
              onChange={(v) => setLines(Number(v))}
            />
            <button className="icon-plain" onClick={() => void load(lines)} disabled={loading} aria-label="Reload logs" title="Reload logs">
              <RefreshIcon size={15} spinning={loading} />
            </button>
            <button
              className="icon-plain"
              aria-label="Copy logs"
              title="Copy logs"
              onClick={async () => {
                try {
                  await navigator.clipboard?.writeText(visible.map((l) => `${l.time} ${l.text}`.trim()).join("\n"));
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1200);
                } catch { /* clipboard denied; the text stays selectable */ }
              }}
            >
              {copied ? <CheckIcon size={15} /> : <CopyIcon size={15} />}
            </button>
            <button className="icon-plain" onClick={onClose} aria-label="Close logs" title="Close"><XIcon /></button>
          </div>
        </div>

        <div className="logs-toolbar">
          <input
            className="search logs-search"
            spellCheck={false}
            autoCorrect="off"
            autoCapitalize="off"
            autoComplete="off"
            placeholder="Search logs…"
            aria-label="Search logs"
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
          <button className={`chip ${onlyMatches ? "active" : ""}`} aria-pressed={onlyMatches} onClick={() => setOnlyMatches((v) => !v)} disabled={!needle}>Match only</button>
          <button className={`chip ${wrap ? "active" : ""}`} aria-pressed={wrap} onClick={() => setWrap((v) => !v)}>Wrap</button>
        </div>

        <div ref={bodyRef} className={`logs-body ${wrap ? "wrap" : "nowrap"}`}>
          {visible.length === 0 && <div className="logs-empty">{loading ? "Loading…" : needle ? "No lines match." : "(no output)"}</div>}
          {visible.slice(0, shown).map((l) => (
            <LogRow
              key={l.n}
              line={l}
              query={query.trim()}
              hit={hitIndex.get(l.n)}
              current={currentLine === l.n}
            />
          ))}
          {shown < visible.length && (
            <button className="btn logs-more" onClick={() => setShown((n) => n + LOG_PAGE)}>
              Show {Math.min(LOG_PAGE, visible.length - shown)} of {visible.length - shown} more
            </button>
          )}
        </div>
    </Dialog>
  );
}
