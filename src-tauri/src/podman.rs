use serde::{Deserialize, Serialize};
use crate::docker::{ContainerDetail, ContainerMount, ContainerNet, ContainerPort, ContainerStat, HealthProbe, ImageDetail, ImageLayer, NetworkContainer, NetworkDetail, NetworkMember, NetworkMapEntry, VolumeDetail};
use std::collections::HashMap;
use std::process::Command;
use std::sync::RwLock;
use std::time::{Duration, Instant};

#[derive(Serialize, Deserialize, Clone)]
pub struct PodmanMachine {
    pub name: String,
    pub default: bool,
    pub running: bool,
    pub starting: bool,
    pub cpus: u32,
    pub memory: u64,
    pub disk_size: u64,
    pub vm_type: String,
    pub port: u32,
}

#[derive(Serialize, Clone)]
pub struct PodmanContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
    pub created_at: String,
    /// Rendered in the same `0.0.0.0:8080->80/tcp, 443/tcp` shape `docker ps` prints,
    /// so one row cell renders either runtime.
    pub ports: String,
}

#[derive(Deserialize)]
struct RawPort {
    #[serde(rename = "host_ip")]
    host_ip: Option<String>,
    #[serde(rename = "container_port")]
    container_port: Option<u16>,
    #[serde(rename = "host_port")]
    host_port: Option<u16>,
    #[serde(rename = "range")]
    range: Option<u16>,
    #[serde(rename = "protocol")]
    protocol: Option<String>,
}

#[derive(Deserialize)]
struct RawContainer {
    #[serde(rename = "Id")]
    id: Option<String>,
    #[serde(rename = "Names")]
    names: Option<Vec<String>>,
    #[serde(rename = "Image")]
    image: Option<String>,
    #[serde(rename = "State")]
    state: Option<String>,
    #[serde(rename = "Status")]
    status: Option<String>,
    #[serde(rename = "CreatedAt")]
    created_at: Option<String>,
    #[serde(rename = "Ports")]
    ports: Option<Vec<RawPort>>,
}

#[derive(Serialize, Clone)]
pub struct PodmanImage {
    pub id: String,
    /// `docker.io/library/nginx:latest`; the reference a user copies.
    pub name: String,
    pub repository: String,
    pub tag: String,
    pub size: u64,
    pub created_at: String,
    pub containers: i64,
}

#[derive(Deserialize)]
struct RawImage {
    #[serde(rename = "Id")]
    id: Option<String>,
    #[serde(rename = "Names")]
    names: Option<Vec<String>>,
    #[serde(rename = "Repository")]
    repository: Option<String>,
    #[serde(rename = "Tag")]
    tag: Option<String>,
    #[serde(rename = "Size")]
    size: Option<u64>,
    #[serde(rename = "CreatedAt")]
    created_at: Option<String>,
    #[serde(rename = "Containers")]
    containers: Option<i64>,
}

#[derive(Serialize, Clone)]
pub struct PodmanVolume {
    pub name: String,
    pub driver: String,
    pub mountpoint: String,
    pub created_at: String,
    pub size: u64,
    pub links: i64,
    /// False when `system df -v` could not describe this volume: `links` is then a zero the
    /// UI must not read as "nothing uses it".
    pub links_known: bool,
}

#[derive(Deserialize)]
struct RawVolume {
    #[serde(rename = "Name")]
    name: Option<String>,
    #[serde(rename = "Driver")]
    driver: Option<String>,
    #[serde(rename = "Mountpoint")]
    mountpoint: Option<String>,
    #[serde(rename = "CreatedAt")]
    created_at: Option<String>,
}

#[derive(Serialize, Clone)]
pub struct PodmanNetwork {
    pub name: String,
    pub id: String,
    pub driver: String,
    pub subnet: String,
    pub gateway: String,
    pub internal: bool,
    pub dns_enabled: bool,
}

#[derive(Deserialize)]
struct RawNetwork {
    #[serde(rename = "name")]
    name: Option<String>,
    #[serde(rename = "id")]
    id: Option<String>,
    #[serde(rename = "driver")]
    driver: Option<String>,
    #[serde(rename = "subnets")]
    subnets: Option<Vec<RawSubnet>>,
    #[serde(rename = "internal")]
    internal: Option<bool>,
    #[serde(rename = "dns_enabled")]
    dns_enabled: Option<bool>,
}

#[derive(Deserialize)]
struct RawSubnet {
    #[serde(rename = "subnet")]
    subnet: Option<String>,
    #[serde(rename = "gateway")]
    gateway: Option<String>,
}

#[derive(Deserialize)]
struct RawMachine {
    #[serde(rename = "Name")]
    name: Option<String>,
    #[serde(rename = "Default")]
    default: Option<bool>,
    #[serde(rename = "Running")]
    running: Option<bool>,
    #[serde(rename = "Starting")]
    starting: Option<bool>,
    #[serde(rename = "CPUs")]
    cpus: Option<u32>,
    #[serde(rename = "Memory")]
    memory: Option<String>,
    #[serde(rename = "DiskSize")]
    disk_size: Option<String>,
    #[serde(rename = "VMType")]
    vm_type: Option<String>,
    #[serde(rename = "Port")]
    port: Option<u32>,
}

static MACHINE: std::sync::RwLock<Option<String>> = std::sync::RwLock::new(None);

/// Names the machine every later `podman` call talks to. `CONTAINER_CONNECTION` is podman's own
/// way to pin a connection, so one write here covers lists, mutations, stats and logs alike.
///
/// The frontend re-sends the selection on every refresh, so the cache is only dropped when
/// the value actually changes: another machine has another store, and the previous machine's
/// bytes must never be shown under its name.
pub fn set_machine(name: Option<String>) {
    let next = name.filter(|n| !n.trim().is_empty());
    let changed = {
        let Ok(mut slot) = MACHINE.write() else { return };
        if *slot == next {
            false
        } else {
            *slot = next;
            true
        }
    };
    if changed {
        invalidate_disk_usage();
    }
}

fn machine() -> Option<String> {
    MACHINE.read().ok().and_then(|slot| slot.clone())
}

fn run_podman(args: &[&str]) -> Result<String, String> {
    run_podman_with(args, crate::proc::READ_LIMIT)
}

