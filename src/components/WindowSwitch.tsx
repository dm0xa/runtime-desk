import { fmtSpan } from "../lib/format";
import { LIVE_WINDOWS, setLiveWindow, useLiveWindow } from "../lib/liveWindow";

/** One shared window for every live chart: two minutes of detail, or ten of context. */
export function WindowSwitch() {
  const value = useLiveWindow();
  return (
    <div className="live-window" role="group" aria-label="Chart window">
      {LIVE_WINDOWS.map((samples) => (
        <button
          key={samples}
          type="button"
          aria-pressed={value === samples}
          className={value === samples ? "on" : ""}
          onClick={() => setLiveWindow(samples)}
        >
          {fmtSpan(samples)}
        </button>
      ))}
    </div>
  );
}
