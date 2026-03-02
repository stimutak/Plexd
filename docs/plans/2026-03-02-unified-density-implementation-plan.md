# Unified Density System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace 5 independent layout mode toggles (Tetris/Wall/Coverflow/BugEye/Mosaic) with a unified 7-level density spectrum controlled by `-`/`=` keys, activated via toolbar button feature flag.

**Architecture:** Parallel system — new density state + layout engine runs alongside untouched old modes. Toolbar button toggles which system is active. New `calculateDensityLayout()` in grid.js dispatches to level-specific layout functions. Mosaic integrates as CSS grid; Bug Eye stays as canvas overlay activated by signal.

**Tech Stack:** Vanilla JS (IIFE modules), CSS3, HTML5. No frameworks.

**Key Files:**
- `web/js/grid.js` (2002 lines) — Layout engine IIFE, exports at line 1981
- `web/js/app.js` (13629 lines) — App IIFE, mode vars at 626-653, layout at 2561-2781, keyboard at ~7934
- `web/js/stream.js` (5058 lines) — `propagateKeys` regex at line 2293
- `web/css/plexd.css` — Mode classes at various locations
- `web/index.html` — Toolbar buttons at lines 69-72

**Verification:** No test framework. Use `node --check <file>` for syntax, `./scripts/start-server.sh` + browser for functional testing.

---

### Task 1: Density State Model

**Files:**
- Modify: `web/js/app.js:626-668` (after existing mode vars)
- Modify: `web/js/app.js:12976+` (public API exports)

**Step 1: Add density state variables after line 640**

Insert after the `smartLayoutMode` declaration (line 640), before `headerVisible` (line 642):

```javascript
    // =========================================================================
    // Unified Density System (parallel to old T/W/O/B modes)
    // =========================================================================
    let useDensitySystem = false;
    window._plexdUseDensitySystem = useDensitySystem;

    // Density level: -1=Fullscreen, 0=Focused, 1=Spotlight, 2=Grid, 3=Fill, 4=Strips, 5=Mosaic
    let densityLevel = 2; // Default: Grid
    window._plexdDensityLevel = densityLevel;

    let styleVariant = 0; // 0-2 per level, Y key cycles
    window._plexdStyleVariant = styleVariant;

    let prevDensityLevel = 2; // For Enter/F toggle-back
    window._plexdPrevDensityLevel = prevDensityLevel;

    const DENSITY_NAMES = ['Fullscreen', 'Focused', 'Spotlight', 'Grid', 'Fill', 'Strips', 'Mosaic'];
    const DENSITY_VARIANT_NAMES = {
        '-1': [['Fullscreen']],
        '0':  [['Focused']],
        '1':  [['Hero + Side', 'Hero + Bottom']],
        '2':  [['Even Grid', 'Z-Depth', 'Content Visible']],
        '3':  [['Crop Tiles', 'Skyline', 'Masonry']],
        '4':  [['Vertical Columns', 'Horizontal Rows']],
        '5':  [['Mosaic', 'Bug Eye']]
    };
    // Max variant index per level (0-indexed)
    const DENSITY_MAX_VARIANT = { '-1': 0, '0': 0, '1': 1, '2': 2, '3': 2, '4': 1, '5': 1 };

    function setDensityLevel(val) { densityLevel = val; window._plexdDensityLevel = val; }
    function setStyleVariant(val) { styleVariant = val; window._plexdStyleVariant = val; }
    function setUseDensitySystem(val) { useDensitySystem = val; window._plexdUseDensitySystem = val; }
```

**Step 2: Add public API exports**

In the `return {` block starting at line 12976, add after `toggleCast,` (line 13039):

```javascript
        // Density system
        toggleDensitySystem,
        setDensity,
        cycleStyleVariant,
        getDensityLevel: function() { return densityLevel; },
        getStyleVariant: function() { return styleVariant; },
        isDensityActive: function() { return useDensitySystem; },
```

**Step 3: Verify syntax**

Run: `node --check web/js/app.js`
Expected: No output (clean syntax)

**Step 4: Commit**

```bash
git add web/js/app.js
git commit -m "feat(density): add state model variables and public API"
```

---

### Task 2: Toolbar Button & CSS

**Files:**
- Modify: `web/index.html:72-73` (after wall button, before smart-zoom)
- Modify: `web/css/plexd.css` (add density button + indicator styles)

**Step 1: Add density toolbar button in index.html**

Insert between the wall button (line 72) and smart-zoom button (line 73):

```html
                <button id="density-btn" class="plexd-button plexd-button-secondary plexd-density-btn" onclick="PlexdApp.toggleDensitySystem()" title="Unified Density System [-/= keys]">◈</button>
```

**Step 2: Add CSS for density button and level indicator**

Append to `web/css/plexd.css`:

```css
/* =========================================================================
   Unified Density System
   ========================================================================= */

/* Toolbar button */
.plexd-density-btn.active {
    background: #3b82f6 !important;
    color: white !important;
}

/* Density level classes on .plexd-app */
.plexd-app.density-active .plexd-stream {
    transition: none; /* No layout transitions — instant snap */
}

/* Mosaic: CSS grid at density level 5, variant 0 */
.plexd-app.density-level-5.density-variant-0 .plexd-grid {
    display: grid !important;
    grid-template-columns: repeat(auto-fill, minmax(120px, 1fr));
    gap: 2px;
}
.plexd-app.density-level-5.density-variant-0 .plexd-stream {
    position: static !important;
    width: auto !important;
    height: auto !important;
    aspect-ratio: 16/9;
    transform: none !important;
}
.plexd-app.density-level-5.density-variant-0 .plexd-stream .plexd-video {
    object-fit: cover;
}

/* Density indicator badge */
.badge-density {
    background: #3b82f6;
    color: white;
}
```

**Step 3: Verify**

Run: `./scripts/start-server.sh` and check button appears in toolbar.
Expected: Diamond (◈) button visible between W and Smart Zoom buttons.

**Step 4: Commit**

