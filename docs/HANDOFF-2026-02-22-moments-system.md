# Moments System — Handoff Document

> **Date:** 2026-02-22
> **Branch:** `feat/moments-system`
> **Status:** Functional, needs browser testing
> **Files changed:** `web/js/app.js`, `web/js/stream.js`, `web/js/moments.js` (new), `web/css/plexd.css`, `web/index.html`

---

## What Is the Moments System?

Moments are **persistent, range-based sub-clips** — bookmarks that remember not just a timestamp, but a time *range* (start/end/peak) from a video stream. They live in `localStorage` and survive browser restarts.

Think of them as "the best 10 seconds of this video" captured with a single keypress, then browseable/playable in four different view modes.

---

## How It All Fits Together

```
┌──────────────────────────────────────────────────────┐
│                    PLEXD MAIN VIEW                    │
│  (multiple video streams in a grid/tetris/wall)      │
│                                                      │
│  Press K → captures a Moment from selected stream    │
│  Press Shift+K → captures from ALL visible streams   │
│  Press J → opens the Moment Browser overlay          │
└──────────────────────────────────────────────────────┘
                         │
                         ▼
┌──────────────────────────────────────────────────────┐
│                   MOMENT BROWSER                     │
│  Full-screen overlay with 4 view modes               │
│                                                      │
│  Header: filters, sort, mode selector, overflow menu │
│  Content: renders one of 4 modes (see below)         │
│                                                      │
│  Press J or Escape → closes browser, returns to grid │
└──────────────────────────────────────────────────────┘
```

### The Lifecycle

1. **Capture** — User watches streams in the main grid, hits `K` when something interesting happens
2. **Store** — `PlexdMoments.createMoment()` saves a 10-second range (peak ±5s) with thumbnail, rating, loved status, and source info to `localStorage`
3. **Browse** — User hits `J` to open the Moment Browser, which shows all moments in one of 4 views
4. **Play** — Each view mode can play moments by mirroring the *already-loaded* source video onto a `<canvas>` element (zero extra network connections)
5. **Manage** — Rate (1-9), love (Q), delete (X/Delete/Backspace), drag-to-reorder, filter, sort

---

## Architecture: Key Files

### `web/js/moments.js` — The Data Store

Pure data layer. IIFE module exposing `PlexdMoments` global.

| Function | Purpose |
|----------|---------|
| `createMoment(opts)` | Create and persist a new moment |
| `getMoment(id)` | Get by ID |
| `getAllMoments()` | Get all (returns copy) |
| `getMomentsForSource(url)` | Filter by source video URL |
| `updateMoment(id, updates)` | Partial merge update |
| `deleteMoment(id)` | Remove from store |
| `filter(opts)` | Query by session, rating, loved, source, tag |
| `sort(arr, by)` | Sort by rating/created/played/playCount/duration/manual |
| `reorder(orderedIds)` | Set manual sort order from array of IDs |
| `getRandomMoment(pool)` | Weighted random (rating² + 1) |
| `recordPlay(id)` | Increment playCount, update lastPlayedAt |
| `onUpdate(cb)` | Register change listener |
| `save()` / `load()` | localStorage persistence (debounced 500ms) |
| `clearAll()` | Purge everything |

**Moment object shape:**
```javascript
{
    id: 'm_xxx_yyyy',           // Unique ID
    sourceUrl: '',              // Video URL this came from
    sourceFileId: null,         // Server file ID if applicable
    sourceTitle: '',            // Display name
    streamId: null,             // Stream ID at capture time
    start: 0,                   // Range start (seconds)
    end: 0,                     // Range end (seconds)
    peak: 0,                    // The exact timestamp captured
    peakEnd: null,              // Optional peak range end
    rating: 0,                  // 0-9
    loved: false,               // Boolean
    tags: [],                   // User tags
    notes: '',                  // User notes
    thumbnailDataUrl: null,     // Base64 canvas capture
    extracted: false,           // Whether sub-clip has been extracted
    extractedPath: null,        // Path to extracted file
    sessionId: 'sess_xxx',      // Browser session that created it
    createdAt: Date.now(),
    updatedAt: Date.now(),
    playCount: 0,
    lastPlayedAt: null,
    sortOrder: 0                // For manual sorting
}
```

### `web/js/app.js` — The Browser UI + Keyboard

All Moment Browser logic lives in `app.js` within the `PlexdApp` IIFE. Key state:

