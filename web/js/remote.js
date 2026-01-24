/**
 * Plexd Remote Viewer
 * Remote control AND viewer for Plexd - watch and control from your phone
 *
 * Features:
 * 1. Live video playback synced with main app
 * 2. Fullscreen viewer mode with gesture controls
 * 3. Haptic feedback for tactile response
 * 4. PWA support - add to home screen
 * 5. Swipe gestures for navigation
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
    let currentMode = localStorage.getItem('plexd-remote-mode') || 'controller'; // 'controller' | 'triage'
    let currentIndex = 0; // Index within filteredStreams
    let swipeHintShown = false;
    let isDraggingProgress = false;
    let lastThumbTapTime = 0;
    let lastThumbTapId = null;

    // Video player state
    let heroHls = null;
    let viewerHls = null;
    let currentVideoUrl = null;
    let viewerMode = false;
    let controlsTimeout = null;
    let lastSyncTime = 0;

    const COMMAND_KEY = 'plexd_remote_command';
    const STATE_KEY = 'plexd_remote_state';
    const POLL_INTERVAL = 300;
    const CONNECTION_TIMEOUT = 2000;
    const SELECTION_GRACE_PERIOD = 1000;
    const SWIPE_THRESHOLD = 50;
    const SYNC_INTERVAL = 2000; // Sync playback position every 2s

    // ============================================
    // Haptic Feedback
    // ============================================
    const haptic = {
        light() {
            if (navigator.vibrate) navigator.vibrate(10);
        },
        medium() {
            if (navigator.vibrate) navigator.vibrate(20);
        },
        heavy() {
            if (navigator.vibrate) navigator.vibrate([30, 10, 30]);
        },
        success() {
            if (navigator.vibrate) navigator.vibrate([10, 50, 20]);
        },
        error() {
            if (navigator.vibrate) navigator.vibrate([50, 30, 50, 30, 50]);
        }
    };

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

        // Video player
        el.heroVideo = $('hero-video');
        el.heroFullscreenBtn = $('hero-fullscreen-btn');

        // Mode tabs and content
        el.modeTabs = $('mode-tabs');
        el.controllerContent = $('controller-content');
        el.triageContent = $('triage-content');

        // Controller elements
        el.ctrlMute = $('ctrl-mute');
        el.ctrlPauseAll = $('ctrl-pause-all');
        el.ctrlRandomAll = $('ctrl-random-all');
        el.ctrlMuteAll = $('ctrl-mute-all');
        el.ctrlClean = $('ctrl-clean');
        el.ctrlTetris = $('ctrl-tetris');

        // Fullscreen viewer
        el.viewerOverlay = $('viewer-overlay');
        el.viewerVideo = $('viewer-video');
        el.viewerControls = $('viewer-controls');
        el.viewerClose = $('viewer-close');
        el.viewerTitle = $('viewer-title');
        el.viewerCounter = $('viewer-counter');
        el.viewerTime = $('viewer-time');
        el.viewerProgress = $('viewer-progress');
        el.viewerProgressFill = $('viewer-progress-fill');
        el.viewerPrev = $('viewer-prev');
        el.viewerPlay = $('viewer-play');
        el.viewerNext = $('viewer-next');
        el.viewerGestureHint = $('viewer-gesture-hint');
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
    // Mode Switching
    // ============================================
    function setMode(mode) {
        if (mode !== 'controller' && mode !== 'triage') return;

        currentMode = mode;
        localStorage.setItem('plexd-remote-mode', mode);

        // Update tab bar active state
        el.modeTabs?.querySelectorAll('.mode-tab').forEach(tab => {
            tab.classList.toggle('active', tab.dataset.mode === mode);
        });

        // Show/hide content sections
        if (el.controllerContent) {
            el.controllerContent.classList.toggle('hidden', mode !== 'controller');
        }
        if (el.triageContent) {
            el.triageContent.classList.toggle('hidden', mode !== 'triage');
        }

        // Render appropriate content
        if (mode === 'controller') {
            renderController();
        }

        haptic.light();
    }

    // ============================================
    // Navigation
    // ============================================
    function navigateStream(direction) {
        if (filteredStreams.length === 0) return;

        if (direction === 'next' || direction === 'right' || direction === 'down') {
            currentIndex = (currentIndex + 1) % filteredStreams.length;
        } else if (direction === 'prev' || direction === 'left' || direction === 'up') {
            currentIndex = (currentIndex - 1 + filteredStreams.length) % filteredStreams.length;
        }

        const stream = filteredStreams[currentIndex];
        if (stream) {
            selectedStreamId = stream.id;
            lastLocalSelectionTime = Date.now();
            send('selectStream', { streamId: stream.id });
            haptic.medium();
            showStreamChangeIndicator();
            render();
        }
    }

    function selectStreamById(streamId) {
        selectedStreamId = streamId;
        lastLocalSelectionTime = Date.now();
        updateCurrentIndex();
        send('selectStream', { streamId });
        haptic.medium();
        showStreamChangeIndicator();
        render();
    }

    // ============================================
    // Video Player Management
    // ============================================
    function loadVideo(videoEl, url, hlsInstance) {
        if (!videoEl || !url) return null;

        // Clean up existing HLS instance
        if (hlsInstance) {
            hlsInstance.destroy();
        }

        const isHls = url.includes('.m3u8') || url.includes('/stream');

        if (isHls && typeof Hls !== 'undefined' && Hls.isSupported()) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: false,
                backBufferLength: 30
            });
            hls.loadSource(url);
            hls.attachMedia(videoEl);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                videoEl.play().catch(() => {});
            });
            return hls;
        } else if (isHls && videoEl.canPlayType('application/vnd.apple.mpegurl')) {
            // Native HLS (Safari)
            videoEl.src = url;
            videoEl.play().catch(() => {});
            return null;
        } else {
            // Regular video
            videoEl.src = url;
            videoEl.play().catch(() => {});
            return null;
        }
    }

    function updateHeroVideo() {
        const stream = getCurrentStream();
        if (!stream || !el.heroVideo) return;

        // Use serverUrl for local files (blob: URLs don't work cross-device)
        const videoUrl = stream.serverUrl || (stream.url && !stream.url.startsWith('blob:') ? stream.url : null);

        if (!videoUrl) {
            // No playable URL available
            el.heroVideo.classList.remove('active');
            return;
        }

        // Only reload if URL changed
        if (currentVideoUrl !== videoUrl) {
            currentVideoUrl = videoUrl;
            heroHls = loadVideo(el.heroVideo, videoUrl, heroHls);
            el.heroVideo.classList.add('active');
        }

        // Sync playback position and state with Mac (within tolerance)
        if (el.heroVideo.readyState >= 2) {
            const drift = Math.abs(el.heroVideo.currentTime - stream.currentTime);
            if (drift > 2 && stream.currentTime > 0) {
                el.heroVideo.currentTime = stream.currentTime;
            }
            // Sync play/pause
            if (stream.paused && !el.heroVideo.paused) {
                el.heroVideo.pause();
            } else if (!stream.paused && el.heroVideo.paused) {
                el.heroVideo.play().catch(() => {});
            }
        }
    }

    function updateViewerVideo() {
        const stream = getCurrentStream();
        if (!stream || !viewerMode) return;

        // Update viewer UI
        const name = stream.fileName || getDisplayName(stream.url);
        if (el.viewerTitle) el.viewerTitle.textContent = name;
        if (el.viewerCounter) el.viewerCounter.textContent = `${currentIndex + 1}/${filteredStreams.length}`;
        if (el.viewerTime) {
            el.viewerTime.textContent = `${formatTime(stream.currentTime)} / ${formatTime(stream.duration)}`;
        }
        if (el.viewerProgressFill && stream.duration > 0) {
            const pct = (stream.currentTime / stream.duration) * 100;
            el.viewerProgressFill.style.width = `${pct}%`;
        }
        if (el.viewerPlay) {
            el.viewerPlay.classList.toggle('playing', !stream.paused);
        }

        // Load video if serverUrl available
        const videoUrl = stream.serverUrl || (stream.url && !stream.url.startsWith('blob:') ? stream.url : null);
        if (videoUrl && el.viewerVideo) {
            const viewerCurrentUrl = el.viewerVideo.getAttribute('data-url');
            if (viewerCurrentUrl !== videoUrl) {
                el.viewerVideo.setAttribute('data-url', videoUrl);
                viewerHls = loadVideo(el.viewerVideo, videoUrl, viewerHls);
            }

            // Sync playback position and state with Mac
            if (el.viewerVideo.readyState >= 2) {
                const drift = Math.abs(el.viewerVideo.currentTime - stream.currentTime);
                if (drift > 2 && stream.currentTime > 0) {
                    el.viewerVideo.currentTime = stream.currentTime;
                }
                // Sync play/pause
                if (stream.paused && !el.viewerVideo.paused) {
                    el.viewerVideo.pause();
                } else if (!stream.paused && el.viewerVideo.paused) {
                    el.viewerVideo.play().catch(() => {});
                }
            }
        }
    }

    // ============================================
    // Fullscreen Viewer Mode
    // ============================================
    function enterViewer() {
        if (!el.viewerOverlay) return;

        viewerMode = true;
        el.viewerOverlay.classList.remove('hidden');
        haptic.heavy();

        // Show controls initially, then auto-hide
        showViewerControls();
        updateViewerVideo();

        // Show gesture hint briefly
        if (el.viewerGestureHint) {
            el.viewerGestureHint.classList.add('visible');
            setTimeout(() => el.viewerGestureHint.classList.remove('visible'), 2000);
        }

        // Setup viewer gestures
        setupViewerGestures();
    }

    function exitViewer() {
        if (!el.viewerOverlay) return;

        viewerMode = false;
        el.viewerOverlay.classList.add('hidden');
        haptic.medium();
        clearTimeout(controlsTimeout);
    }

    function showViewerControls() {
        if (!el.viewerControls) return;
        el.viewerControls.classList.remove('hidden');

        clearTimeout(controlsTimeout);
        controlsTimeout = setTimeout(() => {
            if (viewerMode) {
                el.viewerControls.classList.add('hidden');
            }
        }, 3000);
    }

    function toggleViewerControls() {
        if (!el.viewerControls) return;
        if (el.viewerControls.classList.contains('hidden')) {
            showViewerControls();
        } else {
            el.viewerControls.classList.add('hidden');
        }
    }

    // ============================================
    // Stream Change Indicator
    // ============================================
    function showStreamChangeIndicator() {
        let indicator = document.querySelector('.stream-change-indicator');
        if (!indicator) {
            indicator = document.createElement('div');
            indicator.className = 'stream-change-indicator';
            document.body.appendChild(indicator);
        }

        const stream = getCurrentStream();
        if (stream) {
            const name = stream.fileName || getDisplayName(stream.url);
            indicator.textContent = name;
            indicator.classList.add('visible');

            setTimeout(() => indicator.classList.remove('visible'), 1000);
        }
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
            renderAudioButton();

            // Mode-specific rendering
            if (currentMode === 'controller') {
                renderController();
            } else {
                renderRating();
                renderFilters();
                renderThumbnails();
            }

            updateHeroVideo();
            if (viewerMode) {
                updateViewerVideo();
            }
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

        // Focus button state (uses transport-btn.active now)
        if (el.btnFocus) {
            const isFocused = stream.id === state?.fullscreenStreamId;
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

        // Event listeners - single tap selects, double tap random seek
        el.thumbsStrip.querySelectorAll('.thumb-item').forEach(item => {
            item.addEventListener('click', () => {
                const now = Date.now();
                const streamId = item.dataset.id;

                if (now - lastThumbTapTime < 300 && lastThumbTapId === streamId) {
                    // Double tap = random seek
                    send('randomSeek', { streamId });
                    haptic.medium();
                } else {
                    // Single tap = select
                    selectStreamById(streamId);
                }

                lastThumbTapTime = now;
                lastThumbTapId = streamId;
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

    function renderController() {
        const stream = getCurrentStream();

        // Stream audio toggle - active = unmuted (sound on)
        if (el.ctrlMute) {
            const isMuted = stream?.muted || false;
            el.ctrlMute.classList.toggle('active', !isMuted);
            el.ctrlMute.classList.toggle('muted', isMuted);
        }

        // Clean mode toggle
        if (el.ctrlClean) {
            el.ctrlClean.classList.toggle('active', state?.cleanMode || false);
        }

        // Tetris mode toggle
        if (el.ctrlTetris) {
            el.ctrlTetris.classList.toggle('active', state?.tetrisMode || false);
        }
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

        // Mode tabs
        el.modeTabs?.querySelectorAll('.mode-tab').forEach(tab => {
            tab.addEventListener('click', () => {
                setMode(tab.dataset.mode);
            });
        });

        // Controller tiles
        el.ctrlMute?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('toggleMute', { streamId: selectedStreamId });
                haptic.medium();
            }
        });

        el.ctrlRandomAll?.addEventListener('click', () => {
            send('randomSeekAll');
            haptic.medium();
        });

        el.ctrlPauseAll?.addEventListener('click', () => {
            send('togglePauseAll');
            haptic.medium();
        });

        el.ctrlClean?.addEventListener('click', () => {
            send('toggleCleanMode');
            haptic.medium();
        });

        el.ctrlTetris?.addEventListener('click', () => {
            send('toggleTetrisMode');
            haptic.medium();
        });

        el.ctrlMuteAll?.addEventListener('click', () => {
            send('toggleMuteAll');
            haptic.medium();
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

        // Swipe gestures on thumbnail grid
        setupThumbsGestures();

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
                haptic.heavy();
                openSheet();
            }, 500);
        }, { passive: true });

        el.btnRandom?.addEventListener('touchend', () => {
            if (longPressTimer) clearTimeout(longPressTimer);
        }, { passive: true });

        // Fullscreen button
        el.heroFullscreenBtn?.addEventListener('click', () => {
            haptic.medium();
            enterViewer();
        });

        // Viewer controls
        el.viewerClose?.addEventListener('click', () => {
            exitViewer();
        });

        el.viewerPlay?.addEventListener('click', () => {
            haptic.light();
            if (selectedStreamId) send('togglePause', { streamId: selectedStreamId });
        });

        el.viewerPrev?.addEventListener('click', () => {
            haptic.medium();
            navigateStream('prev');
        });

        el.viewerNext?.addEventListener('click', () => {
            haptic.medium();
            navigateStream('next');
        });

        // Viewer progress bar tap
        el.viewerProgress?.addEventListener('click', (e) => {
            const stream = getCurrentStream();
            if (!stream?.duration) return;
            const rect = el.viewerProgress.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            const time = pct * stream.duration;
            send('seek', { streamId: selectedStreamId, time });
            haptic.light();
        });

        // Add haptic feedback to existing buttons
        [el.btnBack, el.btnForward, el.btnRandom, el.btnPlay, el.btnFocus].forEach(btn => {
            btn?.addEventListener('click', () => haptic.light(), { capture: true });
        });

        // Add haptic to rating buttons
        el.ratingStrip?.querySelectorAll('.rating-btn').forEach(btn => {
            btn.addEventListener('click', () => haptic.success(), { capture: true });
        });
    }

    let viewerGesturesSetup = false;

    function setupViewerGestures() {
        if (!el.viewerOverlay || viewerGesturesSetup) return;
        viewerGesturesSetup = true;

        let startX = 0;
        let startY = 0;
        let isSwiping = false;

        let lastTapTime = 0;

        const onTouchStart = (e) => {
            // Ignore touches on control buttons
            if (e.target.closest('.viewer-btn, .viewer-close, .viewer-progress')) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            isSwiping = true;
        };

        const onTouchEnd = (e) => {
            if (!isSwiping) return;
            isSwiping = false;

            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            const deltaX = endX - startX;
            const deltaY = endY - startY;
            const absX = Math.abs(deltaX);
            const absY = Math.abs(deltaY);

            // Tap detection - zone-based actions on actual video area
            if (absX < 15 && absY < 15) {
                const now = Date.now();

                // Double-tap = exit viewer
                if (now - lastTapTime < 300) {
                    exitViewer();
                    lastTapTime = 0;
                    return;
                }
                lastTapTime = now;

                if (!selectedStreamId) return;

                // Calculate actual video bounds (accounting for object-fit: contain)
                const container = el.viewerOverlay.getBoundingClientRect();
                const video = el.viewerVideo;
                let videoRect = { left: 0, top: 0, width: container.width, height: container.height };

                if (video && video.videoWidth && video.videoHeight) {
                    const videoAspect = video.videoWidth / video.videoHeight;
                    const containerAspect = container.width / container.height;

                    if (videoAspect > containerAspect) {
                        // Video is wider - black bars top/bottom
                        videoRect.width = container.width;
                        videoRect.height = container.width / videoAspect;
                        videoRect.top = (container.height - videoRect.height) / 2;
                        videoRect.left = 0;
                    } else {
                        // Video is taller - black bars left/right
                        videoRect.height = container.height;
                        videoRect.width = container.height * videoAspect;
                        videoRect.left = (container.width - videoRect.width) / 2;
                        videoRect.top = 0;
                    }
                }

                // Check if tap is within video area
                const inVideoX = startX >= videoRect.left && startX <= videoRect.left + videoRect.width;
                const inVideoY = startY >= videoRect.top && startY <= videoRect.top + videoRect.height;

                if (!inVideoX || !inVideoY) {
                    // Tap outside video = toggle controls
                    toggleViewerControls();
                    return;
                }

                // Calculate relative position within video
                const relX = (startX - videoRect.left) / videoRect.width;
                const relY = (startY - videoRect.top) / videoRect.height;

                if (relY < 0.25) {
                    // Top quarter = random seek
                    send('randomSeek', { streamId: selectedStreamId });
                    haptic.medium();
                } else if (relY > 0.75) {
                    // Bottom quarter = toggle controls
                    toggleViewerControls();
                } else if (relX < 0.3) {
                    // Left edge = back 30s
                    send('seekRelative', { streamId: selectedStreamId, offset: -30 });
                    haptic.light();
                } else if (relX > 0.7) {
                    // Right edge = forward 30s
                    send('seekRelative', { streamId: selectedStreamId, offset: 30 });
                    haptic.light();
                } else {
                    // Center = play/pause
                    send('togglePause', { streamId: selectedStreamId });
                    haptic.light();
                }
                return;
            }

            // Swipe detection
            if (absX < SWIPE_THRESHOLD && absY < SWIPE_THRESHOLD) return;

            if (absX > absY) {
                // Horizontal swipe
                if (deltaX > SWIPE_THRESHOLD) {
                    navigateStream('next');
                } else if (deltaX < -SWIPE_THRESHOLD) {
                    navigateStream('prev');
                }
            } else {
                // Vertical swipe
                if (deltaY > SWIPE_THRESHOLD) {
                    // Swipe down = exit viewer
                    exitViewer();
                } else if (deltaY < -SWIPE_THRESHOLD) {
                    // Swipe up = random seek
                    if (selectedStreamId) {
                        send('randomSeek', { streamId: selectedStreamId });
                        haptic.medium();
                    }
                }
            }
        };

        // Attach to overlay (not just video) so taps work even without video loaded
        el.viewerOverlay.addEventListener('touchstart', onTouchStart, { passive: true });
        el.viewerOverlay.addEventListener('touchend', onTouchEnd, { passive: true });
    }

    function setupHeroGestures() {
        if (!el.heroPreview) return;

        let startX = 0;
        let startY = 0;
        let isSwiping = false;
        let lastTapTime = 0;
        let tapTimeout = null;

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

            // Tap detection (minimal movement) - zone-based actions
            if (absX < 10 && absY < 10) {
                const now = Date.now();

                // Double-tap = enter fullscreen viewer
                if (now - lastTapTime < 300) {
                    haptic.heavy();
                    enterViewer();
                    lastTapTime = 0;
                    return;
                }
                lastTapTime = now;

                if (!selectedStreamId) return;

                const rect = el.heroPreview.getBoundingClientRect();
                const relX = (startX - rect.left) / rect.width;  // 0-1 horizontal
                const relY = (startY - rect.top) / rect.height;  // 0-1 vertical

                // Determine zone and action
                if (relY < 0.33) {
                    // Top third = random seek
                    send('randomSeek', { streamId: selectedStreamId });
                    haptic.medium();
                } else if (relY > 0.67) {
                    // Bottom third = toggle focus
                    haptic.heavy();
                    if (state?.fullscreenStreamId === selectedStreamId) {
                        send('exitFullscreen');
                    } else {
                        send('enterFullscreen', { streamId: selectedStreamId });
                    }
                } else if (relX < 0.33) {
                    // Left third (middle row) = back 30s
                    send('seekRelative', { streamId: selectedStreamId, offset: -30 });
                    haptic.light();
                } else if (relX > 0.67) {
                    // Right third (middle row) = forward 30s
                    send('seekRelative', { streamId: selectedStreamId, offset: 30 });
                    haptic.light();
                } else {
                    // Center = toggle play/pause
                    send('togglePause', { streamId: selectedStreamId });
                    haptic.light();
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

            if (absY > absX) {
                // Vertical swipe = spatial navigation (up/down in grid)
                if (deltaY < -SWIPE_THRESHOLD) {
                    send('selectNext', { direction: 'up' });
                    haptic.medium();
                } else if (deltaY > SWIPE_THRESHOLD) {
                    send('selectNext', { direction: 'down' });
                    haptic.medium();
                }
            } else if (absX > absY) {
                // Horizontal swipe = spatial navigation (left/right in grid)
                if (deltaX > SWIPE_THRESHOLD) {
                    send('selectNext', { direction: 'right' });
                    haptic.medium();
                } else if (deltaX < -SWIPE_THRESHOLD) {
                    send('selectNext', { direction: 'left' });
                    haptic.medium();
                }
            }
        }, { passive: false });

        el.heroPreview.addEventListener('touchcancel', () => {
            isSwiping = false;
            el.heroPreview.classList.remove('swiping-left', 'swiping-right', 'swiping-up');
        }, { passive: true });
    }

    function setupThumbsGestures() {
        if (!el.thumbsSection) return;

        let startX = 0;
        let startY = 0;
        let isSwiping = false;

        el.thumbsSection.addEventListener('touchstart', (e) => {
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            isSwiping = true;
        }, { passive: true });

        el.thumbsSection.addEventListener('touchend', (e) => {
            if (!isSwiping) return;
            isSwiping = false;

            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            const deltaX = endX - startX;
            const deltaY = endY - startY;
            const absX = Math.abs(deltaX);
            const absY = Math.abs(deltaY);

            // Need significant movement for swipe
            if (absX < SWIPE_THRESHOLD && absY < SWIPE_THRESHOLD) return;

            if (absY > absX) {
                // Vertical swipe = spatial navigation (up/down in grid)
                if (deltaY < -SWIPE_THRESHOLD) {
                    send('selectNext', { direction: 'up' });
                    haptic.medium();
                } else if (deltaY > SWIPE_THRESHOLD) {
                    send('selectNext', { direction: 'down' });
                    haptic.medium();
                }
            } else {
                // Horizontal swipe = spatial navigation (left/right in grid)
                if (deltaX > SWIPE_THRESHOLD) {
                    send('selectNext', { direction: 'right' });
                    haptic.medium();
                } else if (deltaX < -SWIPE_THRESHOLD) {
                    send('selectNext', { direction: 'left' });
                    haptic.medium();
                }
            }
        }, { passive: true });

        el.thumbsSection.addEventListener('touchcancel', () => {
            isSwiping = false;
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

        // Initialize mode from localStorage
        setMode(currentMode);

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
