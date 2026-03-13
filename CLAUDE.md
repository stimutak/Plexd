# CLAUDE.md - Plexd Project Guidelines

## Project Overview

**Plexd** is a multiplex video stream display system that enables simultaneous playback of multiple video streams in a single application window. The system features intelligent grid layout that maximizes video display area while minimizing wasted space.

## Core Principles

### Code Quality Standards

1. **No Duplicate Files** - Every file must serve a unique purpose. Before creating a new file, verify no existing file serves the same function.

2. **No Duplicate Functions** - Each function must be singular in purpose. Search the codebase before writing new functions to ensure no equivalent exists.

3. **Fix, Don't Rewrite** - When encountering broken or suboptimal code:
   - First attempt to fix the existing implementation
   - Do NOT default to creating a new "enhanced" or "v2" method
   - Refactor in place when improvements are needed
   - Only create new implementations when the existing approach is fundamentally flawed

4. **No Rogue AI Thought** - All code must be:
   - Sensible and well-reasoned
   - Well-documented with clear intent
   - Efficient in both time and space complexity
   - Fast in execution
   - Based on established patterns, not experimental whims

### Development Guidelines

- **Simplicity First**: Choose the simplest solution that meets requirements
- **Performance Matters**: Video playback is resource-intensive; optimize for efficiency
- **Test Before Commit**: Verify changes work across target platforms
- **Clear Naming**: Use descriptive, unambiguous names for all identifiers
- **Single Responsibility**: Each module/function does one thing well

### Server Management

**ALWAYS use `./scripts/start-server.sh` to start the Plexd server.** Never run `node server.js &` directly — this causes zombie processes that accumulate and fight over the port, causing intermittent request failures.

The script:
1. Kills ALL existing processes on port 8080 (with force-kill fallback)
2. Waits for the port to be fully free
3. Starts a single server instance (which auto-starts Skier AI servers)
4. Verifies the server responds and reports AI model availability

```bash
./scripts/start-server.sh     # Start/restart server (safe to run anytime)
tail -f /tmp/plexd-server.log # Watch server logs
```

## Architecture

### Web Application (Primary)
- Vanilla HTML5/CSS3/JavaScript for maximum compatibility and performance
- No heavy frameworks unless absolutely necessary
- HTML5 Video API for stream playback
- CSS Grid/Flexbox for smart layout management

### iOS Application (Future)
- SwiftUI for modern iPad interface
- AVFoundation for video playback
- Consideration for QuickTime compatibility

## Smart Grid Layout Rules

1. Maximize video display area
2. Minimize black bars and letterboxing
3. Minimize gaps between video windows
4. Adapt dynamically to:
   - Screen/container dimensions
   - Number of active streams
   - Individual video aspect ratios
5. Prioritize uniform appearance when possible

## File Structure

```
Plexd/
├── CLAUDE.md           # This file - AI guidelines
├── README.md           # Project documentation
├── server.js           # Node server: remote relay, file storage, HLS transcode, CORS proxy, download
├── uploads/            # Server-side video storage (gitignored)
│   ├── hls/            # HLS transcoded segments
│   └── metadata.json   # File metadata
├── scripts/
│   ├── start-server.sh # ALWAYS use this to start the server (kills old, starts new, verifies)
│   ├── autostart.sh    # MBP autostart with Chrome debugging
│   └── chrome-test.js  # Chrome remote debugging test runner
├── web/                # Web application
│   ├── index.html      # Main entry point
│   ├── remote.html     # iPhone remote PWA
│   ├── hls-manager.html # HLS transcode management UI
│   ├── manifest.json   # PWA manifest
│   ├── sw.js           # Service worker for offline
│   ├── css/
│   │   ├── plexd.css   # Main app styles
│   │   └── remote.css  # Remote styles
│   ├── js/
│   │   ├── grid.js     # Smart grid layout algorithm
│   │   ├── stream.js   # Stream management, HLS proxy, controls overlay
│   │   ├── app.js      # Main app logic, downloads, history, session save
│   │   └── remote.js   # Remote control logic
│   └── assets/         # Icons, images
├── extension/          # Chrome extension (Manifest V3)
│   ├── manifest.json   # Extension config (host_permissions: <all_urls>)
│   ├── popup.html      # Extension popup UI
│   ├── popup.js        # Send/queue to Plexd via /api/remote/command
│   ├── content.js      # Video/stream detection on pages
│   └── background.js   # Network request interception (.m3u8, .mpd)
├── .chrome-profile/    # Persistent Chrome profile (gitignored)
├── ios/                # iOS application (future)
└── docs/               # Additional documentation
```

## iPhone Remote (PWA)

The remote (`/remote.html`) is a Progressive Web App that serves **three purposes**:

1. **Control Surface** - Send commands to the Mac app (play, pause, seek, etc.)
2. **Second Viewer** - Watch video on your phone (synced with Mac playback)
3. **Triage Tool** - Filter streams by rating, quickly rate and review content

### Design Principles
1. **Hero always visible** - Live video preview with tap zones for fast actions
2. **Always-visible rating** - Assign ratings without mode switching
3. **Filter by rating** - Filter tabs (All, ☆, 1-9) to show only specific ratings
4. **Fast triage workflow** - Single-tap zones for quick random/seek/play
5. **Progressive disclosure** - Advanced features in "More" sheet

### Architecture
- **PWA**: manifest.json + service worker for "Add to Home Screen"
- **Server relay**: Commands/state sent via `/api/remote/*` endpoints
- **Video sync**: Phone video syncs position/play state with Mac (within 2s tolerance)
- **Server file storage**: Local files auto-upload to server for cross-device playback

### Layout (Top to Bottom)
```
┌─────────────────────────────────────┐
│  [Audio]     Plexd     [●]          │  Header
├─────────────────────────────────────┤
│         Video Preview               │  Hero (tap zones, swipe=navigate)
│           ← 3 / 12 →                │  Position indicator
├─────────────────────────────────────┤
│  Title                    1:23/4:56 │  Info
│  ═══════════════●─────────────────  │  Progress
├─────────────────────────────────────┤
│   [|◀]  [-30]  [▶||]  [+30]  [▶|]  │  Transport
├─────────────────────────────────────┤
│  [✕][1][2][3][4][5][6][7][8][9]    │  Rating (assign)
├─────────────────────────────────────┤
│  [All][☆][1][2][3][4][5][6][7][8][9]│  Filter tabs (filter by rating)
├─────────────────────────────────────┤
│  [thumb][thumb][thumb]...           │  Thumbnails (filtered)
├─────────────────────────────────────┤
│  [Random]              [More]       │  Quick actions
└─────────────────────────────────────┘
```

### Hero Tap Zones (Single Tap)
```
+------------------+
|   TOP: Random    |  ← top third
+------+----+------+
| LEFT |PLAY| RIGHT|  ← middle third (left/center/right)
| -30s |    | +30s |
+------+----+------+
| BTM: Focus Toggle|  ← bottom third
+------------------+
```
All zones are single-tap. No double-tap required.

### Gestures
- **Swipe left/right**: Navigate to next/previous stream
- **Viewer swipe down**: Exit viewer

### More Sheet Options
- Stream Audio (toggle mute)
- Mute All / Pause All / Random All
- Clean Mode / Tetris Mode
- Fullscreen Viewer

### Server File Storage
- Files upload to `uploads/` when dropped (checked by name+size to avoid duplicates)
- Files tied to saved sets persist; unsaved auto-delete after 24h
- Purge via "Files" button in Sets panel or `/api/files/purge`

### HLS Transcoding
- Transcoding starts **paused** — must be started via Files modal (D→F→Start) or `POST /api/hls/start`
- Uses **HEVC** (H.265) via `hevc_videotoolbox` (Apple Silicon hardware) with `libx265` fallback
- `-tag:v hvc1` required for Safari/iPhone HEVC HLS compatibility
- HEVC produces ~40-50% smaller files than H.264 at equivalent quality
- Target devices: Apple Silicon, iPhone, high-spec Win11 (all have hardware HEVC decode)
- Queue system limits to 4 concurrent transcodes (configurable: `MAX_CONCURRENT_TRANSCODES`)
- Original files auto-deleted after successful transcode
- Client polls `/api/files/transcode-status` and swaps to HLS URL when ready
- Disk space checked before transcoding (min 500MB required)

### HLS CORS Proxy
- Server-side proxy at `/api/proxy/hls?url=<encoded-url>` for external HLS streams
- `fetchUrl()` helper follows redirects (up to 5), sets User-Agent header
- `rewriteM3u8()` rewrites all URLs in m3u8 manifests (segment refs + `URI=` in `#EXT-X-KEY` etc.) to route through proxy
- Manifests detected by URL (`.m3u8`) or Content-Type (`mpegurl`)
- Segments streamed as binary passthrough with `Content-Length` preserved
- `stream.js` stores both `url` (original, for display/save) and `sourceUrl` (proxied, for playback)
- `getProxiedHlsUrl(url)` skips proxying for localhost/same-host URLs

