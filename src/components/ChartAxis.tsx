import { fmtSpan } from "../lib/format";

/**
 * The horizontal frame a live chart otherwise leaves implicit: the left edge is the oldest
 * recorded sample and the right edge is the newest. `seconds` is the span the series actually
 * holds, so a chart that is still filling does not claim the full window.
 */
export function ChartAxis({ seconds }: { seconds: number }) {
  if (seconds < 2) return null;
  return (
    <div className="chart-axis" aria-hidden="true">
      <span>{fmtSpan(seconds)} ago</span>
      <span>now</span>
    </div>
  );
}
