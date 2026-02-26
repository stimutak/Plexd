# Remote Moments Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add moment browsing and triage capabilities to the iPhone remote PWA with Grid and Player modes, rating, filtering, and Mac playback control.

**Architecture:** Bottom tab bar switches between Streams (existing) and Moments (new) contexts. Moments fetched via dedicated `/api/moments` endpoint with lazy thumbnails. Rating/playback commands sent to Mac via existing relay. Built on top of `feat/moments-system` branch (must be merged to main first or work from that branch).

**Tech Stack:** Vanilla JS (IIFE pattern matching `PlexdRemote`), CSS custom properties, existing server relay infrastructure.

**Prerequisites:** The `feat/moments-system` branch must be merged to main before starting. That branch contains `moments.js`, server moment endpoints, and all moment-related app.js code.

**Security note:** Code uses innerHTML for rendering grids/thumbnails, following existing remote.js patterns. All user-facing text (tags, titles) is escaped via `escapeHtml()` helper. Moment data comes from our own server API, not untrusted external sources.

---

## Task 1: Server — Add `?since=` Delta Filter to GET /api/moments

**Files:**
- Modify: `server.js` (worktree: line ~2275, the `GET /api/moments` handler)

**Step 1: Read the existing GET /api/moments handler**

Check the current handler at line ~2275 in the worktree server.js. It loads moments from `uploads/moments/moments.json` and returns the full array.

**Step 2: Add `since` query parameter support**

After loading the moments array, add filtering:

```javascript
// Inside the GET /api/moments handler, after loading moments array:
const sinceParam = url.searchParams.get('since');
if (sinceParam) {
    const sinceTs = parseInt(sinceParam, 10);
    if (!isNaN(sinceTs)) {
        moments = moments.filter(m => (m.updatedAt || m.createdAt || 0) > sinceTs);
    }
}
```

**Step 3: Verify**

```bash
# Start server, then test:
curl 'http://localhost:8080/api/moments' | jq 'length'
curl 'http://localhost:8080/api/moments?since=9999999999999' | jq 'length'
# First should return full count, second should return 0
```

**Step 4: Commit**

```bash
git add server.js
git commit -m "feat(remote): add ?since= delta filter to GET /api/moments"
```

---

## Task 2: Server — Add momentCount and momentLastUpdated to State Relay

**Files:**
- Modify: `web/js/app.js` — `getState()` function (line ~8435)

**Step 1: Read getState() at line 8435**

The function builds a state object sent every 500ms via `/api/remote/state`.

**Step 2: Add moment metadata to state object**

In `getState()`, add two fields to the returned object (after the `timestamp` field at line ~8470):

```javascript
return {
    streams,
    selectedStreamId: selected ? selected.id : null,
    // ... existing fields ...
    timestamp: Date.now(),
    // Moment metadata for remote badge + delta trigger
    momentCount: (typeof PlexdMoments !== 'undefined' && PlexdMoments.count) ? PlexdMoments.count() : 0,
    momentLastUpdated: (typeof PlexdMoments !== 'undefined' && PlexdMoments.getLastUpdated) ? PlexdMoments.getLastUpdated() : 0
};
```

**Step 3: Add `getLastUpdated()` to PlexdMoments if missing**

Check `moments.js` for a `getLastUpdated` function. If it doesn't exist, add it to the public API:

```javascript
// In moments.js, inside the IIFE, add:
function getLastUpdated() {
    var latest = 0;
    for (var i = 0; i < moments.length; i++) {
        var ts = moments[i].updatedAt || moments[i].createdAt || 0;
        if (ts > latest) latest = ts;
    }
    return latest;
}

// Add to the return object:
return {
    // ... existing exports ...
    getLastUpdated: getLastUpdated
};
```

**Step 4: Verify**

Open browser console on Mac app, run:
```javascript
// Should return a number > 0 if moments exist
PlexdMoments.count()
PlexdMoments.getLastUpdated()
```

Check remote state includes new fields:
```bash
curl http://localhost:8080/api/remote/state | jq '{momentCount, momentLastUpdated}'
```

**Step 5: Commit**

```bash
git add web/js/app.js web/js/moments.js
git commit -m "feat(remote): add momentCount/momentLastUpdated to state relay"
```

---

## Task 3: Server — Add Moment Commands to Mac Command Handler

