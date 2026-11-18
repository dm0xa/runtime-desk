---
name: Runtime Desk
description: A macOS console for local containers — Colima profiles, Docker, Podman machines and Lima VMs in one window.
colors:
  canvas: "#f2f2f4"
  sidebar: "#e9e9ec"
  panel: "#ffffff"
  panel-raised: "#f5f5f7"
  rail: "#ffffff"
  sidebar-dark: "#232325"
  panel-dark: "#2c2c2e"
  panel-raised-dark: "#3a3a3c"
  hover: "#ececf0"
  separator: "rgba(0, 0, 0, 0.09)"
  ink: "#1d1d1f"
  ink-muted: "#6e6e73"
  signal: "#22c55e"
  signal-hover: "#16a34a"
  signal-ink: "#04140a"
  signal-ink-ring: "rgba(4, 20, 10, 0.14)"
  link: "#047857"
  link-dark: "#58a6ff"
  focus-ring: "#15803d"
  focus-ring-dark: "#4ade80"
  red: "#ef4444"
  red-solid: "#b91c1c"
  danger: "#b91c1c"
  danger-fill: "rgba(248, 81, 73, 0.12)"
  warning: "#92400e"
  warning-dark: "#d29922"
  warning-fill: "rgba(210, 153, 34, 0.12)"
  violet-dark: "#a78bfa"
  overlay: "rgba(0, 0, 0, 0.55)"
typography:
  metric-lg:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "30px"
    fontWeight: 600
    lineHeight: 1.1
  metric:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "26px"
    fontWeight: 600
    lineHeight: 1.15
  metric-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "24px"
    fontWeight: 700
    lineHeight: 1.2
  title:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.2
  headline:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "20px"
    fontWeight: 650
    lineHeight: 1.25
  title-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "19px"
    fontWeight: 700
    lineHeight: 1.25
  subhead:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "18px"
    fontWeight: 600
    lineHeight: 1.3
  section-lg:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "17px"
    fontWeight: 600
    lineHeight: 1.35
  section:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.35
  body-lg:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "13.5px"
    fontWeight: 400
    lineHeight: 1.45
  body-md:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "12.5px"
    fontWeight: 400
    lineHeight: 1.45
  body:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.45
  control:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 500
    lineHeight: 1
  label:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "11.5px"
    fontWeight: 500
    lineHeight: 1.4
    letterSpacing: "0"
  label-sm:
    fontFamily: "-apple-system, BlinkMacSystemFont, \"SF Pro Text\", Inter, system-ui, sans-serif"
    fontSize: "10.5px"
    fontWeight: 600
    lineHeight: 1.4
    letterSpacing: "0.06em"
  data:
    fontFamily: "ui-monospace, \"SF Mono\", \"JetBrains Mono\", monospace"
    fontSize: "12px"
    fontWeight: 400
    lineHeight: 1.5
  measurement:
    fontFamily: "ui-monospace, \"SF Mono\", \"JetBrains Mono\", monospace"
    fontSize: "22px"
    fontWeight: 600
    lineHeight: 1.2
rounded:
  hairline: "2px"
  micro: "3px"
  chip: "5px"
  control-sm: "6px"
  control: "6px"
  control-md: "8px"
  control-lg: "9px"
  tile: "8px"
  panel: "10px"
  modal: "12px"
  panel-lg: "12px"
  pill: "999px"
spacing:
  xs: "4px"
  sm: "6px"
  md: "8px"
  lg: "12px"
  xl: "16px"
  xxl: "24px"
components:
  button-primary:
    backgroundColor: "{colors.signal}"
    textColor: "#04140a"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "26px"
  button-primary-hover:
    backgroundColor: "{colors.signal-hover}"
    textColor: "#04140a"
  button-secondary:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "26px"
  button-quiet:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "26px"
  button-danger:
    backgroundColor: "{colors.danger-fill}"
    textColor: "{colors.danger}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "26px"
  input:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    padding: "0 12px"
    height: "26px"
  chip:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.pill}"
    padding: "0 10px"
    height: "24px"
  panel:
    backgroundColor: "{colors.panel}"
    rounded: "{rounded.panel}"
    padding: "16px"
  nav-item:
    backgroundColor: "transparent"
    textColor: "{colors.ink-muted}"
    rounded: "{rounded.control}"
    padding: "0 8px"
    height: "26px"
  nav-item-active:
    backgroundColor: "rgba(34, 197, 94, 0.20)"
    textColor: "{colors.ink}"
---

# Design System: Runtime Desk

## Overview

**Creative North Star: "The Instrument Panel"**

Runtime Desk is a console, not a dashboard product: one Colima profile's VM, and whichever Podman machine the toolbar names. Legible at a glance; out of the way of the terminal work it replaces. Surfaces quiet, separators hairlines, colour a signal — green for live, red for destructive or failed, everything else ink.

SF Pro carries language, SF Mono carries measurement. Numbers, sizes, ports, IDs, timestamps, commands: `ui-monospace` (SF Mono on macOS), tabular figures. Labels, prose, controls: `-apple-system`. Inter and JetBrains Mono are bundled fallbacks only, so a blocked network never changes how the product looks. Density deliberate: a mouse-and-keyboard tool, not a marketing page.

**Key Characteristics:**
- Quiet chrome: transparent controls, surface on hover only.
- Green as state: live, running, published, selected — never a section background.
- Mono for anything measured or copied; sans for anything read.
- Hairline separations, not borders and card stacks.
- Native window: overlay title bar, traffic lights over the sidebar, 52px unified toolbar, real menu bar, backdrop-blurred chrome.
- Keyboard-first: soft accent focus ring everywhere, `⌘K`/`⌘F`, `⌘1–9` plus `⌘0` for the last screen, `⌘R`, `⌘,`, `⌘[`, `⌘⌥S`, `Esc`, `?`.

## Colors

Two themes, one accent. Light default; dark is the GitHub-dark console.