/// A mutation the user is waiting on: start, stop, restart, remove, machine set.
fn run_podman_action(args: &[&str]) -> Result<String, String> {
    run_podman_with(args, crate::proc::ACTION_LIMIT)
}

/// A pull or a machine start: minutes of real work with no interim output, so no deadline.
fn run_podman_wait(args: &[&str]) -> Result<String, String> {
    run_podman_with(args, crate::proc::NO_LIMIT)
}

fn run_podman_with(args: &[&str], limit: Option<Duration>) -> Result<String, String> {
    let mut cmd = Command::new("podman");
    if let Some(name) = machine() {
        cmd.env("CONTAINER_CONNECTION", name);
    }
    cmd.args(args);
    let out = crate::proc::run(&mut cmd, limit).map_err(|e| e.to_string())?;
    if !out.success {
        return Err(out.stderr);
    }
    Ok(out.stdout)
}

/// Creates a machine. `name` is optional — podman falls back to `podman-machine-default`.
/// The first init pulls a VM image, so callers must warn before running it.
fn machine_init_args(name: Option<&str>, cpus: Option<u32>, memory_mb: Option<u32>) -> Vec<String> {
    let mut args: Vec<String> = vec!["machine".into(), "init".into()];
    if let Some(c) = cpus.filter(|c| *c > 0) {
        args.push("--cpus".into());
        args.push(c.to_string());
    }
    if let Some(m) = memory_mb.filter(|m| *m > 0) {
        args.push("--memory".into());
        args.push(m.to_string());
    }
    if let Some(n) = name.map(str::trim).filter(|n| !n.is_empty()) {
        args.push(n.to_string());
    }
    args
}

pub fn machine_init(name: Option<&str>, cpus: Option<u32>, memory_mb: Option<u32>) -> Result<String, String> {
    let args = machine_init_args(name, cpus, memory_mb);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    run_podman(&refs)
}

pub fn list_machines() -> Result<Vec<PodmanMachine>, String> {
    let raw = run_podman(&["machine", "list", "--format", "json"])?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Vec<RawMachine> = serde_json::from_str(trimmed).map_err(|e| format!("parse podman machines: {e}"))?;
    Ok(parsed
        .into_iter()
        .filter_map(|m| {
            let name = m.name?;
            Some(PodmanMachine {
                name,
                default: m.default.unwrap_or(false),
                running: m.running.unwrap_or(false),
                starting: m.starting.unwrap_or(false),
                cpus: m.cpus.unwrap_or(0),
                memory: m.memory.unwrap_or_default().parse().unwrap_or(0),
                disk_size: m.disk_size.unwrap_or_default().parse().unwrap_or(0),
                vm_type: m.vm_type.unwrap_or_default(),
                port: m.port.unwrap_or(0),
            })
        })
        .collect())
}

pub fn list_containers() -> Result<Vec<PodmanContainer>, String> {
    let raw = run_podman(&["ps", "-a", "--format", "json"])?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Vec<RawContainer> = serde_json::from_str(trimmed)
        .map_err(|e| format!("parse podman containers: {e}"))?;
    Ok(parsed
        .into_iter()
        .filter_map(|c| {
            let id = c.id?;
            let name = c.names.unwrap_or_default().join(", ");
            Some(PodmanContainer {
                id,
                name: if name.is_empty() { "(unnamed)".into() } else { name },
                image: c.image.unwrap_or_default(),
                state: c.state.unwrap_or_default(),
                status: c.status.unwrap_or_default(),
                created_at: c.created_at.unwrap_or_default(),
                ports: render_ports(c.ports.unwrap_or_default()),
            })
        })
        .collect())
}

pub fn list_images() -> Result<Vec<PodmanImage>, String> {
    let raw = run_podman(&["images", "--format", "json"])?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Vec<RawImage> = serde_json::from_str(trimmed)
        .map_err(|e| format!("parse podman images: {e}"))?;
    Ok(parsed
        .into_iter()
        .filter_map(|i| {
            let id = i.id?;
            let repository = i.repository.clone().unwrap_or_default();
            let tag = i.tag.clone().unwrap_or_default();
            let name = match (i.names.as_ref().and_then(|n| n.first()),) {
                (Some(n),) if !n.is_empty() => n.clone(),
                _ => match (i.repository.as_deref(), i.tag.as_deref()) {
                    (Some(repo), Some(tag)) => format!("{repo}:{tag}"),
                    (Some(repo), None) => repo.to_string(),
                    _ => id.clone(),
                },
            };
            Some(PodmanImage {
                id,
                name,
                repository,
                tag,
                size: i.size.unwrap_or(0),
                created_at: i.created_at.unwrap_or_default(),
                containers: i.containers.unwrap_or(0),
            })
        })
        .collect())
}

#[derive(Serialize, Clone, Default)]
pub struct PodmanDiskUsage {
    pub images: u64,
    pub containers: u64,
    pub volumes: u64,
    pub reclaimable: u64,
}

/// `podman system df` walks the machine's image store, so the reading is reused for a
/// minute and cleared by the operations that free space. Podman reports no build cache
/// line, unlike Docker, so that kind has no field here.
const DISK_TTL: Duration = Duration::from_secs(60);
static DISK_CACHE: RwLock<Option<(Instant, PodmanDiskUsage)>> = RwLock::new(None);

fn invalidate_disk_usage() {
    if let Ok(mut slot) = DISK_CACHE.write() {
        *slot = None;
    }
    // The per-volume table comes from a scan of the same store: an operation that freed
    // space changed it too.
    if let Ok(mut slot) = VOLUME_SIZES_CACHE.write() {
        *slot = None;
    }
}

/// An operation that can free space drops the cached reading instead of waiting for
/// the TTL, so the next refresh cannot show the bytes it just removed.
fn freed(result: Result<String, String>) -> Result<String, String> {
    if result.is_ok() {
        invalidate_disk_usage();
    }
    result
}

