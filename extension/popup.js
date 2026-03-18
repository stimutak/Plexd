/**
 * Plexd Extension - Popup v2
 *
 * Clean rewrite: health check, deduplication, batch send.
 */
(function() {
    'use strict';

    var contentEl = document.getElementById('content');
    var statusBar = document.getElementById('statusBar');
    var statusDot = document.getElementById('statusDot');
    var headerStatus = document.getElementById('headerStatus');
    var sendBtn = document.getElementById('sendBtn');
    var openBtn = document.getElementById('openBtn');

    var videos = [];
    var selectedSet = new Set(); // indices
    var plexdUrl = 'http://localhost:8080';
    var plexdReachable = false;

    // ── Init ────────────────────────────────────────────────────────────────

    async function init() {
        var stored = await chrome.storage.local.get(['plexdUrl']);
        if (stored.plexdUrl) plexdUrl = stored.plexdUrl;

        sendBtn.addEventListener('click', sendSelected);
        openBtn.addEventListener('click', openPlexd);

        // Keyboard shortcuts
        document.addEventListener('keydown', function(e) {
            if (e.key === 'Enter' && !sendBtn.disabled) sendSelected();
            if (e.key === 'a' && (e.metaKey || e.ctrlKey)) { e.preventDefault(); selectAll(); }
        });

        // Health check and scan in parallel
        await Promise.all([checkHealth(), scanForVideos()]);
    }

    // ── Health Check ────────────────────────────────────────────────────────

    async function checkHealth() {
        try {
            var controller = new AbortController();
            var timeout = setTimeout(function() { controller.abort(); }, 3000);
            var resp = await fetch(plexdUrl + '/api/remote/state', { signal: controller.signal });
            clearTimeout(timeout);
            if (resp.ok) {
                plexdReachable = true;
                statusDot.className = 'status-dot ok';
                headerStatus.textContent = 'Connected';
                headerStatus.style.color = '#4ade80';
            } else {
                setOffline();
            }
        } catch (e) {
            setOffline();
        }
    }

    function setOffline() {
        plexdReachable = false;
        statusDot.className = 'status-dot err';
        headerStatus.textContent = 'Not running';
        headerStatus.style.color = '#f87171';
    }

    // ── Video Scanning ──────────────────────────────────────────────────────

    function normalizeUrl(url) {
        // Strip tracking/signed URL params for dedup
        try {
            var u = new URL(url);
            var dominated = ['validto', 'hash', 'ip', 'nva', 'nvb', 'token', 'sig', 'expires', 'hdnts'];
            dominated.forEach(function(p) { u.searchParams.delete(p); });
            // Normalize HLS paths: strip everything after last directory to group
            // master.m3u8, index-v1.m3u8, index-a1.m3u8 etc. as same stream
            var path = u.pathname;
            if (path.match(/\.(m3u8|mpd)$/i)) {
                // Keep up to the parent directory as the dedup key
                var dir = path.replace(/\/[^/]+$/, '');
                u.pathname = dir + '/__stream__';
            }
            return u.href;
        } catch (e) {
            return url;
        }
    }

    // Is this a sub-manifest (variant/audio playlist) rather than a master?
    // Sub-manifests: index-v1.m3u8, index-a1.m3u8, chunklist*.m3u8, etc.
    // Masters: master.m3u8, m.m3u8, playlist.m3u8, or just path/video.m3u8
    function isMasterManifest(url) {
        try {
            var filename = new URL(url).pathname.split('/').pop().toLowerCase();
            // Obvious sub-manifests
            if (filename.match(/^(index-[va]\d|chunklist|media_)/)) return false;
            // Obvious masters
            if (filename.match(/^(master|m|playlist|manifest)\./)) return true;
            // Default: treat as master (better to show than hide)
            return true;
        } catch (e) {
            return true;
        }
    }

    async function scanForVideos() {
        try {
            var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
            var tab = tabs[0];
            if (!tab || !tab.id || !tab.url) {
                showEmpty('No active tab');
                return;
            }

            var allFound = [];
            var seen = new Set();

            function addVideo(v) {
                var key = normalizeUrl(v.url);
                if (seen.has(key)) {
                    // If we already have a sub-manifest, replace with master
                    if (isMasterManifest(v.url)) {
                        var existIdx = allFound.findIndex(function(f) { return normalizeUrl(f.url) === key; });
                        if (existIdx >= 0 && !isMasterManifest(allFound[existIdx].url)) {
                            allFound[existIdx] = v;
                        }
                    }
                    return;
                }
                // Skip sub-manifests if we already have the master
                if (v.url.match(/\.m3u8/i) && !isMasterManifest(v.url)) {
                    // Check if master already exists for this stream
                    if (seen.has(key)) return;
                }
                seen.add(key);
                allFound.push(v);
            }

            // 1. Performance API — most reliable, reads what browser actually loaded
            try {
                var perfResults = await chrome.scripting.executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    world: 'MAIN',
                    func: function() {
                        var urls = [];
                        var seen = {};
                        performance.getEntriesByType('resource').forEach(function(entry) {
                            var lower = entry.name.toLowerCase();
                            if ((lower.includes('.m3u8') || lower.includes('.mpd')) && !seen[entry.name]) {
                                seen[entry.name] = true;
                                urls.push(entry.name);
                            }
                        });
                        return urls;
                    }
                });
                for (var r = 0; r < (perfResults || []).length; r++) {
                    var result = perfResults[r];
                    if (result && result.result) {
                        for (var i = 0; i < result.result.length; i++) {
                            addVideo({ type: 'stream', url: result.result[i], title: tab.title, intercepted: true });
                        }
                    }
                }
            } catch (e) { /* restricted page */ }

            // 2. Content script intercepted streams (from intercept.js via postMessage)
            try {
                var response = await Promise.race([
                    chrome.tabs.sendMessage(tab.id, { action: 'getVideos' }),
                    new Promise(function(_, reject) { setTimeout(function() { reject('timeout'); }, 2000); })
                ]);
                if (response && response.videos) {
                    for (var j = 0; j < response.videos.length; j++) {
                        addVideo(response.videos[j]);
                    }
                }
            } catch (e) { /* content script not ready */ }

            // 3. Content script storage fallback
            try {
                var tabUrl = new URL(tab.url);
                var pageKey = 'streams_' + tabUrl.hostname + tabUrl.pathname;
                var stored = await chrome.storage.local.get([pageKey]);
                var storedData = stored[pageKey];
                if (storedData && storedData.streams) {
                    for (var k = 0; k < storedData.streams.length; k++) {
                        addVideo({ type: 'stream', url: storedData.streams[k], title: storedData.title || tab.title, intercepted: true });
                    }
                }
            } catch (e) {}

            // 4. DOM <video> element scan
            try {
                var domResults = await chrome.scripting.executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    func: function() {
                        var sources = [];
                        var seen = {};
                        document.querySelectorAll('video').forEach(function(video) {
                            [video.src, video.currentSrc].forEach(function(src) {
                                if (src && !src.startsWith('blob:') && !src.startsWith('data:') && !seen[src]) {
                                    try { new URL(src); } catch(e) { return; }
                                    seen[src] = true;
                                    sources.push({ type: 'video', url: src, title: video.title || document.title || 'Video' });
                                }
                            });
                        });
                        return sources;
                    }
                });
                for (var d = 0; d < (domResults || []).length; d++) {
                    if (domResults[d] && domResults[d].result) {
                        for (var e2 = 0; e2 < domResults[d].result.length; e2++) {
                            addVideo(domResults[d].result[e2]);
                        }
                    }
                }
            } catch (e) { /* restricted frames */ }

            if (allFound.length > 0) {
                videos = allFound;
                // Auto-select all streams (the ones users usually want)
                for (var s = 0; s < videos.length; s++) {
                    if (videos[s].intercepted) selectedSet.add(s);
                }
                renderVideoList();
            } else {
                showEmpty('No videos found on this page.\nPlay a video first, then reopen.');
            }
        } catch (err) {
            showEmpty('Could not scan page.');
        }
    }

    // ── Rendering ───────────────────────────────────────────────────────────

    function renderVideoList() {
        contentEl.innerHTML = '';

        var streams = [];
        var other = [];
        for (var i = 0; i < videos.length; i++) {
            if (videos[i].intercepted || videos[i].type === 'stream') {
                streams.push(i);
            } else {
                other.push(i);
            }
        }

        if (streams.length > 0) {
            var label = document.createElement('div');
            label.className = 'section-label streams';
            label.textContent = 'Streams (' + streams.length + ')';
            contentEl.appendChild(label);
            for (var s = 0; s < streams.length; s++) {
                contentEl.appendChild(createItem(streams[s]));
            }
        }

        if (other.length > 0) {
            var label2 = document.createElement('div');
            label2.className = 'section-label';
            label2.textContent = 'Videos (' + other.length + ')';
            if (streams.length > 0) label2.style.marginTop = '8px';
            contentEl.appendChild(label2);
            for (var o = 0; o < other.length; o++) {
                contentEl.appendChild(createItem(other[o]));
            }
        }

        updateSendBtn();
    }

    function createItem(idx) {
        var v = videos[idx];
        var item = document.createElement('div');
        item.className = 'video-item' + (selectedSet.has(idx) ? ' selected' : '');
        item.dataset.idx = idx;

        var cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = selectedSet.has(idx);

        var info = document.createElement('div');
        info.className = 'video-info';

        var title = document.createElement('div');
        title.className = 'video-title';
        title.textContent = v.title || 'Untitled';

        var meta = document.createElement('div');
        meta.className = 'video-meta';

        var badge = document.createElement('span');
        badge.className = 'badge-type ' + getBadgeClass(v);
        badge.textContent = getTypeLabel(v);
        meta.appendChild(badge);

        var urlSpan = document.createElement('span');
        urlSpan.textContent = shortenUrl(v.url);
        meta.appendChild(urlSpan);

        // Warn about mux.project1content.com URLs (IP-bound + CORS-blocked, only work via xfill)
        var isMuxUrl = v.url.includes('mux.project1content.com');
        if (isMuxUrl) {
            var warn = document.createElement('div');
            warn.className = 'mux-warning';
            warn.textContent = '\u26a0 IP-bound stream \u2014 use xfill in Plexd instead';
            info.appendChild(warn);
        }

        info.appendChild(title);
        info.appendChild(meta);

        var copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.innerHTML = '&#x1F4CB;';
        copyBtn.title = 'Copy URL';
        copyBtn.addEventListener('click', function(e) {
            e.stopPropagation();
            navigator.clipboard.writeText(v.url).then(function() {
                copyBtn.innerHTML = '&#x2713;';
                copyBtn.classList.add('copied');
                setTimeout(function() { copyBtn.innerHTML = '&#x1F4CB;'; copyBtn.classList.remove('copied'); }, 1500);
            });
        });

        item.appendChild(cb);
        item.appendChild(info);
        item.appendChild(copyBtn);

        item.addEventListener('click', function() {
            if (selectedSet.has(idx)) {
                selectedSet.delete(idx);
                item.classList.remove('selected');
                cb.checked = false;
            } else {
                selectedSet.add(idx);
                item.classList.add('selected');
                cb.checked = true;
            }
            updateSendBtn();
        });

        return item;
    }

    function selectAll() {
        for (var i = 0; i < videos.length; i++) selectedSet.add(i);
        renderVideoList();
    }

    function updateSendBtn() {
        var n = selectedSet.size;
        sendBtn.disabled = n === 0 || !plexdReachable;
        if (n === 0) {
            sendBtn.textContent = 'Send All';
        } else if (n === videos.length) {
            sendBtn.textContent = 'Send All (' + n + ')';
        } else {
            sendBtn.textContent = 'Send ' + n + ' Video' + (n > 1 ? 's' : '');
        }
    }

    // ── Sending ─────────────────────────────────────────────────────────────

    async function sendSelected() {
        if (selectedSet.size === 0) return;
        if (!plexdReachable) {
            showStatusBar('Plexd not running', true);
            return;
        }

        var urls = [];
        selectedSet.forEach(function(idx) {
            if (videos[idx]) urls.push(videos[idx].url);
        });

        sendBtn.disabled = true;
        sendBtn.textContent = 'Sending...';

        try {
            // Send all in parallel (server queues them)
            var promises = urls.map(function(url) {
                return fetch(plexdUrl + '/api/remote/command', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ action: 'addStream', payload: { url: url }, timestamp: Date.now() })
                });
            });
            await Promise.all(promises);

            showStatusBar('Sent ' + urls.length + ' video' + (urls.length > 1 ? 's' : '') + ' to Plexd');
            selectedSet.clear();
            renderVideoList();
        } catch (err) {
            showStatusBar('Failed to send — is Plexd running?', true);
        }

        updateSendBtn();
    }

    // ── Open Plexd ──────────────────────────────────────────────────────────

    async function openPlexd() {
        try {
            var tabs = await chrome.tabs.query({});
            var existing = tabs.find(function(t) {
                if (!t.url) return false;
                try {
                    var u = new URL(t.url);
                    return u.hostname === 'localhost' && u.port === '8080';
                } catch (e) { return false; }
            });
            if (existing) {
                await chrome.tabs.update(existing.id, { active: true });
                await chrome.windows.update(existing.windowId, { focused: true });
            } else {
                await chrome.tabs.create({ url: plexdUrl });
            }
        } catch (e) {
            await chrome.tabs.create({ url: plexdUrl });
        }
    }

    // ── UI Helpers ──────────────────────────────────────────────────────────

    function showEmpty(message) {
        contentEl.innerHTML = '';
        var div = document.createElement('div');
        div.className = 'empty-state';
        var h = document.createElement('h3');
        h.textContent = 'No Videos';
        var p = document.createElement('p');
        p.textContent = message;
        div.appendChild(h);
        div.appendChild(p);
        contentEl.appendChild(div);
    }

    function showStatusBar(message, isError) {
        statusBar.textContent = message;
        statusBar.className = 'status-bar ' + (isError ? 'err' : 'ok');
        setTimeout(function() { statusBar.className = 'status-bar'; }, 4000);
    }

    function getTypeLabel(v) {
        if (v.url.includes('.m3u8')) return 'HLS';
        if (v.url.includes('.mpd')) return 'DASH';
        if (v.url.match(/\.(mp4|webm|m4v|mov)(\?|$)/i)) return 'MP4';
        return 'video';
    }

    function getBadgeClass(v) {
        if (v.url.includes('.m3u8')) return 'badge-hls';
        if (v.url.includes('.mpd')) return 'badge-dash';
        return 'badge-mp4';
    }

    function shortenUrl(url) {
        try {
            var p = new URL(url);
            var name = p.pathname.split('/').pop() || p.hostname;
            return name.length > 35 ? name.slice(0, 32) + '...' : name;
        } catch (e) {
            return url.slice(0, 35);
        }
    }

    // ── Go ──────────────────────────────────────────────────────────────────
    init();

})();
