mod cleanup;
mod colima;
mod k8s;
mod proc;
mod tools;
mod docker;
mod menu;
mod podman;

use colima::{Profile, ProfileConfig, StartOpts, Status};
use std::collections::HashMap;
use std::io::{BufRead, BufReader};
use std::process::Stdio;
use std::sync::Mutex;
use tauri::ipc::Channel;
use tauri::Manager;

struct ServeState(Mutex<HashMap<String, u32>>);

/// Where the tracked model servers are remembered. They outlive the window, so the map has to
/// as well: otherwise a relaunch reports "no model server tracked" while the server still holds
/// its port, and the only way to stop it is a terminal.
fn serve_state_path() -> std::path::PathBuf {
    crate::colima::colima_home().join("runtime-desk-serve.json")
}

fn pid_alive(pid: u32) -> bool {
    std::process::Command::new("kill")
        .args(["-0", &pid.to_string()])
        .stdout(std::process::Stdio::null())
        .stderr(std::process::Stdio::null())
        .status()
        .map(|status| status.success())
        .unwrap_or(false)
}

/// A PID file outlives a crash, so entries whose process is gone are dropped on load instead of
/// being offered as a "running" server that `Stop` then fails to kill.
fn load_serve_state() -> HashMap<String, u32> {
    let raw = std::fs::read_to_string(serve_state_path()).unwrap_or_default();
    let map: HashMap<String, u32> = serde_json::from_str(&raw).unwrap_or_default();
    map.into_iter().filter(|(_, pid)| pid_alive(*pid)).collect()
}

fn save_serve_state(map: &HashMap<String, u32>) {
    let path = serve_state_path();
    if let Some(parent) = path.parent() { let _ = std::fs::create_dir_all(parent); }
    let _ = std::fs::write(path, serde_json::to_string(map).unwrap_or_default());
}

/// The live `docker events` child, when the user is streaming. One at a time: a profile
/// switch replaces it, because a child left behind keeps a reader on the previous daemon.
struct EventStream(Mutex<Option<std::process::Child>>);

