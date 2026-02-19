# Theater & Advanced Mode — Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add a two-mode viewing system (Theater + Advanced) to Plexd with ergonomic key remaps, a 5-scene Theater experience, and a persistent mode indicator.

**Architecture:** Theater mode is an orchestration layer over existing layout algorithms. A new state machine in `app.js` tracks the current mode (theater/advanced) and scene. Key events route through a dispatcher that calls existing functions based on mode. No new files — everything integrates into `app.js`, `stream.js`, `grid.js`, and `plexd.css`.

**Tech Stack:** Vanilla JS, CSS transitions, HTML5 Video API, existing PlexdGrid/PlexdStream/PlexdApp modules.

**Design doc:** `docs/plans/2026-02-19-theater-advanced-mode-design.md`

---

## Phase 1: Foundation & Bugfixes

### Task 1: Fix rotate bug with hidden streams

The `rotateStreamOrder()` function rotates ALL streams including hidden ones, causing visible rotation to appear broken when a view filter is active.

**Files:**
- Modify: `web/js/stream.js:3540-3567` (`rotateStreamOrder`)
- Modify: `web/js/stream.js:3572-3595` (`shuffleStreamOrder`)

**Step 1: Fix rotateStreamOrder to skip hidden streams**

In `web/js/stream.js`, replace the `rotateStreamOrder` function:

```javascript
function rotateStreamOrder(reverse = false) {
    const allEntries = Array.from(streams.entries());
    const visible = [];
    const hiddenPositions = []; // Track hidden stream positions

    allEntries.forEach(([id, stream], idx) => {
        if (stream.hidden) {
            hiddenPositions.push({ idx, entry: [id, stream] });
        } else {
            visible.push([id, stream]);
        }
    });

    if (visible.length < 2) return;

    if (reverse) {
        const first = visible.shift();
        visible.push(first);
    } else {
        const last = visible.pop();
        visible.unshift(last);
    }

    // Reconstruct full array: insert hidden streams back at their original positions
    const result = [...visible];
    hiddenPositions.forEach(({ idx, entry }) => {
        result.splice(Math.min(idx, result.length), 0, entry);
    });

    // Rebuild Map and DOM order
    streams.clear();
    result.forEach(([id, stream]) => streams.set(id, stream));

    const container = document.getElementById('plexd-container');
    if (container) {
        result.forEach(([id, stream]) => {
            if (stream.wrapper && stream.wrapper.parentElement === container) {
                container.appendChild(stream.wrapper);
            }
        });
    }
}
```

**Step 2: Fix shuffleStreamOrder similarly**

Same pattern — only shuffle visible streams, keep hidden in place:

```javascript
function shuffleStreamOrder() {
    const allEntries = Array.from(streams.entries());
    const visible = [];
    const hiddenPositions = [];

    allEntries.forEach(([id, stream], idx) => {
        if (stream.hidden) {
            hiddenPositions.push({ idx, entry: [id, stream] });
        } else {
            visible.push([id, stream]);
        }
    });

    if (visible.length < 2) return;

    // Fisher-Yates on visible only
    for (let i = visible.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [visible[i], visible[j]] = [visible[j], visible[i]];
    }

    const result = [...visible];
    hiddenPositions.forEach(({ idx, entry }) => {
        result.splice(Math.min(idx, result.length), 0, entry);
    });

    streams.clear();
    result.forEach(([id, stream]) => streams.set(id, stream));

    const container = document.getElementById('plexd-container');
    if (container) {
        result.forEach(([id, stream]) => {
            if (stream.wrapper && stream.wrapper.parentElement === container) {
                container.appendChild(stream.wrapper);
            }
        });
    }
}
```

**Step 3: Verify**

Run: `node --check web/js/stream.js`
Browser test: Load 6 streams, filter to rating 5 (showing 3), press `]` multiple times. All 3 visible streams should rotate correctly without sticking.

**Step 4: Commit**

```bash
git add web/js/stream.js
git commit -m "fix: rotate/shuffle only visible streams when filter active"
```

---

### Task 2: Update audio model — default muted with M toggle

Currently `audioFocusMode` defaults to `true` (loaded from localStorage). New model: audio defaults OFF, `M` unmutes selected and enables audio-follow, `M` again mutes and disables follow, `N` kills all audio.

**Files:**
- Modify: `web/js/stream.js:24` (audioFocusMode default)
- Modify: `web/js/stream.js:2939` (mute/unmute logic)
- Modify: `web/js/stream.js:2965-2970` (toggleAudioFocus)
- Modify: `web/js/app.js:3174-3181` (M key handler)
- Modify: `web/js/app.js:3183-3190` (N key handler)

**Step 1: Change default audio state**

In `web/js/stream.js:24`, change:
```javascript
// Old:
let audioFocusMode = localStorage.getItem('plexd_audio_focus') !== 'false';
// New:
let audioFocusMode = false;
```

**Step 2: Update M key handler in app.js**

In `web/js/app.js:3174-3181`, replace the `m`/`M` case:

