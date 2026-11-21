import { Fragment, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import "./App.css";
import type { AppRelease, CleanupReport, ComposeProject, Container, Counts, DiskUsage, Image, ImagePlatform, LimaVm, Network, NetworkMapEntry, PodmanContainer, PodmanDiskUsage, PodmanImage, PodmanMachine, PodmanNetwork, PodmanVolume, Profile, ProfileConfig, Status, SystemStatus, VersionInfo, VmDiagnostics, Volume, VolumeSize } from "./types";
import { fmtBytes, fmtDateTime, fmtSize, fmtUptime, parseHumanBytes } from "./lib/format";
import { OriginBadge, isKubernetesContainer, isKubernetesName, originOf } from "./lib/origin";
import { overlayOpen } from "./lib/modalFocus";
import { DASHBOARD_WIDGETS, DEFAULT_WIDGETS, LAYOUT_VERSION, WIDGET_KEYS, type ContainerScope, type DashboardContext, type SettingsSection, type WidgetKey, type WidgetVisibility } from "./components/dashboard";
import { LogsModal } from "./components/LogsModal";
import { InspectModal, type InspectTarget } from "./components/InspectModal";
import { Dialog } from "./components/Dialog";
import { ConfirmButton } from "./components/ConfirmButton";
import { Caret } from "./components/Caret";
import { Onboarding } from "./components/Onboarding";
import { ActivityPage } from "./components/ActivityPage";
import { CleanupPage } from "./components/CleanupPage";
import { PodmanPage } from "./components/PodmanPage";
import { KubernetesPage } from "./components/KubernetesPage";
import { ContainerDetail } from "./components/ContainerDetail";
import { PageHeader, type PageAction } from "./components/PageHeader";
import { buildGlobalIndex, type SearchAction } from "./lib/globalSearch";
import { PortChips } from "./components/PortChips";
import { ArrowUpRightIcon, BracesIcon, BroomIcon, CoffeeIcon, ContainerIcon, CopyIcon, FileCodeIcon, FingerprintIcon, GearIcon, InfoIcon, MapIcon, PanelLeftIcon, PencilIcon, PlayIcon, RestartIcon, SlidersIcon, StopIcon, TableIcon, TerminalIcon, TrashIcon, TriangleAlertIcon, UpgradeIcon, XIcon } from "./components/icons";
import { TagBadges } from "./components/TagBadges";
import { InvestigatorPage, type Subject } from "./components/InvestigatorPage";
import { Notices, type Notice } from "./components/Notices";
import { VolumeTreemap } from "./components/VolumeTreemap";
import { NetworkGraph } from "./components/NetworkGraph";
import { TOOLS, TOOL_GROUPS, featureGate, isSystemStatus, toolsFor, toolsInGroup, type FeatureId, type ToolKey } from "./dependencies";
import { CopyButton } from "./components/Facts";
import { setActivityActive, activitySnapshot, subscribeActivity } from "./lib/activity";
import { memoryPressure } from "./lib/memoryGuard";
import { MemoryLimitDialog } from "./components/MemoryLimitDialog";
import { subscribeTags } from "./lib/tags";
import { eventStreamActive, startEventStream, stopEventStream } from "./lib/stream";
import { humanizeDockerError } from "./lib/errors";
import { RowMenu } from "./components/RowMenu";
import { Select } from "./components/Select";

const LAYOUT_VERSION_KEY = "runtimeDesk.layoutVersion";
/** Project home; Settings › About links to it. */
const REPO_URL = "https://github.com/dm0xa/runtime-desk";
/** Optional tip jar, also in the README badge; Settings › About links to it. */
const SUPPORT_URL = "https://buymeacoffee.com/dm0xa";
/** How long a storage report is reused before the page re-reads it in the background. */
const CLEANUP_TTL = 60_000;
/** No daemon, or no answer yet: every storage widget renders the same empty state. */
const EMPTY_DISK: DiskUsage = { images: 0, containers: 0, volumes: 0, build_cache: 0, reclaimable: 0 };
const EMPTY_PODMAN_DISK: PodmanDiskUsage = { images: 0, containers: 0, volumes: 0, reclaimable: 0 };
/** Persisted dashboard layouts from before the current composition are discarded once. */
const LAYOUT_STALE = (() => {
  try { return Number(localStorage.getItem(LAYOUT_VERSION_KEY) ?? "0") < LAYOUT_VERSION; } catch { return true; }
})();


/** Auto layout: pack widgets into 4-column rows, shrinking to a hole when it is still
 *  usable, then redistribute leftover columns so every row is full. */
function computeWidgetSpans(keys: WidgetKey[], cols: number, overrides: Record<string, number> = {}): Partial<Record<WidgetKey, number>> {
  type Slot = { key: WidgetKey; span: number; max: number; fixed: boolean };
  const rows: Slot[][] = [];
  let row: Slot[] = [];
  let col = 0;
  for (const key of keys) {
    const w = DASHBOARD_WIDGETS.find((x) => x.key === key);
    if (!w) continue;
    if (col >= cols) { rows.push(row); row = []; col = 0; }
    const fixed = overrides[key];
    const min = fixed ? Math.min(fixed, cols) : Math.min(w.minSpan ?? 1, cols);
    const max = fixed ? Math.min(fixed, cols) : Math.min(w.maxSpan ?? cols, cols);
    const rem = cols - col;
    let span: number = fixed ? Math.min(fixed, cols) : Math.min(w.span, cols);
    if (span > rem) {
      // A user-fixed width never shrinks; it moves to the next row instead.
      if (!fixed && rem >= min) span = rem;
      else { rows.push(row); row = []; col = 0; }
    }
    row.push({ key, span, max, fixed: !!fixed });
    col += span;
    if (col >= cols) { rows.push(row); row = []; col = 0; }
  }
  if (row.length) rows.push(row);

  const grow = (r: Slot[]) => {
    let left = cols - r.reduce((n, s) => n + s.span, 0);
    let guard = 0;
    while (left > 0 && guard++ < 16) {
      let grew = false;
      for (let i = r.length - 1; i >= 0 && left > 0; i--) {
        if (!r[i].fixed && r[i].span < r[i].max) { r[i].span++; left--; grew = true; }
      }
      if (!grew) break;
    }
  };
  rows.forEach(grow);

  // A pinned width can leave a row short even after growing it: pull the next widget
  // that fits into the gap. The grid runs `dense` flow, so without this pass the hole
  // is backfilled by a later card and a ragged row appears somewhere further down.
  for (let i = 0; i < rows.length; i++) {
    let left = cols - rows[i].reduce((n, s) => n + s.span, 0);
    while (left > 0) {
      let found: Slot | null = null;
      for (let j = i + 1; j < rows.length && !found; j++) {
        const k = rows[j].findIndex((s) => s.span <= left);
        if (k < 0) continue;
        found = rows[j][k];
        rows[j].splice(k, 1);
        if (rows[j].length === 0) rows.splice(j, 1);
      }
      if (!found) break;
      rows[i].push(found);
      left -= found.span;
    }
  }
  rows.forEach(grow);

  const spans: Partial<Record<WidgetKey, number>> = {};
  for (const r of rows) for (const s of r) spans[s.key] = s.span;
  return spans;
}

const NARROW_GRID = "(max-width: 1000px)";

/** Grid width follows the CSS breakpoint so spans can be computed for 2 or 4 columns. */
function useGridColumns(): number {
  const [cols, setCols] = useState(() => (typeof window !== "undefined" && window.matchMedia(NARROW_GRID).matches ? 2 : 4));
  useEffect(() => {
    const mq = window.matchMedia(NARROW_GRID);
    const onChange = () => setCols(mq.matches ? 2 : 4);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, []);
  return cols;
}

function NavIcon({ id }: { id: string }) {
  const c = { width: 16, height: 16, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.8, strokeLinecap: "round" as const, strokeLinejoin: "round" as const };
  switch (id) {
    case "activity": return <svg {...c}><path d="M3 12h3.5l2.5-7 3.5 14 2.5-7H21" /></svg>;
    case "dashboard": return <svg {...c}><rect x="3" y="3" width="7" height="9" rx="1" /><rect x="14" y="3" width="7" height="5" rx="1" /><rect x="14" y="12" width="7" height="9" rx="1" /><rect x="3" y="16" width="7" height="5" rx="1" /></svg>;
    case "containers": return <svg {...c}><path d="M21 8l-9-5-9 5 9 5 9-5Z" /><path d="M3 8v8l9 5 9-5V8" /><path d="M12 13v8" /></svg>;
    case "images": return <svg {...c}><circle cx="12" cy="12" r="9" /><circle cx="12" cy="12" r="3" /><path d="M12 3v3M12 18v3M3 12h3M18 12h3" /></svg>;
    case "volumes": return <svg {...c}><ellipse cx="12" cy="6" rx="8" ry="3" /><path d="M4 6v12c0 1.7 3.6 3 8 3s8-1.3 8-3V6" /><path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></svg>;
    case "networks": return <svg {...c}><rect x="9" y="2.5" width="6" height="4" rx="1" /><rect x="2" y="17.5" width="6" height="4" rx="1" /><rect x="16" y="17.5" width="6" height="4" rx="1" /><path d="M12 6.5v4.5M5 17.5V13h14v4.5M12 11v2" /></svg>;
    case "ai": return <svg {...c}><path d="M12 3l1.8 4.6L18 9.5l-4.2 1.9L12 16l-1.8-4.6L6 9.5l4.2-1.9L12 3Z" /><path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9L19 15Z" /></svg>;
    case "runtimes": return <svg {...c}><rect x="6" y="6" width="12" height="12" rx="2" /><path d="M9 2v3M15 2v3M9 19v3M15 19v3M2 9h3M2 15h3M19 9h3M19 15h3" /></svg>;
    case "sherlock": return <FingerprintIcon size={16} />;
    case "kubernetes": return <svg {...c}><path d="M12 2.6l8.1 4.7v9.4L12 21.4 3.9 16.7V7.3L12 2.6Z" /><circle cx="12" cy="12" r="2.6" /><path d="M12 9.4V5.6M9.8 13.3l-3.3 1.9M14.2 13.3l3.3 1.9" /></svg>;
    case "cleanup": return <BroomIcon size={16} />;
    case "settings": return <svg {...c}><circle cx="12" cy="12" r="3" /><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-2.9 1.2 2 2 0 1 1-4 0 1.7 1.7 0 0 0-2.9-1.2l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1A1.7 1.7 0 0 0 3 15a2 2 0 1 1 0-4 1.7 1.7 0 0 0 1.2-2.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1A1.7 1.7 0 0 0 10 4.1a2 2 0 1 1 4 0 1.7 1.7 0 0 0 2.9 1.2l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1A1.7 1.7 0 0 0 21 11a2 2 0 1 1 0 4Z" /></svg>;
    case "podman-machines": case "podman-containers": case "podman-images": case "podman-volumes": case "podman-networks": return <svg {...c}><rect x="4" y="4" width="16" height="16" rx="3" /><path d="M9 9h6v6H9z" /></svg>;
    default: return null;
  }
}

type NavItem = { id: string; label: string; group: string; feature: FeatureId };

/** Where a group's data comes from. Docker and Podman answer from different virtual
 *  machines, so their headers name the source instead of implying one local engine. */
type NavHint = "profile" | "podman";

const NAV_GROUPS: { title: string; hint?: NavHint; items: NavItem[] }[] = [
  { title: "Overview", items: [
    { id: "dashboard", label: "Dashboard", group: "Overview", feature: "dashboard" },
    { id: "activity", label: "Activity", group: "Overview", feature: "activity" },
    { id: "sherlock", label: "Sherlock", group: "Overview", feature: "investigator" },
  ] },
  { title: "Docker", hint: "profile", items: [
    { id: "containers", label: "Containers", group: "Docker", feature: "containers" },
    { id: "images", label: "Images", group: "Docker", feature: "images" },
    { id: "volumes", label: "Volumes", group: "Docker", feature: "volumes" },
    { id: "networks", label: "Networks", group: "Docker", feature: "networks" },
  ] },
  // Kubernetes is not a peer of the engines: Colima installs k3s *inside* this VM and k3s
  // runs its pods on the profile's own runtime. One group says so.
  { title: "Colima", items: [
    { id: "runtimes", label: "Machine", group: "Colima", feature: "machine" },
    { id: "kubernetes", label: "Kubernetes", group: "Colima", feature: "kubernetes" },
  ] },
  { title: "Podman", hint: "podman", items: [
    { id: "podman-machines", label: "Machines", group: "Podman", feature: "podman" },
    { id: "podman-containers", label: "Containers", group: "Podman", feature: "podman" },
    { id: "podman-images", label: "Images", group: "Podman", feature: "podman" },
    { id: "podman-volumes", label: "Volumes", group: "Podman", feature: "podman" },
    { id: "podman-networks", label: "Networks", group: "Podman", feature: "podman" },
  ] },
  { title: "Tools", items: [
    { id: "cleanup", label: "Cleanup", group: "Tools", feature: "cleanup" },
    { id: "ai", label: "AI Models", group: "Tools", feature: "ai" },
  ] },
  { title: "System", items: [{ id: "settings", label: "Settings", group: "System", feature: "settings" }] },
];

/** Groups that can be hidden; Overview holds the pinned Dashboard, System holds Settings. */
const HIDEABLE_GROUPS = NAV_GROUPS.filter((g) => g.title !== "Overview" && g.title !== "System");

/** Retired group names, mapped to the group that absorbed them. Kubernetes used to sit in
 *  its own section; it is now an item of Colima, because k3s runs inside that VM. */
const RETIRED_SECTIONS: Record<string, string> = { Linux: "Colima", Kubernetes: "Colima" };

const NAV: NavItem[] = NAV_GROUPS.flatMap((g) => g.items);

/** Lists that filter by a query; every other page's header search starts in Global. */
const PAGE_SEARCH: Partial<Record<string, { placeholder: string; label: string }>> = {
  containers: { placeholder: "Search containers...", label: "containers" },
  images: { placeholder: "Search images...", label: "images" },
  volumes: { placeholder: "Search volumes...", label: "volumes" },
  networks: { placeholder: "Search networks...", label: "networks" },
  "podman-machines": { placeholder: "Search machines...", label: "machines" },
  "podman-containers": { placeholder: "Search containers...", label: "containers" },
  "podman-images": { placeholder: "Search images...", label: "images" },
  "podman-volumes": { placeholder: "Search volumes...", label: "volumes" },
  "podman-networks": { placeholder: "Search networks...", label: "networks" },
};

type SettingsTab = "general" | "sidebar" | "configuration" | "about";
type NetworkScope = { network: string; names: string[] };
/** One restorable point on the back stack: the tab plus what that tab was showing. */
type Screen = { tab: string; trail: Subject[]; settingsTab: SettingsTab; search: string; networkScope: NetworkScope | null };

/** Settings sub-sections, a segmented bar at the top of the page. A second sidebar
 *  column next to the navigation made two competing lists; tabs name the section
 *  in the content, the way a Mac settings window names it in its toolbar. */
const SETTINGS_TABS = [
  { id: "general", label: "General", Icon: SlidersIcon },
  { id: "sidebar", label: "Sidebar", Icon: PanelLeftIcon },
  { id: "configuration", label: "Configuration", Icon: FileCodeIcon },
  { id: "about", label: "About", Icon: InfoIcon },
] as const;

/** Install guidance shown when a required CLI is missing. */

function PruneSection({ title, desc, checked, onToggle, count, empty, danger, children }: {
  title: string; desc: string; checked: boolean; onToggle: (v: boolean) => void; count: number; empty?: string; danger?: boolean; children: ReactNode;
}) {
  return (
    <div className={`prune-section ${danger ? "danger" : ""} ${checked ? "on" : ""}`}>
      <label className="prune-row">
        <input type="checkbox" checked={checked} onChange={(e) => onToggle(e.target.checked)} />
        <span className="prune-text"><strong>{title}</strong><em>{desc}</em></span>
        <span className="count">{count}</span>
      </label>
      <div className="prune-items">{empty ? <span className="muted">{empty}</span> : children}</div>
    </div>
  );
}

/** Clipboard API first; the execCommand path keeps the webview working when the API is denied. */
async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch { /* fall through */ }
  const area = document.createElement("textarea");
  area.value = text;
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const ok = document.execCommand("copy");
  area.remove();
  return ok;
}

const blankForm = {
  profile: "", cpus: 2, memory: 2, disk: 100, runtime: "docker", arch: "aarch64",
  vm_type: "vz", rosetta: false, hostname: "", kubernetes: false, k3s_arg: "",
  network_mode: "shared", network_interface: "en0", network_address: false,
  network_preferred_route: false, network_host_addresses: false,
  gateway_address: "192.168.5.2", dns: "", dns_hosts: "",
  port_forwarder: "ssh", ssh_agent: false, mount_type: "virtiofs",
  mount_inotify: false, mounts: [{ location: "~", writable: true }] as { location: string; writable: boolean }[],
};

/** One `--mount` value: `path[:mountpoint][:w]`. No suffix at all means read-only. */
function mountArg(m: { location: string; mount_point?: string; writable: boolean }) {
  const path = m.location.trim();
  const point = m.mount_point?.trim();
  const suffix = point ? `:${point}` : "";
  return m.writable ? `${path}${suffix}:w` : `${path}${suffix}`;
}

/** An empty list must become `none`: no `--mount` flag makes Colima add the home directory. */
function mountArgs(mounts: { location: string; mount_point?: string; writable: boolean }[]) {
  const args = mounts.filter((m) => m.location.trim()).map(mountArg);
  return args.length ? args : ["none"];
}

/** Repeated `--dns` values; the form holds them as one comma/space-separated line. */
function dnsArgs(text: string) {
  return text.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

/** Repeated `--dns-host` values. `name = target` is normalised, since Colima does not trim. */
function dnsHostArgs(text: string) {
  return text.split(/[\n,]+/).map((s) => s.trim()).filter(Boolean)
    .map((entry) => {
      const [name, ...target] = entry.split("=");
      return `${name.trim()}=${target.join("=").trim()}`;
    });
}

/** The create form keeps text where Colima takes repeated flags; this is the one conversion. */
function startPayload(f: typeof blankForm) {
  return {
    profile: f.profile, cpus: f.cpus, memory: f.memory, disk: f.disk, runtime: f.runtime,
    arch: f.arch, vm_type: f.vm_type, rosetta: f.rosetta, hostname: f.hostname,
    kubernetes: f.kubernetes, k3s_arg: f.k3s_arg,
    network_mode: f.network_mode,
    // Bridged is the only mode that reads the interface; sending en0 in shared mode is noise.
    network_interface: f.network_mode === "bridged" ? f.network_interface : undefined,
    network_address: f.network_address, network_preferred_route: f.network_preferred_route,
    network_host_addresses: f.network_host_addresses,
    gateway_address: f.gateway_address.trim() || undefined,
    dns: dnsArgs(f.dns),
    dns_hosts: dnsHostArgs(f.dns_hosts),
    port_forwarder: f.port_forwarder, ssh_agent: f.ssh_agent,
    mount_type: f.mount_type, mount_inotify: f.mount_inotify,
    mounts: mountArgs(f.mounts),
  };
}

/** Colima spells architectures `aarch64`/`x86_64`; image and host metadata says `arm64`/`amd64`.
 *  One normaliser so an amd64 image on an aarch64 VM is not read as a difference of spelling. */
function normalizeArch(value?: string | null): "arm64" | "amd64" | "" {
  switch (value) {
    case "arm64": case "aarch64": return "arm64";
    case "amd64": case "x86_64": return "amd64";
    default: return "";
  }
}

function App() {
  // The window reopens on the screen you left, like every Mac app that remembers its
  // state; a screen whose CLI disappeared now lands on its own "not installed" panel.
  const [tab, setTab] = useState(() => {
    try {
      const saved = localStorage.getItem("runtimeDesk.tab");
      if (saved && NAV.some((n) => n.id === saved)) return saved;
    } catch { /* private mode */ }
    return "dashboard";
  });
  const [sidebarHidden, setSidebarHidden] = useState(() => {
    try { return localStorage.getItem("runtimeDesk.sidebarHidden") === "1"; } catch { return false; }
  });
  const [profiles, setProfiles] = useState<Profile[]>([]);
  const [selected, setSelected] = useState("default");
  /** The tray listener is registered once; it must read the current selection at click time. */
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  /** `act` closes over `selected` and the current refresh; the listener holds the latest one. */
  const trayActionRef = useRef<(action: string) => void>(() => {});
  const [status, setStatus] = useState<Status | null>(null);
  const [version, setVersion] = useState("");
  const [containers, setContainers] = useState<Container[]>([]);
  const [images, setImages] = useState<Image[]>([]);
  /** Image id (short or full digest) → architecture, from one batched `image inspect`. */
  const [imageArch, setImageArch] = useState<Record<string, string>>({});
  /** Same batched `image inspect`, kept apart: the digest names the bits, the arch names the CPU. */
  const [imageDigest, setImageDigest] = useState<Record<string, string>>({});
  /** The id set the last inspect answered for; a refresh with the same images does not re-run it. */
  const imageIdsRef = useRef("");
  const [volumes, setVolumes] = useState<Volume[]>([]);
  const [volSizes, setVolSizes] = useState<VolumeSize[]>([]);
  const [volSizesLoading, setVolSizesLoading] = useState(false);
  const [hoverVolume, setHoverVolume] = useState<string | null>(null);
  const [networks, setNetworks] = useState<Network[]>([]);
  const [netView, setNetView] = useState<"table" | "map">("table");
  const [netMap, setNetMap] = useState<NetworkMapEntry[]>([]);
  const [compose, setCompose] = useState<ComposeProject[]>([]);
  const [limaVms, setLimaVms] = useState<LimaVm[]>([]);
  const [podmanMachines, setPodmanMachines] = useState<PodmanMachine[]>([]);
  /** Which machine the Podman lists are scoped to; podman itself defaults to its own connection. */
  const [podmanMachine, setPodmanMachine] = useState("");
  const [podmanContainers, setPodmanContainers] = useState<PodmanContainer[]>([]);
  const [podmanImages, setPodmanImages] = useState<PodmanImage[]>([]);
  const [podmanVolumes, setPodmanVolumes] = useState<PodmanVolume[]>([]);
  const [podmanNetworks, setPodmanNetworks] = useState<PodmanNetwork[]>([]);
  const [podmanDisk, setPodmanDisk] = useState<PodmanDiskUsage>(EMPTY_PODMAN_DISK);
  const [tools, setTools] = useState<SystemStatus | null>(() => {
    // Render the last known probe result immediately, then refresh in the background.
    try {
      const raw = localStorage.getItem("runtimeDesk.tools");
      if (!raw) return null;
      const parsed: unknown = JSON.parse(raw);
      return isSystemStatus(parsed) ? parsed : null;
    } catch { return null; }
  });
  const [counts, setCounts] = useState<Counts>({ containers: 0, running: 0, images: 0, volumes: 0 });
  /** Which profile the counts above describe. Switching profiles must not lend the previous
   *  VM's numbers to the next one — the delete dialog is where that matters. */
  const [countsProfile, setCountsProfile] = useState("");
  /** The profile list has answered at least once, so "no profile" is a fact and not a
   *  launch-time default. */
  const [profilesRead, setProfilesRead] = useState(false);
  // One scan answers for every visitor of the Cleanup page, so it outlives the tab.
  const [cleanupCache, setCleanupCache] = useState<{ profile: string; at: number; report: CleanupReport } | null>(null);
  const [cleanupLoading, setCleanupLoading] = useState(false);
  const [cleanupNonce, setCleanupNonce] = useState(0);
  /** Header Refresh re-samples Sherlock's detail and live stats. */
  const [subjectNonce, setSubjectNonce] = useState(0);
  /** Tags feed the global search index; a tag edit must rebuild it. */
  const [tagTick, setTagTick] = useState(0);
  const [pageRefreshing, setPageRefreshing] = useState(false);
  const [podmanNonce, setPodmanNonce] = useState(0);
  /** Header Refresh re-reads the cluster and its resource table. */
  const [kubeNonce, setKubeNonce] = useState(0);
  const [disk, setDisk] = useState<DiskUsage>({ images: 0, containers: 0, volumes: 0, build_cache: 0, reclaimable: 0 });
  const [notices, setNotices] = useState<Notice[]>([]);
  const noticeSeq = useRef(0);
  const imagesRef = useRef<Image[]>([]);
  const containersRef = useRef<Container[]>([]);
  const [busy, setBusy] = useState(false);
  /** The tray can fire while a window action is mid-flight; `busy` is state, so mirror it. */
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const [refreshing, setRefreshing] = useState(false);
  /** Bumped per refresh; a late answer from an older one is dropped. */
  const refreshGen = useRef(0);
  /** The wave currently reading a profile, so a second caller joins it instead of spawning one. */
  const refreshJob = useRef<{ profile: string; gen: number; p: Promise<void> } | null>(null);
  const [lastUpdated, setLastUpdated] = useState(0);
  /** True only after a read that the daemon answered. Counts are a claim, so every surface
   *  that prints them asks this instead of the current tab's gate. */
  const [countsRead, setCountsRead] = useState(false);
  /** A list call that failed. "No containers" is a statement about the engine, never about
   *  a request that errored. */
  const [listsFailed, setListsFailed] = useState(false);
  const [search, setSearch] = useState("");
  const [containerFilter, setContainerFilter] = useState<ContainerScope>("all");
  /** Images and volumes carry the same "only the ones I could delete" filter their sibling lists
   *  have as origin chips, in the toolbar row that makes the tables start on one line. */
  const [imageFilter, setImageFilter] = useState<"all" | "unused">("all");
  const [volumeFilter, setVolumeFilter] = useState<"all" | "unused">("all");
  const [networkFilter, setNetworkFilter] = useState<"all" | "user">("all");
  /** Pull is the only way an image arrives, so the Images page offers it. */
  const [pullRef, setPullRef] = useState<string | null>(null);
  /** Colima resizes a VM through `start`; this dialog exists only while the profile is stopped. */
  const [resize, setResize] = useState<{ cpus: string; memory: string; disk: string } | null>(null);
  /** DNS, forwarder and gateway are applied by starting a stopped VM; no recreate needed. */
  const [netEdit, setNetEdit] = useState<{ dns: string; dns_hosts: string; port_forwarder: string; gateway_address: string } | null>(null);
  /** Creation-only fields need destroy + start; `keep_data` decides whether the disk survives. */
  const [recreate, setRecreate] = useState<{
    arch: string; vm_type: string; runtime: string; mount_type: string;
    network_mode: string; network_interface: string; network_address: boolean;
    rosetta: boolean; kubernetes: boolean; keep_data: boolean; confirm: string;
    dns: string; dns_hosts: string;
  } | null>(null);
  const [networkScope, setNetworkScope] = useState<NetworkScope | null>(null);
  const [showCreate, setShowCreate] = useState(false);
  const [showPrune, setShowPrune] = useState(false);
  const [showDelete, setShowDelete] = useState(false);
  const [showColimaPrune, setShowColimaPrune] = useState(false);
  const [deleteConfirm, setDeleteConfirm] = useState("");
  const [showHelp, setShowHelp] = useState(false);
  /** Container whose memory limit the dialog is about to change. */
  const [limitTarget, setLimitTarget] = useState<{ id: string; name: string; used: number; current: number } | null>(null);
  /** Notice id per pressured container: one alert while it stays over the threshold. */
  const pressuredRef = useRef(new Map<string, number>());
  const [trail, setTrail] = useState<Subject[]>([]);
  const subject = trail.length > 0 ? trail[trail.length - 1] : null;
  const [showOnboarding, setShowOnboarding] = useState(() => {
    try { return localStorage.getItem("runtimeDesk.onboarded") !== "1"; } catch { return true; }
  });
  const [settingsTab, setSettingsTab] = useState<SettingsTab>(() => {
    try {
      const saved = localStorage.getItem("runtimeDesk.settingsTab");
      if (saved && SETTINGS_TABS.some((t) => t.id === saved)) {
        return saved as SettingsTab;
      }
    } catch { /* private mode */ }
    return "general";
  });
  // One back stack for the whole app: a screen is the tab plus what that tab was showing.
  // Sherlock pushes an entry per subject hop, so back retraces image -> volume -> Volumes.
  const [back, setBack] = useState<Screen[]>([]);
  const backRef = useRef<Screen[]>([]);
  const here = useRef<Screen>({ tab, trail, settingsTab, search, networkScope });
  here.current = { tab, trail, settingsTab, search, networkScope };
  const trailKey = (t: Subject[]) => t.map((s) => `${s.kind}:${s.id}`).join("|");
  const apply = (to: Screen) => {
    setTab(to.tab);
    setTrail(to.trail);
    setSettingsTab(to.settingsTab);
    setSearch(to.search);
    setNetworkScope(to.networkScope);
  };
  // Drill-down: leaving a screen for a related, filtered or nested view (a row's
  // Investigator, Activity's "Open Containers", a network's members, a notice's
  // "Open Containers"). Stacked, so Back retraces the depth.
  const go = (next: Partial<Screen>) => {
    const from = here.current;
    const to = { ...from, ...next };
    if (to.tab !== from.tab || trailKey(to.trail) !== trailKey(from.trail)) {
      backRef.current = [...backRef.current.slice(-31), from];
      setBack(backRef.current);
    }
    apply(to);
  };
  // Lateral: a peer screen picked from the sidebar, ⌘digit, global search or the status
  // bar. Every peer is one click away, so it never stacks, and leaving a drill-down by
  // the sidebar forgets that drill-down rather than leaving a stray Back behind.
  const navTo = (next: Partial<Screen>) => {
    if (backRef.current.length > 0) {
      backRef.current = [];
      setBack(backRef.current);
    }
    // A peer screen opens at its root: no subject trail, no leftover network filter.
    apply({ ...here.current, trail: [], networkScope: null, ...next });
  };
  const navToRef = useRef(navTo);
  navToRef.current = navTo;
  /** A dashboard metric opens its list at its root, so the tile's number matches the rows. */
  const openContainers = (scope: ContainerScope) => {
    setContainerFilter(scope);
    go({ tab: "containers", trail: [], search: "", networkScope: null });
  };
  /** Settings is a peer screen with sections; a card link names the section it means. */
  const openSettings = (section: SettingsSection) => {
    go({ tab: "settings", settingsTab: section, trail: [], search: "", networkScope: null });
  };
  const goBack = () => {
    const prev = backRef.current[backRef.current.length - 1];
    if (!prev) return;
    backRef.current = backRef.current.slice(0, -1);
    setBack(backRef.current);
    setTab(prev.tab);
    setTrail(prev.trail);
    setSettingsTab(prev.settingsTab);
    setSearch(prev.search);
    setNetworkScope(prev.networkScope);
  };
  const backFn = useRef(goBack);
  backFn.current = goBack;
  // Every "Investigate" entry point lands on the Sherlock page, not a passing overlay.
  const openSubject = (next: Subject) => go({ trail: [next], tab: "sherlock" });
  const navigateSubject = (next: Subject) => go({ trail: [...trail, next] });
  const backTarget = back.length > 0 ? back[back.length - 1] : null;
  const subjectName = (s: Subject) => {
    if (s.kind === "container") return containers.find((c) => c.id === s.id)?.name ?? s.id;
    if (s.kind === "image") {
      const i = images.find((x) => x.id === s.id);
      return i ? `${i.repository}:${i.tag}` : s.id;
    }
    if (s.kind === "volume") return volumes.find((v) => v.name === s.id)?.name ?? s.id;
    if (s.kind === "group") return s.id;
    return netMap.find((n) => n.name === s.id)?.name ?? s.id;
  };
  const backLabel = backTarget
    ? backTarget.tab === "sherlock"
      ? backTarget.trail.length ? subjectName(backTarget.trail[backTarget.trail.length - 1]) : "All assets"
      : NAV.find((n) => n.id === backTarget.tab)?.label ?? "Back"
    : "";
  const [versionInfo, setVersionInfo] = useState<VersionInfo | null>(null);
  const [checkingVersion, setCheckingVersion] = useState(false);
  const [appRelease, setAppRelease] = useState<AppRelease | null>(null);
  /** One GitHub lookup per launch; a failed one clears both so Settings can retry. */
  const appReleaseChecked = useRef(false);
  const appReleaseAnnounced = useRef(false);
  const [diag, setDiag] = useState<VmDiagnostics | null>(null);
  const [diagLoading, setDiagLoading] = useState(false);
  const [editing, setEditing] = useState(false);
  const [spanOverrides, setSpanOverrides] = useState<Record<string, number>>(() => {
    try { return JSON.parse(localStorage.getItem("runtimeDesk.spans") ?? "{}") as Record<string, number>; } catch { return {}; }
  });
  useEffect(() => { localStorage.setItem("runtimeDesk.spans", JSON.stringify(spanOverrides)); }, [spanOverrides]);
  const [hiddenSections, setHiddenSections] = useState<Record<string, boolean>>(() => {
    try {
      const stored = JSON.parse(localStorage.getItem("runtimeDesk.hidden") ?? "{}") as Record<string, boolean>;
      // Only whole sections are hideable; older per-item keys are dropped.
      const allowed = new Set(HIDEABLE_GROUPS.map((g) => g.title));
      const out: Record<string, boolean> = {};
      for (const key of Object.keys(stored)) if (allowed.has(key) && stored[key]) out[key] = true;
      // A merged section stays hidden only when every section that fed it was hidden;
      // otherwise hidden tooling would silently reappear as visible again. A live key
      // (written after the rename) always wins over the retired ones.
      const merged = new Map<string, boolean[]>();
      for (const [retired, current] of Object.entries(RETIRED_SECTIONS)) {
        if (current in stored) continue;
        const flags = merged.get(current) ?? [];
        flags.push(!!stored[retired]);
        merged.set(current, flags);
      }
      for (const [current, flags] of merged) if (flags.every(Boolean)) out[current] = true;
      return out;
    } catch { return {}; }
  });
  useEffect(() => { localStorage.setItem("runtimeDesk.hidden", JSON.stringify(hiddenSections)); }, [hiddenSections]);
  const [widgets, setWidgets] = useState<WidgetVisibility>(() => {
    const base: WidgetVisibility = { ...DEFAULT_WIDGETS };
    if (LAYOUT_STALE) {
      try { localStorage.setItem(LAYOUT_VERSION_KEY, String(LAYOUT_VERSION)); } catch { /* ignore */ }
      return base;
    }
    try {
      const raw = localStorage.getItem("runtimeDesk.widgets");
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (parsed && typeof parsed === "object") {
          const o = parsed as Record<string, unknown>;
          for (const k of WIDGET_KEYS) {
            const v = o[k];
            if (typeof v === "boolean") base[k] = v;
          }
        }
      }
    } catch { /* ignore corrupt prefs */ }
    return base;
  });
  const [order, setOrder] = useState<WidgetKey[]>(() => {
    if (LAYOUT_STALE) return [...WIDGET_KEYS];
    try {
      const raw = localStorage.getItem("runtimeDesk.order");
      if (raw) {
        const parsed: unknown = JSON.parse(raw);
        if (Array.isArray(parsed)) {
          const valid = parsed.filter((k): k is WidgetKey => typeof k === "string" && (WIDGET_KEYS as readonly string[]).includes(k));
          const uniq = Array.from(new Set(valid));
          for (const k of WIDGET_KEYS) if (!uniq.includes(k)) uniq.push(k);
          return uniq;
        }
      }
    } catch { /* ignore corrupt prefs */ }
    return [...WIDGET_KEYS];
  });
  useEffect(() => { localStorage.setItem("runtimeDesk.order", JSON.stringify(order)); }, [order]);
  useEffect(() => {
    // A filter whose tool disappeared would leave an empty, unexplained list. The Kubernetes
    // chip is only drawn while the cluster reports pods, so a stopped or deleted cluster has
    // to fall back to All rather than keep filtering to nothing.
    if (!tools) return;
    if (containerFilter === "compose" && !tools.compose) setContainerFilter("all");
    if (containerFilter === "k8s" && !containers.some(isKubernetesContainer)) setContainerFilter("all");
  }, [tools, containerFilter, containers]);
  useEffect(() => {
    if (!notices.some((n) => n.kind === "success")) return;
    const t = setTimeout(() => setNotices((list) => list.filter((n) => n.kind !== "success")), 5000);
    return () => clearTimeout(t);
  }, [notices]);
  const [dragKey, setDragKey] = useState<WidgetKey | null>(null);
  /** Where the dragging card came from and which surface it currently hovers. */
  const [dropZone, setDropZone] = useState<"grid" | "tray" | null>(null);
  /** Slot a parked card would land in, so the grid can show the gap while dragging. */
  const [dropIndex, setDropIndex] = useState<number | null>(null);
  const dropIndexRef = useRef<number | null>(null);
  dropIndexRef.current = dropIndex;
  const dragRef = useRef<{ key: WidgetKey; from: "grid" | "tray"; startX: number; startY: number; offsetX: number; offsetY: number; active: boolean; ghost?: HTMLElement } | null>(null);
  const suppressClick = useRef(false);
  const flipRects = useRef<Map<string, DOMRect> | null>(null);
  const dragSlots = useRef<{ key: WidgetKey; top: number; bottom: number; cx: number }[] | null>(null);
  const lastReorder = useRef<{ x: number; y: number } | null>(null);
  const orderRef = useRef(order);
  orderRef.current = order;

  /** Snapshot card positions so hide, restore and reorder can animate from them. */
  function captureLayout() {
    const rects = new Map<string, DOMRect>();
    document.querySelectorAll<HTMLElement>(".dash-grid [data-widget-key]").forEach((el) => {
      const key = el.dataset.widgetKey;
      if (key) rects.set(key, el.getBoundingClientRect());
    });
    // Parked tiles are entry points: a restored card grows out of its mini-card.
    document.querySelectorAll<HTMLElement>(".tray-card[data-tray-key]").forEach((el) => {
      const key = el.dataset.trayKey;
      if (key) rects.set(`tray:${key}`, el.getBoundingClientRect());
    });
    flipRects.current = rects;
  }

  // FLIP: after a reorder or a visibility change, glide cards from their old slot.
  useEffect(() => {
    const prev = flipRects.current;
    flipRects.current = null;
    if (!prev) return;
    const grid = document.querySelector(".dash-grid");
    if (!grid) return;
    grid.querySelectorAll<HTMLElement>("[data-widget-key]").forEach((el) => {
      if (el.classList.contains("dragging")) return;
      const key = el.dataset.widgetKey;
      if (!key) return;
      // Drop any animation still running from a previous move, or the new one
      // starts from a stale offset and the card visibly jumps.
      el.getAnimations().forEach((a) => a.cancel());
      const after = el.getBoundingClientRect();
      const before = prev.get(key);
      if (!before) {
        // Newly restored: grow out of the parked mini-card it was clicked or dropped from.
        const parked = prev.get(`tray:${key}`);
        if (!parked) return;
        const dx = parked.left - after.left;
        const dy = parked.top - after.top;
        const sx = parked.width / after.width;
        const sy = parked.height / after.height;
        el.animate(
          [
            { transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`, opacity: 0.6, borderRadius: "10px" },
            { transform: "translate(0, 0) scale(1, 1)", opacity: 1, borderRadius: "12px" },
          ],
          { duration: 240, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
        );
        return;
      }
      const dx = before.left - after.left;
      const dy = before.top - after.top;
      const sx = before.width / after.width;
      const sy = before.height / after.height;
      const resized = Math.abs(sx - 1) > 0.005 || Math.abs(sy - 1) > 0.005;
      if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && !resized) return;
      el.animate(
        [{
          transform: resized
            ? `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`
            : `translate(${dx}px, ${dy}px)`,
          transformOrigin: "top left",
        }, { transform: "translate(0, 0) scale(1, 1)", transformOrigin: "top left" }],
        { duration: 180, easing: "cubic-bezier(0.2, 0.8, 0.2, 1)" },
      );
    });
  }, [order, widgets, dropIndex]);

  /** Slots captured before any reorder: geometry read during FLIP would be mid-animation
   *  and make the drop index flip back and forth (the "blinking" drag). */
  function snapshotSlots(moving: WidgetKey) {
    const grid = document.querySelector(".dash-grid");
    if (!grid) return;
    const slots: { key: WidgetKey; top: number; bottom: number; cx: number }[] = [];
    for (const key of orderRef.current) {
      if (key === moving) continue;
      const el = grid.querySelector<HTMLElement>(`[data-widget-key="${key}"]`);
      if (!el) continue;
      const r = el.getBoundingClientRect();
      slots.push({ key, top: r.top, bottom: r.bottom, cx: r.left + r.width / 2 });
    }
    dragSlots.current = slots;
  }

  /** Drop target for a drag: grid cards hide anywhere above the grid, parked cards
   *  return anywhere inside it. */
  function dropTargetAt(x: number, y: number, from: "grid" | "tray"): "grid" | "tray" | null {
    const inside = (sel: string) => {
      const el = document.querySelector<HTMLElement>(sel);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      return x >= r.left && x <= r.right && y >= r.top && y <= r.bottom;
    };
    if (from === "tray") return inside(".dash-grid") ? "grid" : null;
    if (inside(".dash-tray")) return "tray";
    const dash = document.querySelector<HTMLElement>(".dashboard")?.getBoundingClientRect();
    const grid = document.querySelector<HTMLElement>(".dash-grid")?.getBoundingClientRect();
    // The tray is a thin strip when every card is active, so the whole band above
    // the grid counts as "hide".
    if (dash && grid && y >= dash.top && y < grid.top && x >= dash.left && x <= dash.right) return "tray";
    return null;
  }

  function dropIndexAt(x: number, y: number): number {
    const slots = dragSlots.current;
    if (!slots) return 0;
    for (let i = 0; i < slots.length; i++) {
      if (y < slots[i].top || (y <= slots[i].bottom && x < slots[i].cx)) return i;
    }
    return slots.length;
  }

  function moveToIndex(targetIndex: number, capture = true): boolean {
    const from = dragRef.current?.key;
    if (!from) return false;
    const current = orderRef.current;
    const a = current.indexOf(from);
    if (a < 0) return false;
    const next = [...current];
    next.splice(a, 1);
    next.splice(Math.max(0, Math.min(targetIndex, next.length)), 0, from);
    if (next.every((k, i) => k === current[i])) return false;
    if (capture) captureLayout();
    setOrder(next);
    return true;
  }

  useEffect(() => {
    if (!editing) return;
    function onMove(e: MouseEvent) {
      const st = dragRef.current;
      if (!st) return;
      if (!st.active) {
        if (Math.hypot(e.clientX - st.startX, e.clientY - st.startY) < 4) return;
        st.active = true;
        setDragKey(st.key);
        setDragSpans(widgetSpansRef.current);
        snapshotSlots(st.key);
        lastReorder.current = { x: e.clientX, y: e.clientY };
        document.documentElement.classList.add("widget-drag");
        window.getSelection()?.removeAllRanges();
        const card = document.querySelector<HTMLElement>(st.from === "grid" ? `[data-widget-key="${st.key}"]` : `.tray-card[data-tray-key="${st.key}"]`);
        if (card) {
          const r = card.getBoundingClientRect();
          const ghost = card.cloneNode(true) as HTMLElement;
          ghost.classList.remove("editing", "dragging");
          ghost.classList.add("drag-ghost");
          ghost.removeAttribute("data-widget-key");
          ghost.removeAttribute("data-tray-key");
          ghost.querySelector(".eye-btn")?.remove();
          const body = ghost.querySelector<HTMLElement>(".widget-body");
          if (body) body.style.opacity = "1";
          ghost.style.width = `${r.width}px`;
          ghost.style.height = `${r.height}px`;
          ghost.style.transform = `translate3d(${r.left}px, ${r.top}px, 0)`;
          document.body.appendChild(ghost);
          st.ghost = ghost;
        }
      }
      const ghost = st.ghost;
      if (ghost) {
        const card = document.querySelector<HTMLElement>(st.from === "grid" ? `[data-widget-key="${st.key}"]` : `.tray-card[data-tray-key="${st.key}"]`);
        if (card) {
          const r = card.getBoundingClientRect();
          const w = parseFloat(ghost.style.width);
          const h = parseFloat(ghost.style.height);
          if (Math.abs(w - r.width) > 0.5) ghost.style.width = `${r.width}px`;
          if (Math.abs(h - r.height) > 0.5) ghost.style.height = `${r.height}px`;
        }
        ghost.style.transform = `translate3d(${e.clientX - st.offsetX}px, ${e.clientY - st.offsetY}px, 0) scale(1.02) rotate(0.6deg)`;
      }
      const target = dropTargetAt(e.clientX, e.clientY, st.from);
      setDropZone(target);
      if (st.from === "tray") {
        // Parked cards have no slot yet, so the grid shows a gap at the drop position.
        const idx = target === "grid" ? dropIndexAt(e.clientX, e.clientY) : null;
        if (idx !== dropIndexRef.current) {
          // Widths shift with the gap, so animate the reflow instead of snapping.
          captureLayout();
          dropIndexRef.current = idx;
          setDropIndex(idx);
        }
        return;
      }
      if (dropIndexRef.current !== null) {
        captureLayout();
        dropIndexRef.current = null;
        setDropIndex(null);
      }
      if (target === "tray") return; // hovering the tray means "hide", not "reorder"
      const idx = dropIndexAt(e.clientX, e.clientY);
      const last = lastReorder.current;
      // Require real movement since the previous reorder: the layout shifts under the
      // cursor, and a 1px wobble there would otherwise reorder back and forth.
      if (!last || Math.hypot(e.clientX - last.x, e.clientY - last.y) >= 12) {
        if (moveToIndex(idx)) lastReorder.current = { x: e.clientX, y: e.clientY };
      }
    }
    function onUp(e: MouseEvent) {
      const st = dragRef.current;
      let committed = false;
      if (st?.active) {
        suppressClick.current = true;
        setTimeout(() => { suppressClick.current = false; }, 60);
        const zone = dropTargetAt(e.clientX, e.clientY, st.from);
        if (st.from === "grid" && zone === "tray") {
          captureLayout();
          setWidgets((prev) => ({ ...prev, [st.key]: false }));
          committed = true;
        } else if (st.from === "tray" && zone === "grid") {
          // One snapshot for both changes: the restored card grows out of its tile.
          captureLayout();
          setWidgets((prev) => ({ ...prev, [st.key]: true }));
          moveToIndex(dropIndexAt(e.clientX, e.clientY), false);
          committed = true;
        }
      }
      // A cancelled drag reverts the preview widths; glide the cards back.
      if (!committed && dropIndexRef.current !== null) captureLayout();
      dropIndexRef.current = null;
      dragRef.current?.ghost?.remove();
      dragRef.current = null;
      dragSlots.current = null;
      lastReorder.current = null;
      setDragKey(null);
      setDragSpans(null);
      setDropZone(null);
      setDropIndex(null);
      document.documentElement.classList.remove("widget-drag");
    }
    function onClickCapture(e: MouseEvent) {
      if (suppressClick.current) {
        e.preventDefault();
        e.stopPropagation();
        suppressClick.current = false;
      }
    }
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    window.addEventListener("click", onClickCapture, true);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
      window.removeEventListener("click", onClickCapture, true);
      dragRef.current?.ghost?.remove();
      dragRef.current = null;
      dragSlots.current = null;
      lastReorder.current = null;
      setDragSpans(null);
      setDropZone(null);
      setDropIndex(null);
      dropIndexRef.current = null;
      document.documentElement.classList.remove("widget-drag");
    };
  }, [editing]);

  function startDrag(key: WidgetKey, e: React.MouseEvent, from: "grid" | "tray" = "grid") {
    if (!editing || e.button !== 0) return;
    const target = e.target as Element;
    if (target.closest(".eye-btn, a, input, select, textarea, .btn, .icon-btn")) return;
    document.documentElement.classList.add("widget-drag");
    window.getSelection()?.removeAllRanges();
    const card = e.currentTarget as HTMLElement;
    const r = card.getBoundingClientRect();
    dragRef.current = { key, from, startX: e.clientX, startY: e.clientY, offsetX: e.clientX - r.left, offsetY: e.clientY - r.top, active: false };
  }

  const [pruneOpts, setPruneOpts] = useState({ containers: true, networks: true, images: true, all_images: false, volumes: false, build_cache: true });
  const [form, setForm] = useState({ ...blankForm });
  const [template, setTemplate] = useState("");
  const [sshConfig, setSshConfig] = useState("");
  const [logTarget, setLogTarget] = useState<{ id: string; name: string; runtime?: "docker" | "podman" } | null>(null);
  const [expandedRow, setExpandedRow] = useState<string | null>(null);
  const [collapsedGroups, setCollapsedGroups] = useState<Record<string, boolean>>({});
  const [inspect, setInspect] = useState<InspectTarget | null>(null);
  function toggleRow(id: string) { setInspect(null); setExpandedRow((prev) => (prev === id ? null : id)); }
  /** Row glyphs open the inspect payload in its own window, the same sheet Logs uses. */
  function loadInspect(kind: string, name: string, id: string) {
    const target: InspectTarget = { kind, name, cmd: "inspect_cmd", args: { id }, raw: null, error: null };
    setInspect(target);
    invoke<string>(target.cmd, target.args)
      .then((raw) => setInspect((prev) => (prev?.name === target.name ? { ...prev, raw } : prev)))
      .catch((e) => setInspect((prev) => (prev?.name === target.name ? { ...prev, error: String(e) } : prev)));
  }
  const [modelOut, setModelOut] = useState("");
  const [cfg, setCfg] = useState<ProfileConfig | null>(null);
  const [models, setModels] = useState("");
  const [serveList, setServeList] = useState<[string, number][]>([]);
  const [ai, setAi] = useState({ registry: "docker" as "docker" | "hf" | "ollama", name: "gemma3", prompt: "", runner: "docker" as "docker" | "ramalama", port: 8080 });

  /** `uname -m` as the backend reports it; empty until the first tool probe. */
  const hostArch = normalizeArch(tools?.host_arch);
  /** vz and krunkit boot only the host architecture, so a new profile starts from it. */
  function openCreate() {
    setForm({ ...blankForm, arch: hostArch === "amd64" ? "x86_64" : "aarch64" });
    setShowCreate(true);
  }
  function openNetEdit() {
    if (!cfg) return;
    setNetEdit({
      dns: cfg.dns.join(", "),
      dns_hosts: cfg.dns_hosts.map((h) => `${h.name}=${h.target}`).join("\n"),
      port_forwarder: cfg.port_forwarder,
      gateway_address: cfg.gateway_address,
    });
  }
  function openRecreate() {
    if (!cfg) return;
    setRecreate({
      arch: cfg.arch, vm_type: cfg.vm_type, runtime: cfg.runtime, mount_type: cfg.mount_type,
      network_mode: cfg.network_mode, network_interface: cfg.network_interface,
      network_address: cfg.network_address, rosetta: cfg.rosetta, kubernetes: cfg.kubernetes,
      keep_data: true, confirm: "",
      dns: cfg.dns.join(", "), dns_hosts: cfg.dns_hosts.map((h) => `${h.name}=${h.target}`).join(", "),
    });
  }
  const openCreateRef = useRef(openCreate);
  openCreateRef.current = openCreate;
  /** vz and krunkit cannot boot the other architecture; qemu is the only cross-arch VM type. */
  const createArch = normalizeArch(form.arch);
  const crossArch = !!hostArch && !!createArch && createArch !== hostArch;

  imagesRef.current = images;
  containersRef.current = containers;

  function pushNotice(n: Omit<Notice, "id">) {
    const id = ++noticeSeq.current;
    setNotices((list) => {
      if (list.some((x) => x.title === n.title && x.detail === n.detail)) return list;
      return [...list, { ...n, id }].slice(-3);
    });
    return id;
  }

  /** Every external link takes the same guarded command; open_url_cmd refuses anything but http(s). */
  function openUrl(url: string, done: string) {
    void act(() => invoke("open_url_cmd", { url }), done);
  }

  function containerActions(containerId: string) {
    const name = containersRef.current.find((c) => containerId.startsWith(c.id) || c.id.startsWith(containerId))?.name;
    return [
      { label: "Open Containers", run: () => go({ tab: "containers", search: name ?? "" }) },
      {
        label: "Stop container",
        run: () => void act(() => invoke("container_action_cmd", { id: containerId, action: "stop" }), "Container stopped")
          .then(() => setNotices((list) => list.filter((n) => n.containerId !== containerId))),
      },
    ];
  }

  function reportProblem(e: unknown) {
    const problem = humanizeDockerError(String(e), imagesRef.current, containersRef.current);
    // A stalled read is the one failure whose fix is the button already in the header, so
    // the banner carries it: retry, then stand down once the read has been reissued.
    const id = pushNotice({
      kind: "error",
      title: problem.title,
      detail: problem.detail,
      evidence: problem.evidence,
      containerId: problem.containerId,
      actions: problem.containerId
        ? containerActions(problem.containerId)
        : problem.retryable
          ? [{ label: "Retry", run: () => { setNotices((list) => list.filter((n) => n.id !== id)); void pageRefresh(); } }]
          : undefined,
    });
  }

  async function safe<T>(p: Promise<T>, fallback: T): Promise<T> {
    try { return await p; } catch (e) { reportProblem(e); return fallback; }
  }
  /** Points the container client at a profile before any docker command runs. The runtime
   *  comes from a profile list already in hand, so this never waits on `colima status`. */
  async function activateProfile(name: string, list: Profile[] = profiles) {
    const runtime = list.find((p) => p.name === name)?.runtime ?? null;
    return safe(invoke<string>("set_profile_cmd", { profile: name, runtime }), "");
  }
  /** One batched `image inspect` tells the Images table which rows run emulated. `docker
   *  image ls` carries no platform, and inspecting costs 0.8 s for 26 images, so the call is
   *  skipped while the set of image ids is unchanged. Decorative: a refusal leaves the column
   *  at `—` and raises no notice. */
  async function readImageArch(list: Image[], gen: number) {
    const ids = [...new Set(list.map((i) => i.id.replace(/^sha256:/, "")).filter((id) => /^[0-9a-f]{12,64}$/.test(id)))];
    const key = ids.slice().sort().join(",");
    if (key === imageIdsRef.current) return;
    if (ids.length === 0) {
      imageIdsRef.current = "";
      setImageArch({});
      setImageDigest({});
      return;
    }
    try {
      const platforms = await invoke<ImagePlatform[]>("image_platforms_cmd", { ids });
      if (gen !== refreshGen.current) return;
      const map: Record<string, string> = {};
      const digests: Record<string, string> = {};
      for (const p of platforms) {
        const full = p.id.replace(/^sha256:/, "");
        map[full] = p.architecture;
        map[full.slice(0, 12)] = p.architecture;
        digests[full] = p.digest;
        digests[full.slice(0, 12)] = p.digest;
      }
      imageIdsRef.current = key;
      setImageArch(map);
      setImageDigest(digests);
    } catch {
      // Retry on the next wave: the ids are still unanswered, so the key was never stored.
    }
  }
  /** The container lists this profile's daemon answers, read as one wave.
   *  `quiet` keeps a speculative read from raising notices: the caller started it on the
   *  last known state, so a refusal is already explained by the profile being stopped. */
  async function readDocker(quiet = false) {
    const call = <T,>(cmd: string) =>
      invoke<T>(cmd).then((v) => ({ ok: true as const, v })).catch((e: unknown) => {
        if (!quiet) reportProblem(e);
        return { ok: false as const, v: [] as unknown as T };
      });
    const [c, i, vol, net, cmp] = await Promise.all([
      call<Container[]>("list_containers_cmd"),
      call<Image[]>("list_images_cmd"),
      call<Volume[]>("list_volumes_cmd"),
      call<Network[]>("list_networks_cmd"),
      call<ComposeProject[]>("compose_list_cmd"),
    ]);
    return { c: c.v, i: i.v, vol: vol.v, net: net.v, cmp: cmp.v,
      // Compose is an optional plugin: its absence empties one list and must never make the
      // Containers, Images or Volumes pages report "list unavailable".
      failed: !c.ok || !i.ok || !vol.ok || !net.ok };
  }
  /** `docker system df` scans every layer and takes longer than the whole list wave, so it
   *  lands after the containers are on screen. A refresh replaced by a newer one (or by a
   *  profile switch) drops its answer instead of overwriting fresher state. */
  async function readDisk(gen: number) {
    const dsk = await safe(invoke<DiskUsage>("disk_usage_cmd"), EMPTY_DISK);
    if (gen === refreshGen.current) setDisk(dsk);
  }
  /** Podman is independent of the selected Colima profile. A stopped machine answers
   *  nothing, so the lists stay empty instead of raising four error notices. */
  /** `preferred` lets a caller switch machine and read in one go: state is not updated yet, so
   *  a closure read here would still hold the previous name and undo the switch. `deep` reads
   *  the four lists and the disk walk; the fifteen-second wave passes false unless a Podman
   *  page is open, because those five children have no consumer while a Docker tab is. The
   *  machine list is always read: the sidebar and the dashboard badge come from it. */
  async function readPodman(preferred?: string, deep = true) {
    const quiet = <T,>(p: Promise<T>, fallback: T) => p.catch(() => fallback);
    const machines = await quiet(invoke<PodmanMachine[]>("podman_machines_cmd"), []);
    // Scope before reading anything else, and keep the selection valid: a machine can be
    // removed, and a stopped one must not be the connection everything else uses.
    const wanted = preferred ?? podmanMachine;
    const usable = machines.find((m) => m.name === wanted && m.running)
      ?? machines.find((m) => m.running)
      ?? machines.find((m) => m.default)
      ?? machines[0];
    if (usable && usable.name !== podmanMachine) setPodmanMachine(usable.name);
    await quiet(invoke<string>("podman_set_machine_cmd", { name: usable?.name ?? null }), "");
    setPodmanMachines(machines);
    if (!machines.some((m) => m.running)) {
      setPodmanContainers([]); setPodmanImages([]); setPodmanVolumes([]); setPodmanNetworks([]);
      setPodmanDisk(EMPTY_PODMAN_DISK);
      return;
    }
    if (!deep) return;
    const [c, i, v, n, df] = await Promise.all([
      quiet(invoke<PodmanContainer[]>("podman_containers_cmd"), []),
      quiet(invoke<PodmanImage[]>("podman_images_cmd"), []),
      quiet(invoke<PodmanVolume[]>("podman_volumes_cmd"), []),
      quiet(invoke<PodmanNetwork[]>("podman_networks_cmd"), []),
      quiet(invoke<PodmanDiskUsage>("podman_disk_usage_cmd"), EMPTY_PODMAN_DISK),
    ]);
    setPodmanContainers(c); setPodmanImages(i); setPodmanVolumes(v); setPodmanNetworks(n);
    setPodmanDisk(df);
  }
  /**
   * One data refresh. `preloaded` is a profile list the caller has just read: a launch then
   * pays for `colima list` once, and — because the profile's state is already known — the
   * container commands run in the same wave as the tool probes instead of behind them.
   *
   * Callers are not all deliberate: the timer, a `docker events` burst, a visibility change
   * and the header button can all ask at once, and each wave is about seventeen children.
   * A second request for the profile already being read joins that wave instead of starting
   * another; a request for a *different* profile starts its own and fences the older one, so
   * the previous daemon's rows can never land on top of the new profile's.
   */
  async function refresh(profile: string = selected, preloaded?: Profile[]): Promise<void> {
    const running = refreshJob.current;
    if (running && running.profile === profile) return running.p;
    const gen = ++refreshGen.current;
    const job = { profile, gen, p: runRefresh(profile, gen, preloaded) };
    refreshJob.current = job;
    try {
      await job.p;
    } finally {
      if (refreshJob.current === job) refreshJob.current = null;
    }
  }

  async function runRefresh(profile: string, gen: number, preloaded?: Profile[]) {
    // Every write below is conditional on this still being the newest wave.
    const live = () => gen === refreshGen.current;
    setRefreshing(true);
    // `colima list` costs ~480 ms and used to gate the whole docker wave. The profile's last
    // known state is enough to start the lists beside it; a speculative read stays quiet and
    // its answer is dropped below if the fresh list says the profile is stopped.
    const knownStatus = preloaded?.find((p) => p.name === profile)?.status
      ?? profiles.find((p) => p.name === profile)?.status;
    const speculative = !preloaded;
    const docker = knownStatus?.toLowerCase() === "running" ? readDocker(speculative) : null;
    const [p, srv, lima, sys] = await Promise.all([
      preloaded ? Promise.resolve(preloaded) : safe(invoke<Profile[]>("list_profiles_cmd"), []),
      safe(invoke<[string, number][]>("model_serve_status_cmd"), []),
      safe(invoke<LimaVm[]>("lima_vms_cmd"), []),
      safe(invoke<SystemStatus>("system_status_cmd"), null as unknown as SystemStatus),
    ]);
    if (!live()) return;
    setProfiles(p); setProfilesRead(true); setServeList(srv); setLimaVms(lima); setTools(sys);
    if (sys) {
      try { localStorage.setItem("runtimeDesk.tools", JSON.stringify(sys)); } catch { /* quota */ }
    }
    if (sys?.podman) {
      // A Podman page needs its lists; the dashboard's Storage card needs the disk walk. Any
      // other tab only needs the machine list behind the sidebar badge.
      const deep = tab.startsWith("podman-") || (tab === "dashboard" && !!widgets.storage);
      void readPodman(undefined, deep);
    }
    else {
      setPodmanMachines([]); setPodmanContainers([]); setPodmanImages([]); setPodmanVolumes([]); setPodmanNetworks([]);
      setPodmanDisk(EMPTY_PODMAN_DISK);
    }
    if (!p.find((x) => x.name === profile) && p.length) {
      // The selected profile vanished: point the client at the one that took its place.
      setSelected(p[0].name);
      void activateProfile(p[0].name, p);
    }
    // Docker data only exists while the profile's daemon is up; a stopped profile
    // shows empty views instead of a "cannot connect" error.
    const profileUp = docker !== null || p.find((x) => x.name === profile)?.status.toLowerCase() === "running";
    if (profileUp) {
      const { c, i, vol, net, cmp, failed } = docker ? await docker : await readDocker();
      if (!live()) return;
      setContainers(c); setImages(i); setVolumes(vol); setNetworks(net); setCompose(cmp);
      void readImageArch(i, gen);
      // Counts come from the lists already in hand; a second set of docker list
      // calls for the same numbers was the most expensive part of a refresh.
      setCounts({
        containers: c.length,
        running: c.filter((x) => x.state === "running").length,
        images: i.length,
        volumes: vol.length,
      });
      setListsFailed(failed);
      setCountsRead(!failed);
      setCountsProfile(profile);
      void readDisk(gen);
    } else {
      setContainers([]); setImages([]); setVolumes([]); setNetworks([]); setCompose([]);
      setImageArch({});
      imageIdsRef.current = "";
      setCounts({ containers: 0, running: 0, images: 0, volumes: 0 });
      setListsFailed(false);
      setCountsRead(false);
      setCountsProfile("");
      setDisk(EMPTY_DISK);
    }
    setLastUpdated(Date.now());
    setRefreshing(false);
  }
  /** The header's Refresh reloads the app data plus whatever the visible page owns. */
  async function pageRefresh() {
    setPageRefreshing(true);
    try {
      await refresh();
      await loadStatus(selected, true);
      if (tab === "cleanup") setCleanupNonce((n) => n + 1);
      else if (tab === "runtimes") await loadDiagnostics();
      else if (tab === "settings") await checkVersion();
      else if (tab === "sherlock") setSubjectNonce((n) => n + 1);
      else if (tab === "ai") await loadConfig(selected);
      else if (tab.startsWith("podman-")) setPodmanNonce((n) => n + 1);
      else if (tab === "kubernetes") setKubeNonce((n) => n + 1);
    } finally {
      setPageRefreshing(false);
    }
  }
  async function loadDiagnostics(profile = selected) {
    if (!profile) return;
    setDiagLoading(true);
    setDiag(await safe(invoke<VmDiagnostics>("vm_diagnostics_cmd", { profile }), null as unknown as VmDiagnostics));
    setDiagLoading(false);
  }
  async function checkVersion() {
    setCheckingVersion(true);
    setVersionInfo(await safe(invoke<VersionInfo>("version_check_cmd"), null as unknown as VersionInfo));
    setCheckingVersion(false);
  }
  /**
   * The launch build cannot change while the app runs, so this hits GitHub once. A failed
   * lookup (offline, rate-limited) leaves the refs clear and Settings retries it.
   */
  async function checkAppRelease() {
    if (appReleaseChecked.current) return;
    appReleaseChecked.current = true;
    let next: AppRelease;
    try {
      next = await invoke<AppRelease>("app_release_cmd");
    } catch {
      appReleaseChecked.current = false;
      return;
    }
    setAppRelease(next);
    if (!next.update_available || !next.latest || appReleaseAnnounced.current) return;
    appReleaseAnnounced.current = true;
    pushNotice({
      kind: "info",
      tag: "app-release",
      title: `Runtime Desk ${next.latest} is available`,
      detail: `You are running ${next.installed}. Download the new build from GitHub.`,
      actions: [{ label: "Open releases", run: () => openUrl(next.url, "Opened releases") }],
    });
  }
  /**
   * Settings › About states the same release inline with the same action, so the banner
   * stands down while that panel is on screen — one fact, one place. Leaving About does not
   * bring it back: the panel already carried the announcement.
   */
  useEffect(() => {
    if (tab !== "settings" || settingsTab !== "about") return;
    setNotices((list) => (list.some((n) => n.tag === "app-release") ? list.filter((n) => n.tag !== "app-release") : list));
  }, [tab, settingsTab, appRelease]);
  async function loadConfig(name: string) {
    if (!name) return;
    setCfg(await safe(invoke<ProfileConfig>("profile_config_cmd", { profile: name }), null as unknown as ProfileConfig));
  }
  async function loadStatus(name: string, fresh = false) {
    if (!name) return;
    setStatus(await safe(invoke<Status>("status_cmd", { profile: name, fresh }), {} as Status));
  }
  /** `colima version` costs ~0.5 s and only changes on upgrade, so it stays out of refresh. */
  async function loadVersion() {
    setVersion((await safe(invoke<string>("version_cmd"), "")).trim());
  }
  /** Switching profile repoints the docker daemon and reloads everything. */
  async function chooseProfile(name: string) {
    setSelected(name);
    setNetworkScope(null);
    setDiag(null);
    await activateProfile(name);
    await refresh(name);
  }
  useEffect(() => {
    (async () => {
      void loadVersion();
      const list = await safe(invoke<Profile[]>("list_profiles_cmd"), []);
      setProfiles(list);
      const name = list.find((p) => p.name === selected)?.name ?? list[0]?.name ?? "";
      // Set it even when empty: a machine with no profile must not keep answering for a
      // profile called "default" that Colima never reported.
      setSelected(name);
      if (name) await activateProfile(name, list);
      // The list above is the one refresh needs, so it is not read twice.
      await refresh(name, list);
      void checkAppRelease();
    })();
  }, []);
  useEffect(() => { loadStatus(selected); loadConfig(selected); setSshConfig(""); }, [selected]);
  // Release check is a network call, so it runs when Settings is opened, not on every refresh.
  useEffect(() => { if (tab === "settings") { void checkVersion(); void checkAppRelease(); } }, [tab]);
  // One sampling lifecycle for live stats: open while the monitor is "on" — its card is
  // enabled or its page is open — and closed when neither is. Window visibility is not part
  // of the gate: the sampler is one long-lived `docker stats` child that spawns nothing per
  // tick, and stopping it on every window switch punched a hole in the history that the
  // charts exist to show (the group page fell back to "Collecting the first samples…").
  const activityReady = !!tools?.docker
    && profiles.some((p) => p.name === selected && p.status.toLowerCase() === "running")
    && (!!widgets.activity || tab === "activity" || (tab === "sherlock" && subject?.kind === "group"));
  useEffect(() => {
    setActivityActive(activityReady);
    return () => setActivityActive(false);
  }, [activityReady]);
  // OOM guard: it reads the stats the monitor already samples instead of adding a poll, so
  // it runs while the Activity card or page is on. A container crossing the pressure
  // threshold raises one notice; dropping back below it withdraws that notice.
  const vmMemoryRef = useRef(0);
  vmMemoryRef.current = profiles.find((p) => p.name === selected)?.memory ?? 0;
  useEffect(() => subscribeActivity(() => {
    const pressure = memoryPressure(activitySnapshot().stats, vmMemoryRef.current);
    const open = new Set(pressure.map((p) => p.id));
    for (const p of pressure) {
      if (pressuredRef.current.has(p.id)) continue;
      // A container without a limit gets the action that would confine it.
      const bounded = !p.unbounded;
      const noticeId = pushNotice({
        kind: "error",
        title: bounded ? `${p.name} is close to its memory limit` : `${p.name} is using the VM's memory with no limit`,
        detail: bounded
          ? `${p.pct.toFixed(0)}% of ${fmtBytes(p.limit)} (${fmtBytes(p.used)}). Docker OOM-kills the container at 100%: raise the limit, or cut what it runs.`
          : `${fmtBytes(p.used)} of the ${fmtBytes(p.limit)} VM (${p.pct.toFixed(0)}%). Nothing caps this container, so its next spike can OOM-kill the whole guest: set a limit to confine it.`,
        containerId: p.id,
        actions: [{ label: bounded ? "Raise the limit…" : "Set a limit…", run: () => setLimitTarget({ id: p.id, name: p.name, used: p.used, current: bounded ? p.limit : 0 }) }],
      });
      pressuredRef.current.set(p.id, noticeId);
    }
    for (const [id, noticeId] of [...pressuredRef.current]) {
      if (open.has(id)) continue;
      pressuredRef.current.delete(id);
      setNotices((list) => list.filter((n) => n.id !== noticeId));
    }
  }), []);
  async function applyMemoryLimit(bytes: number) {
    const target = limitTarget;
    if (!target) return;
    setLimitTarget(null);
    await act(
      () => invoke("container_update_memory_cmd", { id: target.id, bytes }),
      `${target.name}: memory limit ${fmtBytes(bytes)}`,
    );
  }
  // Timed refresh only while the window is visible: a backgrounded app should not
  // spawn a dozen CLI processes every 15 s. Returning to the window refreshes at once.
  // With the event stream live this drops to a 60 s reconciliation, because events can be
  // missed while the child reconnects and a silent miss would freeze the views.
  useEffect(() => {
    let tick = 0;
    const run = () => {
      if (document.visibilityState !== "visible") return;
      tick += 1;
      if (eventStreamActive() && tick % 4 !== 0) return;
      refreshRef.current();
    };
    const id = setInterval(run, 15000);
    document.addEventListener("visibilitychange", run);
    return () => { clearInterval(id); document.removeEventListener("visibilitychange", run); };
  }, []);
  function finishOnboarding() {
    try { localStorage.setItem("runtimeDesk.onboarded", "1"); } catch { /* private mode */ }
    setShowOnboarding(false);
    void refresh();
  }
  useEffect(() => {
    // Needed by the Networks tab and by Sherlock: network members, and the peers of a
    // container that share its networks.
    if (tab !== "networks" && tab !== "sherlock") return;
    let alive = true;
    safe(invoke<NetworkMapEntry[]>("network_map_cmd"), []).then((m) => { if (alive) setNetMap(m); });
    return () => { alive = false; };
  }, [tab, lastUpdated, subject?.kind, subject?.id]);
  useEffect(() => { localStorage.setItem("runtimeDesk.widgets", JSON.stringify(widgets)); }, [widgets]);
  // What the window reopens to. Written on change, not on exit: a crash or a force quit
  // still restores the last screen, and there is no quit hook to get wrong.
  useEffect(() => { try { localStorage.setItem("runtimeDesk.tab", tab); } catch { /* private mode */ } }, [tab]);
  useEffect(() => { try { localStorage.setItem("runtimeDesk.settingsTab", settingsTab); } catch { /* private mode */ } }, [settingsTab]);
  useEffect(() => { try { localStorage.setItem("runtimeDesk.sidebarHidden", sidebarHidden ? "1" : "0"); } catch { /* private mode */ } }, [sidebarHidden]);
  const refreshRef = useRef(refresh);
  refreshRef.current = refresh;
  const pageRefreshRef = useRef(pageRefresh);
  pageRefreshRef.current = pageRefresh;
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      const inField = e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement;
      // A dialog owns the keyboard while it is open; the menu bar routes the same commands.
      if (overlayOpen() && (mod || e.key === "?")) return;
      if (mod && e.key === "[") {
        e.preventDefault();
        backFn.current();
      } else if (mod && e.key.toLowerCase() === "r") {
        e.preventDefault();
        void pageRefreshRef.current();
      } else if (mod && /^[0-9]$/.test(e.key)) {
        const nav = visibleNavRef.current;
        const n = nav[e.key === "0" ? nav.length - 1 : Number(e.key) - 1];
        if (n) { navToRef.current({ tab: n.id, search: "" }); e.preventDefault(); }
      } else if (mod && e.altKey && (e.code === "KeyS" || e.key === "ß" || e.key.toLowerCase() === "s")) {
        // Same chord the View menu advertises; the menu owns it once the window is real.
        e.preventDefault();
        setSidebarHidden((hidden) => !hidden);
      } else if (mod && e.key === ",") {
        // macOS puts Settings on ⌘, in every app; the menu bar sends the same command.
        e.preventDefault();
        navToRef.current({ tab: "settings", settingsTab: "general" });
      } else if (mod && e.key === "/") {
        // The Help menu's shortcut; browsers give ⌘? as Shift-/, which the "?" branch handles.
        e.preventDefault();
        setShowHelp(true);
      } else if (e.key === "Escape") {
        setShowCreate(false); setShowPrune(false); setEditing(false); setLogTarget(null); setShowHelp(false);
      } else if (e.key === "?" && !inField) {
        setShowHelp(true);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  useEffect(() => {
    // The menu bar lives in Rust so macOS owns its accelerators (⌘R, ⌘K, ⌘,). Items
    // that change what the window shows come back here as one id.
    let stop: (() => void) | undefined;
    let alive = true;
    listen<string>("menu", (event) => {
      switch (event.payload) {
        case "settings": navToRef.current({ tab: "settings", settingsTab: "general" }); break;
        // One About surface: the app menu opens the Settings tab, not a second stock panel
        // with different facts beside it.
        case "about": navToRef.current({ tab: "settings", settingsTab: "about" }); break;
        case "refresh": void pageRefreshRef.current(); break;
        case "search": window.dispatchEvent(new Event("colima:search")); break;
        case "toggle-sidebar": setSidebarHidden((hidden) => !hidden); break;
        case "new-profile": openCreateRef.current(); break;
        case "shortcuts": setShowHelp(true); break;
        case "docs": openUrl(`${REPO_URL}/blob/main/docs/USAGE.md`, "Opened usage guide"); break;
        case "issue": openUrl(`${REPO_URL}/issues/new`, "Opened issue form"); break;
      }
    })
      .then((unlisten) => { if (alive) stop = unlisten; else unlisten(); })
      // Browser dev has no menu host; the shortcuts above still cover it.
      .catch(() => {});
    return () => { alive = false; stop?.(); };
  }, []);
  useEffect(() => {
    // The menu-bar item forwards Start/Stop here: the window owns busy state, notices and
    // the refresh that follows, so the tray never runs the CLI on its own.
    let stop: (() => void) | undefined;
    let alive = true;
    listen<string>("tray", (event) => trayActionRef.current(event.payload))
      .then((unlisten) => { if (alive) stop = unlisten; else unlisten(); })
      .catch(() => {});
    return () => { alive = false; stop?.(); };
  }, []);
  useEffect(() => {
    // A Mac user right-clicks a row to see what it can do. The menu is the same one
    // the ⋯ trigger opens, so there is exactly one set of row actions to maintain.
    function onContextMenu(e: MouseEvent) {
      const row = (e.target as Element | null)?.closest?.("tr, .side-profile");
      const trigger = row?.querySelector<HTMLButtonElement>(".menu-trigger");
      if (!trigger) return;
      e.preventDefault();
      trigger.click();
    }
    document.addEventListener("contextmenu", onContextMenu);
    return () => document.removeEventListener("contextmenu", onContextMenu);
  }, []);
  useEffect(() => subscribeTags(() => setTagTick((t) => t + 1)), []);
  async function act(fn: () => Promise<unknown>, verb?: string) {
    setBusy(true);
    try {
      const r = await fn();
      const text = typeof r === "string" ? r.trim() : "";
      if (text) {
        const [, ...rest] = text.split("\n");
        pushNotice({
          kind: "success",
          title: (verb ?? text.split("\n")[0]).slice(0, 160),
          detail: rest.length ? rest.join("\n").slice(0, 800) : undefined,
        });
      } else if (verb) {
        pushNotice({ kind: "success", title: verb });
      }
      await refresh(); await loadStatus(selected);
      setCleanupNonce((n) => n + 1);
    } catch (e) { reportProblem(e); }
    finally { setBusy(false); }
  }
  // The tray registers its listener once; rebinding here keeps Start/Stop on the profile that
  // is selected now, and makes `act` refresh and report against that same profile.
  trayActionRef.current = (action) => {
    const profile = selectedRef.current;
    if (!profile || busyRef.current || !profiles.some((p) => p.name === profile)) return;
    if (action === "tray-start") void act(() => invoke("start_cmd", { opts: { profile } }));
    if (action === "tray-stop") void act(() => invoke("stop_cmd", { profile }));
  };

  const [sorts, setSorts] = useState<Record<string, { key: string; dir: 1 | -1 }>>({});
  function toggleSort(table: string, key: string) {
    setSorts((s) => {
      const cur = s[table];
      return { ...s, [table]: { key, dir: cur && cur.key === key ? (cur.dir === 1 ? -1 : 1) : 1 } };
    });
  }
  function applySort<T>(table: string, rows: T[], get: (r: T, key: string) => string | number): T[] {
    const s = sorts[table];
    if (!s) return rows;
    const out = [...rows];
    out.sort((a, b) => {
      const av = get(a, s.key), bv = get(b, s.key);
      if (av < bv) return -1 * s.dir;
      if (av > bv) return 1 * s.dir;
      return 0;
    });
    return out;
  }
  /** A sortable header is a control: it takes focus, answers Return/Space, and states the
   *  current order to assistive tech. */
  function SortTh({ table, k, children }: { table: string; k: string; children: string }) {
    const s = sorts[table];
    const active = s?.key === k;
    const sort = active ? (s!.dir === 1 ? "ascending" : "descending") : "none";
    return (
      <th aria-sort={sort}>
        <button
          type="button"
          className="th-sort"
          onClick={() => toggleSort(table, k)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSort(table, k); } }}
        >
          {children}
          {active ? <span className={`sort-arrow ${s.dir === 1 ? "up" : "down"}`} aria-hidden="true" /> : ""}
        </button>
      </th>
    );
  }

  function containerVal(c: Container, k: string): string | number {
    switch (k) {
      case "state": return c.state;
      case "name": return c.name;
      case "image": return c.image;
      case "status": return c.status;
      case "ports": return c.ports;
      default: return "";
    }
  }
  function imageVal(i: Image, k: string): string | number {
    switch (k) {
      case "id": return i.id;
      case "repository": return i.repository;
      case "tag": return i.tag;
      case "arch": return imageArch[i.id] ?? imageArch[i.id.replace(/^sha256:/, "")] ?? "";
      case "size": return i.size;
      case "created": return i.created;
      default: return "";
    }
  }
  /** The selected profile's guest architecture, from whichever read answered first. */
  const guestArch = normalizeArch(status?.arch ?? cfg?.arch ?? profiles.find((p) => p.name === selected)?.arch);
  /** Rosetta exists only in a vz VM; the config flag is the promise, diagnostics prove it. */
  const rosettaOn = cfg?.vm_type === "vz" && cfg.rosetta;
  /** `Container.image` is a tag, an id, or a `sha256:` digest; one map answers all three. */
  const imageByRef = useMemo(() => {
    const map = new Map<string, Image>();
    for (const i of images) {
      const short = i.id.replace(/^sha256:/, "");
      map.set(`${i.repository}:${i.tag}`, i);
      map.set(i.id, i);
      map.set(short, i);
      map.set(short.slice(0, 12), i);
    }
    return map;
  }, [images]);
  const imageForRef = (ref: string) => {
    const short = ref.replace(/^sha256:/, "");
    return imageByRef.get(ref) ?? imageByRef.get(short) ?? imageByRef.get(short.slice(0, 12));
  };
  /** Null when the platform was not read; the table renders `—` rather than a guess. */
  const imageArchInfo = (img?: Image): { label: string; tone: "native" | "rosetta" | "emulated"; title: string } | null => {
    const raw = img ? imageArch[img.id] ?? imageArch[img.id.replace(/^sha256:/, "")] ?? "" : "";
    const arch = normalizeArch(raw);
    if (!arch) return null;
    if (!guestArch || arch === guestArch) {
      return { label: raw, tone: "native", title: guestArch ? `Built for this profile's ${raw} VM` : `Built for ${raw}` };
    }
    const translated = arch === "amd64" && guestArch === "arm64" && rosettaOn;
    return {
      label: raw,
      tone: translated ? "rosetta" : "emulated",
      title: translated
        ? "Translated by Rosetta: linux/amd64 binaries run at near-native speed"
        : `Emulated: this ${guestArch} VM runs it through qemu. ${guestArch === "arm64" && arch === "amd64"
          ? "A vz profile with Rosetta, or an arm64 image, removes the translation."
          : "An image built for the profile's architecture removes the translation."}`,
    };
  };
  const volSizeByName = useMemo(() => new Map(volSizes.map((v) => [v.name, v.size])), [volSizes]);
  function volumeVal(v: Volume, k: string): string | number {
    switch (k) {
      case "name": return v.name;
      case "size": return volSizeByName.get(v.name) ?? -1;
      case "driver": return v.driver;
      case "mountpoint": return v.mountpoint;
      default: return "";
    }
  }
  const BUILTIN_NETWORKS: Record<string, true> = { bridge: true, host: true, none: true };

  /** Three owners, not two: compose projects, plain `docker run`, and the cluster. */
  const podCount = containers.filter(isKubernetesContainer).length;
  const filteredContainers = applySort("containers", containers.filter((c) =>
    (c.name + c.image + c.state + c.compose_project).toLowerCase().includes(search.toLowerCase())
    && (containerFilter === "all"
      || (containerFilter === "k8s" ? isKubernetesContainer(c)
        : containerFilter === "compose" ? originOf(c) === "compose"
        : originOf(c) === "docker" && !isKubernetesContainer(c)))
    && (!networkScope || networkScope.names.includes(c.name))), containerVal);
  // The origin column only earns its width when the list actually mixes origins.
  // A Docker-only profile repeats "docker" on every row, so the column is dropped.
  const showOrigin = new Set(containers.map((c) => originOf(c))).size > 1;
  const containerCols = showOrigin ? 7 : 6;
  // Compose projects group their containers; plain Docker containers stay ungrouped.
  const containerGroups = (() => {
    const byProject = new Map<string, Container[]>();
    const standalone: Container[] = [];
    for (const c of filteredContainers) {
      if (!c.compose_project) { standalone.push(c); continue; }
      const rows = byProject.get(c.compose_project);
      if (rows) rows.push(c); else byProject.set(c.compose_project, [c]);
    }
    return {
      projects: [...byProject.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([project, rows]) => ({ project, rows })),
      standalone,
    };
  })();
  // One row-level action for a whole Compose project: apply the action only to the
  // containers that need it, sequentially, so we never touch an already-correct state.
  function groupAction(project: string, rows: Container[], action: "start" | "stop") {
    const targets = rows.filter((c) => (action === "start" ? c.state !== "running" : c.state === "running"));
    if (targets.length === 0) return;
    act(async () => {
      for (const c of targets) await invoke("container_action_cmd", { id: c.id, action });
      const noun = targets.length === 1 ? "container" : "containers";
      return `${action === "start" ? "Started" : "Stopped"} ${targets.length} ${noun} in ${project}`;
    });
  }
  const containerRow = (c: Container) => (
    <Fragment key={c.id}>
      <tr onClick={(e) => { if ((e.target as Element).closest("button, .menu-trigger")) return; toggleRow(c.id); }} style={{ cursor: "pointer" }}>
        <td><span className={`status-badge ${c.state === "running" ? "running" : "stopped"}`}><span className="dot" />{c.state}</span></td>
        {showOrigin && <td><OriginBadge c={c} /></td>}
        <td style={{ fontWeight: 600 }} title={c.name}><Caret open={expandedRow === c.id} />{isKubernetesContainer(c) && <span className="k8s-chip" title="Created by the profile's Kubernetes cluster, not by you">k8s</span>}{c.name}<TagBadges kind="container" id={c.id} /></td><td title={c.image}>{c.image}{(() => { const a = imageArchInfo(imageForRef(c.image)); return a && a.tone !== "native" ? <span className={`arch-chip ${a.tone}`} title={a.title}>{a.label}</span> : null; })()}</td><td style={{ color: "var(--muted)" }} title={c.status}>{c.status}</td><td className="ports-cell"><PortChips ports={c.ports} /></td>
        <td>
          <div className="actions">
            <button
              className="icon-btn"
              title="Logs"
              aria-label="Logs"
              disabled={busy || !featureGate("logs", tools, selectedRunning, status?.runtime).ok}
              onClick={() => setLogTarget({ id: c.id, name: c.name })}
            >
              <TerminalIcon size={14} />
            </button>
            <RowMenu label="Container actions">
            {(close) => (
              <>
                <button className="menu-item" disabled={busy || c.state === "running"} onClick={() => { close(); act(() => invoke("container_action_cmd", { id: c.id, action: "start" }), "Container started"); }}>Start</button>
                <button className="menu-item" disabled={busy || c.state !== "running"} onClick={() => { close(); act(() => invoke("container_action_cmd", { id: c.id, action: "stop" }), "Container stopped"); }}>Stop</button>
                <button className="menu-item" disabled={busy} onClick={() => { close(); act(() => invoke("container_action_cmd", { id: c.id, action: "restart" }), "Container restarted"); }}>Restart</button>
                <button className="menu-item" onClick={() => { close(); openSubject({ kind: "container", id: c.id }); }}>Investigate</button>
                <button
                  className="menu-item"
                  disabled={busy || !featureGate("logs", tools, selectedRunning, status?.runtime).ok}
                  title={featureGate("logs", tools, selectedRunning, status?.runtime).ok ? undefined : "Needs the container daemon running for this profile"}
                  onClick={() => { close(); setLogTarget({ id: c.id, name: c.name }); }}
                >Logs</button>
                <div className="menu-sep" />
                <ConfirmButton variant="menu" label="Remove" disabled={busy} onConfirm={() => { close(); act(() => invoke("container_action_cmd", { id: c.id, action: "remove" }), "Container removed"); }} />
              </>
            )}
            </RowMenu>
          </div>
        </td>
      </tr>
      {expandedRow === c.id && (
        <tr className="detail-row">
          <td colSpan={containerCols}>
            <ContainerDetail
              id={c.id}
              name={c.name}
              ports={c.ports}
              running={c.state === "running"}
              onLogs={() => setLogTarget({ id: c.id, name: c.name })}
              onAction={(a) => { void act(
                () => invoke("container_action_cmd", { id: c.id, action: a }),
                a === "start" ? "Container started" : a === "stop" ? "Container stopped" : "Container restarted",
              ); }}
              onOpen={() => openSubject({ kind: "container", id: c.id })}
              onOpenCluster={() => go({ tab: "kubernetes", trail: [], search: "", networkScope: null })}
            />
          </td>
        </tr>
      )}
    </Fragment>
  );
  const usedImageRefs = new Set(containers.flatMap((c) => [c.image]));
  const imageUsed = (i: Image) => usedImageRefs.has(`${i.repository}:${i.tag}`) || usedImageRefs.has(i.id) || usedImageRefs.has(i.id.slice(0, 12));
  const filteredImages = applySort("images", images.filter((i) =>
    (i.repository + i.tag).toLowerCase().includes(search.toLowerCase())
    && (imageFilter === "all" || !imageUsed(i))), imageVal);
  // Volume → containers, built once per containers change. Three call sites consulted it per
  // render (the Unused filter, the chip count, every row) and each call re-split every
  // container's mount string; with 300 volumes × 200 containers that was 3.5–4.5 ms of
  // synchronous render per keystroke, plus the same again on every volume-row hover.
  const mountsByVolume = useMemo(() => {
    const map = new Map<string, Container[]>();
    for (const c of containers) {
      for (const m of c.mounts.split(",")) {
        const name = m.trim().split(":")[0];
        if (!name) continue;
        const list = map.get(name);
        if (list) list.push(c);
        else map.set(name, [c]);
      }
    }
    return map;
  }, [containers]);
  const containersUsingVolume = (v: Volume) => mountsByVolume.get(v.name) ?? [];
  const filteredVolumes = applySort("volumes", volumes.filter((v) =>
    v.name.toLowerCase().includes(search.toLowerCase())
    && (volumeFilter === "all" || containersUsingVolume(v).length === 0)), volumeVal);
  const containersUsingImage = (i: Image) => {
    const ref = `${i.repository}:${i.tag}`;
    return containers.filter((c) => c.image === ref || c.image === i.id || (i.id.length > 6 && c.image.startsWith(i.id)));
  };
  /**
   * What an empty table body means. "No containers" is a claim about the engine, so it may
   * only appear when a read answered, nothing failed, and no filter is on: a failed read, a
   * read still in flight, and a typed filter that matched nothing each say their own thing.
   */
  const emptyRow = (noun: string, scoped?: string) =>
    listsFailed ? "List unavailable" : !countsRead ? "Reading…" : scoped ? scoped : search ? "No matches." : `No ${noun}`;
  const netSource = netMap.length > 0 ? netMap.map((m) => ({ name: m.name, driver: m.driver, scope: m.scope })) : networks;
  const networkVal = (n: { name: string; driver: string; scope: string }, k: string): string | number => {
    if (k === "name") return n.name;
    if (k === "driver") return n.driver;
    if (k === "subnet") return netMap.find((m) => m.name === n.name)?.subnet ?? "";
    if (k === "containers") return netMap.find((m) => m.name === n.name)?.containers.length ?? -1;
    return n.name;
  };
  const filteredNets = applySort("networks", netSource.filter((n) =>
    (n.name + n.driver).toLowerCase().includes(search.toLowerCase())
    && (networkFilter === "all" || !(n.name in BUILTIN_NETWORKS))), networkVal);
  const netRows = [
    { title: "Built-in", rows: filteredNets.filter((n) => n.name in BUILTIN_NETWORKS) },
    { title: "User-defined", rows: filteredNets.filter((n) => !(n.name in BUILTIN_NETWORKS)) },
  ].filter((g) => g.rows.length > 0);
  const stoppedContainers = containers.filter((c) => c.state !== "running");
  const danglingImages = images.filter((i) => i.repository === "<none>" || i.tag === "<none>");
  const unusedImages = images.filter((i) => {
    if (i.repository === "<none>" && i.tag === "<none>") return false;
    const ref = `${i.repository}:${i.tag}`;
    return !usedImageRefs.has(ref) && !usedImageRefs.has(i.id) && !usedImageRefs.has(i.id.slice(0, 12));
  });
  // The prune dialog promises "unused" in every section; volumes pruning by Docker also
  // skips mounted ones, so listing all volumes there would overstate what it removes.
  const prunableVolumes = volumes.filter((v) => containersUsingVolume(v).length === 0);
  const cacheLayers = cleanupCache?.profile === selected ? cleanupCache.report.build_cache : [];
  const selectedCount = [pruneOpts.containers, pruneOpts.networks, pruneOpts.build_cache, pruneOpts.images, pruneOpts.all_images, pruneOpts.volumes].filter(Boolean).length;

  const aiModel = ai.registry === "hf"
    ? (ai.runner === "ramalama" ? `hf://${ai.name}` : `hf.co/${ai.name}`)
    : ai.registry === "ollama" ? `ollama://${ai.name}` : ai.name;
  const prereqs = {
    arm: (cfg?.arch ?? status?.arch ?? "") === "aarch64",
    krunkit: cfg?.vm_type === "krunkit",
    docker: cfg?.runtime === "docker",
    runnerOk: ai.runner === "ramalama" ? true : cfg?.runtime === "docker",
  };
  const servePid = serveList.find(([p]) => p === selected)?.[1] ?? null;
  const aiProfile = profiles.find((p) => p.name === "ai");
  const aiProfileRunning = aiProfile?.status.toLowerCase() === "running";
  const title = NAV.find((n) => n.id === tab)?.label ?? "";
  const running = profiles.filter((p) => p.status.toLowerCase() === "running");
  const selectedRunning = profiles.find((p) => p.name === selected)?.status.toLowerCase() === "running";
  useEffect(() => {
  // A menu-bar label is not worth a notice: if the item is missing the window still works.
  void invoke("tray_sync_cmd", {
    profile: profiles.length === 0 ? "No profile" : selected,
    running: selectedRunning,
    available: profiles.length > 0,
  }).catch(() => {});
  }, [selected, selectedRunning, profiles.length]);
  // Volume sizes need one `system df -v` scan; only pay for it while the list is open, or on
  // Sherlock's project page where a project's footprint is the point.
  const wantVolSizes = tab === "volumes" || (tab === "sherlock" && subject?.kind === "group");
  const volSizesProfile = useRef<string | null>(null);
  useEffect(() => {
    if (!wantVolSizes || !selectedRunning) {
      setVolSizes([]);
      setVolSizesLoading(false);
      volSizesProfile.current = null;
      return;
    }
    // Another profile has different volumes: drop the old scan instead of drawing its tiles.
    if (volSizesProfile.current !== selected) setVolSizes([]);
    let alive = true;
    setVolSizesLoading(true);
    safe(invoke<VolumeSize[]>("volume_sizes_cmd"), []).then((list) => {
      if (!alive) return;
      volSizesProfile.current = selected;
      setVolSizes(list);
      setVolSizesLoading(false);
    });
    return () => { alive = false; };
  }, [wantVolSizes, lastUpdated, selected, selectedRunning]);
  // The storage report costs ~4 s (`system df -v` plus a guest `du`), so the last answer is
  // kept per profile and reused for a minute. Coming back to the page paints it at once and,
  // once it is stale, refreshes it in the background; a mutation or Rescan bypasses the cache.
  const cleanupServed = useRef<{ profile: string; nonce: number } | null>(null);
  useEffect(() => {
    if (tab !== "cleanup" || !selectedRunning) {
      setCleanupLoading(false);
      return;
    }
    const profile = selected;
    const cached = cleanupCache?.profile === profile ? cleanupCache : null;
    const fresh = !!cached && Date.now() - cached.at < CLEANUP_TTL;
    const served = cleanupServed.current;
    if (fresh && served?.profile === profile && served.nonce === cleanupNonce) {
      setCleanupLoading(false);
      return;
    }
    const nonce = cleanupNonce;
    setCleanupLoading(true);
    safe(invoke<CleanupReport | null>("cleanup_report_cmd", { profile }), null).then((next) => {
      setCleanupLoading(false);
      if (!next) return;
      // A scan already answered for a newer request; do not overwrite it with this one.
      const answered = cleanupServed.current;
      if (answered?.profile === profile && answered.nonce > nonce) return;
      cleanupServed.current = { profile, nonce };
      setCleanupCache({ profile, report: next, at: Date.now() });
    });
  }, [tab, selected, selectedRunning, cleanupNonce, cleanupCache]);
  // Guest diagnostics poll only while the Machine page is visible; the ssh round trip is cheap
  // but the kernel-log scan is not free.
  useEffect(() => {
    if (tab !== "runtimes" || !selected || !selectedRunning) return;
    void loadDiagnostics(selected);
    const id = setInterval(() => void loadDiagnostics(selected), 15000);
    return () => clearInterval(id);
  }, [tab, selected, selectedRunning]);
  // Live refresh from `docker events` while the window is visible. Same requirements as the
  // container views (`featureGate`), plus a finished tool probe: the gate calls a not-yet-probed
  // machine "ok" to avoid flicker, and a stream cannot start on an unprobed machine.
  // containerd profiles are excluded on purpose — nerdctl's stream cannot replay a reconnect.
  const streamReady = !!tools
    && featureGate("containers", tools, selectedRunning, status?.runtime).ok
    && (status?.runtime ?? "docker") !== "containerd";
  useEffect(() => {
    const apply = () => {
      if (streamReady && document.visibilityState === "visible") {
        void startEventStream(() => refreshRef.current());
      } else {
        stopEventStream();
      }
    };
    apply();
    document.addEventListener("visibilitychange", apply);
    return () => { document.removeEventListener("visibilitychange", apply); stopEventStream(); };
  }, [streamReady, selected]);
  // One gate for the sidebar, the blocked panel and tab bodies.
  const gateFor = (item: NavItem) => featureGate(item.feature, tools, selectedRunning, status?.runtime);
  const visibleNav = NAV.filter((n) => !hiddenSections[n.group] && !gateFor(n).missing);
  const visibleNavRef = useRef(visibleNav);
  visibleNavRef.current = visibleNav;
  const blocked: ToolKey | null = gateFor(NAV.find((n) => n.id === tab) ?? NAV[0]).missing;
  /** The tool exists but its daemon is closed. The screens keep their nav item (start the
   *  profile and they fill in), yet they must not render an empty table that claims the
   *  engine has nothing — nothing was read at all. */
  const awaitingDaemon = !blocked && gateFor(NAV.find((n) => n.id === tab) ?? NAV[0]).needsDaemon;
  /** Podman's daemon is a machine, not the Colima profile: its four data tabs are closed
   *  while no machine runs, exactly like Docker's lists with the profile stopped. */
  const podmanUp = podmanMachines.some((m) => m.running);
  const awaitingPodman = tab.startsWith("podman-") && tab !== "podman-machines" && !podmanUp;
  const shownTab = blocked ? "__blocked" : awaitingDaemon ? "__waiting" : awaitingPodman ? "__podman-waiting" : tab;
  const headerTitle = tab === "settings"
    ? "Settings"
    : tab.startsWith("podman-") ? `Podman ${title}`
    : ["containers", "images", "volumes", "networks"].includes(tab) ? `Docker ${title}`
    : title;
  const pageFilter = PAGE_SEARCH[shownTab];
  /** One index for the header's global scope; rebuilt when objects or tags change. */
  const globalIndex = useMemo(() => buildGlobalIndex({
    profiles, containers, images, volumes, networks,
    podman: { machines: podmanMachines, containers: podmanContainers, images: podmanImages, volumes: podmanVolumes, networks: podmanNetworks },
    tabs: NAV.filter((n) => !hiddenSections[n.group] && !featureGate(n.feature, tools, selectedRunning, status?.runtime).missing).map(({ id, label }) => ({ id, label })),
  }), [profiles, containers, images, volumes, networks, podmanMachines, podmanContainers, podmanImages, podmanVolumes, podmanNetworks, hiddenSections, tools, selectedRunning, status?.runtime, tagTick]);
  // Hidden cards leave the grid entirely; the editor parks them above it as previews.
  const visibleWidgets = order.filter((k) => widgets[k]);
  const hiddenWidgets = order.filter((k) => !widgets[k]);
  /** One context shape for the grid and the parked-card previews. */
  const dashCtx = (visible: (key: WidgetKey) => boolean): DashboardContext => ({
    profiles, status, version, counts, disk, podmanDisk, containers, images, volumes, networks, compose,
    limaVms, podmanMachines, podmanContainers, podmanImages, podmanVolumes, podmanNetworks,
    tools, running, selected, chooseProfile, visible, openContainers,
    countsRead, listsFailed, profilesRead,
    startSelectedOrCreate: () => {
      if (profiles.length === 0) { openCreate(); return; }
      void act(() => invoke("start_cmd", { opts: { profile: selected } }));
    },
    openSubject, openSettings,
    setTab: (next) => go({ tab: next, trail: [], search: "", networkScope: null }),
  });
  const [dragSpans, setDragSpans] = useState<Partial<Record<WidgetKey, number>> | null>(null);
  const gridCols = useGridColumns();
  const widgetSpans = useMemo(() => computeWidgetSpans(visibleWidgets, gridCols, spanOverrides), [order, widgets, editing, gridCols, spanOverrides]);
  /** Edit-mode width control: auto → half → full → auto. */
  function cycleSpan(key: WidgetKey) {
    const options: (number | undefined)[] = [undefined, Math.max(1, Math.floor(gridCols / 2)), gridCols];
    const index = options.findIndex((o) => o === spanOverrides[key]);
    const next = options[(index + 1) % options.length];
    setSpanOverrides((prev) => {
      const copy = { ...prev };
      if (next === undefined) delete copy[key];
      else copy[key] = next;
      return copy;
    });
  }
  const widgetSpansRef = useRef(widgetSpans);
  widgetSpansRef.current = widgetSpans;
  /** A parked card dropped at `dropIndex` changes every width after it, so the gap and
   *  the cards around it preview the real post-drop layout, not a fixed placeholder. */
  const previewSpans = dropIndex !== null && dragKey
    ? computeWidgetSpans(
      [...visibleWidgets.slice(0, dropIndex), dragKey, ...visibleWidgets.slice(dropIndex)],
      gridCols,
      spanOverrides,
    )
    : null;
  const dropSpan = (dragKey ? previewSpans?.[dragKey] ?? DASHBOARD_WIDGETS.find((x) => x.key === dragKey)?.span : undefined) ?? 2;
  const dropWidget = dragKey ? DASHBOARD_WIDGETS.find((w) => w.key === dragKey) : undefined;

  // Guest health, derived once per render so the panel and the report copy agree.
  const memUsed = diag?.ok ? Math.max(0, diag.mem_total - diag.mem_available) : 0;
  const memPct = diag?.ok && diag.mem_total ? Math.round((memUsed / diag.mem_total) * 100) : 0;
  // Guest usage is not the host cost: the VM holds its whole configured allocation.
  const vmMemGiB = cfg?.memory ?? 0;
  const diskPct = diag?.ok && diag.root_total ? Math.round((diag.root_used / diag.root_total) * 100) : 0;
  const inodePct = diag?.ok && diag.inodes_total ? Math.round((diag.inodes_used / diag.inodes_total) * 100) : 0;
  const loadOver = !!diag?.ok && diag.cpus > 0 && diag.load1 > diag.cpus * 1.5;
  const diagIssues: string[] = [];
  if (diag?.ok) {
    if (!diag.docker_active) diagIssues.push("Docker daemon is not running");
    if (cfg?.rosetta && !diag.rosetta_active) diagIssues.push("Rosetta is configured but not active in the guest");
    if (diag.oom_kills > 0) diagIssues.push(`${diag.oom_kills} OOM kill${diag.oom_kills === 1 ? "" : "s"} in the recent kernel log`);
    if (memPct >= 90) diagIssues.push(`memory at ${memPct}%`);
    if (diskPct >= 85) diagIssues.push(`disk at ${diskPct}%`);
    if (inodePct >= 90) diagIssues.push(`inodes at ${inodePct}%`);
    if (loadOver) diagIssues.push(`load ${diag.load1.toFixed(2)} over ${diag.cpus} vCPU`);
  }
  const diagTone = !selectedRunning ? "stopped" : !diag ? "pending" : !diag.ok ? "error" : diagIssues.length ? "attention" : "ok";
  const diagLabel = { stopped: "Stopped", pending: "Reading…", error: "Unavailable", attention: "Attention", ok: "Healthy" }[diagTone];

  async function copyDiagnostics() {
    if (!diag?.ok) return;
    const report = [
      `Colima VM diagnostics — profile ${selected}`,
      `kernel    ${diag.kernel}`,
      `uptime    ${fmtUptime(diag.uptime_seconds)} · ${diag.cpus} vCPU`,
      `load      ${diag.load1.toFixed(2)} ${diag.load5.toFixed(2)} ${diag.load15.toFixed(2)}`,
      `memory    ${memPct}% — ${fmtBytes(memUsed)} used of ${fmtBytes(diag.mem_total)} in guest${vmMemGiB ? ` (macOS holds the full ${vmMemGiB} GiB VM allocation)` : ""}`,
      `disk      ${diskPct}% — ${fmtBytes(diag.root_used)} used of ${fmtBytes(diag.root_total)}`,
      `inodes    ${inodePct}% — ${diag.inodes_used} of ${diag.inodes_total}`,
      `swap      ${diag.swap_total ? `${fmtBytes(diag.swap_total - diag.swap_free)} used of ${fmtBytes(diag.swap_total)}` : "off"}`,
      `docker    ${diag.docker_active ? "active" : "inactive"} · ${diag.oom_kills} OOM kills`,
      `rosetta   ${diag.rosetta_active ? "active" : "not registered"}`,
      diagIssues.length ? `issues    ${diagIssues.join("; ")}` : "issues    none",
    ].join("\n");
    if (await copyText(report)) {
      pushNotice({ kind: "success", title: "Diagnostics copied", detail: `${report.split("\n").length} lines on the clipboard.` });
    } else {
      pushNotice({ kind: "error", title: "Could not copy diagnostics", detail: "Clipboard access was denied." });
    }
  }

  function onSearchAction(action: SearchAction) {
    if (action.type === "tab") navTo({ tab: action.tab, trail: [], search: "" });
    else if (action.type === "profile") void chooseProfile(action.name);
    else if (action.type === "podman") navTo({ tab: action.tab, search: action.name });
    else openSubject(action.subject);
  }

  // Page-wide actions live in the header; anything that changes one panel stays there.
  const headerActions: PageAction[] = [];
  if (shownTab === "dashboard") {
    headerActions.push({
      id: "edit",
      icon: <PencilIcon />,
      label: editing ? "Exit layout editing" : "Edit dashboard",
      pressed: editing,
      onClick: () => setEditing((v) => !v),
    });
  }
  // The prune dialog covers volumes too, so the volumes list offers it like its siblings.
  if (shownTab === "containers" || shownTab === "images" || shownTab === "volumes") {
    headerActions.push({ id: "prune", icon: <BroomIcon size={16} />, label: "Prune unused data", disabled: busy, onClick: () => setShowPrune(true) });
  }
  if (shownTab === "networks" || shownTab === "podman-networks") {
    headerActions.push({
      id: "network-view",
      kind: "switch",
      label: "Network view",
      options: [
        { id: "table", icon: <TableIcon />, label: "Table view", pressed: netView === "table", onClick: () => setNetView("table") },
        { id: "map", icon: <MapIcon />, label: "Map view", pressed: netView === "map", onClick: () => setNetView("map") },
      ],
    });
  }
  if (shownTab === "activity") {
    headerActions.push({ id: "containers", icon: <ContainerIcon />, label: "Open Containers", onClick: () => go({ tab: "containers" }) });
  }
  if (shownTab === "runtimes") {
    if (selectedRunning) {
      headerActions.push(
        { id: "stop", icon: <StopIcon />, label: "Stop profile", disabled: busy, onClick: () => void act(() => invoke("stop_cmd", { profile: selected })) },
        { id: "restart", icon: <RestartIcon />, label: "Restart profile", disabled: busy, onClick: () => void act(() => invoke("restart_cmd", { profile: selected })) },
      );
    } else {
      headerActions.push({ id: "start", icon: <PlayIcon />, label: selected ? `Start ${selected}` : "Start profile", disabled: busy || !selected, onClick: () => void act(() => invoke("start_cmd", { opts: { profile: selected } })) });
    }
  }
  /** Sidebar badge: the number behind each list, hidden at zero. Docker and Podman read
   *  the lists already in hand. */
  const navBadge = (id: string): number => {
    switch (id) {
      case "containers": return counts.containers;
      case "images": return counts.images;
      case "volumes": return counts.volumes;
      case "networks": return networks.length;
      // The cluster's share of the Docker list, so a k3s install is never a mystery count.
      case "kubernetes": return containers.filter(isKubernetesContainer).length;
      case "podman-machines": return podmanMachines.length;
      case "podman-containers": return podmanContainers.length;
      case "podman-images": return podmanImages.length;
      case "podman-volumes": return podmanVolumes.length;
      case "podman-networks": return podmanNetworks.length;
      default: return 0;
    }
  };

  /** A table only pins its Actions column when it actually overflows; the class is what
   *  draws the column's edge, so a roomy window shows two vertical lines, not three. */
  useEffect(() => {
    const wraps = [...document.querySelectorAll<HTMLElement>(".table-wrap")];
    if (wraps.length === 0) return;
    const sync = () => { for (const w of wraps) w.classList.toggle("is-x", w.scrollWidth > w.clientWidth + 1); };
    sync();
    const observer = new ResizeObserver(sync);
    for (const w of wraps) observer.observe(w);
    window.addEventListener("resize", sync);
    return () => { observer.disconnect(); window.removeEventListener("resize", sync); };
  }, [tab, shownTab, containers.length, images.length, volumes.length, networks.length]);

  /** Every screen but Settings needs tooling. When the probe finds none, the nav says so
   *  instead of collapsing to an empty column that reads as a rendering bug. */
  const noTooling = tools !== null
    && !NAV_GROUPS.some((g) => g.title !== "System" && g.items.some((n) => !gateFor(n).missing));

  return (
    <div className={`app${sidebarHidden ? " sidebar-hidden" : ""}`}>
      {/* First run owns the window: `inert` takes the shell out of tab order and the
          accessibility tree instead of only covering it with a backdrop. */}
      <div className="main-row" inert={showOnboarding || undefined}>
        <aside className="sidebar">
          {/* The window title bar is an overlay, so this strip is what drags the window
              and what the traffic lights sit on. */}
          <div className="sidebar-grip" data-tauri-drag-region />
          <div className="brand"><img src="/logo.png" className="logo-img" alt="Runtime Desk" /> Runtime Desk</div>
          <div className="side-nav">
            {NAV_GROUPS.filter((group) => group.title !== "System").map((group) => {
              if (hiddenSections[group.title]) return null;
              // A section only appears when its tooling is present.
              const items = group.items.filter((n) => !gateFor(n).missing);
              if (items.length === 0) return null;
              // Name the source: Docker answers from the selected Colima profile, Podman from
              // its own machine. When that source does not exist yet the hint says so instead
              // of leaving a bare header that reads like a local engine.
              const hint = group.hint
                ? group.hint === "profile"
                  ? profiles.length === 0
                    ? { text: "no profile", title: "No Colima profile exists yet" }
                    : { text: selected || "—", title: `Objects in the ${selected} Colima profile` }
                  : (() => {
                      const machine = podmanMachines.find((m) => m.running) ?? podmanMachines[0];
                      if (!machine) return { text: "no machine", title: "No Podman machine is initialised" };
                      return { text: machine.name, title: `Podman machine ${machine.name}${machine.running ? "" : " (stopped)"}` };
                    })()
                : null;
              return (
                <div className="nav-group" key={group.title}>
                  <div className="nav-group-title">
                    <span>{group.title}</span>
                    {hint?.text && <span className="nav-group-hint" title={hint.title}>{hint.text}</span>}
                  </div>
                  {items.map((n) => {
                    const badge = navBadge(n.id);
                    const idx = visibleNav.findIndex((v) => v.id === n.id);
                    const key = idx < 9 ? idx + 1 : idx === visibleNav.length - 1 ? 0 : null;
                    return (
                      <button
                        key={n.id}
                        className={`nav-item ${tab === n.id ? "active" : ""}`}
                        aria-current={tab === n.id ? "page" : undefined}
                        title={key === null ? n.label : `${n.label} (⌘${key})`}
                        onClick={() => navTo({ tab: n.id, search: "" })}
                      >
                        <NavIcon id={n.id} />
                        <span>{n.label}</span>
                        {badge > 0 && <span className="badge">{badge}</span>}
                      </button>
                    );
                  })}
                </div>
              );
            })}
            {noTooling && (
              <div className="nav-empty">
                <div className="nav-empty-title">No container tooling found</div>
                <p>
                  Runtime Desk reads <code>colima</code>, <code>docker</code>, <code>podman</code> and
                  <code> kubectl</code> from your PATH. Nothing answered, so there is nothing to show.
                </p>
                <button className="nav-empty-action" onClick={() => openSettings("general")}>What it needs</button>
              </div>
            )}
          </div>
          {/* Settings is an app-level destination, not a peer of Docker or Podman: it sits
              below the scrolling nav, above the profile switcher, with no group heading of
              its own to make a one-row section. */}
          <div className="side-foot">
            <button
              className={`nav-item side-settings ${tab === "settings" ? "active" : ""}`}
              aria-current={tab === "settings" ? "page" : undefined}
              title="Settings (⌘,)"
              onClick={() => navTo({ tab: "settings", search: "" })}
            >
              <GearIcon size={16} />
              <span>Settings</span>
            </button>
          </div>
          <div className="side-profiles">
            <div className="side-section-title">Profiles</div>
            <div className="side-profile-list">
              {profiles.length === 0 && <div className="side-empty">{profilesRead ? "No profiles yet" : "Reading profiles…"}</div>}
              {profiles.map((p) => {
                const running = p.status.toLowerCase() === "running";
                return (
                  <div key={p.name} className={`side-profile ${selected === p.name ? "active" : ""}`}>
                    <button className="side-profile-main" onClick={() => chooseProfile(p.name)} title={`${p.name} · ${p.status}`}>
                      <span className={`side-dot ${running ? "on" : "off"}`} />
                      <span className="side-profile-name">{p.name}</span>
                    </button>
                    <RowMenu label={`${p.name} actions`}>
                      {(close) => (
                        <>
                          <button className="menu-item" disabled={busy || running} onClick={() => { close(); act(() => invoke("start_cmd", { opts: { profile: p.name } })); }}>Start</button>
                          <button className="menu-item" disabled={busy || !running} onClick={() => { close(); act(() => invoke("stop_cmd", { profile: p.name })); }}>Stop</button>
                          <button className="menu-item" disabled={busy || !running} onClick={() => { close(); act(() => invoke("restart_cmd", { profile: p.name })); }}>Restart</button>
                          <div className="menu-sep" />
                          {/* One delete surface: this opens the typed confirmation, which also
                              enforces "stop the profile first" and deletes the disk. */}
                          <button className="menu-item danger" disabled={busy} onClick={() => { close(); chooseProfile(p.name); setDeleteConfirm(""); setShowDelete(true); }}>Delete profile…</button>
                        </>
                      )}
                    </RowMenu>
                  </div>
                );
              })}
            </div>
            <button className="btn ghost side-create" onClick={openCreate}>+ Create new profile</button>
          </div>
        </aside>
        <div className="content">
          {(busy || refreshing) && <div className="busy-bar" />}
          {/* Back appears only after a drill-down: a row's Investigator, a dashboard
              card's filtered list, a network's members. Roots render no slot at all,
              so the title sits on the content gutter and aligns with the toolbar and
              tables below it. Sherlock is a drill-down too, and its back lives here:
              the page body scrolls, so a control inside it would scroll away. */}
          <PageHeader
            key={shownTab}
            title={headerTitle}
            back={backTarget ? { label: backLabel, onClick: goBack } : undefined}
            page={pageFilter ? { value: search, onChange: setSearch, placeholder: pageFilter.placeholder, label: pageFilter.label } : undefined}
            defaultScope={tab === "dashboard" ? "global" : undefined}
            index={globalIndex}
            onSearchAction={onSearchAction}
            actions={headerActions}
            onRefresh={() => void pageRefresh()}
            refreshing={busy || refreshing || pageRefreshing || (tab === "cleanup" && cleanupLoading)}
          />
          {/* Only the page body scrolls, so the header and its actions stay put. */}
          <div className={`page-scroll ${["dashboard","containers","images","volumes","networks"].includes(tab) || tab.startsWith("podman-") ? "" : "scroll"}${tab === "settings" ? " page-settings" : ""}`}>
          <Notices notices={notices} onDismiss={(id) => setNotices((list) => list.filter((n) => n.id !== id))} />

          {shownTab === "__waiting" && (
            <div className="panel prereq-panel">
              <h3>{profiles.length === 0 ? "No Colima profile yet" : `The ${selected} profile is not running`}</h3>
              <p className="muted">
                {profiles.length === 0
                  ? "Every Docker list reads one profile's own socket, so there is nothing to read until a profile exists. Nothing was queried, which is why the lists are empty."
                  : `Containers, images, volumes and networks are read from this profile's socket while it runs. Nothing was queried, which is why the lists are empty.`}
              </p>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                {profiles.length === 0 ? (
                  <button className="btn primary" onClick={openCreate}>New profile…</button>
                ) : (
                  <button className="btn primary" disabled={busy} onClick={() => void act(() => invoke("start_cmd", { opts: { profile: selected } }))}>Start profile</button>
                )}
                <button className="btn ghost" onClick={() => void refresh()}>Recheck</button>
              </div>
            </div>
          )}

          {shownTab === "__podman-waiting" && (
            <div className="panel prereq-panel">
              <h3>{podmanMachines.length === 0 ? "No Podman machine yet" : "No Podman machine is running"}</h3>
              <p className="muted">
                Podman answers from its own virtual machine. {podmanMachines.length === 0
                  ? "One has to exist before its containers can be listed."
                  : "Start the machine to read containers, images, volumes and networks."} Nothing was queried.
              </p>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button className="btn primary" onClick={() => navTo({ tab: "podman-machines", search: "" })}>Open Machines</button>
                <button className="btn ghost" onClick={() => void refresh()}>Recheck</button>
              </div>
            </div>
          )}

          {shownTab === "__blocked" && blocked && (
            <div className="panel prereq-panel">
              <h3>{TOOLS[blocked].label} is not installed</h3>
              <p className="muted">{TOOLS[blocked].why}</p>
              <pre className="logs">{TOOLS[blocked].install}</pre>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button className="btn primary" onClick={() => void refresh()}>Recheck</button>
                <button className="btn ghost" onClick={() => go({ tab: "settings" })}>Open settings</button>
              </div>
            </div>
          )}

          {shownTab === "sherlock" && (
            <InvestigatorPage
              subject={subject}
              containers={subject?.runtime === "podman"
                ? podmanContainers.map((c) => ({ id: c.id, mounts: "", name: c.name, image: c.image, status: c.status, ports: c.ports, created_at: c.created_at, state: c.state, compose_project: "" }))
                : containers}
              images={subject?.runtime === "podman"
                ? podmanImages.map((i) => ({ id: i.id, repository: i.repository, tag: i.tag, size: fmtSize(i.size), created: fmtDateTime(i.created_at) }))
                : images}
              volumes={subject?.runtime === "podman"
                ? podmanVolumes.map((v) => ({ name: v.name, driver: v.driver, mountpoint: v.mountpoint }))
                : volumes}
              networks={subject?.runtime === "podman"
                ? podmanNetworks.map((n) => ({ name: n.name, driver: n.driver, scope: "local" }))
                : networks}
              netMap={netMap}
              daemonUp={selectedRunning}
              profile={selected}
              refreshNonce={subjectNonce}
              vmMemory={profiles.find((p) => p.name === selected)?.memory ?? 0}
              imageArch={imageArch}
              imageDigest={imageDigest}
              volSizes={volSizes}
              onPick={openSubject}
              onNavigate={navigateSubject}
              onOpenContainers={(search) => {
                // Land on a table that can show the row: an armed Compose/Kubernetes chip or a
                // network scope from the previous visit would filter it away.
                setContainerFilter("all");
                go({ tab: subject?.runtime === "podman" ? "podman-containers" : "containers", trail: [], search: search ?? "", networkScope: null });
              }}
              onOpenNetwork={(network, names) => subject?.runtime === "podman" ? go({ tab: "podman-networks", trail: [], search: network }) : go({ tab: "containers", trail: [], search: "", networkScope: { network, names } })}
              onOpenLogs={(c) => setLogTarget({ id: c.id, name: c.name, runtime: subject?.runtime })}
              onSetMemoryLimit={setLimitTarget}
              onContainerAction={(id, action) => {
                // A restart must re-read the member's inspect, or the row keeps the old exit
                // status and image id until the page is reopened.
                void act(() => invoke("container_action_cmd", { id, action }),
                  action === "start" ? "Container started" : action === "stop" ? "Container stopped" : "Container restarted")
                  .then(() => setSubjectNonce((n) => n + 1));
              }}
            />
          )}

          {shownTab === "dashboard" && (
            <div className="dashboard">
              {editing && (
                <div className="edit-bar">
                  <span className="edit-bar-title">Edit dashboard</span>
                  <span className="muted">Drag to reorder. Drop a card above the grid to park it; drag a parked card back to the grid to show it.</span>
                  <button className="btn ghost" style={{ marginLeft: "auto" }} onClick={() => { captureLayout(); setOrder([...WIDGET_KEYS]); setWidgets({ ...DEFAULT_WIDGETS }); setSpanOverrides({}); }}>Reset layout</button>
                  <button className="btn primary" onClick={() => setEditing(false)}>Done</button>
                </div>
              )}
              {editing && (
                <section
                  className={`dash-tray ${dropZone === "tray" ? "drop-target" : ""}`}
                  aria-label="Hidden cards"
                >
                  <div className="dash-tray-head">
                    <span className="edit-bar-title">Hidden cards</span>
                    {hiddenWidgets.length > 0
                      ? <span className="dash-tray-count">{hiddenWidgets.length}</span>
                      : <span className="dash-tray-hint">Drag a card here to hide it.</span>}
                  </div>
                  {hiddenWidgets.length > 0 && (
                    <div className="dash-tray-row">
                      {hiddenWidgets.map((k) => {
                        const w = DASHBOARD_WIDGETS.find((x) => x.key === k);
                        if (!w) return null;
                        return (
                          <button
                            key={w.key}
                            data-tray-key={w.key}
                            className={`tray-card ${dragKey === w.key ? "dragging" : ""}`}
                            title={`${w.label} — click or drag to the grid to show it`}
                            aria-label={`Show ${w.label}`}
                            onMouseDown={(e) => startDrag(w.key, e, "tray")}
                            onClick={() => { captureLayout(); setWidgets({ ...widgets, [w.key]: true }); }}
                          >
                            <span className="tray-preview" aria-hidden="true">
                              <span className="tray-surface"><span className="widget-body">{w.render(dashCtx(() => true))}</span></span>
                            </span>
                            <span className="tray-foot">
                              <span className="tray-name">{w.label}</span>
                              <span className="tray-plus" aria-hidden="true">
                                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round"><path d="M12 5v14M5 12h14" /></svg>
                              </span>
                            </span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </section>
              )}
              <div className={`dash-grid ${dropZone === "grid" ? "drop-target" : ""}`}>
                {visibleWidgets.length === 0 && (
                  <div className="dash-empty">Every card is parked above. Drag one back or click it.</div>
                )}
                {visibleWidgets.map((k, i) => {
                  const w = DASHBOARD_WIDGETS.find((x) => x.key === k);
                  if (!w) return null;
                  return (
                    <Fragment key={w.key}>
                    {dropIndex === i && (
                      <div className="dash-drop-slot" style={{ gridColumn: `span ${dropSpan}` }} aria-hidden="true">
                        {dropWidget && (
                          <div className="widget-body dash-drop-slot-content">{dropWidget.render(dashCtx(() => true))}</div>
                        )}
                      </div>
                    )}
                    <div
                      key={w.key}
                      data-widget-key={w.key}
                      className={`dash-widget ${editing ? "editing" : ""} ${dragKey === w.key ? "dragging" : ""}`}
                      style={{ gridColumn: `span ${previewSpans?.[w.key] ?? (dragSpans ?? widgetSpans)[w.key] ?? w.span}` }}
                      onMouseDown={(e) => startDrag(w.key, e)}
                    >
                      {editing && (
                        <button
                          className={`span-btn ${spanOverrides[w.key] ? "fixed" : ""}`}
                          aria-label={`Card width: ${spanOverrides[w.key] ? `${spanOverrides[w.key]} of ${gridCols} columns` : "auto"}. Click to cycle auto, half, full.`}
                          title={spanOverrides[w.key]
                            ? `Width ${spanOverrides[w.key]}/${gridCols} — click for ${spanOverrides[w.key] === gridCols ? "auto" : "full"}`
                            : "Width auto — click to fix half width"}
                          onClick={() => cycleSpan(w.key)}
                        >
                          {spanOverrides[w.key] === undefined ? "Auto" : spanOverrides[w.key] === gridCols ? "Full" : "Half"}
                        </button>
                      )}
                      {editing && (
                        <button
                          className="eye-btn"
                          aria-label={`Hide ${w.label}`}
                          title="Hide card — it moves to the hidden row"
                          onClick={() => { captureLayout(); setWidgets({ ...widgets, [w.key]: false }); }}
                        >
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7-10-7-10-7Z" /><circle cx="12" cy="12" r="3" /></svg>
                        </button>
                      )}
                      <div className="widget-body">
                        {w.render(dashCtx((key) => !!widgets[key]))}
                      </div>
                    </div>
                    </Fragment>
                  );
                })}
                {dropIndex === visibleWidgets.length && visibleWidgets.length > 0 && (
                  <div className="dash-drop-slot" style={{ gridColumn: `span ${dropSpan}` }} aria-hidden="true">
                    {dropWidget && (
                      <div className="widget-body dash-drop-slot-content">{dropWidget.render(dashCtx(() => true))}</div>
                    )}
                  </div>
                )}
              </div>
            </div>
          )}

          {shownTab === "activity" && (
            <ActivityPage
              toolOk={!!tools?.docker}
              profileRunning={selectedRunning}
              profile={selected}
              vmMemoryBytes={profiles.find((p) => p.name === selected)?.memory ?? 0}
              onInvestigate={(id) => openSubject({ kind: "container", id })}
            />
          )}

          {shownTab === "cleanup" && (
            <CleanupPage
              report={cleanupCache?.profile === selected ? cleanupCache.report : null}
              loading={cleanupLoading}
              busy={busy}
              profile={selected}
              running={selectedRunning}
              readAt={cleanupCache?.profile === selected ? cleanupCache.at : null}
              onPrune={() => setShowPrune(true)}
              onRescan={() => setCleanupNonce((n) => n + 1)}
              onRemoveImage={(id) => act(() => invoke("image_remove_cmd", { id }), "Image removed")}
              onRemoveVolume={(name) => act(() => invoke("volume_remove_cmd", { name }), "Volume removed")}
              onRemoveContainer={(id) => act(() => invoke("container_action_cmd", { id, action: "remove" }), "Container removed")}
              onInvestigate={(kind, id) => openSubject({ kind, id })}
            />
          )}

          {shownTab === "kubernetes" && (
            <KubernetesPage profile={selected} profileRunning={selectedRunning} refreshNonce={kubeNonce} />
          )}

          {shownTab === "containers" && (
            <>
              <div className="toolbar">
                <div className="chips">
                  {networkScope && (
                    <button className="chip active scope-chip" onClick={() => setNetworkScope(null)} title="Clear network filter">
                      network {networkScope.network}
                      <span className="chip-count">{networkScope.names.length}</span>
                      <span className="scope-clear" aria-hidden="true">×</span>
                    </button>
                  )}
                  {(["all", "compose", "docker", "k8s"] as const)
                    .filter((f) => f === "all" || f === "docker"
                      || (f === "compose" ? !featureGate("compose", tools, true).missing : podCount > 0))
                    .map((f) => (
                      <button key={f} className={`chip ${containerFilter === f ? "active" : ""}`} onClick={() => setContainerFilter(f)}>
                        {f === "all" ? "All" : f === "compose" ? "Compose" : f === "k8s" ? "Kubernetes" : "Docker"}
                        <span className="chip-count">{f === "all" ? containers.length
                          : f === "k8s" ? podCount
                          : f === "compose" ? containers.filter((c) => originOf(c) === "compose").length
                          : containers.filter((c) => originOf(c) === "docker" && !isKubernetesContainer(c)).length}</span>
                      </button>
                    ))}
                </div>
              </div>
              <div className="table-wrap">
                <table className={`table table-containers${showOrigin ? " has-origin" : ""}`}>
                  <colgroup>
                    <col className="col-state" />
                    {showOrigin && <col className="col-origin" />}
                    <col className="col-name" />
                    <col className="col-image" />
                    <col className="col-status" />
                    <col className="col-ports" />
                    <col className="col-actions" />
                  </colgroup>
                  <thead><tr><SortTh table="containers" k="state">State</SortTh>{showOrigin && <th>Origin</th>}<SortTh table="containers" k="name">Name</SortTh><SortTh table="containers" k="image">Image</SortTh><SortTh table="containers" k="status">Status</SortTh><SortTh table="containers" k="ports">Ports</SortTh><th>Actions</th></tr></thead>
                  <tbody>
                    {filteredContainers.length === 0 && <tr><td colSpan={containerCols} className="empty">{emptyRow("containers", networkScope ? "No containers on this network" : undefined)}</td></tr>}
                    {containerGroups.projects.map(({ project, rows }) => {
                      const collapsed = !!collapsedGroups[project];
                      const running = rows.filter((c) => c.state === "running").length;
                      return (
                        <Fragment key={`project:${project}`}>
                          <tr className="group-row compose-group" onClick={() => setCollapsedGroups((prev) => ({ ...prev, [project]: !prev[project] }))} style={{ cursor: "pointer" }}>
                            <td colSpan={containerCols}>
                              <div className="group-row-inner">
                                <Caret open={!collapsed} />
                                <span className="group-name" title={project}>{project}</span>
                                <span className="group-meta">{running} of {rows.length} running</span>
                                <span className="group-actions">
                                  <button
                                    className="icon-btn group-act"
                                    aria-label={`Start all containers in ${project}`}
                                    title={running === rows.length ? "All containers running" : `Start ${rows.length - running} stopped container${rows.length - running === 1 ? "" : "s"}`}
                                    disabled={busy || running === rows.length}
                                    onClick={(e) => { e.stopPropagation(); groupAction(project, rows, "start"); }}
                                  ><PlayIcon size={14} /></button>
                                  <button
                                    className="icon-btn group-act"
                                    aria-label={`Stop all containers in ${project}`}
                                    title={running === 0 ? "No running containers" : `Stop ${running} running container${running === 1 ? "" : "s"}`}
                                    disabled={busy || running === 0}
                                    onClick={(e) => { e.stopPropagation(); groupAction(project, rows, "stop"); }}
                                  ><StopIcon size={14} /></button>
                                </span>
                              </div>
                            </td>
                          </tr>
                          {!collapsed && rows.map(containerRow)}
                        </Fragment>
                      );
                    })}
                    {containerGroups.projects.length > 0 && containerGroups.standalone.length > 0 && (
                      <tr className="group-row compose-group"><td colSpan={containerCols}><span className="group-name">No project</span><span className="group-meta">{containerGroups.standalone.length} container{containerGroups.standalone.length === 1 ? "" : "s"}</span></td></tr>
                    )}
                    {containerGroups.standalone.map(containerRow)}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {shownTab === "images" && (
            <>
              <div className="toolbar list-toolbar">
                <div className="chips" role="group" aria-label="Image filter">
                  {(["all", "unused"] as const).map((f) => (
                    <button key={f} className={`chip ${imageFilter === f ? "active" : ""}`} onClick={() => setImageFilter(f)}>
                      {f === "all" ? "All" : "Unused"}
                      <span className="chip-count">{f === "all" ? images.length : images.filter((i) => !imageUsed(i)).length}</span>
                    </button>
                  ))}
                </div>
                <button className="btn ghost" disabled={busy} onClick={() => setPullRef("")}>Pull image…</button>
                <span className="muted list-hint">An unused image is not referenced by any container; it is still on disk until pruned.</span>
              </div>
              <div className="table-wrap">
                <table className="table table-images has-arch">
                  <colgroup>
                    <col className="col-id" />
                    <col className="col-repository" />
                    <col className="col-tag" />
                    <col className="col-arch" />
                    <col className="col-size" />
                    <col className="col-created" />
                    <col className="col-used" />
                    <col className="col-actions" />
                  </colgroup>
                  <thead><tr><SortTh table="images" k="id">ID</SortTh><SortTh table="images" k="repository">Repository</SortTh><SortTh table="images" k="tag">Tag</SortTh><SortTh table="images" k="arch">Arch</SortTh><SortTh table="images" k="size">Size</SortTh><SortTh table="images" k="created">Created</SortTh><th>Used by</th><th>Actions</th></tr></thead>
                  <tbody>
                    {filteredImages.length === 0 && <tr><td colSpan={8} className="empty">{emptyRow("images")}</td></tr>}
                    {filteredImages.map((i) => {
                      const used = containersUsingImage(i);
                      const arch = imageArchInfo(i);
                      return (
                      <Fragment key={`${i.id}-${i.repository}-${i.tag}`}>
                      <tr onClick={(e) => { if ((e.target as Element).closest("button")) return; toggleRow(`${i.id}-${i.tag}`); }} style={{ cursor: "pointer" }}>
                        <td className="cell-id" title={i.id}>{i.id}</td><td style={{ fontWeight: 600 }} title={i.repository}><Caret open={expandedRow === `${i.id}-${i.tag}`} />{i.repository}</td><td>{i.tag}</td>
                        <td>{arch ? <span className={`arch-chip ${arch.tone}`} title={arch.title}>{arch.label}</span> : <span className="muted">—</span>}</td>
                        <td>{parseHumanBytes(i.size) ? fmtSize(parseHumanBytes(i.size)) : i.size}</td><td style={{ color: "var(--muted)" }}>{i.created}</td>
                        <td>
                          {used.length === 0 ? <span className="muted">—</span> : (
                            <button className="icon-btn" title={`Used by ${used.map((c) => c.name).join(", ")}`} onClick={() => openSubject({ kind: "image", id: i.id })}>
                              {used.length} container{used.length === 1 ? "" : "s"}
                            </button>
                          )}
                        </td>
                        <td><div className="actions"><button className="icon-btn" title="Investigate" aria-label="Investigate" onClick={() => openSubject({ kind: "image", id: i.id })}><NavIcon id="sherlock" /></button><ConfirmButton label="Remove image" icon={<TrashIcon size={14} />} disabled={busy || listsFailed || used.length > 0} title={listsFailed ? "The container list did not answer, so its users are unknown" : used.length > 0 ? "Image is used by a container" : "Remove image"} onConfirm={() => act(() => invoke("image_remove_cmd", { id: i.id }), "Image removed")} /></div></td>
                      </tr>
                      {expandedRow === `${i.id}-${i.tag}` && (
                        <tr className="detail-row">
                          <td colSpan={8}>
                            <div className="row-detail">
                              <div className="detail-grid">
                                <div className="detail-item"><span>Image ID</span><code>{i.id}</code></div>
                                <div className="detail-item"><span>Repository</span><code>{i.repository}</code></div>
                                <div className="detail-item"><span>Tag</span><div>{i.tag}</div></div>
                                <div className="detail-item"><span>Architecture</span><div>{arch ? <span className={`arch-chip ${arch.tone}`} title={arch.title}>{arch.label}</span> : "—"}</div></div>
                                <div className="detail-item"><span>Size</span><div>{i.size}</div></div>
                                <div className="detail-item"><span>Created</span><div>{i.created}</div></div>
                              </div>
                              <div className="detail-actions">
                                <button className="icon-plain" aria-label="Copy reference" title="Copy reference" onClick={() => navigator.clipboard?.writeText(`${i.repository}:${i.tag}`)}><CopyIcon /></button>
                                <button className="icon-plain" aria-label="Inspect JSON" title="Inspect JSON" onClick={() => loadInspect("image", `${i.repository}:${i.tag}`, i.id)}><BracesIcon /></button>
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                      </Fragment>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {shownTab === "volumes" && (
            <>
              <div className="toolbar list-toolbar">
                <div className="chips" role="group" aria-label="Volume filter">
                  {(["all", "unused"] as const).map((f) => (
                    <button key={f} className={`chip ${volumeFilter === f ? "active" : ""}`} onClick={() => setVolumeFilter(f)}>
                      {f === "all" ? "All" : "Unused"}
                      <span className="chip-count">{f === "all" ? volumes.length : volumes.filter((v) => containersUsingVolume(v).length === 0).length}</span>
                    </button>
                  ))}
                </div>
                <span className="muted list-hint">An unused volume is mounted by no container. Its data is only freed by removing it.</span>
              </div>
              <VolumeTreemap items={volSizes} loading={volSizesLoading} highlight={hoverVolume} onOpen={(name) => openSubject({ kind: "volume", id: name })} />
              <div className="table-wrap">
                <table className="table table-volumes">
                  <colgroup>
                    <col className="col-name" />
                    <col className="col-size" />
                    <col className="col-driver" />
                    <col className="col-mountpoint" />
                    <col className="col-used" />
                    <col className="col-actions" />
                  </colgroup>
                  <thead><tr><SortTh table="volumes" k="name">Name</SortTh><SortTh table="volumes" k="size">Size</SortTh><SortTh table="volumes" k="driver">Driver</SortTh><SortTh table="volumes" k="mountpoint">Mountpoint</SortTh><th>Used by</th><th>Actions</th></tr></thead>
                  <tbody>
                    {filteredVolumes.length === 0 && <tr><td colSpan={6} className="empty">{emptyRow("volumes")}</td></tr>}
                    {filteredVolumes.map((v) => {
                      const used = containersUsingVolume(v);
                      const size = volSizeByName.get(v.name);
                      return (
                      <tr key={v.name} onMouseEnter={() => setHoverVolume(v.name)} onMouseLeave={() => setHoverVolume(null)}>
                        <td style={{ fontWeight: 600 }} title={v.name}>{v.name}</td>
                        <td style={{ fontFamily: "JetBrains Mono, monospace", fontSize: 11 }}>{size === undefined ? "—" : fmtSize(size)}</td><td>{v.driver}</td><td style={{ color: "var(--muted)", fontFamily: "JetBrains Mono, monospace", fontSize: 11 }}>{v.mountpoint}</td>
                        <td>
                          {used.length === 0 ? <span className="muted">—</span> : (
                            <button className="icon-btn" title={`Mounted by ${used.map((c) => c.name).join(", ")}`} onClick={() => openSubject({ kind: "volume", id: v.name })}>
                              {used.length} container{used.length === 1 ? "" : "s"}
                            </button>
                          )}
                        </td>
                        <td><div className="actions"><button className="icon-btn" title="Investigate" aria-label="Investigate" onClick={() => openSubject({ kind: "volume", id: v.name })}><NavIcon id="sherlock" /></button><ConfirmButton label="Remove volume" icon={<TrashIcon size={14} />} disabled={busy || listsFailed || used.length > 0} title={listsFailed ? "The container list did not answer, so its mounts are unknown" : used.length > 0 ? "Volume is in use" : "Remove volume"} onConfirm={() => act(() => invoke("volume_remove_cmd", { name: v.name }), "Volume removed")} /></div></td>
                      </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </>
          )}

          {shownTab === "networks" && (
            <>
              <div className="toolbar list-toolbar">
                <div className="chips" role="group" aria-label="Network filter">
                  {(["all", "user"] as const).map((f) => (
                    <button key={f} className={`chip ${networkFilter === f ? "active" : ""}`} onClick={() => setNetworkFilter(f)}>
                      {f === "all" ? "All" : "User-defined"}
                      <span className="chip-count">{f === "all" ? netSource.length : netSource.filter((n) => !(n.name in BUILTIN_NETWORKS)).length}</span>
                    </button>
                  ))}
                </div>
                <span className="muted list-hint">Built-in networks cannot be removed; user-defined ones can.</span>
              </div>
              {netView === "map" ? (
                <div className="panel network-map-panel">
                  <div className="section-head">
                    <div>
                      <h3>Network map</h3>
                      <p className="muted">Which containers sit on which network.</p>
                    </div>
                  </div>
                  <NetworkGraph
                    entries={netMap}
                    meta={Object.fromEntries(containers.map((c) => [c.name, { ports: c.ports, state: c.state }]))}
                    onSelectContainer={(name) => go({ tab: "containers", networkScope: null, search: name })}
                    onSelectNetwork={(network, names) => go({ tab: "containers", search: "", networkScope: { network, names } })}
                  />
                </div>
              ) : (
              <div className="table-wrap">
                <table className="table table-networks">
                  <colgroup>
                    <col className="col-name" />
                    <col className="col-containers" />
                    <col className="col-driver" />
                    <col className="col-subnet" />
                    <col className="col-actions" />
                  </colgroup>
                  <thead><tr><SortTh table="networks" k="name">Name</SortTh><SortTh table="networks" k="containers">Containers</SortTh><SortTh table="networks" k="driver">Driver</SortTh><SortTh table="networks" k="subnet">Subnet</SortTh><th>Actions</th></tr></thead>
                  <tbody>
                    {netRows.length === 0 && <tr><td colSpan={5} className="empty">{emptyRow("networks")}</td></tr>}
                    {netRows.map((group) => (
                      <Fragment key={group.title}>
                        <tr className="group-row"><td colSpan={5}>{group.title}</td></tr>
                        {group.rows.map((n) => {
                          const builtin = n.name in BUILTIN_NETWORKS;
                          const rowKey = `net:${n.name}`;
                          const map = netMap.find((m) => m.name === n.name);
                          const containers = map?.containers ?? [];
                          return (
                            <Fragment key={n.name}>
                              <tr onClick={(e) => { if ((e.target as Element).closest("button")) return; toggleRow(rowKey); }} style={{ cursor: "pointer" }}>
                                <td style={{ fontWeight: 600 }} title={n.name}><Caret open={expandedRow === rowKey} />{n.name}</td>
                                <td>{!map ? <span className="muted">—</span> : containers.length > 0 ? `${containers.length}` : <span className="muted">none</span>}</td>
                                <td>{n.driver}</td>
                                <td style={{ color: "var(--muted)", fontFamily: "JetBrains Mono, monospace", fontSize: 11 }}>{map?.subnet || "—"}</td>
                                <td><div className="actions"><button className="icon-btn" title="Investigate" aria-label="Investigate" onClick={() => openSubject({ kind: "network", id: n.name })}><NavIcon id="sherlock" /></button><ConfirmButton label="Remove network" icon={<TrashIcon size={14} />} disabled={busy || builtin} title={builtin ? "Built-in networks cannot be removed" : "Remove network"} onConfirm={() => act(() => invoke("network_remove_cmd", { name: n.name }), "Network removed")} /></div></td>
                              </tr>
                              {expandedRow === rowKey && (
                                <tr className="detail-row">
                                  <td colSpan={5}>
                                    <div className="row-detail">
                                      <div className="detail-grid">
                                        <div className="detail-item"><span>Name</span><code>{n.name}</code></div>
                                        <div className="detail-item"><span>Network ID</span><code>{map?.id || "—"}</code></div>
                                        <div className="detail-item"><span>Driver · scope</span><div>{n.driver} · {n.scope}</div></div>
                                        <div className="detail-item"><span>Subnet</span><code>{map?.subnet || "—"}</code></div>
                                        <div className="detail-item"><span>Gateway</span><code>{map?.gateway || "—"}</code></div>
                                        <div className="detail-item"><span>Internal</span><div>{map?.internal ? "yes" : "no"}</div></div>
                                      </div>
                                      <div className="net-containers">
                                        {!map ? (
                                          <p className="muted">Membership was not read — the network map did not answer.</p>
                                        ) : containers.length === 0 ? (
                                          <p className="muted">No containers attached.</p>
                                        ) : (
                                          <table className="table">
                                            <thead><tr><th>Container</th><th>IPv4</th><th>MAC</th></tr></thead>
                                            <tbody>
                                              {containers.map((c) => (
                                                <tr key={c.name}>
                                                  <td style={{ fontWeight: 600 }}>{isKubernetesName(c.name) && <span className="k8s-chip" title="Created by the profile's Kubernetes cluster, not by you">k8s</span>}{c.name}</td>
                                                  <td><code>{c.ip || "—"}</code></td>
                                                  <td><code>{c.mac || "—"}</code></td>
                                                </tr>
                                              ))}
                                            </tbody>
                                          </table>
                                        )}
                                      </div>
                                      <div className="detail-actions">
                                        <button className="icon-plain" aria-label="Copy name" title="Copy name" onClick={() => navigator.clipboard?.writeText(n.name)}><CopyIcon /></button>
                                        <button className="icon-plain" aria-label="Inspect JSON" title="Inspect JSON" onClick={() => loadInspect("network", n.name, n.name)}><BracesIcon /></button>
                                      </div>
                                            </div>
                                  </td>
                                </tr>
                              )}
                            </Fragment>
                          );
                        })}
                      </Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
              )}
            </>
          )}

          {shownTab === "ai" && (
            <div className="machine-page">
              <section className="panel">
                <div className="section-head ai-head">
                  <h3>Run a model</h3>
                  <div className="chips">
                    <span className={`prereq ${prereqs.arm ? "ok" : "bad"}`}>Apple Silicon</span>
                    <span className={`prereq ${prereqs.krunkit ? "ok" : "bad"}`}>krunkit VM</span>
                    <span className={`prereq ${prereqs.docker ? "ok" : "bad"}`}>docker runtime</span>
                    <span className={`prereq ${prereqs.runnerOk ? "ok" : "bad"}`}>{ai.runner} runner</span>
                  </div>
                </div>

                {!prereqs.krunkit && (
                  <div className="ai-need">
                    <p>
                      <strong>AI workloads need krunkit.</strong> This profile runs the <code>{cfg?.vm_type ?? "unknown"}</code> VM type
                      {tools && !tools.krunkit
                        ? ", and the krunkit CLI is not installed. Install it first:"
                        : ". Recreate the profile with the krunkit VM type to run models here."}
                    </p>
                    {tools && !tools.krunkit && (
                      <div className="ai-need-cmd">
                        <code>brew tap slp/krunkit &amp;&amp; brew install krunkit</code>
                        <CopyButton value="brew tap slp/krunkit && brew install krunkit" label="krunkit install command" />
                      </div>
                    )}
                    <div className="ai-need-actions">
                      {aiProfile ? (
                        <button className="btn primary" disabled={busy} onClick={() => {
                          if (aiProfileRunning) { void chooseProfile("ai"); return; }
                          void act(async () => {
                            await invoke("start_cmd", { opts: { profile: "ai" } });
                            await chooseProfile("ai");
                          });
                        }}>{aiProfileRunning ? "Open AI profile" : "Start AI profile"}</button>
                      ) : (
                        <button
                          className="btn primary"
                          disabled={busy || (!!tools && !tools.krunkit)}
                          title={tools && !tools.krunkit ? "Install krunkit first" : "Create a krunkit profile named ai"}
                          onClick={() => void act(async () => {
                            await invoke("start_cmd", { opts: { profile: "ai", cpus: 4, memory: 8, disk: 50, runtime: "docker", vm_type: "krunkit" } });
                            // The new profile is a new daemon: select it through the same path
                            // that repoints the client and reloads, or every docker call keeps
                            // answering from the previous profile's socket.
                            await chooseProfile("ai");
                          })}
                        >Create AI profile</button>
                      )}
                      <span className="muted"><code>ai</code> · 4 CPU · 8 GiB · 50 GiB · krunkit</span>
                    </div>
                  </div>
                )}

                <div className="ai-grid">
                  <div className="field"><label>Registry</label>
                    <Select
                      label="Registry"
                      value={ai.registry}
                      options={[{ value: "docker", label: "Docker AI Registry" }, { value: "hf", label: "HuggingFace" }, { value: "ollama", label: "Ollama (ramalama)" }]}
                      onChange={(v) => setAi({ ...ai, registry: v })}
                    />
                  </div>
                  <div className="field"><label>Runner</label>
                    <Select
                      label="Runner"
                      value={ai.runner}
                      options={[{ value: "docker", label: "docker" }, { value: "ramalama", label: "ramalama" }]}
                      onChange={(v) => setAi({ ...ai, runner: v })}
                    />
                    {ai.registry === "ollama" && ai.runner !== "ramalama" && (
                      <span className="field-hint bad">The Ollama registry needs the ramalama runner.</span>
                    )}
                  </div>
                  <div className="field"><label>Model</label>
                    <input value={ai.name} autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" aria-label="Model name" onChange={(e) => setAi({ ...ai, name: e.target.value })} placeholder="gemma3" />
                    {aiModel !== ai.name && <span className="field-hint">Resolves to <code>{aiModel}</code></span>}
                  </div>
                  <div className="field"><label>Serve port</label>
                    <input type="number" aria-label="Serve port" value={ai.port} onChange={(e) => setAi({ ...ai, port: +e.target.value })} />
                  </div>
                </div>

                <div className="chips ai-suggest">
                  {["gemma3", "llama3.2", "qwen2.5", "phi4", "mistral", "ai/smollm2"].map((m) => (
                    <button key={m} className={`chip ${ai.name === m ? "active" : ""}`} onClick={() => setAi({ ...ai, name: m })}>{m}</button>
                  ))}
                </div>

                <div className="field"><label>Prompt</label>
                  <input value={ai.prompt} autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" aria-label="Prompt" onChange={(e) => setAi({ ...ai, prompt: e.target.value })} placeholder="Leave empty for an interactive chat" />
                </div>

                <div className="ai-actions">
                  <button className="btn primary" disabled={busy || !ai.name} title={`Download ${aiModel} into the profile`}
                    onClick={() => act(() => invoke("model_pull_cmd", { profile: selected, model: aiModel, runner: ai.runner }))}>Pull model</button>
                  <button className="btn ghost" disabled={busy || !ai.name || !prereqs.krunkit} title={`Ask ${aiModel} one prompt and print the answer below`}
                    onClick={async () => { setModelOut(""); setModelOut(await safe(invoke<string>("model_run_cmd", { profile: selected, model: aiModel, prompt: ai.prompt, runner: ai.runner }), "")); }}>Run prompt</button>
                  <button className="btn ghost" disabled={busy || !ai.name || !prereqs.krunkit} title={`Open Terminal on colima model run ${aiModel}`}
                    onClick={() => act(() => invoke("model_chat_cmd", { profile: selected, model: aiModel, runner: ai.runner }))}>Chat in terminal</button>
                  <span className="ai-actions-sep" />
                  <button className="btn" disabled={busy} title={`Prepare the ${ai.runner} runner inside the profile`}
                    onClick={() => act(() => invoke("model_setup_cmd", { profile: selected, runner: ai.runner }))}>Set up runner</button>
                  <button className="btn" disabled={busy} title="List the models already installed in this profile"
                    onClick={async () => { setModels(""); setModels(await safe(invoke<string>("model_list_cmd", { profile: selected }), "")); }}>List models</button>
                </div>
              </section>

              <section className="panel">
                <div className="section-head">
                  <div>
                    <h3>Model server</h3>
                    <p className="muted">
                      {servePid
                        ? <>Colima model serve is running as pid <code>{servePid}</code>.</>
                        : <>Stopped. Serve keeps <code>{aiModel}</code> available on port <code>{ai.port}</code>.</>}
                    </p>
                  </div>
                  <span className={`status-badge ${servePid ? "running" : "stopped"}`}><span className="dot" />{servePid ? "running" : "stopped"}</span>
                </div>
                <div className="ai-actions">
                  {servePid ? (
                    <>
                      <button className="btn ghost" title={`Open http://localhost:${ai.port}`}
                        onClick={() => act(() => invoke("open_url_cmd", { url: `http://localhost:${ai.port}` }))}>Open localhost:{ai.port}</button>
                      <ConfirmButton variant="btn" label="Stop server" confirmLabel="Stop server?" disabled={busy} onConfirm={() => act(() => invoke("model_serve_stop_cmd", { profile: selected }))} />
                    </>
                  ) : (
                    <button className="btn ghost" disabled={busy || !ai.name || !prereqs.krunkit} title={`Keep ${aiModel} served on port ${ai.port}`}
                      onClick={() => act(() => invoke("model_serve_start_cmd", { profile: selected, model: aiModel, runner: ai.runner, port: ai.port }))}>Serve on :{ai.port}</button>
                  )}
                </div>
              </section>

              {(modelOut || models) && (
                <section className="panel">
                  <div className="section-head">
                    <h3>Output</h3>
                    <button className="btn" disabled={busy} onClick={() => { setModelOut(""); setModels(""); }}>Clear</button>
                  </div>
                  <div className="ai-outputs">
                    {modelOut && <pre className="logs">{modelOut}</pre>}
                    {models && <pre className="logs">{models}</pre>}
                  </div>
                </section>
              )}

              <details className="panel ai-guide">
                <summary>Resource guide</summary>
                <table className="table">
                  <thead><tr><th>Model size</th><th>Min RAM</th><th>Recommended</th><th>Examples</th></tr></thead>
                  <tbody>
                    <tr><td>Tiny (1–2B)</td><td>4 GB</td><td>8 GB</td><td>TinyLlama, Gemma 2B</td></tr>
                    <tr><td>Small (3–4B)</td><td>8 GB</td><td>12 GB</td><td>Phi-3 Mini, Gemma 3</td></tr>
                    <tr><td>Medium (7–8B)</td><td>12 GB</td><td>16 GB</td><td>Llama 3.2, Mistral 7B</td></tr>
                    <tr><td>Large (13B+)</td><td>16 GB</td><td>32 GB</td><td>Phi-4, Mixtral</td></tr>
                  </tbody>
                </table>
              </details>
            </div>
          )}

          {shownTab === "runtimes" && profiles.length === 0 && (
            <div className="panel prereq-panel">
              <h3>No Colima profile yet</h3>
              <p className="muted">
                Colima was not found on this machine, or has never created a profile. Every screen that reads
                a VM needs one; nothing was queried.
              </p>
              <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
                <button className="btn primary" onClick={openCreate}>New profile…</button>
                <button className="btn ghost" onClick={() => void refresh()}>Recheck</button>
              </div>
            </div>
          )}

          {shownTab === "runtimes" && profiles.length > 0 && (
            <div className="machine-page">
              <section className="panel diag-panel">
                <div className="section-head">
                  <div>
                    <h3>Diagnostics</h3>
                    <p className="muted">Live health from inside the VM over <code>colima ssh</code>.</p>
                  </div>
                  <div className="linux-actions">
                    <span className={`diag-verdict ${diagTone}`}>{diagLabel}</span>
                  </div>
                </div>
                {!selectedRunning ? (
                  <p className="muted">The VM is stopped. Start the profile to collect load, memory, disk and kernel data.</p>
                ) : !diag?.ok ? (
                  <p className="muted">{diagLoading ? "Reading the guest…" : diag?.error || "Waiting for the first sample…"}</p>
                ) : (
                  <>
                    <div className="strip-items diag-metrics">
                      <div className="strip-item">
                        <span className="strip-label">CPU load</span>
                        <span className={`strip-value${loadOver ? " state-bad" : ""}`}>{diag.load1.toFixed(2)}</span>
                        <span className="strip-sub">{diag.load5.toFixed(2)} · {diag.load15.toFixed(2)} on {diag.cpus} vCPU</span>
                      </div>
                      <div className="strip-item">
                        <span className="strip-label">Memory</span>
                        <span className={`strip-value${memPct >= 90 ? " state-bad" : memPct >= 80 ? " state-warn" : ""}`}>{memPct}%</span>
                        <span className="strip-sub">{fmtBytes(memUsed)} of {fmtBytes(diag.mem_total)} in guest{vmMemGiB ? ` · macOS holds ${vmMemGiB}\u00a0GiB` : ""}</span>
                      </div>
                      <div className="strip-item">
                        <span className="strip-label">Disk</span>
                        <span className={`strip-value${diskPct >= 85 ? " state-bad" : diskPct >= 75 ? " state-warn" : ""}`}>{diskPct}%</span>
                        <span className="strip-sub">{fmtBytes(diag.root_used)} of {fmtBytes(diag.root_total)}</span>
                      </div>
                      <div className="strip-item">
                        <span className="strip-label">Docker</span>
                        <span className={`strip-value${diag.docker_active ? "" : " state-bad"}`}>{diag.docker_active ? "active" : "inactive"}</span>
                        <span className={`strip-sub${diag.oom_kills > 0 ? " state-bad" : ""}`}>{diag.oom_kills} OOM kill{diag.oom_kills === 1 ? "" : "s"}</span>
                      </div>
                    </div>
                    <p className={`diag-summary${diagIssues.length ? " attention" : ""}`}>
                      {diagIssues.length ? diagIssues.join(" · ") : "No pressure signals: load, memory, disk and the Docker daemon are within range."}
                    </p>
                    <div className="diag-meta">
                      <span>kernel {diag.kernel}</span>
                      <span>up {fmtUptime(diag.uptime_seconds)}</span>
                      <span>inodes {inodePct}%</span>
                      <span>swap {diag.swap_total ? `${fmtBytes(diag.swap_total - diag.swap_free)} of ${fmtBytes(diag.swap_total)}` : "off"}</span>
                      <button className="status-btn diag-copy" onClick={() => void copyDiagnostics()}>Copy report</button>
                    </div>
                  </>
                )}
              </section>

            <div className="linux-grid">
              <div className="settings-col">
                <section className="panel">
                  <div className="section-head">
                    <div>
                      <h3>{selected}</h3>
                      <p className="muted">The Linux VM Colima runs underneath every container.</p>
                    </div>
                    <div className="linux-actions">
                      <span className={`status-badge ${selectedRunning ? "running" : "stopped"}`}><span className="dot" />{selectedRunning ? "running" : "stopped"}</span>
                      <button
                        className="btn ghost"
                        disabled={busy}
                        title={selectedRunning ? "Stop the profile first: Colima resizes a VM on start" : "Start the profile with different CPUs, memory or disk"}
                        onClick={() => setResize({
                          cpus: String(status?.cpu ?? cfg?.cpu ?? 2),
                          memory: String(cfg?.memory ?? 2),
                          disk: String(cfg?.disk ?? 60),
                        })}
                      >
                        Resources…
                      </button>
                    </div>
                  </div>
                  <div className="kv"><span>Architecture</span><strong>{status?.arch ?? "—"}</strong></div>
                  <div className="kv"><span>VM type</span><strong>{cfg?.vm_type ?? "—"}</strong></div>
                  <div className="kv"><span>CPUs</span><strong>{status?.cpu ?? cfg?.cpu ?? "—"}</strong></div>
                  <div className="kv"><span>Memory</span><strong>{status?.memory ? fmtBytes(status.memory) : cfg?.memory ? `${cfg.memory} GiB` : "—"}</strong></div>
                  <div className="kv"><span>Disk</span><strong>{status?.disk ? fmtBytes(status.disk) : cfg?.disk ? `${cfg.disk} GiB` : "—"}</strong></div>
                  <div className="kv"><span>Rosetta</span><strong>{cfg ? (cfg.rosetta ? "enabled" : "off") : "—"}{diag?.ok && (diag.rosetta_active || cfg?.rosetta) && (
                    <span
                      className={`arch-chip ${diag.rosetta_active ? "rosetta" : "emulated"}`}
                      title={diag.rosetta_active
                        ? "The guest registered Rosetta's binfmt handler: linux/amd64 binaries run translated"
                        : "The profile asks for Rosetta but the guest never registered it; recreate the VM with Rosetta enabled"}
                    >{diag.rosetta_active ? "active" : "not registered"}</span>
                  )}</strong></div>
                  <div className="kv"><span>Mount type</span><strong>{status?.mount_type ?? cfg?.mount_type ?? "—"} <span className="muted">· create-time</span></strong></div>
                  <div className="kv"><span>Mounts</span><strong>{cfg ? (cfg.mounts.length ? cfg.mounts.map((m) => `${m.location}${m.mount_point ? ` → ${m.mount_point}` : ""} (${m.writable ? "rw" : "ro"})`).join(", ") : "none") : "—"}</strong></div>
                  <div className="kv"><span>Mount inotify</span><strong>{cfg ? (cfg.mount_inotify ? "on" : "off") : "—"}</strong></div>
                  <div className="kv"><span>SSH agent</span><strong>{cfg ? (cfg.ssh_agent ? "forwarded" : "off") : "—"}</strong></div>
                </section>

                <section className="panel">
                  <div className="section-head">
                    <div>
                      <h3>Network</h3>
                      <p className="muted">How the VM reaches this Mac and the LAN.</p>
                    </div>
                    <div className="linux-actions">
                      <button
                        className="btn ghost"
                        disabled={busy || !cfg}
                        title={selectedRunning ? "Stop the profile: networking is applied by colima start" : "Change DNS, the port forwarder and the gateway"}
                        onClick={openNetEdit}
                      >Change…</button>
                      <button
                        className="btn ghost"
                        disabled={busy || !cfg}
                        title="Mode and reachable IP are read only at creation: this destroys and starts the VM"
                        onClick={openRecreate}
                      >Recreate…</button>
                    </div>
                  </div>
                  <div className="kv"><span>Mode</span><strong>{cfg?.network_mode ?? "—"}{cfg?.network_mode === "bridged" ? ` · ${cfg.network_interface}` : ""} <span className="muted">· create-time</span></strong></div>
                  <div className="kv"><span>Reachable IP</span><strong>{cfg?.network_address ? (profiles.find((p) => p.name === selected)?.ip_address || "assigned") : "off"}</strong></div>
                  <div className="kv"><span>Port forwarder</span><strong>{cfg?.port_forwarder ?? "—"}{cfg?.port_forwarder === "grpc" && <span className="arch-chip rosetta" title="grpc forwards UDP as well as TCP; Colima marks it experimental">UDP</span>}{cfg?.port_forwarder === "ssh" && <span className="muted"> · TCP only</span>}</strong></div>
                  <div className="kv"><span>DNS</span><strong>{cfg?.dns.length ? cfg.dns.join(", ") : "host resolver"}</strong></div>
                  <div className="kv"><span>DNS hosts</span><strong>{cfg?.dns_hosts.length ? cfg.dns_hosts.map((h) => `${h.name} → ${h.target}`).join(", ") : "—"}</strong></div>
                  <div className="kv"><span>Gateway</span><strong>{cfg?.gateway_address || "—"}</strong></div>
                </section>

                <section className="panel">
                  <h3>Container runtime</h3>
                  <p className="muted">Each profile runs one container runtime. Switching runtime needs the profile recreated.</p>
                  <div className="kv"><span>Runtime</span><strong>{status?.runtime ?? "—"}</strong></div>
                  <div className="kv"><span>Client</span><strong>{status?.runtime === "containerd" ? "colima nerdctl" : "docker CLI"}</strong></div>
                  <div className="kv"><span>Driver</span><strong>{status?.driver ?? "—"}</strong></div>
                  <div className="kv"><span>Docker socket</span><code>{status?.docker_socket ?? "—"}</code></div>
                  <div className="kv"><span>Containerd socket</span><code>{status?.containerd_socket ?? "—"}</code></div>
                  <div className="settings-actions">
                    {!tools?.nerdctl && (
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        <button className="btn ghost" disabled={busy} onClick={() => act(() => invoke("nerdctl_install_cmd", { profile: selected }))}>Install nerdctl</button>
                        <span className="help" tabIndex={0} data-tip="Installs the nerdctl CLI into your PATH for this profile. Useful only with the containerd runtime: it lets you run nerdctl commands directly (e.g. `nerdctl ps`) instead of typing `colima nerdctl --` each time. Not needed for docker or incus.">?</span>
                      </div>
                    )}
                    <span className={`tool-pill ${tools?.nerdctl ? "on" : "off"}`}><span className="tool-dot" />nerdctl {tools?.nerdctl ? "installed" : "missing"}</span>
                  </div>
                </section>
              </div>

              <div className="settings-col">
                <section className="panel">
                  <div className="section-head">
                    <div>
                      <h3>Linux VMs on this host</h3>
                      <p className="muted">Lima machines other than the Colima profile VMs.</p>
                    </div>
                  </div>
                  {limaVms.length === 0 ? (
                    <p className="muted">{tools?.lima ? "No Lima VMs found." : "limactl is not installed, so no Lima VMs can be listed."}</p>
                  ) : (
                    <table className="table">
                      <thead><tr><th>Name</th><th>Status</th></tr></thead>
                      <tbody>
                        {limaVms.map((vm) => (
                          <tr key={vm.name}>
                            <td style={{ fontWeight: 600 }}>{vm.name}</td>
                            <td><span className={`status-badge ${vm.status.toLowerCase() === "running" ? "running" : "stopped"}`}><span className="dot" />{vm.status || "unknown"}</span></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                </section>
              </div>
            </div>
            </div>
          )}

          {shownTab.startsWith("podman-") && (
            <PodmanPage
              section={shownTab.slice("podman-".length) as "machines" | "containers" | "images" | "volumes" | "networks"}
              search={search}
              refreshNonce={podmanNonce}
              netView={netView}
              machine={podmanMachine}
              allMachines={podmanMachines}
              onMachine={(name) => {
                setPodmanMachine(name);
                void invoke<string>("podman_set_machine_cmd", { name }).then(() => {
                  void readPodman(name);
                  setPodmanNonce((n) => n + 1);
                });
              }}
              onChanged={() => void readPodman()}
              onOpenMachines={() => go({ tab: "podman-machines" })}
              onOpenContainer={(name) => go({ tab: "podman-containers", search: name })}
              onOpenNetwork={(name) => { setNetView("table"); go({ tab: "podman-networks", search: name }); }}
              onInvestigate={(kind, id) => openSubject({ kind, id, runtime: "podman" })}
            />
          )}
          {shownTab === "settings" && (
            <div className="settings">
              <div
                className="settings-tabs"
                role="tablist"
                aria-label="Settings sections"
                onKeyDown={(e) => {
                  if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
                  const tabs = Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('[role="tab"]'));
                  const i = tabs.indexOf(document.activeElement as HTMLButtonElement);
                  if (i < 0) return;
                  e.preventDefault();
                  const next = tabs[(i + (e.key === "ArrowRight" ? 1 : tabs.length - 1)) % tabs.length];
                  next.focus();
                  setSettingsTab(SETTINGS_TABS[tabs.indexOf(next)].id);
                }}
              >
                {SETTINGS_TABS.map(({ id, label, Icon }) => (
                  <button
                    key={id}
                    role="tab"
                    aria-selected={settingsTab === id}
                    aria-controls="settings-panel"
                    tabIndex={settingsTab === id ? 0 : -1}
                    className={`settings-tab ${settingsTab === id ? "active" : ""}`}
                    title={label}
                    onClick={() => setSettingsTab(id)}
                  >
                    <Icon size={15} />
                    <span>{label}</span>
                  </button>
                ))}
              </div>
              <div className="settings-body" id="settings-panel" role="tabpanel" aria-label={SETTINGS_TABS.find((t) => t.id === settingsTab)?.label}>
                {settingsTab === "general" && (
                  <>
                  <section className="panel settings-panel">
                    <header className="settings-head">
                      <h2>Colima</h2>
                      <p>The VM and CLI behind your profiles.</p>
                    </header>
                    <div className="settings-kv">
                      <span>Version</span>
                      <span className="version-line">
                        <code>{versionInfo?.installed || version.replace(/^colima version\s+/i, "") || "—"}</code>
                        {checkingVersion ? (
                          <span className="version-state">checking…</span>
                        ) : versionInfo?.latest == null ? (
                          <span className="version-state" title="GitHub was unreachable">not checked</span>
                        ) : versionInfo.update_available ? (
                          <span className="version-state outdated">{versionInfo.latest} available</span>
                        ) : (
                          <span className="version-state ok">up to date</span>
                        )}
                        {versionInfo?.update_available && (
                          <span className="version-actions">
                            {versionInfo.manager === "brew" ? (
                              <button className="icon-plain accent" disabled={busy} onClick={() => void (async () => { await act(() => invoke("upgrade_cmd"), "Colima updated"); await loadVersion(); await checkVersion(); })()} aria-label={`Update Colima to ${versionInfo.latest}`} title={`Install Colima ${versionInfo.latest} with brew upgrade`}>
                                <UpgradeIcon />
                              </button>
                            ) : (
                              <button className="icon-plain accent" disabled={busy} onClick={() => openUrl("https://github.com/abiosoft/colima/releases/latest", "Opened releases")} aria-label={`Download Colima ${versionInfo.latest}`} title={`Colima ${versionInfo.latest} is out; opens the release page`}>
                                <ArrowUpRightIcon />
                              </button>
                            )}
                          </span>
                        )}
                      </span>
                    </div>
                    <div className="settings-kv">
                      <span>Active profile</span>
                      <span className="settings-profile">
                        <span className={`side-dot ${selectedRunning ? "on" : "off"}`} />
                        {selected}
                        <span className="muted">{selectedRunning ? "running" : "stopped"}</span>
                      </span>
                    </div>
                    <div className="settings-kv">
                      <span>Runtime</span>
                      <code>{status?.runtime ?? "—"} · {status?.arch ?? "—"}</code>
                    </div>
                    <div className="settings-actions footer">
                      <button className="btn ghost" disabled={busy || !selectedRunning} title="Runs colima update -p <selected profile>: refreshes the container runtime inside the VM, not the CLI. Requires that profile to be running." onClick={() => act(() => invoke("update_cmd", { profile: selected }))}>Update runtime</button>
                      <button className="btn ghost" disabled={busy} title="Removes cached Colima and Lima downloads; containers, images and volumes are untouched" onClick={() => setShowColimaPrune(true)}>Prune cached downloads…</button>
                      <button className="btn ghost" disabled={busy} onClick={() => setShowPrune(true)}>Prune Docker data…</button>
                      <button className="btn ghost" onClick={() => setShowOnboarding(true)}>Run setup again</button>
                    </div>
                  </section>

                  <section className="panel settings-panel settings-tools">
                    <header className="settings-head settings-head-tools">
                      <div>
                        <h2>Tools on this machine</h2>
                        <p>Every CLI Runtime Desk probes. A missing utility hides the sections that need it.</p>
                      </div>
                    </header>
                    <table className="table">
                      <thead>
                        <tr><th>Utility</th><th>Status</th><th>Used for</th><th>Install</th></tr>
                      </thead>
                      {TOOL_GROUPS.map(({ group, label }) => {
                        const keys = toolsInGroup(group);
                        if (!keys.length) return null;
                        return (
                          <tbody key={group}>
                            <tr className="tool-group-row">
                              <th colSpan={4} scope="colgroup">{label}</th>
                            </tr>
                            {keys.map((tool) => {
                              const info = TOOLS[tool];
                              const ok = tools?.[tool];
                              return (
                                <tr key={tool}>
                                  <td className="settings-tool-name">{info.label}</td>
                                  <td>
                                    {tools == null ? (
                                      <span className="tool-pill">checking…</span>
                                    ) : (
                                      <span className={`tool-pill ${ok ? "on" : "off"}`}><span className="tool-dot" />{ok ? "installed" : "missing"}</span>
                                    )}
                                  </td>
                                  <td>{info.why}</td>
                                  <td>
                                    {tools == null || ok ? (
                                      <span className="muted">—</span>
                                    ) : (
                                      <span className="install-cmd">
                                        <code>{info.install}</code>
                                        <CopyButton value={info.install} label={`${info.label} install command`} />
                                      </span>
                                    )}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        );
                      })}
                    </table>
                  </section>

                  {/* Destructive and profile-scoped: it belongs under the facts it destroys,
                      not behind a tab of its own that reads as a peer of General. */}
                  <section className="panel settings-panel settings-danger">
                    <div className="settings-danger-row">
                      <span className="settings-danger-icon" aria-hidden="true"><TriangleAlertIcon size={16} /></span>
                      <div className="settings-danger-text">
                        <h3>Delete {selected}</h3>
                        <p>Removes the profile with its VM disk, images and volumes. This cannot be undone.</p>
                      </div>
                      <button className="btn danger" disabled={busy} onClick={() => { setDeleteConfirm(""); setShowDelete(true); }}>
                        Delete profile…
                      </button>
                    </div>
                  </section>
                  </>
                )}

                {settingsTab === "sidebar" && (
                  <section className="panel settings-panel">
                    <header className="settings-head">
                      <h2>Sidebar</h2>
                      <p>Sections appear only when their tool is installed. Hide the ones you never use.</p>
                    </header>
                    <div className="section-list">
                      {HIDEABLE_GROUPS.map((group) => {
                        const hidden = !!hiddenSections[group.title];
                        const required = toolsFor(group.items.map((i) => i.feature));
                        // Same gate the nav uses, so a row can never read "Unavailable" above a
                        // section that is on screen (containerd's nerdctl client is one case).
                        const available = group.items.filter((i) => !gateFor(i).missing);
                        const unavailable = !!tools && available.length === 0;
                        return (
                          <div className={`section-row ${unavailable ? "unavailable" : ""}`} key={group.title}>
                            <div className="section-text">
                              <div className="section-name">{group.title}</div>
                              <div className="section-sub">
                                {available.length === 0
                                  ? group.items.map((i) => i.label).join(" · ")
                                  : available.map((i) => i.label).join(" · ")}
                              </div>
                            </div>
                            <div className="section-tools">
                              {required.map((tool) => {
                                const ok = tools?.[tool] ?? false;
                                return (
                                  <span key={tool} className={`tool-state ${ok ? "on" : "off"}`} title={ok ? TOOLS[tool].why : TOOLS[tool].install}>
                                    <span className="tool-dot" />{TOOLS[tool].label}
                                  </span>
                                );
                              })}
                            </div>
                            <button
                              className={`section-toggle ${unavailable || hidden ? "" : "on"}`}
                              aria-pressed={!hidden && !unavailable}
                              disabled={unavailable}
                              title={
                                unavailable
                                  ? `Needs ${required.map((t) => TOOLS[t].label).join(", ")}`
                                  : hidden ? "Show this section in the sidebar" : "Hide this section from the sidebar"
                              }
                              onClick={() => setHiddenSections((h) => ({ ...h, [group.title]: !h[group.title] }))}
                            >
                              {unavailable ? "Unavailable" : hidden ? "Hidden" : "Visible"}
                            </button>
                          </div>
                        );
                      })}
                    </div>
                    <div className="other-tools">
                      <div className="other-tools-label">Also detected</div>
                      <div className="other-tools-list">
                        {(Object.keys(TOOLS) as ToolKey[])
                          .filter((tool) => !HIDEABLE_GROUPS.some((g) => toolsFor(g.items.map((i) => i.feature)).includes(tool)))
                          .map((tool) => {
                            const ok = tools?.[tool] ?? false;
                            return (
                              <span key={tool} className={`tool-state ${ok ? "on" : "off"}`} title={ok ? TOOLS[tool].why : TOOLS[tool].install}>
                                <span className="tool-dot" />{TOOLS[tool].label}
                              </span>
                            );
                          })}
                      </div>
                    </div>
                  </section>
                )}

                {settingsTab === "configuration" && (
                  <section className="panel settings-panel">
                    <header className="settings-head">
                      <h2>Configuration</h2>
                      <p>Template applied when creating profiles, and the SSH config for <code>{selected}</code>.</p>
                    </header>
                    <div className="settings-actions">
                      <button
                        className="btn ghost"
                        disabled={busy}
                        onClick={async () => {
                          if (template) { setTemplate(""); return; }
                          setTemplate(await safe(invoke<string>("template_cmd"), "") || "(template file not found)");
                        }}
                      >
                        {template ? "Hide template" : "Show template"}
                      </button>
                      <button
                        className="btn ghost"
                        disabled={busy}
                        onClick={async () => {
                          if (sshConfig) { setSshConfig(""); return; }
                          setSshConfig(await safe(invoke<string>("ssh_config_cmd", { profile: selected }), "") || "(no SSH config)");
                        }}
                      >
                        {sshConfig ? "Hide SSH config" : "Show SSH config"}
                      </button>
                    </div>
                    {template && <pre className="logs code-block" style={{ marginTop: 12 }}>{template}</pre>}
                    {sshConfig && <pre className="logs code-block" style={{ marginTop: 12 }}>{sshConfig}</pre>}
                    <p className="settings-note">Template lives at <code>_templates/default.yaml</code> inside the Colima config home (<code>~/.colima</code> or <code>$XDG_CONFIG_HOME/colima</code>).</p>
                  </section>
                )}

                {settingsTab === "about" && (
                  <section className="panel settings-panel about-panel">
                    {/* A Mac about panel: the app as identity, then references, then the notice. */}
                    <div className="about-identity">
                      <img className="about-mark" src="/logo.png" alt="" width={72} height={72} />
                      <h2 className="about-name">Runtime Desk</h2>
                      <p className="about-version mono">v{__APP_VERSION__} · GPL-3.0-only</p>
                      <p className="about-credits">A macOS console for local containers: Colima profiles, Docker, Podman machines and Lima VMs in one window. Every view reads the <code>colima</code>, <code>docker</code>, <code>podman</code>, and <code>nerdctl</code> output you already have.</p>
                      <p className="about-built">Built with Tauri 2 and React 19 by dm0xa.</p>
                    </div>

                    {appRelease?.update_available && appRelease.latest && (
                      <div className="about-update" role="status">
                        <span className="about-update-icon"><UpgradeIcon size={15} /></span>
                        <span className="about-update-text">
                          {/* The panel already names the app above, so the row names the version. */}
                          <span>Version {appRelease.latest} is available</span>
                          <span>You are running {appRelease.installed}.</span>
                        </span>
                        <button className="btn ghost" onClick={() => openUrl(appRelease.url, "Opened releases")}>Open releases</button>
                      </div>
                    )}

                    <div className="about-links">
                      <button className="about-link" onClick={() => openUrl(REPO_URL, "Opened GitHub")} title="github.com/dm0xa/runtime-desk">Repository</button>
                      <span className="about-sep" aria-hidden="true">·</span>
                      <button className="about-link" onClick={() => openUrl(`${REPO_URL}/issues/new`, "Opened issue form")} title="github.com/dm0xa/runtime-desk/issues/new">Report an issue</button>
                      <span className="about-sep" aria-hidden="true">·</span>
                      <button className="about-link" onClick={() => openUrl("https://github.com/abiosoft/colima", "Opened Colima project")} title="github.com/abiosoft/colima">Colima</button>
                      <span className="about-sep" aria-hidden="true">·</span>
                      <button className="about-link" onClick={() => openUrl(`${REPO_URL}/blob/main/LICENSE`, "Opened license")} title="GNU General Public License v3.0, full text">License</button>
                    </div>

                    <button className="about-support" onClick={() => openUrl(SUPPORT_URL, "Opened Buy Me a Coffee")} title="buymeacoffee.com/dm0xa">
                      <CoffeeIcon size={13} />
                      <span>Buy me a coffee</span>
                    </button>

                    <p className="about-copyright">Copyright © 2026 Runtime Desk contributors. GPL-3.0-only, without warranty.</p>
                  </section>
                )}

              </div>
            </div>
          )}
          </div>
        </div>
      </div>
      <div className="statusbar" inert={showOnboarding || undefined}>
        <span>
          {!(countsRead && !listsFailed) ? (
            <><span className="status-dot idle" aria-hidden="true" />{[
              tools && !tools.docker && status?.runtime !== "containerd" ? "docker CLI not found"
                : profiles.length === 0 ? "no profile"
                : !selectedRunning ? `${selected} stopped`
                : "lists unavailable",
            ][0]} · counts not read</>
          ) : (
            <><span className="status-dot" aria-hidden="true" />{counts.running} running · {counts.containers} {counts.containers === 1 ? "container" : "containers"} · {counts.images} {counts.images === 1 ? "image" : "images"} · {counts.volumes} {counts.volumes === 1 ? "volume" : "volumes"}</>
          )}
        </span>
        <span>{status?.runtime ?? ""} {status?.arch ?? ""}</span>
        <span title={lastUpdated ? new Date(lastUpdated).toLocaleTimeString() : undefined}>
          {lastUpdated ? `updated ${Math.max(0, Math.round((Date.now() - lastUpdated) / 1000))}s ago` : ""}
        </span>
        <div className="right">
          <button className="status-btn" title="Keyboard shortcuts (?)" aria-label="Keyboard shortcuts" onClick={() => setShowHelp(true)}>?</button>
          <button className="status-btn" title="Settings (⌘,)" aria-label="Settings" onClick={() => navTo({ tab: "settings" })}><GearIcon size={13} /></button>
        </div>
      </div>

      {showOnboarding && (
        <Onboarding
          tools={tools}
          onRecheck={() => void refresh()}
          onFinish={finishOnboarding}
          onSkip={finishOnboarding}
        />
      )}

      {logTarget && (
        <LogsModal
          name={logTarget.name}
          tail={500}
          onClose={() => setLogTarget(null)}
          onLoad={(size) => safe(invoke<string>(logTarget.runtime === "podman" ? "podman_container_logs_cmd" : "container_logs_cmd", { id: logTarget.id, tail: size }), "")}
        />
      )}

      {inspect && (
        <InspectModal
          kind={inspect.kind}
          name={inspect.name}
          raw={inspect.raw}
          error={inspect.error}
          onReload={() => loadInspect(inspect.kind, inspect.name, String(inspect.args.id))}
          onClose={() => setInspect(null)}
        />
      )}

      {showHelp && (
        <Dialog label="Keyboard shortcuts" width={440} onClose={() => setShowHelp(false)}>
            <h2>Keyboard shortcuts</h2>
            <div className="help-grid">
              <div className="help-row"><span>Navigate the first nine screens</span><span><kbd>⌘</kbd><kbd>1</kbd> … <kbd>⌘</kbd><kbd>9</kbd></span></div>
              <div className="help-row"><span>Navigate the last screen</span><span><kbd>⌘</kbd><kbd>0</kbd></span></div>
              <div className="help-row"><span>Search everything</span><span><kbd>⌘</kbd><kbd>K</kbd> or <kbd>⌘</kbd><kbd>F</kbd></span></div>
              <div className="help-row"><span>Settings</span><span><kbd>⌘</kbd><kbd>,</kbd></span></div>
              <div className="help-row"><span>New profile</span><span><kbd>⌘</kbd><kbd>N</kbd></span></div>
              <div className="help-row"><span>Go back</span><span><kbd>⌘</kbd><kbd>[</kbd></span></div>
              <div className="help-row"><span>Refresh data</span><span><kbd>⌘</kbd><kbd>R</kbd></span></div>
              <div className="help-row"><span>Show / hide sidebar</span><span><kbd>⌘</kbd><kbd>⌥</kbd><kbd>S</kbd></span></div>
              <div className="help-row"><span>Row actions</span><span>Right-click a row</span></div>
              <div className="help-row"><span>Close dialog / edit mode</span><span><kbd>Esc</kbd></span></div>
              <div className="help-row"><span>This help</span><span><kbd>?</kbd></span></div>
            </div>
            <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 16 }}>
              <button className="btn primary" onClick={() => setShowHelp(false)}>Got it</button>
            </div>
        </Dialog>
      )}

      {showPrune && (
        <Dialog label="Prune unused data" className="prune-modal" onClose={() => setShowPrune(false)}>
            <div className="prune-head">
              <div>
                <h2>Prune unused data</h2>
                <p className="muted">
                  Context: <strong>{selected}</strong> · running containers are never touched
                  {disk.reclaimable > 0 ? <> · Docker estimates up to {fmtSize(disk.reclaimable)} reclaimable</> : null}
                </p>
              </div>
              <button className="icon-plain" onClick={() => setShowPrune(false)} aria-label="Close" title="Close"><XIcon /></button>
            </div>

            <div className="prune-body">
              <div className="warn">Irreversible. Review exactly what will be removed below before confirming.</div>
              {containers.some((c) => isKubernetesContainer(c)) && (
                <p className="muted">
                  Stopped containers created by the cluster's kubelet are pruned with the rest; its controllers recreate
                  any that are still wanted, so nothing in the cluster breaks.
                </p>
              )}

              <PruneSection title="Stopped containers" desc="Every container that is not running." checked={pruneOpts.containers} onToggle={(v) => setPruneOpts({ ...pruneOpts, containers: v })} empty={stoppedContainers.length === 0 ? "No stopped containers" : undefined} count={stoppedContainers.length}>
                {stoppedContainers.map((c) => <code key={c.id} title={c.status}>{c.name}</code>)}
              </PruneSection>

              <PruneSection title="Unused networks" desc="Networks with no attached containers; built-in networks are skipped by Docker." checked={pruneOpts.networks} onToggle={(v) => setPruneOpts({ ...pruneOpts, networks: v })} empty={networks.length === 0 ? "No networks" : undefined} count={networks.length}>
                {networks.map((n) => <code key={n.name}>{n.name}</code>)}
              </PruneSection>

              <PruneSection title="Build cache" desc="All Docker builder cache layers; layers a running build holds are skipped." checked={pruneOpts.build_cache} onToggle={(v) => setPruneOpts({ ...pruneOpts, build_cache: v })} count={cacheLayers.length || 1}>
                {cacheLayers.length > 0
                  ? cacheLayers.slice(0, 6).map((entry, i) => (
                    <code key={i} title={entry.in_use ? "Held by a running build; prune skips it" : undefined}>
                      {entry.kind || "build cache"} · {fmtSize(entry.size)}{entry.in_use ? " · in use" : ""}
                    </code>
                  ))
                  : <code>buildkit cache</code>}
                {cacheLayers.length > 6 && (
                  <code>+{cacheLayers.length - 6} more · {fmtSize(cacheLayers.slice(6).reduce((n, c) => n + c.size, 0))}</code>
                )}
              </PruneSection>

              <PruneSection title="Dangling images" desc="Images with no tag; safe to remove." checked={pruneOpts.images} onToggle={(v) => setPruneOpts({ ...pruneOpts, images: v })} empty={danglingImages.length === 0 ? "No dangling images" : undefined} count={danglingImages.length}>
                {danglingImages.map((i) => <code key={`${i.id}-${i.repository}-${i.tag}`}>{i.id}</code>)}
              </PruneSection>

              <PruneSection danger title="All unused images" desc="Every image not referenced by a container — including images you may want to keep." checked={pruneOpts.all_images} onToggle={(v) => setPruneOpts({ ...pruneOpts, all_images: v })} empty={unusedImages.length === 0 ? "No unused images" : undefined} count={unusedImages.length}>
                {unusedImages.map((i) => <code key={`${i.id}-${i.repository}-${i.tag}`}>{i.repository}:{i.tag}</code>)}
              </PruneSection>

              <PruneSection danger title="Unused volumes" desc="Docker removes volumes not attached to any container. Data is not recoverable." checked={pruneOpts.volumes} onToggle={(v) => setPruneOpts({ ...pruneOpts, volumes: v })} empty={prunableVolumes.length === 0 ? "No unused volumes" : undefined} count={prunableVolumes.length}>
                {prunableVolumes.map((v) => <code key={v.name}>{v.name}</code>)}
              </PruneSection>
            </div>

            <div className="prune-foot">
              <span className="muted">{selectedCount} of 6 categories selected</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button className="btn ghost" onClick={() => setShowPrune(false)}>Cancel</button>
                <button className="btn danger" disabled={busy || selectedCount === 0} onClick={() => act(async () => { await invoke("docker_prune_cmd", { opts: pruneOpts }); setShowPrune(false); })}>Prune selected</button>
              </div>
            </div>
        </Dialog>
      )}

      {resize && (
        <Dialog label={`Start ${selected} with…`} width={460} onClose={() => { if (!busy) setResize(null); }}>
          <h2>Start {selected} with…</h2>
          <p className="muted">
            Colima has no "resize" verb: resources are applied by <code>colima start</code>, which is why this
            starts the profile. {selectedRunning ? "Stop it first — the fields below would restart the VM." : ""}
          </p>
          <div className="field-row">
            <div className="field">
              <label htmlFor="resize-cpus">CPUs</label>
              <input id="resize-cpus" type="number" min={1} value={resize.cpus} onChange={(e) => setResize({ ...resize, cpus: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="resize-memory">Memory (GiB)</label>
              <input id="resize-memory" type="number" min={1} value={resize.memory} onChange={(e) => setResize({ ...resize, memory: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="resize-disk">Disk (GiB)</label>
              <input id="resize-disk" type="number" min={10} value={resize.disk} onChange={(e) => setResize({ ...resize, disk: e.target.value })} />
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" disabled={busy} onClick={() => setResize(null)}>Cancel</button>
            <button
              className="btn primary"
              disabled={busy || selectedRunning || !resize.cpus || !resize.memory || !resize.disk}
              onClick={() => act(async () => {
                await invoke("start_cmd", { opts: {
                  profile: selected,
                  cpus: Number(resize.cpus),
                  memory: Number(resize.memory),
                  disk: Number(resize.disk),
                  runtime: status?.runtime ?? undefined,
                  vm_type: cfg?.vm_type ?? undefined,
                } });
                await activateProfile(selected);
                await loadConfig(selected);
                setResize(null);
                return `${selected} started`;
              })}
            >
              Start with these resources
            </button>
          </div>
        </Dialog>
      )}

      {netEdit && (
        <Dialog label={`Network for ${selected}`} width={500} onClose={() => { if (!busy) setNetEdit(null); }}>
          <h2>Network for {selected}</h2>
          <p className="muted">
            Applied by <code>colima start</code>, so the profile must be stopped. Mode and the reachable
            IP are read only at creation — use <strong>Recreate…</strong> for those.
          </p>
          <div className="field">
            <label>Port forwarder</label>
            <Select label="Port forwarder" minWidth={0} value={netEdit.port_forwarder} options={[
              { value: "ssh", label: "ssh — TCP only" },
              { value: "grpc", label: "grpc — TCP + UDP" },
              { value: "none", label: "none" },
            ]} onChange={(v) => setNetEdit({ ...netEdit, port_forwarder: v })} />
            <div className="field-hint">grpc carries UDP but is experimental.</div>
          </div>
          <div className="field">
            <label>DNS resolvers</label>
            <input value={netEdit.dns} aria-label="DNS resolvers" autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" placeholder="1.1.1.1, 8.8.8.8" onChange={(e) => setNetEdit({ ...netEdit, dns: e.target.value })} />
            {!!cfg?.dns.length && !netEdit.dns.trim() && (
              <div className="field-hint bad">Colima has no flag that removes resolvers. Keep at least one, or use Recreate… for a fresh VM.</div>
            )}
          </div>
          <div className="field">
            <label>DNS hosts</label>
            <input value={netEdit.dns_hosts} aria-label="DNS hosts" autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" placeholder="myapp.local=192.168.1.100" onChange={(e) => setNetEdit({ ...netEdit, dns_hosts: e.target.value })} />
            {!!cfg?.dns_hosts.length && !netEdit.dns_hosts.trim() && (
              <div className="field-hint bad">Colima has no flag that removes DNS hosts. Keep one, or use Recreate… for a fresh VM.</div>
            )}
          </div>
          <div className="field">
            <label>Gateway</label>
            <input value={netEdit.gateway_address} aria-label="Gateway address" autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" onChange={(e) => setNetEdit({ ...netEdit, gateway_address: e.target.value })} />
            <div className="field-hint">Empty resets to Colima's default, <code>192.168.5.2</code>.</div>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" disabled={busy} onClick={() => setNetEdit(null)}>Cancel</button>
            <button
              className="btn primary"
              disabled={busy || selectedRunning
                || (!!cfg?.dns.length && !netEdit.dns.trim())
                || (!!cfg?.dns_hosts.length && !netEdit.dns_hosts.trim())}
              title={selectedRunning ? "Stop the profile first: colima start applies these" : undefined}
              onClick={() => act(async () => {
                await invoke("start_cmd", { opts: {
                  profile: selected,
                  dns: dnsArgs(netEdit.dns),
                  dns_hosts: dnsHostArgs(netEdit.dns_hosts),
                  port_forwarder: netEdit.port_forwarder,
                  // An empty field must mean the default, not "leave the old custom gateway".
                  gateway_address: netEdit.gateway_address.trim() || "192.168.5.2",
                } });
                await activateProfile(selected);
                await loadConfig(selected);
                setNetEdit(null);
                return `${selected} started with the new network settings`;
              })}
            >Start with these settings</button>
          </div>
        </Dialog>
      )}

      {recreate && (
        <Dialog label={`Recreate ${selected}`} className="create-modal" onClose={() => { if (!busy) setRecreate(null); }}>
          <h2>Recreate {selected}</h2>
          <p className="muted">
            Colima reads architecture, VM type, runtime, mount type and network mode only when it creates the
            VM. Changing one means deleting and starting it again. Settings this app does not edit — Docker
            daemon config, environment variables, CPU type — are not carried over.
          </p>
          <div className="row2">
            <div className="field"><label>Arch</label><Select label="Architecture" minWidth={0} value={recreate.arch} options={[{ value: "aarch64", label: "aarch64" }, { value: "x86_64", label: "x86_64" }]} onChange={(v) => setRecreate({ ...recreate, arch: v, vm_type: normalizeArch(v) === hostArch ? recreate.vm_type : "qemu", rosetta: normalizeArch(v) === hostArch ? recreate.rosetta : false, mount_type: normalizeArch(v) !== hostArch && recreate.mount_type === "virtiofs" ? "9p" : recreate.mount_type })} /></div>
            <div className="field"><label>VM type</label><Select label="VM type" minWidth={0} value={recreate.vm_type} options={[{ value: "vz", label: "vz" }, { value: "qemu", label: "qemu" }, { value: "krunkit", label: "krunkit" }]} onChange={(v) => setRecreate({ ...recreate, vm_type: v, rosetta: v === "vz" ? recreate.rosetta : false, mount_type: v !== "vz" && recreate.mount_type === "virtiofs" ? "9p" : recreate.mount_type })} /></div>
            <div className="field"><label>Runtime</label><Select label="Runtime" minWidth={0} value={recreate.runtime} options={[{ value: "docker", label: "docker" }, { value: "containerd", label: "containerd" }, { value: "incus", label: "incus" }]} onChange={(v) => setRecreate({ ...recreate, runtime: v, kubernetes: v === "incus" ? false : recreate.kubernetes })} /></div>
          </div>
          <div className="row2">
            <div className="field"><label>Mount type</label><Select label="Mount type" minWidth={0} value={recreate.mount_type} options={[...(recreate.vm_type === "vz" ? [{ value: "virtiofs", label: "virtiofs" }] : []), { value: "9p", label: "9p" }, { value: "sshfs", label: "sshfs" }]} onChange={(v) => setRecreate({ ...recreate, mount_type: v })} /></div>
            <div className="field"><label>Network mode</label><Select label="Network mode" minWidth={0} value={recreate.network_mode} options={[{ value: "shared", label: "shared" }, { value: "bridged", label: "bridged" }]} onChange={(v) => setRecreate({ ...recreate, network_mode: v })} /></div>
            <div className="field"><label>Interface</label><input value={recreate.network_interface} disabled={recreate.network_mode !== "bridged"} aria-label="Network interface" autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" onChange={(e) => setRecreate({ ...recreate, network_interface: e.target.value })} /></div>
          </div>
          <div className="field">
            <label className="check"><input type="checkbox" checked={recreate.network_address} onChange={(e) => setRecreate({ ...recreate, network_address: e.target.checked })} /> Assign a reachable IP</label>
          </div>
          <div className="field">
            <label className="check"><input type="checkbox" disabled={recreate.vm_type !== "vz" || normalizeArch(recreate.arch) !== "arm64"} checked={recreate.rosetta} onChange={(e) => setRecreate({ ...recreate, rosetta: e.target.checked })} /> Rosetta (amd64 emulation)</label>
          </div>
          <div className="field">
            <label className="check"><input type="checkbox" disabled={recreate.runtime === "incus"} checked={recreate.kubernetes} onChange={(e) => setRecreate({ ...recreate, kubernetes: e.target.checked })} /> Kubernetes (k3s){recreate.runtime === "incus" ? <span className="muted"> — needs docker or containerd</span> : null}</label>
            <div className="field-hint">Tick this if the cluster was enabled later from the Kubernetes page: that does not set the profile's <code>kubernetes</code> config flag.</div>
          </div>
          <div className="field">
            <label>DNS resolvers</label>
            <input value={recreate.dns} aria-label="DNS resolvers" autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" placeholder="1.1.1.1, 8.8.8.8" onChange={(e) => setRecreate({ ...recreate, dns: e.target.value })} />
            <div className="field-hint">Comma-separated. Clear it to start the new VM without custom resolvers.</div>
          </div>
          <div className="field">
            <label>DNS hosts</label>
            <input value={recreate.dns_hosts} aria-label="DNS hosts" autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" placeholder="myapp.local=192.168.1.100" onChange={(e) => setRecreate({ ...recreate, dns_hosts: e.target.value })} />
            <div className="field-hint">Clear it to drop every custom DNS host with the old VM.</div>
          </div>
          <fieldset className="field">
            <legend>Container data</legend>
            <label className="check"><input type="radio" name="recreate-data" checked={recreate.keep_data} onChange={() => setRecreate({ ...recreate, keep_data: true })} /> Keep images and containers</label>
            <label className="check"><input type="radio" name="recreate-data" checked={!recreate.keep_data} onChange={() => setRecreate({ ...recreate, keep_data: false })} /> Delete them — a fresh VM</label>
            <div className="field-hint">
              Keeping data is only safe when the runtime and mount type stay the same; a different runtime
              starts an empty engine on the old disk.
            </div>
          </fieldset>
          <div className="field">
            <label>Type <code>{selected}</code> to confirm</label>
            <input value={recreate.confirm} aria-label="Confirm profile name" autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" onChange={(e) => setRecreate({ ...recreate, confirm: e.target.value })} />
          </div>
          <div className="modal-actions">
            <button className="btn ghost" disabled={busy} onClick={() => setRecreate(null)}>Cancel</button>
            <button
              className="btn primary"
              disabled={busy || recreate.confirm !== selected || (!!hostArch && normalizeArch(recreate.arch) !== hostArch && recreate.vm_type !== "qemu")}
              onClick={() => act(async () => {
                await invoke("recreate_profile_cmd", {
                  opts: {
                    profile: selected,
                    cpus: cfg?.cpu, memory: cfg?.memory, disk: cfg?.disk,
                    runtime: recreate.runtime, arch: recreate.arch, vm_type: recreate.vm_type,
                    rosetta: recreate.rosetta && recreate.vm_type === "vz" && normalizeArch(recreate.arch) === "arm64",
                    hostname: cfg?.hostname,
                    kubernetes: recreate.kubernetes,
                    k3s_arg: recreate.kubernetes ? cfg?.k3s_args.join(",") : "",
                    mount_type: recreate.mount_type, mount_inotify: cfg?.mount_inotify,
                    mounts: mountArgs(cfg?.mounts ?? []),
                    network_mode: recreate.network_mode,
                    network_interface: recreate.network_mode === "bridged" ? recreate.network_interface : undefined,
                    network_address: recreate.network_address,
                    network_preferred_route: cfg?.network_preferred_route,
                    network_host_addresses: cfg?.network_host_addresses,
                    gateway_address: cfg?.gateway_address,
                    dns: dnsArgs(recreate.dns),
                    dns_hosts: dnsHostArgs(recreate.dns_hosts),
                    port_forwarder: cfg?.port_forwarder, ssh_agent: cfg?.ssh_agent,
                  },
                  deleteData: !recreate.keep_data,
                });
                // The runtime may have changed: read the profile again so the client (docker
                // vs nerdctl) is picked for the new engine, not the one the list still holds.
                await activateProfile(selected, await safe(invoke<Profile[]>("list_profiles_cmd"), []));
                await loadConfig(selected);
                setRecreate(null);
                return `${selected} recreated`;
              })}
            >Recreate &amp; Start</button>
          </div>
        </Dialog>
      )}

      {pullRef !== null && (
        <Dialog label="Pull an image" width={460} onClose={() => { if (!busy) setPullRef(null); }}>
          <h2>Pull an image</h2>
          <p className="muted">
            Runs <code>docker pull</code> against <strong>{selected}</strong>. The download happens in the VM, so
            the tag comes from a registry rather than this Mac.
          </p>
          <div className="field">
            <label htmlFor="pull-ref">Image reference</label>
            <input
              id="pull-ref"
              value={pullRef}
              placeholder="nginx:1.27"
              autoFocus
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setPullRef(e.target.value)}
            />
          </div>
          <div className="modal-actions">
            <button className="btn ghost" disabled={busy} onClick={() => setPullRef(null)}>Cancel</button>
            <button
              className="btn primary"
              disabled={busy || !pullRef.trim()}
              onClick={() => act(async () => {
                const result = await invoke<string>("image_pull_cmd", { reference: pullRef.trim() });
                setPullRef(null);
                return result.trim().split("\n").slice(-1)[0] || "Image pulled";
              })}
            >
              Pull
            </button>
          </div>
        </Dialog>
      )}

      {showDelete && (
        <Dialog label={`Delete ${selected}`} width={480} onClose={() => setShowDelete(false)}>
            <h2>Delete {selected}</h2>
            <p className="muted">This removes the profile's VM disk, its containers, images and volumes. It cannot be undone.</p>
            {countsRead && !listsFailed && countsProfile === selected ? (
              <>
                <div className="settings-kv"><span>Containers</span><span>{counts.containers}</span></div>
                <div className="settings-kv"><span>Images</span><span>{counts.images}</span></div>
                <div className="settings-kv"><span>Volumes</span><span>{counts.volumes}</span></div>
              </>
            ) : (
              <p className="muted">
                The profile's containers, images and volumes were not read, so their count is unknown.
                The whole VM disk is deleted either way.
              </p>
            )}
            {selectedRunning ? (
              <div className="inv-delete-block">
                <p className="warn">Stop the profile before deleting it.</p>
                <button className="btn ghost" disabled={busy} onClick={() => act(() => invoke("stop_cmd", { profile: selected }), "Profile stopped")}>Stop profile</button>
              </div>
            ) : (
              <div className="field" style={{ marginTop: 12 }}>
                <label>Type <code>{selected}</code> to confirm</label>
                <input
                  value={deleteConfirm}
                  onChange={(e) => setDeleteConfirm(e.target.value)}
                  autoCorrect="off"
                  autoCapitalize="off"
                  spellCheck={false}
                  autoComplete="off"
                  placeholder={selected}
                  aria-label={`Type ${selected} to confirm deletion`}
                  autoFocus
                />
              </div>
            )}
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setShowDelete(false)}>Cancel</button>
              <button
                className="btn danger"
                disabled={busy || selectedRunning || deleteConfirm !== selected}
                onClick={() => {
                  setShowDelete(false);
                  void act(() => invoke("delete_cmd", { profile: selected, data: true, force: true }), "Profile deleted");
                }}
              >
                Delete profile and data
              </button>
            </div>
        </Dialog>
      )}

      {showColimaPrune && (
        <Dialog label="Prune cached downloads" width={480} onClose={() => setShowColimaPrune(false)}>
            <h2>Prune cached downloads</h2>
            <p className="muted">
              Runs <code>colima prune</code> for <strong>{selected}</strong>. It removes cached Colima and Lima
              downloads; containers, images and volumes are untouched.
            </p>
            <div className="modal-actions">
              <button className="btn ghost" onClick={() => setShowColimaPrune(false)}>Cancel</button>
              <button
                className="btn primary"
                disabled={busy}
                onClick={() => {
                  setShowColimaPrune(false);
                  void act(() => invoke("prune_cmd", { profile: selected }), "Cached downloads pruned");
                }}
              >
                Prune downloads
              </button>
            </div>
        </Dialog>
      )}

      {limitTarget && (
        <MemoryLimitDialog
          name={limitTarget.name}
          used={limitTarget.used}
          current={limitTarget.current}
          busy={busy}
          onClose={() => setLimitTarget(null)}
          onApply={(bytes) => void applyMemoryLimit(bytes)}
        />
      )}
      {showCreate && (
        <Dialog label="New profile" className="create-modal" onClose={() => setShowCreate(false)}>
            <h2>New profile</h2>
            <div className="field"><label>Name</label><input value={form.profile} autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" aria-label="Profile name" onChange={(e) => setForm({ ...form, profile: e.target.value })} placeholder="dev" /></div>
            <div className="row2">
              <div className="field"><label>CPUs</label><input type="number" aria-label="CPUs" value={form.cpus} onChange={(e) => setForm({ ...form, cpus: +e.target.value })} /></div>
              <div className="field"><label>Memory (GiB)</label><input type="number" aria-label="Memory in GiB" value={form.memory} onChange={(e) => setForm({ ...form, memory: +e.target.value })} /></div>
              <div className="field"><label>Disk (GiB)</label><input type="number" aria-label="Disk in GiB" value={form.disk} onChange={(e) => setForm({ ...form, disk: +e.target.value })} /></div>
            </div>
            <div className="row2">
              <div className="field"><label>Runtime</label><Select label="Runtime" minWidth={0} value={form.runtime} options={[{ value: "docker", label: "docker" }, { value: "containerd", label: "containerd" }, { value: "incus", label: "incus" }]} onChange={(v) => setForm({ ...form, runtime: v })} /></div>
              <div className="field"><label>Arch</label><Select label="Architecture" minWidth={0} value={form.arch} options={[{ value: "aarch64", label: "aarch64" }, { value: "x86_64", label: "x86_64" }]} onChange={(v) => {
                const cross = !!hostArch && normalizeArch(v) !== hostArch;
                setForm({ ...form, arch: v, vm_type: cross ? "qemu" : form.vm_type, rosetta: cross ? false : form.rosetta, mount_type: cross && form.mount_type === "virtiofs" ? "9p" : form.mount_type });
              }} /></div>
              <div className="field"><label>VM type</label><Select label="VM type" minWidth={0} value={form.vm_type} options={[{ value: "vz", label: "vz" }, { value: "qemu", label: "qemu" }, { value: "krunkit", label: "krunkit" }]} onChange={(v) => setForm({ ...form, vm_type: v, rosetta: v === "vz" ? form.rosetta : false, mount_type: v !== "vz" && form.mount_type === "virtiofs" ? "9p" : form.mount_type })} /></div>
            </div>
            {crossArch && (
              <div className="field-hint bad">
                This Mac is {hostArch}. vz and krunkit boot only the host architecture, so an {form.arch} VM needs qemu.
              </div>
            )}
            <div className="field">
              <label>Mount type</label>
              <Select label="Mount type" minWidth={0} value={form.mount_type} options={[
                ...(form.vm_type === "vz" ? [{ value: "virtiofs", label: "virtiofs — fastest, needs vz" }] : []),
                { value: "9p", label: "9p — qemu's stable choice" },
                { value: "sshfs", label: "sshfs — most compatible" },
              ]} onChange={(v) => setForm({ ...form, mount_type: v })} />
              <div className="field-hint">Cannot change after the VM is created.</div>
            </div>
            <div className="field">
              <label>Mounts</label>
              {form.mounts.map((m, i) => (
                <div className="mount-row" key={i}>
                  <input
                    value={m.location}
                    aria-label={`Mount ${i + 1} path`}
                    autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off"
                    placeholder="~/projects"
                    onChange={(e) => setForm({ ...form, mounts: form.mounts.map((x, j) => j === i ? { ...x, location: e.target.value } : x) })}
                  />
                  <label className="check"><input type="checkbox" checked={m.writable} onChange={(e) => setForm({ ...form, mounts: form.mounts.map((x, j) => j === i ? { ...x, writable: e.target.checked } : x) })} /> writable</label>
                  <button className="icon-btn" type="button" aria-label={`Remove mount ${i + 1}`} onClick={() => setForm({ ...form, mounts: form.mounts.filter((_, j) => j !== i) })}>×</button>
                </div>
              ))}
              <div className="settings-actions">
                <button className="btn ghost" type="button" onClick={() => setForm({ ...form, mounts: [...form.mounts, { location: "", writable: false }] })}>+ Add mount</button>
              </div>
              <div className="field-hint">Colima's default is your home directory, writable; remove every row to mount nothing.</div>
            </div>
            <div className="field">
              <label className="check"><input type="checkbox" checked={form.mount_inotify} onChange={(e) => setForm({ ...form, mount_inotify: e.target.checked })} /> Propagate inotify events</label>
              <div className="field-hint">Experimental: file watchers inside the VM see changes made on this Mac.</div>
            </div>
            <div className="field">
              <label className="check"><input type="checkbox" checked={form.ssh_agent} onChange={(e) => setForm({ ...form, ssh_agent: e.target.checked })} /> Forward SSH agent</label>
              <div className="field-hint">Lets git and other tools inside the VM use this Mac's keys.</div>
            </div>
            <div className="field"><label>Hostname (optional)</label><input value={form.hostname} autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" aria-label="Hostname" onChange={(e) => setForm({ ...form, hostname: e.target.value })} /></div>
            <div className="field"><label className="check" title={form.vm_type === "vz" && normalizeArch(form.arch) === "arm64" ? "Runs linux/amd64 images through Rosetta" : "Rosetta translates amd64 binaries inside an arm64 vz VM"}><input type="checkbox" disabled={form.vm_type !== "vz" || normalizeArch(form.arch) !== "arm64"} checked={form.rosetta} onChange={(e) => setForm({ ...form, rosetta: e.target.checked })} /> Rosetta (amd64 emulation){form.vm_type !== "vz" ? <span className="muted"> — needs vz</span> : normalizeArch(form.arch) !== "arm64" ? <span className="muted"> — needs an arm64 VM</span> : null}</label></div>
            <p className="form-section">Network</p>
            <div className="row2">
              <div className="field">
                <label>Mode</label>
                <Select label="Network mode" minWidth={0} value={form.network_mode} options={[
                  { value: "shared", label: "shared" }, { value: "bridged", label: "bridged" },
                ]} onChange={(v) => setForm({ ...form, network_mode: v })} />
                <div className="field-hint">Bridged gives the VM a LAN address and needs root. Create-time.</div>
              </div>
              <div className="field">
                <label>Interface</label>
                <input value={form.network_interface} disabled={form.network_mode !== "bridged"} aria-label="Network interface" autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" onChange={(e) => setForm({ ...form, network_interface: e.target.value })} />
                <div className="field-hint">Bridged mode only, e.g. <code>en0</code>.</div>
              </div>
              <div className="field">
                <label>Port forwarder</label>
                <Select label="Port forwarder" minWidth={0} value={form.port_forwarder} options={[
                  { value: "ssh", label: "ssh — TCP only" },
                  { value: "grpc", label: "grpc — TCP + UDP" },
                  { value: "none", label: "none" },
                ]} onChange={(v) => setForm({ ...form, port_forwarder: v })} />
                <div className="field-hint">grpc carries UDP but is experimental.</div>
              </div>
            </div>
            <div className="field">
              <label className="check"><input type="checkbox" checked={form.network_address} onChange={(e) => setForm({ ...form, network_address: e.target.checked })} /> Assign a reachable IP</label>
              <div className="field-hint">Needs root and slows the first boot. Once on, it cannot be turned off without recreating the VM.</div>
            </div>
            <div className="field">
              <label>DNS resolvers</label>
              <input value={form.dns} aria-label="DNS resolvers" autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" placeholder="1.1.1.1, 8.8.8.8" onChange={(e) => setForm({ ...form, dns: e.target.value })} />
              <div className="field-hint">Comma-separated; empty keeps the host resolver.</div>
            </div>
            <details className="field">
              <summary className="form-summary">Advanced networking</summary>
              <div className="field">
                <label>Gateway</label>
                <input value={form.gateway_address} aria-label="Gateway address" autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" onChange={(e) => setForm({ ...form, gateway_address: e.target.value })} />
                <div className="field-hint">IPv4 address whose last octet is <code>2</code>.</div>
              </div>
              <div className="field">
                <label>DNS hosts</label>
                <input value={form.dns_hosts} aria-label="DNS hosts" autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" placeholder="myapp.local=192.168.1.100" onChange={(e) => setForm({ ...form, dns_hosts: e.target.value })} />
                <div className="field-hint"><code>name=target</code>, comma-separated. Resolved by the VM's internal resolver.</div>
              </div>
              <div className="field">
                <label className="check"><input type="checkbox" checked={form.network_preferred_route} onChange={(e) => setForm({ ...form, network_preferred_route: e.target.checked })} /> Prefer the assigned IP as the default route</label>
              </div>
              <div className="field">
                <label className="check"><input type="checkbox" checked={form.network_host_addresses} onChange={(e) => setForm({ ...form, network_host_addresses: e.target.checked })} /> Replicate host IPs for port forwarding</label>
                <div className="field-hint">Lets <code>-p 10.0.1.2:8080:8080</code> bind only that host address.</div>
              </div>
            </details>
            <div className="field">
              <label className="check" title="Provisions Colima's single-node k3s in this VM and points your kubeconfig at it"><input type="checkbox" checked={form.kubernetes} onChange={(e) => setForm({ ...form, kubernetes: e.target.checked })} /> Kubernetes (k3s)</label>
              <div className="field-hint">Adds about 300&nbsp;MB inside the VM. A profile created without it can enable Kubernetes later from the Kubernetes page.</div>
            </div>
            {form.kubernetes && (
              <div className="field">
                <label>k3s args (optional)</label>
                <input value={form.k3s_arg} autoCorrect="off" autoCapitalize="off" spellCheck={false} autoComplete="off" aria-label="k3s args" onChange={(e) => setForm({ ...form, k3s_arg: e.target.value })} placeholder="--disable=traefik,servicelb" />
                <div className="field-hint">Passed as <code>--k3s-arg</code>; empty keeps Colima's default (<code>--disable=traefik</code>).</div>
              </div>
            )}
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
              <button className="btn ghost" onClick={() => setShowCreate(false)}>Cancel</button>
              <button className="btn primary" disabled={busy || !form.profile || (crossArch && form.vm_type !== "qemu")} onClick={() => act(async () => {
                await invoke("start_cmd", { opts: startPayload(form) });
                // The new VM is the one the lists must read: point the client at it before the
                // selection changes, or every list keeps answering from the previous socket.
                await activateProfile(form.profile, await safe(invoke<Profile[]>("list_profiles_cmd"), []));
                setSelected(form.profile);
                setShowCreate(false);
              })}>Create & Start</button>
            </div>
        </Dialog>
      )}
    </div>
  );
}

export default App;