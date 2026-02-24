# Remote Toolbar Redesign — Tabbed Command Surface

> **Date:** 2026-02-23
> **Branch:** `feat/moments-system`
> **Goal:** Replace the static 6-button toolbar with a tabbed toolbar that exposes Theater mode control, Moment capture/browse, and keyboard shortcuts as touch buttons

---

## Problem

The iPhone remote is missing key actions that are available on the Mac via keyboard:
- Theater/mode control (scene switching, Theater toggle)
- Moment capture (K) and browse (J)
- Bug Eye, Mosaic, Crop toggle
- The current Random button is broken

## Solution: Tabbed Toolbar

Replace the 6-button toolbar row with a **tab bar + button row** that switches content per tab:

```
┌─────────────────────────────────────────┐
│  [▶ Play]  [🎭 Mode]  [⭐ Mom]  [⋯]    │  Tab bar
├─────────────────────────────────────────┤
│  [btn] [btn] [btn] [btn] [btn] [btn]   │  Buttons (change per tab)
└─────────────────────────────────────────┘
```

---

## Tab Definitions

### Play Tab (Default)
Current toolbar, preserved:

| Button | Icon | Action | Command |
|--------|------|--------|---------|
| Random | 🔀 | Random seek on current stream | `{ action: 'random' }` |
| Focus | ⛶ | Toggle focus/fullscreen | `{ action: 'focus' }` |
| Audio | ♪ | Toggle audio focus (solo) | `{ action: 'audio-focus' }` |
| Pause | ⏸ | Pause/play all streams | `{ action: 'pause-all' }` |
| Layout | ▦ | Cycle grid layout | `{ action: 'layout' }` |
| Crop | ✂ | Toggle crop mode | `{ action: 'crop' }` |

### Mode Tab
Theater and scene control:

| Button | Icon | Action | Command |
|--------|------|--------|---------|
| Theater | 🎭 | Toggle Theater/Advanced | `{ action: 'key', payload: { key: 'Backquote' } }` |
| Casting | 📋 | Enter Casting Call | `{ action: 'theater-scene', payload: { scene: 'casting' } }` |
| Lineup | 👥 | Enter Lineup | `{ action: 'theater-scene', payload: { scene: 'lineup' } }` |
| Stage | 🎬 | Enter Stage | `{ action: 'theater-scene', payload: { scene: 'stage' } }` |
| Climax | 🔥 | Enter Climax | `{ action: 'theater-scene', payload: { scene: 'climax' } }` |
| Encore | 🎵 | Enter Encore | `{ action: 'theater-scene', payload: { scene: 'encore' } }` |

State: Theater button highlighted when active. Current scene button highlighted. Scene buttons disabled when in Advanced mode.

### Moments Tab

| Button | Icon | Action | Command |
|--------|------|--------|---------|
| Capture | 📸 | Capture moment from selected (K) | `{ action: 'key', payload: { key: 'k' } }` |
| Capture All | 📸+ | Capture from all visible (Shift+K) | `{ action: 'key', payload: { key: 'k', shift: true } }` |
| Browse | 📖 | Open/close Moment Browser (J) | `{ action: 'key', payload: { key: 'j' } }` |
| Play | ▶ | Play random moment | `{ action: 'moment-play' }` |

Badge: Tab label shows moment count.

### More Tab
Former sheet items as inline buttons:

| Button | Icon | Action | Command |
|--------|------|--------|---------|
| Mute All | 🔇 | Mute all streams | `{ action: 'mute-all' }` |
| Random All | 🔀 | Random seek all streams | `{ action: 'random-all' }` |
| Copy URL | 📋 | Copy stream URL | `{ action: 'copy-url' }` |
| Info | ℹ | Toggle stream info | `{ action: 'toggle-info' }` |
| Bug Eye | 👁 | Toggle Bug Eye | `{ action: 'key', payload: { key: 'b' } }` |
| Mosaic | ▦ | Toggle Mosaic | `{ action: 'key', payload: { key: 'm' } }` |

---

## Server-Side Requirements

### State Broadcast
`/api/remote/state` must include:
- `theaterMode` (boolean)
- `theaterScene` (string)
- `momentCount` (number)

### New Command Handlers
- `theater-scene` — set specific scene
- `moment-play` — play random moment in Player mode
- `crop` — toggle crop mode
- `key` action must support `shift` modifier

---

## Visual Design

- Tab bar: horizontal row of small text buttons, accent underline on active tab
- Button row: same style as current toolbar (icon + label, 56px height, `var(--bg-tertiary)` background)
- Active tab persists across stream switches
- Disabled buttons (scene buttons in Advanced mode): 30% opacity, no tap response

---

## Implementation Plan

### Task 1: Write design doc (this file)
- Save to `docs/plans/2026-02-23-remote-toolbar-redesign.md`

### Task 2: Fix Random button bug
- Read `remote.js` to find the Random button handler
- Trace the command relay to see why it's not working
- Fix the issue
- Verify: tap Random on remote, confirm stream seeks on Mac

### Task 3: Add tabbed toolbar HTML structure
- In `remote.html`: replace the `<section class="toolbar">` with new structure
- Tab bar: 4 tab buttons (Play, Mode, Moments, More)
- 4 button panels (one per tab, only active one visible)
- Each panel has its buttons with appropriate IDs and aria-labels
- Verify: page loads without errors

### Task 4: Add tabbed toolbar CSS
- In `remote.css`: replace `.toolbar` / `.toolbar-btn` styles
- Tab bar styles: `.toolbar-tabs`, `.toolbar-tab`, `.toolbar-tab.active`
- Button panel styles: `.toolbar-panel`, `.toolbar-panel.active`
- Active/disabled button states
- Tab indicator (accent underline)
- Verify: visual appearance matches design, responsive on small screens

### Task 5: Wire up tab switching in remote.js
- Tab click switches active panel (show/hide)
- Persist active tab in local variable (not localStorage — resets on reload is fine)
- Verify: tapping tabs switches button panels

### Task 6: Wire up Play tab buttons
- Random, Focus, Audio, Pause, Layout, Crop
- Fix any broken command handlers
- Active state reflection from server state
- Verify: each button sends correct command

### Task 7: Wire up Mode tab buttons
- Theater toggle, scene buttons
- Add `theater-scene` command handler to server.js relay
- Scene buttons disabled when not in Theater mode
- State reflection: highlight current scene
- Server state must broadcast `theaterMode` and `theaterScene`
- Verify: Theater toggle works, scene buttons change scene on Mac

### Task 8: Wire up Moments tab buttons
- Capture (K), Capture All (Shift+K), Browse (J), Play
- Add `key` command handler support for shift modifier if missing
- Add `moment-play` command handler to server
- Moment count badge on tab
- Server state must broadcast `momentCount`
- Verify: Capture creates a moment, Browse opens browser on Mac

### Task 9: Wire up More tab buttons
- Mute All, Random All, Copy URL, Info, Bug Eye, Mosaic
- Remove the old More sheet (or keep as fallback for very advanced options)
- Verify: each button works

### Task 10: Server state extension
- Add `theaterMode`, `theaterScene`, `momentCount` to `/api/remote/state`
- Add new command handlers: `theater-scene`, `moment-play`, `crop`, `key` with shift
- Verify: state endpoint returns new fields, commands execute correctly

### Task 11: End-to-end verification
- Load remote on iPhone (or mobile viewport)
- Test all 4 tabs and every button
- Verify state reflection (Theater mode highlight, moment count badge)
- Check that old functionality still works (rating, transport, thumbnails, viewer)
