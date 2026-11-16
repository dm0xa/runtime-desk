//! Kubernetes, read through the host `kubectl` against the cluster Colima provisioned.
//!
//! Colima installs k3s inside the VM and merges a kubeconfig whose cluster, context and user
//! are named after the *Lima instance*, not the profile label: `colima` for the default profile
//! and `colima-<profile>` for a named one (colima's `config.ProfileFromName`). The app therefore
//! never guesses and never uses the user's current context: every call passes
//! `--context <instance>`, so two profiles cannot answer for each other.
//!
//! Nothing here is required for the rest of the console: a machine without kubectl, or a
//! profile started without Kubernetes, is a normal state the page explains.

use serde::Serialize;
use serde_json::Value;
use std::process::Command;

use crate::cleanup::{now_secs, parse_epoch};

/// The resource lists the page can show. Anything else is a programming error, not user input.
pub const KINDS: [&str; 6] = ["pods", "deployments", "statefulsets", "daemonsets", "services", "nodes"];

pub fn kubectl_installed() -> bool {
    crate::tools::which_bin("kubectl").is_some()
}

/// One kubectl run. `--request-timeout` is set because a VM that is stopping leaves the API
/// server answering TCP and never replying: without it the page hangs instead of explaining.
fn kubectl(args: &[&str]) -> Result<String, String> {
    let Some(bin) = crate::tools::which_bin("kubectl") else {
        return Err("kubectl is not installed".to_string());
    };
    let out = Command::new(bin)
        .arg("--request-timeout=10s")
        .args(args)
        .output()
        .map_err(|e| format!("failed to spawn kubectl: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(clean_error(&String::from_utf8_lossy(&out.stderr)))
    }
}

/// kubectl prefixes connection failures with several lines of advice; the first line that is
/// not an empty separator is the one worth showing.
fn clean_error(raw: &str) -> String {
    let text = raw
        .lines()
        .map(str::trim)
        .filter(|l| !l.is_empty())
        .collect::<Vec<_>>()
        .join(" ");
    if text.is_empty() {
        "kubectl failed with no output".to_string()
    } else {
        text.chars().take(400).collect()
    }
}

/// The kubeconfig context Colima writes for a profile: the Lima instance name, which is
/// `colima` for the default profile and `colima-<profile>` for a named one. Verified against
/// colima 0.10.3: enabling Kubernetes on `default` produces exactly one context, `colima`.
pub fn context_name(profile: &str) -> String {
    let name = profile.trim_start_matches("colima-");
    let instance = if name.is_empty() { "colima" } else { crate::colima::instance_name(name) };
    if instance == "colima" { "colima".to_string() } else { format!("colima-{instance}") }
}

#[derive(Serialize, Default, Clone)]
pub struct ClusterInfo {
    pub context: String,
    /// Colima created a kubeconfig entry for this profile, so the VM has a cluster.
    pub enabled: bool,
    /// The API server answered.
    pub reachable: bool,
    pub version: Option<String>,
    pub nodes: u32,
    pub nodes_ready: u32,
    pub pods: u32,
    pub pods_running: u32,
    pub deployments: u32,
    pub deployments_ready: u32,
    pub namespaces: Vec<String>,
    pub error: Option<String>,
    /// Unix seconds of the last successful read, carried over when the cluster stops
    /// answering so the strip can say "last read 14:03" instead of inventing zeros.
    pub read_at: Option<u64>,
}

#[derive(Serialize)]
pub struct KubeRow {
    pub namespace: String,
    pub name: String,
    pub ready: String,
    pub status: String,
    pub restarts: Option<u64>,
    pub detail: String,
    pub age: String,
}

fn str_at<'a>(value: &'a Value, path: &[&str]) -> Option<&'a str> {
    let mut node = value;
    for key in path {
        node = node.get(*key)?;
    }
    node.as_str()
}

fn num_at(value: &Value, path: &[&str]) -> u64 {
    let mut node = value;
    for key in path {
        node = match node.get(*key) {
            Some(next) => next,
            None => return 0,
        };
    }
    node.as_u64().unwrap_or(0)
}

