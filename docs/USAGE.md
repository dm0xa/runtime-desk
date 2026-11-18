# User guide

Screen-by-screen guide. Install and build steps: [README](../README.md). Internals: [ARCHITECTURE.md](ARCHITECTURE.md).

## Before you start

Runtime Desk reads the CLIs on your machine — `colima`, `docker`, `podman`, `nerdctl`, `kubectl`, `limactl`, `docker compose`, `ramalama`, `krunkit` — and installs nothing.

Probed on start and after **Refresh** (⌘R). A missing tool hides the sections needing it; a page losing its tool shows a panel naming it, its install command, **Recheck**, **Open settings**.

The profile is the second gate: Containers, Images, Volumes, Networks, Activity, Sherlock, Cleanup and the log viewer read its socket, so a stopped profile shows **The `<profile>` profile is not running** with **Start profile** and **Recheck** and queries nothing; no profile shows **No Colima profile yet** with **New profile…**.

Window 1300 × 820, minimum 900 × 600; menu bar Runtime Desk / File / Edit / View / Window / Help; size, position, maximized state and last screen return on relaunch.

Shortcuts: ⌘N **New Profile…**, ⌘F or ⌘K search, ⌘R refresh, ⌘, Settings, ⌘⌥S sidebar, ⌘[ back, ⌘1–⌘9 first nine sections, ⌘0 last, ⌘W close. **?** in the status bar lists them; Esc closes a dialog or leaves edit mode.

Frontmost refresh: 15 seconds; 60 with a live Docker event stream, since events carry changes and the timer only reconciles.

Status bar: running containers, the profile's container/image/volume counts, runtime and architecture, seconds since the lists were read — or `default stopped · counts not read`. **?** and the Settings gear sit at its right.

## First launch

Two pages:

1. **Welcome**: the app's parts — Dashboard, Docker, Podman, Kubernetes, Machine — under a headline whose runtime name rotates through Colima, Docker, Podman, kubectl and containerd.
2. **Tools**: `N of M tools detected`, grouped **Required** (Colima, Docker CLI) and optional **Runtimes**, **Kubernetes**, **VMs**, **AI**; each row: ready/missing pill, why the app wants it, what it unlocks, when missing the install command with **Copy**. The circular arrow re-probes.

Installs nothing. **Skip setup** closes it, **Continue** and **Open Dashboard** move on, **Run setup again** (Settings → General) reopens it.

Only Colima and the Docker CLI are required for the Docker views (containerd profiles read lists through Colima's nerdctl wrapper). A missing optional tool hides only its detail.

## Profiles

Colima VMs, at the bottom of the sidebar under **Profiles**, colored dot for running or stopped.

### Select a profile

Click a name: it becomes active, container commands point at its daemon, status, configuration and Docker data reload.

Docker-runtime profiles use the Docker CLI with `DOCKER_HOST` set to the profile socket; containerd profiles use `colima --profile <name> nerdctl -- …`, needing no host `docker` binary. incus profiles can be managed, but the container views are built for Docker and containerd.

### Profile actions

`⋯` next to a profile:

| Action | What it does |
|---|---|
| Start | Starts the profile. Disabled while it is running. |
| Stop | Stops the profile. |
| Restart | Restarts the VM. Disabled while it is stopped. |
| Delete profile… | Opens the delete dialog below. |

One dialog serves that menu and Settings › General's **Delete profile…**: it removes the profile **and its data** — VM disk, containers, images, volumes — irreversibly; lists counts when read, unknown when not; refuses while running, **Stop profile** replacing the confirmation; needs the name typed before **Delete profile and data**. `colima delete <profile> --data --force`.

### Create a profile

**+ Create new profile** below the list; fields go to `colima start`: name; CPUs, memory (GiB), disk (GiB); runtime (`docker`, `containerd`, `incus`); architecture (`aarch64`, `x86_64`); VM type (`vz`, `qemu`, `krunkit`); optional mount (`path:mode`, e.g. `~/projects:w`) and hostname; Rosetta (amd64, needs `vz`); **Kubernetes (k3s)**, about 300 MB inside the VM, plus optional `--k3s-arg` (empty keeps `--disable=traefik`).

**Create & Start** runs `colima start` with those flags and selects the profile on success.

## Dashboard

The default section: cards that can be rearranged.

### Cards

**VM Instances**, **Running VMs**, **Stopped VMs**, **Allocated vCPUs**, **Docker Resources**, **Podman Machines**, **Podman Resources**, **Activity**, **Infrastructure**, **System Status**, **Instances**; **Runtime**, **Architecture**, **Docker socket**, **Colima version**, **Storage usage**, **Profiles overview**, **Recent containers** start hidden.

Cards that lead somewhere are buttons: Docker Resources' tiles open Containers/Images/Volumes/Networks/Compose, Infrastructure's Linux VMs tile opens Machine, an Activity row opens that container in Sherlock. An unread engine prints `—` and a sentence, naming a stopped profile with a **Start profile** link or **New profile…**.

### Edit mode

The pencil top-right. While active:

- The **eye** button, or dragging onto the **Hidden cards** row, hides a card as a miniature preview.
- Drag a parked card back for the drop position, or click it to restore its old place; drag a grid card onto another's slot to reorder.
- The corner width button cycles **Auto → Half → Full**.
- **Reset layout** restores default order, visibility and widths; **Done** leaves.

Saved locally: survives restarts, not clearing local storage. At 1000 px and below, two columns.

## Activity

Live container metrics from `docker stats`.

Header: search (global scope only — no list here), a container-box icon opening the container list (hover: **Open Containers**), Refresh.

Two panels, both streamed at about 1 Hz while frontmost from one `docker stats` child (a two-second `--no-stream` poll takes over if the stream is refused or ends). Before the first answer: **Reading the first sample from `docker stats`…** rather than 0%; paused in the background it says so and ages the last reading.

**Live totals** holds the fleet numbers: a 72-second total-CPU chart, then a strip — CPU, memory, network received/sent, block I/O read/written, PIDs — with network and block I/O cumulative since each container started, then memory and network receive **rate** (bytes per second) charts.

**Containers** is the per-container table, headed `N running · sorted by CPU; every sparkline shares one scale.`: a 72-second sparkline, memory against its limit, network I/O, block I/O and PIDs per row on one `0–N%` scale.

Each chart has its own ceiling: total CPU from 100%, rising when a container exceeds one core; memory and network scale to their window peak. At three samples the span stretches across the card with its share stated (`8 s of 72 s recorded`); a full window prints `peak N% · 72 s window`.

Runs only with the Docker CLI installed, the profile running, the page **or** its card on, and the window frontmost; hiding the card and leaving the page stops the call.

The card compacts it: a 72-second total-CPU chart, then a row per running container sorted by CPU with sparkline, percentage and memory on one shared scale; a row opens it in Sherlock. The bottom row sums CPU and memory and counts containers; rows cap at six, reading `top 6 of N running` beyond.

### Memory pressure

Two ceilings can kill a container, and the page says which is close:

- **cgroup limit** — `web is at 94% of its 2.0 GiB limit`; Docker OOM-kills at 100%.
- **no limit** — `docker stats` reports the VM's whole memory, so 98% of it is one spike from OOM-killing the guest. The row prints the ceiling given, so an unlimited container shows `5.9 GiB / 6.0 GiB`.

At 90% of either, bar and number turn red, the summary line names up to three containers and their ceiling (`+N more`), and a notice appears once per container, withdrawn under 90%.

The notice's action opens the memory-limit dialog, updating in place through `docker update`. Three Docker rules: at least 6 MiB, never below what the container already holds, no removal — `docker update --memory 0` is accepted then ignored, so unlimited means recreating without `--memory`.

The guard rides the same two-second samples, so it needs the Activity page or card on; otherwise nothing samples and nothing warns.

## Containers

Every container in the active profile, running or stopped.

### Filters and search

- Header search, left of the page actions and Refresh. Click the magnifier to unfold; the planet inside picks list filter or every-page search. **×** empties the query and keeps the field open; Esc or a second click clears and closes.
- Matches name, image, state, Compose project.
- **All**, **Compose**, **Docker**, **Kubernetes** chips filter by origin with counts. Compose appears only with its tool present; Kubernetes only when kubelet-created containers exist, and Docker excludes them, so the four add up to **All**.
- A **network** chip scopes the list to that network's members, with **×** to remove.

Compose containers carry a project label; everything else is Docker. The **Origin** column appears only when origins mix.

Kubelet-shaped names (`k8s_<container>_<pod>_<namespace>_<uid>_<attempt>`) carry a **k8s** chip and count behind **Colima → Kubernetes**. They are the profile's own k3s pod containers: on the docker runtime (cri-dockerd) the kubelet creates them through the same daemon, so they are ordinary Docker containers — including one `rancher/mirrored-pause` sandbox per pod, holding the pod's network namespace. Starting, stopping or removing them here is exactly what the kubelet sees, so a removed container is recreated by its controller.

### Rows and actions

Click a row: the panel uses Sherlock's grouped facts — **Lifecycle**, **Identity**, **Runtime**, **Limits** — then ports, networks, mounts, and the environment count. **Lifecycle** adds `Last exit` reading `OOM-killed` when the kernel stopped the container at its ceiling; a kubelet container gets an **Origin** row. Icons top-right: Logs, Start/Stop, Restart, Open in Sherlock, Inspect JSON.

A terminal icon in Actions opens Logs. `⋯` has **Start**, **Stop**, **Restart**, **Remove**, **Investigate**, **Logs** — the last disabled when the profile is stopped or its container client is missing.

Removal asks for a second click on the same item, expiring after three seconds; it removes with `rm -f`, so it can remove a running container.

### Compose projects

A header named after the project with `N of M running`. Its play and stop icons start or stop only the containers that need it, naming the project in the result; clicking elsewhere collapses or expands. Containers without a project sit below, under **No project** when a project exists.

### Ports

Chips parse `docker ps`. A loopback-only mapping carries a `lo` marker and replaces the bare host port with the fact that matters: `0.0.0.0:8080->80/tcp` and `127.0.0.1:8080->80/tcp` are not the same exposure, and the title names URL and binding ("loopback only (127.0.0.1)", "all interfaces (0.0.0.0)").

- Published TCP mappings are buttons opening in your browser on the published host and port.
- Mappings on `0.0.0.0`, `::`, `[::]` become `localhost`.
- Exposed-only ports, UDP mappings and port ranges are shown but not clickable.

### Logs

The last 100, 500, 1 000, or 5 000 lines.

- **Search** highlights matches and counts them; `Enter` next, `Shift+Enter` previous.
- **Match only** hides lines without the query; **Wrap** toggles soft wrapping.
- **Reload** (circular arrow) fetches again; **Copy** (two pages) copies the visible lines with timestamps, becoming a check mark for a moment.

**Reload**, **Copy** and **Close** are header icons; the line-count picker sits left, and the header counts visible lines and matches. The window mounts 500 lines at a time — **Show 500 more** below the last one — while search, match counts and `Enter` still walk the whole selected tail, growing the page when a match sits past it.

Timestamps from Docker's RFC3339 prefix, ANSI escapes removed. `FATAL`, `ERROR`, `ERR`, `PANIC`, `EXCEPTION` colour a line as an error, `WARN`/`WARNING` warning, `INFO`/`NOTICE` info — best-effort, since the app does not know your log format.

`docker logs` returns stdout and stderr only; files inside the container are invisible to it.

## Images, Volumes and Networks

Each list has its own toolbar, and its filter is the one that matters for cleanup: **All / Unused** for images (no container references it) and volumes (no container mounts it), **All / User-defined** for networks (built-in ones cannot be removed). The page header keeps the **Prune unused data** broom and the network view switch.

An empty table body says which of four things happened: **List unavailable** (a read failed), **Reading…** (no answer yet), **No matches.** (the header filter or a chip matched nothing), or **No `<kind>`** — the only wording that is a claim about the engine.

## Images

ID, repository, tag, size, creation time, **Used by**.

- **Used by** counts every container referencing it, running or stopped; clicking opens it in Sherlock.
- **Investigate** opens Sherlock: tags, size, creation time, platform, layer count, entrypoint, command, working directory, user, environment variables and labels, exposed ports, declared volumes, digests, build history, and the containers using it.
- The bin in **Actions** is disabled while any container uses the image or the container list failed to answer; removing an unused image asks for a second click.
- A row expands to copy and inspect JSON glyphs.

Dangling images (`<none>:<none>`) are listed and removable when nothing uses them.

### Pulling an image

**Pull image…** opens a dialog running `docker pull <reference>` against the selected profile, then reloads the list. The reference is checked for shell-hostile characters, and a leading `-` is refused so it cannot become a flag. Nothing pulls until **Pull**.

## Volumes

Name, size, driver, mountpoint, **Used by**, actions. A treemap above the table draws each volume by size, a click opening it in Sherlock. Sizes come from one `docker system df -v` scan, cached for a minute and loaded only while the section is open; volumes with no data are left out. **Size** shows that measurement (numeric sort, `—` before the scan).

- **Used by** comes from each container's mount list; clicking opens the volume in Sherlock.
- The bin in **Actions** is disabled while a container mounts it or the container list failed to answer.
- **Investigate** shows driver, scope, size, creation time, mountpoint, options, labels, and the containers mounting it with each path.

Files can be browsed on the Sherlock page under **Contents**: read-only, one directory at a time, through `colima ssh`, from the client's mountpoint. A level reads and shows its first 200 entries with **Show 200 more** beneath — a directory holding thousands of files no longer stalls the page or crosses the IPC boundary whole — and directories are read again only when you reload them.

## Networks

Two views, **Table** and **Map**, from one segmented control in the header with the active view highlighted.

### Table

Grouped into **Built-in** (`bridge`, `host`, `none`) and **User-defined**.

Rows show attached container count, driver, subnet. Expand for network ID, scope, subnet, gateway, internal flag, and attached containers with IPv4 and MAC, plus copy and inspect JSON.

Built-in networks cannot be removed: the bin is disabled and says why on hover. Removing a user-defined network asks for a second click; if containers are attached, Docker refuses and its message appears in a notice.

### Map

- Only networks with attachments are drawn; a **Show N unused networks** chip adds the rest.
- A container opens in Containers; an attached network scopes the Containers list to its members, while unused networks are not clickable.

## Sherlock

A full page for one entity: container, image, volume, network, or a Compose project (a group). Open from:

- the **Investigate** icon in Actions of Images, Volumes and Networks, the Cleanup lists, or `⋯ → Investigate` in Containers and the Podman lists;
- the **Used by** count on an image or volume;
- ⌘K search or tag results;
- a container's **Compose** project link;
- the sidebar **Sherlock** item — a picker of every Compose group, container, image, volume and network (filterable by kind; `↵` opens the first match) until you choose one.

The topbar's back button names its destination — the entity you hopped from, or the list you opened Sherlock from — and disappears when there is nowhere to return. The bar under it holds kind and name; its right end: Memory limit (Docker-runtime containers only), Logs, Open in Containers, Inspect JSON (absent for groups, which have no inspect payload).

Two columns:

- **Facts** left: **Identity**, **Lifecycle**, **Health**, **Limits** for a container; **Image** for an image; **Storage** for a volume; **Identity** for a network; **Project** for a group (containers, running, images, oldest member). **Runtime**, then **Related**, right; images get **Runtime** + Related, volumes **Timeline** + Related, networks **Addressing** + Related. IDs, references, mountpoints, hostnames and commands carry a copy button.
- **Related** is links only — tags, networks, ports, mounts, Compose and peers for a container; used-by, ports, volumes and digests for an image; attached containers for a network; published ports per member for a group.

Full-width panels complete it. A **running container's Performance sits above the two columns** — live state is time-sensitive; a stopped container has none, since Lifecycle states it. A group's **Performance** sits there too, always. The rest sit below:

- **Performance** (container): CPU, memory and network-rate history, then block I/O and process count. A Docker container gets one streaming `docker stats <id>` child at a sample per second, stopping with the container or the page; if it dies, the five-second `docker stats --no-stream` poll takes over. Podman has no streaming endpoint, so it runs `podman stats --no-stream` on that poll. Charts draw at ten samples (`collecting · chart in 5 s`), then name the window recorded (`45 s window`, up to `2 min window`). At 90% its memory value turns red with `near the limit, OOM-killed at 100%`. **Lifecycle** gains `Last exit` reading `OOM-killed`.
- **Performance** (group): three charts — CPU across the full panel, memory and receive rate below — each stacked by container, so the top edge is the group total and every band is one member. One colour means the same container in all three; network draws the transmit total as a dashed line. Up to eight containers get a band and the rest are summed into **Other**; the row list below still shows every member's status, CPU, memory and receive rate, and its swatch is the chart legend.
- **Recent output** (containers): the last 60 log lines, fetched on open with Reload. **Logs** in the page bar hands off to the viewer with search.
- **Environment**: every variable, secret-looking names (`TOKEN`, `SECRET`, `PASSWORD`, `_KEY`, …) masked until **Show *N* secrets**, then **Hide secrets**. Long sets show 12 in two aligned columns with **Show all N**; omitted when empty.
- **Labels**: a container's labels are split into **Set at runtime** and **From image**, judged by comparing each value against the image's own label set; when that image is gone the list stays flat and says **image labels unavailable**. Images, volumes and networks have one origin and one flat list. Compose project, service and config files stay split out under Related. First 10 rows across both groups, one **Show all N** for the panel.
- **Build history** (images): layers with creation age, size and command, newest first, from the local cache. Ten rows with **Show all N** / **Show less**; without history from the client, the panel says so.

Clicking a relation pushes a page onto a back stack. The header's back arrow — tooltip naming its destination, such as `Back to Containers` — pops one level; backing out of the first page returns to the previous section. **Open in Containers** switches to the container list, filtered when the entity has a name; **Inspect JSON** opens raw `docker inspect` (or `podman inspect`) in its own window.

Podman objects use the same page, reading Podman's inspect payloads and commands, with Memory limit absent.

### Tags

Free-form local labels: type and press `Enter` to add, `×` to remove. Lowercased, sorted, shown inline in the Containers list, Podman lists (including machine rows) and Sherlock pages.

Stored in the app's local storage keyed by entity kind and ID — containers, images, volumes, networks, Compose groups, Podman machines. Docker cannot attach labels to existing objects, so tags are not Docker metadata and are not shared with other tools; clearing local data removes them.

## Search

⌘K or ⌘F, or the magnifier in any header. The globe picks the scope:

- **Off** — default on Containers, Images, Volumes, Networks and the Podman lists — filters the list in front of you.
- **On** searches every page: visible sidebar sections, profiles, containers, images, volumes, networks, Podman machines, containers, images, volumes and networks, and tags. Results appear under the field; the index is the same everywhere. Pages with nothing to filter, the Dashboard and Activity included, always search this way.

Ranked: prefix matches, then word starts, then substrings; ties to the shorter label, at most 12 shown. Arrow keys move, `Enter` opens. A section switches tabs, a profile selects it, an entity opens in Sherlock, a Podman machine opens its machine list.

Search skips logs, environment variables and file systems.

## Machine

The selected Colima VM. Header icons: **Stop profile** and **Restart profile** while running, **Start `<profile>`** while stopped.

- **Diagnostics**: live health over `colima ssh` — CPU load against the vCPU count, memory, root disk, Docker daemon state, recent OOM kills — over a summary line naming any pressure signal (or none). Prints kernel, uptime, inode and swap figures and offers **Copy report**. Verdict pill: Healthy / Attention / Reading… / Unavailable / Stopped. Memory amber at 80%, red at 90%; root disk amber at 75%, red at 85%; load above 1.5× the vCPU count, any OOM kill and inodes at 90% count as pressure.
- **VM section**: running state with **Resources…** in its header, then architecture, VM type, CPUs, memory, disk, mount type, Rosetta. Colima has no resize verb, so **Resources…** opens **Start `<profile>` with…**: `colima start` with the new values, **Start with these resources** disabled while running.
- **Container runtime**: runtime, active client (`docker CLI` or `colima nerdctl`), driver, Docker socket, containerd socket.
- **nerdctl**: whether the host `nerdctl` client is installed; when missing, **Install nerdctl** runs `colima nerdctl install` for the profile.
- **Linux VMs on this host**: other Lima VMs from `limactl list`; without `limactl` the page says so instead of raising an error.

Changing a profile's runtime is not done here; Colima requires recreating the profile.

## Kubernetes

Reads the single-node k3s inside the VM through the host `kubectl`, targeting the profile's own context — `colima` for the default profile, `colima-<profile>` for a named one — so your terminal's context makes no difference (every call passes `--context`, 10-second timeout).

- **Cluster strip**: Nodes ready/total, Pods running/total, Deployments available/total, server version, namespace count. A partial numerator turns amber; Nodes' `ready` label is green when all are ready. An unreachable API server prints its error with **Recheck**.
- **Kinds**: Pods, Deployments, StatefulSets, DaemonSets, Services, Nodes as chips, with a namespace filter (**All namespaces** reads the whole cluster). Columns follow the kind — Pods add Restarts and the Node; workloads their images; Services Cluster IP, Type, Ports; Nodes Ready, Roles, kubelet version.
- **Status is the useful word**: a waiting pod container shows `CrashLoopBackOff` or `ImagePullBackOff` rather than "Running", which is what a crash-looping pod reports. Anything other than Running/Completed/Succeeded/Available/Ready is red; a Node's Ready value is green when `Ready`.
- **Enable Kubernetes**: a profile started without it shows what the cluster is, the exact command, and a button running `colima kubernetes start -p <profile>`. It installs k3s in the running VM and points your kubeconfig at it; containers keep running. Colima needs `kubectl` for that step.
- **Cluster actions** behind the strip header's `⋯`, once a cluster answers: **Stop Kubernetes** stops k3s, leaving containers alone (a second click confirms), **Reset cluster** reinstalls in place (workloads lost, kubeconfig entry stays), **Delete cluster** removes both, needing the context name typed.
- **Logs** per pod: the terminal glyph ending a pod row opens the containers' log window for every container in that pod (`--all-containers`), with timestamps, search, level highlighting and tail size (200 lines by default). A stopped pod answers from the previous container.
- Reads on entry, then every 15 seconds for the selected list (30 for the cluster strip); header **Refresh** re-reads both. Read-only: it applies no manifests.

The page exists only when `kubectl` and Colima are installed; the sidebar item sits under **Colima** next to **Machine**, and Settings → General lists the install command.

When the API server stops answering the strip keeps the last answer and labels it (**These counters are the last answer, read at 14:03 — the cluster is not answering now.**), with the error and **Recheck** beneath.

The **k8s** chip in Containers comes from this runtime: on a **docker** profile the kubelet creates pods through the profile's Docker daemon, so they appear as `k8s_…` rows and the sidebar row counts them. On a containerd profile they live in `k8s.io` and never reach the Docker lists.

## Podman

Machines and the objects of one of them, through the `podman` CLI, independent of the Colima profile: machines run and stop on their own, and the group appears only when `podman` is installed.

Scoped to a machine, not "the default". Every list toolbar carries a **Machine** picker naming the VM it reads (one machine renders as a sentence, `Machine podman-machine-default`). Choosing another re-reads containers, images, volumes and networks from it; Rust exports `CONTAINER_CONNECTION` so later calls follow.

With no machine running the four object pages show **No Podman machine is running** (or **No Podman machine yet**) with **Open Machines** and **Recheck**, and query nothing; a list failing while a machine looks available raises a notice with **Open Machines** and **Retry**.

- **Machines**: name (`(default)` on the default one), status, CPUs, memory, disk, VM type; start, stop, restart, remove in Actions (remove asks a second click). A row expands to full figures including the API port, with **Resize…**, copy-name and tags. **Resize…** runs `podman machine set` — CPUs and memory only, since Podman grows the disk only on recreation — applying after a restart. **New machine…** runs `podman machine init`, warning that the first downloads a VM image.
- **Containers**: Docker's row shape and two actions — state badge with dot, terminal icon for logs, and a `⋯` menu with Start, Stop, Restart, Investigate, Details, Logs, Tags… and Remove. The Ports column opens published TCP ports in the browser; a row publishing more than three draws three chips and a `+N` badge whose title lists them all. A row expands to Docker's detail panel: CPU/memory/PIDs strip while running, Lifecycle, Identity, Runtime, Limits, then Ports, Networks, Mounts and the environment count. The corner holds Logs, Stop/Start, Restart, Inspect JSON.
- **Images**: ID, Repository, Tag, Size, Created, container count, removal blocked while one uses it (or while the container list failed). **Pull image…** runs `podman pull` in the named machine. Actions: the fingerprint opening Sherlock, and remove; a row expands to the same facts with copy, tags and Inspect JSON glyphs.
- **Volumes**: the treemap from `podman system df -v` above the table; hovering a cell highlights its row and vice versa. Sizes, driver, mountpoint and use count sort; a row expands to the full mountpoint with copy, tags and inspect glyphs. A `?` in **Used by** means `system df -v` could not describe that volume, and removal stays disabled rather than treating an unread count as zero.
- **Networks**: table or map from the page header. The table groups the built-in `podman` network above user-defined ones, counts attached containers and lists them (name, IPv4, MAC); a container opens Podman Containers filtered to it, a network node in the map switches to the table filtered to it. Actions: the fingerprint and remove, refused for the built-in network.

Every Podman list sorts on its data columns with Docker's header arrows and says `Loading…`, `No matches.`, `List unavailable` or `No <kind>`, claiming no more about the daemon than it knows.

## AI Models

Models through Colima's `model` commands.

Pills in the **Run a model** header: Apple Silicon; a `krunkit` VM; the Docker runtime; a compatible runner.

A profile not using `krunkit` gets an amber note offering **Create AI profile**, which starts a profile named `ai` with 4 CPUs, 8 GiB of memory, 50 GiB of disk, the Docker runtime and `krunkit` — or **Open AI profile** / **Start AI profile**. With `krunkit` missing it prints the install command, and **Create AI profile** stays disabled until Refresh re-probes:

```sh
brew tap slp/krunkit && brew install krunkit
```

Controls:

- **Registry**: Docker AI Registry, HuggingFace, or Ollama (ramalama).
- **Runner**: `docker` or `ramalama`.
- **Model**: free text, suggestions such as `gemma3`, `llama3.2`, `qwen2.5`, `phi4`, `mistral`, `ai/smollm2`.
- **Serve port**.
- **Prompt**: the one-off prompt for **Run prompt**; empty for an interactive chat.

The resolved reference appears under Model when the registry rewrites the name: `hf.co/...` for HuggingFace with Docker, `hf://...` with ramalama, `ollama://...` for Ollama. Ollama needs the ramalama runner; docker with Ollama adds an amber note under Runner.

Buttons:

- **Pull model** downloads the model.
- **Run prompt** runs a one-off prompt and prints the answer in **Output**.
- **Chat in terminal** opens an interactive session in Terminal.app, since the GUI cannot host a TTY.
- **Set up runner** prepares the runner inside the profile.
- **List models** shows what is available in **Output**, which has a **Clear** button.
- Run prompt, Chat in terminal and the server require the `krunkit` VM; pull and list do not.

**Model server** panel: **Serve on :<port>**, then the pid while `colima model serve` runs, with **Open localhost:<port>** and **Stop server** (`SIGTERM`).

The PID is written next to Colima's own state, so **Stop server** works after quitting; a crashed PID is dropped rather than offered as running.

## Settings

Four tabs across the top of the page: General, Sidebar, Configuration, About. The tab bar is a segmented control at the page's top edge; the window title stays simply **Settings**.

### General

- Colima version, active profile and its state, runtime and architecture.
- The version row carries the CLI update: opening Settings compares against the newest GitHub release, and Refresh checks again. A newer one reads `<latest> available` plus an icon — brew upgrade on Homebrew installs, an external link on manual ones; `up to date` once current, `not checked` when unreachable.
- **Update runtime** runs `colima update -p <selected profile>`, refreshing the container runtime inside the VM, not the CLI. Disabled unless that profile is running.
- **Prune cached downloads…** explains itself then runs `colima prune` for the selected profile: cached Colima and Lima downloads go; containers, images and volumes are untouched.
- **Prune Docker data…** opens the Docker prune dialog, listing every target and the reclaimable space before anything runs; the same dialog is on Cleanup. With a cluster running, stopped kubelet containers are pruned too and controllers recreate any still wanted.
- **Run setup again** reopens the first-run wizard.

**Tools on this machine**: every probed CLI grouped as Core, Container runtimes, Kubernetes, Virtual machines and AI workloads, with status (`installed` / `missing` / `checking…`), why the app wants it, and its install command with a copy button.

**Delete `<profile>`** closes the tab: a warning row with **Delete profile…**, which opens the same dialog as the profile menu — it removes the profile and its data (VM disk, containers, images, volumes), lists counts when read, refuses while running (with **Stop profile** in place), and needs the name typed before the red confirm enables.

### Sidebar

Hideable groups: Docker, Colima, Podman, Tools. Overview and Settings are always reachable — Settings sits below the scrolling nav, above the profile switcher.

Two group headers name their source, answering from different virtual machines: **Docker** carries the selected profile's name (or `no profile`), **Podman** the running or first machine's name (or `no machine`). **Colima** holds **Machine** and **Kubernetes**, since k3s runs inside that VM.

Each row names its group's tools: green dot installed, dimmed grey missing. All missing reads **Unavailable**, dims, and cannot be enabled (Kubernetes needs `kubectl`). The visibility control reads **Visible**, **Hidden** or **Unavailable**; **Also detected** lists tools not tied to a hideable group.

### Configuration

- **Show template** reads `_templates/default.yaml` inside the Colima config home: `$COLIMA_HOME` when that directory exists, otherwise `~/.colima` when it exists, otherwise `$XDG_CONFIG_HOME/colima` when the variable is set, otherwise `~/.colima`.
- **Show SSH config** runs `colima ssh-config` for the selected profile.

Read-only views whose button flips to Hide once open.

### About

Identifies the app rather than reporting state, the way a Mac About panel does: a centered column with the logo, the name, and the version in mono beside the license (`v1.1.3 · GPL-3.0-only`). A short paragraph says what the app is and which CLIs it reads, then `Built with Tauri 2 and React 19 by dm0xa.` Below, one line of text links opening outside the app — Repository, Report an issue, Colima, License (the full GPL-3.0 text) — and a quiet Buy me a coffee link. A hairline closes with `Copyright © 2026 Runtime Desk contributors. GPL-3.0-only, without warranty.` While GitHub has a newer release, an inline row under the credits names it with **Open releases**; the launch banner for that same release hides while this panel is open, so the fact is stated once. The version comes from `package.json`.

## Cleanup

Tools → **Cleanup** answers three questions: what Docker holds, what nothing uses, what the VM costs on the Mac.

Five numbers up top:

- **VM disk on this Mac** — allocated size of the profile's sparse disk image, against its configured disk size; not compacted automatically. Opens Machine.
- **Guest root** — used space inside the VM, amber from 75%, red from 85%. Opens Machine.
- **Docker on the VM disk** — `du` of `/var/lib/docker`: what layers cost on disk, not Docker's logical sum.
- **Docker logical size** — `docker system df` totals; opens Images.
- **Nothing needs it** — unique bytes behind the removal lists below; jumps to Unused objects.

Card and legend jumps are drill-downs; the topbar back chevron (⌘[) returns.

The bar under them splits images, containers, volumes and build cache. Logical sizes count shared layers once per image, so they can exceed the allocated number; the sparse disk image gives space back to Docker but not always to macOS.

- **Unused objects** lists dangling images, stopped containers, unused volumes and build cache entries, largest first, each with its reason. **Age** is days since creation; hover for the timestamp. Docker keeps no last-use record for images or volumes, so build cache rows alone show a last use. Actions are icons: the fingerprint for Investigate, the trash can for **Remove** (a second click arms it), and a broom on build cache rows, opening the prune dialog. The header carries **Prune…**.
- **Unused images** lists tagged images no container references; older than 30 days gets a **stale** badge. Removing one deletes every tag pointing at it, and **Unique** is what the removal actually frees. Same Investigate and Remove glyphs.
- **Largest container logs** shows the biggest `*-json.log` files in the guest — outside Docker's totals, growing without limit unless the container sets `--log-opt max-size`.

While the first scan runs the page shows a skeleton; Refresh re-reads and keeps the current report. It stays in memory, so leaving and returning shows it at once; it is reused for 60 seconds, then refreshed in the background.

The report is read through the profile's container client — nerdctl on containerd profiles, the Docker CLI on Docker, as fallback — when you open the page, after a removal, or on Refresh.

## Prune

From the broom icon in the Containers, Images and Volumes headers, **Prune…** in Cleanup's Unused objects panel, and Settings → General → **Prune Docker data…**.

Six categories, each listing what it would remove:

| Category | Default | Notes |
|---|---|---|
| Stopped containers | On | Running containers are never touched. |
| Unused networks | On | Docker skips built-in networks. |
| Build cache | On | Unused builder cache layers. |
| Dangling images | On | Untagged images. |
| All unused images | Off | Every image not referenced by a container, including ones you may want. |
| Unused volumes | Off | Data is not recoverable. |

**Prune selected** runs the corresponding prune commands through the active container client; removing one container lives on its row.

Colima's own asset prune is separate: Settings → General → **Prune cached downloads…**.

## Troubleshooting

### A screen says the profile is not running

It reads the selected profile's socket, so nothing was queried and the table is not evidence of an empty engine. **Start profile** starts it; **Recheck** re-reads; **New profile…** appears when none exists. Dashboard Docker cards show `—` with a **Start profile** link, and the status bar reads `default stopped · counts not read`.

### A Podman tab says no machine is running

Podman answers from its own virtual machine, so Containers, Images, Volumes and Networks close while no machine runs. **Open Machines** goes to the list; **Recheck** re-reads; a failing list raises a notice with **Open Machines** and **Retry**.

### Pulling an image (Podman)

**Pull image…** runs `podman pull` in the machine the page names and reloads the list; the reference is checked for shell-hostile characters and a leading `-` first.

### Resizing a Podman machine

Press **Resize…** on a machine row: `podman machine set` with the CPUs and memory you enter, applying after a restart. Disk is not offered — podman only grows it when the machine is recreated.

### Two Podman machines

The machine picker names the VM every list reads; switching re-reads containers, images, volumes and networks from it. A stopped or removed machine cannot stay selected — the selection is re-validated on every read.

### The sidebar says "No container tooling found"

Nothing on your `PATH` answered for any group: no `colima`, `docker`, `podman` or `kubectl`, so every section needing one is hidden. **What it needs** opens Settings → General, naming each tool and its install command.

### A section is missing

Its CLI was not detected. Settings → Sidebar names the missing tool and its install command; install it, then press **Refresh** (⌘R).

`kubectl` without Colima stays hidden too: the Kubernetes screen reads the cluster Colima provisions, so Settings lists Colima as missing. Clusters from other tools (Docker Desktop, kind, minikube, remote contexts) are not read.

Kubernetes needs `kubectl` on the PATH (`brew install kubectl`), because Colima shells out to it while provisioning a cluster.

### The Kubernetes page says the cluster is not enabled

The profile was started without `--kubernetes`. **Enable Kubernetes** runs `colima kubernetes start -p <profile>`, or recreate the profile with Kubernetes for a fresh VM. Enabling takes about a minute and does not restart containers. On a new VM, tick **Kubernetes (k3s)** in **New profile…**, which passes `--kubernetes` (and an optional `--k3s-arg`) to `colima start`.

A connection error instead means the VM is stopping or stopped: start the profile and press **Refresh**.

**kubectl could not read your kubeconfig** means the cluster may be fine and the kubeconfig broken — fix it and press **Recheck**; enabling Kubernetes would not help.

### Docker views are empty

Check the selected profile is running: a stopped profile shows the prerequisite panel rather than a connection error. Start it from the panel or the profile menu.

Running and still failing, the notice usually names the cause:

- **Docker daemon is not reachable**: the profile's socket is not responding. Restart the profile.
- **Permission denied**: access to the Docker socket is restricted.
- **Port already in use**: another process owns the host port.
- **Already gone**: the object was removed between the list refresh and the action.

### Compose counts are missing on a containerd profile

Compose is Docker-only: the app uses `docker compose`, and nerdctl has no Compose integration.

### The log viewer is empty

The container may write to a file instead of stdout/stderr, or produced nothing yet; `docker logs` cannot see files inside it.

### A tool installed with Homebrew is not detected

Apps launched from Finder do not necessarily inherit your shell's `PATH`. The backend looks for `colima` in the usual Homebrew location as a fallback; other tools resolve through the process `PATH`. Launch from a terminal where they resolve.

### The app will not open

Local builds are unsigned; macOS may ask for confirmation the first time. More in [DEVELOPMENT.md](DEVELOPMENT.md#release-builds).