**Files:**
- Modify: `web/js/app.js` — `handleRemoteCommand()` (line ~8216)

**Step 1: Read handleRemoteCommand() at line 8216**

This is a switch statement handling remote commands like `togglePause`, `setRating`, etc.

**Step 2: Add moment command cases**

Add before the `default:` case (after the existing Theater section around line 8420):

```javascript
            // Moments (remote triage)
            case 'playMoment': {
                const mom = PlexdMoments.getMoment(payload.momentId);
                if (mom) {
                    // Find the stream playing this source, or the selected stream
                    const streams = PlexdStream.getAllStreams();
                    let target = streams.find(s => s.url === mom.sourceUrl || s.serverUrl === mom.sourceUrl);
                    if (!target) target = PlexdStream.getSelectedStream();
                    if (target && target.video) {
                        target.video.currentTime = mom.peak || mom.start;
                        target.video.play().catch(() => {});
                        PlexdStream.enterFocusedMode(target.id);
                        PlexdMoments.recordPlay(mom.id);
                    }
                }
                sendState();
                break;
            }
            case 'rateMoment':
                if (payload.momentId && typeof payload.rating === 'number') {
                    PlexdMoments.updateMoment(payload.momentId, { rating: payload.rating });
                }
                sendState();
                break;
            case 'loveMoment':
                if (payload.momentId) {
                    const m = PlexdMoments.getMoment(payload.momentId);
                    if (m) PlexdMoments.updateMoment(payload.momentId, { loved: !m.loved });
                }
                sendState();
                break;
            case 'randomMoment': {
                const pool = PlexdMoments.getAllMoments();
                const pick = PlexdMoments.getRandomMoment(pool);
                if (pick) {
                    handleRemoteCommand('playMoment', { momentId: pick.id });
                    return; // playMoment already calls sendState
                }
                sendState();
                break;
            }
```

**Step 3: Verify**

From browser console or curl, send a test command:
```bash
curl -X POST http://localhost:8080/api/remote/command \
  -H 'Content-Type: application/json' \
  -d '{"action":"playMoment","payload":{"momentId":"SOME_REAL_ID"}}'
```

Check Mac app responds (seeks and enters fullscreen).

**Step 4: Commit**

```bash
git add web/js/app.js
git commit -m "feat(remote): handle moment commands from iPhone remote"
```

---

## Task 4: HTML — Add Tab Bar and Moments Panel Structure

**Files:**
- Modify: `web/remote.html`

**Step 1: Read remote.html**

Review the structure: `<div class="app">` contains `<header>`, `<main>`, sheets, viewer.

**Step 2: Add bottom tab bar**

After the More sheet (`#more-sheet`, line ~241) and before the viewer overlay (`#viewer-overlay`, line ~245), add the tab bar:

```html
            <!-- Tab bar -->
            <nav class="tab-bar" id="tab-bar">
                <button class="tab-btn active" data-tab="streams" id="tab-streams">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4"/></svg>
                    <span>Streams</span>
                </button>
                <button class="tab-btn" data-tab="moments" id="tab-moments">
                    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                    <span>Moments</span>
                    <span class="tab-badge" id="moment-badge"></span>
                </button>
            </nav>
```

**Step 3: Add moments panel inside `<main>`**

After `#remote-ui` (line ~191), add the moments panel (hidden by default). This mirrors the stream view's section structure but with moment-specific IDs and content. The panel includes: hero preview, info section, tags, transport (+-5s), rating strip, filter tabs, thumbnail grid, and mode toolbar.

Key DOM elements to include:
- `#moments-ui` (`.moments-ui.hidden`) — main container
- `#moments-hero-preview` — video preview area with status + position overlay
- `#moments-info` — title + time range + progress bar
- `#moments-tags` — empty container for AI/user tag pills
- `#moments-transport` — 5 transport buttons (prev, -5s, play, +5s, next)
- `#moments-rating-strip` — favorite + clear + rating 1-9 buttons
- `#moments-filter-tabs` — All, fav, unrated, 1-9 filter buttons
- `#moments-grid` — empty container for grid cells or filmstrip
- `#moments-toolbar` — random, shuffle, sort, mode toggle buttons

**Step 4: Verify**

Open `http://localhost:8080/remote.html` in browser. Tab bar should appear (unstyled). Moments panel should be hidden.

