use serde::{Deserialize, Serialize};
use std::io::{BufRead, BufReader, Read};
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::{Mutex, RwLock};
use std::time::{Duration, Instant};

pub(crate) fn colima_bin() -> String {
    crate::tools::which_bin("colima")
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/opt/homebrew/bin/colima".to_string())
}

/// Colima prints logrus records on failure (`time="…" level=fatal msg="…"`).
/// Keep only the message and turn its escaped newlines into real ones.
fn humanize(raw: &str) -> String {
    let raw = raw.trim();
    if let Some(pos) = raw.find("msg=\"") {
        let mut out = String::new();
        let mut chars = raw[pos + 5..].chars();
        while let Some(c) = chars.next() {
            match c {
                '\\' => match chars.next() {
                    Some('n') => out.push('\n'),
                    Some('t') => out.push('\t'),
                    Some(other) => out.push(other),
                    None => break,
                },
                '"' => break,
                other => out.push(other),
            }
        }
        if !out.trim().is_empty() {
            return out.trim().to_string();
        }
    }
    raw.to_string()
}

fn home_dir() -> PathBuf {
    match std::env::var("HOME") {
        Ok(home) if !home.trim().is_empty() => PathBuf::from(home),
        _ => PathBuf::from("/tmp"),
    }
}

/// The Colima config home. Reading profile configs, the template and a stopped profile's
/// socket means landing on the same directory the CLI itself uses — see
/// [`resolve_colima_home`] for the order and why it is not guessed.
pub fn colima_home() -> PathBuf {
    let env = |key: &str| std::env::var(key).ok();
    resolve_colima_home(
        env("COLIMA_HOME").as_deref(),
        &home_dir().to_string_lossy(),
        env("XDG_CONFIG_HOME").as_deref(),
    )
}

/// Pure form of [`colima_home`], so the precedence is testable without mutating the
/// process environment (tests run in parallel threads).
///
/// Measured against colima 0.10.3: `$COLIMA_HOME` when that directory exists, then
/// `~/.colima` when it exists (the CLI prints `found ~/.colima, ignoring
/// $XDG_CONFIG_HOME`), then `$XDG_CONFIG_HOME/colima` when the variable is set and
/// non-empty, else `~/.colima`. `~/.config/colima` alone never counts, because the
/// variable has to name it.
///
/// Existence alone decides. A directory holding no state still wins in the CLI, so a
/// "does it look populated" test here would disagree with the command we shell out to.
pub fn resolve_colima_home(colima_home: Option<&str>, home: &str, xdg: Option<&str>) -> PathBuf {
    if let Some(dir) = colima_home.map(str::trim).filter(|d| !d.is_empty()) {
        let path = PathBuf::from(dir);
        if path.is_dir() {
            return path;
        }
    }
    let home = if home.trim().is_empty() { "/tmp" } else { home };
    let legacy = PathBuf::from(home).join(".colima");
    if legacy.is_dir() {
        return legacy;
    }
    match xdg.map(str::trim).filter(|d| !d.is_empty()) {
        Some(xdg) => PathBuf::from(xdg).join("colima"),
        None => legacy,
    }
}

/// A `colima` read. `list`, `status`, `version` and `ssh-config` answer from local state,
/// so the read deadline is generous rather than tight.
pub fn run(args: &[&str]) -> Result<String, String> {
    run_with(args, crate::proc::READ_LIMIT)
}

/// A start, stop, restart, delete, prune, update, model pull or model run: minutes of
/// legitimate work with no progress output. Killing one mid-flight is worse than waiting —
/// a killed `colima start` leaves a half-provisioned VM and a killed pull a partial layer —
/// so these carry no deadline.
fn run_action(args: &[&str]) -> Result<String, String> {
    run_with(args, crate::proc::NO_LIMIT)
}

fn run_with(args: &[&str], limit: Option<Duration>) -> Result<String, String> {
    let mut cmd = Command::new(colima_bin());
    cmd.args(args);
    let out = crate::proc::run(&mut cmd, limit).map_err(|e| e.to_string())?;
    if out.success {
        Ok(out.stdout)
    } else {
        Err(humanize(&out.stderr))
    }
}

/// One `colima ssh -- sh -c` round trip for a read-only report. A stopped profile or a
/// denied sudo returns Colima's message instead of blocking the caller. The deadline is the
/// long one: the guest script walks `/var/lib/docker`, which can take a while on a full VM.
pub fn ssh_script(profile: &str, script: &str) -> Result<String, String> {
    let mut cmd = Command::new(colima_bin());
    cmd.args(["ssh", "-p", profile, "--", "sh", "-c", script]);
    let out = crate::proc::run(&mut cmd, crate::proc::ACTION_LIMIT).map_err(|e| e.to_string())?;
    if out.success {
        Ok(out.stdout)
    } else {
        Err(humanize(&out.stderr))
    }
}

/// Lima instance name for a Colima profile: the default profile is the "colima" instance.
pub(crate) fn instance_name(profile: &str) -> &str {
    if profile == "default" { "colima" } else { profile }
}

/// The profile's disk image on the host: path plus the bytes it actually occupies.
/// The image is sparse, so `len()` overstates it; allocated blocks are what Finder charges.
pub fn disk_image(profile: &str) -> (String, u64) {
    let instance = instance_name(profile);
    // Colima runs limactl with LIMA_HOME pointing at `<colima_home>/_lima`, so that leg
    // comes first; the other two cover a lima relocation and a hand-run VM.
    let mut candidates = vec![colima_home().join("_lima").join(instance).join("disk")];
    if let Some(lima) = std::env::var("LIMA_HOME").ok().map(|d| d.trim().to_string()).filter(|d| !d.is_empty()) {
        candidates.push(PathBuf::from(lima).join(instance).join("disk"));
    }
    candidates.push(home_dir().join(".lima").join(instance).join("disk"));
    for path in candidates {
        let Ok(meta) = std::fs::metadata(&path) else { continue };
        #[cfg(unix)]
        let bytes = {
            use std::os::unix::fs::MetadataExt;
            meta.blocks() * 512
        };
        #[cfg(not(unix))]
        let bytes = meta.len();
        if bytes > 0 {
            return (path.display().to_string(), bytes);
        }
    }
    (String::new(), 0)
}

#[derive(Deserialize, Clone, serde::Serialize)]
pub struct Profile {
    pub name: String,
    pub status: String,
    #[serde(default)]
    pub arch: Option<String>,
    #[serde(default)]
    pub cpus: Option<u32>,
    #[serde(default)]
    pub memory: Option<u64>,
    #[serde(default)]
    pub disk: Option<u64>,
    #[serde(default)]
    pub runtime: Option<String>,
    /// Lima's instance field is `IPAddress`; older shapes say `address`. Empty when the
    /// VM has no reachable address (the default shared network).
    #[serde(default, alias = "IPAddress", alias = "address", rename = "ip_address")]
    pub ip_address: Option<String>,
}

/// `colima list --json` answers one question for the whole window, and the launch asks it
/// twice: the first read of the window, then the first refresh. The gate makes the second
/// caller wait for the run already in flight instead of spawning the CLI again; the short
/// TTL keeps it honest for everyone else (the 15 s refresh still reads the CLI).
static LIST_GATE: Mutex<()> = Mutex::new(());
static LIST_CACHE: RwLock<Option<(Instant, Vec<Profile>)>> = RwLock::new(None);
/// Longer than a CLI run, shorter than a refresh cycle, so a profile started or
/// stopped by another window cannot hide behind it. The refresh itself runs every 15 s
/// (60 s with the event stream), so a shorter TTL could never serve two consecutive waves;
/// every path that changes the list calls `invalidate_profiles()` anyway.
const LIST_TTL: Duration = Duration::from_secs(10);

pub fn list_profiles() -> Result<Vec<Profile>, String> {
    let _gate = LIST_GATE.lock().unwrap_or_else(|e| e.into_inner());
    if let Ok(slot) = LIST_CACHE.read() {
        if let Some((at, cached)) = slot.as_ref() {
            if at.elapsed() < LIST_TTL {
                return Ok(cached.clone());
            }
        }
    }
    let out = read_profiles()?;
    if let Ok(mut slot) = LIST_CACHE.write() {
        *slot = Some((Instant::now(), out.clone()));
    }
    Ok(out)
}

/// Drops the cached list: the set of profiles or one profile's state just changed.
pub fn invalidate_profiles() {
    if let Ok(mut slot) = LIST_CACHE.write() {
        *slot = None;
    }
    // A start, stop or delete changes the status too; never let it outlive the mutation.
    STATUS_CACHE.clear();
}

/// Runs `colima list` while the window is still loading its bundle, so the first read the
/// view makes is already answered.
pub fn prefetch_profiles() {
    let _ = list_profiles();
}

fn read_profiles() -> Result<Vec<Profile>, String> {
    let raw = run(&["list", "--json"])?;
    let mut out = Vec::new();
    for line in raw.lines() {
        let t = line.trim();
        if t.is_empty() { continue; }
        if let Ok(p) = serde_json::from_str::<Profile>(t) {
            out.push(p);
        }
    }
    if out.is_empty() {
        if let Ok(v) = serde_json::from_str::<Vec<Profile>>(raw.trim()) {
            return Ok(v);
        }
        return Err("no profiles parsed".to_string());
    }
    Ok(out)
}

#[derive(Deserialize, Clone, serde::Serialize)]
pub struct Status {
    pub display_name: Option<String>,
    pub driver: Option<String>,
    pub arch: Option<String>,
    pub runtime: Option<String>,
    pub mount_type: Option<String>,
    pub docker_socket: Option<String>,
    pub containerd_socket: Option<String>,
    pub cpu: Option<u32>,
    pub memory: Option<u64>,
    pub disk: Option<u64>,
}

