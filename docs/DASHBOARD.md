# Dashboard modules

The dashboard is a grid of independent cards, one file each in
`src/components/dashboard/cards/`, named after its key. `registry.ts` globs the folder at build time
(`import.meta.glob(..., { eager: true })`), so dropping a file in is the whole registration step; it
sorts by `order`, builds default visibility, and keeps the `DASHBOARD_WIDGETS` / `WIDGET_KEYS` API.

## Contract

A card is a default-exported `DashboardCard`:

| Field | Meaning |
|---|---|
| key | Filename without `.tsx`; what `localStorage` stores, so renaming resets saved state. |
| `label` | Name in the parked-card tray and the hide button's accessibility text. |
| `description` | One line about the card; nothing reads it at runtime. |
| `span` | Preferred width out of the grid columns. |
| `minSpan` | Narrowest usable width; never shrunk below. Defaults to 1. |
| `maxSpan` | Widest when leftover columns are redistributed. Defaults to 4, clamped to columns. |
| `order` | Default position; ties sort by filename. Gaps of 10 leave insertion room. |
| `defaultVisible` | Visible on a fresh layout. Defaults to true. |
| `render` | `(ctx: DashboardContext) => ReactNode`. |

Cards get `DashboardContext` from `context.ts` and nothing else; `App.tsx` owns refresh, polling,
errors.

| Context field | What it holds |
|---|---|
| `profiles`, `running`, `selected` | All profiles, the running ones, the active name. |
| `status` | Selected profile's `colima status --json`: runtime, driver, arch, socket, mount type. |
| `version` | `colima version` output; line one is the version. |
| `counts` | Container, running, image, and volume counts from the loaded lists. |
| `countsRead`, `listsFailed` | Whether the counts describe the selected profile and whether any of the five Docker reads failed; unread is `—`, never `0`. |
| `profilesRead` | The list answered once, so "no profile yet" is a fact. |
| `containers`, `images`, `volumes`, `networks`, `compose` | Docker lists loaded for the active profile. |
| `disk` | Cached `docker system df` reading. |
| `podmanDisk` | `podman system df` for the selected machine; zero while none runs. |
| `limaVms` | Host tool probe for Lima. |
| `podmanMachines`, `podmanContainers`, `podmanImages`, `podmanVolumes`, `podmanNetworks` | Podman state for the selected machine (running, else default, else first) when `podman` is installed; lists empty while none runs. |
| `tools` | CLI probe (`SystemStatus`), or `null` before the first probe. |
| `chooseProfile(name)` | Switches the active profile. |
| `startSelectedOrCreate()` | Starts the selected profile, or opens New profile when none exists; stopped-VM cards put the fix in the card. |
| `openContainers(scope)` | Opens Containers filtered by origin (`all`, `compose`, `docker`, `k8s`) at its root, matching tile numbers to rows. |
| `openSubject(subject)` | Opens one container, image, volume, or network in Sherlock, optionally with its runtime (`docker`/`podman`). |
| `openSettings(section)` | Opens Settings at `general`, `sidebar`, `configuration`, `about`, or `danger`, not `setTab("settings")`'s last section. |
| `setTab(tab)` | Opens a section at its root: clears search and subject trail, pushes Back. |
| `visible(key)` | Whether a card is enabled; hidden cards still mount in edit mode. |

## Modules

`Default` is visibility on a fresh layout; hidden cards stay in the editor and each key is a filename.

| Key | Card | Shows | Opens | Auto span | Range | Default |
|---|---|---|---|---|---|---|
| `kpi-instances` | VM Instances | `profiles.length` | Machine | 1 | 1–2 | shown |
| `kpi-running` | Running VMs | Running profiles, green above zero | Machine | 1 | 1–2 | shown |
| `kpi-stopped` | Stopped VMs | Profiles minus running profiles | Machine | 1 | 1–2 | shown |
| `kpi-cpus` | Allocated vCPUs | Sum of `cpus` across profiles | Machine | 1 | 1–2 | shown |
| `docker-resources` | Docker Resources | Container, image, volume, network, Compose counts; pending read or failure named, never stale | Containers, Images, Volumes, Networks; Compose filtered | 2 | 2–4 | shown |
| `podman-machines` | Podman Machines | Podman machines, green when one runs | Podman Machines | 1 | 1–2 | shown |
| `podman-resources` | Podman Resources | Counts for the selected machine; missing Podman or machine named | Podman Containers, Images, Volumes, Networks | 2 | 2–4 | shown |
| `activity` | Activity | Live 72-second CPU history, sparklines, CPU, memory for the six busiest containers | Card and header open Activity (`.card-action`, `role="link"`, Enter/Space); rows open Sherlock | 4 | 4 | shown |
| `infrastructure` | Infrastructure | Lima VMs | Machine for Linux VMs | 2 | 2–4 | shown |
| `system-status` | System Status | Installed and missing CLI tools | Settings · General (tool check, install) | 2 | 2–4 | shown |
| `instances` | Instances | Profile table: runtime, architecture, resources | Chooses the profile | 4 | 4 | shown |
| `runtime` | Runtime | Runtime and driver | Machine | 1 | 1–2 | hidden |
| `arch` | Architecture | Architecture and mount type | Machine | 1 | 1–2 | hidden |
| `socket` | Docker socket | Socket path | Machine | 1 | 1–2 | hidden |
| `version` | Colima version | Installed version | Settings · General | 1 | 1–2 | hidden |
| `storage` | Storage usage | Per-engine donuts (`docker system df` / `podman system df`); chips switch providers; a stopped engine is named, not zero | Docker lists, Build cache; reclaimable opens Cleanup; Podman cells open Podman lists | 2 | 2–4 | hidden |
| `profiles` | Profiles overview | Status of each profile | Chooses the profile | 2 | 2–4 | hidden |
| `recent` | Recent containers | Latest containers with origin (Docker, Compose) | View all → Containers; each row opens it in Sherlock | 4 | 2–4 | hidden |