fn items(raw: &str) -> Result<Vec<Value>, String> {
    let parsed: Value = serde_json::from_str(raw).map_err(|e| format!("unreadable kubectl JSON: {e}"))?;
    Ok(parsed.get("items").and_then(Value::as_array).cloned().unwrap_or_default())
}

/// kubectl prints `2d`, `5m`, `3w`; the same shape keeps the column narrow.
fn humanize_age(secs: u64) -> String {
    const MINUTE: u64 = 60;
    const HOUR: u64 = 3600;
    const DAY: u64 = 86400;
    match secs {
        0..=59 => format!("{secs}s"),
        60..=3599 => format!("{}m", secs / MINUTE),
        3600..=86399 => format!("{}h", secs / HOUR),
        86400..=604799 => format!("{}d", secs / DAY),
        604800..=2591999 => format!("{}w", secs / (DAY * 7)),
        2592000..=31535999 => format!("{}mo", secs / (DAY * 30)),
        _ => format!("{}y", secs / (DAY * 365)),
    }
}

/// A creation timestamp that kubernetes did not stamp (or stamped in year 1) reads as unknown
/// instead of a wild age.
fn age_of(created: Option<&str>) -> String {
    let Some(stamp) = created else {
        return "—".to_string();
    };
    let Some(then) = parse_epoch(stamp) else {
        return "—".to_string();
    };
    let now = now_secs() as i64;
    humanize_age((now - then).max(0) as u64)
}

fn row(namespace: &str, name: &str, ready: String, status: String, restarts: Option<u64>, detail: String, created: Option<&str>) -> KubeRow {
    KubeRow {
        namespace: if namespace.is_empty() { "—".to_string() } else { namespace.to_string() },
        name: name.to_string(),
        ready,
        status,
        restarts,
        detail,
        age: age_of(created),
    }
}

fn images_of(item: &Value) -> (Vec<String>, usize) {
    let list = item
        .pointer("/spec/template/spec/containers")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let total = list.len();
    let images: Vec<String> = list
        .iter()
        .filter_map(|c| c.get("image").and_then(Value::as_str).map(str::to_string))
        .collect();
    (images, total)
}

/// `repo:tag` only: the registry host is noise in a table cell.
fn short_image(image: &str) -> String {
    let without_digest = image.split('@').next().unwrap_or(image);
    without_digest.rsplit('/').next().unwrap_or(without_digest).to_string()
}

fn image_summary(images: &[String], total: usize) -> String {
    if total == 0 {
        return "—".to_string();
    }
    let mut shown: Vec<String> = images.iter().take(2).map(|i| short_image(i)).collect();
    if total > shown.len() {
        shown.push(format!("+{}", total - shown.len()));
    }
    shown.join(", ")
}

fn pod_row(item: &Value) -> KubeRow {
    let containers = item.pointer("/spec/containers").and_then(Value::as_array).map(Vec::len).unwrap_or(0);
    let statuses = item.pointer("/status/containerStatuses").and_then(Value::as_array).cloned().unwrap_or_default();
    let ready = statuses.iter().filter(|c| c.get("ready").and_then(Value::as_bool) == Some(true)).count();
    let restarts: u64 = statuses.iter().map(|c| num_at(c, &["restartCount"])).sum();
    // A waiting reason (CrashLoopBackOff, ImagePullBackOff) is the fact a person needs; the
    // phase only says Running/Pending and hides that every container is crash-looping.
    let waiting = statuses
        .iter()
        .find_map(|c| str_at(c, &["state", "waiting", "reason"]))
        .map(str::to_string);
    let status = waiting
        .or_else(|| str_at(item, &["status", "reason"]).map(str::to_string))
        .or_else(|| str_at(item, &["status", "phase"]).map(str::to_string))
        .unwrap_or_else(|| "Unknown".to_string());
    let total = containers.max(statuses.len());
    row(
        str_at(item, &["metadata", "namespace"]).unwrap_or(""),
        str_at(item, &["metadata", "name"]).unwrap_or(""),
        format!("{ready}/{total}"),
        status,
        Some(restarts),
        str_at(item, &["spec", "nodeName"]).unwrap_or("—").to_string(),
        str_at(item, &["metadata", "creationTimestamp"]),
    )
}

