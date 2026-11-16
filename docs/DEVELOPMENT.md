# Development

## Prerequisites

- macOS (Apple Silicon or Intel)
- [rustup](https://rustup.rs) with a stable toolchain
- Node.js 20.19+ or 22.12+ and npm
- Xcode Command Line Tools: `xcode-select --install`
- Colima and the Docker CLI for manual testing

```sh
rustc --version
cargo --version
node --version
npm --version
```

A broken `~/.cargo/bin` symlink usually explains a missing `cargo`.

## Setup

```sh
git clone https://github.com/dm0xa/runtime-desk.git
cd runtime-desk
npm install
```

```sh
npm run tauri dev
```

First Rust build takes minutes; later runs recompile only changes.

## Scripts

| Command | What it does |
|---|---|
| `npm run tauri dev` | Vite plus the app; Rust changes restart it, frontend hot-reloads |
| `npm run dev` | Vite only, for layout/CSS; `invoke` fails without Tauri |
| `npm run build` | Type-checks with `tsc`, builds the frontend |
| `npm run preview` | Serves the built frontend; still no Tauri |
| `npm run tauri build` | `Runtime Desk.app` only |
| `npm run bundle` | The app plus the Finder-laid-out disk image |
| `npm run check:commands` | Diffs every `invoke` against the Rust signatures: names, payload keys |

```sh
cd src-tauri
cargo build
cargo test
```

Vite fails instead of picking another port when 1422 is taken (`strictPort: true`); `devUrl` must match.

## Checks before a pull request

```sh
npx tsc --noEmit
npm run build
npm run check:commands      # command names + invoke payload shapes
cd src-tauri && cargo test
python3 scripts/headless_probe.py --gate   # every state x page x 3 widths, ~5 min
```

No frontend test suite, linter, or formatter: match the surrounding code; TypeScript is strict about unused locals and parameters.

Rust tests cover parsers, command builders, and profile/machine/context selection; some touch local tools, so start a Colima profile before rerunning a daemon-dependent failure.

Most behavior is a CLI call plus rendering: name the profile, tools, and clicks.

### Command surface checks

`invoke` is untyped both ways, so two bugs survive `tsc` and `cargo`: a nonexistent command name,
and payload keys that do not match the handler's parameters.
`stop_cmd(profile: String)` called as `invoke("stop_cmd", { opts: { profile } })` compiles, then Tauri
rejects it at the click; three call sites shipped that way.

`npm run check:commands` (or `python3 scripts/check_commands.py`) reads the `#[tauri::command]`
signatures in `src-tauri/src/lib.rs` and every `"<name>_cmd"` reference and `invoke("…", { … })`
payload under `src/`, failing on a name mismatch, a dead handler, or a missing or invented key.
camelCase and snake_case are normalised; `tauri::State`/`AppHandle`/`Window` parameters are skipped;
variable and spread payloads are unchecked; `--self-test` proves a wrong shape and unknown name
still fail. Today: 94 commands, 94 call sites, 0 problems, 13 unchecked.

### Headless layout and state checks

Failed states (no profile, no tools, a stopped daemon or Podman machine) are unreachable on a
healthy machine, and screenshotting needs a Screen Recording grant, so
`scripts/headless_probe.py` stubs `window.__TAURI_INTERNALS__` over the built frontend:

```sh
npm run build                                   # the probe serves dist/
python3 scripts/headless_probe.py --list        # 17 states, 17 pages
python3 scripts/headless_probe.py --all --state stopped --width 900 --width 1280
python3 scripts/headless_probe.py --state no-tools --page dashboard --shots --out /tmp/probe
python3 scripts/headless_probe.py --gate   # every state x page x 900/1280/1600, exit 1 on a regression (~5 min)
```

Outside `--gate` it prints per-page JSON at each width for dashboard, the four Docker lists, activity,
sherlock, cleanup, machine, kubernetes, the five Podman pages, Settings · Sidebar and About: clipped
chrome (nav labels, headers, buttons; table cells ellipsize by design), `Arial`/`Times` violations,
page and table overflow, nav groups, row/chip/notice counts, page text, console errors,
and About's column width and link labels. States live in `STATES`; add one there. Needs Python
`playwright` and a cached Chromium (`PROBE_CHROME`, `PROBE_PORT`; `--fresh` keeps the wizard).
Persisted keys (`runtimeDesk.onboarded`, `runtimeDesk.layoutVersion` — the current `LAYOUT_VERSION` —
`runtimeDesk.widgets`) are written after the first load, then the page reloads: an init script can
land after the module script read `localStorage`. Reports carry the first data row's cell widths, so
a collapsing column is a number. `--gate` runs four states at a time and fails on clipped chrome,
a UA control font, page overflow or a console error; only `--fresh` opens an overlay (`modal` text).
Other dialogs (New profile, Prune, Resources, Pull image, Delete): click the trigger, or print
`REPORT_JS().modal` from a throwaway Playwright page.

## Code conventions

### TypeScript and React

- `strict` is on, `any` is unused; prefer a typed per-table accessor over a cast.
- Backend payloads use snake_case; keep `src/types.ts` aligned with the Rust structs.
- Tables use `<div className="actions">` inside a cell; `actions` on a `<td>` replaces its table-cell layout.
- The theme is CSS variables in `src/App.css`, light and dark under `prefers-color-scheme`.
- Fonts are Inter and JetBrains Mono, self-hosted in `public/fonts/` as `inter-var.woff2` and
  `jetbrains-mono-var.woff2`, `@font-face`d in `src/App.css`, preloaded from `index.html`.

### Rust

- Shelling commands are `async`, wrapped in `blocking(...)`; a synchronous `Command::output()` freezes the webview.
- Never call `Command::output()` directly. Go through `proc::run(cmd, limit)`, which drains both pipes on threads and kills the child at the deadline: a wedged daemon would otherwise park the caller for good, and enough parked callers drain the blocking pool until the window needs a force quit. `proc::READ_LIMIT` (20 s) is for lists, status, inspect and log tails; `proc::ACTION_LIMIT` (120 s) for start/stop/remove/prune of a container or network; `proc::NO_LIMIT` for what legitimately takes minutes with no interim output — `docker pull`, `colima start`, `podman machine start`, and the guest scans behind Cleanup.
- Pass arguments as arrays; never build shell strings.
- Register new commands in `tauri::generate_handler!` or the frontend cannot call them.
- Prefer an empty list for optional tools; errors are for what the user can act on. An optional plugin (compose) must never gate a required list.
- Keep CLI parsing in the module that owns that CLI and unit-test non-obvious parsers.

### Dependency gates

Requirements live in `src/dependencies.ts`. No one-off `if (!tools.x)`: `featureGate(...)` decides rendering, fetching, polling, and whether an action is enabled. Rules in [ARCHITECTURE.md](ARCHITECTURE.md#dependency-gates).

### Activity polling

Only `src/lib/activity.ts` owns the 2-second `docker stats` poll; `App.tsx` calls `setActivityActive(...)`. Views subscribe with `subscribeActivity`, never their own interval.

### Notices

Mutations go through `act()`, which shows a notice and refreshes; failures go through `humanizeDockerError`, turning short IDs into names with a recovery step. No separate error banner for CLI failures.

### Local persistence

New `localStorage` keys use the `runtimeDesk.` prefix. Bump `LAYOUT_VERSION` when the default card composition changes, so old layouts leave no invisible or misplaced cards.

## Adding a command

1. Implement the function in the module that owns the CLI: `colima.rs`, `docker.rs`, `podman.rs`, `k8s.rs`, `cleanup.rs`, or `tools.rs`.
2. Add an `async fn ..._cmd` in `lib.rs` wrapped in `blocking(...)`.
3. Register it in `tauri::generate_handler!`.
4. Add the request/response type to `src/types.ts` if needed.
5. Call it with `invoke("..._cmd", { ... })`.

If gated, reuse the `dependencies.ts` feature and check the gate first.

## Adding a dashboard card

1. Add a file to `src/components/dashboard/cards/` named after the card's key in kebab-case; the filename is the key.
2. Default-export a `DashboardCard` with `label`, `description`, `span`, `minSpan`, `maxSpan`, `order`, `render`; `defaultVisible: false` starts hidden.
3. Read only from `DashboardContext`.
4. Bump `LAYOUT_VERSION` if the default visible set or order changes.

`registry.ts` globs the folder at build time (`import.meta.glob(..., { eager: true })`) and sorts by `order`; nothing else needs editing. Template: [DASHBOARD.md](DASHBOARD.md).

## Release builds

```sh
npm run bundle
```

Output lands in `src-tauri/target/release/bundle/`: `macos/Runtime Desk.app` and
`dmg/Runtime Desk_<version>_<arch>.dmg`. `src-tauri/tauri.conf.json` holds the product name
`Runtime Desk`, identifier `io.github.dm0xa.runtimedesk`, target `app` (the image comes from
`src-tauri/dmg/build.sh`), and a 1300×820 window with a 900×600 minimum. Nothing is signed or
notarized, so first launch may show a Gatekeeper prompt ([ROADMAP.md](ROADMAP.md)). Keep the version
equal in `package.json`, `src-tauri/tauri.conf.json`, and `src-tauri/Cargo.toml`.

### Disk image

Opens as the usual install window: background picture, app left, `Applications` right, arrow
between, nothing else. `src-tauri/dmg/build.sh` guarantees that.

It stages the bundle with an `Applications` link and the background, makes a read-write HFS+ image,
drives Finder for the layout (660×400 at `{420, 220}`, 128 pt icons with 13 pt labels, the picture as
folder background, icon centres `{180, 170}` and `{480, 170}`), hides `.VolumeIcon.icns`, and
compresses; it fails if Finder wrote no `.DS_Store` or positions differ from the background's.

Tauri's bundler is not used: its Finder pass addresses `disk "Runtime Desk"`, so a miss yields a
plain three-item window with no failure; `hdiutil create` inside it intermittently returns
"Resource busy" here. Finder also stores icons 45 pt lower than AppleScript reports on a fresh image,
below the arrow, so `build.sh` measures what was stored, re-lays it out with the difference
subtracted, and repeats until the positions match.

- Building needs a logged-in GUI session (it drives Finder) and one-time terminal Automation permission (System Settings → Privacy & Security → Automation).
- A `Runtime Desk` volume left mounted takes the name; `scripts/bundle.sh` detaches it first.

Background, generated:

```sh
python3 -m pip install pillow
python3 scripts/make-dmg-background.py
```

That writes `background.png` (660×400) and `background@2x.png` (1320×800, preferred on Retina) from
`build.sh`'s geometry: arrow at y = 170 between the centres, caption in the top 300 pt.

### App icon

Source icon: `src-tauri/icons/app-icon.png`. Regenerate the platform set:

```sh
npx tauri icon src-tauri/icons/app-icon.png
```

## Troubleshooting

### `cargo` is not found or fails immediately

Use rustup's toolchain:

```sh
rustup which cargo
export PATH="$(dirname "$(rustup which cargo)"):$PATH"
```

Then retry `npm run tauri dev`.

### Port 1422 is already in use

Vite fails rather than pick another port; stop that process or update `vite.config.ts` and `build.devUrl` in `src-tauri/tauri.conf.json`.

### `invoke` fails in the browser

`npm run dev` has no Rust side; use `npm run tauri dev` to read data.

### A CLI works in the terminal but not in the app

Finder launches may miss your shell's `PATH`; the backend falls back to `/opt/homebrew/bin/colima`. Launch from a terminal where tools resolve, or check `which <tool>`.

### The app opens with missing sections

Finish or rerun the setup wizard, then press **Refresh** (⌘R). The cached probe stops the sidebar flashing; a refresh replaces it.

### Rust tests fail on tool probes

The `tools` tests call the local Docker installation best-effort; start a Colima profile and rerun.

## Documentation

Adding a screen or action updates the user guide in the same pull request:
[README.md](../README.md), [CHANGELOG.md](../CHANGELOG.md), [USAGE.md](USAGE.md),
[ARCHITECTURE.md](ARCHITECTURE.md), [DASHBOARD.md](DASHBOARD.md), [ROADMAP.md](ROADMAP.md),
[DESIGN.md](../DESIGN.md), [PRODUCT.md](../PRODUCT.md).
