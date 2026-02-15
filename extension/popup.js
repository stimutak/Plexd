/**
 * Plexd Extension - Popup Script
 *
 * Handles the extension popup UI, video selection, and sending to Plexd.
 */

(function() {
    'use strict';

    // DOM elements
    const contentEl = document.getElementById('content');
    const statusEl = document.getElementById('status');
    const sendBtn = document.getElementById('sendBtn');
    const queueBtn = document.getElementById('queueBtn');
    const openPlexdBtn = document.getElementById('openPlexdBtn');
    const clearBtn = document.getElementById('clearBtn');
    const plexdUrlInput = document.getElementById('plexdUrl');
    const autoQueueToggle = document.getElementById('autoQueueToggle');

    // State
    let videos = [];
    let selectedVideos = new Set();
    let autoQueueEnabled = false;

    // Default Plexd URL
    const DEFAULT_PLEXD_URL = 'http://localhost:8080';

    /**
     * Ensure URL has a protocol prefix
     */
    function normalizeUrl(url) {
        if (!url) return DEFAULT_PLEXD_URL;
        url = url.trim();
        if (url.startsWith('file://') || url.startsWith('http://') || url.startsWith('https://')) return url;
        return 'http://' + url;
    }

    /**
     * Check if a host is localhost or local network
     */
    function isLocalHost(host) {
        if (!host) return false;
        return ['localhost', '127.0.0.1', '[::1]', '[::]'].includes(host) ||
               host.startsWith('192.168.') || host.startsWith('10.');
    }

    /**
     * Find existing Plexd tab that matches the configured URL
     */
    async function findPlexdTab(plexdUrl) {
        const tabs = await chrome.tabs.query({});

        // Handle file:// URLs specially
        if (plexdUrl.startsWith('file://')) {
            // For file URLs, match the file path (ignoring query string)
            const plexdPath = plexdUrl.split('?')[0];
            return tabs.find(t => t.url && t.url.startsWith('file://') && t.url.split('?')[0] === plexdPath);
        }

        // For http/https URLs
        try {
            const plexdUrlObj = new URL(plexdUrl);

            return tabs.find(t => {
                if (!t.url) return false;
                try {
                    const tabUrl = new URL(t.url);

                    // Both must be http/https
                    if (!tabUrl.protocol.startsWith('http')) return false;

                    // For localhost URLs, match on port
                    if (isLocalHost(plexdUrlObj.hostname) && isLocalHost(tabUrl.hostname)) {
                        return tabUrl.port === plexdUrlObj.port;
                    }

                    // For other URLs, match on origin
                    return tabUrl.origin === plexdUrlObj.origin;
                } catch {
                    return false;
                }
            });
        } catch {
            return null;
        }
    }

    /**
     * Initialize popup
     */
    async function init() {
        try {
            // Load saved settings
            const stored = await chrome.storage.local.get(['plexdUrl', 'autoQueue']);
            if (plexdUrlInput) {
                plexdUrlInput.value = normalizeUrl(stored.plexdUrl || DEFAULT_PLEXD_URL);

                // Save URL when changed
                plexdUrlInput.addEventListener('change', () => {
                    plexdUrlInput.value = normalizeUrl(plexdUrlInput.value);
                    chrome.storage.local.set({ plexdUrl: plexdUrlInput.value });
                });
            }

            // Load auto-queue state
            autoQueueEnabled = stored.autoQueue || false;
            if (autoQueueToggle) {
                autoQueueToggle.checked = autoQueueEnabled;
                autoQueueToggle.addEventListener('change', () => {
                    autoQueueEnabled = autoQueueToggle.checked;
                    chrome.storage.local.set({ autoQueue: autoQueueEnabled });
                    showStatus(autoQueueEnabled ? 'Auto-queue enabled' : 'Auto-queue disabled');
                });
            }

            // Button handlers
            if (sendBtn) sendBtn.addEventListener('click', sendToPlexd);
            if (queueBtn) queueBtn.addEventListener('click', queueSelected);
            if (openPlexdBtn) openPlexdBtn.addEventListener('click', openPlexd);
            if (clearBtn) clearBtn.addEventListener('click', clearAllStreams);

            // Scan current tab for videos
            await scanForVideos();
        } catch (err) {
            console.error('Popup init error:', err);
            if (contentEl) {
                contentEl.innerHTML = '<div class="empty-state"><h3>Error</h3><p>' + err.message + '</p></div>';
            }
        }
    }

    /**
     * Scan current tab for videos
     */
    async function scanForVideos() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (!tab || !tab.id || !tab.url) {
                showEmpty('No active tab');
                return;
            }

            // PRIMARY: Read stream URLs from page's Performance API
            // Runs in MAIN world so it sees ALL resources the page actually loaded
            // Works even if extension was just reloaded (performance entries persist until page reload)
            let interceptedVideos = [];
            try {
                const perfResults = await chrome.scripting.executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    world: 'MAIN',
                    func: () => {
                        const urls = [];
                        const seen = new Set();
                        performance.getEntriesByType('resource').forEach(entry => {
                            const lower = entry.name.toLowerCase();
                            if ((lower.includes('.m3u8') || lower.includes('.mpd')) && !seen.has(entry.name)) {
                                seen.add(entry.name);
                                urls.push(entry.name);
                            }
                        });
                        return urls;
                    }
                });
                const seen = new Set();
                for (const r of (perfResults || [])) {
                    if (r && r.result) {
                        for (const url of r.result) {
                            if (!seen.has(url)) {
                                seen.add(url);
                                interceptedVideos.push({
                                    type: 'stream',
                                    url: url,
                                    title: tab.title + ' (Stream)',
                                    intercepted: true
                                });
                            }
                        }
                    }
                }
            } catch (e) {
                console.log('[Plexd] Performance API scan failed:', e);
            }

            // FALLBACK: Check background webRequest storage
            if (interceptedVideos.length === 0) {
                try {
                    const stored = await chrome.storage.local.get(['intercepted_' + tab.id]);
                    const streams = stored['intercepted_' + tab.id];
                    if (streams && streams.length > 0) {
                        interceptedVideos = streams.map(url => ({
                            type: 'stream',
                            url: url,
                            title: tab.title + ' (Stream)',
                            intercepted: true
                        }));
                    }
                } catch {}
            }

            // FALLBACK 2: Check content.js storage
            if (interceptedVideos.length === 0) {
                try {
                    const tabUrl = new URL(tab.url);
                    const pageKey = 'streams_' + tabUrl.hostname + tabUrl.pathname;
                    const stored = await chrome.storage.local.get([pageKey]);
                    const storedData = stored[pageKey];
                    if (storedData && storedData.streams && storedData.streams.length > 0) {
                        interceptedVideos = storedData.streams.map(url => ({
                            type: 'stream',
                            url: url,
                            title: (storedData.title || tab.title) + ' (Stream)',
                            intercepted: true
                        }));
                    }
                } catch {}
            }

            // Ask content script for video list (with timeout so popup never hangs)
            let contentVideos = [];
            try {
                const response = await Promise.race([
                    chrome.tabs.sendMessage(tab.id, { action: 'getVideos' }),
                    new Promise((_, reject) => setTimeout(() => reject('timeout'), 1500))
                ]);
                if (response && response.videos) {
                    contentVideos = response.videos;
                }
            } catch {}

            // Also scan ALL frames via executeScript for <video> elements
            // (catches videos in iframes that the main frame content script can't see)
            let domVideos = [];
            const seen = new Set(contentVideos.map(v => v.url));
            try {
                const scriptResults = await chrome.scripting.executeScript({
                    target: { tabId: tab.id, allFrames: true },
                    func: () => {
                        const sources = [];
                        const seen = new Set();
                        document.querySelectorAll('video').forEach(video => {
                            [video.src, video.currentSrc].forEach(src => {
                                if (src && !src.startsWith('blob:') && !src.startsWith('data:') && !seen.has(src)) {
                                    try { new URL(src); } catch { return; }
                                    seen.add(src);
                                    sources.push({ type: 'video', url: src, title: video.title || document.title || 'Video' });
                                }
                            });
                        });
                        return sources;
                    }
                });
                for (const r of scriptResults) {
                    if (r && r.result) {
                        for (const v of r.result) {
                            if (!seen.has(v.url)) {
                                seen.add(v.url);
                                domVideos.push(v);
                            }
                        }
                    }
                }
            } catch {
                // allFrames can fail on restricted frames, try main frame only
                try {
                    const scriptResults = await chrome.scripting.executeScript({
                        target: { tabId: tab.id },
                        func: () => {
                            const sources = [];
                            document.querySelectorAll('video').forEach(video => {
                                [video.src, video.currentSrc].forEach(src => {
                                    if (src && !src.startsWith('blob:') && !src.startsWith('data:')) {
                                        try { new URL(src); } catch { return; }
                                        sources.push({ type: 'video', url: src, title: document.title || 'Video' });
                                    }
                                });
                            });
                            return sources;
                        }
                    });
                    if (scriptResults && scriptResults[0] && scriptResults[0].result) {
                        for (const v of scriptResults[0].result) {
                            if (!seen.has(v.url)) {
                                seen.add(v.url);
                                domVideos.push(v);
                            }
                        }
                    }
                } catch {}
            }

            // Combine: intercepted first, then content script, then iframe DOM
            const allVideos = [...interceptedVideos, ...contentVideos, ...domVideos];

            if (allVideos.length > 0) {
                videos = allVideos;
                renderVideoList(tab.title);
            } else {
                showEmpty('No videos found. Play a video first, then reopen this popup.');
            }
        } catch (err) {
            console.error('Scan error:', err);
            showEmpty('Could not scan page. Try refreshing.');
        }
    }

    /**
     * Render the video list
     */
    function renderVideoList(pageTitle) {
        // Separate intercepted streams from other videos
        const intercepted = [];
        const other = [];
        videos.forEach((video, index) => {
            if (video.intercepted || video.type === 'stream') {
                intercepted.push({ video, index });
            } else {
                other.push({ video, index });
            }
        });

        let html = '';

        // Show intercepted streams first (these are the good ones!)
        if (intercepted.length > 0) {
            html += `<div class="section-title" style="color: #4ade80;">&#9733; Captured Streams (Best)</div>
                     <ul class="video-list" id="streamList"></ul>`;
        }

        // Show other detected videos
        if (other.length > 0) {
            html += `<div class="section-title" style="margin-top: 12px;">Other Videos on Page</div>
                     <ul class="video-list" id="otherList"></ul>`;
        }

        if (intercepted.length === 0 && other.length === 0) {
            html = '<div class="empty-state"><h3>No Videos</h3><p>Play a video on this page first</p></div>';
        }

        contentEl.innerHTML = html;

        // Render intercepted streams
        if (intercepted.length > 0) {
            const streamList = document.getElementById('streamList');
            intercepted.forEach(({ video, index }) => {
                const li = createVideoItem(video, index, true);
                streamList.appendChild(li);
            });
        }

        // Render other videos
        if (other.length > 0) {
            const otherList = document.getElementById('otherList');
            other.forEach(({ video, index }) => {
                const li = createVideoItem(video, index, false);
                otherList.appendChild(li);
            });
        }
    }

    /**
     * Create a video list item with copy button
     */
    function createVideoItem(video, index, isStream) {
        // Create wrapper div
        const wrapper = document.createElement('div');
        wrapper.className = 'video-item-wrapper';

        // Create the video item
        const li = document.createElement('div');
        li.className = 'video-item' + (isStream ? ' stream-item' : '');
        li.dataset.index = index;

        const typeLabel = getTypeLabel(video);
        const urlShort = shortenUrl(video.url);

        li.innerHTML = `
            <div class="video-title">${escapeHtml(video.title || 'Untitled')}</div>
            <div class="video-meta">
                <span class="video-type" style="${isStream ? 'background: #166534; color: #4ade80;' : ''}">${typeLabel}</span>
                <span>${urlShort}</span>
            </div>
        `;

        li.addEventListener('click', () => toggleSelection(index, li));

        // Create actions row
        const actionsRow = document.createElement('div');
        actionsRow.className = 'video-item-actions';

        // Create copy button
        const copyBtn = document.createElement('button');
        copyBtn.className = 'copy-btn';
        copyBtn.title = 'Copy stream URL';
        copyBtn.innerHTML = '&#128203; Copy URL'; // Clipboard icon with text
        copyBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            copyStreamUrl(video.url, copyBtn);
        });

        actionsRow.appendChild(copyBtn);
        wrapper.appendChild(li);
        wrapper.appendChild(actionsRow);
        return wrapper;
    }

    /**
     * Copy stream URL to clipboard
     */
    async function copyStreamUrl(url, button) {
        try {
            await navigator.clipboard.writeText(url);
            button.classList.add('copied');
            button.innerHTML = '&#10003; Copied!'; // Checkmark with text
            showStatus('URL copied to clipboard');
            setTimeout(() => {
                button.classList.remove('copied');
                button.innerHTML = '&#128203; Copy URL';
            }, 2000);
        } catch (err) {
            console.error('Copy failed:', err);
            showStatus('Failed to copy URL', true);
        }
    }

    /**
     * Toggle video selection
     */
    function toggleSelection(index, element) {
        if (selectedVideos.has(index)) {
            selectedVideos.delete(index);
            element.classList.remove('selected');
        } else {
            selectedVideos.add(index);
            element.classList.add('selected');
        }
        updateSendButton();
    }

    /**
     * Update send button state
     */
    function updateSendButton() {
        const count = selectedVideos.size;
        sendBtn.disabled = count === 0;
        sendBtn.textContent = count > 0 ? `Send ${count} Video${count > 1 ? 's' : ''}` : 'Send Selected';
        if (queueBtn) {
            queueBtn.disabled = count === 0;
            queueBtn.textContent = count > 0 ? `Queue ${count}` : 'Queue';
        }
    }

    /**
     * Send a command to Plexd via the server API
     */
    async function sendCommand(action, payload = {}) {
        const plexdUrl = normalizeUrl(plexdUrlInput.value).replace(/\/$/, '');
        const resp = await fetch(`${plexdUrl}/api/remote/command`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action, payload, timestamp: Date.now() })
        });
        if (!resp.ok) throw new Error(`Server returned ${resp.status}`);
        return resp.json();
    }

    /**
     * Send selected videos to Plexd
     */
    async function sendToPlexd() {
        if (selectedVideos.size === 0) return;

        const selectedList = Array.from(selectedVideos).map(i => videos[i]);
        const plexdUrl = normalizeUrl(plexdUrlInput.value);

        if (!plexdUrl) {
            showStatus('Please set Plexd URL first', true);
            return;
        }

        try {
            const newUrls = selectedList.map(v => v.url);
            console.log('[Plexd Popup] Sending:', newUrls);

            for (const url of newUrls) {
                await sendCommand('addStream', { url });
            }

            showStatus(`Sent ${selectedList.length} video(s) to Plexd`);

            // Clear selection
            selectedVideos.clear();
            document.querySelectorAll('.video-item.selected').forEach(el => {
                el.classList.remove('selected');
            });
            updateSendButton();

        } catch (err) {
            console.error('Send error:', err);
            showStatus('Failed to send. Is Plexd running?', true);
        }
    }

    /**
     * Queue selected videos (add to Plexd queue instead of playing)
     */
    async function queueSelected() {
        if (selectedVideos.size === 0) return;

        const selectedList = Array.from(selectedVideos).map(i => videos[i]);
        const plexdUrl = normalizeUrl(plexdUrlInput.value);

        if (!plexdUrl) {
            showStatus('Please set Plexd URL first', true);
            return;
        }

        try {
            const newUrls = selectedList.map(v => v.url);
            console.log('[Plexd Popup] Queueing:', newUrls);

            for (const url of newUrls) {
                await sendCommand('queueStream', { url });
            }

            showStatus(`Queued ${selectedList.length} video(s)`);

            // Clear selection
            selectedVideos.clear();
            document.querySelectorAll('.video-item.selected').forEach(el => {
                el.classList.remove('selected');
            });
            updateSendButton();

        } catch (err) {
            console.error('Queue error:', err);
            showStatus('Failed to queue. Is Plexd open?', true);
        }
    }

    /**
     * Open Plexd - finds existing tab or creates new one
     */
    async function openPlexd() {
        const plexdUrl = normalizeUrl(plexdUrlInput.value);

        if (!plexdUrl) {
            showStatus('Please set Plexd URL first', true);
            return;
        }

        try {
            // Find existing Plexd tab or create new one
            const plexdTab = await findPlexdTab(plexdUrl);

            if (plexdTab) {
                // Activate existing tab
                await chrome.tabs.update(plexdTab.id, { active: true });
                await chrome.windows.update(plexdTab.windowId, { focused: true });
                showStatus('Switched to Plexd tab');
            } else {
                // Create new tab
                await chrome.tabs.create({ url: plexdUrl });
            }
        } catch (err) {
            console.error('Open Plexd error:', err);
            // Fallback: just create a new tab
            await chrome.tabs.create({ url: plexdUrl });
        }
    }

    /**
     * Clear all accumulated streams
     */
    async function clearAllStreams() {
        await chrome.storage.local.remove(['plexd_all_streams']);
        showStatus('Cleared all streams');
    }

    /**
     * Show empty state
     */
    function showEmpty(message) {
        contentEl.innerHTML = `
            <div class="empty-state">
                <h3>No Videos</h3>
                <p>${escapeHtml(message)}</p>
            </div>
        `;
    }

    /**
     * Show status message
     */
    function showStatus(message, isError = false) {
        statusEl.textContent = message;
        statusEl.className = 'status visible' + (isError ? ' error' : '');

        setTimeout(() => {
            statusEl.classList.remove('visible');
        }, 3000);
    }

    /**
     * Get type label for video
     */
    function getTypeLabel(video) {
        if (video.type === 'embed') {
            return video.embedType || 'embed';
        }
        if (video.url.includes('.m3u8')) return 'HLS';
        if (video.url.includes('.mpd')) return 'DASH';
        return video.type || 'video';
    }

    /**
     * Shorten URL for display
     */
    function shortenUrl(url) {
        try {
            const parsed = new URL(url);
            const path = parsed.pathname.split('/').pop() || parsed.hostname;
            return path.length > 30 ? path.slice(0, 27) + '...' : path;
        } catch {
            return url.slice(0, 30);
        }
    }

    /**
     * Escape HTML
     */
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // Initialize
    init();

})();