```javascript
case 'm':
case 'M':
    {
        const targetStream = fullscreenStream || selected;
        if (targetStream) {
            const isMuted = targetStream.video.muted;
            if (isMuted) {
                // Unmuting: enable audio focus so audio follows navigation
                PlexdStream.toggleMute(targetStream.id); // unmutes
                if (!PlexdStream.isAudioFocusMode()) {
                    PlexdStream.toggleAudioFocus();
                    updateAudioFocusButton(true);
                }
                // Mute all others when enabling audio follow
                PlexdStream.muteAllExcept(targetStream.id);
                showMessage('Audio ON — follows selection', 'info');
            } else {
                // Muting: disable audio focus
                PlexdStream.toggleMute(targetStream.id); // mutes
                if (PlexdStream.isAudioFocusMode()) {
                    PlexdStream.toggleAudioFocus();
                    updateAudioFocusButton(false);
                }
                showMessage('Audio OFF', 'info');
            }
        }
    }
    break;
```

**Step 3: Update N key handler**

In `web/js/app.js:3183-3190`, replace the `n`/`N` case:

```javascript
case 'n':
case 'N':
    // N = Kill all audio, stop following
    {
        PlexdStream.muteAll();
        if (PlexdStream.isAudioFocusMode()) {
            PlexdStream.toggleAudioFocus();
        }
        updateAudioFocusButton(false);
        showMessage('All audio OFF', 'info');
    }
    break;
```

**Step 4: Add helper functions to stream.js exports**

Add `isAudioFocusMode` and `muteAllExcept` to stream.js if they don't exist.

In `web/js/stream.js`, add near the existing mute functions:

```javascript
function isAudioFocusMode() {
    return audioFocusMode;
}

function muteAllExcept(streamId) {
    streams.forEach((stream, id) => {
        if (id !== streamId && stream.video) {
            stream.video.muted = true;
        }
    });
}
```

Add to the return object: `isAudioFocusMode, muteAllExcept`

**Step 5: Mute all streams on init**

Ensure new streams start muted. In the stream creation flow, verify `video.muted = true` is set.

**Step 6: Verify**

Run: `node --check web/js/stream.js && node --check web/js/app.js`
Browser test:
- Load streams — all should be muted (silent)
- Select a stream, press M — that stream unmutes, audio follows arrows
- Press M again — muted, audio stops following
- Unmute again with M, press N — all audio killed

**Step 7: Commit**

```bash
git add web/js/stream.js web/js/app.js
git commit -m "feat: audio defaults off, M toggles unmute+follow, N kills all"
```

---

## Phase 2: Key Remapping

### Task 3: Remap Q for star, L for relayout

**Files:**
- Modify: `web/js/app.js:3669-3681` (L key handler)
- Modify: `web/js/app.js` — add Q handler in handleKeyboard switch
- Modify: `web/js/stream.js` — propagateKeys regex (add Q)

**Step 1: Add Q key handler (star/favorite with double-tap filter)**

In `web/js/app.js`, add new state variables near line 590:

```javascript
let lastQTime = 0;
let qTimeout = null;
```

Add in `handleKeyboard` switch, before the existing `case 'r'`:

```javascript
case 'q':
case 'Q':
    // Q = Star/favorite, QQ = filter to favorites
    e.preventDefault();
    {
        const now = Date.now();
        if ((now - lastQTime) < DOUBLE_TAP_THRESHOLD) {
            // Double tap: filter to favorites
            if (qTimeout) { clearTimeout(qTimeout); qTimeout = null; }
            lastQTime = 0;
            const fullscreenMode = PlexdStream.getFullscreenMode();
            if (fullscreenMode === 'true-focused' || fullscreenMode === 'browser-fill') {
                PlexdStream.exitFocusedMode();
            }
            const count = PlexdStream.getFavoriteCount();
            setViewMode('favorites');
            if (count === 0) {
                showMessage('No favorites yet — press Q to star streams', 'info');
            }
        } else {
            lastQTime = now;
            if (qTimeout) clearTimeout(qTimeout);
            const targetStream = fullscreenStream || selected;
            qTimeout = setTimeout(() => {
                qTimeout = null;
                if (targetStream) {
                    const isFav = PlexdStream.toggleFavorite(targetStream.id);
                    showMessage(isFav ? 'Starred' : 'Unstarred', isFav ? 'success' : 'info');
                } else {
                    showMessage('Select a stream first', 'warning');
                }
            }, DOUBLE_TAP_THRESHOLD);
        }
    }
    break;
```

**Step 2: Change L to force relayout**

In `web/js/app.js:3669-3681`, replace the L handler:

```javascript
case 'l':
case 'L':
    // L = Force relayout (star moved to Q)
    e.preventDefault();
    forceRelayout();
    break;
```

**Step 3: Update propagateKeys regex in stream.js**

Add `qQ` to the propagateKeys regex in stream.js.

**Step 4: Update help overlay**

Change shortcut text: `Q` Star, `QQ` Filter starred, `L` Force relayout.

**Step 5: Verify & Commit**

Run: `node --check web/js/app.js && node --check web/js/stream.js`
Browser test: Press Q to star, QQ to filter, L to relayout.

```bash
git add web/js/app.js web/js/stream.js
git commit -m "feat: remap Q for star/favorite, L for relayout"
```

---

### Task 4: Add E/R seek aliases and XX double-tap remove

**Files:**
- Modify: `web/js/app.js` — handleKeyboard switch (add E, R cases; modify X case)
- Modify: `web/js/stream.js` — propagateKeys regex, isFavorite export

**Step 1: Add E key handler (seek back, double-tap for 60s)**

Add state variables near line 590:

```javascript
let lastETime = 0;
let eTimeout = null;
let lastRTime = 0;
let rTimeout = null;
let lastXTime = 0;
let xTimeout = null;
```