fn kill_event_stream(state: &EventStream) {
    // Take the child out inside the lock, then kill it outside: `wait()` on a client stuck
    // in an uninterruptible read would otherwise hold the slot against every other stream
    // command, and the panel could never be restarted.
    let child = state.0.lock().ok().and_then(|mut slot| slot.take());
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// The live `docker stats` child behind the Investigator's Performance panel. One at a
/// time: opening another container replaces it, so no reader stays on the previous one.
struct StatsStream(Mutex<Option<std::process::Child>>);

/// Sent to the panel when the stats child closes its stdout (container stopped, daemon
/// went away). Not JSON, so it can never be mistaken for a sample.
const STATS_END: &str = "__stats_end__";

fn kill_stats_stream(state: &StatsStream) {
    // Same reasoning as the events child: never hold the slot across `kill()` + `wait()`.
    let child = state.0.lock().ok().and_then(|mut slot| slot.take());
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// The live `docker stats` child behind the Activity view: every container of the selected
/// profile from one stream, so the two-second poll does not spawn a child each time.
struct ActivityStream(Mutex<Option<std::process::Child>>);

fn kill_activity_stream(state: &ActivityStream) {
    // The slot is released before the child is signalled: a client stuck in a read must not
    // hold the next stream behind this one.
    let child = state.0.lock().ok().and_then(|mut slot| slot.take());
    if let Some(mut child) = child {
        let _ = child.kill();
        let _ = child.wait();
    }
}

type R<T> = Result<T, String>;

async fn blocking<T: Send + 'static>(f: impl FnOnce() -> R<T> + Send + 'static) -> R<T> {
    tauri::async_runtime::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn list_profiles_cmd() -> R<Vec<Profile>> { blocking(colima::list_profiles).await }

#[tauri::command]
async fn status_cmd(profile: String) -> R<Status> {
    let target = profile.clone();
    let status = blocking(move || colima::status(&target)).await?;
    // The socket this reports is the confirmation the launch deferred: adopt it while this
    // profile is still the active one, so the endpoint set from the path convention is
    // replaced by the reported one as soon as it is known.
    if let Some(socket) = status.docker_socket.as_deref() {
        docker::confirm_endpoint(&profile, socket);
    }
    Ok(status)
}

#[tauri::command]
async fn start_cmd(opts: StartOpts) -> R<String> { blocking(move || colima::start(&opts)).await }

#[tauri::command]
async fn stop_cmd(profile: String) -> R<String> { blocking(move || colima::stop(&profile)).await }

#[tauri::command]
async fn restart_cmd(profile: String) -> R<String> { blocking(move || colima::restart(&profile)).await }

#[tauri::command]
async fn delete_cmd(profile: String, data: bool, force: bool) -> R<String> {
    blocking(move || colima::delete(&profile, data, force)).await
}

#[tauri::command]
async fn podman_machines_cmd() -> R<Vec<podman::PodmanMachine>> { blocking(podman::list_machines).await }

/// The machine every other podman command talks to, so two machines on one Mac are not one list.
#[tauri::command]
async fn podman_set_machine_cmd(name: Option<String>) -> R<String> {
    podman::set_machine(name.clone());
    Ok(name.unwrap_or_default())
}

/// `podman machine init`. The first call downloads a VM image, which is why the UI asks first.
#[tauri::command]
async fn podman_machine_init_cmd(name: Option<String>, cpus: Option<u32>, memory_mb: Option<u32>) -> R<String> {
    blocking(move || podman::machine_init(name.as_deref(), cpus, memory_mb)).await
}

#[tauri::command]
async fn podman_containers_cmd() -> R<Vec<podman::PodmanContainer>> { blocking(podman::list_containers).await }

#[tauri::command]
async fn podman_images_cmd() -> R<Vec<podman::PodmanImage>> { blocking(podman::list_images).await }

#[tauri::command]
async fn podman_image_pull_cmd(reference: String) -> R<String> { blocking(move || podman::image_pull(&reference)).await }

#[tauri::command]
async fn podman_volumes_cmd() -> R<Vec<podman::PodmanVolume>> { blocking(podman::list_volumes).await }

/// `podman system df`: the machine's own accounting, so Podman storage never borrows a
/// Docker number or a host file scan.
#[tauri::command]
async fn podman_disk_usage_cmd() -> podman::PodmanDiskUsage {
    blocking(|| Ok::<_, String>(podman::disk_usage())).await.unwrap_or_default()
}

#[tauri::command]
async fn podman_image_remove_cmd(id: String) -> R<String> { blocking(move || podman::image_remove(&id)).await }

#[tauri::command]
async fn podman_volume_remove_cmd(name: String) -> R<String> { blocking(move || podman::volume_remove(&name)).await }

#[tauri::command]
async fn podman_network_remove_cmd(name: String) -> R<String> { blocking(move || podman::network_remove(&name)).await }

#[tauri::command]
async fn podman_container_start_cmd(id: String) -> R<String> { blocking(move || podman::container_start(&id)).await }

#[tauri::command]
async fn podman_container_stop_cmd(id: String) -> R<String> { blocking(move || podman::container_stop(&id)).await }

#[tauri::command]
async fn podman_container_restart_cmd(id: String) -> R<String> { blocking(move || podman::container_restart(&id)).await }

#[tauri::command]
async fn podman_container_remove_cmd(id: String) -> R<String> { blocking(move || podman::container_remove(&id)).await }

#[tauri::command]
async fn podman_container_logs_cmd(id: String, tail: u32) -> R<String> { blocking(move || podman::container_logs(&id, tail)).await }

#[tauri::command]
async fn podman_image_inspect_cmd(id: String) -> R<String> { blocking(move || podman::image_inspect(&id)).await }

#[tauri::command]
async fn podman_container_inspect_json_cmd(id: String) -> R<String> { blocking(move || podman::container_inspect_json(&id)).await }

#[tauri::command]
async fn podman_volume_inspect_cmd(name: String) -> R<String> { blocking(move || podman::volume_inspect(&name)).await }

#[tauri::command]
async fn podman_network_inspect_cmd(name: String) -> R<String> { blocking(move || podman::network_inspect(&name)).await }

#[tauri::command]
async fn podman_networks_cmd() -> R<Vec<podman::PodmanNetwork>> { blocking(podman::list_networks).await }

#[tauri::command]
async fn podman_network_map_cmd() -> R<Vec<docker::NetworkMapEntry>> { blocking(podman::network_map).await }

#[tauri::command]
async fn podman_container_detail_cmd(id: String) -> R<docker::ContainerDetail> { blocking(move || podman::container_detail(&id)).await }

#[tauri::command]
async fn podman_image_detail_cmd(id: String) -> R<docker::ImageDetail> { blocking(move || podman::image_detail(&id)).await }

#[tauri::command]
async fn podman_volume_detail_cmd(name: String) -> R<docker::VolumeDetail> { blocking(move || podman::volume_detail(&name)).await }

#[tauri::command]
async fn podman_network_detail_cmd(name: String) -> R<docker::NetworkDetail> { blocking(move || podman::network_detail(&name)).await }

#[tauri::command]
async fn podman_container_stats_cmd() -> R<Vec<docker::ContainerStat>> { blocking(podman::container_stats).await }




#[tauri::command]
async fn podman_machine_set_cmd(name: String, cpus: Option<u32>, memory_mb: Option<u32>) -> R<String> {
    blocking(move || podman::machine_set(&name, cpus, memory_mb)).await
}

#[tauri::command]
async fn podman_start_cmd(name: String) -> R<String> { blocking(move || podman::start(&name)).await }

#[tauri::command]
async fn podman_stop_cmd(name: String) -> R<String> { blocking(move || podman::stop(&name)).await }

#[tauri::command]
async fn podman_restart_cmd(name: String) -> R<String> { blocking(move || podman::restart(&name)).await }

#[tauri::command]
async fn podman_remove_cmd(name: String) -> R<String> { blocking(move || podman::remove(&name)).await }

#[tauri::command]
async fn version_cmd() -> String { blocking(|| Ok(colima::version())).await.unwrap_or_default() }

#[tauri::command]
async fn template_cmd() -> R<String> { blocking(colima::template).await }

#[tauri::command]
async fn ssh_config_cmd(profile: String) -> R<String> { blocking(move || colima::ssh_config(&profile)).await }

#[tauri::command]
async fn model_run_cmd(profile: String, model: String, prompt: String, runner: String) -> R<String> {
    blocking(move || colima::model_run(&profile, &model, &prompt, &runner)).await
}

#[tauri::command]
async fn prune_cmd(profile: String) -> R<String> { blocking(move || colima::prune(&profile)).await }

#[tauri::command]
async fn update_cmd(profile: String) -> R<String> { blocking(move || colima::update(&profile)).await }

/// Installed CLI version vs the newest GitHub release, plus how it was installed.
#[tauri::command]
async fn version_check_cmd() -> colima::VersionInfo {
    blocking(|| Ok::<_, String>(colima::version_check())).await.unwrap_or_default()
}

/// Newest Runtime Desk release on GitHub, compared with the version this build carries.
#[tauri::command]
async fn app_release_cmd() -> colima::AppReleaseInfo {
    blocking(|| Ok::<_, String>(colima::app_release_check())).await.unwrap_or_default()
}

/// Upgrades the Colima CLI (Homebrew installs only).
#[tauri::command]
async fn upgrade_cmd() -> R<String> { blocking(colima::upgrade).await }

/// Live guest health: load, memory, disk, inodes, docker service and OOM kills.
#[tauri::command]
async fn vm_diagnostics_cmd(profile: String) -> colima::VmDiagnostics {
    blocking(move || Ok::<_, String>(colima::vm_diagnostics(&profile))).await.unwrap_or_default()
}

#[tauri::command]
async fn nerdctl_install_cmd(profile: String) -> R<String> {
    blocking(move || colima::nerdctl_install(&profile)).await
}

#[tauri::command]
async fn list_containers_cmd() -> R<Vec<docker::Container>> { blocking(docker::list_containers).await }

#[tauri::command]
async fn list_images_cmd() -> R<Vec<docker::Image>> { blocking(docker::list_images).await }

#[tauri::command]
async fn list_volumes_cmd() -> R<Vec<docker::Volume>> { blocking(docker::list_volumes).await }

#[tauri::command]
async fn list_networks_cmd() -> R<Vec<docker::Network>> { blocking(docker::list_networks).await }

#[tauri::command]
async fn container_action_cmd(id: String, action: String) -> R<String> {
    blocking(move || docker::container_action(&id, &action)).await
}

#[tauri::command]
async fn image_detail_cmd(id: String) -> R<docker::ImageDetail> {
    blocking(move || docker::image_detail(&id)).await
}

#[tauri::command]
async fn volume_detail_cmd(name: String) -> R<docker::VolumeDetail> {
    blocking(move || docker::volume_detail(&name)).await
}

/// Per-volume sizes from one cached `system df -v` scan; the treemap and the detail page share it.
#[tauri::command]
async fn volume_sizes_cmd() -> Vec<docker::VolumeSize> {
    blocking(|| Ok::<_, String>(docker::volume_sizes())).await.unwrap_or_default()
}

/// Storage report for the Cleanup page: one `system df -v`, one `colima ssh` scan and one
/// host stat run together, so the page costs about as much as the slowest of the three.
#[tauri::command]
async fn cleanup_report_cmd(profile: String) -> cleanup::CleanupReport {
    blocking(move || Ok::<_, String>(cleanup::report(&profile)))
        .await
        .unwrap_or_else(|_| cleanup::CleanupReport::default())
}

/// One directory level of a volume, read through `colima ssh -- sudo find`. The root comes
/// from the active container client, so Docker and containerd profiles both resolve.
#[tauri::command]
async fn volume_contents_cmd(profile: String, name: String, path: String) -> R<colima::VolumeContents> {
    blocking(move || {
        let root = docker::volume_mountpoint(&name)?;
        colima::volume_contents(&profile, &root, &path)
    })
    .await
}

#[tauri::command]
async fn network_detail_cmd(name: String) -> R<docker::NetworkDetail> {
    blocking(move || docker::network_detail(&name)).await
}

#[tauri::command]
async fn container_detail_cmd(id: String) -> R<docker::ContainerDetail> {
    blocking(move || docker::container_detail(&id)).await
}

#[tauri::command]
async fn container_logs_cmd(id: String, tail: u32) -> R<String> {
    blocking(move || docker::container_logs(&id, tail)).await
}

#[tauri::command]
async fn container_stats_cmd() -> R<Vec<docker::ContainerStat>> {
    blocking(docker::container_stats).await
}

#[tauri::command]
async fn container_stats_one_cmd(id: String) -> R<docker::ContainerStat> {
    blocking(move || docker::container_stats_one(&id)).await
}

/// Caps or raises a live container's memory limit; 0 removes it.
#[tauri::command]
async fn container_update_memory_cmd(id: String, bytes: u64) -> R<String> {
    blocking(move || docker::container_update_memory(&id, bytes)).await
}

#[tauri::command]
async fn network_map_cmd() -> R<Vec<docker::NetworkMapEntry>> {
    blocking(docker::network_map).await
}

#[tauri::command]
async fn inspect_cmd(id: String) -> R<String> { blocking(move || docker::inspect(&id)).await }

#[tauri::command]
async fn image_pull_cmd(reference: String) -> R<String> { blocking(move || docker::image_pull(&reference)).await }

#[tauri::command]
async fn image_remove_cmd(id: String) -> R<String> { blocking(move || docker::image_remove(&id)).await }

#[tauri::command]
async fn volume_remove_cmd(name: String) -> R<String> { blocking(move || docker::volume_remove(&name)).await }

#[tauri::command]
async fn network_remove_cmd(name: String) -> R<String> { blocking(move || docker::network_remove(&name)).await }

#[tauri::command]
async fn system_status_cmd() -> tools::SystemStatus {
    blocking(|| Ok(tools::system_status())).await.unwrap_or_default()
}

/// Points every subsequent docker command at this profile's daemon.
///
/// The endpoint is colima's own convention (`<colima home>/<profile>/docker.sock`), which
/// is the path `colima status` reports, so a launch does not sit on that ~1 s command
/// before the first container list. `runtime` comes from the profile list the caller has
/// already read. A status run behind the caller only confirms the socket.
#[tauri::command]
fn set_profile_cmd(profile: String, runtime: Option<String>, activity: tauri::State<'_, ActivityStream>) -> String {
    let endpoint = colima::docker_endpoint(&profile, None);
    docker::set_endpoint(Some(endpoint.clone()));
    // Colima's own nerdctl path is the primary client for containerd profiles.
    docker::set_client(runtime.as_deref().unwrap_or("docker"), &profile);
    // A stats child left on the previous daemon would keep feeding the Activity view numbers
    // about a profile the window no longer shows; the window restarts it on the next tick.
    kill_activity_stream(&activity);
    endpoint
}

#[tauri::command]
async fn compose_list_cmd() -> R<Vec<tools::ComposeProject>> { blocking(tools::compose_list).await }

#[tauri::command]
async fn lima_vms_cmd() -> Vec<tools::LimaVm> { blocking(|| Ok(tools::lima_vms())).await.unwrap_or_default() }

#[tauri::command]
async fn docker_prune_cmd(opts: docker::PruneOpts) -> R<String> {
    blocking(move || docker::prune(&opts)).await
}

#[tauri::command]
async fn disk_usage_cmd() -> docker::DiskUsage { blocking(|| Ok(docker::disk_usage())).await.unwrap_or(docker::DiskUsage { images: 0, containers: 0, volumes: 0, build_cache: 0, reclaimable: 0 }) }

#[tauri::command]
async fn profile_config_cmd(profile: String) -> R<ProfileConfig> { blocking(move || colima::profile_config(&profile)).await }

#[tauri::command]
async fn model_list_cmd(profile: String) -> R<String> { blocking(move || colima::model_list(&profile)).await }

#[tauri::command]
async fn model_pull_cmd(profile: String, model: String, runner: String) -> R<String> {
    blocking(move || colima::model_pull(&profile, &model, &runner)).await
}

#[tauri::command]
async fn model_setup_cmd(profile: String, runner: String) -> R<String> {
    blocking(move || colima::model_setup(&profile, &runner)).await
}

#[tauri::command]
async fn model_chat_cmd(profile: String, model: String, runner: String) -> R<String> {
    blocking(move || colima::model_run_terminal(&profile, &model, &runner)).await
}

#[tauri::command]
async fn model_serve_start_cmd(profile: String, model: String, runner: String, port: u32, state: tauri::State<'_, ServeState>) -> R<u32> {
    let profile_key = profile.clone();
    let pid = blocking(move || colima::model_serve_start(&profile, &model, &runner, port)).await?;
    {
        let mut map = state.0.lock().map_err(|e| e.to_string())?;
        map.insert(profile_key, pid);
        save_serve_state(&map);
    }
    Ok(pid)
}

#[tauri::command]
async fn model_serve_stop_cmd(profile: String, state: tauri::State<'_, ServeState>) -> R<String> {
    let pid = {
        let mut map = state.0.lock().map_err(|e| e.to_string())?;
        let pid = map.remove(&profile);
        save_serve_state(&map);
        pid
    };
    match pid {
        Some(pid) => blocking(move || colima::model_serve_stop(pid)).await,
        None => Err("no model server tracked for this profile".into()),
    }
}

/// Only web links reach `open`. The URL can come from container metadata (a published
/// port), not just from this app's own text, and `open` reads a leading dash as a flag
/// (`-a Calculator`) while any other scheme (`file:`, `smb:`) hands off to another app.
fn is_openable_url(url: &str) -> bool {
    let rest = url.strip_prefix("https://").or_else(|| url.strip_prefix("http://"));
    match rest {
        Some(r) => !r.is_empty() && !url.chars().any(|c| c.is_control() || c.is_whitespace()),
        None => false,
    }
}

/// Starts the event stream and forwards every line to the caller's channel. Returns
/// `polling` (no child spawned) when the profile uses the containerd client, so the
/// frontend keeps its timed refresh instead of waiting for events that never arrive.
#[tauri::command]
fn events_start_cmd(on_event: Channel<String>, state: tauri::State<'_, EventStream>) -> R<String> {
    let Some(mut cmd) = docker::events_command() else { return Ok("polling".into()) };
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("failed to start docker events: {e}"))?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Err("docker events produced no stdout".into());
    };
    kill_event_stream(&state);
    if let Ok(mut slot) = state.0.lock() { *slot = Some(child); }
    // A blocking read on the child's stdout, one line per event, until the channel closes
    // or the child is killed. Killing the child is what ends this thread: stdout hits EOF.
    std::thread::spawn(move || {
        for line in BufReader::new(stdout).lines().map_while(Result::ok) {
            if on_event.send(line).is_err() { break; }
        }
    });
    Ok("streaming".into())
}

