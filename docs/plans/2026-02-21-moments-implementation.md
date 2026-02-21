# Moments System Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Transform bookmarks into "Moments" — persistent, range-based sub-clips that become the primary artifact of Plexd, visible across every scene with a dedicated 6-mode browser.

**Architecture:** In-memory moment store with localStorage persistence (Phase 1-4), then server persistence via JSON + SQLite (Phase 6). Moment creation via K key with canvas-diff auto-range detection. Visual integration across all Theater scenes. Moment Browser replaces Encore with 6 view modes.

**Tech Stack:** Vanilla JS/CSS/HTML (client), Node.js (server), SQLite via `better-sqlite3` (server), ffmpeg (extraction), Ollama (optional AI)

**Design Doc:** `docs/plans/2026-02-21-moments-system-design.md`

**Branch:** `feat/moments-system`

---

## Phase 1: Foundation — Moment Data Model & Creation

### Task 1: Moment Store Module

Create the in-memory moment store with localStorage persistence. This replaces the `bookmarks` array (app.js:649).

**Files:**
- Create: `web/js/moments.js`
- Modify: `web/index.html` (add script tag)

**Step 1: Create moments.js with data model and CRUD**

Create `web/js/moments.js` — an IIFE module (same pattern as PlexdStream in stream.js) exposing `PlexdMoments` globally. Must include:

- `createMoment(opts)` — creates moment with ID `m_<timestamp36>_<random>`, fields: sourceUrl, sourceFileId, sourceTitle, streamId, start, end, peak, peakEnd, rating, loved, tags, notes, aiDescription, aiTags, aiEmbedding, thumbnailDataUrl, extracted, extractedPath, sessionId, createdAt, updatedAt, playCount, lastPlayedAt, sortOrder
- `getMoment(id)`, `getAllMoments()`, `getMomentsForSource(url)`, `getMomentsForStream(streamId)`, `getSessionMoments()`
- `updateMoment(id, updates)` — partial merge, updates `updatedAt`
- `deleteMoment(id)` — removes from array
- `recordPlay(id)` — increments playCount, sets lastPlayedAt
- `countForSource(url)`, `countForStream(streamId)`
- `filter(opts)` — filters by sessionId, minRating, loved, sourceUrl, tag, hasPeak
- `sort(arr, by)` — sorts by rating, created, played, playCount, duration, manual
- `reorder(orderedIds)` — sets sortOrder
- `getRandomMoment(pool)` — weighted random (rating^2 + 1)
- `save()` / `load()` — localStorage `plexd_moments` key, strips aiEmbedding from save
- `onUpdate(cb)` — register callback for changes
- `getSessionId()`, `count()`

**Step 2: Add script tag to index.html**

Add `<script src="js/moments.js"></script>` after stream.js, before app.js.

**Step 3: Verify**

Run: `node --check web/js/moments.js` — expect clean parse.

Browser console: `PlexdMoments.count()` returns 0, `PlexdMoments.createMoment({sourceUrl:'test', peak:10, start:5, end:15})` works.

**Step 4: Commit**

```bash
git add web/js/moments.js web/index.html
git commit -m "feat(moments): add PlexdMoments store with CRUD, filtering, and localStorage persistence"
```

---

### Task 2: Upgrade K Key — Create Moments with Thumbnail Capture

Replace the old bookmark creation (app.js:4215-4242) with moment creation. Make K work in both Theater AND Advanced mode (was Theater-only).

**Files:**
- Modify: `web/js/app.js` (lines 649, 4215-4242)

**Step 1: Remove old bookmarks array**

At app.js:649, replace `let bookmarks = [];` with a comment noting migration to PlexdMoments.

**Step 2: Replace K key handler**

