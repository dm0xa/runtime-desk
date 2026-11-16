import { Channel, invoke } from "@tauri-apps/api/core";
import type { ContainerStat } from "../types";

/**
 * Live container stats, sampled while the gate is open instead of by each view.
 * Views subscribe; the App owns the lifecycle so switching tabs never loses history.
 *
 * One `docker stats` child streams every container at about 1 Hz. The old path spawned
 * `docker stats --no-stream` every two seconds — measured at 1.06 s of child per call, i.e.
 * half a core-second of process churn per second of monitoring — so the stream is the
 * primary source and the poll is only the fallback for a client that refuses it.
 */

const INTERVAL = 2000;
/** Points kept per series. Accounting runs once a second, so 72 points are the 72 s the
 *  charts have always claimed; doubling the count is what keeps the label honest at 1 Hz. */
const SAMPLES = 72;
/** Accounting runs on its own second: the stream answers per container, the charts want one
 *  full snapshot, and the network rate needs a known interval. */
const ACCOUNTING_MS = 1000;
export const ACTIVITY_STEP_MS = ACCOUNTING_MS;
export const ACTIVITY_WINDOW_S = (SAMPLES * ACCOUNTING_MS) / 1000;
const END = "__stats_end__";

type Series = { cpu: number[]; mem: number[]; netRx: number[]; netTx: number[] };
export type ActivitySnapshot = { stats: ContainerStat[]; at: number; error: string | null };

let stopSampling: (() => void) | null = null;
let latest = new Map<string, ContainerStat>();
/** How many accounting ticks each container has gone without a sample. `docker stats` stops
 *  emitting a container about a second after it exits, so without this its last numbers stay
 *  on screen for ever as a "live" row. Two ticks tolerate a slow stream. */
const misses = new Map<string, number>();
/** Ids that reported a sample since the last accounting tick. */
const seen = new Set<string>();
const MISS_LIMIT = 2;
let snapshot: ActivitySnapshot = { stats: [], at: 0, error: null };
const history = new Map<string, Series>();
/** Aggregate series per tick, for the Activity charts. */
const totals = {
  cpu: [] as number[], mem: [] as number[],
  netRx: [] as number[], netTx: [] as number[],
  netRxRate: [] as number[], netTxRate: [] as number[],
};
let lastNet: { at: number; rx: number; tx: number } | null = null;
const listeners = new Set<() => void>();

function push(list: number[], value: number) {
  list.push(value);
  if (list.length > SAMPLES) list.shift();
}

function emit() {
  for (const listener of listeners) listener();
}

/** Folds one full snapshot into history, totals, the OOM guard's view and the subscribers. */
function apply(stats: ContainerStat[]) {
  snapshot = { stats, at: Date.now(), error: null };
  for (const s of stats) {
    const h = history.get(s.id) ?? { cpu: [], mem: [], netRx: [], netTx: [] };
    push(h.cpu, s.cpu);
    push(h.mem, s.mem);
    push(h.netRx, s.net_rx);
    push(h.netTx, s.net_tx);
    history.set(s.id, h);
  }
  for (const key of [...history.keys()]) if (!stats.some((s) => s.id === key)) history.delete(key);
  push(totals.cpu, stats.reduce((n, s) => n + s.cpu, 0));
  push(totals.mem, stats.reduce((n, s) => n + s.mem, 0));
  const rx = stats.reduce((n, s) => n + s.net_rx, 0);
  const tx = stats.reduce((n, s) => n + s.net_tx, 0);
  push(totals.netRx, rx);
  push(totals.netTx, tx);
  if (lastNet) {
    const seconds = Math.max((snapshot.at - lastNet.at) / 1000, 0.5);
    push(totals.netRxRate, Math.max(0, rx - lastNet.rx) / seconds);
    push(totals.netTxRate, Math.max(0, tx - lastNet.tx) / seconds);
  }
  lastNet = { at: snapshot.at, rx, tx };
  emit();
}

function failed(e: unknown) {
  snapshot = { stats: [], at: Date.now(), error: String(e) };
  history.clear();
  for (const list of Object.values(totals)) list.length = 0;
  lastNet = null;
  emit();
}

/** The fallback: one `--no-stream` round trip per fixed delay, never overlapping. */
function poll(): () => void {
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    const began = Date.now();
    try {
      apply(await invoke<ContainerStat[]>("container_stats_cmd"));
    } catch (e) {
      failed(e);
    }
    if (stopped) return;
    setTimeout(loop, Math.max(INTERVAL, Date.now() - began));
  };
  void loop();
  return () => { stopped = true; };
}

