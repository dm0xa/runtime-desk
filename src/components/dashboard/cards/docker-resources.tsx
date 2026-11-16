import { StripPanel } from "../StripPanel";
import type { DashboardCard } from "../context";

export default {
  label: "Docker Resources",
  description: "Container, image, volume, network and compose counts",
  span: 2,
  minSpan: 2,
  maxSpan: 4,
  order: 50,
  render: (c) => {
    // Three different truths, in order: nothing to point at yet, a closed daemon, a good read.
    // A number nobody read is never printed as zero.
    const unknown = !c.profilesRead;
    const stopped = !unknown && c.profiles.length > 0 && !c.profiles.some((p) => p.name === c.selected && p.status.toLowerCase() === "running");
    const noProfile = !unknown && c.profiles.length === 0;
    const unreadable = !unknown && !noProfile && !stopped && (!c.countsRead || c.listsFailed);
    const note = unknown ? (
      <span>Reading the profile and its lists…</span>
    ) : noProfile ? (
      <><span>No Colima profile yet — Docker data is not read.</span><button className="inv-link" onClick={c.startSelectedOrCreate}>New profile…</button></>
    ) : stopped ? (
      <><span>{c.selected} is stopped — Docker data is not read.</span><button className="inv-link" onClick={c.startSelectedOrCreate}>Start profile</button></>
    ) : unreadable ? (
      <><span>The lists did not answer — nothing was read.</span><button className="inv-link" onClick={() => c.setTab("containers")}>Open Containers</button></>
    ) : undefined;
    const dash = "—";
    return (
      <StripPanel
        title="Docker Resources"
        note={note}
        items={[
          { label: "Containers", value: note ? dash : c.counts.containers, sub: note ? undefined : `${c.counts.running} running`, state: !note && c.counts.running > 0 ? "ok" : undefined, onClick: () => c.openContainers("all"), title: "Open Containers" },
          { label: "Images", value: note ? dash : c.counts.images, onClick: () => c.setTab("images"), title: "Open Images" },
          { label: "Volumes", value: note ? dash : c.counts.volumes, onClick: () => c.setTab("volumes"), title: "Open Volumes" },
          { label: "Networks", value: note ? dash : c.networks.length, onClick: () => c.setTab("networks"), title: "Open Networks" },
          { label: "Compose", value: note ? dash : c.compose.length, onClick: () => c.openContainers("compose"), title: "Open Compose containers" },
        ]}
      />
    );
  },
} satisfies DashboardCard;
