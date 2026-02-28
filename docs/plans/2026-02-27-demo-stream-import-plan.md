# Demo Stream Import (xfill) Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Add an "xfill" button that populates Plexd with 16 random adult HLS streams scraped live from xHamster.

**Architecture:** Server endpoint `GET /api/demo/streams?count=16` scrapes xHamster listing pages, extracts HLS URLs from video pages, returns them. Client calls `addStreamSilent()` for each URL; existing HLS proxy handles playback.

**Tech Stack:** Node.js http/https (server scraping), existing `fetchUrl()` helper, vanilla JS client.

---

### Task 1: Add server-side scraping helpers to server.js

**Files:**
- Modify: `server.js` (insert after `fetchUrl` function around line 1246, before `rewriteM3u8`)

**Step 1: Add `fetchPage` promise wrapper**

Insert after the `fetchUrl` function (line 1246):

```javascript
// Promise wrapper around fetchUrl for scraping (returns full body as string)
function fetchPage(url) {
    return new Promise((resolve, reject) => {
        fetchUrl(url, (err, res) => {
            if (err) return reject(err);
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error('HTTP ' + res.statusCode));
            }
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(body));
            res.on('error', reject);
        });
    });
}
```

**Step 2: Add `scrapeXhamsterListing` function**

```javascript
// Scrape xHamster listing page for video URLs
async function scrapeXhamsterListing(count) {
    const page = Math.floor(Math.random() * 50) + 1;
    const listUrl = 'https://xhamster.com/newest/' + page;
    console.log('[Demo] Fetching listing: ' + listUrl);

    const html = await fetchPage(listUrl);

    // Extract video page URLs from listing
    const linkPattern = /href="(https:\/\/xhamster\.com\/videos\/[^"]+)"/g;
    const urls = [];
    const seen = new Set();
    let match;
    while ((match = linkPattern.exec(html)) !== null) {
        if (!seen.has(match[1])) {
            seen.add(match[1]);
            urls.push(match[1]);
        }
    }

    // Grab more than needed to absorb failures
    return urls.slice(0, Math.ceil(count * 1.5));
}
```

**Step 3: Add `scrapeXhamsterVideo` function**

```javascript
// Extract HLS URL + title from an xHamster video page
async function scrapeXhamsterVideo(pageUrl) {
    const html = await fetchPage(pageUrl);

    // Extract title
    const titleMatch = html.match(/<title>([^<]+)<\/title>/i);
    const title = titleMatch
        ? titleMatch[1].replace(/ - xHamster.*$/i, '').trim()
        : 'Untitled';

    // Try window.initials JSON (primary method)
    const initialsMatch = html.match(
        /window\.initials\s*=\s*(\{.+?\});\s*<\/script>/s
    );
    if (initialsMatch) {
        try {
            const initials = JSON.parse(initialsMatch[1]);
            const sources = initials
                && initials.videoModel
                && initials.videoModel.sources;
            const hlsUrl = (sources && sources.hls && sources.hls.url)
                || (sources && sources.mp4 && (
                    sources.mp4['1080p']
                    || sources.mp4['720p']
                    || sources.mp4['480p']
                ));
            if (hlsUrl) return { url: hlsUrl, title: title };
        } catch (e) {
            console.log('[Demo] JSON parse failed for '
                + pageUrl + ': ' + e.message);
        }
    }

    // Fallback: look for .m3u8 URLs directly in page source
    const m3u8Match = html.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/);
    if (m3u8Match) return { url: m3u8Match[1], title: title };

    // Fallback: look for MP4 URLs
    const mp4Match = html.match(/(https?:\/\/[^\s"']+\.mp4[^\s"']*)/);
    if (mp4Match) return { url: mp4Match[1], title: title };

    return null;
}
```

**Step 4: Commit**

```
git add server.js
git commit -m "feat(demo): add xHamster scraping helpers for xfill"
```

---

### Task 2: Add /api/demo/streams endpoint to server.js

**Files:**
- Modify: `server.js` (insert before "Static file serving" comment at line 2937)

**Step 1: Add the endpoint**

Insert just before `// Static file serving` (line 2937):

