# Unified Density & Key Bindings Redesign

**Date:** 2026-02-27
**Status:** Approved

## Problem

Plexd has ~20+ view states across overlapping systems (Grid, Tetris with 4 sub-modes, Wall with 3 sub-modes, Coverflow, Focused, Bug Eye, Mosaic, Theater with 5 scenes). Keys are arbitrarily assigned, some have dangerous dual meanings (XX removes all unstarred), and some modes conflict (Tetris crop tiles vs Wall crop tiles vs Climax tight wall).

## Core Insight

All view modes map to a single **density axis**: how many streams are visible and how much space each gets. Layout style is a secondary concern. Crop/contain and filters are orthogonal.

## Design: Three Orthogonal Axes

| Axis | What it controls | Keys |
|------|-----------------|------|
| **Density** | How many streams, how much space each | `-` / `=` |
| **Filter** | Which streams are shown | `V`, `0-9`, `QQ` |
| **Presentation** | How each stream looks | `Opt+Up/Down`, `Shift+H`, `I` |

### Axis 1: Unified Density Spectrum

7 levels controlled by `-` (less dense) and `=` (more dense):

```
-1         0          1          2          3          4          5
FULLSCREEN FOCUSED    SPOTLIGHT  GRID       FILL       STRIPS     MOSAIC
true FS    browser-   hero+      even       crop to    vertical   everything
no chrome  fill       thumbs     grid       fill       columns    visible
```

**Style variants** at each level with `Y`:

| Level | Style 1 | Style 2 | Style 3 |
|-------|---------|---------|---------|
| 5 Mosaic | Mosaic (clean) | Bug Eye (compound) | — |
| 4 Strips | Vertical columns | Horizontal rows | — |
| 3 Fill | Crop tiles | Skyline pack | Column pack |
| 2 Grid | Even grid | Coverflow | Content-visible |
| 1 Spotlight | Hero+side | Hero+bottom | — |
| 0 Focused | Browser-fill | — | — |
| -1 Fullscreen | True fullscreen | — | — |

**Density shortcuts:**
- `Enter` / `Z` = toggle Focused (level 0) ↔ previous density level. Works from ANY level.
- `F` = toggle Fullscreen (level -1) ↔ previous density level. Works from ANY level.

### Axis 2: Filter (unchanged)

- `V` / `Shift+V` — cycle view filter (all → 1★ → 2★ → ... → 9★ → favorites)
- `0` — show all
- `1-9` — tap = assign rating, double-tap = filter to that slot
- `Q` — star, `QQ` = filter starred
- `G` — cycle rating on selected

### Axis 3: Presentation (unchanged)

- `Opt+Up` — toggle crop/contain on selected stream
- `Opt+Down` — toggle crop/contain on all streams
- `Shift+H` — clean mode (hide per-stream controls)
- `I` — stream info overlay

## Deprecated Mode Keys

| Old Key | Old Function | Replacement |
|---------|-------------|-------------|
| `T` | Tetris cycle (4 sub-modes) | Density levels 3-4 + Y variants |
| `W` | Wall cycle (3 sub-modes) | Density levels 1, 4 + Y variants |
| `O` | Coverflow toggle | Y variant at Grid density |
| `B` / `Shift+B` | Bug Eye / Mosaic | Y variants at Mosaic density |

`W` retains its Moment Browser Wall edit function (context-dependent).

## Stream Management Fix

**X = close stream.** No double-tap variant. The old `XX` (remove all unstarred) is removed — too dangerous for accidental activation. Mass removal available through Sets panel or a confirmation-gated UI action.

## Theater Mode (preserved)

Theater is a guided path through density levels. Manual density keys override within Theater.

| Scene | Key/Auto | Density equiv |
|-------|----------|---------------|
| Casting | auto on enter | ~Level 5 (Mosaic) |
| Lineup | Tab/Space | ~Level 2 (Grid, filtered) |
| Stage | Tab/Space | ~Level 0 (Focused) |
| Climax | C | ~Level 3-4 + sub-modes |
| Encore | N | Moment Browser (J) |

