# Cast & Mirroring Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Cast a single selected stream to Chromecast, AirPlay, or Presentation API second screens, with Mac as dual-screen controller.

**Architecture:** Three-tier casting (Chrome Cast SDK → Safari AirPlay → Presentation API fallback) with a shared receiver page. Server adds one endpoint for LAN IP discovery. Keyboard: `Shift+P` = cast toggle, `Cmd+Shift+P` = switch stream.

**Tech Stack:** Google Cast SDK (Chrome), WebKit AirPlay API (Safari), W3C Presentation API (fallback), HLS.js (receiver), vanilla JS IIFE module.

**Design Doc:** `docs/plans/2026-03-01-cast-mirroring-design.md`

---

### Task 1: Server — LAN IP Discovery Endpoint

**Files:**
- Modify: `server.js` (add route near other `/api/` routes, ~line 1754 area)

**Step 1: Add `/api/server-info` endpoint**

Find the route handling section in `server.js` (near `/api/remote/state`). Add:

```javascript
// --- Cast / Server Info ---
if (urlPath === '/api/server-info' && method === 'GET') {
    const nets = os.networkInterfaces();
    let ip = '127.0.0.1';
    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                ip = net.address;
                break;
            }
        }
        if (ip !== '127.0.0.1') break;
    }
    return jsonOk(res, { ip, port: parseInt(PORT) });
}
```

Note: `os` is already imported at line 7 (`const os = require('os')`).

**Step 2: Test the endpoint**

```bash
curl http://localhost:8080/api/server-info
```
Expected: `{"ip":"192.168.x.x","port":8080}`

**Step 3: Commit**

```bash
git add server.js
git commit -m "feat(cast): add /api/server-info endpoint for LAN IP discovery"
```

---

### Task 2: Cast Receiver Page

**Files:**
- Create: `web/cast-receiver.html`

**Step 1: Create the receiver page**

Create `web/cast-receiver.html` — a minimal page that:
- Loads HLS.js from CDN (same version as index.html: `hls.js@1.5.7`)
- Has a single `<video>` element, fullscreen, black background
- Shows a "Plexd" idle screen (centered text on black) when nothing is playing
- Loads Google Cast Receiver SDK (`//www.gstatic.com/cast/sdk/libs/caf_receiver/v3/cast_receiver_framework.js`)
- Handles three receiver modes:
  - **Cast Receiver:** Initializes `cast.framework.CastReceiverContext` and listens for `LOAD` media events
  - **Presentation API:** Listens on `navigator.presentation.receiver.connectionList` for messages
  - **Standalone:** Reads `?url=` query param for direct testing

**Message handling (all modes):**

```javascript
function handleMessage(msg) {
    const data = typeof msg === 'string' ? JSON.parse(msg) : msg;
    switch (data.cmd) {
        case 'load':
            loadVideo(data.url, data.title);
            break;
        case 'play':
            video.play();
            break;
        case 'pause':
            video.pause();
            break;
        case 'seek':
            video.currentTime = data.time;
            break;
        case 'volume':
            video.volume = data.level;
            video.muted = data.level === 0;
            break;
    }
}
```

**Video loading logic:**

```javascript
function loadVideo(url, title) {
    // Tear down previous HLS instance
    if (hlsInstance) { hlsInstance.destroy(); hlsInstance = null; }

    // Show title briefly
    if (title) showTitle(title);

    // HLS detection
    if (url.includes('.m3u8')) {
        if (video.canPlayType('application/vnd.apple.mpegurl')) {
            // Native HLS (Safari receiver)
            video.src = url;
        } else if (window.Hls && Hls.isSupported()) {
            hlsInstance = new Hls({ maxBufferLength: 30 });
            hlsInstance.loadSource(url);
            hlsInstance.attachMedia(video);
        }
    } else {
        video.src = url;
    }
    video.play();
    idleScreen.style.display = 'none';
}
```

**State reporting** — send back to sender every 2 seconds + on key events:

```javascript
function sendState(conn, event, data) {
    const msg = JSON.stringify({ event, ...data });
    if (conn && conn.send) conn.send(msg);
}

// On timeupdate (throttled to every 2s)
video.addEventListener('timeupdate', throttle(() => {
    sendState(connection, 'timeupdate', { time: video.currentTime });
}, 2000));

// On state changes
video.addEventListener('playing', () => sendState(connection, 'state', { state: 'playing' }));
video.addEventListener('pause',   () => sendState(connection, 'state', { state: 'paused' }));
video.addEventListener('waiting', () => sendState(connection, 'state', { state: 'buffering' }));
video.addEventListener('loadedmetadata', () => sendState(connection, 'loaded', { duration: video.duration }));
video.addEventListener('error',   () => sendState(connection, 'error', { message: video.error?.message || 'Unknown error' }));
```

