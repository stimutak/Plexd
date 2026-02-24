# Theater & Advanced Mode — Viewing System Redesign

**Date:** 2026-02-19
**Status:** Approved for implementation

## Overview

Plexd currently has 13+ independent viewing modes with complex stacking rules. This redesign introduces two cohesive modes:

1. **Theater Mode** (default) — A guided 5-scene experience that escalates from browsing to climax. One hand, pure flow.
2. **Advanced Mode** — The full power-user toolkit. Evolution of the current system with ergonomic key remaps and a persistent mode indicator.

Toggle between modes with `` ` `` (backtick). Switching preserves the current layout — it swaps the control scheme, not the view.

---

## Two-Mode Architecture

| | Theater (default) | Advanced (`` ` `` to switch) |
|---|---|---|
| **Purpose** | Guided escalation toward climax | Full manual control over every parameter |
| **Mental model** | Scenes: push Space to intensify | Layers: layout + crop + filter, each independent |
| **Navigation** | Space forward, Shift+Space back, Escape back | All existing cycle keys (T, W, O, V, etc.) |
| **Who** | The experience — one hand, pure flow | The editor — tweaking exactly what you want |

---

## Audio Model

| State | Behavior |
|-------|----------|
| **Default** | All clips muted. Silent. |
| **Press `M`** | Unmutes selected clip. Audio now follows selection — arrows move audio to new clip, previous auto-mutes. |
| **Press `M` again** | Mutes. Back to silent. Audio stops following. |
| **Press `N`** | Mutes all, resets. Audio stops following. |
| **Scene transition** | Audio state carries. If audio was following, it follows the hero into the new scene. |

---

## Theater Mode: The Five Scenes

### Scene Flow

```
CASTING CALL ──Space──> LINEUP ──Space──> STAGE ──Space──> CLIMAX ──Space──> wraps to CASTING CALL
     ^                                                         |
     └───────────── Escape <──── Escape <──── Escape <─────────┘

ENCORE (J) — accessible from ANY scene, returns you to where you were
```

### Scene 1: CASTING CALL

**Purpose:** See everything. Fast triage. Star the hot ones, rate the rest, kill the duds.

**Layout:** Edge-to-edge crop tiles (Wall Crop mode 2 algorithm). Face detection auto-pan active by default. Every pixel filled with video — zero black bars, zero gaps.

```
┌──────────┬──────────┬──────────┐
│  clip 1  │  clip 2  │  clip 3  │
│ (cover)  │ (cover)  │ (cover)  │
├──────────┼──────────┼──────────┤
│  clip 4  │  clip 5  │  clip 6  │
│ (cover)  │ (cover)  │ (cover)  │
├──────────┼──────────┼──────────┤
│  clip 7  │  clip 8  │  clip 9  │
│ (cover)  │ (cover)  │ (cover)  │
└──────────┴──────────┴──────────┘
  All object-fit:cover, face-detect auto-pan
  Selected clip: subtle bright border
  Starred clips: persistent golden glow
  Low-rated clips (1-3): dimmed to opacity 0.7
```

**Behavior:**
- Grid auto-calculates optimal rows/cols (16:9 scoring from existing crop tile algorithm)
- All clips play simultaneously
- Audio off by default. `M` unmutes selected, audio follows arrows from then on.
- Selected clip gets a subtle highlight ring
- Starred clips get a persistent warm golden glow
- Clips rated 1-3 subtly dim (opacity 0.7) — still visible but clearly "reviewed"
- Face detection runs to keep the action centered in every tile

**Key actions:**
- `Arrows` — Navigate selection (audio follows if unmuted)
- `Q` — Star/unstar selected
- `1-9` — Rate selected
- `X` — Remove clip (next auto-selects)
- `Z` / `Enter` — Quick focus peek (zooms selected to full, Escape returns)
- `Space` — Advance to Lineup
- `Space-Space` — Random seek all clips simultaneously

**Transition to Lineup:** Unstarred AND unrated clips fade out. Starred and rated clips redistribute into Lineup layout. Smooth CSS transition (300ms).

---

### Scene 2: THE LINEUP

**Purpose:** Your curated picks, packed tight. All the good stuff, nothing else.

**Layout:** Treemap/split-pack (Tetris mode 3) — irregular packing that maximizes every pixel based on each clip's aspect ratio. All `object-fit: cover` with face-detect pan.

```
┌───────────────────┬─────────┐
│                   │  clip 3 │
│     clip 1        ├─────────┤
│   (big, wide AR)  │  clip 4 │
├──────────┬────────┴─────────┤
│  clip 2  │     clip 5       │
│          │   (big, tall AR) │
└──────────┴──────────────────┘
  Treemap: aspect-ratio-aware recursive binary packing
  Zero gaps, every clip fills its space
  Higher-rated clips get proportionally more screen area
```

