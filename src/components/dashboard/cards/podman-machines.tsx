import { kpiCard } from "../kpi";

const ICON = <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 9h6v6H9z" /></svg>;

export default kpiCard({
  label: "Podman Machines",
  description: "Podman machines on this host, and how many are running",
  icon: ICON,
  value: (c) => c.podmanMachines.length,
  state: (c) => c.podmanMachines.some((m) => m.running) ? "ok" : undefined,
  tab: "podman-machines",
  tabLabel: "Podman Machines",
  order: 55,
});