**Step 5: Commit**

```bash
git add web/remote.html
git commit -m "feat(remote): add tab bar and moments panel HTML structure"
```

---

## Task 5: CSS — Style Tab Bar

**Files:**
- Modify: `web/css/remote.css`

**Step 1: Read remote.css end section (after utilities)**

**Step 2: Add tab bar styles**

Add before the media queries section (before line ~1225):

```css
/* Tab Bar */
.tab-bar {
    display: flex;
    position: fixed;
    bottom: 0;
    left: 0;
    right: 0;
    height: 48px;
    padding-bottom: var(--safe-bottom);
    background: var(--bg-secondary);
    backdrop-filter: blur(16px) saturate(1.2);
    -webkit-backdrop-filter: blur(16px) saturate(1.2);
    border-top: 1px solid var(--border);
    z-index: 100;
}

.tab-btn {
    flex: 1;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2px;
    background: none;
    border: none;
    color: var(--text-tertiary);
    font-size: 10px;
    font-weight: 500;
    font-family: inherit;
    cursor: pointer;
    transition: color var(--transition-fast);
    position: relative;
    -webkit-tap-highlight-color: transparent;
}

.tab-btn.active {
    color: var(--accent);
}

.tab-btn.active::after {
    content: '';
    position: absolute;
    top: 0;
    left: 25%;
    right: 25%;
    height: 2px;
    background: var(--accent);
    border-radius: 0 0 2px 2px;
}

.tab-badge {
    position: absolute;
    top: 4px;
    right: calc(50% - 24px);
    min-width: 16px;
    height: 16px;
    padding: 0 4px;
    background: var(--accent);
    border-radius: var(--radius-full);
    font-size: 9px;
    font-weight: 700;
    color: white;
    display: flex;
    align-items: center;
    justify-content: center;
    line-height: 1;
}

.tab-badge:empty { display: none; }
```

**Step 3: Adjust main content padding for tab bar**

Modify existing `.main` rule to add bottom padding so content isn't hidden behind the fixed tab bar:

```css
padding-bottom: calc(48px + var(--safe-bottom) + 12px);
```

**Step 4: Verify**

Reload remote.html. Tab bar should be visible, styled, fixed to bottom.

**Step 5: Commit**

```bash
git add web/css/remote.css
git commit -m "feat(remote): style tab bar with fixed bottom positioning"
```

---

## Task 6: CSS — Style Moments Panel

**Files:**
- Modify: `web/css/remote.css`

**Step 1: Add moments-specific styles**

Add after tab bar styles. Key elements to style:

- `.moments-ui` — flex column container with 12px gap
- `.tags-section` — flex-wrap row for tag pills
- `.tag-pill` / `.tag-pill.ai-tag` — small rounded pills (11px font, bg-elevated)
- `.moments-grid` — 3-column CSS grid with 6px gap, max-height 40vh, overflow-y auto
- `.moment-cell` — 16:9 aspect ratio, border 2px transparent, selected = accent border + glow
- `.moment-cell img` — object-fit cover
- `.moment-rating[data-rating="N"]` — color mapped to `var(--rating-N)` for 1-9
- `.moment-loved` — gold heart, absolute top-left
- `.moment-placeholder` — centered rating number or star
- `.moments-filmstrip` — horizontal flex strip (player mode), 80x52px cells
- `.moments-empty` — centered text with star icon

Follow existing remote.css patterns:
- Use `var(--bg-tertiary)` for card backgrounds
- Use `var(--accent)` for selection borders
- Use `var(--radius-sm)` for small border radii
- Use `-webkit-overflow-scrolling: touch` for iOS momentum scroll

**Step 2: Add tablet adjustments in existing `@media (min-width: 768px)` block**

```css
.moments-grid { grid-template-columns: repeat(4, 1fr); }
.moments-filmstrip .moment-cell { width: 96px; height: 64px; }
```

**Step 3: Verify**

Temporarily remove `.hidden` from moments-ui in DevTools. Grid and filmstrip should be properly styled.

**Step 4: Commit**

```bash
git add web/css/remote.css
git commit -m "feat(remote): style moments grid, tags, filmstrip, and empty state"
```

---

## Task 7: JS — Tab Switching Logic