/// `colima status --json` costs 1.3 s (median of 5, colima 0.10.3, 2026-11-19) — two to three
/// times `colima list --json` — and
/// answers almost nothing the list did not: only the sockets, driver, mount type and display
/// name. It sits on the mount path, on every ⌘R and, through `act()`, on every mutation, where
/// it kept the header spinner and the disabled buttons up ~800 ms after the data had landed.
///
/// None of those fields changes while the profile runs: sizing only moves when a start or
/// restart passes new flags, and every such path calls `invalidate_profiles()`. So the cache
/// is per profile (switching back is free) and lives far longer than the profile list, which
/// is what actually refreshes the running state every 15 s. Without that, `act()` re-ran a
/// 1.3 s CLI call after removing a container, just to re-read a socket path.
const STATUS_TTL: Duration = Duration::from_secs(300);

/// One entry per profile, stamped with the `Instant` the CLI answered. A `Vec`, not a map:
/// a window has a handful of profiles, and `Vec::new()` is `const`, so the cache needs no
/// lazy initialisation.
struct StatusCache {
    entries: RwLock<Vec<(String, Instant, Status)>>,
}

impl StatusCache {
    const fn new() -> Self {
        Self { entries: RwLock::new(Vec::new()) }
    }

    fn get(&self, profile: &str, now: Instant, max_age: Duration) -> Option<Status> {
        let entries = self.entries.read().ok()?;
        let (_, at, cached) = entries.iter().find(|(name, _, _)| name == profile)?;
        (now.saturating_duration_since(*at) < max_age).then(|| cached.clone())
    }

    /// Stores one answer, dropping every entry older than `max_age` so a long-lived window
    /// cannot accumulate the profiles it has seen.
    fn put(&self, profile: &str, now: Instant, status: &Status, max_age: Duration) {
        if let Ok(mut entries) = self.entries.write() {
            entries.retain(|(name, at, _)| {
                name != profile && now.saturating_duration_since(*at) < max_age
            });
            entries.push((profile.to_string(), now, status.clone()));
        }
    }

    fn clear(&self) {
        if let Ok(mut entries) = self.entries.write() {
            entries.clear();
        }
    }
}

static STATUS_CACHE: StatusCache = StatusCache::new();

pub fn status(profile: &str) -> Result<Status, String> {
    status_with(&STATUS_CACHE, profile, Instant::now(), STATUS_TTL, &fetch_status)
}

/// `colima status` again, past the cache: a manual Refresh means "go ask", so it must not be
/// answered by an entry up to five minutes old.
pub fn status_fresh(profile: &str) -> Result<Status, String> {
    let fetched = fetch_status(profile)?;
    STATUS_CACHE.put(profile, Instant::now(), &fetched, STATUS_TTL);
    Ok(fetched)
}

/// The cache policy, separated from the CLI so it can be tested without a VM: a hit within
/// `max_age` never calls `fetch`, and one profile's entry never answers for another.
fn status_with(
    cache: &StatusCache,
    profile: &str,
    now: Instant,
    max_age: Duration,
    fetch: &dyn Fn(&str) -> Result<Status, String>,
) -> Result<Status, String> {
    if let Some(cached) = cache.get(profile, now, max_age) {
        return Ok(cached);
    }
    let fetched = fetch(profile)?;
    cache.put(profile, now, &fetched, max_age);
    Ok(fetched)
}

fn fetch_status(profile: &str) -> Result<Status, String> {
    let raw = if profile == "default" {
        run(&["status", "--json"])?
    } else {
        run(&["status", "--json", "-p", profile])?
    };
    let mut json = String::new();
    for line in raw.lines() {
        let t = line.trim();
        if t.starts_with('{') { json = t.to_string(); break; }
    }
    if json.is_empty() { json = raw.trim().to_string(); }
    serde_json::from_str(&json).map_err(|e| format!("parse status: {e}"))
}

pub fn version() -> String {
    run(&["version"]).unwrap_or_else(|e| e)
}

/// Docker endpoint for a profile. Falls back to the conventional socket path when
/// the profile is stopped, so commands fail against the right socket instead of
/// silently reusing another profile's daemon. Callers that already ran `status`
/// pass it in; that command costs ~1.3 s, so it must never run twice in one switch.
pub fn docker_endpoint(profile: &str, status: Option<&Status>) -> String {
    if let Some(socket) = status.and_then(|st| st.docker_socket.clone()) {
        if !socket.is_empty() {
            return socket;
        }
    }
    let dir = if profile == "default" { "default".to_string() } else { profile.to_string() };
    format!("unix://{}/{dir}/docker.sock", colima_home().display())
}

pub fn template() -> Result<String, String> {
    let path = colima_home().join("_templates").join("default.yaml");
    std::fs::read_to_string(&path).map_err(|e| format!("read template: {e}"))
}

pub fn ssh_config(profile: &str) -> Result<String, String> {
    if profile == "default" { run(&["ssh-config"]) } else { run(&["ssh-config", "-p", profile]) }
}


#[derive(Deserialize, Clone, serde::Serialize, Debug, PartialEq)]
pub struct DnsHost {
    pub name: String,
    pub target: String,
}

/// One row of Colima's `mounts:` list. `location` is the host path; `writable` is the
/// `:w` suffix on the CLI flag.
#[derive(Deserialize, Clone, serde::Serialize, Debug, PartialEq)]
pub struct MountSpec {
    pub location: String,
    pub writable: bool,
}

#[derive(Deserialize, Clone, serde::Serialize, Debug, PartialEq)]
pub struct ProfileConfig {
    pub vm_type: String,
    pub runtime: String,
    pub arch: String,
    pub mount_type: String,
    pub cpu: u32,
    pub memory: u32,
    pub disk: u32,
    pub rosetta: bool,
    /// `shared` or `bridged`. Immutable after the VM exists: Colima discards a changed mode.
    pub network_mode: String,
    pub network_interface: String,
    /// Assign a reachable IP. Once enabled it cannot be disabled without recreating.
    pub network_address: bool,
    pub network_preferred_route: bool,
    pub network_host_addresses: bool,
    pub gateway_address: String,
    pub dns: Vec<String>,
    pub dns_hosts: Vec<DnsHost>,
    /// `ssh`, `grpc` or `none`. `grpc` is the only one that carries UDP.
    pub port_forwarder: String,
    pub ssh_agent: bool,
    pub mount_inotify: bool,
    pub mounts: Vec<MountSpec>,
    /// Recreate reads these to preserve settings that `colima delete` would otherwise drop.
    pub hostname: String,
    pub kubernetes: bool,
    pub k3s_args: Vec<String>,
}

impl Default for ProfileConfig {
    fn default() -> Self {
        Self {
            vm_type: "vz".into(), runtime: "docker".into(), arch: "aarch64".into(),
            mount_type: "virtiofs".into(), cpu: 2, memory: 2, disk: 60, rosetta: false,
            network_mode: "shared".into(), network_interface: "en0".into(),
            network_address: false, network_preferred_route: false, network_host_addresses: false,
            gateway_address: "192.168.5.2".into(), dns: Vec::new(), dns_hosts: Vec::new(),
            port_forwarder: "ssh".into(), ssh_agent: false, mount_inotify: false,
            mounts: vec![MountSpec { location: "~".into(), writable: true }],
            hostname: String::new(), kubernetes: false, k3s_args: Vec::new(),
        }
    }
}

pub fn profile_config(profile: &str) -> Result<ProfileConfig, String> {
    profile_config_in(&colima_home(), profile)
}

/// The config of one profile under a given Colima home. Split from [`profile_config`]
/// so a test can read a temp directory instead of the user's real one.
fn profile_config_in(home: &Path, profile: &str) -> Result<ProfileConfig, String> {
    let path = home.join(profile).join("colima.yaml");
    let text = std::fs::read_to_string(&path).map_err(|e| format!("read config: {e}"))?;
    Ok(ProfileConfig::from_yaml(&parse_yaml(&text)))
}

/// A YAML subset reader. Colima writes a flat map whose only nested values we read are
/// `network:` (a map), `mounts:` (a list of maps) and `dnsHosts:` (a map) — a full YAML
/// dependency would be a large surface for that. Comments, blank lines, quoted scalars,
/// inline `[]`/`{}`, `null`, block lists and block maps are all this needs.
#[derive(Debug, PartialEq)]
enum Yaml {
    Scalar(String),
    List(Vec<Yaml>),
    Map(Vec<(String, Yaml)>),
}

impl Yaml {
    fn get(&self, key: &str) -> Option<&Yaml> {
        match self {
            Yaml::Map(entries) => entries.iter().find(|(k, _)| k == key).map(|(_, v)| v),
            _ => None,
        }
    }

    /// A scalar, or `None` for null/empty. Quoted values lose their quotes; `~` stays a
    /// value because Colima writes the home mount as `location: "~"`.
    fn text(&self) -> Option<&str> {
        match self {
            Yaml::Scalar(s) if !s.is_empty() && s != "null" => Some(s),
            _ => None,
        }
    }

    fn flag(&self) -> bool {
        self.text() == Some("true")
    }

    fn int(&self) -> Option<u32> {
        self.text()?.parse().ok()
    }

    fn items(&self) -> &[Yaml] {
        match self {
            Yaml::List(items) => items,
            _ => &[],
        }
    }
}

fn indent_of(line: &str) -> usize {
    line.len() - line.trim_start().len()
}

fn yaml_scalar(raw: &str) -> Yaml {
    let value = raw.trim();
    if let Some(inner) = value.strip_prefix('[').and_then(|v| v.strip_suffix(']')) {
        if inner.trim().is_empty() {
            return Yaml::List(Vec::new());
        }
        return Yaml::List(inner.split(',').map(yaml_scalar).collect());
    }
    if value == "{}" {
        return Yaml::Map(Vec::new());
    }
    Yaml::Scalar(value.trim_matches('"').trim_matches('\'').to_string())
}

/// A YAML mapping separator is `:` followed by a space or end of line. Without that rule a
/// scalar list item such as `- https://mirror.gcr.io` would parse as a key and a value.
fn yaml_pair(text: &str) -> Option<(&str, &str)> {
    let (key, value) = text.split_once(':')?;
    (value.is_empty() || value.starts_with(' ')).then_some((key, value))
}