```bash
git add web/index.html web/css/plexd.css
git commit -m "feat(density): add toolbar button and CSS classes"
```

---

### Task 3: Layout Engine — Dispatcher + Fullscreen + Focused

**Files:**
- Modify: `web/js/grid.js:1981-1996` (add to public API)
- Modify: `web/js/grid.js` (add new functions before the `return` block at line 1981)

**Step 1: Add the layout dispatcher and simple level functions**

Insert before line 1981 (`// Public API`) in grid.js:

```javascript
    // =========================================================================
    // Unified Density Layout Engine
    // =========================================================================

    /**
     * Unified density layout dispatcher.
     * @param {number} density - Level from -1 (fullscreen) to 5 (mosaic)
     * @param {number} variant - Style variant index (0-2)
     * @param {Object} container - {width, height}
     * @param {Array} streams - Stream objects
     * @param {number} selectedIdx - Index of selected stream in array
     * @returns {Object} Layout result: {cells, rows, cols, mode} OR signal {type, mode}
     */
    function calculateDensityLayout(density, variant, container, streams, selectedIdx) {
        if (streams.length === 0) return { cells: [], rows: 0, cols: 0, mode: 'empty' };

        switch (density) {
            case -1: return densityFullscreen(container, streams, selectedIdx);
            case  0: return densityFocused(container, streams, selectedIdx);
            case  1: return densitySpotlight(variant, container, streams, selectedIdx);
            case  2: return densityGrid(variant, container, streams, selectedIdx);
            case  3: return densityFill(variant, container, streams, selectedIdx);
            case  4: return densityStrips(variant, container, streams, selectedIdx);
            case  5: return densityMosaic(variant, container, streams, selectedIdx);
            default: return densityGrid(0, container, streams, selectedIdx);
        }
    }

    /**
     * Level -1: Fullscreen — selected stream fills entire container, others hidden.
     * True fullscreen API call is handled by app.js, this just provides positioning.
     */
    function densityFullscreen(container, streams, selectedIdx) {
        var idx = (selectedIdx >= 0 && selectedIdx < streams.length) ? selectedIdx : 0;
        var cells = streams.map(function(s, i) {
            return {
                streamId: s.id,
                x: 0, y: 0,
                width: container.width,
                height: container.height,
                hidden: i !== idx
            };
        });
        return { cells: cells, rows: 1, cols: 1, mode: 'density-fullscreen' };
    }

    /**
     * Level 0: Focused — selected stream fills container (browser-level, no true FS).
     */
    function densityFocused(container, streams, selectedIdx) {
        var idx = (selectedIdx >= 0 && selectedIdx < streams.length) ? selectedIdx : 0;
        var cells = streams.map(function(s, i) {
            return {
                streamId: s.id,
                x: 0, y: 0,
                width: container.width,
                height: container.height,
                hidden: i !== idx
            };
        });
        return { cells: cells, rows: 1, cols: 1, mode: 'density-focused' };
    }
```

**Step 2: Add placeholder stubs for remaining levels**

These will be replaced in subsequent tasks. Add after `densityFocused`:

```javascript
    // Placeholder stubs — replaced in Tasks 4-8
    function densitySpotlight(variant, container, streams, selectedIdx) {
        return calculateSpotlightLayout(container, streams); // Reuse existing
    }
    function densityGrid(variant, container, streams, selectedIdx) {
        return calculateLayout(container, streams); // Reuse existing
    }
    function densityFill(variant, container, streams, selectedIdx) {
        return calculateTetrisLayout(container, streams, 1); // Reuse rows
    }
    function densityStrips(variant, container, streams, selectedIdx) {
        return calculateStripsLayout(container, streams); // Reuse existing
    }
    function densityMosaic(variant, container, streams, selectedIdx) {
        if (variant === 1) return { type: 'overlay', mode: 'bugeye' };
        return { type: 'mosaic-grid' }; // Signal for CSS grid
    }
```

**Step 3: Export the new function**

Add to the `return` block at line 1981:

```javascript
        calculateDensityLayout,
```

**Step 4: Verify syntax**

Run: `node --check web/js/grid.js`
Expected: No output (clean syntax)

**Step 5: Commit**

```bash
git add web/js/grid.js
git commit -m "feat(density): add layout dispatcher with fullscreen/focused + stubs"
```

---

### Task 4: Layout Engine — Grid Variants (Level 2)

**Files:**
- Modify: `web/js/grid.js` (replace `densityGrid` stub)

**Step 1: Replace the `densityGrid` stub**

Replace the placeholder with the full implementation:

```javascript
    /**
     * Level 2: Grid — even grid, Z-depth overlap, or content-visible.
     * Variant 0: Standard even grid (reuses existing calculateLayout)
     * Variant 1: Z-depth overlap — center stream large, others layered behind
     * Variant 2: Content-visible — lazy-rendered tiles with CSS content-visibility
     */
    function densityGrid(variant, container, streams, selectedIdx) {
        if (variant === 0) {
            // Standard even grid
            return calculateLayout(container, streams);
        }

        if (variant === 1) {
            // Z-depth overlap: selected stream prominent, others stacked behind
            var idx = (selectedIdx >= 0 && selectedIdx < streams.length) ? selectedIdx : 0;
            var count = streams.length;
            var centerW = container.width * 0.65;
            var centerH = container.height * 0.65;
            var centerX = (container.width - centerW) / 2;
            var centerY = (container.height - centerH) / 2;

            var cells = streams.map(function(s, i) {
                if (i === idx) {
                    return {
                        streamId: s.id,
                        x: centerX, y: centerY,
                        width: centerW, height: centerH,
                        zIndex: count + 1,
                        opacity: 1,
                        isSelected: true
                    };
                }
                // Fan others behind, offset by position relative to selected
                var offset = i - idx;
                if (offset > count / 2) offset -= count;
                if (offset < -count / 2) offset += count;
                var sideScale = 0.4;
                var sideW = container.width * sideScale;
                var sideH = container.height * sideScale;
                var spreadX = offset * (container.width * 0.12);
                var spreadY = Math.abs(offset) * 8;
                return {
                    streamId: s.id,
                    x: (container.width - sideW) / 2 + spreadX,
                    y: (container.height - sideH) / 2 + spreadY,
                    width: sideW, height: sideH,
                    zIndex: count - Math.abs(offset),
                    opacity: Math.max(0.3, 1 - Math.abs(offset) * 0.15),
                    isSelected: false
                };
            });
            return { cells: cells, rows: 1, cols: count, mode: 'density-grid-zdepth', selectedIndex: idx };
        }

        if (variant === 2) {
            // Content-visible: standard grid but mark cells for CSS content-visibility
            var layout = calculateLayout(container, streams);
            layout.mode = 'density-grid-content-visible';
            layout.cells.forEach(function(cell) { cell.contentVisible = true; });
            return layout;
        }

        return calculateLayout(container, streams);
    }
```

