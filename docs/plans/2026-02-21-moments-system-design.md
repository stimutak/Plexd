# Moments System — Bookmarks Evolved

**Date:** 2026-02-21
**Status:** Approved for implementation
**Approach:** Top-Down (Experience First)

## Overview

Bookmarks evolve from "clip ID + timestamp" into **Moments** — the primary artifact of Plexd. A Moment is an extracted sub-clip representing the best part of a video. Moments are:

- Visible across every scene (badges, timeline markers)
- Browsable in a dedicated 6-mode Moment Browser
- Persistent in a global database (JSON + SQLite) that survives sessions
- Playable with crescendo looping, playlists, and random discovery
- Optionally AI-analyzed by a local vision model for auto-tagging and similarity search

Moments replace the current Encore view and become the "main currency" of the app — the end goal is not just the clips you love, but the specific moments within them that rock your world.

---

## The Moment Data Model

```javascript
{
  id: "m_1708500000_a3f2",        // unique ID (timestamp + random)

  // Source reference
  sourceUrl: "https://...",        // original stream URL
  sourceFileId: "file_abc",       // server file ID (if uploaded)
  sourceTitle: "clip name",       // human-readable source

  // Time range
  start: 83.2,                    // range start (seconds)
  end: 91.7,                      // range end (seconds)
  peak: 87.4,                     // peak point within range
  peakEnd: 88.9,                  // peak range end (for crescendo)

  // Metadata
  rating: 8,                      // 1-9 (inherits clip rating by default)
  loved: true,                    // starred/loved
  tags: ["tag1", "tag2"],         // user tags
  notes: "",                      // free text

  // AI-generated (optional, populated by local LLM)
  aiDescription: "",              // visual description
  aiTags: [],                     // auto-detected categories
  aiEmbedding: [...],             // vector for similarity search

  // Thumbnails
  thumbnailDataUrl: "data:...",   // canvas-captured frame at peak

  // Extraction status
  extracted: false,               // solidified to MP4?
  extractedPath: null,            // server path to extracted file

  // Session tracking
  sessionId: "sess_abc",
  createdAt: 1708500000,
  updatedAt: 1708500000,
  playCount: 0,
  lastPlayedAt: null,

  // Manual ordering
  sortOrder: 0                    // for drag-reorder in browser
}
```

### Key constraints

- `peak` + `peakEnd` define the crescendo zone — playback tightens to this on repeat
- `thumbnailDataUrl` captured from canvas at creation — instant visual recall without loading the video
- Range editing: **full edit** when source is loaded (expand/shrink), **tighten only** when source unavailable
- "Reconnect source" action: searches loaded streams + server files by URL/fileId, re-enables full editing if found

---

## Moment Creation — Smart Auto-Range

Press **K** to create a moment. Two phases:

### Phase 1: Instant Capture (~0ms, always)

1. Record current time as `peak`
2. Capture canvas frame as `thumbnailDataUrl`
3. Create moment with default range: `peak ± 5 seconds`
4. Inherit clip's current rating and loved status
5. Visual feedback: golden pulse + "Moment saved" toast

### Phase 2: Smart Range Detection (async, best-effort)

**Tier 1 — Canvas Diff (always available)**
- Sample frames at 0.5s intervals in ±15s window around peak
- Pixel-diff via `getImageData` to detect scene cuts (>30% diff) and stillness (<2% diff)
- Expand range outward from peak until hitting scene cut or stillness
- Silently update `start`/`end`

**Tier 2 — Audio Analysis (always available)**
- Read audio levels from `AnalyserNode` (Web Audio API)
- Find peaks/valleys in ±15s window
- Cross-reference with visual scene cuts for natural "act boundaries"
- Tighten range to the audio-visual hot zone

**Tier 3 — Local LLM (optional, requires Ollama)**
- Send frames to local vision model
- Populate `aiDescription`, `aiTags`, `aiEmbedding`

**Fallback chain:** If Tier 2 fails → Tier 1 result stands. If Tier 1 fails → ±5s default stands. The moment is always created instantly.

### Refining Later (in Moment Browser)

- Drag range handles to adjust start/end
- Tap to set/move peak point
- Set peakEnd for crescendo zone
- Add/edit tags and notes
- Full range editing only when source is loaded; tighten-only otherwise

---

## Moments Across Every Scene

### Universal Indicators (all scenes, all modes)

On every video tile:
- **Gold diamond badge** (top-right) with moment count for this clip
- **Timeline dots** — gold pips at each moment's peak position on progress bar

### Per-Scene Behavior

**Casting Call:**
- Moment badges on every tile — instant triage of which clips have moments
- Clips with moments get a subtle warm undertone

**Lineup:**
- Moment density influences tile size (alongside rating weight)
- Timeline dots visible on each tile

**Stage:**
- **Moment timeline strip** below hero — visual blocks for each moment's range, gold highlight for peaks
- `Shift+Left/Right` jumps hero to next/prev moment's peak
- K creates moments, visible immediately on strip

**Climax:**
- **New sub-mode: Moment Reel** — plays all moments back-to-back with crossfades
- Tight Wall shows moment density as heat overlay (optional)
- Single Focus shows moment markers

---

## The Moment Browser (replaces Encore, J key)

Accessible via **J** from any scene. Six view modes, cycled with **E**:

### Mode 1: Grid (default)

Thumbnail cards in a grid. Each card shows: thumbnail at peak, rating badge, loved icon, duration. Arrow keys navigate, Enter plays, Delete removes, drag to reorder.

### Mode 2: Wall

Every moment plays its range on loop simultaneously. Cover-cropped, face-detect, edge-to-edge. A living wall of your best moments.