#[tauri::command]
fn events_stop_cmd(state: tauri::State<'_, EventStream>) -> R<String> {
    kill_event_stream(&state);
    Ok("stopped".into())
}

/// Starts one streaming `docker stats <id>` child and forwards every JSON line to the
/// caller's channel — roughly one sample per second, instead of a 5 s `--no-stream` poll.
/// The reader sends `__stats_end__` when stdout closes so the panel can fall back to
/// polling rather than freeze on the last number.
#[tauri::command]
fn stats_start_cmd(id: String, on_sample: Channel<String>, state: tauri::State<'_, StatsStream>) -> R<String> {
    let mut cmd = docker::stats_command(&id);
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("failed to start docker stats: {e}"))?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Err("docker stats produced no stdout".into());
    };
    kill_stats_stream(&state);
    if let Ok(mut slot) = state.0.lock() { *slot = Some(child); }
    std::thread::spawn(move || {
        docker::read_stats_lines(BufReader::new(stdout), |stat| {
            match serde_json::to_string(&stat) {
                Ok(json) => on_sample.send(json).is_ok(),
                Err(_) => true,
            }
        });
        let _ = on_sample.send(STATS_END.to_string());
    });
    Ok("streaming".into())
}

#[tauri::command]
fn stats_stop_cmd(state: tauri::State<'_, StatsStream>) -> R<String> {
    kill_stats_stream(&state);
    Ok("stopped".into())
}

