# Plexd

**Multiplex Video Stream Display System**

Plexd enables simultaneous playback of multiple video streams in a single application window with intelligent grid layout that maximizes viewing area.

## Features

### Core
- **Multi-Stream Playback**: Display multiple video streams simultaneously
- **Smart Grid Layout**: Automatically arranges videos to maximize display area
- **HLS Support**: Native .m3u8 streaming with auto-max quality selection
- **Responsive Design**: Adapts to any screen size, optimized for iPad and desktop

### Playback Controls
- **Seek Bar**: Drag to any position in the video
- **Time Display**: Shows current time / duration
- **Skip Buttons**: Jump forward/back 10 seconds
- **Picture-in-Picture**: Pop out any video to floating window
- **Fullscreen**: Browser-fill mode (click) or true fullscreen (double-click)

### Audio
- **Audio Focus Mode**: Unmuting one stream automatically mutes others
- **Per-Stream Mute**: Individual mute controls

### Navigation
- **Keyboard Navigation**: Arrow keys to select streams in grid
- **Stream Selection**: Visual highlight on selected stream
- **Drag to Reorder**: Drag streams to rearrange grid position

### Management
- **Queue System**: Queue videos to play later, "Play All" to load queue
- **History**: Track recently played streams, click to replay
- **Save Combinations**: Save current stream sets with custom names
- **Clear All**: Remove all streams at once

### Stream Info
- **Resolution Display**: Shows video dimensions
- **State Indicator**: Loading, playing, paused, error status
- **URL Display**: Shows truncated stream URL

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| Arrow Keys | Navigate between streams |
| Enter | Toggle fullscreen on selected |
| Space | Play/pause selected (or all) |
| M | Mute selected (or all) |
| P | Picture-in-Picture |
| A | Toggle audio focus mode |
| I | Toggle stream info overlay |
| F | True fullscreen (when in browser-fill) |
| Delete | Remove selected stream |
| Ctrl+S | Save stream combination |
| Esc | Exit fullscreen / deselect |

## Quick Start

### Web Application

1. Open `web/index.html` in a modern browser (or serve via local server)
2. Enter a video stream URL in the input field
3. Click "Add Stream" to add it to the grid
4. Hover over streams to see controls
5. Use keyboard or mouse to navigate

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

## Project Structure

```
Plexd/
├── CLAUDE.md          # Development guidelines
├── README.md          # This file
├── HANDOFF.md         # Technical handoff notes
├── web/               # Web application
│   ├── index.html     # Main entry
│   ├── css/
│   │   └── plexd.css  # All styles
│   └── js/
│       ├── app.js     # Main app logic, queue, history
│       ├── grid.js    # Smart grid layout engine
│       └── stream.js  # Stream manager, controls, playback
└── extension/         # Browser extension
    ├── manifest.json  # Extension config (Manifest V3)
    ├── popup.html     # Extension popup UI
    ├── popup.js       # Popup logic
    ├── content.js     # Video detection script
    └── background.js  # Service worker
```

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   Plexd App                      │
├──────────────┬──────────────┬───────────────────┤
│    Header    │   Sidebar    │                   │
│  - URL Input │  - Queue     │                   │
│  - Controls  │  - History   │    Video Grid     │
│  - Stats     │              │                   │
├──────────────┴──────────────┤   - Streams       │
│                             │   - Controls      │
│      PlexdApp (app.js)      │   - Seek bars     │
│  - Stream management        │                   │
│  - Queue/History            ├───────────────────┤
│  - Keyboard handling        │  Shortcuts Bar    │
├─────────────────────────────┴───────────────────┤
│              PlexdGrid (grid.js)                │
│  - Layout calculation                           │
│  - Optimal grid dimensions                      │
│  - Position/size application                    │
├─────────────────────────────────────────────────┤
│             PlexdStream (stream.js)             │
│  - Video element creation                       │
│  - HLS.js integration                           │
│  - Playback controls                            │
│  - Selection & navigation                       │
└─────────────────────────────────────────────────┘
```

## Data Persistence

All data stored in localStorage:

| Key | Content |
|-----|---------|
| `plexd_streams` | Current active stream URLs |
| `plexd_queue` | Queued stream URLs |
| `plexd_history` | Last 50 played streams with timestamps |
| `plexd_combinations` | Saved stream sets with names |

## Performance Targets

- 4+ simultaneous streams on standard hardware
- 8+ streams on capable devices
- Sub-100ms layout recalculation
- Smooth playback without frame drops

## Browser Support

- Chrome 90+
- Firefox 88+
- Safari 14+
- Edge 90+
- iPad Safari

## Development

See [CLAUDE.md](CLAUDE.md) for coding standards:

- No duplicate files or functions
- Fix existing code rather than rewriting
- Efficient, performance-first implementations
- Single responsibility per module

## License

[License TBD]
