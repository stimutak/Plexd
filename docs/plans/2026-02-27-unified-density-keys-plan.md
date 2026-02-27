# Unified Density & Key Bindings Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace Plexd's overlapping view mode system (Tetris/Wall/Coverflow/BugEye/Mosaic) with a unified density spectrum controlled by `-`/`=` keys, with style variants via `Y`.

**Architecture:** Introduce a `densityLevel` (integer -1 to 5) and `styleVariant` (integer 0+) as the single source of truth for layout. Map old mode variables (wallMode, tetrisMode, coverflowMode) through a translation layer in `updateLayout()`. Theater scenes set density presets. Bug fixes ship first as independent commits.

**Tech Stack:** Vanilla JS (app.js, stream.js, grid.js), CSS (plexd.css). No new dependencies.

---

## Phase 1: Bug Fixes (independent, ship first)

### Task 1: Fix Climax E cycling stuck in Single Focus

**Files:**
- Modify: `web/js/app.js` — `applyClimaxSubMode()` function (~line 2690)

**Step 1: Locate and read `applyClimaxSubMode()`**

Read `web/js/app.js` and find the `applyClimaxSubMode` function. Understand the switch statement for cases 0-3.

**Step 2: Add exitFocusedMode at top of function**

At the start of `applyClimaxSubMode()`, before the switch, add:
```javascript
// Exit focused mode before switching sub-modes (fixes Single Focus → Tight Wall stuck bug)
var fsMode = PlexdStream.getFullscreenMode();
if (fsMode === 'browser-fill' || fsMode === 'true-focused') {
    PlexdStream.exitFocusedMode();
}
```

This ensures that when E cycles from sub-mode 3 (Single Focus, which enters focused mode) to sub-mode 0 (Tight Wall), the focused mode is exited first so the new layout is visible.

**Step 3: Verify syntax**

Run: `node -c web/js/app.js`
Expected: No errors

**Step 4: Manual test**

