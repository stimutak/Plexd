# Wall Moment Editing — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add in-point and duration editing to Wall view moments via drag handles on a mini-timeline and keyboard nudge on the selected cell.

**Architecture:** Each Wall cell gets a timeline bar showing the moment's range within the source video. The selected cell's bar becomes interactive with drag handles (left=in-point, right=out-point). Keyboard `Opt+Arrow` nudges in-point, `Opt+Shift+Arrow` adjusts duration. The loop handler already holds a reference to the moment object, so mutating `start`/`end` via `PlexdMoments.updateMoment()` takes effect immediately — no handler re-registration needed.

**Tech Stack:** Vanilla JS/CSS, PlexdMoments API, existing Wall view DOM

**Branch:** `feat/moments-system` (continue existing)

---

## Task 1: Add Timeline Bar DOM to Wall Cells

Add a mini-timeline bar to each cell in `renderMomentWall()`. The bar shows the moment's range as a filled region within the source video's total duration.

**Files:**
- Modify: `web/js/app.js` (renderMomentWall, ~line 3495-3597)

**Step 1: Add timeline bar after canvas in each cell**

Inside the `moments.forEach` loop (~line 3495), after `cell.appendChild(canvas)` (line 3504), add:

```javascript
// Timeline bar showing moment range within source duration
var timeline = document.createElement('div');
timeline.className = 'wall-timeline';

var fill = document.createElement('div');
fill.className = 'wall-timeline-fill';

var peakDot = document.createElement('div');
peakDot.className = 'wall-timeline-peak';

var handleL = document.createElement('div');
handleL.className = 'wall-timeline-handle wall-timeline-handle-l';

var handleR = document.createElement('div');
handleR.className = 'wall-timeline-handle wall-timeline-handle-r';

timeline.appendChild(fill);
timeline.appendChild(peakDot);
timeline.appendChild(handleL);
timeline.appendChild(handleR);
cell.appendChild(timeline);

// Store refs for updates
cell._timeline = { fill: fill, peakDot: peakDot, handleL: handleL, handleR: handleR, bar: timeline };
cell._moment = mom;
```

**Step 2: Add `updateCellTimeline` helper**

Add this function before `renderMomentWall` (~line 3468):

```javascript
function updateCellTimeline(cell) {
    var t = cell._timeline;
    var mom = cell._moment;
    if (!t || !mom) return;

    // Get source duration from loaded stream or estimate from moment.end
    var loadedStream = resolveMomentStream(mom);
    var dur = (loadedStream && loadedStream.video && loadedStream.video.duration > 0)
        ? loadedStream.video.duration : Math.max(mom.end + 10, 60);

    var startPct = (mom.start / dur) * 100;
    var endPct = (mom.end / dur) * 100;
    var peakPct = (mom.peak / dur) * 100;

    t.fill.style.left = startPct + '%';
    t.fill.style.width = (endPct - startPct) + '%';
    t.peakDot.style.left = peakPct + '%';
}
```

**Step 3: Call `updateCellTimeline` after building each cell**

At the end of the `moments.forEach` body, just before `grid.appendChild(cell)` (line 3597), add:

```javascript
updateCellTimeline(cell);
```

**Step 4: Verify**

Run: `node --check web/js/app.js` — expect clean parse.

Browser: Open Wall view (J → Tab to Wall). Each cell should show a thin bar at the bottom with a gold fill region. Non-selected cells show bar passively; no drag handles visible yet (CSS does that).

**Step 5: Commit**

```bash
git add web/js/app.js
git commit -m "feat(moments): add timeline bar DOM to Wall cells"
```

---

## Task 2: CSS for Timeline Bars

Style the timeline track, fill, peak dot, and drag handles. Handles only appear on the selected cell.

**Files:**
- Modify: `web/css/plexd.css` (after `.moment-wall-cell.drag-over` block, ~line 3368)

**Step 1: Add timeline CSS**

