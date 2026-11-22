# Architecture

## Overview

- **Frontend**: React 19 + TypeScript, built with Vite.
- **Backend**: Rust, exposed to the frontend as 100 Tauri commands.
- **Data source**: the `colima`, `docker`, `podman` and `kubectl` CLIs already on the machine; `limactl`, `nerdctl`, `ramalama`, `krunkit`, `osascript` and `open` only where needed.

A webview invokes Rust commands, which shell out on a blocking thread. No daemon, no HTTP server, no database: CLI output is read on demand and held in React state. Durable state is small — preferences, dashboard layout and tags in `localStorage`, model-server PIDs in `<colima home>/runtime-desk-serve.json` so a relaunch can stop a server it started, and the window frame in `window.json` in the app config dir. Arguments go as arrays, never shell strings, and nothing survives a restart: every launch probes afresh. In-memory only: profiles 10 seconds, `colima status` per profile 5 minutes (cleared by any profile mutation), disk totals and per-volume sizes 60.

## Backend

### `src-tauri/src/lib.rs`

Assembly point; `main.rs` only calls `run()`.

- `blocking(f)` wraps a closure in `tauri::async_runtime::spawn_blocking`, so a slow CLI call never blocks the webview.
- Commands doing user-visible work return `Result<T, String>`; best-effort probes return defaults (a missing optional tool yields an empty list).
- `ServeState` (`Mutex<HashMap<profile, pid>>`) tracks AI model servers, mirrored to `<colima home>/runtime-desk-serve.json` on every change because a server outlives the window; entries whose PID `kill -0` rejects are dropped on load, so a crashed run cannot offer a "running" server that Stop then fails to kill.
- `EventStream` is a `Mutex<Option<Child>>` for the live `docker events` child: starting a stream kills the previous one, so a profile switch cannot leave a reader on the old daemon; its thread ends at stdout EOF.
- `StatsStream` is the same shape for Sherlock's `docker stats <id>`: one JSON sample per second, then `__stats_end__` when stdout closes, so the panel falls back to polling instead of freezing on the last number.
- `run()` calls `tools::ensure_toolchain_path()` first (a Finder launch inherits launchd's `PATH`), registers the opener plugin, installs the menu from `menu::build` with `menu::dispatch`, builds the menu-bar item from `tray::build` (its Start/Stop forward a `tray` event to the window, which owns the action), manages the three states, prefetches profiles while the bundle loads, and lists every command in `tauri::generate_handler!` — missing there, a command is invisible even if it compiles. `RunEvent::Exit` kills both stream children.

Command groups (100 total):

- **Profiles and Colima VM** (19): `list_profiles_cmd`, `status_cmd`, `start_cmd`, `stop_cmd`, `restart_cmd`, `delete_cmd`, `recreate_profile_cmd`, `set_profile_cmd`, `profile_config_cmd`, `version_cmd`, `template_cmd`, `ssh_config_cmd`, `prune_cmd`, `update_cmd`, `nerdctl_install_cmd`, `vm_diagnostics_cmd`, `version_check_cmd`, `upgrade_cmd`, `app_release_cmd`
- **AI** (8): `model_run_cmd`, `model_list_cmd`, `model_pull_cmd`, `model_setup_cmd`, `model_chat_cmd`, `model_serve_start_cmd`, `model_serve_stop_cmd`, `model_serve_status_cmd`
- **Containers** (9): `list_containers_cmd`, `container_action_cmd`, `container_detail_cmd`, `container_details_cmd` (one `docker inspect` for a whole Compose project), `container_logs_cmd`, `container_stats_cmd`, `container_stats_one_cmd`, `container_update_memory_cmd`, `inspect_cmd`
- **Images** (5): `list_images_cmd`, `image_platforms_cmd`, `image_detail_cmd`, `image_pull_cmd`, `image_remove_cmd`
- **Volumes** (5): `list_volumes_cmd`, `volume_detail_cmd`, `volume_sizes_cmd`, `volume_contents_cmd`, `volume_remove_cmd`
- **Networks** (4): `list_networks_cmd`, `network_map_cmd`, `network_detail_cmd`, `network_remove_cmd`
- **Docker-wide and streams** (10): `disk_usage_cmd`, `docker_prune_cmd`, `cleanup_report_cmd`, `compose_list_cmd`, `events_start_cmd`, `events_stop_cmd`, `stats_start_cmd`, `stats_stop_cmd`, `stats_all_start_cmd`, `stats_all_stop_cmd`
- **Podman machines** (8): `podman_machines_cmd`, `podman_machine_init_cmd`, `podman_set_machine_cmd`, `podman_machine_set_cmd`, `podman_start_cmd`, `podman_stop_cmd`, `podman_restart_cmd`, `podman_remove_cmd`
- **Podman objects** (24): `podman_containers_cmd`, `podman_container_start_cmd`, `podman_container_stop_cmd`, `podman_container_restart_cmd`, `podman_container_remove_cmd`, `podman_container_logs_cmd`, `podman_container_detail_cmd`, `podman_container_inspect_json_cmd`, `podman_container_stats_cmd`, `podman_images_cmd`, `podman_image_pull_cmd`, `podman_image_remove_cmd`, `podman_image_detail_cmd`, `podman_image_inspect_cmd`, `podman_volumes_cmd`, `podman_volume_remove_cmd`, `podman_volume_detail_cmd`, `podman_volume_inspect_cmd`, `podman_networks_cmd`, `podman_network_remove_cmd`, `podman_network_detail_cmd`, `podman_network_inspect_cmd`, `podman_network_map_cmd`, `podman_disk_usage_cmd`
- **Kubernetes** (4): `k8s_cluster_cmd`, `k8s_resources_cmd`, `k8s_logs_cmd`, `k8s_cluster_action_cmd`
- **Host tools** (2): `system_status_cmd`, `lima_vms_cmd`
- **Desktop** (2): `open_url_cmd` — http and https only; anything else is refused before `open` runs; `tray_sync_cmd` — rebuilds the menu-bar item for the selected profile, its running state and whether a profile exists

### `src-tauri/src/colima.rs`

A thin wrapper around the `colima` binary.

- `colima_bin()` resolves `colima` through `tools::which_bin()`, falling back to `/opt/homebrew/bin/colima` because GUI apps do not always inherit a shell `PATH`.
- `run(args)` invokes with an argument array, returning stdout or `humanize()`d stderr, which unwraps logrus records (`time="…" level=fatal msg="…"`) so users see the error, not a JSON log line.
- `list_profiles()` parses newline-delimited JSON (array fallback), cached 10 seconds behind a gate: a launch asks twice and the second caller joins the run in flight. `invalidate_profiles()` drops it after any change; `prefetch_profiles()` runs it on a thread.
- `status()` takes the first line starting with `{`, since log lines may precede it.
- `instance_name()` maps a profile to its Lima instance (`colima` for default, else the name), naming its socket directory, kube context and disk image.
- `start()` maps typed options to flags: CPU a count, memory and disk GiB; `list --json` reports bytes. It also maps networking (`--network-mode/interface/address`, gateway, repeated `--dns`/`--dns-host`, `--port-forwarder`), mounts (`--mount-type`, repeated `--mount`, `--mount-inotify`) and `--ssh-agent`, and `validate_start()` refuses what Colima would discard or misread before the CLI runs: a gateway whose last octet is not 2, a non-IP resolver, a bad ifname, `virtiofs` outside vz, a mount that starts with `-` or contains a comma. `delete()` adds `--data` only on request — the sidebar delete keeps data, Settings → Delete profile removes it. `recreate()` is stop → delete → start for the fields Colima reads only at creation.
- `colima_home()` / `resolve_colima_home()` resolve the config home as the CLI does: `$COLIMA_HOME` if it exists, then `~/.colima`, then `$XDG_CONFIG_HOME/colima`, else `~/.colima`; existence alone decides, and the resolver is pure so precedence is testable.
- `docker_endpoint(profile, status)` prefers the reported socket, else builds `unix://<config home>/<profile>/docker.sock`; that fallback lets `set_profile_cmd` configure the backend without `colima status` (about 1.3 s, never twice per switch), and `status_cmd` confirms the guess through `docker::confirm_endpoint`.
- `disk_image(profile)` finds the sparse disk (`<config home>/_lima/<instance>/disk`, then `$LIMA_HOME`, then `~/.lima`) in allocated blocks, not apparent size.
- `profile_config()` reads `<config home>/<profile>/colima.yaml` with a small YAML-subset reader — block maps and lists, inline `[]`/`{}`, quoted scalars, `null` — because the fields the UI needs are nested (`network`, `mounts`, `dnsHosts`, `kubernetes.k3sArgs`); a full YAML dependency was not worth that surface; `template()` reads the template file and `ssh_config()` shells out to `colima ssh-config`.
- `volume_contents(profile, root, rel, limit)` lists one volume directory over `colima ssh` in one `find -printf` pass. It stops one row past `limit` (the page the browser asked for) and returns `truncated` when there is more; the hard ceiling stays 5000 entries and 4 MiB, and only the page crosses the IPC boundary.
- `vm_diagnostics(profile)` runs one guest script over `colima ssh` (kernel, CPU count, load, uptime, memory and swap from `/proc/meminfo`, root and inode use, Docker state, OOM kills from the kernel log, and `/proc/sys/fs/binfmt_misc/rosetta`) and parses `key=value` lines; a stopped VM returns `ok: false` with Colima's message, so the page explains instead of blanking.
- `version_check()` compares `colima version` with `abiosoft/colima`'s newest GitHub release and reports whether Homebrew can upgrade in place; `upgrade()` runs `brew upgrade colima` and refuses hand-installed binaries; `app_release_check()` does the same for this app (`dm0xa/runtime-desk`).
- Model servers spawn `colima model serve` detached and return the PID; stopping sends `SIGTERM`.

### `src-tauri/src/docker.rs`

The container client layer. Three process-wide values route commands: `ENDPOINT` (the `DOCKER_HOST` value), `CLIENT` (`Docker` or `ColimaNerdctl(profile)`), and `ACTIVE_PROFILE` (the profile those describe, so a late answer about another profile cannot rewrite them after a switch).

`set_profile_cmd` sets all three from the profile list the frontend holds, derives the socket through `colima::docker_endpoint(profile, None)`, and returns it; `status_cmd` later calls `confirm_endpoint(profile, socket)`, which replaces the guess only while its profile is still active. `run_docker(args)` then runs `docker` with `DOCKER_HOST` set, or `colima --profile <profile> nerdctl -- <args>`; `nerdctl_argv()` is pure and unit-tested.

`run_client(args)` gives the profile's own client one call, then one Docker attempt only on failure and only if the Docker CLI is installed, returning the client that answered. They list images differently: nerdctl shows untagged ones, while the Docker CLI from v29 hides them unless asked with `--filter dangling=true` (`-a` would add every build layer). `list_images()` tops up a Docker answer with that call, supplying the prune dialog's "Dangling images" count.

`run_output()` treats a zero-exit run that printed only to stderr as a failure: that is the client printing usage over lost argv, and an empty table would claim an empty daemon.

`image_platforms(ids)` answers the Images table's architecture column with one batched `image inspect`: the list format carries no platform, the inspect costs 0.8 s for 26 images, and the frontend asks again only when the set of ids changes. Ids are digest-shaped (12–64 lowercase hex, optionally `sha256:`) before they reach argv; a name or a leading dash is dropped rather than inspected.

The rest is parsing and one-line wrappers, pinned with `--format` templates.

Two long-running children live here, managed by `lib.rs`: `events_command()` (`docker events` filtered to container, image, network and volume types, `None` on containerd) and `stats_command(id)` (`docker stats --format '{{json .}}' <id>`, no `--no-stream`). `read_stats_lines()` strips redraw controls and forwards one sample per 700 ms.

`volume_sizes()` returns per-volume sizes, largest first, from `docker system df -v --format '{{json .Volumes}}'`, on the 60-second disk cache; a client that cannot answer yields an empty list.

`container_update_memory()` is the only wrapper that writes a runtime limit: `docker update --memory=<bytes> --memory-swap=<bytes> <id>`, from a tested pure argv function. Both ceilings move together because raising memory alone fails while a smaller swap ceiling stays. The floor is 6 MiB; zero is rejected rather than sent (`--memory 0` succeeds and changes nothing, so only a new container can drop a limit); an id that looks like a flag never reaches argv.

`container_detail()` reports `State.OOMKilled` as `oom_killed`: `ps` shows the exit code, not the cause.

`disk_usage()` caches `docker system df` for 60 seconds: it walks the VM disk and takes 1.2–1.5 s with a few dozen images, the costliest part of a refresh. `set_endpoint()`, prune and image, volume and container removal clear the cache; a failed read never is. Sidebar and status-bar counts derive from the lists the frontend holds.

### `src-tauri/src/podman.rs`

A separate, Colima-independent wrapper around the `podman` binary.

- `run_podman(args)` uses `Command::new("podman").args([...])`, never a shell string or `DOCKER_HOST`; it sets `CONTAINER_CONNECTION`, podman's own way to pin a connection.
- `set_machine(name)` stores the machine in one slot, so lists, mutations, stats and logs follow without a per-command argument; `podman_set_machine_cmd` is the setter and the only way the backend learns which machine the pages show, as `set_profile_cmd` does for Colima.
- `machine_init()` builds `podman machine init [--cpus N] [--memory MB] [name]` and `machine_set()` builds `podman machine set [--cpus N] [--memory MB] <name>`, dropping empty or zero fields so a cleared input never becomes a flag; disk is not offered because podman only grows it on recreation. Both argv builders are pure and tested.
- `list_machines()`, `list_containers()`, `list_images()`, `list_volumes()` and `list_networks()` parse the matching `--format json` output; `list_volumes()` also reads `podman system df -v` for per-volume `size` and `links` — the only Podman command reporting a size per volume.
- `network_map()` runs `podman network inspect` and projects each network into the same `NetworkMapEntry` as Docker, including container IP and MAC.
- `disk_usage()` parses `podman system df --format json` into images, containers, volumes and reclaimable bytes, preferring `RawSize`/`RawReclaimable` over the human strings. Cached 60 seconds, cleared by pulls and by image, volume, container and machine removals; a failed read is never cached.
- `container_stats()` runs `podman stats --no-stream --format json` and converts human strings (`0.31%`, `217.1kB / 4.077GB`) into the bytes and percents the live strip and pressure guard read. It polls; there is no podman stats child.
- `container_detail()` parses `podman inspect <id>` into the same `ContainerDetail` Docker produces, pinned by a test against `src-tauri/tests/fixtures/podman-container-inspect.json`; each kind also has an `*_inspect_*` command returning raw JSON for the Inspect sheet.
- Actions map to `podman machine start|stop|restart|rm -f`, `podman start|stop|restart|rm -f`, `podman logs --tail <n>`, `podman rmi -f`, `podman volume rm -f`, `podman network rm`. `image_pull()` validates the reference with `docker::safe_image_ref` before argv, because a leading dash would read as a flag.

### `src-tauri/src/cleanup.rs`

The Cleanup page asks where the storage went, so it reads three sources.

- `system df -v --format {{json .}}` for container accounting: per-image use counts and ages, per-volume link counts, stopped-container writable layers, build cache entries — deduplicated by image ID, or an image with two tags would be counted and removed twice. It goes through `run_client()`, with one Docker fallback when nerdctl cannot run the verbose format. nerdctl rows use their own keys (`CreatedSince`, `CacheType`, `LastUsedSince`) and omit `State`, so ages fall back to the human phrase and running state to `Status`'s `Up` prefix.
- `colima ssh -- sh -c` for what occupies the VM: `df -P -k /var/lib/docker` for the Docker data disk (Colima mounts `/var/lib/docker` on a separate disk, so this is the honest denominator), `df -k /` for the root filesystem, `sudo -n du -sk /var/lib/docker` for the layers' cost, and the eight largest `*-json.log` files under `/var/lib/docker/containers`, which Docker's totals omit. `du` needs `sudo`; when refused, the Docker numbers and the data-disk reading still render.
- `colima::disk_image(profile)` for the sparse host image, in allocated blocks so a 60 GiB disk shows what Finder charges.

The three run in one `thread::scope` inside `report()`, so the page waits for the slowest, not their sum. Image "unique" bytes come from Docker's `UniqueSize`; summing them is the honest saving, since shared base layers survive for other images.

### `src-tauri/src/tools.rs`

Host tool detection and optional integrations.

- `ensure_toolchain_path()` runs once from `run()` and puts `/opt/homebrew/bin`, `/opt/homebrew/sbin`, `/usr/local/bin`, `/opt/local/bin` and `/usr/bin` ahead of the inherited `PATH`, which would otherwise hide every Homebrew CLI and gate the Docker surface off.
- `system_status()` checks nine binaries with `which_bin()` (a `PATH` scan with an executable-bit check, not a `which` process per tool) and probes `docker compose version` separately, the Compose plugin not being a standalone binary. The nine: `colima`, `docker`, `limactl`, `nerdctl`, `compose`, `ramalama`, `krunkit`, `podman`, `kubectl`. The same answer carries `host_arch` from one `uname -m` spawn (not a tool, and excluded from `ToolKey`), because `cfg!(target_arch)` would report `x86_64` for a build running under Rosetta.
- `compose_list()` returns an empty list when `docker compose` is missing, but a real failure otherwise, which usually means a broken installation.
- `lima_vms()` parses NDJSON from `limactl list --json` and returns an empty list on failure: Lima is optional and must not raise a banner on every refresh.
- `kubectl` is probed through `k8s::kubectl_installed()`, the same `which_bin()` scan.

### `src-tauri/src/k8s.rs`

Kubernetes, read through the host `kubectl` against the profile's own context.

- Colima installs k3s and merges a kubeconfig whose cluster, context and user are named after the **Lima instance**, not the profile label: `colima` for default, `colima-<profile>` otherwise (colima 0.10.3 `config.ProfileFromName`; verified live — enabling Kubernetes on `default` yields exactly one context, `colima`). `context_name()` derives it from `colima::instance_name()` and every call passes `--context <instance>`, so the active context is never consulted and two profiles cannot answer for each other.
- `pod_logs(profile, namespace, pod, tail)` runs `kubectl logs --all-containers=true --timestamps --tail <n>`, clamping the UI-supplied tail to 1..5000.
- `cluster_info(profile)` first runs `kubectl config get-contexts -o name`: the **context** appearing there *is* the "started with Kubernetes" condition, so a profile started without it renders an explanatory panel. `ClusterInfo` carries `context`, `enabled`, `reachable`, `version`, node/pod/deployment totals with ready counts, `namespaces`, `error` and `read_at` (unix seconds of the last good read); its other five reads (`get --raw /version`, `nodes`, `pods -A`, `deployments -A`, `namespaces`) run in one `thread::scope`, since each kubectl run is a process and a cold cluster would take a second.
- When the API server stops answering, `LAST_GOOD` (one slot per context, replaced only by a reachable read) is shown under its own `read_at` with `reachable: false`, so the page says "last read 14:03" rather than claiming a cluster with no pods.
- `resources(profile, kind, namespace)` answers for the six `KINDS` (`pods`, `deployments`, `statefulsets`, `daemonsets`, `services`, `nodes`), rejecting an unknown kind before kubectl runs. `None` becomes `-A`, a name `-n <ns>`; `resource_args()` is unit-tested because the wrong choice silently answers for the wrong scope.
- Every call sets `--request-timeout=10s`, or a stopping VM leaves the API server answering TCP and never replying and the page hangs instead of explaining.
- Rows share one shape (`namespace`, `name`, `ready`, `status`, `restarts`, `detail`, `age`): pods report ready counts, summed restarts and the container's *waiting* reason (a crash-looping pod's phase is `Running`); workloads `ready/desired` plus images; services ClusterIP/type/ports; nodes Ready, roles and kubelet version. Ages use `cleanup::parse_epoch()` and read `—` with no usable timestamp (Go's year-1 zero time included).
- `cluster_action(profile, verb)` accepts `start`, `stop`, `delete`, `reset` (checked by `cluster_verb()` first) and runs `colima kubernetes <verb> -p <profile>`, then drops the cached profile list because those entries carry the Kubernetes column.

### `src-tauri/src/menu.rs`

The native menu bar, built in Rust so the system owns the accelerators: Runtime Desk (About, Services, Hide, Quit, Settings… `⌘,`), File (New Profile… `⌘N`, Close Window), Edit (undo/redo/cut/copy/paste/select-all routed to the focused field, Search… `⌘F`), View (Show Sidebar `⌘⌥S`, Refresh `⌘R`, Enter Full Screen), Window (minimize, zoom, bring all to front), Help.

Items that change what the window shows never act on their own: `dispatch()` emits one `menu` event with the item id to the `main` webview, and `src/App.tsx` owns every destination (`settings`, `new-profile`, `search`, `refresh`, `toggle-sidebar`, `help`).

### `src-tauri/src/tray.rs`

The menu-bar item: the bundle icon plus a menu that names the selected profile and its state, with **Start**, **Stop**, **Show Runtime Desk** and **Quit**. `tray_sync_cmd` rebuilds it whenever the window's selection or running state changes, and disables Start/Stop when no profile exists; like the app menu, Start/Stop emit a `tray` event and the window runs the same `start_cmd`/`stop_cmd` path it uses everywhere else, so busy state, notices and the list refresh are not duplicated in Rust. Closing the window still quits (⌘Q or the tray's **Quit**); the item exists while the app runs.