/// `i` is the first line of the block; `indent` is the column its keys/items start at.
/// Returns the value and the first line after the block.
fn yaml_block(lines: &[(usize, &str)], mut i: usize, indent: usize) -> (Yaml, usize) {
    if i < lines.len() && lines[i].0 == indent && lines[i].1.starts_with("- ") {
        let mut items = Vec::new();
        while i < lines.len() && lines[i].0 == indent && lines[i].1.starts_with("- ") {
            let item = &lines[i].1[2..];
            i += 1;
            match yaml_pair(item) {
                Some((key, value)) => {
                    let mut entries = vec![(key.trim().to_string(), yaml_scalar(value))];
                    // Continuation keys of the same list item (`- location:` then `writable:`).
                    while i < lines.len() && lines[i].0 > indent && !lines[i].1.starts_with("- ") {
                        if let Some((k, v)) = yaml_pair(lines[i].1) {
                            entries.push((k.trim().to_string(), yaml_scalar(v)));
                        }
                        i += 1;
                    }
                    items.push(Yaml::Map(entries));
                }
                None => items.push(yaml_scalar(item)),
            }
        }
        return (Yaml::List(items), i);
    }

    let mut entries = Vec::new();
    while i < lines.len() && lines[i].0 == indent {
        let (key, value) = match yaml_pair(lines[i].1) {
            Some(pair) => pair,
            None => { i += 1; continue; }
        };
        let key = key.trim().to_string();
        let value = value.trim();
        i += 1;
        if value.is_empty() && i < lines.len() && lines[i].0 > indent {
            let (child, next) = yaml_block(lines, i, lines[i].0);
            entries.push((key, child));
            i = next;
        } else {
            entries.push((key, yaml_scalar(value)));
        }
    }
    (Yaml::Map(entries), i)
}

fn parse_yaml(text: &str) -> Yaml {
    let lines: Vec<(usize, &str)> = text
        .lines()
        .map(|line| line.trim_end())
        .filter(|line| !line.trim().is_empty() && !line.trim_start().starts_with('#'))
        .map(|line| (indent_of(line), line.trim_start()))
        .collect();
    yaml_block(&lines, 0, 0).0
}

impl ProfileConfig {
    fn from_yaml(root: &Yaml) -> Self {
        let mut cfg = Self::default();
        if let Some(v) = root.get("vmType").and_then(Yaml::text) { cfg.vm_type = v.into(); }
        if let Some(v) = root.get("runtime").and_then(Yaml::text) { cfg.runtime = v.into(); }
        if let Some(v) = root.get("arch").and_then(Yaml::text) { cfg.arch = v.into(); }
        if let Some(v) = root.get("mountType").and_then(Yaml::text) { cfg.mount_type = v.into(); }
        if let Some(v) = root.get("cpu").and_then(Yaml::int) { cfg.cpu = v; }
        if let Some(v) = root.get("memory").and_then(Yaml::int) { cfg.memory = v; }
        if let Some(v) = root.get("disk").and_then(Yaml::int) { cfg.disk = v; }
        if let Some(v) = root.get("rosetta") { cfg.rosetta = v.flag(); }
        if let Some(v) = root.get("hostname").and_then(Yaml::text) { cfg.hostname = v.into(); }
        if let Some(v) = root.get("portForwarder").and_then(Yaml::text) { cfg.port_forwarder = v.into(); }
        if let Some(v) = root.get("forwardAgent") { cfg.ssh_agent = v.flag(); }
        if let Some(v) = root.get("mountInotify") { cfg.mount_inotify = v.flag(); }
        if let Some(v) = root.get("mounts") { cfg.mounts = mounts_from(v); }
        if let Some(k8s) = root.get("kubernetes") {
            if let Some(v) = k8s.get("enabled") { cfg.kubernetes = v.flag(); }
            if let Some(v) = k8s.get("k3sArgs") {
                cfg.k3s_args = v.items().iter().filter_map(|i| i.text().map(str::to_string)).collect();
            }
        }
        if let Some(net) = root.get("network") {
            if let Some(v) = net.get("mode").and_then(Yaml::text) { cfg.network_mode = v.into(); }
            if let Some(v) = net.get("interface").and_then(Yaml::text) { cfg.network_interface = v.into(); }
            if let Some(v) = net.get("address") { cfg.network_address = v.flag(); }
            if let Some(v) = net.get("preferredRoute") { cfg.network_preferred_route = v.flag(); }
            if let Some(v) = net.get("hostAddresses") { cfg.network_host_addresses = v.flag(); }
            if let Some(v) = net.get("gatewayAddress").and_then(Yaml::text) { cfg.gateway_address = v.into(); }
            if let Some(v) = net.get("dns") { cfg.dns = v.items().iter().filter_map(|i| i.text().map(str::to_string)).collect(); }
            if let Some(Yaml::Map(entries)) = net.get("dnsHosts") {
                cfg.dns_hosts = entries.iter()
                    .filter_map(|(name, target)| target.text().map(|t| DnsHost { name: name.clone(), target: t.to_string() }))
                    .collect();
            }
        }
        // Older configs kept DNS at the top level.
        if cfg.dns.is_empty() && let Some(v) = root.get("dns") {
            cfg.dns = v.items().iter().filter_map(|i| i.text().map(str::to_string)).collect();
        }
        cfg
    }
}

fn mounts_from(value: &Yaml) -> Vec<MountSpec> {
    value.items().iter().filter_map(|item| match item {
        Yaml::Map(_) => {
            let location = item.get("location").and_then(Yaml::text)?;
            Some(MountSpec {
                location: location.into(),
                writable: item.get("writable").map(Yaml::flag).unwrap_or(false),
            })
        }
        Yaml::Scalar(s) if !s.is_empty() && s != "null" => Some(MountSpec { location: s.clone(), writable: false }),
        _ => None,
    }).collect()
}

/// Model and runner names come from a text field and end up in colima's argv — and, for the
/// Terminal path, inside an AppleScript string that a shell executes. Colima accepts
/// `hf.co/owner/model:tag`-style refs, so this whitelist is what those need and nothing more:
/// no spaces, no quotes, no `;`, `$`, backticks, and no leading `-` that would read as a flag.
pub fn safe_model_arg(value: &str, what: &str) -> Result<(), String> {
    let ok = !value.is_empty()
        && !value.starts_with('-')
        && value.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '/' | ':' | '@' | '+' | '-'))
        && value.len() <= 200;
    if ok { Ok(()) } else { Err(format!("{what} {value:?} is not a model reference: use letters, digits, '.', '_', '/', ':', '@', '+', '-'")) }
}

pub fn model_list(profile: &str) -> Result<String, String> {
    let mut a: Vec<&str> = vec!["model", "list"];
    if profile != "default" { a.push("-p"); a.push(profile); }
    run(&a)
}

pub fn model_pull(profile: &str, model: &str, runner: &str) -> Result<String, String> {
    safe_model_arg(model, "Model")?;
    if !runner.is_empty() { safe_model_arg(runner, "Runner")?; }
    let mut a: Vec<&str> = vec!["model", "pull", model];
    if !runner.is_empty() && runner != "docker" { a.push("--runner"); a.push(runner); }
    if profile != "default" { a.push("-p"); a.push(profile); }
    run_action(&a)
}

pub fn model_setup(profile: &str, runner: &str) -> Result<String, String> {
    if !runner.is_empty() { safe_model_arg(runner, "Runner")?; }
    let mut a: Vec<&str> = vec!["model", "setup"];
    if !runner.is_empty() && runner != "docker" { a.push("--runner"); a.push(runner); }
    if profile != "default" { a.push("-p"); a.push(profile); }
    run_action(&a)
}

/// Opens an interactive chat session in Terminal.app (GUI cannot host a TTY).
pub fn model_run_terminal(profile: &str, model: &str, runner: &str) -> Result<String, String> {
    safe_model_arg(model, "Model")?;
    if !runner.is_empty() { safe_model_arg(runner, "Runner")?; }
    let mut cmd = format!("colima model run {model}");
    if !runner.is_empty() && runner != "docker" { cmd.push_str(&format!(" --runner {runner}")); }
    if profile != "default" { cmd.push_str(&format!(" -p {profile}")); }
    let script = cmd.replace('\\', "\\\\").replace('"', "\\\"");
    let out = Command::new("osascript")
        .args(["-e", &format!("tell application \"Terminal\" to do script \"{script}\""), "-e", "tell application \"Terminal\" to activate"])
        .output()
        .map_err(|e| format!("open Terminal: {e}"))?;
    if out.status.success() { Ok(format!("Opened: {cmd}")) } else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
}

pub fn model_serve_start(profile: &str, model: &str, runner: &str, port: u32) -> Result<u32, String> {
    safe_model_arg(model, "Model")?;
    if !runner.is_empty() { safe_model_arg(runner, "Runner")?; }
    let mut a: Vec<String> = vec!["model".into(), "serve".into(), model.into()];
    if !runner.is_empty() && runner != "docker" { a.push("--runner".into()); a.push(runner.into()); }
    if port > 0 { a.push("--port".into()); a.push(port.to_string()); }
    if profile != "default" { a.push("-p".into()); a.push(profile.into()); }
    let child = Command::new(colima_bin())
        .args(&a)
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| format!("spawn serve: {e}"))?;
    Ok(child.id())
}

pub fn model_serve_stop(pid: u32) -> Result<String, String> {
    let out = Command::new("kill").arg("-TERM").arg(pid.to_string()).output().map_err(|e| e.to_string())?;
    if out.status.success() { Ok("Stopped model server".into()) } else { Err(String::from_utf8_lossy(&out.stderr).to_string()) }
}

