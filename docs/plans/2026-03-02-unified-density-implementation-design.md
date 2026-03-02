# Unified Density System — Implementation Design

**Date:** 2026-03-02
**Status:** Approved
**Supersedes:** 2026-02-27-unified-density-keys-design.md (conceptual design)

## Decisions

| Decision | Choice |
|----------|--------|
| Scope | Full implementation — all 7 levels, Y variants, Enter/F shortcuts, Theater, bug fixes |
| Migration strategy | Parallel systems with feature flag. Old modes untouched, new system alongside |
| Feature toggle | Toolbar button (no key shortcut). Click toggles `useDensitySystem` |
| Layout engine | Clean reimplementation — new `calculateDensityLayout()` in grid.js |
| Mosaic (level 5 v0) | CSS grid (integrated into layout engine) |
| Bug Eye (level 5 v1) | Canvas overlay (preserved, activated via signal from layout engine) |
| Coverflow | Not fixed — broken, replaced by Grid variant 1 |

## State Model

```javascript
let useDensitySystem = false;    // Toolbar button toggles
let densityLevel = 2;            // -1 to 5 (default: Grid)
let styleVariant = 0;            // 0-2 per level
let prevDensityLevel = 2;        // For Enter/F toggle-back
```

### Density Levels

| Level | Name | Description |
|-------|------|-------------|
| -1 | FULLSCREEN | True browser fullscreen, no chrome |
| 0 | FOCUSED | Single stream fills container |
| 1 | SPOTLIGHT | Hero stream + thumbnail sidebar/strip |
| 2 | GRID | Even grid (default) |
| 3 | FILL | Crop-to-fill tiles |
| 4 | STRIPS | Vertical columns or horizontal rows |
| 5 | MOSAIC | Everything tiny and visible |

### Style Variants (Y key cycles)

| Level | Variant 0 | Variant 1 | Variant 2 |
|-------|-----------|-----------|-----------|
| 5 | Mosaic (CSS grid) | Bug Eye (canvas overlay) | — |
| 4 | Vertical columns | Horizontal rows | — |
| 3 | Crop tiles | Skyline bin-pack | Column-pack (masonry) |
| 2 | Even grid | Z-depth overlap | Content-visible |
| 1 | Hero + side thumbs | Hero + bottom strip | — |
| 0 | Browser-fill | — | — |
| -1 | True fullscreen | — | — |

## Unified Layout Engine (grid.js)

### Public API

```javascript
PlexdGrid.calculateDensityLayout(density, variant, container, streams, selectedIdx)
// Returns: layout array OR signal object
```

### Internal Dispatch

```javascript
calculateDensityLayout(density, variant, container, streams, selectedIdx) {
    switch (density) {
        case -1: return layoutFullscreen(container, streams, selectedIdx);
        case  0: return layoutFocused(container, streams, selectedIdx);
        case  1: return layoutSpotlight(variant, container, streams, selectedIdx);
        case  2: return layoutGrid(variant, container, streams, selectedIdx);
        case  3: return layoutFill(variant, container, streams, selectedIdx);
        case  4: return layoutStrips(variant, container, streams, selectedIdx);
        case  5: return layoutMosaic(variant, container, streams, selectedIdx);
    }
}
```

### Return Types

- **Normal layout:** `[{x, y, width, height}, ...]` — same format as existing functions
- **CSS grid signal:** `{type: 'mosaic-grid'}` — tells app.js to switch to CSS grid mode
- **Overlay signal:** `{type: 'overlay', mode: 'bugeye'}` — tells app.js to activate canvas overlay

### New Algorithms

- **Skyline bin-pack** (level 3 variant 1): Tiles placed bottom-up along a skyline contour, minimizing vertical gaps
- **Column-pack / masonry** (level 3 variant 2): Items placed in shortest column, Pinterest-style
- **Spotlight** (level 1): Hero gets ~70% width, remaining streams stack in column (v0) or row (v1)

### Reused From Existing grid.js

- Even grid calculation → level 2 variant 0
- Tetris rows/columns → level 4 variants
- Crop-to-fill tile sizing → level 3 variant 0

## Key Handling (app.js)

### Feature Flag

Toolbar button `#density-btn` toggles `useDensitySystem`. On toggle:
- **Entering density:** Map current old-mode state to nearest density level for seamless transition
- **Leaving density:** Map density state back to old mode vars

### Density Key Handler

