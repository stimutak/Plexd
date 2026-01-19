/**
 * Plexd Remote Control - iOS Optimized with Live Preview
 * Control without looking at the laptop
 */

const PlexdRemote = (function() {
    'use strict';

    // ============================================
    // State
    // ============================================
    let channel = null;
    let state = null;
    let connected = false;
    let lastStateTime = 0;
    let selectedStreamId = null;
    let lastLocalSelectionTime = 0; // Track when we last made a local selection
    const lastTapTimes = {}; // Track double-tap per stream ID

    const COMMAND_KEY = 'plexd_remote_command';
    const STATE_KEY = 'plexd_remote_state';
    const POLL_INTERVAL = 300;
    const CONNECTION_TIMEOUT = 2000;
    const SELECTION_GRACE_PERIOD = 1000; // Ignore state updates for selection for 1s after local selection

    // ============================================
    // DOM Elements
    // ============================================
    const $ = (id) => document.getElementById(id);
    const el = {};

    function cacheElements() {
        // Main sections
        el.connection = $('connection');
        el.emptyState = $('empty-state');

        // Preview section
        el.previewSection = $('preview-section');
        el.previewImage = $('preview-image');
        el.previewStatus = $('preview-status');
        el.previewTitle = $('preview-title');
        el.previewTime = $('preview-time');
        el.previewRating = $('preview-rating');
        el.previewProgressBar = $('preview-progress-bar');

        // Preview controls
        el.previewBack = $('preview-back');
        el.previewPrev = $('preview-prev');
        el.previewPlay = $('preview-play');
        el.previewNext = $('preview-next');
        el.previewForward = $('preview-forward');

        // Streams section
        el.streamsSection = $('streams-section');
        el.streamsList = $('streams-list');
        el.streamsCount = $('streams-count');

        // Action bar
        el.actionBar = $('action-bar');
        el.actionMute = $('action-mute');
        el.actionRating = $('action-rating');
        el.actionRandom = $('action-random');
        el.actionFullscreen = $('action-fullscreen');
        el.actionMore = $('action-more');

        // Sheet
        el.moreSheet = $('more-sheet');
        el.sheetBackdrop = el.moreSheet?.querySelector('.sheet-backdrop');
        el.sheetCancel = $('sheet-cancel');
        el.optPauseAll = $('opt-pause-all');
        el.optMuteAll = $('opt-mute-all');
        el.optGlobalFullscreen = $('opt-global-fullscreen');
        el.optViewAll = $('opt-view-all');
        el.optViewFavorites = $('opt-view-favorites');
        el.optTetris = $('opt-tetris');
        el.optClean = $('opt-clean');
        el.optRandom = $('opt-random');
        el.optRandomAll = $('opt-random-all');
    }

    // ============================================
    // Communication
    // ============================================
    function setupCommunication() {
        // BroadcastChannel for same-browser tabs
        if (typeof BroadcastChannel !== 'undefined') {
            channel = new BroadcastChannel('plexd-remote');
            channel.onmessage = (e) => {
                if (e.data.action === 'stateUpdate') {
                    handleStateUpdate(e.data.payload);
                }
            };
        }

        // Listen for localStorage changes
        window.addEventListener('storage', (e) => {
            if (e.key === STATE_KEY && e.newValue) {
                try {
                    const newState = JSON.parse(e.newValue);
                    if (newState.timestamp && Date.now() - newState.timestamp < 3000) {
                        handleStateUpdate(newState);
                    }
                } catch (err) { /* ignore */ }
            }
        });

        // Poll for state
        setInterval(pollState, POLL_INTERVAL);
        setInterval(checkConnection, 1000);

        // Initial ping
        send('ping');
    }

    async function pollState() {
        try {
            const res = await fetch('/api/remote/state');
            if (res.ok) {
                const newState = await res.json();
                const age = Date.now() - (newState.timestamp || 0);
                console.log('[Remote] State received, age:', age, 'ms, streams:', newState.streams?.length || 0);
                if (newState.timestamp && age < 3000) {
                    handleStateUpdate(newState);
                    return;
                }
            }
        } catch (e) {
            console.log('[Remote] API fetch failed:', e.message);
        }

        // Fallback to localStorage
        const stored = localStorage.getItem(STATE_KEY);
        if (stored) {
            try {
                const newState = JSON.parse(stored);
                if (newState.timestamp && Date.now() - newState.timestamp < 3000) {
                    handleStateUpdate(newState);
                }
            } catch (e) { /* ignore */ }
        }
    }

    function send(action, payload = {}) {
        const command = { action, payload, timestamp: Date.now() };
        console.log('[Remote] Sending command:', action, payload);

        if (channel) {
            channel.postMessage(command);
        }

        fetch('/api/remote/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(command)
        }).catch(() => {
            try {
                localStorage.setItem(COMMAND_KEY, JSON.stringify(command));
            } catch (e) { /* ignore */ }
        });
    }

    function handleStateUpdate(newState) {
        state = newState;
        lastStateTime = Date.now();

        const now = Date.now();
        const withinGracePeriod = (now - lastLocalSelectionTime) < SELECTION_GRACE_PERIOD;

        // Update selection from state, but respect local selection grace period
        if (!selectedStreamId && state.streams && state.streams.length > 0) {
            // No local selection - use state or first stream
            selectedStreamId = state.selectedStreamId || state.streams[0].id;
        } else if (!withinGracePeriod) {
            // Grace period expired - sync with main app
            selectedStreamId = state.selectedStreamId;
        }
        // If within grace period, keep local selection

        if (!connected) {
            connected = true;
            updateConnectionUI(true);
        }

        render();
    }

    function checkConnection() {
        if (connected && Date.now() - lastStateTime > CONNECTION_TIMEOUT) {
            connected = false;
            updateConnectionUI(false);
            send('ping');
        }
    }

    function updateConnectionUI(isConnected) {
        if (!el.connection) return;
        el.connection.classList.toggle('connected', isConnected);
        el.connection.classList.toggle('disconnected', !isConnected);
    }

    // ============================================
    // Rendering
    // ============================================
    function render() {
        if (!state) return;

        const hasStreams = state.streams && state.streams.length > 0;

        // Toggle sections
        el.emptyState?.classList.toggle('hidden', hasStreams);
        el.previewSection?.classList.toggle('hidden', !hasStreams);
        el.streamsSection?.classList.toggle('hidden', !hasStreams);
        el.actionBar?.classList.toggle('hidden', !hasStreams);

        if (hasStreams) {
            renderPreview();
            renderStreamList();
            renderActionBar();
            renderSheet();
        }
    }

    function renderPreview() {
        const stream = state.streams.find(s => s.id === selectedStreamId) || state.streams[0];
        if (!stream) return;

        const name = stream.fileName || getDisplayName(stream.url);
        const progress = stream.duration > 0 ? (stream.currentTime / stream.duration) * 100 : 0;
        const rating = stream.rating || 0;

        // Thumbnail
        if (el.previewImage) {
            if (stream.thumbnail) {
                el.previewImage.src = stream.thumbnail;
                el.previewImage.classList.add('visible');
            } else {
                el.previewImage.classList.remove('visible');
            }
        }

        // Status badge
        if (el.previewStatus) {
            el.previewStatus.classList.toggle('playing', !stream.paused);
            el.previewStatus.classList.toggle('paused', stream.paused);
            const statusText = el.previewStatus.querySelector('.status-text');
            if (statusText) {
                statusText.textContent = stream.paused ? 'Paused' : 'Playing';
            }
        }

        // Info
        if (el.previewTitle) el.previewTitle.textContent = name;
        if (el.previewTime) {
            el.previewTime.textContent = `${formatTime(stream.currentTime)} / ${formatTime(stream.duration)}`;
        }
        if (el.previewRating) {
            el.previewRating.textContent = rating > 0 ? '\u2605'.repeat(rating) : '';
        }
        if (el.previewProgressBar) {
            el.previewProgressBar.style.width = `${progress}%`;
        }

        // Play button state
        if (el.previewPlay) {
            el.previewPlay.classList.toggle('paused', stream.paused);
        }
    }

    function renderStreamList() {
        if (!el.streamsList || !el.streamsCount) return;

        el.streamsCount.textContent = state.streams.length;

        el.streamsList.innerHTML = state.streams.map(stream => {
            const isSelected = stream.id === selectedStreamId;
            const isFullscreen = stream.id === state.fullscreenStreamId;
            const name = stream.fileName || getDisplayName(stream.url);
            const rating = stream.rating || 0;
            const ratingClass = rating > 0 ? `rating-${rating}` : '';
            const ratingStars = rating > 0 ? '\u2605'.repeat(rating) : '';
            const hasThumbnail = !!stream.thumbnail;

            return `
                <div class="stream-item ${isSelected ? 'selected' : ''} ${isFullscreen ? 'fullscreen' : ''} ${ratingClass}"
                     data-id="${stream.id}">
                    <div class="stream-thumb">
                        ${hasThumbnail
                            ? `<img class="stream-thumb-img visible" src="${stream.thumbnail}" alt="">`
                            : `<div class="stream-thumb-placeholder">
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                    <path d="M21 3H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h5v2h8v-2h5c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 14H3V5h18v12z"/>
                                </svg>
                               </div>`
                        }
                    </div>
                    <div class="stream-info">
                        <div class="stream-name">${escapeHtml(name)}</div>
                        <div class="stream-meta">
                            <span class="stream-status ${stream.paused ? '' : 'playing'}">
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                    ${stream.paused
                                        ? '<path d="M6 19h4V5H6zm8-14v14h4V5z"/>'
                                        : '<path d="M8 5v14l11-7z"/>'}
                                </svg>
                                ${stream.paused ? 'Paused' : 'Playing'}
                            </span>
                            ${ratingStars ? `<span class="stream-rating-badge">${ratingStars}</span>` : ''}
                        </div>
                    </div>
                    <button class="stream-action" data-action="play">
                        <svg viewBox="0 0 24 24" fill="currentColor">
                            ${stream.paused
                                ? '<path d="M8 5v14l11-7z"/>'
                                : '<path d="M6 19h4V5H6zm8-14v14h4V5z"/>'}
                        </svg>
                    </button>
                </div>
            `;
        }).join('');

        // Event listeners
        el.streamsList.querySelectorAll('.stream-item').forEach(item => {
            const id = item.dataset.id;

            // Tap to select, double-tap for fullscreen
            item.addEventListener('click', (e) => {
                if (e.target.closest('.stream-action')) return;

                const now = Date.now();
                const lastTap = lastTapTimes[id] || 0;

                if (now - lastTap < 400) {
                    // Double-tap: toggle fullscreen
                    send('enterFullscreen', { streamId: id });
                    lastTapTimes[id] = 0;
                } else {
                    // Single tap: select stream
                    lastTapTimes[id] = now;
                    selectedStreamId = id;
                    lastLocalSelectionTime = now; // Prevent state updates from overwriting
                    send('selectStream', { streamId: id });
                    render();
                }
            });

            // Play/pause button
            const actionBtn = item.querySelector('.stream-action');
            actionBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                send('togglePause', { streamId: id });
            });
        });
    }

    function renderActionBar() {
        if (!state) return;

        const stream = state.streams.find(s => s.id === selectedStreamId) || state.streams[0];
        if (!stream) return;

        // Mute button
        if (el.actionMute) {
            el.actionMute.classList.toggle('muted', stream.muted);
            const label = el.actionMute.querySelector('span');
            if (label) label.textContent = stream.muted ? 'Unmute' : 'Mute';
        }

        // Rating button
        if (el.actionRating) {
            const rating = stream.rating || 0;
            el.actionRating.classList.toggle('active', rating > 0);
            const label = el.actionRating.querySelector('span');
            if (label) label.textContent = rating > 0 ? `${rating}\u2605` : 'Rate';
        }

        // Fullscreen button
        if (el.actionFullscreen) {
            const isFs = stream.id === state.fullscreenStreamId;
            el.actionFullscreen.classList.toggle('active', isFs);
            const label = el.actionFullscreen.querySelector('span');
            if (label) label.textContent = isFs ? 'Unfocus' : 'Focus';
        }
    }

    function renderSheet() {
        if (!el.moreSheet || !state) return;

        const anyPlaying = state.streams?.some(s => !s.paused);
        const anyUnmuted = state.streams?.some(s => !s.muted);

        if (el.optPauseAll) {
            const span = el.optPauseAll.querySelector('span');
            if (span) span.textContent = anyPlaying ? 'Pause All' : 'Play All';
        }

        if (el.optMuteAll) {
            const span = el.optMuteAll.querySelector('span');
            if (span) span.textContent = anyUnmuted ? 'Mute All' : 'Unmute All';
        }

        if (el.optViewAll) {
            el.optViewAll.classList.toggle('active', state.viewMode === 'all');
        }
        if (el.optViewFavorites) {
            el.optViewFavorites.classList.toggle('active', state.viewMode !== 'all');
        }
        if (el.optTetris) {
            el.optTetris.classList.toggle('active', state.tetrisMode);
        }
        if (el.optClean) {
            el.optClean.classList.toggle('active', state.cleanMode);
        }
    }

    // ============================================
    // Event Handlers
    // ============================================
    function setupEventListeners() {
        // Preview controls
        el.previewBack?.addEventListener('click', () => {
            if (selectedStreamId) send('seekRelative', { streamId: selectedStreamId, offset: -10 });
        });
        el.previewPrev?.addEventListener('click', () => {
            send('selectNext', { direction: 'left' });
        });
        el.previewPlay?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('togglePause', { streamId: selectedStreamId });
            }
        });
        el.previewNext?.addEventListener('click', () => {
            send('selectNext', { direction: 'right' });
        });
        el.previewForward?.addEventListener('click', () => {
            if (selectedStreamId) send('seekRelative', { streamId: selectedStreamId, offset: 10 });
        });

        // Action bar
        el.actionMute?.addEventListener('click', () => {
            if (selectedStreamId) send('toggleMute', { streamId: selectedStreamId });
        });
        el.actionRating?.addEventListener('click', () => {
            if (selectedStreamId) send('cycleRating', { streamId: selectedStreamId });
        });
        el.actionRandom?.addEventListener('click', () => {
            if (selectedStreamId) send('randomSeek', { streamId: selectedStreamId });
        });
        el.actionFullscreen?.addEventListener('click', () => {
            if (selectedStreamId) {
                const stream = state?.streams?.find(s => s.id === selectedStreamId);
                if (stream?.id === state?.fullscreenStreamId) {
                    send('exitFullscreen');
                } else {
                    send('enterFullscreen', { streamId: selectedStreamId });
                }
            }
        });
        el.actionMore?.addEventListener('click', openSheet);

        // Sheet
        el.sheetBackdrop?.addEventListener('click', closeSheet);
        el.sheetCancel?.addEventListener('click', closeSheet);

        el.optPauseAll?.addEventListener('click', () => { send('togglePauseAll'); closeSheet(); });
        el.optMuteAll?.addEventListener('click', () => { send('toggleMuteAll'); closeSheet(); });
        el.optGlobalFullscreen?.addEventListener('click', () => { send('toggleGlobalFullscreen'); closeSheet(); });
        el.optViewAll?.addEventListener('click', () => { send('setViewMode', { mode: 'all' }); closeSheet(); });
        el.optViewFavorites?.addEventListener('click', () => { send('cycleViewMode'); closeSheet(); });
        el.optTetris?.addEventListener('click', () => { send('toggleTetrisMode'); closeSheet(); });
        el.optClean?.addEventListener('click', () => { send('toggleCleanMode'); closeSheet(); });
        el.optRandom?.addEventListener('click', () => {
            if (selectedStreamId) send('randomSeek', { streamId: selectedStreamId });
            closeSheet();
        });
        el.optRandomAll?.addEventListener('click', () => { send('randomSeekAll'); closeSheet(); });

        // Swipe gestures on preview
        setupSwipeGestures();
    }

    function setupSwipeGestures() {
        const previewContainer = el.previewSection?.querySelector('.preview-container');
        if (!previewContainer) return;

        let startX = 0;
        let startY = 0;
        let isSwiping = false;

        // Prevent default to stop page scrolling - must be non-passive
        previewContainer.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            isSwiping = true;
        }, { passive: false });

        previewContainer.addEventListener('touchmove', (e) => {
            if (isSwiping) {
                // Prevent page scroll while swiping on preview
                e.preventDefault();
            }
        }, { passive: false });

        previewContainer.addEventListener('touchend', (e) => {
            if (!isSwiping) return;
            isSwiping = false;

            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            const deltaX = endX - startX;
            const deltaY = endY - startY;
            const absX = Math.abs(deltaX);
            const absY = Math.abs(deltaY);

            // Need at least 50px movement
            if (absX < 50 && absY < 50) return;

            if (absX > absY) {
                // Horizontal swipe
                if (deltaX > 0) {
                    send('selectNext', { direction: 'left' });
                } else {
                    send('selectNext', { direction: 'right' });
                }
            } else {
                // Vertical swipe
                if (deltaY > 0) {
                    send('selectNext', { direction: 'up' });
                } else {
                    send('selectNext', { direction: 'down' });
                }
            }
        }, { passive: false });

        previewContainer.addEventListener('touchcancel', () => {
            isSwiping = false;
        }, { passive: true });
    }

    function openSheet() {
        if (!el.moreSheet) return;
        el.moreSheet.classList.remove('hidden');
    }

    function closeSheet() {
        if (!el.moreSheet) return;
        el.moreSheet.classList.add('hidden');
    }

    // ============================================
    // Utilities
    // ============================================
    function getDisplayName(url) {
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname;
            const filename = pathname.split('/').pop() || urlObj.hostname;
            const decoded = decodeURIComponent(filename);
            return decoded.length > 40 ? decoded.substring(0, 37) + '...' : decoded;
        } catch (e) {
            return url.substring(0, 40);
        }
    }

    function formatTime(seconds) {
        if (!seconds || !isFinite(seconds)) return '0:00';

        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);

        if (h > 0) {
            return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    // ============================================
    // Initialize
    // ============================================
    function init() {
        cacheElements();
        setupEventListeners();
        setupCommunication();
        console.log('Plexd Remote initialized');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { init, send, getState: () => state };
})();

window.PlexdRemote = PlexdRemote;
