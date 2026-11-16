import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ContainerDetail as Detail, ContainerStat } from "../types";
import { isKubernetesName } from "../lib/origin";
import { fmtBytes, fmtDateTime } from "../lib/format";
import { PortChips } from "./PortChips";
import { FactsGroup, Row } from "./Facts";
import { BracesIcon, FingerprintIcon, PlayIcon, RestartIcon, StopIcon, TerminalIcon } from "./icons";
import { InspectModal } from "./InspectModal";

/** Commands per runtime. Podman answers with the same `ContainerDetail` and `ContainerStat`
 *  shapes, so the row is one component for both lists instead of a second vocabulary. */
const SOURCE = {
  docker: { detail: "container_detail_cmd", stats: "container_stats_cmd", inspect: "inspect_cmd" },
  podman: { detail: "podman_container_detail_cmd", stats: "podman_container_stats_cmd", inspect: "podman_container_inspect_json_cmd" },
} as const;

/** Expanded table row: the same grouped facts as the entity page, not a second vocabulary.
 *  `onOpen` is omitted for Podman, which has no Investigator page yet. */
export function ContainerDetail({ id, name, ports, running, onLogs, onAction, onOpen, onOpenCluster, source = "docker" }: {
  id: string;
  name: string;
  ports: string;
  running: boolean;
  onLogs: () => void;
  onAction: (action: "start" | "stop" | "restart") => void;
  onOpen?: () => void;
  /** Opens the profile's Kubernetes page; offered only for a kubelet container. */
  onOpenCluster?: () => void;
  source?: keyof typeof SOURCE;
}) {
  const commands = SOURCE[source];
  const [detail, setDetail] = useState<Detail | null>(null);
  const [stat, setStat] = useState<ContainerStat | null>(null);
  const [inspect, setInspect] = useState<{ raw: string | null; error: string | null } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const d = await invoke<Detail>(commands.detail, { id });
        if (alive) setDetail(d);
      } catch (e) {
        if (alive) setError(String(e));
      }
    })();
    if (running) {
      // One row is expanded at a time, so ask for that container: `docker stats --no-stream`
      // over the whole list measured ~1.9 s to fill one line, and the one-shot command that
      // Sherlock already uses answers the same question for one child.
      if (source === "docker") {
        invoke<ContainerStat>("container_stats_one_cmd", { id })
          .then((s) => { if (alive) setStat(s); })
          .catch(() => { /* stats are best effort */ });
      } else {
        // Podman's stats row carries the 12-character id; the table hands us the full one.
        invoke<ContainerStat[]>(commands.stats)
          .then((stats) => { if (alive) setStat(stats.find((s) => s.id === id || id.startsWith(s.id) || s.name === name) ?? null); })
          .catch(() => { /* stats are best effort */ });
      }
    } else {
      setStat(null);
    }
    return () => { alive = false; };
  }, [id, name, running, source, commands.detail, commands.stats]);

  /** The raw payload is a window, like Logs: the row keeps one glyph, not a sheet. */
  function loadInspect() {
    setInspect({ raw: null, error: null });
    invoke<string>(commands.inspect, { id })
      .then((raw) => setInspect((prev) => (prev ? { ...prev, raw } : prev)))
      .catch((e) => setInspect((prev) => (prev ? { ...prev, error: String(e) } : prev)));
  }

  if (error) return <div className="row-detail"><p className="muted">{error}</p></div>;

  return (
    <div className="row-detail">
      <div className="cd-head">
        {stat && (
          <div className="cd-live">
            <span className="cd-live-item"><span className="cd-live-label">CPU</span> {stat.cpu.toFixed(1)}%
              <span className="cd-bar"><span style={{ width: `${Math.min(100, stat.cpu)}%` }} /></span>
            </span>
            <span className="cd-live-item"><span className="cd-live-label">Memory</span> {fmtBytes(stat.mem)}
              {stat.mem_limit ? <span className="muted"> of {fmtBytes(stat.mem_limit)} ({stat.mem_pct.toFixed(0)}%)</span> : null}
            </span>
            <span className="cd-live-item"><span className="cd-live-label">PIDs</span> {stat.pids}</span>
          </div>
        )}
        <div className="cd-actions">
          <button className="icon-plain" onClick={onLogs} aria-label="Logs" title="Logs">
            <TerminalIcon />
          </button>
          <button
            className="icon-plain"
            onClick={() => onAction(running ? "stop" : "start")}
            aria-label={running ? "Stop" : "Start"}
            title={running ? "Stop" : "Start"}
          >
            {running ? <StopIcon /> : <PlayIcon />}
          </button>
          <button className="icon-plain" onClick={() => onAction("restart")} aria-label="Restart" title="Restart">
            <RestartIcon />
          </button>
          {onOpen && (
            <button className="icon-plain" onClick={onOpen} aria-label="Open in Sherlock" title="Open in Sherlock">
              <FingerprintIcon />
            </button>
          )}
          <button className="icon-plain" aria-label="Inspect JSON" title="Inspect JSON" onClick={loadInspect}>
            <BracesIcon />
          </button>
        </div>
      </div>

      <div className="row-detail-facts">
        <FactsGroup title="Lifecycle">
          <Row label="Status">{running ? "running" : "stopped"}{detail?.health ? <span className="muted"> · {detail.health}</span> : null}</Row>
          <Row label="Started">{detail ? fmtDateTime(detail.started_at) : "—"}</Row>
          <Row label="Restarts">{detail ? `${detail.restart_policy || "no"} · ${detail.restart_count} total` : "—"}</Row>
          {detail?.oom_killed && <Row label="Last exit"><span className="state-bad">OOM-killed</span></Row>}
        </FactsGroup>
        <FactsGroup title="Identity">
          <Row label="Container" copy={name}><code>{name}</code></Row>
          {isKubernetesName(name) && (
            <Row label="Origin">
              <span className="k8s-chip" title="Created by the profile's Kubernetes cluster">k8s</span>
              {onOpenCluster
                ? <button className="inv-link" onClick={onOpenCluster}>Created by k3s — open Kubernetes</button>
                : "Created by the profile's k3s cluster"}
            </Row>
          )}
          <Row label="ID" mono copy={id}><code>{id}</code></Row>
          <Row label="Image">{detail?.image || "—"}</Row>
          <Row label="Created">{detail ? fmtDateTime(detail.created) : "—"}</Row>
        </FactsGroup>
        <FactsGroup title="Runtime">
          <Row label="Command" mono copy={detail?.command}><code title={detail?.command}>{detail?.command || "—"}</code></Row>
          <Row label="Working dir" mono copy={detail?.workdir}><code>{detail?.workdir || "—"}</code></Row>
          <Row label="User" mono><code>{detail?.user || "root"}</code></Row>
          <Row label="Hostname" mono copy={detail?.hostname}><code>{detail?.hostname || "—"}</code></Row>
        </FactsGroup>
        <FactsGroup title="Limits">
          <Row label="Memory">{detail?.memory_limit ? fmtBytes(detail.memory_limit) : "unlimited"}</Row>
          <Row label="CPU">{detail?.nano_cpus ? `${(detail.nano_cpus / 1e9).toFixed(2)} cores` : "unlimited"}</Row>
          <Row label="PID" mono>{detail?.pid ? <code>{detail.pid}</code> : "—"}</Row>
        </FactsGroup>
      </div>

      <div className="row-detail-relations">
        <div className="cd-row">
          <span className="cd-label">Ports</span>
          <PortChips ports={ports} empty="none" />
        </div>
        <div className="cd-row">
          <span className="cd-label">Networks</span>
          <div className="cd-chips">
            {detail?.networks.length
              ? detail.networks.map((n) => <span className="cd-chip" key={n.name}>{n.name}<span className="muted"> · {n.ip || "no ip"}</span></span>)
              : <span className="muted">none</span>}
          </div>
        </div>
        <div className="cd-row">
          <span className="cd-label">Mounts</span>
          <div className="cd-chips">
            {detail?.mounts.length
              ? detail.mounts.map((m) => (
                  <span className="cd-chip" key={`${m.source}-${m.destination}`}>
                    <code>{m.source || "(anonymous)"}</code><span className="muted"> → {m.destination} · {m.kind}</span>
                  </span>
                ))
              : <span className="muted">none</span>}
          </div>
        </div>
        <div className="cd-row">
          <span className="cd-label">Environment</span>
          <span className="muted">
            {detail ? `${detail.env_count} variable${detail.env_count === 1 ? "" : "s"}` : "—"}
            {detail && detail.env_count > 0 && onOpen && <> · <button className="inv-link" onClick={onOpen}>values in Sherlock</button></>}
          </span>
        </div>
      </div>

      {inspect && (
        <InspectModal
          kind="container"
          name={name}
          raw={inspect.raw}
          error={inspect.error}
          onReload={loadInspect}
          onClose={() => setInspect(null)}
        />
      )}
    </div>
  );
}