**Step 2: Test standalone mode**

```bash
# With server running:
open "http://localhost:8080/cast-receiver.html?url=https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8"
```
Expected: Video plays fullscreen on black background.

**Step 3: Commit**

```bash
git add web/cast-receiver.html
git commit -m "feat(cast): add cast receiver page with HLS support and message protocol"
```

---

### Task 3: PlexdCast Module — Core Structure

**Files:**
- Create: `web/js/cast.js`

**Step 1: Create the IIFE module skeleton**

Create `web/js/cast.js` following the project's IIFE pattern (like PlexdStream, PlexdMoments):

```javascript
const PlexdCast = (function() {
    'use strict';

    // --- State ---
    var castState = {
        active: false,
        mode: null,          // 'cast' | 'airplay' | 'presentation'
        streamId: null,       // Which Plexd stream is being cast
        targetName: '',       // Device name (e.g., "Living Room TV")
        receiverUrl: null     // LAN URL for cast-receiver.html
    };

    var availability = {
        cast: false,
        airplay: false,
        presentation: false
    };

    var stateCallbacks = [];
    var castSession = null;       // Chrome Cast session
    var presentationConn = null;  // Presentation API connection
    var serverInfo = null;        // { ip, port } from /api/server-info

    // --- Helpers ---

    function notifyStateChange() {
        var state = getState();
        stateCallbacks.forEach(function(cb) { try { cb(state); } catch(e) {} });
    }

    function getStreamCastUrl(streamId) {
        // Get the stream's proxied URL and rewrite localhost → LAN IP
        var stream = PlexdStream.getAllStreams().find(function(s) { return s.id === streamId; });
        if (!stream) return null;
        var url = stream.sourceUrl || stream.url;
        if (serverInfo && (url.includes('localhost') || url.includes('127.0.0.1'))) {
            url = url.replace(/localhost|127\.0\.0\.1/, serverInfo.ip);
        }
        return url;
    }

    function getReceiverUrl() {
        if (!serverInfo) return null;
        return 'http://' + serverInfo.ip + ':' + serverInfo.port + '/cast-receiver.html';
    }

    // --- Init ---

    function init() {
        // Fetch server info for LAN IP
        fetch('/api/server-info')
            .then(function(r) { return r.json(); })
            .then(function(info) {
                serverInfo = info;
                castState.receiverUrl = getReceiverUrl();
                detectAvailability();
            })
            .catch(function() { detectAvailability(); });
    }

    function detectAvailability() {
        // Chrome Cast
        if (window.chrome && window.chrome.cast) {
            availability.cast = true;
            initChromeCast();
        }
        // Safari AirPlay
        var testVideo = document.createElement('video');
        if (testVideo.webkitShowPlaybackTargetPicker) {
            availability.airplay = true;
        }
        // Presentation API
        if (navigator.presentation && navigator.presentation.request) {
            availability.presentation = true;
        }
        notifyStateChange();
    }

    // --- Public API ---

    function getState() {
        return {
            active: castState.active,
            mode: castState.mode,
            streamId: castState.streamId,
            targetName: castState.targetName,
            available: availability.cast || availability.airplay || availability.presentation
        };
    }

    function getAvailability() {
        return Object.assign({}, availability);
    }

    function onStateChange(callback) {
        stateCallbacks.push(callback);
    }

    // Stubs — filled in by Tasks 4, 5, 6
    function castStream(streamId) {}
    function stopCasting() {}
    function switchStream(streamId) {}
    function sendCommand(cmd, data) {}

    // Expose state for debugging
    window._plexdCastState = castState;

    return {
        init: init,
        getState: getState,
        getAvailability: getAvailability,
        castStream: castStream,
        stopCasting: stopCasting,
        switchStream: switchStream,
        sendCommand: sendCommand,
        onStateChange: onStateChange
    };
})();
```

**Step 2: Commit**

```bash
git add web/js/cast.js
git commit -m "feat(cast): add PlexdCast module skeleton with state management and LAN URL rewriting"
```

---

