# Changelog

Every release of Runtime Desk, what it added and what it still cannot do. The format
is [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), the versions are
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

## 1.7.0 — 2026-11-19

### Added

- **Pick 2 or 10 minutes of live history.** One switch, shared by Activity, a container's Performance and a Compose project.
- **Every live chart shows its own time axis.** You can see how much history it really holds.
- **Hovering a project member highlights it in every chart.** Same colour, one container.

### Fixed

- **A paused sampler starts a new recording.** No fabricated history across a gap.

## 1.6.0 — 2026-11-19

### Added

- **A Compose project is now a health and cost page.** Open a project in Sherlock for every member's state, health probe, restarts, memory against its own limit and last exit — worst first, with start/restart on each faulty row.
- **Footprint.** Which image each service runs and whether it is shared, stale or not pulled, which volumes it holds and how large they are, plus bind mounts.
- **Project cost and topology.** Block I/O and pid totals beside the memory chart, member counts per network, and host-port collisions with other projects.

### Changed

- **One `docker inspect` per project.** Member details arrive in a single call instead of one per container.

### Fixed

- **Pages that draw no live numbers stop polling.** Only views with a running chart keep the one-second subscription.

## 1.5.1 — 2026-11-19

### Fixed

- **Charts keep filling while the app is in the background.** Live stats no longer pause on a window switch, so Activity and the container Performance panel keep sampling and have no gap when you come back.

## 1.5.0 — 2026-11-19

### Changed

- **`colima status` is read once per profile.** It costs 1.3 s and cannot change while the profile runs, so it is cached for five minutes and cleared by every profile change. Removing a container no longer waits on it.

### Added

- **Networking, mounts and SSH-agent are controls, not YAML edits.** **New profile** sets network mode, interface, IP, DNS, gateway, port forwarding, mount type, mounts, inotify and SSH-agent; Machine shows a **Network** panel with **Change…**. Bad values are refused before the CLI runs.
- **Recreate a profile for settings Colima reads only once.** Architecture, VM type, runtime, mount type and network are fixed at creation, so Machine can delete and start the profile again — keeping or deleting images and data — with the settings this app exposes.
- **A menu-bar item.** The selected profile and its state, with **Start**, **Stop**, **Show Runtime Desk** and **Quit**, sharing the window's busy state and notices.
- **Emulation is visible, and impossible profiles are refused.** Images gain an **Arch** column that tells Rosetta-translated rows from qemu-emulated ones, Machine proves Rosetta from the guest, and **New profile** starts from this Mac's architecture.
- **An OrbStack comparison.** [docs/ORBSTACK.md](docs/ORBSTACK.md) audits OrbStack's published benchmarks and adds this Mac's measured Colima baseline.

## 1.4.0 — 2026-11-18

### Changed

- **Settings is one page with tabs.** General, Sidebar, Configuration and About sit in a segmented bar at the top (arrow keys work) instead of a second rail beside the sidebar, and **Delete profile** moved to the bottom of General. The app menu's **About Runtime Desk** opens that page too.
- **The sidebar is one list.** Settings sits below the navigation and above the profile switcher, and group headings read as sections again.
- **A Mac Help menu.** **Keyboard Shortcuts** (⌘/), **Runtime Desk Guide** and **Report an Issue…**, plus **Toggle Sidebar** — which is what it does.
- **Activity is two cards.** **Live totals** keeps the fleet CPU chart, the metric strip and the rate cards; **Containers** is the table on its own, headed with the running count.
- **Banners hug their message.** A one-line notice is the width of its sentence, not a 760px empty bar with the dismiss button at the far end.

### Fixed

- **A timeout says what is happening, and offers the fix.** "colima did not answer within 20s" now reads **Colima is not answering**, explains that a starting VM answers once it settles, and carries **Retry**; the CLI's own line stays behind **Show details**.
- **A mount reads as a path, not a wrapped sentence.** Related › Mounts gives each row two lines, and a long host path breaks after its `/` separators instead of mid-word beside its destination.

## 1.3.0 — 2026-11-18

### Added

- **A Compose project is now one page in Sherlock.** A project shows its containers' live CPU, memory and network as stacked charts, alongside tags and published ports — open it from the picker's **Groups** filter or from a container's Compose link.
- **Every Activity row opens its container in Sherlock.** A fingerprint icon in the new Actions column hands that container to the page that shows everything attached to it.

