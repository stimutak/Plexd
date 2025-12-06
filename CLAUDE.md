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
├── web/                # Web application
│   ├── index.html      # Main entry point
│   ├── css/
│   │   └── plexd.css   # All styles (single file)
│   ├── js/
│   │   ├── grid.js     # Smart grid layout algorithm
│   │   ├── stream.js   # Stream management
│   │   └── app.js      # Main application logic
│   └── assets/         # Static assets if needed
├── ios/                # iOS application (future)
└── docs/               # Additional documentation
```

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