**Files:**
- Modify: `web/js/remote.js`

**Step 1: Add moment state variables**

After existing state variables (around line 37), add variables for: `activeTab`, `moments` array, `momentThumbs` map, `momentFilter`, `momentSort`, `momentMode`, `momentSelectedIndex`, `momentShuffleMode`, `momentLastFetch`, `momentPollInterval`, `momentHls`, `momentVideoUrl`, `momentPlayerHistory`, `momentPlayerHistoryPos`.

**Step 2: Cache new DOM elements**

In `cacheElements()`, cache all `#tab-*`, `#moment-badge`, `#moments-*` elements.

**Step 3: Add `switchTab(tab)` function**

Toggles `.hidden` on `#remote-ui` and `#moments-ui`, toggles `.active` on tab buttons, starts/stops moment polling.

**Step 4: Add tab click handlers in `setupEventListeners()`**

**Step 5: Update badge in `handleStateUpdate()` / `render()`**

Read `state.momentCount` and set badge text content.

**Step 6: Verify**

Tab switching works, panels show/hide, badge updates.

**Step 7: Commit**

```bash
git add web/js/remote.js
git commit -m "feat(remote): add tab switching with moment state variables"
```

---

## Task 8: JS — Fetch Moments and Render Grid

**Files:**
- Modify: `web/js/remote.js`

**Step 1: Add `fetchMoments(since?)` async function**

Calls `GET /api/moments` (or `?since=`). On delta, merges by ID. Stores in `moments` array. Calls `renderMoments()`.

**Step 2: Add polling functions**

`startMomentPolling()` — 10s interval, checks `state.momentLastUpdated > momentLastFetch`.
`stopMomentPolling()` — clears interval.

**Step 3: Add `getFilteredMoments()` function**

Filters by `momentFilter` (all/fav/rating), sorts by `momentSort` (created/rating/played/duration/random).

**Step 4: Add `renderMoments()` function**

Dispatches to `renderMomentGrid()` or `renderMomentPlayer()` based on `momentMode`. Updates info, rating, position.

**Step 5: Add `renderMomentGrid(filtered)` function**

Builds 3-column grid of `.moment-cell` divs with thumbnail images, rating badges, loved hearts. Triggers lazy thumbnail loading.

**Step 6: Add `renderMomentPlayer(filtered)` function**

Builds horizontal filmstrip of `.moment-cell` divs. Auto-scrolls to selected.

**Step 7: Add `loadMomentThumb(momentId)` async function**

Fetches `/api/moments/:id/thumb.jpg`, creates blob URL, caches in `momentThumbs`, updates visible cell.

**Step 8: Verify**

Switch to Moments tab. Grid populates with cells. Thumbnails lazy-load.

**Step 9: Commit**

```bash
git add web/js/remote.js
git commit -m "feat(remote): moment fetching, filtering, sorting, and grid rendering"
```

---

## Task 9: JS — Moment Info, Tags, and Rating Display

**Files:**
- Modify: `web/js/remote.js`

**Step 1: Add `renderMomentInfo(moment)` function**

Sets title (source name), time range (start-end), renders tag pills (AI tags with `.ai-tag` class, user tags plain).

**Step 2: Add `renderMomentRating(moment)` function**

Toggles `.active` on favorite button and rating buttons (same pattern as existing stream rating rendering).

**Step 3: Add `renderMomentFilterTabs()` function**

Updates `.active` class and count badges on filter tab buttons.

**Step 4: Add `escapeHtml(str)` helper**

Creates a div, sets textContent, reads back innerHTML. Prevents XSS from tag names.

**Step 5: Verify**

Select a moment. Info shows source name + range. Tags show as pills. Rating buttons highlight.

**Step 6: Commit**

```bash
git add web/js/remote.js
git commit -m "feat(remote): moment info, tags, and rating display"
```

---

## Task 10: JS — Moment Interactions (Grid Tap, Rating, Filter, Transport)

**Files:**
- Modify: `web/js/remote.js`

**Step 1: Add grid click handler**

Event delegation on `#moments-grid`. First tap selects (updates `momentSelectedIndex`), second tap plays (sends `playMoment` command).

**Step 2: Add moment rating handlers**

Favorite button: sends `loveMoment`, optimistic toggle. Rating 1-9: sends `rateMoment`, optimistic update, bounce animation.

