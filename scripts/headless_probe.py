#!/usr/bin/env python3
"""Headless layout/state probe for the built frontend.

Serves `dist/` and stubs `window.__TAURI_INTERNALS__` so every screen can be rendered
without the Tauri shell, a container engine, or a cluster. Prints one JSON report.

    python3 scripts/headless_probe.py --list
    python3 scripts/headless_probe.py --state stopped --page containers
    python3 scripts/headless_probe.py --state baseline --page all --width 900 --width 1280

Requires playwright for Python (pip install playwright) and one cached Chromium.
"""
from __future__ import annotations

import argparse
import json
import re
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"
def free_port() -> int:
    """Several probes (or several agents) run at once: a fixed port would collide and the
    later run would talk to the earlier run's server, or to nothing."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def probe_port() -> int:
    """Resolved per run: parallel states in one process must not share a server."""
    return int(os.environ.get("PROBE_PORT") or 0) or free_port()
UID = "93f71c48-591a-4943-9348-0487d1719502"
PODS = ["coredns-54bf7cdff9-j4r4r", "metrics-server-77dbbf84b-rp7sc", "local-path-provisioner-69879d7dd7-8jl7j"]
LONG_PROFILE = "a-very-long-profile-name-for-layout-tests"
LONG_MACHINE = "podman-machine-fedora-workstation-42"

ALL_TOOLS = {"colima": True, "docker": True, "lima": True, "nerdctl": True, "compose": True,
             "ramalama": False, "krunkit": False, "podman": True, "kubectl": True}
PROFILE = {"name": "default", "status": "Running", "arch": "aarch64", "cpus": 4,
           "memory": 6442450944, "disk": 64424509440, "runtime": "docker", "address": ""}
CLUSTER = {"context": "colima", "enabled": True, "reachable": True, "version": "v1.35.0+k3s1",
           "nodes": 1, "nodes_ready": 1, "pods": 5, "pods_running": 5, "deployments": 1,
           "deployments_ready": 1, "namespaces": ["default", "kube-system"], "error": None, "read_at": 1763210432}
MACHINE = {"name": "podman-machine-default", "default": True, "running": True, "starting": False,
           "cpus": 4, "memory": 4294967296, "disk_size": 64424509440, "vm_type": "applehv", "port": 5555}


PODMAN_CONTAINERS = [
    {"id": f"p{i}", "name": name, "image": image, "status": "Up 3 hours", "ports": ports,
     "created_at": "2026-11-15T09:00:00Z", "state": "running", "pod": "", "pod_name": ""}
    for i, (name, image, ports) in enumerate([
        ("api", "docker.io/library/python:3.12", "0.0.0.0:8000->8000/tcp"),
        ("pg", "docker.io/library/postgres:16", "127.0.0.1:5432->5432/tcp"),
    ])
]
PODMAN_IMAGES = [
    {"id": f"sha256:{i:064d}", "name": repo, "repository": repo.split("/")[-1], "tag": tag,
     "size": 123456789, "created_at": "2026-11-14T09:00:00Z", "containers": 1 if i == 0 else 0}
    for i, (repo, tag) in enumerate([("docker.io/library/python", "3.12"), ("docker.io/library/postgres", "16")])
]
PODMAN_VOLUMES = [
    {"name": "pgdata", "driver": "local", "mountpoint": "/home/user/.local/share/containers/storage/volumes/pgdata/_data",
     "created_at": "2026-11-10T09:00:00Z", "links": 1, "size": 1048576},
    {"name": "cache", "driver": "local", "mountpoint": "/home/user/.local/share/containers/storage/volumes/cache/_data",
     "created_at": "2026-11-12T09:00:00Z", "links": 0, "size": 524288},
]
PODMAN_NETWORKS = [
    {"id": "pn1", "name": "podman", "driver": "bridge", "subnet": "10.88.0.0/16", "created_at": "2026-11-10T09:00:00Z"},
    {"id": "pn2", "name": "backend", "driver": "bridge", "subnet": "10.89.0.0/24", "created_at": "2026-11-11T09:00:00Z"},
]


def stream_stat(i: int, name: str, cpu: float, mem_pct: int = 12) -> dict:
    """One `docker stats` row for the stub stream. `mem_pct` is what the OOM guard reads."""
    limit = 1024 ** 3 if mem_pct >= 90 else 4 * 1024 ** 3
    return {"id": f"s{i}", "name": name, "cpu": cpu, "mem": int(limit * mem_pct / 100),
            "mem_limit": limit, "mem_pct": mem_pct, "pids": 3,
            "net_rx": 1000, "net_tx": 500, "block_read": 4096, "block_write": 2048}


def plain_containers(n: int) -> list[dict]:
    return [{"id": f"c{i}", "name": f"web-{i}", "image": "nginx:1", "status": "Up 2 hours",
             "ports": "0.0.0.0:8080->80/tcp", "created_at": "2026-11-15T10:00:00Z", "state": "running",
             "compose_project": "stack" if i == 0 else "", "mounts": ""} for i in range(n)]


def pod_containers(pods: list[str]) -> list[dict]:
    out: list[dict] = []
    for pod in pods:
        for cname in ("POD", pod.split("-")[0]):
            out.append({"id": f"{cname[:4]}{len(out)}", "name": f"k8s_{cname}_{pod}_kube-system_{UID}_1",
                        "image": "rancher/mirrored-pause:3.6" if cname == "POD" else "img:1",
                        "status": "Up 2 days", "ports": "", "created_at": "2026-11-13T10:00:00Z",
                        "state": "running", "compose_project": "", "mounts": ""})
    return out


BASE = {
    "tools": {**ALL_TOOLS, "host_arch": "arm64"},
    "profiles": [PROFILE],
    "machines": [MACHINE],
    "containers": plain_containers(3) + pod_containers(PODS),
}

STATES: dict[str, dict] = {
    "baseline": {},
    "stopped": {"profiles": [{**PROFILE, "status": "Stopped"}]},
    "no-profile": {"profiles": []},
    "no-tools": {"tools": {k: False for k in ALL_TOOLS}, "profiles": [], "machines": []},
    "kubectl-only": {"tools": {**ALL_TOOLS, "colima": False, "docker": False, "podman": False,
                               "lima": False, "nerdctl": False, "compose": False, "kubectl": True},
                     "profiles": []},
    "k8s-off": {"tools": {**ALL_TOOLS, "kubectl": False}},
    "containerd": {"tools": {**ALL_TOOLS, "docker": False},
                   "profiles": [{**PROFILE, "runtime": "containerd"}]},
    "long-names": {"profiles": [{**PROFILE, "name": LONG_PROFILE}],
                   "machines": [{**MACHINE, "name": LONG_MACHINE}]},
    "podman-no-machine": {"machines": []},
    "many": {"containers": plain_containers(120) + pod_containers(PODS[:1])},
    # The cluster exists in the kubeconfig but the API server is not answering: the state a
    # stopping VM leaves behind, and the one that must never invent counts.
    # Unreachable, but the last answer is still on file (that is what the app shows).
    "k8s-unreachable": {"cluster": {**CLUSTER, "reachable": False, "read_at": 1763210432,
                                    "error": "Unable to connect to the server: dial tcp 192.168.5.15:6443: i/o timeout"}},
    # Unreachable and never read: no counts exist, so every counter must read `—`.
    "k8s-never-read": {"cluster": {**CLUSTER, "reachable": False, "read_at": None, "nodes": 0, "nodes_ready": 0,
                                   "pods": 0, "pods_running": 0, "deployments": 0, "deployments_ready": 0,
                                   "namespaces": [], "version": None,
                                   "error": "Unable to connect to the server: dial tcp 192.168.5.15:6443: i/o timeout"}},
    # Two profiles: the delete dialog must never print the other VM's counts.
    "two-profiles": {"profiles": [PROFILE, {**PROFILE, "name": "beta", "status": "Stopped"}]},
    # The About banner is the one stateful block on that page: render it or it is never judged.
    "new-release": {"release": {"installed": "1.0.2", "latest": "1.1.0", "update_available": True,
                                "url": "https://github.com/dm0xa/runtime-desk/releases/tag/v1.1.0"}},
    # Two machines: every Podman list must say which one it is reading, and the picker must stick.
    "two-podman-machines": {"machines": [MACHINE, {**MACHINE, "name": "podman-machine-test", "default": False, "running": True}]},
    "slow-probes": {"hold": ["system_status_cmd", "list_profiles_cmd"]},
    # Guards (asserted by the gate, measured by scenario runs):
    # a full 10-minute ring buffer at the 10-minute window — the sparkline point budget;
    "full-buffer": {"guard": "full-buffer", "live_window": 600,
                    "stream": {"default": [stream_stat(0, "web-0", 1.5), stream_stat(1, "web-1", 2.5),
                                           stream_stat(2, "web-2", 0.5)]}},
    # forty containers at 95% of a 1 GiB limit: the OOM notice must name the count, not vanish;
    "oom-40": {"expect_notice": 40, "containers": plain_containers(40),
               "stream": {"default": [stream_stat(i, f"pressured-{i}", 1 + i % 5, mem_pct=95)
                                      for i in range(40)]}},
    # two running profiles: switching must start a new sampler for the new daemon;
    "two-running": {"guard": "sampler",
                    "profiles": [PROFILE, {**PROFILE, "name": "beta", "status": "Running"}],
                    "stream": {"default": [stream_stat(0, "default-web", 1.5)],
                               "beta": [stream_stat(1, "beta-web", 4.5)]}},
    "k8s-not-enabled": {"cluster": {**CLUSTER, "enabled": False, "reachable": False, "version": None,
                                    "nodes": 0, "nodes_ready": 0, "pods": 0, "pods_running": 0,
                                    "deployments": 0, "deployments_ready": 0, "namespaces": [], "error": None}},
}

PAGES = ["dashboard", "containers", "images", "volumes", "networks", "activity", "sherlock",
         "cleanup", "machine", "kubernetes", "podman-machines", "podman-containers", "podman-images",
         "podman-volumes", "podman-networks", "settings-general", "settings-sidebar",
         "settings-configuration", "settings-about"]

NAV_LABEL = {"dashboard": "Dashboard", "containers": "Containers", "images": "Images", "volumes": "Volumes",
             "networks": "Networks", "activity": "Activity", "sherlock": "Sherlock", "cleanup": "Cleanup",
             "machine": "Machine", "kubernetes": "Kubernetes",
             "podman-machines": "Machines", "podman-containers": "Containers", "podman-images": "Images",
             "podman-volumes": "Volumes", "podman-networks": "Networks",
             "settings-general": "Settings", "settings-sidebar": "Settings",
             "settings-configuration": "Settings", "settings-about": "Settings"}
# Settings sections live in a tab bar inside the page, not in a second sidebar column.
SETTINGS_SECTION = {"settings-general": "General", "settings-sidebar": "Sidebar",
                    "settings-configuration": "Configuration", "settings-about": "About"}


def chrome_path() -> str:
    override = os.environ.get("PROBE_CHROME")
    if override:
        return override
    cache = Path.home() / "Library/Caches/ms-playwright"
    for candidate in sorted(cache.glob("chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell"),
                            reverse=True):
        return str(candidate)
    for candidate in sorted(cache.glob("chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"),
                            reverse=True):
        return str(candidate)
    raise SystemExit("no cached Chromium found; set PROBE_CHROME")


def stub_js(state: str) -> str:
    cfg = {**BASE, **STATES[state]}
    containers = cfg["containers"]
    report = {"containers": [{"id": c["id"], "name": c["name"], "running": c["state"] == "running",
                             "size": 4096, "status": c["status"], "created": c["created_at"], "age_days": 3}
                            for c in containers[:2]]
                           + [{"id": "stopped0", "name": "old-worker", "running": False, "size": 4096,
                               "status": "Exited (137) 20 days ago", "created": "2026-10-01T10:00:00Z",
                               "age_days": 20}],
              # The unused list has to render every kind in the layout gate: a used image,
              # a dangling one, an unused tagged one, a stopped container, a volume, cache.
              "images": [{"id": "sha256:" + "a" * 64, "tags": ["nginx:1"], "size": 400_000_000,
                          "unique": 150_000_000, "containers": 1, "created": "2026-11-14T10:00:00Z",
                          "age_days": 2, "dangling": False},
                         {"id": "sha256:" + "b" * 64, "tags": [], "size": 300_000_000,
                          "unique": 120_000_000, "containers": 0, "created": "2026-09-01T10:00:00Z",
                          "age_days": 45, "dangling": True},
                         {"id": "sha256:" + "c" * 64, "tags": ["redis:7"], "size": 110_000_000,
                          "unique": 60_000_000, "containers": 0, "created": "2026-11-01T10:00:00Z",
                          "age_days": 10, "dangling": False}],
              "volumes": [{"name": "old-logs", "driver": "local",
                           "mountpoint": "/var/lib/docker/volumes/old-logs/_data", "size": 50_000_000,
                           "links": 0, "created": "2026-10-01T10:00:00Z", "age_days": 40}],
              "build_cache": [{"size": 20_000_000, "kind": "regular", "last_used": "3 days ago",
                               "in_use": False}],
              "client": "docker",
              "host_disk": 30_000_000_000, "host_disk_path": "/Users/probe/.colima/_lima/colima/disk",
              "docker_disk_total": 98 * 1024 ** 3, "docker_disk_used": 16 * 1024 ** 3,
              "root_total": 60_000_000_000, "root_used": 40_000_000_000, "docker_dir": 20_000_000_000,
              "log_files": [{"container": "web-0", "path": "/var/lib/docker/containers/c0/c0-json.log",
                             "size": 7_000_000}],
              "totals": {"images": 810_000_000, "containers": 8192, "volumes": 50_000_000,
                         "build_cache": 20_000_000, "reclaimable": 250_000_000},
              "error": None}
    return """