**Step 2: Verify syntax**

Run: `node --check web/js/grid.js`

**Step 3: Commit**

```bash
git add web/js/grid.js
git commit -m "feat(density): implement Grid level variants (even/z-depth/content-visible)"
```

---

### Task 5: Layout Engine — Spotlight Variants (Level 1)

**Files:**
- Modify: `web/js/grid.js` (replace `densitySpotlight` stub)

**Step 1: Replace the `densitySpotlight` stub**

```javascript
    /**
     * Level 1: Spotlight — hero stream prominent, others as thumbnails.
     * Variant 0: Hero + side column of thumbs
     * Variant 1: Hero + bottom row of thumbs
     */
    function densitySpotlight(variant, container, streams, selectedIdx) {
        if (streams.length === 1) return singleStreamLayout(container, streams[0]);

        // Move selected to front as hero
        var idx = (selectedIdx >= 0 && selectedIdx < streams.length) ? selectedIdx : 0;
        var ordered = streams.slice();
        if (idx > 0) {
            var hero = ordered.splice(idx, 1)[0];
            ordered.unshift(hero);
        }

        if (variant === 1) {
            // Hero + bottom row
            return densitySpotlightBottom(container, ordered);
        }

        // Default (variant 0): Hero + side column — reuse existing spotlight
        return calculateSpotlightLayout(container, ordered);
    }

    /**
     * Spotlight variant 1: Hero on top (~70% height), thumbnails in bottom row.
     */
    function densitySpotlightBottom(container, streams) {
        var gap = 4;
        var thumbCount = streams.length - 1;
        var heroRatio = thumbCount > 0 ? 0.7 : 1;
        var heroH = container.height * heroRatio - (thumbCount > 0 ? gap / 2 : 0);
        var cells = [{
            streamId: streams[0].id,
            x: 0, y: 0,
            width: container.width,
            height: heroH,
            objectFit: 'cover',
            isSpotlightHero: true
        }];

        if (thumbCount > 0) {
            var thumbH = container.height - heroH - gap;
            var thumbW = (container.width - gap * (thumbCount - 1)) / thumbCount;
            for (var i = 0; i < thumbCount; i++) {
                cells.push({
                    streamId: streams[i + 1].id,
                    x: i * (thumbW + gap),
                    y: heroH + gap,
                    width: thumbW,
                    height: thumbH,
                    objectFit: 'cover'
                });
            }
        }

        return { cells: cells, rows: 2, cols: streams.length, mode: 'density-spotlight-bottom' };
    }
```

**Step 2: Verify syntax**

Run: `node --check web/js/grid.js`

**Step 3: Commit**

```bash
git add web/js/grid.js
git commit -m "feat(density): implement Spotlight level variants (side/bottom)"
```

---

### Task 6: Layout Engine — Fill Variants (Level 3)

**Files:**
- Modify: `web/js/grid.js` (replace `densityFill` stub)

**Step 1: Replace the `densityFill` stub**

