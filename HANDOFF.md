# Plexd Technical Handoff

## Overview

Plexd is a multiplex video stream display system. This document records all major sessions of work for continuity between development sessions.

---

## Session: March 2026 — Security Hardening + Performance Audit

### What Was Done

A full security, performance, and architecture review was conducted across the entire codebase (`server.js` 5,142 lines, `app.js` 14,433 lines, `stream.js` 5,237 lines, `grid.js` 2,519 lines). Ten issues were identified and fixed in a single commit (`623f39a`).

---

### Security Fixes

#### 1. Local File Inclusion (LFI) — Critical

Three endpoints accepted user-supplied filesystem paths with no restrictions, allowing any LAN client to read, copy, or enumerate arbitrary files on the host machine (SSH keys, `.env`, Chrome cookies, etc.).

**Endpoints affected:**
- `GET /api/files/local?path=<any-path>` — served any file via `serveFileWithRange()`
- `POST /api/files/import` body `{ filePath }` — copied any file into `uploads/`
- `GET /api/files/scan-local?folder=<any-path>` — recursively listed any directory

**Fix:** Added `isAllowedLocalPath()` guard called in all three handlers before any filesystem operation:

```js
// server.js
const ALLOWED_LOCAL_DIRS = [
    path.resolve(UPLOADS_DIR),
    path.resolve(DEFAULT_SCAN_FOLDER),   // ~/Downloads
];

function isAllowedLocalPath(filePath) {
    const resolved = path.resolve(filePath);
    return ALLOWED_LOCAL_DIRS.some(
        dir => resolved === dir || resolved.startsWith(dir + path.sep)
    );
}
```

To allow additional scan roots, add to `ALLOWED_LOCAL_DIRS` at the top of `server.js`.

---

#### 2. SSRF — High

The `/api/proxy/hls` and `/api/proxy/video` endpoints accepted any `http://` or `https://` URL and fetched it server-side. A LAN client could use this to scan internal network services, hit cloud metadata endpoints (`169.254.169.254`), or reach other localhost ports.

**Fix:** Added host validation inside `fetchUrl()` before any connection is made:

```js
const parsedHost = new URL(targetUrl).hostname;
if (/^(localhost$|127\.|0\.0\.0\.0|::1|169\.254\.|10\.|192\.168\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(parsedHost)) {
    callback(new Error(`SSRF blocked: private/loopback host (${parsedHost})`));
    return;
}
```

The proxy is only used for external CDN content (Aylo/Reptyle HLS streams), so this restriction is safe.

---

#### 3. CSRF / Unauthenticated API — Medium

The server bound on `0.0.0.0:8080` with `Access-Control-Allow-Origin: *` and zero authentication. Any device on the network (or any webpage opened in the browser via a cross-origin fetch) could call any API endpoint — controlling playback, importing files, triggering AI analysis, deleting moments, etc.

**Fix — Per-run API token:**

A random 32-hex-character token is generated at server startup:

```js
const API_TOKEN = crypto.randomBytes(16).toString('hex');
```

It is injected into every served HTML page as a `<meta>` tag:

```js
// Injected into </head> of every .html response
const tokenMeta = `<meta name="plexd-api-token" content="${API_TOKEN}">`;
```

All `/api/*` endpoints (except the proxy and `/api/server-info`, which are needed before the token is known) require the `X-Plexd-Token` header:

```js
const TOKEN_EXEMPT = new Set(['/api/server-info', '/api/proxy/hls', '/api/proxy/video', '/api/proxy/hls/download']);
if (pathname.startsWith('/api/') && !TOKEN_EXEMPT.has(pathname)) {
    const tok = req.headers['x-plexd-token'] || url.searchParams.get('_t');
    if (tok !== API_TOKEN) {
        jsonError(res, 401, 'Unauthorized');
        return;
    }
}
```

**Fix — `plexdFetch()` client wrapper:**

A `plexdFetch()` wrapper is defined inline in `index.html` and `remote.html` (before any JS files load). It reads the `<meta>` token once and injects it as a header on every `/api/` call automatically:

```js
window.plexdFetch = function(url, opts) {
    opts = opts || {};
    if (typeof url === 'string' && url.startsWith('/api/')) {
        opts.headers = Object.assign({ 'X-Plexd-Token': getToken() }, opts.headers || {});
    }
    return fetch(url, opts);
};
```

All 41 `fetch('/api/…')` calls across `app.js`, `remote.js`, `stream.js`, and `moments.js` were replaced with `plexdFetch(…)`.

**Key rule:** Any new API call added to client JS must use `plexdFetch()`, not `fetch()` directly.

---

#### 4. CORS Wildcard — Medium

`Access-Control-Allow-Origin: *` allowed any webpage to make credentialed requests to the API from the user's browser.

**Fix:** Replaced with a dynamic origin allowlist — only localhost and RFC-1918 LAN addresses are permitted:

```js
const allowedOrigin = /^https?:\/\/(localhost|127\.0\.0\.1|192\.168\.|10\.|172\.(1[6-9]|2[0-9]|3[01])\.)/.test(origin)
    ? origin : `http://localhost:${PORT}`;