Add in handleKeyboard switch:

```javascript
case 'e':
    // e = Seek back 10s, ee = Seek back 60s
    // In Theater Climax: E cycles sub-mode (handled by theater dispatcher above)
    if (theaterMode && theaterScene === 'climax') {
        if (e.shiftKey) {
            climaxSubMode = (climaxSubMode + 3) % 4;
        } else {
            climaxSubMode = (climaxSubMode + 1) % 4;
        }
        applyClimaxSubMode();
        updateLayout();
        showMessage(getSceneName('climax'), 'info');
        break;
    }
    e.preventDefault();
    {
        const now = Date.now();
        if ((now - lastETime) < DOUBLE_TAP_THRESHOLD) {
            if (eTimeout) { clearTimeout(eTimeout); eTimeout = null; }
            lastETime = 0;
            const ts = fullscreenStream || selected;
            if (ts) PlexdStream.seekRelative(ts.id, -60);
            syncOverlayClones();
        } else {
            lastETime = now;
            if (eTimeout) clearTimeout(eTimeout);
            const ts = fullscreenStream || selected;
            eTimeout = setTimeout(() => {
                eTimeout = null;
                if (ts) PlexdStream.seekRelative(ts.id, -10);
                syncOverlayClones();
            }, DOUBLE_TAP_THRESHOLD);
        }
    }
    break;
```

**Step 2: Add R key handler (seek forward, double-tap for 60s, Shift for reload)**

Replace existing `case 'r'` / `case 'R'`:

```javascript
case 'r':
case 'R':
    if (e.shiftKey) {
        // Shift+R = Reload stream (moved from plain R)
        const ts = fullscreenStream || selected || getCoverflowSelectedStream();
        if (ts) {
            PlexdStream.reloadStream(ts.id);
            showMessage('Reloading stream...', 'info');
        } else {
            showMessage('Select a stream first', 'info');
        }
        break;
    }
    // r = Seek forward 10s, rr = Seek forward 60s
    e.preventDefault();
    {
        const now = Date.now();
        if ((now - lastRTime) < DOUBLE_TAP_THRESHOLD) {
            if (rTimeout) { clearTimeout(rTimeout); rTimeout = null; }
            lastRTime = 0;
            const ts = fullscreenStream || selected;
            if (ts) PlexdStream.seekRelative(ts.id, 60);
            syncOverlayClones();
        } else {
            lastRTime = now;
            if (rTimeout) clearTimeout(rTimeout);
            const ts = fullscreenStream || selected;
            rTimeout = setTimeout(() => {
                rTimeout = null;
                if (ts) PlexdStream.seekRelative(ts.id, 10);
                syncOverlayClones();
            }, DOUBLE_TAP_THRESHOLD);
        }
    }
    break;
```

**Step 3: Modify X handler for XX double-tap**

Wrap existing X logic in double-tap detection. Single X = remove selected (existing). Double XX = remove all unstarred.

```javascript
case 'x':
case 'X':
    {
        const now = Date.now();
        if ((now - lastXTime) < DOUBLE_TAP_THRESHOLD) {
            // XX: Remove all unstarred streams
            if (xTimeout) { clearTimeout(xTimeout); xTimeout = null; }
            lastXTime = 0;
            const allStreams = PlexdStream.getAllStreams();
            const unstarred = allStreams.filter(s => !PlexdStream.isFavorite(s.id));
            if (unstarred.length === 0) {
                showMessage('All streams are starred', 'info');
            } else {
                unstarred.forEach(s => PlexdStream.removeStream(s.id));
                updateStreamCount();
                saveCurrentStreams();
                showMessage('Removed ' + unstarred.length + ' unstarred streams', 'info');
            }
        } else {
            lastXTime = now;
            if (xTimeout) clearTimeout(xTimeout);
            const targetStream = fullscreenStream || selected || getCoverflowSelectedStream();
            xTimeout = setTimeout(() => {
                xTimeout = null;
                if (targetStream) {
                    if (fullscreenStream) {
                        const nextStreamId = PlexdStream.getNextStreamId(targetStream.id);
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
            }, DOUBLE_TAP_THRESHOLD);
        }
    }
    break;
```

**Step 4: Add `isFavorite` to stream.js exports if not already there**

Check and add: `function isFavorite(streamId) { return favorites.has(streamId); }`

**Step 5: Update propagateKeys regex for E and R**

Add `eErR` to the propagateKeys regex in stream.js.

**Step 6: Update help overlay text**

Update seek shortcuts to show `E`/`R` as primary, `,`/`.` as alias.

**Step 7: Verify & Commit**

Run: `node --check web/js/app.js && node --check web/js/stream.js`
Browser test: E/R for seeking, EE/RR for big jumps, Shift+R for reload, XX for bulk remove.

```bash
git add web/js/app.js web/js/stream.js
git commit -m "feat: add E/R seek aliases, XX double-tap bulk remove"
```

---

## Phase 3: Mode Infrastructure

### Task 5: Add Theater/Advanced mode state machine

**Files:**
- Modify: `web/js/app.js:582-620` (state variables section)
- Modify: `web/js/app.js` (new functions for mode/scene management)

**Step 1: Add mode state variables**

After the existing mode state variables (around line 620), add:

```javascript
// Theater/Advanced Mode
let theaterMode = true; // true = Theater (default), false = Advanced
let theaterScene = 'casting'; // 'casting' | 'lineup' | 'stage' | 'climax' | 'encore'
let climaxSubMode = 0; // 0=tight-wall, 1=auto-rotate, 2=collage, 3=single-focus
let encorePreviousScene = null; // Scene to return to after Encore
let autoRotateTimer = null; // Timer for Climax auto-rotate hero
const AUTO_ROTATE_INTERVAL = 15000; // 15 seconds
let bookmarks = []; // Array of { streamId, timestamp, bookmarkedAt }

// Space double-tap detection (Theater: random seek)
let lastSpaceTime = 0;
let spaceTimeout = null;

// Stage hero tracking
let stageHeroId = null;
```

**Step 2: Add scene management functions**

```javascript
function setTheaterScene(scene) {
    const prev = theaterScene;
    if (prev === 'encore') closeEncoreView();
    if (prev === 'climax' && scene !== 'climax') stopAutoRotate();
    theaterScene = scene;
    applyTheaterScene();
    updateModeIndicator();
    showMessage(getSceneName(scene), 'info');
}

function getSceneName(scene) {
    const names = {
        casting: 'Casting Call',
        lineup: 'Lineup',
        stage: 'Stage',
        climax: 'Climax: ' + ['Tight Wall', 'Auto-Rotate', 'Collage', 'Single Focus'][climaxSubMode],
        encore: 'Encore'
    };
    return names[scene] || scene;
}

function nextScene() {
    const order = ['casting', 'lineup', 'stage', 'climax'];
    const idx = order.indexOf(theaterScene);
    const next = idx >= order.length - 1 ? order[0] : order[idx + 1];
    setTheaterScene(next);
}

function prevScene() {
    const order = ['casting', 'lineup', 'stage', 'climax'];
    const idx = order.indexOf(theaterScene);
    const prev = idx <= 0 ? order[order.length - 1] : order[idx - 1];
    setTheaterScene(prev);
}

function toggleTheaterAdvanced() {
    theaterMode = !theaterMode;
    const app = document.querySelector('.plexd-app');
    if (app) app.classList.toggle('theater-mode', theaterMode);

    if (theaterMode) {
        theaterScene = detectCurrentScene();
        applyTheaterScene();
    }
    updateModeIndicator();
    showMessage(theaterMode ? 'Theater Mode' : 'Advanced Mode', 'info');
}

function detectCurrentScene() {
    const mode = PlexdStream.getFullscreenMode();
    if (mode === 'true-focused' || mode === 'browser-fill') return 'stage';
    if (wallMode === 3) return 'stage';
    if (viewMode === 'favorites' || (typeof viewMode === 'number' && viewMode >= 5)) return 'lineup';
    if (bugEyeMode || mosaicMode || (wallMode === 2 && tetrisMode > 0)) return 'climax';
    return 'casting';
}
```

**Step 3: Add applyTheaterScene function**

```javascript
function applyTheaterScene() {
    if (coverflowMode) toggleCoverflowMode();

    switch (theaterScene) {
        case 'casting':
            setViewMode('all');
            tetrisMode = 0;
            wallMode = 2;
            window._plexdWallMode = 2;
            if (!faceDetectionActive) startFaceDetection();
            break;

        case 'lineup':
            applyLineupFilter();
            wallMode = 0;
            window._plexdWallMode = 0;
            tetrisMode = 3;
            break;

        case 'stage':
            tetrisMode = 0;
            wallMode = 3;
            window._plexdWallMode = 3;
            if (!stageHeroId || !PlexdStream.getStream(stageHeroId)) {
                const streams = getFilteredStreams();
                stageHeroId = streams.length > 0 ? streams[0].id : null;
            }
            if (stageHeroId) PlexdStream.selectStream(stageHeroId);
            break;

        case 'climax':
            applyClimaxSubMode();
            break;

        case 'encore':
            showEncoreView();
            return;
    }

    updateWallModeClasses();
    updateTetrisModeClasses();
    updateLayout();
}

function applyLineupFilter() {
    const favCount = PlexdStream.getFavoriteCount();
    if (favCount > 0) {
        setViewMode('favorites');
    } else {
        setViewMode('all');
    }
}
```

**Step 4: Add to PlexdApp exports**

Add to the return object:
```javascript
toggleTheaterAdvanced,
nextScene,
prevScene,
setTheaterScene,
```

**Step 5: Verify & Commit**

Run: `node --check web/js/app.js`

```bash
git add web/js/app.js
git commit -m "feat: add Theater/Advanced mode state machine and scene management"
```

---

### Task 6: Wire up backtick toggle and Space/Escape for Theater

**Files:**
- Modify: `web/js/app.js:3197-3211` (backtick handler)
- Modify: `web/js/app.js:3161-3172` (Space handler)
- Modify: `web/js/app.js:3411-3458` (Escape handler)
- Modify: `web/js/stream.js` — propagateKeys for J, K

**Step 1: Replace backtick handler with mode toggle**

```javascript
case '`':
    e.preventDefault();
    toggleTheaterAdvanced();
    break;
