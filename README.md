# Plexd

**Multiplex Video Stream Display System**

Plexd enables simultaneous playback of multiple video streams in a single application window with intelligent grid layout that maximizes viewing area.

## Features

- **Multi-Stream Playback**: Display multiple video streams simultaneously
- **Smart Grid Layout**: Automatically arranges videos to maximize display area and minimize wasted space
- **URL-Based Input**: Add streams by entering their URLs
- **Responsive Design**: Adapts to any screen size, optimized for iPad and desktop
- **Cross-Platform**: Web-based application works on any modern browser

## Quick Start

### Web Application

1. Open `web/index.html` in a modern browser
2. Enter a video stream URL in the input field
3. Click "Add Stream" to add it to the grid
4. Repeat for additional streams
5. The grid automatically optimizes layout

### Supported Stream Types

**Works:**
- Direct video file URLs (MP4, WebM, OGG)
- HLS streams (.m3u8)
- DASH streams (.mpd) - with browser support
- Public video URLs without authentication

**Does NOT work (currently):**
- Webpage URLs (YouTube, Vimeo, etc.) - these are HTML pages, not video files
- DRM-protected streams (Netflix, Hulu, Disney+, etc.)
- Login-required video URLs (authentication doesn't transfer)

## Browser Extension

The Plexd browser extension lets you send videos from any webpage directly to Plexd.

### Installation (Chrome/Edge/Brave)

1. Open `chrome://extensions` (or `edge://extensions`)
2. Enable "Developer mode" (toggle in top right)
3. Click "Load unpacked"
4. Select the `extension/` folder

### Usage

1. Navigate to any page with videos
2. Click the Plexd extension icon
3. See detected videos listed
4. Select videos and click "Send to Plexd"
5. Videos appear in your Plexd grid

### What the Extension Detects

- `<video>` elements with src attributes
- `<source>` elements inside videos
- YouTube/Vimeo embeds (shows embed info)
- Videos in data attributes

*Note: DRM-protected streams still won't play - the extension finds the URL but Plexd can't decrypt the content.*

## Architecture

```
┌─────────────────────────────────────────────┐
│                  Plexd UI                   │
├─────────────────────────────────────────────┤
│  ┌─────────┐  ┌─────────┐  ┌─────────┐     │
│  │ Stream 1│  │ Stream 2│  │ Stream 3│     │
│  └─────────┘  └─────────┘  └─────────┘     │
│  ┌─────────┐  ┌─────────┐  ┌─────────┐     │
│  │ Stream 4│  │ Stream 5│  │ Stream 6│     │
│  └─────────┘  └─────────┘  └─────────┘     │
├─────────────────────────────────────────────┤
│              Smart Grid Engine              │
│  - Layout optimization                      │
│  - Aspect ratio handling                    │
│  - Dynamic reflow                           │
├─────────────────────────────────────────────┤
│              Stream Manager                 │
│  - URL validation                           │
│  - Playback control                         │
│  - Error handling                           │
└─────────────────────────────────────────────┘
```

## Smart Grid Algorithm

The layout engine optimizes for:

1. **Maximum Video Area**: Fills available space efficiently
2. **Minimal Letterboxing**: Reduces black bars around videos
3. **Minimal Gaps**: Tight arrangement without wasted space
4. **Uniform Appearance**: Consistent sizing when possible

### Layout Strategy

- For uniform aspect ratios: Equal-sized grid cells
- For mixed ratios: Row-based grouping with similar ratios
- Dynamic recalculation on window resize or stream add/remove

## Performance

Target specifications:
- 4+ simultaneous streams on standard hardware
- 8+ streams on capable devices
- Sub-100ms layout updates
- Smooth playback without frame drops

## Platform Support

### Web (Current)
- Chrome, Firefox, Safari, Edge (latest versions)
- iPad Safari (primary mobile target)
- Any WebKit/Blink-based browser

### iOS Native (Planned)
- iPadOS 15+
- SwiftUI + AVFoundation
- QuickTime integration potential

## Project Structure

```
Plexd/
├── CLAUDE.md       # Development guidelines
├── README.md       # This file
├── web/            # Web application
│   ├── index.html  # Main entry
│   ├── css/        # Styles
│   └── js/         # Application logic
├── extension/      # Browser extension
│   ├── manifest.json
│   ├── popup.html/js
│   ├── content.js  # Video detection
│   └── background.js
├── ios/            # iOS app (future)
└── docs/           # Documentation
```

## Development

See [CLAUDE.md](CLAUDE.md) for development guidelines and coding standards.

### Key Principles

- No duplicate files or functions
- Fix existing code rather than rewriting
- Efficient, well-reasoned implementations
- Performance-first design

## License

[License TBD]

## Contributing

Contributions welcome. Please read CLAUDE.md before submitting changes.
