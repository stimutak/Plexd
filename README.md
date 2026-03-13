# Plexd

**Multiplex Video Stream Display System**

Plexd enables simultaneous playback of multiple video streams in a single application window with intelligent grid layout that maximizes viewing area.

## Features

### Core
- **Multi-Stream Playback**: Display multiple video streams simultaneously
- **Smart Grid Layout**: Automatically arranges videos to maximize display area
- **Tetris Layout Mode**: Intelligent packing based on video aspect ratios
- **HLS Support**: Native .m3u8 streaming with auto-max quality selection
- **HLS CORS Proxy**: Server-side proxy for external HLS streams (bypasses CORS restrictions)
- **Stream Downloads**: Download any stream as MP4 (local files, HLS remux via ffmpeg, external streams)
- **Session Persistence**: Streams auto-save and restore across page reloads
- **Responsive Design**: Adapts to any screen size, optimized for iPad and desktop

### Rating System
- **Star Ratings (1-5)**: Rate streams to organize and filter content
- **Rating Indicator**: Visual badge shows current rating on each stream
- **View Filtering**: Show only streams with specific ratings (All, 1★, 2★, 3★, 4★, 5★)
- **Persistent Ratings**: Ratings saved per URL across sessions

### iPad / Touch Support
- **Slide-Down Header**: Tap hamburger menu to reveal controls, hides for clean viewing
- **Touch-Optimized Buttons**: Large touch targets for all controls
- **Global Controls**: Pause all, mute all, audio focus, clean mode, fullscreen
- **PWA Support**: Add to home screen for app-like experience

### Playback Controls
- **Seek Bar**: Drag to any position in the video
- **Time Display**: Shows current time / duration
- **Skip Buttons**: Jump forward/back 10 seconds
- **Picture-in-Picture**: Pop out any video to floating window
- **Fullscreen**: Browser-fill mode (click) or true fullscreen (double-click)

### Global Controls (Header)
- **⏸ Pause/Play All**: Toggle playback for all streams
- **🔇 Mute All**: Toggle mute for all streams
- **🎧 Audio Focus**: Toggle audio focus mode (see Audio System below)
- **👁 Clean Mode**: Hide all per-stream controls for distraction-free viewing
- **⛶ Global Fullscreen**: Fullscreen the entire grid view
- **🔀 Random Seek All**: Jump all streams to random positions

### Audio System

Plexd has a flexible audio system with two modes: **Audio Focus** and **Independent**.

#### Audio Focus Mode (🎧 ON - Default)
When Audio Focus is enabled (headphone icon highlighted):
- **Unmuting one stream automatically mutes all others**
- Only one stream can have audio at a time
- Useful for quickly switching audio between streams
- Click a stream's mute button (🔊) to hear that stream; others go silent

#### Independent Mode (🔈 OFF)
When Audio Focus is disabled (speaker icon):
- **Streams can be unmuted independently**
- Multiple streams can play audio simultaneously
- Useful for ambient/background viewing of multiple sources
- Click mute buttons to toggle each stream individually

#### Audio Controls

| Control | Location | Behavior |
|---------|----------|----------|
| 🔊/🔇 per-stream | Stream overlay | Toggle mute for that stream (audio focus applies) |
| 🎧/🔈 global | Header bar | Toggle audio focus mode ON/OFF |
| M key (with selection) | Keyboard | Toggle mute on selected stream |
| M key (no selection) | Keyboard | Toggle mute ALL streams |
| A key | Keyboard | Toggle audio focus mode |

#### Important Notes
- **Streams start muted** - Browser autoplay policy requires videos to start muted
- **Audio focus state persists** - Your preference is saved across sessions
- **Mute button tooltip** - Hover to see current mode (focus ON/OFF)
- **M key without selection** - Now toggles (mute all ↔ unmute all), not just mute

### Projector / External Display
- **Projector Viewer** (`Shift+F`): Opens a single clean popup window showing the selected stream
- **Auto-Follow**: Switch streams in the main UI — the projector window follows automatically
- **External Display**: Drag the popup to your HDMI-connected projector/TV, double-click for fullscreen
- **Independent from Cast**: Works via wired HDMI, separate from wireless Cast (`Shift+P`)

