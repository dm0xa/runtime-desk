import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ClusterInfo, KubeRow } from "../types";
import { LogsModal } from "./LogsModal";
import { RowMenu } from "./RowMenu";
import { Dialog } from "./Dialog";
import { TerminalIcon } from "./icons";

/** The resource lists the backend answers for, in the order the chips read. */
const KINDS = [
  { kind: "pods", label: "Pods" },
  { kind: "deployments", label: "Deployments" },
  { kind: "statefulsets", label: "StatefulSets" },
  { kind: "daemonsets", label: "DaemonSets" },
  { kind: "services", label: "Services" },
  { kind: "nodes", label: "Nodes" },
] as const;

type KubeKind = (typeof KINDS)[number]["kind"];

type Column = {
  key: keyof KubeRow | "restarts";
  label: string;
  /** Monospace, right-sized digits: addresses, counts, ages. */
  mono?: boolean;
};

/** One table, six shapes: the columns a kind actually has, so a Node row does not print an
 *  empty Namespace cell. `restarts` only exists for Pods. */
const COLUMNS: Record<KubeKind, Column[]> = {
  pods: [
    { key: "namespace", label: "Namespace" },
    { key: "name", label: "Name" },
    { key: "ready", label: "Ready", mono: true },
    { key: "status", label: "Status" },
    { key: "restarts", label: "Restarts", mono: true },
    { key: "detail", label: "Node" },
    { key: "age", label: "Age", mono: true },
  ],
  deployments: [
    { key: "namespace", label: "Namespace" },
    { key: "name", label: "Name" },
    { key: "ready", label: "Ready", mono: true },
    { key: "status", label: "Status" },
    { key: "detail", label: "Images" },
    { key: "age", label: "Age", mono: true },
  ],
  statefulsets: [
    { key: "namespace", label: "Namespace" },
    { key: "name", label: "Name" },
    { key: "ready", label: "Ready", mono: true },
    { key: "status", label: "Status" },
    { key: "detail", label: "Images" },
    { key: "age", label: "Age", mono: true },
  ],
  daemonsets: [
    { key: "namespace", label: "Namespace" },
    { key: "name", label: "Name" },
    { key: "ready", label: "Ready", mono: true },
    { key: "status", label: "Status" },
    { key: "detail", label: "Images" },
    { key: "age", label: "Age", mono: true },
  ],
  services: [
    { key: "namespace", label: "Namespace" },
    { key: "name", label: "Name" },
    { key: "ready", label: "Cluster IP", mono: true },
    { key: "status", label: "Type" },
    { key: "detail", label: "Ports" },
    { key: "age", label: "Age", mono: true },
  ],
  nodes: [
    { key: "name", label: "Name" },
    { key: "ready", label: "Ready" },
    { key: "status", label: "Roles" },
    { key: "detail", label: "Kubelet" },
    { key: "age", label: "Age", mono: true },
  ],
};

type ClusterVerb = "stop" | "reset" | "delete";

/** Menu wording, then what the same row reads once armed. Delete and reset change or remove
 *  the cluster, so no verb runs on the first click. */
const CLUSTER_ACTIONS: { verb: ClusterVerb; label: string; armed: string; title: string }[] = [
  { verb: "stop", label: "Stop Kubernetes", armed: "Confirm stop?", title: "Stops k3s in the VM. Containers and the Docker runtime keep running; the kubeconfig entry stays." },
  { verb: "reset", label: "Reset cluster", armed: "Confirm reset?", title: "Reinstalls k3s in place. Workloads are lost; the kubeconfig entry stays." },
  { verb: "delete", label: "Delete cluster", armed: "Confirm delete?", title: "Removes the cluster and its kubeconfig entry. The VM and its containers keep running." },
];

const ALL_NAMESPACES = "*";
const INFO_EVERY_MS = 30000;
const ROWS_EVERY_MS = 15000;
/** Pod statuses that mean the object is doing what it was asked to do. */
const HEALTHY: Record<string, true> = { Running: true, Completed: true, Succeeded: true, Available: true, Ready: true };

function value(row: KubeRow, key: Column["key"]): string {
  if (key === "restarts") return row.restarts === null ? "—" : String(row.restarts);
  return row[key];
}

/**
 * The Kubernetes surface: what Colima's k3s is running, read with the host `kubectl` against
 * the profile's own context. Read-only by design — the page reports, it does not apply
 * manifests — apart from provisioning the cluster itself, which is a Colima command.
 */