#[derive(Deserialize, Clone, serde::Serialize)]
pub struct StartOpts {
    pub profile: String,
    pub cpus: Option<u32>,
    pub memory: Option<u64>,
    pub disk: Option<u64>,
    pub runtime: Option<String>,
    pub arch: Option<String>,
    pub vm_type: Option<String>,
    pub rosetta: Option<bool>,
    /// `--mount`, one entry per directory; `["none"]` disables mounts.
    pub mounts: Option<Vec<String>>,
    /// Only applied when the VM is created (`--mount-type`).
    pub mount_type: Option<String>,
    pub mount_inotify: Option<bool>,
    pub hostname: Option<String>,
    /// Immutable after creation: Colima discards a changed mode.
    pub network_mode: Option<String>,
    pub network_interface: Option<String>,
    pub network_address: Option<bool>,
    pub network_preferred_route: Option<bool>,
    pub network_host_addresses: Option<bool>,
    pub gateway_address: Option<String>,
    /// Repeated `--dns`, one resolver per entry.
    pub dns: Option<Vec<String>>,
    /// Repeated `--dns-host`, each `name=target`.
    pub dns_hosts: Option<Vec<String>>,
    /// `ssh`, `grpc` or `none`.
    pub port_forwarder: Option<String>,
    pub ssh_agent: Option<bool>,
    /// Start the VM with Kubernetes (k3s). A profile created without it can enable it later
    /// from the Kubernetes page, but only by provisioning the running VM.
    pub kubernetes: Option<bool>,
    /// Passed straight through as `--k3s-arg`; empty means Colima's default (`--disable=traefik`).
    pub k3s_arg: Option<String>,
}

/// `--vz-rosetta` is registered whatever `--vm-type` says, but only a vz VM runs it, so
/// sending it with qemu or krunkit would let the UI promise amd64 emulation that never runs.
pub fn rosetta_applies(vm_type: Option<&str>) -> bool {
    matches!(vm_type, None | Some("vz"))
}

fn choice(what: &str, value: Option<&str>, allowed: &[&str]) -> Result<(), String> {
    match value {
        None => Ok(()),
        Some(v) if allowed.contains(&v) => Ok(()),
        Some(v) => Err(format!("{what} {v:?} is not one of {}", allowed.join(", "))),
    }
}

/// Reject what Colima would either ignore or turn into a surprising VM: a bad resolver,
/// a gateway whose last octet is not 2, an ifname longer than the kernel allows, a mount
/// path that reads as a flag or splits the comma-separated string list.
pub fn validate_start(o: &StartOpts) -> Result<(), String> {
    choice("Network mode", o.network_mode.as_deref(), &["shared", "bridged"])?;
    choice("Port forwarder", o.port_forwarder.as_deref(), &["ssh", "grpc", "none"])?;
    choice("Mount type", o.mount_type.as_deref(), &["sshfs", "9p", "virtiofs"])?;
    if o.mount_type.as_deref() == Some("virtiofs") && !matches!(o.vm_type.as_deref(), None | Some("vz")) {
        return Err("virtiofs needs a vz VM: choose 9p or sshfs".into());
    }
    if let Some(iface) = o.network_interface.as_deref() {
        let ok = !iface.is_empty() && iface.len() <= 15
            && iface.chars().all(|c| c.is_ascii_alphanumeric() || c == '_');
        if !ok {
            return Err(format!("Network interface {iface:?} is not an interface name"));
        }
    }
    if let Some(gateway) = o.gateway_address.as_deref() {
        match gateway.parse::<std::net::Ipv4Addr>() {
            Ok(ip) if ip.octets()[3] == 2 => {}
            Ok(_) => return Err(format!("Gateway {gateway} must end in .2: Colima uses the last octet for the host")),
            Err(_) => return Err(format!("Gateway {gateway:?} is not an IPv4 address")),
        }
    }
    for dns in o.dns.iter().flatten() {
        if dns.parse::<std::net::IpAddr>().is_err() {
            return Err(format!("DNS resolver {dns:?} is not an IP address"));
        }
    }
    for host in o.dns_hosts.iter().flatten() {
        let Some((name, target)) = host.split_once('=') else {
            return Err(format!("DNS host {host:?} must be name=target"));
        };
        if name.trim().is_empty() || target.trim().is_empty() {
            return Err(format!("DNS host {host:?} must be name=target"));
        }
    }
    for mount in o.mounts.iter().flatten() {
        let mount = mount.trim();
        if mount.is_empty() { return Err("A mount cannot be empty".into()); }
        if mount.starts_with('-') { return Err(format!("Mount {mount:?} cannot start with '-'")); }
        if mount.contains(',') { return Err(format!("Mount {mount:?} cannot contain a comma: Colima splits the list there")); }
    }
    Ok(())
}

/// A command that starts, stops, restarts or removes a profile: the list the window reads
/// next is different, so the cached read must not outlive it.
fn run_mutation(args: &[&str]) -> Result<String, String> {
    let out = run_action(args);
    invalidate_profiles();
    out
}

/// The `colima start` argument list. Split out so the flag mapping — especially the ones
/// that only apply to some VM types — is testable without starting a VM.
fn start_args(o: &StartOpts) -> Vec<String> {
    let mut a: Vec<String> = vec!["start".into()];
    if o.profile != "default" { a.push(o.profile.clone()); }
    if let Some(v) = o.cpus { a.push("--cpus".into()); a.push(v.to_string()); }
    if let Some(v) = o.memory { a.push("--memory".into()); a.push(v.to_string()); }
    if let Some(v) = o.disk { a.push("--disk".into()); a.push(v.to_string()); }
    if let Some(v) = &o.runtime { a.push("--runtime".into()); a.push(v.clone()); }
    if let Some(v) = &o.arch { a.push("--arch".into()); a.push(v.clone()); }
    if let Some(v) = &o.vm_type { a.push("--vm-type".into()); a.push(v.clone()); }
    if o.rosetta == Some(true) && rosetta_applies(o.vm_type.as_deref()) { a.push("--vz-rosetta".into()); }
    if let Some(v) = &o.mount_type { a.push("--mount-type".into()); a.push(v.clone()); }
    for mount in o.mounts.iter().flatten() {
        if !mount.trim().is_empty() { a.push("--mount".into()); a.push(mount.trim().to_string()); }
    }
    if o.mount_inotify == Some(true) { a.push("--mount-inotify".into()); }
    if let Some(v) = &o.hostname { if !v.trim().is_empty() { a.push("--hostname".into()); a.push(v.clone()); } }
    if let Some(v) = &o.network_mode { a.push("--network-mode".into()); a.push(v.clone()); }
    if let Some(v) = &o.network_interface { a.push("--network-interface".into()); a.push(v.clone()); }
    if o.network_address == Some(true) { a.push("--network-address".into()); }
    if o.network_preferred_route == Some(true) { a.push("--network-preferred-route".into()); }
    if o.network_host_addresses == Some(true) { a.push("--network-host-addresses".into()); }
    if let Some(v) = &o.gateway_address { if !v.trim().is_empty() { a.push("--gateway-address".into()); a.push(v.clone()); } }
    for dns in o.dns.iter().flatten() {
        if !dns.trim().is_empty() { a.push("--dns".into()); a.push(dns.trim().to_string()); }
    }
    for host in o.dns_hosts.iter().flatten() {
        if !host.trim().is_empty() { a.push("--dns-host".into()); a.push(host.trim().to_string()); }
    }
    if let Some(v) = &o.port_forwarder { a.push("--port-forwarder".into()); a.push(v.clone()); }
    if o.ssh_agent == Some(true) { a.push("--ssh-agent".into()); }
    if o.kubernetes == Some(true) { a.push("--kubernetes".into()); }
    if let Some(v) = &o.k3s_arg { if !v.trim().is_empty() { a.push("--k3s-arg".into()); a.push(v.clone()); } }
    a
}

pub fn start(o: &StartOpts) -> Result<String, String> {
    validate_start(o)?;
    let a = start_args(o);
    let r: Vec<&str> = a.iter().map(|s| s.as_str()).collect();
    run_mutation(&r)
}

/// Destroy the VM and start it again with options only creation can apply (`arch`,
/// `vmType`, `runtime`, `mountType`, network mode). `delete_data` also drops the runtime
/// disk; without it Colima keeps images and containers on the profile's disk.
pub fn recreate(o: &StartOpts, delete_data: bool) -> Result<String, String> {
    validate_start(o)?;
    let running = list_profiles().unwrap_or_default().iter()
        .any(|p| p.name == o.profile && p.status == "Running");
    let stopped = if running { stop(&o.profile)? } else { String::new() };
    let deleted = delete(&o.profile, delete_data, true).map_err(|e| format!("delete: {e}"))?;
    let started = start(o).map_err(|e| format!("start: {e}"))?;
    let mut out = String::new();
    for step in [stopped, deleted, started] {
        if !step.trim().is_empty() { if !out.is_empty() { out.push('\n'); } out.push_str(step.trim()); }
    }
    Ok(out)
}

pub fn stop(profile: &str) -> Result<String, String> {
    let a: Vec<&str> = if profile == "default" { vec!["stop"] } else { vec!["stop", profile] };
    run_mutation(&a)
}

pub fn restart(profile: &str) -> Result<String, String> {
    let a: Vec<&str> = if profile == "default" { vec!["restart"] } else { vec!["restart", profile] };
    run_mutation(&a)
}

pub fn delete(profile: &str, data: bool, force: bool) -> Result<String, String> {
    let mut a: Vec<String> = vec!["delete".into()];
    if profile != "default" { a.push(profile.into()); }
    if data { a.push("--data".into()); }
    if force { a.push("--force".into()); }
    let r: Vec<&str> = a.iter().map(|s| s.as_str()).collect();
    run_mutation(&r)
}

pub fn model_run(profile: &str, model: &str, prompt: &str, runner: &str) -> Result<String, String> {
    safe_model_arg(model, "Model")?;
    if !runner.is_empty() { safe_model_arg(runner, "Runner")?; }
    let mut a: Vec<&str> = vec!["model", "run", model];
    if !prompt.trim().is_empty() { a.push(prompt); }
    if !runner.is_empty() && runner != "docker" { a.push("--runner"); a.push(runner); }
    if profile != "default" { a.push("-p"); a.push(profile); }
    run_action(&a)
}