**Which clips show:** Starred OR rated 5+. If nothing is starred/rated, all clips carry through.

**Behavior:**
- Rating-weighted: higher-rated clips get more screen area
- Drag to adjust pan/crop on any clip
- `Q` un-stars: clip fades out of Lineup
- Re-rating below 5 also fades the clip out

**Key actions:**
- `Arrows` — Navigate (audio follows if unmuted)
- `Q` — Star/unstar (unstarring removes from Lineup)
- `1-9` — Re-rate (below threshold fades out)
- `Z` / `Enter` — Focus peek
- `G` — Cycle rating on selected
- `Space` — Advance to Stage
- `Space-Space` — Random seek all visible clips
- `Escape` — Back to Casting Call (all clips return)

**Transition to Stage:** Selected clip (or highest-rated if none selected) becomes hero. Others shrink to ensemble. Smooth layout morph.

---

### Scene 3: THE STAGE

**Purpose:** One hero clip, supporting cast visible. Deep focus with context.

**Layout:** Spotlight — hero clip gets 60-70% of screen, remaining clips packed around it.

```
┌────────────────────────┬────────┐
│                        │ clip 2 │
│                        ├────────┤
│      HERO (clip 1)     │ clip 3 │
│     60-70% of screen   ├────────┤
│   face-detect + zoom   │ clip 4 │
│                        ├────────┤
│                        │ clip 5 │
└────────────────────────┴────────┘
  Hero: object-fit:cover, face-detect, 1.3-1.5x zoom
  Ensemble: object-fit:cover, tightly packed
  Audio on hero (if unmuted)
```

**Behavior:**
- Hero gets face-detect auto-pan + gentle zoom (1.3-1.5x)
- Ensemble packed tight in remaining space (right column or bottom row, adapts to screen shape)
- **Left/Right arrows rotate which clip is hero** — smooth crossfade (200ms). Audio follows to new hero.
- **Up/Down arrows navigate within ensemble** for starring/rating without promoting
- `Enter` on ensemble clip promotes it to hero

**Key actions:**
- `Left/Right` — Rotate hero (next/prev clip takes center, audio follows)
- `Up/Down` — Navigate within ensemble
- `Enter` — Promote ensemble clip to hero
- `Q` — Star/unstar (unstarring removes from stage)
- `Z` — Fullscreen hero (ensemble hidden)
- `K` — Bookmark this moment (saves clip ID + timestamp)
- `Space` — Advance to Climax
- `Space-Space` — Random seek hero clip
- `Escape` — Back to Lineup

---

### Scene 4: THE CLIMAX

**Purpose:** Peak intensity. Cycle sub-modes with `E` to find what hits hardest.

**Sub-modes** (cycle `E`, reverse `Shift+E`):

#### 4A: TIGHT WALL

```
┌──────────┬──────────┬──────────┐
│  COVER   │  COVER   │  COVER   │
│  ZOOM    │  ZOOM    │  ZOOM    │
│  1.8x    │  1.8x    │  1.8x    │
├──────────┼──────────┼──────────┤
│  COVER   │  COVER   │  COVER   │
│  ZOOM    │  ZOOM    │  ZOOM    │
│  1.8x    │  1.8x    │  1.8x    │
└──────────┴──────────┴──────────┘
  Maximum zoom, face-detect, edge-to-edge
  Every tile packed with action
```

All Lineup clips, edge-to-edge, aggressive zoom (1.8x), face-detect centering. Maximum simultaneous content on screen.

#### 4B: AUTO-ROTATE HERO

```
┌────────────────────────┬────────┐
│                        │████████│
│      AUTO-CYCLING      ├────────┤
│        HERO            │████████│
│    (changes every      ├────────┤
│     15 seconds)        │████████│
│                        ├────────┤
│                        │████████│
└────────────────────────┴────────┘
  Hero auto-cycles through clips (15s timer)
  Smooth crossfade between heroes
  Left/Right overrides, resets timer
```

Spotlight layout with auto-rotating hero (15s interval, configurable). Audio follows each rotation. Arrow override resets timer.

#### 4C: COLLAGE

```
┌─────────────────────────────────┐
│    ┌────────┐                   │
│    │ clip 1 │  ┌──────────┐    │
│    │ 0.85   │  │  clip 2  │    │
│    └────────┘  │  0.75    │    │
│         ┌──────┴───┐      │    │
│         │  clip 3  └──────┘    │
│         │  0.90    │           │
│    ┌────┴──┐  ┌────┴────┐     │
│    │clip 4 │  │  clip 5  │    │
│    │ 0.70  │  │  0.80    │    │
│    └───────┘  └──────────┘    │
└─────────────────────────────────┘
  Semi-transparent overlapping layers
  Variable opacity (0.65-0.95), slight rotation
  All object-fit:cover with maximum zoom
  Abstract layered intensity
```

