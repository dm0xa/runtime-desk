import type { SystemStatus } from "../../types";

/** The four the sidebar gates on. Before the probe answers, "Not found" would be a claim. */
const TOOLS: { key: keyof SystemStatus; label: string }[] = [
  { key: "colima", label: "Colima" },
  { key: "docker", label: "Docker" },
  { key: "podman", label: "Podman" },
  { key: "kubectl", label: "kubectl" },
];

export function SystemStatusWidget({ tools, onOpen }: { tools: SystemStatus | null; onOpen: () => void }) {
  return (
    <button
      type="button"
      className="card card-action system-status"
      onClick={onOpen}
      aria-label="Open Settings, General: tools on this machine"
      title="Open Settings · General — tools on this machine"
    >
      <div className="strip-title">System Status</div>
      <div className="check-grid">
        {TOOLS.map(({ key, label }) => {
          const installed = tools?.[key];
          return (
            <div className="check-row" key={key}>
              <span className="check-name">{label}</span>
              <span className={`check-state ${installed === undefined ? "pending" : installed ? "ok" : "missing"}`}>
                {installed === undefined ? "Checking…" : installed ? "Installed" : "Not found"}
              </span>
            </div>
          );
        })}
      </div>
    </button>
  );
}