/// Serve starts a blocking web server; launch detached and return immediately.

pub fn prune(profile: &str) -> Result<String, String> {
    let a: Vec<&str> = if profile == "default" { vec!["prune"] } else { vec!["prune", "-p", profile] };
    run_action(&a)
}

/// `colima update` updates the container runtime *inside* the VM. It is not a
/// CLI upgrade — this only ever touches the guest. Without `-p` it targets the
/// default profile whatever profile the UI has selected, so always pass it.
pub fn update(profile: &str) -> Result<String, String> {
    let a: Vec<&str> = if profile == "default" { vec!["update"] } else { vec!["update", "-p", profile] };
    run_action(&a)
}

#[derive(Serialize, Default)]
pub struct VersionInfo {
    pub installed: String,
    /// Newest published GitHub release, None when the check could not run.
    pub latest: Option<String>,
    /// "brew" or "manual" — decides whether the app can upgrade the CLI itself.
    pub manager: String,
    pub update_available: bool,
}

/// "colima version 0.10.3\ngit commit: …" -> "0.10.3"
fn version_from(raw: &str) -> Option<String> {
    let token = raw.lines().next()?.split_whitespace().last()?;
    token.chars().next().filter(|c| c.is_ascii_digit())?;
    Some(token.to_string())
}

/// "v0.10.10" -> (0, 10, 10). Pre-release and build suffixes are ignored.
fn parse_version(raw: &str) -> Option<(u64, u64, u64)> {
    let core = raw.trim().trim_start_matches('v');
    let core = core.split(['-', '+']).next()?;
    let mut parts = core.split('.');
    let major = parts.next()?.parse().ok()?;
    let minor = parts.next()?.parse().ok()?;
    let patch = parts.next().unwrap_or("0").parse().ok()?;
    Some((major, minor, patch))
}

/// Homebrew installs live under a Cellar directory; anything else was installed by hand.
fn manager() -> &'static str {
    match std::fs::canonicalize(colima_bin()) {
        Ok(path) if path.to_string_lossy().contains("/Cellar/") => "brew",
        _ => "manual",
    }
}

fn latest_release(repo: &str) -> Option<String> {
    let out = Command::new("curl")
        .args([
            "-fsSL", "--max-time", "6",
            "-H", "Accept: application/vnd.github+json",
            &format!("https://api.github.com/repos/{repo}/releases/latest"),
        ])
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let json: serde_json::Value = serde_json::from_slice(&out.stdout).ok()?;
    let tag = json.get("tag_name")?.as_str()?.trim_start_matches('v').to_string();
    parse_version(&tag).map(|_| tag)
}

/// `latest` is a published release the running build predates. A missing tag (offline,
/// rate-limited, malformed) is never an available update.
fn is_newer(latest: Option<&str>, installed: &str) -> bool {
    match (parse_version(installed), latest.and_then(parse_version)) {
        (Some(installed), Some(latest)) => latest > installed,
        _ => false,
    }
}

pub fn version_check() -> VersionInfo {
    let installed = version_from(&version()).unwrap_or_default();
    let latest = latest_release("abiosoft/colima");
    let update_available = is_newer(latest.as_deref(), &installed);
    VersionInfo { installed, latest, manager: manager().to_string(), update_available }
}

/// This app's own release channel, so About can say a newer build exists without
/// embedding a second version string: the installed side is the crate version, which
/// `package.json` and `tauri.conf.json` already carry in lockstep.
#[derive(Serialize, Default)]
pub struct AppReleaseInfo {
    pub installed: String,
    /// Newest published GitHub release, None when the check could not run.
    pub latest: Option<String>,
    pub update_available: bool,
    /// Release page for the newest tag; the frontend opens it with the guarded opener.
    pub url: String,
}

const APP_REPO: &str = "dm0xa/runtime-desk";

pub fn app_release_check() -> AppReleaseInfo {
    let installed = env!("CARGO_PKG_VERSION").to_string();
    let latest = latest_release(APP_REPO);
    let update_available = is_newer(latest.as_deref(), &installed);
    AppReleaseInfo {
        installed,
        latest,
        update_available,
        url: format!("https://github.com/{APP_REPO}/releases/latest"),
    }
}

/// Upgrades the CLI itself. Only Homebrew installs can be upgraded in place.
pub fn upgrade() -> Result<String, String> {
    if manager() != "brew" {
        return Err("Colima was installed without Homebrew. Download the latest release from github.com/abiosoft/colima/releases.".to_string());
    }
    let brew = crate::tools::which_bin("brew")
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_else(|| "/opt/homebrew/bin/brew".to_string());
    let out = Command::new(brew)
        .args(["upgrade", "colima"])
        .output()
        .map_err(|e| format!("failed to spawn brew: {e}"))?;
    let text = format!(
        "{}{}",
        String::from_utf8_lossy(&out.stdout),
        String::from_utf8_lossy(&out.stderr)
    );
    if out.status.success() {
        Ok(text.trim().to_string())
    } else {
        Err(text.trim().to_string())
    }
}

/// Everything the guest can report about its own health. Sizes are bytes, from kB
/// in /proc and df, so the UI never has to know the guest's units.
#[derive(Serialize, Default)]
pub struct VmDiagnostics {
    pub ok: bool,
    pub error: Option<String>,
    pub kernel: String,
    pub uptime_seconds: u64,
    pub cpus: u32,
    pub load1: f64,
    pub load5: f64,
    pub load15: f64,
    pub mem_total: u64,
    pub mem_available: u64,
    pub swap_total: u64,
    pub swap_free: u64,
    pub root_total: u64,
    pub root_used: u64,
    pub inodes_total: u64,
    pub inodes_used: u64,
    pub docker_active: bool,
    /// Number of "Killed process" lines in the last 500 kernel log entries.
    pub oom_kills: u64,
    /// Rosetta's binfmt handler is registered in the guest. The profile's `rosetta: true`
    /// only states intent; this is what makes linux/amd64 binaries run translated.
    pub rosetta_active: bool,
}

/// One round trip: the guest answers `key=value` lines instead of the app running a
/// dozen ssh commands. `-n 500` bounds the kernel-log scan so a poll stays cheap.
const DIAGNOSTICS_SCRIPT: &str = r#"echo kernel=$(uname -r)
echo cpus=$(nproc 2>/dev/null || grep -c ^processor /proc/cpuinfo)
echo load1=$(cut -d' ' -f1 /proc/loadavg)
echo load5=$(cut -d' ' -f2 /proc/loadavg)
echo load15=$(cut -d' ' -f3 /proc/loadavg)
echo uptime=$(cut -d. -f1 /proc/uptime)
awk '/^MemTotal:/{print "mem_total_kb="$2} /^MemAvailable:/{print "mem_available_kb="$2} /^SwapTotal:/{print "swap_total_kb="$2} /^SwapFree:/{print "swap_free_kb="$2}' /proc/meminfo
df -k / | awk 'NR==2{print "root_total_kb="$2; print "root_used_kb="$3}'
df -i / | awk 'NR==2{print "inodes_total="$2; print "inodes_used="$3}'
d=$(systemctl is-active docker 2>/dev/null); echo docker=${d:-unknown}
oom=$(journalctl -k -q --no-pager -n 500 2>/dev/null | grep -ci 'killed process'); echo oom=${oom:-0}
rosetta=$(cat /proc/sys/fs/binfmt_misc/rosetta 2>/dev/null | head -1); echo rosetta=${rosetta}"#;

fn kb(value: &str) -> u64 {
    value.trim().parse::<u64>().unwrap_or(0) * 1024
}

fn parse_diagnostics(raw: &str) -> VmDiagnostics {
    let mut d = VmDiagnostics { ok: true, ..Default::default() };
    for line in raw.lines() {
        let Some((key, value)) = line.trim().split_once('=') else { continue };
        let value = value.trim();
        match key {
            "kernel" => d.kernel = value.to_string(),
            "cpus" => d.cpus = value.parse().unwrap_or(0),
            "load1" => d.load1 = value.parse().unwrap_or(0.0),
            "load5" => d.load5 = value.parse().unwrap_or(0.0),
            "load15" => d.load15 = value.parse().unwrap_or(0.0),
            "uptime" => d.uptime_seconds = value.parse().unwrap_or(0),
            "mem_total_kb" => d.mem_total = kb(value),
            "mem_available_kb" => d.mem_available = kb(value),
            "swap_total_kb" => d.swap_total = kb(value),
            "swap_free_kb" => d.swap_free = kb(value),
            "root_total_kb" => d.root_total = kb(value),
            "root_used_kb" => d.root_used = kb(value),
            "inodes_total" => d.inodes_total = value.parse().unwrap_or(0),
            "inodes_used" => d.inodes_used = value.parse().unwrap_or(0),
            "docker" => d.docker_active = value == "active",
            "oom" => d.oom_kills = value.parse().unwrap_or(0),
            "rosetta" => d.rosetta_active = value.starts_with("enabled"),
            _ => {}
        }
    }
    d
}

/// Live health of the guest through `colima ssh`. A stopped VM returns ok=false with
/// Colima's message instead of an error, so the panel can explain rather than blank out.
pub fn vm_diagnostics(profile: &str) -> VmDiagnostics {
    let out = Command::new(colima_bin())
        .args(["ssh", "-p", profile, "--", "sh", "-c", DIAGNOSTICS_SCRIPT])
        .output();
    match out {
        Ok(o) if o.status.success() => parse_diagnostics(&String::from_utf8_lossy(&o.stdout)),
        Ok(o) => VmDiagnostics { ok: false, error: Some(humanize(&String::from_utf8_lossy(&o.stderr))), ..Default::default() },
        Err(e) => VmDiagnostics { ok: false, error: Some(format!("failed to spawn colima: {e}")), ..Default::default() },
    }
}

