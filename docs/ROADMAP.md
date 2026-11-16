# Roadmap

What is done, what comes next, and what I do not plan to build. Effort: S under an hour, M about half a day, L multi-day.

## Done

Profiles live in the sidebar; switching one points the Docker views at the right daemon — Docker CLI for Docker runtime, `nerdctl` for containerd. First launch probes the tools, names any missing install command, and hides the sections that need it; Settings → General repeats it. A stopped profile, a stopped Podman machine, or a missing tool gets a prerequisite panel with the reason and the fix, never an empty table.

Docker sections cover containers, images, volumes and networks. Containers have row actions, details, and a log viewer with search and highlighting; Compose containers group under their project with a running count and project-wide start/stop. Lists filter by origin (All, Compose, Docker, Kubernetes — a partition); images and volumes by All/Unused, networks by All/User-defined. Images and volumes show their users and refuse removal while in use or while the proving list failed. Networks have a table and a map; published TCP ports open in the browser.

The dashboard refreshes from `docker events`: a container start or image removal lands within a quarter second (one refresh per burst, 250 ms debounce), the timer stepping back to sixty-second reconciliation. Cards are files under `src/components/dashboard/cards/` (see [DASHBOARD.md](DASHBOARD.md)); they move, resize, hide, and reset. Activity samples `docker stats` every two seconds over 72 seconds.

Sherlock opens one object at a time and links around it, for Docker and Podman. A container page adds live CPU, memory, I/O and PID samples, the last 60 log lines, environment variables with secrets masked, labels, health check and probes, sibling containers; an image page adds build history; a volume page browses contents read-only through `colima ssh`. Local tags show beside the name in Containers and feed ⌘K, which also searches sections, profiles, and objects.

Machine shows the VM, runtime, sockets, nerdctl status, Lima VMs, and guest telemetry from one `colima ssh` round trip, polled every fifteen seconds only while open on a running profile; Resources… starts a stopped profile with the CPUs, memory, and disk given, Colima having no resize verb. Podman gets five pages scoped to one machine: a picker names it and `CONTAINER_CONNECTION` follows every call; the choice is re-validated per read. Machines can be created, started, stopped, restarted, resized (CPUs and memory; podman grows disk only on recreation), removed; rows open in Sherlock.

AI Models pulls, runs, chats, and serves models via Docker or ramalama, and names a missing VM type or krunkit CLI. Settings covers the template, SSH config, sidebar visibility, setup rerun, Colima version and update check, `colima update`, `colima prune`, the Docker prune dialog, profile deletion. Settings → About is a Mac-style panel: version, license, credits, links — including the full license text.

Runtime Desk is GPL-3.0-only. Earlier releases shipped under MIT and stay available under those terms.

Cleanup reads `system df -v` for per-image use counts, image ages, volume links, stopped container layers and build cache, then a `colima ssh` scan of `/var/lib/docker`, the largest container logs, and the sparse disk image size. Dangling and unused images, stopped containers and unused volumes list largest first with the reason and a two-click Remove; images older than thirty days are marked stale. Rows carry their age and exact timestamps on hover; volume timestamps come from one batched `volume inspect`, since `system df -v` has none.

Kubernetes reads the VM's k3s cluster through `kubectl --context colima` (or `colima-<profile>`): nodes, pods, deployments, statefulsets, daemonsets and services with a namespace filter; pod status shows the waiting reason, not the phase. Cluster facts every thirty seconds, the list every fifteen, nothing while the profile is stopped. Every read has a timeout, and the last successful answer per context is kept, so a silent API server shows counts under their timestamp, not zeros. Enable and Stop cluster are page actions; reset and delete want the context name.

At 90% of a container's cgroup limit — or of VM memory when none is set — OOM kills are flagged before they happen: the Activity row turns red, a line names the containers and the ceiling, and a notice offers the memory-limit dialog, which updates the ceiling through `docker update`, moving swap with it, and refuses what Docker would ignore: under 6 MiB, a shrink below usage, zero (a limit cannot be removed from a live container). `State.OOMKilled` marks the kernel's last exit in the Sherlock bar and the row.

## Next

| Feature | Effort | Data source | Notes |
|---|---|---|---|
| Container start history | M | `docker events --since`, recorded by the app | Docker keeps no past events, so the app records them as it runs. |
| Cleanup for Podman | M | `podman system df -v` and the Podman lists | Cleanup reads a Colima profile's Docker engine and disk image; Podman machines have their own. |

## Later

- **Live stats in the Containers table.** The expanded row and Sherlock hold them; it duplicates Activity, and the poll is a `docker stats` call every two seconds.
- **Container exec and terminal.** The biggest missing feature: a PTY, xterm, a new window or pane. Until then, `colima ssh -- <command>`.
- **A notice that opens the container's page.** Error notices offer **Open Containers** (filtered to its name) and **Stop container**, not Sherlock or the log viewer.
- **Profile and Compose-project pages in Sherlock.** Machine covers a profile; a Compose page would gather services, volumes, and networks.
- **A relation graph.** Draw Sherlock's related objects with the network map's renderer.
- **Tag filters.** Filter each table by tag; the store and search already have the data.
- **Signing and packaging.** Notarize the macOS build and see what Linux and Windows need.
- **Profile import/export and custom shortcuts.** The menu bar's accelerators are fixed.

## Not planned

| Feature | Why not |
|---|---|
| `.orb.local`-style domains | Needs a resolver and reverse proxy outside the app. |
| Vulnerability scanning | Docker Scout is an external service; no local data. |
| Volume browsing through a helper container | `colima ssh` with `sudo` does the same job without pulling an image. |

## What Colima can and cannot do

Checked with Colima 0.10.x and Docker runtime unless noted.

| Command | What it gives us | Where it is used |
|---|---|---|
| `colima list --json`, `status --json` | Profiles, runtime, sockets | Sidebar, Machine, client routing |
| `colima start`, `stop`, `restart`, `delete` | Profile lifecycle, `--data` teardown, CPUs/memory/disk/`--arch`/`--vm-type` and `--kubernetes`/`--k3s-arg` at start | Sidebar actions, Settings → Delete profile, Resources…, New profile… |
| `colima ssh -- <cmd>` | Any command inside the VM, with `sudo` | Diagnostics, the volume browser, Cleanup |
| `colima nerdctl -- <args>` | containerd client | Every container view on containerd |
| `colima nerdctl install` | Host `nerdctl` alias | Machine |
| `colima model list`, `pull`, `setup`, `run`, `serve` | Model runners | AI Models |
| `colima prune` | Cached asset cleanup | Settings → General |
| `system df -v` through the active client, `du /var/lib/docker` | What the engine holds and what nothing uses | Cleanup |
| `docker update --memory --memory-swap` through the active client | A live cgroup memory ceiling; zero is ignored, so a limit cannot be removed without recreating | Memory pressure notices, Sherlock |
| `colima template`, `ssh-config` | Template text, SSH config | Settings → Configuration |
| `colima update` | Runtime update | Settings → General |

Podman is read through its own commands, not Colima: `podman machine list`, `init`, `set`, `rm`, `ps -a`, `images`, `pull`, `rmi`, `volume ls/rm/inspect`, `network ls/rm/inspect`, `system df`, `inspect` — each against the machine named by `CONTAINER_CONNECTION`.

Colima does not know which containers use an image or volume, how big each is, what is in an image's layers, which Compose projects exist, or what a container is doing. Those come from the container client (`docker`, `colima nerdctl`, `podman`) and `ps -a` fields — the source of the used-by columns.