/// `podman system df --format json` answers one row per kind. `RawSize` is the exact
/// byte count; the human `Size` string is the fallback for a Podman that omits it.
fn parse_disk_usage(raw: &str) -> Option<PodmanDiskUsage> {
    #[derive(Deserialize)]
    struct Row {
        #[serde(rename = "Type")] kind: String,
        #[serde(rename = "RawSize", default)] raw_size: Option<u64>,
        #[serde(rename = "Size", default)] size: Option<String>,
        #[serde(rename = "RawReclaimable", default)] raw_reclaimable: Option<u64>,
        #[serde(rename = "Reclaimable", default)] reclaimable: Option<String>,
    }
    let rows: Vec<Row> = serde_json::from_str(raw.trim()).ok()?;
    if rows.is_empty() {
        return None;
    }
    let bytes = |exact: Option<u64>, text: Option<String>| {
        exact.unwrap_or_else(|| text.as_deref().map(crate::docker::parse_size).unwrap_or(0))
    };
    let mut usage = PodmanDiskUsage::default();
    for row in rows {
        let size = bytes(row.raw_size, row.size);
        match row.kind.as_str() {
            "Images" => usage.images = size,
            "Containers" => usage.containers = size,
            "Local Volumes" => usage.volumes = size,
            _ => {}
        }
        usage.reclaimable += bytes(row.raw_reclaimable, row.reclaimable);
    }
    Some(usage)
}

fn read_disk_usage() -> Option<PodmanDiskUsage> {
    let raw = run_podman(&["system", "df", "--format", "json"]).ok()?;
    parse_disk_usage(&raw)
}

pub fn disk_usage() -> PodmanDiskUsage {
    if let Ok(slot) = DISK_CACHE.read() {
        if let Some((at, cached)) = slot.as_ref() {
            if at.elapsed() < DISK_TTL {
                return cached.clone();
            }
        }
    }
    // A failed read (machine stopped, old Podman without JSON df) must not pin zeros
    // for the whole TTL.
    let Some(fresh) = read_disk_usage() else {
        return PodmanDiskUsage::default();
    };
    if let Ok(mut slot) = DISK_CACHE.write() {
        *slot = Some((Instant::now(), fresh.clone()));
    }
    fresh
}

/// `podman system df -v` is the only Podman command that reports a size per volume. It walks
/// the whole store, so the reading is cached next to the disk totals and dropped by the same
/// operations that free space. `--format` cannot be combined with `-v`, so it stays text.
///
/// `None` means "could not read" — a machine that is down, or a table layout this parse does
/// not know. Callers must not turn that into zeros: `links` decides whether a volume is
/// removable.
static VOLUME_SIZES_CACHE: RwLock<Option<(Instant, HashMap<String, (u64, i64)>)>> = RwLock::new(None);

fn read_volume_sizes() -> Option<HashMap<String, (u64, i64)>> {
    let raw = run_podman(&["system", "df", "-v"]).ok()?;
    let mut in_volumes = false;
    let mut out = HashMap::new();
    for line in raw.lines() {
        let text = line.trim();
        if text.starts_with("Local Volumes space usage:") {
            in_volumes = true;
            continue;
        }
        if !in_volumes || text.is_empty() || text.starts_with("VOLUME NAME") {
            continue;
        }
        let fields: Vec<&str> = text.split_whitespace().collect();
        if fields.len() < 3 {
            continue;
        }
        let links = fields[fields.len() - 2].parse().unwrap_or(0);
        let size = crate::docker::parse_size(fields[fields.len() - 1]);
        out.insert(fields[0].to_string(), (size, links));
    }
    if out.is_empty() {
        return None;
    }
    Some(out)
}

fn volume_sizes() -> Option<HashMap<String, (u64, i64)>> {
    if let Ok(slot) = VOLUME_SIZES_CACHE.read() {
        if let Some((at, cached)) = slot.as_ref() {
            if at.elapsed() < DISK_TTL {
                return Some(cached.clone());
            }
        }
    }
    let fresh = read_volume_sizes()?;
    if let Ok(mut slot) = VOLUME_SIZES_CACHE.write() {
        *slot = Some((Instant::now(), fresh.clone()));
    }
    Some(fresh)
}

pub fn list_volumes() -> Result<Vec<PodmanVolume>, String> {
    let sizes = volume_sizes();
    let raw = run_podman(&["volume", "ls", "--format", "json"])?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Vec<RawVolume> = serde_json::from_str(trimmed)
        .map_err(|e| format!("parse podman volumes: {e}"))?;
    Ok(parsed
        .into_iter()
        .filter_map(|v| {
            let name = v.name?;
            let known = sizes.as_ref().and_then(|m| m.get(&name).copied());
            let (size, links) = known.unwrap_or((0, 0));
            Some(PodmanVolume {
                name,
                driver: v.driver.unwrap_or_default(),
                mountpoint: v.mountpoint.unwrap_or_default(),
                created_at: v.created_at.unwrap_or_default(),
                size,
                links,
                // A volume the df table did not describe has an unknown user count, and the
                // Remove gate must treat unknown as "in use" rather than as zero.
                links_known: known.is_some(),
            })
        })
        .collect())
}

/// `podman pull <ref>`. The reference is validated by the same whitelist the Docker page uses —
/// it reaches podman's argv, where a leading `-` would read as a flag.
pub fn image_pull(reference: &str) -> Result<String, String> {
    crate::docker::safe_image_ref(reference)?;
    let out = run_podman_wait(&["pull", reference]);
    invalidate_disk_usage();
    out
}

pub fn image_remove(id: &str) -> Result<String, String> {
    freed(run_podman_action(&["rmi", "-f", id]))
}

pub fn volume_remove(name: &str) -> Result<String, String> {
    freed(run_podman_action(&["volume", "rm", "-f", name]))
}

pub fn network_remove(name: &str) -> Result<String, String> {
    run_podman_action(&["network", "rm", name])
}

pub fn container_start(id: &str) -> Result<String, String> {
    run_podman_action(&["start", id])
}

pub fn container_stop(id: &str) -> Result<String, String> {
    run_podman_action(&["stop", id])
}

pub fn container_restart(id: &str) -> Result<String, String> {
    run_podman_action(&["restart", id])
}

pub fn container_remove(id: &str) -> Result<String, String> {
    freed(run_podman_action(&["rm", "-f", id]))
}

pub fn container_logs(id: &str, tail: u32) -> Result<String, String> {
    run_podman(&["logs", "--tail", &tail.to_string(), id])
}