## Frontend

### App shell

`src/App.tsx` owns the shell:

- sidebar groups and visibility — Overview (Dashboard, Activity, Sherlock), Docker (Containers, Images, Volumes, Networks), Colima (Machine, Kubernetes), Podman (Machines, Containers, Images, Volumes, Networks), Tools (Cleanup, AI Models), System (Settings) — plus the Settings rail (General, Sidebar, Configuration, About) and its Delete profile entry
- profile selection and `set_profile_cmd`
- tab state, settings section, search text, network scope, and the 32-entry back stack over tabs and Sherlock's trail
- the global refresh (15 s, 60 s with the event stream live), per-profile status/config loads, and Machine's 15 s diagnostics poll
- `act()` and notices
- dashboard layout, edit mode and drag reorder
- prune and create-profile dialogs
- shortcuts and the `menu` event
- the global search index
- the gate decision (`__blocked`, `__waiting`, `__podman-waiting`, or the real page)

One large component on purpose: views receive data and callbacks instead of fetching, so polling and error handling stay in one place.

`KubernetesPage.tsx` fetches for itself — kubectl is a separate CLI with its own cluster and cadence — reading cluster facts every 30 s while the profile runs (which is also how it notices a cluster coming back) and the selected resource list every 15 s only while enabled and reachable; `pageRefresh()` bumps its `refreshNonce` only for the visible tab. A cluster that stopped answering keeps its last counts under their own timestamp, and an unread count stays `—`.