```

**Step 2: Replace Space handler with mode-aware logic**

```javascript
case ' ':
    e.preventDefault();
    if (theaterMode) {
        const now = Date.now();
        const shiftHeld = e.shiftKey;
        if ((now - lastSpaceTime) < DOUBLE_TAP_THRESHOLD) {
            if (spaceTimeout) { clearTimeout(spaceTimeout); spaceTimeout = null; }
            lastSpaceTime = 0;
            if (theaterScene === 'stage' || theaterScene === 'climax') {
                randomSeekSelected();
            } else {
                randomSeekAll();
            }
        } else {
            lastSpaceTime = now;
            if (spaceTimeout) clearTimeout(spaceTimeout);
            spaceTimeout = setTimeout(() => {
                spaceTimeout = null;
                if (shiftHeld) { prevScene(); } else { nextScene(); }
            }, DOUBLE_TAP_THRESHOLD);
        }
    } else {
        // Advanced: Space = play/pause (existing behavior)
        if (selected) {
            if (selected.video.paused) {
                selected.video.play().catch(() => {});
            } else {
                selected.video.pause();
            }
        } else {
            togglePlayPause();
        }
    }
    break;
```

**Step 3: Update Escape handler for Theater scene regression**

At the bottom of the Escape handler, in the `else` (normal mode) block, add Theater check:

```javascript
} else {
    // Normal mode
    if (theaterMode && theaterScene !== 'casting') {
        prevScene();
    } else {
        PlexdStream.selectStream(null);
        PlexdStream.resetFullscreenState();
    }
    if (inputEl) inputEl.blur();
}
```

**Step 4: Wire J for Encore, K for Bookmark**

Add in handleKeyboard switch:

```javascript
case 'j':
case 'J':
    if (!theaterMode) break;
    e.preventDefault();
    if (theaterScene === 'encore') {
        setTheaterScene(encorePreviousScene || 'casting');
        encorePreviousScene = null;
    } else {
        encorePreviousScene = theaterScene;
        setTheaterScene('encore');
    }
    break;

case 'k':
case 'K':
    if (!theaterMode) break;
    e.preventDefault();
    {
        const ts = fullscreenStream || selected;
        if (ts && ts.video) {
            bookmarks.push({
                streamId: ts.id,
                timestamp: ts.video.currentTime,
                bookmarkedAt: Date.now()
            });
            const m = Math.floor(ts.video.currentTime / 60);
            const s = Math.floor(ts.video.currentTime % 60);
            showMessage('Bookmarked at ' + m + ':' + String(s).padStart(2, '0'), 'success');
        }
    }
    break;
```

**Step 5: Update propagateKeys for J, K, E, R, Q**

Add `jJkKeErRqQ` to the propagateKeys regex in stream.js.

**Step 6: Modify arrow handler for Stage hero rotation**

In `handleArrowNav`, add at the top:

```javascript
if (theaterMode && theaterScene === 'stage') {
    const streams = getFilteredStreams();
    if (streams.length === 0) return;
    if (direction === 'left' || direction === 'right') {
        const currentIdx = streams.findIndex(s => s.id === stageHeroId);
        let nextIdx;
        if (direction === 'right') {
            nextIdx = currentIdx >= streams.length - 1 ? 0 : currentIdx + 1;
        } else {
            nextIdx = currentIdx <= 0 ? streams.length - 1 : currentIdx - 1;
        }
        stageHeroId = streams[nextIdx].id;
        PlexdStream.selectStream(stageHeroId);
        updateLayout();
        return;
    }
    PlexdStream.selectNextStream(direction);
    return;
}
```

**Step 7: Verify & Commit**

Run: `node --check web/js/app.js && node --check web/js/stream.js`
Browser test: Backtick toggles mode. In Theater: Space advances scenes, Escape regresses. J/K bookmark. Arrows rotate hero in Stage.

```bash
git add web/js/app.js web/js/stream.js
git commit -m "feat: wire Theater key routing — backtick toggle, Space scenes, J/K bookmarks"
```

---

### Task 7: Add mode indicator badge

**Files:**
- Modify: `web/index.html` — add badge element
- Modify: `web/css/plexd.css` — badge styles
- Modify: `web/js/app.js` — updateModeIndicator function

**Step 1: Add HTML element**

In `web/index.html`, just inside the `.plexd-app` div (after the header), add:

```html
<div id="mode-indicator" class="plexd-mode-indicator"></div>
```

**Step 2: Add CSS**

```css
.plexd-mode-indicator {
    position: fixed;
    top: 8px;
    right: 8px;
    z-index: 1000;
    display: flex;
    gap: 6px;
    pointer-events: none;
    font-family: 'SF Mono', 'Fira Code', monospace;
    font-size: 11px;
    transition: opacity 0.2s ease;
}

.plexd-mode-indicator:empty { display: none; }

.plexd-mode-indicator .badge {
    padding: 2px 6px;
    border-radius: 3px;
    background: rgba(0, 0, 0, 0.6);
    color: rgba(255, 255, 255, 0.8);
    backdrop-filter: blur(4px);
}

.plexd-mode-indicator .badge-scene {
    background: rgba(236, 72, 153, 0.7);
    color: white;
}