At app.js:4215-4242, replace the entire K case block. New behavior:
- Works in both Theater and Advanced mode (remove `if (!theaterMode) break;`)
- Gets target stream from `fullscreenStream || selected`
- Deduplicates by sourceUrl + peak time within 1 second
- Captures thumbnail via `PlexdStream.captureStreamFrame(ts.id)`
- Inherits rating via `PlexdStream.getRating()` and loved via `PlexdStream.isFavorite()`
- Default range: `peak +/- 5 seconds`, clamped to video duration
- Creates moment via `PlexdMoments.createMoment()`
- Shows "Moment captured at X:XX" toast
- Calls `autoDetectRange(moment.id, ts)` if available (Task 3)

**Step 3: Verify propagateKeys**

At stream.js:2202, confirm `kK` are in the propagateKeys regex (they should be from existing bookmark code).

**Step 4: Verify**

Load video, press K in Advanced mode — should create moment. Press K at same position — "Already captured". Console: `PlexdMoments.count()` reflects creation.

**Step 5: Commit**

```bash
git add web/js/app.js
git commit -m "feat(moments): upgrade K key to create Moments with thumbnail, rating, range"
```

---

### Task 3: Canvas Diff Auto-Range Detection

Add Tier 1 smart range detection that runs asynchronously after moment creation.

**Files:**
- Modify: `web/js/app.js` (add autoDetectRange function, ~line 4250)

**Step 1: Add autoDetectRange function**

Creates an offscreen `<video>` probe element (same src as stream), seeks through +/-15s window at 0.5s intervals, uses offscreen canvas (160x90) to capture frames, computes pixel diff between consecutive frames. Detects scene cuts (>30% diff) and stillness (<2% diff). Expands range outward from peak until hitting a boundary. Updates moment's start/end silently via `PlexdMoments.updateMoment()`.

Graceful fallback: if CORS taints the canvas or video can't be probed, keeps the +/-5s default.

**Step 2: Verify**

Load video, press K. Check moment's start/end in console — may differ from +/-5s defaults if scene boundaries were detected.

**Step 3: Commit**

```bash
git add web/js/app.js
git commit -m "feat(moments): add Tier 1 canvas-diff auto-range detection"
```

---

## Phase 2: Visual Integration — Moment Indicators Everywhere

### Task 4: Moment Count Badge on Stream Tiles

Add a gold diamond badge showing moment count to every video tile.

**Files:**
- Modify: `web/js/stream.js` (createStream, ~line 170)
- Modify: `web/css/plexd.css` (badge styles)
- Modify: `web/js/app.js` (updateMomentBadges function + wire to onUpdate)

**Step 1: Add badge DOM element**

In stream.js `createStream()`, after favoriteIndicator creation (~line 170), add a `<div class="plexd-moment-badge">` to the wrapper. Add `momentBadge` to the stream object.

**Step 2: CSS**

`.plexd-moment-badge` — positioned absolute top-right, min-width 22px, border-radius 11px, background `var(--gold)`, color `var(--void)`, font-size 11px, font-weight 700, z-index 5, pointer-events none, box-shadow with gold-glow. Hidden by default (`opacity: 0`), `.has-moments` class sets `opacity: 1`. `::before` pseudo-element shows diamond character.

**Step 3: Update function in app.js**

`updateMomentBadges()` — iterates all streams, queries `PlexdMoments.countForStream()` then falls back to `countForSource()`, updates badge text and visibility. Called from `PlexdMoments.onUpdate()` callback registered in `init()`.

**Step 4: Verify & Commit**

```bash
git add web/js/stream.js web/css/plexd.css web/js/app.js
git commit -m "feat(moments): add gold moment count badges to stream tiles"
```

---

### Task 5: Timeline Moment Dots on Stream Controls

Add gold dots on the seek bar at each moment's peak position.

**Files:**
- Modify: `web/js/stream.js` (createControlsOverlay + new updateMomentDots function)
- Modify: `web/css/plexd.css` (dot styles)

**Step 1: Add dot container**

In `createControlsOverlay()`, add `<div class="plexd-moment-dots">` inside the seek container.

**Step 2: CSS**

`.plexd-moment-dots` — absolute positioned, full width, pointer-events none. `.plexd-moment-dot` — absolute, 4x4px circle, gold background, gold-glow shadow, positioned by `left: X%`.

