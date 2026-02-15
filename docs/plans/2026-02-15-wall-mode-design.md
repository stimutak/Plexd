# Wall Mode — Multi-Stream Viewing Modes

**Date:** 2026-02-15
**Key:** W (cycles through modes)
**Status:** Design

## Problem

With 15 streams in a standard grid, each tile is ~350x200px. Most of each frame is dead space — room background, ceiling, furniture. The subject typically occupies 30-40% of the frame. Bug Eye and Mosaic don't help because they clone a single stream rather than improving visibility across all streams.

## Solution

Three new viewing modes under a single key (W), each addressing the problem differently. Two are full layout modes, one is a stackable crop modifier.

### Cycle Order

```
W → Strips → Crop Tiles → Spotlight → Off → ...
```

## Mode 1: Strips

All visible streams displayed as vertical columns side by side. Each column shows only the center ~40% of the video horizontally. Since subjects are almost always centered, this gives you tall, narrow panels of pure content with zero dead space.

```
┌──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┬──┐
│  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │
│  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │
│s1│s2│s3│s4│s5│s6│s7│s8│s9│10│11│12│13│14│15│
│  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │
│  │  │  │  │  │  │  │  │  │  │  │  │  │  │  │
└──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┴──┘
```

**Layout type:** Full layout (mutually exclusive with Tetris/Coverflow)

**Implementation:**
- CSS flexbox: container is `display: flex; flex-direction: row`
- Each stream wrapper gets equal width (`flex: 1`) and full height
- Video element: `object-fit: cover` — natural center crop due to narrow container
- `panPosition` (existing per-stream drag system) adjusts horizontal offset if subject isn't centered
- No extra video elements, no canvas, no cloning

**Cost:** Zero. Pure CSS on existing elements.

## Mode 2: Crop Tiles

Uses whatever layout is currently active (standard grid, Tetris, or Coverflow) but aggressively zooms each video to show roughly the center 50% of the frame both horizontally and vertically. Every tile becomes dense with content instead of showing dead space.

```
┌─────┬─────┬─────┬─────┬─────┐
│ ░░░ │ ░░░ │ ░░░ │ ░░░ │ ░░░ │
│░░s1░│░░s2░│░░s3░│░░s4░│░░s5░│
│ ░░░ │ ░░░ │ ░░░ │ ░░░ │ ░░░ │
├─────┼─────┼─────┼─────┼─────┤
│ ░░░ │ ░░░ │ ░░░ │ ░░░ │ ░░░ │
│░░s6░│░░s7░│░░s8░│░░s9░│░░10░│
│ ░░░ │ ░░░ │ ░░░ │ ░░░ │ ░░░ │
├─────┼─────┼─────┼─────┼─────┤
│ ░░░ │ ░░░ │ ░░░ │ ░░░ │ ░░░ │
│░░11░│░░12░│░░13░│░░14░│░░15░│
│ ░░░ │ ░░░ │ ░░░ │ ░░░ │ ░░░ │
└─────┴─────┴─────┴─────┴─────┘
```

**Layout type:** Stackable modifier (works on top of any layout)

**Implementation:**
- Each stream wrapper gets `overflow: hidden` (already the case)
- Video element gets `object-fit: cover` plus `transform: scale(1.8)` (or similar) to zoom into center
- `transform-origin` set from `panPosition` so per-stream drag adjusts the crop region
- When combined with Tetris, you get gap-free packing AND zoomed-in content — maximum density

**Difference from Tetris modes 1-3:** Tetris crops minimally to fill irregularly-shaped cells. Crop Tiles zooms aggressively (1.5-2x) regardless of cell shape to focus on the center of each frame.

**Cost:** Zero. CSS transform + overflow hidden on existing elements.

**Key combo example:** `T T W W` = Tetris Columns + Crop Tiles = tightly packed AND zoomed in.

## Mode 3: Spotlight

One stream gets hero treatment at ~60-70% of screen, aggressively center-cropped. Remaining streams tile as small thumbnails along the edges, also cropped.

```
┌──────────────────────┬────┐
│                      │ s2 │
│                      ├────┤
│                      │ s3 │
│       HERO (s1)      ├────┤
│     center-cropped   │ s4 │
│       60-70%         ├────┤
│                      │ s5 │
│                      ├────┤
│                      │ s6 │
├────┬────┬────┬────┬──┴────┤
│ s7 │ s8 │ s9 │ s10│  s11  │
└────┴────┴────┴────┴───────┘
```