/// One directory entry inside a volume, as the guest reports it.
#[derive(Serialize, Clone, Default)]
pub struct VolumeEntry {
    /// `dir`, `file`, `link`, `char`, `block`, `pipe`, `socket` or `other`.
    pub kind: String,
    pub name: String,
    pub size: u64,
    pub modified: String,
    pub user: String,
    pub group: String,
    pub mode: String,
    /// Symlink target; empty for everything else.
    pub link: String,
}

#[derive(Serialize, Clone, Default)]
pub struct VolumeContents {
    /// The volume's data directory in the guest.
    pub root: String,
    /// The listed directory, relative to `root` (`""` for the root itself).
    pub path: String,
    pub entries: Vec<VolumeEntry>,
    /// True when the directory holds more entries than one listing returns.
    pub truncated: bool,
}

/// One `find` level per listing. Past this many rows the panel is not browsable anyway;
/// the flag lets the UI say so instead of silently dropping names.
const MAX_ENTRIES: usize = 5000;
/// Backstop for pathological output (very long names, a misbehaving client). A normal
/// 5000-row listing is well under a megabyte.
const MAX_BYTES: usize = 4 * 1024 * 1024;

/// GNU find `-printf` record: type, size, mtime, owner, group, mode, link target, name.
/// `\0` terminates each record, because a file name may contain any other byte.
const ENTRY_FORMAT: &str = r"%y\t%s\t%TY-%Tm-%TdT%TH:%TM:%TS\t%u\t%g\t%m\t%l\t%f\0";

fn kind_of(type_char: &str) -> &'static str {
    match type_char {
        "d" => "dir",
        "f" => "file",
        "l" => "link",
        "c" => "char",
        "b" => "block",
        "p" => "pipe",
        "s" => "socket",
        _ => "other",
    }
}

/// Joins a UI-supplied relative path onto the volume root one component at a time.
/// `..` cannot climb out and a leading `/` is inert, so the path stays lexically under
/// the root. Navigation never descends through a symlink (the listing reports one as a
/// link, not a directory); a crafted IPC call that names a symlink as an intermediate
/// component would still resolve it inside the guest, which is read-only and already
/// reachable by the same caller.
fn volume_path(root: &str, rel: &str) -> Result<String, String> {
    let mut path = root.trim_end_matches('/').to_string();
    if path.is_empty() {
        return Err("volume has no mountpoint".to_string());
    }
    for part in rel.split('/') {
        match part {
            "" | "." => {}
            ".." => return Err("path cannot leave the volume".to_string()),
            _ => {
                path.push('/');
                path.push_str(part);
            }
        }
    }
    Ok(path)
}

fn parse_volume_record(record: &str) -> Option<VolumeEntry> {
    let mut f = record.splitn(8, '\t');
    let kind = kind_of(f.next()?);
    Some(VolumeEntry {
        kind: kind.to_string(),
        size: f.next().and_then(|s| s.parse().ok()).unwrap_or(0),
        modified: f.next()?.to_string(),
        user: f.next()?.to_string(),
        group: f.next()?.to_string(),
        mode: f.next()?.to_string(),
        link: f.next()?.to_string(),
        name: f.next()?.to_string(),
    })
}

#[cfg(test)]
fn parse_volume_entries(raw: &str) -> Vec<VolumeEntry> {
    raw.split('\0')
        .filter(|record| !record.is_empty())
        .filter_map(parse_volume_record)
        .collect()
}

/// Read-only listing of one volume directory through `colima ssh -- sudo find`, never a
/// helper container: the volume lives in the VM's own tree, not on the host.
pub fn volume_contents(profile: &str, root: &str, rel: &str, limit: usize) -> Result<VolumeContents, String> {
    let cap = limit.clamp(1, MAX_ENTRIES);
    let path = volume_path(root, rel)?;
    let mut child = Command::new(colima_bin())
        .args(["ssh", "-p", profile, "--", "sudo", "find", &path])
        .args(["-mindepth", "1", "-maxdepth", "1", "-printf", ENTRY_FORMAT])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|e| format!("failed to spawn colima: {e}"))?;

    // stderr gets its own thread: a full pipe would block the child while this side is
    // still reading stdout, and `find` reports one line per unreadable entry.
    let errs = child.stderr.take().map(|mut pipe| {
        std::thread::spawn(move || {
            let mut text = String::new();
            let _ = pipe.read_to_string(&mut text);
            text
        })
    });

    // Parse incrementally and stop one row past what the caller asked for. Reading the whole
    // listing first would let a directory with millions of entries (which any container
    // holding the volume can create) buffer tens of megabytes just to discard all but a page;
    // the page is what the browser draws, so the page is what crosses the boundary.
    let mut entries = Vec::new();
    let mut truncated = false;
    if let Some(stdout) = child.stdout.take() {
        let mut reader = BufReader::new(stdout);
        let mut record = Vec::new();
        let mut bytes = 0usize;
        loop {
            record.clear();
            match reader.read_until(0, &mut record) {
                Ok(0) => break,
                Ok(n) => bytes += n,
                Err(_) => break,
            }
            let line = record.strip_suffix(b"\0").unwrap_or(&record);
            let text = String::from_utf8_lossy(line);
            if let Some(entry) = parse_volume_record(&text) {
                entries.push(entry);
            }
            // One row past the page proves there is more; exactly the page might be the end.
            if entries.len() > cap || bytes >= MAX_BYTES {
                truncated = true;
                let _ = child.kill();
                break;
            }
        }
    }

    let status = child.wait().map_err(|e| format!("wait for colima: {e}"))?;
    let stderr = errs.map(|t| t.join().unwrap_or_default()).unwrap_or_default();
    if !status.success() && !truncated {
        return Err(humanize(&stderr));
    }
    // The kept prefix is sorted, not the whole directory: ordering beyond the page is lost
    // either way, and the count in the UI says the list is partial.
    entries.sort_by_key(|e| (e.kind != "dir", e.name.to_lowercase()));
    entries.truncate(cap);
    Ok(VolumeContents {
        root: root.trim_end_matches('/').to_string(),
        path: rel.trim_matches('/').to_string(),
        entries,
        truncated,
    })
}

pub fn nerdctl_install(profile: &str) -> Result<String, String> {
    let mut a: Vec<&str> = vec!["nerdctl", "install"];
    if profile != "default" { a.push("-p"); a.push(profile); }
    run_action(&a)
}
#[cfg(test)]
mod tests {
    use super::safe_model_arg;

    /// Model and runner strings reach both argv and (for Terminal) a shell command line, so the
    /// validator is the only thing between a pasted text field and `; curl … | sh`.
    #[test]
    fn model_refs_reject_shell_and_flags() {
        for ok in ["llama3.2", "hf.co/bartowski/Llama-3.2-1B-Instruct-GGUF:Q4_K_M", "ollama://mistral@latest", "a+b"] {
            assert!(safe_model_arg(ok, "Model").is_ok(), "{ok} should pass");
        }
        for bad in ["", "-rf", "x; curl evil|sh", "a$(id)", "`id`", "a b", "q\"uote", "a'b"] {
            assert!(safe_model_arg(bad, "Model").is_err(), "{bad:?} should be rejected");
        }
    }

    use super::{humanize, rosetta_applies};
    use std::path::Path;

    /// A `colima status --json` answer with just enough fields to tell profiles apart.
    fn sample_status(runtime: &str) -> super::Status {
        super::Status {
            display_name: Some("colima".into()),
            driver: Some("macOS Virtualization.Framework".into()),
            arch: Some("aarch64".into()),
            runtime: Some(runtime.into()),
            mount_type: Some("virtiofs".into()),
            docker_socket: Some("/tmp/docker.sock".into()),
            containerd_socket: None,
            cpu: Some(4),
            memory: Some(6 << 30),
            disk: Some(60 << 30),
        }
    }

    /// `status` costs ~1.3 s per CLI run and sits after every mutation, so the cache has
    /// to answer repeats without touching the CLI — and must never answer for another profile.
    #[test]
    fn status_cache_serves_repeats_and_per_profile() {
        use super::{status_with, StatusCache};
        use std::cell::Cell;
        use std::time::{Duration, Instant};

        let cache = StatusCache::new();
        let calls = Cell::new(0);
        let fetch = |profile: &str| {
            calls.set(calls.get() + 1);
            Ok(sample_status(profile))
        };
        let ttl = Duration::from_secs(300);
        let t0 = Instant::now();

        let first = status_with(&cache, "default", t0, ttl, &fetch).unwrap();
        assert_eq!(first.runtime.as_deref(), Some("default"));
        // Same profile a minute later: no CLI run.
        let again = status_with(&cache, "default", t0 + Duration::from_secs(60), ttl, &fetch).unwrap();
        assert_eq!(again.cpu, Some(4));
        assert_eq!(calls.get(), 1);
        // Another profile has its own entry.
        let other = status_with(&cache, "work", t0 + Duration::from_secs(60), ttl, &fetch).unwrap();
        assert_eq!(other.runtime.as_deref(), Some("work"));
        assert_eq!(calls.get(), 2);
        // Switching back is free, which is the case a single-slot cache paid for twice.
        status_with(&cache, "default", t0 + Duration::from_secs(120), ttl, &fetch).unwrap();
        assert_eq!(calls.get(), 2);
    }

    #[test]
    fn status_cache_expires_and_never_stores_a_failure() {
        use super::{status_with, StatusCache};
        use std::cell::Cell;
        use std::time::{Duration, Instant};

        let cache = StatusCache::new();
        let calls = Cell::new(0);
        let ttl = Duration::from_secs(300);
        let t0 = Instant::now();
        let ok = |profile: &str| {
            calls.set(calls.get() + 1);
            Ok(sample_status(profile))
        };

        status_with(&cache, "default", t0, ttl, &ok).unwrap();
        // At the TTL boundary the entry is stale: one more CLI run.
        status_with(&cache, "default", t0 + ttl, ttl, &ok).unwrap();
        assert_eq!(calls.get(), 2);

        // A profile that is stopped answers with an error; the next reader must retry, not
        // inherit the failure for five minutes.
        let failing = |_: &str| {
            calls.set(calls.get() + 1);
            Err("colima is not running".to_string())
        };
        assert!(status_with(&cache, "dev", t0, ttl, &failing).is_err());
        assert!(status_with(&cache, "dev", t0, ttl, &failing).is_err());
        assert_eq!(calls.get(), 4);

        // A start, stop or delete clears every profile's entry.
        cache.clear();
        status_with(&cache, "default", t0 + ttl, ttl, &ok).unwrap();
        assert_eq!(calls.get(), 5);
    }

