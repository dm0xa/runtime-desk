import { Fragment, useState } from "react";
import type { CleanupReport } from "../types";
import { fmtBytes, fmtSize } from "../lib/format";
import { isKubernetesName } from "../lib/origin";
import { ConfirmButton } from "./ConfirmButton";
import { BroomIcon, FingerprintIcon, TrashIcon } from "./icons";
import { RefreshIcon } from "./RefreshIcon";

/** An object nothing has used for this long is called stale in the list. */
const STALE_DAYS = 30;

type ObjectKind = "image" | "container" | "volume" | "cache";
type Safety = "safe" | "review" | "held";

const KIND_LABEL: Record<ObjectKind, string> = {
  image: "Images",
  container: "Containers",
  volume: "Volumes",
  cache: "Build cache",
};

const KIND_SINGULAR: Record<ObjectKind, string> = {
  image: "Image",
  container: "Container",
  volume: "Volume",
  cache: "Cache",
};

type Props = {
  report: CleanupReport | null;
  loading: boolean;
  busy: boolean;
  profile: string;
  running: boolean;
  /** When the report on screen was read; the page keeps it for a minute before re-reading. */
  readAt: number | null;
  onPrune: () => void;
  onRescan: () => void;
  onRemoveImage: (id: string) => void;
  onRemoveVolume: (name: string) => void;
  onRemoveContainer: (id: string) => void;
  onInvestigate: (kind: "image" | "volume" | "container", id: string) => void;
};

const shortId = (id: string) => id.replace(/^sha256:/, "").slice(0, 12);

/** A group preview is two rows of Safe and three of Review; sixty objects stay a
 *  scroll, but all three risk headers are on screen before the first scroll. */
const GROUP_PREVIEW = 3;
const SAFE_PREVIEW = 2;

const fmtAge = (days: number | null) => {
  if (days === null) return "unknown";
  if (days === 0) return "today";
  return `${days} day${days === 1 ? "" : "s"}`;
};

/** One row of the unused list. `freed` is the only byte count the page totals: what a
 *  removal gives back for good. */
type Candidate = {
  key: string;
  kind: ObjectKind;
  safety: Safety;
  name: string;
  nameTitle?: string;
  why: string;
  whyTitle?: string;
  age: string;
  ageTitle?: string;
  stale: boolean;
  freed: number;
  freedTitle: string;
  k8s?: boolean;
  data?: boolean;
  investigate?: () => void;
  remove?: () => void;
  removeLabel?: string;
  removeTitle?: string;
};

function CandidateRow({ c, busy }: { c: Candidate; busy: boolean }) {
  return (
    <tr>
      <td className="cleanup-name" title={c.nameTitle ?? c.name}>
        <span className="cleanup-name-main">
          {c.k8s && <span className="k8s-chip" title="Created by the profile's Kubernetes cluster; its controller recreates it">k8s</span>}
          <span className="cleanup-name-text">{c.name}</span>
          {c.data && <span className="cleanup-data" title="Removing the volume deletes the files inside">data</span>}
        </span>
        <span className="cleanup-name-sub" title={c.whyTitle ?? c.why}>{KIND_SINGULAR[c.kind]} · {c.why}</span>
      </td>
      <td className="cleanup-age" title={c.ageTitle}>
        {c.age}
        {c.stale && <span className="cleanup-stale" title={`Older than ${STALE_DAYS} days`}>stale</span>}
      </td>
      <td className={`cleanup-freed${c.freed > 0 ? "" : " zero"}`} title={c.freedTitle}>
        {c.freed > 0 ? fmtSize(c.freed) : "—"}
      </td>
      <td>
        <div className="actions">
          {c.investigate && (
            <button className="icon-btn" title="Investigate" aria-label={`Investigate ${c.name}`} onClick={c.investigate}>
              <FingerprintIcon />
            </button>
          )}
          {c.remove && (
            <ConfirmButton
              label={`Remove ${c.name}`}
              confirmLabel={c.removeLabel ?? "Remove?"}
              title={c.removeTitle ?? `Remove ${c.name}`}
              icon={<TrashIcon size={14} />}
              disabled={busy}
              onConfirm={c.remove}
            />
          )}
        </div>
      </td>
    </tr>
  );
}