```javascript
    /**
     * Level 3: Fill — streams fill all space, minimal/no gaps.
     * Variant 0: Crop tiles (edge-to-edge with object-fit:cover)
     * Variant 1: Skyline bin-pack (bottom-up, Tetris-like settling)
     * Variant 2: Column-pack / masonry (shortest column gets next item)
     */
    function densityFill(variant, container, streams, selectedIdx) {
        if (variant === 1) return densityFillSkyline(container, streams);
        if (variant === 2) return densityFillMasonry(container, streams);
        return densityFillCrop(container, streams, selectedIdx);
    }

    /**
     * Fill variant 0: Crop tiles — edge-to-edge grid, all cells object-fit:cover.
     */
    function densityFillCrop(container, streams, selectedIdx) {
        var count = streams.length;
        if (count === 0) return { cells: [], rows: 0, cols: 0, mode: 'density-fill-crop' };

        // Find optimal rows/cols that maximize 16:9 cell shape and fill
        var bestRows = 1, bestCols = count, bestScore = -Infinity;
        for (var r = 1; r <= count; r++) {
            var c = Math.ceil(count / r);
            if ((r * c) - count >= c) continue;
            var cellRatio = (container.width / c) / (container.height / r);
            var score = (1 - Math.abs(cellRatio - 16/9) / (16/9)) * 0.6 + (count / (r * c)) * 0.4;
            if (score > bestScore) { bestRows = r; bestCols = c; bestScore = score; }
        }

        var cellW = container.width / bestCols;
        var cellH = container.height / bestRows;
        var selectedStream = selectedIdx >= 0 && selectedIdx < count ? streams[selectedIdx] : null;
        var selectedId = selectedStream ? selectedStream.id : null;

        var cells = streams.map(function(s, i) {
            return {
                streamId: s.id,
                x: (i % bestCols) * cellW,
                y: Math.floor(i / bestCols) * cellH,
                width: cellW,
                height: cellH,
                objectFit: 'cover',
                wallCropZoom: (s.id === selectedId) ? 2.2 : 1.8,
                isWallCropSelected: s.id === selectedId
            };
        });

        return { cells: cells, rows: bestRows, cols: bestCols, mode: 'density-fill-crop' };
    }

    /**
     * Fill variant 1: Skyline bin-pack.
     * Places tiles along a rising "skyline" contour, like Tetris pieces settling.
     * Each stream placed at the position with the lowest current height.
     */
    function densityFillSkyline(container, streams) {
        var count = streams.length;
        var cols = Math.max(2, Math.ceil(Math.sqrt(count * (container.width / container.height))));
        var colWidth = container.width / cols;
        var skyline = new Array(cols).fill(0); // Track height of each column

        var cells = streams.map(function(s) {
            // Find lowest point on skyline
            var minH = Infinity, minCol = 0;
            for (var c = 0; c < cols; c++) {
                if (skyline[c] < minH) { minH = skyline[c]; minCol = c; }
            }

            // Cell height based on aspect ratio (assume 16:9 if unknown)
            var aspect = (s.video && s.video.videoWidth && s.video.videoHeight)
                ? s.video.videoWidth / s.video.videoHeight : 16 / 9;
            var cellH = colWidth / aspect;

            var cell = {
                streamId: s.id,
                x: minCol * colWidth,
                y: minH,
                width: colWidth,
                height: cellH,
                objectFit: 'cover'
            };

            skyline[minCol] += cellH;
            return cell;
        });

        // Scale to fit container height
        var maxH = Math.max.apply(null, skyline);
        if (maxH > 0 && maxH !== container.height) {
            var scale = container.height / maxH;
            cells.forEach(function(c) {
                c.y *= scale;
                c.height *= scale;
            });
        }

        return { cells: cells, rows: count, cols: cols, mode: 'density-fill-skyline' };
    }

    /**
     * Fill variant 2: Column-pack / masonry.
     * Items placed in shortest column, Pinterest-style.
     */
    function densityFillMasonry(container, streams) {
        var count = streams.length;
        var cols = Math.max(2, Math.ceil(Math.sqrt(count * (container.width / container.height))));
        var colWidth = container.width / cols;
        var gap = 2;
        var colHeights = new Array(cols).fill(0);

        var cells = streams.map(function(s) {
            // Find shortest column
            var minH = Infinity, minCol = 0;
            for (var c = 0; c < cols; c++) {
                if (colHeights[c] < minH) { minH = colHeights[c]; minCol = c; }
            }

            var aspect = (s.video && s.video.videoWidth && s.video.videoHeight)
                ? s.video.videoWidth / s.video.videoHeight : 16 / 9;
            var effectiveWidth = colWidth - gap;
            var cellH = effectiveWidth / aspect;

            var cell = {
                streamId: s.id,
                x: minCol * colWidth + gap / 2,
                y: colHeights[minCol] + gap / 2,
                width: effectiveWidth,
                height: cellH,
                objectFit: 'contain'
            };

            colHeights[minCol] += cellH + gap;
            return cell;
        });

        return { cells: cells, rows: count, cols: cols, mode: 'density-fill-masonry' };
    }
```

**Step 2: Verify syntax**

Run: `node --check web/js/grid.js`

**Step 3: Commit**

```bash
git add web/js/grid.js
git commit -m "feat(density): implement Fill level variants (crop/skyline/masonry)"
```

---

### Task 7: Layout Engine — Strips Variants (Level 4)

**Files:**
- Modify: `web/js/grid.js` (replace `densityStrips` stub)

**Step 1: Replace the `densityStrips` stub**

```javascript
    /**
     * Level 4: Strips — streams in columns or rows.
     * Variant 0: Vertical columns (reuses existing calculateStripsLayout)
     * Variant 1: Horizontal rows
     */
    function densityStrips(variant, container, streams, selectedIdx) {
        if (variant === 0) {
            return calculateStripsLayout(container, streams);
        }

        // Variant 1: Horizontal rows — each stream gets a full-width row
        var count = streams.length;
        var rowH = container.height / count;
        var cells = streams.map(function(s, i) {
            return {
                streamId: s.id,
                x: 0,
                y: i * rowH,
                width: container.width,
                height: rowH,
                objectFit: 'cover'
            };
        });

        return { cells: cells, rows: count, cols: 1, mode: 'density-strips-horizontal' };
    }
```

**Step 2: Verify syntax**

Run: `node --check web/js/grid.js`

**Step 3: Commit**

```bash
git add web/js/grid.js
git commit -m "feat(density): implement Strips level variants (columns/rows)"
```

---

### Task 8: Layout Engine — Mosaic Signal (Level 5)

**Files:**
- Modify: `web/js/grid.js` (replace `densityMosaic` stub)

**Step 1: Replace the `densityMosaic` stub**

```javascript
    /**
     * Level 5: Mosaic — everything tiny and visible.
     * Variant 0: CSS grid mosaic — returns signal for app.js to apply CSS grid mode.
     *   The actual positioning is handled by CSS (grid-template-columns on .plexd-grid).
     *   We still return cells so app.js knows which streams are involved.
     * Variant 1: Bug Eye — returns overlay signal for app.js to activate canvas overlay.
     */
    function densityMosaic(variant, container, streams, selectedIdx) {
        if (variant === 1) {
            // Signal app.js to activate Bug Eye canvas overlay
            return { type: 'overlay', mode: 'bugeye' };
        }

        // Variant 0: CSS grid mosaic — return cell list (positions ignored, CSS handles layout)
        var cells = streams.map(function(s) {
            return { streamId: s.id, x: 0, y: 0, width: 0, height: 0 };
        });
        return { type: 'mosaic-grid', cells: cells, rows: 0, cols: 0, mode: 'density-mosaic' };
    }
```

**Step 2: Verify syntax**

Run: `node --check web/js/grid.js`

**Step 3: Commit**

```bash
git add web/js/grid.js
git commit -m "feat(density): implement Mosaic level (CSS grid signal + Bug Eye overlay)"
```

---

### Task 9: Key Handler & Core Functions