**Layout type:** Full layout (mutually exclusive with Tetris/Coverflow)

**Implementation:**
- CSS grid with named template areas: hero region + edge tiles
- First stream in the filtered/rotated order becomes hero
- Hero video: `object-fit: cover` with moderate zoom (~1.4x)
- Thumbnail videos: `object-fit: cover` with aggressive zoom (~2x)
- Layout adapts to stream count — fewer streams = larger thumbnails
- No cloned video elements; streams are repositioned, not duplicated

**Cost:** Zero extra video elements. CSS grid template swap.

## Interaction Matrix

| Feature | Strips | Crop Tiles | Spotlight |
|---------|--------|------------|-----------|
| **Tetris (T)** | Turns off Tetris | Stacks on top | Turns off Tetris |
| **Coverflow (O)** | Turns off Coverflow | Stacks on top | Turns off Coverflow |
| **V filtering** | Fewer columns | Fewer tiles | Smaller roster |
| **[ ] rotation** | Shifts column order | Shifts tile order | Rotates hero |
| **Arrow keys** | Navigate streams | Navigate streams | Navigate + promote hero |
| **Click thumbnail** | Select stream | Select stream | Promote to hero |
| **Number keys** | Rate selected | Rate selected | Rate hero |
| **panPosition drag** | Adjust H offset | Adjust crop center | Adjust crop center |
| **Focused mode (F)** | Exit Wall, enter focused | Exit Wall, enter focused | Exit Wall, enter focused |

## Mutual Exclusivity

```
Layout modes (one at a time):
├── Standard Grid (default)
├── Tetris (T key, cycles sub-modes)
├── Coverflow (O key)
├── Strips (W x1)
└── Spotlight (W x3)

Crop modifier (stackable):
└── Crop Tiles (W x2) — works with any layout above
```

When activating a layout mode, all other layout modes turn off. Crop Tiles is independent.

## UI Integration

### Toolbar
Add a Wall mode button next to the existing Tetris (T) and Coverflow (C) buttons:

```html
<button id="wall-btn" class="plexd-button plexd-button-secondary"
        onclick="PlexdApp.cycleWallMode()" title="Wall mode [W]">W</button>
```

Button shows active state and current sub-mode label.

### Keyboard
- **W** — Cycle wall mode (Off → Strips → Crop Tiles → Spotlight → Off)
- **Shift+W** — Cycle backward
- **Esc** — Exit current wall mode (before exiting fullscreen)

### Messages
```
Wall: Strips (Esc to exit)
Wall: Crop Tiles (stacked on Tetris Columns)
Wall: Spotlight (← → to change hero)
Wall: OFF
```

### CSS Classes
```
.plexd-app.wall-strips     — Strips active
.plexd-app.wall-crop       — Crop Tiles active
.plexd-app.wall-spotlight   — Spotlight active
```

### State Tracking
```javascript
let wallMode = 0;  // 0=off, 1=strips, 2=crop-tiles, 3=spotlight
window._plexdWallMode = wallMode;
```

Exposed in `PlexdAppState` for remote control, same pattern as `tetrisMode`.

## Remote Control

Add to the remote's "More" sheet:
- **Wall Mode** button — cycles through modes
- State sync shows current wall mode in remote UI

## Performance Notes

All three modes use zero extra video elements. On M4 Apple Silicon with hardware decode, 15 simultaneous HLS streams is well within capability. The CSS transforms (scale, overflow hidden, grid template changes) are GPU-composited and have negligible cost.

## File Changes Required

| File | Changes |
|------|---------|
| `web/js/app.js` | Wall mode state, `cycleWallMode()`, keyboard handler for W, mutual exclusivity with layout modes, Spotlight hero logic |
| `web/js/grid.js` | Strips layout calculator, Spotlight layout calculator, crop-tiles scale factor application |
| `web/css/plexd.css` | Wall mode CSS classes, strips flexbox, spotlight grid template, crop zoom transforms |
| `web/index.html` | Wall mode toolbar button |
| `web/js/remote.js` | Wall mode state sync and control |
| `web/remote.html` | Wall mode option in More sheet |

---

## Bug: Coverflow Arrow Keys Broken

**Separate issue discovered during design session.**

Coverflow mode (O key) no longer responds to arrow key navigation. Arrow keys should move through the Z-stacked streams, bringing the next/previous one to the front. This regression needs investigation — likely a handler priority issue or a missing condition in the keyboard handler.

**File to investigate:** `web/js/app.js` — arrow key handler around the coverflow navigation logic.