`PodmanPage.tsx` owns its fetch and actions because Podman is not part of the Colima profile. It renders one section at a time (`machines`, `containers`, `images`, `volumes`, `networks`), takes `section`, `search`, `refreshNonce`, `netView`, `machine` and `allMachines`, and calls back through `onMachine`, `onOpenContainer`, `onOpenNetwork`, `onOpenMachines`, `onInvestigate`. It reloads on mount, section change and header Refresh (`podmanNonce`); no timer, no event stream. The machine picker sits above the tables (one machine stated, several a Select), pages read `Podman <Section>`, volumes reuse `VolumeTreemap` (`source="podman system df -v"`), networks `NetworkGraph` with a table/map switch, rows `TagBadges`, `TagButton` and the Inspector.

### Frontend modules

`src/lib/` is where behaviour that is not a component lives:

| Module | Responsibility |
|---|---|
| `activity.ts` | The Activity sampler: one long-lived `docker stats` stream with a 2 s poll fallback, 600-sample series at a 1 s accounting tick, one lifecycle per selected profile, per-tick subscriber fan-out, dead series dropped, newest-sample stamp for stall detection |
| `stats.ts` | Sherlock's streaming `docker stats <id>` channel, with the `__stats_end__` polling fallback |
| `stream.ts` | `docker events` consumer: 250 ms debounce, `exec_*` ignored |
| `errors.ts` | `humanizeDockerError` / `humanizePodmanError` → `{ title, detail, evidence?, containerId? }` |
| `memoryGuard.ts` | `PRESSURE_PCT` (90), `memoryPressure()`, `isUnbounded()`, limit string parsing/formatting |
| `tags.ts` | Tag store persisted to `runtimeDesk.tags`, with subscriptions |
| `globalSearch.ts` | Index over profiles, Docker and Podman objects, tags and visible tabs; prefix/word/contains scoring |
| `origin.tsx` | Compose-versus-Docker origin, the kubelet-name test for cluster-made containers, and the badge both feed |
| `format.ts` | Byte, size, date and uptime formatting |
| `modalFocus.ts` | Modal focus contract: first control or `[data-autofocus]`, Tab cycling, focus return, opt-in Escape, `overlayOpen()` so chords do not fire behind a dialog |