### Navigation
- **Keyboard Navigation**: Arrow keys to select streams in grid
- **Stream Selection**: Visual highlight on selected stream
- **Drag to Reorder**: Drag streams to rearrange grid position

### Management
- **Queue System**: Queue videos to play later, "Play All" to load queue
- **History**: Track recently played streams, click to replay
- **Save Combinations**: Save current stream sets with custom names
- **Export/Import**: Share stream sets via file (AirDrop compatible)
- **Per-Stream Download**: Download button on each stream's hover controls (⬇)

### Stream Info
- **Resolution Display**: Shows video dimensions
- **State Indicator**: Loading, playing, paused, error status
- **URL Display**: Shows truncated stream URL

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Arrow Keys | Navigate between streams (in grid/coverflow) |
| Enter/Z | Toggle focused fullscreen on selected stream |
| Space | Play/pause selected stream (or toggle all if none selected) |
| M | Toggle mute on selected stream (or toggle all if none selected) |
| A | Toggle audio focus mode (🎧 ON / 🔈 OFF) |
| P | Picture-in-Picture for selected stream |
| I | Toggle stream info overlay |
| F | Toggle true fullscreen (grid view, hides browser chrome) |
| Shift+F | Toggle projector viewer (external display popup) |
| T | Toggle Tetris layout mode |
| V | Cycle view modes (All → 1★ → 2★ → ... → 9★) |
| G | Cycle rating on selected stream |
| Q | Random seek on selected/focused stream |
| Shift+Q | Random seek ALL streams |
| 0 | Show all streams (exit rating filter) |
| 1-9 (in grid) | Filter by rating slot |
| 1-9 (in focused fullscreen) | Assign rating to focused stream |
| Shift+1-9 | Opposite action (assign in grid, filter in fullscreen) |
| Shift+0 | Clear rating on selected/focused stream |
| Delete/Backspace | Remove selected stream |
| Ctrl+S | Save stream combination |
| Esc | Exit fullscreen / deselect / clear state |
| ? | Toggle keyboard shortcuts hint |

## Quick Start

### Using Plexd Chrome App (Recommended)

1. Double-click `~/Applications/Plexd Chrome.app`
   - Auto-starts the Node.js server if not running
   - Opens Chrome with persistent Plexd profile (history, saved sets, extension)
   - Restores your last session automatically

### Manual Setup

1. Start the server: `node --watch server.js 8080`
2. Open `http://localhost:8080` in Chrome
3. Enter a video stream URL in the input field
4. Click "Add Stream" or drag-and-drop video files

### iPad Setup

1. Open the app URL in Safari
2. Tap Share → "Add to Home Screen"
3. Launch from home screen for fullscreen PWA experience
4. Tap ☰ to reveal controls, tap again to hide

### Supported Stream Types

**Works:**
- Direct video URLs (MP4, WebM, OGG)
- HLS streams (.m3u8) - auto-selects highest quality, external streams proxied through server
- DASH streams (.mpd) - with browser support
- Drag-and-drop local video files (auto-upload + HLS transcode)
- Public video URLs without authentication

**Does NOT work:**
- Webpage URLs (YouTube, Vimeo pages) - use extension to extract
- DRM-protected streams (Netflix, Hulu, Disney+)
- Login-required URLs

## Browser Extension

The Plexd extension detects video URLs on any webpage and sends them to Plexd.

### Installation (Chrome/Edge/Brave)

