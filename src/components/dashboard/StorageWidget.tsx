import { useState } from "react";
import type { DashboardContext } from "./context";
import { fmtSize } from "../../lib/format";

type Provider = "docker" | "podman";

type Slice = { label: string; value: number; color: string; tab: string };

const COLORS = { images: "#22c55e", containers: "#58a6ff", volumes: "#d29922", cache: "#a78bfa" };

/** A donut and its legend share one hover state, so the ring and the row highlight together. */
function StorageDonut({ slices, onOpen }: { slices: Slice[]; onOpen: (tab: string) => void }) {
  const [hover, setHover] = useState<string | null>(null);
  const size = 132, thickness = 18, r = (size - thickness) / 2, c = 2 * Math.PI * r;
  const total = slices.reduce((a, x) => a + x.value, 0);
  let acc = 0;

  return (
    <div className="storage-row">
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} className="donut">
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--border)" strokeWidth={thickness} />
        <g transform={`rotate(-90 ${size / 2} ${size / 2})`}>
          {slices.map((seg) => {
            const len = total ? (seg.value / total) * c : 0;
            const el = (
              <circle
                key={seg.label}
                cx={size / 2} cy={size / 2} r={r} fill="none"
                stroke={seg.color}
                strokeWidth={hover === seg.label ? thickness + 6 : thickness}
                strokeDasharray={`${len} ${c - len}`}
                strokeDashoffset={-acc}
                opacity={hover && hover !== seg.label ? 0.3 : 1}
                style={{ cursor: "pointer", transition: "stroke-width 0.12s ease, opacity 0.12s ease" }}
                onMouseEnter={() => setHover(seg.label)}
                onMouseLeave={() => setHover(null)}
                onClick={() => onOpen(seg.tab)}
              >
                <title>{`${seg.label}: ${fmtSize(seg.value)} — click to open`}</title>
              </circle>
            );
            acc += len;
            return el;
          })}
        </g>
        <text x="50%" y="47%" textAnchor="middle" fill="var(--text)" fontSize="15" fontWeight="700">{fmtSize(total)}</text>
        <text x="50%" y="60%" textAnchor="middle" fill="var(--muted)" fontSize="9" letterSpacing="1">TOTAL</text>
      </svg>
      <div className="legend">
        {slices.map((seg) => {
          const pct = total ? Math.round((seg.value / total) * 100) : 0;
          return (
            <button
              key={seg.label}
              className={`legend-row legend-btn ${hover === seg.label ? "active" : ""}`}
              onMouseEnter={() => setHover(seg.label)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onOpen(seg.tab)}
            >
              <span className="legend-dot" style={{ background: seg.color }} />
              <span className="legend-label">{seg.label}</span>
              <span className="legend-value">{fmtSize(seg.value)}</span>
              <span className="legend-pct">{pct}%</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export function StorageWidget({ disk, podmanDisk, podmanMachines, tools, running, selected, setTab, profiles, startSelectedOrCreate }: DashboardContext) {
  const [picked, setPicked] = useState<Provider | null>(null);
  const selectedRunning = running.some((p) => p.name === selected);
  const podmanUp = Boolean(tools?.podman) && podmanMachines.some((m) => m.running);

  const providers: { id: Provider; label: string }[] = [
    { id: "docker", label: "Docker" },
    ...(tools?.podman ? [{ id: "podman" as const, label: "Podman" }] : []),
  ];
  // Open on the provider that has a running engine; a stopped profile leaves Docker
  // showing its empty state, which is the honest answer.
  const preferred: Provider = selectedRunning ? "docker" : podmanUp ? "podman" : "docker";
  const active = picked && providers.some((p) => p.id === picked)
    ? picked
    : providers.some((p) => p.id === preferred) ? preferred : providers[0].id;

  const dockerSlices: Slice[] = [
    { label: "Images", value: disk.images, color: COLORS.images, tab: "images" },
    { label: "Containers", value: disk.containers, color: COLORS.containers, tab: "containers" },
    { label: "Volumes", value: disk.volumes, color: COLORS.volumes, tab: "volumes" },
    { label: "Build cache", value: disk.build_cache, color: COLORS.cache, tab: "cleanup" },
  ];
  const podmanSlices: Slice[] = [
    { label: "Images", value: podmanDisk.images, color: COLORS.images, tab: "podman-images" },
    { label: "Containers", value: podmanDisk.containers, color: COLORS.containers, tab: "podman-containers" },
    { label: "Volumes", value: podmanDisk.volumes, color: COLORS.volumes, tab: "podman-volumes" },
  ];

  return (
    <div className="panel storage-panel">
      <div className="storage-head">
        <h3>Storage usage</h3>
        {providers.length > 1 && (
          <div className="chips" aria-label="Storage provider">
            {providers.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`chip ${active === p.id ? "active" : ""}`}
                aria-pressed={active === p.id}
                onClick={() => setPicked(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        )}
      </div>

      {active === "docker" && (selectedRunning ? (
        <>
          <StorageDonut slices={dockerSlices} onOpen={setTab} />
          <div className="storage-foot">
            <span className="muted">Read by <code>docker system df</code></span>
            <button className="inv-link" onClick={() => setTab("cleanup")}>{fmtSize(disk.reclaimable)} reclaimable</button>
          </div>
        </>
      ) : (
        <p className="muted storage-note">
          {profiles.length === 0 ? "No Colima profile yet." : <>Profile <code>{selected}</code> is stopped.</>} Storage is not read.{" "}
          <button className="inv-link" onClick={startSelectedOrCreate}>{profiles.length === 0 ? "New profile…" : "Start profile"}</button>
        </p>
      ))}

      {active === "podman" && (podmanUp ? (
        <>
          <StorageDonut slices={podmanSlices} onOpen={setTab} />
          <div className="storage-foot">
            <span className="muted">Read by <code>podman system df</code></span>
            <span className="muted">{fmtSize(podmanDisk.reclaimable)} reclaimable</span>
          </div>
        </>
      ) : (
        <p className="muted storage-note">No running Podman machine — start one in Podman Machines.</p>
      ))}
    </div>
  );
}