**Files:**
- Modify: `web/js/app.js` (add density key handler + core functions)

**Step 1: Add `setDensity()`, `cycleStyleVariant()`, and `toggleDensitySystem()` functions**

Insert these after the `setWallMode`/`setTetrisMode`/`_setTheaterScene` setters (~line 668), before the utility helpers section:

```javascript
    // =========================================================================
    // Density System Core Functions
    // =========================================================================

    /**
     * Set the density level, cleaning up the outgoing level.
     * @param {number} level - Target density level (-1 to 5)
     */
    function setDensity(level) {
        level = Math.max(-1, Math.min(5, level));
        if (level === densityLevel && level !== -1 && level !== 0) return;

        // Cleanup outgoing level
        if (densityLevel === 5 && styleVariant === 1) {
            // Leaving Bug Eye overlay
            toggleBugEyeMode(true);
        }

        prevDensityLevel = densityLevel;
        window._plexdPrevDensityLevel = prevDensityLevel;
        setDensityLevel(level);
        setStyleVariant(0); // Reset variant on level change

        // Handle true fullscreen transitions
        if (level === -1) {
            PlexdStream.enterGridFullscreen();
        } else if (prevDensityLevel === -1) {
            if (document.fullscreenElement) {
                document.exitFullscreen();
            }
        }

        // Handle focused mode transitions
        if (level === 0) {
            var selected = PlexdStream.getSelectedStream();
            if (selected) PlexdStream.enterFocusedMode(selected.id);
        } else if (prevDensityLevel === 0) {
            var fsMode = PlexdStream.getFullscreenMode();
            if (fsMode === 'browser-fill') PlexdStream.exitFocusedMode();
        }

        updateDensityClasses();
        updateModeIndicator();
        updateLayout();

        var label = getDensityLabel();
        showMessage(label, 'info');
    }

    /**
     * Cycle style variant at current density level.
     */
    function cycleStyleVariant() {
        var max = DENSITY_MAX_VARIANT[String(densityLevel)] || 0;
        if (max === 0) {
            showMessage('No variants at this level', 'info');
            return;
        }

        // Cleanup outgoing variant
        if (densityLevel === 5 && styleVariant === 1) {
            toggleBugEyeMode(true); // Leaving Bug Eye
        }

        setStyleVariant((styleVariant + 1) % (max + 1));

        updateDensityClasses();
        updateModeIndicator();
        updateLayout();

        var label = getDensityLabel();
        showMessage(label, 'info');
    }

    /**
     * Toggle density system on/off via toolbar button.
     * Maps current old-mode state → density level when entering,
     * and density level → old-mode state when leaving.
     */
    function toggleDensitySystem() {
        setUseDensitySystem(!useDensitySystem);

        var btn = document.getElementById('density-btn');
        if (btn) btn.classList.toggle('active', useDensitySystem);

        if (useDensitySystem) {
            // Map current old-mode state to density level
            mapOldModeToDensity();
            updateDensityClasses();
        } else {
            // Map density level back to old mode state
            mapDensityToOldMode();
            removeDensityClasses();
        }

        updateModeIndicator();
        updateLayout();
        showMessage(useDensitySystem ? 'Density System ON' : 'Density System OFF', 'info');
    }

    /**
     * Get human-readable density label for messages.
     */
    function getDensityLabel() {
        var levelName = DENSITY_NAMES[densityLevel + 1] || 'Unknown';
        var variants = DENSITY_VARIANT_NAMES[String(densityLevel)];
        if (variants && variants[0] && variants[0][styleVariant]) {
            var variantName = variants[0][styleVariant];
            if (styleVariant > 0) return levelName + ' > ' + variantName;
        }
        return levelName;
    }

    /**
     * Update CSS classes on .plexd-app for density system.
     */
    function updateDensityClasses() {
        var app = document.querySelector('.plexd-app');
        if (!app) return;

        // Remove all density classes
        app.classList.remove('density-active');
        for (var i = -1; i <= 5; i++) {
            app.classList.remove('density-level-' + i);
        }
        for (var v = 0; v <= 2; v++) {
            app.classList.remove('density-variant-' + v);
        }

        if (useDensitySystem) {
            app.classList.add('density-active');
            app.classList.add('density-level-' + densityLevel);
            app.classList.add('density-variant-' + styleVariant);
        }
    }

    function removeDensityClasses() {
        var app = document.querySelector('.plexd-app');
        if (!app) return;
        app.classList.remove('density-active');
        for (var i = -1; i <= 5; i++) app.classList.remove('density-level-' + i);
        for (var v = 0; v <= 2; v++) app.classList.remove('density-variant-' + v);
    }

    /**
     * Map old mode variables → nearest density level.
     * Called when entering density system.
     */
    function mapOldModeToDensity() {
        var fsMode = PlexdStream.getFullscreenMode();
        if (fsMode === 'true-focused' || document.fullscreenElement) {
            setDensityLevel(-1); setStyleVariant(0);
        } else if (fsMode === 'browser-fill') {
            setDensityLevel(0); setStyleVariant(0);
        } else if (bugEyeMode) {
            setDensityLevel(5); setStyleVariant(1);
        } else if (mosaicMode) {
            setDensityLevel(5); setStyleVariant(0);
        } else if (wallMode === 1) {
            setDensityLevel(4); setStyleVariant(0);
        } else if (wallMode === 3) {
            setDensityLevel(1); setStyleVariant(0);
        } else if (wallMode === 2) {
            setDensityLevel(3); setStyleVariant(0);
        } else if (tetrisMode === 1) {
            setDensityLevel(4); setStyleVariant(1); // Rows → horizontal strips
        } else if (tetrisMode === 2) {
            setDensityLevel(4); setStyleVariant(0); // Columns → vertical strips
        } else if (tetrisMode === 3) {
            setDensityLevel(3); setStyleVariant(1); // Treemap → skyline
        } else if (tetrisMode === 4) {
            setDensityLevel(2); setStyleVariant(2); // Content-visible
        } else if (coverflowMode) {
            setDensityLevel(2); setStyleVariant(1); // Coverflow → Z-depth
        } else {
            setDensityLevel(2); setStyleVariant(0); // Default: Grid
        }
        prevDensityLevel = 2; // Default toggle-back to grid
    }

    /**
     * Map density level → old mode variables.
     * Called when leaving density system.
     */
    function mapDensityToOldMode() {
        // Reset all old modes first
        setTetrisMode(0);
        setWallMode(0);
        coverflowMode = false;
        window._plexdCoverflowMode = false;

        switch (densityLevel) {
            case -1: // Stay in fullscreen
                break;
            case 0: // Stay in focused
                break;
            case 1: setWallMode(3); break; // Spotlight
            case 2:
                if (styleVariant === 2) setTetrisMode(4); // Content-visible
                break; // Default grid = all off
            case 3:
                if (styleVariant === 0) setWallMode(2); // Crop tiles
                else if (styleVariant === 1) setTetrisMode(3); // Treemap ≈ skyline
                else setTetrisMode(1); // Rows ≈ masonry
                break;
            case 4:
                if (styleVariant === 0) setWallMode(1); // Vertical columns = strips
                else setTetrisMode(1); // Horizontal rows ≈ row-pack
                break;
            case 5:
                // Mosaic/Bug Eye — leave old modes off, these are overlays
                break;
        }

        updateWallModeClasses();
        updateTetrisModeClasses();

        var coverflowBtn = document.getElementById('coverflow-btn');
        if (coverflowBtn) coverflowBtn.classList.remove('active');
    }
```