### Task 4: PlexdCast — Chrome Cast Implementation

**Files:**
- Modify: `web/js/cast.js` (fill in Chrome Cast functions)

**Step 1: Add Chrome Cast SDK initialization**

Inside the `initChromeCast()` stub, add:

```javascript
function initChromeCast() {
    var context = cast.framework.CastContext.getInstance();
    context.setOptions({
        receiverApplicationId: CAST_APP_ID, // From Google Cast Developer Console
        autoJoinPolicy: chrome.cast.AutoJoinPolicy.ORIGIN_SCOPED
    });

    // Listen for session state changes
    context.addEventListener(
        cast.framework.CastContextEventType.SESSION_STATE_CHANGED,
        function(event) {
            switch (event.sessionState) {
                case cast.framework.SessionState.SESSION_STARTED:
                case cast.framework.SessionState.SESSION_RESUMED:
                    castSession = context.getCurrentSession();
                    castState.active = true;
                    castState.mode = 'cast';
                    castState.targetName = castSession.getCastDevice().friendlyName;
                    // Set up message listener for receiver → sender
                    castSession.addMessageListener('urn:x-cast:plexd', function(ns, msg) {
                        handleReceiverMessage(JSON.parse(msg));
                    });
                    notifyStateChange();
                    break;
                case cast.framework.SessionState.SESSION_ENDED:
                    castSession = null;
                    castState.active = false;
                    castState.mode = null;
                    castState.streamId = null;
                    castState.targetName = '';
                    notifyStateChange();
                    break;
            }
        }
    );
}
```

**Step 2: Implement `castStream` for Chrome Cast path**

```javascript
function castStreamViaCast(streamId) {
    if (!castSession) {
        // Request a session first (shows device picker)
        cast.framework.CastContext.getInstance().requestSession()
            .then(function() {
                castSession = cast.framework.CastContext.getInstance().getCurrentSession();
                loadMediaOnCast(streamId);
            })
            .catch(function(e) { console.warn('Cast session request failed:', e); });
        return;
    }
    loadMediaOnCast(streamId);
}

function loadMediaOnCast(streamId) {
    var url = getStreamCastUrl(streamId);
    if (!url) return;

    var mediaInfo = new chrome.cast.media.MediaInfo(url, 'application/x-mpegURL');
    mediaInfo.streamType = chrome.cast.media.StreamType.BUFFERED;

    var stream = PlexdStream.getAllStreams().find(function(s) { return s.id === streamId; });
    if (stream) {
        mediaInfo.metadata = new chrome.cast.media.GenericMediaMetadata();
        mediaInfo.metadata.title = stream.url.split('/').pop() || 'Plexd Stream';
    }

    var request = new chrome.cast.media.LoadRequest(mediaInfo);
    castSession.loadMedia(request)
        .then(function() {
            castState.streamId = streamId;
            notifyStateChange();
        })
        .catch(function(e) { console.error('Cast loadMedia failed:', e); });
}
```

**Step 3: Implement `sendCommand` for Chrome Cast path**

```javascript
function sendCommandViaCast(cmd, data) {
    if (!castSession) return;
    castSession.sendMessage('urn:x-cast:plexd', JSON.stringify({ cmd: cmd, ...data }));
}
```

**Step 4: Implement `stopCasting` for Chrome Cast path**

```javascript
function stopCastingViaCast() {
    if (castSession) {
        castSession.endSession(true);
    }
}
```

**Step 5: Wire into public API**

Update the public `castStream`, `stopCasting`, `sendCommand` functions to dispatch based on available protocol:

```javascript
function castStream(streamId) {
    if (availability.cast) {
        castStreamViaCast(streamId);
    } else if (availability.airplay) {
        castStreamViaAirPlay(streamId);
    } else if (availability.presentation) {
        castStreamViaPresentation(streamId);
    }
}

function stopCasting() {
    if (castState.mode === 'cast') stopCastingViaCast();
    else if (castState.mode === 'presentation') stopCastingViaPresentation();
    // AirPlay: no programmatic stop — user disconnects via system UI
}

function sendCommand(cmd, data) {
    if (castState.mode === 'cast') sendCommandViaCast(cmd, data);
    else if (castState.mode === 'presentation') sendCommandViaPresentation(cmd, data);
}

function switchStream(streamId) {
    castState.streamId = streamId;
    var url = getStreamCastUrl(streamId);
    if (!url) return;
    if (castState.mode === 'cast') loadMediaOnCast(streamId);
    else sendCommand('load', { url: url });
}
```