```css
/* Wall moment editing — timeline bar */
.wall-timeline {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    height: 3px;
    background: rgba(255, 255, 255, 0.15);
    z-index: 2;
    pointer-events: none;
}
.moment-wall-cell.selected .wall-timeline {
    height: 8px;
    pointer-events: auto;
}
.wall-timeline-fill {
    position: absolute;
    top: 0;
    bottom: 0;
    background: var(--gold);
    opacity: 0.7;
}
.moment-wall-cell.selected .wall-timeline-fill {
    opacity: 1;
    box-shadow: 0 0 6px rgba(201, 163, 85, 0.4);
}
.wall-timeline-peak {
    position: absolute;
    top: -1px;
    width: 3px;
    height: calc(100% + 2px);
    background: #fff;
    transform: translateX(-50%);
    opacity: 0.6;
}
.moment-wall-cell.selected .wall-timeline-peak {
    opacity: 1;
}
.wall-timeline-handle {
    display: none;
    position: absolute;
    top: 50%;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    background: var(--gold);
    border: 2px solid #fff;
    transform: translate(-50%, -50%);
    cursor: ew-resize;
    z-index: 3;
    box-shadow: 0 0 4px rgba(0, 0, 0, 0.5);
}
.moment-wall-cell.selected .wall-timeline-handle {
    display: block;
}
.wall-timeline-handle-l {
    /* left% set by JS to match fill left */
}
.wall-timeline-handle-r {
    /* left% set by JS to match fill right edge */
}
```

**Step 2: Update `updateCellTimeline` to position handles**

In `updateCellTimeline` (from Task 1), add after the peakDot line:

```javascript
t.handleL.style.left = startPct + '%';
t.handleR.style.left = endPct + '%';
```

**Step 3: Verify**

Browser: Open Wall view. Non-selected cells show a thin 3px bar. Click a cell — bar grows to 8px, gold handles appear at each end of the fill region. Peak shows as a white tick.

**Step 4: Commit**

```bash
git add web/css/plexd.css web/js/app.js
git commit -m "feat(moments): style Wall timeline bars with handles on selected cell"
```

---

## Task 3: Drag Handle Interaction

Make the left and right handles draggable on the selected cell. Dragging updates the moment's `start`/`end` via `PlexdMoments.updateMoment()`.

**Files:**
- Modify: `web/js/app.js` (inside `renderMomentWall`, after timeline creation in the forEach loop)

**Step 1: Add drag handler factory**

Add this function before `renderMomentWall` (~line 3468), after `updateCellTimeline`:

```javascript
function setupTimelineDrag(cell) {
    var t = cell._timeline;
    var mom = cell._moment;
    if (!t) return;

    function getSourceDuration() {
        var s = resolveMomentStream(mom);
        return (s && s.video && s.video.duration > 0) ? s.video.duration : Math.max(mom.end + 10, 60);
    }

    function handleDrag(handle, side) {
        function onMove(e) {
            e.preventDefault();
            var rect = t.bar.getBoundingClientRect();
            var clientX = e.touches ? e.touches[0].clientX : e.clientX;
            var pct = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            var dur = getSourceDuration();
            var time = pct * dur;

            if (side === 'left') {
                // In-point: clamp to [0, end - 1]
                mom.start = Math.max(0, Math.min(time, mom.end - 1));
                // Keep peak inside range
                if (mom.peak < mom.start) mom.peak = mom.start;
            } else {
                // Out-point: clamp to [start + 1, duration]
                mom.end = Math.max(mom.start + 1, Math.min(time, dur));
                // Keep peak inside range
                if (mom.peak > mom.end) mom.peak = mom.end;
            }
            updateCellTimeline(cell);
        }

        function onEnd() {
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onEnd);
            document.removeEventListener('touchmove', onMove);
            document.removeEventListener('touchend', onEnd);
            // Persist the edit
            PlexdMoments.updateMoment(mom.id, { start: mom.start, end: mom.end, peak: mom.peak });
            var durStr = (mom.end - mom.start).toFixed(1) + 's';
            var inStr = Math.floor(mom.start / 60) + ':' + String(Math.floor(mom.start % 60)).padStart(2, '0');
            showMessage('In: ' + inStr + ' | Dur: ' + durStr, 'info');
        }

        handle.addEventListener('mousedown', function(e) {
            e.preventDefault();
            e.stopPropagation();
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onEnd);
        });
        handle.addEventListener('touchstart', function(e) {
            e.preventDefault();
            e.stopPropagation();
            document.addEventListener('touchmove', onMove, { passive: false });
            document.addEventListener('touchend', onEnd);
        }, { passive: false });
    }

    handleDrag(t.handleL, 'left');
    handleDrag(t.handleR, 'right');
}
```

