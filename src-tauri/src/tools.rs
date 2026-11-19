use serde::Serialize;
use std::os::unix::fs::PermissionsExt;
use std::path::{Path, PathBuf};
use std::process::Command;

/// Why a CLI invocation produced no output. `Missing` means the binary is not on
/// PATH (optional tooling); `Failed` means it ran and exited non-zero.
enum RunError {
    Missing,
    Failed(String),
}

impl RunError {
    fn message(&self) -> String {
        match self {
            RunError::Missing => "binary not found on PATH".to_string(),
            RunError::Failed(e) => e.clone(),
        }
    }
}

/// FINDER GAP: an .app started by Finder or Spotlight inherits launchd's PATH
/// (`/usr/bin:/bin:/usr/sbin:/sbin`), so every Homebrew CLI reads as missing and the
/// whole Docker surface gates itself off. Put the usual install roots first, once,
/// before Tauri spawns any worker thread.
pub(crate) fn ensure_toolchain_path() {
    const ROOTS: [&str; 5] = ["/opt/homebrew/bin", "/opt/homebrew/sbin", "/usr/local/bin", "/opt/local/bin", "/usr/bin"];
    let mut dirs: Vec<PathBuf> = ROOTS.iter().map(PathBuf::from).collect();
    for dir in std::env::split_paths(&std::env::var_os("PATH").unwrap_or_default()) {
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    if let Ok(joined) = std::env::join_paths(dirs) {
        // SAFETY: called from `run()` before any thread exists.
        unsafe { std::env::set_var("PATH", joined) };
    }
}

fn run(bin: &str, args: &[&str]) -> Result<String, RunError> {
    let mut cmd = Command::new(bin);
    cmd.args(args);
    let out = crate::proc::run(&mut cmd, crate::proc::READ_LIMIT).map_err(|e| {
        if e.is_missing() {
            RunError::Missing
        } else {
            RunError::Failed(e.to_string())
        }
    })?;
    if out.success {
        Ok(out.stdout)
    } else {
        Err(RunError::Failed(out.stderr))
    }
}

/// PATH lookup without spawning `which`. A refresh probes nine binaries, and every
/// spawn costs a process; one stat per PATH entry is free by comparison.
pub(crate) fn which_bin(name: &str) -> Option<PathBuf> {
    let path = std::env::var_os("PATH")?;
    std::env::split_paths(&path)
        .map(|dir| dir.join(name))
        .find(|candidate| executable(candidate))
}

fn executable(path: &Path) -> bool {
    let Ok(meta) = std::fs::metadata(path) else {
        return false;
    };
    meta.is_file() && meta.permissions().mode() & 0o111 != 0
}

fn installed(bin: &str) -> bool {
    which_bin(bin).is_some()
}

/// Whether a compose CLI exists, without running one.
///
/// `docker compose version` was the old probe and spawned a process on every fifteen-second
/// refresh for an answer that only changes when the user installs something. Compose is
/// discovered the way the Docker CLI itself discovers it: a `docker-compose` binary on PATH,
/// or `docker-compose` in one of the CLI plugin directories, including `$DOCKER_CONFIG`.
fn compose_installed() -> bool {
    if installed("docker-compose") {
        return true;
    }
    let mut roots: Vec<PathBuf> = Vec::new();
    if let Some(dir) = std::env::var_os("DOCKER_CONFIG").filter(|d| !d.is_empty()) {
        roots.push(PathBuf::from(dir));
    }
    if let Some(home) = std::env::var_os("HOME").filter(|h| !h.is_empty()) {
        roots.push(PathBuf::from(&home).join(".docker"));
        roots.push(PathBuf::from(&home).join(".local/share/docker"));
    }
    roots.push(PathBuf::from("/usr/local/lib/docker"));
    roots.push(PathBuf::from("/opt/homebrew/lib/docker"));
    roots.push(PathBuf::from("/opt/local/lib/docker"));
    roots
        .into_iter()
        .map(|root| root.join("cli-plugins").join("docker-compose"))
        .any(|plugin| executable(&plugin))
}

/// The host's architecture, not the container VM's. `uname -m` answers `arm64` even for a
/// process running under Rosetta, where `cfg!(target_arch)` would say x86_64 and every
/// vz/krunkit suggestion would be backwards. One spawn for the life of the app.
static HOST_ARCH: std::sync::LazyLock<String> = std::sync::LazyLock::new(|| {
    Command::new("uname")
        .arg("-m")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| std::env::consts::ARCH.to_string())
});

fn host_arch() -> String {
    HOST_ARCH.clone()
}

#[derive(Serialize, Default)]
pub struct SystemStatus {
    pub colima: bool,
    pub docker: bool,
    pub lima: bool,
    pub nerdctl: bool,
    pub compose: bool,
    pub ramalama: bool,
    pub krunkit: bool,
    pub podman: bool,
    pub kubectl: bool,
    /// `arm64` or `x86_64`: the host decides which VM types can boot natively.
    pub host_arch: String,
}

