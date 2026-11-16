import { StorageWidget } from "../StorageWidget";
import type { DashboardCard } from "../context";

export default {
  label: "Storage usage",
  description: "Docker and Podman storage, each quoted from its own engine",
  span: 2,
  minSpan: 2,
  maxSpan: 4,
  order: 140,
  defaultVisible: false,
  render: (c) => <StorageWidget {...c} />,
} satisfies DashboardCard;
