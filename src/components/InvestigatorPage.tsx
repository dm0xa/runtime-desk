import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import type {
  Container,
  ContainerDetail,
  ContainerPort,
  ContainerStat,
  Image,
  ImageDetail,
  Network,
  NetworkDetail,
  NetworkMapEntry,
  Volume,
  VolumeDetail,
  VolumeSize,
} from "../types";
import { fmtBytes, fmtDateTime, fmtSize, fmtSpan, parseHumanBytes } from "../lib/format";
import { isKubernetesName } from "../lib/origin";
import { startStatsStream } from "../lib/stats";
import { activitySeriesFor, activitySnapshot, subscribeActivity, type ActivitySnapshot } from "../lib/activity";
import { PRESSURE_PCT } from "../lib/memoryGuard";
import { useLiveWindow } from "../lib/liveWindow";
import { addTag, removeTag, subscribeTags, tagsFor, type TagKind } from "../lib/tags";
import { PortChips } from "./PortChips";
import { VolumeContents } from "./VolumeContents";
import { FactsGroup, Row } from "./Facts";
import { GroupStackChart } from "./GroupChart";
import { ChartAxis } from "./ChartAxis";
import { WindowSwitch } from "./WindowSwitch";
import { ArrowUpRightIcon, BracesIcon, FingerprintIcon, PlayIcon, RestartIcon, SlidersIcon, TerminalIcon } from "./icons";
import { InspectModal, type InspectTarget } from "./InspectModal";
import { RefreshIcon } from "./RefreshIcon";
import { Sparkline } from "./Sparkline";

export type Subject = { kind: "container" | "image" | "volume" | "network" | "group"; id: string; runtime?: "docker" | "podman" };

type Props = {
  /** null renders the picker; a subject renders everything attached to it. */
  subject: Subject | null;
  containers: Container[];
  images: Image[];
  volumes: Volume[];
  networks: Network[];
  netMap: NetworkMapEntry[];
  daemonUp: boolean;
  profile: string;
  /** Bumped by the header's Refresh so the detail and live sample reload. */
  refreshNonce: number;
  /** The profile's VM memory in bytes: a project's memory is otherwise a number without a ceiling. */
  vmMemory: number;
  /** Image id (without `sha256:`) to architecture, from the batched `image inspect` the Images table pays for. */
  imageArch: Record<string, string>;
  /** The same batch's repo digest per image id: the name that survives a retag. */
  imageDigest: Record<string, string>;
  /** Volume sizes from the shared `system df -v` scan. */
  volSizes: VolumeSize[];
  onPick: (subject: Subject) => void;
  onNavigate: (subject: Subject) => void;
  onOpenContainers: (search?: string) => void;
  onOpenNetwork: (network: string, names: string[]) => void;
  onOpenLogs: (container: Container) => void;
  /** Opens the memory-limit dialog, the in-app way out of an imminent OOM kill. */
  onSetMemoryLimit: (target: { id: string; name: string; used: number; current: number }) => void;
  /** Start/restart a member from the health table, so a flagged row is fixable in place. */
  onContainerAction: (id: string, action: "start" | "stop" | "restart") => void;
};