## 1.2.1 — 2026-11-18

### Fixed

- **The window opens where you left it.** Size, position and maximized state are remembered again, in screen points in `window.json` instead of the window-state plugin's physical pixels, so a frame saved on the laptop no longer comes back at half size on an external display — and one remembered from a display that is gone is pulled back onto a display that is present.

## 1.2.0 — 2026-11-18

### Changed

- **A container's Labels panel now says where each label came from.** Sherlock splits them into **Set at runtime** and **From image**, and keeps one flat list with a short note when the image is gone.

## 1.1.5 — 2026-11-17

### Fixed

- **A new release is announced once.** Settings › About already names the version inline, so the launch banner now stands down while that panel is open instead of repeating it.
- **Banners share the column they sit above**, matching a Settings pane's width and keeping the page gutter in narrow windows.

## 1.1.4 — 2026-11-16

### Fixed

- **A stuck daemon no longer freezes the window.** Every CLI call has a deadline now — 20 s for reads, two minutes for actions — while genuinely long work such as `colima start` or `docker pull` is allowed to finish. A suspended VM can no longer wedge the app into a force quit.
- **List pages stopped claiming the engine was empty.** A missing compose plugin no longer blanks Containers, Images and Volumes, and an empty table now says whether a read failed, is still running, or a filter matched nothing.
- **The AI page's buttons now switch the container client**, so docker calls follow the profile the header names.
- **Podman volumes with an unreadable size table show `?`** and cannot be removed until the use count is known; container start and stop refresh the counts immediately.
- **Smaller fixes:** Podman machine tags open Machines instead of a Sherlock page for something that does not exist, a Kubernetes filter whose chip disappeared falls back to All, Pods turn amber when not all are running, and a failing monitor query no longer refuses to start the app.

### Changed

- **A refresh does about half the work it used to.** One wave per profile replaces several overlapping ones, the docker wave starts beside `colima list` instead of behind it (634 → 345 ms measured here), and the profile status and list are cached for ten seconds.
- **The Activity view streams from one `docker stats` child** at about 1 Hz instead of spawning a poll every two seconds, and the charts keep a true 72-second window.
- **`docker events` sends two fields per line** — 30 bytes instead of 537 — and tells the window when it has ended, so the slow cadence only applies while no stream is live.
- **Big lists draw less.** Logs mount 500 lines with **Show more**, volume directories load a page at a time, Podman containers and images draw 100 rows per page, and the Ports column shows three chips plus a `+N` badge.
- **Sherlock keeps its live panel across a refresh**, labels real elapsed time instead of assuming one second per sample, and loads one container's stats when a row expands rather than the whole list.

## 1.1.3 — 2026-11-16

### Changed

- **Settings → About reads as a Mac about panel.** It was a dashboard: status pills, a facts strip, a 2×2 launcher grid, a tip row — five equal-weight blocks, so nothing led. Now it is one centered column: logo, name, version and `GPL-3.0-only` in mono, credits, `Built with Tauri 2 and React 19 by dm0xa.`, text links, and the copyright notice.
- **Runtime Desk is now GPL-3.0-only, not MIT.** LICENSE carries the verbatim GNU GPL v3, `package.json` and `src-tauri/Cargo.toml` declare `GPL-3.0-only`, and Settings → About links its full text. Earlier releases stay under MIT; copies from now on must keep the source available under the GPL.

### Added