/// The Activity view's stream: every container, one line each per second, from one child.
#[tauri::command]
fn stats_all_start_cmd(on_sample: Channel<String>, state: tauri::State<'_, ActivityStream>) -> R<String> {
    let mut cmd = docker::stats_all_command();
    cmd.stdout(Stdio::piped()).stderr(Stdio::null());
    let mut child = cmd.spawn().map_err(|e| format!("failed to start docker stats: {e}"))?;
    let Some(stdout) = child.stdout.take() else {
        let _ = child.kill();
        return Err("docker stats produced no stdout".into());
    };
    kill_activity_stream(&state);
    if let Ok(mut slot) = state.0.lock() { *slot = Some(child); }
    std::thread::spawn(move || {
        docker::read_stats_lines_all(BufReader::new(stdout), |stat| {
            let Ok(json) = serde_json::to_string(&stat) else { return true };
            on_sample.send(json).is_ok()
        });
        let _ = on_sample.send(STATS_END.to_string());
    });
    Ok("streaming".into())
}

#[tauri::command]
fn stats_all_stop_cmd(state: tauri::State<'_, ActivityStream>) -> R<String> {
    kill_activity_stream(&state);
    Ok("stopped".into())
}

#[tauri::command]
fn open_url_cmd(url: String) -> R<String> {
    if !is_openable_url(&url) {
        return Err("only http and https links can be opened".into());
    }
    std::process::Command::new("open").arg(&url).output().map(|_| format!("Opened {url}")).map_err(|e| e.to_string())
}