```javascript
    // GET /api/demo/streams - Scrape random streams for xfill demo
    if (pathname === '/api/demo/streams' && req.method === 'GET') {
        const count = parseInt(params.get('count')) || 16;
        const CONCURRENCY = 6;

        try {
            const videoPageUrls = await scrapeXhamsterListing(count);
            console.log('[Demo] Found ' + videoPageUrls.length
                + ' video pages, extracting streams...');

            if (videoPageUrls.length === 0) {
                jsonOk(res, {
                    streams: [],
                    source: 'xhamster',
                    fetched: 0,
                    failed: 0,
                    error: 'No videos found on listing page'
                });
                return;
            }

            // Fetch video pages in batches with concurrency limit
            const streams = [];
            let failed = 0;
            for (let i = 0; i < videoPageUrls.length
                    && streams.length < count; i += CONCURRENCY) {
                const batch = videoPageUrls.slice(i, i + CONCURRENCY);
                const results = await Promise.allSettled(
                    batch.map(url => scrapeXhamsterVideo(url))
                );
                for (const r of results) {
                    if (r.status === 'fulfilled' && r.value) {
                        streams.push(r.value);
                    } else {
                        failed++;
                    }
                }
            }

            console.log('[Demo] Extracted ' + streams.length
                + ' streams (' + failed + ' failed)');
            jsonOk(res, {
                streams: streams.slice(0, count),
                source: 'xhamster',
                fetched: streams.length,
                failed: failed
            });
        } catch (err) {
            console.error('[Demo] Scrape error:', err.message);
            jsonError(res, 500,
                'Failed to scrape demo streams: ' + err.message);
        }
        return;
    }

```

**Step 2: Test the endpoint**

Run: `curl -s 'http://localhost:8080/api/demo/streams?count=2' | python3 -m json.tool`

Expected: JSON response with `streams` array containing `{url, title}` objects.

**Step 3: Commit**

```
git add server.js
git commit -m "feat(demo): add /api/demo/streams endpoint"
```

---

### Task 3: Add xfill function to app.js

**Files:**
- Modify: `web/js/app.js` (add function after `addStreamSilent` ~line 1518, export in public API ~line 11598)

**Step 1: Add the xfill function**

Insert after `addStreamSilent` function (after line 1518):

```javascript
    /**
     * xfill - Load random demo streams from server scraper
     */
    var _xfillLoading = false;
    async function xfill(count) {
        if (_xfillLoading) return;
        _xfillLoading = true;
        count = count || 16;

        var btn = document.getElementById('xfill-btn');
        if (btn) btn.textContent = 'Loading...';

        try {
            var resp = await fetch('/api/demo/streams?count=' + count);
            var data = await resp.json();

            if (!data.streams || data.streams.length === 0) {
                showMessage(
                    data.error || 'No demo streams found. Try again?',
                    'error'
                );
                return;
            }

            var IMMEDIATE = 6;
            for (var i = 0; i < data.streams.length; i++) {
                addStreamSilent(
                    data.streams[i].url,
                    i >= IMMEDIATE ? { deferred: true } : undefined
                );
            }
            updateLayout();

            // Stagger-activate deferred streams
            // (same pattern as session restore)
            var allStreams = PlexdStream.getAllStreams();
            var deferred = allStreams.filter(function(s) {
                return s.deferred;
            });
            if (deferred.length > 0) staggerActivate(deferred);

            showMessage(
                'Added ' + data.streams.length + ' demo streams'
                + (data.failed
                    ? ' (' + data.failed + ' failed)' : ''),
                'success'
            );
        } catch (err) {
            console.error('[xfill] Error:', err);
            showMessage(
                'Failed to load demo streams: ' + err.message,
                'error'
            );
        } finally {
            _xfillLoading = false;
            if (btn) btn.textContent = 'xfill';
        }
    }
```

**Step 2: Export xfill in public API**

In the `return { ... }` block, add after `jumpToRandomMoment` (line 11598):

```javascript
        // Demo
        xfill
```

**Step 3: Commit**

```
git add web/js/app.js
git commit -m "feat(demo): add xfill function to load random demo streams"
```

---

### Task 4: Add xfill button to toolbar in index.html

**Files:**
- Modify: `web/index.html` (insert in toolbar after panel buttons, ~line 87)

**Step 1: Add the button**

Insert after the "Hist" button (line 87), before the closing `</div>` of `plexd-stats`:

```html
                <button id="xfill-btn" class="plexd-button plexd-button-secondary" onclick="PlexdApp.xfill()" title="Load 16 random demo streams">xfill</button>
```

**Step 2: Commit**

```
git add web/index.html
git commit -m "feat(demo): add xfill button to toolbar"
```

---

### Task 5: End-to-end verification

**Step 1: Restart server**

Run: `./scripts/start-server.sh`

**Step 2: Test API directly**

Run: `curl -s 'http://localhost:8080/api/demo/streams?count=2' | python3 -m json.tool`

Verify: Response has `streams` array with `.m3u8` or `.mp4` URLs.

**Step 3: Test in browser**

1. Open http://localhost:8080
2. Press H to show toolbar
3. Click "xfill" button
4. Verify: button changes to "Loading...", then streams appear in grid
5. Verify: streams play through HLS proxy (check Network tab for proxy requests)

**Step 4: Adjust scraping if needed**

If `window.initials` JSON structure doesn't match (site may have changed):
- Open a video page manually in browser
- View source, search for video URLs or JSON configs
- Update `scrapeXhamsterVideo()` regex/path accordingly

**Step 5: Final commit if adjustments were made**

```
git add server.js
git commit -m "fix(demo): adjust xHamster scraping for current site structure"
```
