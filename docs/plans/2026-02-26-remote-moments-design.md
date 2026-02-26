# Remote Moments — Browse & Triage

**Date:** 2026-02-26
**Status:** Approved
**Scope:** Add moment browsing and triage capabilities to the iPhone remote PWA

## Overview

Add a Moments tab to the iPhone remote that lets users browse, rate, filter, and play moments captured on the Mac. The phone is a review/triage tool — no create, edit, or delete from the remote.

## Design Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Primary use case | Browse & triage | Phone reviews moments captured on Mac |
| Browse modes | Grid + Player | Maps naturally to touch; Grid for overview, Player for sequential playback |
| Playback target | Mac + phone preview | Tap sends play command to Mac, phone shows synced preview (same pattern as streams) |
| Data sync | Dedicated endpoint | Keeps state relay lightweight; moments list can be large |
| UI integration | Bottom tab bar | Clean context switching, standard mobile pattern |

## Navigation

Bottom tab bar (2 tabs), 48px tall, fixed to viewport bottom:

```
┌──────────┬───────────────────┐
│ ▶ Streams │ ★ Moments (42)   │
└──────────┴───────────────────┘
```

- Always visible except in fullscreen viewer
- Moments badge shows total count from state relay
- Switching preserves state in each context (scroll position, filters, selection)
- Active tab has accent underline

## Moments Panel Layout

```
┌─────────────────────────────────────┐
│  [Audio]     Plexd     [●]         │  Header (unchanged)
├─────────────────────────────────────┤
│         Moment Preview              │  Hero (plays moment clip)
│          ← 7 / 42 →                │  Position in filtered list
├─────────────────────────────────────┤
│  Stream: video.mp4      0:15-0:25  │  Source + range info
│  ═══════════●───────────────────    │  Progress within moment range
├─────────────────────────────────────┤
│  [tags: action, fast]               │  AI + user tag pills (if present)
├─────────────────────────────────────┤
│   [|◀]  [-5s]   [▶||]  [+5s]  [▶|]│  Transport (±5s for short clips)
├─────────────────────────────────────┤
│  [✕][1][2][3][4][5][6][7][8][9][♥] │  Rating (assign to moment)
├─────────────────────────────────────┤
│ [All][♥][☆][1][2][3][4][5][6][7][8][9]│  Filter tabs (by moment rating)
├─────────────────────────────────────┤
│  [thumb][thumb][thumb]...           │  Moment thumbnails (filtered)
├─────────────────────────────────────┤
│ [Random] [Shuffle] [Grid|Player]   │  Mode + sort controls
├─────────────────────────────────────┤
│  ▶ Streams    │    ★ Moments (42)  │  Tab bar
└─────────────────────────────────────┘
```

### Key differences from stream view

- **Info row**: Source video name + moment time range (start–end), not stream title + full duration
- **Transport**: ±5s seeks (moments are short clips, 30s would overshoot)
- **Prev/Next**: Navigates filtered moments, not streams
- **Thumbnails**: Moment thumbnails with rating overlay badges
- **Tags row**: AI tags + user tags shown as small pills (when present)
- **Mode controls**: Toggle Grid ↔ Player, sort dropdown, shuffle toggle

## Hero Tap Zones (Moments Mode)

```
+------------------+
|   TOP: Random    |  ← random moment from filtered list
+------+----+------+
| LEFT |PLAY| RIGHT|  ← prev/next moment
+------+----+------+
| BTM: Grid/Player |  ← toggle browse mode
+------------------+
```

- Swipe left/right: Navigate moments
- Swipe down (Player mode): Exit to Grid

## Browse Modes

### Grid Mode (default)

- 3-column scrollable grid of moment thumbnails
- Rating badge in corner (colored pill)
- Heart icon overlay if loved
- AI tag pill if analyzed
- Selected moment has accent border
- Tap selects, tap again plays
- Pull-to-refresh fetches latest from server

### Player Mode

- Horizontal filmstrip at top (scrollable)
- Hero plays moment clip in range
- Auto-advances to next moment when clip range ends
- Shuffle toggle randomizes order (weighted by rating²)
- Transport: prev/next = moments, ±5s = seek within clip
- Back/forward navigates play history stack

## Progress Bar

Shows position within the **moment's range** (start → end), not the full video duration. Dragging seeks within the clip boundaries. Full video duration shown as small text for context.

## Sort Control

Small sort button next to filter tabs, opens dropdown:
- By rating (highest first)
- By newest (default)
- By most played
- By duration
- Random

## Data Flow

### Fetching Moments

```
Tab opens (first time):
  GET /api/moments → full moment list (JSON, no thumbnails)

Subsequent updates (every 10s while tab active):
  GET /api/moments?since=<timestamp> → delta only

Thumbnails (lazy):
  GET /api/moments/:id/thumb → JPEG (cached in memory as blobUrl)
```

### State Relay Changes

Mac state push gains two fields:

```javascript
{
  ...existingState,
  momentCount: 42,            // For badge
  momentLastUpdated: 1708XXX  // Triggers re-fetch when newer than cache
}
```

Remote checks `momentLastUpdated` against cached timestamp. If newer, fetches delta.

### Remote → Mac Commands

| Action | Payload | Mac Behavior |
|--------|---------|-------------|
| `playMoment` | `{ momentId }` | Seek source stream to peak, enter fullscreen |
| `rateMoment` | `{ momentId, rating }` | Update moment rating |
| `loveMoment` | `{ momentId }` | Toggle loved status |
| `nextMoment` | `{ direction: 1\|-1 }` | Navigate filtered list |
| `randomMoment` | `{}` | Play random (weighted by rating²) |

Mac command handler calls existing `PlexdMoments` API.

### Server Endpoints

**New:**
- `GET /api/moments?since=<timestamp>` — Delta query (filter by `updatedAt`)
- `GET /api/moments/:id/thumb` — Serve thumbnail JPEG

**Modified:**
- Mac state object: add `momentCount`, `momentLastUpdated`

## Error Handling

- **Offline**: Show cached moments from last fetch, disable rating, queue commands
- **No moments**: Empty state: "Capture moments on Mac with K key"
- **Thumbnail fail**: Colored placeholder with rating number

## Scope Boundaries

**In scope:**
- Grid + Player browse modes
- Rating (0-9), loved toggle
- Filter by rating, loved, source
- Sort by rating, newest, most played, duration, random
- Play on Mac with phone preview sync
- Tag display (AI + user tags)

**Out of scope:**
- Creating moments from phone
- Editing moment ranges (start/end/peak)
- Deleting moments
- AI analysis from phone
- Wall, Collage, Discovery, Cascade modes