/** The stream, or null when the backend did not start one. */
async function stream(onEnd: () => void): Promise<(() => void) | null> {
  const ch = new Channel<string>();
  let closed = false;
  ch.onmessage = (line: string) => {
    if (closed) return;
    if (line === END) {
      closed = true;
      onEnd();
      return;
    }
    try {
      const stat = JSON.parse(line) as ContainerStat;
      // The CLI prints one transient row with an empty id while a container is created.
      if (!stat.id) return;
      latest.set(stat.id, stat);
      seen.add(stat.id);
      misses.delete(stat.id);
    } catch {
      // A partial line from a killed child is not worth an error.
    }
  };
  try {
    if ((await invoke<string>("stats_all_start_cmd", { onSample: ch })) !== "streaming") return null;
  } catch {
    return null;
  }
  return () => {
    closed = true;
    ch.onmessage = () => {};
    void invoke("stats_all_stop_cmd").catch(() => {});
  };
}

/** True while the gate is open, so a late stream answer can tell it is unwanted. */
let sampling = false;
/** Bumped on every start/stop, so a finishing start cannot resurrect a stopped gate. */
let generation = 0;

async function sample(gen: number) {
  const stopStream = await stream(() => {
    // The child closed: daemon restarted, the VM stopped, or the profile changed under it.
    // The poll applies a fresh reading on its first pass, so do not read here as well: that
    // was a second `docker stats` child (~2 s) racing the poll's own.
    if (gen !== generation) return;
    stopSampling?.();
    latest = new Map();
    misses.clear();
    stopSampling = poll();
  });
  if (gen !== generation) {
    stopStream?.();
    return;
  }
  if (!stopStream) {
    stopSampling = poll();
    return;
  }
  const id = setInterval(() => {
    // A container the stream stopped reporting is gone: `docker stats` ends its lines about a
    // second after the exit, and without this its last numbers would stay on screen as a live
    // row for ever, with history nothing ever clears. A slow tick tolerates a missed sample.
    for (const key of [...latest.keys()]) {
      if (seen.has(key)) {
        misses.delete(key);
        continue;
      }
      const next = (misses.get(key) ?? 0) + 1;
      if (next < MISS_LIMIT) {
        misses.set(key, next);
        continue;
      }
      latest.delete(key);
      misses.delete(key);
      history.delete(key);
    }
    seen.clear();
    // Always publish: when the last container exits, the tick must hand the views an empty
    // snapshot, or the rows that were there freeze on screen for ever.
    apply([...latest.values()]);
  }, ACCOUNTING_MS);
  stopSampling = () => {
    clearInterval(id);
    stopStream();
  };
}

/** Called by the App from the dependency gate; the only place sampling starts/stops. */
export function setActivityActive(active: boolean) {
  if (active === sampling) return;
  sampling = active;
  generation++;
  stopSampling?.();
  stopSampling = null;
  latest = new Map();
  if (active) void sample(generation);
}

export function subscribeActivity(listener: () => void): () => void {
  listeners.add(listener);
  listener();
  return () => { listeners.delete(listener); };
}

export function activitySnapshot(): ActivitySnapshot {
  return snapshot;
}

/** Aggregate history across containers, newest right; at most SAMPLES entries. */
export function activityTotals(): {
  cpu: number[]; mem: number[];
  netRx: number[]; netTx: number[];
  netRxRate: number[]; netTxRate: number[];
} {
  return totals;
}

export const ACTIVITY_SAMPLES = SAMPLES;

/**
 * Highest CPU share in the recorded history, for the shared sparkline scale.
 * Using the history peak (not the current busiest container) keeps every row's
 * vertical scale fixed while the numbers move underneath it.
 */
export function activityCpuPeak(): number {
  let peak = 0;
  for (const series of history.values()) {
    for (const v of series.cpu) if (v > peak) peak = v;
  }
  return peak;
}

/**
 * SVG polyline points for one container's CPU history, right-aligned so the newest sample sits at `width`.
 * `ceiling` lets several rows share a vertical scale; omit it to scale a row to its own peak.
 */
export function activitySparkPoints(id: string, width: number, height: number, ceiling?: number): string {
  const data = history.get(id)?.cpu ?? [];
  if (data.length < 2) return "";
  const peak = Math.max(ceiling ?? Math.max(...data), 1e-9);
  const span = SAMPLES - 1;
  const offset = SAMPLES - data.length;
  return data
    .map((v, i) => `${(((offset + i) / span) * width).toFixed(1)},${(height - Math.min(1, v / peak) * height).toFixed(1)}`)
    .join(" ");
}