#[tauri::command]
fn model_serve_status_cmd(state: tauri::State<'_, ServeState>) -> Vec<(String, u32)> {
    state.0.lock().map(|m| m.iter().map(|(k, v)| (k.clone(), *v)).collect()).unwrap_or_default()
}

#[tauri::command]
async fn k8s_cluster_cmd(profile: String) -> k8s::ClusterInfo {
    blocking(move || Ok(k8s::cluster_info(&profile))).await.unwrap_or_default()
}

#[tauri::command]
async fn k8s_resources_cmd(profile: String, kind: String, namespace: Option<String>) -> R<Vec<k8s::KubeRow>> {
    blocking(move || k8s::resources(&profile, &kind, namespace.as_deref())).await
}

#[tauri::command]
async fn k8s_logs_cmd(profile: String, namespace: String, pod: String, tail: u32) -> R<String> {
    blocking(move || k8s::pod_logs(&profile, &namespace, &pod, tail)).await
}

#[tauri::command]
async fn k8s_cluster_action_cmd(profile: String, action: String) -> R<String> {
    let done = blocking(move || k8s::cluster_action(&profile, &action)).await?;
    // A new cluster changes what the page can show, and the profiles list carries the
    // Kubernetes column on the Machine page.
    colima::invalidate_profiles();
    Ok(done)
}