**Step 3: Add filter tab handler**

Click handler on `#moments-filter-tabs`. Updates `momentFilter`, resets index, re-renders.

**Step 4: Add transport handlers**

- Prev/Next: navigate `momentSelectedIndex`, send `playMoment`
- Back/Forward: send `seekRelative` with +-5 offset
- Play: send `playMoment` for selected
- Random: send `randomMoment`
- Shuffle toggle: flip `momentShuffleMode`, toggle `.active` class
- Sort cycle: rotate through sort options, update label text, re-render
- Mode toggle: flip `momentMode` grid/player, update label, re-render

**Step 5: Verify**

Test all interactions: grid tap, rating, filters, transport, sort, mode toggle.

**Step 6: Commit**

```bash
git add web/js/remote.js
git commit -m "feat(remote): moment interactions — grid tap, rating, filter, transport"
```

---

## Task 11: JS — Hero Tap Zones and Swipe Gestures for Moments

**Files:**
- Modify: `web/js/remote.js`

**Step 1: Add moment hero gesture handler**

Attach touch handlers to `#moments-hero-preview`. Follow existing stream hero gesture pattern:
- Track `startX`/`startY` on touchstart
- Detect swipe vs tap on touchend (threshold: 60px horizontal, must exceed vertical)
- Swipe left/right: navigate moments
- Tap zones: top=random, bottom=mode toggle, left=prev, center=play, right=next
- Add `.swiping-left`/`.swiping-right` classes during swipe for visual feedback

**Step 2: Verify on phone**

Swipe and tap zones work correctly on touch device.

**Step 3: Commit**

```bash
git add web/js/remote.js
git commit -m "feat(remote): moment hero tap zones and swipe gesture navigation"
```

---

## Task 12: JS — Moment Hero Video Preview Sync

**Files:**
- Modify: `web/js/remote.js`

**Step 1: Add `updateMomentHeroVideo()` function**

Loads source video URL into moments hero video element using existing `loadVideo()` helper. Seeks to moment peak. Only reloads on URL change.

**Step 2: Add `updateMomentHeroPosition()` function**

Updates position indicator text (e.g., "7 / 42").

**Step 3: Call both from `renderMoments()`**

**Step 4: Add timeupdate listener on moments hero video**

Calculate progress as `(currentTime - start) / (end - start)` and update fill width + thumb position.

**Step 5: Verify**

Hero video loads for selected moment. Progress bar tracks within moment range.

**Step 6: Commit**

```bash
git add web/js/remote.js
git commit -m "feat(remote): moment hero video preview with range-clamped progress"
```

---

## Task 13: Integration Testing and Polish

**Files:**
- All modified files

**Step 1: Full flow test**

1. Start server, open Mac app, create moments with K key
2. Open remote, switch to Moments tab
3. Verify: grid loads, thumbnails appear, rating works, filters work
4. Verify: tap plays on Mac, hero syncs on phone
5. Verify: swipe navigation, player mode, sort cycling
6. Verify: badge count updates when new moments created on Mac

**Step 2: iPhone test**

Open on actual iPhone (same WiFi). Check:
- Haptic feedback, hero video loads, swipe gestures
- No layout overflow, tab bar doesn't overlap content
- Safe area insets (notch) handled

**Step 3: Fix any issues found**

**Step 4: Commit**

```bash
git add -A
git commit -m "fix(remote): integration polish for moments triage"
```

---

## Task Summary

| Task | What | Files |
|------|------|-------|
| 1 | Server: `?since=` delta filter | server.js |
| 2 | State relay: momentCount/LastUpdated | app.js, moments.js |
| 3 | Mac command handler: moment commands | app.js |
| 4 | HTML: tab bar + moments panel structure | remote.html |
| 5 | CSS: tab bar styles | remote.css |
| 6 | CSS: moments panel styles | remote.css |
| 7 | JS: tab switching + state variables | remote.js |
| 8 | JS: fetch, filter, sort, grid render | remote.js |
| 9 | JS: info, tags, rating display | remote.js |
| 10 | JS: interactions (tap, rate, filter, transport) | remote.js |
| 11 | JS: hero tap zones + swipe gestures | remote.js |
| 12 | JS: hero video preview + progress sync | remote.js |
| 13 | Integration testing + polish | all |