**Step 3: updateMomentDots function**

New function `updateMomentDots(streamId)` — clears dot container, gets moments for stream, calculates percentage position of each peak, creates dot elements. Export in PlexdStream API.

**Step 4: Wire updates**

In app.js onUpdate callback, iterate streams and call `PlexdStream.updateMomentDots(s.id)`.

**Step 5: Verify & Commit**

```bash
git add web/js/stream.js web/css/plexd.css web/js/app.js
git commit -m "feat(moments): add gold timeline dots on stream seek bars"
```

---

## Phase 3: Moment Browser — Replace Encore

### Task 6: Moment Browser Shell (Replace Encore)

Replace `showEncoreView()` / `closeEncoreView()` with Moment Browser. Grid mode first.

**Files:**
- Modify: `web/js/app.js` (replace lines 2491-2563)
- Modify: `web/css/plexd.css` (new browser styles)

**Step 1: Add momentBrowserState object**

Track: open (bool), mode (0-5), selectedIndex, filterSession ('current'/'all'), filterMinRating, filterLoved, filterSource, sortBy, filteredMoments, reelIndex, reelRepeat.

**Step 2: Replace showEncoreView with showMomentBrowser**

- Closes any existing browser, applies filters via `PlexdMoments.filter()` and sort
- Builds overlay: header (title + count + mode label + filter buttons), content area
- Grid mode: `renderMomentGrid()` creates cards with thumbnail img (or placeholder div), play overlay, info bar (duration, rating, loved icon)
- Uses `textContent` for all text, no innerHTML
- Click handler calls `playMomentInContext(moment)`

**Step 3: Add playMomentInContext**

Finds loaded stream matching moment's sourceUrl or streamId, seeks to peak, selects stream, enters Stage if Theater mode, records play.

**Step 4: Add closeMomentBrowser**

Cleans up videos (pause, clear src, load), removes overlay.

**Step 5: Alias for backward compat**

`var showEncoreView = showMomentBrowser; var closeEncoreView = closeMomentBrowser;`

**Step 6: Add keyboard handler**

In `handleKeyboard()`, early check: if `momentBrowserState.open`, handle Escape/J (close), E/Shift+E (cycle mode), arrows (navigate), Enter (play), Delete/X (remove), / (random), 1-9 (rate), Q (toggle loved). Return to consume all keys when browser open. Place this BEFORE theater scene checks.

**Step 7: Update J key handler**

Make J work in both Theater and Advanced mode. Toggle browser open/closed.

**Step 8: CSS**

Full-screen overlay (fixed inset 0, z-index 160000). Header with flex layout, filter buttons with .active state using accent colors. Grid with auto-fill columns (minmax 180px). Cards with 16:9 aspect ratio, border-radius 8px, hover scale, selected state with gold border. Thumbnail cover-fit, play overlay on hover, info bar gradient at bottom.

**Step 9: Verify & Commit**

```bash
git add web/js/app.js web/css/plexd.css
git commit -m "feat(moments): replace Encore with Moment Browser (Grid mode + keyboard nav)"
```

---

### Task 7: Wall Mode for Moment Browser

**Files:** `web/js/app.js`, `web/css/plexd.css`

Add `renderMomentWall()` — grid of cells, each containing a `<video>` that loops the moment's range (timeupdate handler resets to start when reaching end). Falls back to thumbnail img if source unavailable. Wire into showMomentBrowser mode 1. CSS: grid auto-fill 200px min, 2px gap, cells with cover-fit video.

```bash
git commit -m "feat(moments): add Wall mode — simultaneous looping playback"
```

---

### Task 8: Reel Mode for Moment Browser

**Files:** `web/js/app.js`, `web/css/plexd.css`

Add `renderMomentReel()` — main video area playing current moment (with audio), info overlay, filmstrip at bottom. Space advances, Shift+Space goes back. `advanceReel()` handles next/prev/shuffle. Wire into mode 2. CSS: flex column, video contain-fit, filmstrip flex row with 80x45 thumbs.