```javascript
var momentBrowserState = {
    open: false,
    mode: 0,              // 0=Grid, 1=Wall, 2=Player, 3=Collage
    selectedIndex: 0,     // Currently selected/playing moment index
    filterSession: 'all', // 'current' or 'all'
    filterMinRating: 0,
    filterLoved: false,
    filterSource: null,
    sortBy: 'created',
    filteredMoments: [],  // Current filtered+sorted subset
    shuffleMode: false,
    playerHistory: [],    // Stack of played indices for Up/Down nav
    playerHistoryPos: -1, // -1 = at head (most recent)
    playerCursor: 0       // Filmstrip browse position (Player mode)
};
```

Key functions:

| Function | Purpose |
|----------|---------|
| `showMomentBrowser()` | Opens the overlay, builds header/filters/mode selector |
| `closeMomentBrowser()` | Tears down overlay, stops all canvas mirrors |
| `renderCurrentBrowserMode()` | Cleans up previous mode, dispatches to render function |
| `renderMomentGrid(container)` | Grid mode renderer |
| `renderMomentWall(container)` | Wall mode renderer |
| `renderMomentPlayer(container)` | Player mode renderer |
| `renderMomentCollage(container)` | Collage mode renderer |
| `loadReelMoment(skipHistory)` | Loads a moment in Player: thumbnail → canvas mirror → crescendo |
| `advancePlayer(direction)` | Next/prev or random in Player mode |
| `resolveMomentStream(mom)` | Finds the loaded stream matching a moment's source URL |
| `handleMomentBrowserKeyboard(e)` | All keyboard handling when browser is open |

### `web/js/stream.js` — Stream Health + Grace Period

The health monitor was updated with a **60-second grace period** after `startHealthMonitoring()`:

- During grace: frozen detection threshold is tripled (45s instead of 15s)
- During grace: stall recovery is skipped for first-attempt streams
- During grace: error handler suppresses recovery for unplayed non-HLS streams
- Post-grace: streams that errored during grace get a retry

This prevents the "thundering herd" problem where 50 streams all try to load simultaneously, hit Chrome's 6-per-host TCP limit, trigger the watchdog, and get stuck in retry loops.

### `web/css/plexd.css` — Moment Browser Styles

All styles prefixed `.moment-*` or `.plexd-moment-*`. Key sections:
- `.plexd-moment-browser` — Full-screen overlay
- `.moment-browser-header` / `.moment-browser-controls` — Filters toolbar
- `.moment-browser-content` — Scrollable content area
- `.moment-grid` / `.moment-card` — Grid mode cards
- `.moment-wall-viewport` / `.moment-wall-canvas` / `.moment-wall-cell` — Wall mode
- `.moment-reel` / `.moment-reel-main` / `.moment-reel-strip` / `.moment-reel-thumb` — Player mode
- `.moment-collage` / `.moment-collage-cell` — Collage mode

---

## The Four View Modes

### Mode 0: Grid — Editor/Manager

**Purpose:** Organizational tool. See all your moments as thumbnail cards. Rate, delete, reorder.

```
┌────────────────────────────────────────────┐
│ [Card] [Card] [Card] [Card] [Card]        │
│ [Card] [Card] [Card] [Card] [Card]        │
│ [Card] [Card] ...                          │
└────────────────────────────────────────────┘
```

- CSS Grid with `auto-fill`, `minmax(160px, 1fr)` — responsive columns
- Each card: thumbnail image (or placeholder with timestamp), info overlay (title, duration, rating, loved)
- Click = select (bright border). No double-click behavior anywhere
- Drag-and-drop to reorder (HTML5 drag/drop, persists via `PlexdMoments.reorder()`)
- Capped at 60 visible cards

**Grid Keyboard:**

| Key | Action |
|-----|--------|
| Left/Right | Select prev/next card |
| Down/Up | Scroll the grid to reveal hidden cards |
| Enter | Play selected moment in context |
| Delete/Backspace/X | Remove selected moment |
| 1-9 | Rate selected moment |
| Q | Toggle loved |
| / | Jump to random moment |

### Mode 1: Wall — Living Wall

**Purpose:** All moments playing simultaneously in a navigable 2D grid of live canvases.

```
┌─────────────────────────────────────────────┐
│ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐           │
│ │▶vid │ │▶vid │ │▶vid │ │▶vid │  ← all    │
│ └─────┘ └─────┘ └─────┘ └─────┘   playing  │
│ ┌─────┐ ┌─────┐ ┌─────┐ ┌─────┐           │
│ │▶vid │ │▶vid │ │▶vid │ │▶vid │           │
│ └─────┘ └─────┘ └─────┘ └─────┘           │
└─────────────────────────────────────────────┘
  ← pan with arrows, zoom with +/- (2x2 to 8x8)
```

- Each cell is a `<canvas>` mirroring its source stream via `requestAnimationFrame` loop
- Source videos loop within their `start..end` range via `timeupdate` handler
- Viewport panning via CSS `transform: translate()` (GPU-composited, no reflow)
- Zoom changes grid column count (`grid-template-columns: repeat(zoom, 1fr)`)
- Click to select, drag to reorder spatially