/// Same wire format `docker ps` prints: `0.0.0.0:8080->80/tcp`, `443/tcp` when the port
/// is only exposed, `0.0.0.0:8000-8002->8000-8002/tcp` for a published range. The wider
/// host-port form is only used when the ranges differ, which podman also reports.
fn render_ports(mut ports: Vec<RawPort>) -> String {
    ports.sort_by_key(|p| (p.container_port.unwrap_or(0), p.host_port.unwrap_or(0)));
    ports
        .into_iter()
        .map(|p| {
            let target = p.container_port.unwrap_or(0);
            let proto = p.protocol.unwrap_or_else(|| "tcp".into());
            match p.host_port.unwrap_or(0) {
                0 => format!("{target}/{proto}"),
                host => {
                    let ip = p.host_ip.filter(|ip| !ip.is_empty()).unwrap_or_else(|| "0.0.0.0".into());
                    match p.range.unwrap_or(1) {
                        1 => format!("{ip}:{host}->{target}/{proto}"),
                        n => format!("{ip}:{host}-{}->{target}-{}/{proto}", host + n - 1, target + n - 1),
                    }
                }
            }
        })
        .collect::<Vec<_>>()
        .join(", ")
}

pub fn image_inspect(id: &str) -> Result<String, String> {
    inspect_json(&["image", "inspect", id])
}

pub fn container_inspect_json(id: &str) -> Result<String, String> {
    inspect_json(&["container", "inspect", id])
}

pub fn volume_inspect(name: &str) -> Result<String, String> {
    inspect_json(&["volume", "inspect", name])
}

pub fn network_inspect(name: &str) -> Result<String, String> {
    inspect_json(&["network", "inspect", name])
}

/// The CLI's single JSON array pretty-printed, matching the Docker inspect sheets.
fn inspect_json(args: &[&str]) -> Result<String, String> {
    let raw = run_podman(args)?;
    let value: serde_json::Value = serde_json::from_str(raw.trim())
        .map_err(|e| format!("parse podman {}: {e}", args.join(" ")))?;
    serde_json::to_string_pretty(&value).map_err(|e| e.to_string())
}

pub fn list_networks() -> Result<Vec<PodmanNetwork>, String> {
    let raw = run_podman(&["network", "ls", "--format", "json"])?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Vec<RawNetwork> = serde_json::from_str(trimmed)
        .map_err(|e| format!("parse podman networks: {e}"))?;
    Ok(parsed
        .into_iter()
        .filter_map(|n| {
            let name = n.name?;
            let first = n.subnets.as_ref().and_then(|s| s.first());
            Some(PodmanNetwork {
                name,
                id: n.id.unwrap_or_default(),
                driver: n.driver.unwrap_or_default(),
                subnet: first.and_then(|s| s.subnet.clone()).unwrap_or_default(),
                gateway: first.and_then(|s| s.gateway.clone()).unwrap_or_default(),
                internal: n.internal.unwrap_or(false),
                dns_enabled: n.dns_enabled.unwrap_or(false),
            })
        })
        .collect())
}

pub fn network_map() -> Result<Vec<NetworkMapEntry>, String> {
    let names: Vec<String> = list_networks()?.into_iter().map(|n| n.name).collect();
    if names.is_empty() {
        return Ok(Vec::new());
    }
    let mut args = vec!["network", "inspect"];
    args.extend(names.iter().map(String::as_str));
    let raw = run_podman(&args)?;
    let parsed: Vec<serde_json::Value> = serde_json::from_str(raw.trim())
        .map_err(|e| format!("parse podman network inspect: {e}"))?;
    Ok(parsed
        .into_iter()
        .map(|net| {
            let subnet = net.pointer("/subnets/0/subnet").and_then(serde_json::Value::as_str).unwrap_or("");
            let gateway = net.pointer("/subnets/0/gateway").and_then(serde_json::Value::as_str).unwrap_or("");
            let mut containers = Vec::new();
            if let Some(map) = net.get("containers").and_then(serde_json::Value::as_object) {
                for c in map.values() {
                    let name = c.get("name").and_then(serde_json::Value::as_str).unwrap_or("");
                    let mac = c
                        .pointer("/interfaces/eth0/mac_address")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("");
                    let ip = c
                        .pointer("/interfaces/eth0/subnets/0/ipnet")
                        .and_then(serde_json::Value::as_str)
                        .unwrap_or("")
                        .split('/')
                        .next()
                        .unwrap_or("");
                    containers.push(NetworkContainer {
                        name: name.to_string(),
                        ip: ip.to_string(),
                        mac: mac.to_string(),
                    });
                }
            }
            NetworkMapEntry {
                id: net.get("id").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
                name: net.get("name").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
                driver: net.get("driver").and_then(serde_json::Value::as_str).unwrap_or("").to_string(),
                scope: "local".into(),
                internal: net.get("internal").and_then(serde_json::Value::as_bool).unwrap_or(false),
                subnet: subnet.to_string(),
                gateway: gateway.to_string(),
                containers,
            }
        })
        .collect())
}

/// `podman container inspect` reshaped into the same `ContainerDetail` Docker returns, so
/// the expanded row is one component with one vocabulary. Field mapping notes: podman puts
/// the human reference in `ImageName` (`Image` is the hex id), keeps `Name` without a slash,
/// and reports health under `State.Health`.
pub fn container_detail(id: &str) -> Result<ContainerDetail, String> {
    let raw = run_podman(&["container", "inspect", id])?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty inspect output".into());
    }
    let parsed: Vec<serde_json::Value> = serde_json::from_str(trimmed)
        .map_err(|e| format!("parse podman inspect: {e}"))?;
    let c = parsed.first().ok_or_else(|| "no inspect data".to_string())?;
    Ok(parse_detail(c))
}