**Step 2: Add `handleDensityKeys()` function**

Insert after the density core functions (just before the keyboard handler or in a logical location):

```javascript
    /**
     * Handle density-specific keys when density system is active.
     * Returns true if the key was handled.
     */
    function handleDensityKeys(e) {
        if (!useDensitySystem) return false;

        switch (e.key) {
            case '-':
            case '_': // Shift+- on some keyboards
                if (!e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    setDensity(densityLevel - 1);
                    return true;
                }
                return false;

            case '=':
            case '+': // Shift+= on some keyboards
                if (!e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    setDensity(densityLevel + 1);
                    return true;
                }
                return false;

            case 'y':
            case 'Y':
                // Y = cycle style variant (only in density mode)
                if (!e.shiftKey && !e.metaKey && !e.ctrlKey) {
                    e.preventDefault();
                    cycleStyleVariant();
                    return true;
                }
                return false;

            // Intercept old mode keys — no-op in density mode
            case 't':
            case 'T':
                if (!e.shiftKey && !e.metaKey) return true; // Swallow T (but not Shift+T = reset pan)
                return false;
            case 'o':
            case 'O':
                if (!e.metaKey) return true; // Swallow O
                return false;
            case 'w':
            case 'W':
                // W still works for moment browser wall edit; only swallow if NOT in moment browser
                if (!momentBrowserState.open) return true;
                return false;
            case 'b':
            case 'B':
                if (!e.metaKey) return true; // Swallow B/Shift+B
                return false;

            default:
                return false;
        }
    }
```

**Step 3: Verify syntax**

Run: `node --check web/js/app.js`
Expected: No output

**Step 4: Commit**

```bash
git add web/js/app.js
git commit -m "feat(density): add core functions and key handler"
```

---

### Task 10: Wire Into updateLayout & handleKeyboard

**Files:**
- Modify: `web/js/app.js:2662-2688` (layout branching in `_doUpdateLayout`)
- Modify: `web/js/app.js:~7934+` (keyboard handler)

**Step 1: Add density branch in `_doUpdateLayout()`**

In `_doUpdateLayout()`, replace the layout calculation block (lines 2662-2688) by wrapping it with a density check. The new code goes at line 2662:

```javascript
        let layout;
        if (useDensitySystem) {
            // Unified density layout engine
            var selected = PlexdStream.getSelectedStream();
            var selectedIdx = selected ? streamsToShow.findIndex(function(s) { return s.id === selected.id; }) : -1;
            var result = PlexdGrid.calculateDensityLayout(densityLevel, styleVariant, container, streamsToShow, selectedIdx);

            if (result.type === 'overlay') {
                // Bug Eye canvas overlay — activate it, skip grid positioning
                if (result.mode === 'bugeye' && !bugEyeMode) {
                    toggleBugEyeMode();
                }
                return;
            } else if (result.type === 'mosaic-grid') {
                // CSS grid mosaic — cells are positioned by CSS, just ensure wrappers are visible
                streamsToShow.forEach(function(s) {
                    if (s.wrapper) {
                        s.wrapper.style.position = '';
                        s.wrapper.style.left = '';
                        s.wrapper.style.top = '';
                        s.wrapper.style.width = '';
                        s.wrapper.style.height = '';
                        s.wrapper.style.display = '';
                    }
                });
                PlexdStream.setGridCols(Math.ceil(Math.sqrt(streamsToShow.length)));
                return;
            } else {
                layout = result;
            }
        } else if (wallMode === 1) {
```

Note: the existing `if (wallMode === 1)` at line 2663 becomes `} else if (wallMode === 1) {`. The rest of the old layout branching stays intact as the `else` chain.

**Step 2: Wire `handleDensityKeys()` into keyboard handler**

In `handleKeyboard()` (around line 7934), add the density key check early — after the moment browser check but before the main `switch` statement. Find the spot right before the `switch (e.key)` for the main key handling and add:

```javascript
        // Density system keys — intercept before old mode keys
        if (handleDensityKeys(e)) return;
```

**Step 3: Also handle Enter/Z and F for density mode**

Find the existing `Enter`/`z`/`Z` case and `f`/`F` case in `handleKeyboard()`. Wrap them with density checks.