The four VM counters and `podman-machines` are `KpiCard`s from `kpiCard()` (`kpi.tsx`);
`docker-resources`, `podman-resources`, `activity`, `infrastructure` are composed panels; `instances`
is a table; the rest are stat cards and panels.

### Navigation

Counting tiles are controls; the `Opens` column says where. `setTab`, `openContainers`, and
`openSettings` go through `go`, which clears search and subject trail and pushes a Back entry, so
every card link is one Back away.

- The Containers tile resets the origin filter so its number matches the table; Compose sets it.
- The four KPI cards open Machine; a `StripPanel` cell is a button only when its item carries `onClick`.
- Activity and Recent rows call `openSubject` so the clicked object survives; Activity's header opens Activity, Recent's "View all →" opens Containers.
- Settings links use `openSettings("general")`, not `setTab("settings")`, which restores its last section.
- Podman cells and cards follow the App's selected machine, so changing it on the Podman pages moves them; Back from these roots returns.
- `StripPanel` renders a clickable item as `<button class="strip-item strip-action">`: 6×8px padding cancelled by an equal negative margin keeps grid lines while growing the hit area; hover/focus use `--hover`, `title` names the destination.
- Numbers with nowhere to go stay plain cells.

### Gated cards

`featureGate` in `src/dependencies.ts` alone decides tool or daemon availability; `activity` passes
it to the widget, and `docker-resources` checks profile status to explain a stopped profile instead
of counts.

`activity` alone changes what the app runs: `App.tsx` enables the 2-second `docker stats` sampler
while card, profile, and window are live, stopping otherwise. Others render refreshed data.

Podman cards read `podmanMachines` and the four Podman lists. `App.tsx` loads them on refresh when
`podman` is present, scoping first (running, else default, else first) via `podman_set_machine_cmd`,
so lists and the Podman picker agree; a stopped machine leaves lists empty and the card explains
why. Cards never fetch or subscribe.

Storage is read per engine on the same refresh, never from another engine or host scan:
`disk_usage_cmd` quotes `docker system df`, `podman_disk_usage_cmd` quotes `podman system df`. Both
cache a minute, and freeing removals clear it, so deleted bytes cannot linger. Hiding a card stops
its cost: new data belongs in the global refresh, not a card's `useEffect` interval.

## Layout

- Four columns above 1000 px; two at or below.
- `computeWidgetSpans()` packs visible cards into rows:
  - a card that does not fit wraps;
  - an auto card shrinks into a hole at least its `minSpan` wide;
  - leftover columns go out from the last card backwards, up to `maxSpan`;
  - a pinned width (Auto · Half · Full) never resizes: it moves to the next row, later fitting cards pull up, and `grid-auto-flow: dense` prevents ragged rows.
- `runtimeDesk.spans` stores width overrides: absent is Auto, Half `floor(columns / 2)`, Full all columns; the value is absolute for its grid and clamps to the current count, so Full saved wide shows two narrow and four when widened.
- `LAYOUT_VERSION` discards saved visibility and order when the default composition changes; width overrides survive (stable IDs), and **Reset layout** clears them.
- Hidden cards leave the grid and park above it as mini previews in edit mode; the App renders them there, hence `visible()`.
- Drag uses FLIP with geometry captured at drag start; never read live `getBoundingClientRect()` mid-drag, since transforms move the drop target and oscillate order.

## Template card

Copy it; replace the body, keep the shape.

`src/components/dashboard/cards/queue.tsx`:

```tsx
import type { DashboardCard } from "../context";

export default {
  label: "Queue",
  description: "Running and total containers",
  span: 2,
  minSpan: 2,
  maxSpan: 4,
  order: 200,
  render: ({ counts, setTab }) => (
    <div className="panel">
      <h3>Queue</h3>
      <p className="muted">
        {counts.running} running of {counts.containers}
      </p>
      <button className="btn ghost" onClick={() => setTab("containers")}>Open containers</button>
    </div>
  ),
} satisfies DashboardCard;
```

The registry finds the file on the next reload or build, keys it `queue`, and places it by `order`;
`WidgetKey` is a string, saved keys checked against the discovered set.

Checklist for a new card:

1. Name the file after the key (kebab-case); the key is the saved identity.
2. Read from `DashboardContext`; never fetch or poll here.
3. Gated? Use the App's `featureGate` values and explain, not an empty render.
4. Match `span` to content; charts and full-row tables use `minSpan: 4`. Shared scales sit by the chart; never scale a row to its own peak (`USAGE.md` → Activity).
5. `defaultVisible: false` for hidden cards, `order` for a predictable position, and bump `LAYOUT_VERSION` when either default changes.
6. Style with the existing `.card`, `.panel`, `.stat-card`, and table classes; icon-only controls need `aria-label` and `title` (`DESIGN.md`).
7. Decide where a count leads: a KPI tile takes `tab`/`tabLabel`, a strip cell `onClick` and `title`; else stay static. See Navigation.
8. Verify with `npm run build` and edit mode: drop, resize Auto → Half → Full, hide, reload, confirm the layout survives.

`DEVELOPMENT.md` has the short version; `ARCHITECTURE.md` covers module boundaries and data flow.