/// The inspect-to-`ContainerDetail` mapping, split out so a captured podman payload can
/// pin the field names in a test without a running machine.
fn parse_detail(c: &serde_json::Value) -> ContainerDetail {
    let text = |v: &str| c[v].as_str().unwrap_or_default().to_string();

    let arg_list = |path: &[&str]| -> Vec<String> {
        let mut cur = c;
        for key in path {
            cur = &cur[*key];
        }
        cur.as_array()
            .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    };
    let command = {
        let mut parts = arg_list(&["Config", "Entrypoint"]);
        parts.extend(arg_list(&["Config", "Cmd"]));
        parts.join(" ")
    };

    let mut mounts: Vec<ContainerMount> = c["Mounts"]
        .as_array()
        .map(|list| {
            list.iter()
                .map(|m| ContainerMount {
                    source: m["Source"].as_str().unwrap_or_default().to_string(),
                    destination: m["Destination"].as_str().unwrap_or_default().to_string(),
                    mode: m["Mode"].as_str().unwrap_or_default().to_string(),
                    kind: m["Type"].as_str().unwrap_or_default().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    mounts.sort_by(|a, b| a.destination.cmp(&b.destination));

    let mut networks: Vec<ContainerNet> = c["NetworkSettings"]["Networks"]
        .as_object()
        .map(|map| {
            map.iter()
                .map(|(name, net)| ContainerNet {
                    name: name.clone(),
                    ip: net["IPAddress"].as_str().unwrap_or_default().to_string(),
                    ipv6: net["GlobalIPv6Address"].as_str().unwrap_or_default().to_string(),
                    mac: net["MacAddress"].as_str().unwrap_or_default().to_string(),
                    gateway: net["Gateway"].as_str().unwrap_or_default().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    networks.sort_by(|a, b| a.name.cmp(&b.name));

    let mut labels: Vec<(String, String)> = c["Config"]["Labels"]
        .as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect())
        .unwrap_or_default();
    labels.sort_by(|a, b| a.0.cmp(&b.0));

    let env: Vec<(String, String)> = c["Config"]["Env"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .filter_map(|s| s.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
                .collect()
        })
        .unwrap_or_default();

    // Published bindings first, then image-exposed ports that were never published.
    let mut ports: Vec<ContainerPort> = Vec::new();
    let mut seen: std::collections::HashSet<String> = std::collections::HashSet::new();
    let mut push = |key: &str, bindings: Option<&Vec<serde_json::Value>>, ports: &mut Vec<ContainerPort>| {
        let (container, proto) = key.split_once('/').unwrap_or((key, ""));
        if !seen.insert(format!("{container}/{proto}")) {
            return;
        }
        let list: &[serde_json::Value] = bindings.map(|b| b.as_slice()).unwrap_or(&[]);
        if list.is_empty() {
            ports.push(ContainerPort {
                container: container.to_string(),
                proto: proto.to_string(),
                host_ip: String::new(),
                host_port: String::new(),
            });
            return;
        }
        for b in list {
            ports.push(ContainerPort {
                container: container.to_string(),
                proto: proto.to_string(),
                host_ip: b["HostIp"].as_str().unwrap_or_default().to_string(),
                host_port: b["HostPort"].as_str().unwrap_or_default().to_string(),
            });
        }
    };
    if let Some(map) = c["NetworkSettings"]["Ports"].as_object() {
        for (key, val) in map {
            push(key, val.as_array(), &mut ports);
        }
    }
    if let Some(map) = c["Config"]["ExposedPorts"].as_object() {
        for key in map.keys() {
            push(key, None, &mut ports);
        }
    }
    ports.sort_by(|a, b| {
        let num = |p: &ContainerPort| p.container.split('-').next().unwrap_or("").parse::<u32>().unwrap_or(0);
        num(a).cmp(&num(b)).then_with(|| a.proto.cmp(&b.proto)).then_with(|| a.host_port.cmp(&b.host_port))
    });

    let health_log = c["State"]["Health"]["Log"]
        .as_array()
        .map(|a| {
            a.iter()
                .rev()
                .take(5)
                .rev()
                .map(|p| HealthProbe {
                    start: p["Start"].as_str().unwrap_or_default().to_string(),
                    exit_code: p["ExitCode"].as_i64().unwrap_or(0),
                    output: p["Output"].as_str().unwrap_or_default().trim().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();

    let image = text("ImageName");
    ContainerDetail {
        id: text("Id").chars().take(12).collect(),
        name: text("Name").trim_start_matches('/').to_string(),
        image: if image.is_empty() { text("Image") } else { image },
        image_id: text("Image").chars().take(12).collect(),
        command,
        created: text("Created"),
        started_at: c["State"]["StartedAt"].as_str().unwrap_or_default().to_string(),
        finished_at: c["State"]["FinishedAt"].as_str().unwrap_or_default().to_string(),
        state: c["State"]["Status"].as_str().unwrap_or_default().to_string(),
        health: c["State"]["Health"]["Status"].as_str().unwrap_or_default().to_string(),
        restart_policy: c["HostConfig"]["RestartPolicy"]["Name"].as_str().unwrap_or_default().to_string(),
        restart_count: c["RestartCount"].as_u64().unwrap_or(0),
        restart_max: c["HostConfig"]["RestartPolicy"]["MaximumRetryCount"].as_u64().unwrap_or(0),
        mounts,
        networks,
        env_count: env.len(),
        env,
        labels,
        ports,
        hostname: c["Config"]["Hostname"].as_str().unwrap_or_default().to_string(),
        workdir: c["Config"]["WorkingDir"].as_str().unwrap_or_default().to_string(),
        user: c["Config"]["User"].as_str().unwrap_or_default().to_string(),
        entrypoint: arg_list(&["Config", "Entrypoint"]).join(" "),
        cmd: arg_list(&["Config", "Cmd"]).join(" "),
        health_test: arg_list(&["Config", "Healthcheck", "Test"]).join(" "),
        health_interval: c["Config"]["Healthcheck"]["Interval"].as_u64().unwrap_or(0),
        health_timeout: c["Config"]["Healthcheck"]["Timeout"].as_u64().unwrap_or(0),
        health_retries: c["Config"]["Healthcheck"]["Retries"].as_u64().unwrap_or(0),
        health_log,
        memory_limit: c["HostConfig"]["Memory"].as_u64().unwrap_or(0),
        nano_cpus: c["HostConfig"]["NanoCpus"].as_i64().unwrap_or(0),
        pid: c["State"]["Pid"].as_i64().unwrap_or(0),
        oom_killed: c["State"]["OOMKilled"].as_bool().unwrap_or(false),
    }
}

/// `podman stats --no-stream --format json`. Podman prints human strings (`0.31%`,
/// `217.1kB / 4.077GB`, `1.02kB / 468B`), unlike Docker's numeric stats, so each field is
/// parsed here into the byte and percent units the live strip expects.
pub fn container_stats() -> Result<Vec<ContainerStat>, String> {
    let raw = run_podman(&["stats", "--no-stream", "--format", "json"])?;
    let trimmed = raw.trim();
    if trimmed.is_empty() || trimmed == "null" {
        return Ok(Vec::new());
    }
    let parsed: Vec<serde_json::Value> = serde_json::from_str(trimmed)
        .map_err(|e| format!("parse podman stats: {e}"))?;
    Ok(parsed
        .iter()
        .map(|s| {
            let (mem, mem_limit) = split_pair(s["mem_usage"].as_str().unwrap_or(""));
            let (rx, tx) = split_pair(s["net_io"].as_str().unwrap_or(""));
            let (read, write) = split_pair(s["block_io"].as_str().unwrap_or(""));
            let mem_pct = s["mem_percent"]
                .as_str()
                .map(percent)
                .unwrap_or(0.0);
            ContainerStat {
                id: s["id"].as_str().unwrap_or_default().to_string(),
                name: s["name"].as_str().unwrap_or_default().to_string(),
                cpu: s["cpu_percent"].as_str().map(percent).unwrap_or(0.0),
                mem,
                mem_limit,
                mem_pct,
                pids: s["pids"].as_str().unwrap_or("0").parse().unwrap_or(0),
                net_rx: rx,
                net_tx: tx,
                block_read: read,
                block_write: write,
            }
        })
        .collect())
}

fn percent(value: &str) -> f64 {
    value.trim().trim_end_matches('%').parse().unwrap_or(0.0)
}

/// Podman writes `used / limit`, with either side possibly missing.
fn split_pair(value: &str) -> (u64, u64) {
    let mut parts = value.split('/').map(str::trim);
    let used = parts.next().map(human_bytes).unwrap_or(0);
    let limit = parts.next().map(human_bytes).unwrap_or(0);
    (used, limit)
}

/// `217.1kB`, `4.077GB`, `468B`, `12MiB` into bytes. Podman prints decimal units; binary
/// spellings are still accepted because podman versions differ.
fn human_bytes(value: &str) -> u64 {
    let text = value.trim();
    let split = text.find(|ch: char| !ch.is_ascii_digit() && ch != '.').unwrap_or(text.len());
    let (number, unit) = text.split_at(split);
    let n: f64 = number.parse().unwrap_or(0.0);
    let mult = match unit.trim() {
        "" | "B" => 1.0,
        "kB" | "KB" => 1e3,
        "MB" => 1e6,
        "GB" => 1e9,
        "TB" => 1e12,
        "KiB" => 1024.0,
        "MiB" => 1024.0 * 1024.0,
        "GiB" => 1024.0 * 1024.0 * 1024.0,
        "TiB" => 1024.0 * 1024.0 * 1024.0 * 1024.0,
        _ => 1.0,
    };
    (n * mult).round() as u64
}

pub fn start(name: &str) -> Result<String, String> {
    run_podman_wait(&["machine", "start", name])
}

pub fn stop(name: &str) -> Result<String, String> {
    run_podman_action(&["machine", "stop", name])
}

/// `podman machine set` argv. Disk is not settable after creation, so it is not offered here:
/// podman only grows a machine's disk when the machine is recreated.
fn machine_set_args(name: &str, cpus: Option<u32>, memory_mb: Option<u32>) -> Vec<String> {
    let mut args: Vec<String> = vec!["machine".into(), "set".into()];
    if let Some(c) = cpus.filter(|c| *c > 0) { args.push("--cpus".into()); args.push(c.to_string()); }
    if let Some(m) = memory_mb.filter(|m| *m > 0) { args.push("--memory".into()); args.push(m.to_string()); }
    args.push(name.to_string());
    args
}

pub fn machine_set(name: &str, cpus: Option<u32>, memory_mb: Option<u32>) -> Result<String, String> {
    let args = machine_set_args(name, cpus, memory_mb);
    let refs: Vec<&str> = args.iter().map(String::as_str).collect();
    let out = run_podman_action(&refs);
    invalidate_disk_usage();
    out
}

pub fn restart(name: &str) -> Result<String, String> {
    run_podman_action(&["machine", "restart", name])
}

pub fn remove(name: &str) -> Result<String, String> {
    freed(run_podman_action(&["machine", "rm", "-f", name]))
}

#[cfg(test)]
mod tests {
    use super::{machine_init_args, parse_disk_usage};

    /// Resizing a machine has the same "empty field must not become a flag" rule as creating it.
    #[test]
    fn machine_set_argv_omits_empty_fields() {
        assert_eq!(super::machine_set_args("dev", None, None), ["machine", "set", "dev"]);
        assert_eq!(super::machine_set_args("dev", Some(0), Some(0)), ["machine", "set", "dev"]);
        assert_eq!(
            super::machine_set_args("dev", Some(8), Some(16384)),
            ["machine", "set", "--cpus", "8", "--memory", "16384", "dev"],
        );
    }

    /// The machine is the Podman daemon; its creation flags are user input, so the argv is
    /// worth pinning: an empty field must not become `--cpus 0`, and a blank name must not be
    /// passed as the machine name.
    #[test]
    fn machine_init_argv_omits_empty_fields() {
        assert_eq!(machine_init_args(None, None, None), ["machine", "init"]);
        assert_eq!(machine_init_args(Some("   "), Some(0), Some(0)), ["machine", "init"]);
        assert_eq!(
            machine_init_args(Some(" dev "), Some(2), Some(2048)),
            ["machine", "init", "--cpus", "2", "--memory", "2048", "dev"],
        );
        assert_eq!(machine_init_args(None, Some(4), None), ["machine", "init", "--cpus", "4"]);
    }

    /// Shape captured from `podman system df --format json` on Podman 6.1.4.
    #[test]
    fn disk_usage_uses_exact_bytes() {
        let raw = r#"[
{"Type":"Images","Total":1,"Active":1,"RawSize":8950903,"RawReclaimable":0,"TotalCount":1,"Size":"8.951MB","Reclaimable":"0B (0%)"},
{"Type":"Containers","Total":1,"Active":1,"RawSize":24882,"RawReclaimable":0,"TotalCount":1,"Size":"24.88kB","Reclaimable":"0B (0%)"},
{"Type":"Local Volumes","Total":1,"Active":0,"RawSize":2097152,"RawReclaimable":2097152,"TotalCount":1,"Size":"2.097MB","Reclaimable":"2.097MB (100%)"}
]"#;
        let usage = parse_disk_usage(raw).expect("rows parse");
        assert_eq!((usage.images, usage.containers, usage.volumes), (8950903, 24882, 2097152));
        assert_eq!(usage.reclaimable, 2097152);
    }

    #[test]
    fn disk_usage_falls_back_to_human_sizes() {
        let raw = r#"[
{"Type":"Images","Size":"1.5GB","Reclaimable":"0B (0%)"},
{"Type":"Local Volumes","Size":"2MB","Reclaimable":"2MB (100%)"}
]"#;
        let usage = parse_disk_usage(raw).expect("rows parse");
        assert_eq!((usage.images, usage.volumes), (1_500_000_000, 2_000_000));
        assert_eq!(usage.reclaimable, 2_000_000);
    }

    #[test]
    fn empty_or_broken_output_has_no_reading() {
        assert!(parse_disk_usage("[]").is_none());
        assert!(parse_disk_usage("not json").is_none());
    }
}





#[cfg(test)]
mod port_tests {
    use super::{render_ports, RawPort};

    fn p(host_ip: &str, host: Option<u16>, target: u16, range: Option<u16>, proto: &str) -> RawPort {
        RawPort {
            host_ip: Some(host_ip.into()),
            container_port: Some(target),
            host_port: host,
            range,
            protocol: Some(proto.into()),
        }
    }

    #[test]
    fn renders_the_docker_ps_shape() {
        assert_eq!(render_ports(vec![p("0.0.0.0", Some(8080), 80, Some(1), "tcp")]), "0.0.0.0:8080->80/tcp");
        assert_eq!(render_ports(vec![p("", Some(9000), 9000, Some(1), "tcp")]), "0.0.0.0:9000->9000/tcp");
        assert_eq!(render_ports(vec![p("", None, 443, None, "tcp")]), "443/tcp");
        assert_eq!(
            render_ports(vec![p("0.0.0.0", Some(8000), 8000, Some(3), "tcp")]),
            "0.0.0.0:8000-8002->8000-8002/tcp",
        );
    }

    #[test]
    fn keeps_the_published_interface_and_protocol() {
        assert_eq!(render_ports(vec![p("127.0.0.1", Some(5555), 5555, Some(1), "udp")]), "127.0.0.1:5555->5555/udp");
    }

    #[test]
    fn sorts_by_target_port() {
        let ports = vec![p("", Some(9000), 9000, Some(1), "tcp"), p("", Some(80), 80, Some(1), "tcp")];
        assert_eq!(render_ports(ports), "0.0.0.0:80->80/tcp, 0.0.0.0:9000->9000/tcp");
    }
}

#[cfg(test)]
mod stats_tests {
    use super::{human_bytes, percent, split_pair};

    #[test]
    fn parses_the_strings_podman_stats_prints() {
        assert_eq!(percent("0.31%"), 0.31);
        assert_eq!(percent(" 12% "), 12.0);
        assert_eq!(split_pair("217.1kB / 4.077GB"), (217_100, 4_077_000_000));
        assert_eq!(split_pair("0B / 0B"), (0, 0));
        assert_eq!(human_bytes("468B"), 468);
        assert_eq!(human_bytes("1.5MB"), 1_500_000);
        assert_eq!(human_bytes("12MiB"), 12 * 1024 * 1024);
    }

    #[test]
    fn unknown_units_do_not_invent_bytes() {
        assert_eq!(human_bytes("--"), 0);
        assert_eq!(split_pair(""), (0, 0));
    }
}

#[cfg(test)]
mod detail_tests {
    use super::parse_detail;

    /// Captured from `podman container inspect` of a running container published on
    /// 18080 with one read-only volume mount (podman 6.1.4).
    const FIXTURE: &str = include_str!(concat!(env!("CARGO_MANIFEST_DIR"), "/tests/fixtures/podman-container-inspect.json"));

    #[test]
    fn maps_the_inspect_payload_the_row_renders() {
        let value: serde_json::Value = serde_json::from_str(FIXTURE).expect("fixture parses");
        let d = parse_detail(&value);
        assert_eq!(d.name, "omp-fixture-probe");
        assert_eq!(d.image, "docker.io/library/alpine:latest");
        assert_eq!(d.state, "running");
        assert_eq!(d.command, "sleep 300");
        assert_eq!(d.workdir, "/");
        assert_eq!(d.id.len(), 12);
        assert!(d.pid > 0);
        assert_eq!(d.networks.len(), 1);
        assert_eq!(d.networks[0].name, "podman");
        assert_eq!(d.ports[0].container, "80");
        assert_eq!(d.ports[0].host_port, "18080");
        assert_eq!(d.mounts[0].destination, "/data");
        assert_eq!(d.mounts[0].kind, "volume");
        assert!(d.env.iter().any(|(k, v)| k == "DEMO" && v == "1"));
        assert_eq!(d.restart_policy, "no");
        assert_eq!(d.memory_limit, 0);
    }
}

/// `podman image inspect` reshaped into Docker's `ImageDetail`. Podman's payload is close
/// to Docker's, but `History` is an array of objects and there is no `image history` CLI
/// with Docker's tabular format, so build history is read from the inspect payload.
pub fn image_detail(id: &str) -> Result<ImageDetail, String> {
    let raw = run_podman(&["image", "inspect", id])?;
    let parsed: Vec<serde_json::Value> =
        serde_json::from_str(raw.trim()).map_err(|e| format!("parse podman image inspect: {e}"))?;
    let img = parsed.first().ok_or("image not found")?;
    let strings = |v: &serde_json::Value| -> Vec<String> {
        v.as_array()
            .map(|a| a.iter().filter_map(|x| x.as_str().map(str::to_string)).collect())
            .unwrap_or_default()
    };
    let joined = |v: &serde_json::Value| strings(v).join(" ");
    let env: Vec<(String, String)> = img["Config"]["Env"]
        .as_array()
        .map(|a| {
            a.iter()
                .filter_map(|v| v.as_str())
                .filter_map(|s| s.split_once('=').map(|(k, v)| (k.to_string(), v.to_string())))
                .collect()
        })
        .unwrap_or_default();
    let mut labels: Vec<(String, String)> = img["Config"]["Labels"]
        .as_object()
        .map(|m| m.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_string())).collect())
        .unwrap_or_default();
    labels.sort_by(|a, b| a.0.cmp(&b.0));
    let history = img["History"]
        .as_array()
        .map(|a| {
            a.iter()
                .map(|h| ImageLayer {
                    created: h["created"].as_str().unwrap_or_default().to_string(),
                    size: h["size"].as_str().unwrap_or_default().to_string(),
                    command: h["created_by"].as_str().unwrap_or_default().to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    Ok(ImageDetail {
        id: img["Id"].as_str().unwrap_or_default().chars().skip(7).take(12).collect(),
        tags: strings(&img["RepoTags"]),
        digests: strings(&img["RepoDigests"]),
        size: img["Size"].as_u64().unwrap_or(0),
        created: img["Created"].as_str().unwrap_or_default().to_string(),
        architecture: img["Architecture"].as_str().unwrap_or_default().to_string(),
        os: img["Os"].as_str().unwrap_or_default().to_string(),
        author: img["Author"].as_str().unwrap_or_default().to_string(),
        entrypoint: joined(&img["Config"]["Entrypoint"]),
        cmd: joined(&img["Config"]["Cmd"]),
        workdir: img["Config"]["WorkingDir"].as_str().unwrap_or_default().to_string(),
        user: img["Config"]["User"].as_str().unwrap_or_default().to_string(),
        env_count: env.len(),
        env,
        labels,
        exposed_ports: {
            let mut ports: Vec<String> = img["Config"]["ExposedPorts"]
                .as_object()
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            ports.sort();
            ports
        },
        volumes: {
            let mut vols: Vec<String> = img["Config"]["Volumes"]
                .as_object()
                .map(|m| m.keys().cloned().collect())
                .unwrap_or_default();
            vols.sort();
            vols
        },
        layers: img["RootFS"]["Layers"].as_array().map(|a| a.len()).unwrap_or(0),
        history,
    })
}

/// `podman volume inspect` reshaped into Docker's `VolumeDetail`.
pub fn volume_detail(name: &str) -> Result<VolumeDetail, String> {
    let raw = run_podman(&["volume", "inspect", name])?;
    let parsed: Vec<serde_json::Value> =
        serde_json::from_str(raw.trim()).map_err(|e| format!("parse podman volume inspect: {e}"))?;
    let v = parsed.first().ok_or("volume not found")?;
    let pairs = |val: &serde_json::Value| -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = val
            .as_object()
            .map(|m| m.iter().map(|(k, x)| (k.clone(), x.as_str().unwrap_or_default().to_string())).collect())
            .unwrap_or_default();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    };
    // Size from the cached system df scan, like Docker.
    let size = volume_sizes().and_then(|m| m.get(name).map(|(s, _)| *s));
    Ok(VolumeDetail {
        name: v["Name"].as_str().unwrap_or_default().to_string(),
        driver: v["Driver"].as_str().unwrap_or_default().to_string(),
        mountpoint: v["Mountpoint"].as_str().unwrap_or_default().to_string(),
        created: v["CreatedAt"].as_str().unwrap_or_default().to_string(),
        scope: v["Scope"].as_str().unwrap_or_default().to_string(),
        labels: pairs(&v["Labels"]),
        options: pairs(&v["Options"]),
        size,
    })
}

/// `podman network inspect` reshaped into Docker's `NetworkDetail`.
pub fn network_detail(name: &str) -> Result<NetworkDetail, String> {
    let raw = run_podman(&["network", "inspect", name])?;
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Err("empty inspect output".into());
    }
    let parsed: Vec<serde_json::Value> = serde_json::from_str(trimmed)
        .map_err(|e| format!("parse podman network inspect: {e}"))?;
    let net = parsed.first().ok_or("network not found")?;
    let pairs = |val: &serde_json::Value| -> Vec<(String, String)> {
        let mut out: Vec<(String, String)> = val
            .as_object()
            .map(|m| m.iter().map(|(k, x)| (k.clone(), x.as_str().unwrap_or_default().to_string())).collect())
            .unwrap_or_default();
        out.sort_by(|a, b| a.0.cmp(&b.0));
        out
    };
    let mut containers: Vec<NetworkMember> = net["containers"]
        .as_object()
        .map(|m| {
            m.iter()
                .map(|(id, c)| NetworkMember {
                    id: id.clone(),
                    name: c["name"].as_str().unwrap_or_default().to_string(),
                    ip: c["interfaces"]["eth0"]["subnets"][0]["ipnet"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                    ipv6: String::new(),
                    mac: c["interfaces"]["eth0"]["mac_address"]
                        .as_str()
                        .unwrap_or_default()
                        .to_string(),
                })
                .collect()
        })
        .unwrap_or_default();
    containers.sort_by(|a, b| a.name.cmp(&b.name));
    let subnet_info = net["subnets"].as_array().and_then(|a| a.first());
    Ok(NetworkDetail {
        id: net["id"].as_str().unwrap_or_default().chars().take(12).collect(),
        name: net["name"].as_str().unwrap_or_default().to_string(),
        driver: net["driver"].as_str().unwrap_or_default().to_string(),
        scope: net["scope"].as_str().unwrap_or_default().to_string(),
        created: net["created"].as_str().unwrap_or_default().to_string(),
        internal: net["internal"].as_bool().unwrap_or(false),
        enable_ipv6: net["ipv6_enabled"].as_bool().unwrap_or(false),
        subnet: subnet_info.and_then(|c| c["subnet"].as_str()).unwrap_or_default().to_string(),
        gateway: subnet_info.and_then(|c| c["gateway"].as_str()).unwrap_or_default().to_string(),
        ip_range: String::new(),
        labels: pairs(&net["labels"]),
        options: pairs(&net["options"]),
        containers,
    })
}