/** The Docker data filesystem, which is a separate disk from the VM's root image. */
function DiskMeter({ used, total }: { used: number; total: number }) {
  const pct = total > 0 ? Math.min(100, Math.round((used / total) * 100)) : 0;
  const tone = pct >= 95 ? "bad" : pct >= 85 ? "warn" : "";
  return (
    <div className="cleanup-disk">
      <div className="cleanup-disk-line">
        <span>Docker data disk</span>
        <b>{total > 0 ? `${fmtBytes(used)} / ${fmtBytes(total)}` : "not measured"}</b>
      </div>
      {total > 0 && (
        <div className="cleanup-meter">
          <span className={tone} style={{ width: `${pct}%` }} />
        </div>
      )}
      <div className="cleanup-disk-sub">
        {total > 0 ? `${pct}% used` : "Docker's filesystem was not reported"}
      </div>
    </div>
  );
}

function SkeletonRows({ rows }: { rows: number }) {
  return (
    <div className="cleanup-skeleton-rows" aria-hidden="true">
      {Array.from({ length: rows }, (_, i) => (
        <div className="cleanup-skeleton-row" key={i}>
          <span className="cleanup-skeleton" style={{ width: `${28 + (i % 3) * 8}%` }} />
          <span className="cleanup-skeleton" style={{ width: "16%" }} />
          <span className="cleanup-skeleton" style={{ width: `${18 + (i % 2) * 6}%` }} />
          <span className="cleanup-skeleton" style={{ width: 46, marginLeft: "auto" }} />
        </div>
      ))}
    </div>
  );
}

