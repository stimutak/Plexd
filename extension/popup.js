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
    const openPlexdBtn = document.getElementById('openPlexdBtn');
    const plexdUrlInput = document.getElementById('plexdUrl');

    // State
    let videos = [];
    let selectedVideos = new Set();

    // Default Plexd URL - can be file:// or http://
    const DEFAULT_PLEXD_URL = '';

    /**
     * Initialize popup
     */
    async function init() {
        try {
            // Load saved Plexd URL
            const stored = await chrome.storage.local.get(['plexdUrl']);
            if (plexdUrlInput) {
                plexdUrlInput.value = stored.plexdUrl || DEFAULT_PLEXD_URL;

                // Save URL when changed
                plexdUrlInput.addEventListener('change', () => {
                    chrome.storage.local.set({ plexdUrl: plexdUrlInput.value });
                });
            }

            // Button handlers
            if (sendBtn) sendBtn.addEventListener('click', sendToPlexd);
            if (openPlexdBtn) openPlexdBtn.addEventListener('click', openPlexd);

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

            // Get intercepted streams from chrome.storage
            const tabUrl = new URL(tab.url);
            const pageKey = 'streams_' + tabUrl.hostname + tabUrl.pathname;
            const stored = await chrome.storage.local.get([pageKey]);
            const storedData = stored[pageKey];

            let interceptedVideos = [];
            if (storedData && storedData.streams && storedData.streams.length > 0) {
                interceptedVideos = storedData.streams.map(url => ({
                    type: 'stream',
                    url: url,
                    title: storedData.title + ' (Captured)',
                    intercepted: true
                }));
            }

            // Also try to get DOM video elements via executeScript
            let domVideos = [];
            try {
                const scriptResults = await chrome.scripting.executeScript({
                    target: { tabId: tab.id },
                    func: () => {
                        const sources = [];
                        const seen = new Set();
                        document.querySelectorAll('video').forEach(video => {
                            if (video.src && !video.src.startsWith('blob:') && !seen.has(video.src)) {
                                seen.add(video.src);
                                sources.push({ type: 'video', url: video.src, title: document.title });
                            }
                            if (video.currentSrc && !video.currentSrc.startsWith('blob:') && !seen.has(video.currentSrc)) {
                                seen.add(video.currentSrc);
                                sources.push({ type: 'currentSrc', url: video.currentSrc, title: document.title });
                            }
                        });
                        return sources;
                    }
                });
                if (scriptResults && scriptResults[0] && scriptResults[0].result) {
                    domVideos = scriptResults[0].result;
                }
            } catch (e) {
                console.log('executeScript failed:', e);
            }

            // Combine: intercepted streams first, then DOM videos
            const allVideos = [...interceptedVideos, ...domVideos];

            if (allVideos.length > 0) {
                videos = allVideos;
                renderVideoList(storedData?.title || tab.title);
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
     * Create a video list item
     */
    function createVideoItem(video, index, isStream) {
        const li = document.createElement('li');
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
        return li;
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
    }

    /**
     * Send selected videos to Plexd
     */
    async function sendToPlexd() {
        if (selectedVideos.size === 0) return;

        const selectedList = Array.from(selectedVideos).map(i => videos[i]);

        // Get Plexd URL
        const plexdUrl = plexdUrlInput.value;

        if (!plexdUrl) {
            showStatus('Please set Plexd URL first', true);
            return;
        }

        try {
            // Always use URL params - most reliable method
            // Use ||| as separator since URLs can contain commas
            const streamUrls = selectedList.map(v => encodeURIComponent(v.url)).join('|||');
            const targetUrl = `${plexdUrl}?streams=${streamUrls}`;

            console.log('[Plexd Popup] Sending streams:', selectedList.map(v => v.url));
            console.log('[Plexd Popup] Encoded:', streamUrls);
            console.log('[Plexd Popup] Target URL:', targetUrl);

            // Find existing Plexd tab or create new one
            const tabs = await chrome.tabs.query({});
            const plexdOrigin = new URL(plexdUrl).origin;
            let plexdTab = tabs.find(t => t.url && t.url.startsWith(plexdOrigin));

            if (plexdTab) {
                // Plexd is already open - inject streams without reloading
                try {
                    const streamUrls = selectedList.map(v => v.url);
                    await chrome.scripting.executeScript({
                        target: { tabId: plexdTab.id },
                        func: (urls) => {
                            if (window.PlexdApp && window.PlexdApp.addStream) {
                                urls.forEach(url => window.PlexdApp.addStream(url));
                                return true;
                            }
                            return false;
                        },
                        args: [streamUrls]
                    });
                    // Focus the Plexd tab
                    await chrome.tabs.update(plexdTab.id, { active: true });
                } catch (e) {
                    // Fallback: reload with URL params if injection fails
                    console.log('Script injection failed, using URL params:', e);
                    await chrome.tabs.update(plexdTab.id, { url: targetUrl, active: true });
                }
            } else {
                // Open new Plexd tab with streams in URL
                await chrome.tabs.create({ url: targetUrl });
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
            showStatus('Failed to send. Is Plexd open?', true);
        }
    }

    /**
     * Open Plexd in new tab
     */
    async function openPlexd() {
        const plexdUrl = plexdUrlInput.value;

        if (!plexdUrl) {
            showStatus('Please set Plexd URL first', true);
            return;
        }

        await chrome.tabs.create({ url: plexdUrl });
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
