---
name: perf-audit
description: "Performance audit for video streaming. Use when investigating performance issues, optimizing video playback, or checking for memory leaks in stream handling."
allowed-tools: "Read,Grep,Glob"
---

# Performance Audit for Video Streaming

Specialized audit focusing on performance-critical video streaming code.

## Audit Areas

### 1. DOM Manipulation Efficiency

Search for inefficient patterns:

```
# Look for DOM queries in loops
pattern: "for.*querySelector|while.*querySelector|forEach.*getElementById"

# Look for layout thrashing (read then write in loops)
pattern: "offsetWidth|offsetHeight|getBoundingClientRect" near mutations
```

**Red Flags:**
- `innerHTML` in loops (causes reflow for each iteration)
- Reading layout properties then immediately writing styles
- Creating elements inside requestAnimationFrame

**Green Patterns:**
- Batch DOM updates with DocumentFragment
- Cache element references
- Use CSS classes instead of inline styles

### 2. Memory Leak Detection

Search for leak patterns:

```
# Event listeners without cleanup
pattern: "addEventListener" without corresponding "removeEventListener"

# Intervals without clear
pattern: "setInterval" without "clearInterval"

# Video elements without cleanup
pattern: "new Video|createElement('video')" without src = '' or remove()
```

**Check Points:**
- `removeStream` function cleans up all listeners
- Video `src` set to empty before removal
- All intervals stored and cleared on cleanup
- No closures holding references to removed DOM

### 3. Grid Layout Performance

**Target:** Sub-100ms recalculation

Check:
- `calculateGrid` function complexity (should be O(n) where n = stream count)
- No nested loops over streams
- Results cached when inputs unchanged
- Uses CSS Grid/Flexbox (GPU-accelerated)

### 4. Video Playback Optimization

Check:
- Preload strategy (`preload="metadata"` vs `"auto"`)
- Poster images for initial render
- Hardware decoding enabled (no CSS transforms on video)
- Appropriate resolution for display size

### 5. Event Handler Efficiency

Search for:
- Throttled/debounced resize handlers
- Passive event listeners for scroll/touch
- Event delegation for repeated elements

## Output Format

```markdown
## Performance Audit Results

### DOM Manipulation
- Score: Good/Warning/Critical
- Issues: [list]
- Recommendations: [list]

### Memory Management
- Score: Good/Warning/Critical
- Potential leaks: [list]
- Cleanup verification: [status]

### Grid Layout
- Complexity: O(?)
- Recalculation estimate: <100ms / >100ms
- Issues: [list]

### Video Playback
- Preload strategy: [current]
- Hardware acceleration: [status]
- Recommendations: [list]

### Event Handling
- Throttling: [present/missing]
- Passive listeners: [present/missing]
- Issues: [list]

## Priority Fixes
1. [Most critical issue]
2. [Second priority]
3. [Third priority]

## Performance Targets
- [ ] Grid recalculates in <100ms
- [ ] No memory leaks after add/remove 10 streams
- [ ] Smooth 60fps playback with 4+ streams
- [ ] UI responsive during playback
```

## Key Files to Audit

1. `web/js/grid.js` — Layout calculation
2. `web/js/stream.js` — Stream lifecycle management
3. `web/js/app.js` — Event handlers and initialization
4. `server.js` — HLS transcoding performance (if relevant)