struct WindowFit {
    size: tauri::PhysicalSize<u32>,
    position: tauri::PhysicalPosition<i32>,
}

/// The largest inner size and on-screen origin that keep the whole window frame inside
/// `area`, or `None` when the geometry already fits.
///
/// All values are physical pixels, so a monitor with a different scale factor is
/// handled by passing that monitor's own work area.
fn fit_to_work_area(
    inner: tauri::PhysicalSize<u32>,
    frame: (u32, u32),
    position: tauri::PhysicalPosition<i32>,
    area: &tauri::PhysicalRect<i32, u32>,
) -> Option<WindowFit> {
    let (frame_w, frame_h) = frame;
    let outer_w = inner.width.saturating_add(frame_w).min(area.size.width);
    let outer_h = inner.height.saturating_add(frame_h).min(area.size.height);
    let max_x = area.position.x + (area.size.width - outer_w) as i32;
    let max_y = area.position.y + (area.size.height - outer_h) as i32;
    let x = position.x.clamp(area.position.x, max_x);
    let y = position.y.clamp(area.position.y, max_y);
    let size = tauri::PhysicalSize::new(
        outer_w.saturating_sub(frame_w),
        outer_h.saturating_sub(frame_h),
    );
    if size == inner && x == position.x && y == position.y {
        return None;
    }
    Some(WindowFit { size, position: tauri::PhysicalPosition::new(x, y) })
}

/// Whether a window frame sits entirely inside a monitor's work area.
///
/// The fit must not run on the monitor the *cursor* is on: a window opened on the main
/// display while the pointer is on a display to its left would otherwise be dragged to
/// that display by the clamp. Ask every monitor instead, and leave the window alone when
/// one of them already holds it.
fn fits_inside(
    area: &tauri::PhysicalRect<i32, u32>,
    rect: &tauri::PhysicalRect<i32, u32>,
) -> bool {
    let right = rect.position.x.saturating_add(rect.size.width as i32);
    let bottom = rect.position.y.saturating_add(rect.size.height as i32);
    rect.position.x >= area.position.x
        && rect.position.y >= area.position.y
        && right <= area.position.x.saturating_add(area.size.width as i32)
        && bottom <= area.position.y.saturating_add(area.size.height as i32)
}