### Primary
- **Signal Green** (#22c55e): the only accent — primary buttons, running state, active sidebar item, accent focus ring. Hover #16a34a light, #4ade80 dark.
- **Ink** (--text: #1d1d1f / #f5f5f7). **Ink Muted** (--muted: #6e6e73 / #9d9da2): labels, secondary values, inactive nav.

### Semantic text
- **Green Text** (#047857 / #4ade80), **Amber Text** (#92400e / #d29922), **Danger Text** (#b91c1c / #f85149): prose and figures on white or a 12–14% tint of their own hue, a step darker than the raw signal so each clears 4.5:1 at 11–13px; raw tones only fills, dots, outlines.
- **Link** (#047857 light, #58a6ff dark): clickable names, never bare signal green.

### Neutral
- **Canvas** (#f2f2f4 / #1c1c1e): window ground. **Sidebar** (#e9e9ec at 76% / #232325 at 78%): translucent, inset hairline between.
- **Panel** (#ffffff / #2c2c2e): cards, tables, modals. **Panel Raised** (#f5f5f7 / #3a3a3c): control fills, metric tiles, table headers.
- **Hover** (#ececf0 / #3f3f42): second step of a control hover; sidebar and toolbar hovers use ink at 6–8%.
- **Separator** (0.09 alpha black / white): dividers, inset rings, table rules, 0.5px at a window edge.
- **Toolbar / status material** (`--glass-bar`: panel 74–76%), blurred `saturate(180%) blur(24px)`.

### Named Rules
**The Green Is A Signal Rule.** Green marks live state or the single primary action — never decoration, never a selection in a destructive flow. Destructive selection: neutral raised surface with a checkbox; only the confirm is red.

**The Red Is Failure Or Armed Rule.** Red means error or armed destruction. Stopped container, absent optional tool, unselected destructive option: neutral ink.

**The Two-Theme Rule.** Every colour declared for both themes in `src/App.css`. A token without a dark value is a bug.

## Typography

**Display / Body Font:** `-apple-system` / SF Pro Text (macOS 11+), Inter as the bundled fallback (`/fonts/inter-var.woff2`)
**Measurement / Code Font:** `ui-monospace` / SF Mono, JetBrains Mono as the bundled fallback (`/fonts/jetbrains-mono-var.woff2`)


### Hierarchy
- **Title** (600, 15px, 1.2): the current section in `.topbar h1`. One per window; 22px exists only as a metric value.
- **Section** (600, 15px, 1.35): panel headings (`.panel h3`).
- **Body** (400, 12.5–13px, 1.45): descriptions, table cells (13px, tabular), related rows.
- **Sidebar** (400, 13px in 26px rows; selected 500): nav and profile rows, **+ Create new profile** in `--text` not `--muted` — greying every row read a size too small. Group headers 11px/600 `--muted`, 10.5px/500 source hint right; counter badges 11px/500.
- **Control** (500, 13px): buttons; inputs and selects 12.5px, chips 11.5px.
- **Label** (500, 11.5px, no tracking, sentence case): table headers (`.table th`), card labels. Uppercase 0.06em belongs only to `.strip-label` (10.5px/600) and `.inv-sub-label` (10px/600) — caps tracking on a header row is the web-dashboard tell.
- **Data** (400–600, 11–13px, tabular): `.cell-id` 11px, sizes, ports, timestamps, paths, commands.
- **Measurement** (600, 22–30px, tabular): `.kpi-value` 30px, `.card-value` 26px, `.strip-value` 22px.

### Mono Rules

**The Mono Measures Rule.** Copyable, countable, comparable or column-aligned ⇒ mono and tabular. Prose never.

**The Self-Hosted Rule.** No remote font requests. The window renders identically behind a filtered network.

**The Inherited Control Rule.** `button, input, select, textarea { font-family: inherit }` sits beside `body`. Without it buttons render in the UA control font — Arial in the webview — lighter than SF Pro at the same px, indistinguishable from "the sidebar font is too small".

## Layout

**The Ephemeral First Rule.** Time-sensitive state leads. Running container: Performance first, above the fact columns; stopped: dropped, because Lifecycle already says so. Static identity follows, then logs, then reference lists (environment, labels, build history, volume contents). Nothing live below a static card.

**Window chrome.** `.titleBarStyle: Overlay`, hidden title, webview owns the frame. Traffic lights over the sidebar, which reserves a 38px `.sidebar-grip` for them and for dragging; content column opens with a 52px unified toolbar doubling as the drag region (`data-tauri-drag-region`, `core:window:allow-start-dragging`). Native menu bar carries ⌘N, ⌘R, ⌘F, ⌘, and full screen, each forwarded as one `menu` event.

**The window remembers itself.** `window.json` in the app config dir keeps the frame in screen points — size, position, maximized — and a launch applies it to a window created hidden, with a work-area fit pulling back a frame no monitor holds; last screen and sidebar visibility in `localStorage` on change. View → **Show Sidebar** (⌘⌥S) hides nav and settings rail together, persisting.

- Fixed 224px sidebar, flexible content column, 1300×820 window (minimum 900×600); Settings adds a second column (`clamp(140px, 12vw, 240px)`) beside the nav.
- 8px rhythm: 20px page gutter, 14px under the toolbar, 16px card/panel inset, 12px between panels in a column, 14px between stacked list cards.
- Toolbar title, toolbar icons, status bar and every card and table edge share the 20px gutter; panel headings and card labels sit 16px inside it (content + 36px), a table's first cell 14px inside the table (content + 34px).
- Two vertical lines, never three. Every page uses that gutter, none adds its own, all narrow to 16px below 1100px.
- Header never scrolls: the page body is its own `.page-scroll`, and table views keep one scroll container.
- Sidebar fits seventeen nav rows (six groups) and three profiles at default size; denser content scrolls inside `.side-nav` rather than pushing the profile switcher off the window.

A list is a card, not a page: `.table-wrap` hugs its rows and scrolls only when they run out of window. A 400px card under a 300px gap of canvas is correct; a card stretched to the window floor for five rows reads as an empty template.

Sherlock is a two-column grid (`minmax(0,1.1fr) minmax(0,1fr)`) with full-width panels spanning both below. Below 1100px every two-column surface collapses to one and gutters drop to 16px; the settings rail keeps its labels at every width, tightening item padding only below 1000px.

## Elevation & Depth


### Shadow Vocabulary
- **Surface** (`0 0 0 0.5px rgba(0,0,0,0.07), 0 1px 2px rgba(0,0,0,0.05), 0 8px 22px rgba(0,0,0,0.04)`): panels, cards, table containers.
- **Popover** (`0 0 0 0.5px rgba(0,0,0,0.12), 0 12px 34px rgba(0,0,0,0.18), 0 2px 6px rgba(0,0,0,0.08)`): dropdowns, modals, tooltips.
- Dark theme swaps both for white-hairline, black-based equivalents; geometry identical.

## Shapes

Controls 6px radius, panels and cards 10px, tiles and popovers 8px, modals 12px. Pills only for chips, status badges, tags. A surface has a border or a shadow, never both. No gradient borders, coloured edge stripes, skewed geometry.

## Components

### Dialogs
- One shell (`src/components/Dialog.tsx`): backdrop, `role="dialog"`, `aria-modal="true"`, a label, focus inside, Tab trapped, Esc closes, focus restored. Backdrop closes; inside does not.
- Long dialogs (prune, logs, inspect) keep their own header inside the shell; short ones use an `<h2>` plus a right-aligned action row.
- **The Inspect window is the Logs window for one payload** (`src/components/InspectModal.tsx`): `.logs-modal` chrome — 900 px wide, 94 vw cap, header naming the object, search with match count and next/previous, `Wrap` chip, copy, close — over a line-numbered body with `Highlight`. A window, not a sheet in the row: a 900-line `docker inspect` in a cell is unreadable. Portals to `document.body`; keeps its command for the reload glyph.
- Destructive dialogs list affected counts, require the profile name where the blast radius is the whole VM, disable confirm while the profile runs.

### First run
- Two steps — **Welcome**, then **Tools** — in a 720 × 720 px modal shown until `localStorage["runtimeDesk.onboarded"]` is `1`; Settings → General → **Run setup again** reopens it. Both steps use `height: min(720px, 88vh)`: the tools list is ~1067 px scrolling inside `.onboarding-body`, the welcome note pinned to the same box, so stepping forward never resizes the window.
- Copy names the CLIs the app reads (`colima`, `docker`, `podman`, `nerdctl`) and never claims one it does not run; `kubectl` in Tools under **Kubernetes · optional**.
- The headline cycles one noun — `Colima`, `Docker`, `Podman`, `kubectl`, `containerd` — random order every 2.2 s, `--accent-hover` weight 700, never repeating the word on screen and never bouncing back to its predecessor; under three words the second guardrail drops. `.onboarding-rotor` is an inline slot: words absolute and nowrap, widths measured once from hidden inline probes (an inline box is exactly as wide as its text in every engine), animating to the entering word's width while the outgoing word lifts 0.32 em and blurs out.
- Owns the window like `Dialog`: `useModalFocus` (`src/lib/modalFocus.ts`) focuses `[data-autofocus]` — Continue / Open Dashboard — traps Tab, restores focus on close; `.main-row` and `.statusbar` carry `inert`. Esc not wired: only **Skip setup** dismisses first run.
- `prefers-reduced-motion: reduce` stops the cycle and the width transition.

### Targets and State
- Interactive targets ≥ 24×24 px: row icon and status buttons 24 (`--ctl-h-sm`), header `.icon-plain` 26 (`--ctl-h`), copy buttons 24, clickable port chips `min-height: 24px`. Inline data chips may be smaller — not interactive.
- Toggles expose state twice: visible active style and `aria-pressed`. Icon-only controls always `aria-label` plus `title`.
- Inputs carry an explicit `aria-label`; a placeholder is a hint, never the only name.

### Buttons
- **Shape:** 26px tall, 6px radius, 0 11px padding, 13px/500 text, 6px icon gap. Mac push button: white face, 1px inset ring, one-pixel contact shadow, pressed one step darker.
- **Primary:** signal green fill, near-black text, hover one step deeper, active 4% brightness drop. At most one per region.
- **Secondary (`.ghost`):** panel fill, 1px inset `--ctl-border` ring, half-pixel contact shadow. One meaningful toolbar action (**Pull model**), list-toolbar actions (**Pull image…**, **New machine…**).
- **Quiet (`.btn` alone):** transparent, muted text; hover a 6% ink wash and ink text. Default for utilities that neither change state nor destroy.
- **Danger:** red text on a red 12% tint when armed or confirming. Row-level Remove muted until hover, then red; armed a solid red fill. Disabled drops tint and hue — an unavailable action must not look like a faded error.
- **Row destruction is a bin, not a word.** `TrashIcon` beside the Sherlock control: first click arms (solid red fill, white check), second runs; an unavailable target (used by a container, built-in network) is disabled with the reason in its `title`. A text **Remove** per row outshouts the data and cannot hold still in a squeezed column.
- **Icon-only:** `.icon-plain`, 26px square (`var(--ctl-h)`, `var(--ctl-radius)`), transparent until hover, always `aria-label` and `title`: header page actions (`.topbar-tools`), the expanded container row (five on Docker: Logs, Start/Stop, Restart, Open in Sherlock, Inspect JSON; four on Podman), the Sherlock bar, Podman row details. The container row right-aligns them on the live strip (`.cd-actions`, 2px gap) — no footer bar.
- **Lifecycle is icon-only:** Start, Stop, Restart are ▶ ■ ↻ wherever a page action — Machine header, expanded container row, Podman machine rows (`.icon-btn`). Menus keep words (profiles offer Start/Stop/Restart in `⋯`); the delete dialog's **Stop profile** stays a sentence step.
- **Row actions:** `.icon-btn`, 24px tall (`--ctl-h-sm`), 8px side padding, transparent, muted; hover adds the surface without turning the row into a button farm.
- **View switch:** two views of one page are one segmented `.view-switch` — 26px `panel-2` shell, active segment on `panel` with the accent icon and `aria-pressed`. Never two icon buttons, where the inactive half reads as a peer action.
- **Focus:** global `:focus-visible` is a 3px `--accent` halo at 70%, 1px offset, clearing 3:1 both themes; controls drawing their own state (search fields, view switch, sort headers) use a 2px `--focus-ring` (#15803d light, #4ade80 dark) at 1px offset. Never `--accent-ring` alone, which is a fill.

### Chips
- Pills, 24px tall, 999px radius, panel-raised fill, muted 11.5px text. Selected: 14% green tint, 32%-green inset ring, ink text.
- `chip-count` is a 10px mono figure on the canvas colour, so counts stay aligned.

### Tables
- **One row metric:** 44px rows (`0 14px` cells, `10px 14px` header); header gutter 14px = body, so labels sit above values. Panel tables of prose keep `.table td`'s `8px 12px`.
- **List toolbars sit above every list:** a `.list-toolbar` (Partition chips, or All/Unused) belongs to the table's card, so all four list tables start on the same line.
- **Column budgets live in one block** (`src/App.css`, "List column budgets"), measured: two-chip ports cell 178px (declared 190px), `Exited (1) 12 minutes ago` 196px (declared 192px), 12-character ID 118px. Fixed columns are `<col>` widths; exactly one stays auto for slack (name, repository, mountpoint). At 1280: 1280 − 220 sidebar − 48 gutters = 1012px of table, every fixed sum under it. `.table-containers` 998px and `.table-kube` 1040px `min-width`, unconditional — a 1000px media-query floor left the name column at 0px from 1001 to 1102px.
- **The origin column is conditional.** Origin only when origins mix (Compose beside plain) — `docker` down every row is noise on a single-origin profile. A mixed list pays the badge column out of the image column (200 → 168px).
- **Actions pin, they do not drift.** Last column always `position: sticky`; forced sideways scroll adds the `.table-wrap.is-x` inset hairline, so it reads as a pinned layer, not a third vertical rule.
- **Expanded-row controls are glyphs, not words.** Row-panel actions right-aligned in `.detail-actions` on the `.cd-actions` 2px rhythm: Copy and Inspect JSON as 26px `.icon-plain` with `aria-label` and `title`, plus Copy name and Tags on a Podman machine row; no `.btn` text control inside a table panel. Inspect JSON is one-shot, so the glyph keeps its shape and carries no `aria-pressed`.
- **Podman lists reuse the Docker table.** Same `.table-wrap`, 44px rows, 14px gutters, `colgroup` budgets; only the data source changes. Action budgets: 84px for a container row (Logs + `⋯`), 96px for images, volumes, networks (fingerprint + bin, Docker's pair), 118px for machines (start/stop, restart, bin — tags live in the expanded row). Tags are not a fourth icon: containers open them from `⋯ → Tags…`, other lists from the panel's tag glyph. IDs render as `.cell-id`, createdAt through `fmtDateTime` into `.cell-time`.
- **Podman rows behave like Docker rows.** Every data column sorts through `.sort-arrow`; a row expands into `.row-detail`. Podman containers use Docker's `ContainerDetail` (`source="podman"`): grouped facts, the CPU/memory/PIDs strip, Ports/Networks/Mounts/Environment rows and the icon strip are the same code — `podman container inspect` reshaped into `ContainerDetail`, `podman stats --no-stream` strings (`0.31%`, `217.1kB / 4.077GB`) parsed into `ContainerStat`. Four icons instead of five, Podman having no Investigator. Ports fed by `0.0.0.0:8080->80/tcp` strings so one `PortChips` cell serves both runtimes; logs open in `LogsModal` through a tail-aware `podman logs`.
- **Podman volumes reuse the volume map, tags reuse the tag editor.** The treemap shows `podman system df -v` sizes with the same tonal cells; local tags edit through the same tag chip/input vocabulary as Sherlock (the machine row opens them from the panel's tag glyph, never a fifth icon). No second metadata store. The network page reuses `.view-switch` and `NetworkGraph` under a "Network map" heading.
### Cards / Containers
- Panel radius 10px, panel fill, hairline ring plus contact shadow, 16px padding.
- Labels above values, 11.5px muted, sentence case; `.card-value` 26px/600, `.card-sub` 12px muted. KPI cards are `.kpi-card`: 32px icon well, label, figure at 30px mono.
- Strip metrics are `.strip-item`: `.strip-label` (10.5px/600, uppercase, 0.06em), `.strip-value` (22px/600 mono, tabular), `.strip-sub` (11.5px muted) always rendering — a non-breaking space when empty — so baselines align.
- A tile that counts something is a control where a screen exists behind the number: a KPI card opens its tab (vCPUs and memory to Machine, containers to their lists), strip cells use `.strip-action` (VMs to Machine, Docker cells to their lists, Compose to Containers scoped). Whole tile is the target; hover raises the fill and lifts it 1px, focus rings it. An interactive cell pads 6×8px, offset by an equal negative margin.
- An interactive strip cell pads 6×8px and pulls the padding back with an equal negative margin, keeping a plain cell's grid lines while the hit area grows.
- **Storage is quoted, never computed.** The Storage usage card switches providers with the same `.chip` control; Docker and Podman draw the donut from their own `system df`. No host scan or client-side sum enters an engine's number; a stopped engine or missing tool is named in place of a zero, and the source line names the command that answered.

### Notices
- One banner vocabulary for errors, successes, info: `.notice-card` = panel fill plus a 7% wash of the state colour (`--red` / `--accent`), hairline ring, 760px max width (860px above a Settings pane, so a banner shares that column instead of ending short of the panel edge), 8px radius, 9/10/12px padding. Colour is never the message: state is a 15px `TriangleAlertIcon` / `CheckIcon` / `InfoIcon`, title 13px/600 primary ink, detail 12px muted — legible under colour-blindness, Increase Contrast and dark mode.
- **One fact, one place.** A newer app release is announced once: the launch banner carries it everywhere except Settings › About, whose inline row states the same version and runs the same **Open releases**. Opening About retracts the banner (`tag: "app-release"`) and leaving does not bring it back.
- The sentence is the message, the CLI text is evidence. `humanizeDockerError` / `humanizePodmanError` return `{ title, detail, evidence }`; evidence hides behind **Show details** in an 11.5px mono block (max 132px tall, scrollable, selectable) with **Copy** beside it. A failed Podman list uses the same banner in the page (gutter-aligned, `Open Machines` + `Retry`), not a raw `p.error`.
- Headlines come from the dial result: `dial tcp 127.0.0.1:54379: … connection refused` reads "Nothing is listening for Podman", address kept. Say what the CLI proved: `permission denied` names the path (`/var/lib/docker/volumes/pgdata`), a missing socket is "The container socket is not there … the profile is not running" (both strings contain "permission denied"), an unresolvable image id becomes "An image is still in use" with the hex id.
- **A count is a claim.** An empty cell says "No containers" only after a successful read; after a failure, "List unavailable" with the banner carrying the reason. Podman lists add "Loading…" in flight. Gate closed: `default stopped · counts not read` (or `no profile · counts not read`, `docker CLI not found · counts not read`) behind an idle 6px dot, never zeros.
- **Destructive verbs scale their friction.** Container or image removal: two-click arm, 3 s expiry (`ConfirmButton`). Profile delete: type its name. Cluster reset or delete: type the kubeconfig context. Creating belongs in the list it fills (**Pull image…**, **New machine…**, **New profile…**), so an empty list shows the way out of itself.
- **A closed gate is not an empty list.** A tool whose daemon is closed (profile stopped, or none) queried nothing, so every daemon-gated screen renders a prerequisite panel instead of its table: one sentence ("Nothing was queried, which is why the lists are empty"), **Start profile** or **New profile…**, plus **Recheck**. The nav item stays — starting the profile fills the screen in place. `shownTab` has four non-page states: `__blocked` (tool missing), `__waiting` (Colima daemon closed), `__podman-waiting` (no running Podman machine), and the real page.
- **No tooling at all keeps the nav's shape.** A probe that finds nothing to read — the common "Docker Desktop only, no Colima" machine — would collapse the sidebar to one gear icon; it renders a notice instead (title, four CLIs as `code`, **What it needs** opening Settings › General), gated on `tools !== null` and ignoring hidden sections.
- One footer row after the detail controls: `Show details` (quiet link button, muted, 8% hover wash) → `Copy` → real actions as 22px Mac ghost buttons (`Open Containers`, `Stop container`). Dismiss is a 22px rounded square top-right, muted until hover; the stack holds three and dedupes identical title+detail.

### Dashboard Editor
- Hidden cards leave the grid and park in one row above it (`panel-2` strip, 10px radius): one 168px tile per card, a 160×96 miniature and a caption.
- The miniature is the card's real render on a 320px surface scaled to 50%, `pointer-events: none`, so preview and card never diverge.
- Both directions are drags: a grid card dropped above the grid parks, a parked tile dropped on the grid returns at the drop slot. Tray 2px accent inset ring, grid an accent outline, source dims to 35%.
- A parked card's drag previews the post-drop layout: the grid re-packs around it through `computeWidgetSpans` and the gap holds an invisible render, so nothing shifts on release.
- Motion: reorders and hide/restore are FLIP (180ms translate, 240ms grow-out-of-the-tile for restores); a newly parked tile fades up 4px.

### Inputs / Fields
- 26px tall, 6px radius, panel-raised fill, 1px inset separator, 12.5px text (13px is button text). Hover raises the fill; focus replaces the separator with the accent ring. Placeholders muted, typed text ink.
- Every free-text field opts out of macOS typing aids — `spellCheck={false}` `autoCorrect="off"` `autoCapitalize="off"` `autoComplete="off"` — or WKWebView floats its autocorrect bubble over the field and rewrites names as you type. Search, log filter, tag, profile, mount, hostname, model and delete-confirm fields carry it.
- **One search control lives in every page header**, left of the page actions and Refresh: closed as a 26px `.icon-plain` magnifier (`aria-expanded`), unfolding inline to `min(240px, 34vw)` over `--dur`. A 20px `.search-globe` at the open field's left edge: unpressed filters the visible list, pressed searches **everything** (sections, profiles, objects, tags) in a panel under the field, arrow keys and `Enter` to open the hit. The input pads 30px left where the globe shows and reserves 34px right for a 20px **×** that appears only with text. ⌘K (or ⌘F) opens Global mode anywhere; Escape closes and always clears.

### Live Charts
- Line chart with a tinted area: 1.6px accent stroke, `--spark-fill` (12% green light, 18% dark), one hairline baseline from the separator token.
- **Two cadences, two windows.** Sherlock streams one sample per second with `TREND_SAMPLES = 120` — a two-minute window — while Activity samples every 2 s and keeps 36, a 72 s window. `windowLabel` and the Activity captions name the window the reader sees (`2 min window`, `72 s window`), so `last 72 s` never claims a window it does not hold.
- **A chart waits for enough points to be a trend.** `TREND_MIN_POINTS = ceil(120 / 12) = 10`, so Sherlock draws at 10 s and says so until then (`collecting · chart in 7 s`); Activity's cards print `${n * 2} s of 72 s recorded` until the window fills. `fit` stretches the recorded span only from three points on — one or two stretch into a full-width band that reads as a divider.
- Scaled to the known ceiling when one exists — 100% per core for CPU (`scale 100%`), the memory limit for memory — else to the observed peak. The half-domain hairline keeps a quiet line readable as "low", not "broken"; the peak prints in mono (`peak 13.2% · 2 min window · scale 100%`).
- **Every Activity row is a drill-down.** The live table ends in a 56px Actions column holding one fingerprint icon per container — the same glyph the Sherlock nav item uses — and it opens that container's Sherlock page. The three narrowest metric columns shed 50px to pay for it (Network 170 → 148, Block 152 → 132, PIDs 64 → 56), so the table lands at 984px — the panel's interior at the 1280px window — and never scrolls sideways there.
- Before the first answer the panel is a skeleton (`.spark-skeleton`, 60px box, `ghost-sheen`), never an empty axis. Every chart sits next to its numbers — one without an adjacent value is decoration.

### Volume Map
- Squarified treemap: area is size, tint is `color-mix(--accent 6%→28%, --panel)` by share of the largest volume — one hue scaled by size, like Storage in System Settings, so the biggest consumer reads first.
- Each cell carries a hairline inset ring; hover and keyboard focus switch it to the accent ring plus a 2px `--accent-ring` halo. Hovering a volumes-table row applies the same ring and a 1.25 brightness lift, so the table is the map's legend.
- Name (11.5px/600) bottom-left once a cell is wider than 78px and taller than 26px; size (mono 10.5px, muted) joins only above 78×44px. Below that the cell keeps its `title`.

### Facts List
- Each fact group is its own card. Columns are semantic: **left is the object** (Identity, Lifecycle, Health, Limits), **right is how it runs and what it touches** (Runtime, then Related). Images: Image | Runtime + Related. Volumes: Storage | Timeline + Related.
- Inside a card, label/value rows use a 6px vertical rhythm, a hairline under each row and none under the last. Values align right; long identifiers wrap rather than clip.
- The inline table row is the exception: values start left on a fixed 76px label column, so the four flat groups share one 26px row rhythm and every value begins on the same x. The 24px copy button hangs inside the row rather than setting its height.

### Reference Lists
- Environment and Labels are definition grids: environment in two aligned columns when width allows, labels in one; keys muted mono, values left-aligned and wrapping.
- A container's Labels panel holds two sets — **Set at runtime**, then **From image** — because Docker merges the image's labels into the container's `Config.Labels`; the origin is recovered by comparing each value with the image's own set, and the split is drawn only once that set is known. One shared row budget and one **Show all N** control across both sets, so the split never doubles the panel.
- Long lists truncate at 12 (environment) or 10 (labels, build history) with a quiet **Show all N** control; the panel is omitted when the set is empty.

### Cleanup
- One Tools page, one reading order: storage cost, unused objects, idle tagged images, large logs — each its own full-width panel, 12px apart. The top strip uses the standard metric cells (`.strip-label` over a mono `.strip-value`) with a sub-line naming the denominator (configured disk, guest root, `du`, `docker system df`); "Nothing needs it" turns amber only when non-zero — attention, not failure.
- The composition bar is magnitude in tone, never hue: four steps of `--text` mixed transparent over the panel (55/40/27/15%), 1px panel hairlines between, so it reads as one ink ramp while the volume map spends the accent. Its legend repeats the swatch and prints each value in mono. Docker's own reclaim figure sits at the end, attributed to Docker, because it counts shared layers per image while the page's total counts unique bytes.
- The **Unused objects** table columns are Object, Kind, Why it can go, Age, Size, Actions, sorted largest first. Age is creation age in mono tabular, exact timestamp in the cell's `title`. Docker records no last use for images or volumes, so only build cache rows show one (`LastUsedAt`/`LastUsedSince`). Volume ages come from one batched `volume inspect --format '{{.Name}}|{{.CreatedAt}}'`, because `system df -v` carries none; an unanswerable client, or nerdctl's zero time, leaves `unknown`. Row actions are glyphs only: fingerprint for Investigate, trash `ConfirmButton` for Remove, broom on build cache rows opening the single prune dialog.
- Unused images show short image ID, tags, age, size, unique size; **stale** is a label on a 14% amber tint at 30 days or older, and the Unique column carries the removal decision, because removing an image deletes every tag on it. Log rows are Container, Size and the guest path in 11px mono with a `title`; that panel is read-only and grows without `--log-opt max-size`.
- Loading is shape, not a claim: skeleton metric cells, bar and rows while the scan runs; no empty-state sentence appears until it returns, because "nothing unused" is not known yet. `aria-busy` marks the panel, and rescanning keeps the last report visible so the page never flickers.
- The report is cached in memory per profile for 60 seconds; returning paints the cached numbers at once, past the minute the fetch runs behind them. A mutation or the header Refresh bypasses the cache, and the scan never joins the 15-second timer. The header names the client that answered — `nerdctl` on containerd profiles, `docker` otherwise.

### Kubernetes
- One page per profile, read through the host `kubectl` against the context Colima wrote — `colima` for the default, `colima-<profile>` for a named one, the Lima instance name rather than the profile label (`--context <instance>`, never the user's current context, so a second profile cannot answer for this one). Read-only for objects: the page reports, never applies manifests. Writes are the cluster's own lifecycle — **Enable Kubernetes** (`colima kubernetes start -p <profile>`) plus Stop/Reset/Delete in the strip menu.
- Three bands on the standard column: cluster strip, one chip row, one table; nothing is a card inside a card, and the strip is `.strip-items` with `.strip-label`/`.strip-value`/`.strip-sub`. Kind chips (`Pods`, `Deployments`, `StatefulSets`, `DaemonSets`, `Services`, `Nodes`) are the primary tab; namespace chips sit on the same row, right-aligned, **All namespaces** first and `*` as the sentinel becoming `-A`.
- The strip answers four questions with denominators, never bare totals: Nodes `ready/total`, Pods `running/total`, Deployments `available/total`, and the server version with the namespace count under it. Nodes take `state-warn` until all are ready, `state-ok` at full readiness; Deployments `state-warn` while fewer are available than declared; Pods print the bare fraction. An unreachable cluster prints the error under the strip (plus `Recheck`), the table empty — no number was read.
- **Columns follow the kind.** A Node row has no Namespace and a Service's "ready" column is its Cluster IP, so the table is six shapes over one row type: Namespace, Name, the kind's own facts, Age. Pods add Restarts; workloads replace Node with their images (`repo:tag`, two shown, `+N` after); Services show Type and Ports (`80:30080→8080/TCP`). Restarts and ages are mono/tabular, everything else text.
- Status needs no decoding: a pod whose container is waiting shows the waiting reason (`CrashLoopBackOff`, `ImagePullBackOff`) instead of the phase, because "Running" is exactly what a crash-looping pod reports. Unhealthy statuses take `--red-text`, ready nodes `--green-text`; the word is the signal, never colour alone. Age reads like kubectl's (`12s`, `5m`, `3h`, `2d`, `2w`, `2mo`, `2y`); no timestamp reads `—`.
- Three states, no dead ends: profile stopped (one sentence, no fetch), Kubernetes not enabled (what k3s-in-the-VM means, the exact command, **Enable Kubernetes**, **Recheck**), enabled but unreachable (the strip's error plus last counts, stamped `read at HH:MM` by `k8s.rs`'s per-context cache; never-read shows `—`). A missing `kubectl` hides the sidebar item behind the usual tool gate, and Settings names the install.
- **One menu for the cluster's verbs.** The strip header carries a `⋯` `RowMenu` — Stop Kubernetes, Reset cluster, Delete cluster — never a row of red buttons: they are the destructive half of one decision, existing only when a cluster does. Stop arms in place (`Confirm stop?`, menu open so the second click lands where the first did); Reset and Delete open a dialog asking for the kubeconfig context typed (`Type colima to confirm`).
- **Pods are the one kind with a row action**: a 56px right-aligned Logs column holding the terminal glyph, opening the shared `LogsModal` (search, level highlight, match-only, wrap, 200-line default). The command is `kubectl logs <pod> --all-containers=true --timestamps --tail N -n <ns>`, so every container prints and the parser still splits time from text.
### AI Models
- One panel per job: **Run a model** (registry, runner, model, serve port, prompt, and the actions on that model), **Model server** (state plus serve, open and stop), and **Output**, which appears only once Run prompt or List models returns something and carries **Clear**. The resource guide is a collapsed disclosure below; the page is `.machine-page` panels 12px apart.
- The four preconditions — Apple Silicon, krunkit VM, docker runtime, the runner in use — are chips in the Run header, not sentences. A profile that cannot run models gets one amber block stating why, printing the missing CLI's install command as a copyable mono line, and keeping the profile action and its sizing (`ai · 4 CPU · 8 GiB · 50 GiB`) in one row; the header Refresh re-probes. Amber, never red.
- **Pull model** is the panel's single primary; Run prompt and Chat in terminal are ghost, separated by a 1px hairline from utilities that change no model state (Set up runner, List models).
- Buttons name their effect — Pull model, Run prompt, Chat in terminal, Serve on :8080, Open localhost:8080 — each with a `title` naming the model it acts on.
- The resolved reference appears under the Model field only when the registry rewrites the name (`hf.co/…`, `ollama://…`); the same hint carries the Ollama-needs-ramalama rule, in amber because the current selection breaks it.
- Model server prints pid and port while running, and the model and port it would serve when stopped; the status badge sits at the header's right. Serve is disabled, not hidden, while the VM type is not krunkit.

### Navigation
- Back appears only after a drill-down: a row's Sherlock page, Activity's Open Containers icon, a network node's list, a notice's action, "Open settings" from a blocked prerequisite. Roots (sidebar, ⌘digit, global search, status bar) are one click away, so they never stack, clear drill-down history, and render no control. A root's title starts on the text column (20px gutter + 16px inset), no reserved slot; a drill-down adds the 26px `--ctl-h` control and shifts the title right by its width plus the 6px gap.
- The sidebar carries no search box; the page header's is the only one, so a list page never shows two fields. ⌘K focuses it in Global mode.
- Docker and Podman share one item vocabulary: short sidebar labels under the group heading, and a topbar prefix — **Docker Containers**, **Podman Containers** — so two lists never read as the same screen.
- **States are asked of the data, not of the screen.** `countsRead`/`listsFailed` are set by the read itself, so the status bar, the delete dialog and the empty cells agree; the current tab's gate answers a different question and used to answer wrong. A sortable header is a focusable button with `aria-sort`; a picker row carries its full label in `title`; the settings rail keeps its labels at every width and grows with the viewport (`clamp(140px, 12vw, 240px)`, 536px of content at 900 → 1184px at 1600).
- **A group header names its source, never repeats its only item.** Each header carries a 10.5px/500 right-aligned hint — profile name, or `no profile` / `no machine`. **Machine** and **Kubernetes** share one **Colima** group, Kubernetes not being a peer of the engines. A kubelet container carries an accent `k8s` chip (16% tint, 10px/600) and counts on the Kubernetes row; that chip costs about 33px of the 142px name cell a single-origin list gets at 1280 (1012 − 870 fixed), so a kubelet name reads `k8s_POD_cor…`, accepted since the row's `title` carries the full name; a mixed-origin list pays the badge column out of the image column, leaving 174px.
- Podman is scoped the way Colima is: `podman_set_machine_cmd` names the machine once and `run_podman` exports it as `CONTAINER_CONNECTION`, so lists, mutations, stats and logs talk to the same VM without a `machine` parameter. The toolbar states the machine (a `<Select>` above one machine, a sentence for one), validates it on every read, and re-reads the four lists on switch.
- Settings: a second, full-height column beside the sidebar (`clamp(140px, 12vw, 240px)`: `--rail` surface, white in light and one step above the nav in dark; 60px top padding so its first row sits on the sidebar's first group heading rather than 21.6px above it), not a floating card and not a second nav list. It carries General, Sidebar, Configuration and About at primary nav weight (13px, 16px icon, sidebar active tint) plus the red **Delete profile** row below a `.settings-rail-sep` hairline; the page title names the section (`Settings · General`).

### Settings
- General opens with the Colima facts (version and update state, active profile, runtime), then a **Tools on this machine** table: Utility, Status, Used for, Install. The only place every probed CLI appears at once, whatever the sidebar hides.
- The version row is the whole CLI-update story: installed version in mono, state beside it ("0.11.0 available" amber, "up to date" green, "not checked" muted), and, only while a newer release exists, an accented `UpgradeIcon` running `brew upgrade` on Homebrew installs and opening the release page otherwise. The header Refresh re-checks GitHub.
- The table is grouped by purpose — Core, Container runtimes, Kubernetes, Virtual machines, AI workloads — with one Label-scale row (Inter 10.5px/600, 0.06em, uppercase, muted) spanning all four columns and closed by a `--sep` hairline, so alignment survives grouping. Group order lives in `TOOL_GROUPS` beside `TOOLS`; an empty group renders nothing. Podman gates the Podman sidebar group; kubectl gates the Kubernetes item.
- The Install cell carries the install command only when the tool is missing, an em dash otherwise; hovering reveals the same 24px copy control the fact rows use (check for 1.2s).
- The header Refresh is the only control that re-probes: it re-reads the tool table and re-checks GitHub from any page. Settings → Sidebar names what is missing but never probes.
- **Sidebar** is one panel of three fixed columns per row: the section (13px/600 over its pages in 11.5px muted), the CLI it needs as a dot plus name (green installed, dimmed muted missing — never a red chip), and the visibility control. Both right-hand columns are fixed (132px, 104px), so every right edge meets on the same x. The control is a 26px pill naming its state — **Visible** (panel fill, ink), **Hidden** (muted, no fill), **Unavailable** when the CLI is absent (row muted, button disabled; `aria-pressed` repeats it). Below, **Also detected** is a Label-scale line over a legend of dot-plus-name pairs for every probed CLI no hideable section uses.

- **About** is a Mac about panel: one centered identity column — 72px mark, name 20px/650, version line 11.5px mono (`v1.1.3 · GPL-3.0-only`) with tabular numerals, a 52ch credits sentence at 12.5px muted, `Built with Tauri 2 and React 19 by dm0xa.` at 11.5px, one centered line of links (Repository · Report an issue · Colima · License; hover wash, 2px focus ring), an 11.5px muted tip-jar line, then a hairline and an 11px centered `Copyright © 2026 Runtime Desk contributors. GPL-3.0-only, without warranty.` While a newer release exists, an inline row under the credits keeps its amber `UpgradeIcon` tile and ghost **Open releases** button, and it is the only place the app states that fact — the launch banner stands down on this panel. No tiles, icon wells, fact cells or grid.
### Status Bar
- 26px tall, 11.5px muted, on a translucent bar hairline-separated from the page: the counts line (or `… · counts not read`), runtime and `arch`, `updated Ns ago`, and two 24px `.status-btn` icon buttons (keyboard shortcuts `?`, settings).

### Accessibility
- **Reduce Transparency** (`prefers-reduced-transparency: reduce`): the sidebar and toolbar/status bars drop `backdrop-filter` for solid `--bg-secondary` / `--panel`. Nothing relies on the blur to be readable.
- **Increase Contrast** (`prefers-contrast: more`): separators to 0.26 / 0.30 alpha, secondary ink to `#494950` / `#d0d0d6`, `--border` to `#b3b3b9` / `#6f6f76`, `--ctl-border` to 0.28 / 0.30 alpha, so every hairline survives.
- **Reduce Motion** (`prefers-reduced-motion: reduce`) turns off `.spin`, `.busy-bar`, `.activity-bar > span`, `.spark`, `.card-action`, `.strip-action`, the search field's width transition and the `ghost-sheen` skeletons (`.volume-cell-ghost::after`, `.cleanup-skeleton::after`, `.spark-skeleton::after`), stops the first-run headline's cycle, and switches `scrollIntoView` to `auto`.
- Every keyboard path is reachable without a pointer: Tab cycles the toolbar and lists, Esc closes the topmost surface, ⌘1–9 and ⌘0 reach the visible screens, `?` opens the shortcut sheet, and all window actions exist in the menu bar with their accelerator visible.

## Do's and Don'ts

### Do:
- **Do** keep one filled secondary action per toolbar; everything else quiet.
- **Do** set copyable, countable or comparable numbers in mono, tabular.
- **Do** separate surfaces with `var(--sep)` hairlines and inset rings, not borders.
- **Do** give icon-only controls both `aria-label` and `title`.
- **Do** take control measurements from `--ctl-h`, `--ctl-h-sm`, `--ctl-radius`.
- **Do** scale charts to the known ceiling (100% CPU, the memory limit), else the window peak, printing the peak.
- **Do** pair every chart with its value and window length.
- **Do** encode magnitude in area or an ink ramp, accent reserved for interaction — the volume map excepted, scaling accent by size (6–28%) so a treemap can rank.
- **Do** route every modal through the Dialog shell, for free focus, Esc and labelling.
- **Do** keep interactive targets at 24px or larger.

### Don't:
- **Don't** accent a button unless it is that region's primary action.
- **Don't** ship a control without hover, active, disabled and focus states.
- **Don't** use unicode glyphs as icons; draw them in `src/components/icons.tsx`, 2px stroke.
- **Don't** load fonts, images or styles from a CDN.
- **Don't** add a second radius vocabulary; reuse 5/6/7/8/9/10/12 or the 999px pill.
- **Don't** add a chart without data, a numerical companion or a stated window.
- **Don't** use an ink ramp where one hue already ranks magnitudes, or the accent as a magnitude fill.
- **Don't** use red for a resting state (stopped, disabled, not installed) or every row's Remove.