    #[test]
    fn instance_name_follows_the_colima_default() {
        assert_eq!(super::instance_name("default"), "colima");
        assert_eq!(super::instance_name("work"), "work");
    }

    fn opts(profile: &str, kubernetes: Option<bool>, k3s_arg: Option<&str>) -> super::StartOpts {
        super::StartOpts {
            profile: profile.into(), cpus: Some(2), memory: Some(4), disk: Some(60),
            runtime: Some("docker".into()), arch: None, vm_type: Some("vz".into()), rosetta: None,
            mounts: None, mount_type: None, mount_inotify: None, hostname: None,
            network_mode: None, network_interface: None, network_address: None,
            network_preferred_route: None, network_host_addresses: None, gateway_address: None,
            dns: None, dns_hosts: None, port_forwarder: None, ssh_agent: None,
            kubernetes, k3s_arg: k3s_arg.map(str::to_string),
        }
    }

    #[test]
    fn kubernetes_flags_are_opt_in() {
        let off = super::start_args(&opts("work", None, None));
        assert!(!off.iter().any(|a| a == "--kubernetes"), "{off:?}");
        assert_eq!(off[1], "work");

        let on = super::start_args(&opts("default", Some(true), None));
        assert!(on.iter().any(|a| a == "--kubernetes"), "{on:?}");
        // The default profile is addressed by its Lima instance, not as a positional name.
        assert_eq!(on, ["start", "--cpus", "2", "--memory", "4", "--disk", "60", "--runtime", "docker", "--vm-type", "vz", "--kubernetes"].map(String::from).to_vec());

        let arg = super::start_args(&opts("default", Some(true), Some("--disable=traefik,servicelb")));
        let at = arg.iter().position(|a| a == "--k3s-arg").unwrap();
        assert_eq!(arg[at + 1], "--disable=traefik,servicelb");

        // An empty text field must not become an empty flag value.
        let blank = super::start_args(&opts("default", None, Some("   ")));
        assert!(!blank.iter().any(|a| a == "--k3s-arg"), "{blank:?}");
    }

    #[test]
    fn network_mount_and_ssh_flags_are_mapped() {
        let o = super::StartOpts {
            network_mode: Some("bridged".into()), network_interface: Some("en1".into()),
            network_address: Some(true), network_preferred_route: Some(true),
            network_host_addresses: Some(true), gateway_address: Some("192.168.10.2".into()),
            dns: Some(vec!["1.1.1.1".into(), "8.8.8.8".into()]),
            dns_hosts: Some(vec!["example.com=1.2.3.4".into()]),
            port_forwarder: Some("grpc".into()), ssh_agent: Some(true),
            mount_type: Some("virtiofs".into()), mount_inotify: Some(true),
            mounts: Some(vec!["~/projects:w".into(), "/data:ro".into()]),
            ..opts("work", None, None)
        };
        super::validate_start(&o).unwrap();
        let args = super::start_args(&o);
        let joined = args.join(" ");
        for expected in [
            "--network-mode bridged", "--network-interface en1", "--network-address",
            "--network-preferred-route", "--network-host-addresses", "--gateway-address 192.168.10.2",
            "--port-forwarder grpc", "--ssh-agent", "--mount-type virtiofs", "--mount-inotify",
        ] {
            assert!(joined.contains(expected), "missing {expected}: {args:?}");
        }
        assert_eq!(args.iter().filter(|a| *a == "--dns").count(), 2);
        assert_eq!(args.iter().filter(|a| *a == "--mount").count(), 2);
        assert!(joined.contains("--dns-host example.com=1.2.3.4"), "{args:?}");
        assert!(joined.contains("--mount ~/projects:w"), "{args:?}");
    }

    #[test]
    fn invalid_start_values_are_refused_before_the_cli_runs() {
        let bad_gateway = super::StartOpts { gateway_address: Some("192.168.10.3".into()), ..opts("default", None, None) };
        assert!(super::validate_start(&bad_gateway).unwrap_err().contains(".2"));

        let bad_dns = super::StartOpts { dns: Some(vec!["not-an-ip".into()]), ..opts("default", None, None) };
        assert!(super::validate_start(&bad_dns).unwrap_err().contains("DNS resolver"));

        let bad_mode = super::StartOpts { network_mode: Some("host".into()), ..opts("default", None, None) };
        assert!(super::validate_start(&bad_mode).unwrap_err().contains("Network mode"));

        let bad_mount = super::StartOpts { mounts: Some(vec!["~/a,b:w".into()]), ..opts("default", None, None) };
        assert!(super::validate_start(&bad_mount).unwrap_err().contains("comma"));

        let bad_interface = super::StartOpts { network_interface: Some("bridge-interface-too-long".into()), ..opts("default", None, None) };
        assert!(super::validate_start(&bad_interface).unwrap_err().contains("interface"));

        let qemu_virtiofs = super::StartOpts { vm_type: Some("qemu".into()), mount_type: Some("virtiofs".into()), ..opts("default", None, None) };
        assert!(super::validate_start(&qemu_virtiofs).unwrap_err().contains("virtiofs"));
    }

    #[test]
    fn reads_network_mounts_and_ssh_from_colima_yaml() {
        let text = r#"
# Network configurations for the virtual machine.
network:
  address: true
  mode: bridged
  interface: en7
  preferredRoute: true
  dns:
    - 8.8.8.8
    - 1.1.1.1
  dnsHosts:
    myapp.local: 192.168.1.100
    api.local: host.docker.internal
  hostAddresses: true
  gatewayAddress: 192.168.10.2

forwardAgent: true
portForwarder: grpc
binfmt: true
mountType: virtiofs
mountInotify: true
hostname: colima-dev

kubernetes:
  enabled: true
  k3sArgs:
    - --disable=traefik,servicelb

mounts:
    - location: "~"
      writable: true
    - location: /data
      writable: false
"#;
        let cfg = super::ProfileConfig::from_yaml(&super::parse_yaml(text));
        assert_eq!(cfg.network_mode, "bridged");
        assert_eq!(cfg.network_interface, "en7");
        assert!(cfg.network_address);
        assert!(cfg.network_preferred_route);
        assert!(cfg.network_host_addresses);
        assert_eq!(cfg.gateway_address, "192.168.10.2");
        assert_eq!(cfg.dns, ["8.8.8.8", "1.1.1.1"]);
        assert_eq!(cfg.dns_hosts[0], super::DnsHost { name: "myapp.local".into(), target: "192.168.1.100".into() });
        assert_eq!(cfg.dns_hosts[1].target, "host.docker.internal");
        assert!(cfg.ssh_agent);
        assert_eq!(cfg.port_forwarder, "grpc");
        assert!(cfg.mount_inotify);
        assert_eq!(cfg.hostname, "colima-dev");
        assert!(cfg.kubernetes);
        assert_eq!(cfg.k3s_args, ["--disable=traefik,servicelb"]);
        assert_eq!(cfg.mounts, [
            super::MountSpec { location: "~".into(), writable: true },
            super::MountSpec { location: "/data".into(), writable: false },
        ]);
    }

    #[test]
    fn missing_and_disabled_mount_blocks_have_distinct_meanings() {
        // No `mounts:` key: Colima's default home mount.
        let defaulted = super::ProfileConfig::from_yaml(&super::parse_yaml("cpu: 2\nnetwork:\n  dns: null\n"));
        assert_eq!(defaulted.mounts, [super::MountSpec { location: "~".into(), writable: true }]);
        assert!(defaulted.dns.is_empty());
        assert_eq!(defaulted.network_mode, "shared");

        // `mounts: []` is an explicit "no mounts", not the default.
        let disabled = super::ProfileConfig::from_yaml(&super::parse_yaml("mounts: []\n"));
        assert!(disabled.mounts.is_empty());

        let inline_dns = super::ProfileConfig::from_yaml(&super::parse_yaml("network:\n  dns: [9.9.9.9, 1.1.1.1]\n"));
        assert_eq!(inline_dns.dns, ["9.9.9.9", "1.1.1.1"]);

        // `- https://…` is a value, not a key: a mapping separator needs a space or EOL.
        let urls = super::parse_yaml("mirrors:\n  - https://mirror.gcr.io\n");
        assert_eq!(urls.get("mirrors").unwrap().items()[0], super::Yaml::Scalar("https://mirror.gcr.io".into()));
    }

    #[test]
    fn rosetta_flag_only_for_vz() {
        assert!(rosetta_applies(None));
        assert!(rosetta_applies(Some("vz")));
        assert!(!rosetta_applies(Some("qemu")));
        assert!(!rosetta_applies(Some("krunkit")));
    }

    #[test]
    fn reads_the_version_off_the_first_line() {
        assert_eq!(super::version_from("colima version 0.10.3\ngit commit: abc\n"), Some("0.10.3".to_string()));
        assert_eq!(super::version_from("command not found"), None);
        assert_eq!(super::version_from(""), None);
    }

