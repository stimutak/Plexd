/**
 * Plexd Remote - Redesigned for iPhone
 * Simplified UI with no hidden interactions
 *
 * Design principles:
 * 1. No hidden tap zones - all controls are visible buttons
 * 2. One gesture system - swipe left/right for navigation only
 * 3. Always-visible rating - no mode switching
 * 4. Progressive disclosure - advanced features in "More" sheet
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
    let currentIndex = 0;
    let isDraggingProgress = false;
    let tapHintShown = localStorage.getItem('plexd-tap-hint-shown') === 'true';
    let currentFilter = 'all'; // 'all', '0', '1'-'9'

    // Video player state
    let heroHls = null;
    let viewerHls = null;
    let currentVideoUrl = null;
    let viewerMode = false;
    let controlsVisible = true;
    let controlsTimeout = null;

    const COMMAND_KEY = 'plexd_remote_command';
    const STATE_KEY = 'plexd_remote_state';
    const POLL_INTERVAL = 300;
    const CONNECTION_TIMEOUT = 2000;
    const SELECTION_GRACE_PERIOD = 1000;
    const SWIPE_THRESHOLD = 50;

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
        el.remoteUI = $('remote-ui');

        // Hero
        el.hero = $('hero');
        el.heroPreview = $('hero-preview');
        el.heroVideo = $('hero-video');
        el.heroImage = $('hero-image');
        el.heroStatus = $('hero-status');
        el.heroPosition = $('hero-position');
        el.posText = $('pos-text');
        el.heroTapHint = $('hero-tap-hint');

        // Info
        el.streamTitle = $('stream-title');
        el.streamTime = $('stream-time');

        // Progress
        el.progressTrack = $('progress-track');
        el.progressFill = $('progress-fill');
        el.progressThumb = $('progress-thumb');

        // Transport buttons
        el.btnPrev = $('btn-prev');
        el.btnBack = $('btn-back');
        el.btnPlay = $('btn-play');
        el.btnForward = $('btn-forward');
        el.btnNext = $('btn-next');

        // Rating
        el.ratingStrip = $('rating-strip');

        // Filter tabs
        el.filterTabs = $('filter-tabs');

        // Thumbnails
        el.thumbsSection = $('thumbs-section');
        el.thumbsStrip = $('thumbs-strip');

        // Quick actions
        el.btnRandom = $('btn-random');
        el.btnMore = $('btn-more');

        // Sheet
        el.moreSheet = $('more-sheet');
        el.sheetBackdrop = el.moreSheet?.querySelector('.sheet-backdrop');
        el.sheetCancel = $('sheet-cancel');
        el.optMute = $('opt-mute');
        el.optMuteAll = $('opt-mute-all');
        el.optPauseAll = $('opt-pause-all');
        el.optRandomAll = $('opt-random-all');
        el.optClean = $('opt-clean');
        el.optTetris = $('opt-tetris');
        el.optFullscreen = $('opt-fullscreen');

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
        el.viewerBack = $('viewer-back');
        el.viewerPlay = $('viewer-play');
        el.viewerForward = $('viewer-forward');
        el.viewerNext = $('viewer-next');
        el.streamIndicator = $('stream-indicator');
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
        const streams = state.streams || [];

        // Handle selection
        if (!selectedStreamId && streams.length > 0) {
            selectedStreamId = state.selectedStreamId || streams[0].id;
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
    // Navigation
    // ============================================
    function updateCurrentIndex() {
        const streams = state?.streams || [];
        if (!selectedStreamId || streams.length === 0) {
            currentIndex = 0;
            return;
        }
        const idx = streams.findIndex(s => s.id === selectedStreamId);
        currentIndex = idx >= 0 ? idx : 0;
    }

    function navigateStream(direction) {
        const streams = state?.streams || [];
        if (streams.length === 0) return;

        if (direction === 'next') {
            currentIndex = (currentIndex + 1) % streams.length;
        } else if (direction === 'prev') {
            currentIndex = (currentIndex - 1 + streams.length) % streams.length;
        }

        const stream = streams[currentIndex];
        if (stream) {
            selectedStreamId = stream.id;
            lastLocalSelectionTime = Date.now();
            send('selectStream', { streamId: stream.id });
            haptic.medium();
            showStreamIndicator(stream);
            render();
        }
    }

    function selectStreamById(streamId) {
        selectedStreamId = streamId;
        lastLocalSelectionTime = Date.now();
        updateCurrentIndex();
        send('selectStream', { streamId });
        haptic.light();
        render();
    }

    function showStreamIndicator(stream) {
        if (!el.streamIndicator) return;
        const name = stream.fileName || getDisplayName(stream.url);
        el.streamIndicator.textContent = name;
        el.streamIndicator.classList.add('visible');
        setTimeout(() => el.streamIndicator.classList.remove('visible'), 1000);
    }

    // ============================================
    // Video Player Management
    // ============================================
    function loadVideo(videoEl, url, hlsInstance) {
        if (!videoEl || !url) return null;

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
            videoEl.src = url;
            videoEl.play().catch(() => {});
            return null;
        } else {
            videoEl.src = url;
            videoEl.play().catch(() => {});
            return null;
        }
    }

    function updateHeroVideo() {
        const stream = getCurrentStream();
        if (!stream || !el.heroVideo) return;

        const videoUrl = stream.serverUrl || (stream.url && !stream.url.startsWith('blob:') ? stream.url : null);

        if (!videoUrl) {
            el.heroVideo.classList.remove('active');
            return;
        }

        if (currentVideoUrl !== videoUrl) {
            currentVideoUrl = videoUrl;
            heroHls = loadVideo(el.heroVideo, videoUrl, heroHls);
            el.heroVideo.classList.add('active');
        }

        // Sync playback
        if (el.heroVideo.readyState >= 2) {
            const drift = Math.abs(el.heroVideo.currentTime - stream.currentTime);
            if (drift > 2 && stream.currentTime > 0) {
                el.heroVideo.currentTime = stream.currentTime;
            }
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
        if (el.viewerCounter) {
            const total = state?.streams?.length || 0;
            el.viewerCounter.textContent = `${currentIndex + 1}/${total}`;
        }
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

        // Load video
        const videoUrl = stream.serverUrl || (stream.url && !stream.url.startsWith('blob:') ? stream.url : null);
        if (videoUrl && el.viewerVideo) {
            const viewerCurrentUrl = el.viewerVideo.getAttribute('data-url');
            if (viewerCurrentUrl !== videoUrl) {
                el.viewerVideo.setAttribute('data-url', videoUrl);
                viewerHls = loadVideo(el.viewerVideo, videoUrl, viewerHls);
            }

            if (el.viewerVideo.readyState >= 2) {
                const drift = Math.abs(el.viewerVideo.currentTime - stream.currentTime);
                if (drift > 2 && stream.currentTime > 0) {
                    el.viewerVideo.currentTime = stream.currentTime;
                }
                if (stream.paused && !el.viewerVideo.paused) {
                    el.viewerVideo.pause();
                } else if (!stream.paused && el.viewerVideo.paused) {
                    el.viewerVideo.play().catch(() => {});
                }
            }
        }
    }

    // ============================================
    // Fullscreen Viewer
    // ============================================
    function enterViewer() {
        if (!el.viewerOverlay) return;

        viewerMode = true;
        el.viewerOverlay.classList.remove('hidden');
        haptic.heavy();

        showViewerControls();
        updateViewerVideo();
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
        controlsVisible = true;
        el.viewerControls.classList.remove('hidden');

        clearTimeout(controlsTimeout);
        controlsTimeout = setTimeout(() => {
            if (viewerMode) {
                controlsVisible = false;
                el.viewerControls.classList.add('hidden');
            }
        }, 3000);
    }

    function toggleViewerControls() {
        if (controlsVisible) {
            clearTimeout(controlsTimeout);
            controlsVisible = false;
            el.viewerControls?.classList.add('hidden');
        } else {
            showViewerControls();
        }
    }

    // ============================================
    // Rendering
    // ============================================
    function render() {
        if (!state) return;

        const hasStreams = state.streams && state.streams.length > 0;

        el.emptyState?.classList.toggle('hidden', hasStreams);
        el.remoteUI?.classList.toggle('hidden', !hasStreams);

        if (hasStreams) {
            renderHero();
            renderInfo();
            renderTransport();
            renderRating();
            renderFilterTabs();
            renderThumbnails();
            renderAudioButton();
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

        // Position indicator
        if (el.posText) {
            const total = state.streams?.length || 0;
            el.posText.textContent = total > 0 ? `${currentIndex + 1} / ${total}` : '0 / 0';
        }

        // Show tap hint briefly on first load
        if (!tapHintShown && el.heroTapHint) {
            el.heroTapHint.classList.add('visible');
            setTimeout(() => {
                el.heroTapHint.classList.remove('visible');
                tapHintShown = true;
                localStorage.setItem('plexd-tap-hint-shown', 'true');
            }, 3000);
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

    function renderTransport() {
        const stream = getCurrentStream();
        if (!stream) return;

        if (el.btnPlay) {
            el.btnPlay.classList.toggle('playing', !stream.paused);
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

    function renderThumbnails() {
        if (!el.thumbsStrip) return;

        const filteredStreams = getFilteredStreams();
        if (filteredStreams.length === 0) {
            el.thumbsStrip.innerHTML = `<div class="thumbs-empty">No streams with rating ${currentFilter === '0' ? '☆' : currentFilter}</div>`;
            return;
        }

        el.thumbsStrip.innerHTML = filteredStreams.map((stream) => {
            const isSelected = stream.id === selectedStreamId;
            const rating = stream.rating || 0;
            const hasThumbnail = !!stream.thumbnail;

            return `
                <div class="thumb-item ${isSelected ? 'selected' : ''}"
                     data-id="${stream.id}">
                    ${hasThumbnail
                        ? `<img class="thumb-img" src="${stream.thumbnail}" alt="">`
                        : `<div class="thumb-placeholder"></div>`
                    }
                    ${rating > 0 ? `<span class="thumb-rating" data-rating="${rating}">${rating}</span>` : ''}
                </div>
            `;
        }).join('');

        // Event delegation for thumbnail clicks
        const selectedThumb = el.thumbsStrip.querySelector('.thumb-item.selected');
        if (selectedThumb) {
            selectedThumb.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
        }
    }

    function renderFilterTabs() {
        if (!el.filterTabs) return;

        const streams = state?.streams || [];

        el.filterTabs.querySelectorAll('.filter-tab').forEach(tab => {
            const filter = tab.dataset.filter;
            tab.classList.toggle('active', filter === currentFilter);

            // Update count display (optional: show how many streams match)
            if (filter !== 'all') {
                const filterRating = parseInt(filter, 10);
                const count = streams.filter(s => (s.rating || 0) === filterRating).length;
                // Could add count badge here if desired
            }
        });
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
            return state?.streams?.[0];
        }
        return state.streams.find(s => s.id === selectedStreamId) || state.streams[0];
    }

    function getFilteredStreams() {
        const streams = state?.streams || [];
        if (currentFilter === 'all') return streams;

        const filterRating = parseInt(currentFilter, 10);
        return streams.filter(s => (s.rating || 0) === filterRating);
    }

    // ============================================
    // Event Handlers
    // ============================================
    function setupEventListeners() {
        // Audio toggle
        el.audioToggle?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('toggleMute', { streamId: selectedStreamId });
                haptic.light();
            }
        });

        // Transport buttons
        el.btnPrev?.addEventListener('click', () => {
            navigateStream('prev');
        });

        el.btnBack?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('seekRelative', { streamId: selectedStreamId, offset: -30 });
                haptic.light();
            }
        });

        el.btnPlay?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('togglePause', { streamId: selectedStreamId });
                haptic.light();
            }
        });

        el.btnForward?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('seekRelative', { streamId: selectedStreamId, offset: 30 });
                haptic.light();
            }
        });

        el.btnNext?.addEventListener('click', () => {
            navigateStream('next');
        });

        // Quick actions
        el.btnRandom?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('randomSeek', { streamId: selectedStreamId });
                haptic.medium();
            }
        });

        el.btnMore?.addEventListener('click', () => {
            openSheet();
            haptic.light();
        });

        // Rating buttons
        el.ratingStrip?.querySelectorAll('.rating-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const rating = parseInt(btn.dataset.rating, 10);
                if (selectedStreamId) {
                    send('setRating', { streamId: selectedStreamId, rating });
                    btn.classList.add('just-set');
                    setTimeout(() => btn.classList.remove('just-set'), 300);
                    haptic.success();
                }
            });
        });

        // Filter tabs
        el.filterTabs?.addEventListener('click', (e) => {
            const tab = e.target.closest('.filter-tab');
            if (tab) {
                const filter = tab.dataset.filter;
                if (filter && filter !== currentFilter) {
                    currentFilter = filter;
                    haptic.light();
                    renderFilterTabs();
                    renderThumbnails();
                }
            }
        });

        // Thumbnail clicks (event delegation)
        el.thumbsStrip?.addEventListener('click', (e) => {
            const item = e.target.closest('.thumb-item');
            if (item) {
                const streamId = item.dataset.id;
                if (streamId) {
                    selectStreamById(streamId);
                }
            }
        });

        // Hero gestures (simplified: tap = viewer, swipe = navigate)
        setupHeroGestures();

        // Progress bar
        setupProgressBar();

        // Sheet
        el.sheetBackdrop?.addEventListener('click', closeSheet);
        el.sheetCancel?.addEventListener('click', closeSheet);

        el.optMute?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('toggleMute', { streamId: selectedStreamId });
                haptic.light();
            }
            closeSheet();
        });

        el.optMuteAll?.addEventListener('click', () => {
            send('toggleMuteAll');
            haptic.medium();
            closeSheet();
        });

        el.optPauseAll?.addEventListener('click', () => {
            send('togglePauseAll');
            haptic.medium();
            closeSheet();
        });

        el.optRandomAll?.addEventListener('click', () => {
            send('randomSeekAll');
            haptic.medium();
            closeSheet();
        });

        el.optClean?.addEventListener('click', () => {
            send('toggleCleanMode');
            haptic.medium();
            closeSheet();
        });

        el.optTetris?.addEventListener('click', () => {
            send('toggleTetrisMode');
            haptic.medium();
            closeSheet();
        });

        el.optFullscreen?.addEventListener('click', () => {
            closeSheet();
            setTimeout(() => enterViewer(), 200);
        });

        // Viewer controls
        setupViewerEvents();
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
        }, { passive: true });

        el.heroPreview.addEventListener('touchmove', (e) => {
            if (!isSwiping) return;

            const currentX = e.touches[0].clientX;
            const deltaX = currentX - startX;

            // Visual feedback during swipe
            if (Math.abs(deltaX) > 20) {
                el.heroPreview.classList.toggle('swiping-left', deltaX < -20);
                el.heroPreview.classList.toggle('swiping-right', deltaX > 20);
            }
        }, { passive: true });

        el.heroPreview.addEventListener('touchend', (e) => {
            if (!isSwiping) return;
            isSwiping = false;

            // Clear visual feedback
            el.heroPreview.classList.remove('swiping-left', 'swiping-right');

            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            const deltaX = endX - startX;
            const deltaY = endY - startY;
            const absX = Math.abs(deltaX);
            const absY = Math.abs(deltaY);

            // Tap detection - zone-based actions (single tap, no double-tap)
            if (absX < 15 && absY < 15) {
                if (!selectedStreamId) return;

                // Calculate tap zone using thirds
                const rect = el.heroPreview.getBoundingClientRect();
                const relX = (startX - rect.left) / rect.width;
                const relY = (startY - rect.top) / rect.height;

                // Zone layout:
                // +------------------+
                // |   TOP: Random    |  (top third)
                // +------+----+------+
                // | LEFT |PLAY| RIGHT|  (middle third)
                // | -30s |    | +30s |
                // +------+----+------+
                // | BTM: Focus       |  (bottom third)
                // +------------------+

                if (relY < 0.33) {
                    // Top third = random seek
                    send('randomSeek', { streamId: selectedStreamId });
                    haptic.medium();
                } else if (relY > 0.67) {
                    // Bottom third = toggle focus/fullscreen on Mac
                    if (state?.fullscreenStreamId === selectedStreamId) {
                        send('exitFullscreen');
                    } else {
                        send('enterFullscreen', { streamId: selectedStreamId });
                    }
                    haptic.heavy();
                } else {
                    // Middle third - divided into left/center/right
                    if (relX < 0.33) {
                        // Left third = back 30s
                        send('seekRelative', { streamId: selectedStreamId, offset: -30 });
                        haptic.light();
                    } else if (relX > 0.67) {
                        // Right third = forward 30s
                        send('seekRelative', { streamId: selectedStreamId, offset: 30 });
                        haptic.light();
                    } else {
                        // Center = play/pause
                        send('togglePause', { streamId: selectedStreamId });
                        haptic.light();
                    }
                }
                return;
            }

            // Swipe detection - horizontal for stream navigation
            if (absX > SWIPE_THRESHOLD && absX > absY) {
                if (deltaX > 0) {
                    navigateStream('prev');
                } else {
                    navigateStream('next');
                }
            }
        }, { passive: true });

        el.heroPreview.addEventListener('touchcancel', () => {
            isSwiping = false;
            el.heroPreview.classList.remove('swiping-left', 'swiping-right');
        }, { passive: true });
    }

    function setupViewerEvents() {
        if (!el.viewerOverlay) return;

        // Close button
        el.viewerClose?.addEventListener('click', exitViewer);

        // Transport buttons
        el.viewerPrev?.addEventListener('click', () => {
            navigateStream('prev');
            haptic.medium();
        });

        el.viewerBack?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('seekRelative', { streamId: selectedStreamId, offset: -30 });
                haptic.light();
            }
        });

        el.viewerPlay?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('togglePause', { streamId: selectedStreamId });
                haptic.light();
            }
        });

        el.viewerForward?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('seekRelative', { streamId: selectedStreamId, offset: 30 });
                haptic.light();
            }
        });

        el.viewerNext?.addEventListener('click', () => {
            navigateStream('next');
            haptic.medium();
        });

        // Progress bar seek
        el.viewerProgress?.addEventListener('click', (e) => {
            const stream = getCurrentStream();
            if (!stream?.duration) return;
            const rect = el.viewerProgress.getBoundingClientRect();
            const pct = (e.clientX - rect.left) / rect.width;
            const time = pct * stream.duration;
            send('seek', { streamId: selectedStreamId, time });
            haptic.light();
        });

        // Viewer gestures - zone-based taps + swipes
        let startX = 0;
        let startY = 0;
        let isSwiping = false;
        let lastTapTime = 0;

        el.viewerOverlay.addEventListener('touchstart', (e) => {
            if (e.target.closest('.viewer-btn, .viewer-close, .viewer-progress')) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            isSwiping = true;
        }, { passive: true });

        el.viewerOverlay.addEventListener('touchend', (e) => {
            if (!isSwiping) return;
            isSwiping = false;

            const endX = e.changedTouches[0].clientX;
            const endY = e.changedTouches[0].clientY;
            const deltaX = endX - startX;
            const deltaY = endY - startY;
            const absX = Math.abs(deltaX);
            const absY = Math.abs(deltaY);

            // Tap detection - zone-based actions
            if (absX < 15 && absY < 15) {
                const now = Date.now();

                // Double-tap = exit viewer
                if (now - lastTapTime < 300) {
                    exitViewer();
                    lastTapTime = 0;
                    return;
                }
                lastTapTime = now;

                if (!selectedStreamId) {
                    toggleViewerControls();
                    return;
                }

                // Calculate video bounds (accounting for letterboxing)
                const container = el.viewerOverlay.getBoundingClientRect();
                const video = el.viewerVideo;
                let videoRect = { left: 0, top: 0, width: container.width, height: container.height };

                if (video && video.videoWidth && video.videoHeight) {
                    const videoAspect = video.videoWidth / video.videoHeight;
                    const containerAspect = container.width / container.height;

                    if (videoAspect > containerAspect) {
                        videoRect.width = container.width;
                        videoRect.height = container.width / videoAspect;
                        videoRect.top = (container.height - videoRect.height) / 2;
                    } else {
                        videoRect.height = container.height;
                        videoRect.width = container.height * videoAspect;
                        videoRect.left = (container.width - videoRect.width) / 2;
                    }
                }

                // Check if tap is within video area
                const inVideoX = startX >= videoRect.left && startX <= videoRect.left + videoRect.width;
                const inVideoY = startY >= videoRect.top && startY <= videoRect.top + videoRect.height;

                if (!inVideoX || !inVideoY) {
                    // Outside video = toggle controls
                    toggleViewerControls();
                    return;
                }

                // Zone actions on video area
                const relX = (startX - videoRect.left) / videoRect.width;
                const relY = (startY - videoRect.top) / videoRect.height;

                if (relY < 0.25) {
                    // Top = random seek
                    send('randomSeek', { streamId: selectedStreamId });
                    haptic.medium();
                } else if (relY > 0.75) {
                    // Bottom = toggle controls
                    toggleViewerControls();
                } else if (relX < 0.3) {
                    // Left = back 30s
                    send('seekRelative', { streamId: selectedStreamId, offset: -30 });
                    haptic.light();
                } else if (relX > 0.7) {
                    // Right = forward 30s
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
            if (absX > SWIPE_THRESHOLD && absX > absY) {
                // Horizontal swipe = navigate streams
                if (deltaX > 0) {
                    navigateStream('prev');
                } else {
                    navigateStream('next');
                }
            } else if (absY > SWIPE_THRESHOLD && absY > absX) {
                // Swipe down = exit viewer
                if (deltaY > 0) {
                    exitViewer();
                }
            }
        }, { passive: true });
    }

    function setupProgressBar() {
        if (!el.progressTrack) return;

        let lastSeekTime = null;
        let lastTouchEndTime = 0;

        const seekToPosition = (clientX) => {
            const stream = getCurrentStream();
            if (!stream?.duration || stream.duration <= 0) return;

            const rect = el.progressTrack.getBoundingClientRect();
            const percent = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
            const seekTime = percent * stream.duration;

            if (el.progressFill) el.progressFill.style.width = `${percent * 100}%`;
            if (el.progressThumb) el.progressThumb.style.left = `${percent * 100}%`;

            lastSeekTime = seekTime;
            return seekTime;
        };

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

        el.progressTrack.addEventListener('touchend', () => {
            if (!isDraggingProgress) return;
            isDraggingProgress = false;
            el.progressTrack.classList.remove('dragging');
            lastTouchEndTime = Date.now();

            if (lastSeekTime !== null && selectedStreamId) {
                send('seek', { streamId: selectedStreamId, time: lastSeekTime });
            }
            lastSeekTime = null;
        }, { passive: true });

        el.progressTrack.addEventListener('touchcancel', () => {
            isDraggingProgress = false;
            el.progressTrack.classList.remove('dragging');
            lastSeekTime = null;
        }, { passive: true });

        // Mouse events for desktop testing
        el.progressTrack.addEventListener('click', (e) => {
            if (Date.now() - lastTouchEndTime < 500) return;
            const seekTime = seekToPosition(e.clientX);
            if (seekTime !== undefined && selectedStreamId) {
                send('seek', { streamId: selectedStreamId, time: seekTime });
            }
        });
    }

    function openSheet() {
        if (!el.moreSheet) return;

        // Update sheet option states
        const stream = getCurrentStream();
        if (el.optMute) {
            const isMuted = stream?.muted || false;
            el.optMute.classList.toggle('muted', isMuted);
        }
        if (el.optClean) {
            el.optClean.classList.toggle('active', state?.cleanMode || false);
        }
        if (el.optTetris) {
            el.optTetris.classList.toggle('active', state?.tetrisMode || false);
        }

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
            return url?.substring(0, 50) || 'Unknown';
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
        console.log('Plexd Remote initialized (redesigned)');
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', init);
    } else {
        init();
    }

    return { init, send, getState: () => state };
})();

window.PlexdRemote = PlexdRemote;