```bash
git commit -m "feat(moments): add Reel mode — cinematic playback with filmstrip"
```

---

### Task 9: Discovery Mode

**Files:** `web/js/app.js`, `web/css/plexd.css`

Add `renderMomentDiscovery()` — plays random weighted moment fullscreen. Hint overlay built with DOM methods (createElement/textContent, NOT innerHTML). Space re-renders with new random. Wire into mode 4.

```bash
git commit -m "feat(moments): add Discovery mode — random-first exploration"
```

---

### Task 10: Collage and Cascade Modes

**Files:** `web/js/app.js`, `web/css/plexd.css`

`renderMomentCollage()` (mode 3) — up to 12 thumbnails with random position, rotation (-5 to +5 deg), opacity (0.65-0.95), overlapping. CSS: absolute positioned cells, hover brings to front.

`renderMomentCascade()` (mode 5) — stacked perspective: 4 thumbnails scaled and offset (1.0/0.85/0.70/0.55, offset 60px each). Info on top layer. Arrow keys shift the window through moments.

```bash
git commit -m "feat(moments): add Collage and Cascade modes"
```

---

## Phase 4: Crescendo Playback & Random Everywhere

### Task 11: Crescendo Loop Playback

**Files:** `web/js/app.js`

Add `crescendoState` object (momentId, loopCount, maxLoopsBeforeTighten=2, tightenSteps=3, currentStart/End, targetStart/End).

`setupCrescendo(video, moment)` — if no peakEnd, simple loop. If peakEnd exists, track loop count and progressively interpolate start/end toward peak/peakEnd range after maxLoopsBeforeTighten plays.

Use in Reel mode instead of simple timeupdate loop.

```bash
git commit -m "feat(moments): add crescendo loop — progressive tightening to peak"
```

---

### Task 12: Random Everywhere

**Files:** `web/js/app.js`

Add `Shift+/` in Stage and Advanced mode — jumps to random moment's peak in current hero/selected clip. Shows "Random moment (star)N" toast. Records play.

Ensure `/` in Moment Browser plays random moment (already in Task 6 keyboard handler).

```bash
git commit -m "feat(moments): add random moment jump (Shift+/) everywhere"
```

---

## Phase 5: Stage Moment Timeline Strip

### Task 13: Stage Scene Moment Strip

**Files:** `web/js/app.js`, `web/css/plexd.css`

`updateStageMomentStrip()` — creates fixed strip at bottom of screen showing moment ranges as colored blocks (left/width calculated from start/end as percentage of duration). Peak markers as small gold bars. Click jumps to moment.

`Shift+Arrow` in Stage — jumps to next/prev moment's peak (sorted by peak time).

Called from `applyTheaterScene` case 'stage' and from onUpdate callback.

CSS: fixed bottom, 6px height, gold-glow blocks, gold peak markers, pointer-events auto.

```bash
git commit -m "feat(moments): add Stage moment timeline strip + Shift+Arrow navigation"
```

---

## Phase 6: Server Persistence

### Task 14: Server Moments API

**Files:** `server.js`

Add at top: `MOMENTS_DIR`, `MOMENTS_JSON`, `MOMENTS_THUMBS`, `MOMENTS_EXTRACTED` paths. Create directories. Load `momentsDb` array from JSON.

Add API routes (pathname-based, matching existing server pattern):
- `GET /api/moments` — list with query filters (session, minRating, loved, source), strips thumbnailDataUrl and aiEmbedding
- `POST /api/moments` — upsert (by id). Saves thumbnail as JPEG file if thumbnailDataUrl present
- `GET /api/moments/:id` — single moment
- `PUT /api/moments/:id` — partial update
- `DELETE /api/moments/:id` — delete + cleanup thumbnail/extracted files
- `GET /api/moments/stats` — total, loved, rated, extracted, sessions counts
- `POST /api/moments/reorder` — save sort order
- `GET /api/moments/:id/thumbnail` — serve JPEG thumbnail file

```bash
git commit -m "feat(moments): add server-side moments API with JSON persistence"
```

---

