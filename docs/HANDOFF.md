# Session Handoff

## Changes Made

### Bug Eye Mode
- Now a true toggle: B to enter, B again to exit (no more shuffle)
- Copies positioned in a ring around center instead of scattered randomly
- Works in fullscreen without needing Esc (which exits fullscreen first)

### Slot Keys (1-9) Double-Tap Fix
- Fixed: double-tap was both assigning AND filtering
- Now uses timeout-based detection: single tap waits 300ms before assigning
- Double-tap cancels pending assign and only filters

### Random Seek (/ key) Fix
- Improved duration detection for HLS streams (checks hls.js first)
- Simplified random calculation (was overly complex segment-based)
- Added console.log for debugging: `[Random Seek] Range: X-Ys, Position: Zs`

### Drag Reordering Fix
- Added `e.stopPropagation()` to stream drop handler
- Prevents app-level file drop handler from interfering

### UI Fixes
- Shortcuts hint bar now has `z-index: 100` to stay above streams
- Set list shows file sizes and delete button for stored local files

## Files Modified
- `web/js/app.js` - Bug eye toggle, slot key timeout, random seek
- `web/js/stream.js` - Random seek duration detection, drag fix
- `web/css/plexd.css` - Shortcuts z-index
- `web/index.html` - Version bump to v=25
- `docs/keyboard-shortcuts.md` - Updated Bug Eye description

## Known State
- Server running on port 8000
- All features tested and working

## Next Steps (if any)
- Monitor random seek console output if issues persist
- Consider adding shuffle feature back as separate key if wanted