### HLS-to-MP4 Download
- Endpoint: `GET /api/proxy/hls/download?url=<encoded-url>&name=<filename>`
- Uses `ffmpeg -c copy -bsf:a aac_adtstoasc -movflags frag_keyframe+empty_moov -f mp4 pipe:1`
- `-bsf:a aac_adtstoasc`: Required — HLS uses ADTS-wrapped AAC, MP4 needs ASC format
- `-movflags frag_keyframe+empty_moov`: Enables streaming to stdout without seeking
- `-user_agent`: Browser User-Agent string to avoid CDN blocks
- Backpressure handling: pauses ffmpeg stdout when response buffer is full
- Logs file size on completion for diagnostics

### Session Auto-Save
- `saveCurrentStreams()` saves to `localStorage['plexd_streams']`
- Uses `s.serverUrl || s.url` (prefers server URL over ephemeral blob URLs)
- Deduplicates by URL key and fileId
- Triggered on: `addStream()`, `beforeunload`, 30-second interval
- `addStreamSilent()` used for restoring (no history, no messages)

### Chrome Extension
- Uses server relay (`POST /api/remote/command`) with `{ action, payload, timestamp }` format
- Health check: `GET /api/remote/state` with 3-second timeout
- `host_permissions: ["<all_urls>"]` for cross-origin fetch to Plexd server
- Auto-loaded via `--load-extension` in autostart script and Plexd Chrome app

### xfill / Demo Streams

One-click button that fills the grid with random premium video streams. Toolbar button calls `PlexdApp.xfill()` → `GET /api/demo/streams?count=16&source=brazzers`.

**Sources:** `?source=brazzers` (premium, requires login), `?source=reptyle` (Paper Street Media), or `?source=xhamster` (free scraping). `auto` prefers Aylo if auth is valid, includes Reptyle when available.

**Brazzers/Aylo Integration:**
- Auth via Chrome cookie decryption from `.chrome-profile/Default/Cookies`
- Tokens: `access_token_ma` (~1hr JWT), `refresh_token_ma`, `instance_token` (~2 days), `app_session_id` (UUID)
- Cookie decryption: macOS Keychain → PBKDF2 (salt="saltysalt", 1003 iters, 16 bytes) → AES-128-CBC (IV=0x20×16), strip "v10" 3-byte prefix
- **CRITICAL: Aylo API requires raw JWT on `Authorization` header — NO "Bearer" prefix.** Adding "Bearer" causes 401 on `/v1/self` and `isMemberUnlocked: false` on all scenes
- Required headers: `Authorization` (raw JWT), `Instance` (instance JWT), `X-APP-SESSION-ID` (UUID cookie), `X-Forwarded-For` (external IP via api.ipify.org)
- API: `site-api.project1service.com`, sort syntax uses hyphen prefix (`orderBy=-dateReleased` for descending)
- `videos.full.files` is an array: `[{type: "hls"|"http", format: "2160p"|"1080p"|..., urls: {view}, codec: "av1"|"h264", sizeBytes}]`
- `extractBestVideoUrl()` picks highest-resolution HLS entry (up to 4K/2160p AV1)
- Signed HLS URLs expire (~24hr): `master.m3u8?validto=...&ip=...&hash=...`
- Streams route through `/api/proxy/hls` for CORS (manifest URL rewriting)

