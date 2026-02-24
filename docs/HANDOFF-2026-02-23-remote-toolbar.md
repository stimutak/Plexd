# Remote Tabbed Toolbar — Handoff Document

> **Date:** 2026-02-23
> **Branch:** `feat/moments-system`
> **Status:** COMPLETE — All tasks done, two-phase review passed, fixes applied
> **Design:** `docs/plans/2026-02-23-remote-toolbar-redesign.md`

---

## What's Done

### Server bug fix
- `server.js:1711` — `createReadStream` crashed on empty files (end=-1). Added `stat.size > 0` guard.

### Selection grace period fix
- `remote.js` — Bumped grace period from 1s to 2.5s
- Added `!== selectedStreamId` check so Mac state only overrides when it's actually different
- Fixes the "snap back" when switching streams on the remote

### HTML Structure (`remote.html`)
The old 6-button toolbar replaced with tabbed toolbar:
```
<section class="toolbar">
  <div class="toolbar-tabs">        <!-- 4 tab buttons -->
    Play | Mode | Moments | More
  </div>
  <div class="toolbar-panel" data-panel="play">    <!-- 6 buttons -->
  <div class="toolbar-panel" data-panel="mode">     <!-- 6 buttons -->
  <div class="toolbar-panel" data-panel="moments">  <!-- 4 buttons -->
  <div class="toolbar-panel" data-panel="more">     <!-- 6 buttons -->
</section>
```

### CSS (`remote.css`)
- `.toolbar-tabs` / `.toolbar-tab` — Segmented control style tab bar
- `.toolbar-panel` / `.toolbar-panel.active` — Show/hide panels
- `.toolbar-btn-scene.disabled` / `.current` — Theater scene button states
- `.toolbar-tab-badge` — Moment count badge on Moments tab

### JS Wiring (`remote.js`)
- Tab switching via event delegation on `el.toolbarTabs`
- All 22 button handlers wired across 4 panels
- State reflection in `renderToolbar()` — theater mode, scene buttons, moment badge, layout label

### Server-side (`app.js`)
Command handlers added to `handleRemoteCommand()`:
- `theater-scene` — enters theater mode if needed, sets scene
- `moment-play` — calls `jumpToRandomMoment()` (plays random captured moment)
- `toggleCrop` — toggles Coverflow mode
- `key` — dispatches synthetic KeyboardEvent (supports shift/ctrl/alt modifiers)
- `toggleFavorite` — toggles favorite on stream
- `toggleBugEyeMode` — toggles Bug Eye overlay
- `toggleMosaicMode` — toggles Mosaic overlay
- `toggleStreamInfo` — toggles stream info display
- `setLayoutMode` — explicit layout set (turns off all special modes for grid)

State extended in `getState()`:
- `theaterMode`, `theaterScene`, `momentCount`, `mosaicMode`, `favorite` (per stream)

State exposure:
- `window._plexdMosaicMode` tracked at all 5 assignment sites
- `PlexdAppState.mosaicMode` getter added
- `jumpToRandomMoment` exported on `PlexdApp`

### Two-Phase Review Results
- 23 findings → 17 confirmed, 6 false positives (26% filter rate)
- 5 confirmed issues fixed: missing `favorite`/`mosaicMode` in state, 5 dead command handlers, theater key bug, moment-play duplication

---

## Known Issues (Low Priority)

| Issue | Severity | Notes |
|-------|----------|-------|
| Layout cycle uses toggles (not idempotent) | MEDIUM | Can briefly desync, self-corrects in 500ms |
| `toggleCrop` label misleading | MEDIUM | Maps to Coverflow, not per-stream crop |
| `transition: all` on buttons | LOW | No real perf impact on phone |
| Dead CSS `.actions-row` | LOW | Orphan from old layout |
| Orphaned More sheet | LOW | Replaced by More panel, dead code |
| Audio Focus optimistic toggle | LOW | Brief visual flicker, self-corrects |

---

## What's Next

The remote toolbar redesign is complete. Remaining work on `feat/moments-system`:

1. **Clean up dead code** — Remove orphaned More sheet HTML/CSS/JS
2. **E2E manual testing** — Test all 4 tabs on iPhone
3. **Moments system polish** — Any remaining Moments tasks from the original plan
4. **Branch completion** — Commit, PR to main

---

## Key Files

| File | Status |
|------|--------|
| `web/remote.html` | Done — tabbed toolbar HTML |
| `web/css/remote.css` | Done — tab + panel styles |
| `web/js/remote.js` | Done — tab switching, button handlers, state reflection |
| `web/js/app.js` | Done — command handlers, state extension, exports |
