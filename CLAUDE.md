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
├── server.js           # Node server with remote relay + file storage + HLS transcoding
├── uploads/            # Server-side video storage (gitignored)
│   ├── hls/            # HLS transcoded segments
│   └── metadata.json   # File metadata
├── scripts/
│   └── autostart.sh    # MBP autostart with Chrome debugging
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
│   │   ├── stream.js   # Stream management
│   │   ├── app.js      # Main application logic
│   │   └── remote.js   # Remote control logic
│   └── assets/         # Icons, images
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
- Videos auto-transcode to HLS in background after upload
- Uses h264_videotoolbox (Apple Silicon hardware) with libx264 fallback
- Queue system limits to 4 concurrent transcodes (configurable: `MAX_CONCURRENT_TRANSCODES`)
- Original files preserved - delete manually via HLS Manager (`/hls-manager.html`)
- Client polls `/api/files/transcode-status` and swaps to HLS URL when ready
- Disk space checked before transcoding (min 500MB required)

## Prohibited Practices

- Creating duplicate utility files (e.g., `utils.js` AND `helpers.js`)
- Writing wrapper functions that just call another function
- Adding "improved" versions of existing functions (fix the original)
- Over-engineering simple solutions
- Adding dependencies without clear justification
- Speculative features not in current requirements

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

1. **stream.js `propagateKeys`** - Keys that need app-level handling must be in this regex. They get dispatched to document via synthetic event.

2. **Capture-phase handlers** - Use `addEventListener(..., true)` for highest priority. Essential for Bug Eye/Mosaic to close before fullscreen exit.

3. **Browser Escape behavior** - Cannot be overridden. Browser exits fullscreen synchronously BEFORE any JS handler runs. Design around this (overlay stays visible, second Escape closes it).

4. **forceOff pattern** - Toggle functions that can be called from multiple places should use:
   ```javascript
   function toggleMode(forceOff = false) {
       if (forceOff || modeIsOn) { /* turn off */ return; }
       /* turn on */
   }
   ```

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

### HLS Transcoding System

**Architecture:**
- Queue-based system prevents CPU overload (`transcodeQueue`, `activeTranscodes`)
- `MAX_CONCURRENT_TRANSCODES = 4` for M4 Max (adjust per machine)
- Jobs tracked in `transcodingJobs` object with status/progress

**Encoder Fallback:**
```javascript
// Hardware first, software fallback
runTranscode(fileId, useSoftwareEncoder = false)
// If h264_videotoolbox fails, auto-retries with libx264
```

**Key APIs:**
- `POST /api/files/upload` - Upload, returns fileId, starts transcode
- `GET /api/files/transcode-status?fileId=X` - Poll for progress
- `GET /api/hls/list` - List all files with transcode status
- `DELETE /api/hls/delete/:id` - Delete HLS only (keep original)
- `DELETE /api/hls/delete-original/:id` - Delete original only (keep HLS)

**Helper Function:**
```javascript
deleteFileAndHLS(fileId, { deleteOriginal, deleteHLS, cancelTranscode })
```
Use this instead of inline deletion code (DRY pattern).