fn workload_row(item: &Value, kind: &str) -> KubeRow {
    let desired = if kind == "daemonsets" {
        num_at(item, &["status", "desiredNumberScheduled"])
    } else {
        let spec = num_at(item, &["spec", "replicas"]);
        if spec > 0 { spec } else { num_at(item, &["status", "replicas"]) }
    };
    let ready = if kind == "daemonsets" {
        num_at(item, &["status", "numberReady"])
    } else {
        num_at(item, &["status", "readyReplicas"])
    };
    let (images, total) = images_of(item);
    let status = if ready >= desired { "Available" } else { "Progressing" };
    row(
        str_at(item, &["metadata", "namespace"]).unwrap_or(""),
        str_at(item, &["metadata", "name"]).unwrap_or(""),
        format!("{ready}/{desired}"),
        status.to_string(),
        None,
        image_summary(&images, total),
        str_at(item, &["metadata", "creationTimestamp"]),
    )
}

fn service_row(item: &Value) -> KubeRow {
    let ports = item
        .pointer("/spec/ports")
        .and_then(Value::as_array)
        .map(|list| {
            list.iter()
                .filter_map(|p| {
                    let port = num_at(p, &["port"]);
                    let target = num_at(p, &["targetPort"]);
                    let node = num_at(p, &["nodePort"]);
                    let proto = str_at(p, &["protocol"]).unwrap_or("TCP");
                    Some(if node > 0 {
                        format!("{port}:{node}→{target}/{proto}")
                    } else if target > 0 && target != port {
                        format!("{port}→{target}/{proto}")
                    } else {
                        format!("{port}/{proto}")
                    })
                })
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    let ip = str_at(item, &["spec", "clusterIP"]).unwrap_or("—").to_string();
    row(
        str_at(item, &["metadata", "namespace"]).unwrap_or(""),
        str_at(item, &["metadata", "name"]).unwrap_or(""),
        ip,
        str_at(item, &["spec", "type"]).unwrap_or("ClusterIP").to_string(),
        None,
        if ports.is_empty() { "—".to_string() } else { ports.join(", ") },
        str_at(item, &["metadata", "creationTimestamp"]),
    )
}

fn node_roles(item: &Value) -> String {
    let Some(labels) = item.pointer("/metadata/labels").and_then(Value::as_object) else {
        return "<none>".to_string();
    };
    let mut roles: Vec<String> = labels
        .keys()
        .filter_map(|k| k.strip_prefix("node-role.kubernetes.io/"))
        .filter(|r| !r.is_empty())
        .map(str::to_string)
        .collect();
    roles.sort();
    if roles.is_empty() {
        "<none>".to_string()
    } else {
        roles.join(",")
    }
}

fn node_row(item: &Value) -> KubeRow {
    let ready = item
        .pointer("/status/conditions")
        .and_then(Value::as_array)
        .and_then(|list| {
            list.iter()
                .find(|c| str_at(c, &["type"]) == Some("Ready"))
                .and_then(|c| str_at(c, &["status"]))
        })
        .map(|status| if status == "True" { "Ready" } else { "NotReady" })
        .unwrap_or("Unknown");
    row(
        "",
        str_at(item, &["metadata", "name"]).unwrap_or(""),
        ready.to_string(),
        node_roles(item),
        None,
        str_at(item, &["status", "nodeInfo", "kubeletVersion"]).unwrap_or("—").to_string(),
        str_at(item, &["metadata", "creationTimestamp"]),
    )
}

fn to_rows(kind: &str, raw: &str) -> Result<Vec<KubeRow>, String> {
    let mut rows: Vec<KubeRow> = items(raw)?
        .iter()
        .map(|item| match kind {
            "pods" => pod_row(item),
            "deployments" | "statefulsets" | "daemonsets" => workload_row(item, kind),
            "services" => service_row(item),
            _ => node_row(item),
        })
        .collect();
    rows.sort_by(|a, b| (a.namespace.as_str(), a.name.as_str()).cmp(&(b.namespace.as_str(), b.name.as_str())));
    Ok(rows)
}

/// The kubectl arguments for one resource read. Split out because "every namespace" is `-A`
/// and a named one is `-n`, and picking the wrong one silently answers for the wrong scope.
fn resource_args(profile: &str, kind: &str, namespace: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = vec!["--context".into(), context_name(profile), "get".into(), kind.into(), "-o".into(), "json".into()];
    match namespace {
        Some(ns) if !ns.is_empty() => {
            args.push("-n".into());
            args.push(ns.into());
        }
        _ => args.push("-A".into()),
    }
    args
}

/// One resource list for the table. `namespace` of `None` means every namespace.
pub fn resources(profile: &str, kind: &str, namespace: Option<&str>) -> Result<Vec<KubeRow>, String> {
    if !KINDS.contains(&kind) {
        return Err(format!("unsupported resource {kind}"));
    }
    let args = resource_args(profile, kind, namespace);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    to_rows(kind, &kubectl(&refs)?)
}

/// The last `tail` lines of one pod, all containers, with timestamps so the log viewer's
/// own parser can split time from text. A pod that is not running still answers (previous
/// container crash output), which is exactly when the logs matter.
fn pod_log_args(profile: &str, namespace: &str, pod: &str, tail: u32) -> Result<Vec<String>, String> {
    if pod.trim().is_empty() {
        return Err("no pod given".to_string());
    }
    let mut args: Vec<String> = vec![
        "--context".into(), context_name(profile),
        "logs".into(), pod.to_string(),
        "--all-containers=true".into(),
        "--timestamps".into(),
        "--tail".into(), tail.clamp(1, 5000).to_string(),
    ];
    // `—` is what the table prints for "no namespace", never a namespace kubectl would accept.
    if !namespace.is_empty() && namespace != "—" {
        args.push("-n".into());
        args.push(namespace.to_string());
    }
    Ok(args)
}

pub fn pod_logs(profile: &str, namespace: &str, pod: &str, tail: u32) -> Result<String, String> {
    let args = pod_log_args(profile, namespace, pod, tail)?;
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    kubectl(&refs)
}

/// The four verbs the page can send, validated before anything is spawned.
fn cluster_verb(action: &str) -> Result<&str, String> {
    match action {
        "start" | "stop" | "delete" | "reset" => Ok(action),
        other => Err(format!("unsupported kubernetes action {other}")),
    }
}

/// The last answer a context gave. A VM that stops mid-read leaves the API server accepting
/// TCP and never replying; the page then shows this answer, labelled with its timestamp,
/// instead of zeros it never counted.
static LAST_GOOD: std::sync::Mutex<Option<(String, ClusterInfo)>> = std::sync::Mutex::new(None);

fn cached(context: &str) -> Option<ClusterInfo> {
    LAST_GOOD.lock().ok().and_then(|slot| slot.clone()).and_then(|(ctx, info)| if ctx == context { Some(info) } else { None })
}

fn remember(context: &str, info: &ClusterInfo) {
    if let Ok(mut slot) = LAST_GOOD.lock() {
        *slot = Some((context.to_string(), info.clone()));
    }
}

/// Cluster facts for the strip, and the namespace list for the filter. The five reads run in
/// parallel: each kubectl run costs a process, and sequentially a cold cluster takes a second.
pub fn cluster_info(profile: &str) -> ClusterInfo {
    let context = context_name(profile);
    let mut info = ClusterInfo { context: context.clone(), ..ClusterInfo::default() };
    if !kubectl_installed() {
        info.error = Some("kubectl is not installed: brew install kubectl".to_string());
        return info;
    }
    let contexts = match kubectl(&["config", "get-contexts", "-o", "name"]) {
        Ok(raw) => raw,
        Err(e) => {
            info.error = Some(e);
            return info;
        }
    };
    // Colima merges the kubeconfig entry under the profile's own name, so this is exactly the
    // condition "this profile was started with Kubernetes".
    if !contexts.lines().any(|line| line.trim() == context) {
        return info;
    }
    info.enabled = true;

    let (version, nodes, pods, deployments, namespaces) = std::thread::scope(|s| {
        let version = s.spawn(|| kubectl(&["--context", &context, "get", "--raw", "/version"]));
        let nodes = s.spawn(|| kubectl(&["--context", &context, "get", "nodes", "-o", "json"]));
        let pods = s.spawn(|| kubectl(&["--context", &context, "get", "pods", "-A", "-o", "json"]));
        let deployments = s.spawn(|| kubectl(&["--context", &context, "get", "deployments", "-A", "-o", "json"]));
        let namespaces = s.spawn(|| kubectl(&["--context", &context, "get", "namespaces", "-o", "json"]));
        (
            version.join().unwrap_or_else(|_| Err("kubectl version read panicked".into())),
            nodes.join().unwrap_or_else(|_| Err("kubectl nodes read panicked".into())),
            pods.join().unwrap_or_else(|_| Err("kubectl pods read panicked".into())),
            deployments.join().unwrap_or_else(|_| Err("kubectl deployments read panicked".into())),
            namespaces.join().unwrap_or_else(|_| Err("kubectl namespaces read panicked".into())),
        )
    });

    match version {
        Ok(raw) => {
            info.reachable = true;
            info.version = serde_json::from_str::<Value>(&raw)
                .ok()
                .and_then(|v| v.get("gitVersion").and_then(Value::as_str).map(str::to_string));
        }
        Err(e) => info.error = Some(e),
    }

    if let Ok(raw) = nodes {
        if let Ok(list) = items(&raw) {
            info.nodes = list.len() as u32;
            info.nodes_ready = list.iter().filter(|n| node_row(n).ready == "Ready").count() as u32;
        }
    }
    if let Ok(raw) = pods {
        if let Ok(list) = items(&raw) {
            info.pods = list.len() as u32;
            info.pods_running = list
                .iter()
                .filter(|p| str_at(p, &["status", "phase"]) == Some("Running"))
                .count() as u32;
        }
    }
    if let Ok(raw) = deployments {
        if let Ok(list) = items(&raw) {
            info.deployments = list.len() as u32;
            info.deployments_ready = list.iter().filter(|d| workload_row(d, "deployments").status == "Available").count() as u32;
        }
    }
    if let Ok(raw) = namespaces {
        if let Ok(list) = items(&raw) {
            let mut names: Vec<String> = list
                .iter()
                .filter_map(|n| str_at(n, &["metadata", "name"]).map(str::to_string))
                .collect();
            names.sort();
            info.namespaces = names;
        }
    }

    if info.reachable {
        info.read_at = Some(crate::cleanup::now_secs());
        remember(&context, &info);
        return info;
    }
    // Unreachable: keep the numbers from the last answer, under their own timestamp.
    if let Some(last) = cached(&context) {
        info.nodes = last.nodes;
        info.nodes_ready = last.nodes_ready;
        info.pods = last.pods;
        info.pods_running = last.pods_running;
        info.deployments = last.deployments;
        info.deployments_ready = last.deployments_ready;
        info.namespaces = last.namespaces;
        info.version = last.version;
        info.read_at = last.read_at;
    }
    info
}

/// `colima kubernetes start|stop|delete|reset` provisions, halts, or tears down k3s in the VM.
/// `delete` removes the cluster and its kubeconfig entry; `reset` reinstalls it in place.
pub fn cluster_action(profile: &str, action: &str) -> Result<String, String> {
    cluster_verb(action)?;
    let out = Command::new(crate::colima::colima_bin())
        .args(["kubernetes", action, "-p", profile])
        .output()
        .map_err(|e| format!("failed to spawn colima: {e}"))?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(clean_error(&String::from_utf8_lossy(&out.stderr)))
    }
}

#[cfg(test)]
mod last_good_tests {
    use super::{cached, remember, ClusterInfo};

    /// A cluster that stops answering must be able to repeat the numbers it did answer with;
    /// another profile's context must never answer for it.
    #[test]
    fn last_good_answer_is_per_context() {
        let mut info = ClusterInfo { context: "colima-unittest".into(), reachable: true, pods: 7, read_at: Some(42), ..ClusterInfo::default() };
        info.nodes = 1;
        remember("colima-unittest", &info);
        let hit = cached("colima-unittest").expect("cached answer");
        assert_eq!((hit.nodes, hit.pods, hit.read_at), (1, 7, Some(42)));
        assert!(cached("colima-other-unittest").is_none());
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const PODS: &str = r#"{"items":[
      {"metadata":{"namespace":"default","name":"web-0","creationTimestamp":"2026-11-15T10:00:00Z"},
       "spec":{"nodeName":"colima","containers":[{}]},
       "status":{"phase":"Running","containerStatuses":[{"ready":true,"restartCount":2,"state":{"running":{}}}]}},
      {"metadata":{"namespace":"kube-system","name":"coredns-1","creationTimestamp":"2026-11-14T10:00:00Z"},
       "spec":{"nodeName":"colima","containers":[{},{}]},
       "status":{"phase":"Running","containerStatuses":[
          {"ready":false,"restartCount":1,"state":{"waiting":{"reason":"CrashLoopBackOff"}}},
          {"ready":true,"restartCount":0,"state":{"running":{}}}]}}
    ]}"#;

    #[test]
    fn pods_report_ready_counts_and_waiting_reasons() {
        let rows = to_rows("pods", PODS).unwrap();
        assert_eq!(rows.len(), 2);
        let coredns = rows.iter().find(|r| r.name == "coredns-1").unwrap();
        assert_eq!(coredns.ready, "1/2");
        assert_eq!(coredns.status, "CrashLoopBackOff");
        assert_eq!(coredns.restarts, Some(1));
        let web = rows.iter().find(|r| r.name == "web-0").unwrap();
        assert_eq!(web.ready, "1/1");
        assert_eq!(web.status, "Running");
        assert_eq!(web.detail, "colima");
    }

    #[test]
    fn deployments_count_available_replicas() {
        let raw = r#"{"items":[
          {"metadata":{"namespace":"default","name":"web"},"spec":{"replicas":3,"template":{"spec":{"containers":[{"image":"ghcr.io/acme/web:1.2"},{"image":"redis:7"}]}}},"status":{"readyReplicas":3}},
          {"metadata":{"namespace":"default","name":"api"},"spec":{"replicas":2,"template":{"spec":{"containers":[{"image":"api:dev"},{"image":"sidecar:1"},{"image":"proxy:1"}]}}},"status":{"readyReplicas":1}}
        ]}"#;
        let rows = to_rows("deployments", raw).unwrap();
        let web = rows.iter().find(|r| r.name == "web").unwrap();
        assert_eq!(web.ready, "3/3");
        assert_eq!(web.status, "Available");
        assert_eq!(web.detail, "web:1.2, redis:7");
        let api = rows.iter().find(|r| r.name == "api").unwrap();
        assert_eq!(api.ready, "1/2");
        assert_eq!(api.status, "Progressing");
        assert_eq!(api.detail, "api:dev, sidecar:1, +1");
    }

    #[test]
    fn services_show_type_and_ports() {
        let raw = r#"{"items":[{"metadata":{"namespace":"default","name":"web"},"spec":{"type":"NodePort","clusterIP":"10.43.0.7","ports":[{"port":80,"targetPort":8080,"nodePort":30080,"protocol":"TCP"}]}}]}"#;
        let rows = to_rows("services", raw).unwrap();
        assert_eq!(rows[0].ready, "10.43.0.7");
        assert_eq!(rows[0].status, "NodePort");
        assert_eq!(rows[0].detail, "80:30080→8080/TCP");
        assert_eq!(rows[0].namespace, "default");
    }

    #[test]
    fn a_named_target_port_falls_back_to_the_service_port() {
        // k3s answers `443/TCP` for the `kubernetes` service; a Helm chart may name its
        // targetPort ("http"), which is not a number. The cell then shows the service port
        // alone rather than inventing `443→0/TCP`.
        let raw = r#"{"items":[{"metadata":{"namespace":"default","name":"api"},"spec":{"type":"ClusterIP","clusterIP":"10.43.0.9","ports":[{"port":8080,"targetPort":"http","protocol":"TCP"}]}}]}"#;
        let rows = to_rows("services", raw).unwrap();
        assert_eq!(rows[0].detail, "8080/TCP");
    }

    #[test]
    fn nodes_read_roles_and_kubelet_version() {
        let raw = r#"{"items":[{"metadata":{"name":"colima","labels":{"node-role.kubernetes.io/control-plane":"true","kubernetes.io/hostname":"colima"}},
          "status":{"nodeInfo":{"kubeletVersion":"v1.35.0+k3s1"},"conditions":[{"type":"Ready","status":"True"}]}}]}"#;
        let rows = to_rows("nodes", raw).unwrap();
        assert_eq!(rows[0].ready, "Ready");
        assert_eq!(rows[0].status, "control-plane");
        assert_eq!(rows[0].detail, "v1.35.0+k3s1");
        assert_eq!(rows[0].namespace, "—");
    }

    #[test]
    fn missing_timestamps_read_as_unknown() {
        assert_eq!(age_of(None), "—");
        assert_eq!(age_of(Some("0001-01-01T00:00:00Z")), "—");
        assert_eq!(age_of(Some("not a date")), "—");
    }

    #[test]
    fn ages_use_kubernetes_units() {
        assert_eq!(humanize_age(5), "5s");
        assert_eq!(humanize_age(90), "1m");
        assert_eq!(humanize_age(3 * 3600), "3h");
        assert_eq!(humanize_age(2 * 86400), "2d");
        assert_eq!(humanize_age(15 * 86400), "2w");
        assert_eq!(humanize_age(70 * 86400), "2mo");
        assert_eq!(humanize_age(800 * 86400), "2y");
    }

    #[test]
    fn unknown_kinds_are_rejected_before_kubectl_runs() {
        assert!(resources("default", "secrets", None).is_err());
        assert!(cluster_action("default", "install").is_err());
        assert!(pod_logs("default", "kube-system", "  ", 100).is_err());
    }

    #[test]
    fn contexts_are_named_after_the_lima_instance() {
        // Colima names the instance `colima` for the default profile (verified on 0.10.3)
        // and `colima-<profile>` otherwise, so the profile label never reaches kubectl.
        assert_eq!(context_name("default"), "colima");
        assert_eq!(context_name(""), "colima");
        assert_eq!(context_name("colima"), "colima");
        assert_eq!(context_name("work"), "colima-work");
        assert_eq!(context_name("colima-work"), "colima-work");
    }

    #[test]
    fn only_the_four_cluster_verbs_are_accepted() {
        for verb in ["start", "stop", "delete", "reset"] {
            assert!(cluster_verb(verb).is_ok(), "{verb}");
        }
        // A typo must fail before spawning colima, not run the wrong subcommand.
        assert!(cluster_verb("STOP").is_err());
        assert!(cluster_verb("").is_err());
        assert!(cluster_verb("start --force").is_err());
    }

    #[test]
    fn pod_logs_read_every_container_with_timestamps() {
        let args = pod_log_args("default", "kube-system", "coredns-abc", 200).unwrap();
        assert_eq!(args[0..2], ["--context", "colima"]);
        assert_eq!(args[2], "logs");
        assert_eq!(args[3], "coredns-abc");
        assert!(args.contains(&"--all-containers=true".to_string()));
        assert!(args.contains(&"--timestamps".to_string()));
        let tail = args.iter().position(|a| a == "--tail").unwrap();
        assert_eq!(args[tail + 1], "200");
        let ns = args.iter().position(|a| a == "-n").unwrap();
        assert_eq!(args[ns + 1], "kube-system");
        // A clamped tail keeps a broken UI value from downloading the whole log.
        let clamped = pod_log_args("default", "", "p", 100000).unwrap();
        let at = clamped.iter().position(|a| a == "--tail").unwrap();
        assert_eq!(clamped[at + 1], "5000");
        assert!(!clamped.contains(&"-n".to_string()));
    }

    #[test]
    fn every_namespace_is_a_not_n() {
        let all = resource_args("work", "pods", None);
        assert_eq!(all, ["--context", "colima-work", "get", "pods", "-o", "json", "-A"].map(String::from).to_vec());
        let one = resource_args("work", "pods", Some("kube-system"));
        assert_eq!(one, ["--context", "colima-work", "get", "pods", "-o", "json", "-n", "kube-system"].map(String::from).to_vec());
        // An empty string is not a namespace: it falls back to the cluster-wide read.
        assert_eq!(resource_args("work", "pods", Some("")).last().unwrap(), "-A");
    }
}

