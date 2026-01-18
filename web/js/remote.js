/**
 * Plexd Remote Control - iOS Optimized
 * Beautiful, minimal, intuitive remote interface
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
    let playerExpanded = false;

    const COMMAND_KEY = 'plexd_remote_command';
    const STATE_KEY = 'plexd_remote_state';
    const POLL_INTERVAL = 300;
    const CONNECTION_TIMEOUT = 2000;

    // ============================================
    // DOM Elements
    // ============================================
    const $ = (id) => document.getElementById(id);
    const el = {};

    function cacheElements() {
        // Main sections
        el.connection = $('connection');
        el.emptyState = $('empty-state');
        el.streams = $('streams');

        // Now playing bar
        el.nowPlaying = $('now-playing');
        el.npProgressBar = el.nowPlaying?.querySelector('.now-playing-progress-bar');
        el.npTitle = el.nowPlaying?.querySelector('.now-playing-title');
        el.npTime = el.nowPlaying?.querySelector('.now-playing-time');
        el.npPrev = $('np-prev');
        el.npPlay = $('np-play');
        el.npNext = $('np-next');

        // Full player
        el.player = $('player');
        el.playerTitle = $('player-title');
        el.playerMeta = $('player-meta');
        el.playerProgress = $('player-progress');
        el.playerCurrent = $('player-current');
        el.playerDuration = $('player-duration');

        // Player controls
        el.ctrlBack = $('ctrl-back');
        el.ctrlPrev = $('ctrl-prev');
        el.ctrlPlay = $('ctrl-play');
        el.ctrlNext = $('ctrl-next');
        el.ctrlForward = $('ctrl-forward');

        // Player actions
        el.actionMute = $('action-mute');
        el.actionRating = $('action-rating');
        el.actionFullscreen = $('action-fullscreen');
        el.actionMore = $('action-more');

        // Bottom sheet
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

        // Listen for localStorage changes (same device, cross-tab)
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

        // Poll for state (HTTP API + localStorage fallback)
        setInterval(pollState, POLL_INTERVAL);

        // Check connection status
        setInterval(checkConnection, 1000);

        // Initial ping
        send('ping');
    }

    async function pollState() {
        try {
            // Try HTTP API first
            const res = await fetch('/api/remote/state');
            if (res.ok) {
                const newState = await res.json();
                if (newState.timestamp && Date.now() - newState.timestamp < 3000) {
                    handleStateUpdate(newState);
                    return;
                }
            }
        } catch (e) { /* API not available */ }

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

        // BroadcastChannel
        if (channel) {
            channel.postMessage(command);
        }

        // HTTP API
        fetch('/api/remote/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(command)
        }).catch(() => {
            // Fallback to localStorage
            try {
                localStorage.setItem(COMMAND_KEY, JSON.stringify(command));
            } catch (e) { /* ignore */ }
        });
    }

    function handleStateUpdate(newState) {
        state = newState;
        lastStateTime = Date.now();
        selectedStreamId = state.selectedStreamId;

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

        renderStreams();
        renderNowPlaying();
        renderPlayer();
        renderSheet();
    }

    function renderStreams() {
        if (!el.streams || !el.emptyState) return;

        if (!state.streams || state.streams.length === 0) {
            el.streams.innerHTML = '';
            el.emptyState.classList.remove('hidden');
            el.nowPlaying?.classList.add('hidden');
            return;
        }

        el.emptyState.classList.add('hidden');

        el.streams.innerHTML = state.streams.map(stream => {
            const isSelected = stream.id === state.selectedStreamId;
            const isFullscreen = stream.id === state.fullscreenStreamId;
            const name = stream.fileName || getDisplayName(stream.url);
            const progress = stream.duration > 0 ? (stream.currentTime / stream.duration) * 100 : 0;
            const rating = stream.rating || 0;
            const ratingClass = rating > 0 ? `rating-${rating}` : '';
            const ratingStars = rating > 0 ? '\u2605'.repeat(rating) : '';

            return `
                <div class="stream-card ${isSelected ? 'selected' : ''} ${isFullscreen ? 'fullscreen' : ''} ${ratingClass}"
                     data-id="${stream.id}">
                    <div class="stream-card-content">
                        <div class="stream-card-header">
                            <div class="stream-card-info">
                                <div class="stream-card-name">${escapeHtml(name)}</div>
                                <div class="stream-card-meta">
                                    <span class="stream-card-status ${stream.paused ? '' : 'playing'}">
                                        <svg viewBox="0 0 24 24" fill="currentColor">
                                            ${stream.paused
                                                ? '<path d="M6 19h4V5H6zm8-14v14h4V5z"/>'
                                                : '<path d="M8 5v14l11-7z"/>'}
                                        </svg>
                                        ${stream.paused ? 'Paused' : 'Playing'}
                                    </span>
                                    ${ratingStars ? `<span class="stream-card-rating">${ratingStars}</span>` : ''}
                                    ${!stream.muted ? `
                                        <span class="stream-card-audio">
                                            <svg viewBox="0 0 24 24" fill="currentColor">
                                                <path d="M3 9v6h4l5 5V4L7 9H3zm13.5 3c0-1.77-1.02-3.29-2.5-4.03v8.05c1.48-.73 2.5-2.25 2.5-4.02z"/>
                                            </svg>
                                        </span>
                                    ` : ''}
                                </div>
                            </div>
                            <button class="stream-card-action" data-action="play">
                                <svg viewBox="0 0 24 24" fill="currentColor">
                                    ${stream.paused
                                        ? '<path d="M8 5v14l11-7z"/>'
                                        : '<path d="M6 19h4V5H6zm8-14v14h4V5z"/>'}
                                </svg>
                            </button>
                        </div>
                        <div class="stream-card-progress">
                            <div class="stream-card-progress-bar" style="width: ${progress}%"></div>
                        </div>
                        <div class="stream-card-time">
                            <span>${formatTime(stream.currentTime)}</span>
                            <span>${formatTime(stream.duration)}</span>
                        </div>
                    </div>
                </div>
            `;
        }).join('');

        // Attach event listeners
        el.streams.querySelectorAll('.stream-card').forEach(card => {
            const id = card.dataset.id;

            // Tap card to select
            card.addEventListener('click', (e) => {
                if (e.target.closest('.stream-card-action')) return;
                send('selectStream', { streamId: id });
            });

            // Double tap for fullscreen
            let lastTap = 0;
            card.addEventListener('touchend', (e) => {
                if (e.target.closest('.stream-card-action')) return;
                const now = Date.now();
                if (now - lastTap < 300) {
                    send('enterFullscreen', { streamId: id });
                }
                lastTap = now;
            });

            // Play button
            const playBtn = card.querySelector('.stream-card-action');
            playBtn?.addEventListener('click', (e) => {
                e.stopPropagation();
                send('togglePause', { streamId: id });
            });
        });
    }

    function renderNowPlaying() {
        if (!el.nowPlaying || !state.streams || state.streams.length === 0) {
            el.nowPlaying?.classList.add('hidden');
            return;
        }

        const stream = state.streams.find(s => s.id === selectedStreamId) || state.streams[0];
        if (!stream) {
            el.nowPlaying.classList.add('hidden');
            return;
        }

        el.nowPlaying.classList.remove('hidden');

        const name = stream.fileName || getDisplayName(stream.url);
        const progress = stream.duration > 0 ? (stream.currentTime / stream.duration) * 100 : 0;

        if (el.npTitle) el.npTitle.textContent = name;
        if (el.npTime) el.npTime.textContent = `${formatTime(stream.currentTime)} / ${formatTime(stream.duration)}`;
        if (el.npProgressBar) el.npProgressBar.style.width = `${progress}%`;

        // Update play button state
        if (el.npPlay) {
            el.npPlay.classList.toggle('paused', stream.paused);
        }
    }

    function renderPlayer() {
        if (!el.player || !state.streams || state.streams.length === 0) return;

        const stream = state.streams.find(s => s.id === selectedStreamId) || state.streams[0];
        if (!stream) return;

        const name = stream.fileName || getDisplayName(stream.url);
        const progress = stream.duration > 0 ? (stream.currentTime / stream.duration) * 100 : 0;
        const rating = stream.rating || 0;

        if (el.playerTitle) el.playerTitle.textContent = name;
        if (el.playerMeta) {
            const parts = [];
            if (rating > 0) parts.push('\u2605'.repeat(rating));
            if (!stream.paused) parts.push('Playing');
            if (!stream.muted) parts.push('Audio on');
            el.playerMeta.textContent = parts.join(' \u2022 ');
        }

        if (el.playerProgress) {
            el.playerProgress.value = progress;
            el.playerProgress.style.setProperty('--progress', `${progress}%`);
        }

        if (el.playerCurrent) el.playerCurrent.textContent = formatTime(stream.currentTime);
        if (el.playerDuration) el.playerDuration.textContent = formatTime(stream.duration);

        // Play button state
        if (el.ctrlPlay) {
            el.ctrlPlay.classList.toggle('paused', stream.paused);
        }

        // Mute button state
        if (el.actionMute) {
            el.actionMute.classList.toggle('muted', stream.muted);
            const label = el.actionMute.querySelector('span');
            if (label) label.textContent = stream.muted ? 'Unmute' : 'Mute';
        }

        // Fullscreen state
        if (el.actionFullscreen) {
            const isFs = stream.id === state.fullscreenStreamId;
            el.actionFullscreen.classList.toggle('active', isFs);
            const label = el.actionFullscreen.querySelector('span');
            if (label) label.textContent = isFs ? 'Unfocus' : 'Focus';
        }

        // Rating button state
        if (el.actionRating) {
            el.actionRating.classList.toggle('active', rating > 0);
            const label = el.actionRating.querySelector('span');
            if (label) label.textContent = rating > 0 ? `${rating} Star${rating > 1 ? 's' : ''}` : 'Rate';
        }
    }

    function renderSheet() {
        if (!el.moreSheet || !state) return;

        // Update active states for options
        const anyPlaying = state.streams?.some(s => !s.paused);
        const anyUnmuted = state.streams?.some(s => !s.muted);

        // Pause all button text
        if (el.optPauseAll) {
            const span = el.optPauseAll.querySelector('span');
            if (span) span.textContent = anyPlaying ? 'Pause All' : 'Play All';
        }

        // Mute all button text
        if (el.optMuteAll) {
            const span = el.optMuteAll.querySelector('span');
            if (span) span.textContent = anyUnmuted ? 'Mute All' : 'Unmute All';
        }

        // View mode states
        if (el.optViewAll) {
            el.optViewAll.classList.toggle('active', state.viewMode === 'all');
        }
        if (el.optViewFavorites) {
            el.optViewFavorites.classList.toggle('active', state.viewMode !== 'all');
        }

        // Tetris mode
        if (el.optTetris) {
            el.optTetris.classList.toggle('active', state.tetrisMode);
        }

        // Clean mode
        if (el.optClean) {
            el.optClean.classList.toggle('active', state.cleanMode);
        }
    }

    // ============================================
    // Event Handlers
    // ============================================
    function setupEventListeners() {
        // Now Playing bar - tap to expand player
        el.nowPlaying?.querySelector('.now-playing-info')?.addEventListener('click', () => {
            expandPlayer();
        });

        // Now Playing controls
        el.npPrev?.addEventListener('click', (e) => {
            e.stopPropagation();
            send('selectNext', { direction: 'left' });
        });
        el.npPlay?.addEventListener('click', (e) => {
            e.stopPropagation();
            if (selectedStreamId) {
                send('togglePause', { streamId: selectedStreamId });
            } else {
                send('togglePauseAll');
            }
        });
        el.npNext?.addEventListener('click', (e) => {
            e.stopPropagation();
            send('selectNext', { direction: 'right' });
        });

        // Player handle - swipe down to close
        setupPlayerGestures();

        // Player controls
        el.ctrlBack?.addEventListener('click', () => {
            if (selectedStreamId) send('seekRelative', { streamId: selectedStreamId, offset: -10 });
        });
        el.ctrlPrev?.addEventListener('click', () => send('selectNext', { direction: 'left' }));
        el.ctrlPlay?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('togglePause', { streamId: selectedStreamId });
            } else {
                send('togglePauseAll');
            }
        });
        el.ctrlNext?.addEventListener('click', () => send('selectNext', { direction: 'right' }));
        el.ctrlForward?.addEventListener('click', () => {
            if (selectedStreamId) send('seekRelative', { streamId: selectedStreamId, offset: 10 });
        });

        // Player progress scrubbing
        el.playerProgress?.addEventListener('input', (e) => {
            if (selectedStreamId && state) {
                const stream = state.streams?.find(s => s.id === selectedStreamId);
                if (stream && stream.duration > 0) {
                    const time = (e.target.value / 100) * stream.duration;
                    send('seek', { streamId: selectedStreamId, time });
                }
            }
        });

        // Player actions
        el.actionMute?.addEventListener('click', () => {
            if (selectedStreamId) send('toggleMute', { streamId: selectedStreamId });
        });
        el.actionRating?.addEventListener('click', () => {
            if (selectedStreamId) send('cycleRating', { streamId: selectedStreamId });
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
        el.actionMore?.addEventListener('click', () => openSheet());

        // Sheet controls
        el.sheetBackdrop?.addEventListener('click', closeSheet);
        el.sheetCancel?.addEventListener('click', closeSheet);

        el.optPauseAll?.addEventListener('click', () => {
            send('togglePauseAll');
            closeSheet();
        });
        el.optMuteAll?.addEventListener('click', () => {
            send('toggleMuteAll');
            closeSheet();
        });
        el.optGlobalFullscreen?.addEventListener('click', () => {
            send('toggleGlobalFullscreen');
            closeSheet();
        });
        el.optViewAll?.addEventListener('click', () => {
            send('setViewMode', { mode: 'all' });
            closeSheet();
        });
        el.optViewFavorites?.addEventListener('click', () => {
            send('cycleViewMode');
            closeSheet();
        });
        el.optTetris?.addEventListener('click', () => {
            send('toggleTetrisMode');
            closeSheet();
        });
        el.optClean?.addEventListener('click', () => {
            send('toggleCleanMode');
            closeSheet();
        });

        // Swipe gestures on stream list
        setupSwipeGestures();
    }

    function setupPlayerGestures() {
        if (!el.player) return;

        let startY = 0;
        let currentY = 0;

        const handle = el.player.querySelector('.player-handle');
        const content = el.player.querySelector('.player-content');

        // Tap handle area to collapse
        handle?.addEventListener('click', collapsePlayer);

        // Swipe down to collapse
        el.player.addEventListener('touchstart', (e) => {
            if (!playerExpanded) return;
            startY = e.touches[0].clientY;
        }, { passive: true });

        el.player.addEventListener('touchmove', (e) => {
            if (!playerExpanded) return;
            currentY = e.touches[0].clientY;
            const deltaY = currentY - startY;

            if (deltaY > 0) {
                // Swiping down
                el.player.style.transform = `translateY(${Math.min(deltaY, 200)}px)`;
            }
        }, { passive: true });

        el.player.addEventListener('touchend', () => {
            if (!playerExpanded) return;
            const deltaY = currentY - startY;

            el.player.style.transform = '';

            if (deltaY > 100) {
                collapsePlayer();
            }

            startY = 0;
            currentY = 0;
        }, { passive: true });
    }

    function setupSwipeGestures() {
        if (!el.streams) return;

        let startX = 0;
        let startY = 0;

        el.streams.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
        }, { passive: true });

        el.streams.addEventListener('touchend', (e) => {
            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            const deltaX = endX - startX;
            const deltaY = endY - startY;

            // Only handle horizontal swipes
            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
                if (deltaX > 0) {
                    send('selectNext', { direction: 'left' });
                } else {
                    send('selectNext', { direction: 'right' });
                }
            }
        }, { passive: true });
    }

    // ============================================
    // Player Expand/Collapse
    // ============================================
    function expandPlayer() {
        if (!el.player) return;
        playerExpanded = true;
        el.player.classList.add('expanded');
        document.body.style.overflow = 'hidden';
    }

    function collapsePlayer() {
        if (!el.player) return;
        playerExpanded = false;
        el.player.classList.remove('expanded');
        document.body.style.overflow = '';
    }

    // ============================================
    // Sheet Open/Close
    // ============================================
    function openSheet() {
        if (!el.moreSheet) return;
        el.moreSheet.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    }

    function closeSheet() {
        if (!el.moreSheet) return;
        el.moreSheet.classList.add('hidden');
        document.body.style.overflow = '';
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
            return decoded.length > 50 ? decoded.substring(0, 47) + '...' : decoded;
        } catch (e) {
            return url.substring(0, 50);
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

    // Auto-init when DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    // Public API
    return {
        init,
        send,
        getState: () => state,
        expandPlayer,
        collapsePlayer
    };
})();

window.PlexdRemote = PlexdRemote;