pub fn system_status() -> SystemStatus {
    let docker = installed("docker");
    SystemStatus {
        colima: installed("colima"),
        docker,
        lima: installed("limactl"),
        nerdctl: installed("nerdctl"),
        compose: docker && compose_installed(),
        ramalama: installed("ramalama"),
        krunkit: installed("krunkit"),
        podman: installed("podman"),
        // Colima itself shells out to kubectl while provisioning the cluster, so a Kubernetes
        // surface without it could neither read nor create one.
        kubectl: crate::k8s::kubectl_installed(),
        host_arch: host_arch(),
    }
}

#[derive(Serialize)]
pub struct ComposeProject {
    pub name: String,
    pub status: String,
}

#[derive(serde::Deserialize)]
struct RawCompose {
    #[serde(alias = "Name")]
    name: Option<String>,
    #[serde(alias = "Status")]
    status: Option<String>,
}

/// Empty when the compose plugin is absent; a real `docker compose` failure is
/// surfaced because it usually means a broken Docker install.
///
/// "Absent" has to cover a docker CLI without the plugin, not just a missing `docker`
/// binary: the app draws this into the same refresh wave as the container lists, and one
/// optional plugin must never make the Containers, Images and Volumes pages report
/// "list unavailable".
pub fn compose_list() -> Result<Vec<ComposeProject>, String> {
    let raw = match run("docker", &["compose", "ls", "--all", "--format", "json"]) {
        Ok(raw) => raw,
        Err(RunError::Missing) => return Ok(Vec::new()),
        Err(e) if plugin_absent(&e.message()) => {
            // A standalone `docker-compose` binary understands the same argv.
            match run("docker-compose", &["ls", "--all", "--format", "json"]) {
                Ok(raw) => raw,
                Err(_) => return Ok(Vec::new()),
            }
        }
        Err(e) => return Err(e.message()),
    };
    let trimmed = raw.trim();
    if trimmed.is_empty() {
        return Ok(Vec::new());
    }
    let parsed: Vec<RawCompose> = serde_json::from_str(trimmed)
        .map_err(|e| format!("failed to parse docker compose ls: {e}"))?;
    Ok(parsed
        .into_iter()
        .filter_map(|p| {
            let name = p.name?;
            Some(ComposeProject { name, status: p.status.unwrap_or_default() })
        })
        .collect())
}

/// How the Docker CLI words "that subcommand does not exist", i.e. the compose plugin is
/// not installed. Matched on the message because the CLI has no dedicated exit code.
fn plugin_absent(message: &str) -> bool {
    let text = message.to_ascii_lowercase();
    text.contains("is not a docker command")
        || text.contains("unknown command")
        || text.contains("unknown shorthand flag")
        || text.contains("docker: 'compose' is not a docker command")
}

#[derive(Serialize)]
pub struct LimaVm {
    pub name: String,
    pub status: String,
}

#[derive(serde::Deserialize)]
struct RawLima {
    name: Option<String>,
    status: Option<String>,
}

/// Optional tool: a missing `limactl` is a normal state, not an error.
pub fn lima_vms() -> Vec<LimaVm> {
    let raw = match run("limactl", &["list", "--json"]) {
        Ok(raw) => raw,
        Err(_) => return Vec::new(),
    };
    raw.lines()
        .filter_map(|line| {
            let t = line.trim();
            if t.is_empty() {
                return None;
            }
            let v = serde_json::from_str::<RawLima>(t).ok()?;
            Some(LimaVm { name: v.name?, status: v.status.unwrap_or_default() })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Mutex;

    /// PATH is process-wide, so the test that rewrites it and the one that reads it take this
    /// lock. Without it the Finder-launch test strips PATH between `system_status()`'s
    /// `installed()` calls and the assertion's own, and the status test fails at random.
    static PATH_LOCK: Mutex<()> = Mutex::new(());

    fn lock_path() -> std::sync::MutexGuard<'static, ()> {
        PATH_LOCK.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// Optional tooling must never reject: absent binaries return empty lists so the
    /// dashboard does not raise an error banner on every refresh.
    #[test]
    fn optional_tools_never_error() {
        assert!(compose_list().is_ok());
        let _ = lima_vms();
    }

    #[test]
    fn system_status_reports_missing_lima_as_false() {
        let _path = lock_path();
        let status = system_status();
        assert_eq!(status.lima, installed("limactl"));
    }

    /// Finder launches the app with launchd's four-directory PATH; the Homebrew roots
    /// must be added back or every gated surface disappears.
    #[test]
    fn toolchain_path_recovers_from_a_finder_launch() {
        let _path = lock_path();
        let original = std::env::var_os("PATH");
        // SAFETY: every test that reads PATH holds PATH_LOCK, so nothing observes the change.
        unsafe { std::env::set_var("PATH", "/usr/bin:/bin:/usr/sbin:/sbin") };
        ensure_toolchain_path();
        let path = std::env::var("PATH").unwrap();
        assert!(path.starts_with("/opt/homebrew/bin:"), "{path}");
        assert!(path.ends_with("/usr/bin:/bin:/usr/sbin:/sbin"), "{path}");
        assert!(which_bin("sh").is_some(), "shell must still resolve");
        // SAFETY: still under the lock; the next reader starts from the real PATH.
        unsafe {
            match original {
                Some(value) => std::env::set_var("PATH", value),
                None => std::env::remove_var("PATH"),
            }
        }
    }
}