Views and components (all under `src/components/`, the two self-fetching pages included):

| Component | Responsibility |
|---|---|
| `KubernetesPage.tsx` | Cluster strip, namespace filter, six kind tables, typed-context friction on stop/reset/delete, pod logs |
| `PodmanPage.tsx` | The five Podman sections, machine picker, create/resize/pull dialogs |
| `InvestigatorPage.tsx` (Sherlock) | One subject's facts, related and attached objects, live performance, JSON sheets, for Docker and Podman subjects |
| `ContainerDetail.tsx` | Expanded container row: live strip, icon actions, inspect toggle |
| `InspectModal.tsx` | The Inspect sheet: Logs chrome and search, re-runnable command, raw JSON |
| `LogsModal.tsx` | Log viewer: RFC3339 prefix, level detection, ANSI stripping |
| `Highlight.tsx` | The single match tokenizer both sheets use |
| `TagButton.tsx` / `TagBadges.tsx` | Tag editor dialog and read-only inline list |
| `VolumeTreemap.tsx` / `NetworkGraph.tsx` | Volume area map and network topology, shared by the Docker and Podman pages |
| `Notices.tsx` | Notice stack, icons, collapsed evidence, actions |
| `Dialog.tsx` / `ConfirmButton.tsx` | Modal shell and arm-then-confirm control for destructive actions |
| `MemoryLimitDialog.tsx` | The limit editor the OOM notice opens |
| `RowMenu.tsx` / `PageSearch.tsx` / `PageHeader.tsx` | Portal row menu, per-page search, page header |
| `Onboarding.tsx` | First-run wizard with CLI install guidance |

