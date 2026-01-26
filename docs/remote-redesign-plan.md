# Plexd Remote Redesign Plan

## Executive Summary

The current iPhone remote has significant UX problems that make it difficult to use:
- **6 invisible tap zones** on the hero that users must memorize
- **5 different gesture systems** creating cognitive overload
- **Mode switching** (Controller/Triage) with unclear purpose
- **Undiscoverable features** (long-press Random)
- **Auto-hide controls** with no return indicator

This redesign simplifies everything while keeping the dark visual style.

---

## Core Design Principles

1. **No Hidden Interactions** - If there's an action, there's a visible button
2. **Thumb-First** - Most-used controls at bottom of screen
3. **One Gesture System** - Swipe left/right for navigation, that's it
4. **Always-Visible Rating** - No mode switching required
5. **Progressive Disclosure** - Advanced features in "More" sheet

---

## New Architecture

### Screen Layout (Top to Bottom)

```
┌─────────────────────────────────────────┐
│  [Audio]     Plexd     [●]              │  Header
├─────────────────────────────────────────┤
│                                         │
│         ┌───────────────────┐           │
│         │                   │           │
│         │   Video Preview   │           │  Hero (swipe only)
│         │                   │           │
│         │    ← 3 / 12 →     │           │  Stream indicator
│         └───────────────────┘           │
│                                         │
├─────────────────────────────────────────┤
│  Stream Title                 1:23/4:56 │  Info
│  ═══════════════════●────────────────── │  Progress
├─────────────────────────────────────────┤
│   [|◀]   [-30]   [▶||]   [+30]   [▶|]  │  Transport
├─────────────────────────────────────────┤
│  [✕][1][2][3][4][5][6][7][8][9]        │  Rating (always visible)
├─────────────────────────────────────────┤
│  [thumb][thumb][thumb][thumb]...        │  Thumbnails (scrollable)
├─────────────────────────────────────────┤
│  [🔀 Random]              [⋯ More]      │  Quick actions
└─────────────────────────────────────────┘
```

### Key Changes from Current Design

| Current | New |
|---------|-----|
| 6 tap zones on hero | Hero is passive (preview only) |
| 4 swipe directions | Swipe left/right only |
| Controller/Triage tabs | Single unified view |
| Hidden long-press | Visible "More" button |
| Rating hidden in Triage | Rating always visible |
| Focus button for fullscreen | Double-tap hero or fullscreen btn |

---

## Interaction Design

### Hero Section
- **Display**: Live video preview (synced with Mac)
- **Tap**: Single tap = open fullscreen viewer
- **Swipe Left/Right**: Navigate to prev/next stream
- **Visual**: Stream position indicator "← 3 / 12 →"
- **No hidden zones**: All controls via explicit buttons below

### Transport Controls
Five clearly-labeled buttons in a row:
1. **Previous Stream** (|◀) - Jump to previous stream
2. **Back 30s** (-30) - Seek backward
3. **Play/Pause** (▶/||) - Toggle playback (larger, center)
4. **Forward 30s** (+30) - Seek forward
5. **Next Stream** (▶|) - Jump to next stream

### Rating Strip
- **Always visible** (no mode switching)
- **Clear rating** (✕) + numbers 1-9
- **Color feedback**: Selected rating shows color (red→yellow→green→blue gradient)
- **Tap haptic**: Light feedback on selection

### Thumbnail Strip
- **Horizontal scroll**
- **Current stream highlighted** (blue border)
- **Rating badge** on each thumbnail
- **Tap to select** stream
- **No filter tabs** - Show all streams, sorted by rating optionally

### Quick Actions Row
Two buttons at the bottom:
1. **Random** - Random seek on current stream
2. **More** - Opens action sheet

### "More" Action Sheet
Opens from bottom with:
- Mute Stream (toggle)
- Mute All
- Pause All
- Random All Streams
- Clean Mode (toggle)
- Tetris Mode (toggle)
- Fullscreen Viewer
- Cancel

### Fullscreen Viewer
Simplified overlay:
- **Video fills screen**
- **Tap anywhere**: Toggle controls visibility
- **Swipe left/right**: Navigate streams
- **Swipe down**: Close viewer
- **Controls**: Title, progress, play/pause, prev/next

---

## Visual Design (Keeping Current Style)

### Colors (No Changes)
```css
--bg-primary: #000;
--bg-secondary: #111;
--bg-tertiary: #1a1a1a;
--accent: #0a84ff;

/* Rating gradient */
--rating-1: #ff453a;  /* Red */
--rating-5: #8ed158;  /* Yellow-Green */
--rating-9: #64d2ff;  /* Blue */
```

### Typography
- SF Pro (system font)
- Title: 15px semibold
- Time: 13px regular
- Buttons: 13-16px

### Touch Targets
- Minimum 44pt (Apple guideline)
- Transport buttons: 52×44
- Rating buttons: 36×44
- Thumbnails: 72×48

### Animations
- Button press: scale(0.95)
- Stream change: slide transition
- Sheet: slide up from bottom
- Haptics: light for taps, medium for actions

---

## State Management

### Simplified State
```javascript
state = {
    streams: [...],
    selectedStreamId: string,
    isViewerOpen: boolean,
    isMoreSheetOpen: boolean
}
```

### Removed State
- `currentMode` - No more mode switching
- `currentFilter` - No more filtering (show all)
- Complex gesture tracking

---

## Implementation Steps

### Phase 1: Simplify Layout
1. Remove mode tabs (Controller/Triage)
2. Make rating strip always visible
3. Add explicit Prev/Next stream buttons to transport
4. Add "More" button, remove long-press
5. Add stream position indicator to hero

### Phase 2: Simplify Gestures
1. Remove all hero tap zones
2. Keep only left/right swipe on hero
3. Single tap hero = open viewer
4. Simplify viewer to tap=toggle, swipe=navigate

### Phase 3: Polish
1. Add stream change animation
2. Improve rating button feedback
3. Add auto-scroll thumbnails to selected
4. Test on actual iPhone devices

---

## Removed Features

These features are removed for simplicity:
1. **Tap zones on hero** - Replaced with explicit buttons
2. **Mode switching** - Unified view
3. **Filter tabs** - Show all streams
4. **Long-press Random** - Replaced with "More" button
5. **Double-tap thumbnails** - Single tap selects
6. **Up/Down swipe on hero** - Only left/right
7. **Complex viewer zones** - Simple tap toggle

---

## Migration Notes

### For Existing Users
- All functions still available, just reorganized
- Rating works the same
- Stream navigation via buttons or swipe
- Advanced options in "More" sheet

### Backwards Compatibility
- Server API unchanged
- PWA manifest unchanged
- Service worker unchanged

---

## Success Criteria

1. **Discoverability**: New user can control playback in <10 seconds
2. **Rating Speed**: Rate a stream in <2 taps
3. **Navigation**: Switch streams in <1 tap or swipe
4. **No Memorization**: Zero hidden interactions to learn
5. **One-Hand Use**: All common actions reachable by thumb