.clean-mode .plexd-mode-indicator { display: none; }
.header-hidden .plexd-mode-indicator { opacity: 0; }
```

**Step 3: Add updateModeIndicator function in app.js**

```javascript
function updateModeIndicator() {
    const el = document.getElementById('mode-indicator');
    if (!el) return;

    // Clear existing badges
    el.textContent = '';

    if (theaterMode) {
        const sceneNames = {
            casting: 'CAST', lineup: 'LINE', stage: 'STAGE',
            climax: 'CLIMAX', encore: 'ENCORE'
        };
        const badge = document.createElement('span');
        badge.className = 'badge badge-scene';
        badge.textContent = sceneNames[theaterScene] || theaterScene;
        el.appendChild(badge);
    } else {
        // Advanced mode — show active modes
        const modes = [];
        if (tetrisMode > 0) modes.push('T' + tetrisMode);
        if (wallMode > 0) modes.push('W' + wallMode);
        if (coverflowMode) modes.push('CF');
        if (faceDetectionActive) modes.push('A');
        if (viewMode !== 'all') {
            modes.push(viewMode === 'favorites' ? 'FAV' : 'R' + viewMode);
        }
        modes.forEach(text => {
            const badge = document.createElement('span');
            badge.className = 'badge';
            badge.textContent = text;
            el.appendChild(badge);
        });
    }
}
```

Call `updateModeIndicator()` at the end of: `toggleTheaterAdvanced()`, `applyTheaterScene()`, `cycleTetrisMode()`, `cycleWallMode()`, `toggleCoverflowMode()`, `setViewMode()`, `startFaceDetection()`, `stopFaceDetection()`.

**Step 4: Verify & Commit**

Run: `node --check web/js/app.js`
Browser test: Badge shows in top-right. Changes as you switch modes/scenes.

```bash
git add web/index.html web/css/plexd.css web/js/app.js
git commit -m "feat: add persistent mode indicator badge"
```

---

## Phase 4: Theater Scenes

### Task 8: Implement Casting Call visual feedback

**Files:**
- Modify: `web/css/plexd.css` — starred glow, low-rated dim
- Modify: `web/js/app.js` — visual state update function

**Step 1: Add CSS**

```css
.theater-mode .plexd-stream.starred-glow {
    box-shadow: inset 0 0 0 2px rgba(251, 191, 36, 0.8), 0 0 20px rgba(251, 191, 36, 0.3);
    z-index: 5;
}

.theater-mode .plexd-stream.low-rated {
    opacity: 0.7;
    filter: brightness(0.85);
}
```

**Step 2: Add updateCastingCallVisuals function**

```javascript
function updateCastingCallVisuals() {
    if (!theaterMode || theaterScene !== 'casting') return;
    const allStreams = PlexdStream.getAllStreams();
    allStreams.forEach(stream => {
        if (!stream.wrapper) return;
        const isFav = PlexdStream.isFavorite(stream.id);
        const rating = PlexdStream.getRating(stream.id);
        stream.wrapper.classList.toggle('starred-glow', isFav);
        stream.wrapper.classList.toggle('low-rated', rating > 0 && rating <= 3);
    });
}
```

Call this after star (Q), rate (1-9, G), and on Casting Call scene entry.

**Step 3: Verify & Commit**

```bash
git add web/css/plexd.css web/js/app.js
git commit -m "feat: Casting Call scene with starred glow and low-rated dimming"
```

---

### Task 9: Implement Lineup rating-weighted treemap

**Files:**
- Modify: `web/js/grid.js:1571-1654` (`tryTetrisSplitPack`)
- Modify: `web/js/app.js` — Lineup weight calculation

**Step 1: Add rating-weight support to treemap**

Modify `tryTetrisSplitPack` to accept an optional `weights` parameter. When weights are provided, use them for split proportions:

In the split logic, calculate area proportion by weight:
```javascript
const leftWeight = leftStreams.reduce((sum, s) => sum + (weights?.get(s.id) || 1), 0);
const rightWeight = rightStreams.reduce((sum, s) => sum + (weights?.get(s.id) || 1), 0);
const splitRatio = leftWeight / (leftWeight + rightWeight);
```

**Step 2: Build weight map in Lineup scene entry**

```javascript
case 'lineup':
    applyLineupFilter();
    wallMode = 0;
    window._plexdWallMode = 0;
    tetrisMode = 3;
    // Rating-weighted layout
    const lineupStreams = getFilteredStreams();
    const weights = new Map();
    lineupStreams.forEach(s => {
        const rating = PlexdStream.getRating(s.id) || 0;
        const isFav = PlexdStream.isFavorite(s.id);
        const weight = Math.max(1, (rating - 4) * 0.5) + (isFav ? 0.5 : 0);
        weights.set(s.id, weight);
    });
    window._plexdLineupWeights = weights;
    break;
```

Pass `window._plexdLineupWeights` to the treemap in the layout call path.

**Step 3: Verify & Commit**

```bash
git add web/js/grid.js web/js/app.js
git commit -m "feat: Lineup scene with rating-weighted treemap layout"
```

---

### Task 10: Implement Climax sub-modes

**Files:**
- Modify: `web/js/app.js` — applyClimaxSubMode, auto-rotate, collage layout
- Modify: `web/css/plexd.css` — collage styles

**Step 1: Implement applyClimaxSubMode**

```javascript
function applyClimaxSubMode() {
    stopAutoRotate();
    switch (climaxSubMode) {
        case 0: // Tight Wall
            tetrisMode = 0;
            wallMode = 2;
            window._plexdWallMode = 2;
            break;
        case 1: // Auto-Rotate Hero
            tetrisMode = 0;
            wallMode = 3;
            window._plexdWallMode = 3;
            startAutoRotate();
            break;
        case 2: // Collage
            tetrisMode = 0;
            wallMode = 0;
            window._plexdWallMode = 0;
            break;
        case 3: // Single Focus
            tetrisMode = 0;
            wallMode = 0;
            window._plexdWallMode = 0;
            {
                const target = PlexdStream.getSelectedStream() || getFilteredStreams()[0];
                if (target) PlexdStream.enterFocusedMode(target.id);
            }
            break;
    }
    updateWallModeClasses();
    updateTetrisModeClasses();
    updateModeIndicator();
}
```

**Step 2: Implement auto-rotate**

```javascript
function startAutoRotate() {
    stopAutoRotate();
    autoRotateTimer = setInterval(() => {
        if (!theaterMode || theaterScene !== 'climax' || climaxSubMode !== 1) {
            stopAutoRotate();
            return;
        }
        const streams = getFilteredStreams();
        if (streams.length < 2) return;
        const sel = PlexdStream.getSelectedStream();
        const currentIdx = sel ? streams.findIndex(s => s.id === sel.id) : -1;
        const nextIdx = (currentIdx + 1) % streams.length;
        PlexdStream.selectStream(streams[nextIdx].id);
        stageHeroId = streams[nextIdx].id;
        updateLayout();
    }, AUTO_ROTATE_INTERVAL);
}

