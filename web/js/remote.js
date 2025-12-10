/**
 * Plexd Remote Control
 *
 * Mobile-optimized remote control for Plexd via BroadcastChannel
 */

const PlexdRemoteClient = (function() {
    'use strict';

    let channel = null;
    let state = null;
    let connected = false;
    let lastStateTime = 0;
    let connectionCheckInterval = null;
    let selectedStreamId = null;

    // DOM elements
    const elements = {};

    /**
     * Initialize the remote control
     */
    function init() {
        // Check BroadcastChannel support
        if (typeof BroadcastChannel === 'undefined') {
            showError('BroadcastChannel not supported in this browser');
            return;
        }

        // Cache DOM elements
        cacheElements();

        // Set up BroadcastChannel
        channel = new BroadcastChannel('plexd-remote');

        channel.onmessage = (event) => {
            const { action, payload } = event.data;
            if (action === 'stateUpdate') {
                handleStateUpdate(payload);
            }
        };

        // Set up event listeners
        setupEventListeners();

        // Request initial state
        send('ping');

        // Check connection status periodically
        connectionCheckInterval = setInterval(checkConnection, 1000);

        console.log('Plexd remote client initialized');
    }

    /**
     * Cache DOM element references
     */
    function cacheElements() {
        elements.connectionStatus = document.getElementById('connection-status');
        elements.statusText = elements.connectionStatus?.querySelector('.status-text');
        elements.streamList = document.getElementById('stream-list');

        elements.btnPrev = document.getElementById('btn-prev');
        elements.btnNext = document.getElementById('btn-next');
        elements.btnPauseAll = document.getElementById('btn-pause-all');
        elements.btnMuteAll = document.getElementById('btn-mute-all');
        elements.btnSeekBack = document.getElementById('btn-seek-back');
        elements.btnSeekFwd = document.getElementById('btn-seek-fwd');
        elements.btnFullscreen = document.getElementById('btn-fullscreen');
        elements.btnViewMode = document.getElementById('btn-view-mode');
        elements.btnTetris = document.getElementById('btn-tetris');
        elements.btnClean = document.getElementById('btn-clean');
    }

    /**
     * Set up event listeners for controls
     */
    function setupEventListeners() {
        // Navigation
        elements.btnPrev?.addEventListener('click', () => send('selectNext', { direction: 'left' }));
        elements.btnNext?.addEventListener('click', () => send('selectNext', { direction: 'right' }));

        // Playback
        elements.btnPauseAll?.addEventListener('click', () => send('togglePauseAll'));
        elements.btnMuteAll?.addEventListener('click', () => send('toggleMuteAll'));

        // Seek
        elements.btnSeekBack?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('seekRelative', { streamId: selectedStreamId, offset: -10 });
            }
        });
        elements.btnSeekFwd?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('seekRelative', { streamId: selectedStreamId, offset: 10 });
            }
        });

        // View controls
        elements.btnFullscreen?.addEventListener('click', () => send('toggleGlobalFullscreen'));
        elements.btnViewMode?.addEventListener('click', () => send('cycleViewMode'));
        elements.btnTetris?.addEventListener('click', () => send('toggleTetrisMode'));
        elements.btnClean?.addEventListener('click', () => send('toggleCleanMode'));

        // Swipe gestures on stream list
        setupSwipeGestures();
    }

    /**
     * Set up swipe gestures for stream selection
     */
    function setupSwipeGestures() {
        let touchStartX = 0;
        let touchStartY = 0;

        elements.streamList?.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
        }, { passive: true });

        elements.streamList?.addEventListener('touchend', (e) => {
            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;

            const deltaX = touchEndX - touchStartX;
            const deltaY = touchEndY - touchStartY;

            // Only handle horizontal swipes (not vertical scrolling)
            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 50) {
                if (deltaX > 0) {
                    send('selectNext', { direction: 'left' });
                } else {
                    send('selectNext', { direction: 'right' });
                }
            }
        }, { passive: true });
    }

    /**
     * Send a command to the main display
     */
    function send(action, payload = {}) {
        if (!channel) return;
        channel.postMessage({ action, payload });
    }

    /**
     * Handle state update from main display
     */
    function handleStateUpdate(newState) {
        state = newState;
        lastStateTime = Date.now();
        selectedStreamId = state.selectedStreamId;

        if (!connected) {
            connected = true;
            updateConnectionStatus(true);
        }

        renderStreamList();
        updateControls();
    }

    /**
     * Check if we're still connected (receiving updates)
     */
    function checkConnection() {
        const timeSinceLastUpdate = Date.now() - lastStateTime;

        if (connected && timeSinceLastUpdate > 2000) {
            connected = false;
            updateConnectionStatus(false);
            // Try to reconnect
            send('ping');
        }
    }

    /**
     * Update connection status UI
     */
    function updateConnectionStatus(isConnected) {
        if (!elements.connectionStatus) return;

        if (isConnected) {
            elements.connectionStatus.classList.remove('disconnected');
            elements.connectionStatus.classList.add('connected');
            if (elements.statusText) {
                elements.statusText.textContent = 'Connected';
            }
        } else {
            elements.connectionStatus.classList.remove('connected');
            elements.connectionStatus.classList.add('disconnected');
            if (elements.statusText) {
                elements.statusText.textContent = 'Disconnected';
            }
        }
    }

    /**
     * Show error message
     */
    function showError(message) {
        if (elements.streamList) {
            elements.streamList.innerHTML = `
                <div class="empty-state error">
                    <p>${escapeHtml(message)}</p>
                </div>
            `;
        }
    }

    /**
     * Render the stream list
     */
    function renderStreamList() {
        if (!state || !elements.streamList) return;

        if (state.streams.length === 0) {
            elements.streamList.innerHTML = `
                <div class="empty-state">
                    <p>No streams playing</p>
                    <p class="hint">Add streams in the main Plexd app</p>
                </div>
            `;
            return;
        }

        elements.streamList.innerHTML = state.streams.map(stream => {
            const isSelected = stream.id === state.selectedStreamId;
            const isFullscreen = stream.id === state.fullscreenStreamId;
            const displayName = stream.fileName || getDisplayName(stream.url);
            const progress = stream.duration > 0 ? (stream.currentTime / stream.duration) * 100 : 0;
            const rating = stream.rating || 0;
            const ratingStars = rating > 0 ? '★'.repeat(rating) : '';
            const ratingClass = rating > 0 ? `rating-${rating}` : '';

            return `
                <div class="stream-item ${isSelected ? 'selected' : ''} ${isFullscreen ? 'fullscreen' : ''} ${ratingClass}"
                     data-stream-id="${stream.id}">
                    <div class="stream-info">
                        <div class="stream-name">${escapeHtml(displayName)}</div>
                        <div class="stream-meta">
                            <span class="stream-state ${stream.paused ? 'paused' : 'playing'}">
                                ${stream.paused ? '⏸' : '▶'}
                            </span>
                            <span class="stream-time">${formatTime(stream.currentTime)} / ${formatTime(stream.duration)}</span>
                            ${ratingStars ? `<span class="stream-rating ${ratingClass}">${ratingStars}</span>` : ''}
                            ${stream.muted ? '' : '<span class="stream-audio">🔊</span>'}
                        </div>
                    </div>
                    <div class="stream-progress">
                        <div class="stream-progress-bar" style="width: ${progress}%"></div>
                    </div>
                    <div class="stream-actions">
                        <button class="stream-btn play-btn" data-action="togglePause" title="${stream.paused ? 'Play' : 'Pause'}">
                            ${stream.paused ? '▶' : '⏸'}
                        </button>
                        <button class="stream-btn mute-btn ${stream.muted ? '' : 'active'}" data-action="toggleMute" title="${stream.muted ? 'Unmute' : 'Mute'}">
                            ${stream.muted ? '🔇' : '🔊'}
                        </button>
                        <button class="stream-btn rating-btn ${ratingClass}" data-action="cycleRating" title="Rate">
                            ${rating > 0 ? '★' : '☆'}
                        </button>
                        <button class="stream-btn fullscreen-btn ${isFullscreen ? 'active' : ''}" data-action="enterFullscreen" title="Fullscreen">
                            ⛶
                        </button>
                    </div>
                </div>
            `;
        }).join('');

        // Add click handlers for stream items
        elements.streamList.querySelectorAll('.stream-item').forEach(item => {
            const streamId = item.dataset.streamId;

            // Tap to select
            item.addEventListener('click', (e) => {
                if (e.target.closest('.stream-btn')) return; // Don't select if clicking a button
                send('selectStream', { streamId });
            });

            // Double tap for fullscreen
            let lastTap = 0;
            item.addEventListener('touchend', (e) => {
                if (e.target.closest('.stream-btn')) return;
                const now = Date.now();
                if (now - lastTap < 300) {
                    send('enterFullscreen', { streamId });
                }
                lastTap = now;
            });
        });

        // Add click handlers for stream action buttons
        elements.streamList.querySelectorAll('.stream-btn').forEach(btn => {
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                const streamId = btn.closest('.stream-item').dataset.streamId;
                const action = btn.dataset.action;

                switch (action) {
                    case 'togglePause':
                        send('togglePause', { streamId });
                        break;
                    case 'toggleMute':
                        send('toggleMute', { streamId });
                        break;
                    case 'cycleRating':
                        send('cycleRating', { streamId });
                        break;
                    case 'enterFullscreen':
                        send('enterFullscreen', { streamId });
                        break;
                }
            });
        });
    }

    /**
     * Update control button states
     */
    function updateControls() {
        if (!state) return;

        // Check if any stream is paused
        const allPaused = state.streams.length > 0 && state.streams.every(s => s.paused);
        const anyPlaying = state.streams.some(s => !s.paused);

        if (elements.btnPauseAll) {
            elements.btnPauseAll.querySelector('.icon').textContent = anyPlaying ? '⏸' : '▶';
            elements.btnPauseAll.classList.toggle('active', anyPlaying);
        }

        // Check if any stream is unmuted
        const anyUnmuted = state.streams.some(s => !s.muted);
        if (elements.btnMuteAll) {
            elements.btnMuteAll.querySelector('.icon').textContent = anyUnmuted ? '🔊' : '🔇';
            elements.btnMuteAll.classList.toggle('active', anyUnmuted);
        }

        // Fullscreen state
        if (elements.btnFullscreen) {
            elements.btnFullscreen.classList.toggle('active', state.fullscreenMode !== 'none');
        }

        // View mode
        if (elements.btnViewMode) {
            const viewText = state.viewMode === 'all' ? 'All' : '★'.repeat(state.viewMode);
            elements.btnViewMode.querySelector('.icon').textContent = viewText;
        }

        // Tetris mode
        if (elements.btnTetris) {
            elements.btnTetris.classList.toggle('active', state.tetrisMode);
        }

        // Clean mode
        if (elements.btnClean) {
            elements.btnClean.classList.toggle('active', state.cleanMode);
        }

        // Enable/disable seek buttons based on selection
        const hasSelection = state.selectedStreamId !== null;
        if (elements.btnSeekBack) {
            elements.btnSeekBack.disabled = !hasSelection;
        }
        if (elements.btnSeekFwd) {
            elements.btnSeekFwd.disabled = !hasSelection;
        }
    }

    /**
     * Get display name from URL
     */
    function getDisplayName(url) {
        try {
            const urlObj = new URL(url);
            const pathname = urlObj.pathname;
            const filename = pathname.split('/').pop() || urlObj.hostname;
            // Decode and truncate
            const decoded = decodeURIComponent(filename);
            return decoded.length > 40 ? decoded.substring(0, 37) + '...' : decoded;
        } catch (e) {
            return url.substring(0, 40);
        }
    }

    /**
     * Format time in MM:SS or HH:MM:SS
     */
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

    /**
     * Escape HTML for safe rendering
     */
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Cleanup
     */
    function destroy() {
        if (connectionCheckInterval) {
            clearInterval(connectionCheckInterval);
        }
        if (channel) {
            channel.close();
        }
    }

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return {
        init,
        send,
        getState: () => state,
        destroy
    };
})();

window.PlexdRemoteClient = PlexdRemoteClient;
