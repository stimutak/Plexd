# iOS/iPad Considerations for Plexd

## Web-Based Approach (Current)

The web application is designed to work on iPad Safari with these considerations:

### Supported Features
- **Responsive Layout**: Adapts to iPad screen sizes (all models)
- **Touch-Friendly Controls**: Larger tap targets for touch interaction
- **playsInline**: Videos play inline without fullscreen takeover
- **Web App Capable**: Can be added to home screen as standalone app

### Limitations on iPad Safari

1. **Autoplay Restrictions**
   - Videos must be muted for autoplay to work
   - User interaction required to unmute
   - First video may require tap to start

2. **Simultaneous Playback**
   - Safari allows multiple video elements
   - Performance depends on iPad model
   - Expected: 4-6 streams on modern iPads
   - Older models may struggle with 4+ streams

3. **HLS Preference**
   - Safari prefers HLS (.m3u8) streams
   - MP4 files work but may buffer more
   - DASH not natively supported

4. **Memory Constraints**
   - iPads have limited memory
   - High-resolution streams may cause issues
   - Consider 720p or lower for many streams

### Tested Configurations

| iPad Model | Expected Streams | Resolution |
|------------|-----------------|------------|
| iPad Pro 2021+ | 8+ | 1080p |
| iPad Air 4+ | 6-8 | 720p-1080p |
| iPad 9th Gen | 4-6 | 720p |
| iPad Mini 6 | 4-6 | 720p |

## Native iOS App (Future)

If performance requirements exceed web capabilities, a native iOS app would provide:

### Advantages
- Direct AVFoundation access
- Better hardware acceleration
- Lower memory overhead per stream
- Background audio support
- Picture-in-Picture integration

### Proposed Architecture

```
┌─────────────────────────────────────┐
│           PlexdApp (SwiftUI)        │
├─────────────────────────────────────┤
│  ┌─────────────────────────────────┐│
│  │      GridLayoutView             ││
│  │  ┌────────┐  ┌────────┐        ││
│  │  │AVPlayer│  │AVPlayer│        ││
│  │  │ View 1 │  │ View 2 │        ││
│  │  └────────┘  └────────┘        ││
│  └─────────────────────────────────┘│
├─────────────────────────────────────┤
│         StreamManager               │
│  - URL validation                   │
│  - AVPlayerItem management          │
│  - Error handling                   │
├─────────────────────────────────────┤
│         GridLayoutEngine            │
│  - Same algorithm as web            │
│  - Swift port of grid.js            │
└─────────────────────────────────────┘
```

### Key Classes

```swift
// StreamManager.swift
class StreamManager: ObservableObject {
    @Published var streams: [VideoStream]

    func addStream(url: URL)
    func removeStream(id: UUID)
}

// VideoStream.swift
struct VideoStream: Identifiable {
    let id: UUID
    let url: URL
    let player: AVPlayer
    var aspectRatio: CGFloat
    var state: StreamState
}

// GridLayout.swift
struct GridLayout {
    static func calculate(
        containerSize: CGSize,
        streams: [VideoStream]
    ) -> [StreamPosition]
}
```

### QuickTime Integration

For local file playback via QuickTime:
- Use `AVURLAsset` for local files
- Support common formats: MOV, MP4, M4V
- File picker integration via DocumentPicker

### Minimum Requirements

- iPadOS 15.0+
- Xcode 14+
- Swift 5.7+

## Performance Testing

### Metrics to Track

1. **CPU Usage** - Keep under 80% at steady state
2. **Memory** - Monitor for leaks with many streams
3. **Frame Drops** - Target 0 drops at 30fps minimum
4. **Thermal State** - Avoid thermal throttling

### Testing Commands (Web)

Open Safari Developer Tools on Mac connected to iPad:
- Timeline: Profile rendering performance
- Memory: Watch for growth over time
- Network: Monitor stream bandwidth

## Recommendations

1. **Start with Web Version**
   - Test on target iPads
   - Measure actual stream limits
   - Gather user feedback

2. **Port to Native If**
   - Web performance insufficient
   - Need background playback
   - Advanced features required (PiP, AirPlay control)

3. **Hybrid Approach**
   - Keep web for cross-platform
   - Native for power users
   - Shared design language
