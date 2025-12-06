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
        // Load saved Plexd URL
        const stored = await chrome.storage.local.get(['plexdUrl']);
        plexdUrlInput.value = stored.plexdUrl || DEFAULT_PLEXD_URL;

        // Save URL when changed
        plexdUrlInput.addEventListener('change', () => {
            chrome.storage.local.set({ plexdUrl: plexdUrlInput.value });
        });

        // Scan current tab for videos
        await scanForVideos();

        // Button handlers
        sendBtn.addEventListener('click', sendToPlexd);
        openPlexdBtn.addEventListener('click', openPlexd);
    }

    /**
     * Scan current tab for videos
     */
    async function scanForVideos() {
        try {
            const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });

            if (!tab || !tab.id) {
                showEmpty('No active tab');
                return;
            }

            // Inject content script if needed and get videos
            const results = await chrome.tabs.sendMessage(tab.id, { action: 'getVideos' });

            if (results && results.videos && results.videos.length > 0) {
                videos = results.videos;
                renderVideoList(results.pageTitle);
            } else {
                showEmpty('No videos found on this page');
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
        contentEl.innerHTML = `
            <div class="section-title">Videos on: ${escapeHtml(pageTitle || 'this page')}</div>
            <ul class="video-list" id="videoList"></ul>
        `;

        const listEl = document.getElementById('videoList');

        videos.forEach((video, index) => {
            const li = document.createElement('li');
            li.className = 'video-item';
            li.dataset.index = index;

            const typeLabel = getTypeLabel(video);
            const urlShort = shortenUrl(video.url);

            li.innerHTML = `
                <div class="video-title">${escapeHtml(video.title || 'Untitled')}</div>
                <div class="video-meta">
                    <span class="video-type">${typeLabel}</span>
                    <span>${urlShort}</span>
                </div>
            `;

            li.addEventListener('click', () => toggleSelection(index, li));
            listEl.appendChild(li);
        });
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

        // Get Plexd tab or open new one
        const plexdUrl = plexdUrlInput.value;

        if (!plexdUrl) {
            showStatus('Please set Plexd URL first', true);
            return;
        }

        try {
            // Find existing Plexd tab
            const tabs = await chrome.tabs.query({});
            let plexdTab = tabs.find(t => t.url && t.url.includes('plexd'));

            if (plexdTab) {
                // Send to existing tab
                await chrome.tabs.sendMessage(plexdTab.id, {
                    action: 'addStreams',
                    streams: selectedList.map(v => ({
                        url: v.url,
                        title: v.title
                    }))
                });
                await chrome.tabs.update(plexdTab.id, { active: true });
            } else {
                // Open Plexd with streams as URL params
                const streamUrls = selectedList.map(v => encodeURIComponent(v.url)).join(',');
                const targetUrl = `${plexdUrl}?streams=${streamUrls}`;
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