function stopAutoRotate() {
    if (autoRotateTimer) {
        clearInterval(autoRotateTimer);
        autoRotateTimer = null;
    }
}
```

**Step 3: Implement collage layout in updateLayout**

Add collage special case in `updateLayout()`:

```javascript
if (theaterMode && theaterScene === 'climax' && climaxSubMode === 2) {
    const cStreams = getFilteredStreams();
    layout.cells = cStreams.map((stream, i) => {
        const angle = (Math.random() - 0.5) * 10;
        const scale = 0.4 + Math.random() * 0.35;
        const x = Math.random() * container.width * 0.5;
        const y = Math.random() * container.height * 0.5;
        return {
            streamId: stream.id,
            x, y,
            width: container.width * scale,
            height: container.height * scale,
            objectFit: 'cover',
            wallCropZoom: 1.5,
            collageRotation: angle,
            collageOpacity: 0.65 + Math.random() * 0.3,
            collageZIndex: cStreams.length - i
        };
    });
}
```

Handle collage properties in the cell-applying loop.

**Step 4: Add CSS**

```css
.theater-climax-collage .plexd-stream {
    border-radius: 4px;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.5);
}
```

**Step 5: Verify & Commit**

```bash
git add web/js/app.js web/css/plexd.css
git commit -m "feat: Climax scene with 4 sub-modes"
```

---

### Task 11: Implement Encore bookmark view

**Files:**
- Modify: `web/js/app.js` — showEncoreView, closeEncoreView
- Modify: `web/css/plexd.css` — Encore overlay styles

**Step 1: Add showEncoreView function**

```javascript
function showEncoreView() {
    let overlay = document.getElementById('encore-overlay');
    if (overlay) overlay.remove();

    if (bookmarks.length === 0) {
        showMessage('No bookmarks yet — press K to bookmark moments', 'info');
        theaterScene = encorePreviousScene || 'casting';
        return;
    }

    overlay = document.createElement('div');
    overlay.id = 'encore-overlay';
    overlay.className = 'plexd-encore-overlay';

    const title = document.createElement('div');
    title.className = 'encore-title';
    title.textContent = 'Encore — ' + bookmarks.length + ' moment' + (bookmarks.length !== 1 ? 's' : '');
    overlay.appendChild(title);

    const grid = document.createElement('div');
    grid.className = 'encore-grid';

    bookmarks.slice().reverse().forEach((bm) => {
        const stream = PlexdStream.getStream(bm.streamId);
        if (!stream) return;

        const card = document.createElement('div');
        card.className = 'encore-card';

        const thumb = document.createElement('video');
        thumb.src = stream.video.src;
        thumb.currentTime = bm.timestamp;
        thumb.muted = true;
        thumb.playsInline = true;
        card.appendChild(thumb);

        const info = document.createElement('div');
        info.className = 'encore-info';
        const m = Math.floor(bm.timestamp / 60);
        const s = Math.floor(bm.timestamp % 60);
        info.textContent = m + ':' + String(s).padStart(2, '0');
        card.appendChild(info);

        card.addEventListener('click', () => {
            closeEncoreView();
            stageHeroId = bm.streamId;
            setTheaterScene('stage');
            const st = PlexdStream.getStream(bm.streamId);
            if (st && st.video) st.video.currentTime = bm.timestamp;
        });

        grid.appendChild(card);
    });

    overlay.appendChild(grid);
    document.querySelector('.plexd-app').appendChild(overlay);
}

function closeEncoreView() {
    const overlay = document.getElementById('encore-overlay');
    if (overlay) overlay.remove();
}
```

**Step 2: Add CSS**

```css
.plexd-encore-overlay {
    position: fixed;
    inset: 0;
    z-index: 500;
    background: rgba(0, 0, 0, 0.92);
    padding: 40px;
    overflow-y: auto;
}

.encore-title {
    font-size: 18px;
    color: #fff;
    margin-bottom: 20px;
    font-weight: 600;
}

.encore-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 12px;
}

.encore-card {
    position: relative;
    aspect-ratio: 16/9;
    border-radius: 6px;
    overflow: hidden;
    cursor: pointer;
    transition: transform 0.15s ease, box-shadow 0.15s ease;
}

.encore-card:hover {
    transform: scale(1.05);
    box-shadow: 0 0 20px rgba(236, 72, 153, 0.5);
}

.encore-card video {
    width: 100%;
    height: 100%;
    object-fit: cover;
}