    #[test]
    fn parses_guest_diagnostics() {
        let raw = "kernel=6.8.0-117-generic\ncpus=4\nload1=0.07\nload5=0.32\nload15=0.32\nuptime=100280\n\
mem_total_kb=6053356\nmem_available_kb=5324848\nswap_total_kb=0\nswap_free_kb=0\n\
root_total_kb=19221248\nroot_used_kb=1468788\ninodes_total=2490368\ninodes_used=18192\n\
docker=active\noom=0\nrosetta=enabled\n";
        let d = super::parse_diagnostics(raw);
        assert!(d.ok);
        assert_eq!(d.kernel, "6.8.0-117-generic");
        assert_eq!(d.cpus, 4);
        assert_eq!(d.mem_total, 6053356 * 1024);
        assert_eq!(d.mem_available, 5324848 * 1024);
        assert_eq!(d.root_used, 1468788 * 1024);
        assert_eq!(d.inodes_total, 2490368);
        assert!(d.docker_active);
        assert_eq!(d.oom_kills, 0);
        assert_eq!(d.load1, 0.07);
        assert!(d.rosetta_active);
    }

    #[test]
    fn missing_keys_leave_diagnostics_at_zero() {
        let d = super::parse_diagnostics("kernel=x\ndocker=inactive\noom=3\n");
        assert_eq!(d.mem_total, 0);
        assert!(!d.docker_active);
        assert_eq!(d.oom_kills, 3);
        assert!(!d.rosetta_active);
    }

    #[test]
    fn compares_release_versions() {
        assert_eq!(super::parse_version("v0.10.10"), Some((0, 10, 10)));
        assert_eq!(super::parse_version("0.9"), Some((0, 9, 0)));
        assert_eq!(super::parse_version("0.11.0-beta.1"), Some((0, 11, 0)));
        assert_eq!(super::parse_version("nightly"), None);
        assert!(super::parse_version("v0.10.10") > super::parse_version("0.10.3"));
        assert!(super::parse_version("0.10.3") == super::parse_version("v0.10.3"));
    }

    #[test]
    fn only_a_higher_tag_counts_as_an_update() {
        assert!(super::is_newer(Some("0.2.0"), "0.1.0"));
        assert!(!super::is_newer(Some("0.1.0"), "0.1.0"));
        assert!(!super::is_newer(Some("0.9.0"), "0.10.0"));
        // A failed lookup is not an update, however the local version reads.
        assert!(!super::is_newer(None, "0.1.0"));
        assert!(!super::is_newer(Some("nightly"), "0.1.0"));
    }

    #[test]
    fn strips_logrus_wrapper_and_unescapes_newlines() {
        let raw = "time=\"2026-11-11T19:02:46+01:00\" level=fatal msg=\"error in config: cannot use vmType: 'krunkit', error: krunkit not found in $PATH\\nInstall with: brew tap slp/krunkit && brew install krunkit\"\n";
        assert_eq!(
            humanize(raw),
            "error in config: cannot use vmType: 'krunkit', error: krunkit not found in $PATH\nInstall with: brew tap slp/krunkit && brew install krunkit"
        );
    }

    #[test]
    fn passes_plain_errors_through() {
        assert_eq!(humanize("  cannot connect  \n"), "cannot connect");
    }

    #[test]
    fn joins_a_relative_path_without_leaving_the_volume() {
        let root = "/var/lib/docker/volumes/data/_data";
        assert_eq!(super::volume_path(root, "").unwrap(), root);
        assert_eq!(super::volume_path(root, "/logs/app/").unwrap(), format!("{root}/logs/app"));
        assert_eq!(super::volume_path(root, "logs//./app").unwrap(), format!("{root}/logs/app"));
        assert!(super::volume_path(root, "..").is_err());
        assert!(super::volume_path(root, "logs/../../etc").is_err());
        assert!(super::volume_path("", "logs").is_err());
    }

    #[test]
    fn parses_nul_terminated_find_records() {
        // Every record is `type, size, mtime, user, group, mode, link, name`; link is empty
        // for anything that is not a symlink, and the name is the last field.
        let raw = "d\t4096\t2026-11-11T19:02:46.1234567890\troot\troot\t755\t\tlogs\0\
f\t12\t2026-11-11T19:03:00.0000000000\t1000\t1000\t644\t\tapp.json\0\
l\t7\t2026-11-11T19:03:01.0000000000\troot\troot\t777\t../app\tcurrent\0\
f\t0\t2026-11-11T19:04:00.0000000000\troot\troot\t600\t\tbad name\0";
        let e = super::parse_volume_entries(raw);
        assert_eq!(e.len(), 4);
        assert_eq!(e[0].kind, "dir");
        assert_eq!(e[0].name, "logs");
        assert_eq!(e[1].kind, "file");
        assert_eq!(e[1].name, "app.json");
        assert_eq!(e[1].size, 12);
        assert_eq!(e[1].user, "1000");
        assert_eq!(e[1].mode, "644");
        assert_eq!(e[2].kind, "link");
        assert_eq!(e[2].link, "../app");
        assert_eq!(e[3].name, "bad name");
        assert!(super::parse_volume_entries("").is_empty());
    }

    #[test]
    fn malformed_records_are_dropped_not_rendered() {
        // A truncated or foreign line must never become an entry with an empty name.
        assert!(super::parse_volume_entries("f\t1\t2026-11-11T00:00:00Z\troot\0").is_empty());
        assert!(super::parse_volume_entries("\0\0").is_empty());
    }

    /// A scratch directory that removes itself; no test may touch the real `$HOME`.
    struct Scratch(std::path::PathBuf);

    impl Scratch {
        fn new(tag: &str) -> Self {
            let dir = std::env::temp_dir().join(format!("runtime-desk-{tag}-{}", std::process::id()));
            let _ = std::fs::remove_dir_all(&dir);
            std::fs::create_dir_all(&dir).unwrap();
            Self(dir)
        }

        fn path(&self) -> &Path {
            &self.0
        }

        fn dir(&self, rel: &str) -> std::path::PathBuf {
            let path = self.0.join(rel);
            std::fs::create_dir_all(&path).unwrap();
            path
        }
    }

    impl Drop for Scratch {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }

    // --- Colima config home (see resolve_colima_home) ---

    #[test]
    fn colima_home_env_wins_when_the_directory_exists() {
        let scratch = Scratch::new("home-env");
        let env_dir = scratch.dir("relocated");
        scratch.dir(".colima");
        let xdg = scratch.dir("xdg");
        assert_eq!(
            super::resolve_colima_home(
                Some(env_dir.to_str().unwrap()),
                scratch.path().to_str().unwrap(),
                Some(xdg.to_str().unwrap()),
            ),
            env_dir
        );
    }

    #[test]
    fn colima_home_env_is_ignored_when_the_directory_is_absent() {
        // Colima only honours $COLIMA_HOME for a directory that exists; a stale export
        // must not poison the resolution.
        let scratch = Scratch::new("home-env-missing");
        let legacy = scratch.dir(".colima");
        let bogus = scratch.path().join("no-such-dir");
        assert_eq!(
            super::resolve_colima_home(
                Some(bogus.to_str().unwrap()),
                scratch.path().to_str().unwrap(),
                None,
            ),
            legacy
        );
    }

    #[test]
    fn legacy_home_beats_xdg_because_the_cli_ignores_xdg_then() {
        let scratch = Scratch::new("home-legacy");
        let legacy = scratch.dir(".colima");
        let xdg = scratch.dir("xdg");
        assert_eq!(
            super::resolve_colima_home(None, scratch.path().to_str().unwrap(), Some(xdg.to_str().unwrap())),
            legacy
        );
    }

    #[test]
    fn xdg_home_is_used_when_no_legacy_directory_exists() {
        let scratch = Scratch::new("home-xdg");
        let xdg = scratch.dir("xdg");
        assert_eq!(
            super::resolve_colima_home(None, scratch.path().to_str().unwrap(), Some(xdg.to_str().unwrap())),
            xdg.join("colima")
        );
    }

    #[test]
    fn blank_xdg_home_falls_back_to_legacy() {
        let scratch = Scratch::new("home-xdg-blank");
        let legacy = scratch.path().join(".colima");
        assert_eq!(
            super::resolve_colima_home(None, scratch.path().to_str().unwrap(), Some("   ")),
            legacy
        );
    }

    #[test]
    fn dot_config_colima_is_not_picked_up_without_the_variable() {
        // An unset XDG_CONFIG_HOME never means `~/.config`; colima keeps using `~/.colima`.
        let scratch = Scratch::new("home-dot-config");
        scratch.dir(".config/colima");
        assert_eq!(
            super::resolve_colima_home(None, scratch.path().to_str().unwrap(), None),
            scratch.path().join(".colima")
        );
    }

    #[test]
    fn an_empty_home_still_yields_an_absolute_path() {
        assert_eq!(super::resolve_colima_home(None, "", None), std::path::Path::new("/tmp/.colima"));
    }

    #[test]
    fn reads_a_profile_config_from_an_xdg_layout_home() {
        let scratch = Scratch::new("profile-xdg");
        let xdg = scratch.dir("xdg");
        let profile = xdg.join("colima").join("default");
        std::fs::create_dir_all(&profile).unwrap();
        std::fs::write(
            profile.join("colima.yaml"),
            "vmType: qemu\nruntime: containerd\narch: x86_64\nmountType: 9p\ncpu: 8\nmemory: 16\ndisk: 120\nrosetta: true\n",
        )
        .unwrap();
        let home = super::resolve_colima_home(None, scratch.path().to_str().unwrap(), Some(xdg.to_str().unwrap()));
        let cfg = super::profile_config_in(&home, "default").unwrap();
        assert_eq!(cfg.vm_type, "qemu");
        assert_eq!(cfg.runtime, "containerd");
        assert_eq!(cfg.arch, "x86_64");
        assert_eq!(cfg.mount_type, "9p");
        assert_eq!((cfg.cpu, cfg.memory, cfg.disk), (8, 16, 120));
        assert!(cfg.rosetta);
    }

    #[test]
    fn a_missing_profile_config_names_the_file_it_could_not_read() {
        let scratch = Scratch::new("profile-missing");
        match super::profile_config_in(scratch.path(), "work") {
            Ok(_) => panic!("a config that does not exist must not parse"),
            Err(err) => assert!(err.starts_with("read config: "), "{err}"),
        }
    }
}