res.setHeader('Access-Control-Allow-Origin', allowedOrigin);
res.setHeader('Vary', 'Origin');
```

The Chrome extension's Private Network Access headers are preserved.

---

#### 5. Unbounded Proxy Manifest Body — Medium

When the HLS proxy fetched a manifest (`.m3u8`), it accumulated the full response body in memory with no size limit. A malicious upstream server could send a gigabyte-sized response.

**Fix:** Hard cap at 10MB (real manifests are a few KB):

```js
const MAX_MANIFEST_BYTES = 10 * 1024 * 1024;
proxyRes.on('data', chunk => {
    body += chunk;
    if (body.length > MAX_MANIFEST_BYTES) {
        proxyRes.destroy();
        if (!res.headersSent) jsonError(res, 502, 'Manifest too large');
    }
});
```

---

### Performance Fixes

#### 6. `transition: all` on Stream Wrappers (plexd.css)

The coverflow and smart-layout modes applied `transition: all` to `.plexd-stream` elements. Stream wrappers are positioned with `style.left`, `style.top`, `style.width`, `style.height` — so `transition: all` was animating layout properties, triggering a full reflow on every frame during carousel animation.

**Fix:** Replaced with GPU-composited properties only:

```css
/* Before */
transition: all 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94);

/* After */
transition: transform 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94),
            opacity 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94),
            box-shadow 0.5s cubic-bezier(0.25, 0.46, 0.45, 0.94);
```

**Rule (already in CLAUDE.md):** Never animate `left`, `top`, `width`, or `height`. Only animate `transform` and `opacity`.

---

#### 7. Progress Bar Layout Thrashing (remote.css / remote.js)

The iPhone remote's progress bar used `transition: width` on the fill element and `transition: left` on the thumb — both layout properties, both animating on every `timeupdate` event (multiple times per second).

**Fix — CSS:** Converted to GPU-composited transforms:

```css
/* Fill: width → scaleX */
.progress-fill {
    width: 100%;
    transform-origin: left center;
    transform: scaleX(0);
    transition: transform 0.1s linear;
}

/* Thumb: left → translateX via CSS custom property */
.progress-thumb {
    left: 0;
    transform: translateX(calc(var(--progress, 0) * 1% - 9px)) translateY(-50%);
    transition: transform 0.1s linear;
}
```

**Fix — JS:** Updated all three progress update sites in `remote.js`:

```js
// Fill
el.progressFill.style.transform = `scaleX(${progress / 100})`;