### Task 15: Client-Server Sync

**Files:** `web/js/moments.js`

Add sync logic inside IIFE:
- `syncToServer()` — POST each dirty moment to `/api/moments`
- `loadFromServer()` — GET `/api/moments`, merge with client (server wins for rating/tags, client wins for range)
- 30-second sync interval (same pattern as `saveCurrentStreams`)
- Mark dirty on every `_notifyUpdate` call
- `loadFromServer()` called on module load (after localStorage load)
- Graceful offline: catch fetch errors, retry next cycle

```bash
git commit -m "feat(moments): add client-server sync — 30s interval, offline-first"
```

---

## Phase 7: Extraction (Solidify)

### Task 16: ffmpeg Sub-Clip Extraction

**Files:** `server.js`

Add `POST /api/moments/:id/extract` — finds source file (uploaded file, HLS playlist, or URL). Runs ffmpeg with `-ss <start> -t <duration>` to extract sub-clip. Uses HEVC hardware encoder with software fallback (same pattern as HLS transcoding). Saves to `moments/extracted/<id>.mp4`. Updates moment's `extracted` and `extractedPath` fields.

Add `GET /api/moments/:id/file` — serves extracted MP4 with Content-Type and Content-Length.

```bash
git commit -m "feat(moments): add ffmpeg sub-clip extraction with HEVC + fallback"
```

---

## Phase 8: Audio Analysis (Tier 2)

### Task 17: Audio Level Analysis

**Files:** `web/js/app.js`

`audioAnalyzeRange(momentId, stream)` — creates AudioContext + AnalyserNode from stream video element. Samples frequency data every 100ms during moment range. `processAudioSamples()` finds audio "hot zone" with highest average level using a sliding window. If audio peak differs significantly from visual peak, averages them and updates moment.

Called from `autoDetectRange()` when video is playing.

```bash
git commit -m "feat(moments): add Tier 2 audio level analysis for range refinement"
```

---

## Phase 9: Local LLM Integration

### Task 18: Ollama Detection and AI Analysis

**Files:** `server.js`

`checkOllama()` — probes localhost:11434/api/tags on startup, looks for vision models (llava, bakllava). Sets `ollamaAvailable` flag.

`GET /api/ai/status` — returns availability, model name, provider.

`POST /api/moments/:id/analyze` — reads thumbnail JPEG, sends to Ollama vision model with prompt for description and category tags. Parses response, stores in moment's aiDescription and aiTags.

```bash
git commit -m "feat(moments): add optional local LLM integration via Ollama"
```

---

## Phase 10: Set Integration & Polish

### Task 19: Save Moments with Sets

**Files:** `web/js/app.js`

Update set save logic (search for `plexd_combinations`) to include `momentIds` array. Update set load to note restored moments.

```bash
git commit -m "feat(moments): save moment IDs with sets"
```

---

### Task 20: Documentation and Help

**Files:** `CLAUDE.md`, `web/js/app.js`

Document Moments system in CLAUDE.md. Update help overlay with new keyboard shortcuts (K, J, E in browser, Shift+Arrow in Stage, Shift+/ random moment).

```bash
git commit -m "docs: document Moments system and update help overlay"
```

---

## Verification Checklist

After all tasks:

1. K creates moments in both modes with thumbnail capture
2. Gold badges show moment count on tiles
3. Timeline dots visible on seek bars
4. J opens Moment Browser with 6 modes (E cycles)
5. Grid: thumbnail cards, arrow nav, Enter plays, Delete removes
6. Wall: simultaneous looping playback
7. Reel: cinematic + filmstrip, Space advances
8. Discovery: random weighted moments
9. Collage: overlapping thumbnails
10. Cascade: stacked perspective
11. Crescendo tightens loop toward peak
12. Shift+/ jumps to random moment
13. Stage strip shows moment blocks, click to jump
14. Server persistence survives restart
15. Client syncs to server within 30s
16. Extraction creates standalone MP4
17. AI generates descriptions (if Ollama installed)
18. Set save/load includes moments