/// The work area of the monitor a frame overlaps most, for the case where it fits on
/// none of them (a window restored from a display that is now gone).
fn best_work_area<'a>(
    areas: impl Iterator<Item = &'a tauri::PhysicalRect<i32, u32>>,
    rect: &tauri::PhysicalRect<i32, u32>,
) -> Option<tauri::PhysicalRect<i32, u32>> {
    let right = rect.position.x.saturating_add(rect.size.width as i32);
    let bottom = rect.position.y.saturating_add(rect.size.height as i32);
    areas
        .map(|area| {
            let overlap_w = (right.min(area.position.x.saturating_add(area.size.width as i32))
                - rect.position.x.max(area.position.x))
            .max(0) as u64;
            let overlap_h = (bottom.min(area.position.y.saturating_add(area.size.height as i32))
                - rect.position.y.max(area.position.y))
            .max(0) as u64;
            (overlap_w * overlap_h, *area)
        })
        .max_by_key(|(area_px, _)| *area_px)
        .filter(|(area_px, _)| *area_px > 0)
        .map(|(_, area)| area)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tools::ensure_toolchain_path();
    tauri::Builder::default()
        .manage(ServeState(Mutex::new(load_serve_state())))
        .manage(EventStream(Mutex::new(None)))
        .manage(StatsStream(Mutex::new(None)))
        .manage(ActivityStream(Mutex::new(None)))
        .plugin(tauri_plugin_opener::init())
        // Size, position and maximized state survive a relaunch, the way every Mac
        // window does; the work-area fit below still pulls an off-screen frame back.
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .menu(menu::build)
        .on_menu_event(|app, event| menu::dispatch(app, event.id().as_ref()))
        .setup(|app| {
            // Warm the first read the window makes, while it is still loading the bundle.
            std::thread::spawn(colima::prefetch_profiles);
            // macOS keeps a window created larger than the display at that size, so on
            // smaller screens the configured geometry hangs off the right/bottom edge.
            // Only a frame that no monitor fully holds is moved: the cursor's monitor is
            // not evidence about where the window belongs.
            if let Some(win) = app.get_webview_window("main") {
                let inner = win.inner_size()?;
                let outer = win.outer_size()?;
                let position = win.outer_position()?;
                let rect = tauri::PhysicalRect { position, size: outer };
                let areas: Vec<_> = win.available_monitors()?.iter().map(|m| *m.work_area()).collect();
                if !areas.iter().any(|area| fits_inside(area, &rect)) {
                    let target = best_work_area(areas.iter(), &rect)
                        .or_else(|| win.primary_monitor().ok().flatten().map(|m| *m.work_area()));
                    if let Some(area) = target {
                        let frame = (
                            outer.width.saturating_sub(inner.width),
                            outer.height.saturating_sub(inner.height),
                        );
                        if let Some(fit) = fit_to_work_area(inner, frame, position, &area) {
                            win.set_size(fit.size)?;
                            win.set_position(fit.position)?;
                        }
                    }
                }
            }
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            list_profiles_cmd, status_cmd, start_cmd, stop_cmd, restart_cmd, delete_cmd,
            podman_machines_cmd, podman_machine_init_cmd, podman_set_machine_cmd, podman_machine_set_cmd, podman_containers_cmd, podman_images_cmd, podman_image_pull_cmd, podman_volumes_cmd, podman_disk_usage_cmd, podman_image_remove_cmd, image_remove_cmd, podman_volume_remove_cmd, podman_network_remove_cmd, podman_container_start_cmd, podman_container_stop_cmd, podman_container_restart_cmd, podman_container_remove_cmd, podman_container_logs_cmd, podman_image_inspect_cmd, podman_container_inspect_json_cmd, podman_container_detail_cmd, podman_container_stats_cmd, podman_image_detail_cmd, podman_volume_detail_cmd, podman_network_detail_cmd, podman_volume_inspect_cmd, podman_network_inspect_cmd, podman_networks_cmd, podman_network_map_cmd, podman_start_cmd, podman_stop_cmd, podman_restart_cmd, podman_remove_cmd,
            version_cmd, template_cmd, ssh_config_cmd,
            model_run_cmd, prune_cmd, update_cmd, nerdctl_install_cmd,
            profile_config_cmd, model_list_cmd, model_pull_cmd, model_setup_cmd, model_chat_cmd,
            model_serve_start_cmd, model_serve_stop_cmd, model_serve_status_cmd, open_url_cmd,
            list_containers_cmd, list_images_cmd, list_volumes_cmd, list_networks_cmd, container_action_cmd, container_logs_cmd, container_detail_cmd, image_detail_cmd, volume_detail_cmd, volume_sizes_cmd, volume_contents_cmd, container_stats_cmd, container_stats_one_cmd, container_update_memory_cmd, network_map_cmd, network_detail_cmd,
            inspect_cmd, image_pull_cmd, image_remove_cmd, volume_remove_cmd, network_remove_cmd, docker_prune_cmd, disk_usage_cmd, cleanup_report_cmd,
            system_status_cmd, set_profile_cmd, compose_list_cmd, lima_vms_cmd,
            version_check_cmd, app_release_cmd, upgrade_cmd, vm_diagnostics_cmd,
            events_start_cmd, events_stop_cmd, stats_start_cmd, stats_stop_cmd,
            stats_all_start_cmd, stats_all_stop_cmd,
            k8s_cluster_cmd, k8s_resources_cmd, k8s_logs_cmd, k8s_cluster_action_cmd
        ])
        .build(tauri::generate_context!())
        .expect("error while building tauri application")
        .run(|app, event| {
            // The reader threads and their children outlive the window unless killed here.
            if matches!(event, tauri::RunEvent::Exit) {
                kill_event_stream(app.state::<EventStream>().inner());
                kill_stats_stream(app.state::<StatsStream>().inner());
                kill_activity_stream(app.state::<ActivityStream>().inner());
            }
        });
}

#[cfg(test)]
mod tests {
    use super::{best_work_area, fit_to_work_area, fits_inside, is_openable_url, pid_alive};