**Step 6: Commit**

```bash
git add web/js/cast.js
git commit -m "feat(cast): implement Chrome Cast sender with media loading and control messages"
```

---

### Task 5: PlexdCast — Safari AirPlay Implementation

**Files:**
- Modify: `web/js/cast.js`

**Step 1: Add AirPlay functions**

```javascript
function castStreamViaAirPlay(streamId) {
    var stream = PlexdStream.getAllStreams().find(function(s) { return s.id === streamId; });
    if (!stream || !stream.video) return;

    // Listen for target availability
    stream.video.addEventListener('webkitplaybacktargetavailabilitychanged', function(e) {
        availability.airplay = e.availability === 'available';
        notifyStateChange();
    });

    // Listen for current playback target change
    stream.video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', function() {
        if (stream.video.webkitCurrentPlaybackTargetIsWireless) {
            castState.active = true;
            castState.mode = 'airplay';
            castState.streamId = streamId;
            castState.targetName = 'AirPlay';
        } else {
            castState.active = false;
            castState.mode = null;
            castState.streamId = null;
            castState.targetName = '';
        }
        notifyStateChange();
    });

    // Show the AirPlay picker
    stream.video.webkitShowPlaybackTargetPicker();
}
```

Note: AirPlay has no control channel — the video element's native controls are used. Play/pause/seek on the Mac video element automatically syncs to the AirPlay device.

**Step 2: Commit**

```bash
git add web/js/cast.js
git commit -m "feat(cast): implement Safari AirPlay with native video routing"
```

---

### Task 6: PlexdCast — Presentation API Fallback

**Files:**
- Modify: `web/js/cast.js`

**Step 1: Add Presentation API functions**

```javascript
function castStreamViaPresentation(streamId) {
    var receiverUrl = getReceiverUrl();
    if (!receiverUrl) return;

    var request = new PresentationRequest([receiverUrl]);
    request.start()
        .then(function(connection) {
            presentationConn = connection;
            castState.active = true;
            castState.mode = 'presentation';
            castState.streamId = streamId;
            castState.targetName = 'External Display';
            notifyStateChange();

            connection.addEventListener('message', function(e) {
                handleReceiverMessage(JSON.parse(e.data));
            });

            connection.addEventListener('close', function() {
                presentationConn = null;
                castState.active = false;
                castState.mode = null;
                castState.streamId = null;
                castState.targetName = '';
                notifyStateChange();
            });

            // Send the initial video URL
            var url = getStreamCastUrl(streamId);
            if (url) {
                connection.send(JSON.stringify({ cmd: 'load', url: url }));
            }
        })
        .catch(function(e) { console.warn('Presentation request failed:', e); });
}

function sendCommandViaPresentation(cmd, data) {
    if (presentationConn && presentationConn.state === 'connected') {
        presentationConn.send(JSON.stringify(Object.assign({ cmd: cmd }, data)));
    }
}

function stopCastingViaPresentation() {
    if (presentationConn) {
        presentationConn.close();
    }
}
```

**Step 2: Add shared receiver message handler**

```javascript
function handleReceiverMessage(data) {
    // Handle state reports from receiver for UI updates
    switch (data.event) {
        case 'loaded':
            // Receiver has loaded the video; store duration if needed
            break;
        case 'timeupdate':
            // Could sync local scrubber position
            break;
        case 'state':
            // Could show buffering indicator on cast badge
            break;
        case 'error':
            console.warn('Cast receiver error:', data.message);
            break;
    }
}
```

**Step 3: Commit**

```bash
git add web/js/cast.js
git commit -m "feat(cast): implement Presentation API fallback with bidirectional messaging"
```

---

### Task 7: Wire Cast Module into App

**Files:**
- Modify: `web/index.html` (~line 196, script tags)
- Modify: `web/js/app.js` (~line 7219, keyboard handler + init)
- Modify: `web/js/stream.js` (~line 2283, propagateKeys)

**Step 1: Add script tags to `index.html`**

After the HLS.js script tag (line 194) and before `grid.js`, add the Cast SDK. After `moments.js` and before `app.js`, add `cast.js`:

```html
<!-- Cast SDK (Chrome only, non-blocking) -->
<script src="//www.gstatic.com/cv/js/sender/v1/cast_sender.js?loadCastFramework=1" async></script>

<!-- Scripts -->
<script src="js/grid.js?v=103"></script>
<script src="js/stream.js?v=103"></script>
<script src="js/moments.js?v=103"></script>
<script src="js/cast.js?v=103"></script>
<script src="js/app.js?v=103"></script>
```

The Cast SDK is loaded `async` so it doesn't block page load. `cast.js` initializes when the SDK fires `__onGCastApiAvailable`.

**Step 2: Add `__onGCastApiAvailable` hook to `cast.js`**

Add at the bottom of `cast.js` (outside the IIFE):

```javascript
// Chrome Cast SDK callback — called when SDK is ready
window['__onGCastApiAvailable'] = function(isAvailable) {
    if (isAvailable) {
        PlexdCast.init();
    }
};

// For non-Chrome browsers, init immediately
if (!window.chrome || !window.chrome.cast) {
    document.addEventListener('DOMContentLoaded', function() {
        PlexdCast.init();
    });
}
```

**Step 3: Add keyboard handler in `app.js`**

In `handleKeyboard()` (around line 7411 where `case 'p':` is), add a `Shift+P` check BEFORE the existing `P` handler:

```javascript
case 'p':
case 'P':
    if (e.shiftKey) {
        // Shift+P: Cast / disconnect
        e.preventDefault();
        var castState = PlexdCast.getState();
        if (castState.active) {
            PlexdCast.stopCasting();
            showMessage('Cast disconnected');
        } else if (castState.available) {
            var target = PlexdStream.getSelectedStream() || PlexdStream.getFullscreenStream();
            if (target) {
                PlexdCast.castStream(target.id);
            } else {
                showMessage('Select a stream to cast');
            }
        } else {
            showMessage('No cast devices found. Use macOS Screen Mirroring (Control Center → Screen Mirroring)');
        }
    } else if (selected) {
        PlexdStream.togglePiP(selected.id);
    }
    break;
```

**Step 4: Add `P` to `propagateKeys` in `stream.js`**

`P` (and `p`) is ALREADY in the `propagateKeys` regex at line 2283 (in the character class `pP`). No change needed — `Shift+P` produces `'P'` which matches the same regex. Verify this by checking the regex includes `pP` in its character class.

**Step 5: Initialize cast state listener in `app.js`**

In the app's initialization code, add a listener that updates the cast button:

```javascript
// Cast state listener
PlexdCast.onStateChange(function(state) {
    var castBtn = document.getElementById('cast-btn');
    if (castBtn) {
        castBtn.classList.toggle('active', state.active);
        castBtn.title = state.active
            ? 'Casting to ' + state.targetName + ' [Shift+P to disconnect]'
            : 'Cast selected stream [Shift+P]';
    }
    updateCastStatusBar(state);
});
```

**Step 6: Commit**

```bash
git add web/index.html web/js/app.js web/js/stream.js web/js/cast.js
git commit -m "feat(cast): wire PlexdCast into app — keyboard, init, script loading"
```

---

### Task 8: Cast UI — Toolbar Button, Status Bar, Stream Badge

**Files:**
- Modify: `web/index.html` (~line 80, toolbar buttons)
- Modify: `web/css/plexd.css` (add cast styles)
- Modify: `web/js/app.js` (status bar + badge rendering)

**Step 1: Add cast button to toolbar HTML**

In `index.html`, after the fullscreen button (line 80) and before the rewind button:

```html
<button id="cast-btn" class="plexd-button plexd-button-secondary" onclick="PlexdApp.toggleCast()" title="Cast selected stream [Shift+P]">📺</button>
```

**Step 2: Add `toggleCast` to PlexdApp public API**

In `app.js`, add a function that delegates to the Shift+P keyboard handler logic and expose it in the return object:

```javascript
function toggleCast() {
    var castState = PlexdCast.getState();
    if (castState.active) {
        PlexdCast.stopCasting();
        showMessage('Cast disconnected');
    } else if (castState.available) {
        var target = PlexdStream.getSelectedStream() || PlexdStream.getFullscreenStream();
        if (target) {
            PlexdCast.castStream(target.id);
        } else {
            showMessage('Select a stream to cast');
        }
    } else {
        showMessage('No cast devices. Use macOS Screen Mirroring.');
    }
}
```

**Step 3: Add CSS styles for cast UI**

In `plexd.css`, add:

```css
/* Cast status bar */
.plexd-cast-status {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    background: rgba(66, 133, 244, 0.9);
    color: #fff;
    font-size: 12px;
    padding: 4px 12px;
    text-align: center;
    z-index: 1000;
    cursor: pointer;
    opacity: 0;
    pointer-events: none;
    transition: opacity 0.2s;
}

.plexd-cast-status.visible {
    opacity: 1;
    pointer-events: auto;
}

/* Cast badge on stream wrapper */
.plexd-cast-badge {
    position: absolute;
    top: 6px;
    right: 6px;
    background: rgba(66, 133, 244, 0.85);
    color: #fff;
    font-size: 14px;
    padding: 2px 6px;
    border-radius: 4px;
    z-index: 10;
    pointer-events: none;
}
```

**Step 4: Add cast status bar and badge logic in `app.js`**

```javascript
function updateCastStatusBar(state) {
    var bar = document.getElementById('cast-status-bar');
    if (!bar) {
        bar = document.createElement('div');
        bar.id = 'cast-status-bar';
        bar.className = 'plexd-cast-status';
        bar.addEventListener('click', function() { PlexdCast.stopCasting(); });
        var app = document.querySelector('.plexd-app');
        if (app) app.appendChild(bar);
    }

    if (state.active) {
        var stream = PlexdStream.getAllStreams().find(function(s) { return s.id === state.streamId; });
        var title = stream ? (stream.url.split('/').pop() || 'Stream') : 'Stream';
        bar.textContent = '📺 Casting "' + title + '" to ' + state.targetName + ' — click to disconnect';
        bar.classList.add('visible');
    } else {
        bar.classList.remove('visible');
    }

    // Update stream badge
    updateCastBadge(state);
}

function updateCastBadge(state) {
    // Remove any existing badge
    var old = document.querySelector('.plexd-cast-badge');
    if (old) old.remove();

    if (state.active && state.streamId) {
        var stream = PlexdStream.getAllStreams().find(function(s) { return s.id === state.streamId; });
        if (stream && stream.wrapper) {
            var badge = document.createElement('div');
            badge.className = 'plexd-cast-badge';
            badge.textContent = '📺';
            stream.wrapper.appendChild(badge);
        }
    }
}
```

**Step 5: Commit**

```bash
git add web/index.html web/css/plexd.css web/js/app.js
git commit -m "feat(cast): add cast toolbar button, status bar, and stream badge UI"
```

---

### Task 9: Cast Receiver — Chrome Cast Receiver Integration

**Files:**
- Modify: `web/cast-receiver.html` (add CAF receiver framework handling)

**Step 1: Add Cast Application Framework (CAF) receiver logic**

In `cast-receiver.html`, add proper CAF receiver initialization that works alongside the existing message protocol:

```javascript
function initCastReceiver() {
    if (!window.cast || !cast.framework) return;

    var context = cast.framework.CastReceiverContext.getInstance();
    var playerManager = context.getPlayerManager();

    // Custom message namespace for control commands
    context.addCustomMessageListener('urn:x-cast:plexd', function(event) {
        handleMessage(event.data);
        // Send state back
        context.sendCustomMessage('urn:x-cast:plexd', event.senderId,
            JSON.stringify({ event: 'state', state: video.paused ? 'paused' : 'playing' }));
    });

    // Intercept LOAD to use our custom video player instead of CAF's built-in
    playerManager.setMessageInterceptor(cast.framework.messages.MessageType.LOAD, function(request) {
        loadVideo(request.media.contentId, request.media.metadata?.title);
        return null; // Prevent default CAF player from loading
    });

    context.start();
}
```

**Step 2: Add a dev/test Application ID constant**

At top of `cast-receiver.html`:

```javascript
// During development, use Chrome's default media receiver for testing
// Replace with registered App ID from https://cast.google.com/publish/
var CAST_APP_ID = 'CC1AD845'; // Default Media Receiver (dev only)
```

And mirror this constant in `cast.js`:

```javascript
var CAST_APP_ID = 'CC1AD845'; // TODO: Replace with registered Plexd receiver App ID
```

Note: The Default Media Receiver (`CC1AD845`) won't load our custom receiver page, but it allows testing the Cast SDK session flow. For full custom receiver testing, register a test device + app at cast.google.com/publish.

**Step 3: Commit**

```bash
git add web/cast-receiver.html web/js/cast.js
git commit -m "feat(cast): add CAF receiver integration with custom message namespace"
```