**Step 2: Call `setupTimelineDrag` after building the selected cell**

In the `moments.forEach` loop, after `updateCellTimeline(cell)`, add:

```javascript
if (idx === momentBrowserState.selectedIndex) {
    setupTimelineDrag(cell);
}
```

**Step 3: Re-attach drag on selection change**

In `updateWallSelection()` (~line 3656), after toggling the `.selected` class, add:

```javascript
// Re-attach drag handlers to newly selected cell
var selectedCell = document.querySelector('.moment-wall-cell.selected');
if (selectedCell && selectedCell._timeline) {
    setupTimelineDrag(selectedCell);
}
```

Note: Since `setupTimelineDrag` adds new event listeners each call, and old listeners are on the old handles (which are the same DOM elements but no longer in a `.selected` cell with `pointer-events: auto`), old listeners are effectively dead. No leak concern since cells are recreated on re-render.

**Step 4: Verify**

Browser: Open Wall view, select a cell. Drag the left handle — in-point moves, loop restarts from new position. Drag right handle — duration changes. Toast shows updated values. Peak dot stays within range.

**Step 5: Commit**

```bash
git add web/js/app.js
git commit -m "feat(moments): add drag handles for Wall moment in-point and duration editing"
```

---

## Task 4: Keyboard Nudge

Add `Opt+Arrow` and `Opt+Shift+Arrow` to the Moment Browser keyboard handler for fine-grained in-point and duration adjustment.

**Files:**
- Modify: `web/js/app.js` (handleMomentBrowserKeys, ~line 4703 switch block)

**Step 1: Add altKey checks before existing arrow cases**

In the `switch (e.key)` block inside `handleMomentBrowserKeys`, **before** the existing `case 'ArrowRight':` (line 4742), add these cases. Since switch cases fall through, and ArrowLeft/ArrowRight are already handled, we need to intercept `altKey` inside the existing cases. Replace the four arrow cases (ArrowRight at 4742, ArrowLeft at 4758, ArrowDown at 4774, ArrowUp at 4794) by adding `e.altKey` guard at the top of each:

For `ArrowLeft` and `ArrowRight`, add at the very start of each case:

```javascript
case 'ArrowRight':
    e.preventDefault();
    if (e.altKey && mode === 1 && moments.length > 0 && moments[idx]) {
        var mom = moments[idx];
        var s = resolveMomentStream(mom);
        var dur = (s && s.video && s.video.duration > 0) ? s.video.duration : Math.max(mom.end + 10, 60);
        if (e.shiftKey) {
            // Opt+Shift+Right: extend duration +0.5s
            mom.end = Math.min(mom.end + 0.5, dur);
        } else {
            // Opt+Right: nudge in-point later +0.5s
            mom.start = Math.min(mom.start + 0.5, mom.end - 1);
            if (mom.peak < mom.start) mom.peak = mom.start;
        }
        PlexdMoments.updateMoment(mom.id, { start: mom.start, end: mom.end, peak: mom.peak });
        var cell = document.querySelector('.moment-wall-cell.selected');
        if (cell) updateCellTimeline(cell);
        var inStr = Math.floor(mom.start / 60) + ':' + String(Math.floor(mom.start % 60)).padStart(2, '0');
        showMessage('In: ' + inStr + ' | Dur: ' + (mom.end - mom.start).toFixed(1) + 's', 'info');
        return true;
    }
    // ... existing navigation code continues unchanged ...
```