/** Seconds → "3d 4h" / "2h 14m" / "41s". */
const dur = (seconds: number) => {
  if (!Number.isFinite(seconds) || seconds < 0) return "—";
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${Math.floor(seconds % 60)}s`;
  return `${Math.floor(seconds)}s`;
};

/** Docker writes the zero time for "never"; treat pre-1970 timestamps as absent. */
const rel = (iso: string) => {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at) || at < 0) return "—";
  const seconds = (Date.now() - at) / 1000;
  if (seconds < 0) return "just now";
  return `${dur(seconds)} ago`;
};

const startedOf = (iso: string) => {
  if (!iso) return "—";
  const at = Date.parse(iso);
  if (Number.isNaN(at) || at < 0) return "—";
  return fmtDateTime(iso);
};

const SECRET_KEY = /(SECRET|TOKEN|PASSW|PASSWORD|API[_-]?KEY|_KEY$|CREDENTIAL|AUTH|PRIVATE|SESSION)/i;
/** The stream is one sample per second; ten minutes is the longest window a view draws. */
const TREND_SAMPLES = 600;
/** Fewer points than this draw a flat baseline, not a trend, so the card shows a placeholder. */
const TREND_MIN_POINTS = 10;
/** Fallback cadence, in milliseconds, when the live stream cannot start or dies. */
const POLL_MS = 5000;
/** Until the chart draws, count down to it instead of implying a two-minute wait. */
const collecting = (n: number, stepSeconds: number) =>
  `collecting · chart in ${Math.round(Math.max(0, TREND_MIN_POINTS - n) * stepSeconds)} s`;
const maskable = (k: string) => SECRET_KEY.test(k);

/** Host paths have no spaces, so a long one wraps mid-word. Allow a break after each separator. */
function pathWithBreaks(path: string): ReactNode {
  const parts = path.split("/");
  return parts.map((part, i) => (i === 0 ? <Fragment key={i}>{part}</Fragment>
    : <Fragment key={i}><wbr />/{part}</Fragment>));
}

/** Docker's ps port string from structured bindings, so PortChips can open the URL. */
function portString(ports: ContainerPort[]): string {
  return ports
    .map((p) => (p.host_port ? `${p.host_ip || "0.0.0.0"}:${p.host_port}->${p.container}/${p.proto}` : `${p.container}/${p.proto}`))
    .join(", ");
}

/** Everything Docker knows about an env set, with secret-looking values masked. */
function KeyValuePanel({ title, pairs, note, limit = 12 }: { title: string; pairs: [string, string][]; note?: string; limit?: number }) {
  const [reveal, setReveal] = useState(false);
  const [expanded, setExpanded] = useState(false);
  if (pairs.length === 0) return null;
  const hidden = pairs.filter(([k]) => maskable(k)).length;
  const shown = expanded ? pairs : pairs.slice(0, limit);
  return (
    <section className="panel inv-wide">
      <div className="inv-panel-head">
        <h3>{title} <span className="inv-count">{pairs.length}</span></h3>
        {note && <span className="muted inv-note">{note}</span>}
        {hidden > 0 && (
          <button className="btn" onClick={() => setReveal((r) => !r)}>
            {reveal ? "Hide secrets" : `Show ${hidden} secret${hidden === 1 ? "" : "s"}`}
          </button>
        )}
      </div>
      <div className="inv-pairs">
        {shown.map(([k, v]) => {
          const masked = maskable(k) && !reveal;
          return (
            <div className="inv-pair" key={k}>
              <code className="inv-pair-key">{k}</code>
              <code className="inv-pair-value">{masked ? "••••••••" : v || "—"}</code>
            </div>
          );
        })}
      </div>
      {pairs.length > limit && (
        <button className="btn inv-more" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show less" : `Show all ${pairs.length}`}
        </button>
      )}
    </section>
  );
}

/** One origin's worth of labels: what the image declared, or what was attached at creation. */
type LabelGroup = { title: string; pairs: [string, string][] };

/** Labels grouped by where they were set. Docker hands a container one merged
 *  `Config.Labels`, so the split only appears once the image's own set is known. */
function LabelsPanel({ groups, note, limit = 10 }: { groups: LabelGroup[]; note?: string; limit?: number }) {
  const [reveal, setReveal] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const present = groups.filter((g) => g.pairs.length > 0);
  const total = present.reduce((n, g) => n + g.pairs.length, 0);
  if (total === 0) return null;
  const hidden = present.reduce((n, g) => n + g.pairs.filter(([k]) => maskable(k)).length, 0);
  // One budget across groups, so the first ten rows are the same ten a flat list showed.
  let budget = expanded ? Infinity : limit;
  return (
    <section className="panel inv-wide">
      <div className="inv-panel-head">
        <h3>Labels <span className="inv-count">{total}</span></h3>
        {note && <span className="muted inv-note">{note}</span>}
        {hidden > 0 && (
          <button className="btn" onClick={() => setReveal((r) => !r)}>
            {reveal ? "Hide secrets" : `Show ${hidden} secret${hidden === 1 ? "" : "s"}`}
          </button>
        )}
      </div>
      {present.map((group) => {
        if (budget <= 0) return null;
        const rows = expanded ? group.pairs : group.pairs.slice(0, budget);
        budget -= rows.length;
        return (
          <div className="inv-label-group" key={group.title}>
            {groups.length > 1 && (
              <div className="inv-sub-label">{group.title}<span className="inv-count">{group.pairs.length}</span></div>
            )}
            <div className="inv-pairs one">
              {rows.map(([k, v]) => (
                <div className="inv-pair" key={k}>
                  <code className="inv-pair-key">{k}</code>
                  <code className="inv-pair-value">{maskable(k) && !reveal ? "••••••••" : v || "—"}</code>
                </div>
              ))}
            </div>
          </div>
        );
      })}
      {total > limit && (
        <button className="btn inv-more" onClick={() => setExpanded((e) => !e)}>
          {expanded ? "Show less" : `Show all ${total}`}
        </button>
      )}
    </section>
  );
}

function BuildHistory({ layers }: { layers: { created: string; size: string; command: string }[] }) {
  const [all, setAll] = useState(false);
  const limit = 10;
  const shown = all ? layers : layers.slice(0, limit);
  return (
    <section className="panel inv-wide">
      <div className="inv-panel-head">
        <h3>Build history <span className="inv-count">{layers.length}</span></h3>
        <span className="muted inv-note">newest first, from the local layer cache</span>
      </div>
      {layers.length ? (
        <div className="inv-history">
          {shown.map((h, idx) => (
            <div className="inv-history-row" key={`${h.created}-${idx}`}>
              <span className="muted inv-history-when">{h.created}</span>
              <span className="inv-history-size">{h.size || "—"}</span>
              <code className="inv-history-cmd" title={h.command}>{h.command || "—"}</code>
            </div>
          ))}
        </div>
      ) : <p className="muted">history is not exposed by this container client</p>}
      {layers.length > limit && (
        <button className="btn inv-more" onClick={() => setAll((a) => !a)}>
          {all ? "Show less" : `Show all ${layers.length}`}
        </button>
      )}
    </section>
  );
}

function HealthCard({ detail }: { detail: ContainerDetail | null }) {
  return (
    <section className="panel">
      <h3>Health</h3>
      {!detail ? (
        <p className="muted">Reading health…</p>
      ) : detail.health_test ? (
        <>
          <Row label="Status">{detail.health || "unknown"}</Row>
          <Row label="Schedule">
            {detail.health_interval ? `${detail.health_interval / 1e9}s interval` : "—"}
            <span className="muted">
              {` · ${detail.health_timeout ? `${detail.health_timeout / 1e9}s timeout` : "no timeout"} · ${detail.health_retries || 0} retries`}
            </span>
          </Row>
          {detail.health_log.length > 0 && (() => {
            const last = detail.health_log[detail.health_log.length - 1];
            return (
              <Row label="Last probe">
                <span className={last.exit_code === 0 ? "inv-ok" : "inv-bad"}>{last.exit_code === 0 ? "pass" : `exit ${last.exit_code}`}</span>
                <span className="muted"> · {rel(last.start)}</span>
              </Row>
            );
          })()}
          <details className="inv-details">
            <summary>Check command and recent probes</summary>
            <div className="inv-code-line" title={detail.health_test}>{detail.health_test}</div>
            {detail.health_log.map((p) => (
              <div className="inv-row" key={p.start}>
                <span className="muted">{fmtDateTime(p.start)}</span>
                <span className={p.exit_code === 0 ? "inv-ok" : "inv-bad"}>
                  {p.exit_code === 0 ? "pass" : `exit ${p.exit_code}`}{p.output ? ` · ${p.output}` : ""}
                </span>
              </div>
            ))}
          </details>
        </>
      ) : <p className="muted">No health check declared.</p>}
    </section>
  );
}

/** First paint of Performance: `docker stats` has not answered yet, so the cards show their
 * shape instead of a chart with nothing in it. Mirrors the Volumes/Cleanup skeletons. */
function PerformanceSkeleton() {
  return (
    <div aria-hidden="true">
      <div className="trend-grid">
        {Array.from({ length: 3 }, (_, i) => (
          <div className="trend-card" key={i}>
            <div className="trend-head">
              <span className="cleanup-skeleton skeleton-label" />
              <span className="cleanup-skeleton" style={{ width: 52, height: 16 }} />
            </div>
            <span className="spark-skeleton" />
            <span className="cleanup-skeleton skeleton-sub" />
          </div>
        ))}
      </div>
      <div className="inv-metrics">
        {Array.from({ length: 2 }, (_, i) => (
          <div className="inv-metric" key={i}>
            <span className="cleanup-skeleton skeleton-label" />
            <span className="cleanup-skeleton skeleton-value" />
            <span className="cleanup-skeleton skeleton-sub" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Containers that get their own band. The tail is summed into one neutral band, so a
 *  fifty-service project still reads as three charts; the rows below list every member. */
const GROUP_BANDS = 8;

/** Per-sample rate from a cumulative counter series: the Activity tick is one second. */
function rateSeries(counters: number[]): number[] {
  const out: number[] = [];
  for (let i = 1; i < counters.length; i++) out.push(Math.max(0, counters[i] - counters[i - 1]));
  return out;
}

/** Sums right-aligned series, so lists that started at different times end on the same sample. */
function sumAligned(lists: number[][]): number[] {
  const length = Math.max(0, ...lists.map((l) => l.length));
  const out = new Array<number>(length).fill(0);
  for (const list of lists) for (let i = 0; i < list.length; i++) out[length - list.length + i] += list[i];
  return out;
}

/** The shared Activity stream, read once per page: every group panel draws the same second.
 *  Only the group page subscribes — a container page has its own stream, and an image or volume
 *  page must not re-render once a second for numbers it never draws. */
function useActivitySnapshot(active: boolean): ActivitySnapshot {
  const [snap, setSnap] = useState<ActivitySnapshot>(() => activitySnapshot());
  useEffect(() => {
    if (!active) return;
    setSnap(activitySnapshot());
    return subscribeActivity(() => setSnap(activitySnapshot()));
  }, [active]);
  return snap;
}

/** A compose project's member containers with the numbers the shared Activity stream already
 *  samples: the group page adds no `docker stats` child of its own. */
function GroupPerformance({ members, snap, vmMemory, onNavigate }: {
  members: Container[];
  snap: ActivitySnapshot;
  /** VM memory in bytes: a project's memory is only meaningful against its ceiling. */
  vmMemory: number;
  onNavigate: (subject: Subject) => void;
}) {

  const statByMember = new Map<string, ContainerStat>();
  for (const s of snap.stats) {
    const hit = members.find((m) => m.id === s.id || (s.id && m.id.startsWith(s.id)));
    if (hit) statByMember.set(hit.id, s);
  }
  const win = useLiveWindow();
  // One series per container, shared by all three charts and by the rows below. The store keeps
  // ten minutes; the switch chooses how much of it this page draws.
  const series = members.map((m) => {
    const recorded = activitySeriesFor(statByMember.get(m.id)?.id ?? m.id);
    return {
      m,
      cpu: recorded.cpu.slice(-win),
      mem: recorded.mem.slice(-win),
      rx: rateSeries(recorded.netRx).slice(-win),
      tx: rateSeries(recorded.netTx).slice(-win),
      read: rateSeries(recorded.blkRead).slice(-win),
      write: rateSeries(recorded.blkWrite).slice(-win),
    };
  });
  // Rank by the window's CPU peak, not by the instant: a container between spikes keeps its
  // band, or colours would swap places every second and the charts would flicker.
  const ranked = [...series].sort((a, b) =>
    (b.cpu.length ? Math.max(...b.cpu) : 0) - (a.cpu.length ? Math.max(...a.cpu) : 0) || b.cpu.length - a.cpu.length);
  const colorOf = new Map(ranked.slice(0, GROUP_BANDS).map((d, i) => [d.m.id, `var(--seg-${i + 1})`]));
  // Same bands for CPU, memory and network: one colour means one container in all three charts.
  const stack = (metric: "cpu" | "mem" | "rx") => {
    const bands = ranked.slice(0, GROUP_BANDS).map((d, i) => ({
      key: d.m.id, name: d.m.name, color: `var(--seg-${i + 1})`, values: d[metric],
    }));
    const tail = ranked.slice(GROUP_BANDS);
    if (tail.length) {
      bands.push({ key: "__other", name: `Other (${tail.length})`, color: "var(--seg-other)", values: sumAligned(tail.map((d) => d[metric])) });
    }
    return bands;
  };

  const running = members.filter((m) => m.state === "running");
  const cpu = running.reduce((n, m) => n + (statByMember.get(m.id)?.cpu ?? 0), 0);
  const mem = running.reduce((n, m) => n + (statByMember.get(m.id)?.mem ?? 0), 0);
  const rx = series.reduce((n, d) => n + (d.rx[d.rx.length - 1] ?? 0), 0);
  const tx = series.reduce((n, d) => n + (d.tx[d.tx.length - 1] ?? 0), 0);
  const txTotal = sumAligned(ranked.map((d) => d.tx));
  /** Project-wide disk and process cost: the same facts the container page carries, summed. */
  const readNow = series.reduce((n, d) => n + (d.read[d.read.length - 1] ?? 0), 0);
  const writeNow = series.reduce((n, d) => n + (d.write[d.write.length - 1] ?? 0), 0);
  const pids = running.reduce((n, m) => n + (statByMember.get(m.id)?.pids ?? 0), 0);
  /** Memory the rest of the daemon holds: the project is only one tenant of the VM. */
  const allMem = snap.stats.reduce((n, s) => n + s.mem, 0);
  const otherMem = Math.max(0, allMem - mem);
  const samples = Math.max(0, ...ranked.map((d) => d.cpu.length));
  const reading = snap.at === 0 && !snap.error;
  /** Seconds the shared series holds inside the selected window. The axis and the header both
   *  print this, so a half-filled chart never claims the full two or ten minutes. */
  const spanSeconds = Math.min(samples, win);
  const windowNote = samples >= win
    ? `last ${fmtSpan(win)}`
    : `${fmtSpan(spanSeconds)} recorded`;

  return (
    <section className="panel inv-wide" aria-busy={reading}>
      <div className="inv-panel-head">
        <h3>Performance <span className="inv-count">{members.length}</span></h3>
        <span className="muted inv-note">
          {snap.error ? "live numbers unavailable" : reading ? "reading live numbers…" : `live · 1 s samples · ${windowNote}`}
        </span>
        <div className="inv-head-tools"><WindowSwitch /></div>
      </div>
      {members.length === 0 ? (
        <p className="muted">No containers carry this project name any more.</p>
      ) : (
        <>
          <div className="trend-grid group-trends">
            <div className="trend-card wide">
              <div className="trend-head">
                <span className="inv-metric-label">CPU</span>
                <span className="trend-value">{reading ? "—" : `${cpu.toFixed(1)}%`}</span>
              </div>
              <GroupStackChart
                bands={stack("cpu")}
                slots={win}
                label={`CPU across ${members.length} containers`}
                format={(v) => `${v.toFixed(1)}%`}
                floor={100}
              />
              <ChartAxis seconds={spanSeconds} />
              <span className="inv-metric-sub">{running.length} of {members.length} running · scale 100% = one core</span>
            </div>
            <div className="trend-card">
              <div className="trend-head">
                <span className="inv-metric-label">Memory</span>
                <span className="trend-value">{reading ? "—" : fmtBytes(mem)}</span>
              </div>
              <GroupStackChart
                bands={stack("mem")}
                slots={win}
                label={`Memory across ${members.length} containers`}
                format={(v) => fmtBytes(v)}
              />
              <ChartAxis seconds={spanSeconds} />
              <span className="inv-metric-sub">
                {vmMemory > 0 ? `of ${fmtBytes(vmMemory)} VM (${((mem / vmMemory) * 100).toFixed(1)}%) · ` : ""}
                {vmMemory > 0 && !reading ? `${otherMem > 0 ? `${fmtBytes(otherMem)} in other containers · ` : ""}` : ""}
                stacked per container
              </span>
            </div>
            <div className="trend-card">
              <div className="trend-head">
                <span className="inv-metric-label">Network</span>
                <span className="trend-value">{reading ? "—" : `${fmtSize(rx)}/s`}</span>
              </div>
              <GroupStackChart
                bands={stack("rx")}
                slots={win}
                label={`Network receive across ${members.length} containers`}
                format={(v) => `${fmtSize(v)}/s`}
                secondary={txTotal}
                secondaryLabel={`Transmit ${fmtSize(tx)}/s`}
              />
              <ChartAxis seconds={spanSeconds} />
              <span className="inv-metric-sub">receive stacked · transmit dashed · {fmtSize(tx)}/s up</span>
            </div>
          </div>
          <div className="inv-metrics">
            <div className="inv-metric">
              <span className="inv-metric-label">Block I/O</span>
              <span className="inv-metric-value">{reading ? "—" : `${fmtSize(readNow)}/s read`}</span>
              <span className="inv-metric-sub">{reading ? "" : `${fmtSize(writeNow)}/s written · across ${running.length} running`}</span>
            </div>
            <div className="inv-metric">
              <span className="inv-metric-label">Processes</span>
              <span className="inv-metric-value">{reading ? "—" : pids}</span>
              <span className="inv-metric-sub">pids in this project</span>
            </div>
          </div>
          <div className="inv-group group-members">
            {members.map((m) => {
              const stat = statByMember.get(m.id);
              const data = series.find((d) => d.m.id === m.id);
              const color = colorOf.get(m.id);
              const rxNow = data?.rx[data.rx.length - 1] ?? 0;
              const txNow = data?.tx[data.tx.length - 1] ?? 0;
              return (
                <div className="inv-member-row" key={m.id}>
                  <span
                    className="group-swatch"
                    style={{ background: color ?? "var(--seg-other)" }}
                    title={color ? m.name : "Summed into Other on the charts"}
                  />
                  <span className={`status-badge ${m.state === "running" ? "running" : "stopped"}`}><span className="dot" />{m.state}</span>
                  <button className="inv-link" onClick={() => onNavigate({ kind: "container", id: m.id })}>{m.name}</button>
                  <span className="inv-member-image" title={m.image}>{m.image}</span>
                  <span className="inv-member-num" title="CPU share of one core">{m.state === "running" ? (stat ? `${stat.cpu.toFixed(1)}%` : "—") : ""}</span>
                  <span className="inv-member-num" title="Memory in use">{m.state === "running" ? (stat ? fmtBytes(stat.mem) : "—") : ""}</span>
                  <span className="inv-member-num" title={`${fmtSize(rxNow)}/s receive · ${fmtSize(txNow)}/s transmit`}>{m.state === "running" ? `${fmtSize(rxNow)}/s` : ""}</span>
                </div>
              );
            })}
          </div>
        </>
      )}
    </section>
  );
}

/** Service name Compose itself uses: the `com.docker.compose.service` label when the member
 *  was inspected, otherwise the container name. The label is what a compose file says. */
const serviceName = (m: Container, d?: ContainerDetail) =>
  d?.labels.find(([k]) => k === "com.docker.compose.service")?.[1] || m.name;

type MemberFacts = { m: Container; d?: ContainerDetail };

/** What is wrong with this project, per service. Every column answers a question a user asks
 *  when a stack misbehaves: is it up, does its health check pass, has it been restarted, how
 *  close is it to its memory ceiling, and how did the last run end. */
function GroupHealth({ rows, snap, stale, memberError, onNavigate, onSetMemoryLimit, onContainerAction }: {
  rows: MemberFacts[];
  snap: ActivitySnapshot;
  /** Member ids running an image older than the tag they name. */
  stale: Set<string>;
  /** Set when the batch and its per-member fallback both failed: the table then says so. */
  memberError: string;
  onNavigate: (subject: Subject) => void;
  onSetMemoryLimit: (target: { id: string; name: string; used: number; current: number }) => void;
  onContainerAction: (id: string, action: "start" | "stop" | "restart") => void;
}) {
  const statOf = (m: Container) =>
    snap.stats.find((s) => s.id === m.id || s.name === m.name);
  const unhealthy = rows.filter((r) => r.d?.health === "unhealthy");
  const noHealth = rows.filter((r) => r.d && !r.d.health_test);
  const oom = rows.filter((r) => r.d?.oom_killed);
  const badExit = rows.filter((r) => r.d && r.m.state !== "running" && r.d.exit_code !== 0);
  const pressured = rows.filter((r) => {
    const s = statOf(r.m);
    return !!s && s.mem_limit > 0 && s.mem_pct >= PRESSURE_PCT;
  });
  const restarts = rows.reduce((n, r) => n + (r.d?.restart_count ?? 0), 0);
  const running = rows.filter((r) => r.m.state === "running");
  /** The longest-running member: uptime, not container age, is what a restart loop resets. */
  const oldest = running.reduce<{ at: number; name: string } | null>((min, r) => {
    const at = Date.parse(r.d?.started_at ?? "");
    if (Number.isNaN(at) || at < 0) return min;
    return !min || at < min.at ? { at, name: r.m.name } : min;
  }, null);
  const uptime = oldest ? dur((Date.now() - oldest.at) / 1000) : null;
  const flagged = unhealthy.length + oom.length + badExit.length + pressured.length;
  const reading = snap.at === 0 && !snap.error;
  /** Worst first, so the reason the page was opened is the first row. Rank uses only facts that
   *  do not change every second (an OOM flag, an exit status, a probe result), so rows do not
   *  swap places while someone reads them. */
  const ordered = [...rows].sort((a, b) => {
    const rank = (r: MemberFacts) =>
      r.d?.oom_killed ? 0
        : r.m.state !== "running" && (r.d?.exit_code ?? 0) !== 0 ? 1
          : r.d?.health === "unhealthy" ? 2
            : r.m.state !== "running" ? 3
              : (r.d?.restart_count ?? 0) > 0 ? 4
                : 5;
    return rank(a) - rank(b) || serviceName(a.m, a.d).localeCompare(serviceName(b.m, b.d));
  });
  /** The member to fix first: the one closest to its ceiling. */
  const worst = pressured.reduce<{ id: string; name: string; used: number; current: number; pct: number } | null>((top, r) => {
    const stat = statOf(r.m);
    if (!stat) return top;
    return !top || stat.mem_pct > top.pct
      ? { id: r.m.id, name: r.m.name, used: stat.mem, current: stat.mem_limit, pct: stat.mem_pct }
      : top;
  }, null);

  return (
    <section className="panel inv-wide">
      <div className="inv-panel-head">
        <h3>Health &amp; risk <span className="inv-count">{rows.length}</span></h3>
        {worst && (
          <button className="btn" onClick={() => onSetMemoryLimit(worst)} title={`${worst.name} is at ${worst.pct.toFixed(1)}% of ${fmtBytes(worst.current)}`}>
            Raise the limit…
          </button>
        )}
        <span className="muted inv-note">
          {flagged === 0
            ? `no risk signals · ${restarts} restarts total${uptime ? ` · up ${uptime}` : ""}`
            : [
                unhealthy.length ? `${unhealthy.length} unhealthy` : "",
                oom.length ? `${oom.length} OOM-killed` : "",
                badExit.length ? `${badExit.length} exited non-zero` : "",
                pressured.length ? `${pressured.length} near the memory limit` : "",
                `${restarts} restarts total`,
                uptime ? `up ${uptime}` : "",
              ].filter(Boolean).join(" · ")}
        </span>
      </div>
      <div className="inv-service-head">
        <span>State</span><span>Service</span><span>Health</span>
        <span className="right">Restarts</span><span className="right">Memory</span><span className="right">Last exit</span>
      </div>
      {ordered.map((r) => {
        const stat = statOf(r.m);
        const metered = stat && stat.mem_limit > 0 && stat.mem_pct >= PRESSURE_PCT;
        const state = r.m.state === "running" ? "running" : r.d && r.d.exit_code !== 0 ? "failed" : "stopped";
        const health = r.d ? (r.d.health || "no check") : "—";
        return (
          <div className="inv-service-row" key={r.m.id}>
            <span className={`status-badge ${state}`}><span className="dot" />{r.m.state}</span>
            <button className="inv-link inv-service-name" onClick={() => onNavigate({ kind: "container", id: r.m.id })}>
              {serviceName(r.m, r.d)}
            </button>
            <span className={r.d?.health === "unhealthy" ? "state-bad" : r.d?.health === "healthy" ? "inv-ok" : "muted"}>
              {health}
            </span>
            <span className="inv-member-num">
              {r.d ? `${r.d.restart_count}${r.d.restart_policy && r.d.restart_count > 0 ? ` · ${r.d.restart_policy}` : ""}` : "—"}
            </span>
            {metered && stat ? (
              <button
                className="inv-link inv-member-num state-bad inv-service-mem"
                onClick={() => onSetMemoryLimit({ id: r.m.id, name: r.m.name, used: stat.mem, current: stat.mem_limit })}
                title={`${r.m.name} is at ${stat.mem_pct.toFixed(1)}% of its limit — raise it before the kernel kills it`}
              >
                {stat.mem_pct.toFixed(1)}% of {fmtBytes(stat.mem_limit)}
              </button>
            ) : (
              <span className="inv-member-num">
                {stat ? (stat.mem_limit > 0 ? `${stat.mem_pct.toFixed(1)}% of ${fmtBytes(stat.mem_limit)}` : `${fmtBytes(stat.mem)} · no limit`) : "—"}
              </span>
            )}
            <span className="inv-member-num inv-service-exit">
              {r.m.state === "running"
                ? <>up{r.d?.oom_killed && <span className="state-bad"> · OOM</span>}</>
                : r.d
                  ? <>{r.d.oom_killed ? <span className="state-bad">OOM-killed</span> : <>exit {r.d.exit_code}</>}
                      {r.d.finished_at && startedOf(r.d.finished_at) !== "—" ? <span className="muted"> · {rel(r.d.finished_at)}</span> : null}</>
                  : "—"}
              {(r.m.state !== "running" || stale.has(r.m.id) || (r.d?.restart_count ?? 0) > 0 || r.d?.health === "unhealthy") && (
                <button
                  className="icon-plain inv-service-action"
                  onClick={() => onContainerAction(r.m.id, r.m.state === "running" ? "restart" : "start")}
                  aria-label={r.m.state === "running" ? "Restart service" : "Start service"}
                  title={r.m.state === "running" ? "Restart service" : "Start service"}
                >
                  {r.m.state === "running" ? <RestartIcon size={14} /> : <PlayIcon size={14} />}
                </button>
              )}
            </span>
          </div>
        );
      })}
      {memberError && (
        <p className="muted inv-note"><span className="state-bad">Member details unavailable</span> — {memberError}</p>
      )}
      {reading && <p className="muted">Reading live memory…</p>}
      {(unhealthy.length > 0 || noHealth.length > 0) && (
        <p className="muted inv-note">
          {noHealth.length > 0 && `${noHealth.length} of ${rows.length} without health check`}
          {noHealth.length > 0 && unhealthy.length > 0 ? " · " : ""}
          {unhealthy.length > 0 && `${unhealthy.map((r) => serviceName(r.m, r.d)).join(", ")} failing the probe`}
        </p>
      )}
    </section>
  );
}

/** What this project costs on disk: the images its containers run (including ones that are no
 *  longer local), the named volumes it mounts, and the total against the VM. */
function GroupFootprint({ rows, images, imageArch, imageDigest, volSizes, stale, onNavigate }: {
  rows: MemberFacts[];
  images: Image[];
  /** Member ids running an image older than the tag they name. */
  stale: Set<string>;
  imageArch: Record<string, string>;
  imageDigest: Record<string, string>;
  volSizes: VolumeSize[];
  onNavigate: (subject: Subject) => void;
}) {
  const local = new Map(images.map((i) => [`${i.repository}:${i.tag}`, i]));
  const refs = [...new Set(rows.map((r) => r.m.image))].sort();
  // Distinct Compose services, not containers: three replicas of one service is one service.
  const services = new Map(refs.map((ref) => [
    ref,
    new Set(rows.filter((r) => r.m.image === ref).map((r) => serviceName(r.m, r.d))).size,
  ]));
  const sizes = new Map(refs.map((ref) => {
    const img = local.get(ref);
    return [ref, img ? parseHumanBytes(img.size) : 0];
  }));
  const imageBytes = [...sizes.values()].reduce((n, bytes) => n + bytes, 0);
  const missing = refs.filter((ref) => !local.has(ref));

  // Named volumes come from the inspect payload: the list's `mounts` string cannot tell a
  // volume from a bind, and a project's storage is the volume part.
  const volumesUsed = new Map<string, Set<string>>();
  for (const r of rows) {
    for (const mount of r.d?.mounts ?? []) {
      if (mount.kind !== "volume" || !mount.source) continue;
      const holders = volumesUsed.get(mount.source) ?? new Set<string>();
      holders.add(serviceName(r.m, r.d));
      volumesUsed.set(mount.source, holders);
    }
  }
  const volSize = new Map(volSizes.map((v) => [v.name, v.size]));
  const volumeBytes = [...volumesUsed.keys()].reduce((n, name) => n + (volSize.get(name) ?? 0), 0);
  const bindPaths = rows.flatMap((r) => (r.d?.mounts ?? []).filter((mount) => mount.kind === "bind" && mount.source));

  return (
    <section className="panel inv-wide">
      <div className="inv-panel-head">
        <h3>Footprint</h3>
        <span className="muted inv-note">
          {`${fmtSize(imageBytes)} images · ${fmtSize(volumeBytes)} volumes · ${fmtSize(imageBytes + volumeBytes)} total`}
          {missing.length ? ` · ${missing.length} image${missing.length === 1 ? "" : "s"} not pulled` : ""}
        </span>
      </div>
      <div className="inv-group">
        <div className="inv-group-title">Images<span className="inv-count">{refs.length}</span></div>
        {refs.map((ref) => {
          const img = local.get(ref);
          const key = img ? img.id.replace(/^sha256:/, "") : "";
          const arch = img ? imageArch[key] : undefined;
          const digest = img ? imageDigest[key] : undefined;
          const older = rows.filter((r) => r.m.image === ref && stale.has(r.m.id)).map((r) => serviceName(r.m, r.d));
          const body = (
            <>
              <code>{ref}</code>
              <span className="muted">
                {img ? fmtSize(sizes.get(ref) ?? 0) : <span className="state-bad">not pulled</span>}
                {arch ? ` · ${arch}` : ""}
                {` · ${services.get(ref)} service${services.get(ref) === 1 ? "" : "s"}`}
                {older.length ? <span className="state-bad"> · {older.join(", ")} {older.length === 1 ? "runs" : "run"} an older image, restart to apply</span> : null}
              </span>
            </>
          );
          return (
            <div className="inv-image-row" key={ref}>
              {img
                ? <button className="inv-link inv-mount" onClick={() => onNavigate({ kind: "image", id: img.id })}>{body}</button>
                : <div className="inv-row inv-mount">{body}</div>}
              {digest && <code className="inv-digest" title={digest}>{digest}</code>}
            </div>
          );
        })}
      </div>
      <div className="inv-group">
        <div className="inv-group-title">Volumes<span className="inv-count">{volumesUsed.size}</span></div>
        {volumesUsed.size === 0 ? <span className="muted">no named volumes</span> : [...volumesUsed.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([name, holders]) => (
            <div className="inv-row inv-mount" key={name}>
              <button className="inv-link" onClick={() => onNavigate({ kind: "volume", id: name })}><code>{name}</code></button>
              <span className="muted">
                {volSize.has(name) ? fmtSize(volSize.get(name) ?? 0) : volSizes.length ? "size unknown" : "size not scanned"}
                {` · ${holders.size} service${holders.size === 1 ? "" : "s"}`}
                {holders.size > 1 ? ` · shared by ${holders.size > 3 ? `${holders.size} services` : [...holders].join(", ")}` : ""}
              </span>
            </div>
          ))}
      </div>
      <div className="inv-group">
        <div className="inv-group-title">Bind mounts<span className="inv-count">{bindPaths.length}</span></div>
        {bindPaths.length === 0 ? <span className="muted">none</span> : bindPaths.map((mount) => (
          <div className="inv-row inv-mount" key={`${mount.source}-${mount.destination}`}>
            <code>{pathWithBreaks(mount.source)}</code>
            <span className="muted">→ {mount.destination} · {mount.mode || "rw"}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

export function InvestigatorPage({ subject, containers, images, volumes, networks, netMap, daemonUp, profile, refreshNonce, vmMemory, imageArch, imageDigest, volSizes, onPick, onNavigate, onOpenContainers, onOpenNetwork, onOpenLogs, onSetMemoryLimit, onContainerAction }: Props) {
  const [detail, setDetail] = useState<{ kind: Subject["kind"]; data: ContainerDetail | ImageDetail | VolumeDetail | NetworkDetail } | null>(null);
  const [inspect, setInspect] = useState<InspectTarget | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [stats, setStats] = useState<ContainerStat | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [statsNonce, setStatsNonce] = useState(0);
  const [trend, setTrend] = useState<{ cpu: number[]; mem: number[] }>({ cpu: [], mem: [] });
  const [net, setNet] = useState<{ rx: number[]; tx: number[] }>({ rx: [], tx: [] });
  /** First and last sample timestamps, plus whether the poll fallback is driving them: the
   *  x-axis is real elapsed time, not a count times an assumed one-second cadence. */
  const [trendMeta, setTrendMeta] = useState({ first: 0, last: 0, polling: false });

  const trendOwner = useRef<string>("");
  const prevSample = useRef<{ at: number; rx: number; tx: number } | null>(null);
  const [logs, setLogs] = useState<string | null>(null);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [logsNonce, setLogsNonce] = useState(0);
  /** The subject image's own labels: undefined while reading, null when unreadable. Docker
   *  merges them into the container's `Config.Labels`, so this is the only way to say which
   *  label came from the image and which was attached when the container was created. */
  const [imageLabels, setImageLabels] = useState<[string, string][] | null>();
  /** A project's members are only listed by the containers table; health, restarts, limits and
   *  mounts live in `inspect`, so the group page reads them in one batched call. */
  const [memberDetails, setMemberDetails] = useState<Record<string, ContainerDetail>>({});
  const [memberError, setMemberError] = useState("");
  const snap = useActivitySnapshot(subject?.kind === "group");

  const container = subject?.kind === "container" ? containers.find((c) => c.id === subject.id) : undefined;
  const running = container?.state === "running";
  const win = useLiveWindow();
  /** Real seconds between the first and last sample, and how far apart samples land. */
  const trendSpan = trendMeta.first && trendMeta.last ? Math.round((trendMeta.last - trendMeta.first) / 1000) : 0;
  const trendStep = trendMeta.polling ? POLL_MS / 1000 : 1;
  /** Samples inside the selected window: 120 at 1 Hz, 24 at the 5 s fallback. */
  const winSamples = Math.max(2, Math.round(win / trendStep));
  const shownCpu = trend.cpu.slice(-winSamples);
  const shownMem = trend.mem.slice(-winSamples);
  const shownRx = net.rx.slice(-winSamples);
  const shownTx = net.tx.slice(-winSamples);
  const shownSpan = trend.cpu.length >= winSamples ? Math.round((winSamples - 1) * trendStep) : trendSpan;

  useEffect(() => {
    if (!subject) {
      setDetail(null);
      setError(null);
      setInspect(null);
      return;
    }
    let alive = true;
    setDetail(null);
    setError(null);
    setInspect(null);
    // A group is an index over containers the list already holds; there is no inspect payload.
    if (subject.kind === "group") return;
    (async () => {
      try {
        const podman = subject.runtime === "podman";
        const next = subject.kind === "container"
          ? await invoke<ContainerDetail>(podman ? "podman_container_detail_cmd" : "container_detail_cmd", { id: subject.id })
          : subject.kind === "image"
            ? await invoke<ImageDetail>(podman ? "podman_image_detail_cmd" : "image_detail_cmd", { id: subject.id })
            : subject.kind === "volume"
              ? await invoke<VolumeDetail>(podman ? "podman_volume_detail_cmd" : "volume_detail_cmd", { name: subject.id })
              : await invoke<NetworkDetail>(podman ? "podman_network_detail_cmd" : "network_detail_cmd", { name: subject.id });
        if (alive && next) setDetail({ kind: subject.kind, data: next });
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    return () => { alive = false; };
  }, [subject?.kind, subject?.id, subject?.runtime, refreshNonce]);

  // A container's labels are the image's labels plus the ones attached when it was created;
  // reading the image's own set is what lets the panel name each label's origin.
  useEffect(() => {
    setImageLabels(undefined);
    const ref = subject?.kind === "container" ? container?.image : undefined;
    if (!ref) return;
    let alive = true;
    const cmd = subject?.runtime === "podman" ? "podman_image_detail_cmd" : "image_detail_cmd";
    invoke<ImageDetail>(cmd, { id: ref })
      .then((next) => { if (alive) setImageLabels(Array.isArray(next?.labels) ? next.labels : null); })
      .catch(() => { if (alive) setImageLabels(null); });
    return () => { alive = false; };
  }, [subject?.kind, subject?.id, subject?.runtime, container?.image, refreshNonce]);

  // One `docker inspect` covers the whole project. Keyed by name because inspect truncates the
  // id to twelve characters, which does not always match the id the containers list carries.
  const memberIds = subject?.kind === "group"
    ? containers.filter((c) => c.compose_project === subject.id).map((c) => c.id).sort().join(",")
    : "";
  useEffect(() => {
    if (!memberIds) {
      setMemberDetails({});
      setMemberError("");
      return;
    }
    let alive = true;
    const ids = memberIds.split(",");
    /** Applies a batch and returns how many members it described. */
    const keep = (list: ContainerDetail[]) => {
      if (!alive) return 0;
      const next: Record<string, ContainerDetail> = {};
      for (const d of list) next[d.name] = d;
      setMemberDetails(next);
      return Object.keys(next).length;
    };
    // One vanished container makes `docker inspect a b c` exit non-zero and print a partial
    // array, so a failed batch falls back to per-member reads instead of blanking the page.
    // The error is only reported when the fallback recovered nothing either.
    invoke<ContainerDetail[]>("container_details_cmd", { ids })
      .then((list) => { if (keep(list ?? [])) setMemberError(""); })
      .catch((batchError: unknown) => Promise.allSettled(ids.map((id) => invoke<ContainerDetail>("container_detail_cmd", { id })))
        .then((settled) => {
          if (keep(settled.flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : [])))) {
            setMemberError("");
          } else if (alive) {
            setMemberError(String(batchError).slice(0, 120));
          }
        }));
    return () => { alive = false; };
  }, [memberIds, refreshNonce]);

  // Live numbers only exist for a running container. One streaming child feeds this panel
  // about once a second; if it cannot start or dies, the old five-second poll takes over.
  // The child stays up while the window is in the background, so the trend has no gap when
  // the user comes back.
  useEffect(() => {
    if (subject && subject.kind === "container" && trendOwner.current !== subject.id) {
      trendOwner.current = subject.id;
      setTrend({ cpu: [], mem: [] });
      setNet({ rx: [], tx: [] });
      setTrendMeta({ first: 0, last: 0, polling: false });
      prevSample.current = null;
      // The sample in hand belongs to the previous subject; only then is discarding it right.
      // Clearing it on every effect entry also blanked the panel on ⌘R, on a restored window
      // and on the panel's own restart, for a container that had not changed.
      setStats(null);
      setStatsError(null);
    }
    if (!subject || subject.kind !== "container" || !running) {
      // A stopped container must not keep showing its last numbers.
      setStats(null);
      setStatsError(null);
      return;
    }
    let alive = true;
    let stop: (() => void) | null = null;
    let timer: number | undefined;
    let polling = false;

    const apply = (next: ContainerStat) => {
      if (!alive) return;
      setStats(next);
      setStatsError(null);
      setTrend((t) => ({
        cpu: [...t.cpu, next.cpu].slice(-TREND_SAMPLES),
        mem: [...t.mem, next.mem].slice(-TREND_SAMPLES),
      }));
      // Counters are cumulative for the container's life; chart the per-second delta.
      const now = Date.now();
      const prev = prevSample.current;
      if (prev) {
        const seconds = Math.max((now - prev.at) / 1000, 0.5);
        setNet((n) => ({
          rx: [...n.rx, Math.max(0, next.net_rx - prev.rx) / seconds].slice(-TREND_SAMPLES),
          tx: [...n.tx, Math.max(0, next.net_tx - prev.tx) / seconds].slice(-TREND_SAMPLES),
        }));
      }
      prevSample.current = { at: now, rx: next.net_rx, tx: next.net_tx };
      setTrendMeta((m) => ({ first: m.first || now, last: now, polling: m.polling }));
    };

    const poll = async () => {
      try {
        const podman = subject.runtime === "podman";
        if (podman) {
          const stats = await invoke<ContainerStat[]>("podman_container_stats_cmd");
          const stat = stats.find((s) => s.id === subject.id || subject.id.startsWith(s.id) || s.name === (containers.find((c) => c.id === subject.id)?.name ?? ""));
          if (stat) apply(stat);
        } else {
          apply(await invoke<ContainerStat>("container_stats_one_cmd", { id: subject.id }));
        }
      } catch (e) {
        if (alive) setStatsError(String(e));
      }
    };

    const startPolling = () => {
      if (polling || !alive) return;
      polling = true;
      setTrendMeta((m) => ({ ...m, polling: true }));
      void poll();
      timer = window.setInterval(() => { if (!document.hidden) void poll(); }, POLL_MS);
    };

    const podman = subject.runtime === "podman";
    if (podman) {
      // Podman has no streaming stats endpoint; poll the one-shot command instead.
      startPolling();
    } else {
      void startStatsStream(subject.id, apply, startPolling).then((s) => {
        stop = s;
        if (!alive) s?.();
        else if (!s) startPolling();
      });
    }

    return () => {
      alive = false;
      clearInterval(timer);
      stop?.();
    };
  }, [subject?.kind, subject?.id, subject?.runtime, running, statsNonce, refreshNonce]);

  useEffect(() => {
    setLogs(null);
    setLogsError(null);
    if (!subject || subject.kind !== "container") return;
    let alive = true;
    (async () => {
      try {
        const podman = subject.runtime === "podman";
        const next = await invoke<string>(podman ? "podman_container_logs_cmd" : "container_logs_cmd", { id: subject.id, tail: 60 });
        if (alive) setLogs(next);
      } catch (e) {
        if (alive) setLogsError(String(e));
      }
    })();
    return () => { alive = false; };
  }, [subject?.kind, subject?.id, logsNonce]);

  if (!subject) {
    return <AssetPicker containers={containers} images={images} volumes={volumes} networks={networks} netMap={netMap} daemonUp={daemonUp} profile={profile} onPick={onPick} />;
  }

  // Narrowed alias: the inspect closures below read it after this point, where
  // `subject` itself is no longer narrowed.
  const onScreen = subject;
  const image = subject.kind === "image" ? images.find((i) => i.id === subject.id) : undefined;
  const volume = subject.kind === "volume" ? volumes.find((v) => v.name === subject.id) : undefined;
  const network = subject.kind === "network" ? netMap.find((n) => n.name === subject.id) : undefined;
  /** A compose project is an entity in Sherlock: its identity is the project name and its
   *  members are the containers the list already carries, so no new Rust surface exists. */
  const groupMembers = subject.kind === "group" ? containers.filter((c) => c.compose_project === subject.id) : [];
  const groupOldest = groupMembers.reduce<string>((min, c) => (!min || c.created_at < min ? c.created_at : min), "");
  const groupRows: MemberFacts[] = groupMembers.map((m) => ({ m, d: memberDetails[m.name] }));
  /** Compose records where the project came from on every container it creates, so one member's
   *  labels name the file and directory to edit. */
  const groupConfig = groupRows.map((r) => r.d).find(Boolean);
  const configFile = groupConfig?.labels.find(([k]) => k === "com.docker.compose.project.config_files")?.[1] ?? "";
  const workingDir = groupConfig?.labels.find(([k]) => k === "com.docker.compose.project.working_dir")?.[1] ?? "";
  /** Longest-running member: uptime says whether a restart loop keeps resetting the service. */
  const groupUptime = groupRows.reduce<{ at: number } | null>((min, r) => {
    if (r.m.state !== "running") return min;
    const at = Date.parse(r.d?.started_at ?? "");
    if (Number.isNaN(at) || at < 0) return min;
    return !min || at < min.at ? { at } : min;
  }, null);
  /** Members whose image id no longer matches the local tag: they run the previous build until
   *  the container is recreated. */
  const groupStale = new Set(groupRows.flatMap((r) => {
    if (!r.d?.image_id) return [];
    const img = images.find((i) => `${i.repository}:${i.tag}` === r.m.image);
    if (!img) return [];
    const localId = img.id.replace(/^sha256:/, "");
    const started = r.d.image_id.replace(/^sha256:/, "");
    return started.length >= 12 && !(localId.startsWith(started) || started.startsWith(localId)) ? [r.m.id] : [];
  }));
  /** Networks this project is attached to, and how many of its members are on each. */
  const groupNetworks = netMap
    .map((n) => ({ name: n.name, count: n.containers.filter((c) => groupMembers.some((m) => m.name === c.name)).length }))
    .filter((n) => n.count > 0)
    .sort((a, b) => b.count - a.count);
  /** Host ports this project publishes, and the containers outside it that claim the same one:
   *  a stopped sibling project's mapping is exactly why the next `compose up` fails. */
  const groupPorts = groupMembers.flatMap((m) => m.ports.split(",").map((p) => p.trim()).filter(Boolean));
  const groupPortConflicts = groupPorts.flatMap((claim) => {
    const host = /(?:^|:)(\d+)->\d+\/(?:tcp|udp)/i.exec(claim)?.[1];
    if (!host) return [];
    return containers
      .filter((c) => !groupMembers.some((m) => m.id === c.id))
      .filter((c) => c.ports.split(",").some((p) => new RegExp(`(?:^|:)${host}->\\d+/(?:tcp|udp)`, "i").test(p.trim())))
      .map((c) => ({ host, name: c.name, project: c.compose_project, state: c.state }));
  });
  const title = subject.kind === "group"
    ? subject.id
    : subject.kind === "container"
    ? container?.name ?? subject.id
    : subject.kind === "image"
      ? (image ? `${image.repository}:${image.tag}` : subject.id)
      : subject.kind === "volume"
        ? volume?.name ?? subject.id
        : network?.name ?? subject.id;

  // Detail may belong to the previous subject for one render; match on kind too.
  const cDetail = detail?.kind === "container" ? (detail.data as ContainerDetail) : null;
  const iDetail = detail?.kind === "image" ? (detail.data as ImageDetail) : null;
  const vDetail = detail?.kind === "volume" ? (detail.data as VolumeDetail) : null;
  const nDetail = detail?.kind === "network" ? (detail.data as NetworkDetail) : null;

  /** Labels by origin. A container is the only kind with two: its own set is the image's
   *  labels with the run-time ones merged in, so each row is compared against the image. */
  const labelGroups: LabelGroup[] = (() => {
    if (cDetail) {
      const pairs = cDetail.labels ?? [];
      if (imageLabels == null) return pairs.length ? [{ title: "Labels", pairs }] : [];
      const fromImage = new Map(imageLabels);
      return [
        { title: "Set at runtime", pairs: pairs.filter(([k, v]) => fromImage.get(k) !== v) },
        { title: "From image", pairs: pairs.filter(([k, v]) => fromImage.get(k) === v) },
      ];
    }
    if (iDetail) return [{ title: "From image", pairs: iDetail.labels ?? [] }];
    if (vDetail) return [{ title: "Volume", pairs: vDetail.labels ?? [] }];
    if (nDetail) return [{ title: "Network", pairs: nDetail.labels ?? [] }];
    return [];
  })();

  const imageRefs = imageRefSet(images, subject);
  const usedBy = subject.kind === "image"
    ? containers.filter((c) => imageRefs.has(c.image) || c.image === subject.id || c.image.startsWith(subject.id))
    : subject.kind === "volume"
      ? containersUsingVolume(containers, subject.id)
      : [];

  const ports = cDetail?.ports?.length ? portString(cDetail.ports) : container?.ports ?? "";
  const startedSeconds = cDetail ? (Date.now() - Date.parse(cDetail.started_at)) / 1000 : NaN;
  const uptime = running && Number.isFinite(startedSeconds) && startedSeconds > 0 ? dur(startedSeconds) : null;
  // CPU is a share of one core, memory is a share of its limit: those ceilings are known,
  // so history uses them instead of a flattering auto-scale.
  const cpuCeiling = Math.max(100, ...shownCpu);

  // Containers that share at least one network with this container, deduped by name.
  const peers = new Map<string, { id: string; name: string; state: string; nets: string[] }>();
  for (const net of cDetail?.networks ?? []) {
    const entry = netMap.find((n) => n.name === net.name);
    for (const member of entry?.containers ?? []) {
      if (member.name === container?.name) continue;
      const hit = containers.find((c) => c.name === member.name);
      const current = peers.get(member.name);
      if (current) current.nets.push(net.name);
      else peers.set(member.name, { id: hit?.id ?? "", name: member.name, state: hit?.state ?? "", nets: [net.name] });
    }
  }

  /** Docker's `inspect` answers for every kind; Podman needs one command per kind and
   *  names volumes and networks by name instead of id. */
  function inspectCommand(): { cmd: string; args: Record<string, unknown> } {
    if (onScreen.runtime !== "podman") return { cmd: "inspect_cmd", args: { id: onScreen.id } };
    if (onScreen.kind === "container") return { cmd: "podman_container_inspect_json_cmd", args: { id: onScreen.id } };
    if (onScreen.kind === "image") return { cmd: "podman_image_inspect_cmd", args: { id: onScreen.id } };
    if (onScreen.kind === "volume") return { cmd: "podman_volume_inspect_cmd", args: { name: onScreen.id } };
    return { cmd: "podman_network_inspect_cmd", args: { name: onScreen.id } };
  }
  /** The raw payload opens a window, like Logs; a late answer for the previous subject
   *  is dropped rather than painted onto this one. */
  function loadInspect() {
    const cmd = inspectCommand();
    const target: InspectTarget = { kind: onScreen.kind, name: title, ...cmd, raw: null, error: null };
    setInspect(target);
    invoke<string>(target.cmd, target.args)
      .then((raw) => setInspect((prev) => (prev?.name === target.name ? { ...prev, raw } : prev)))
      .catch((e) => setInspect((prev) => (prev?.name === target.name ? { ...prev, error: String(e) } : prev)));
  }

  const labelValue = (key: string) => cDetail?.labels.find(([k]) => k === key)?.[1] ?? iDetail?.labels.find(([k]) => k === key)?.[1] ?? "";

  return (
    <div className="investigator">
      <div className="investigator-bar">
        <span className={`inv-kind ${subject.kind}`}>{subject.kind}</span>
        <h2>{title}</h2>
        <div className="investigator-actions">
          {container && cDetail && subject.runtime !== "podman" && (
            <button
              className="icon-plain"
              onClick={() => onSetMemoryLimit({ id: container.id, name: container.name, used: stats?.mem ?? 0, current: cDetail.memory_limit })}
              aria-label="Memory limit"
              title={cDetail.oom_killed ? "Memory limit — the last exit was an OOM kill" : "Memory limit"}
            >
              <SlidersIcon />
            </button>
          )}
          {container && (
            <button className="icon-plain" onClick={() => onOpenLogs(container)} aria-label="Logs" title="Logs">
              <TerminalIcon />
            </button>
          )}
          <button
            className="icon-plain"
            aria-label="Open in Containers"
            title="Open in Containers"
            onClick={() => {
              if (network) onOpenNetwork(network.name, network.containers.map((c) => c.name));
              else if (image) onOpenContainers(`${image.repository}:${image.tag}`);
              else if (container) onOpenContainers(container.name);
              else if (subject.kind === "group") onOpenContainers(subject.id);
              else onOpenContainers();
            }}
          >
            <ArrowUpRightIcon />
          </button>
          {subject.kind !== "group" && (
            <button className="icon-plain" aria-label="Inspect JSON" title="Inspect JSON" onClick={loadInspect}>
              <BracesIcon />
            </button>
          )}
        </div>
      </div>

      {error && <div className="panel"><p className="muted">{error}</p></div>}

      {subject.kind === "group" && (
        <>
          <GroupPerformance members={groupMembers} snap={snap} vmMemory={vmMemory} onNavigate={onNavigate} />
          <GroupHealth rows={groupRows} snap={snap} stale={groupStale} memberError={memberError} onNavigate={onNavigate} onSetMemoryLimit={onSetMemoryLimit} onContainerAction={onContainerAction} />
          <GroupFootprint rows={groupRows} images={images} imageArch={imageArch} imageDigest={imageDigest} volSizes={volSizes} stale={groupStale} onNavigate={onNavigate} />
        </>
      )}

      {container && running && (
        <section className="panel" aria-busy={!stats && !statsError}>
          <div className="inv-panel-head">
            <h3>Performance</h3>
            <span className="muted inv-note">{trendMeta.polling ? "polling · 5 s from docker stats" : "live · 1 s from docker stats"}</span>
            <div className="inv-head-tools">
              <WindowSwitch />
              <button className="icon-plain" onClick={() => setStatsNonce((n) => n + 1)} aria-label="Restart live sample" title="Restart live sample">
                <RefreshIcon size={15} />
              </button>
            </div>
          </div>
          {stats ? (
            <>
              <div className="trend-grid">
                <div className="trend-card">
                  <div className="trend-head">
                    <span className="inv-metric-label">CPU</span>
                    <span className="trend-value">{stats.cpu.toFixed(1)}%</span>
                  </div>
                  {shownCpu.length < TREND_MIN_POINTS
                    ? <span className="spark-skeleton" aria-hidden="true" />
                    : <>
                        <Sparkline values={shownCpu} slots={winSamples} fit ceiling={cpuCeiling} label={`CPU over the last ${fmtSpan(shownSpan)}`} />
                        <ChartAxis seconds={shownSpan} />
                      </>}
                  <span className="inv-metric-sub">
                    {shownCpu.length >= TREND_MIN_POINTS ? `peak ${Math.max(...shownCpu).toFixed(1)}% · ${fmtSpan(shownSpan)} window · scale 100%` : collecting(shownCpu.length, trendStep)}
                  </span>
                </div>
                <div className="trend-card">
                  <div className="trend-head">
                    <span className="inv-metric-label">Memory</span>
                    <span className={`trend-value${stats.mem_limit > 0 && stats.mem_pct >= PRESSURE_PCT ? " state-bad" : ""}`}>{fmtBytes(stats.mem)}</span>
                  </div>
                  {shownMem.length < TREND_MIN_POINTS
                    ? <span className="spark-skeleton" aria-hidden="true" />
                    : <>
                        <Sparkline values={shownMem} slots={winSamples} fit ceiling={stats.mem_limit || undefined} label={`Memory over the last ${fmtSpan(shownSpan)}`} />
                        <ChartAxis seconds={shownSpan} />
                      </>}
                  <span className="inv-metric-sub">
                    {stats.mem_limit ? `${stats.mem_pct.toFixed(1)}% of ${fmtBytes(stats.mem_limit)}` : "no limit set"}
                    {stats.mem_limit > 0 && stats.mem_pct >= PRESSURE_PCT ? " · near the limit, OOM-killed at 100%" : ""}
                  </span>
                </div>
                <div className="trend-card">
                  <div className="trend-head">
                    <span className="inv-metric-label">Network</span>
                    <span className="trend-value">{fmtSize(net.rx[net.rx.length - 1] ?? 0)}/s</span>
                  </div>
                  {shownRx.length < TREND_MIN_POINTS
                    ? <span className="spark-skeleton" aria-hidden="true" />
                    : <>
                        <Sparkline values={shownRx} secondary={shownTx} slots={winSamples} fit label="Network receive and transmit rate" />
                        <ChartAxis seconds={shownSpan} />
                      </>}
                  <span className="inv-metric-sub">
                    {shownRx.length >= TREND_MIN_POINTS ? `receive solid · transmit light · ${fmtSpan(shownSpan)} window` : collecting(shownRx.length, trendStep)}
                  </span>
                </div>
              </div>
              <div className="inv-metrics">
                <div className="inv-metric">
                  <span className="inv-metric-label">Block I/O</span>
                  <span className="inv-metric-value">{fmtSize(stats.block_read)} read</span>
                  <span className="inv-metric-sub">{fmtSize(stats.block_write)} written</span>
                </div>
                <div className="inv-metric">
                  <span className="inv-metric-label">Processes</span>
                  <span className="inv-metric-value">{stats.pids}</span>
                  <span className="inv-metric-sub">pids</span>
                </div>
              </div>
            </>
          ) : statsError ? (
            <p className="muted">{statsError}</p>
          ) : (
            <PerformanceSkeleton />
          )}
        </section>
      )}

      <div className="investigator-grid">
        <div className="inv-side">
          {subject.kind === "group" && (
            <FactsGroup title="Project" card>
              <Row label="Project" mono copy={subject.id}><code>{subject.id}</code></Row>
              <Row label="Containers">{groupMembers.length}</Row>
              <Row label="Running">{groupMembers.filter((c) => c.state === "running").length}</Row>
              <Row label="Images">{new Set(groupMembers.map((c) => c.image)).size}</Row>
              <Row label="Uptime">{groupUptime ? <>{dur((Date.now() - groupUptime.at) / 1000)}<span className="muted"> · longest-running member</span></> : "—"}</Row>
              <Row label="Oldest">{groupOldest ? <>{fmtDateTime(groupOldest)}<span className="muted"> · {rel(groupOldest)}</span></> : "—"}</Row>
              <Row label="Compose file" mono copy={configFile}><code title={configFile}>{configFile || "—"}</code></Row>
              <Row label="Working dir" mono copy={workingDir}><code title={workingDir}>{workingDir || "—"}</code></Row>
            </FactsGroup>
          )}
          {container && (
            <>
              <FactsGroup title="Identity" card>
                <Row label="Image" copy={container.image}>
                  <button className="inv-link" onClick={() => {
                    const target = images.find((i) => `${i.repository}:${i.tag}` === container.image || i.id === container.image);
                    onNavigate(target ? { kind: "image", id: target.id } : { kind: "image", id: container.image });
                  }}>{container.image}</button>
                </Row>
                <Row label="ID" mono copy={container.id}><code>{container.id}</code></Row>
                <Row label="Profile">{profile || "—"}</Row>
                <Row label="Created">{fmtDateTime(cDetail?.created ?? container.created_at)}</Row>
                {cDetail?.hostname && <Row label="Hostname" mono copy={cDetail.hostname}><code>{cDetail.hostname}</code></Row>}
              </FactsGroup>
              <FactsGroup title="Lifecycle" card>
                <Row label="Status">{container.state}</Row>
                <Row label="Started">
                  {startedOf(cDetail?.started_at ?? "")}
                  {cDetail?.started_at && startedOf(cDetail.started_at) !== "—" ? <span className="muted"> · {rel(cDetail.started_at)}</span> : null}
                </Row>
                {cDetail && startedOf(cDetail.finished_at) !== "—" && (
                  <Row label="Stopped">{startedOf(cDetail.finished_at)}<span className="muted"> · {rel(cDetail.finished_at)}</span></Row>
                )}
                {uptime && <Row label="Uptime">{uptime}</Row>}
                <Row label="Restarts">
                  {cDetail ? `${cDetail.restart_policy || "no"} · ${cDetail.restart_count} total${cDetail.restart_max ? ` · max ${cDetail.restart_max}` : ""}` : "—"}
                </Row>
                {cDetail?.oom_killed && (
                  <Row label="Last exit"><span className="state-bad">OOM-killed</span></Row>
                )}
              </FactsGroup>
              <HealthCard detail={cDetail} />
              <FactsGroup title="Limits" card>
                <Row label="Memory">{cDetail ? (cDetail.memory_limit ? fmtBytes(cDetail.memory_limit) : "unlimited") : "—"}</Row>
                <Row label="CPU">{cDetail ? (cDetail.nano_cpus ? `${(cDetail.nano_cpus / 1e9).toFixed(2)} cores` : "unlimited") : "—"}</Row>
              </FactsGroup>
            </>
          )}
          {image && (
            <>
              <FactsGroup title="Image" card>
                <Row label="Tags"><div>{iDetail?.tags?.length ? iDetail.tags.join(", ") : `${image.repository}:${image.tag}`}</div></Row>
                <Row label="ID" mono copy={image.id}><code>{image.id}</code></Row>
                <Row label="Size">{iDetail ? fmtSize(iDetail.size) : image.size}</Row>
                <Row label="Layers">{iDetail ? iDetail.layers : "—"}</Row>
                <Row label="Created">{fmtDateTime(iDetail?.created ?? "")}{iDetail?.created ? <span className="muted"> · {rel(iDetail.created)}</span> : null}</Row>
                <Row label="Platform">{iDetail ? `${iDetail.os}/${iDetail.architecture}` : "—"}</Row>
                <Row label="Author" mono><code>{iDetail?.author || "—"}</code></Row>
              </FactsGroup>
            </>
          )}
          {volume && (
            <>
              <FactsGroup title="Storage" card>
                <Row label="Driver">{vDetail?.driver ?? volume.driver}</Row>
                <Row label="Scope">{vDetail?.scope ?? "—"}</Row>
                <Row label="Size">{vDetail?.size != null ? fmtSize(vDetail.size) : "—"}</Row>
                <Row label="Mountpoint" mono copy={vDetail?.mountpoint ?? volume.mountpoint}><code title={vDetail?.mountpoint ?? volume.mountpoint}>{vDetail?.mountpoint ?? volume.mountpoint}</code></Row>
                <Row label="Options">{vDetail?.options?.length ? vDetail.options.map(([k, v]) => `${k}=${v}`).join(", ") : "default"}</Row>
              </FactsGroup>
            </>
          )}
          {network && (
            <>
              <FactsGroup title="Identity" card>
                <Row label="ID" mono copy={nDetail?.id ?? network.id}><code>{nDetail?.id ?? network.id}</code></Row>
                <Row label="Driver">{nDetail?.driver ?? network.driver}</Row>
                <Row label="Scope">{nDetail?.scope ?? network.scope}</Row>
                <Row label="Created">{nDetail?.created ? <>{fmtDateTime(nDetail.created)}<span className="muted"> · {rel(nDetail.created)}</span></> : "—"}</Row>
                <Row label="Internal">{(nDetail?.internal ?? network.internal) ? "yes" : "no"}</Row>
                <Row label="IPv6">{nDetail ? (nDetail.enable_ipv6 ? "enabled" : "disabled") : "—"}</Row>
              </FactsGroup>
            </>
          )}
        </div>

        <div className="inv-side">
        {container && (
          <>
            <FactsGroup title="Runtime" card>
              <Row label="Entrypoint" mono copy={cDetail?.entrypoint}><code title={cDetail?.entrypoint}>{cDetail?.entrypoint || "—"}</code></Row>
              <Row label="Args" mono copy={cDetail?.cmd}><code title={cDetail?.cmd}>{cDetail?.cmd || "—"}</code></Row>
              <Row label="Working dir" mono copy={cDetail?.workdir}><code>{cDetail?.workdir || "—"}</code></Row>
              <Row label="User" mono><code>{cDetail?.user || "root (default)"}</code></Row>
              <Row label="PID" mono>{cDetail?.pid ? <code>{cDetail.pid}</code> : "—"}</Row>
            </FactsGroup>
          </>
        )}
        {image && (
          <FactsGroup title="Runtime" card>
            <Row label="Entrypoint" mono copy={iDetail?.entrypoint}><code title={iDetail?.entrypoint}>{iDetail?.entrypoint || "—"}</code></Row>
            <Row label="Cmd" mono copy={iDetail?.cmd}><code title={iDetail?.cmd}>{iDetail?.cmd || "—"}</code></Row>
            <Row label="Working dir" mono copy={iDetail?.workdir}><code>{iDetail?.workdir || "—"}</code></Row>
            <Row label="User" mono><code>{iDetail?.user || "root (default)"}</code></Row>
          </FactsGroup>
        )}
        {volume && (
          <FactsGroup title="Timeline" card>
            <Row label="Created">{fmtDateTime(vDetail?.created ?? "")}{vDetail?.created ? <span className="muted"> · {rel(vDetail.created)}</span> : null}</Row>
          </FactsGroup>
        )}
        {network && (
          <FactsGroup title="Addressing" card>
            <Row label="Subnet" mono copy={nDetail?.subnet || network.subnet}><code>{nDetail?.subnet || network.subnet || "—"}</code></Row>
            <Row label="Gateway" mono copy={nDetail?.gateway || network.gateway}><code>{nDetail?.gateway || network.gateway || "—"}</code></Row>
            <Row label="IP range" mono><code>{nDetail?.ip_range || "—"}</code></Row>
          </FactsGroup>
        )}
        <section className="panel">
          <h3>Related</h3>
          <TagEditor kind={subject.kind} id={subject.id} />

          {subject.kind === "group" && (
            <div className="inv-group">
              <div className="inv-group-title">Published ports</div>
              {groupMembers.some((m) => m.ports) ? groupMembers.map((m) => (
                <div className="inv-row" key={m.id}>
                  <span className="inv-port-name" title={m.name}>{m.name}</span>
                  <PortChips ports={m.ports} empty="" max={2} />
                </div>
              )) : <span className="muted">none</span>}
            </div>
          )}

          {subject.kind === "group" && (
            <>
              <div className="inv-group">
                <div className="inv-group-title">Networks</div>
                {groupNetworks.length === 0 ? <span className="muted">none</span> : groupNetworks.map((n) => (
                  <div className="inv-row" key={n.name}>
                    <button className="inv-link" onClick={() => onNavigate({ kind: "network", id: n.name })}>{n.name}</button>
                    <span className="muted">{n.count} of {groupMembers.length} attached</span>
                  </div>
                ))}
              </div>
              <div className="inv-group">
                <div className="inv-group-title">Port collisions</div>
                {groupPortConflicts.length === 0 ? (
                  <span className="muted">no other container claims these host ports</span>
                ) : groupPortConflicts.map((c) => (
                  <div className="inv-row" key={`${c.host}-${c.name}`}>
                    <code>{c.host}</code>
                    <span className="muted">
                      also declared by <span className="state-bad">{c.project || "no project"}/{c.name}</span> ({c.state})
                    </span>
                  </div>
                ))}
              </div>
            </>
          )}

          {container && (
            <>
              <div className="inv-group">
                <div className="inv-group-title">Networks</div>
                {cDetail?.networks?.length ? cDetail.networks.map((n) => (
                  <button key={n.name} className="inv-link" onClick={() => onNavigate({ kind: "network", id: n.name })}>
                    {n.name}<span className="muted"> · {n.ip || "no ip"}{n.mac ? ` · ${n.mac}` : ""}</span>
                  </button>
                )) : <span className="muted">none</span>}
              </div>
              <div className="inv-group">
                <div className="inv-group-title">Ports</div>
                <PortChips ports={ports} empty="none" />
              </div>
              <div className="inv-group">
                <div className="inv-group-title">Mounts</div>
                {cDetail?.mounts?.length ? cDetail.mounts.map((m) => {
                  const linked = m.kind === "volume" && volumes.some((v) => v.name === m.source);
                  const body = (
                    <>
                      <code>{pathWithBreaks(m.source || "(anonymous)")}</code>
                      <span className="muted">→ {m.destination} · {m.kind === "volume" ? (m.mode || "rw") : m.kind}</span>
                    </>
                  );
                  return linked
                    ? <button key={`${m.source}-${m.destination}`} className="inv-link inv-mount" onClick={() => onNavigate({ kind: "volume", id: m.source })}>{body}</button>
                    : <div key={`${m.source}-${m.destination}`} className="inv-row inv-mount">{body}</div>;
                }) : <span className="muted">none</span>}
              </div>
              {(container.compose_project || labelValue("com.docker.compose.service")) && (
                <div className="inv-group">
                  <div className="inv-group-title">Compose</div>
                  {container.compose_project && (
                    <div className="inv-row">
                      <button className="inv-link" onClick={() => onNavigate({ kind: "group", id: container.compose_project })}>{container.compose_project}</button>
                      <span className="muted">project</span>
                    </div>
                  )}
                  {labelValue("com.docker.compose.service") && (
                    <div className="inv-row">
                      <code>{labelValue("com.docker.compose.service")}</code>
                      <span className="muted">service</span>
                    </div>
                  )}
                  {labelValue("com.docker.compose.project.config_files") && (
                    <div className="inv-row">
                      <code>{labelValue("com.docker.compose.project.config_files")}</code>
                      <span className="muted">config</span>
                    </div>
                  )}
                </div>
              )}
              <div className="inv-group">
                <div className="inv-group-title">Peers on these networks</div>
                {peers.size === 0 ? <span className="muted">none</span> : [...peers.values()].map((p) => (
                  <div key={p.name} className="inv-row">
                    <button className="inv-link" onClick={() => p.id ? onNavigate({ kind: "container", id: p.id }) : onOpenContainers(p.name)}>{p.name}</button>
                    <span className="muted">{p.nets.join(", ")}</span>
                  </div>
                ))}
              </div>
            </>
          )}

          {image && (
            <>
              <div className="inv-group">
                <div className="inv-group-title">Used by containers</div>
                {usedBy.length === 0 ? <span className="muted">none running or stopped</span> : usedBy.map((c) => (
                  <div key={c.id} className="inv-row">
                    <button className="inv-link" onClick={() => onNavigate({ kind: "container", id: c.id })}>{c.name}</button>
                    <span className={`status-badge ${c.state === "running" ? "running" : "stopped"}`}><span className="dot" />{c.state}</span>
                  </div>
                ))}
              </div>
              <div className="inv-group">
                <div className="inv-group-title">Exposed ports</div>
                <div className="cd-chips">
                  {iDetail?.exposed_ports?.length ? iDetail.exposed_ports.map((p) => <span className="cd-chip" key={p}>{p}</span>) : <span className="muted">none declared</span>}
                </div>
              </div>
              <div className="inv-group">
                <div className="inv-group-title">Volumes</div>
                <div className="cd-chips">
                  {iDetail?.volumes?.length ? iDetail.volumes.map((p) => <span className="cd-chip" key={p}>{p}</span>) : <span className="muted">none declared</span>}
                </div>
              </div>
              <div className="inv-group">
                <div className="inv-group-title">Digests</div>
                <div className="cd-chips">
                  {iDetail?.digests?.length ? iDetail.digests.map((d) => <span className="cd-chip" key={d}><code>{d}</code></span>) : <span className="muted">local build, no digest</span>}
                </div>
              </div>
            </>
          )}

          {volume && (
            <div className="inv-group">
              <div className="inv-group-title">Used by containers</div>
              {usedBy.length === 0 ? <span className="muted">not mounted by any container</span> : usedBy.map((c) => {
                const mount = c.mounts.split(",").map((m) => m.trim()).find((m) => m.split(":")[0] === subject.id);
                return (
                  <div key={c.id} className="inv-row">
                    <button className="inv-link" onClick={() => onNavigate({ kind: "container", id: c.id })}>{c.name}</button>
                    <span className="muted">{mount ? mount.split(":").slice(1).join(":") || "/" : c.state}</span>
                  </div>
                );
              })}
            </div>
          )}

          {network && (
            <div className="inv-group">
              <div className="inv-group-title">Attached containers</div>
              {(nDetail?.containers ?? network.containers.map((c) => ({ ...c, id: "", ipv6: "" }))).length === 0 ? <span className="muted">none</span> : (nDetail?.containers ?? network.containers.map((c) => ({ ...c, id: "", ipv6: "" }))).map((c) => {
                const hit = containers.find((x) => (c.id && x.id === c.id) || x.name === c.name);
                return (
                  <div key={c.name} className="inv-row">
                    <button className="inv-link" onClick={() => hit ? onNavigate({ kind: "container", id: hit.id }) : onOpenContainers(c.name)}>
                      {c.name}<span className="muted"> · {c.ip || "no ip"}{c.mac ? ` · ${c.mac}` : ""}</span>
                    </button>
                    {hit && <span className={`status-badge ${hit.state === "running" ? "running" : "stopped"}`}><span className="dot" />{hit.state}</span>}
                  </div>
                );
              })}
            </div>
          )}
        </section>
        </div>

        {container && (
          <>
            <section className="panel inv-wide">
              <div className="inv-panel-head">
                <h3>Recent output</h3>
                <span className="muted inv-note">last 60 lines</span>
                <button className="icon-plain" onClick={() => setLogsNonce((n) => n + 1)} aria-label="Reload output" title="Reload output">
                  <RefreshIcon size={15} />
                </button>
              </div>
              {logsError ? <p className="muted">{logsError}</p> : logs === null ? <p className="muted">reading…</p> : logs.trim() ? <pre className="logs inv-logs">{logs}</pre> : <p className="muted">no output yet</p>}
            </section>

            <KeyValuePanel title="Environment" pairs={cDetail?.env ?? []} note="secrets are masked" />
            <LabelsPanel groups={labelGroups} note={imageLabels === null ? "image labels unavailable" : undefined} />
          </>
        )}

        {image && (
          <>
            <BuildHistory layers={iDetail?.history ?? []} />
            <KeyValuePanel title="Environment" pairs={iDetail?.env ?? []} note="baked into the image" />
            <LabelsPanel groups={labelGroups} note="image metadata" />
          </>
        )}

        {volume && <VolumeContents profile={profile} name={subject.id} />}
        {volume && <LabelsPanel groups={labelGroups} note="volume metadata" />}
        {network && <LabelsPanel groups={labelGroups} note="network metadata" />}
        {network && nDetail?.options?.length ? <KeyValuePanel title="Driver options" pairs={nDetail.options} /> : null}
      </div>

      {inspect && (
        <InspectModal
          kind={inspect.kind}
          name={inspect.name}
          raw={inspect.raw}
          error={inspect.error}
          onReload={loadInspect}
          onClose={() => setInspect(null)}
        />
      )}
    </div>
  );
}

/** Volumes match on the mount's name segment only: `data` must not match `data-volume`. */
export function containersUsingVolume(containers: Container[], name: string): Container[] {
  return containers.filter((c) => c.mounts.split(",").some((m) => m.trim().split(":")[0] === name));
}

type AssetEntry = {
  subject: Subject;
  label: string;
  meta: string;
  state?: "running" | "stopped";
  /** Container created by the profile's Kubernetes cluster. */
  pod?: boolean;
};

const KIND_LABEL: Record<Subject["kind"], string> = {
  container: "Containers",
  image: "Images",
  volume: "Volumes",
  network: "Networks",
  group: "Groups",
};

/** The empty state is the product: one search field, four kinds, every asset browsable. */
function AssetPicker({ containers, images, volumes, networks, netMap, daemonUp, profile, onPick }: {
  containers: Container[];
  images: Image[];
  volumes: Volume[];
  networks: Network[];
  netMap: NetworkMapEntry[];
  daemonUp: boolean;
  profile: string;
  onPick: (subject: Subject) => void;
}) {
  const [query, setQuery] = useState("");
  const [kind, setKind] = useState<"all" | Subject["kind"]>("all");
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { input.current?.focus(); }, []);

  const attached = new Map(netMap.map((n) => [n.name, n.containers.length]));
  // Built once per data change, not once per keystroke: four sorts plus a mount scan per
  // volume is the whole index, and the query only narrows it.
  const groups: { kind: Subject["kind"]; entries: AssetEntry[] }[] = useMemo(() => [
    {
      kind: "group",
      entries: (() => {
        const byProject = new Map<string, Container[]>();
        for (const c of containers) {
          if (!c.compose_project) continue;
          const rows = byProject.get(c.compose_project);
          if (rows) rows.push(c); else byProject.set(c.compose_project, [c]);
        }
        return [...byProject.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([project, rows]) => {
            const running = rows.filter((c) => c.state === "running").length;
            return {
              subject: { kind: "group" as const, id: project },
              label: project,
              meta: `${rows.length} container${rows.length === 1 ? "" : "s"} · ${running} running`,
              state: running > 0 ? "running" as const : "stopped" as const,
            };
          });
      })(),
    },
    {
      kind: "container",
      entries: [...containers]
        .sort((a, b) => (a.state === "running" ? 0 : 1) - (b.state === "running" ? 0 : 1) || a.name.localeCompare(b.name))
        .map((c) => ({
          subject: { kind: "container", id: c.id },
          label: c.name,
          meta: [c.image, c.compose_project].filter(Boolean).join(" · "),
          state: c.state === "running" ? "running" as const : "stopped" as const,
          pod: isKubernetesName(c.name),
        })),
    },
    {
      kind: "image",
      entries: [...images]
        .sort((a, b) => `${a.repository}:${a.tag}`.localeCompare(`${b.repository}:${b.tag}`))
        .map((i) => ({ subject: { kind: "image", id: i.id }, label: `${i.repository}:${i.tag}`, meta: i.size })),
    },
    {
      kind: "volume",
      entries: [...volumes]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((v) => {
          const used = containersUsingVolume(containers, v.name).length;
          return { subject: { kind: "volume", id: v.name }, label: v.name, meta: `${v.driver}${used ? ` · ${used} using` : ""}` };
        }),
    },
    {
      kind: "network",
      entries: [...networks]
        .sort((a, b) => a.name.localeCompare(b.name))
        .map((n) => {
          const count = attached.get(n.name);
          return { subject: { kind: "network", id: n.name }, label: n.name, meta: `${n.driver}${count ? ` · ${count} attached` : ""}` };
        }),
    },
  ], [containers, images, volumes, networks, netMap]);

  const q = query.trim().toLowerCase();
  const visible = groups
    .filter((g) => kind === "all" || g.kind === kind)
    .map((g) => ({ ...g, entries: g.entries.filter((e) => !q || e.label.toLowerCase().includes(q) || e.meta.toLowerCase().includes(q)) }))
    .filter((g) => g.entries.length > 0);
  const total = groups.reduce((n, g) => n + g.entries.length, 0);
  const first = visible[0]?.entries[0];
  const counts = Object.fromEntries(groups.map((g) => [g.kind, g.entries.length]));

  return (
    <div className="picker">
      <div className="picker-head">
        <span className="picker-icon" aria-hidden="true">
          <FingerprintIcon size={26} />
        </span>
        <h2>Choose an asset</h2>
        <p>Pick a Compose project, container, image, volume or network. Sherlock shows everything attached to it.</p>
      </div>

      {!daemonUp ? (
        <p className="picker-note">Profile <code>{profile}</code> is stopped. Start it from Machine to browse its assets.</p>
      ) : total === 0 ? (
        <p className="picker-note">Nothing to investigate yet — run a container or pull an image and it appears here.</p>
      ) : (
        <>
          <div className="picker-controls">
            <input
              ref={input}
              className="picker-search"
              spellCheck={false}
              autoCorrect="off"
              autoCapitalize="off"
              autoComplete="off"
              placeholder="Search projects, containers, images, volumes, networks…"
              aria-label="Search assets"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && first) { e.preventDefault(); onPick(first.subject); }
                if (e.key === "Escape") setQuery("");
              }}
            />
            <div className="picker-filters">
              <button className={`chip ${kind === "all" ? "active" : ""}`} onClick={() => setKind("all")}>
                All <span className="chip-count">{total}</span>
              </button>
              {(Object.keys(KIND_LABEL) as Subject["kind"][]).filter((k) => k !== "group" || counts.group > 0).map((k) => (
                <button key={k} className={`chip ${kind === k ? "active" : ""}`} onClick={() => setKind(k)}>
                  {KIND_LABEL[k]} <span className="chip-count">{counts[k]}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="picker-list">
            {visible.length === 0 ? (
              <p className="picker-empty">No assets match “{query.trim()}”.</p>
            ) : visible.map((g) => (
              <div className="picker-group" key={g.kind}>
                <div className="picker-group-title">
                  <span>{KIND_LABEL[g.kind]}</span>
                  <span>{g.entries.length}</span>
                </div>
                {g.entries.map((e) => (
                  <button className="picker-row" key={`${e.subject.kind}:${e.subject.id}`} title={e.label} onClick={() => onPick(e.subject)}>
                    <span className="pick-name">
                      {e.state && <span className={`pick-dot ${e.state}`} />}
                      {e.pod && <span className="k8s-chip" title="Created by the profile's Kubernetes cluster, not by you">k8s</span>}
                      <span className="pick-name-text">{e.label}</span>
                    </span>
                    <span className="pick-meta">{e.meta}</span>
                  </button>
                ))}
              </div>
            ))}
          </div>
          <p className="picker-hint"><kbd>↵</kbd> opens the first match</p>
        </>
      )}
    </div>
  );
}

function TagEditor({ kind, id }: { kind: TagKind; id: string }) {
  const [, force] = useState(0);
  const [value, setValue] = useState("");
  useEffect(() => subscribeTags(() => force((n) => n + 1)), []);
  const tags = tagsFor(kind, id);
  return (
    <div className="inv-group">
      <div className="inv-group-title">Tags</div>
      <div className="tag-row">
        {tags.map((tag) => (
          <span className="tag-chip" key={tag}>
            {tag}
            <button aria-label={`Remove tag ${tag}`} onClick={() => removeTag(kind, id, tag)}>×</button>
          </span>
        ))}
        <input
          className="tag-input"
          spellCheck={false}
          autoCorrect="off"
          autoCapitalize="off"
          autoComplete="off"
          placeholder="add tag…"
          aria-label="Add tag"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && value.trim()) {
              e.preventDefault();
              addTag(kind, id, value);
              setValue("");
            }
          }}
        />
      </div>
    </div>
  );
}

/** Image refs that point at this image, used to find dependent containers. */
function imageRefSet(images: Image[], subject: Subject): Set<string> {
  const refs = new Set<string>();
  if (subject.kind !== "image") return refs;
  for (const i of images) {
    if (i.id === subject.id) {
      refs.add(`${i.repository}:${i.tag}`);
      refs.add(i.id);
    }
  }
  return refs;
}
