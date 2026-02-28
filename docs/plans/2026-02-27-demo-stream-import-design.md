# Demo Stream Import — Design

## Summary

One-click button that populates Plexd with 16 random adult video streams scraped live from xHamster. Server-side scrape extracts HLS URLs; client adds them via existing `addStreamSilent()` pipeline. Streams play through the existing HLS CORS proxy.

## Server Endpoint

**`GET /api/demo/streams?count=16`**

Response:
```json
{
  "streams": [
    { "url": "https://..../master.m3u8?...", "title": "Video Title" },
    ...
  ],
  "source": "xhamster",
  "fetched": 16,
  "failed": 2
}
```

### Scrape Pipeline

1. Pick random page offset (1–100), fetch `https://xhamster.com/newest/<page>`
2. Parse HTML for video links matching `/videos/<slug>-<id>` pattern
3. Grab ~20 links (overshoot to absorb extraction failures)
4. Fetch each video page in parallel (6 concurrent, `Promise.allSettled`)
5. Extract HLS URL from `window.initials` JSON embedded in page script tags
6. Return up to `count` successful results

### Key Decisions

- **xHamster** chosen because it serves native HLS — perfect match with existing `/api/proxy/hls` infrastructure
- **No caching** — each press fetches fresh random content
- **User-Agent** reuses `fetchUrl()` browser UA string
- **Concurrency limit of 6** avoids rate limiting; same `Promise.allSettled` pattern as Skier AI

## Client UI

- **Button**: "Demo" in toolbar/settings area
- **Loading state**: Button text changes to "Loading..." while fetching
- **On success**: Loop results, call `addStreamSilent(url)` for each (no per-stream history/toast), one summary toast at end
- **`updateLayout()`** called once after all streams added

### Why `addStreamSilent`

Same function used for session restore. No history entries, no per-stream messages. Bulk add with single summary notification.

## Error Handling

| Scenario | Behavior |
|----------|----------|
| Site unreachable | `{ streams: [], error: "..." }`, client shows toast |
| Partial failures | Server returns what it got, client adds partial |
| Zero streams | Toast: "Couldn't load demo streams. Try again?" |
| Rate limited | Partial results returned (6-concurrent limit mitigates) |

No retry logic — user clicks button again if needed.

## Files to Modify

- **`server.js`** — Add `/api/demo/streams` endpoint with scrape logic
- **`web/js/app.js`** — Add Demo button to toolbar, fetch + addStreamSilent loop
- **`web/index.html`** — Button element in toolbar (if needed, or created dynamically in app.js)