`src-tauri/tests/fixtures/` holds test-only payloads. `podman-container-inspect.json` is the golden `podman inspect` document that `podman.rs` embeds with `include_str!` so the detail mapping is tested without a running machine.

### Dependency gates

`src/dependencies.ts` alone decides whether a feature can exist or run: `TOOLS` (label, install command, why, what it enables, Settings/onboarding group — `Core`, `Runtimes`, `Kubernetes`, `VMs`, `AI`) for the nine CLIs; `FEATURES` (feature ID → tools, daemon need); `featureGate(feature, tools, profileRunning, runtime)` → `{ ok, missing, needsDaemon }`; `toolsFor(features)`; `isSystemStatus(value)` for a cached probe.

Feature requirements:

| Feature | Tools | Daemon |
|---|---|---|
| `dashboard` | `colima` | no |
| `containers`, `images`, `volumes`, `networks`, `networkMap` | `docker` | yes |
| `activity`, `logs` | `docker` | yes |
| `investigator` (Sherlock) | `docker` | yes |
| `cleanup` | `docker` | yes |
| `compose` | `docker`, `compose` | yes |
| `machine` | `colima` | no |
| `podman` | `podman` | no |
| `kubernetes` | `colima`, `kubectl` | yes |
| `ai` | `docker` | no |
| `settings` | none | no |

Rules the UI depends on:

1. A missing tool hides the section or chip rather than disabling it (without `podman`, the whole group); nothing hides before the first probe (`tools === null`), so the sidebar does not flicker.
2. A closed daemon gate keeps the section visible but stops fetching, polling and actions, and the view says the profile is stopped (`__waiting`); the global refresh still reads profiles, host tools and, running, Docker data.
3. The last probe is cached in `localStorage["runtimeDesk.tools"]` and rendered next launch; a background refresh replaces it.
4. Podman's second gate is its machine: the four data sections render `__podman-waiting` while none runs, since a stopped machine answers nothing and an empty table would claim it does.

The event stream reuses the `containers` gate rather than testing `tools.docker`, with two guards the gate lacks: a finished probe (`!!tools`, since an unprobed machine reads as "ok" to avoid nav flicker) and `runtime !== "containerd"` (containerd satisfies the gate without a Docker CLI, but its client cannot replay a reconnect).

### Container client routing

The runtime decides the client (`set_profile_cmd` sets it, `docker.rs` above):

- **docker** → Docker CLI with `DOCKER_HOST` on the profile's socket.
- **containerd** → `colima --profile <profile> nerdctl -- <args>`; the host `docker` binary is not required, and `featureGate` counts the Docker requirement as satisfied when Colima exists and the runtime is containerd.
- **incus** → the profile is manageable, but the container views are built for Docker and containerd.