1. Open `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked"
4. Select the `extension/` folder

### Usage

1. Navigate to any page with videos
2. Click the Plexd extension icon
3. See detected video URLs
4. Select and click "Send to Plexd"

### What It Detects

- `<video>` elements with src
- `<source>` elements
- Network requests for .m3u8, .mpd, .mp4
- Embedded video players

## Server

Plexd runs a Node.js server that provides:

- **Static file serving** for the web app
- **Remote control relay** (`/api/remote/*`) for iPhone PWA
- **File upload & storage** (`/api/files/*`) with deduplication
- **HLS transcoding** (`/api/hls/*`) using hardware-accelerated h264_videotoolbox (libx264 fallback)
- **HLS CORS proxy** (`/api/proxy/hls`) for external streams blocked by CORS
- **HLS-to-MP4 download** (`/api/proxy/hls/download`) using ffmpeg remux (`-c copy -bsf:a aac_adtstoasc`)

### Running the Server

```bash
# Development (auto-restart on changes)
node --watch server.js 8080

# Or use the autostart script (starts server + Chrome with debug port)
./scripts/autostart.sh

# Or use the macOS app (~/Applications/Plexd Chrome.app)
```

### Deployment

Vercel deployment available for static-only mode:

```bash
vercel deploy
```

## Project Structure

```
Plexd/
├── CLAUDE.md           # Development guidelines
├── README.md           # This file
├── server.js           # Node server (remote relay, file storage, HLS proxy/transcode)
├── vercel.json         # Vercel deployment config
├── uploads/            # Server-side video storage (gitignored)
│   ├── hls/            # HLS transcoded segments
│   └── metadata.json   # File metadata
├── scripts/
│   ├── autostart.sh    # MBP autostart (server + Chrome + extension)
│   └── chrome-test.js  # Chrome remote debugging test runner
├── web/                # Web application
│   ├── index.html      # Main entry
│   ├── remote.html     # iPhone remote control PWA
│   ├── hls-manager.html # HLS transcode management UI
│   ├── css/
│   │   ├── plexd.css   # Main app styles
│   │   └── remote.css  # Remote control styles
│   └── js/
│       ├── app.js      # Main app logic, queue, history, downloads, ratings
│       ├── grid.js     # Smart grid layout engine
│       ├── stream.js   # Stream manager, controls, HLS proxy, playback
│       └── remote.js   # Remote control logic
├── extension/          # Chrome extension (Manifest V3)
│   ├── manifest.json   # Extension config
│   ├── popup.html      # Extension popup UI
│   ├── popup.js        # Popup logic (send/queue to Plexd)
│   ├── content.js      # Video/stream detection (intercepts .m3u8/.mpd)
│   └── background.js   # Service worker (network request interception)
└── .chrome-profile/    # Persistent Chrome profile for Plexd (gitignored)
```

## Data Persistence

Session state auto-saves on every stream add, on page unload, and every 30 seconds. All data stored in localStorage:

| Key | Content |
|-----|---------|
| `plexd_streams` | Current active stream URLs (uses serverUrl when available) |
| `plexd_queue` | Queued stream URLs |
| `plexd_history` | Last 50 played streams with timestamps |
| `plexd_combinations` | Saved stream sets with names |
| `plexd_ratings` | Stream ratings (URL → 1-9) |
| `plexd_favorites` | Favorited stream URLs |
| `plexd_audio_focus` | Audio focus mode preference (true/false) |

## Stream Downloads

Every stream has a download button (⬇) in its hover controls. Download behavior depends on stream type:

| Stream Type | Download Method |
|-------------|----------------|
| Server file (original exists) | Direct download from `/api/files/<id>` |
| Server HLS (original deleted) | ffmpeg remux of HLS segments to MP4 |
| External HLS (.m3u8) | ffmpeg remux via server proxy |
| Blob URL (dropped file) | Direct blob download |
| Regular URL | Fetch with CORS proxy fallback |

The server-side download uses `ffmpeg -c copy -bsf:a aac_adtstoasc` to remux HLS segments into a streamable fragmented MP4 without re-encoding.

## Performance Targets

- 4+ simultaneous streams on standard hardware
- 8+ streams on capable devices
- Sub-100ms layout recalculation
- Smooth playback without frame drops

## Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+ (including iPad)
- Edge 90+

## Development

See [CLAUDE.md](CLAUDE.md) for coding standards:

- No duplicate files or functions
- Fix existing code rather than rewriting
- Efficient, performance-first implementations
- Single responsibility per module

## License

[License TBD]