```javascript
// In handleKeyboard(), after moment browser / theater checks:
if (useDensitySystem) {
    if (handleDensityKeys(e)) return;
}
```

| Key | Action |
|-----|--------|
| `-` | `setDensity(densityLevel - 1)` |
| `=` | `setDensity(densityLevel + 1)` |
| `Y` | `cycleStyleVariant()` |
| `Enter` / `Z` | Toggle Focused (level 0) ↔ `prevDensityLevel` |
| `F` | Toggle Fullscreen (level -1) ↔ `prevDensityLevel` |

When density is active, old keys `T`, `W`, `O`, `B`, `Shift+B` are no-ops.

### setDensity() Function

```javascript
function setDensity(level) {
    level = Math.max(-1, Math.min(5, level));
    if (level === densityLevel) return;

    // Cleanup outgoing level
    if (densityLevel === 5 && styleVariant === 1) closeBugEyeOverlay();

    prevDensityLevel = densityLevel;
    densityLevel = level;
    styleVariant = 0;  // Reset variant on level change

    // Fullscreen API calls
    if (level === -1) enterTrueFullscreen();
    if (prevDensityLevel === -1 && level !== -1) exitTrueFullscreen();

    updateGrid();
    updateDensityIndicator();
    showMessage(getDensityLabel(), 'info');
}
```

### updateGrid() Integration

```javascript
if (useDensitySystem) {
    const result = PlexdGrid.calculateDensityLayout(
        densityLevel, styleVariant, container, streamsToShow, selectedIdx
    );
    if (result.type === 'overlay') {
        activateOverlay(result.mode);       // Bug Eye canvas
    } else if (result.type === 'mosaic-grid') {
        applyMosaicGrid(result, streamsToShow);  // CSS grid
    } else {
        applyLayout(result, streamsToShow);      // Normal positioning
    }
} else {
    // Existing layout logic — untouched
}
```

## CSS

### Class Namespace

```css
.plexd-app.density-active { }
.plexd-app.density-level-N { }   /* N = -1 to 5 */
.plexd-app.density-variant-N { } /* N = 0 to 2 */
```

### Rendering Approach

- Levels -1 through 4: JavaScript-calculated positions via `transform: translate()` + `width`/`height` (same as current)
- Level 5 variant 0 (Mosaic): CSS grid with `grid-template-columns: repeat(auto-fill, minmax(120px, 1fr))`
- No transition animations on layout properties (per CLAUDE.md)
- Bug Eye overlay uses `opacity` transition only (GPU-composited)

### Density Indicator

Reuses mode indicator element. Shows level name, adds variant name when variant > 0:
- `Grid` (level 2, variant 0)
- `Fill > Skyline` (level 3, variant 1)

## Bug Fixes

### 1. Climax E cycling stuck in Single Focus
- Fix in old system: `applyClimaxSubMode()` calls `exitFocusedMode()` when leaving sub-mode 3
- Density system: inherently solved — `setDensity()` handles transitions

### 2. Crop toggle broken in true fullscreen
- Both systems: `video.style.setProperty('object-fit', 'cover', 'important')` to override `:fullscreen` CSS rule

### 3. Spotlight arrows don't change hero
- Old system: `handleArrowNav` rotates hero when `wallMode === 3`
- Density system: `handleArrowNav` rotates hero when `densityLevel === 1`

### 4. Enter/F only work from adjacent modes
- Old system: leave as-is (partial fix not worth the complexity)
- Density system: inherently solved — Enter/F toggle from any level

## Theater Integration

`applyTheaterScene()` gets a density-aware branch:

| Scene | Density equivalent |
|-------|--------------------|
| Casting | `setDensity(5); styleVariant = 0` (Mosaic) |
| Lineup | `setDensity(2); styleVariant = 0` (Grid) |
| Stage | `setDensity(0)` (Focused) |
| Climax | `setDensity(3-5)` based on sub-mode |
| Encore | Moment Browser (unchanged) |

```javascript
if (useDensitySystem) {
    applyTheaterSceneDensity(scene);
} else {
    // existing theater logic
}
```

## Files Modified

| File | Changes |
|------|---------|
| `web/js/grid.js` | New `calculateDensityLayout()` + level-specific layout functions |
| `web/js/app.js` | State vars, `handleDensityKeys()`, `setDensity()`, `updateGrid()` branch, toolbar button, Theater branch, bug fixes |
| `web/css/plexd.css` | Density class styles, mosaic grid, toolbar button, indicator |
| `web/index.html` | Density toolbar button element |