- **A Homebrew cask.** `brew install --cask dm0xa/tap/runtime-desk` installs the newest release, `brew upgrade --cask runtime-desk` moves it forward, and `--zap` drops the window state and WebKit cache. The cask is generated by `packaging/homebrew/bump.sh` from each release's `SHA256SUMS.txt` (which releases now carry), pins both architectures, and removes the quarantine flag after install — but only when the bundle really is ad-hoc signed, so a notarized build keeps its Gatekeeper check.
- **A Podman machine can be resized.** **Resize…** on an expanded machine row runs `podman machine set` with the new CPUs and memory (disk is not offered: podman only grows it on recreation) and says a restart is needed.
- **Podman images can be pulled too.** The Podman Images page gained **Pull image…** (`podman pull` in the selected machine, reference validated by the Docker page's whitelist).
- **Podman is no longer default-machine-only.** A Mac with two machines had one invisible: every `podman` call read the current connection, and nothing could change it. `podman_set_machine_cmd` now names the machine (exported as `CONTAINER_CONNECTION` inside `run_podman`), the pages open with a picker (a sentence when there is only one), and switching re-reads all four lists.
- **Images can be pulled, and a VM resized, from the app.** The Images toolbar gained **Pull image…** (`docker pull` against the selected profile, reference validated before argv), and the Machine profile card gained **Resources…**, which explains that Colima applies new CPUs, memory or disk through `colima start` and therefore starts the profile (`Start default with these resources`).
- **Kubernetes.** The k3s cluster inside the VM gets its own page: Nodes, Pods, Deployments, StatefulSets, DaemonSets and Services per profile, a namespace filter and pod status as the waiting reason (`CrashLoopBackOff`, `ImagePullBackOff`). Reads use `kubectl --context <instance>` (the Lima instance name, `colima` or `colima-<profile>`) with a request timeout. Without Kubernetes a profile offers **Enable Kubernetes** (`colima kubernetes start -p <profile>`); one strip menu has **Stop Kubernetes**, **Reset cluster** and **Delete cluster** — Stop needs a second click, reset and delete a typed context name. Pod rows open the log window (`kubectl logs`, every container, timestamps). **New profile…** takes **Kubernetes (k3s)** and an optional `--k3s-arg`; `kubectl` joins the probe list.
- The Storage usage card is provider-scoped: Docker and Podman donuts from `docker system df` / `podman system df`. Podman's reading is cached for a minute, cleared by removals.

- **The cluster's containers can be filtered out.** Containers carries a fourth origin chip, **Kubernetes** (`All 9 = Compose 1 + Docker 2 + Kubernetes 6`), so `docker ps`'s kubelet rows are no longer noise; the Docker chip excludes them, making the four chips a partition.
- **Images, Volumes and Networks filter the objects you can delete.** Each list gained its siblings' toolbar row: **All / Unused** for images and volumes, **All / User-defined** for networks (built-in ones cannot be removed). All four lists start their table at `y = 112` at 1280, so switching pages no longer jolts the list by 34px.
- **A Podman machine can be created from the app.** The Machines list and the new prerequisite panel offer **New machine…**, which explains that the first one downloads a VM image and runs `podman machine init` with the name, CPUs and memory you give it (all optional). Before, a Mac with `podman` and no machine had four dead tabs.
- **An unreachable cluster shows its last counts, under their timestamp.** The strip used to print `0/0` for a cluster that never answered; it now says `These counters are the last answer, read at 14:03 — the cluster is not answering now.` Rust keeps the last successful answer per kubeconfig context; a cluster never read shows `—`.
- **A stopped daemon is never an empty engine.** The status bar asks whether data was *read*, not whether the tab needs it, so Dashboard, Machine and Settings no longer print `0 running · 0 containers · 0 images · 0 volumes` behind a green dot when nothing was queried (`default stopped · counts not read` instead). The delete dialog says the contents were not read instead of `0 / 0 / 0`; a failed `docker ps` renders **List unavailable**, not **No containers**; an unanswered map renders `—`, and Podman's four tabs take the same panel (**Open Machines**, **Recheck**).
- **Cold start claims nothing it has not read.** Before the first probe answers, resource cards read **Reading the profile and its lists…** / **Checking what is installed…** with `—` instead of **No Colima profile yet** and **Podman is not installed**; a failed list wave reads **The lists did not answer**.
- **Dashboard cards put the fix in the card.** A stopped profile's *Docker Resources* and *Storage usage* cards keep their metrics, reading `—` rather than `0`, with the note above and **Start profile** one click away.
- **Activity stops claiming zeros before the first sample.** The first second rendered `CPU 0.0%` and **No running containers** beside a sidebar badge that said otherwise; it now says it is reading, and a paused monitor says its reading is stale.
- **An unreachable cluster shows no numbers.** When the API server does not answer, the Kubernetes strip prints `—` for every counter, the table says the cluster did not answer instead of **No pods**, and **Recheck** sits beside the error. A kubeconfig `kubectl` cannot read is shown as that failure, not "Kubernetes is not enabled" with an Enable button.
- **The Containers name column no longer collapses.** Between 1001 and 1102 px the fixed columns summed past the wrapper and the name column reached 0 px, because the guard was a media query at 1000. The floor is unconditional now (160 px at any width); Kubernetes tables got the same floor so seven columns cannot squeeze to 92 px.
- **One delete surface.** The sidebar profile menu's **Delete** (`--data false`, allowed while running) is now **Delete profile…**, opening Settings' typed confirmation, so both keep the running guard and disk wipe. The dialog also names the profile its numbers belong to: a stopped `beta` while `alpha` is selected says the contents were not read.
- **The settings rail no longer narrows the content column as the window widens.** Its width stepped 240 → 52 at a breakpoint, making content 187 px narrower just above it; it keeps its labels as `clamp(140px, 12vw, 240px)`, so content is monotonic: 536 px at 900, 902 at 1280, 1184 at 1600.
- **Hiding the sidebar keeps the Settings rail.** ⌘⌥S left Settings · General with no way to reach About, Configuration or Delete profile; the rail is a content column and stays. The toolbar keeps a 92px leading inset, where the title bar's window buttons sit. ⌘⌥S now matches the physical key (`e.code`): with Option held WebKit reports `ß`, not `s`.
- **Sortable headers are controls.** Every sortable `<th>` carries `aria-sort` and a focusable button answering Return and Space, and the Networks table — unsortable while its three siblings were not — sorts all four columns. The row menu takes and returns focus, handles ↑/↓/Esc, and announces `aria-haspopup`/`aria-expanded`; a group header's profile/machine hint went from 2.25:1 contrast to the muted ink.
- The sidebar stops implying Kubernetes is an engine. **Machine** and **Kubernetes** share one **Colima** group, because k3s runs inside that VM and, on docker-runtime profiles, through the same daemon. A kubelet-created container (`k8s_…`, plus one `rancher/mirrored-pause` sandbox per pod) carries a **k8s** chip wherever a container is named and counts on the Kubernetes row. Saved visibility migrates: the merged group stays hidden only if both old sections were, and a stored **Colima** key wins.
- First run no longer resizes when you step from **Welcome** to **Tools**: the modal is `height: min(720px, 88vh)` for both steps, the tools list scrolls inside the body, and the closing note pins to the bottom. The headline also rotates **kubectl**.
- **The app is Runtime Desk.** The old name named one runtime; the app reads every one it finds. `Colima Desk` became `Runtime Desk`: product name `Runtime Desk.app`, bundle id `io.github.dm0xa.runtimedesk`, repository `dm0xa/runtime-desk`, keys under `runtimeDesk.`, disk image volume `Runtime Desk`. Nothing migrates — the old stores belong to the old bundle — so saved tags, layout, visibility, the setup flag and the window frame start clean once.
- **Inspect JSON opens a window, like Logs.** Every Inspect JSON glyph — image, volume and network rows, the Sherlock bar, the Podman lists — opens the payload in its own window: line numbers, search, copy, wrap, and a reload that re-runs the command. It reuses the Logs chrome and drops late answers. On Sherlock it also fixes the Podman path, which always ran the container command.
- First run speaks about containers, not one tool. The welcome headline cycles **Colima**, **Docker**, **Podman** and **containerd** in accent green — random order, 2.2 s apart, never repeating a word on screen — and the lead names every CLI the app reads (`colima`, `docker`, `podman`, `nerdctl`). About describes a console for Colima profiles, Docker, Podman machines and Lima VMs, not one "over the Colima VM".
- The window is a Mac window now. The title bar is an overlay: traffic lights over a translucent sidebar, and a 52 px unified toolbar (also the drag region) above the content; the sidebar reserves the 38 px the controls need. A native menu bar adds App, File, Edit, View, Window and Help with ⌘N, ⌘F, ⌘R, ⌘, and full screen. Typography moved to SF Pro and SF Mono, controls dropped to 26 px on a 6 px radius, and ⌘, opens Settings.
- The window behaves like a Mac window: size, position and maximized state survive a relaunch (`tauri-plugin-window-state`), the last screen and sidebar visibility are restored, and View → **Show Sidebar** (⌘⌥S) hides the nav. Reduce Transparency makes the glass bars solid and Increase Contrast strengthens every hairline.
- Launch no longer waits on a serial CLI chain. The profile socket comes from colima's path convention (`colima status` confirms it behind the caller), the container lists run in the tool probes' wave, `colima list` is read once per launch, prefetched while the window loads, and `docker system df` — the slowest call — fills storage after the containers are on screen.
- **Two checks cover what `tsc` and `cargo` cannot.** `npm run check:commands` compares every `#[tauri::command]` signature with every `invoke` call and payload under `src/` (94 commands, 94 referenced), failing on an unhandled command, a dead one, or a wrong payload key (`--self-test` proves it still catches both). `scripts/headless_probe.py --gate` checks 17 states on 17 pages at 900/1280/1600.

### Fixed

- **Stop and Restart on the Machine page could never work.** They sent `{ opts: { profile } }` while `stop_cmd`/`restart_cmd` take a bare `profile`, so Tauri rejected every call and the app showed an "invalid args" notice. Both now send the declared shape.
- **Creating or losing a profile left the container client on the old socket.** "Create & Start" set the selection without calling `set_profile_cmd`, and `refresh()` re-selected `p[0]` when the selected profile vanished, so the lists kept reading the previous (or the machine's default Docker) endpoint. Both paths now point the client at the profile they select.
- **"Prune unused data" promised named volumes and removed only anonymous ones.** Docker 23+ prunes anonymous volumes unless `-a` is passed; the job is now `volume prune -fa`, and `prune_jobs` is pinned by a test for both image variants.
- **A failed container list no longer licenses a force-remove.** Image and volume rows disable their bin when the list that proves "in use" did not answer (`listsFailed`), saying so on hover, instead of reading "— used by" and arming `rmi -f`; Podman's image bin follows the same rule.
- **Model and runner names are validated before they reach a shell.** `colima model run` goes to Terminal through AppleScript, and the field was interpolated with only `\` and `"` escaped — `;`, `$()` and backticks executed. A single `safe_model_arg` whitelist (letters, digits, `._/:@+-`, no leading `-`, 200 chars) now guards pull, run, serve, setup and the Terminal path, with a test that feeds it `; curl … | sh`.
- **Reset and Delete cluster ask for the context name.** They were a second-click arm like Stop; a reset wipes workloads and a delete wipes the cluster, so both now require typing `colima` (or the profile's context), as deleting a profile does.
- A closed daemon no longer reads as an empty engine. With the profile stopped — or no Colima profile at all — Containers, Images, Volumes, Networks, Activity and Sherlock said **No containers**; they now render a prerequisite panel: the reason, **Start profile** (or **New profile…**) and **Recheck**. **k8s** marks a container only when its name has the kubelet's shape (`k8s_<container>_<pod>_<ns>_<uid>_<attempt>`).
- A failed Podman list reads as a macOS banner, not CLI stderr above the table. Podman prints a page of advice before the failure it hit, so `humanizePodmanError` builds the sentence from the dial result — **Nothing is listening for Podman**, with `127.0.0.1:54379` and the refused connection, Podman's text behind **Show details**, and **Open Machines** and **Retry**. The empty table says "List unavailable", not "No containers".
- Errors read as macOS banners. The card is the panel fill with a 7% red wash and a 15px warning glyph, the sentence primary ink at 13px/600, CLI output behind **Show details**. It stops guessing: `permission denied` names the denied path, a missing `docker.sock` reads "The container socket is not there", and an unresolvable image id reads "An image is still in use" with the hex id.
- The sidebar reads at its real size. `button`, `input`, `select` and `textarea` did not inherit the font stack, so every nav row, profile row and status button rendered in the webview's default control font (Arial). Controls now inherit the system stack, nav and profile rows use primary ink, badges went to 11 px/500 and **+ Create new profile** to 13 px.

## 1.0.2 — 2026-11-13

### Fixed

- The Colima config home is resolved the way the CLI resolves it: `$COLIMA_HOME` when that directory exists, then `~/.colima`, then `$XDG_CONFIG_HOME/colima`. Profile config, the template, the stopped profile's socket, and the disk image on the host follow that home instead of assuming `~/.colima`.

## 1.0.0 — 2026-11-11

The first release. Colima Desk is one macOS window over a Colima VM: it runs the same `colima`, `docker`, and `nerdctl` commands you already use and shows the output, naming the affected object when something fails.