For Enter/Z (find the existing handler):
```javascript
            case 'Enter':
            case 'z':
            case 'Z':
                if (useDensitySystem) {
                    // Toggle Focused (level 0) ↔ previous density
                    if (densityLevel === 0) {
                        setDensity(prevDensityLevel !== 0 ? prevDensityLevel : 2);
                    } else {
                        setDensity(0);
                    }
                    break;
                }
                // ... existing Enter/Z code follows
```

For F (find the existing handler):
```javascript
            case 'f':
            case 'F':
                if (useDensitySystem && !e.metaKey) {
                    // Toggle Fullscreen (level -1) ↔ previous density
                    if (densityLevel === -1) {
                        setDensity(prevDensityLevel !== -1 ? prevDensityLevel : 2);
                    } else {
                        setDensity(-1);
                    }
                    break;
                }
                // ... existing F code follows
```

**Step 4: Verify syntax**

Run: `node --check web/js/app.js`

**Step 5: Functional test**

Run: `./scripts/start-server.sh`
Open browser. Click the ◈ density button. Press `-` and `=` to cycle through levels. Press `Y` for variants. Press `Enter` to toggle focused. Press `F` for fullscreen.

**Step 6: Commit**

```bash
git add web/js/app.js
git commit -m "feat(density): wire layout engine and key handler into app"
```

---

### Task 11: Update Mode Indicator

**Files:**
- Modify: `web/js/app.js:3520-3557` (`updateModeIndicator()`)

**Step 1: Add density branch to `updateModeIndicator()`**

In the existing `updateModeIndicator()` at line 3520, add a density branch. After the `if (theaterMode)` block and its Theater badge, add an early return for density mode before the Advanced mode `else`:

Replace the `} else {` at line 3534 with:

```javascript
        } else if (useDensitySystem) {
            // Density mode indicator
            var densityBadge = document.createElement('span');
            densityBadge.className = 'badge badge-density';
            densityBadge.textContent = getDensityLabel();
            el.appendChild(densityBadge);

            // Still show filter info
            if (viewMode !== 'all') {
                var filterBadge = document.createElement('span');
                filterBadge.className = 'badge';
                filterBadge.textContent = viewMode === 'favorites' ? 'FAV' : 'R' + viewMode;
                el.appendChild(filterBadge);
            }
        } else {
```

**Step 2: Verify syntax**

Run: `node --check web/js/app.js`

**Step 3: Commit**

```bash
git add web/js/app.js
git commit -m "feat(density): update mode indicator for density labels"
```

---

### Task 12: Theater Integration

**Files:**
- Modify: `web/js/app.js:3407-3482` (`applyTheaterScene()`)

**Step 1: Add density-aware Theater scene application**

Add a new function after `applyTheaterScene()`:

```javascript
    /**
     * Apply theater scene using density system.
     * Called when useDensitySystem is true and theater scenes transition.
     */
    function applyTheaterSceneDensity() {
        if (coverflowMode) toggleCoverflowMode();
        window._plexdLineupWeights = null;

        if (theaterScene !== 'casting' && faceDetectionActive) stopFaceDetection();
        if (theaterScene !== 'casting') {
            PlexdStream.getAllStreams().forEach(function(s) {
                if (s.wrapper) s.wrapper.classList.remove('starred-glow', 'low-rated');
            });
        }

        switch (theaterScene) {
            case 'casting':
                setViewMode('all');
                setDensity(5); setStyleVariant(0); // Mosaic
                if (!faceDetectionActive) startFaceDetection();
                updateCastingCallVisuals();
                break;

            case 'lineup':
                {
                    var favCount = PlexdStream.getFavoriteCount();
                    setViewMode(favCount > 0 ? 'favorites' : 'all');
                }
                setDensity(2); setStyleVariant(0); // Grid
                break;

            case 'stage':
                setDensity(1); setStyleVariant(0); // Spotlight
                if (!stageHeroId || !PlexdStream.getStream(stageHeroId)) {
                    var streams = getFilteredStreams();
                    stageHeroId = streams.length > 0 ? streams[0].id : null;
                }
                if (stageHeroId) PlexdStream.selectStream(stageHeroId);
                updateStageMomentStrip();
                break;

            case 'climax':
                applyClimaxSubModeDensity();
                return;

            case 'encore':
                showEncoreView();
                return;
        }

        updateDensityClasses();
        updateModeIndicator();
        updateLayout();
    }

    /**
     * Apply Climax sub-mode using density system.
     */
    function applyClimaxSubModeDensity() {
        stopAutoRotate();
        switch (climaxSubMode) {
            case 0: // Tight Wall → Fill crop
                setDensity(3); setStyleVariant(0);
                break;
            case 1: // Auto-Rotate Hero → Spotlight
                setDensity(1); setStyleVariant(0);
                startAutoRotate();
                break;
            case 2: // Collage → Fill skyline (closest equivalent)
                setDensity(3); setStyleVariant(1);
                break;
            case 3: // Single Focus → Focused
                setDensity(0);
                break;
        }
        updateDensityClasses();
        updateModeIndicator();
        updateLayout();
    }
```

**Step 2: Add density routing in `applyTheaterScene()`**

At the top of `applyTheaterScene()` (line 3407), add:

```javascript
    function applyTheaterScene() {
        if (useDensitySystem) {
            applyTheaterSceneDensity();
            return;
        }
        // ... existing code follows
```

**Step 3: Verify syntax**

Run: `node --check web/js/app.js`

**Step 4: Commit**

```bash
git add web/js/app.js
git commit -m "feat(density): integrate theater mode with density system"
```

---

### Task 13: Bug Fixes

**Files:**
- Modify: `web/js/app.js:3484-3510` (Climax E cycling — verify already fixed)
- Modify: `web/js/app.js` (crop toggle in fullscreen)
- Modify: `web/js/app.js` (Spotlight arrows)

**Step 1: Verify Climax E cycling fix exists**

Read `applyClimaxSubMode()` at line 3484. The exploration showed lines 3487-3491 already have:
```javascript
        var fsMode = PlexdStream.getFullscreenMode();
        if (fsMode === 'browser-fill' || fsMode === 'true-focused') {
            PlexdStream.exitFocusedMode();
        }
```

