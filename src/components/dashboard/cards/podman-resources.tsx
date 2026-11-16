import { StripPanel } from "../StripPanel";
import type { DashboardCard } from "../context";

export default {
  label: "Podman Resources",
  description: "Container, image, volume and network counts for the default Podman machine",
  span: 2,
  minSpan: 2,
  maxSpan: 4,
  order: 56,
  render: (c) => {
    const running = c.podmanMachines.some((m) => m.running);
    // Same rule as the Docker card: a number nobody read is not zero, and a probe that has
    // not answered yet is not evidence that Podman is missing.
    const unknown = c.tools === null;
    const note = unknown
      ? "Checking what is installed…"
      : !c.tools?.podman
        ? "Podman is not installed — nothing was read."
        : !running
          ? "No running Podman machine — nothing was read."
          : undefined;
    const dash = "—";
    return (
      <StripPanel
        title="Podman Resources"
        note={note}
        items={[
          { label: "Containers", value: note ? dash : c.podmanContainers.length, sub: note ? undefined : `${c.podmanContainers.filter((x) => x.state === "running").length} running`, state: !note && c.podmanContainers.some((x) => x.state === "running") ? "ok" : undefined, onClick: () => c.setTab("podman-containers"), title: "Open Podman Containers" },
          { label: "Images", value: note ? dash : c.podmanImages.length, onClick: () => c.setTab("podman-images"), title: "Open Podman Images" },
          { label: "Volumes", value: note ? dash : c.podmanVolumes.length, onClick: () => c.setTab("podman-volumes"), title: "Open Podman Volumes" },
          { label: "Networks", value: note ? dash : c.podmanNetworks.length, onClick: () => c.setTab("podman-networks"), title: "Open Podman Networks" },
        ]}
      />
    );
  },
} satisfies DashboardCard;