### Mode 3: Reel (playlist playback)

Cinematic mode — one moment at a time, full screen. Filmstrip at bottom shows queue. Auto-advances or manual skip. Repeat one / repeat all / shuffle.

### Mode 4: Collage

Overlapping moments with variable opacity and slight rotation. All looping simultaneously. Abstract layered intensity.

### Mode 5: Discovery (random-first)

Plays a random moment from your database, weighted by rating. Space = next random. Enter = lock and loop. Pure surprise mode.

### Mode 6: Cascade

Stacked perspective — current moment big on top, upcoming moments smaller below, all playing. Auto-advances, cascade shifts up.

### Filtering

- **This Session** / **All Sessions** / **Specific session**
- **Rating threshold**: 5+, 7+, 9 only, unrated
- **Loved only**
- **By source clip**
- **By tag** (manual or AI)
- **Has peak defined**

### Sorting

- Rating (highest first)
- Recently created
- Recently played
- Most replayed
- Duration (longest/shortest)
- Manual order (drag-sorted)

### Crescendo Playback

When a moment has peak range defined (`peak` to `peakEnd`):

```
Loop 1:  [======== full range ========]
Loop 2:  [======== full range ========]
Loop 3:    [==== tightened ====]
Loop 4:      [== peak zone ==]
Loop 5:      [== peak zone ==]  ← locks on peak
```

Configurable: loops before tightening, tightening speed.

---

## Random Everywhere

| Context | Action | Result |
|---------|--------|--------|
| Any scene | `/` | Random seek within current clip |
| Any scene | `//` | Random seek ALL clips |
| Moment Browser | `/` | Jump to random moment, play it |
| Reel mode | `/` | Skip to random moment in queue |
| Stage | `Shift+/` | Jump to random MOMENT in current clip |
| Any browser mode | Space in Discovery | Next random moment |
| Moment Browser | `Shift+/` | Random moment from ALL sessions |
| Playlist/Reel | Shuffle toggle | Randomize play order |

Random is weighted: higher-rated moments surface more often. High play-count moments slightly de-prioritized for variety.

---

## Server Persistence

### Storage Layout

```
uploads/
├── moments/
│   ├── moments.json          ← source of truth
│   ├── moments.db            ← SQLite index (derived)
│   ├── thumbnails/           ← JPEG exports
│   │   └── m_170850_a3f2.jpg
│   └── extracted/            ← solidified MP4 sub-clips
│       └── m_170850_a3f2.mp4
```

### API Endpoints

```
GET    /api/moments                     ← list (filters: ?session, ?rating, ?tag, ?source)
GET    /api/moments/:id                 ← single moment
POST   /api/moments                     ← create
PUT    /api/moments/:id                 ← update
DELETE /api/moments/:id                 ← delete (+ extracted file)
POST   /api/moments/:id/extract         ← solidify via ffmpeg
GET    /api/moments/:id/thumbnail       ← serve thumbnail
POST   /api/moments/reindex             ← rebuild SQLite from JSON
GET    /api/moments/stats               ← counts, top-rated, summary
POST   /api/moments/:id/analyze         ← local LLM analysis
GET    /api/moments/similar/:id         ← cosine similarity search
POST   /api/moments/reorder             ← save manual sort order
```

### Sync Model

- Client creates moments in-memory (instant, no server round-trip)
- Periodic sync pushes to server every 30s (like stream auto-save)
- On page load: fetch all from server, merge with localStorage
- Conflict resolution: server wins for rating/tags, client wins for range
- Offline: works via localStorage, syncs when server reachable

### Set Integration

Sets gain `momentIds` field. Saving a set captures its moments. Loading restores them. Moments can belong to multiple sets (always in global DB regardless).

### Extraction (Solidify)

```bash
ffmpeg -ss <start> -to <end> -i <source> \
  -c:v hevc_videotoolbox -tag:v hvc1 \
  -c:a aac -movflags +faststart \
  extracted/<moment_id>.mp4
```

Same HEVC pipeline as HLS transcoding. Extracted moments play independently without source.

---

## Local LLM Integration (Optional)

### Architecture

Client → Plexd Server → Ollama (localhost:11434) → Vision Model (LLaVA/BakLLaVA)

### Feature Gate

`GET /api/ai/status` → `{ available, model, provider }`

Server probes Ollama on startup. If available, AI features enabled in client. If not, everything works — AI fields stay empty.

### Features When Available

1. **Auto-Description** — frames → vision model → text description
2. **Auto-Tags** — multi-dimensional categorization (action, intensity, setting, etc.)
3. **Similarity Search** — embedding vectors, cosine similarity, "more like this"
4. **Smart Playlists** — AI-curated reels by category, intensity-building order
5. **Batch Analysis** — `POST /api/moments/analyze-all`, background queue, progress polling

### Setup

```bash
brew install ollama
ollama pull llava:13b
ollama serve
```

Plexd auto-detects. No configuration needed.

---

## Implementation Order (Top-Down)

1. Moment data model (in-memory + localStorage)
2. K creation with instant capture + canvas diff auto-range
3. Universal moment indicators (badges, timeline dots) across all scenes
4. Moment Browser: Grid mode (replace Encore)
5. Moment Browser: Wall + Reel modes
6. Crescendo playback + loop behavior
7. Moment Browser: Collage, Discovery, Cascade modes
8. Random everywhere integration
9. Range refinement UI (drag handles, peak setting)
10. Server persistence (JSON + SQLite + APIs)
11. Sync model (client ↔ server)
12. Set integration (momentIds)
13. Audio analysis (Tier 2 auto-range)
14. Extraction / solidify (ffmpeg)
15. Local LLM integration (optional tier)