window.__probe = { expectNotice: %(expect_notice)s };
window.__TAURI_INTERNALS__ = {
  transformCallback: (cb) => { const id = Math.floor(Math.random()*1e9); window['_' + id] = cb; return id; },
  convertFileSrc: (p) => p,
  invoke: async (cmd, args) => {
    if (%(hold)s.includes(cmd)) return new Promise(() => {});
    switch (cmd) {
      case "list_profiles_cmd": return %(profiles)s;
      case "status_cmd": return { profile: "default", running: %(running)s, runtime: %(runtime)s, kubernetes: true, arch: "aarch64" };
      case "list_containers_cmd": return %(containers)s;
      case "list_images_cmd": return [{ id: "5a4fbe9e1122", repository: "nginx", tag: "1", size: "100MB", created: "2 days ago" }];
      case "image_platforms_cmd": return [{ id: "sha256:5a4fbe9e1122aabbccdd", architecture: "amd64" }];
      case "list_volumes_cmd": return [{ name: "pgdata", driver: "local", mountpoint: "/var/lib/docker/volumes/pgdata" }];
      case "list_networks_cmd": return [{ name: "bridge", driver: "bridge", scope: "local" }];
      case "network_map_cmd": return [{ id: "n1", name: "bridge", driver: "bridge", scope: "local", internal: false,
          subnet: "172.17.0.0/16", gateway: "172.17.0.1", containers: [
            { id: "p1", name: "k8s_POD_coredns-54bf7cdff9-j4r4r_kube-system_%(uid)s_1", ip: "172.17.0.2", ipv6: "", mac: "aa:bb" },
            { id: "c0", name: "web-0", ip: "172.17.0.3", ipv6: "", mac: "aa:cc" }] }];
      case "compose_list_cmd": return [{ name: "stack", status: "running(1)", config_files: "compose.yaml" }];
      case "disk_usage_cmd": return { images: 1000, containers: 2000, volumes: 300, build_cache: 0, total: 3300, reclaimable: 1200 };
      case "podman_disk_usage_cmd": return { images: 0, containers: 0, volumes: 0, reclaimable: 0 };
      case "podman_machines_cmd": return %(machines)s;
      case "podman_containers_cmd": return %(podman_containers)s;
      case "podman_images_cmd": return %(podman_images)s;
      case "podman_volumes_cmd": return %(podman_volumes)s;
      case "podman_networks_cmd": return %(podman_networks)s;
      case "podman_network_map_cmd": return %(podman_networks)s.map((n) => ({ ...n, internal: false,
        gateway: "10.88.0.1", scope: "local", containers: [] }));
      case "lima_vms_cmd": case "volume_sizes_cmd": case "model_serve_status_cmd":
        return [];
      case "system_status_cmd": return %(tools)s;
      case "cleanup_report_cmd": return %(report)s;
      case "k8s_cluster_cmd": return %(cluster)s;
      case "k8s_resources_cmd": return [{ namespace: "kube-system", name: "coredns-54bf7cdff9-j4r4r", ready: "1/1",
          status: "Running", restarts: 3, detail: "10.42.0.2 · colima", age: "2d" }];
      case "k8s_logs_cmd": case "container_logs_cmd": case "podman_container_logs_cmd":
        return "2026-11-15T10:00:00Z info ready\\n2026-11-15T10:00:01Z warn retrying\\n";
      case "container_detail_cmd": return { id: "c0", name: "web-0", image: "nginx:1", created: "2026-11-15T10:00:00Z",
          state: "running", status: "Up 2 hours", restart_count: 0, platform: "linux/arm64", pid: 42,
          command: "nginx -g 'daemon off;'", entrypoint: "", hostname: "c0", ip: "172.17.0.3", gateway: "172.17.0.1",
          mounts: [], networks: [], ports: [], env: [], labels: {}, health: null, exit_code: 0, started_at: "",
          finished_at: "", memory_limit: 0, nano_cpus: 0, compose_project: "" };
      case "container_stats_one_cmd": return { id: "c0", name: "web-0", cpu: 1.5, mem: 1024, mem_limit: 4096,
          mem_pct: 25, pids: 3, net_rx: 10, net_tx: 20, block_read: 5, block_write: 6 };
      case "container_stats_cmd": return [{ id: "c0", name: "web-0", cpu: 1.5, mem: 1024, mem_limit: 4096,
          mem_pct: 25, pids: 3, net_rx: 10, net_tx: 20, block_read: 5, block_write: 6 }];
      // The live path: one child streaming every container at about 1 Hz. The stub pushes a
      // sample a second so the probe renders the real Activity view, not its poll fallback.
      // Each start is counted under the profile selected when it happened: the backend command
      // takes no profile, so the sidebar's active row is the identity the app is sampling.
      case "stats_all_start_cmd": {
        const ch = args && args.onSample;
        if (!ch || !ch.onmessage) return "polling";
        const active = document.querySelector('.side-profile.active .side-profile-name');
        const profile = (active && active.textContent || 'default').trim();
        window.__statsStarts = window.__statsStarts || [];
        window.__statsStarts.push(profile);
        if (window.__activity) clearInterval(window.__activity);
        const rows = (%(streams)s)[profile] || (%(streams)s).default || [];
        let tick = 0;
        const emit = () => {
          tick += 1;
          for (const s of rows) {
            ch.onmessage(JSON.stringify(Object.assign({}, s, {
              cpu: s.cpu + (tick %% 5),
              net_rx: s.net_rx + 1000 * tick, net_tx: s.net_tx + 500 * tick,
            })));
          }
        };
        emit();
        window.__activity = setInterval(emit, 1000);
        return "streaming";
      }
      case "stats_all_stop_cmd":
        window.__statsStops = (window.__statsStops || 0) + 1;
        if (window.__activity) { clearInterval(window.__activity); window.__activity = null; }
        return "stopped";
      case "image_detail_cmd": return { id: "sha256:aaaa", repository: "nginx", tag: "1", size: "100MB",
          created: "2 days ago", architecture: "arm64", os: "linux", digest: "sha256:bbbb", layers: [],
          entrypoint: "", command: "", exposed_ports: [], env: [], labels: {}, containers: [] };
      case "network_detail_cmd": return { id: "n1", name: "bridge", driver: "bridge", scope: "local", internal: false,
          subnet: "172.17.0.0/16", gateway: "172.17.0.1", created: "2 days ago", containers: [] };
      case "model_list_cmd": return { machines: [] };
      case "vm_diagnostics_cmd": return { ok: true, error: "", cpus: 4, load1: 0.4, load5: 0.3, load15: 0.2,
          mem_total: 6442450944, mem_used: 1073741824, disk_total: 64424509440, disk_used: 21474836480,
          kernel: "6.8.0-117-generic", uptime: 200000, rosetta_active: true };
      case "app_release_cmd": return %(release)s;
      case "version_check_cmd": return null;
      case "profile_config_cmd": return { vm_type: "vz", runtime: "docker", arch: "aarch64", mount_type: "virtiofs", cpu: 4, memory: 6, disk: 60, rosetta: true,
          network_mode: "bridged", network_interface: "en0", network_address: true, network_preferred_route: false,
          network_host_addresses: false, gateway_address: "192.168.5.2", dns: ["1.1.1.1", "8.8.8.8"],
          dns_hosts: [{ name: "myapp.local", target: "192.168.1.100" }], port_forwarder: "grpc",
          ssh_agent: true, mount_inotify: false, mounts: [{ location: "~", writable: true }, { location: "/data", writable: false }],
          hostname: "colima", kubernetes: false, k3s_args: [] };
      case "recreate_profile_cmd": case "tray_sync_cmd": return "";
      case "template_cmd": case "ssh_config_cmd": case "version_cmd": return "";
      case "events_start_cmd": return "polling";
      default: return null;
    }
  },
};
""" % {
        "profiles": json.dumps(cfg["profiles"]),
        "running": "true" if any(p["status"] == "Running" for p in cfg["profiles"]) else "false",
        "runtime": json.dumps(cfg["profiles"][0]["runtime"] if cfg["profiles"] else "docker"),
        "containers": json.dumps(containers),
        "machines": json.dumps(cfg["machines"]),
        "tools": json.dumps(cfg["tools"]),
        "report": json.dumps(report),
        "uid": UID,
        "cluster": json.dumps(cfg.get("cluster", CLUSTER)),
        "podman_containers": json.dumps(cfg.get("podman_containers", PODMAN_CONTAINERS)),
        "podman_images": json.dumps(cfg.get("podman_images", PODMAN_IMAGES)),
        "podman_volumes": json.dumps(cfg.get("podman_volumes", PODMAN_VOLUMES)),
        "podman_networks": json.dumps(cfg.get("podman_networks", PODMAN_NETWORKS)),
        "hold": json.dumps(cfg.get("hold", [])),
        "streams": json.dumps(cfg.get("stream", {"default": [stream_stat(0, "web-0", 1.0)]})),
        "expect_notice": json.dumps(cfg.get("expect_notice", 0)),
        "release": json.dumps(cfg.get("release", {"installed": "1.0.2", "latest": None,
                                                  "update_available": False, "url": ""})),
    }


REPORT_JS = r"""() => {
  // Table cells ellipsize on purpose; only chrome that should never clip is reported.
  const clipped = [...document.querySelectorAll('.nav-item span, .nav-group-title, .topbar h1, .strip-label, .strip-value, .section-name, .button, .btn, .about-name, .about-version, .about-built, .about-copyright, .about-link')]
    .filter((e) => e.scrollWidth > e.clientWidth + 1)
    .map((e) => ({ cls: e.className || e.tagName, text: (e.textContent || '').trim().slice(0, 40), over: e.scrollWidth - e.clientWidth }));
  const badFont = [...document.querySelectorAll('body *')]
    .filter((e) => /Arial|Times/.test(getComputedStyle(e).fontFamily))
    .map((e) => e.className || e.tagName).slice(0, 12);
  // .table-wrap is a scroll container by design (its min-widths force sideways scroll);
  // only the page itself must never overflow.
  const overflow = [...document.querySelectorAll('.page-scroll, .content')]
    .filter((e) => e.scrollWidth > e.clientWidth + 2)
    .map((e) => ({ cls: e.className, over: e.scrollWidth - e.clientWidth }));
  const rects = {};
  for (const sel of ['.sidebar', '.settings-tabs', '.topbar h1', '.table', '.page-scroll', '.statusbar', '.prereq-panel', '.nav-empty', '.logs-modal']) {
    const el = document.querySelector(sel);
    if (el) { const r = el.getBoundingClientRect(); rects[sel] = [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)]; }
  }
  return {
    title: document.querySelector('.topbar h1')?.textContent ?? '',
    scroll: [document.documentElement.scrollWidth, document.documentElement.clientWidth],
    bodyOverflow: document.documentElement.scrollWidth > document.documentElement.clientWidth,
    clipped, badFont, overflow, rects,
    counts: {
      rows: document.querySelectorAll('.table tbody tr').length,
      chips: document.querySelectorAll('.k8s-chip').length,
      groups: document.querySelectorAll('.nav-group-title').length,
      items: document.querySelectorAll('.nav-item').length,
      notices: document.querySelectorAll('.notice-card').length,
      emptyCells: document.querySelectorAll('td.empty').length,
    },
    furniture: {
      toolbar: document.querySelectorAll('.toolbar').length,
      panels: document.querySelectorAll('.panel').length,
      sectionHeads: document.querySelectorAll('.section-head h3').length,
      tableWraps: document.querySelectorAll('.table-wrap').length,
      empties: [...document.querySelectorAll('td.empty, .empty')].map((e) => e.textContent.trim().slice(0, 28)),
      actions: document.querySelectorAll('.topbar .actions button, .topbar button').length,
      prereq: !!document.querySelector('.prereq-panel'),
      notices: document.querySelectorAll('.notice-card').length,
    },
    nav: [...document.querySelectorAll('.nav-group-title')].map((t) => ({ g: t.firstElementChild?.textContent ?? t.textContent,
      hint: t.querySelector('.nav-group-hint')?.textContent ?? '' })),
    text: (document.querySelector('.content')?.innerText || '').replace(/\s+/g, ' ').slice(0, 500),
    // The sidebar's own copy (group hints, the no-tooling notice) is not inside .content.
    navText: (document.querySelector('.side-nav')?.innerText || '').replace(/\s+/g, ' ').slice(0, 240),
    // Overlays live outside .content: first launch, dialogs, logs and inspect windows.
    modal: (document.querySelector('.onboarding-backdrop, .modal-backdrop')?.innerText || '').replace(/\s+/g, ' ').slice(0, 300),
    // First data row of the visible list, so a collapsing column is a number, not a hunch.
    cells: [...([...document.querySelectorAll('tbody tr')].find((r) => !r.classList.contains('group-row'))?.children ?? [])]
      .map((td) => Math.round(td.getBoundingClientRect().width)),
    // Guards: deterministic facts, not layout. The point budget is the sparkline's own
    // coordinate space (viewBox width, 120), so it does not depend on the row's CSS width.
    guards: (() => {
      const rows = [...document.querySelectorAll('.activity-table polyline')].map((el) => {
        const svg = el.ownerSVGElement;
        const box = (svg?.getAttribute('viewBox') || '').trim().split(/\s+/).map(Number);
        const width = box.length === 4 && box[2] > 0 ? box[2] : (svg?.clientWidth || 0);
        const pairs = (el.getAttribute('points') || '').trim().split(/\s+/).filter(Boolean).length;
        return { width, pairs };
      });
      const worst = rows.reduce((a, s) => (s.pairs > a.pairs ? s : a), { width: 0, pairs: 0 });
      const titles = [...document.querySelectorAll('.notice-card .notice-title')]
        .map((e) => (e.textContent || '').trim());
      const grouped = titles.filter((t) => /^\d+ containers are close to their memory limits$/.test(t));
      const perContainer = titles.filter((t) =>
        / is close to its memory limit$| is using the VM's memory with no limit$/.test(t)).length;
      const groupedCount = grouped.length ? Number(grouped[0].split(' ')[0]) : 0;
      const expect = (window.__probe && window.__probe.expectNotice) || 0;
      return {
        spark: { rows: rows.length, width: worst.width, worstPairs: worst.pairs,
                 worstRatio: +(worst.width ? worst.pairs / worst.width : 0).toFixed(2),
                 budget: 2 * worst.width, ok: worst.pairs <= 2 * worst.width },
        notice: { expected: expect, perContainer, grouped: grouped.length, groupedCount,
                  ok: expect === 0 ? true
                    : grouped.length > 0 ? groupedCount === expect
                    : perContainer > 0 && perContainer <= 3 },
      };
    })(),
    errors: [],
    // About is a centered column, not a grid: print the identity block's width and the link row count.
    about: {
      column: Math.round(document.querySelector('.about-identity')?.getBoundingClientRect().width ?? 0),
      links: [...document.querySelectorAll('.about-link')].map((e) => (e.textContent || '').trim()),
    },
  };
}"""


SAMPLER_READ = r"""() => {
  const label = document.querySelector('.activity-chart-peak')?.textContent || '';
  const m = label.match(/·\s*(\d+)\s*s of/);
  return {
    recorded: m ? Number(m[1]) : null,
    starts: (window.__statsStarts || []).slice(),
    stops: window.__statsStops || 0,
    rows: [...document.querySelectorAll('.activity-table tbody tr td:first-child')]
      .map((e) => (e.textContent || '').trim()).filter(Boolean),
  };
}"""


def guard_probe(browser, port: int, state: str, width: int, kind: str) -> dict:
    """Measure a guard in its own context with a fake clock.

    Two guards need time the wall clock will not give: a full 600-sample ring buffer, and a
    sampler restart whose totals series must visibly start over. Both run on Playwright's
    clock, so the numbers come from counted ticks, never from how fast the machine is.
    """
    ctx = browser.new_context(viewport={"width": width, "height": 900}, device_scale_factor=2)
    pg = ctx.new_page()
    pg.clock.install()
    pg.add_init_script(stub_js(state))
    errors: list[str] = []
    pg.on("pageerror", lambda e: errors.append(str(e)[:240]))
    try:
        pg.goto(f"http://localhost:{port}/", wait_until="load")
        pg.evaluate("""() => {
          localStorage.setItem('runtimeDesk.onboarded','1');
          localStorage.setItem('runtimeDesk.layoutVersion','3');
          localStorage.setItem('runtimeDesk.widgets', JSON.stringify({recent:true}));
          localStorage.setItem('runtimeDesk.liveWindow','600');
        }""")
        pg.reload(wait_until="load")
        pg.wait_for_timeout(1200)
        pg.get_by_role("button", name=re.compile(r"^Activity\b")).first.click(timeout=3000)
        pg.wait_for_timeout(500)
        if kind == "full-buffer":
            # Ten minutes of ticks: the ring holds its 600 samples and the view draws the
            # 10-minute window. The polyline must stay within one point per horizontal pixel
            # (two, with slack) whatever the buffer holds.
            pg.clock.run_for("10:00")
            rep = pg.evaluate(REPORT_JS)
            spark = rep["guards"]["spark"]
            spark["chart"] = pg.evaluate(
                "() => document.querySelector('.activity-chart-peak')?.textContent || ''")
            spark["samples_note"] = "600 accounting ticks via fake clock"
            spark["ok"] = spark["worstPairs"] <= 2 * spark["width"]
            return {"spark": spark, "errors": errors[:3]}
        if kind == "sampler":
            # A minute of history on the first profile: long enough that a reset is visible
            # as a smaller number, not as a plausible one.
            pg.clock.run_for("01:00")
            before = pg.evaluate(SAMPLER_READ)
            pg.locator(".side-profile", has_text="beta").locator(".side-profile-main").first.click()
            pg.wait_for_timeout(300)
            pg.clock.run_for("00:03")
            after = pg.evaluate(SAMPLER_READ)
            fails: list[str] = []
            beta_starts = after["starts"].count("beta")
            if beta_starts < 1:
                fails.append(f"no stats_all_start_cmd for beta (starts {after['starts']})")
            if len(after["starts"]) <= len(before["starts"]):
                fails.append(f"start count did not grow ({len(before['starts'])} -> {len(after['starts'])})")
            if after["stops"] <= before["stops"]:
                fails.append(f"old sampler was not stopped (stops {before['stops']} -> {after['stops']})")
            if before["recorded"] is None or after["recorded"] is None:
                fails.append("chart did not report a recorded span")
            elif after["recorded"] >= before["recorded"]:
                fails.append(f"totals series was not reset ({before['recorded']} s -> {after['recorded']} s)")
            if after["rows"] != ["beta-web"]:
                fails.append(f"rows still name the old profile: {after['rows']}")
            return {"sampler": {"ok": not fails, "fail": "; ".join(fails),
                                "before": before, "after": after}, "errors": errors[:3]}
        return {"ok": False, "fail": f"unknown guard {kind}"}
    finally:
        ctx.close()


def run(state: str, pages: list[str], widths: list[int], shots: bool, out_dir: Path,
        fresh: bool = False, dark: bool = False) -> list[dict]:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise SystemExit("playwright for Python is not installed (pip install playwright)")

    if not (DIST / "index.html").exists():
        raise SystemExit("dist/ is missing; run `npm run build` first")

    port = probe_port()
    cfg = {**BASE, **STATES[state]}
    srv = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--directory", str(DIST)],
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    results: list[dict] = []
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=chrome_path())
            for width in widths:
                ctx = browser.new_context(viewport={"width": width, "height": 900}, device_scale_factor=2,
                                          color_scheme="dark" if dark else "light")
                pg = ctx.new_page()
                pg.add_init_script(stub_js(state))
                errors: list[str] = []
                pg.on("pageerror", lambda e: errors.append(str(e)[:240]))
                pg.goto(f"http://localhost:{port}/", wait_until="load")
                if not fresh:
                    # Set the persisted keys after the origin exists, then reload: an init
                    # script can land after the module script has already read them.
                    pg.evaluate(f"""() => {{
                      localStorage.setItem('runtimeDesk.onboarded','1');
                      localStorage.setItem('runtimeDesk.layoutVersion','3');
                      localStorage.setItem('runtimeDesk.widgets', JSON.stringify({{recent:true}}));
                      localStorage.setItem('runtimeDesk.liveWindow','{cfg.get("live_window", 120)}');
                    }}""")
                    pg.reload(wait_until="load")
                pg.wait_for_timeout(1500)
                for index, page in enumerate(pages):
                    errors.clear()  # a page's report must not inherit the previous page's errors
                    if page == "dashboard" and index > 0:
                        # The first page is whatever mounted; return to Dashboard explicitly.
                        pg.get_by_role("button", name=re.compile(r"^Dashboard\b")).first.click(timeout=2000)
                        pg.wait_for_timeout(900)
                    if page != "dashboard":
                        nav = NAV_LABEL[page]
                        try:
                            # A gated screen has no nav item; fail in 2s instead of the 30s default.
                            if page.startswith("podman-"):
                                pg.locator(".nav-group", has=pg.locator(".nav-group-title", has_text="Podman")) \
                                  .get_by_role("button", name=re.compile(rf"^{nav}\b")).click(timeout=2000)
                            elif page in SETTINGS_SECTION:
                                pg.get_by_role("button", name=re.compile(r"^Settings\b")).first.click(timeout=2000)
                                pg.wait_for_timeout(400)
                                pg.locator(".settings-tabs").get_by_role(
                                    "tab", name=re.compile(rf"^{SETTINGS_SECTION[page]}\b")).click(timeout=2000)
                            else:
                                pg.get_by_role("button", name=re.compile(rf"^{nav}\b")).first.click(timeout=2000)
                        except Exception as exc:  # noqa: BLE001 - report, do not fail the run
                            results.append({"state": state, "page": page, "width": width,
                                            "error": f"navigation failed: {str(exc)[:160]}"})
                            continue
                        pg.wait_for_timeout(1100)
                    if page == "activity" and cfg.get("expect_notice"):
                        # The OOM notice is raised by the activity subscription, one tick after
                        # the page opens: wait for the banner rather than guess a sleep.
                        try:
                            pg.wait_for_selector(".notice-card", timeout=4000)
                        except Exception:  # noqa: BLE001 - a missing banner is the assertion's job
                            pass
                    rep = pg.evaluate(REPORT_JS)
                    rep.update({"state": state, "page": page, "width": width, "errors": errors[:6]})
                    if page == "activity" and cfg.get("guard"):
                        # Guards that need more time than the wall clock allows run in their own
                        # fake-clock context, so their numbers are ticks, not machine speed.
                        try:
                            probe = guard_probe(browser, port, state, width, cfg["guard"])
                        except Exception as exc:  # noqa: BLE001 - a crash is a failed assertion
                            probe = {"ok": False, "fail": f"guard probe crashed: {str(exc)[:160]}"}
                        rep["guards"]["probe"] = probe
                        if probe.get("spark"):
                            rep["guards"]["spark"] = probe["spark"]
                        if probe.get("sampler"):
                            rep["guards"]["sampler"] = probe["sampler"]
                    results.append(rep)
                    if shots:
                        out_dir.mkdir(parents=True, exist_ok=True)
                        pg.screenshot(path=str(out_dir / f"{state}-{page}-{width}.png"),
                                      clip={"x": 0, "y": 0, "width": width, "height": min(900, 820)})
                ctx.close()
            browser.close()
    finally:
        srv.terminate()
    return results


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--state", default="baseline", choices=sorted(STATES))
    ap.add_argument("--page", action="append", default=None, help="page id, repeatable; default dashboard")
    ap.add_argument("--width", action="append", type=int, default=None, help="viewport width, repeatable")
    ap.add_argument("--all", action="store_true", help="every page at every given width")
    ap.add_argument("--list", action="store_true", help="print states and pages")
    ap.add_argument("--shots", action="store_true", help="write screenshots")
    ap.add_argument("--out", default="/tmp/runtime-desk-probe")
    ap.add_argument("--pretty", action="store_true")
    ap.add_argument("--fresh", action="store_true", help="first launch: keep the onboarding modal")
    ap.add_argument("--dark", action="store_true", help="render with prefers-color-scheme: dark")
    ap.add_argument("--gate", action="store_true",
                    help="every state, every page, widths 900/1280/1600; exit 1 on a layout regression")
    args = ap.parse_args()

    if args.list:
        print("states:", " ".join(sorted(STATES)))
        print("pages: ", " ".join(PAGES))
        return

    if args.gate:
        failures: list[str] = []
        # States are independent and each run() owns its server and browser, so a gate over
        # fifteen states takes about as long as the slowest four instead of all fifteen.
        from concurrent.futures import ThreadPoolExecutor
        widths = args.width or [900, 1280, 1600]
        with ThreadPoolExecutor(max_workers=4) as pool:
            batches = list(pool.map(lambda st: run(st, PAGES, widths, False, Path(args.out)), sorted(STATES)))
        for rep in (rep for batch in batches for rep in batch):
            where = f"{rep.get('state')}/{rep.get('page')}@{rep.get('width')}"
            if rep.get("error"):
                continue  # screen is gated in this state, nothing rendered to judge
            for item in rep["clipped"]:
                failures.append(f"{where}: clipped {item['cls']} \"{item['text']}\" +{item['over']}px")
            for cls in rep["badFont"]:
                failures.append(f"{where}: UA font on .{cls}")
            for item in rep["overflow"]:
                failures.append(f"{where}: .{item['cls']} overflows by {item['over']}px")
            for err in rep["errors"]:
                failures.append(f"{where}: console error {err}")
            # Guards. The point budget applies to every Activity render; a shallow history is
            # simply under budget. The notice contract only means anything where 40 containers
            # are pressured, which the state itself declares.
            guards = rep.get("guards") or {}
            spark = guards.get("spark") or {}
            if rep.get("page") == "activity" and spark.get("width", 0) > 0 \
                    and spark.get("worstPairs", 0) > 2 * spark.get("width", 0):
                failures.append(f"{where}: activity sparkline {spark['worstPairs']} points "
                                f"> 2x{spark['width']} (ratio {spark['worstRatio']})")
            notice = guards.get("notice") or {}
            if rep.get("page") == "activity" and notice.get("expected") and not notice.get("ok"):
                failures.append(f"{where}: {notice['expected']} pressured containers raised "
                                f"{notice['perContainer']} per-container and {notice['grouped']} "
                                f"grouped notices")
            sampler = guards.get("sampler")
            if sampler and not sampler.get("ok"):
                failures.append(f"{where}: sampler {sampler.get('fail')}")
            probe = guards.get("probe") or {}
            if probe.get("fail"):
                failures.append(f"{where}: guard probe {probe['fail']}")
        print(f"{len(failures)} layout regressions")
        for line in failures[:60]:
            print(" ", line)
        raise SystemExit(1 if failures else 0)

    pages = PAGES if args.all else (args.page or ["dashboard"])
    widths = args.width or [1280]
    for page in pages:
        if page not in NAV_LABEL:
            raise SystemExit(f"unknown page {page}; see --list")
    results = run(args.state, pages, widths, args.shots, Path(args.out), args.fresh, args.dark)
    print(json.dumps(results, indent=2 if args.pretty else None, ensure_ascii=False))


if __name__ == "__main__":
    main()