1. Enter Theater mode (`` ` ``), go to Climax (C)
2. Press E repeatedly to cycle through sub-modes
3. When hitting Single Focus (sub-mode 3), verify it enters focused mode
4. Press E again — should exit focus and show Tight Wall (sub-mode 0)

**Step 5: Commit**

```bash
git add web/js/app.js
git commit -m "fix: exit focused mode when cycling Climax sub-modes with E"
```

---

### Task 2: Fix crop toggle in true fullscreen

**Files:**
- Modify: `web/js/app.js` — Opt+ArrowUp and Opt+ArrowDown handlers (~line 7017-7045)

**Step 1: Read the current crop toggle handlers**

Find the `case 'ArrowUp':` and `case 'ArrowDown':` inside the `if (e.altKey)` block in `handleKeyboard()`.

**Step 2: Change inline style assignment to use setProperty with !important**

Replace `targetForCrop.video.style.objectFit = 'contain'` and `= 'cover'` with:
```javascript
targetForCrop.video.style.setProperty('object-fit', 'contain', 'important');
// and
targetForCrop.video.style.setProperty('object-fit', 'cover', 'important');
```

Do the same for the Opt+Down (all streams) handler.

**Step 3: Verify syntax**

Run: `node -c web/js/app.js`

**Step 4: Manual test**

1. Open streams in grid, enter true fullscreen (F from focused)
2. Press Opt+Up — should toggle between crop and contain
3. Exit fullscreen, verify crop toggle still works in grid

**Step 5: Commit**

```bash
git add web/js/app.js
git commit -m "fix: crop toggle works in true fullscreen using !important"
```

---

### Task 3: Fix Spotlight arrows to change hero

**Files:**
- Modify: `web/js/app.js` — `handleArrowNav()` function (~line 7765)

**Step 1: Read handleArrowNav and find the Stage hero rotation logic**

The function already has Theater Stage logic at the top:
```javascript
if (theaterMode && theaterScene === 'stage') {
    // Left/Right rotates hero via stageHeroId
}
```

**Step 2: Add Spotlight (wallMode === 3) hero rotation**

After the Theater Stage check, before the generic arrow handling, add:
```javascript
// Spotlight mode: Left/Right rotates hero (same as Theater Stage)
if (wallMode === 3) {
    const streams = getFilteredStreams();
    if (streams.length === 0) return;
    if (direction === 'left' || direction === 'right') {
        const sel = PlexdStream.getSelectedStream();
        const currentIdx = sel ? streams.findIndex(s => s.id === sel.id) : 0;
        let nextIdx;
        if (direction === 'right') {
            nextIdx = currentIdx >= streams.length - 1 ? 0 : currentIdx + 1;
        } else {
            nextIdx = currentIdx <= 0 ? streams.length - 1 : currentIdx - 1;
        }
        PlexdStream.selectStream(streams[nextIdx].id);
        updateLayout();
        return;
    }
}
```

Note: Spotlight uses the selected stream as hero (via grid.js `calculateSpotlightLayout`), so changing selection + relayout changes the hero.

**Step 3: Verify syntax and test**

Run: `node -c web/js/app.js`
Manual: Press W to cycle to Spotlight mode, then use left/right arrows — hero stream should change.

**Step 4: Commit**

```bash
git add web/js/app.js
git commit -m "fix: arrow keys rotate hero stream in Spotlight mode"
```

---

### Task 4: Remove XX double-tap danger

**Files:**
- Modify: `web/js/app.js` — X key handler (~line 7557)

**Step 1: Replace handleDoubleTap with direct action**

Change the X handler from `handleDoubleTap('x', singleFn, doubleFn)` to just the single-tap action directly (no handleDoubleTap wrapper, no double-tap variant):

```javascript
case 'x':
case 'X':
    {
        var targetStream = PlexdStream.getFullscreenStream() || PlexdStream.getSelectedStream() || getCoverflowSelectedStream();
        if (targetStream) {
            var fsStream = PlexdStream.getFullscreenStream();
            if (fsStream) {
                var nextStreamId = PlexdStream.getNextStreamId(targetStream.id);
                PlexdStream.removeStream(targetStream.id);
                if (nextStreamId) {
                    PlexdStream.enterFocusedMode(nextStreamId);
                } else {
                    PlexdStream.exitFocusedMode();
                }
            } else {
                PlexdStream.removeStreamAndFocusNext(targetStream.id);
            }
            updateStreamCount();
            saveCurrentStreams();
            showMessage('Stream closed', 'info');
        } else {
            showMessage('Select a stream first', 'info');
        }
    }
    break;
```

**Step 2: Verify syntax and test**

Run: `node -c web/js/app.js`
Manual: Press X — closes stream immediately. Double-tapping X should just close two streams sequentially (safe).

**Step 3: Commit**

```bash
git add web/js/app.js
git commit -m "fix: remove dangerous XX double-tap, X always just closes one stream"
```

---

## Phase 2: Density State System (core refactor)

### Task 5: Add density state variables and setters

**Files:**
- Modify: `web/js/app.js` — near existing mode variable declarations (~line 625-655)

**Step 1: Read current mode variable declarations**

Find the block where `wallMode`, `tetrisMode`, `coverflowMode` are declared.

**Step 2: Add density state variables after existing ones**

```javascript
// Unified Density System
// Replaces wallMode/tetrisMode/coverflowMode with a single axis
// -1=Fullscreen, 0=Focused, 1=Spotlight, 2=Grid, 3=Fill, 4=Strips, 5=Mosaic
let densityLevel = 2; // Default: Grid
let styleVariant = 0; // Style variant within current density level
let prevDensityLevel = 2; // For Enter/F toggle-back
window._plexdDensityLevel = densityLevel;
window._plexdStyleVariant = styleVariant;

function _setDensityLevel(val) {
    densityLevel = val;
    window._plexdDensityLevel = val;
}
function _setStyleVariant(val) {
    styleVariant = val;
    window._plexdStyleVariant = val;
}
```

**Step 3: Verify syntax**

Run: `node -c web/js/app.js`

**Step 4: Commit**

```bash
git add web/js/app.js
git commit -m "feat: add density state variables and setters"
```

---

### Task 6: Create density-to-mode translation layer

**Files:**
- Modify: `web/js/app.js` — new function near `updateLayout()`

**Step 1: Write `applyDensityLevel()` function**

This function maps density level + style variant to the old mode variables, then calls updateLayout():

```javascript
// Maximum style variants per density level
var DENSITY_STYLES = {
    '-1': 1,  // Fullscreen: 1 style
    '0': 1,   // Focused: 1 style
    '1': 2,   // Spotlight: hero+side, hero+bottom
    '2': 3,   // Grid: even, coverflow, content-visible
    '3': 3,   // Fill: crop tiles, skyline, column
    '4': 2,   // Strips: vertical, horizontal
    '5': 2    // Mosaic: mosaic, bug eye
};

function applyDensityLevel() {
    // Exit focused/fullscreen if moving away from those levels
    var fsMode = PlexdStream.getFullscreenMode();
    if (densityLevel > 0 && (fsMode === 'browser-fill' || fsMode === 'true-focused')) {
        PlexdStream.exitFocusedMode();
    }
    if (densityLevel > -1 && fsMode === 'true-grid') {
        PlexdStream.exitTrueFullscreen();
    }

    // Reset all old mode variables
    setWallMode(0);
    setTetrisMode(0);
    if (coverflowMode) toggleCoverflowMode();
    if (bugEyeMode) toggleBugEyeMode(true);
    if (mosaicMode) toggleMosaicMode(true);

    // Apply density level
    switch (densityLevel) {
        case -1: // Fullscreen
            {
                var target = PlexdStream.getSelectedStream() || getFilteredStreams()[0];
                if (target) {
                    PlexdStream.enterFocusedMode(target.id);
                    PlexdStream.enterTrueFullscreen(target.id);
                }
            }
            break;
        case 0: // Focused
            {
                var target = PlexdStream.getSelectedStream() || getFilteredStreams()[0];
                if (target) PlexdStream.enterFocusedMode(target.id);
            }
            break;
        case 1: // Spotlight
            setWallMode(3);
            break;
        case 2: // Grid
            if (styleVariant === 1) {
                toggleCoverflowMode();
            } else if (styleVariant === 2) {
                setTetrisMode(4); // content-visible
            }
            // styleVariant 0 = default grid (no mode set)
            break;
        case 3: // Fill
            if (styleVariant === 0) {
                setWallMode(2); // crop tiles
            } else if (styleVariant === 1) {
                setTetrisMode(2); // skyline
            } else if (styleVariant === 2) {
                setTetrisMode(3); // column
            }
            break;
        case 4: // Strips
            setWallMode(1); // vertical columns
            break;
        case 5: // Mosaic
            if (styleVariant === 0) {
                toggleMosaicMode();
            } else {
                toggleBugEyeMode();
            }
            break;
    }

    updateWallModeClasses();
    updateTetrisModeClasses();
    updateModeIndicator();
    if (densityLevel >= 1) updateLayout();

    // Show density level name
    var names = {
        '-1': 'Fullscreen',
        '0': 'Focused',
        '1': 'Spotlight',
        '2': 'Grid',
        '3': 'Fill',
        '4': 'Strips',
        '5': 'Mosaic'
    };
    var styleNames = {
        '2': ['Grid', 'Coverflow', 'Content Visible'],
        '3': ['Crop Tiles', 'Skyline', 'Column'],
        '5': ['Mosaic', 'Bug Eye']
    };
    var name = names[String(densityLevel)] || '';
    var styles = styleNames[String(densityLevel)];
    if (styles && styles[styleVariant]) name = styles[styleVariant];
    showMessage(name, 'info');
}
```

**Step 2: Verify syntax**

Run: `node -c web/js/app.js`

**Step 3: Commit**

```bash
git add web/js/app.js
git commit -m "feat: density-to-mode translation layer (applyDensityLevel)"
```

---

### Task 7: Add density key bindings (-/=/Y)

**Files:**
- Modify: `web/js/app.js` — `handleKeyboard()` switch statement

**Step 1: Add `-` key handler for less dense**

In the main switch in `handleKeyboard()`, find or add the `-` case. Note: `-` is already handled in Moment Browser for Wall zoom, so only add to the main handler (the moment browser handler returns `true` first if open).

```javascript
case '-':
    // Moment browser handles its own - for wall zoom
    // Main handler: decrease density
    if (densityLevel > -1) {
        prevDensityLevel = densityLevel;
        _setDensityLevel(densityLevel - 1);
        _setStyleVariant(0);
        applyDensityLevel();
    }
    break;
```

**Step 2: Modify `=` key handler for more dense**

The `=` key currently calls `removeDuplicateStreams()`. Move that to `Shift+=` or another key. Replace with:

```javascript
case '=':
    if (e.shiftKey) {
        // Shift+= (i.e., +): remove duplicate streams (moved from plain =)
        e.preventDefault();
        removeDuplicateStreams();
    } else {
        // Increase density
        if (densityLevel < 5) {
            prevDensityLevel = densityLevel;
            _setDensityLevel(densityLevel + 1);
            _setStyleVariant(0);
            applyDensityLevel();
        }
    }
    break;
```

**Step 3: Add `Y` key handler for style variant**

```javascript
case 'y':
case 'Y':
    {
        var maxStyles = DENSITY_STYLES[String(densityLevel)] || 1;
        if (maxStyles > 1) {
            _setStyleVariant((styleVariant + 1) % maxStyles);
            applyDensityLevel();
        }
    }
    break;
```

**Step 4: Add Y to propagateKeys regex in stream.js**

In `web/js/stream.js`, find the `propagateKeys` regex and ensure `yY` is in the character class. It may already be there — check first.

**Step 5: Verify syntax**

Run: `node -c web/js/app.js && node -c web/js/stream.js`

**Step 6: Commit**

```bash
git add web/js/app.js web/js/stream.js
git commit -m "feat: density key bindings (-/=/Y)"
```

---

### Task 8: Fix Enter/Z to toggle Focused from any level

**Files:**
- Modify: `web/js/app.js` — Enter/Z handler (~line 7246)

**Step 1: Read current Enter/Z handler**

**Step 2: Rewrite to use density system**

Replace the current Enter/Z handler with:

```javascript
case 'Enter':
case 'z':
case 'Z':
    e.preventDefault();
    if (densityLevel === 0 || densityLevel === -1) {
        // In Focused/Fullscreen — return to previous density
        _setDensityLevel(prevDensityLevel > 0 ? prevDensityLevel : 2);
        _setStyleVariant(0);
        applyDensityLevel();
    } else {
        // From any level — jump to Focused
        prevDensityLevel = densityLevel;
        _setDensityLevel(0);
        _setStyleVariant(0);
        applyDensityLevel();
    }
    break;
```

**Step 3: Verify syntax and test**

Run: `node -c web/js/app.js`
Manual: From Grid, press Enter — should focus. Press Enter again — should return to Grid. From Strips, press Enter — should focus. Enter again — back to Strips.

**Step 4: Commit**

```bash
git add web/js/app.js
git commit -m "feat: Enter/Z toggles Focused from any density level"
```

---

### Task 9: Fix F to toggle Fullscreen from any level

**Files:**
- Modify: `web/js/app.js` — add F handler in main handleKeyboard
- Modify: `web/js/stream.js` — F handler in focused mode (currently only place F is bound)

**Step 1: Move F handling to app.js main handler**

Currently F is only in stream.js (focused mode keydown handler) and moment browser. Add to the main handler:

```javascript
case 'f':
case 'F':
    e.preventDefault();
    if (densityLevel === -1) {
        // In Fullscreen — return to previous density
        _setDensityLevel(prevDensityLevel >= 0 ? prevDensityLevel : 2);
        _setStyleVariant(0);
        applyDensityLevel();
    } else {
        // From any level — jump to Fullscreen
        prevDensityLevel = densityLevel;
        _setDensityLevel(-1);
        _setStyleVariant(0);
        applyDensityLevel();
    }
    break;
```

**Step 2: Remove or gate the stream.js F handler**

In stream.js, the F handler in the focused-mode keydown listener calls `toggleTrueFullscreen()`. This should now be handled by app.js via propagateKeys. Check if F is already in propagateKeys (it should be — `fF` is in the regex). If so, remove the `case 'f'` from stream.js focused handler.

**Step 3: Gate the Moment Browser F handler**

The Moment Browser's F handler (toggles popup fullscreen) should only run when the browser is open — it already does since `handleMomentBrowserKeyboard` returns `true` before the main handler runs.

**Step 4: Verify syntax and test**

Run: `node -c web/js/app.js && node -c web/js/stream.js`
Manual: From Grid, press F — should go fullscreen. Press F again — back to Grid.

**Step 5: Commit**

```bash
git add web/js/app.js web/js/stream.js
git commit -m "feat: F toggles Fullscreen from any density level"
```

---

## Phase 3: Deprecate Old Mode Keys

### Task 10: Remove old mode key bindings (T, W, O, B)

**Files:**
- Modify: `web/js/app.js` — remove T, W, O, B handlers from main handleKeyboard

**Step 1: Remove or comment out these handlers**

- `case 't': case 'T':` — Tetris cycle (and Shift+T reset pan) → Remove tetris cycle, keep Shift+T pan reset
- `case 'w': case 'W':` — Wall cycle → Remove from main handler (keep in Moment Browser)
- `case 'o': case 'O':` — Coverflow toggle → Remove
- `case 'b': case 'B':` — Bug Eye / Shift+B Mosaic → Remove

For Shift+T (reset pan positions), move to another key or keep as Shift+T since T is "freed but still responds to Shift":

```javascript
case 't':
case 'T':
    if (e.shiftKey) {
        // Shift+T = Reset all pan positions to center
        PlexdStream.resetAllPanPositions();
        showMessage('Pan positions reset', 'info');
    }
    break;
```

**Step 2: Remove propagateKeys entries if no longer needed**

Check if `tToObB` can be removed from the propagateKeys regex in stream.js. Since Shift+T still exists, keep `tT`. Remove `oO`. Keep `bB` only if needed elsewhere. Check carefully.

**Step 3: Verify syntax**

Run: `node -c web/js/app.js && node -c web/js/stream.js`

**Step 4: Commit**

```bash
git add web/js/app.js web/js/stream.js
git commit -m "feat: deprecate T/W/O/B mode keys, replaced by density spectrum"
```

---

### Task 11: Sync density state from Theater scene changes

**Files:**
- Modify: `web/js/app.js` — `applyTheaterScene()` function

**Step 1: Read applyTheaterScene**

**Step 2: After each scene sets its modes, sync density state**

At the end of each case in `applyTheaterScene()`, set the matching density level so `-`/`=` keys work correctly within Theater:

```javascript
case 'casting':
    // ... existing casting setup ...
    _setDensityLevel(5); _setStyleVariant(0); // Mosaic
    break;
case 'lineup':
    // ... existing lineup setup ...
    _setDensityLevel(2); _setStyleVariant(0); // Grid
    break;
case 'stage':
    // ... existing stage setup ...
    _setDensityLevel(1); _setStyleVariant(0); // Spotlight
    break;
case 'climax':
    // ... existing climax setup (calls applyClimaxSubMode) ...
    // Density is set by applyClimaxSubMode
    break;
case 'encore':
    // Moment Browser — don't change density
    break;
```

Also update `applyClimaxSubMode()` to sync density:
- Sub-mode 0 (Tight Wall): `_setDensityLevel(3);` (Fill)
- Sub-mode 1 (Auto-Rotate): `_setDensityLevel(1);` (Spotlight)
- Sub-mode 2 (Collage): `_setDensityLevel(2);` (Grid, special)
- Sub-mode 3 (Single Focus): `_setDensityLevel(0);` (Focused)

**Step 3: Verify syntax**

Run: `node -c web/js/app.js`

**Step 4: Commit**

```bash
git add web/js/app.js
git commit -m "feat: sync density state from Theater scene changes"
```

---

### Task 12: Update help overlay and mode indicator

**Files:**
- Modify: `web/js/app.js` — help overlay HTML and `updateModeIndicator()`

**Step 1: Update help overlay**

Replace the old "Layout Modes" section keys with the new density keys:
```html
<h4>Density</h4>
<div class="plexd-shortcut"><kbd>-</kbd> Less dense · <kbd>=</kbd> More dense</div>
<div class="plexd-shortcut"><kbd>Y</kbd> Cycle style variant</div>
<div class="plexd-shortcut"><kbd>Enter</kbd> Toggle Focused · <kbd>F</kbd> Toggle Fullscreen</div>
<div class="plexd-shortcut"><kbd>Opt+↑</kbd> Crop toggle · <kbd>Opt+↓</kbd> Crop all</div>
```

Remove references to T/W/O/B for layout mode cycling.

**Step 2: Update mode indicator to show density level**

In `updateModeIndicator()`, show density level name instead of (or in addition to) Theater scene name.

**Step 3: Verify syntax**

Run: `node -c web/js/app.js`

**Step 4: Commit**

```bash
git add web/js/app.js
git commit -m "feat: update help overlay and mode indicator for density system"
```

---

### Task 13: Update CLAUDE.md with new key bindings

**Files:**
- Modify: `CLAUDE.md` — keyboard section, Theater section

**Step 1: Replace the old mode documentation with density system documentation**

Update the "Theater & Advanced Mode" section to reflect:
- Density spectrum (-/=/Y)
- Deprecated keys (T/W/O/B)
- New Enter/F behavior
- Updated Theater key mapping

**Step 2: Commit**

```bash
git add CLAUDE.md
git commit -m "docs: update CLAUDE.md for unified density system"
```

---

## Implementation Order

1. **Task 1-4** (Phase 1: Bug fixes) — independent, can be done in any order or parallel
2. **Task 5** (density state) — foundation for everything in Phase 2
3. **Task 6** (translation layer) — depends on Task 5
4. **Task 7** (key bindings) — depends on Task 6
5. **Task 8-9** (Enter/F) — depends on Task 6
6. **Task 10** (deprecate old keys) — depends on Task 7
7. **Task 11** (Theater sync) — depends on Task 6
8. **Task 12-13** (docs/UI) — depends on all above

```
Phase 1 (parallel):  [T1] [T2] [T3] [T4]
Phase 2 (sequential): [T5] → [T6] → [T7] → [T8, T9] → [T10] → [T11]
Phase 3 (sequential): [T12] → [T13]
```
