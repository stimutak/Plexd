# Plexd

**Multiplex Video Stream Display System**

Plexd enables simultaneous playback of multiple video streams in a single application window with intelligent grid layout that maximizes viewing area.

## Features

### Core
- **Multi-Stream Playback**: Display multiple video streams simultaneously
- **Smart Grid Layout**: Automatically arranges videos to maximize display area
- **Tetris Layout Mode**: Intelligent packing based on video aspect ratios
- **HLS Support**: Native .m3u8 streaming with auto-max quality selection
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
- **🔇 Mute All**: Mute/unmute all streams at once
- **🎧 Audio Focus**: Unmuting one stream automatically mutes others
- **👁 Clean Mode**: Hide all per-stream controls for distraction-free viewing
- **⛶ Global Fullscreen**: Fullscreen the entire grid view

### Navigation
- **Keyboard Navigation**: Arrow keys to select streams in grid
- **Stream Selection**: Visual highlight on selected stream
- **Drag to Reorder**: Drag streams to rearrange grid position

### Management
- **Queue System**: Queue videos to play later, "Play All" to load queue
- **History**: Track recently played streams, click to replay
- **Save Combinations**: Save current stream sets with custom names
- **Export/Import**: Share stream sets via file (AirDrop compatible)

### Stream Info
- **Resolution Display**: Shows video dimensions
- **State Indicator**: Loading, playing, paused, error status
- **URL Display**: Shows truncated stream URL

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Arrow Keys | Navigate between streams |
| Enter/Z | Toggle fullscreen on selected |
| Space | Play/pause selected (or all) |
| M | Mute selected (or all) |
| P | Picture-in-Picture |
| A | Toggle audio focus mode |
| I | Toggle stream info overlay |
| F | True fullscreen (browser API) |
| T | Toggle Tetris layout mode |
| V | Cycle view modes (All → 1★ → 2★ → ... → 5★) |
| G | Cycle rating on selected stream |
| 1-5 | Set rating directly on selected stream |
| 0 | Clear rating on selected stream |
| Delete | Remove selected stream |
| Ctrl+S | Save stream combination |
| Esc | Exit fullscreen / deselect |
| ? | Toggle keyboard shortcuts hint |

## Quick Start

### Web Application

1. Open `web/index.html` in a modern browser (or serve via local server)
2. Enter a video stream URL in the input field
3. Click "Add Stream" to add it to the grid
4. Tap the ☰ hamburger menu (top-right) to show header controls
5. Use keyboard or touch to navigate

### iPad Setup

1. Open the app URL in Safari
2. Tap Share → "Add to Home Screen"
3. Launch from home screen for fullscreen PWA experience
4. Tap ☰ to reveal controls, tap again to hide

### Supported Stream Types

**Works:**
- Direct video URLs (MP4, WebM, OGG)
- HLS streams (.m3u8) - auto-selects highest quality
- DASH streams (.mpd) - with browser support
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

## Deployment

### Vercel

The project includes `vercel.json` for easy deployment:

```bash
vercel deploy
```

### Local Server

```bash
cd web
python -m http.server 8000
# or
npx serve .
```

## Project Structure

```
Plexd/
├── CLAUDE.md          # Development guidelines
├── README.md          # This file
├── vercel.json        # Vercel deployment config
├── web/               # Web application
│   ├── index.html     # Main entry
│   ├── css/
│   │   └── plexd.css  # All styles
│   └── js/
│       ├── app.js     # Main app logic, queue, history, ratings
│       ├── grid.js    # Smart grid layout engine
│       └── stream.js  # Stream manager, controls, playback
└── extension/         # Browser extension
    ├── manifest.json  # Extension config (Manifest V3)
    ├── popup.html     # Extension popup UI
    ├── popup.js       # Popup logic
    ├── content.js     # Video detection script
    └── background.js  # Service worker
```

## Data Persistence

All data stored in localStorage:

| Key | Content |
|-----|---------|
| `plexd_streams` | Current active stream URLs |
| `plexd_queue` | Queued stream URLs |
| `plexd_history` | Last 50 played streams with timestamps |
| `plexd_combinations` | Saved stream sets with names |
| `plexd_ratings` | Stream ratings (URL → 1-5) |

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