**Reptyle (Paper Street Media) Integration:**
- Auth via Chrome cookie decryption: `refresh_token` (~30 days) exchanged for `access_token` (~30 min) via `POST auth.reptyle.com/oauth/refresh`
- Uses standard `Bearer {token}` auth (unlike Aylo's raw JWT)
- Two API systems: ElasticSearch (`ma-store.reptyle.com/ts_index/_search`) for content discovery, REST (`api2.reptyle.com/api/v1`) for playback
- Watch response: `{status, data: {stream, stream2: {av1, vp9, avc}, stream3}}` — streams in `data`
- `extractBestReptyleUrl()` priority: `stream2.av1.hls` > `stream2.vp9.hls` > `stream2.avc.hls` > `stream` (legacy)
- HLS via CacheFly CDN, routes through `/api/proxy/hls` for CORS
- Tags are plain strings (no IDs) — hashed via `reptyleStringHash()` + `REPTYLE_TAG_OFFSET` (200000)
- Actors discovered via ES `type:models` query, offset with `REPTYLE_ACTOR_OFFSET` (200000)
- ID ranges: Aylo `1-99999`, Stash `100000-199999`, Reptyle `200000+`, Network IDs: Reptyle `-2000`

**Key endpoints:**
- `GET /api/demo/streams?count=16&source=brazzers` — Fetch random premium scenes
- `GET /api/demo/streams?source=reptyle&count=9` — Fetch Reptyle scenes
- `GET /api/demo/auth-status` — Check Aylo + Reptyle + Stash login status

**Key functions (server.js):**
- `getBrazzersAuth()` — Read/decrypt Chrome cookies, refresh if expired
- `fetchBrazzersApi(apiPath, auth)` — API call with correct Aylo headers
- `scrapeBrazzersScenes(count, auth)` — Fetch random scene listings, extract HLS URLs
- `extractBestVideoUrl(files)` — Pick highest quality from files array
- `getExternalIp()` — Cached external IP for X-Forwarded-For
- `getReptyleAuth()` — OAuth token refresh from Chrome cookies
- `fetchReptyleElastic(path, auth, body)` — ElasticSearch queries for content discovery
- `fetchReptyleApi(path, auth)` — REST API for playback URLs
- `scrapeReptyleScenes(count, auth, tagNames, actorIds)` — ES discovery + watch URL extraction
- `refreshReptyleTagsFromApi(auth)` — Cache tags (from /tags API or ES fallback)
- `refreshReptyleActorsFromApi(auth)` — Cache performers from ES models index

## Prohibited Practices

- Creating duplicate utility files (e.g., `utils.js` AND `helpers.js`)
- Writing wrapper functions that just call another function
- Adding "improved" versions of existing functions (fix the original)
- Over-engineering simple solutions
- Adding dependencies without clear justification
- Speculative features not in current requirements
- **Transitioning layout properties in CSS** (`left`, `top`, `width`, `height`) — these trigger expensive reflows on every frame. Use `transform` and `opacity` only for animations/transitions (GPU-composited, no reflow)

## When Adding New Code

1. Search existing codebase for similar functionality
2. If found, extend or fix existing code
3. If not found, add in the most logical existing file
4. Only create new files for genuinely new domains
5. Document the "why" not just the "what"

## Performance Targets

- Support minimum 4 simultaneous streams on modern hardware
- Target 8+ streams on capable devices
- Sub-100ms layout recalculation
- Smooth playback without frame drops
- Minimal memory footprint per stream
- CSS transitions must use GPU-composited properties only (`opacity`, `transform`) — never animate `left`/`top`/`width`/`height`

## Browser/Platform Support

### Web
- Modern browsers (Chrome, Firefox, Safari, Edge)
- iPad Safari (primary mobile target)
- Responsive from tablet to desktop

### iOS Native (Future)
- iPadOS 15+
- iPhone support optional/secondary

---

## Multi-Agent Development Environment

This project uses a Boris Cherny-inspired multi-agent workflow for efficient development.

### Philosophy

1. **Parallel beats Sequential** - Run multiple agents simultaneously
2. **Specialization beats Generalization** - Each agent focuses on one concern
3. **Verification is Critical** - Always give Claude a way to verify its work
4. **Two-Phase Loop** - Initial review + challenger phase filters false positives
5. **Shared Knowledge** - Update CLAUDE.md when mistakes are discovered

### Available Subagents (`.claude/agents/`)

| Agent | Purpose |
|-------|---------|
| `code-reviewer` | Quality, security, and maintainability reviews |
| `bug-finder` | Finds bugs, edge cases, and failure modes |
| `style-checker` | Style guide compliance checking |
| `verifier` | End-to-end verification and testing |
| `code-simplifier` | Removes unnecessary complexity post-implementation |
| `verification-challenger` | Filters false positives from other agents |
| `planner` | Creates detailed implementation plans |
| `parallel-coordinator` | Orchestrates multi-agent workflows |

### Slash Commands (`.claude/commands/`)

| Command | Purpose |
|---------|---------|
| `/commit-push-pr` | Full workflow: commit, push, create PR |
| `/review` | Multi-agent code review |
| `/verify` | Run verification loop |
| `/two-phase-review` | Initial review + challenge loop |
| `/simplify` | Simplify code after implementation |
| `/plan` | Enter planning mode for complex tasks |
| `/parallel-review` | Real-time strategy mode parallel review |
| `/shared-knowledge` | Update CLAUDE.md with learnings |
| `/test-and-commit` | Parallel verify, then commit if passing |

### Skills (`.claude/skills/`)

| Skill | Purpose |
|-------|---------|
| `/verify-app` | End-to-end app verification (syntax, server, browser) |
| `/retrospective` | Extract session learnings, update CLAUDE.md |
| `/perf-audit` | Performance audit for video streaming |

**Full guide**: See `docs/multi-agent-workflow.md` for comprehensive documentation.

### Two-Phase Review Loop

The signature technique for high-quality code review:

```
Phase 1: Fan-Out (Parallel)
├── code-reviewer    → Quality findings
├── bug-finder       → Bug findings
├── style-checker    → Style findings
└── verifier         → Verification findings

Phase 2: Challenge (Filter)
└── verification-challenger → Confirms real issues, removes false positives
```

This typically filters 20-40% of findings as false positives.

### Verification Loop Pattern

The most important practice for quality results:

```
Write Code → Verify → Fix Issues → Re-verify → Done
```

Always provide Claude a way to verify its work (tests, build, lint, manual testing).

### Shared Knowledge Pattern

When Claude makes a mistake:
1. Fix the immediate issue
2. Update CLAUDE.md with a new rule
3. Commit the rule so future sessions benefit

Example: "Always search with Grep before creating utility functions"

### Recommended Workflows

**For New Features:**
1. `/plan` - Create implementation plan
2. Implement the feature
3. `/verify` - Run verification loop
4. `/simplify` - Remove unnecessary complexity
5. `/two-phase-review` - Full review
6. `/commit-push-pr` - Ship it

**For Bug Fixes:**
1. Investigate and fix
2. `/verify` - Confirm fix works
3. `/review` - Quick review
4. `/commit-push-pr` - Ship it

**For Code Quality:**
1. `/parallel-review` - Comprehensive review
2. Fix confirmed issues
3. `/shared-knowledge` - Document learnings

---

## Technical Knowledge

### Keyboard Event Handling in Fullscreen

**Critical Pattern:** In true fullscreen mode, keyboard events need special handling:

1. **stream.js `propagateKeys`** - Keys that need app-level handling must be in this regex. They get dispatched to document via synthetic event. **CRITICAL: Every new key binding added to app.js `handleKeyboard()` MUST also be added to the `propagateKeys` regex in stream.js, or that key will be dead in true fullscreen mode.** This was the #1 bug source in the Theater mode implementation (3 critical bugs from missing keys).

2. **Capture-phase handlers** - Use `addEventListener(..., true)` for highest priority. Essential for Bug Eye/Mosaic to close before fullscreen exit.

3. **Browser Escape behavior** - Cannot be overridden. Browser exits fullscreen synchronously BEFORE any JS handler runs. Design around this (overlay stays visible, second Escape closes it).

4. **forceOff pattern** - Toggle functions that can be called from multiple places should use:
   ```javascript
   function toggleMode(forceOff = false) {
       if (forceOff || modeIsOn) { /* turn off */ return; }
       /* turn on */
   }
   ```

### DOM Append Pattern for Fullscreen Visibility

**CRITICAL:** `.plexd-app` is the fullscreen element (not individual streams). In true fullscreen, only `.plexd-app` and its descendants are visible. Elements appended to `document.body` are **invisible** in fullscreen.

**Rule:** All user-visible overlays, modals, toasts, and panels MUST be appended to `.plexd-app`:
```javascript
(document.querySelector('.plexd-app') || document.body).appendChild(element);
```

**Why not `document.fullscreenElement`?** Using `.plexd-app` directly is simpler and always correct — it's the fullscreen element when fullscreen, and a normal container when not. No need for fullscreenchange re-parenting handlers.

**Exceptions** (OK on `document.body`):
- Hidden utility elements (extracted video elements with `opacity: 0`)
- Temporary download anchor tags
- Focus warning (only relevant when keyboard focus is lost, not in fullscreen)

### Double-Tap Pattern

Use the shared `handleDoubleTap(key, onSingle, onDouble)` helper in app.js for any key that needs single/double-tap differentiation. **Do NOT create new `lastXTime`/`xTimeout` state variables** — the helper manages state internally via `_dtState`.

```javascript
handleDoubleTap('q', function() {
    // Single tap (fires after 300ms delay)
    // IMPORTANT: Query fresh state here, not in enclosing scope
    var target = PlexdStream.getSelectedStream();
    if (target) PlexdStream.toggleFavorite(target.id);
}, function() {
    // Double tap (fires immediately on second tap)
    setViewMode('favorites');
});
```

**Key rule:** Variable captures (like `selected`, `fullscreenStream`) must happen INSIDE the callbacks, not before `handleDoubleTap()`, because the single-tap callback fires 300ms later.

### Stream API Return Types

- `PlexdStream.getFullscreenStream()` → returns a **stream object** (with `.id`, `.url`, `.video`), NOT a string ID
- `PlexdStream.getSelectedStream()` → returns a **stream object** or `null`
- `PlexdStream.getAllStreams()` → returns array of stream objects (includes hidden streams!)
- `getFilteredStreams()` → returns array of visible, mode-filtered streams (excludes hidden)

**Common mistake:** Passing a stream object where a string ID is expected (e.g., `getPrevStreamId()`, `getNextStreamId()`). Always use `.id` when calling ID-based functions.

### State Variable Tracking

When creating overlay modes (Bug Eye, Mosaic), track:
- `xxxMode` - boolean for mode state
- `xxxStreamId` - which stream is displayed (for update detection)
- `xxxOverlay` - DOM element reference

### Panel Keyboard Navigation Pattern

For panels with selectable items:
1. Track `selectedIndex` state
2. Handle Arrow keys to change index
3. Handle Enter to activate selection
4. Reset index when panel opens/closes
5. Call navigation handler early in main `handleKeyboard()`

### Moments System

**Architecture:** Offline-first with server sync. localStorage is the source of truth, with 30-second dirty-checking sync to the server (`/api/moments/sync`). Thumbnails stored as JPEG files on disk.

**Key globals:**
- `PlexdMoments` — Data store IIFE (moments.js). CRUD + filter/sort/reorder + server sync.
- `momentBrowserState` — UI state object in app.js. Tracks open/mode/selectedIndex/filters/sort.

**Moment Browser modes (4):** Grid, Wall, Player, Collage. Cycled with E/Shift+E or Tab/Shift+Tab.

**Canvas mirror pattern:** Moments play by mirroring already-loaded `<video>` elements onto `<canvas>` via rAF loop — zero extra network connections. Each mode manages its own rAF loop and MUST clean up via `stop*Mirrors()` on mode switch or browser close.

**Key bindings:**
- `K` — Capture moment from selected/fullscreen stream (peak ±60s = 2 min default)
- `Shift+K` — Capture from ALL visible streams
- `J` — Toggle Moment Browser overlay
- `E` / `Shift+E` — Cycle browser modes (also Tab/Shift+Tab)
- `/` — Random moment in browser
- `W` — Open selected moment in Wall edit mode

**Set integration:** Saved sets (`plexd_combinations`) include `momentIds` array linking to associated moments.

**Wall Editing (Wall mode = mode 1):**
- Each Wall cell has a timeline bar (`wall-timeline`) showing the moment's range within the source video duration
- Selected cell gets 8px interactive bar with drag handles for in-point (left) and out-point (right)
- `updateCellTimeline(cell)` — recalculates fill/peak/handle positions from `cell._moment`
- `setupTimelineDrag(cell)` — attaches mouse+touch drag handlers to handles; persists via `PlexdMoments.updateMoment()`
- Drag handles mutate `mom.start`/`mom.end` directly — the existing `timeupdate` loop handler holds a closure reference to the same object, so loop boundaries update live
- `Opt+Left/Right` — Nudge in-point ±0.5s (Wall mode only)
- `Opt+Shift+Left/Right` — Adjust duration ±0.5s (Wall mode only)
- Minimum 1s duration enforced; peak clamped to stay within range
- `panWallToSelected()` — Centers viewport on selected cell (both axes) using offsetTop/offsetLeft + transform panning; called on selection change and when entering edit mode so scale(1.8) cell isn't clipped
- `getTimelineWindow()` — For extracted clips, adds ±padding around the extraction bounds so drag handles can move in both directions (not just shrink). Stores original bounds in `mom._extractedStart`/`mom._extractedEnd` on first call
- Mouse wheel scrolls the Wall viewport (viewport uses `overflow: hidden` + CSS `transform: translate()` panning)
- `initWallCell()` — Lazy-inits via IntersectionObserver. Canvas inserted BEHIND poster image; poster removed only after first video frame draws to canvas (prevents blank flash)

**Server API:**
- `GET /api/moments` — List (with filters)
- `POST /api/moments` — Upsert single moment
- `POST /api/moments/sync` — Bulk sync (dirty moments)
- `DELETE /api/moments/:id` — Remove moment + thumbnail

### Skier AI Multi-Model Tagging

**Architecture:** 4 specialized Skier model servers run in parallel, each on its own port. Managed by `~/Projects/nsfw_ai_model_server/nsfw-ai-manage.sh`. Auto-started by Plexd server on boot.

| Category | Model | Port | Tags |
|----------|-------|------|------|
| Actions | distinctive_haze (VIP) / gentler_river (Member) | 8000 | 36 |
| Bodyparts | electric_smoke (VIP) | 8001 | 37 |
| BDSM | happy_terrain (VIP) | 8002 | 50 |
| Positions | blooming_star (VIP) | 8003 | 28 |

**Discovery:** Server reads `~/Projects/nsfw_ai_model_server/server-status.json` for the full list of configured servers. Falls back to single server at `:8000` if file not found.

**Analysis flow:**
1. `a` key in Moment Browser → `POST /api/moments/:id/analyze`
2. Server calls ALL available Skier servers in parallel (`Promise.allSettled`)
3. Tags merged (highest confidence wins for duplicates), sorted by confidence descending
4. Results saved to moment, response includes which categories contributed
5. Empty results don't wipe existing tags (server-owned field protection)

**Batch:** `Shift+A` → `POST /api/moments/analyze-batch`. Processes untagged moments sequentially. Client polls `/api/moments/analyze-progress` for live updates in the Status Log panel.

**AI fields are server-owned:** Client sync (`POST /api/moments/sync`) strips `aiTags`, `aiDescription`, `aiConfidences` from incoming data — prevents browser from overwriting server-side AI results.

**Setup (new models from Patreon):**
```bash
cd ~/Projects/nsfw_ai_model_server
# Drop zip files, then:
./nsfw-ai-manage.sh extract    # Unpacks zips → copies model/config files
./nsfw-ai-manage.sh setup      # Creates instance dirs with symlinks
./nsfw-ai-manage.sh start      # Launches all servers
./nsfw-ai-manage.sh status     # Verify all running
```

**Key endpoints:**
- `GET /api/ai/status` — List all Skier servers with availability
- `POST /api/moments/:id/analyze` — Analyze one moment (all models)
- `POST /api/moments/analyze-batch` — Batch all untagged
- `GET /api/moments/analyze-progress` — Poll batch progress

### Casting (AirPlay / Chromecast / Presentation API)

**Architecture:** `PlexdCast` IIFE module (`web/js/cast.js`) abstracts three protocols behind a unified API. Auto-detects available path: Chrome Cast SDK → Safari AirPlay → Presentation API fallback.

**Key binding:** `Shift+P` — toggle cast for selected stream. `P` alone remains PiP.

**Three protocol paths:**
- **Chrome Cast** — Google Cast SDK loaded async, `CastSession.loadMedia()` sends URL to Chromecast, `CastSession.sendMessage('urn:x-cast:plexd', ...)` for control commands
- **Safari AirPlay** — `video.webkitShowPlaybackTargetPicker()` for native video routing, no control channel (playback syncs via video element)
- **Presentation API** — W3C standard, opens `/cast-receiver.html` on second screen, bidirectional via `PresentationConnection.send()`

**Cast receiver:** `web/cast-receiver.html` — lightweight self-contained page with HLS.js. Runs on Cast device or second screen. JSON message protocol: `{cmd: "load"|"play"|"pause"|"seek"|"volume"}` inbound, `{event: "loaded"|"timeupdate"|"state"|"error"}` outbound.

**LAN IP discovery:** `GET /api/server-info` returns `{ip, port}`. Sender rewrites `localhost` URLs to LAN IP before sending to Cast receiver (Chromecast can't reach localhost).

**UI:** Toolbar button (`#cast-btn`), blue status bar at top of `.plexd-app` when active, cast badge on stream wrapper.

**Grid casting:** Not in-app — use macOS Screen Mirroring (Control Center). Can run simultaneously with single-stream Cast (AirPlay mirror + Chromecast are independent protocols).

**Key endpoints:**
- `GET /api/server-info` — LAN IP and port for URL rewriting

### Projector Viewer (External Display)

**Purpose:** Show video on a projector/second display via HDMI while keeping the Plexd control UI on the laptop. Separate from Cast (which targets wireless Chromecast/AirPlay).

**Key binding:** `Shift+F` — toggle projector viewer open/closed. Uses the selected or fullscreen stream.

**Architecture:** Single shared popup window (`window.name='plexd-projector'`) managed by `PlexdStream` module in `stream.js`. Communication via `postMessage` with origin validation (no bidirectional — projector is a "dumb terminal").

**Key functions (stream.js):**
- `buildProjectorHtml(url, startTime, title)` — Self-contained HTML string with HLS.js, postMessage listener, auto-hide cursor/title
- `openProjectorViewer(streamId)` — Opens (or reuses) full-screen popup, writes HTML via same pattern as `popoutStream`
- `updateProjectorStream(streamId)` — Sends `{cmd:'load', url, time, title}` via `postMessage` to existing popup
- `closeProjectorViewer()` — Closes popup, clears state
- `isProjectorOpen()` — Boolean check (auto-cleans stale references)

**Auto-follow:** `selectStream()` calls `updateProjectorStream()` when projector is open and selection changes. Stream switches are instant (no new window).

**Popup features:**
- Full-viewport black background, no controls (controlled from main UI)
- Double-click toggles native fullscreen (for projector display)
- Title overlay fades after 3s (`titleTimer`), cursor hides after 3s idle (`idleTimer` — separate timers)
- HLS.js loaded from CDN (synchronous `<script>` tag, same as `popoutStream`)

**Safety:**
- `postMessage` origin validation (`e.origin !== allowedOrigin` check in popup)
- `postMessage` target origin set to `window.location.origin` (not `'*'`)
- try/catch around popup write for popup-blocked edge cases
- `removeStream()` clears `projectorStreamId` when projected stream is removed
- Null guards on `stream.video` access

**Relationship to other features:**
- `Shift+F` handled in the same capture-phase `F` key handler as fullscreen (`e.shiftKey` check runs first)
- `fF` added to `propagateKeys` regex — works in true fullscreen mode
- Dead `case 'f'/'F'` removed from focused-mode switch (propagateKeys handles it)
- Independent from Cast (`Shift+P`) — both can run simultaneously (wired HDMI vs wireless)

### HLS Transcoding System

**Architecture:**
- Queue-based system prevents CPU overload (`transcodeQueue`, `activeTranscodes`)
- `MAX_CONCURRENT_TRANSCODES = 4` for M4 (adjust per machine)
- Jobs tracked in `transcodingJobs` object with status/progress
- Guard `transcodingJobs[fileId]` access — job can be deleted mid-transcode by cleanup

**Encoder: HEVC (H.265)**
```javascript
// Hardware first, software fallback
runTranscode(fileId, useSoftwareEncoder = false)
// If hevc_videotoolbox fails, auto-retries with libx265
```
- `-tag:v hvc1` is **required** for Safari/iPhone HEVC HLS playback
- Originals auto-deleted after successful transcode

**Key APIs:**
- `POST /api/files/upload` - Upload, returns fileId, queues transcode
- `POST /api/hls/start` - Unpause and queue all pending files
- `POST /api/hls/resume` / `POST /api/hls/pause` - Toggle queue processing
- `GET /api/files/transcode-status?fileId=X` - Poll for progress
- `GET /api/hls/list` - List all files with transcode status
- `GET /api/hls/status` - Queue status (paused, queueLength, activeCount)
- `DELETE /api/hls/delete/:id` - Delete HLS only (keep original)
- `DELETE /api/hls/delete-original/:id` - Delete original only (keep HLS)

**Helper Function:**
```javascript
deleteFileAndHLS(fileId, { deleteOriginal, deleteHLS, cancelTranscode })
```
Use this instead of inline deletion code (DRY pattern).

### Stream URL Patterns

Streams maintain two URL properties:
- `stream.url` — Original URL (for display, dedup, saving, history)
- `stream.sourceUrl` — Actual URL for media loading (may be proxied via `/api/proxy/hls`)

**Download filename resolution** (in `downloadStream()`):
1. `stream.fileName` (set during file drop)
2. `fileId` from `extractServerFileId()` (original filename for server files)
3. `getDownloadName(url)` — walks URL path, skips generic names (master, playlist, index)

**`addStream` vs `addStreamSilent`:**
- `addStream()` — full add: dedup check, history, auto-save, message
- `addStreamSilent()` — restore only: dedup check, no history, no message (for auto-load, sets, queue)
- `addStreamFromFile()` — file drop: creates blob URL, uploads to server, adds server URL to history after upload

### Plexd Chrome App

Located at `~/Applications/Plexd Chrome.app` (AppleScript app, native ARM64+x86_64):
- Auto-starts Node.js server if not running on port 8080
- Launches Chrome with `--user-data-dir=.chrome-profile` (persistent profile)
- Loads extension via `--load-extension`
- Opens `http://localhost:8080/?autoload=last`

### Theater & Advanced Mode

Two viewing modes toggled by **Backtick** (`` ` ``):

**Advanced Mode** (default) — Full power-user toolkit. All keys work normally.

**Theater Mode** — Guided 5-scene cinematic experience:

| Scene | Key | Purpose |
|-------|-----|---------|
| Casting Call | Auto on enter | Mosaic overview, streams fade in, Space advances |
| Lineup | Auto after Casting | Grid view, arrow keys rotate hero, Space advances |
| Stage | Auto after Lineup | Focused playback, transport controls, rating |
| Climax | C | Sub-modes: Tight Wall (0) → Focus (1) → Bug Eye (2) → Single Focus (3), cycle with E/Shift+E |
| Encore | N | Plays bookmarked highlights in fullscreen overlay |

**State machine** — `theaterMode` (bool) + `theaterScene` (string). Scene transitions via `applyTheaterScene()` which calls scene-specific `enterXxx()` / `exitXxx()` functions.

**Key routing** — `handleKeyboard()` checks `theaterMode` first. Each scene has a handler block that returns early for scene-specific keys, falling through to shared handlers (rating, help, Escape).

**Mode badge** — Visual indicator showing current mode/scene, updated by `updateModeIndicator()`.

**Encore cleanup** — Always use `closeEncoreView()` to tear down the video overlay. Never use raw `.remove()` on Encore elements — this leaks media resources (paused video continues buffering).

**Climax sub-modes** — Tracked by `climaxSubMode` (0-3). When Escape exits Single Focus (mode 3), fall back to Tight Wall (mode 0), don't leave Climax entirely.
