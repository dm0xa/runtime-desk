# Contributing to Runtime Desk

## Before you start

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) — module boundaries, dependency gates.
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) — setup, scripts, release builds.
- [docs/USAGE.md](docs/USAGE.md) — read before changing a screen.

## Setup

```sh
git clone https://github.com/dm0xa/runtime-desk.git
cd runtime-desk
npm install
npm run tauri dev
```

Needs Rust stable, Node.js 20.19+ (or 22.12+), and Xcode Command Line Tools. Colima and the Docker CLI are for manual testing; the probe needs neither.

Vite serves on port 1422 (`strictPort`); `src-tauri/tauri.conf.json`'s `devUrl` must match — change both together.

## Pull requests

One concern per pull request. Describe what changed, why, and how you verified it — name the Colima profile, runtime, and tools, and paste the `check:commands` result if you touched an `invoke` call.

Gated features: name the gate you exercised and the state when the tool is missing or the profile is stopped; a closed gate renders a prerequisite panel (`__blocked`, `__waiting`, `__podman-waiting`), never an empty table.

## Code conventions

- TypeScript is strict: no `as any`, typed accessors.
- Rust commands are `#[tauri::command] fn <name>_cmd`. Shell-outs are `async` via `blocking(...)`; state-only ones (`set_profile_cmd`, channel handles, `open_url_cmd`) stay synchronous.
- Register commands in `tauri::generate_handler!` (`src-tauri/src/lib.rs`); `npm run check:commands` fails on an unregistered command or an `invoke` with no handler.
- New features go through `src/dependencies.ts` (`FEATURES` + `featureGate`), not local `if (!tools.x)` checks.
- `src/lib/activity.ts` alone polls stats every 2 seconds; views subscribe to its snapshot.
- Table action buttons go in `<div className="actions">`, never on the `<td>`.
- Persisted keys use the `runtimeDesk.` prefix.

## Checks

```sh
npx tsc --noEmit
npm run build
npm run check:commands
cd src-tauri && cargo test
```

`npm run check:commands` (96 backend commands today) diffs every `#[tauri::command]` signature in `src-tauri/src/lib.rs` against every `"<name>_cmd"` reference and literal `invoke` payload under `src/`, failing on an unhandled command, a dead one, or a key missing from the payload; `--self-test` proves it catches both.

For layout and degraded-state work, render the built frontend headlessly: no container engine, no cluster, no Screen Recording grant.

```sh
npm run build                           # the probe serves dist/
python3 scripts/headless_probe.py --list
python3 scripts/headless_probe.py --state stopped --page containers --shots
python3 scripts/headless_probe.py --gate  # 17 states × 17 pages × 900/1280/1600, ~5 min
```

`--gate` exits non-zero on clipped chrome, a control in the webview's default font, page overflow, or a console error. It needs `playwright` and one cached Chromium.

## Documentation

Update the matching file when behavior changes:

- `README.md` for setup, requirements, shortcuts;
- `CHANGELOG.md` when a user-visible change ships;
- `docs/USAGE.md` for screen behavior;
- `docs/ARCHITECTURE.md` for internals;
- `docs/ROADMAP.md` when an item ships.

## Code of conduct

Be kind. Assume good faith. Discuss the change, not the person.

## Licensing of contributions

Runtime Desk is GPL-3.0-only (full text in [LICENSE](LICENSE)). Contributing licenses your work under the same terms (inbound = outbound) unless you say otherwise before merge. Vendored code must be GPLv3-compatible: MIT, BSD, ISC and Apache-2.0 are; proprietary sources, SSPL, and GPLv2-only code are not. Pasted code keeps its own notice.