```javascript
case 'ArrowLeft':
    e.preventDefault();
    if (e.altKey && mode === 1 && moments.length > 0 && moments[idx]) {
        var mom = moments[idx];
        if (e.shiftKey) {
            // Opt+Shift+Left: shrink duration -0.5s
            mom.end = Math.max(mom.end - 0.5, mom.start + 1);
            if (mom.peak > mom.end) mom.peak = mom.end;
        } else {
            // Opt+Left: nudge in-point earlier -0.5s
            mom.start = Math.max(mom.start - 0.5, 0);
        }
        PlexdMoments.updateMoment(mom.id, { start: mom.start, end: mom.end, peak: mom.peak });
        var cell = document.querySelector('.moment-wall-cell.selected');
        if (cell) updateCellTimeline(cell);
        var inStr = Math.floor(mom.start / 60) + ':' + String(Math.floor(mom.start % 60)).padStart(2, '0');
        showMessage('In: ' + inStr + ' | Dur: ' + (mom.end - mom.start).toFixed(1) + 's', 'info');
        return true;
    }
    // ... existing navigation code continues unchanged ...
```

**Step 2: Verify**

Browser: Open Wall view, select a moment. Press `Opt+Right` — in-point moves 0.5s later, toast confirms. Press `Opt+Left` — back 0.5s. Press `Opt+Shift+Right` — duration extends. Press `Opt+Shift+Left` — duration shrinks. Minimum 1s duration enforced.

**Step 3: Commit**

```bash
git add web/js/app.js
git commit -m "feat(moments): add Opt+Arrow keyboard nudge for Wall moment editing"
```

---

## Task 5: Update Help Overlay + CLAUDE.md

Update the keyboard shortcuts modal with Moments shortcuts and fix stale labels.

**Files:**
- Modify: `web/js/app.js` (showShortcutsModal, ~line 9308)
- Modify: `CLAUDE.md` (add Moments section)

**Step 1: Update help overlay**

In `showShortcutsModal()` (~line 9348), find the Theater Mode section and replace:

```html
<div class="plexd-shortcut"><kbd>J</kbd> Toggle Encore view</div>
<div class="plexd-shortcut"><kbd>K</kbd> Bookmark moment</div>
```

with:

```html
<div class="plexd-shortcut"><kbd>K</kbd> Capture Moment</div>
<div class="plexd-shortcut"><kbd>J</kbd> Toggle Moment Browser</div>
<div class="plexd-shortcut"><kbd>E</kbd> / <kbd>Tab</kbd> Cycle browser mode</div>
<div class="plexd-shortcut"><kbd>Shift+/</kbd> Jump to random moment</div>
<div class="plexd-shortcut"><kbd>Shift+←→</kbd> Jump between moments (Stage)</div>
```

Also add a new section after Stars & Slots:

```html
<div class="plexd-shortcuts-section">
    <h4>Wall Editing</h4>
    <div class="plexd-shortcut"><kbd>Opt+←→</kbd> Nudge in-point ±0.5s</div>
    <div class="plexd-shortcut"><kbd>Opt+Shift+←→</kbd> Adjust duration ±0.5s</div>
    <div class="plexd-shortcut"><kbd>Drag handles</kbd> Drag in/out points</div>
</div>
```

**Step 2: Update CLAUDE.md**

Add a Moments System section to CLAUDE.md after the Theater & Advanced Mode section, documenting the data model, key APIs, browser modes, and Wall editing.

**Step 3: Verify**

Browser: Press `?` or `H` to open help. Confirm Moments shortcuts appear. Confirm "Encore" and "Bookmark" labels are gone.

**Step 4: Commit**

```bash
git add web/js/app.js CLAUDE.md
git commit -m "docs: update help overlay and CLAUDE.md with Moments system shortcuts"
```

---

## Verification Checklist

After all tasks:

1. Wall view shows timeline bars on every cell
2. Selected cell shows 8px bar with gold drag handles
3. Drag left handle — in-point moves, loop updates live
4. Drag right handle — duration changes, loop updates live
5. Peak dot stays within range after edits
6. `Opt+Left/Right` nudges in-point by 0.5s
7. `Opt+Shift+Left/Right` adjusts duration by 0.5s
8. Toast shows updated in-point and duration
9. Edits persist (refresh page, moments retain new start/end)
10. Help overlay shows Moments shortcuts, no stale labels
