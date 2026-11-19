#!/usr/bin/env python3
"""Sherlock compose-project (group page) benchmark workload.

Renders the real built frontend in headless Chromium with a stubbed Tauri IPC layer, opens
Sherlock on one deterministic Compose project, and reports how many of a fixed set of
*valuable* facts the page actually puts on screen.

    python3 scripts/group_probe.py            # metric lines only
    python3 scripts/group_probe.py --verbose  # plus the rendered text and every check

Print contract (consumed by autoresearch.sh):
    METRIC group_signals=<n>
    METRIC group_rows=<n>
    METRIC group_probe_ops=<n>
    METRIC group_render_ms=<n>
    ASI signals_failed=<csv>
    ASI panels=<csv>

Exits non-zero only when the workload itself cannot run (no dist, no browser, wrong page).
A thin page is not an error: it just scores low.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import re
import socket
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DIST = ROOT / "dist"

# Frozen clock so age/uptime text is identical on every run, today or next month.
NOW_MS = 1795040800000  # 2026-11-18T22:26:40Z


def iso(ms: int) -> str:
    return dt.datetime.fromtimestamp(ms / 1000, dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


PROJECT = "shopstack"
WORKDIR = "/Users/dev/shopstack"
CONFIG = f"{WORKDIR}/compose.yaml"
BIND = f"{WORKDIR}/site"

API = "ghcr.io/acme/api:2.4.1"
NGINX = "nginx:1.27"
PG = "postgres:16"
REDIS = "redis:7-alpine"
ALPINE = "alpine:3.20"


def container(cid, name, image, state, status, ports="", mounts="", project=PROJECT,
              created=None) -> dict:
    return {"id": cid, "name": name, "image": image, "state": state, "status": status,
            "ports": ports, "mounts": mounts, "compose_project": project,
            "created_at": created or iso(NOW_MS - 7 * 86400_000)}


# One project, deliberately uneven: a restart loop, an OOM victim, an unhealthy service,
# services with no health check, a one-shot migration, a stopped sibling project that already
# declares the same host port, a shared volume, a bind mount, and an image that is not local.
CONTAINERS = [
    container("c-web", "shopstack-web-1", NGINX, "running", "Up 6 hours",
              ports="0.0.0.0:8080->80/tcp", mounts=f"{BIND}:/usr/share/nginx/html"),
    container("c-api", "shopstack-api-1", API, "running", "Up 20 minutes (unhealthy)",
              ports="127.0.0.1:3000->3000/tcp"),
    container("c-worker", "shopstack-worker-1", API, "running", "Up 6 hours"),
    container("c-db", "shopstack-db-1", PG, "running", "Up 6 days",
              ports="", mounts="pgdata:/var/lib/postgresql/data"),
    container("c-redis", "shopstack-redis-1", REDIS, "running", "Up 6 days",
              ports="", mounts="redisdata:/data"),
    container("c-migrate", "shopstack-migrate-1", API, "exited", "Exited (0) 2 hours ago"),
    container("c-backup", "shopstack-backup-1", ALPINE, "exited", "Exited (0) 2 hours ago",
              mounts="pgdata:/backup"),
    # Another project that is down but still declares host port 8080.
    container("c-blog", "blog-web-1", NGINX, "exited", "Exited (0) 3 hours ago",
              ports="0.0.0.0:8080->80/tcp", project="blog"),
    container("c-solo", "scratch", ALPINE, "running", "Up 4 hours", project=""),
]

# Only these are local: alpine:3.20 is referenced by backup/solo but was never pulled.
IMAGES = [
    {"id": "sha256:" + "11" * 32, "repository": "nginx", "tag": "1.27", "size": "100MB", "created": "3 days ago"},
    {"id": "sha256:" + "22" * 32, "repository": "ghcr.io/acme/api", "tag": "2.4.1", "size": "512MB", "created": "2 days ago"},
    {"id": "sha256:" + "33" * 32, "repository": "postgres", "tag": "16", "size": "250MB", "created": "5 days ago"},
    {"id": "sha256:" + "44" * 32, "repository": "redis", "tag": "7-alpine", "size": "50MB", "created": "5 days ago"},
]
IMAGE_BYTES = {"sha256:" + "11" * 32: 100_000_000, "sha256:" + "22" * 32: 512_000_000,
               "sha256:" + "33" * 32: 250_000_000, "sha256:" + "44" * 32: 50_000_000}
IMAGE_ARCH = {"sha256:" + "11" * 32: "arm64", "sha256:" + "22" * 32: "arm64",
              "sha256:" + "33" * 32: "arm64", "sha256:" + "44" * 32: "arm64"}
# Repo digests, as `docker image inspect` reports them: the name that survives a retag.
IMAGE_DIGEST = {"sha256:" + "11" * 32: "sha256:" + "a1" * 32,
                "sha256:" + "22" * 32: "sha256:" + "b2" * 32,
                "sha256:" + "33" * 32: "sha256:" + "c3" * 32,
                "sha256:" + "44" * 32: "sha256:" + "d4" * 32}

VOLUMES = [
    {"name": "pgdata", "driver": "local", "mountpoint": "/var/lib/docker/volumes/pgdata/_data"},
    {"name": "redisdata", "driver": "local", "mountpoint": "/var/lib/docker/volumes/redisdata/_data"},
]
VOLUME_SIZES = [{"name": "pgdata", "size": 340_000_000}, {"name": "redisdata", "size": 12_000_000}]

NET_MAP = [
    {"id": "n1", "name": "shopstack_default", "driver": "bridge", "scope": "local", "internal": False,
     "subnet": "172.18.0.0/16", "gateway": "172.18.0.1",
     "containers": [{"id": c["id"], "name": c["name"], "ip": f"172.18.0.{10 + i}", "ipv6": "", "mac": "aa:bb:cc:00:00:01"}
                    for i, c in enumerate(CONTAINERS[:7])]},
    {"id": "n2", "name": "blog_default", "driver": "bridge", "scope": "local", "internal": False,
     "subnet": "172.19.0.0/16", "gateway": "172.19.0.1",
     "containers": [{"id": "c-blog", "name": "blog-web-1", "ip": "172.19.0.2", "ipv6": "", "mac": "aa:bb:cc:00:00:02"}]},
]

COMPOSE = [{"name": "shopstack", "status": "running(5)"}, {"name": "blog", "status": "exited(1)"}]


def _net(name, ip):
    return {"name": name, "ip": ip, "ipv6": "", "mac": "aa:bb:cc:00:00:01", "gateway": "172.18.0.1"}


def _detail(cid, name, image, state, health, restarts, policy, mem_limit, started_ms,
            finished_ms=None, mounts=None, networks=None, ports=None, oom=False, pid=1000,
            exit_code=0, image_id=None):
    return {
        "id": cid, "name": name, "image": image,
        "image_id": image_id or {"nginx:1.27": "11" * 32, "ghcr.io/acme/api:2.4.1": "22" * 32,
                                 "postgres:16": "33" * 32, "redis:7-alpine": "44" * 32}.get(image, "55" * 32),
        
        "command": "", "created": iso(NOW_MS - 7 * 86400_000),
        "started_at": iso(started_ms), "finished_at": iso(finished_ms) if finished_ms else "0001-01-01T00:00:00Z",
        "state": state, "health": health, "restart_policy": policy, "restart_count": restarts,
        "labels": compose_labels(name.split("-")[1] if "-" in name else name),
        "restart_max": 0, "mounts": mounts or [], "networks": networks or [],
        "env_count": 0, "env": [], "ports": ports or [], "hostname": name,
        "workdir": "", "user": "", "entrypoint": "", "cmd": "",
        "health_test": "CMD-SHELL curl -fsS localhost:80/ || exit 1" if health else "",
        "health_interval": 30_000_000_000 if health else 0, "health_timeout": 5_000_000_000 if health else 0,
        "health_retries": 3 if health else 0,
        "health_log": [{"start": iso(NOW_MS - 60_000), "exit_code": 0 if health == "healthy" else 1,
                        "output": ""}] if health else [],
        "memory_limit": mem_limit, "nano_cpus": 0, "pid": pid, "exit_code": exit_code,
        "oom_killed": oom,
    }


def compose_labels(service: str) -> list:
    return [["com.docker.compose.project", PROJECT],
            ["com.docker.compose.service", service],
            ["com.docker.compose.project.config_files", CONFIG],
            ["com.docker.compose.project.working_dir", WORKDIR]]


WEB_PORT = [{"container": "80", "proto": "tcp", "host_ip": "0.0.0.0", "host_port": "8080"}]
API_PORT = [{"container": "3000", "proto": "tcp", "host_ip": "127.0.0.1", "host_port": "3000"}]
DETAILS = {
    "c-web": _detail("c-web", "shopstack-web-1", NGINX, "running", "healthy", 0, "always", 512 * 1024 ** 2,
                     NOW_MS - 6 * 3600_000,
                     mounts=[{"source": BIND, "destination": "/usr/share/nginx/html", "mode": "ro", "kind": "bind"}],
                     networks=[_net("shopstack_default", "172.18.0.10")], ports=WEB_PORT, pid=2101),
    "c-api": _detail("c-api", "shopstack-api-1", API, "running", "unhealthy", 14, "on-failure", 512 * 1024 ** 2,
                     NOW_MS - 20 * 60_000,
                     networks=[_net("shopstack_default", "172.18.0.11")], ports=API_PORT, oom=True, pid=2202),
    "c-worker": _detail("c-worker", "shopstack-worker-1", API, "running", "", 2, "any", 0,
                        NOW_MS - 6 * 3600_000, networks=[_net("shopstack_default", "172.18.0.12")], pid=2303),
    "c-db": _detail("c-db", "shopstack-db-1", PG, "running", "healthy", 0, "always", 1024 ** 3,
                    NOW_MS - 6 * 86400_000,
                    mounts=[{"source": "pgdata", "destination": "/var/lib/postgresql/data", "mode": "rw", "kind": "volume"}],
                    networks=[_net("shopstack_default", "172.18.0.13")], pid=2404),
    "c-redis": _detail("c-redis", "shopstack-redis-1", REDIS, "running", "", 0, "always", 0,
                       NOW_MS - 6 * 86400_000,
                       mounts=[{"source": "redisdata", "destination": "/data", "mode": "rw", "kind": "volume"}],
                       networks=[_net("shopstack_default", "172.18.0.14")], pid=2505),
    "c-migrate": _detail("c-migrate", "shopstack-migrate-1", API, "exited", "", 0, "no", 0,
                         NOW_MS - 2 * 3600_000 - 300_000, finished_ms=NOW_MS - 2 * 3600_000,
                         networks=[_net("shopstack_default", "172.18.0.15")], pid=4),
    "c-backup": _detail("c-backup", "shopstack-backup-1", ALPINE, "exited", "", 0, "no", 0,
                        NOW_MS - 2 * 3600_000 - 60_000, finished_ms=NOW_MS - 2 * 3600_000,
                        mounts=[{"source": "pgdata", "destination": "/backup", "mode": "rw", "kind": "volume"}],
                        networks=[_net("shopstack_default", "172.18.0.16")], pid=5, exit_code=3),
}

# One second of the shared Activity stream: 5 running members, api at 97.7% of its limit.
MIB = 1024 ** 2
STATS = [
    {"id": "c-web", "name": "shopstack-web-1", "cpu": 1.2, "mem": 120 * MIB, "mem_limit": 512 * MIB, "mem_pct": 23.4},
    {"id": "c-api", "name": "shopstack-api-1", "cpu": 9.4, "mem": 500 * MIB, "mem_limit": 512 * MIB, "mem_pct": 97.7},
    {"id": "c-worker", "name": "shopstack-worker-1", "cpu": 2.1, "mem": 210 * MIB, "mem_limit": 0, "mem_pct": 0},
    {"id": "c-db", "name": "shopstack-db-1", "cpu": 3.3, "mem": 380 * MIB, "mem_limit": 1024 * MIB, "mem_pct": 37.1},
    {"id": "c-redis", "name": "shopstack-redis-1", "cpu": 0.2, "mem": 28 * MIB, "mem_limit": 0, "mem_pct": 0},
]

STATUS = {"profile": "default", "running": True, "runtime": "docker", "kubernetes": False, "arch": "aarch64"}
TOOLS = {"colima": True, "docker": True, "lima": True, "nerdctl": False, "compose": True, "ramalama": False,
         "krunkit": False, "podman": False, "kubectl": False, "host_arch": "arm64"}
PROFILES = [{"name": "default", "status": "Running", "arch": "aarch64", "cpus": 4,
             "memory": 6 * 1024 ** 3, "disk": 60 * 1024 ** 3, "runtime": "docker", "address": ""}]

DATA = {
    "containers": CONTAINERS, "images": IMAGES, "volumes": VOLUMES, "volumeSizes": VOLUME_SIZES,
    "netMap": NET_MAP, "compose": COMPOSE, "details": DETAILS, "stats": STATS, "status": STATUS,
    "tools": TOOLS, "profiles": PROFILES, "imageBytes": IMAGE_BYTES, "imageArch": IMAGE_ARCH,
    "imageDigest": IMAGE_DIGEST,
    "now": NOW_MS,
}

STUB_JS = r"""
const DATA = __DATA__;
window.__calls = [];
window.__TAURI_INTERNALS__ = {
  transformCallback: (cb) => { const id = Math.floor(Math.random() * 1e9); window['_' + id] = cb; return id; },
  convertFileSrc: (p) => p,
  invoke: async (cmd, args) => {
    window.__calls.push(cmd);
    const id = args && (args.id || args.name);
    switch (cmd) {
      case "list_profiles_cmd": return DATA.profiles;
      case "status_cmd": return DATA.status;
      case "system_status_cmd": return DATA.tools;
      case "list_containers_cmd": return DATA.containers;
      case "list_images_cmd": return DATA.images;
      case "image_platforms_cmd": return DATA.images.map((i) => ({ id: i.id, architecture: DATA.imageArch[i.id],
        digest: DATA.imageDigest[i.id] }));
      case "list_volumes_cmd": return DATA.volumes;
      case "list_networks_cmd": return DATA.netMap.map((n) => ({ name: n.name, driver: n.driver, scope: n.scope }));
      case "network_map_cmd": return DATA.netMap;
      case "compose_list_cmd": return DATA.compose;
      case "volume_sizes_cmd": return DATA.volumeSizes;
      case "disk_usage_cmd": return { images: 912000000, containers: 4000000, volumes: 352000000, build_cache: 250000000, total: 1518000000, reclaimable: 260000000 };
      case "podman_disk_usage_cmd": return { images: 0, containers: 0, volumes: 0, reclaimable: 0 };
      case "cleanup_report_cmd": return { containers: [], images: [], volumes: [], build_cache: [], log_files: [], host_disk: 500000000000, root_total: 60000000000, root_used: 20000000000, totals: { images: 912000000, containers: 4000000, volumes: 352000000, build_cache: 250000000 } };
      case "container_detail_cmd": return DATA.details[id] || null;
      // Same fixture, batched: the project page reads every member in one call.
      case "container_details_cmd": return (args && args.ids ? args.ids : []).map((i) => DATA.details[i]).filter(Boolean);
      case "image_detail_cmd": {
        const img = DATA.images.find((i) => i.id === id || `${i.repository}:${i.tag}` === id);
        if (!img) throw new Error("No such image: " + id);
        return { id: img.id, tags: [`${img.repository}:${img.tag}`], digests: ["sha256:" + "ab".repeat(32)],
          size: DATA.imageBytes[img.id], created: "2026-11-16T09:00:00Z", architecture: DATA.imageArch[img.id],
          os: "linux", author: "", entrypoint: "", cmd: "", workdir: "", user: "", env_count: 0, env: [],
          labels: [], exposed_ports: [], volumes: [], layers: 9, history: [] };
      }
      case "volume_detail_cmd": return { name: id, driver: "local", mountpoint: "/var/lib/docker/volumes/" + id + "/_data",
        created: "2026-11-12T09:00:00Z", scope: "local", labels: [], options: [], size: (DATA.volumeSizes.find((v) => v.name === id) || {}).size ?? null };
      case "network_detail_cmd": {
        const n = DATA.netMap.find((x) => x.name === id) || DATA.netMap[0];
        return { id: n.id, name: n.name, driver: n.driver, scope: n.scope, internal: n.internal,
          enable_ipv6: false, subnet: n.subnet, gateway: n.gateway, ip_range: "", labels: [], options: [],
          created: "2026-11-12T09:00:00Z", containers: n.containers };
      }
      case "container_logs_cmd": case "podman_container_logs_cmd": return "2026-11-18T10:00:00Z ready\n";
      case "stats_all_start_cmd": {
        const ch = args && args.onSample;
        if (!ch || !ch.onmessage) return "polling";
        if (window.__activity) clearInterval(window.__activity);
        let tick = 0;
        const emit = () => {
          tick += 1;
          for (const s of DATA.stats) {
            ch.onmessage(JSON.stringify({ ...s, pids: 8, net_rx: 4096 * tick, net_tx: 1024 * tick,
              block_read: 8192, block_write: 4096 }));
          }
        };
        emit();
        window.__activity = setInterval(emit, 1000);
        return "streaming";
      }
      case "stats_all_stop_cmd":
        if (window.__activity) { clearInterval(window.__activity); window.__activity = null; }
        return "stopped";
      case "container_stats_cmd": case "container_stats_one_cmd":
        return DATA.stats[0];
      case "vm_diagnostics_cmd": return { ok: true, error: "", cpus: 4, load1: 0.4, load5: 0.3, load15: 0.2,
        mem_total: 6442450944, mem_used: 1288490188, disk_total: 64424509440, disk_used: 21474836480,
        kernel: "6.8.0", uptime: 200000, rosetta_active: true, oom_kills: 0, nvidia: null, swap_total: 0,
        swap_free: 0, inodes_total: 0, inodes_used: 0, mem_available: 5153960756, root_total: 0, root_used: 0,
        docker_active: true, guest_arch: "aarch64", host_arch: "arm64", booted_at: 0, guest_agent: true };
      case "k8s_cluster_cmd": return { context: "colima", enabled: false, reachable: false, version: null,
        nodes: 0, nodes_ready: 0, pods: 0, pods_running: 0, deployments: 0, deployments_ready: 0,
        namespaces: [], error: null, read_at: null };
      case "k8s_resources_cmd": return [];
      case "app_release_cmd": return { installed: "1.5.1", latest: null, update_available: false, url: "" };
      case "version_check_cmd": case "template_cmd": case "ssh_config_cmd": case "version_cmd": return "";
      case "profile_config_cmd": return null;
      case "lima_vms_cmd": case "podman_machines_cmd": case "podman_containers_cmd":
      case "podman_images_cmd": case "podman_volumes_cmd": case "podman_networks_cmd":
      case "model_serve_status_cmd":
        return [];
      default: return null;
    }
  },
};
// Frozen clock: relative ages ("6d", "20 minutes ago") must not drift between runs.
Date.now = () => DATA.now;
"""

EXTRACT_JS = r"""() => {
  const root = document.querySelector('.investigator');
  const norm = (s) => (s || '').replace(/\s+/g, ' ').trim();
  const full = norm(root ? root.innerText : '');
  const heads = [...document.querySelectorAll('.investigator h3, .investigator .inv-group-title')].map((e) => norm(e.textContent));
  const rowSel = '.inv-row, .inv-pair, .inv-member-row, tbody tr, .cd-chip, .inv-metric, .trend-card';
  return {
    rendered: !!root,
    full,
    heads,
    rows: document.querySelectorAll(rowSel).length,
    panels: document.querySelectorAll('.investigator .panel').length,
    calls: (window.__calls || []).slice(),
  };
}"""

# Each signal is a list of groups; a signal scores when EVERY group has at least one pattern
# matching the page text. Patterns are deliberately value-based (a fact a user can act on),
# not markup-based, so any layout that shows the fact earns the point.
SIGNALS: list[tuple[str, list[list[str]]]] = [
    ("image_footprint", [[r"\b912\s?MB\b"]]),
    ("unique_images", [[r"[Ii]mages[^.]{0,14}\b(?:4|5)\b", r"\b(?:4|5)\b[^.]{0,14}[Ii]mages"]]),
    ("host_share", [[r"(?:of|/|vs\.?)\s*6(?:\.0)?\s?GiB", r"\b6(?:\.0)?\s?GiB[^.]{0,20}(?:VM|host|total)"]]),
    ("restart_total", [[r"\b16\b[^.]{0,30}restart", r"restart[^.]{0,30}\b16\b"]]),
    ("health_unhealthy", [[r"\bapi\b"], [r"unhealthy"]]),
    ("no_healthcheck", [[r"(?:no|without|missing|none)[^.]{0,26}health ?check"]]),
    ("oom_flagged", [[r"\bOOM\b"]]),
    ("memory_pressure", [[r"\b9[7-9](?:\.\d)?\s?%", r"\b100\s?%\s*of"]]),
    ("exit_code", [[r"migrate"], [r"exit(?:ed)?\s*\(?0\)?", r"code\s*0"]]),
    ("oldest_uptime", [[r"\b6d\b"]]),
    ("config_path", [[r"compose\.ya?ml"]]),
    ("network_topology", [[r"shopstack_default"], [r"\b7\b"]]),
    ("port_collision", [[r"8080"], [r"\bblog\b"]]),
    ("shared_volume", [[r"pgdata[^.]{0,30}\b2\b", r"\b2\b[^.]{0,30}pgdata"]]),
    ("volume_sizes", [[r"\b340\s?MB\b"]]),
    ("bind_path", [[r"/Users/dev/shopstack/site"]]),
    ("image_digest", [[r"sha256:[0-9a-f]{16}"]]),
    ("image_platform", [[r"arm64"]]),
    ("missing_image", [[r"alpine:3\.20"], [r"not (?:local|pulled|present)|missing image|absent locally"]]),
    ("restart_policy", [[r"on-failure"]]),
]

# Commands that cost a CLI round-trip per object; counted only while the group page renders.
PROBE_COMMANDS = {"container_detail_cmd", "image_detail_cmd", "volume_detail_cmd",
                  "network_detail_cmd", "image_platforms_cmd", "volume_sizes_cmd",
                  "network_map_cmd", "container_stats_one_cmd"}


def free_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def chrome_path() -> str:
    override = os.environ.get("PROBE_CHROME")
    if override:
        return override
    cache = Path.home() / "Library/Caches/ms-playwright"
    for pattern in ("chromium_headless_shell-*/chrome-headless-shell-mac-arm64/chrome-headless-shell",
                    "chromium-*/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing"):
        found = sorted(cache.glob(pattern))
        if found:
            return str(found[-1])
    raise SystemExit("no cached Chromium found; set PROBE_CHROME")


def score(full: str) -> tuple[list[str], list[str]]:
    passed, failed = [], []
    for name, groups in SIGNALS:
        ok = all(any(re.search(pat, full, re.I) for pat in group) for group in groups)
        (passed if ok else failed).append(name)
    return passed, failed


def run(verbose: bool) -> int:
    try:
        from playwright.sync_api import sync_playwright
    except ImportError:
        raise SystemExit("playwright for Python is not installed (pip install playwright)")

    if not (DIST / "index.html").exists():
        raise SystemExit("dist/ is missing; run `npm run build` first")

    port = free_port()
    server = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--directory", str(DIST)],
                              stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    time.sleep(0.8)
    try:
        with sync_playwright() as p:
            browser = p.chromium.launch(executable_path=chrome_path())
            ctx = browser.new_context(viewport={"width": 1440, "height": 1000}, device_scale_factor=2,
                                      color_scheme="dark")
            pg = ctx.new_page()
            pg.add_init_script(STUB_JS.replace("__DATA__", json.dumps(DATA)))
            errors: list[str] = []
            pg.on("pageerror", lambda e: errors.append(str(e)[:200]))
            pg.goto(f"http://localhost:{port}/", wait_until="load")
            pg.evaluate("""() => {
              localStorage.setItem('runtimeDesk.onboarded', '1');
              localStorage.setItem('runtimeDesk.layoutVersion', '3');
              localStorage.setItem('runtimeDesk.widgets', JSON.stringify({recent: true}));
            }""")
            pg.reload(wait_until="load")
            pg.wait_for_timeout(1200)
            try:
                pg.get_by_role("button", name=re.compile(r"^Sherlock\b")).first.click(timeout=4000)
                pg.wait_for_selector('.picker-row[title="shopstack"]', timeout=4000)
            except Exception as exc:  # noqa: BLE001 - harness cannot run
                raise SystemExit(f"could not open Sherlock's picker: {str(exc)[:200]}")
            pg.wait_for_timeout(300)
            pg.evaluate("window.__calls = []")
            started = time.monotonic()
            pg.locator('.picker-row[title="shopstack"]').first.click(timeout=4000)
            # Settle: DOM text, row count and IPC calls all quiet for 400 ms (cap 10 s).
            last, quiet = None, 0
            for _ in range(100):
                pg.wait_for_timeout(100)
                snap = pg.evaluate("""() => {
                  const root = document.querySelector('.investigator');
                  return [root ? root.innerText.length : 0,
                          document.querySelectorAll('.investigator .panel, .investigator .inv-row, .investigator .inv-member-row').length,
                          (window.__calls || []).length];
                }""")
                key = tuple(snap)
                quiet = quiet + 1 if key == last else 0
                last = key
                if quiet >= 4:
                    break
            render_ms = round((time.monotonic() - started) * 1000)
            report = pg.evaluate(EXTRACT_JS)
            ctx.close()
            browser.close()
    finally:
        server.terminate()

    if not report.get("rendered"):
        raise SystemExit("group page did not render")

    full = report["full"]
    passed, failed = score(full)
    ops = sum(1 for c in report["calls"] if c in PROBE_COMMANDS)

    print(f"METRIC group_signals={len(passed)}")
    print(f"METRIC group_rows={report['rows']}")
    print(f"METRIC group_probe_ops={ops}")
    print(f"METRIC group_render_ms={render_ms}")
    print(f"ASI signals_failed={','.join(failed) or '-'}")
    print(f"ASI signals_passed={','.join(passed) or '-'}")
    print(f"ASI panels={','.join(h[:40] for h in report['heads'][:14]) or '-'}")
    if errors:
        print(f"ASI console_errors={' | '.join(errors[:3])}")
    if verbose:
        print("--- rendered ---")
        print(full)
    return 0


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--verbose", action="store_true", help="print the rendered group-page text")
    args = ap.parse_args()
    sys.exit(run(args.verbose))


if __name__ == "__main__":
    main()
