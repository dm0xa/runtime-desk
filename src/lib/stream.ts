import { Channel, invoke } from "@tauri-apps/api/core";

/**
 * Live `docker events` stream, the alternative to polling every fifteen seconds.
 *
 * One lifecycle, owned by the App: start it when a docker-runtime profile is running and
 * the window is visible, stop it otherwise. Events only mark state stale — the App still
 * owns the refresh, so a burst of pulls becomes one refresh instead of twenty.
 *
 * containerd profiles answer `polling`: nerdctl's stream has no `--since` to replay a
 * dropped connection and no type filter, so those keep the timed refresh.
 */

/** A pull of twenty images fires twenty events; one refresh is enough. */
const DEBOUNCE_MS = 250;
/** Health checks and `docker exec` emit three events each and never change a view. */
const NOISE_ACTION = /^exec_/;
/** Event types that can change something a view renders. */
const RELEVANT_TYPE: Record<string, true> = { container: true, image: true, network: true, volume: true };

const END = "__events_end__";

let channel: Channel<string> | null = null;
let generation = 0;
/** Starts and stops counted apart: an await that resumes must tell which one it lost to. */
let starts = 0;
let stops = 0;
let timer: number | undefined;
let listener: (() => void) | null = null;
let streaming = false;

/** True once the backend confirmed a child is running; the App stretches its timer then. */
export function eventStreamActive(): boolean {
  return streaming;
}

export async function startEventStream(onChange: () => void): Promise<void> {
  stopEventStream();
  listener = onChange;
  const mine = generation;
  const ch = new Channel<string>();
  ch.onmessage = (line: string) => {
    if (mine !== generation) return;
    // The child closed (daemon restarted, VM stopped). Drop the claim of a live stream so the
    // App returns to its fifteen-second refresh, and read once now that we are blind.
    if (line === END) {
      streaming = false;
      listener?.();
      return;
    }
    // `type\taction`; the backend asks docker for exactly these two fields.
    const tab = line.indexOf("\t");
    if (tab <= 0) return;
    const type = line.slice(0, tab);
    const action = line.slice(tab + 1);
    if (RELEVANT_TYPE[type] !== true) return;
    if (action && NOISE_ACTION.test(action)) return;
    clearTimeout(timer);
    timer = setTimeout(() => {
      timer = undefined;
      listener?.();
    }, DEBOUNCE_MS);
  };
  channel = ch;
  const mineStart = ++starts;
  const mineStop = stops;
  let live = false;
  try {
    live = (await invoke<string>("events_start_cmd", { onEvent: ch })) === "streaming";
  } catch {
    live = false;
  }
  // A newer start owns the child now (the backend kills the previous one), so late-arriving
  // here must not claim or kill anything.
  if (mineStart !== starts) return;
  // A stop landed while this child was spawning: the stop ran before the child existed, so
  // nobody else will end it. Kill the orphan instead of latching `streaming` on a child the
  // App has already stopped caring about.
  if (mineStop !== stops) {
    if (live) void invoke("events_stop_cmd").catch(() => {});
    return;
  }
  streaming = live;
}

export function stopEventStream(): void {
  generation++;
  stops++;
  clearTimeout(timer);
  timer = undefined;
  listener = null;
  streaming = false;
  if (!channel) return;
  channel.onmessage = () => {};
  channel = null;
  void invoke("events_stop_cmd").catch(() => {});
}
