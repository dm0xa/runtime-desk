type Band = {
  key: string;
  name: string;
  /** CSS colour (a `var(--seg-N)` token), shared with the legend row below. */
  color: string;
  /** Samples, oldest first; short series sit at the right edge. */
  values: number[];
};

const WIDTH = 640;
const HEIGHT = 104;

/**
 * One stacked area chart for a container group: each band is a container's history and the
 * stack's top edge is the group total, so the picture answers both questions at once — how
 * much the group uses and who is using it. CPU, memory and network pass the same bands and
 * colours, so a colour means one container across all three charts.
 */
export function GroupStackChart({ bands, slots, label, format, floor = 0, secondary, secondaryLabel, activeKey = null }: {
  bands: Band[];
  slots: number;
  label: string;
  /** Axis and tooltip value formatter; the unit differs per metric. */
  format: (value: number) => string;
  /** Known ceiling of one sample (100 for CPU's share of a core); keeps an idle group honest. */
  floor?: number;
  /** Group total drawn as a light line, for a second metric such as network transmit. */
  secondary?: number[];
  secondaryLabel?: string;
  /** The band linked to a hovered row: everything else dims so one container is traceable. */
  activeKey?: string | null;
}) {
  const length = Math.max(0, ...bands.map((b) => b.values.length));
  const n = Math.min(length, slots);
  if (n < 2) {
    return (
      <div className="group-chart-empty" role="status">
        Collecting the first samples from <code>docker stats</code>…
      </div>
    );
  }

  // Once there is a shape to read, draw the recorded span across the full width; a six-second
  // trend squeezed into the right eighth of the panel reads as an empty chart. Below three
  // samples the span keeps its true share so a flat pair is not stretched into a band.
  const span = n >= 3 ? n : slots;
  const offset = n >= 3 ? 0 : slots - n;
  const x = (j: number) => ((offset + j) / (span - 1)) * WIDTH;

  const cumulative = new Array<number>(n).fill(0);
  for (const band of bands) for (let j = 0; j < n; j++) cumulative[j] += band.values[band.values.length - n + j] ?? 0;
  const secondaryAligned = secondary ? secondary.slice(-n) : [];
  const ceiling = Math.max(floor, Math.max(...cumulative, ...secondaryAligned, 0) * 1.06, 1e-9);
  const y = (v: number) => HEIGHT - Math.min(1, Math.max(0, v) / ceiling) * (HEIGHT - 1) - 0.5;
  const total = cumulative[n - 1];

  const bottoms = new Array<number>(n).fill(0);
  const paths = bands.map((band) => {
    const top: string[] = [];
    const bottom: string[] = [];
    for (let j = 0; j < n; j++) {
      const value = band.values[band.values.length - n + j] ?? 0;
      top.push(`${x(j).toFixed(1)},${y(bottoms[j] + value).toFixed(1)}`);
      bottom.push(`${x(j).toFixed(1)},${y(bottoms[j]).toFixed(1)}`);
      bottoms[j] += value;
    }
    const peak = Math.max(...band.values);
    return {
      band,
      peak,
      line: `M${top.join(" L")}`,
      area: `M${top.join(" L")} L${bottom.reverse().join(" L")} Z`,
    };
  });
  const secondaryLine = secondaryAligned.length
    ? `M${secondaryAligned.map((v, j) => `${x(j).toFixed(1)},${y(v).toFixed(1)}`).join(" L")}`
    : "";

  return (
    <svg
      className="group-chart"
      viewBox={`0 0 ${WIDTH} ${HEIGHT}`}
      preserveAspectRatio="none"
      role="img"
      aria-label={`${label}: ${format(total)} now, split across ${bands.length} band${bands.length === 1 ? "" : "s"}`}
    >
      {[0.25, 0.5, 0.75].map((fraction) => (
        <line key={fraction} className="spark-mid" x1="0" y1={HEIGHT * fraction} x2={WIDTH} y2={HEIGHT * fraction} vectorEffect="non-scaling-stroke" />
      ))}
      <line className="spark-axis" x1="0" y1={HEIGHT - 0.5} x2={WIDTH} y2={HEIGHT - 0.5} vectorEffect="non-scaling-stroke" />
      {paths.map(({ band, area, line, peak }) => {
        const active = activeKey !== null && band.key === activeKey;
        const dim = activeKey !== null && !active;
        return (
          <g key={band.key}>
            <path
              className="group-chart-band"
              d={area}
              fill={band.color}
              style={{ fillOpacity: active ? 0.72 : dim ? 0.07 : 0.5 }}
            >
              <title>{`${band.name} — now ${format(band.values[band.values.length - 1] ?? 0)}, peak ${format(peak)}`}</title>
            </path>
            <path
              className="group-chart-edge"
              d={line}
              stroke={band.color}
              style={{ strokeWidth: active ? 2 : 1.2, opacity: dim ? 0.16 : active ? 1 : 0.85 }}
              vectorEffect="non-scaling-stroke"
            />
          </g>
        );
      })}
      {secondaryLine && (
        <path
          className="group-chart-secondary"
          d={secondaryLine}
          style={{ opacity: activeKey !== null ? 0.16 : 0.45 }}
          vectorEffect="non-scaling-stroke"
        >
          <title>{secondaryLabel ?? "Group total"}</title>
        </path>
      )}
    </svg>
  );
}
