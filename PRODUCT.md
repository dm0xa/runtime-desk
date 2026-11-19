# Product

<!-- impeccable:product-schema 1 -->

## Platform

web

## Stack

A macOS-only Rust desktop app wrapped by Tauri v2. The Rust side (`src-tauri/src/`) runs the CLIs off the UI thread as 96 Tauri commands; the frontend is React 19 + TypeScript + Vite in the system WKWebView, a 1300×820 window with a 900×600 floor and the macOS overlay title bar. Platform reads `web`: every pixel is HTML/CSS, no AppKit layer, no native controls. The menu bar is the only native UI, built in Rust (`menu.rs`) so macOS owns accelerators.

## Users

macOS developers who use [Colima](https://github.com/abiosoft/colima) for a Linux Docker or containerd runtime instead of Docker Desktop, and already have the `colima` CLI. They are mid-task on a profile that may be stopped; the author is the first and most demanding user.

## Product Purpose

One window over the Colima VM, Podman machines and their containers, so daily jobs — start a profile, inspect containers, read logs, remove images, pull, prune, resize a VM, run models — need no dozen tabs. Success over six months: the author reaches for this instead of `colima status`, `docker ps` and `docker logs`.

## Positioning

A thin, runtime-aware front-end: every view derives from Colima's JSON and the profile's client, the Docker CLI for Docker profiles, `colima nerdctl` for containerd. Podman views run the `podman` CLI against one machine: `podman_set_machine_cmd` names it and exports `CONTAINER_CONNECTION` inside every invocation, so every view follows the picker and never routes through Colima state. No daemon, no database, no remote service, no second source of truth: a failure is one sentence naming the object, the CLI's output a click away.

## Operating Context

Run from the bundle or `npm run tauri dev` (Vite on `http://localhost:1422`, `strictPort`); building needs Rust, Node 20.19+ or 22.12+ and Xcode command line tools, and `npm run bundle` writes app and disk image into `src-tauri/target/release/bundle/`.

The loop: pick a sidebar profile, start it from `⋯` if stopped, then work in Overview (Dashboard, Activity, Sherlock), Docker (Containers, Images, Volumes, Networks), Colima (Machine, Kubernetes), Podman (the same five pages), Tools (Cleanup, AI Models) or System (Settings). Live stats stream `docker stats` at 1 Hz while the Activity card or page, or a Compose group page, is on, and charts draw a 2 or 10 minute window; everything else refreshes from a `docker events` stream (250 ms debounce), plus a sixty-second reconciliation pass and a fifteen-second timer when no stream is live, kept by containerd profiles because `nerdctl events` has no `--since`.

## Capabilities and Constraints

- Profiles: list, status, start, stop, restart, delete (`--data` teardown after typing the name). **New profile…** covers name, CPUs, memory, disk, runtime (docker, containerd, incus — the last has no container client), architecture, VM type, Rosetta, mount, hostname, Kubernetes and k3s args. **Resources…** starts the profile with new CPUs, memory or disk; **Start with these resources** is disabled while it runs, since Colima applies resources on start.
- Docker views: containers with actions, details, a log window (100–5 000 lines, search with next/previous and **Match only**, error and warning lines coloured); Images and Volumes with used-by columns, removal refused while in use and an **All / Unused** filter; Networks with an **All / User-defined** filter, table and map; **Pull image…** from the Images toolbar.
- Podman views: a machine picker on all five pages, re-validated on each read. Machines get start/stop/restart/remove, **New machine…** (`podman machine init`) and **Resize…** (`podman machine set`, CPUs and memory only, disk grows on recreation). Containers get Docker's rows, logs and inspect; volumes carry sizes from `podman system df -v`; networks group built-in from user-defined.
- Kubernetes: one page per profile reading the single-node k3s Colima provisions: cluster strip, kind chips, a namespace filter; pods open the shared log window (`kubectl logs`, all containers, timestamps). **Enable Kubernetes** runs `colima kubernetes start -p <profile>`; stop is a two-click arm, reset and delete ask for the context name. Reads carry `--context colima[-<profile>]` with a ten-second timeout, so your kubectl context is never consulted; a failed read keeps the last good counts and read time (`ClusterInfo.reachable`, `read_at`).
- Dashboard: a KPI row (VM instances, running VMs, stopped VMs, allocated vCPUs) then resource, storage, Activity and System Status cards (`docs/DASHBOARD.md`). One file per card in `src/components/dashboard/cards/`; drag to reorder or into **Hidden cards**, cycle Auto / Half / Full, **Reset layout**.
- Activity: two or ten minutes of per-container CPU history (120 or 600 one-second samples) plus memory, network I/O, block I/O and PIDs, with an OOM warning at 90% of a container's limit or the VM's when nothing caps it.
- Sherlock: one object with its neighbours; live stats, the last 60 log lines, env vars and labels with secret values masked, health checks, build history, volume contents; tags added there reach Containers and ⌘K search.
- Machine, AI Models (pull, chat, serve via Docker or `ramalama` in a `krunkit` profile), Cleanup (`docker system df -v`, one guest scan of `/var/lib/docker`, images unused for 30 days stale, the eight largest container logs), Settings (General, Sidebar, Configuration, About, Delete profile).
- Dependency gates: a missing optional CLI hides its section, Podman until `podman`, Kubernetes until `kubectl`. The probe runs on every refresh (⌘R), showing in Settings → Sidebar and first run. The app installs nothing itself, but offers buttons that do: **Enable Kubernetes**, `brew upgrade colima`, **Install nerdctl**, **Pull image…**, **Pull model**, **New machine…**.
- A closed gate renders a prerequisite panel with the reason and a way out: **Start profile** (or **New profile…**), **Open Machines** when no Podman machine runs, **Recheck** and **Open settings** for a missing tool. The page slot has four states: `__blocked` (tool missing), `__waiting` (Colima daemon closed), `__podman-waiting` (no Podman machine), the page.
- Destructive actions require an explicit selection, the prune dialog previewing every category: two-click arm for a container and for stopping Kubernetes, the typed profile name to delete a profile, the typed context name to reset or delete a cluster.
- Counts carry provenance: `countsRead`, `listsFailed`, `countsProfile`, `profilesRead`, `snapshot.at`, `ClusterInfo.reachable`, `read_at`; the delete dialog prints counts only when they describe the selected profile, a failed list disables force-removal.
- Routing is decided per profile from `colima status`; Colima 0.10.x is the verified baseline. Podman JSON shapes are pinned to 6.1.4.
- macOS only, unsigned, not notarized. UI state is `localStorage` (tags, dashboard order/spans/visibility, hidden groups, last screen, last settings section, onboarding, last tool probe) plus model-server PIDs in `runtime-desk-serve.json` (Colima's config home) so a serve survives a relaunch; no database.
- UI copy is English today; localization is undecided.
- Undecided: signing and notarization, Linux and Windows support, an embedded terminal.

## Brand Commitments

Runtime Desk names what it reads: every container runtime on the machine, rather than one of them. Palette and logo come from [colima.run](https://colima.run) (`public/logo.png`, `public/colima*.svg`); the README keeps that attribution. Voice: first-person, plain, admits rough edges.

## Evidence on Hand

- `README.md`, `docs/USAGE.md`, `docs/ARCHITECTURE.md`, `docs/DEVELOPMENT.md`, `docs/ROADMAP.md`, `docs/DASHBOARD.md`.
- `src-tauri/src/podman.rs` (Podman 6.1.4 JSON shapes the UI parses) and `src-tauri/src/k8s.rs` (kubectl shapes, per-context last-good cache).
- Logo and icon assets in `public/` and `src-tauri/icons/`; a verified Colima 0.10.x capability table in `docs/ROADMAP.md`: relations, sizes, layers, Compose projects and live state Colima cannot report.
- 81 Rust tests cover CLI parsing and client selection; `scripts/check_commands.py` checks every literal `invoke()` name and payload against the Rust signatures, listing the payloads it cannot see; `scripts/headless_probe.py` renders 17 pages in 17 states at 900, 1280 and 1600 px. No frontend unit-test runner.

No testimonials, user counts, benchmarks, press or download figures exist; do not invent them.

## Product Principles

1. Report, do not reinterpret: what the CLI returned, error text included, object named.
2. Never act beyond the request: no silent installs, no background services. Anything that downloads or installs is a labelled button; a missing tool hides its section.
3. Destructive actions show their exact targets first.
4. The daily loop is the product: a running profile and its containers two clicks away, data without drilling.
5. One interface over three clients: Colima Docker, Colima nerdctl and Podman differences routed, not pushed onto the user.

## Accessibility & Inclusion

Keyboard everywhere: ⌘K or ⌘F, ⌘1–9, ⌘0, ⌘R, `⌘,`, ⌘N, ⌘[, ⌘⌥S, Esc, `?`, right-click row menus, a reachable focus order, Esc-closing dialogs. No formal standard such as WCAG 2.1 AA committed.
