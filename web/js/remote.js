/**
 * Plexd Remote - Triage Mode
 * Ergonomic, one-thumb operation for rapid clip review
 *
 * Core workflow:
 * 1. Swipe left/right to switch streams (within current filter)
 * 2. Swipe up to random seek
 * 3. Tap progress bar to seek
 * 4. Tap 1-9 to rate
 * 5. Tap filter tabs to show only clips with that exact rating
 * 6. Audio toggle for current stream
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
    let lastLocalSelectionTime = 0;
    let currentFilter = 'all'; // 'all', '0', '1', '2', ... '9' (exact rating)
    let filteredStreams = []; // Streams matching current filter
    let currentIndex = 0; // Index within filteredStreams
    let swipeHintShown = false;
    let isDraggingProgress = false;

    const COMMAND_KEY = 'plexd_remote_command';
    const STATE_KEY = 'plexd_remote_state';
    const POLL_INTERVAL = 300;
    const CONNECTION_TIMEOUT = 2000;
    const SELECTION_GRACE_PERIOD = 1000;
    const SWIPE_THRESHOLD = 50;

    // ============================================
    // DOM Elements
    // ============================================
    const $ = (id) => document.getElementById(id);
    const el = {};

    function cacheElements() {
        // Header
        el.audioToggle = $('audio-toggle');
        el.connection = $('connection');

        // Main sections
        el.emptyState = $('empty-state');
        el.triageUI = $('triage-ui');

        // Hero
        el.hero = $('hero');
        el.heroPreview = $('hero-preview');
        el.heroImage = $('hero-image');
        el.heroStatus = $('hero-status');
        el.heroCounter = $('hero-counter');
        el.swipeHintLR = $('swipe-hint-lr');
        el.swipeHintUD = $('swipe-hint-ud');

        // Info
        el.streamTitle = $('stream-title');
        el.streamTime = $('stream-time');

        // Progress
        el.progressTrack = $('progress-track');
        el.progressFill = $('progress-fill');
        el.progressThumb = $('progress-thumb');

        // Actions
        el.btnBack = $('btn-back');
        el.btnRandom = $('btn-random');
        el.btnPlay = $('btn-play');
        el.btnForward = $('btn-forward');
        el.btnFocus = $('btn-focus');

        // Rating
        el.ratingStrip = $('rating-strip');

        // Filters
        el.filterTabs = $('filter-tabs');

        // Thumbnails
        el.thumbsSection = $('thumbs-section');
        el.thumbsStrip = $('thumbs-strip');

        // Sheet
        el.moreSheet = $('more-sheet');
        el.sheetBackdrop = el.moreSheet?.querySelector('.sheet-backdrop');
        el.sheetCancel = $('sheet-cancel');
        el.optPauseAll = $('opt-pause-all');
        el.optMuteAll = $('opt-mute-all');
        el.optRandomAll = $('opt-random-all');
        el.optTetris = $('opt-tetris');
        el.optClean = $('opt-clean');
    }

    // ============================================
    // Communication
    // ============================================
    function setupCommunication() {
        if (typeof BroadcastChannel !== 'undefined') {
            channel = new BroadcastChannel('plexd-remote');
            channel.onmessage = (e) => {
                if (e.data.action === 'stateUpdate') {
                    handleStateUpdate(e.data.payload);
                }
            };
        }

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

        setInterval(pollState, POLL_INTERVAL);
        setInterval(checkConnection, 1000);
        send('ping');
    }

    async function pollState() {
        try {
            const res = await fetch('/api/remote/state');
            if (res.ok) {
                const newState = await res.json();
                const age = Date.now() - (newState.timestamp || 0);
                if (newState.timestamp && age < 3000) {
                    handleStateUpdate(newState);
                    return;
                }
            }
        } catch (e) {
            // Silently fail - will try localStorage
        }

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
        console.log('[Remote] Sending:', action, payload);

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

        // Update filtered streams
        updateFilteredStreams();

        // Handle selection
        if (!selectedStreamId && filteredStreams.length > 0) {
            selectedStreamId = state.selectedStreamId || filteredStreams[0].id;
            updateCurrentIndex();
        } else if (!withinGracePeriod && state.selectedStreamId) {
            selectedStreamId = state.selectedStreamId;
            updateCurrentIndex();
        }

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
    // Filtering
    // ============================================
    function updateFilteredStreams() {
        if (!state?.streams) {
            filteredStreams = [];
            return;
        }

        if (currentFilter === 'all') {
            filteredStreams = [...state.streams];
        } else {
            const targetRating = parseInt(currentFilter, 10);
            filteredStreams = state.streams.filter(s => (s.rating || 0) === targetRating);
        }
    }

    function updateCurrentIndex() {
        if (!selectedStreamId || filteredStreams.length === 0) {
            currentIndex = 0;
            return;
        }
        const idx = filteredStreams.findIndex(s => s.id === selectedStreamId);
        currentIndex = idx >= 0 ? idx : 0;
    }

    function getFilterCounts() {
        const counts = { all: 0, 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
        if (!state?.streams) return counts;

        counts.all = state.streams.length;
        state.streams.forEach(s => {
            const rating = s.rating || 0;
            counts[rating] = (counts[rating] || 0) + 1;
        });
        return counts;
    }

    // ============================================
    // Navigation
    // ============================================
    function navigateStream(direction) {
        if (filteredStreams.length === 0) return;

        if (direction === 'next' || direction === 'right') {
            currentIndex = (currentIndex + 1) % filteredStreams.length;
        } else if (direction === 'prev' || direction === 'left') {
            currentIndex = (currentIndex - 1 + filteredStreams.length) % filteredStreams.length;
        }

        const stream = filteredStreams[currentIndex];
        if (stream) {
            selectedStreamId = stream.id;
            lastLocalSelectionTime = Date.now();
            send('selectStream', { streamId: stream.id });
            render();
        }
    }

    function selectStreamById(streamId) {
        selectedStreamId = streamId;
        lastLocalSelectionTime = Date.now();
        updateCurrentIndex();
        send('selectStream', { streamId });
        render();
    }

    // ============================================
    // Rendering
    // ============================================
    function render() {
        if (!state) return;

        const hasStreams = state.streams && state.streams.length > 0;

        el.emptyState?.classList.toggle('hidden', hasStreams);
        el.triageUI?.classList.toggle('hidden', !hasStreams);

        if (hasStreams) {
            renderHero();
            renderInfo();
            renderActions();
            renderRating();
            renderFilters();
            renderThumbnails();
            renderAudioButton();
        }
    }

    function renderHero() {
        const stream = getCurrentStream();
        if (!stream) return;

        // Thumbnail
        if (el.heroImage) {
            if (stream.thumbnail) {
                el.heroImage.src = stream.thumbnail;
                el.heroImage.classList.add('visible');
            } else {
                el.heroImage.classList.remove('visible');
            }
        }

        // Status
        if (el.heroStatus) {
            const isPlaying = !stream.paused;
            el.heroStatus.classList.toggle('playing', isPlaying);
            el.heroStatus.classList.toggle('paused', !isPlaying);
            const statusText = el.heroStatus.querySelector('.status-text');
            if (statusText) {
                statusText.textContent = isPlaying ? 'Playing' : 'Paused';
            }
        }

        // Counter
        if (el.heroCounter) {
            const total = filteredStreams.length;
            el.heroCounter.textContent = total > 0 ? `${currentIndex + 1} / ${total}` : '0 / 0';
        }

        // Hide swipe hints after first interaction
        if (!swipeHintShown) {
            el.swipeHintLR?.classList.remove('faded');
            el.swipeHintUD?.classList.remove('faded');
        }
    }

    function renderInfo() {
        const stream = getCurrentStream();
        if (!stream) return;

        const name = stream.fileName || getDisplayName(stream.url);
        if (el.streamTitle) el.streamTitle.textContent = name;

        if (el.streamTime) {
            el.streamTime.textContent = `${formatTime(stream.currentTime)} / ${formatTime(stream.duration)}`;
        }

        // Progress bar (only if not dragging)
        if (!isDraggingProgress) {
            const progress = stream.duration > 0 ? (stream.currentTime / stream.duration) * 100 : 0;
            if (el.progressFill) el.progressFill.style.width = `${progress}%`;
            if (el.progressThumb) el.progressThumb.style.left = `${progress}%`;
        }
    }

    function renderActions() {
        const stream = getCurrentStream();
        if (!stream) return;

        // Play button state
        if (el.btnPlay) {
            el.btnPlay.classList.toggle('playing', !stream.paused);
        }

        // Focus button state
        if (el.btnFocus) {
            const isFocused = stream.id === state.fullscreenStreamId;
            el.btnFocus.classList.toggle('active', isFocused);
        }
    }

    function renderRating() {
        const stream = getCurrentStream();
        const rating = stream?.rating || 0;

        el.ratingStrip?.querySelectorAll('.rating-btn').forEach(btn => {
            const btnRating = parseInt(btn.dataset.rating, 10);
            btn.classList.toggle('active', btnRating === rating);
        });
    }

    function renderFilters() {
        const counts = getFilterCounts();

        el.filterTabs?.querySelectorAll('.filter-tab').forEach(tab => {
            const filter = tab.dataset.filter;
            const isActive = filter === currentFilter;
            const count = filter === 'all' ? counts.all : (counts[filter] || 0);
            const isEmpty = count === 0;

            tab.classList.toggle('active', isActive);
            tab.classList.toggle('empty', isEmpty);

            const countEl = tab.querySelector('.filter-count');
            if (countEl) countEl.textContent = count;
        });
    }

    function renderThumbnails() {
        if (!el.thumbsStrip) return;

        if (filteredStreams.length === 0) {
            el.thumbsStrip.innerHTML = '<div class="no-streams-msg">No streams match filter</div>';
            return;
        }

        el.thumbsStrip.innerHTML = filteredStreams.map((stream, idx) => {
            const isSelected = stream.id === selectedStreamId;
            const isFocused = stream.id === state?.fullscreenStreamId;
            const rating = stream.rating || 0;
            const hasThumbnail = !!stream.thumbnail;

            return `
                <div class="thumb-item ${isSelected ? 'selected' : ''} ${isFocused ? 'focused' : ''}"
                     data-id="${stream.id}" data-index="${idx}">
                    ${hasThumbnail
                        ? `<img class="thumb-img" src="${stream.thumbnail}" alt="">`
                        : `<div class="thumb-placeholder"></div>`
                    }
                    ${rating > 0 ? `<span class="thumb-rating">${rating}</span>` : ''}
                </div>
            `;
        }).join('');

        // Event listeners
        el.thumbsStrip.querySelectorAll('.thumb-item').forEach(item => {
            item.addEventListener('click', () => {
                selectStreamById(item.dataset.id);
            });
        });

        // Scroll selected into view
        const selectedThumb = el.thumbsStrip.querySelector('.thumb-item.selected');
        if (selectedThumb) {
            selectedThumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
    }

    function renderAudioButton() {
        const stream = getCurrentStream();
        if (!el.audioToggle || !stream) return;

        const isMuted = stream.muted;
        el.audioToggle.classList.toggle('muted', isMuted);
        el.audioToggle.classList.toggle('unmuted', !isMuted);
    }

    function getCurrentStream() {
        if (!state?.streams || !selectedStreamId) {
            return filteredStreams[0] || state?.streams?.[0];
        }
        return state.streams.find(s => s.id === selectedStreamId) || filteredStreams[0];
    }

    // ============================================
    // Event Handlers
    // ============================================
    function setupEventListeners() {
        // Audio toggle
        el.audioToggle?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('toggleMute', { streamId: selectedStreamId });
            }
        });

        // Action buttons
        el.btnBack?.addEventListener('click', () => {
            if (selectedStreamId) send('seekRelative', { streamId: selectedStreamId, offset: -10 });
        });

        el.btnForward?.addEventListener('click', () => {
            if (selectedStreamId) send('seekRelative', { streamId: selectedStreamId, offset: 10 });
        });

        el.btnRandom?.addEventListener('click', () => {
            if (selectedStreamId) send('randomSeek', { streamId: selectedStreamId });
        });

        el.btnPlay?.addEventListener('click', () => {
            if (selectedStreamId) send('togglePause', { streamId: selectedStreamId });
        });

        el.btnFocus?.addEventListener('click', () => {
            if (!selectedStreamId) return;
            if (state?.fullscreenStreamId === selectedStreamId) {
                send('exitFullscreen');
            } else {
                send('enterFullscreen', { streamId: selectedStreamId });
            }
        });

        // Rating buttons
        el.ratingStrip?.querySelectorAll('.rating-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const rating = parseInt(btn.dataset.rating, 10);
                if (selectedStreamId) {
                    send('setRating', { streamId: selectedStreamId, rating });
                    // Visual feedback
                    btn.classList.add('just-set');
                    setTimeout(() => btn.classList.remove('just-set'), 300);
                }
            });
        });

        // Filter tabs
        el.filterTabs?.querySelectorAll('.filter-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                const newFilter = tab.dataset.filter;
                if (newFilter === currentFilter) return;

                currentFilter = newFilter;
                updateFilteredStreams();

                // Sync view mode to main Plex app
                const viewMode = newFilter === 'all' ? 'all' : parseInt(newFilter, 10);
                send('setViewMode', { mode: viewMode });

                // Try to keep current stream if it's in the filter
                if (selectedStreamId) {
                    const inFilter = filteredStreams.some(s => s.id === selectedStreamId);
                    if (!inFilter && filteredStreams.length > 0) {
                        selectedStreamId = filteredStreams[0].id;
                        lastLocalSelectionTime = Date.now();
                        send('selectStream', { streamId: selectedStreamId });
                    }
                }
                updateCurrentIndex();
                render();
            });
        });

        // Swipe gestures on hero
        setupHeroGestures();

        // Progress bar interactions
        setupProgressBar();

        // Sheet
        el.sheetBackdrop?.addEventListener('click', closeSheet);
        el.sheetCancel?.addEventListener('click', closeSheet);

        el.optPauseAll?.addEventListener('click', () => { send('togglePauseAll'); closeSheet(); });
        el.optMuteAll?.addEventListener('click', () => { send('toggleMuteAll'); closeSheet(); });
        el.optRandomAll?.addEventListener('click', () => { send('randomSeekAll'); closeSheet(); });
        el.optTetris?.addEventListener('click', () => { send('toggleTetrisMode'); closeSheet(); });
        el.optClean?.addEventListener('click', () => { send('toggleCleanMode'); closeSheet(); });

        // Long press on random for more options
        let longPressTimer = null;
        el.btnRandom?.addEventListener('touchstart', () => {
            longPressTimer = setTimeout(() => {
                openSheet();
            }, 500);
        }, { passive: true });

        el.btnRandom?.addEventListener('touchend', () => {
            if (longPressTimer) clearTimeout(longPressTimer);
        }, { passive: true });
    }

    function setupHeroGestures() {
        if (!el.heroPreview) return;

        let startX = 0;
        let startY = 0;
        let isSwiping = false;

        el.heroPreview.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            isSwiping = true;
        }, { passive: false });

        el.heroPreview.addEventListener('touchmove', (e) => {
            if (!isSwiping) return;
            e.preventDefault();

            const currentX = e.touches[0].clientX;
            const currentY = e.touches[0].clientY;
            const deltaX = currentX - startX;
            const deltaY = currentY - startY;

            // Visual feedback during swipe
            if (Math.abs(deltaX) > 20 && Math.abs(deltaX) > Math.abs(deltaY)) {
                el.heroPreview.classList.toggle('swiping-left', deltaX < -20);
                el.heroPreview.classList.toggle('swiping-right', deltaX > 20);
            } else if (deltaY < -20 && Math.abs(deltaY) > Math.abs(deltaX)) {
                el.heroPreview.classList.add('swiping-up');
            }
        }, { passive: false });

        el.heroPreview.addEventListener('touchend', (e) => {
            if (!isSwiping) return;
            isSwiping = false;

            // Clear visual feedback
            el.heroPreview.classList.remove('swiping-left', 'swiping-right', 'swiping-up');

            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            const deltaX = endX - startX;
            const deltaY = endY - startY;
            const absX = Math.abs(deltaX);
            const absY = Math.abs(deltaY);

            // Tap detection (minimal movement)
            if (absX < 10 && absY < 10) {
                // Tap = toggle play/pause
                if (selectedStreamId) {
                    send('togglePause', { streamId: selectedStreamId });
                }
                return;
            }

            // Swipe detection
            if (absX < SWIPE_THRESHOLD && absY < SWIPE_THRESHOLD) return;

            // Hide hints after first swipe
            if (!swipeHintShown) {
                swipeHintShown = true;
                el.swipeHintLR?.classList.add('faded');
                el.swipeHintUD?.classList.add('faded');
            }

            if (absY > absX && deltaY < -SWIPE_THRESHOLD) {
                // Swipe UP = random seek
                if (selectedStreamId) send('randomSeek', { streamId: selectedStreamId });
            } else if (absX > absY) {
                // Horizontal swipe = navigate
                if (deltaX > SWIPE_THRESHOLD) {
                    navigateStream('prev');
                } else if (deltaX < -SWIPE_THRESHOLD) {
                    navigateStream('next');
                }
            }
        }, { passive: false });

        el.heroPreview.addEventListener('touchcancel', () => {
            isSwiping = false;
            el.heroPreview.classList.remove('swiping-left', 'swiping-right', 'swiping-up');
        }, { passive: true });
    }

    function setupProgressBar() {
        if (!el.progressTrack) return;

        // Store last seek time to avoid unreliable changedTouches on iOS
        let lastSeekTime = null;
        // Track when touch ended to ignore synthetic mouse/click events
        let lastTouchEndTime = 0;

        const seekToPosition = (clientX) => {
            const stream = getCurrentStream();
            if (!stream?.duration || stream.duration <= 0) return;

            const rect = el.progressTrack.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            const seekTime = percent * stream.duration;

            // Update UI immediately
            if (el.progressFill) el.progressFill.style.width = `${percent * 100}%`;
            if (el.progressThumb) el.progressThumb.style.left = `${percent * 100}%`;

            lastSeekTime = seekTime;
            return seekTime;
        };

        // Touch events
        el.progressTrack.addEventListener('touchstart', (e) => {
            e.preventDefault();
            isDraggingProgress = true;
            el.progressTrack.classList.add('dragging');
            seekToPosition(e.touches[0].clientX);
        }, { passive: false });

        el.progressTrack.addEventListener('touchmove', (e) => {
            if (!isDraggingProgress) return;
            e.preventDefault();
            seekToPosition(e.touches[0].clientX);
        }, { passive: false });

        el.progressTrack.addEventListener('touchend', (e) => {
            if (!isDraggingProgress) return;
            isDraggingProgress = false;
            el.progressTrack.classList.remove('dragging');
            lastTouchEndTime = Date.now();

            // Use stored seek time instead of recalculating from changedTouches (unreliable on iOS)
            if (lastSeekTime !== null && selectedStreamId) {
                send('seek', { streamId: selectedStreamId, time: lastSeekTime });
            }
            lastSeekTime = null;
        }, { passive: false });

        el.progressTrack.addEventListener('touchcancel', () => {
            isDraggingProgress = false;
            el.progressTrack.classList.remove('dragging');
            lastSeekTime = null;
        }, { passive: true });

        // Mouse events (for testing on desktop) - skip if recent touch
        el.progressTrack.addEventListener('mousedown', (e) => {
            if (Date.now() - lastTouchEndTime < 500) return;
            isDraggingProgress = true;
            el.progressTrack.classList.add('dragging');
            seekToPosition(e.clientX);

            const onMouseMove = (e) => {
                if (!isDraggingProgress) return;
                seekToPosition(e.clientX);
            };

            const onMouseUp = (e) => {
                if (!isDraggingProgress) return;
                isDraggingProgress = false;
                el.progressTrack.classList.remove('dragging');

                const seekTime = seekToPosition(e.clientX);
                if (seekTime !== undefined && selectedStreamId) {
                    send('seek', { streamId: selectedStreamId, time: seekTime });
                }

                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };

            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        // Simple click - skip if recent touch (iOS fires synthetic clicks after touch)
        el.progressTrack.addEventListener('click', (e) => {
            if (isDraggingProgress) return;
            if (Date.now() - lastTouchEndTime < 500) return;
            const seekTime = seekToPosition(e.clientX);
            if (seekTime !== undefined && selectedStreamId) {
                send('seek', { streamId: selectedStreamId, time: seekTime });
            }
        });
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

    // ============================================
    // Initialize
    // ============================================
    function init() {
        cacheElements();
        setupEventListeners();
        setupCommunication();
        console.log('Plexd Remote (Triage Mode) initialized');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { init, send, getState: () => state };
})();

window.PlexdRemote = PlexdRemote;