// Thumb
el.progressThumb.style.setProperty('--progress', progress);
```

Same pattern applied to `viewer-progress-fill` and `moments-player-progress-fill`.

---

### Housekeeping

#### 8. Puppeteer moved to devDependencies

`puppeteer` (300MB of bundled Chromium) was listed as a runtime `dependency` but is only used in `scripts/chrome-test.js`. Moved to `devDependencies` so production deploys don't install it.

---

### Files Changed

| File | Changes |
|------|---------|
| `server.js` | API_TOKEN, ALLOWED_LOCAL_DIRS, isAllowedLocalPath(), SSRF guard in fetchUrl(), CORS origin allowlist, token auth middleware, manifest body cap, HTML token injection |
| `web/index.html` | plexdFetch() wrapper inline script |
| `web/remote.html` | plexdFetch() wrapper inline script |
| `web/js/app.js` | 34× fetch→plexdFetch |
| `web/js/remote.js` | 4× fetch→plexdFetch, progress bar scaleX/translateX |
| `web/js/stream.js` | 1× fetch→plexdFetch |
| `web/js/moments.js` | 2× fetch→plexdFetch |
| `web/css/plexd.css` | transition: all → explicit GPU props on .plexd-stream |
| `web/css/remote.css` | progress fill/thumb: layout props → transform |
| `package.json` | puppeteer: dependencies → devDependencies |

---

### Remaining Architecture Notes (Not Fixed — Future Work)

These were identified in the audit but not fixed in this session due to scope:

1. **`app.js` is 14,433 lines** — a single IIFE containing theater mode, moments UI, wall editor, face detection, keyboard handling, sets, ratings, downloads, and more. Recommend extracting bounded submodules: `theater.js`, `moments-ui.js`, `keyboard.js`.

2. **`server.js` is 5,142 lines** with 57 `if (pathname === …)` route branches. No routing middleware, so adding uniform auth/logging/rate-limiting requires touching every branch. A minimal route-map pattern would help.

3. **`handleKeyboard` has 200+ cases** called on every keypress. A dispatch table keyed by mode + key would reduce constant-factor cost.

4. **Health check polls every 5s per stream** — with 8 streams that's 8 independent timers. Consolidate to a single interval iterating all streams.

5. **Static files loaded fully into memory** (`fs.readFile`) — should use `fs.createReadStream` with `ETag`/`Cache-Control` headers for large JS files.

---

## Session: January 2026 — Remote Interface Redesign

### Completed This Session

1. **Server-Side File Storage** (`server.js`)
   - `/api/files/upload` — upload with name+size duplicate check
   - `/api/files/:id` — serve files with range request support
   - `/api/files/list` — list all uploaded files
   - `/api/files/purge` — delete all or by set name
   - `/api/files/associate` — link files to saved sets (prevents 24h auto-delete)

2. **Remote Video Sync** (`web/js/remote.js`)
   - Phone video syncs position with Mac (within 2s tolerance)
   - Play/pause state synced from Mac
   - Uses `serverUrl` for cross-device playback

3. **Remote Tap Zones** (hero area)
   ```
   +------------------+
   |   TOP: Random    |
   +------+----+------+
   | LEFT |PLAY| RIGHT|
   | -30s |    | +30s |
   +------+----+------+
   | BTM: Focus Toggle|
   +------------------+
   ```

4. **Remote Swipe Gestures**
   - Swipe left/right = navigate streams
   - Viewer swipe down = exit viewer

### Key Files Modified
- `server.js` — file storage API
- `web/js/app.js` — upload logic, purge UI in Manage Files modal
- `web/js/remote.js` — tap zones, video sync, swipe gestures
- `web/js/stream.js` — double-click focus
- `web/sw.js` — cache version bump
- `CLAUDE.md` — remote documentation

---

## Development Quick Reference

### Start Server

```bash
./scripts/start-server.sh     # ALWAYS use this — kills old instances first
tail -f /tmp/plexd-server.log # Watch logs
```

Never run `node server.js &` directly — see CLAUDE.md for why.

### URLs

```
http://localhost:8080/          # Main app
http://localhost:8080/remote.html  # iPhone remote PWA
http://<lan-ip>:8080/remote.html   # iPhone on same WiFi
```

### Token Flow

The API token is generated fresh on every server start. The browser gets it automatically via the `<meta name="plexd-api-token">` tag injected into HTML. The `plexdFetch()` wrapper reads it and sends `X-Plexd-Token` on every API call. No manual token management needed.

If you add a new API endpoint:
1. Add the route to `server.js` — the token middleware covers all `/api/*` automatically
2. Call the endpoint via `plexdFetch()` in client JS, not `fetch()`
3. If the endpoint needs to be exempt from auth (like a new proxy), add its path to `TOKEN_EXEMPT`

### Extending ALLOWED_LOCAL_DIRS

If you want to allow scanning/importing from a directory other than `~/Downloads`:

```js
// Near top of server.js, after ALLOWED_LOCAL_DIRS is defined:
ALLOWED_LOCAL_DIRS.push(path.resolve('/path/to/your/media'));
```

---

## Architecture Summary

### Server Modules (all in server.js)

| Section | Responsibility |
|---------|---------------|
| File Storage | Upload, serve, transcode, HLS management |
| Remote Relay | State sync and command bus between Mac and iPhone |
| Proxy | HLS/video CORS bypass for external streams |
| Moments | Capture, thumbnail, AI tagging, clip extraction |
| Demo/Auth | Aylo (Brazzers), Reptyle, Stash integration |
| Downloads | Background ffmpeg download queue |
| Static Serving | Web files with token injection |

### Client Modules

| File | Responsibility |
|------|---------------|
| `grid.js` | Layout calculation (standard grid, coverflow, Tetris/Wall) |
| `stream.js` | Video element lifecycle, HLS.js, controls, fullscreen, projector |
| `moments.js` | Moment CRUD, server sync, thumbnail store |
| `cast.js` | AirPlay / Chromecast / Presentation API abstraction |
| `app.js` | Everything else: keyboard, theater mode, ratings, sets, UI |

### Data Flow

```
User Input → PlexdApp.addStream() → PlexdStream.createStream()
                                          ↓
                                   Video element created
                                          ↓
                                   PlexdGrid.calculateLayout()
                                          ↓
                                   DOM positions updated via left/top/width/height
```

### Remote Control Flow

```
iPhone (remote.html)
  → plexdFetch('/api/remote/command', POST, {action, payload})
  → server.js pendingCommands[]
  → Mac app polls GET /api/remote/command every 500ms
  → handleRemoteCommand(action, payload)
```

State flows the other direction: Mac POSTs to `/api/remote/state`, iPhone polls GET.

---

## Known Issues / Future Work

1. **Stream wrapper positioning** uses `left`/`top`/`width`/`height` inline styles. Coverflow/smart-layout mode transitions are now GPU-safe (transition only covers `transform`/`opacity`/`box-shadow`), but the underlying positioning could be refactored to use `transform: translate()` for consistency.

2. **app.js size** (14k lines) makes it hard to audit or modify safely. Extracting `theater.js`, `moments-ui.js`, and `keyboard.js` would reduce risk of cross-feature breakage.

3. **No rate limiting** on API endpoints. A misbehaving LAN client could flood the moments sync or demo stream endpoints. Low priority for a personal tool but worth noting.

4. **Service worker caching** (`sw.js`) caches all static assets. After a server restart (new token), cached HTML in the service worker may have the old token. The `?v=N` cache-bust on script tags handles JS files, but the HTML itself is cached. Solution: always bump the SW cache version after deployments that change security-sensitive HTML.