If this is already present, bug fix 1 is done. If not, add it at the top of `applyClimaxSubMode()`.

**Step 2: Fix crop toggle in true fullscreen**

Search for `objectFit = 'cover'` assignments related to Opt+Up/Down crop toggle. Replace `video.style.objectFit = 'cover'` with `video.style.setProperty('object-fit', 'cover', 'important')` and similarly for `contain`.

Find the crop toggle handler (search for `Alt` + `ArrowUp` or `Opt+Up` in handleKeyboard). Update:

```javascript
// Before:
video.style.objectFit = 'cover';
// After:
video.style.setProperty('object-fit', 'cover', 'important');

// Before:
video.style.objectFit = 'contain';
// After:
video.style.setProperty('object-fit', 'contain', 'important');
```

**Step 3: Fix Spotlight arrows (old system)**

Find the arrow key handler section that checks `wallMode === 3` and `theaterScene === 'stage'`. The exploration showed this at ~line 8798. If Spotlight arrow hero rotation only works in Theater Stage but not in Advanced mode's `wallMode === 3`, add the same logic:

In the arrow navigation handler, ensure that when `wallMode === 3` (regardless of theater mode), left/right arrows rotate the hero by selecting the next/prev stream and calling `updateLayout()`.

**Step 4: Verify syntax**

Run: `node --check web/js/app.js`

**Step 5: Functional test**

Test in browser:
- Climax: Enter Theater, advance to Climax, press E to cycle through sub-modes. Verify Single Focus → Tight Wall transition works.
- Crop toggle: Enter fullscreen (F), press Opt+Up. Video should toggle between crop and contain.
- Spotlight arrows: In Advanced mode, press W to Spotlight, then left/right arrows should rotate hero.

**Step 6: Commit**

```bash
git add web/js/app.js
git commit -m "fix: crop toggle in fullscreen, spotlight arrows in advanced mode"
```

---

### Task 14: Update propagateKeys Regex

**Files:**
- Modify: `web/js/stream.js:2293` (propagateKeys regex)

**Step 1: Verify `-` and `=` are already in the regex**

Read the propagateKeys regex at stream.js:2293. The current regex includes:
```
/^[,.<>/?bBqQlL;:wWtToOaAeErRxXjJkK'nNmMgGvVhHiIpPcCdDuUsSyYß=`÷≤≥+\-\[\]{}\\|]$/
```

Check: `=` is present. `-` is present (as `\-`). `y`/`Y` are present. These are the density keys.

If `-`, `=`, and `Y` are already in the regex, **no change needed**. The `_` and `+` keys (Shift variants) should also be checked — `+` is present as `+`.

**Step 2: Verify no changes needed**

If all density keys (`-`, `=`, `Y`) are already propagated, mark this task complete.

**Step 3: Commit (only if changes were made)**

```bash
git add web/js/stream.js
git commit -m "fix: ensure density keys propagate in fullscreen mode"
```

---

### Task 15: Integration Testing

**Files:** None (testing only)

**Step 1: Start server**

Run: `./scripts/start-server.sh`

**Step 2: Load streams**

Open `http://localhost:8080`. Add 4+ streams (drop files or use xfill).

**Step 3: Test density system activation**

1. Click ◈ density toolbar button
2. Verify mode indicator shows "Grid"
3. Verify old T/W/O/B keys are dead (no response)

**Step 4: Test density levels**

1. Press `=` repeatedly: Grid → Fill → Strips → Mosaic
2. Press `-` repeatedly: Mosaic → Strips → Fill → Grid → Spotlight → Focused → Fullscreen
3. At each level, verify layout changes visually
4. At Fullscreen (level -1), verify true fullscreen is entered
5. Press `-` at Fullscreen (should stay at -1, clamped)

**Step 5: Test style variants**

1. At Grid level, press `Y`: Even Grid → Z-Depth → Content Visible → Even Grid
2. At Fill level, press `Y`: Crop → Skyline → Masonry → Crop
3. At Strips level, press `Y`: Vertical → Horizontal → Vertical
4. At Mosaic level, press `Y`: CSS Grid Mosaic → Bug Eye overlay → CSS Grid Mosaic

**Step 6: Test Enter/F shortcuts**

1. From Grid level, press `Enter`: should jump to Focused (level 0)
2. Press `Enter` again: should return to Grid (level 2)
3. From Strips level, press `F`: should jump to Fullscreen (level -1)
4. Press `F` again: should return to Strips (level 4)

**Step 7: Test theater integration**

1. Press `` ` `` to enter Theater mode
2. Advance through scenes (Space/Tab)
3. Verify scenes map to correct density levels
4. Press `` ` `` to return to Advanced

**Step 8: Test old mode fallback**

1. Click ◈ to deactivate density system
2. Verify T/W/O/B keys work as before
3. Verify mode indicator shows ADV + mode badges

**Step 9: Commit all remaining changes**

```bash
git add -A
git commit -m "feat(density): unified density system complete with all levels and variants"
```

---

## Task Dependency Graph

```
Task 1 (State Model)
  ├── Task 2 (Toolbar Button)
  ├── Task 3 (Layout Dispatcher + Stubs)
  │     ├── Task 4 (Grid Variants)
  │     ├── Task 5 (Spotlight Variants)
  │     ├── Task 6 (Fill Variants)
  │     ├── Task 7 (Strips Variants)
  │     └── Task 8 (Mosaic Signal)
  └── Task 9 (Key Handler + Core Functions)
        └── Task 10 (Wire into updateLayout + handleKeyboard)
              ├── Task 11 (Mode Indicator)
              ├── Task 12 (Theater Integration)
              ├── Task 13 (Bug Fixes)
              └── Task 14 (propagateKeys)
                    └── Task 15 (Integration Testing)
```

Tasks 3-8 (grid.js layout functions) can be done in parallel.
Tasks 11-14 (app.js polish) can be done in parallel after Task 10.
