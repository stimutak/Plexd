/**
 * Plexd Remote Control
 * iPhone-optimized remote with gesture-based navigation
 */

const PlexdRemoteClient = (function() {
    'use strict';

    let channel = null;
    let state = null;
    let connected = false;
    let lastStateTime = 0;
    let connectionCheckInterval = null;
    let statePollInterval = null;
    let quickActionsVisible = false;
    let quickActionsTimeout = null;

    const COMMAND_KEY = 'plexd_remote_command';
    const STATE_KEY = 'plexd_remote_state';

    // DOM elements
    const elements = {};

    /**
     * Initialize the remote control
     */
    function init() {
        cacheElements();
        setupBroadcastChannel();
        startStatePoll();
        setupStorageListener();
        setupEventListeners();
        setupGestures();

        // Request initial state
        send('ping');

        // Check connection status periodically
        connectionCheckInterval = setInterval(checkConnection, 1000);

        console.log('Plexd remote initialized');
    }

    /**
     * Cache DOM element references
     */
    function cacheElements() {
        elements.connectionStatus = document.getElementById('connection-status');
        elements.streamPosition = document.getElementById('stream-position');
        elements.emptyState = document.getElementById('empty-state');
        elements.nowPlaying = document.getElementById('now-playing');
        elements.nowPlayingArea = document.getElementById('now-playing-area');
        elements.streamName = document.getElementById('stream-name');
        elements.streamTime = document.getElementById('stream-time');
        elements.streamProgress = document.getElementById('stream-progress');
        elements.playState = document.getElementById('play-state');
        elements.streamRating = document.getElementById('stream-rating');
        elements.audioState = document.getElementById('audio-state');
        elements.quickActions = document.getElementById('quick-actions');
        elements.btnPrev = document.getElementById('btn-prev');
        elements.btnNext = document.getElementById('btn-next');
        elements.btnPlayPause = document.getElementById('btn-play-pause');
        elements.playPauseIcon = document.getElementById('play-pause-icon');
        elements.btnMute = document.getElementById('btn-mute');
        elements.btnRating = document.getElementById('btn-rating');
        elements.btnFullscreen = document.getElementById('btn-fullscreen');
        elements.btnViewMode = document.getElementById('btn-view-mode');
        elements.viewModeIcon = document.getElementById('view-mode-icon');
    }

    /**
     * Set up BroadcastChannel for same-browser communication
     */
    function setupBroadcastChannel() {
        if (typeof BroadcastChannel !== 'undefined') {
            channel = new BroadcastChannel('plexd-remote');
            channel.onmessage = (event) => {
                const { action, payload } = event.data;
                if (action === 'stateUpdate') {
                    handleStateUpdate(payload);
                }
            };
        }
    }

    /**
     * Set up localStorage listener for cross-tab communication
     */
    function setupStorageListener() {
        window.addEventListener('storage', (e) => {
            if (e.key === STATE_KEY && e.newValue) {
                try {
                    handleStateUpdate(JSON.parse(e.newValue));
                } catch (err) {
                    // ignore parse errors
                }
            }
        });
    }

    /**
     * Poll for state updates (HTTP API + localStorage fallback)
     */
    function startStatePoll() {
        statePollInterval = setInterval(async () => {
            try {
                const res = await fetch('/api/remote/state');
                if (res.ok) {
                    const newState = await res.json();
                    if (newState.timestamp && Date.now() - newState.timestamp < 3000) {
                        handleStateUpdate(newState);
                    }
                    return;
                }
            } catch (e) {
                // API not available
            }

            // localStorage fallback
            const stateData = localStorage.getItem(STATE_KEY);
            if (stateData) {
                try {
                    const newState = JSON.parse(stateData);
                    if (newState.timestamp && Date.now() - newState.timestamp < 3000) {
                        handleStateUpdate(newState);
                    }
                } catch (e) {
                    // ignore
                }
            }
        }, 300);
    }

    /**
     * Set up event listeners for controls
     */
    function setupEventListeners() {
        // Main controls
        elements.btnPrev?.addEventListener('click', () => {
            send('selectNext', { direction: 'left' });
            hapticFeedback();
        });

        elements.btnNext?.addEventListener('click', () => {
            send('selectNext', { direction: 'right' });
            hapticFeedback();
        });

        elements.btnPlayPause?.addEventListener('click', () => {
            send('togglePauseAll');
            hapticFeedback();
        });

        // Quick action buttons
        elements.btnMute?.addEventListener('click', () => {
            if (state?.selectedStreamId) {
                send('toggleMute', { streamId: state.selectedStreamId });
                hapticFeedback();
            }
        });

        elements.btnRating?.addEventListener('click', () => {
            if (state?.selectedStreamId) {
                send('cycleRating', { streamId: state.selectedStreamId });
                hapticFeedback();
            }
        });

        elements.btnFullscreen?.addEventListener('click', () => {
            if (state?.selectedStreamId) {
                send('enterFullscreen', { streamId: state.selectedStreamId });
                hapticFeedback();
                hideQuickActions();
            }
        });

        elements.btnViewMode?.addEventListener('click', () => {
            send('cycleViewMode');
            hapticFeedback();
        });

        // Tap on now playing card to show quick actions
        elements.nowPlaying?.addEventListener('click', (e) => {
            if (!e.target.closest('button')) {
                toggleQuickActions();
                hapticFeedback();
            }
        });

        // Tap outside quick actions to close
        document.addEventListener('click', (e) => {
            if (quickActionsVisible &&
                !e.target.closest('.quick-actions') &&
                !e.target.closest('.now-playing-content')) {
                hideQuickActions();
            }
        });
    }

    /**
     * Set up swipe gestures for navigation
     */
    function setupGestures() {
        let touchStartX = 0;
        let touchStartY = 0;
        let touchStartTime = 0;
        let isSwiping = false;

        const area = elements.nowPlayingArea;
        if (!area) return;

        area.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            touchStartTime = Date.now();
            isSwiping = false;
        }, { passive: true });

        area.addEventListener('touchmove', (e) => {
            if (!touchStartX) return;

            const deltaX = e.touches[0].clientX - touchStartX;
            const deltaY = e.touches[0].clientY - touchStartY;

            // If horizontal movement is dominant, we're swiping
            if (Math.abs(deltaX) > Math.abs(deltaY) && Math.abs(deltaX) > 20) {
                isSwiping = true;
                showSwipeIndicator(deltaX > 0 ? 'left' : 'right');
            }
        }, { passive: true });

        area.addEventListener('touchend', (e) => {
            hideSwipeIndicators();

            if (!touchStartX) return;

            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;
            const deltaX = touchEndX - touchStartX;
            const deltaY = touchEndY - touchStartY;
            const duration = Date.now() - touchStartTime;

            // Swipe detection: horizontal, fast enough, long enough
            if (Math.abs(deltaX) > Math.abs(deltaY) &&
                Math.abs(deltaX) > 60 &&
                duration < 500) {

                if (deltaX > 0) {
                    send('selectNext', { direction: 'left' });
                    showToast('Previous');
                } else {
                    send('selectNext', { direction: 'right' });
                    showToast('Next');
                }
                hapticFeedback();
            }

            touchStartX = 0;
            touchStartY = 0;
        }, { passive: true });
    }

    /**
     * Show swipe direction indicator
     */
    function showSwipeIndicator(direction) {
        // Create or get indicators
        let leftIndicator = document.querySelector('.swipe-indicator.left');
        let rightIndicator = document.querySelector('.swipe-indicator.right');

        if (!leftIndicator) {
            leftIndicator = document.createElement('div');
            leftIndicator.className = 'swipe-indicator left';
            leftIndicator.textContent = '‹';
            document.body.appendChild(leftIndicator);
        }

        if (!rightIndicator) {
            rightIndicator = document.createElement('div');
            rightIndicator.className = 'swipe-indicator right';
            rightIndicator.textContent = '›';
            document.body.appendChild(rightIndicator);
        }

        leftIndicator.classList.toggle('visible', direction === 'left');
        rightIndicator.classList.toggle('visible', direction === 'right');
    }

    /**
     * Hide swipe indicators
     */
    function hideSwipeIndicators() {
        document.querySelectorAll('.swipe-indicator').forEach(el => {
            el.classList.remove('visible');
        });
    }

    /**
     * Toggle quick actions panel
     */
    function toggleQuickActions() {
        if (quickActionsVisible) {
            hideQuickActions();
        } else {
            showQuickActions();
        }
    }

    /**
     * Show quick actions panel
     */
    function showQuickActions() {
        if (!elements.quickActions || !state?.selectedStreamId) return;

        elements.quickActions.classList.remove('hidden');
        quickActionsVisible = true;

        // Auto-hide after 5 seconds
        clearTimeout(quickActionsTimeout);
        quickActionsTimeout = setTimeout(hideQuickActions, 5000);
    }

    /**
     * Hide quick actions panel
     */
    function hideQuickActions() {
        if (!elements.quickActions) return;

        elements.quickActions.classList.add('hidden');
        quickActionsVisible = false;
        clearTimeout(quickActionsTimeout);
    }

    /**
     * Show a toast notification
     */
    function showToast(message) {
        // Remove existing toast
        const existing = document.querySelector('.toast');
        if (existing) existing.remove();

        const toast = document.createElement('div');
        toast.className = 'toast';
        toast.textContent = message;
        document.body.appendChild(toast);

        setTimeout(() => {
            toast.classList.add('fade-out');
            setTimeout(() => toast.remove(), 200);
        }, 1000);
    }

    /**
     * Trigger haptic feedback if available
     */
    function hapticFeedback() {
        if ('vibrate' in navigator) {
            navigator.vibrate(10);
        }
    }

    /**
     * Send a command to the main display
     */
    function send(action, payload = {}) {
        const command = {
            action,
            payload,
            timestamp: Date.now()
        };

        // BroadcastChannel for same-browser
        if (channel) {
            channel.postMessage(command);
        }

        // HTTP API for cross-device
        fetch('/api/remote/command', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(command)
        }).catch(() => {
            // API not available, fall back to localStorage
            try {
                localStorage.setItem(COMMAND_KEY, JSON.stringify(command));
            } catch (e) {
                console.warn('Could not write command');
            }
        });
    }

    /**
     * Handle state update from main display
     */
    function handleStateUpdate(newState) {
        state = newState;
        lastStateTime = Date.now();

        if (!connected) {
            connected = true;
            updateConnectionStatus(true);
        }

        updateNowPlaying();
        updateControls();
    }

    /**
     * Check if we're still connected
     */
    function checkConnection() {
        const timeSinceLastUpdate = Date.now() - lastStateTime;

        if (connected && timeSinceLastUpdate > 2000) {
            connected = false;
            updateConnectionStatus(false);
            send('ping');
        }
    }

    /**
     * Update connection status UI
     */
    function updateConnectionStatus(isConnected) {
        if (!elements.connectionStatus) return;

        elements.connectionStatus.classList.toggle('connected', isConnected);
        elements.connectionStatus.classList.toggle('disconnected', !isConnected);
    }

    /**
     * Update the Now Playing display
     */
    function updateNowPlaying() {
        if (!state) return;

        // Show/hide states
        const hasStreams = state.streams && state.streams.length > 0;
        elements.emptyState?.classList.toggle('hidden', hasStreams);
        elements.nowPlaying?.classList.toggle('hidden', !hasStreams);

        if (!hasStreams) {
            elements.streamPosition.textContent = '-';
            return;
        }

        // Find selected stream or use first
        const selectedId = state.selectedStreamId;
        let stream = state.streams.find(s => s.id === selectedId);
        let streamIndex = state.streams.findIndex(s => s.id === selectedId);

        if (!stream) {
            stream = state.streams[0];
            streamIndex = 0;
        }

        // Update position counter
        elements.streamPosition.textContent = `${streamIndex + 1} / ${state.streams.length}`;

        // Update stream info
        const displayName = stream.fileName || getDisplayName(stream.url);
        elements.streamName.textContent = displayName;

        // Time display
        const currentTime = formatTime(stream.currentTime);
        const duration = formatTime(stream.duration);
        elements.streamTime.textContent = `${currentTime} / ${duration}`;

        // Progress bar
        const progress = stream.duration > 0 ? (stream.currentTime / stream.duration) * 100 : 0;
        elements.streamProgress.style.width = `${progress}%`;

        // Play state
        elements.playState.textContent = stream.paused ? '⏸' : '▶';
        elements.playState.classList.toggle('paused', stream.paused);

        // Rating
        const rating = stream.rating || 0;
        elements.streamRating.textContent = rating > 0 ? '★'.repeat(rating) : '';

        // Audio state
        elements.audioState.textContent = stream.muted ? '🔇' : '🔊';
        elements.audioState.classList.toggle('muted', stream.muted);

        // Update quick action buttons
        if (elements.btnMute) {
            elements.btnMute.classList.toggle('active', !stream.muted);
            elements.btnMute.querySelector('.quick-icon').textContent = stream.muted ? '🔇' : '🔊';
            elements.btnMute.querySelector('.quick-label').textContent = stream.muted ? 'Unmute' : 'Mute';
        }

        if (elements.btnRating) {
            const ratingIcon = rating > 0 ? '★' : '☆';
            elements.btnRating.querySelector('.quick-icon').textContent = ratingIcon;
        }

        const isFullscreen = stream.id === state.fullscreenStreamId;
        if (elements.btnFullscreen) {
            elements.btnFullscreen.classList.toggle('active', isFullscreen);
        }
    }

    /**
     * Update control button states
     */
    function updateControls() {
        if (!state) return;

        // Play/Pause button state
        const anyPlaying = state.streams && state.streams.some(s => !s.paused);

        if (elements.btnPlayPause) {
            elements.btnPlayPause.classList.toggle('paused', !anyPlaying);
        }

        if (elements.playPauseIcon) {
            elements.playPauseIcon.textContent = anyPlaying ? '⏸' : '▶';
            // Adjust centering for pause icon
            elements.playPauseIcon.style.marginLeft = anyPlaying ? '0' : '4px';
        }

        // View mode
        if (elements.viewModeIcon) {
            const viewText = state.viewMode === 'all' ? '★' : '★'.repeat(state.viewMode);
            elements.viewModeIcon.textContent = viewText;
        }

        if (elements.btnViewMode) {
            elements.btnViewMode.classList.toggle('active', state.viewMode !== 'all');
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
            const decoded = decodeURIComponent(filename);
            // Remove file extension for cleaner display
            const withoutExt = decoded.replace(/\.[^/.]+$/, '');
            return withoutExt.length > 50 ? withoutExt.substring(0, 47) + '...' : withoutExt;
        } catch (e) {
            return url.substring(0, 50);
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
     * Cleanup
     */
    function destroy() {
        if (connectionCheckInterval) {
            clearInterval(connectionCheckInterval);
        }
        if (statePollInterval) {
            clearInterval(statePollInterval);
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
