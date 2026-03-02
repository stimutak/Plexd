# Cast & Mirroring Design

**Date:** 2026-03-01
**Status:** Approved

## Goal

Cast a single selected stream from Plexd to an external display (TV, projector) via Chrome Cast, Safari AirPlay, or Presentation API. The Mac acts as a dual-screen controller while the TV plays the video fullscreen. For full grid casting, users use macOS Screen Mirroring (zero code needed). Both can run simultaneously (AirPlay mirror + Chromecast single stream).

## Architecture

```
┌──────────────────────┐                          ┌──────────────────────┐
│   Mac (Sender)       │    Cast/AirPlay/Pres.    │  TV/Projector        │
│                      │ ────────────────────────▶ │  (Receiver)          │
│  Plexd grid + controls│                          │  cast-receiver.html  │
│  PlexdCast module    │ ◀──────────────────────▶ │  Fullscreen video    │
│                      │   bidirectional messages  │                      │
└──────────────────────┘                          └──────────────────────┘
         │                                                  │
         └──────── Both fetch media via ───────────────────┘
                   /api/proxy/hls or /api/proxy/video
```

### Three Protocol Paths (auto-detected)

| Path | Detection | Single Stream | Control Channel |
|------|-----------|--------------|-----------------|
| **Chrome Cast** | `window.chrome && chrome.cast` | `CastSession.loadMedia(url)` | `CastSession.sendMessage()` |
| **Safari AirPlay** | `video.webkitShowPlaybackTargetPicker` | Native URL routing | None (use Remote app) |
| **Presentation API** | `navigator.presentation` | URL sent to receiver page | `PresentationConnection.send()` |

## Components

### 1. PlexdCast Module (`web/js/cast.js`) — NEW

IIFE module abstracting all three protocols:

```
PlexdCast
├── init()                    — Detect cast targets, load SDKs
├── getAvailability()         — { chrome: bool, airplay: bool, presentation: bool }
├── castStream(streamId)      — Start casting selected stream
├── stopCasting()             — End cast session
├── switchStream(streamId)    — Change which stream is on the TV
├── sendCommand(cmd, data)    — Play/pause/seek/volume to receiver
├── onStateChange(callback)   — Cast state events
└── getState()                — { active, mode, targetName, streamId }
```

**Protocol selection (automatic):**
```javascript
if (window.chrome && chrome.cast) → Chrome Cast SDK
else if (video.webkitShowPlaybackTargetPicker) → Safari AirPlay
else if (navigator.presentation) → Presentation API fallback
```

### 2. Cast Receiver Page (`web/cast-receiver.html`) — NEW

Minimal page for Cast devices / second screens:

- `<video>` element, fullscreen, black background
- HLS.js bundled for HLS stream playback
- Listens for JSON commands over cast connection
- Reports playback state back to sender
- Idle screen with Plexd logo when nothing playing

**Message protocol:**
```
Sender → Receiver:
  { cmd: "load",   url: "...", title: "..." }
  { cmd: "play" }  { cmd: "pause" }
  { cmd: "seek", time: 120.5 }  { cmd: "volume", level: 0.8 }

Receiver → Sender:
  { event: "loaded",     duration: 300 }
  { event: "timeupdate", time: 45.2 }
  { event: "state",      state: "playing"|"paused"|"buffering"|"error" }
  { event: "error",      message: "..." }
```

### 3. UI Changes

**Toolbar button:** Cast icon, grayed when unavailable, highlighted when active.

**Keyboard:**
- `Shift+P` — Cast/disconnect toggle for selected stream (`P` alone = PiP)
- Switch stream: disconnect + select new stream + Shift+P

**Cast status bar:** Thin bar at top of `.plexd-app`:
```
📺 Casting "scene-title" to Living Room TV
```

**Stream badge:** Cast icon on the wrapper of the stream currently being cast.

**No-targets hint:** "No cast devices found. Use macOS Screen Mirroring (Control Center → Screen Mirroring)."

### 4. Server Changes — MINIMAL

**One new endpoint:**
```javascript
GET /api/server-info → { ip: "192.168.x.x", port: 8080 }
```

Sender rewrites `localhost` URLs to LAN IP before sending to receiver (Chromecast can't reach localhost).

**Existing infrastructure reused as-is:**
- `/api/proxy/hls` — receiver fetches HLS through this
- `/api/proxy/video` — receiver fetches MP4 through this
- Static file serving — serves `cast-receiver.html`
- CORS headers — already `Access-Control-Allow-Origin: *`

### 5. `stream.js` Edit

Add `P` to `propagateKeys` regex (required for key to work in true fullscreen).

### 6. `index.html` Edit

Add `<script>` tags for `cast.js` and Google Cast SDK (conditional load).

## File Changes Summary

| File | Change | Type |
|------|--------|------|
| `web/js/cast.js` | PlexdCast module | **New** |
| `web/cast-receiver.html` | Receiver page | **New** |
| `web/js/app.js` | Cast button, P key, status UI | Edit |
| `web/js/stream.js` | `propagateKeys` regex | Edit |
| `web/index.html` | Script tags | Edit |
| `web/css/plexd.css` | Cast badge, status bar styles | Edit |
| `server.js` | `/api/server-info` endpoint | Edit |

## Scope

**In:** Single-stream casting (Cast + AirPlay + Presentation API). Dual-screen control. Stream switching. Status UI.

**Out:** Grid-view casting (use macOS Screen Mirroring). Multi-device casting. Audio-only casting.

## Chrome Cast Registration

Cast receiver app must be registered at https://cast.google.com/publish/ to get an Application ID. During development, use custom receiver on a registered test device.
