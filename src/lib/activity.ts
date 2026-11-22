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
/** Points kept per series: ten minutes at the one-second accounting cadence. The views draw
 *  the last 120 or all 600, so a ten-minute choice costs no second sampler. */
const SAMPLES = 600;
/** Accounting runs on its own second: the stream answers per container, the charts want one
 *  full snapshot, and the network rate needs a known interval. */
const ACCOUNTING_MS = 1000;
export const ACTIVITY_STEP_MS = ACCOUNTING_MS;
const END = "__stats_end__";

type Series = { cpu: number[]; mem: number[]; netRx: number[]; netTx: number[]; blkRead: number[]; blkWrite: number[] };
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
/** When the last accounting tick landed. A gate that opens after a pause must not splice the
 *  new samples onto the old ones: the chart would claim a window it does not hold. */
let lastTick = 0;
/** When a sample last actually arrived. `snapshot.at` is the tick's stamp and moves even when
 *  the child is silent, so only this can tell a stalled stream from a healthy one. */
let newestSampleAt = 0;
/** The profile the history belongs to. Two running profiles both keep the gate open, and the
 *  sampler's child holds the endpoint it was started with: a switch must start a new recording. */
let recordingProfile = "";
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
    const h = history.get(s.id) ?? { cpu: [], mem: [], netRx: [], netTx: [], blkRead: [], blkWrite: [] };
    push(h.cpu, s.cpu);
    push(h.mem, s.mem);
    push(h.netRx, s.net_rx);
    push(h.netTx, s.net_tx);
    push(h.blkRead, s.block_read);
    push(h.blkWrite, s.block_write);
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
  lastTick = snapshot.at;
  emit();
}

function failed(e: unknown) {
  snapshot = { stats: [], at: Date.now(), error: String(e) };
  history.clear();
  for (const list of Object.values(totals)) list.length = 0;
  lastNet = null;
  lastTick = 0;
  newestSampleAt = 0;
  emit();
}

/** The fallback: one `--no-stream` round trip per fixed delay, never overlapping. */
function poll(): () => void {
  let stopped = false;
  const loop = async () => {
    if (stopped) return;
    const began = Date.now();
    try {
      const stats = await invoke<ContainerStat[]>("container_stats_cmd");
      newestSampleAt = Date.now();
      apply(stats);
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
      newestSampleAt = Date.now();
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

/** Called by the App from the dependency gate; the only place sampling starts/stops.
 *  `profile` is the recording's identity: two running profiles both keep the gate open, and
 *  `docker stats` was spawned against one endpoint, so a switch has to start a new recording
 *  instead of splicing the second daemon's rows and totals onto the first's. */
export function setActivityActive(active: boolean, profile = "") {
  if (active === sampling && profile === recordingProfile) return;
  const switched = profile !== recordingProfile;
  recordingProfile = profile;
  sampling = active;
  generation++;
  stopSampling?.();
  stopSampling = null;
  latest = new Map();
  if (active) {
    // More than two silent ticks is a new recording, not a continuation, and another profile
    // is a different daemon: either way the old samples would draw a window that never
    // happened. A tab switch changes neither, so its history survives.
    if (switched || (lastTick && Date.now() - lastTick > ACCOUNTING_MS * 2.5)) {
      history.clear();
      misses.clear();
      seen.clear();
      for (const list of Object.values(totals)) list.length = 0;
      snapshot = { stats: [], at: 0, error: null };
      lastNet = null;
      lastTick = 0;
      newestSampleAt = 0;
    }
    void sample(generation);
  }
}

export function subscribeActivity(listener: () => void): () => void {
  listeners.add(listener);
  listener();
  return () => { listeners.delete(listener); };
}

export function activitySnapshot(): ActivitySnapshot {
  return snapshot;
}

/** When a sample last arrived (`0` before the first). `snapshot.at` moves every tick even
 *  when the child is silent, so a stalled sampler is only visible through this. */
export function activitySampleAt(): number {
  return newestSampleAt;
}

/** Aggregate history across containers, newest right; at most SAMPLES entries. */
export function activityTotals(): {
  cpu: number[]; mem: number[];
  netRx: number[]; netTx: number[];
  netRxRate: number[]; netTxRate: number[];
} {
  return totals;
}

export type ContainerSeries = { cpu: number[]; mem: number[]; netRx: number[]; netTx: number[]; blkRead: number[]; blkWrite: number[] };
const EMPTY_SERIES: ContainerSeries = { cpu: [], mem: [], netRx: [], netTx: [], blkRead: [], blkWrite: [] };

/**
 * Recorded series for one container, oldest first, capped at the activity window. Read-only:
 * charts read these in place instead of copying every tick.
 */
export function activitySeriesFor(id: string): ContainerSeries {
  return history.get(id) ?? EMPTY_SERIES;
}

/**
 * Highest CPU share in the recorded history, for the shared sparkline scale.
 * Using the history peak (not the current busiest container) keeps every row's
 * vertical scale fixed while the numbers move underneath it.
 */
export function activityCpuPeak(samples = SAMPLES): number {
  let peak = 0;
  for (const series of history.values()) {
    const from = Math.max(0, series.cpu.length - samples);
    for (let i = from; i < series.cpu.length; i++) if (series.cpu[i] > peak) peak = series.cpu[i];
  }
  return peak;
}

/**
 * SVG polyline points for one container's CPU history, right-aligned so the newest sample sits at `width`.
 * `ceiling` lets several rows share a vertical scale; omit it to scale a row to its own peak.
 *
 * The ten-minute window holds 600 samples for a 120 px box: formatting all of them was 16.5 ms
 * per tick at 200 containers (4.7× the two-minute window) for points no display can resolve.
 * Past one point per pixel the samples are bucketed and each bucket keeps its maximum, so a
 * spike still shows instead of being skipped by a stride.
 */
export function activitySparkPoints(id: string, width: number, height: number, ceiling?: number, samples = SAMPLES): string {
  const data = (history.get(id)?.cpu ?? []).slice(-samples);
  if (data.length < 2) return "";
  const scale = Math.max(ceiling ?? Math.max(...data), 1e-9);
  const span = samples - 1;
  const offset = samples - data.length;
  const y = (v: number) => (height - Math.min(1, v / scale) * height).toFixed(1);
  const points = Math.max(2, Math.ceil(width));
  if (data.length <= points) {
    return data.map((v, i) => `${(((offset + i) / span) * width).toFixed(1)},${y(v)}`).join(" ");
  }
  const per = data.length / points;
  const out: string[] = [];
  for (let b = 0; b < points; b++) {
    const from = Math.floor(b * per);
    const to = Math.min(data.length, Math.floor((b + 1) * per));
    if (to <= from) continue;
    let high = data[from];
    for (let i = from + 1; i < to; i++) if (data[i] > high) high = data[i];
    const x = ((offset + (from + to - 1) / 2) / span) * width;
    out.push(`${x.toFixed(1)},${y(high)}`);
  }
  // The newest sample sits exactly at the right edge, as it does in the unbatched path: a
  // bucket centre would leave the line ending visibly short of "now".
  out.push(`${width.toFixed(1)},${y(data[data.length - 1])}`);
  return out.join(" ");
}