All clips overlap with variable opacity, slight rotation (-5deg to +5deg), offset positioning. All cover-cropped with maximum zoom. Bodies blending into bodies.

#### 4D: SINGLE FOCUS

```
┌─────────────────────────────────┐
│                                 │
│           FULL SCREEN           │
│          ONE CLIP ONLY          │
│         face-detect pan         │
│                                 │
└─────────────────────────────────┘
  Arrows cycle through favorites/rated clips only
  Audio follows
  Distraction-free single focus
```

One clip, fullscreen, face-detect. Arrows cycle through starred/rated clips only.

**Key actions (all Climax sub-modes):**
- `E` / `Shift+E` — Cycle Climax sub-mode forward / backward
- `Arrows` — Navigate / rotate hero / cycle clip
- `K` — Bookmark this moment
- `Q` — Star/unstar
- `Space-Space` — Random seek
- `Escape` — Back to Stage
- `Space` — Wraps to Casting Call (full cycle)

---

### Scene 5: THE ENCORE

**Purpose:** Return to bookmarked moments. Your personal highlight reel.

**Access:** Press `J` from ANY scene. Press `J` again or `Escape` to return.

```
┌─────────────────────────────────────┐
│  ENCORE: Your Bookmarked Moments    │
├──────────┬──────────┬──────────┬────┤
│ > 1:23   │ > 3:45   │ > 0:52  │... │
│  clip 2  │  clip 5  │  clip 1  │    │
│  rated 9 │  rated 8 │  rated 7 │    │
└──────────┴──────────┴──────────┴────┘
  Grid of bookmarked moments
  Thumbnail at bookmarked timestamp
  Enter = play from that moment (enters Stage with clip as hero)
  Sorted by bookmark time (most recent first)
```

**Behavior:**
- Shows all `K`-bookmarked moments from the session
- Each tile shows clip frozen at bookmarked timestamp
- Enter plays from exact timestamp in Stage mode (clip becomes hero)
- Arrow navigation
- `Escape` or `J` returns to previous scene

---

## Advanced Mode: Power User Evolution

Advanced mode IS the current app with these refinements:

### Changes from Current

| Change | Old | New | Why |
|--------|-----|-----|-----|
| Star/Favorite | `L` | `Q` / `QQ` for filter | Left-hand triage cluster |
| Seek +/-10s | `,` / `.` only | `E` / `R` primary, `,`/`.` alias | Left-hand pair |
| Seek +/-60s | `<` / `>` only | `EE` / `RR` primary, `<`/`>` alias | Double-tap big jump |
| Reload stream | `R` single | `Shift+R` | Rare action, shifted |
| Favorites filter | `` ` `` | `QQ` double-tap | `` ` `` freed for mode toggle |
| Mode toggle | N/A | `` ` `` | Theater <-> Advanced |
| Force relayout | No key | `L` | L freed by Q taking star |
| Remove all unstarred | N/A | `XX` double-tap | New safety-netted bulk remove |
| Space double-tap | N/A | Play/pause all | Explicit double-tap |
| Mode indicator | Flash message (fades) | Persistent corner badge | Always know what's active |

**Everything else unchanged.** All 13+ modes, all stacking rules, all panels, all algorithms.

### Mode Indicator Badge

```
┌─────────────────────────────────────────────┐
│                                     T3 W2 A │
│                                             │
│            (video grid)                     │
│                                             │
└─────────────────────────────────────────────┘