    /// The liveness probe is what stops a PID file from advertising a server that died with the
    /// previous launch, so `model_serve_status_cmd` cannot list a PID that `kill -0` rejects.
    #[test]
    fn own_process_is_alive() {
        assert!(pid_alive(std::process::id()));
    }

    #[test]
    fn opener_accepts_web_links_only() {
        assert!(is_openable_url("http://localhost:8080"));
        assert!(is_openable_url("https://github.com/abiosoft/colima/releases/latest"));
        assert!(!is_openable_url("file:///Users/me/.ssh/id_ed25519"));
        assert!(!is_openable_url("smb://host/share"));
        assert!(!is_openable_url("javascript:alert(1)"));
        // `open` would read these as flags, not as a URL.
        assert!(!is_openable_url("-a"));
        assert!(!is_openable_url("-a Calculator"));
        assert!(!is_openable_url("http://"));
        assert!(!is_openable_url("https://host/pa th"));
        assert!(!is_openable_url("http://host/\n"));
    }

    #[test]
    fn fit_leaves_a_window_that_already_fits_alone() {
        let area = tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(0, 25),
            size: tauri::PhysicalSize::new(1728, 1055),
        };
        let fit = fit_to_work_area(
            tauri::PhysicalSize::new(1300, 820),
            (0, 28),
            tauri::PhysicalPosition::new(200, 100),
            &area,
        );
        assert!(fit.is_none());
    }

    #[test]
    fn fit_shrinks_the_frame_to_the_work_area() {
        // 1280x800 display, 25px menu bar: a 1300x820 inner size plus the titlebar overflows.
        let area = tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(0, 25),
            size: tauri::PhysicalSize::new(1280, 775),
        };
        let fit = fit_to_work_area(
            tauri::PhysicalSize::new(1300, 820),
            (0, 28),
            tauri::PhysicalPosition::new(0, 25),
            &area,
        )
        .expect("window larger than the display must be fitted");
        assert_eq!(fit.size, tauri::PhysicalSize::new(1280, 747));
        assert_eq!(fit.position, tauri::PhysicalPosition::new(0, 25));
    }

    #[test]
    fn fit_pulls_an_off_screen_origin_back() {
        let area = tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(0, 25),
            size: tauri::PhysicalSize::new(1280, 775),
        };
        let fit = fit_to_work_area(
            tauri::PhysicalSize::new(900, 600),
            (0, 28),
            tauri::PhysicalPosition::new(-300, 900),
            &area,
        )
        .expect("origin outside the display must be clamped");
        assert_eq!(fit.size, tauri::PhysicalSize::new(900, 600));
        assert_eq!(fit.position, tauri::PhysicalPosition::new(0, 172));
    }

    #[test]
    fn fit_never_underflows_on_a_tiny_work_area() {
        let area = tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(0, 0),
            size: tauri::PhysicalSize::new(20, 20),
        };
        let fit = fit_to_work_area(
            tauri::PhysicalSize::new(1300, 820),
            (0, 28),
            tauri::PhysicalPosition::new(0, 0),
            &area,
        )
        .expect("window larger than the display must be fitted");
        assert_eq!(fit.size, tauri::PhysicalSize::new(20, 0));
        assert_eq!(fit.position, tauri::PhysicalPosition::new(0, 0));
    }

    fn area(x: i32, y: i32, w: u32, h: u32) -> tauri::PhysicalRect<i32, u32> {
        tauri::PhysicalRect {
            position: tauri::PhysicalPosition::new(x, y),
            size: tauri::PhysicalSize::new(w, h),
        }
    }

    #[test]
    fn a_window_on_any_monitor_is_never_moved() {
        // Main display; a second display to its left with nothing on it yet.
        let main = area(0, 25, 1728, 1055);
        let left = area(-2200, 0, 2200, 1100);
        let rect = area(214, 99, 1300, 820);
        assert!(fits_inside(&main, &rect));
        assert!(!fits_inside(&left, &rect));
        // The left display must not become the target just because the cursor is there.
        let areas = [left, main];
        assert!(areas.iter().any(|a| fits_inside(a, &rect)));
    }

    #[test]
    fn a_window_straddling_the_edge_is_fitted_into_the_monitor_it_mostly_covers() {
        let main = area(0, 25, 1728, 1055);
        let left = area(-2200, 0, 2200, 1100);
        let rect = area(-700, 200, 1300, 820);
        assert!(!fits_inside(&main, &rect) && !fits_inside(&left, &rect));
        let target = best_work_area([&main, &left].into_iter(), &rect).expect("one overlaps");
        assert_eq!(target.position.x, -2200);
    }

    #[test]
    fn a_window_off_every_monitor_has_no_overlap_target() {
        let main = area(0, 25, 1728, 1055);
        let rect = area(9000, 9000, 1300, 820);
        assert!(best_work_area([&main].into_iter(), &rect).is_none());
    }
}