**Wall Keyboard:**

| Key | Action |
|-----|--------|
| Arrows | Pan the viewport |
| Shift+Arrows | Select individual cells |
| +/= | Zoom in (fewer, larger cells, minimum 2x2) |
| - | Zoom out (more, smaller cells, maximum 8x8) |
| Enter | Play selected in context |
| Space | Pause/play selected moment's source |

### Mode 2: Player — Sequential Playback

**Purpose:** Watch moments one at a time. Canvas mirror of the source stream. Filmstrip at bottom for browsing. Playback history for rewinding through what you've watched.

```
┌─────────────────────────────────────────────┐
│                                             │
│          ┌─────────────────────┐            │
│          │                     │            │
│          │   Canvas Mirror     │  ⇆ Shuffle │
│          │   (playing moment)  │            │
│          │                     │            │
│          └─────────────────────┘            │
│          Stream 3/12 — 8.2s ★5              │
│                                             │
│  [t][t][t][T][t][t][t][t][t][t][t][t]      │
│   ← filmstrip (gold=playing, white=cursor) →│
└─────────────────────────────────────────────┘
```

- Main area: `<canvas>` drawing frames from source video via rAF loop
- Shows thumbnail immediately on load (prevents black screen while video buffers)
- Solo audio: mutes all other streams, unmutes the moment's source
- Crescendo: progressive loop tightening toward the peak timestamp
- Filmstrip: horizontal scroll of thumbnails. Two visual states:
  - **Gold border** = currently playing (`.active`)
  - **White border** = browse cursor (`.highlighted`) — when different from active
- Playback history: stack of played indices, navigable with Up/Down

**Player Keyboard:**