T3 = Tetris mode 3 (Treemap)
W2 = Wall mode 2 (Crop)
A  = Smart Zoom active
```

Only shows active modes. Hidden when nothing active. Respects Clean Mode.

---

## Complete Key Map

### Double-Tap Philosophy

| Pattern | Meaning |
|---------|---------|
| Single tap | Action on selected clip |
| Double tap | Action on all clips or meta/filter action |
| Shift+key | Reverse direction on cycle keys |

### Universal Keys (identical in both modes)

| Key | Single Tap | Double Tap | Shift |
|-----|-----------|------------|-------|
| `` ` `` | Toggle Theater <-> Advanced | — | — |
| `Q` | Star/favorite selected | Filter to favorites | — |
| `1-9` | Rate selected | Filter to that rating | — |
| `0` | Show all (clear filter) | — | Clear rating on selected |
| `M` | Mute/unmute selected (audio follows if unmuted) | — | — |
| `N` | Mute all, stop audio follow | — | — |
| `I` | Stream info toggle | — | — |
| `Arrows` | Navigate clips (audio follows if unmuted) | — | — |
| `Z` / `Enter` | Focus/unfocus selected | — | — |
| `F` | True fullscreen toggle | — | — |
| `X` | Remove selected | Remove all unstarred | — |
| `Delete`/`Backspace` | Remove selected | — | — |
| `E` | Seek back 10s | Seek back 60s | — |
| `R` | Seek forward 10s | Seek forward 60s | Reload stream |
| `,` | Seek back 10s (alias) | — | Seek back 60s |
| `.` | Seek forward 10s (alias) | — | Seek forward 60s |
| `;` / `'` | Frame back / forward | — | — |
| `C` | Copy URL selected | — | Copy all URLs |
| `S` | Streams panel | — | `Ctrl+S` Save set |
| `D` | Saved sets panel | — | — |
| `P` | Picture-in-Picture | — | — |
| `B` | Bug Eye | — | Mosaic |
| `H` | Toggle header | — | Clean mode |
| `A` | Smart Zoom (face detect) | — | — |
| `=` | Remove duplicates | — | — |
| `?` | Help overlay | — | — |
| `\` | Rewind selected to start | — | — |
| `\|` | Rewind all to start | — | — |

### Theater-Only Keys

| Key | Single Tap | Double Tap | Shift |
|-----|-----------|------------|-------|
| `Space` | Next scene | Random seek (context-dependent) | Previous scene |
| `E` | Cycle Climax sub-mode (in Climax) | — | Reverse cycle |
| `K` | Bookmark moment (clip + timestamp) | — | — |
| `J` | Toggle Encore view | — | — |

Note: `E` serves dual purpose — seek in non-Climax scenes, Climax cycle in Climax scene.

### Advanced-Only Keys

| Key | Single Tap | Double Tap | Shift |
|-----|-----------|------------|-------|
| `Space` | Play/pause selected (or all) | Play/pause all | — |
| `T` | Cycle Tetris forward | — | Reset pan positions |
| `W` | Cycle Wall forward | — | Cycle Wall backward |
| `O` | Toggle Coverflow | — | — |
| `V` | Cycle view filter forward | — | Cycle backward |
| `G` | Cycle rating forward | — | Cycle backward |
| `L` | Force relayout | — | — |
| `/` | Random seek selected | Random seek all | — |
| `[` / `]` | Rotate CCW / CW | — | — |
| `{` / `}` | Shuffle randomly | — | — |

### Escape Ladder (both modes)

```
Overlay (Bug Eye / Mosaic / Help / Panels)
  | Escape
Wall mode (if active, Advanced only)
  | Escape
Fullscreen (true-focused)
  | Escape
Focus (browser-fill)
  | Escape
Current scene (Theater) / Grid (Advanced)
  | Escape (Theater only)
Previous Scene
  | Escape
Casting Call (Theater base) / Deselect (Advanced base)
```

---

## Mode Toggle Behavior

### Theater -> Advanced (press `` ` ``):
- Current scene's layout freezes in place
- Mode indicator badge appears
- All Advanced keys activate
- Layout stays until user changes it with T/W/O

### Advanced -> Theater (press `` ` ``):
- System maps current state to nearest scene:
  - All clips visible with crop -> Casting Call
  - Filtered to favorites/high-rated -> Lineup
  - Spotlight or one clip focused -> Stage
  - Overlay (Bug Eye/Mosaic) or max zoom -> Climax
- Theater keys activate, Space-based navigation takes over
- Mode indicator badge hides

Switching is seamless — clips don't jump around, layout doesn't reset. You're changing the control scheme, not the view.

---

## Implementation Architecture

Theater mode is primarily an **orchestration layer** over existing algorithms:

| Scene | Existing Algorithm | File |
|-------|--------------------|------|
| Casting Call | Wall Crop tile grid (wallMode === 2) | app.js, grid.js |
| Lineup | Tetris Treemap (tryTetrisSplitPack) | grid.js |
| Stage | Spotlight (calculateSpotlightLayout) | grid.js |
| Climax: Tight Wall | Wall Crop + zoom | app.js, grid.js |
| Climax: Auto-Rotate | Spotlight + timer | app.js, grid.js |
| Climax: Collage | Mosaic variant | app.js |
| Climax: Single Focus | browser-fill fullscreen | stream.js |
| Encore | New (bookmark grid) | app.js (new) |

New code needed:
- Theater state machine (scene tracking, transitions)
- Bookmark system (clip ID + timestamp storage)
- Encore view (bookmark grid layout)
- Scene transition animations (CSS transitions)
- Mode indicator badge (HTML/CSS)
- Key routing layer (Theater vs Advanced dispatch)
- Auto-rotate timer (Climax 4B)
- Rating-weighted treemap sizing (Lineup)
- Visual feedback: golden glow (starred), dim (low-rated)
- Space double-tap detection for random seek

Existing code reused as-is:
- All grid layout algorithms
- All stream management
- Face detection / Smart Zoom
- Pan/zoom system
- Rating and favorites storage
- Fullscreen modes
- Bug Eye and Mosaic overlays
- Audio focus / mute system
- Seeking, navigation, all playback controls