---

### Task 10: Integration Testing & Polish

**Files:**
- Modify: `web/js/cast.js` (edge cases)
- Modify: `web/js/app.js` (edge cases)

**Step 1: Handle stream removal while casting**

In `app.js`, when a stream is removed (the existing `removeStream` flow), check if it's the currently cast stream and stop casting:

```javascript
// In the stream removal handler:
var castState = PlexdCast.getState();
if (castState.active && castState.streamId === removedStreamId) {
    PlexdCast.stopCasting();
    showMessage('Cast stopped — stream was removed');
}
```

**Step 2: Handle page unload**

In `cast.js`, add cleanup:

```javascript
window.addEventListener('beforeunload', function() {
    if (castState.active) {
        stopCasting();
    }
});
```

**Step 3: Disable cast button when no streams**

In the `PlexdCast.onStateChange` listener, also check stream count:

```javascript
var castBtn = document.getElementById('cast-btn');
if (castBtn) {
    var hasStreams = PlexdStream.getAllStreams().length > 0;
    castBtn.disabled = !state.available || !hasStreams;
}
```

**Step 4: Test each cast path manually**

- **Chrome Cast**: Open in Chrome, click cast button, verify device picker appears
- **Safari AirPlay**: Open in Safari, click cast button, verify AirPlay picker appears
- **Presentation API**: Open in Chrome/Edge with a second display, verify presentation starts
- **Shift+P**: Verify keyboard shortcut works in both normal and fullscreen modes
- **Stream badge**: Verify 📺 badge appears on cast stream wrapper
- **Status bar**: Verify blue bar appears/disappears with cast state
- **Disconnect**: Verify clicking status bar or pressing Shift+P again disconnects

**Step 5: Commit**

```bash
git add web/js/cast.js web/js/app.js
git commit -m "feat(cast): add edge case handling — stream removal, page unload, button state"
```

---

### Task 11: Update Design Doc + CLAUDE.md

**Files:**
- Modify: `docs/plans/2026-03-01-cast-mirroring-design.md` (update key binding to Shift+P)
- Modify: `CLAUDE.md` (add cast section to architecture docs)

**Step 1: Fix design doc key binding**

Update the keyboard section from `P` / `Shift+P` to `Shift+P` / `Cmd+Shift+P`:

```markdown
**Keyboard:**
- `Shift+P` — Cast/disconnect toggle for selected stream (P alone = PiP)
- Switch cast to different stream: disconnect + select new stream + Shift+P
```

**Step 2: Add cast section to CLAUDE.md**

Add under the existing architecture docs:

```markdown
### Casting (AirPlay / Chromecast / Presentation API)

**Architecture:** PlexdCast IIFE module (`cast.js`) abstracts three protocols. Auto-detects available path: Chrome Cast SDK → Safari AirPlay → Presentation API fallback.

**Key binding:** `Shift+P` — toggle cast for selected stream. `P` remains PiP.

**Cast receiver:** `web/cast-receiver.html` — lightweight page with HLS.js, runs on Cast device or second screen. JSON message protocol for control commands.

**Server:** `/api/server-info` returns `{ ip, port }` for LAN URL rewriting (Chromecast can't reach localhost).

**Grid casting:** Not in-app — use macOS Screen Mirroring (Control Center). Can run simultaneously with single-stream Cast.
```

**Step 3: Commit**

```bash
git add docs/plans/2026-03-01-cast-mirroring-design.md CLAUDE.md
git commit -m "docs: update cast design (Shift+P binding) and add cast section to CLAUDE.md"
```

---

## Task Dependency Graph

```
Task 1 (server endpoint) ─────┐
                               ├──▶ Task 7 (wire into app) ──▶ Task 8 (UI) ──▶ Task 10 (polish)
Task 2 (receiver page) ───────┤                                                       │
                               │                                                       ▼
Task 3 (cast.js skeleton) ────┤                                                 Task 11 (docs)
    │                          │
    ├──▶ Task 4 (Chrome Cast)  │
    ├──▶ Task 5 (AirPlay)     ─┘
    ├──▶ Task 6 (Presentation)
    └──▶ Task 9 (CAF receiver)
```

Tasks 1, 2, 3 can run in parallel. Tasks 4, 5, 6 can run in parallel after Task 3. Task 7 needs 1-6 done. Task 8 after 7. Task 9 after 2. Task 10 after 8+9. Task 11 after 10.
