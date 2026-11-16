import { Fragment, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { PodmanMachine, PodmanContainer, PodmanImage, PodmanVolume, PodmanNetwork, NetworkMapEntry } from "../types";
import { PlayIcon, StopIcon, RestartIcon, TrashIcon, TerminalIcon, FingerprintIcon, CopyIcon, TagIcon, BracesIcon } from "./icons";
import { TagBadges } from "./TagBadges";
import { TagDialog } from "./TagButton";
import { VolumeTreemap } from "./VolumeTreemap";
import { fmtSize, fmtDateTime } from "../lib/format";
import { ConfirmButton } from "./ConfirmButton";
import { NetworkGraph } from "./NetworkGraph";
import { RowMenu } from "./RowMenu";
import { Select } from "./Select";
import { LogsModal } from "./LogsModal";
import { Dialog } from "./Dialog";
import { Caret } from "./Caret";
import { PortChips } from "./PortChips";
import { ContainerDetail } from "./ContainerDetail";
import { InspectModal, type InspectTarget } from "./InspectModal";
import { Notices } from "./Notices";
import { humanizePodmanError } from "../lib/errors";

export type PodmanSection = "machines" | "containers" | "images" | "volumes" | "networks";

/** Podman's own default network; the CLI refuses to remove it. */
const ROW_PAGE = 100;
const BUILTIN_NETWORK = "podman";

export function PodmanPage({ section, search, refreshNonce, netView, machine, allMachines, onMachine, onOpenContainer, onOpenNetwork, onChanged, onOpenMachines, onInvestigate }: { section: PodmanSection; search: string; refreshNonce: number; netView: "table" | "map"; machine: string; allMachines: PodmanMachine[]; onMachine: (name: string) => void; onOpenContainer: (name: string) => void; onOpenNetwork: (name: string) => void; onChanged: () => void; onOpenMachines: () => void; onInvestigate: (kind: "container" | "image" | "volume" | "network", id: string) => void }) {
  const [machines, setMachines] = useState<PodmanMachine[]>([]);
  const [containers, setContainers] = useState<PodmanContainer[]>([]);
  const [images, setImages] = useState<PodmanImage[]>([]);
  const [volumes, setVolumes] = useState<PodmanVolume[]>([]);
  const [networks, setNetworks] = useState<PodmanNetwork[]>([]);
  const [highlightVolume, setHighlightVolume] = useState<string | null>(null);
  const [netMap, setNetMap] = useState<NetworkMapEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [armedRemove, setArmedRemove] = useState<string | null>(null);
  /** One expanded row per page, keyed by `kind:id`; the same row shows the facts the
   *  Docker lists put under a caret, because the Podman pages have no Investigator. */
  const [expanded, setExpanded] = useState<string | null>(null);
  const [sorts, setSorts] = useState<Record<string, { key: string; dir: 1 | -1 }>>({});
  /** Rows drawn per table. A 300-container machine measured 143 ms and 15 210 DOM nodes per
   *  tab switch with every row mounted; the first hundred caps that at the page floor. */
  const [pages, setPages] = useState<Record<string, number>>({});
  const [inspect, setInspect] = useState<InspectTarget | null>(null);
  const [logTarget, setLogTarget] = useState<{ id: string; name: string } | null>(null);
  /** Docker keeps tags in the Investigator, so its rows spend no icon on them. Podman opens
   *  the same editor from a row menu or the expanded panel instead of the actions cell. */
  const [tagTarget, setTagTarget] = useState<{ kind: "machine" | "container" | "image" | "volume" | "network"; id: string; name: string } | null>(null);

  /** A machine is the Podman daemon; without one, four tabs have nothing to read. Creating
   *  one is a command the app cannot infer, so it is offered where the empty list is. */
  const [creating, setCreating] = useState<{ name: string; cpus: string; memory: string } | null>(null);
  const [pullRef, setPullRef] = useState<string | null>(null);
  /** `podman machine set`: CPUs and memory can change; disk cannot, podman only grows it on
   *  recreation, so the dialog does not offer it. */
  const [resizing, setResizing] = useState<{ name: string; cpus: string; memory: string } | null>(null);
  const [creatingBusy, setCreatingBusy] = useState(false);
  async function createMachine() {
    if (!creating) return;
    setCreatingBusy(true);
    try {
      await invoke<string>("podman_machine_init_cmd", {
        name: creating.name.trim() || null,
        cpus: creating.cpus.trim() ? Number(creating.cpus) : null,
        memoryMb: creating.memory.trim() ? Number(creating.memory) : null,
      });
      setCreating(null);
      setError("");
      await loadMachines();
      onChanged();
    } catch (e) { setError(String(e)); }
    finally { setCreatingBusy(false); }
  }

  const loadMachines = async () => {
    setBusy(true);
    try { setMachines(await invoke<PodmanMachine[]>("podman_machines_cmd")); setError(""); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const loadContainers = async () => {
    setBusy(true);
    try { setContainers(await invoke<PodmanContainer[]>("podman_containers_cmd")); setError(""); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const loadImages = async () => {
    setBusy(true);
    try { setImages(await invoke<PodmanImage[]>("podman_images_cmd")); setError(""); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const loadVolumes = async () => {
    setBusy(true);
    try { setVolumes(await invoke<PodmanVolume[]>("podman_volumes_cmd")); setError(""); }
    catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };
  const loadNetworks = async () => {
    setBusy(true);
    try {
      const [rows, map] = await Promise.all([
        invoke<PodmanNetwork[]>("podman_networks_cmd"),
        invoke<NetworkMapEntry[]>("podman_network_map_cmd"),
      ]);
      setNetworks(rows); setNetMap(map); setError("");
    } catch (e) { setError(String(e)); }
    finally { setBusy(false); }
  };

  const load = () => {
    if (section === "machines") loadMachines();
    else if (section === "containers") loadContainers();
    else if (section === "images") loadImages();
    else if (section === "volumes") loadVolumes();
    else loadNetworks();
  };

  useEffect(() => { load(); }, [section, refreshNonce]);
  useEffect(() => { setExpanded(null); setInspect(null); }, [section]);

  /** One expansion per page: opening a row closes the last one and drops its JSON sheet. */
  function toggleExpanded(key: string) {
    setInspect(null);
    setExpanded((prev) => (prev === key ? null : key));
  }
  /** The expanded row reads its own facts, so opening is only a key change. */
  function toggleContainer(id: string) {
    setInspect(null);
    toggleExpanded(`c:${id}`);
  }
  /** Row action: run the command, reload the list, and let the sidebar count follow. */
  const containerAction = (id: string) => (action: "start" | "stop" | "restart") => {
    setBusy(true);
    invoke(`podman_container_${action}_cmd`, { id })
      .then(loadContainers)
      .then(() => onChanged())
      .catch((e) => setError(String(e)))
      .finally(() => setBusy(false));
  };
  /** Inspect owns a window now, so the payload is bound to the object it came from
   *  instead of a sheet that outlives its row. A late answer for another subject is dropped. */
  function openInspect(kind: string, name: string, cmd: string, args: Record<string, unknown>) {
    loadInspect({ kind, name, cmd, args, raw: null, error: null });
  }
  function loadInspect(target: InspectTarget) {
    setInspect(target);
    invoke<string>(target.cmd, target.args)
      .then((raw) => setInspect((prev) => (prev?.name === target.name ? { ...prev, raw } : prev)))
      .catch((e) => setInspect((prev) => (prev?.name === target.name ? { ...prev, error: String(e) } : prev)));
  }

  function toggleSort(table: string, key: string) {
    setSorts((prev) => {
      const cur = prev[table];
      return { ...prev, [table]: { key, dir: cur && cur.key === key ? (cur.dir === 1 ? -1 : 1) : 1 } };
    });
  }
  function SortTh({ table, k, children }: { table: string; k: string; children: string }) {
    const s = sorts[table];
    const active = s?.key === k;
    return (
      <th aria-sort={active ? (s!.dir === 1 ? "ascending" : "descending") : "none"}>
        <button type="button" className="th-sort" onClick={() => toggleSort(table, k)}
          onKeyDown={(e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggleSort(table, k); } }}>
          {children}
          {active ? <span className={`sort-arrow ${s.dir === 1 ? "up" : "down"}`} aria-hidden="true" /> : ""}
        </button>
      </th>
    );
  }
  function sorted<T>(table: string, rows: T[], get: (row: T, key: string) => string | number): T[] {
    const s = sorts[table];
    if (!s) return rows;
    const out = [...rows];
    out.sort((a, b) => {
      const av = get(a, s.key);
      const bv = get(b, s.key);
      if (av < bv) return -1 * s.dir;
      if (av > bv) return 1 * s.dir;
      return 0;
    });
    return out;
  }

  const q = search.trim().toLowerCase();
  const match = (value: string) => value.toLowerCase().includes(q);
  /** A row of "No containers" is a claim about the daemon. Only a successful read earns it:
   *  an in-flight or failed one says what is actually known instead. */
  const emptyText = (noun: string) => (q ? "No matches." : error ? "List unavailable" : busy ? "Loading…" : `No ${noun}`);
  const shownMachines = sorted("machines", q ? machines.filter((m) => match(m.name) || match(m.vm_type)) : machines, (m, k) => k === "cpus" ? m.cpus : k === "memory" ? m.memory : k === "disk" ? m.disk_size : k === "status" ? (m.running ? "running" : "stopped") : m.name);
  const shownContainers = sorted("containers", q ? containers.filter((c) => match(c.name) || match(c.image) || match(c.state) || match(c.ports)) : containers, (c, k) => k === "image" ? c.image : k === "state" ? c.state : k === "status" ? c.status : k === "ports" ? c.ports : c.name);
  const shownImages = sorted("images", q ? images.filter((i) => match(i.name) || match(i.repository) || match(i.tag) || match(i.id)) : images, (i, k) => k === "id" ? i.id : k === "repository" ? i.repository : k === "tag" ? i.tag : k === "size" ? i.size : k === "created" ? i.created_at : k === "containers" ? i.containers : i.name);
  // The volume table is the one with a hover highlight, and that highlight is page state:
  // without this the whole table (and the treemap layout behind it) was rebuilt on every
  // row crossing, twice per boundary.
  const shownVolumes = useMemo(
    () => sorted("volumes", q ? volumes.filter((v) => match(v.name) || match(v.driver) || match(v.mountpoint)) : volumes, (v: PodmanVolume, k) => k === "size" ? v.size : k === "driver" ? v.driver : k === "mountpoint" ? v.mountpoint : k === "links" ? v.links : v.name),
    [volumes, q, sorts.volumes],
  );
  const pageSize = (table: string) => pages[table] ?? ROW_PAGE;
  const moreRows = (table: string, colSpan: number, total: number) => {
    const shown = pageSize(table);
    if (shown >= total) return null;
    return (
      <tr>
        <td colSpan={colSpan}>
          <button className="btn inv-more" onClick={() => setPages((p) => ({ ...p, [table]: shown + ROW_PAGE }))}>
            Show {Math.min(ROW_PAGE, total - shown)} of {total - shown} more
          </button>
        </td>
      </tr>
    );
  };
  const shownNetworks = sorted("networks", q ? networks.filter((n) => match(n.name) || match(n.driver) || match(n.subnet)) : networks, (n, k) => k === "driver" ? n.driver : k === "subnet" ? n.subnet : n.name);
  const netGroups = [
    { title: "Built-in", rows: shownNetworks.filter((n) => n.name === BUILTIN_NETWORK) },
    { title: "User-defined", rows: shownNetworks.filter((n) => n.name !== BUILTIN_NETWORK) },
  ].filter((g) => g.rows.length > 0);

  return (
    <div className="podman-page">
      {allMachines.length > 0 && (
        <div className="toolbar list-toolbar">
          {allMachines.length === 1 ? (
            <span className="muted">Machine <strong>{allMachines[0].name}</strong>{allMachines[0].running ? "" : " (stopped)"}</span>
          ) : (
            <>
              <span className="muted">Machine</span>
              <Select
                value={machine}
                label="Podman machine"
                minWidth={200}
                options={allMachines.map((m) => ({ value: m.name, label: `${m.name}${m.running ? "" : " (stopped)"}` }))}
                onChange={onMachine}
              />
            </>
          )}
          <span className="muted list-hint" hidden={allMachines.length === 1}>
            Containers, images, volumes and networks below belong to this machine.
          </span>
          {section === "machines" && (
            <button className="btn ghost" disabled={busy || creatingBusy} onClick={() => setCreating({ name: "", cpus: "4", memory: "4096" })}>
              New machine…
            </button>
          )}
          {section === "images" && (
            <button className="btn ghost" disabled={busy} onClick={() => setPullRef("")}>Pull image…</button>
          )}
        </div>
      )}
      {/* A failed list is a notice, not a paragraph of CLI stderr: the sentence says what
          happened, Podman's own text stays behind "Show details", and the two ways out
          (start a machine, retry) are one click away. */}
      {error && (
        <Notices
          notices={[{
            id: 0,
            kind: "error",
            ...humanizePodmanError(error),
            actions: [
              ...(section === "machines" ? [] : [{ label: "Open Machines", run: onOpenMachines }]),
              { label: "Retry", run: load },
            ],
          }]}
          onDismiss={() => setError("")}
        />
      )}

      {section === "machines" && (
        <div className="table-wrap">
          <table className="table table-podman-machines">
            <colgroup>
              <col className="col-name" />
              <col className="col-status" />
              <col className="col-cpus" />
              <col className="col-memory" />
              <col className="col-disk" />
              <col className="col-vmtype" />
              <col className="col-actions" />
            </colgroup>
            <thead><tr><SortTh table="machines" k="name">Name</SortTh><SortTh table="machines" k="status">Status</SortTh><SortTh table="machines" k="cpus">CPUs</SortTh><SortTh table="machines" k="memory">Memory</SortTh><SortTh table="machines" k="disk">Disk</SortTh><SortTh table="machines" k="vmtype">VM type</SortTh><th>Actions</th></tr></thead>
            <tbody>
              {shownMachines.length === 0 && <tr><td colSpan={7} className="empty">{emptyText("machines")}</td></tr>}
              {shownMachines.map((m) => {
                const key = `m:${m.name}`;
                return (
                  <Fragment key={key}>
                    <tr key={m.name} onClick={(e) => { if ((e.target as Element).closest("button")) return; toggleExpanded(key); }} style={{ cursor: "pointer" }}>
                      <td style={{ fontWeight: 600 }} title={m.name}><Caret open={expanded === key} />{m.name}{m.default ? " (default)" : ""}<TagBadges kind="machine" id={m.name} /></td>
                      <td><span className={`status-badge ${m.running ? "running" : "stopped"}`}><span className="dot" />{m.starting ? "starting" : m.running ? "running" : "stopped"}</span></td>
                      <td>{m.cpus}</td>
                      <td>{Math.round(m.memory / 1024 / 1024)} MiB</td>
                      <td>{Math.round(m.disk_size / 1024 / 1024 / 1024)} GiB</td>
                      <td>{m.vm_type}</td>
                      <td><div className="actions">
                        {!m.running && <button className="icon-btn" title="Start" aria-label="Start" disabled={busy} onClick={async () => { setBusy(true); try { await invoke("podman_start_cmd", { name: m.name }); await loadMachines(); onChanged(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}><PlayIcon size={14} /></button>}
                        {m.running && <button className="icon-btn" title="Stop" aria-label="Stop" disabled={busy} onClick={async () => { setBusy(true); try { await invoke("podman_stop_cmd", { name: m.name }); await loadMachines(); onChanged(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}><StopIcon size={14} /></button>}
                        <button className="icon-btn" title="Restart" aria-label="Restart" disabled={busy} onClick={async () => { setBusy(true); try { await invoke("podman_restart_cmd", { name: m.name }); await loadMachines(); onChanged(); } catch (e) { setError(String(e)); } finally { setBusy(false); } }}><RestartIcon size={14} /></button>
                        <button className={`icon-btn danger ${armedRemove === m.name ? "armed" : ""}`} title={armedRemove === m.name ? "Confirm remove" : "Remove"} aria-label={armedRemove === m.name ? "Confirm remove" : "Remove"} disabled={busy} onClick={async () => {
                          if (armedRemove !== m.name) { setArmedRemove(m.name); return; }
                          setArmedRemove(null); setBusy(true);
                          try { await invoke("podman_remove_cmd", { name: m.name }); await loadMachines(); onChanged(); }
                          catch (e) { setError(String(e)); }
                          finally { setBusy(false); }
                        }}><TrashIcon size={14} /></button>
                        </div></td>
                    </tr>
                    {expanded === key && (
                      <tr className="detail-row">
                        <td colSpan={7}>
                          <div className="row-detail">
                            <div className="detail-grid">
                              <div className="detail-item"><span>Name</span><code>{m.name}</code></div>
                              <div className="detail-item"><span>Status</span><div>{m.running ? (m.starting ? "starting" : "running") : "stopped"}</div></div>
                              <div className="detail-item"><span>Default machine</span><div>{m.default ? "yes" : "no"}</div></div>
                              <div className="detail-item"><span>CPUs</span><div>{m.cpus}</div></div>
                              <div className="detail-item"><span>Memory</span><div>{Math.round(m.memory / 1024 / 1024)} MiB</div></div>
                              <div className="detail-item"><span>Disk</span><div>{Math.round(m.disk_size / 1024 / 1024 / 1024)} GiB</div></div>
                              <div className="detail-item"><span>VM type</span><div>{m.vm_type || "—"}</div></div>
                              <div className="detail-item"><span>API port</span><code>{m.port || "—"}</code></div>
                            </div>
                            <div className="detail-actions">
                              <button className="btn ghost" disabled={busy} onClick={() => setResizing({ name: m.name, cpus: String(m.cpus), memory: String(Math.round(m.memory / 1024 / 1024)) })}>Resize…</button>
                              <button className="icon-plain" aria-label="Copy name" title="Copy name" onClick={() => navigator.clipboard?.writeText(m.name)}><CopyIcon /></button>
                              <button className="icon-plain" aria-label="Tags" title="Tags" onClick={() => setTagTarget({ kind: "machine", id: m.name, name: m.name })}><TagIcon /></button>
                            </div>
                          </div>
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            {moreRows("containers", 6, shownContainers.length)}
            </tbody>
          </table>
        </div>
      )}

      {section === "containers" && (
        <div className="table-wrap">
          <table className="table table-containers">
            <colgroup>
              <col className="col-state" />
              <col className="col-name" />
              <col className="col-image" />
              <col className="col-status" />
              <col className="col-ports" />
              <col className="col-actions" />
            </colgroup>
            <thead><tr><SortTh table="containers" k="state">State</SortTh><SortTh table="containers" k="name">Name</SortTh><SortTh table="containers" k="image">Image</SortTh><SortTh table="containers" k="status">Status</SortTh><SortTh table="containers" k="ports">Ports</SortTh><th>Actions</th></tr></thead>
            <tbody>
              {shownContainers.length === 0 && <tr><td colSpan={6} className="empty">{emptyText("containers")}</td></tr>}
              {shownContainers.slice(0, pageSize("containers")).map((c) => {
                const key = `c:${c.id}`;
                const logs = () => setLogTarget({ id: c.id, name: c.name });
                return (
                  <Fragment key={key}>
                    <tr key={c.id} onClick={(e) => { if ((e.target as Element).closest("button, .menu-trigger")) return; void toggleContainer(c.id); }} style={{ cursor: "pointer" }}>
                      <td><span className={`status-badge ${c.state === "running" ? "running" : "stopped"}`}><span className="dot" />{c.state}</span></td>
                      <td style={{ fontWeight: 600 }} title={c.name}><Caret open={expanded === key} />{c.name}<TagBadges kind="container" id={c.id} /></td>
                      <td title={c.image}>{c.image}</td>
                      <td style={{ color: "var(--muted)" }} title={c.status}>{c.status}</td>
                      <td className="ports-cell"><PortChips ports={c.ports} /></td>
                      <td><div className="actions">
                        <button className="icon-btn" title="Logs" aria-label="Logs" onClick={logs}><TerminalIcon size={14} /></button>
                        <RowMenu label="Container actions">
                          {(close) => (
                            <>
                              <button className="menu-item" disabled={busy || c.state === "running"} onClick={() => { close(); setBusy(true); invoke("podman_container_start_cmd", { id: c.id }).then(loadContainers).then(() => onChanged()).catch((e) => setError(String(e))).finally(() => setBusy(false)); }}>Start</button>
                              <button className="menu-item" disabled={busy || c.state !== "running"} onClick={() => { close(); setBusy(true); invoke("podman_container_stop_cmd", { id: c.id }).then(loadContainers).then(() => onChanged()).catch((e) => setError(String(e))).finally(() => setBusy(false)); }}>Stop</button>
                              <button className="menu-item" disabled={busy} onClick={() => { close(); setBusy(true); invoke("podman_container_restart_cmd", { id: c.id }).then(loadContainers).then(() => onChanged()).catch((e) => setError(String(e))).finally(() => setBusy(false)); }}>Restart</button>
                              <button className="menu-item" onClick={() => { close(); onInvestigate("container", c.id); }}>Investigate</button>
                              <button className="menu-item" onClick={() => { close(); void toggleContainer(c.id); }}>Details</button>
                              <button className="menu-item" onClick={() => { close(); logs(); }}>Logs</button>
                              <button className="menu-item" onClick={() => { close(); setTagTarget({ kind: "container", id: c.id, name: c.name }); }}>Tags…</button>
                              <div className="menu-sep" />
                              <ConfirmButton variant="menu" label="Remove" disabled={busy} onConfirm={() => { close(); setBusy(true); invoke("podman_container_remove_cmd", { id: c.id }).then(loadContainers).then(() => onChanged()).catch((e) => setError(String(e))).finally(() => setBusy(false)); }} />
                            </>
                          )}
                        </RowMenu>
                        </div></td>
                    </tr>
                    {expanded === key && (
                      <tr className="detail-row">
                        <td colSpan={6}>
                          <ContainerDetail
                            id={c.id}
                            name={c.name}
                            ports={c.ports}
                            running={c.state === "running"}
                            source="podman"
                            onLogs={logs}
                            onAction={containerAction(c.id)}
                          />
                        </td>
                      </tr>
                    )}
                  </Fragment>
                );
              })}
            {moreRows("images", 7, shownImages.length)}
            </tbody>
          </table>
        </div>
      )}

      {section === "images" && (
        <div className="table-wrap">
          <table className="table table-images">
            <colgroup>
              <col className="col-id" />
              <col className="col-repository" />
              <col className="col-tag" />
              <col className="col-size" />
              <col className="col-created" />
              <col className="col-used" />
              <col className="col-actions" />
            </colgroup>
            <thead><tr><SortTh table="images" k="id">ID</SortTh><SortTh table="images" k="repository">Repository</SortTh><SortTh table="images" k="tag">Tag</SortTh><SortTh table="images" k="size">Size</SortTh><SortTh table="images" k="created">Created</SortTh><SortTh table="images" k="containers">Used by</SortTh><th>Actions</th></tr></thead>
            <tbody>
              {shownImages.length === 0 && <tr><td colSpan={7} className="empty">{emptyText("images")}</td></tr>}
              {shownImages.slice(0, pageSize("images")).map((i) => {
                const key = `i:${i.id}`;
                return (
                  <Fragment key={key}>
                    <tr key={i.id} onClick={(e) => { if ((e.target as Element).closest("button")) return; toggleExpanded(key); }} style={{ cursor: "pointer" }}>
                      <td className="cell-id" title={i.id}>{i.id.slice(0, 12)}</td>
                      <td style={{ fontWeight: 600 }} title={i.repository}><Caret open={expanded === key} />{i.repository || "<none>"}<TagBadges kind="image" id={i.id} /></td>
                      <td>{i.tag || "<none>"}</td>
                      <td>{fmtSize(i.size)}</td>
                      <td className="cell-time" title={i.created_at}>{fmtDateTime(i.created_at)}</td>
                      <td>{i.containers === 0 ? <span className="muted">—</span> : `${i.containers} container${i.containers === 1 ? "" : "s"}`}</td>
                      <td><div className="actions"><button className="icon-btn" title="Investigate" aria-label="Investigate" onClick={() => onInvestigate("image", i.id)}><FingerprintIcon size={16} /></button><ConfirmButton label="Remove image" icon={<TrashIcon size={14} />} disabled={busy || (error !== "" && i.containers > 0)} title={error ? "The container list did not answer, so its users are unknown" : i.containers > 0 ? "Image is used by a container" : "Remove image"} onConfirm={() => { setBusy(true); invoke("podman_image_remove_cmd", { id: i.id }).then(loadImages).then(() => onChanged()).catch((e) => setError(String(e))).finally(() => setBusy(false)); }} /></div></td>
                    </tr>
                    {expanded === key && (
                      <tr className="detail-row">
                        <td colSpan={7}>
                          <div className="row-detail">
                            <div className="detail-grid">
                              <div className="detail-item"><span>Image ID</span><code>{i.id}</code></div>
                              <div className="detail-item"><span>Reference</span><code>{i.name}</code></div>
                              <div className="detail-item"><span>Repository</span><code>{i.repository || "<none>"}</code></div>
                              <div className="detail-item"><span>Tag</span><div>{i.tag || "<none>"}</div></div>
                              <div className="detail-item"><span>Size</span><div>{fmtSize(i.size)}</div></div>
                              <div className="detail-item"><span>Created</span><div>{fmtDateTime(i.created_at) || "—"}</div></div>
                              <div className="detail-item"><span>Used by</span><div>{i.containers} container{i.containers === 1 ? "" : "s"}</div></div>
                            </div>
                            <div className="detail-actions">
                              <button className="icon-plain" aria-label="Copy reference" title="Copy reference" onClick={() => navigator.clipboard?.writeText(i.name)}><CopyIcon /></button>
                              <button className="icon-plain" aria-label="Tags" title="Tags" onClick={() => setTagTarget({ kind: "image", id: i.id, name: i.name })}><TagIcon /></button>
                              <button className="icon-plain" aria-label="Inspect JSON" title="Inspect JSON" onClick={() => openInspect("image", i.name, "podman_image_inspect_cmd", { id: i.id })}><BracesIcon /></button>
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
      )}

      {section === "volumes" && (
        <>
          <VolumeTreemap
            items={shownVolumes}
            source="podman system df -v"
            action="highlight in the table"
            highlight={highlightVolume}
            onOpen={(name) => setHighlightVolume(name)}
          />
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
              <thead><tr><SortTh table="volumes" k="name">Name</SortTh><SortTh table="volumes" k="size">Size</SortTh><SortTh table="volumes" k="driver">Driver</SortTh><SortTh table="volumes" k="mountpoint">Mountpoint</SortTh><SortTh table="volumes" k="links">Used by</SortTh><th>Actions</th></tr></thead>
              <tbody>
                {shownVolumes.length === 0 && <tr><td colSpan={6} className="empty">{emptyText("volumes")}</td></tr>}
                {shownVolumes.map((v) => {
                  const key = `v:${v.name}`;
                  return (
                    <Fragment key={key}>
                      <tr key={v.name} className={highlightVolume === v.name ? "volume-row-highlight" : undefined} onMouseEnter={() => setHighlightVolume(v.name)} onMouseLeave={() => setHighlightVolume(null)} onClick={(e) => { if ((e.target as Element).closest("button")) return; toggleExpanded(key); }} style={{ cursor: "pointer" }}>
                        <td style={{ fontWeight: 600 }}><Caret open={expanded === key} />{v.name}<TagBadges kind="volume" id={v.name} /></td>
                        <td>{fmtSize(v.size)}</td>
                        <td>{v.driver}</td>
                        <td><code className="cell-mono" title={v.mountpoint}>{v.mountpoint}</code></td>
                        <td>{!v.links_known ? <span className="muted" title="The volume table could not be read">?</span> : v.links === 0 ? <span className="muted">—</span> : `${v.links} container${v.links === 1 ? "" : "s"}`}</td>
                        <td><div className="actions"><button className="icon-btn" title="Investigate" aria-label="Investigate" onClick={() => onInvestigate("volume", v.name)}><FingerprintIcon size={16} /></button><ConfirmButton label="Remove volume" icon={<TrashIcon size={14} />} disabled={busy || !v.links_known || v.links > 0} title={!v.links_known ? "Use count unknown: not removable from here" : v.links > 0 ? "Volume is used by a container" : "Remove volume"} onConfirm={() => { setBusy(true); invoke("podman_volume_remove_cmd", { name: v.name }).then(loadVolumes).then(() => onChanged()).catch((e) => setError(String(e))).finally(() => setBusy(false)); }} /></div></td>
                      </tr>
                      {expanded === key && (
                        <tr className="detail-row">
                          <td colSpan={6}>
                            <div className="row-detail">
                              <div className="detail-grid">
                                <div className="detail-item"><span>Name</span><code>{v.name}</code></div>
                                <div className="detail-item"><span>Driver</span><div>{v.driver}</div></div>
                                <div className="detail-item"><span>Mountpoint</span><code>{v.mountpoint || "—"}</code></div>
                                <div className="detail-item"><span>Size</span><div>{fmtSize(v.size)}</div></div>
                                <div className="detail-item"><span>Used by</span><div>{v.links_known ? `${v.links} container${v.links === 1 ? "" : "s"}` : "unknown"}</div></div>
                                <div className="detail-item"><span>Created</span><div>{fmtDateTime(v.created_at) || "—"}</div></div>
                              </div>
                              <div className="detail-actions">
                                <button className="icon-plain" aria-label="Copy mountpoint" title="Copy mountpoint" onClick={() => navigator.clipboard?.writeText(v.mountpoint)}><CopyIcon /></button>
                                <button className="icon-plain" aria-label="Tags" title="Tags" onClick={() => setTagTarget({ kind: "volume", id: v.name, name: v.name })}><TagIcon /></button>
                                <button className="icon-plain" aria-label="Inspect JSON" title="Inspect JSON" onClick={() => openInspect("volume", v.name, "podman_volume_inspect_cmd", { name: v.name })}><BracesIcon /></button>
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

      {section === "networks" && (
        <>
          {netView === "map" ? (
            <div className="panel" style={{ margin: "12px 24px 16px" }}>
              <div className="section-head">
                <div>
                  <h3>Network map</h3>
                  <p className="muted">Which containers sit on which network.</p>
                </div>
              </div>
              <NetworkGraph
                entries={netMap}
                meta={Object.fromEntries(containers.map((c) => [c.name, { ports: c.ports, state: c.state }]))}
                onSelectContainer={onOpenContainer}
                onSelectNetwork={(network) => onOpenNetwork(network)}
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
                <thead><tr><SortTh table="networks" k="name">Name</SortTh><th>Containers</th><SortTh table="networks" k="driver">Driver</SortTh><SortTh table="networks" k="subnet">Subnet</SortTh><th>Actions</th></tr></thead>
                <tbody>
                  {shownNetworks.length === 0 && <tr><td colSpan={5} className="empty">{emptyText("networks")}</td></tr>}
                  {netGroups.map((group) => (
                    <Fragment key={group.title}>{group.rows.length > 0 && <tr className="group-row"><td colSpan={5}>{group.title}</td></tr>}
                      {group.rows.map((n) => {
                        const key = `n:${n.name}`;
                        const builtin = n.name === BUILTIN_NETWORK;
                        const attached = netMap.find((m) => m.name === n.name)?.containers ?? [];
                        return (
                          <Fragment key={key}>
                            <tr key={n.name} onClick={(e) => { if ((e.target as Element).closest("button")) return; toggleExpanded(key); }} style={{ cursor: "pointer" }}>
                              <td style={{ fontWeight: 600 }} title={n.name}><Caret open={expanded === key} />{n.name}<TagBadges kind="network" id={n.name} /></td>
                              <td>{attached.length > 0 ? attached.length : <span className="muted">none</span>}</td>
                              <td>{n.driver}</td>
                              <td className="cell-mono" title={n.subnet}>{n.subnet || "—"}</td>
                              <td><div className="actions"><button className="icon-btn" title="Investigate" aria-label="Investigate" onClick={() => onInvestigate("network", n.name)}><FingerprintIcon size={16} /></button><ConfirmButton label="Remove network" icon={<TrashIcon size={14} />} disabled={busy || builtin} title={builtin ? "Built-in Podman network" : "Remove network"} onConfirm={() => { setBusy(true); invoke("podman_network_remove_cmd", { name: n.name }).then(loadNetworks).then(() => onChanged()).catch((e) => setError(String(e))).finally(() => setBusy(false)); }} /></div></td>
                            </tr>
                            {expanded === key && (
                              <tr className="detail-row">
                                <td colSpan={5}>
                                  <div className="row-detail">
                                    <div className="detail-grid">
                                      <div className="detail-item"><span>Name</span><code>{n.name}</code></div>
                                      <div className="detail-item"><span>Network ID</span><code>{n.id || "—"}</code></div>
                                      <div className="detail-item"><span>Driver</span><div>{n.driver}</div></div>
                                      <div className="detail-item"><span>Subnet</span><code>{n.subnet || "—"}</code></div>
                                      <div className="detail-item"><span>Gateway</span><code>{n.gateway || "—"}</code></div>
                                      <div className="detail-item"><span>Internal</span><div>{netMap.find((m) => m.name === n.name)?.internal ? "yes" : "no"}</div></div>
                                    </div>
                                    <div className="net-containers">
                                      {attached.length === 0 ? (
                                        <p className="muted">No containers attached.</p>
                                      ) : (
                                        <table className="table">
                                          <thead><tr><th>Container</th><th>IPv4</th><th>MAC</th></tr></thead>
                                          <tbody>
                                            {attached.map((c) => (
                                              <tr key={c.name} onClick={() => onOpenContainer(c.name)} style={{ cursor: "pointer" }}>
                                                <td style={{ fontWeight: 600 }}>{c.name}</td>
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
                                      <button className="icon-plain" aria-label="Tags" title="Tags" onClick={() => setTagTarget({ kind: "network", id: n.name, name: n.name })}><TagIcon /></button>
                                      <button className="icon-plain" aria-label="Inspect JSON" title="Inspect JSON" onClick={() => openInspect("network", n.name, "podman_network_inspect_cmd", { name: n.name })}><BracesIcon /></button>
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

      {resizing && (
        <Dialog label={`Resize ${resizing.name}`} width={460} onClose={() => { if (!busy) setResizing(null); }}>
          <h2>Resize {resizing.name}</h2>
          <p className="muted">
            Runs <code>podman machine set</code>, then the machine needs a restart to use the new values.
            Disk cannot be changed after creation — podman only grows it when a machine is recreated.
          </p>
          <div className="field-row">
            <div className="field">
              <label htmlFor="podman-set-cpus">CPUs</label>
              <input id="podman-set-cpus" type="number" min={1} value={resizing.cpus} onChange={(e) => setResizing({ ...resizing, cpus: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="podman-set-memory">Memory (MiB)</label>
              <input id="podman-set-memory" type="number" min={512} step={512} value={resizing.memory} onChange={(e) => setResizing({ ...resizing, memory: e.target.value })} />
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" disabled={busy} onClick={() => setResizing(null)}>Cancel</button>
            <button
              className="btn primary"
              disabled={busy || !resizing.cpus || !resizing.memory}
              onClick={async () => {
                setBusy(true);
                try {
                  await invoke<string>("podman_machine_set_cmd", {
                    name: resizing.name,
                    cpus: Number(resizing.cpus),
                    memoryMb: Number(resizing.memory),
                  });
                  setResizing(null);
                  await loadMachines();
                  onChanged();
                } catch (e) { setError(String(e)); }
                finally { setBusy(false); }
              }}
            >
              Apply
            </button>
          </div>
        </Dialog>
      )}

      {pullRef !== null && (
        <Dialog label="Pull an image" width={460} onClose={() => { if (!busy) setPullRef(null); }}>
          <h2>Pull an image</h2>
          <p className="muted">Runs <code>podman pull</code> in <strong>{machine || "the selected machine"}</strong>.</p>
          <div className="field">
            <label htmlFor="podman-pull-ref">Image reference</label>
            <input
              id="podman-pull-ref"
              value={pullRef}
              placeholder="docker.io/library/nginx:1.27"
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
              onClick={async () => {
                setBusy(true);
                try {
                  await invoke<string>("podman_image_pull_cmd", { reference: pullRef.trim() });
                  setPullRef(null);
                  await loadImages();
                  onChanged();
                } catch (e) { setError(String(e)); }
                finally { setBusy(false); }
              }}
            >
              Pull
            </button>
          </div>
        </Dialog>
      )}

      {creating && (
        <Dialog label="New Podman machine" width={440} onClose={() => { if (!creatingBusy) setCreating(null); }}>
          <h2>New Podman machine</h2>
          <p className="muted">
            Runs <code>podman machine init</code>. The first machine downloads a VM image and takes a
            few minutes; nothing is created until you press Initialize.
          </p>
          <div className="field">
            <label htmlFor="podman-machine-name">Name (optional)</label>
            <input
              id="podman-machine-name"
              value={creating.name}
              placeholder="podman-machine-default"
              autoFocus
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              onChange={(e) => setCreating({ ...creating, name: e.target.value })}
            />
          </div>
          <div className="field-row">
            <div className="field">
              <label htmlFor="podman-machine-cpus">CPUs</label>
              <input id="podman-machine-cpus" type="number" min={1} value={creating.cpus} onChange={(e) => setCreating({ ...creating, cpus: e.target.value })} />
            </div>
            <div className="field">
              <label htmlFor="podman-machine-memory">Memory (MiB)</label>
              <input id="podman-machine-memory" type="number" min={512} step={512} value={creating.memory} onChange={(e) => setCreating({ ...creating, memory: e.target.value })} />
            </div>
          </div>
          <div className="modal-actions">
            <button className="btn ghost" disabled={creatingBusy} onClick={() => setCreating(null)}>Cancel</button>
            <button className="btn primary" disabled={creatingBusy} onClick={() => void createMachine()}>
              {creatingBusy ? "Initializing…" : "Initialize machine"}
            </button>
          </div>
        </Dialog>
      )}

      {tagTarget && (
        <TagDialog kind={tagTarget.kind} id={tagTarget.id} name={tagTarget.name} onClose={() => setTagTarget(null)} />
      )}

      {logTarget && (
        <LogsModal
          name={logTarget.name}
          tail={200}
          onClose={() => setLogTarget(null)}
          onLoad={(tail) => invoke<string>("podman_container_logs_cmd", { id: logTarget.id, tail })}
        />
      )}

      {inspect && (
        <InspectModal
          kind={inspect.kind}
          name={inspect.name}
          raw={inspect.raw}
          error={inspect.error}
          onReload={() => loadInspect(inspect)}
          onClose={() => setInspect(null)}
        />
      )}
    </div>
  );
}
