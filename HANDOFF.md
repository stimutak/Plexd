# Plexd Technical Handoff

## Overview

Plexd is a multiplex video stream display system. This document provides technical context for future development.

## Current State

**Version**: Initial development complete
**Status**: Functional with core features implemented

## Architecture Summary

### Three Main Modules

1. **PlexdApp** (`web/js/app.js`)
   - Application controller
   - Event handling and keyboard shortcuts
   - Queue and history management
   - Stream combination save/load
   - Extension message handling

2. **PlexdStream** (`web/js/stream.js`)
   - Video element creation and lifecycle
   - HLS.js integration for .m3u8 streams
   - Playback controls (seek, mute, fullscreen, PiP)
   - Stream selection and grid navigation
   - Drag-and-drop reordering

3. **PlexdGrid** (`web/js/grid.js`)
   - Layout calculation algorithm
   - Optimal row/column determination
   - Position and size application
   - Efficiency scoring

### Data Flow

```
User Input → PlexdApp.addStream() → PlexdStream.createStream()
                                          ↓
                                   Video element created
                                          ↓
                                   PlexdGrid.calculateLayout()
                                          ↓
                                   DOM positions updated
```

### Extension Integration

```
Content Script (content.js) → Detects video URLs via fetch/XHR interception
                                          ↓
                            Stores in chrome.storage.local
                                          ↓
Popup (popup.js) → Reads detected URLs → Sends to Plexd via URL params
                                          ↓
PlexdApp → Reads URL params → Adds streams → Saves to localStorage
```

## Key Technical Decisions

### Stream Passing: URL Parameters with `|||` Separator
- URLs with commas broke comma-separated parsing
- Solution: Use `|||` as separator, URL-encode each stream

### Stream Persistence: localStorage on Plexd Page
- chrome.storage wasn't persisting reliably between popup opens
- Solution: Plexd page manages its own localStorage
- Extension sends new streams via URL params, Plexd accumulates

### CORS: No crossOrigin Attribute
- Setting `crossOrigin='anonymous'` caused preflight failures
- Solution: Don't set crossOrigin - let browser handle it

### Grid Navigation: Compute from DOM
- Module variable `gridCols` wasn't updating reliably
- Solution: `computeGridCols()` reads actual DOM positions via `getBoundingClientRect()`

### HLS Quality: Force Maximum
- Default HLS.js behavior caps to player size
- Solution: Set `capLevelToPlayerSize: false` and select `maxLevel` on manifest parse

## File Details

### web/js/app.js (Main Application)
- `init()` - Setup, load queue/history, connect callbacks
- `addStream(url)` - Create stream, add to DOM, save to history
- `handleKeyboard(e)` - All keyboard shortcuts
- Queue functions: `addToQueue`, `playFromQueue`, `playAllFromQueue`
- History functions: `addToHistory`, `clearHistory`, `loadHistory`
- Combination functions: `saveStreamCombination`, `loadStreamCombination`
- `togglePanel(panelId)` - Slide panels in/out

### web/js/stream.js (Stream Manager)
- `createStream(url, options)` - Creates video element with all controls
- `createControlsOverlay(streamId)` - Seek bar, buttons, time display
- `setupVideoEvents(stream)` - Event listeners for playback, seek, drag
- `toggleFullscreen/toggleTrueFullscreen` - Two fullscreen modes
- `togglePiP` - Picture-in-Picture API
- `computeGridCols()` - DOM-based grid detection
- `selectNextStream(direction)` - Grid-aware navigation
- `reorderStreams(draggedId, targetId)` - Drag-drop handling

### web/js/grid.js (Layout Engine)
- `calculateLayout(container, streams)` - Main entry point
- `findOptimalGrid(container, count)` - Tries all row/col combinations
- `buildGridLayout()` - Calculates positions and sizes
- `applyLayout()` - Updates DOM element positions

### web/css/plexd.css
- `.plexd-controls` - Bottom overlay with gradient
- `.plexd-seek-container` - Seek bar and time
- `.plexd-btn-row` - Control buttons
- `.plexd-panel` - Slide-out sidebar panels
- `.plexd-selected` - Stream selection highlight
- `.plexd-fullscreen` - Browser-fill mode

### extension/content.js
- Intercepts fetch() and XMLHttpRequest
- Detects .m3u8, .mpd, .mp4 URLs
- Stores in chrome.storage.local with page-specific key

### extension/popup.js
- Reads detected URLs from storage
- Finds Plexd tab (localhost matching)
- Sends streams via URL parameters

## Known Issues / TODO

1. **Grid Navigation Edge Cases**: When last row has fewer items, up/down behavior could be smoother

2. **Seek Bar on Live Streams**: Shows incorrect duration for live HLS streams

3. **Extension Icons**: Currently no icons (removed due to missing files)

4. **Mobile Touch**: Controls may need larger touch targets on mobile

5. **Stream Labels**: No way to add custom names to streams yet

## Potential Improvements

1. **Volume Slider**: Per-stream volume control instead of just mute

2. **Playback Speed**: 0.5x, 1x, 1.5x, 2x options

3. **Sync Playback**: Sync all streams to same timestamp

4. **Import/Export**: JSON export of stream sets

5. **Thumbnails**: Preview thumbnails for saved combinations

6. **Auto-Queue Mode**: Extension auto-adds detected videos without confirmation

7. **Stream Quality Selector**: Manual quality override for HLS

8. **Keyboard Shortcuts Modal**: Show all shortcuts in overlay

## Testing Notes

### Test Streams
```
# Big Buck Bunny (MP4)
https://commondatastorage.googleapis.com/gtv-videos-bucket/sample/BigBuckBunny.mp4

# HLS Test Stream
https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8
```

### Extension Testing
1. Load extension in developer mode
2. Navigate to page with video
3. Open extension popup
4. Check console for detected URLs

## Environment

- Vanilla JavaScript (no framework)
- HLS.js via CDN for streaming
- Chrome Extension Manifest V3
- No build process required

## Contacts

Developed with Claude Code assistance. See CLAUDE.md for development guidelines.