export function CleanupPage({ report, loading, busy, profile, running, readAt, onPrune, onRescan, onRemoveImage, onRemoveVolume, onRemoveContainer, onInvestigate }: Props) {
  const [kindFilter, setKindFilter] = useState<"all" | ObjectKind>("all");
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const images = report?.images ?? [];
  const unused = images.filter((i) => !i.dangling && i.containers === 0);
  const dangling = images.filter((i) => i.dangling);
  const stopped = (report?.containers ?? []).filter((c) => !c.running);
  const unusedVolumes = (report?.volumes ?? []).filter((v) => v.links === 0);
  const cache = report?.build_cache ?? [];
  const logs = report?.log_files ?? [];
  const totals = report?.totals;

  const imageBytes = totals?.images ?? 0;
  const containerBytes = totals?.containers ?? 0;
  const volumeBytes = totals?.volumes ?? 0;
  const cacheBytes = totals?.build_cache ?? 0;
  const logical = imageBytes + containerBytes + volumeBytes + cacheBytes;

  const candidates: Candidate[] = [
    ...dangling.map((i) => ({
      key: `img:${i.id}`,
      kind: "image" as const,
      safety: "safe" as const,
      name: `untagged ${shortId(i.id)}`,
      nameTitle: i.id,
      why: "No tag points at it",
      whyTitle: "The image has no tag; removing it frees its unique layers",
      age: fmtAge(i.age_days),
      ageTitle: i.created ? `Created ${i.created}` : undefined,
      stale: i.age_days !== null && i.age_days >= STALE_DAYS,
      freed: i.unique,
      freedTitle: `${fmtSize(i.unique)} unique of ${fmtSize(i.size)}; layers another image shares stay on disk`,
      investigate: () => onInvestigate("image", shortId(i.id)),
      remove: () => onRemoveImage(i.id),
      removeLabel: "Remove image?",
      removeTitle: "The image has no tags; removing it frees its unique layers",
    })),
    ...unused.map((i) => ({
      key: `img:${i.id}`,
      kind: "image" as const,
      safety: "review" as const,
      name: i.tags[0] ?? shortId(i.id),
      nameTitle: i.tags.length > 1 ? `${i.tags.join(", ")} · ${i.id}` : i.id,
      why: "Nothing uses it",
      whyTitle: "No container references this image; removing it deletes every tag",
      age: fmtAge(i.age_days),
      ageTitle: i.created ? `Created ${i.created}` : undefined,
      stale: i.age_days !== null && i.age_days >= STALE_DAYS,
      freed: i.unique,
      freedTitle: `${fmtSize(i.unique)} unique of ${fmtSize(i.size)}; layers another image shares stay on disk`,
      investigate: () => onInvestigate("image", shortId(i.id)),
      remove: () => onRemoveImage(i.id),
      removeLabel: i.tags.length > 1 ? "Remove all tags?" : "Remove image?",
      removeTitle: `Removes every tag on this image${i.tags.length > 1 ? `: ${i.tags.join(", ")}` : ""}`,
    })),
    ...stopped.map((c) => {
      const k8s = isKubernetesName(c.name);
      const exit = c.status.match(/Exited \((\d+)\)/)?.[1];
      return {
        key: `ctr:${c.id}`,
        kind: "container" as const,
        safety: (k8s ? "held" : "safe") as Safety,
        name: c.name,
        nameTitle: `${c.image || c.name} · ${c.id}`,
        why: k8s ? "Cluster-owned" : exit ? `Exited ${exit}` : "Not running",
        whyTitle: k8s ? "A kubelet controller creates this container again; its bytes are not a saving" : `${c.status || "Not running"}${exit === "137" ? " — 137 is SIGKILL, often the OOM killer" : exit === "143" ? " — 143 is SIGTERM, a requested stop" : ""}`,
        age: fmtAge(c.age_days),
        ageTitle: c.created ? `Created ${c.created}` : undefined,
        stale: !k8s && c.age_days !== null && c.age_days >= STALE_DAYS,
        freed: k8s ? 0 : c.size,
        freedTitle: k8s
          ? `${fmtSize(c.size)} on disk, but the cluster recreates this container`
          : `${fmtSize(c.size)} on the VM disk`,
        k8s,
        investigate: () => onInvestigate("container", shortId(c.id)),
        remove: () => onRemoveContainer(shortId(c.id)),
        removeLabel: "Remove container?",
        removeTitle: k8s ? "The cluster recreates containers it still needs" : `Remove ${c.name}`,
      };
    }),
    ...unusedVolumes.map((v) => ({
      key: `vol:${v.name}`,
      kind: "volume" as const,
      safety: "review" as const,
      name: v.name,
      nameTitle: `${v.name} · ${v.mountpoint}`,
      why: "Nothing mounts it",
      whyTitle: `${v.mountpoint} — removing the volume deletes the files inside`,
      age: fmtAge(v.age_days),
      ageTitle: v.created ? `Created ${v.created}` : undefined,
      stale: v.age_days !== null && v.age_days >= STALE_DAYS,
      freed: v.size,
      freedTitle: `${fmtSize(v.size)} of data. Docker cannot undo this.`,
      data: true,
      investigate: () => onInvestigate("volume", v.name),
      remove: () => onRemoveVolume(v.name),
      removeLabel: "Delete contents?",
      removeTitle: `Remove ${v.name} and delete the files inside`,
    })),
    ...cache.map((entry, i) => ({
      key: `cache:${i}`,
      kind: "cache" as const,
      safety: (entry.in_use ? "held" : "safe") as Safety,
      name: entry.kind ? `${entry.kind} cache` : "Build cache layer",
      nameTitle: entry.kind || "Build cache",
      why: entry.in_use ? "In use by a build" : "Idle builder cache",
      whyTitle: entry.in_use ? "Held by a running build; prune skips it" : "Not used by an active build",
      age: entry.last_used || "—",
      ageTitle: "Build cache records its last use, not creation",
      stale: false,
      freed: entry.in_use ? 0 : entry.size,
      freedTitle: entry.in_use ? `${fmtSize(entry.size)} held by a running build` : `${fmtSize(entry.size)} of builder cache`,
    })),
  ].sort((a, b) => b.freed - a.freed || a.name.localeCompare(b.name));

  const safeRows = candidates.filter((c) => c.safety === "safe");
  const reviewRows = candidates.filter((c) => c.safety === "review");
  const heldRows = candidates.filter((c) => c.safety === "held");
  const safeBytes = safeRows.reduce((n, c) => n + c.freed, 0);
  const reviewBytes = reviewRows.reduce((n, c) => n + c.freed, 0);
  const reclaimable = safeBytes + reviewBytes;
  const reclaimBy = (kind: ObjectKind) => candidates.filter((c) => c.kind === kind).reduce((n, c) => n + c.freed, 0);

  const kindCounts = (["image", "container", "volume", "cache"] as const)
    .map((kind) => ({ kind, rows: candidates.filter((c) => c.kind === kind) }))
    .filter((k) => k.rows.length > 0);
  const activeKind: "all" | ObjectKind = kindCounts.some((k) => k.kind === kindFilter) ? kindFilter : "all";
  const visibleKind = (c: Candidate) => activeKind === "all" || c.kind === activeKind;
  const groups = [
    { key: "safe" as const, title: "Safe to remove", note: "the prune defaults", rows: safeRows.filter(visibleKind) },
    { key: "review" as const, title: "Review first", note: "data and tagged images", rows: reviewRows.filter(visibleKind) },
    { key: "held" as const, title: "Held", note: "in use or cluster-owned", rows: heldRows.filter(visibleKind) },
  ]
    .map((g) => ({ ...g, bytes: g.rows.reduce((n, c) => n + c.freed, 0) }))
    .filter((g) => g.rows.length > 0);
  const visibleCount = groups.reduce((n, g) => n + g.rows.length, 0);
  const visibleFreed = groups.reduce((n, g) => n + g.bytes, 0);

  const imageReclaim = Math.min(imageBytes, reclaimBy("image"));
  const containerReclaim = Math.min(containerBytes, reclaimBy("container"));
  const volumeReclaim = Math.min(volumeBytes, reclaimBy("volume"));
  const cacheReclaim = Math.min(cacheBytes, reclaimBy("cache"));
  const reclaimPct = logical > 0 ? Math.round((reclaimable / logical) * 100) : 0;
  const activeImages = images.filter((i) => i.containers > 0).length;
  const attachedVolumes = (report?.volumes ?? []).filter((v) => v.links > 0).length;
  const runningContainers = (report?.containers ?? []).filter((c) => c.running).length;
  const inUseCache = cache.filter((c) => c.in_use).length;

  const dockerTotal = report?.docker_disk_total ?? 0;
  const dockerUsed = report?.docker_disk_used ?? 0;
  const logTotal = logs.reduce((n, l) => n + l.size, 0);
  // A 228 KB log is not a cleanup problem. Keep the panel for logs worth acting on;
  // the rail's Details row still names the count and size.
  const LOG_PANEL_MIN = 10 * 1024 * 1024;

  const scanned = loading
    ? "scanning…"
    : readAt
      ? `scanned ${new Date(readAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })}`
      : "scanned";

  const listSummary = candidates.length === 0
    ? "No removal candidates."
    : activeKind === "all"
      ? `${candidates.length} object${candidates.length === 1 ? "" : "s"} · ${fmtSize(reclaimable)} can be freed${heldRows.length > 0 ? ` · ${heldRows.length} held` : ""} · grouped by risk`
      : `${KIND_LABEL[activeKind]} · ${visibleCount} of ${candidates.length} · ${fmtSize(visibleFreed)} can be freed`;

  const logPanel = logs.length > 0 && logTotal >= LOG_PANEL_MIN ? (
    <section className="panel">
      <div className="section-head">
        <div>
          <h3>Container logs</h3>
          <p className="muted">
            {logs.length} file{logs.length === 1 ? "" : "s"} · {fmtSize(logTotal)} written by Docker outside its own
            totals. They grow without a limit unless the container sets <code>--log-opt max-size</code>.
          </p>
        </div>
      </div>
      <table className="table table-logs">
        <colgroup>
          <col className="col-log-container" />
          <col className="col-log-size" />
          <col className="col-log-path" />
        </colgroup>
        <thead><tr><th>Container</th><th>Size</th><th>File</th></tr></thead>
        <tbody>
          {logs.map((log) => (
            <tr key={log.path}>
              <td className="cleanup-name" title={log.container}><span className="cleanup-name-text">{log.container}</span></td>
              <td className="cleanup-freed">{fmtSize(log.size)}</td>
              <td className="cleanup-path" title={log.path}>{log.path}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  ) : null;

  if (loading && !report) {
    return (
      <div className="cleanup-page">
        <div className="cleanup-b-workspace">
          <aside className="panel cleanup-b-rail" aria-hidden="true">
            <span className="cleanup-skeleton skeleton-label" />
            <span className="cleanup-skeleton" style={{ width: 148, height: 30, marginTop: 6 }} />
            <span className="cleanup-skeleton skeleton-sub" style={{ marginTop: 8 }} />
            <div className="cleanup-skeleton-split">
              <span className="cleanup-skeleton skeleton-label" />
              <span className="cleanup-skeleton skeleton-label" />
            </div>
            <div className="cleanup-bar-skeleton"><span className="cleanup-skeleton" style={{ width: "62%" }} /></div>
          </aside>
          <section className="panel cleanup-b-listpane" aria-busy="true">
            <div className="section-head">
              <div><h3>Unused objects</h3><p className="muted">Scanning <code>system df -v</code> and the guest disk.</p></div>
              <span className="icon-plain" role="status" aria-label="Scanning storage" title="Scanning storage"><RefreshIcon spinning /></span>
            </div>
            <SkeletonRows rows={7} />
          </section>
        </div>
      </div>
    );
  }

  if (!running) {
    return (
      <section className="panel">
        <h3>Cleanup</h3>
        <p className="muted">Profile <code>{profile}</code> is stopped. Start it to read the storage report.</p>
      </section>
    );
  }

  // The scan answered nothing (the invoke failed): "nothing unused" has not been earned.
  if (!report) {
    return (
      <section className="panel">
        <h3>Cleanup</h3>
        <p className="muted">The storage scan for <code>{profile}</code> did not answer. Nothing is shown rather than zeroes that were never read.</p>
        <button className="btn ghost" onClick={onRescan}><RefreshIcon /> Rescan</button>
      </section>
    );
  }

  // `system df -v` failed. The Docker data disk was still measured; its numbers were not,
  // so they are omitted instead of printed as zero.
  if (report.error) {
    return (
      <div className="cleanup-page">
        <section className="panel">
          <div className="section-head">
            <div>
              <h3>Cleanup</h3>
              <p className="muted">Read for <code>{profile}</code>; the object lists wait for Docker.</p>
            </div>
            <button className="btn ghost" disabled={loading} onClick={onRescan}><RefreshIcon spinning={loading} /> {loading ? "Scanning…" : "Rescan"}</button>
          </div>
          <p className="cleanup-error" role="alert">Docker's storage could not be read: {report.error}</p>
          <DiskMeter used={dockerUsed} total={dockerTotal} />
          <p className="cleanup-b-list-note">Docker's sizes and the object list stay hidden rather than showing zeroes that were never read. The data disk above was measured.</p>
        </section>
        {logPanel}
      </div>
    );
  }

  return (
    <div className="cleanup-page">
      <div className="cleanup-b-workspace">
        <aside className="panel cleanup-b-rail">
          <span className="cleanup-b-rail-label">Can be freed</span>
          <span className={`cleanup-b-rail-value ${reclaimable > 0 ? "state-warn" : "state-ok"}`}>{fmtSize(reclaimable)}</span>
          <span className="cleanup-b-rail-sub">
            {candidates.length === 0
              ? "Nothing unused: every image, container and volume is referenced."
              : `${reclaimPct}% of Docker's ${fmtSize(logical)} · ${candidates.length} object${candidates.length === 1 ? "" : "s"}${heldRows.length > 0 ? ` · ${heldRows.length} held` : ""}`}
          </span>
          {reclaimable > 0 && (
            <div className="cleanup-b-rail-split">
              <div>
                <span className="cleanup-b-rail-split-label">Safe now</span>
                <span className="cleanup-b-rail-split-value">{fmtSize(safeBytes)}</span>
              </div>
              <div className="review">
                <span className="cleanup-b-rail-split-label">Review first</span>
                <span className="cleanup-b-rail-split-value">{fmtSize(reviewBytes)}</span>
              </div>
            </div>
          )}
          <div className="cleanup-b-rail-actions">
            <button className="btn primary" disabled={busy || candidates.length === 0} onClick={onPrune} title="Review every category in the prune dialog">
              <BroomIcon size={14} />
              {candidates.length === 0 ? "Nothing to prune" : `Review & prune ${fmtSize(reclaimable)}…`}
            </button>
          </div>
          {candidates.length > 0 && (
            <p className="cleanup-b-rail-foot">Safe is the prune defaults. Review is data and tagged images you may still want.</p>
          )}
          <DiskMeter used={dockerUsed} total={dockerTotal} />
          <div className="cleanup-cats">
            <div className="cleanup-cat"><span>Images</span><b>{fmtSize(imageBytes)}</b><em>{fmtSize(imageReclaim)} can be freed · {activeImages} active</em></div>
            <div className="cleanup-cat"><span>Volumes</span><b>{fmtSize(volumeBytes)}</b><em>{fmtSize(volumeReclaim)} can be freed · {attachedVolumes === 0 ? "none attached" : `${attachedVolumes} attached`}</em></div>
            <div className="cleanup-cat"><span>Containers</span><b>{fmtSize(containerBytes)}</b><em>{fmtSize(containerReclaim)} can be freed · {runningContainers} running</em></div>
            <div className="cleanup-cat"><span>Build cache</span><b>{cacheBytes > 0 ? fmtSize(cacheBytes) : "—"}</b><em>{cacheBytes > 0 ? `${fmtSize(cacheReclaim)} can be freed · ${inUseCache} in use` : "nothing cached"}</em></div>
          </div>
          <details className="cleanup-b-rail-details">
            <summary>Details</summary>
            <div className="cleanup-detail-row"><span>Client</span><b>{report.client || "—"}</b></div>
            <div className="cleanup-detail-row"><span>Docker's estimate</span><b>{fmtSize(totals?.reclaimable ?? 0)}</b></div>
            <div className="cleanup-detail-row"><span>Container logs</span><b>{logs.length > 0 ? `${fmtSize(logTotal)} · ${logs.length} files` : "none"}</b></div>
            <p className="cleanup-detail-note">Docker's accounting counts shared layers once per image. Frees sums only bytes that stay freed.</p>
          </details>
        </aside>

        <section className="panel cleanup-b-listpane">
          <div className="cleanup-b-list-head">
            <div><h3>Unused objects</h3><p className="muted">{listSummary}</p></div>
            <div className="cleanup-b-list-meta">{scanned} · <button className="cleanup-b-rescan" disabled={loading} onClick={onRescan} title="Re-read the storage report">Rescan</button></div>
          </div>

          {kindCounts.length > 1 && (
            <div className="chips cleanup-kinds" role="group" aria-label="Filter unused objects by kind">
              <button className={`chip${activeKind === "all" ? " active" : ""}`} aria-pressed={activeKind === "all"} onClick={() => setKindFilter("all")}>
                All <span className="chip-count">{candidates.length}</span>
              </button>
              {kindCounts.map((k) => (
                <button
                  key={k.kind}
                  className={`chip${activeKind === k.kind ? " active" : ""}`}
                  aria-pressed={activeKind === k.kind}
                  title={`${fmtSize(k.rows.reduce((n, c) => n + c.freed, 0))} can be freed`}
                  onClick={() => setKindFilter(k.kind)}
                >
                  {KIND_LABEL[k.kind]} <span className="chip-count">{k.rows.length}</span>
                </button>
              ))}
            </div>
          )}

          {groups.length > 0 ? (
            <div className="cleanup-b-listscroll">
              <table className="table table-cleanup-b">
                <colgroup>
                  <col className="col-object" />
                  <col className="col-age" />
                  <col className="col-frees" />
                  <col className="col-actions" />
                </colgroup>
                <thead>
                  <tr>
                    <th>Object</th>
                    <th title="Creation age; build cache rows show when the layer was last used">Age</th>
                    <th title="Bytes the removal frees for good; rows sort by it inside a group">Frees <span className="cleanup-sort">↓</span></th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {groups.map((g) => {
                    const preview = g.key === "safe" ? SAFE_PREVIEW : GROUP_PREVIEW;
                    const open = !!expanded[g.key];
                    const shown = open ? g.rows : g.rows.slice(0, preview);
                    const hidden = g.rows.length - shown.length;
                    const hiddenBytes = g.bytes - shown.reduce((n, c) => n + c.freed, 0);
                    return (
                      <Fragment key={g.key}>
                        <tr className="cleanup-b-group">
                          <td colSpan={4}>
                            <div className="cleanup-b-groupline">
                              <span className="cleanup-b-title">{g.title}</span>
                              <span className="cleanup-b-count">{g.rows.length} object{g.rows.length === 1 ? "" : "s"}</span>
                              <span className="cleanup-b-note">{g.note}</span>
                              <span className={`cleanup-b-bytes${g.key === "review" ? " review" : g.key === "held" ? " muted" : ""}`}>
                                {g.key === "held" ? "frees nothing" : fmtSize(g.bytes)}
                              </span>
                            </div>
                          </td>
                        </tr>
                        {shown.map((c) => <CandidateRow key={c.key} c={c} busy={busy} />)}
                        {(hidden > 0 || (open && g.rows.length > preview)) && (
                          <tr className="cleanup-more-row">
                            <td colSpan={4}>
                              <button className="cleanup-more" onClick={() => setExpanded((prev) => ({ ...prev, [g.key]: !open }))}>
                                {open ? "Show fewer" : `Show ${hidden} more${hiddenBytes > 0 ? ` · ${fmtSize(hiddenBytes)}` : ""}`}
                              </button>
                            </td>
                          </tr>
                        )}
                      </Fragment>
                    );
                  })}
                </tbody>
              </table>
              <p className="cleanup-b-list-note">Frees = bytes that stay freed · rows sort by it inside each group.</p>
            </div>
          ) : candidates.length === 0 ? (
            <p className="cleanup-empty">
              Dangling or unused images, stopped containers, unused volumes and build cache all come through here
              when they appear. Images a container still references stay out of the list.
            </p>
          ) : (
            <p className="cleanup-empty">Nothing in this kind is unused any more. Pick All to see the rest.</p>
          )}
        </section>
      </div>

      {logPanel}
    </div>
  );
}