export function KubernetesPage({ profile, profileRunning, refreshNonce }: {
  profile: string;
  profileRunning: boolean;
  /** Bumped by the header Refresh, which owns every page's reload. */
  refreshNonce: number;
}) {
  const [kind, setKind] = useState<KubeKind>("pods");
  /** `*` is "all namespaces": kubectl's `-A`, not a namespace that could exist. */
  const [namespace, setNamespace] = useState<string>(ALL_NAMESPACES);
  const [info, setInfo] = useState<ClusterInfo | null>(null);
  const [rows, setRows] = useState<KubeRow[]>([]);
  const [loadingRows, setLoadingRows] = useState(false);
  const [busy, setBusy] = useState(false);
  const [armed, setArmed] = useState<ClusterVerb | null>(null);
  /** Delete and reset destroy cluster state; they ask for the context name instead of a second
   *  click, the same contract the profile delete uses. `stop` stays a two-click arm. */
  const [typed, setTyped] = useState<{ verb: ClusterVerb; value: string } | null>(null);
  const [logTarget, setLogTarget] = useState<{ namespace: string; pod: string } | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);

  // The cluster came from Colima: switching profile means a different k3s, a different
  // kubeconfig context, and namespaces that no longer exist here.
  useEffect(() => {
    setInfo(null);
    setRows([]);
    setError("");
    setNamespace(ALL_NAMESPACES);
  }, [profile]);

  useEffect(() => {
    if (!profileRunning) {
      setInfo(null);
      return;
    }
    let alive = true;
    const read = async () => {
      // Six kubectl processes per call: a backgrounded window must not keep spawning them.
      if (document.hidden) return;
      try {
        const next = await invoke<ClusterInfo>("k8s_cluster_cmd", { profile });
        if (alive) setInfo(next);
      } catch (e) {
        if (alive) setError(String(e));
      }
    };
    void read();
    const id = setInterval(() => void read(), INFO_EVERY_MS);
    document.addEventListener("visibilitychange", read);
    return () => { alive = false; clearInterval(id); document.removeEventListener("visibilitychange", read); };
  }, [profile, profileRunning, refreshNonce, reload]);

  const reachable = !!info?.enabled && !!info?.reachable;
  /** Counts may be shown when they were read — now, or at the timestamp carried over from the
   *  last answer. Numbers nobody counted stay `—`. */
  const counts = info && (info.reachable || info.read_at != null) ? info : null;
  const lastRead = info && !info.reachable && info.read_at != null
    ? new Date(info.read_at * 1000).toLocaleTimeString()
    : null;

  useEffect(() => {
    // While the cluster is off this would be one failing kubectl per 15 s for a view that
    // already says why it is empty.
    if (!profileRunning || !reachable) {
      setRows([]);
      return;
    }
    let alive = true;
    const read = async () => {
      if (document.hidden) return;
      setLoadingRows(true);
      try {
        const next = await invoke<KubeRow[]>("k8s_resources_cmd", {
          profile,
          kind,
          namespace: namespace === ALL_NAMESPACES ? null : namespace,
        });
        if (alive) { setRows(next); setError(""); }
      } catch (e) {
        if (alive) setError(String(e));
      } finally {
        if (alive) setLoadingRows(false);
      }
    };
    void read();
    const id = setInterval(() => void read(), ROWS_EVERY_MS);
    document.addEventListener("visibilitychange", read);
    return () => { alive = false; clearInterval(id); document.removeEventListener("visibilitychange", read); };
  }, [profile, profileRunning, reachable, kind, namespace, refreshNonce, reload]);

  // A namespace deleted on the server must not leave the table asking for it forever.
  useEffect(() => {
    if (!info || namespace === ALL_NAMESPACES) return;
    if (!info.namespaces.includes(namespace)) setNamespace(ALL_NAMESPACES);
  }, [info, namespace]);

  const act = async (action: "start" | ClusterVerb) => {
    setBusy(true);
    setArmed(null);
    setError("");
    try {
      await invoke<string>("k8s_cluster_action_cmd", { profile, action });
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
      setReload((n) => n + 1);
    }
  };

  const columns = COLUMNS[kind];
  // Pods are the one kind with a per-row action worth a column: the reason a pod is not
  // ready is almost always in its container's log.
  const showLogs = kind === "pods";
  const emptyLabel = loadingRows
    ? "Reading…"
    : info && !info.reachable
      ? "The cluster did not answer — nothing was read"
      : `No ${KINDS.find((k) => k.kind === kind)?.label.toLowerCase() ?? "objects"}`;

  if (!profileRunning) {
    return (
      <div className="kube-page">
        <section className="panel">
          <h3>Kubernetes</h3>
          <p className="muted">Profile <code>{profile}</code> is stopped. Start it to read its cluster.</p>
        </section>
      </div>
    );
  }

  if (info && !info.enabled && info.error) {
    return (
      <div className="kube-page">
        <section className="panel">
          <h3>kubectl could not read your kubeconfig</h3>
          <p className="muted">
            The cluster may well be running; <code>kubectl</code> failed before it could look. Fix the
            kubeconfig, then recheck. Enabling Kubernetes would not help here.
          </p>
          <pre className="logs">{info.error}</pre>
          <div style={{ display: "flex", gap: 8, marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={() => setReload((n) => n + 1)}>Recheck</button>
          </div>
        </section>
      </div>
    );
  }

  if (info && !info.enabled) {
    return (
      <div className="kube-page">
        <section className="panel">
          <h3>Kubernetes is not enabled on this profile</h3>
          <p className="muted">
            Colima runs a single-node k3s <em>inside</em> the VM. Enabling it installs the cluster on the
            running VM and registers a <code>{info?.context ?? "colima"}</code> context in your kubeconfig;
            containers keep running. It takes about a minute.
          </p>
          <pre className="logs">{`colima kubernetes start -p ${profile}`}</pre>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 12 }}>
            <button className="btn primary" disabled={busy} onClick={() => void act("start")}>
              {busy ? "Enabling…" : "Enable Kubernetes"}
            </button>
            <button className="btn ghost" disabled={busy} onClick={() => setReload((n) => n + 1)}>Recheck</button>
            <span className="help" tabIndex={0} data-tip="Runs `colima kubernetes start` for the selected profile. Colima installs k3s in the existing VM, points your kubeconfig at it and activates the context; nothing on the host is rebuilt. The context is named after the Lima instance: colima for the default profile, colima-<profile> otherwise.">?</span>
          </div>
          {error && <p className="muted">{error}</p>}
        </section>
      </div>
    );
  }

  const typedEntry = typed ? CLUSTER_ACTIONS.find((a) => a.verb === typed.verb) : null;

  return (
    <div className="kube-page">
      {typed && typedEntry && (
        <Dialog label={typedEntry.label} width={460} onClose={() => { if (!busy) setTyped(null); }}>
          <h2>{typedEntry.label}</h2>
          <p className="muted">{typedEntry.title}</p>
          <p className="muted">Type <code>{info?.context ?? "colima"}</code> to confirm.</p>
          <div className="field">
            <input
              value={typed.value}
              autoFocus
              autoCorrect="off"
              autoCapitalize="off"
              spellCheck={false}
              aria-label="Type the context name to confirm"
              placeholder={info?.context ?? "colima"}
              onChange={(e) => setTyped({ ...typed, value: e.target.value })}
            />
          </div>
          <div className="modal-actions">
            <button className="btn ghost" disabled={busy} onClick={() => setTyped(null)}>Cancel</button>
            <button
              className="btn danger"
              disabled={busy || typed.value !== (info?.context ?? "colima")}
              onClick={() => { const verb = typed.verb; setTyped(null); void act(verb); }}
            >
              {typed.verb === "delete" ? "Delete cluster" : "Reset cluster"}
            </button>
          </div>
        </Dialog>
      )}
      <section className="panel strip-panel">
        <div className="section-head">
          <div>
            <h3>Cluster</h3>
            <p className="muted">
              {info ? <>Context <code>{info.context}</code> · read through kubectl</> : "Reading the cluster…"}
            </p>
          </div>
          {reachable && (
            <RowMenu label="Cluster actions">
              {(close) => (
                <>
                  {CLUSTER_ACTIONS.map((entry) => (
                    <button
                      key={entry.verb}
                      className={`menu-item ${armed === entry.verb ? "danger" : ""}`}
                      disabled={busy}
                      title={entry.title}
                      onClick={() => {
                        // The two destructive verbs need the name typed, not just a second click.
                        if (entry.verb === "delete" || entry.verb === "reset") {
                          close();
                          setTyped({ verb: entry.verb, value: "" });
                          return;
                        }
                        if (armed === entry.verb) { close(); void act(entry.verb); return; }
                        setArmed(entry.verb);
                      }}
                    >
                      {armed === entry.verb ? entry.armed : entry.label}
                    </button>
                  ))}
                </>
              )}
            </RowMenu>
          )}
        </div>
        <div className="strip-items kube-strip">
          <div className="strip-item">
            <span className="strip-label">Nodes</span>
            <span className={`strip-value ${info && info.nodes > 0 && info.nodes_ready < info.nodes ? "state-warn" : ""}`}>
              {counts ? `${counts.nodes_ready}/${counts.nodes}` : "—"}
            </span>
            <span className={`strip-sub ${info && info.nodes > 0 && info.nodes_ready === info.nodes ? "state-ok" : ""}`}>ready</span>
          </div>
          <div className="strip-item">
            <span className="strip-label">Pods</span>
            <span className="strip-value">{counts ? `${counts.pods_running}/${counts.pods}` : "—"}</span>
            <span className="strip-sub">running</span>
          </div>
          <div className="strip-item">
            <span className="strip-label">Deployments</span>
            <span className={`strip-value ${info && info.deployments > 0 && info.deployments_ready < info.deployments ? "state-warn" : ""}`}>
              {counts ? `${counts.deployments_ready}/${counts.deployments}` : "—"}
            </span>
            <span className="strip-sub">available</span>
          </div>
          <div className="strip-item">
            <span className="strip-label">Kubernetes</span>
            <span className="strip-value kube-version">{counts?.version ?? "—"}</span>
            <span className="strip-sub">{counts ? `${counts.namespaces.length} namespace${counts.namespaces.length === 1 ? "" : "s"}` : "not read"}</span>
          </div>
        </div>
        {lastRead && (
          <p className="strip-note state-warn">
            These counters are the last answer, read at {lastRead} — the cluster is not answering now.
          </p>
        )}
        {info?.error && (
          <p className="strip-note">
            {info.error}{" "}
            <button className="inv-link" disabled={busy} onClick={() => { setReload((n) => n + 1); }}>Recheck</button>
          </p>
        )}
        {error && <p className="strip-note">{error}</p>}
      </section>

      <div className="toolbar kube-toolbar">
        <div className="chips" role="tablist" aria-label="Resource kind">
          {KINDS.map((entry) => (
            <button
              key={entry.kind}
              role="tab"
              aria-selected={kind === entry.kind}
              className={`chip ${kind === entry.kind ? "active" : ""}`}
              onClick={() => setKind(entry.kind)}
            >
              {entry.label}
            </button>
          ))}
        </div>
        <div className="chips">
          <button className={`chip ${namespace === ALL_NAMESPACES ? "active" : ""}`} onClick={() => setNamespace(ALL_NAMESPACES)}>
            All namespaces
          </button>
          {(info?.namespaces ?? []).map((name) => (
            <button key={name} className={`chip ${namespace === name ? "active" : ""}`} onClick={() => setNamespace(name)}>
              {name}
            </button>
          ))}
        </div>
      </div>

      <div className="table-wrap kube-table-wrap">
        <table className="table table-kube">
          <thead>
            <tr>
              {columns.map((c) => <th key={c.key}>{c.label}</th>)}
              {showLogs && <th>Logs</th>}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr><td colSpan={columns.length + (showLogs ? 1 : 0)} className="empty">{emptyLabel}</td></tr>
            )}
            {rows.map((row) => (
              <tr key={`${row.namespace}:${row.name}`}>
                {columns.map((c) => {
                  const text = value(row, c.key);
                  const cls = [
                    c.mono ? "cell-mono" : "",
                    c.key === "name" ? "kube-name" : "",
                    c.key === "status" && HEALTHY[text] !== true ? "kube-bad" : "",
                    c.key === "ready" && kind === "nodes" ? (text === "Ready" ? "kube-ok" : "kube-bad") : "",
                  ].filter(Boolean).join(" ");
                  return (
                    <td key={c.key} className={cls || undefined} title={text}>
                      {text || "—"}
                    </td>
                  );
                })}
                {showLogs && (
                  <td className="kube-actions">
                    <button
                      className="icon-btn"
                      aria-label={`Logs for ${row.name}`}
                      title="Logs"
                      onClick={() => setLogTarget({ namespace: row.namespace, pod: row.name })}
                    >
                      <TerminalIcon size={15} />
                    </button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {logTarget && (
        <LogsModal
          name={logTarget.namespace === "—" ? logTarget.pod : `${logTarget.namespace}/${logTarget.pod}`}
          tail={200}
          onClose={() => setLogTarget(null)}
          onLoad={(tail) =>
            invoke<string>("k8s_logs_cmd", {
              profile,
              namespace: logTarget.namespace === "—" ? "" : logTarget.namespace,
              pod: logTarget.pod,
              tail,
            }).catch((e) => String(e))
          }
        />
      )}
    </div>
  );
}