| Key | Action |
|-----|--------|
| Left/Right | Browse filmstrip (visual only, doesn't play) |
| Space | Play the cursor position. If shuffle is on, picks random |
| Down | Go BACK in playback history (replay last played moment) |
| Up | Go FORWARD in playback history |
| R | Toggle shuffle mode |
| Enter | Play in context (exits browser, seeks source stream) |
| 1-9 | Rate current moment |
| Q | Toggle loved |

**History behavior:** Every played moment pushes to the history stack. If you go back (Down) to an earlier entry and then play something new (Space), the forward history is truncated — same as browser back/forward.

### Mode 3: Collage — Abstract Overlapping Intensity

**Purpose:** Scattered, overlapping canvases all playing simultaneously. Interactive selection with solo audio.

```
┌─────────────────────────────────────────────┐
│        ┌────────┐                           │
│    ┌───┤ ▶vid   ├──┐                       │
│    │   └────────┘  │    ┌──────┐           │
│    │  ▶vid         │    │▶vid  │           │
│    └───────────────┘    │      │           │
│              ┌──────────┤      │           │
│              │  ▶vid    └──────┘           │
│              └──────────┘                   │
└─────────────────────────────────────────────┘
  ← arrows cycle selection, selected gets audio
```

- Max 12 cells, randomly positioned with rotation (-5° to +5°) and varied opacity
- Each cell: `<canvas>` mirroring source via rAF loop
- Source videos loop within `start..end` range
- Selected cell: full opacity, border, z-index top, scaled up 1.1x, **solo audio**
- All other cells: muted, slightly transparent

**Collage Keyboard:**

| Key | Action |
|-----|--------|
| Left/Right | Cycle through cells (with audio solo on selected) |
| Space | Pause/play selected moment's source |
| Enter | Play in context |

---

## Global Keys (All Modes)

| Key | Action |
|-----|--------|
| J or Escape | Close Moment Browser |
| Tab / Shift+Tab | Cycle modes forward/backward |
| E / Shift+E | Cycle modes forward/backward (alias) |
| 1-9 | Rate selected moment |
| Q | Toggle loved on selected |
| X / Delete / Backspace | Delete selected moment |
| / | Jump to random moment |

---

## Capturing Moments

| Key | Context | Action |
|-----|---------|--------|
| K | Main grid | Capture moment from selected/fullscreen stream (peak ±5s) |
| Shift+K | Main grid | Capture moments from ALL visible streams at current position |

Capture includes:
- Thumbnail (canvas screenshot of current frame)
- Rating and loved status copied from the stream
- Deduplication: skips if a moment for the same source within 1 second already exists

---

## How Canvas Mirrors Work

This is the core trick that makes Moments efficient. Instead of loading video streams twice, we **mirror** already-loaded `<video>` elements onto `<canvas>` elements:

```
Source <video>  →  requestAnimationFrame  →  canvas.drawImage(video)
(already loaded)     (60fps loop)            (zero network cost)
```

`resolveMomentStream(moment)` finds the loaded stream matching a moment's source URL. If the source stream isn't loaded (user removed it), the canvas shows the static thumbnail instead.

Each mode manages its own rAF loop:
- Player: `reelMirror.rafId` (single canvas)
- Wall: `wallMirrorState.rafId` (N canvases)
- Collage: `collageMirrorState.rafId` (up to 12 canvases)

**Cleanup is critical.** Every mode switch and browser close calls the appropriate `stop*Mirrors()` function which cancels the rAF, removes `timeupdate` handlers, and restores mute states.

---

## Filters and Sorting

The Moment Browser header provides:

| Control | What it does |
|---------|-------------|
| "This Session" button | Toggle: show only moments created in this browser session |
| ♥ button | Toggle: show only loved moments |
| Rating buttons (1-9) | Toggle: show moments with rating ≥ N |
| Source dropdown | Filter by source video URL |
| Sort button | Cycle through: created, rating, played, playCount, duration, manual |
| "..." overflow menu | Purge All Moments (with confirmation) |
| Mode dropdown | Switch between Grid/Wall/Player/Collage |

---

## Stream Health: Grace Period

When loading many streams (30-50+), Chrome's 6-per-host TCP connection limit means most streams queue and stall. Without intervention, the health watchdog would flag these as broken and trigger futile retries.

**Solution (in `stream.js`):**

1. **Progressive activation** — `progressiveActivate()` polls every 2 seconds, counts how many streams are in `loading`/`buffering` state, and only activates new streams when below the 6-connection cap
2. **60-second grace period** — After `startHealthMonitoring()`, the watchdog applies relaxed thresholds:
   - Frozen detection: 45s instead of 15s
   - Stall recovery: skipped entirely for first-attempt streams
   - Error handler: suppresses recovery for unplayed non-HLS streams
3. **Post-grace retry** — Streams that errored during grace get one automatic retry after the grace window closes

---

## What's NOT Done Yet

- **Auto-range detection** — The `autoDetectRange` function is referenced but not implemented. Currently all moments default to peak ±5s.
- **AI features** — Moment schema includes `aiDescription`, `aiTags`, `aiEmbedding` fields but they're unused
- **Server sync** — `dirty` flag and `clearDirty()` exist in moments.js for future server persistence, but everything is localStorage-only
- **Moment extraction** — `extracted`/`extractedPath` fields exist for future ffmpeg sub-clip extraction
- **Remote integration** — The iPhone remote doesn't have Moments controls yet

---

## Testing Checklist

```
[ ] Load app with 5+ streams
[ ] K captures a moment (check "Moment captured at X:XX" message)
[ ] Shift+K captures from all visible streams
[ ] J opens Moment Browser
[ ] Grid: thumbnails visible, arrow selection works, drag reorder works
[ ] Grid: Down scrolls to reveal more cards
[ ] Grid: 1-9 rates, Q loves, X deletes
[ ] Tab cycles through all 4 modes
[ ] Wall: canvases playing, arrow pan, +/- zoom
[ ] Player: video shows on canvas (not black), filmstrip at bottom
[ ] Player: Left/Right browse filmstrip (white cursor), Space plays cursor position
[ ] Player: R toggles shuffle, Space picks random when shuffle on
[ ] Player: Down goes back in history, Up goes forward
[ ] Collage: scattered overlapping canvases, arrows cycle with audio solo
[ ] Escape or J closes browser cleanly
[ ] No console errors after closing browser (canvas loops cleaned up)
[ ] Load 50 streams: no thundering herd errors in first 60 seconds
[ ] Moments persist after page reload (check localStorage)
```

---

## File Locations Quick Reference

| What | Where |
|------|-------|
| Moment data store | `web/js/moments.js` — `PlexdMoments` global |
| Browser UI + keyboard | `web/js/app.js` — search for `momentBrowserState` |
| Grid renderer | `app.js:renderMomentGrid()` |
| Wall renderer | `app.js:renderMomentWall()` |
| Player renderer | `app.js:renderMomentPlayer()` |
| Collage renderer | `app.js:renderMomentCollage()` |
| Keyboard handler | `app.js:handleMomentBrowserKeyboard()` |
| Stream resolution | `app.js:resolveMomentStream()` |
| Canvas mirror cleanup | `app.js:stopReelMirror()`, `stopWallMirrors()`, `stopCollageMirrors()` |
| Grace period | `stream.js` — search for `LOAD_GRACE_PERIOD` |
| Progressive activation | `app.js:progressiveActivate()` |
| Moment CSS | `plexd.css` — search for `.moment-` |
| Filmstrip CSS | `plexd.css` — search for `.moment-reel-` |
