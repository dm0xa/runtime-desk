import { useSyncExternalStore } from "react";

/** The live charts are a ring buffer; this is how much of it a view draws. */
export const LIVE_WINDOWS = [120, 600] as const;
export type LiveWindow = (typeof LIVE_WINDOWS)[number];
const KEY = "runtimeDesk.liveWindow";
const listeners = new Set<() => void>();

function read(): LiveWindow {
  try {
    return Number(localStorage.getItem(KEY)) === 600 ? 600 : 120;
  } catch {
    return 120;
  }
}

let current = read();

export const liveWindow = () => current;

export function setLiveWindow(next: LiveWindow) {
  if (next === current) return;
  current = next;
  try { localStorage.setItem(KEY, String(next)); } catch { /* private mode */ }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

/** One window choice shared by Activity, Sherlock's Performance and its Compose group page. */
export const useLiveWindow = () => useSyncExternalStore(subscribe, liveWindow);