Podman never participates: `podman.rs` runs `podman` with `CONTAINER_CONNECTION` on the selected machine, never reads `ENDPOINT` or `CLIENT`, and a Colima switch never re-points the Podman pages. `readPodman(preferred)` re-validates the chosen machine (falling back to a running one, then the default), tells the backend through `podman_set_machine_cmd`, then reads the four lists, so a removed or stopped machine cannot answer for a running one.

Compose is the exception: `compose_list()` calls `docker compose ls` directly, so its counts and filters only work on Docker-runtime profiles.

### Live refresh

Docker-runtime profiles do not poll alone: `events_start_cmd` spawns
`docker events --filter type=container --filter type=image --filter type=network --filter
type=volume --format '{{json .}}'` against the profile's `DOCKER_HOST`, and a thread forwards
each stdout line through a Tauri `Channel`. `src/lib/stream.ts` debounces at 250 ms, ignores
`exec_*` actions (a health check emits three), and calls the App's refresh, so a burst costs one
refresh. The stream runs only while the `containers` gate is open (plus the guards above) and the
window is visible.

The 15 s timer stays a reconciliation pass: events during a child restart cannot be replayed, so
every fourth tick refreshes regardless (60 s).

containerd profiles answer `polling` and never spawn a child: `nerdctl events` emits a
`/tasks/exit`-style topic with no `--since`, `--until` or type filter, so it cannot replay a
dropped connection or be parsed by the Docker decoder.


### Live activity

