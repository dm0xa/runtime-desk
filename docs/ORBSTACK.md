# OrbStack vs Colima: reading the benchmarks

OrbStack publishes five benchmarks and a feature matrix that marks Colima down. This page checks what
those numbers actually measure, adds the numbers OrbStack does not publish — this Mac's Colima, measured
— and lists what each side really has. Written 2026-11-18 against Runtime Desk 1.4.0 (`bfb3f7d`),
Colima 0.10.3 / Lima 2.3.0 on an M1 Pro, and OrbStack's current release (v2.2.5, 2026-10-23).

Short version: the published benchmarks are real work, run by the vendor in August 2023 on one M1 Max
against Docker Desktop only. Colima is never measured by OrbStack. The independent harnesses that do
measure Colima put it at or near parity today, ahead on container startup and port latency, behind on
bind-mount throughput.

## 1. The five published benchmarks

All five share one test rig, stated once on [OrbStack's benchmarks page](https://docs.orbstack.dev/benchmarks):

> Testing conducted in late August 2023 with the latest versions of OrbStack (v0.17.0) and Docker
> Desktop (v4.22.0) at the time. Unless otherwise noted, all settings were left at their respective
> defaults, and all tests were run on an M1 Max MacBook Pro.

| Benchmark | OrbStack | Docker Desktop | Ratio | What it times |
|---|---|---|---|---|
| Open edX devstack provisioning | 17 min | 45 min | 2.6× | `make pull` excluded, then `time make dev.provision` |
| PostHog image build, arm64 + amd64 in serial | 7 min | 19 min | 2.7× | `docker build` of `production.Dockerfile` at `42f4d6bb` |
| Kubernetes + Traefik + Grafana, idle power | 27 mW | 123 mW | 4.6× | 10-minute average, per-process-group energy from the kernel |
| Supabase Compose stack, idle power | 82 mW | 137 mW | 1.7× | same sampling method |
| Sentry Compose stack (38 services), idle power | 180 mW | 726 mW | 4.0× | same sampling method |

The homepage adds two efficiency claims with no test rig: "less than 0.1% background CPU usage on Apple
Silicon" and "less than 10 MB of disk space … out of the box". The efficiency page repeats the CPU figure
as "around 0.1% when idle, often dropping to 0%". Neither carries a date, a macOS version, a sampling
window or a definition of which process counts.

The power figure is derived, not measured directly: sample the process group's estimated energy in nJ
from the macOS kernel before and after a settled 10-minute window and divide by elapsed time. OrbStack
says so itself, including the caveat that this excludes the kernel and is an underestimate of
system-wide power. The per-process `ri_energy_nj` counter behind Activity Monitor's Energy Impact is the
same family of value.

## 2. What the methodology does not control

None of this invalidates the results; it bounds them.

- **One machine, one run, no error bars.** Every chart is a single bar per product. No n, no min/max, no
  deviation is published. RAM, macOS version, storage type, power source and thermal state are unstated.
- **Defaults only.** "All settings were left at their respective defaults" means the PostHog amd64 leg
  is most likely Rosetta (OrbStack's default path) against Docker Desktop's built-in emulation: Docker
  Desktop's Rosetta toggle arrived as a beta in 4.16 and is documented as default **Disabled**. The
  native/emulated split of the 7 vs 19 minutes is not disclosed. This does not make the comparison wrong
  — it is Docker Desktop's default experience — but it is not an emulator-to-emulator test.
- **Cache state unstated.** The edX timed step downloads pip/npm/gem packages inside the window, and
  PostHog's build gives no cache state or build flags. Warm-cache builds, the common daily case, are not
  measured.
- **Colima would be measured at its documented default.** Colima's default is QEMU + sshfs, not VZ +
  virtiofs. A benchmark against defaults is partly a benchmark of sshfs. (Docker Desktop 4.22 was already
  on VirtioFS, so the Docker Desktop comparison is not that artifact.)
- **Power is relative-only.** `powermetrics(1)` warns that its average power values are estimates and
  should not be compared across devices; the same restraint applies to a per-process-group figure whose
  membership and sampling interval are unpublished. Ordering and rough ratio are the usable signal.

## 3. The evidence is three years old, the page is not

The benchmarks page still reads late August 2023, v0.17.0 vs v4.22.0. Wayback snapshots from 2023-11-26
and 2025-06-12 contain the identical strings, so the page has not been re-run. In the meantime OrbStack
shipped v1.6.0 (2024-05-22) with a rewritten virtualization and filesystem stack, v1.7.0 (2024-08-22)
with dynamic memory, and is now at v2.2.5. The current product is faster than what the charts test.

The five result values exist only inside PNG charts; the HTML has no table or CSV. The assets were also
generated at different times: the PostHog chart's tab row is Speed (Open edX), Build (PostHog), CPU &
Battery (Kubernetes), Supabase, while the Sentry chart's tab row drops Build entirely and reads Speed,
Kubernetes, Supabase, Sentry. Reading the numbers therefore means opening five images.

One arithmetic nit, from OrbStack's 2024 filesystem post: `yarn` 7.9/9.8 s is 81% of native, printed as
77%; `rm -rf` 3.6/4.0 s is 90%, printed as 87%. The headline "2–10x faster" in the first paragraph
becomes "2–5x" later on the same page. Small, but it is the same page that asks to be trusted on ratios.

## 4. Colima is not a benchmarked competitor

OrbStack measures Docker Desktop and nothing else. Colima appears only in a
[feature comparison](https://docs.orbstack.dev/compare/colima) with no numbers at all: "Fast startup ✅ /
❌", "Low CPU usage ✅ / ❌", "Low power usage ✅ / ❌", "Rosetta ✅ / Experimental", "Linux machines ✅ /
M3 or newer". That page has no "last updated" line, unlike the Docker Desktop comparison, which is
stamped January 2025 for v4.37.2.

Two of those ❌ marks are also wrong on Colima's shipped documentation: Colima has SSH agent forwarding
(`--ssh-agent`, `forwardAgent: true`) and a NAT66 prefix for IPv6 in shared mode (unsupported under
`vz`). Where OrbStack's table and Colima's docs disagree, treat the docs as primary.

## 5. Independent numbers that do measure Colima

- **DDEV, nightly medians 2026-08-31 → 2026-09-30** ([ddev.com](https://ddev.com/blog/docker-performance/)),
  `drupal_install_s` on Apple Silicon, Mutagen on: Rancher Desktop 12.0, Lima 12.1, Podman (rootless)
  12.3, **Colima (vz) 12.6**, **OrbStack 13.4**, Docker Desktop 16.7, OrbStack without Mutagen 16.8.
  DDEV's own conclusion: with Mutagen on, the provider is mostly not a performance decision any more.
  On `ddev_start_cold_s` the order flips — OrbStack 12.2 s, Colima 14.4 s — so "Colima is faster" is
  false as a blanket statement; it is faster on the install path.
- **zot24/macos-container-benchmarks, 2026-04** ([repo](https://github.com/zot24/macos-container-benchmarks)),
  M3 16 GB, 4 runs × 3 iterations, per-container limits equalised: container startup Colima 0.291 s,
  Docker Desktop 0.329 s, OrbStack 0.371 s; port-mapped TTFB Colima 1.56 ms, OrbStack 2.18 ms, Docker
  Desktop 2.69 ms; volume read OrbStack 10,061 MB/s vs Colima 3,354 MB/s; volume write OrbStack
  1,566 MB/s vs Colima 1,306 MB/s; image build Docker Desktop 4.98 s, OrbStack 5.28 s, Colima 6.81 s.

So the shape of the difference is: OrbStack wins bind-mount and volume I/O, Colima wins container
startup and port latency, and the DDEV install path is a near tie. Nothing in either source supports
"uniformly faster".

## 6. This Mac's Colima, measured

Read-only measurements taken 2026-11-18 on the machine that runs this app: M1 Pro, 10 cores, 32 GiB RAM,
macOS 27.2, Colima 0.10.3 with Lima 2.3.0, profile `default`, `vz` + virtiofs, guest Ubuntu 24.04.4
(kernel 6.8.0-117), Docker Engine 29.9.3.

| Metric | Value | How |
|---|---|---|
| VM sizing | 4 vCPU / 6 GiB / 60 GiB | `colima status --json` |
| Idle CPU, whole VM process group | 7.78% of one core | cumulative `TIME` delta over 90 s |
| Idle RSS | 1,225.9 MiB (VM pid), 1,352.1 MiB (4-process group) | `ps` RSS samples |
| Host disk | 15.89 GiB in `~/.colima` — 13.96 GiB data disk + 1.94 GiB root | `du -sk` |
| Guest disk, Docker's accounting | 5.565 GB images, 96.07 MB volumes | `docker system df` |
| `docker info` | 90.0 ms median (n=5) | monotonic timer around the CLI |
| `docker ps` | 73.3 ms median (n=5) | same |
| `docker run --rm alpine true` (image present) | 224.5 ms median (n=3) | same |
| `docker exec` into a running container | 64.1 ms median (n=3) | same |
| `colima status` | 1,189.7 ms median (n=10) | same |
| Cold start (stopped → `docker ps` answers) | **not measured** | would have required stopping the user's running container |

How to read those numbers, because a naive reading overstates Colima's cost:

1. **The host was not idle** — load average 12–21, 969 processes, Edge alone at 67% CPU in one `top`
   sample. 7.78% is an upper bound for a quiet machine, not a floor.
2. **The VM was not idle either** — one warm-pool container was running inside it at 4.08% of a core.
   Subtract that and Colima's own hypervisor + virtiofs + usernet + SSH-mux overhead is roughly 3.7% of
   one core *on this loaded host*.
3. **`ps %CPU` is unusable here.** Three methods, three numbers for the same process: `ps` said a flat
   12.5%, `top`'s delta sampler 6.1%, cumulative-time delta 7.78%. Only the delta is quotable.
4. **Host disk is not guest disk.** 15.89 GiB on the Mac against `docker system df`'s 5.565 GB of images
   compares different layers; the gap is the root filesystem, swap, guest logs and sparse slack. Any
   OrbStack "disk usage" figure must be compared host-side: OrbStack's own fresh-install claim is "less
   than 10 MB", but that is an empty install, before a single image exists.
5. **Latency is CLI-dominated.** 90 ms for `docker info` over a unix socket to a local VM is mostly two
   process launches. `colima status` at ~1.2 s is the expensive one, and it is what a GUI pays before it
   can decide whether a profile is running.

## 7. Feature matrix

`yes` = shipped and usable; `partial` = flag-only, read-only, or narrow; `no` = absent. The Runtime Desk
column says what the GUI exposes, not what Colima can do underneath.

| Feature | OrbStack | Colima CLI | Runtime Desk |
|---|---|---|---|
| Instant startup | yes — "starts in 2 seconds" | no — boots a Lima VM | no — inherits VM boot |
| Fast network | yes — custom stack, "up to 45 Gbps" | no | no — no network layer of its own |
| Local domain names | yes — `<container>.orb.local` | no | no — published TCP ports become `localhost` links |
| Seamless integration | yes — purpose-built macOS services | CLI only | partial — native window and menu over the CLIs |
| Linux machines | yes — systemd/OpenRC/runit | partial — Incus runtime only, M3+ | partial — Colima profiles; other Lima VMs read-only |
| Isolated machines | yes — `--isolated` | no | no |
| Rosetta x86 emulation | yes — default path | partial — `--vz-rosetta`, needs `vz` | partial — checkbox in New profile, per-image arm64/amd64 chip, guest binfmt state |
| Optimized for Apple Silicon | yes | partial — native arm64 builds, generic Lima VM | no — ships both arches |
| Low CPU usage | yes — ~0.1% idle | no | no — shows CPU charts, does not reduce idle cost |
| Dynamic disk | yes — grows and shrinks | partial — sparse image, max fixed at create | partial — shows allocated vs configured; raise on restart |
| Native Swift app | yes | no app | partial — native window/menu, React content in WKWebView |
| SSH agent forwarding | yes | yes — `--ssh-agent` | no — no toggle or status |
| File sharing | yes — two-way via `/mnt/mac`, `~/OrbStack` | partial — host→VM mounts only | partial — `--mount` at profile creation |
| USB passthrough | yes | no | no |
| Sound | yes — ALSA device | no | no |
| 2-way CLI integration | yes — `mac` prefix, `open`, `pbcopy` | no | no — explicitly no TTY or `exec` |
| 16 Linux distros | yes | no — fixed Ubuntu 24.04 minimal image | no |
| SSH | yes — `ssh orb` | yes — `colima ssh`, generated config | partial — `ssh-config` shown read-only |
| Remote VS Code | yes — documented workflow | partial — generated config enables it | no |
| VPN-friendly | yes | yes | partial — inherits Colima, no controls |
| IPv6 | yes | partial — NAT66 in shared mode, not under `vz` | no |
| ICMP / ping / traceroute | yes | no | no |
| Low initial memory usage | yes — allocated on demand, returned | no — fixed at `colima start` | partial — shows memory and pressure, cannot change while running |
| Accurate clock | yes | partial — normal VM clock sync | no |
| Works without admin | yes | yes | yes — no privileged helper |
| Bind mounts | yes | yes — `$HOME` writable by default | partial — create-time `--mount` only |
| Volume files on Mac | yes — `~/OrbStack/docker/volumes` | no | partial — read-only Contents browser inside the guest |
| Image files on Mac | yes — `~/OrbStack/docker/images` | no | no — build history only |
| Host networking | yes — `--net=host` | no | no |
| eBPF | yes | no | no |
| Native UI | yes | no | partial — native menu bar, web content |
| Activity Monitor | yes — in-app plus `orb top` | no | yes — own Activity page, 1 Hz, 2 or 10 min CPU history |
| Menu bar app | yes — status item with quick actions | no | no — app menu only |
| Quick global actions | yes | no | partial — in-window actions only |
| Kubernetes | yes — GUI, ClusterIP/NodePort/LB, wildcard domains | yes — k3s in the profile | yes — read-only objects, pod logs, start/stop/reset; no manifest apply |

### What a Runtime Desk user would gain from OrbStack

1. Seconds-scale startup and a faster network path.
2. DNS for containers, host networking, IPv6, ping and traceroute without publishing ports.
3. Two-way file sharing through Finder instead of a guest-side read-only browser.
4. Real Linux machines with isolated sandboxes, USB and sound.
5. Global menu-bar control.
6. Memory returned to macOS and a shrinkable disk.

### What Runtime Desk has that OrbStack does not

1. One window over Colima profiles, Podman machines and other Lima VMs, with global search.
2. Cleanup forensics: host sparse disk vs guest usage vs Docker's logical totals, largest logs, objects
   unused for 30 days.
3. Sherlock: mounts, networks, ports, masked env vars, label origin, build history and related objects
   joined on one page.
4. An OOM guard that warns at 90% of a cgroup or VM limit and raises it in place through `docker update`.
5. A Colima lifecycle and configuration surface: profiles, restart with new resources, `colima update`,
   template and `ssh-config` viewers, CLI update check.
6. Free software with no seat licensing, plus an AI Models page driving `colima model` in a `krunkit`
   profile — OrbStack's feature list has no model-runner UI.

## 8. Licensing

| | OrbStack | Colima | Runtime Desk |
|---|---|---|---|
| Source | closed; "some components" open | MIT | GPL-3.0-only |
| Free tier | personal, non-commercial | yes | yes |
| Paid | Pro $8/user/month ($96 billed annually) for commercial use; Enterprise on request | none | none |
| Trial | 30-day Pro | n/a | n/a |
| Seats | per user, 5 devices | n/a | n/a |
| Commercial use | requires a licence, including non-profits, government and >$10k/yr related work | unrestricted | unrestricted |
| macOS floor | 14.0+ | 13+ | Tauri v2 app; no documented floor |

## 9. What to measure next

The three dimensions a desktop user feels most and OrbStack publishes nothing for:

1. **Cold start** — quit the app, stop the VM, then time from launch to the first successful `docker ps`.
   Requires a machine where stopping Colima costs nothing.
2. **Idle cost of the whole stack** — VM process group plus the app's own RSS and CPU, sampled with the
   `TIME`-delta method, on an otherwise idle host (this measurement could not be, and says so).
3. **Bind-mount throughput in the editor/test loop**, where OrbStack's own numbers and zot24's agree the
   gap is real: 10,061 vs 3,354 MB/s sequential read is not noise.

Until those exist, the honest claim is the narrow one: Colima starts containers fast, answers ports fast,
costs about one GiB resident per 4 GiB of configured guest memory on a busy host, and is behind on
bind-mount I/O — not that either product is "faster" in general.

## Sources

- OrbStack: [homepage](https://orbstack.dev/), [benchmarks](https://docs.orbstack.dev/benchmarks),
  [efficiency](https://docs.orbstack.dev/efficiency), [Docker](https://docs.orbstack.dev/docker/),
  [architecture](https://docs.orbstack.dev/architecture),
  [file sharing](https://docs.orbstack.dev/docker/file-sharing),
  [Colima comparison](https://docs.orbstack.dev/compare/colima),
  [FAQ](https://docs.orbstack.dev/faq), [release notes](https://docs.orbstack.dev/release-notes),
  [pricing](https://orbstack.dev/pricing), [licensing](https://docs.orbstack.dev/licensing),
  [1.0 announcement](https://orbstack.dev/blog/orbstack-1.0),
  [filesystem post](https://orbstack.dev/blog/fast-filesystem),
  [dynamic memory](https://orbstack.dev/blog/dynamic-memory)
- Colima: [repository](https://github.com/abiosoft/colima),
  [commands](https://colima.run/docs/commands/), [FAQ](https://colima.run/docs/faq/),
  [configuration](https://colima.run/docs/configuration/),
  [default template](https://raw.githubusercontent.com/abiosoft/colima/master/embedded/defaults/colima.yaml)
- Third party: [DDEV nightly performance](https://ddev.com/blog/docker-performance/),
  [DDEV history data](https://ddev.github.io/ddev/perf/history.ndjson),
  [zot24/macos-container-benchmarks](https://github.com/zot24/macos-container-benchmarks)
- Docker Desktop: [release notes](https://docs.docker.com/desktop/release-notes/),
  [settings reference](https://docs.docker.com/desktop/settings-and-maintenance/settings)
