import { invoke } from "@tauri-apps/api/core";

export type PortMapping = {
  raw: string;
  /** Host interface the port is published on, if any. */
  host: string | null;
  /** Published host port; null for exposed-only or ranged mappings. */
  hostPort: string | null;
  target: string;
  proto: string;
};

const HOST = String.raw`(\[[^\]]+\]|[\d.:]+)`;

// Compiled once: `parsePorts` runs per row and per render, and a `new RegExp` inside the
// mapper cost two pattern builds per published port on every keystroke in the list filter.
const MAPPED_PORT = new RegExp(`^${HOST}:(\\d+)->(\\d+)/(\\w+)$`);
const RANGE_PORT = new RegExp(`^${HOST}:(\\d+-\\d+)->(\\d+-\\d+)/(\\w+)$`);
const PLAIN_PORT = /^(\d+)->(\d+)\/(\w+)$/;
const EXPOSED_PORT = /^(\d+(?:-\d+)?)\/(\w+)$/;

/**
 * Parses `docker ps`/`nerdctl ps` port strings such as
 * `0.0.0.0:8080->80/tcp, 127.0.0.1:32769->9223/tcp, 443/tcp`.
 */
export function parsePorts(raw: string): PortMapping[] {
  return raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((seg) => {
      const mapped = seg.match(MAPPED_PORT);
      if (mapped) return { raw: seg, host: mapped[1], hostPort: mapped[2], target: mapped[3], proto: mapped[4] };
      const range = seg.match(RANGE_PORT);
      if (range) return { raw: seg, host: range[1], hostPort: null, target: range[2], proto: range[4] };
      const noHost = seg.match(PLAIN_PORT);
      if (noHost) return { raw: seg, host: null, hostPort: noHost[1], target: noHost[2], proto: noHost[3] };
      const exposed = seg.match(EXPOSED_PORT);
      if (exposed) return { raw: seg, host: null, hostPort: null, target: exposed[1], proto: exposed[2] };
      return { raw: seg, host: null, hostPort: null, target: seg, proto: "" };
    });
}

/** How the port is published: LAN-reachable, loopback only, or IPv6-all. A chip that only
 *  says `8080→80` cannot tell those apart, and the difference is a security fact. */
export function bindingLabel(p: PortMapping): string {
  if (!p.host) return p.hostPort ? "all interfaces" : "exposed only";
  if (p.host === "0.0.0.0" || p.host === "[::]" || p.host === "::") return "all interfaces";
  if (p.host === "127.0.0.1" || p.host === "[::1]") return "loopback only";
  return `on ${p.host}`;
}

/** Loopback URL for a published TCP port, or null when the mapping cannot be opened. */
export function localUrl(p: PortMapping): string | null {
  if (p.proto !== "tcp" || !p.hostPort) return null;
  const host = !p.host || p.host === "0.0.0.0" || p.host === "::" || p.host === "[::]" ? "localhost" : p.host.replace(/^\[|\]$/g, "");
  return `http://${host}:${p.hostPort}`;
}

export async function openPort(p: PortMapping) {
  const url = localUrl(p);
  if (url) await invoke("open_url_cmd", { url });
}

/** Port chips; published TCP ports open in the browser. A row that publishes more than a few
 *  ports draws the first ones and a `+N` badge: eight chips per row measured 10 640 DOM nodes
 *  for 200 containers and pushed a tab switch from 45 ms to ~95 ms, while the full list is
 *  still in the badge's title. */
export function PortChips({ ports, empty = "—", max = 3 }: { ports: string; empty?: string; max?: number }) {
  const mappings = parsePorts(ports);
  if (mappings.length === 0) return <span className="muted">{empty}</span>;
  const shown = mappings.slice(0, max);
  const hidden = mappings.length - shown.length;
  return (
    <div className="port-chips">
      {shown.map((p, idx) => {
        const url = localUrl(p);
        const loopback = bindingLabel(p) === "loopback only";
        const label = (
          <>
            {loopback && <span className="port-scope" aria-label="loopback only">lo</span>}
            {p.hostPort && <span>{p.hostPort}</span>}
            {p.hostPort && <span className="arrow">→</span>}
            <span>{p.target}{!p.hostPort && p.proto ? `/${p.proto}` : ""}</span>
          </>
        );
        return url ? (
          <button
            key={idx}
            type="button"
            className="port-chip clickable"
            title={`${url} · ${bindingLabel(p)}${p.host ? ` (${p.host})` : ""} · click to open`}
            onClick={(e) => { e.stopPropagation(); void openPort(p); }}
          >
            {label}
          </button>
        ) : (
          <span key={idx} className={`port-chip ${p.hostPort ? "" : "exposed"}`} title={`${p.raw} · ${bindingLabel(p)}`}>
            {label}
          </span>
        );
      })}
      {hidden > 0 && (
        <span className="port-chip exposed" title={mappings.map((p) => p.raw).join(", ")}>+{hidden}</span>
      )}
    </div>
  );
}