`src/lib/activity.ts` is a module-level store with one sampling lifecycle: one `docker stats` child streams every container (`stats_all_start_cmd`), samples land in a `latest` map, and accounting runs once a second into per-container series capped at 600 points (ten minutes) plus totals; views slice the last 120 (`2 min`) or all 600 (`10 min`) through `src/lib/liveWindow.ts`, and a sparkline buckets those samples to about one point per pixel (keeping each bucket's maximum) because a 120 px box cannot resolve 600 points. A container absent for two ticks is dropped with its series (the CLI stops reporting a container about a second after it exits), and an empty id is ignored because the CLI prints a transient creation row. `container_stats_cmd` on a two-second minimum gap is the fallback when the stream is refused or ends. Subscribers are notified once per accounting tick; a failed sample clears history and records the error. A gate that reopens after more than two silent ticks starts a new recording — history, totals and the last snapshot are cleared — because splicing new samples onto old ones would draw the pause as continuous history.

The App activates the store when:

```ts
activityReady =
  docker tool installed &&
  selected profile running &&
  (activity widget visible || Activity tab open ||
   Sherlock is showing a Compose group)
```

Views only subscribe, so switching tabs keeps history and hiding the card stops the call. The sampler is independent of `document.visibilityState` on purpose: one long-lived stream spawns nothing per tick, and pausing it on a window switch left the charts with a gap (the Sherlock group panel fell back to its "Collecting the first samples…" placeholder on return). List refreshes and the `docker events` stream stay visibility-gated — those spawn CLI children per run.

The sampler's identity is the selected profile, not just "a profile is running": `docker stats` captured one endpoint when it spawned, so two running profiles would otherwise let the second page show the first daemon's rows and append its totals to the same series. A profile change clears the recording; a tab switch does not. `snapshot.at` is restamped on every accounting tick even when the child is silent, so the views' "no sample for Ns" line reads `activitySampleAt()`, the newest real sample.

### OOM guard

`src/lib/memoryGuard.ts` holds the rule set, so the Activity page, notices and dialog cannot disagree. `memoryPressure(stats, vmBytes)` returns running containers at or above `PRESSURE_PCT` (90), worst first, marking one `unbounded` when the ceiling `docker stats` reported is within 2% of the profile's memory (`colima list --json` reports it in bytes), because Docker echoes the VM total back when no cgroup limit exists. `parseMemoryLimit` / `formatMemoryLimit` read and write the dialog's strings, rejecting zero, `unlimited`, `none` and anything below Docker's 6 MiB floor, which `docker update` would accept and ignore; a live container only loses a limit by being recreated.

`App.tsx` evaluates pressure on every activity sample, so the guard costs no CLI calls; `pressuredRef` keeps one notice id per container, giving one alert per crossing and withdrawing it below the threshold. Past three pressured containers the guard raises one grouped notice naming the count and the worst three instead: the notice stack holds three, so per-container banners beyond it would be evicted while their ids stayed tracked, silently losing the alert. The notice opens `MemoryLimitDialog`, whose apply calls `container_update_memory_cmd` through `act()`.

### Notices and errors

`src/lib/errors.ts` turns raw CLI errors into `{ title, detail, evidence?, containerId? }`: image-in-use errors resolve IDs to names; running-container, daemon-unreachable, not-found, permission and port-in-use errors get specific titles and recovery text; `humanizePodmanError` reads Podman's stderr — advice first, failure last — titling from the dial result (`connection refused`, missing socket file, `os error 2` for a missing binary) and keeping the raw text as evidence; unknown errors keep their first line.

CLI output is never the headline: `evidence` stays collapsed behind **Show details**. `PodmanPage` renders the same banner for a failed list with `Open Machines` and `Retry`, and empty rows read `Loading…` / `List unavailable` rather than claiming an empty daemon.

`Notices.tsx` shows at most three: errors persist until dismissed, successes auto-dismiss after five seconds, duplicates drop by title and detail, container-scoped errors can offer actions. All mutations go through `act()`: set busy, invoke, show a success notice (a verb when the command returns nothing useful), then refresh.

### Dashboard composition

Every card is one file in `src/components/dashboard/cards/` default-exporting a `DashboardCard`;
`registry.ts` globs the folder (`import.meta.glob("./cards/*.tsx", { eager: true })`) at build time,
so a file is the whole registration, keyed by filename with `order` setting the default sequence.
The folder holds 18 cards; `kpi.tsx` sits one level up because anything inside `cards/` would be
discovered. Cards read `DashboardContext` from `context.ts` and nothing else, linking through its
callbacks, never `invoke` or a raw `setTab`, so every drill-down joins the back stack.

Layout: four columns above 1000 px, two at or below, with `useGridColumns()` watching the same
match so span math and CSS agree; `computeWidgetSpans()` packs rows, lets a card shrink into a
usable hole, redistributes leftover columns up to `maxSpan`, and pulls a later card into a gap a
pinned width left behind (`grid-auto-flow: dense` would backfill it and leave a ragged row lower
down); a user-fixed width (Auto · Half · Full) never shrinks, moving to the next row instead; drag
reorder uses FLIP animation with geometry frozen at drag start so the drop index does not flicker.
`LAYOUT_VERSION` (3) discards stored order, visibility and spans once when the default composition
changes.

The card template, per-card data sources and the `WidgetKey` rules are in [DASHBOARD.md](DASHBOARD.md).

### Local state

All keys are plain `localStorage` strings:

| Key | Contents |
|---|---|
| `runtimeDesk.tools` | Last tool probe, validated by `isSystemStatus` |
| `runtimeDesk.onboarded` | `"1"` once the setup wizard is completed |
| `runtimeDesk.widgets` | Per-card visibility |
| `runtimeDesk.order` | Card order |
| `runtimeDesk.spans` | Per-card width overrides |
| `runtimeDesk.hidden` | Hidden sidebar groups |
| `runtimeDesk.layoutVersion` | Version used to discard stale layouts |
| `runtimeDesk.tags` | Tags keyed by entity kind and ID |
| `runtimeDesk.tab` | The screen the window reopens to |
| `runtimeDesk.settingsTab` | Last Settings section |
| `runtimeDesk.sidebarHidden` | `"1"` while the sidebar is collapsed |

The screen and Settings keys are written on change, not on exit, so a crash or force quit still restores the last view. Tags are local metadata, not Docker labels: Docker has no API for adding labels to existing objects, so tags cannot live on the object and do not travel between machines.

## Parsing notes

Colima and Docker output formats are the main source of edge cases.

### Colima

- `colima list --json` is **newline-delimited JSON**, one profile per line, not an array. The parser accepts both.
- `colima status --json` is one object, sometimes preceded by log lines; the parser takes the first line starting with `{`.
- `colima start` takes a CPU count for `--cpus` and GiB for `--memory` and `--disk`; `list --json` reports bytes.
- `colima delete` only removes data when `--data` is present.
- Errors arrive as logrus records; `humanize()` extracts `msg` and unescapes newlines.

### Docker

- `docker ps -a` uses a tab-separated `--format` template with nine fields: id, names, image, status, ports, createdAt, state, the `com.docker.compose.project` label, and mounts last (raw, comma-separated).
- `docker stats --no-stream --format '{{json .}}'` returns one JSON object per container per sample; `MemUsage`, `NetIO` and `BlockIO` are human strings split on `/`, parsed by `human_bytes()` for binary and SI units.
- Sherlock streams instead: `docker stats --format '{{json .}}' <id>` keeps its cursor controls (`ESC [ H`, `ESC [ J`) even through a pipe and redraws at 2 Hz with one fresh reading per second. `strip_ansi()` cleans each line, `parse_stat_line()` parses it, and `read_stats_lines()` drops any line less than 700 ms after the last accepted one, so a redraw is not a second point.
- `docker system df --format '{{json .}}'` also returns human sizes, parsed by `parse_size()`.
- `docker volume ls` carries no sizes; `volume_sizes()` takes them from the `Volumes` array of `system df -v`.
- `docker logs --timestamps` is parsed in the frontend: RFC3339 prefix, ANSI stripping, and level detection on `FATAL`/`ERROR`/`ERR`/`PANIC`/`EXCEPTION`, `WARN`/`WARNING` and `INFO`/`NOTICE`.
- `docker network inspect <ids>` supplies the network map: subnet, gateway, internal flag, and attached containers with IP and MAC.
- Detail views use `docker inspect`, `docker image inspect` and `docker volume inspect`; raw JSON is requested only when **Inspect JSON** opens.

### Podman

- `podman machine list --format json` returns PascalCase keys: `Name`, `Running`, `Starting`, `CPUs`, `Memory` and `DiskSize` as string byte counts, `VMType`, `Port`, `Default`.
- `podman ps -a --format json` returns `Id`, `Names` as an array, `Image`, `State`, `Status`, `CreatedAt`, and `Ports` as objects (`host_ip`, `container_port`, `host_port`, `range`, `protocol`). The UI comma-joins names and renders ports into the same `0.0.0.0:8080->80/tcp` string `docker ps` prints, so one cell serves both runtimes.
- `podman images --format json` returns `Id`, `Names` array, `Repository`, `Tag`, `Size`, `CreatedAt`, `Containers`.
- `podman volume ls --format json` returns `Name`, `Driver`, `Mountpoint`, `CreatedAt`; sizes and link counts come from the `system df -v` text table, not this payload.
- `podman network ls --format json` uses lowercase keys: `name`, `id`, `driver`, `subnets` array (`subnet`, `gateway`), `internal`, `dns_enabled`.
- `podman container inspect <id>` returns an array; the detail view reads the first element's `Name`, `ImageName`, `State.Status`, `Created`, `NetworkSettings.Ports`, `Config.ExposedPorts`, `Mounts`, `Config.Env`, `Config.Labels`, `HostConfig`, `State.Health`, and the keys of `NetworkSettings.Networks`.
- Podman JSON shapes are pinned to Podman 6.1.4, and the inspect mapping is tested against a captured payload. Empty arrays return an empty list, not an error.

## Extending the app

### Add a CLI command

Implement it in the module owning that CLI (`Result<T, String>`, `Command::new(bin).args([...])`, never a shell string), add an `async fn ..._cmd` in `lib.rs` wrapped in `blocking(...)` — slow work there would freeze the webview — and register it in `generate_handler!`. Structured payloads get a type in `src/types.ts`; the frontend calls it with `invoke`. Steps: [DEVELOPMENT.md](DEVELOPMENT.md#adding-a-command).

### Add a gated feature

Add the feature to `FeatureId` and `FEATURES` in `src/dependencies.ts`, add a `NavItem` in `App.tsx` carrying that ID, and drive visibility, loading and polling through `featureGate(...)` — no local `if (!tools.x)`. A new tool also goes into `SystemStatus`, `TOOLS` and the Rust probe.

### Extend Podman

Add the call and a typed struct in `podman.rs`, the registered `podman_*_cmd` in `lib.rs`, and the payload type in `src/types.ts`. A new page also needs a `podman-*` `NavItem`, a `PAGE_SEARCH` entry and a `PodmanSection` branch in `PodmanPage.tsx`, with header Refresh as the only refresh control (`pageRefresh()` increments `podmanNonce` for every `podman-` tab). A one-machine call needs nothing: `run_podman` already exports `CONTAINER_CONNECTION`.

### Add a dashboard card

One file in `src/components/dashboard/cards/` named after the persisted key, default-exporting a `DashboardCard` (label, description, span, min/max span, order, `render(ctx)`) — that file is the registration. Consume `DashboardContext`, fetching only for a specific on-demand query, and bump `LAYOUT_VERSION` in `registry.ts` when the default composition changes, adding the card's description to [DASHBOARD.md](DASHBOARD.md).

### Add an entity relation

Return the field from the relevant detail command, add it to `src/types.ts`, and render it in `InvestigatorPage.tsx` with `onNavigate` so it joins the back stack. Load any list it depends on first — network data, for example, when the Networks tab or a network subject is active.

## Tests and invariants

Rust unit tests (81 today, `cargo test`) cover where a parsing bug is expensive: logrus humanization, size/percentage/age parsing; `colima nerdctl` argv and the containerd event decision; `colima start` flags including `--vz-rosetta`; the Podman inspect mapping against `src-tauri/tests/fixtures/`; machine `init`/`set` argv, where an empty field must not become a flag; the Kubernetes last-good cache, resource argv, log tail clamp; window work-area fitting and the web-link-only URL check; optional tools returning empty lists, `PATH` detection reporting `false`.

There is no frontend test runner; two scripts cover what `tsc` and `cargo` cannot and exit non-zero on a defect: `npm run check:commands` (`scripts/check_commands.py`) diffs every `#[tauri::command]` signature against every literal `invoke` site, and `python3 scripts/headless_probe.py` renders the stubbed `dist/` through a state × page × width matrix. Both are documented in [DEVELOPMENT.md](DEVELOPMENT.md).

Otherwise a frontend change is verified by exercising the affected screen; pull requests state the Docker/Colima setup used.

Invariants worth preserving:

- No blocking CLI call on the webview thread.
- No feature keeps polling after its gate closes, and nothing reaches a feature's tools un-gated.
- A closed gate renders a prerequisite panel (`__blocked`, `__waiting`, `__podman-waiting`), never an empty table that claims an empty engine.
- Numbers carry provenance: `countsRead`, `listsFailed`, `countsProfile`, `profilesRead`, `snapshot.at` and `ClusterInfo.read_at` decide whether a surface may show a value, and a surface that has not read says "not read" instead of borrowing another profile's counts.
- Podman pages never read or mutate Colima profile state.
- Mutating actions refresh the data and report through the notice system.
- Destructive friction scales with the object: two-click arm for a container or image, typed profile name to delete a profile, typed kube context for cluster reset/delete.
- New persisted keys are namespaced under `runtimeDesk.`.
- Dashboard widget keys stay stable; changing the default composition bumps `LAYOUT_VERSION`.

## Tradeoffs and limitations

- **macOS conventions.** `open_url_cmd` uses `open`, AI chat AppleScript and Terminal.app, the Colima binary falls back to `/opt/homebrew/bin`, the menu bar is native, and the remembered window frame is reapplied on launch, pulling a frame no monitor fully holds into the nearest work area. No other platform is supported yet.
- **No TTY.** The app cannot host an interactive shell or container exec session; AI chat delegates to Terminal.app, and a real terminal pane is a separate project.
- **Polling where streaming is not trustworthy.** Docker lists refresh every 15 seconds while the window is visible, or every 60 with `docker events` connected; the activity sampler holds one `docker stats` child that streams every container at about 1 Hz (accounting once a second; a `docker stats --no-stream` poll every 2 s is the fallback when the stream is refused or ends); Sherlock streams `docker stats` at 1 Hz, falling back to a 5-second `podman stats --no-stream` poll. Every sampler stops while the window is hidden, and the 60-second disk cache can lag a minute unless a prune or removal clears it.
- **Aggregate disk totals.** `docker system df` totals are one cached walk that cannot be split per object; per-volume sizes and link counts come from the same `system df -v` payload, and per-image "unique" bytes exist only on Cleanup, where rows deduplicate by image ID. A layer breakdown needs `docker image history`, read on demand by Image detail.
- **Compose is Docker-only.** nerdctl has no Compose integration, so the Compose count and filter do not apply to containerd profiles.
- **Podman runs beside Colima, with a smaller surface.** The Podman pages follow one machine (`CONTAINER_CONNECTION`) that can be created, resized (CPUs and memory; a restart applies it, disk cannot change), started, stopped, restarted and removed. Images pull and remove, containers log, inspect and expose a stats strip, volumes use the treemap, networks the table/map view, tags and the Investigator work on Podman objects. Missing: events stream, streaming stats child, Cleanup report, Compose projects, disk resizing.
- **Local UI state.** Layout and tags live in webview storage; clearing the app's data resets them, and they are not portable.
- **Disabled CSP.** `tauri.conf.json` sets `"csp": null`; only local assets and two self-hosted variable fonts (`/fonts/inter-var.woff2`, `/fonts/jetbrains-mono-var.woff2`, preloaded from `index.html`) load at render time, so define a real CSP if remote content is ever added. Container and log strings render as React text, not HTML.
