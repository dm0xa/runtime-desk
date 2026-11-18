import { useState } from "react";
import type { DashboardContext } from "./context";
import { fmtSize } from "../../lib/format";

type Provider = "all" | "docker" | "podman";

/** `tab` is absent on the combined view: its rows sum two engines whose lists live on separate
 *  pages, so there is no single page a row could open. */
type Slice = { label: string; value: number; color: string; tab?: string };

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
                style={{ cursor: seg.tab ? "pointer" : "default", transition: "stroke-width 0.12s ease, opacity 0.12s ease" }}
                onMouseEnter={() => setHover(seg.label)}
                onMouseLeave={() => setHover(null)}
                onClick={() => { if (seg.tab) onOpen(seg.tab); }}
              >
                <title>{`${seg.label}: ${fmtSize(seg.value)}${seg.tab ? " — click to open" : ""}`}</title>
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
          const cells = (
            <>
              <span className="legend-dot" style={{ background: seg.color }} />
              <span className="legend-label">{seg.label}</span>
              <span className="legend-value">{fmtSize(seg.value)}</span>
              <span className="legend-pct">{pct}%</span>
            </>
          );
          const tab = seg.tab;
          if (!tab) {
            return <div key={seg.label} className="legend-row">{cells}</div>;
          }
          return (
            <button
              key={seg.label}
              className={`legend-row legend-btn ${hover === seg.label ? "active" : ""}`}
              onMouseEnter={() => setHover(seg.label)}
              onMouseLeave={() => setHover(null)}
              onClick={() => onOpen(tab)}
            >
              {cells}
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
  const hasPodman = Boolean(tools?.podman);
  const podmanUp = hasPodman && podmanMachines.some((m) => m.running);

  const providers: { id: Provider; label: string }[] = [
    ...(hasPodman ? [{ id: "all" as const, label: "All" }] : []),
    { id: "docker" as const, label: "Docker" },
    ...(hasPodman ? [{ id: "podman" as const, label: "Podman" }] : []),
  ];
  // Open on the combined view only when it actually combines: one engine answering keeps its
  // own donut (a sum plus an apologetic footnote would read as a defect). All stays one click
  // away and then names whichever engine is missing.
  const preferred: Provider = selectedRunning && podmanUp ? "all" : selectedRunning ? "docker" : podmanUp ? "podman" : "docker";
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
  // Only engines that were actually read contribute: a stopped profile must not add zeros that
  // read as "Docker is empty". Build cache has no Podman counterpart, so the row exists only
  // while Docker answered.
  const allSlices: Slice[] = [
    { label: "Images", value: (selectedRunning ? disk.images : 0) + (podmanUp ? podmanDisk.images : 0), color: COLORS.images },
    { label: "Containers", value: (selectedRunning ? disk.containers : 0) + (podmanUp ? podmanDisk.containers : 0), color: COLORS.containers },
    { label: "Volumes", value: (selectedRunning ? disk.volumes : 0) + (podmanUp ? podmanDisk.volumes : 0), color: COLORS.volumes },
    ...(selectedRunning ? [{ label: "Build cache", value: disk.build_cache, color: COLORS.cache }] : []),
  ];
  const allReclaimable = (selectedRunning ? disk.reclaimable : 0) + (podmanUp ? podmanDisk.reclaimable : 0);

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

      {active === "all" && (selectedRunning || podmanUp ? (
        <>
          <StorageDonut slices={allSlices} onOpen={setTab} />
          <div className="storage-foot">
            <span className="muted">
              Read by {selectedRunning ? <code>docker system df</code> : null}
              {selectedRunning && podmanUp ? " + " : null}
              {podmanUp ? <code>podman system df</code> : null}
              {selectedRunning && !podmanUp ? " — no Podman machine running" : null}
              {!selectedRunning && podmanUp ? <> {"— profile "}<code>{selected}</code>{" is stopped"}</> : null}
            </span>
            <span className="muted">{fmtSize(allReclaimable)} reclaimable</span>
          </div>
        </>
      ) : (
        <p className="muted storage-note">
          {profiles.length === 0 ? "No Colima profile yet." : <>Profile <code>{selected}</code> is stopped.</>} No Podman machine is running either, so there is nothing to read.{" "}
          <button className="inv-link" onClick={startSelectedOrCreate}>{profiles.length === 0 ? "New profile…" : "Start profile"}</button>
        </p>
      ))}

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
