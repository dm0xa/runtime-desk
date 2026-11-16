import { StripPanel } from "../StripPanel";
import type { DashboardCard } from "../context";

export default {
  label: "Infrastructure",
  description: "Lima workloads on this machine",
  span: 2,
  minSpan: 2,
  maxSpan: 4,
  order: 70,
  render: (c) => (
    <StripPanel
      title="Infrastructure"
      items={[
        { label: "Linux VMs", value: c.limaVms.length, sub: `${c.limaVms.filter((v) => v.status.toLowerCase() === "running").length} running`, state: c.limaVms.some((v) => v.status.toLowerCase() === "running") ? "ok" : undefined, onClick: () => c.setTab("runtimes"), title: "Open Machine" },
      ]}
    />
  ),
} satisfies DashboardCard;