.encore-info {
    position: absolute;
    bottom: 0;
    left: 0;
    right: 0;
    padding: 4px 8px;
    background: rgba(0, 0, 0, 0.7);
    color: white;
    font-size: 12px;
}
```

**Step 3: Verify & Commit**

```bash
git add web/js/app.js web/css/plexd.css
git commit -m "feat: Encore bookmark system with visual recall grid"
```

---

## Phase 5: Scene Transitions & Polish

### Task 12: Add scene transition animations

**Files:**
- Modify: `web/css/plexd.css` — transition styles
- Modify: `web/js/app.js` — fade-out on Casting to Lineup transition

**Step 1: Add CSS**

```css
.theater-mode .plexd-stream {
    transition: all 0.3s ease;
}

.theater-mode .plexd-stream.fading-out {
    opacity: 0;
    transform: scale(0.95);
    transition: opacity 0.3s ease, transform 0.3s ease;
}
```

**Step 2: Implement fade on Casting to Lineup**

In `setTheaterScene`, when transitioning from casting to lineup:

```javascript
if (prev === 'casting' && scene === 'lineup') {
    const allStreams = PlexdStream.getAllStreams();
    allStreams.forEach(s => {
        if (!PlexdStream.isFavorite(s.id) && (PlexdStream.getRating(s.id) || 0) < 5) {
            if (s.wrapper) s.wrapper.classList.add('fading-out');
        }
    });
    setTimeout(() => {
        theaterScene = scene;
        applyTheaterScene();
        updateModeIndicator();
        allStreams.forEach(s => {
            if (s.wrapper) s.wrapper.classList.remove('fading-out');
        });
    }, 300);
    showMessage(getSceneName(scene), 'info');
    return;
}
```

**Step 3: Verify & Commit**

```bash
git add web/css/plexd.css web/js/app.js
git commit -m "feat: smooth CSS transitions between Theater scenes"
```

---

### Task 13: Update help overlay and remote commands

**Files:**
- Modify: `web/js/app.js` — help overlay HTML, remote handler
- Modify: `web/index.html` — cache bust

**Step 1: Update help overlay**

Add Theater section and update remapped shortcuts in the help overlay HTML.

**Step 2: Add remote command handlers**

```javascript
case 'toggleTheaterAdvanced':
    PlexdApp.toggleTheaterAdvanced();
    sendState();
    break;
case 'nextScene':
    PlexdApp.nextScene();
    sendState();
    break;
case 'prevScene':
    PlexdApp.prevScene();
    sendState();
    break;
```

**Step 3: Bump cache version**

Update `?v=64` to `?v=65` in index.html.

**Step 4: Verify & Commit**

```bash
git add web/js/app.js web/index.html
git commit -m "feat: update help overlay and remote commands for Theater/Advanced"
```

---

### Task 14: Final integration test

**Step 1: Full syntax check**

```bash
node --check server.js && node --check web/js/app.js && node --check web/js/stream.js && node --check web/js/grid.js && node --check web/js/remote.js
```

**Step 2: Browser verification checklist**

```
Theater Mode:
[ ] App starts in Theater mode (Casting Call)
[ ] Mode indicator shows CAST
[ ] All clips edge-to-edge crop, face-detect active
[ ] Q stars clips (golden glow)
[ ] 1-9 rates clips (low-rated dims)
[ ] QQ filters to favorites
[ ] Space -> Lineup (unstarred fade out)
[ ] Lineup treemap, higher-rated bigger
[ ] Space -> Stage (hero + ensemble)
[ ] Left/Right rotates hero, audio follows (if M was pressed)
[ ] Enter on ensemble promotes to hero
[ ] Space -> Climax
[ ] E cycles: Tight Wall > Auto-Rotate > Collage > Single Focus
[ ] Auto-Rotate cycles hero every 15s
[ ] K bookmarks, J opens Encore
[ ] Encore card click jumps to moment
[ ] Escape regresses scenes
[ ] Space-Space random seeks

Advanced Mode:
[ ] Backtick switches to Advanced
[ ] Mode indicator shows T3, W2, etc.
[ ] All existing keys: T, W, O, V, G, [, ], {, }
[ ] Space = play/pause
[ ] E/R = seek, EE/RR = big seek
[ ] Q = star, L = relayout
[ ] XX = remove unstarred
[ ] Backtick returns to Theater

Audio:
[ ] Clips start muted
[ ] M unmutes + follow
[ ] M mutes + stops follow
[ ] N kills all
[ ] Audio follows hero in Stage/Climax

Bugfix:
[ ] Rotate with filter active works correctly
[ ] Shuffle with filter active works correctly
```

**Step 3: Final commit**

```bash
git add -A
git commit -m "chore: final integration verification pass"
```

---

## Summary

| Phase | Tasks | Description |
|-------|-------|-------------|
| Phase 1 | T1-T2 | Rotate bugfix, audio model |
| Phase 2 | T3-T4 | Key remaps (Q, E/R, XX) |
| Phase 3 | T5-T7 | State machine, key routing, mode badge |
| Phase 4 | T8-T11 | Casting Call, Lineup, Climax, Encore |
| Phase 5 | T12-T14 | Transitions, help, integration test |
| **Total** | **14 tasks** | **~14 commits** |

Each phase delivers value independently. Phase 1-2 improve the existing app. Phase 3 adds the skeleton. Phase 4 fills in scenes. Phase 5 polishes.