Theater keys:
- `` ` `` — toggle Theater/Advanced
- `Tab` / `Shift+Tab` — next/prev scene
- `Space` — advance (Casting/Lineup), play/pause (other)
- `C` — enter Climax
- `N` — enter Encore
- `E` / `Shift+E` — cycle Climax sub-mode
- `Esc` — regress scene

## Bug Fixes (part of implementation)

### 1. Climax E cycling stuck in Single Focus

When `E` cycles Climax to sub-mode 3 (Single Focus), it enters focused mode. Pressing `E` again to cycle to sub-mode 0 (Tight Wall) does not exit focused mode first — the new layout is invisible behind the focused stream.

**Fix:** `applyClimaxSubMode()` must call `exitFocusedMode()` when transitioning away from sub-mode 3.

### 2. Crop toggle broken in true fullscreen

CSS rule `.plexd-app:fullscreen video { object-fit: contain !important }` overrides inline styles set by the Opt+Up/Down crop toggle.

**Fix:** Use `video.style.setProperty('object-fit', 'cover', 'important')` instead of `video.style.objectFit = 'cover'` to match `!important` priority.

### 3. Spotlight arrows don't change hero

In Spotlight mode (Wall mode 3), arrow keys only select streams but don't change which stream is the hero. This is already implemented for Theater Stage scene (`handleArrowNav` checks `theaterScene === 'stage'` and rotates hero). Spotlight should use the same logic: left/right rotates hero, up/down navigates ensemble.

### 4. Enter/F only work from adjacent modes

Currently Enter only toggles between grid and focused. F only works from focused mode.

**Fix:** Enter/F should jump to Focused/Fullscreen from ANY density level and toggle back to the previous level.

## Full Keyboard Map

### Right hand (around arrows) — viewing controls

| Key | Action | Category |
|-----|--------|----------|
| `-` | Less dense (← in spectrum) | Density |
| `=` | More dense (→ in spectrum) | Density |
| `Y` | Cycle style variant at current density | Density/Style |
| `Enter`/`Z` | Toggle Focused ↔ previous density | Density shortcut |
| `F` | Toggle Fullscreen ↔ previous density | Density shortcut |
| `Opt+↑` | Crop/contain toggle (selected) | Presentation |
| `Opt+↓` | Crop/contain toggle (all) | Presentation |
| `Opt+←/→` | Cycle view mode backward/forward | Filter |
| `,` `.` | Seek ±10s | Transport |
| `<` `>` | Seek ±60s | Transport |
| `;` `'` | Frame step ±1 | Transport |
| `/` | Random seek, `//` = all | Transport |
| `\` | Rewind, `\|` = all | Transport |
| `[` `]` | Rotate CW/CCW | Arrangement |
| `{` `}` | Shuffle | Arrangement |
| `←↑↓→` | Navigate/select streams | Navigation |

### Left hand — actions & panels

| Key | Action | Category |
|-----|--------|----------|
| `Q` | Star, `QQ` = filter starred | Rating |
| `1-9` | Assign (tap), filter (double-tap) | Rating |
| `0` | Show all | Rating |
| `G` | Cycle rating | Rating |
| `V` | Cycle view filter, `Shift+V` = reverse | Filter |
| `K` | Capture moment, `Shift+K` = all | Moments |
| `J` | Moment Browser | Moments |
| `M` | Audio toggle (mute/unmute + follow) | Audio |
| `Shift+H` | Clean mode | Presentation |
| `H` | Toggle header | UI |
| `I` | Stream info | UI |
| `S` | Streams panel | UI |
| `D` | Sets panel | UI |
| `X` | Close stream | Management |
| `Shift+R` | Reload, `Shift+RR` = all | Management |
| `C` | Copy URL (Adv) / Climax (Theater) | Context-dependent |
| `P` | PiP | Utility |
| `L` | Force relayout | Utility |
| `A` | Smart Zoom (face detection) | Utility |
| `Cmd+S` | Save set | Save |
| `?` | Help, `??` = random moment | Help |

### Freed keys (available for future)

`T`, `W` (main view), `O`, `B`, `E` (outside Climax), `R` (unshifted), `N` (Advanced), `U`

## Design Principles

1. **One-handed right hand** — primary controls around arrow cluster
2. **Density as primary axis** — most mode switching is really density control
3. **Orthogonal axes** — density, filter, presentation are independent
4. **No dangerous double-taps** — removed XX, all destructive actions require deliberate gesture
5. **Theater preserved** — guided mode complements manual controls
6. **Minimal key reassignment** — ratings, transport, navigation unchanged
