# fontCIA — Extension Shell Design (Sub-project 1 of 8)

**Status:** Approved
**Scope:** Build-order step 1 from `CLAUDE_CODE_INSTRUCTIONS.md` — icon click → crosshair → shadow-DOM selection overlay → locked selection box + placeholder panel. No backend, no real scan dialogue, no font resolution. Those are later sub-projects (steps 2–8), each with their own spec.

## Context

fontCIA v1 is a Chrome MV3 extension that reads font info straight from page CSS (no ML, no pixel capture — that's an explicitly deferred phase 2). The full feature set spans 8 independent phases per the instructions doc; this spec covers only the first: the selection mechanism itself, with no backend wiring.

## Confirmed stack (whole project)

- Extension: Manifest V3, vanilla TypeScript (no framework)
- Backend (later phases): Express + Prisma + Postgres
- Auth (later phases): email/password with JWT
- Chrome only, both light/dark themes at launch (tokens below)

## Functional behavior

**Icon click (toggle, with double-injection guard):**
- On `chrome.action.onClicked`, the background service worker first checks `chrome.storage.session` for an existing armed/active entry keyed by tabId.
  - If none exists: write `{armed: true}` for that tabId, inject the content script via `chrome.scripting.executeScript`. Content script enters crosshair mode.
  - If one already exists (selection mode already active in that tab — armed-but-undrawn, mid-drag, or locked): treat the click as toggle-off, routing through the exact same teardown path as pressing `Esc` (see below). Do **not** inject a second content script or create a second overlay.
- No content script is statically declared in the manifest; it only runs when explicitly injected on click, so it doesn't execute on every page load.

**Selection lifecycle (within the injected content script):**
1. Crosshair cursor (`cursor: crosshair`) applied on entry.
2. Overlay rendered inside a shadow DOM host appended to `document.body`, isolating it from host page styles in both directions.
3. `mousedown` starts the box, `mousemove` resizes it live, `mouseup` locks it immediately — no resize handles/adjustment step after release.
4. A drag under ~4px is treated as a no-op: stays armed, doesn't lock a degenerate box.
5. On lock: content script clears the armed flag directly via `chrome.storage.session` (content scripts have direct access with the `storage` permission — no relay through the background worker required). Renders:
   - The locked box with a dashed accent-color (`#FF6A3D`) border.
   - A placeholder panel directly under the box, connected by a small notch/arrow pointing up at the box (layout "B" from the visual review), dashed border matching the box, containing static text ("scan dialogue — goes here in step 2") and a `×` affordance.
6. `Esc` at any stage — armed-but-undrawn, mid-drag, or locked — tears down the overlay, clears the storage flag, restores the default cursor. This is the single canonical dismiss path; both the icon-click-while-active guard (above) and the panel's `×` button route through it rather than duplicating teardown logic.
7. One-shot: after any lock or dismissal, the mode is fully off. The user must click the icon again to re-arm (per the confirmed "one-shot arm, auto-disarm" behavior — no persistent toggle state to manage across page interactions beyond the lifecycle above).

## Theming

CSS custom properties are wired for both palettes now, even though there's no toggle UI yet (deferred to the scan-dialogue phase, since that's where real settings UI will live). Dark is the default.

**Dark (default):**
| Token | Value |
|---|---|
| Background base | `#14171A` |
| Surface | `#1F242B` |
| Text | `#E8E6E1` |
| Accent / CTA | `#FF6A3D` |
| Success / match-confidence | `#3FA796` |
| Border | `#2A2F36` |

**Light:**
| Token | Value |
|---|---|
| Background base | `#FFFFFF` |
| Surface | `#F4F4F5` |
| Text | `#18181B` |
| Accent / CTA | `#FF6A3D` (same across themes) |
| Success / match-confidence | `#16A34A` |
| Border | `#E5E5E7` |

The overlay/box/panel render on top of arbitrary page content, so contrast must hold regardless of host page background — no mid-tone chrome.

## Architecture

- `manifest.json` — MV3, `action`, background service worker, permissions: `activeTab`, `scripting`, `storage`. No statically declared content script.
- `src/background/service-worker.ts` — `chrome.action.onClicked` handler implementing the double-injection guard described above; injects the content script when arming.
- `src/content/overlay.ts` — shadow DOM host creation, crosshair application, mouse event handling for the drag lifecycle, `Esc` handling, lock rendering (box + panel).
- `src/content/theme.css` — injected into the shadow root; both token sets as CSS custom properties, dark active by default.

**Why `chrome.storage.session`, not an in-memory background variable:** MV3 service workers are ephemeral and can be killed/restarted by the browser at any time. Storing the armed/tabId state in `chrome.storage.session` means the double-injection guard and toggle-off behavior survive a worker restart mid-session, rather than silently breaking because an in-memory flag was lost.

**Messaging architecture note:** keeping icon-click → inject-and-arm as a clean, explicit message/state path (rather than ad hoc) is what lets phase 2's `chrome.tabs.captureVisibleTab` proxy (which must go through the background worker, since content scripts can't call it directly) slot in later without a rewrite. Not built now — just don't foreclose it.

## Error handling / edge cases

- **Double-injection guard**: see icon-click behavior above — this is the primary hardening item for this phase.
- **Sub-4px drag**: no-op, stays armed rather than locking a degenerate box.
- **SPA navigation mid-selection (flagged for testing, not solved in this phase):** if a route/DOM change happens while selection mode is active (armed, mid-drag, or locked) — e.g., a YouTube autoplay transition — the shadow-DOM overlay must be verified to either tear down cleanly or not end up orphaned against stale content. No specific handling is designed for this yet; it's called out here so the manual test pass (below) explicitly exercises it and any needed fix becomes a scoped follow-up rather than a surprise.

## Testing

- **Unit:** box-drawing math — coordinate normalization for drag-in-any-direction, the ~4px no-op threshold.
- **Manual/E2E (load unpacked in Chrome):**
  - Crosshair appears on icon click; drag draws and locks the box; panel renders in layout B with correct notch/border.
  - `Esc` cancels at each stage (armed-undrawn, mid-drag, locked).
  - Clicking the icon again while already armed/mid-drag/locked toggles off via the same path as `Esc` — no second overlay appears.
  - Manually flipping the CSS variable set (no toggle UI yet) confirms both light and dark token sets render with visible contrast against arbitrary page backgrounds.
  - **SPA navigation edge case:** trigger a route change (e.g., on a site like YouTube) while armed/mid-drag/locked, and confirm the overlay tears down cleanly rather than persisting against stale content.

## Out of scope for this spec

Everything from build-order steps 2–8: real scan dialogue, DOM font resolution, backend API, enrollment flow, multi-source results, saved library, accounts, tier gating. These get their own specs when we reach them.
