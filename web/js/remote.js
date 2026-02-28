/**
 * Plexd Remote - Redesigned for iPhone
 * Simplified UI with no hidden interactions
 *
 * Design principles:
 * 1. No hidden tap zones - all controls are visible buttons
 * 2. One gesture system - swipe left/right for navigation only
 * 3. Always-visible rating - no mode switching
 * 4. Progressive disclosure - advanced features in tabbed toolbar (Play/Mode/Moments/More)
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
    let currentFilter = 'all'; // 'all', 'fav', '0', '1'-'9'
    let currentLayout = 'grid'; // 'grid', 'tetris', 'mosaic', 'clean'
    const LAYOUT_MODES = ['grid', 'tetris', 'mosaic', 'clean'];

    // Video player state
    let heroHls = null;
    let viewerHls = null;
    let currentVideoUrl = null;
    let viewerMode = false;
    let controlsVisible = true;
    let controlsTimeout = null;

    // Moments state
    let momentsData = [];
    let momentsLoading = false;
    let momentsBrowserOpen = false;
    let momentsPlayerOpen = false;
    let momentsFilter = 'all'; // 'all', 'loved', '1'-'9'
    let momentsSort = 'newest';
    let momentsSources = [];
    let momentsFilterSource = '';
    let momentsSelectedIndex = 0;
    let momentsPlayerIndex = 0;
    let momentsAutoAdvance = true;
    let momentsFilteredList = [];
    let momentPlayerHls = null;

    const COMMAND_KEY = 'plexd_remote_command';
    const STATE_KEY = 'plexd_remote_state';
    const POLL_INTERVAL = 300;
    const CONNECTION_TIMEOUT = 2000;
    const SELECTION_GRACE_PERIOD = 2500;
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
        el.btnFavorite = $('btn-favorite');

        // Filter tabs
        el.filterTabs = $('filter-tabs');

        // Thumbnails
        el.thumbsSection = $('thumbs-section');
        el.thumbsStrip = $('thumbs-strip');

        // Toolbar tabs
        el.toolbarTabs = $('toolbar-tabs');

        // Play panel buttons
        el.btnRandom = $('btn-random');
        el.btnFocus = $('btn-focus');
        el.btnAudioFocus = $('btn-audio-focus');
        el.btnPauseAll = $('btn-pause-all');
        el.btnLayout = $('btn-layout');
        el.layoutLabel = $('layout-label');
        el.btnCrop = $('btn-crop');

        // Mode panel buttons
        el.btnTheater = $('btn-theater');
        el.btnSceneCasting = $('btn-scene-casting');
        el.btnSceneLineup = $('btn-scene-lineup');
        el.btnSceneStage = $('btn-scene-stage');
        el.btnSceneClimax = $('btn-scene-climax');
        el.btnSceneEncore = $('btn-scene-encore');

        // Moments panel buttons
        el.btnMomentCapture = $('btn-moment-capture');
        el.btnMomentCaptureAll = $('btn-moment-capture-all');
        el.btnMomentBrowse = $('btn-moment-browse');
        el.btnMomentPlay = $('btn-moment-play');
        el.momentCountBadge = $('moment-count-badge');

        // More panel buttons
        el.btnMuteAll = $('btn-mute-all');
        el.btnRandomAll = $('btn-random-all');
        el.btnCopyUrl = $('btn-copy-url');
        el.btnInfo = $('btn-info');
        el.btnBugeye = $('btn-bugeye');
        el.btnMosaic = $('btn-mosaic');

        // Moments browser
        el.momentsBrowser = $('moments-browser');
        el.momentsBrowserClose = $('moments-browser-close');
        el.momentsBrowserCount = $('moments-browser-count');
        el.momentsFilterTabs = $('moments-filter-tabs');
        el.momentsSortSelect = $('moments-sort-select');
        el.momentsSourceSelect = $('moments-source-select');
        el.momentsGrid = $('moments-grid');
        el.momentsLoading = $('moments-loading');
        el.momentsEmpty = $('moments-empty');

        // Moments player
        el.momentsPlayer = $('moments-player');
        el.momentsPlayerVideo = $('moments-player-video');
        el.momentsPlayerControls = $('moments-player-controls');
        el.momentsPlayerClose = $('moments-player-close');
        el.momentsPlayerTitle = $('moments-player-title');
        el.momentsPlayerSource = $('moments-player-source');
        el.momentsPlayerCounter = $('moments-player-counter');
        el.momentsPlayerTags = $('moments-player-tags');
        el.momentsPlayerProgress = $('moments-player-progress');
        el.momentsPlayerProgressFill = $('moments-player-progress-fill');
        el.momentsPlayerTime = $('moments-player-time');
        el.momentsPlayerRating = $('moments-player-rating');
        el.mpRatingLove = $('mp-rating-love');
        el.mpAutoAdvance = $('mp-auto-advance');
        el.momentsPlayerIndicator = $('moments-player-indicator');

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

    let _pollPending = false;
    async function pollState() {
        if (_pollPending) return;
        _pollPending = true;
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
            // Server unreachable — fall back to localStorage
            console.warn('[Remote] Server poll failed:', e.message);
        } finally {
            _pollPending = false;
        }

        const stored = localStorage.getItem(STATE_KEY);
        if (stored) {
            try {
                const newState = JSON.parse(stored);
                if (newState.timestamp && Date.now() - newState.timestamp < 3000) {
                    handleStateUpdate(newState);
                }
            } catch (e) { console.warn('[Remote] localStorage parse error:', e.message); }
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
            } catch (e) { console.warn('[Remote] localStorage fallback failed:', e.message); }
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
        } else if (!withinGracePeriod && state.selectedStreamId && state.selectedStreamId !== selectedStreamId) {
            // Only override local selection if grace period expired AND Mac selected something different
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

    function showSwipeIndicator(text) {
        if (!el.streamIndicator) return;
        el.streamIndicator.textContent = text;
        el.streamIndicator.classList.add('visible');
        setTimeout(() => el.streamIndicator.classList.remove('visible'), 800);
    }

    // ============================================
    // URL Helpers (ported from stream.js)
    // ============================================

    /**
     * Check if URL is an HLS stream.
     * NOTE: /stream endpoints (Stash, etc.) serve raw MP4, NOT HLS.
     */
    function isHlsUrl(url) {
        if (!url) return false;
        const lower = url.toLowerCase();
        if (lower.includes('.m3u8')) return true;
        return [/\/live$/i, /\/live\?/i, /\/playlist$/i, /\/master$/i, /\/hls\//i]
            .some(p => p.test(url));
    }

    /**
     * Get the best playable URL for a stream on the remote.
     * Priority: sourceUrl (already proxied) > serverUrl > url (with proxy routing)
     */
    function getPlayableUrl(stream) {
        if (!stream) return null;

        // sourceUrl is already proxied by the main app — best option
        if (stream.sourceUrl) return stream.sourceUrl;

        // serverUrl is a local path (e.g. /api/files/xxx or /api/hls/xxx) — always playable
        if (stream.serverUrl) return stream.serverUrl;

        // Raw URL — need proxy for cross-origin
        const url = stream.url;
        if (!url || url.startsWith('blob:') || url.startsWith('data:')) return null;

        // Same-origin URLs play directly
        try {
            const u = new URL(url);
            if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' ||
                u.hostname === window.location.hostname) return url;
        } catch { return url; }

        // Cross-origin: route through appropriate proxy
        if (isHlsUrl(url)) return '/api/proxy/hls?url=' + encodeURIComponent(url);
        return '/api/proxy/video?url=' + encodeURIComponent(url);
    }

    // ============================================
    // Video Player Management
    // ============================================
    function loadVideo(videoEl, url, hlsInstance) {
        if (!videoEl || !url) return null;

        if (hlsInstance) {
            hlsInstance.destroy();
        }

        // Clear previous error state
        videoEl.classList.remove('error');

        const hls_url = isHlsUrl(url);

        // Error handler for video element
        const onError = () => {
            console.warn('[Remote] Video load failed:', url);
            videoEl.classList.remove('active');
            videoEl.classList.add('error');
        };
        videoEl.removeEventListener('error', videoEl._onError);
        videoEl.addEventListener('error', onError);
        videoEl._onError = onError;

        if (hls_url && typeof Hls !== 'undefined' && Hls.isSupported()) {
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
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    console.warn('[Remote] HLS fatal error:', data.type, data.details);
                    videoEl.classList.remove('active');
                    videoEl.classList.add('error');
                }
            });
            return hls;
        } else if (hls_url && videoEl.canPlayType('application/vnd.apple.mpegurl')) {
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

        const videoUrl = getPlayableUrl(stream);

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
        const videoUrl = getPlayableUrl(stream);
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

        // Clean up viewer video resources
        if (viewerHls) {
            viewerHls.destroy();
            viewerHls = null;
        }
        if (el.viewerVideo) {
            el.viewerVideo.pause();
            el.viewerVideo.removeAttribute('src');
            el.viewerVideo.removeAttribute('data-url');
            el.viewerVideo.load();
        }

        // Also exit fullscreen on Mac (synchronized)
        send('exitFullscreen');
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
            renderToolbar();
            updateHeroVideo();

            if (viewerMode) {
                updateViewerVideo();
            }
        }
    }

    function renderToolbar() {
        // Update layout label based on state
        if (el.layoutLabel && state) {
            if (state.tetrisMode) {
                currentLayout = 'tetris';
                el.layoutLabel.textContent = 'Tetris';
            } else if (state.mosaicMode) {
                currentLayout = 'mosaic';
                el.layoutLabel.textContent = 'Mosaic';
            } else if (state.cleanMode) {
                currentLayout = 'clean';
                el.layoutLabel.textContent = 'Clean';
            } else {
                currentLayout = 'grid';
                el.layoutLabel.textContent = 'Grid';
            }
        }

        // Update audio focus button state
        if (el.btnAudioFocus && state) {
            el.btnAudioFocus.classList.toggle('audio-focus-active', state.audioFocusMode || false);
        }

        // Update focus button state (if Mac is in fullscreen)
        if (el.btnFocus && state) {
            el.btnFocus.classList.toggle('active', !!state.fullscreenStreamId);
        }

        // Theater mode state
        if (el.btnTheater) {
            el.btnTheater.classList.toggle('active', state.theaterMode || false);
        }

        // Scene buttons: disable when not in theater, highlight current
        document.querySelectorAll('.toolbar-btn-scene').forEach(btn => {
            const isTheater = state.theaterMode || false;
            btn.classList.toggle('disabled', !isTheater);
            btn.classList.toggle('current', isTheater && state.theaterScene === btn.dataset.scene);
        });

        // Moment count badge
        if (el.momentCountBadge) {
            const count = state.momentCount || 0;
            el.momentCountBadge.textContent = count > 0 ? count : '';
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
            const isFocused = state?.fullscreenStreamId === stream.id;
            el.heroStatus.classList.toggle('playing', isPlaying);
            el.heroStatus.classList.toggle('paused', !isPlaying);
            el.heroStatus.classList.toggle('focused', isFocused);
            const statusText = el.heroStatus.querySelector('.status-text');
            if (statusText) {
                if (isFocused) {
                    statusText.textContent = 'Focus';
                } else {
                    statusText.textContent = isPlaying ? 'Playing' : 'Paused';
                }
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
        const isFavorite = stream?.favorite || false;

        // Update favorite button
        if (el.btnFavorite) {
            el.btnFavorite.classList.toggle('active', isFavorite);
        }

        // Update rating buttons
        el.ratingStrip?.querySelectorAll('.rating-btn[data-rating]').forEach(btn => {
            const btnRating = parseInt(btn.dataset.rating, 10);
            btn.classList.toggle('active', btnRating === rating);
        });
    }

    function renderThumbnails() {
        if (!el.thumbsStrip) return;

        const filteredStreams = getFilteredStreams();
        if (filteredStreams.length === 0) {
            let emptyMsg = 'No streams';
            if (currentFilter === 'fav') {
                emptyMsg = 'No favorites yet';
            } else if (currentFilter === '0') {
                emptyMsg = 'No unrated streams';
            } else if (currentFilter !== 'all') {
                emptyMsg = `No streams rated ${currentFilter}`;
            }
            el.thumbsStrip.innerHTML = `<div class="thumbs-empty">${emptyMsg}</div>`;
            return;
        }

        el.thumbsStrip.innerHTML = filteredStreams.map((stream) => {
            const isSelected = stream.id === selectedStreamId;
            const rating = stream.rating || 0;
            const isFavorite = stream.favorite || false;
            const hasThumbnail = !!stream.thumbnail;

            return `
                <div class="thumb-item ${isSelected ? 'selected' : ''}"
                     data-id="${stream.id}">
                    ${hasThumbnail
                        ? `<img class="thumb-img" src="${stream.thumbnail}" alt="">`
                        : `<div class="thumb-placeholder"></div>`
                    }
                    ${isFavorite ? `<span class="thumb-fav">♥</span>` : ''}
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

            // Update count badges
            const countEl = tab.querySelector('.filter-count');
            if (countEl) {
                let count = 0;
                if (filter === 'all') {
                    count = streams.length;
                } else if (filter === 'fav') {
                    count = streams.filter(s => s.favorite).length;
                } else {
                    const filterRating = parseInt(filter, 10);
                    count = streams.filter(s => (s.rating || 0) === filterRating).length;
                }
                countEl.textContent = count > 0 ? count : '';
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
        if (currentFilter === 'fav') return streams.filter(s => s.favorite);

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

        // Toolbar buttons
        el.btnRandom?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('randomSeek', { streamId: selectedStreamId });
                haptic.medium();
            }
        });

        el.btnFocus?.addEventListener('click', () => {
            // Synchronized focus: opens phone viewer AND triggers Mac focus
            if (selectedStreamId) {
                send('enterFullscreen', { streamId: selectedStreamId });
            }
            enterViewer();
        });

        el.btnAudioFocus?.addEventListener('click', () => {
            send('toggleAudioFocus');
            haptic.medium();
            // Toggle visual state
            el.btnAudioFocus.classList.toggle('audio-focus-active');
        });

        el.btnPauseAll?.addEventListener('click', () => {
            send('togglePauseAll');
            haptic.medium();
        });

        el.btnLayout?.addEventListener('click', () => {
            // Cycle through layout modes
            const idx = LAYOUT_MODES.indexOf(currentLayout);
            const nextIdx = (idx + 1) % LAYOUT_MODES.length;
            currentLayout = LAYOUT_MODES[nextIdx];

            // Send the appropriate command
            if (currentLayout === 'tetris') {
                send('toggleTetrisMode');
            } else if (currentLayout === 'mosaic') {
                send('toggleMosaicMode');
            } else if (currentLayout === 'clean') {
                send('toggleCleanMode');
            } else {
                // Grid mode - disable all special modes
                send('setLayoutMode', { mode: 'grid' });
            }

            // Update label
            if (el.layoutLabel) {
                el.layoutLabel.textContent = currentLayout.charAt(0).toUpperCase() + currentLayout.slice(1);
            }
            haptic.medium();
        });

        el.btnCrop?.addEventListener('click', () => {
            send('toggleCrop');
            haptic.medium();
        });

        // Tab switching
        el.toolbarTabs?.addEventListener('click', (e) => {
            const tab = e.target.closest('.toolbar-tab');
            if (!tab) return;
            const tabName = tab.dataset.tab;
            if (!tabName) return;

            // Update tab active states
            el.toolbarTabs.querySelectorAll('.toolbar-tab').forEach(t => t.classList.remove('active'));
            tab.classList.add('active');

            // Update panel visibility
            document.querySelectorAll('.toolbar-panel').forEach(p => p.classList.remove('active'));
            const panel = document.querySelector(`.toolbar-panel[data-panel="${tabName}"]`);
            if (panel) panel.classList.add('active');

            haptic.light();
        });

        // Mode panel — Theater toggle
        el.btnTheater?.addEventListener('click', () => {
            send('key', { key: '`' });
            haptic.medium();
        });

        // Mode panel — Scene buttons
        ['casting', 'lineup', 'stage', 'climax', 'encore'].forEach(scene => {
            const btn = $('btn-scene-' + scene);
            btn?.addEventListener('click', () => {
                send('theater-scene', { scene });
                haptic.medium();
            });
        });

        // Moments panel
        el.btnMomentCapture?.addEventListener('click', () => {
            send('key', { key: 'k' });
            haptic.success();
        });

        el.btnMomentCaptureAll?.addEventListener('click', () => {
            send('key', { key: 'k', shift: true });
            haptic.success();
        });

        el.btnMomentBrowse?.addEventListener('click', () => {
            openMomentsBrowser();
            haptic.medium();
        });

        el.btnMomentPlay?.addEventListener('click', () => {
            // Fetch moments and play a random one
            fetchMoments().then(() => {
                if (momentsFilteredList.length > 0) {
                    const idx = Math.floor(Math.random() * momentsFilteredList.length);
                    openMomentsPlayer(idx);
                }
            });
            haptic.medium();
        });

        // More panel
        el.btnMuteAll?.addEventListener('click', () => {
            send('toggleMuteAll');
            haptic.medium();
        });

        el.btnRandomAll?.addEventListener('click', () => {
            send('randomSeekAll');
            haptic.medium();
        });

        el.btnCopyUrl?.addEventListener('click', () => {
            const stream = getCurrentStream();
            if (stream?.url) {
                navigator.clipboard.writeText(stream.url).then(() => haptic.success()).catch(() => haptic.light());
            }
        });

        el.btnInfo?.addEventListener('click', () => {
            send('toggleStreamInfo');
            haptic.light();
        });

        el.btnBugeye?.addEventListener('click', () => {
            send('toggleBugEyeMode');
            haptic.medium();
        });

        el.btnMosaic?.addEventListener('click', () => {
            send('toggleMosaicMode');
            haptic.medium();
        });

        // Favorite button
        el.btnFavorite?.addEventListener('click', () => {
            if (selectedStreamId) {
                send('toggleFavorite', { streamId: selectedStreamId });
                el.btnFavorite.classList.add('just-set');
                setTimeout(() => el.btnFavorite.classList.remove('just-set'), 300);
                haptic.success();
            }
        });

        // Rating buttons
        el.ratingStrip?.querySelectorAll('.rating-btn[data-rating]').forEach(btn => {
            btn.addEventListener('click', () => {
                const rating = parseInt(btn.dataset.rating, 10);
                if (selectedStreamId && !isNaN(rating)) {
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
            const currentY = e.touches[0].clientY;
            const deltaX = currentX - startX;
            const deltaY = currentY - startY;

            // Visual feedback during swipe
            if (Math.abs(deltaX) > 20) {
                el.heroPreview.classList.toggle('swiping-left', deltaX < -20);
                el.heroPreview.classList.toggle('swiping-right', deltaX > 20);
            }
            // Vertical swipe-up feedback
            el.heroPreview.classList.toggle('swiping-up', deltaY < -20 && Math.abs(deltaY) > Math.abs(deltaX));
        }, { passive: true });

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

            // Tap detection - zone-based actions (single tap, no double-tap)
            if (absX < 15 && absY < 15) {
                if (!selectedStreamId) return;

                // Calculate tap zone using thirds
                const rect = el.heroPreview.getBoundingClientRect();
                const relX = (startX - rect.left) / rect.width;
                const relY = (startY - rect.top) / rect.height;

                // Zone layout:
                // +------------------+
                // | TOP: Viewer      |  (top third)
                // +------+----+------+
                // | LEFT |PLAY| RIGHT|  (middle third)
                // | -30s |    | +30s |
                // +------+----+------+
                // | BTM: Viewer      |  (bottom third)
                // +------------------+
                // Swipe up = Random (anywhere)

                if (relY < 0.33 || relY > 0.67) {
                    // Top/bottom third = synchronized focus (phone viewer + Mac fullscreen)
                    send('enterFullscreen', { streamId: selectedStreamId });
                    enterViewer();
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
            // Swipe up = random seek
            } else if (deltaY < -SWIPE_THRESHOLD && absY > absX) {
                send('randomSeek', { streamId: selectedStreamId });
                haptic.heavy();
                showSwipeIndicator('Random');
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
                if (deltaY > 0) {
                    // Swipe down = exit viewer
                    exitViewer();
                } else {
                    // Swipe up = random seek
                    send('randomSeek', { streamId: selectedStreamId });
                    haptic.heavy();
                    showSwipeIndicator('Random');
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
    // Moments Browser & Player
    // ============================================

    async function fetchMoments() {
        if (momentsLoading) return;
        momentsLoading = true;
        if (el.momentsLoading) el.momentsLoading.classList.remove('hidden');
        if (el.momentsEmpty) el.momentsEmpty.classList.add('hidden');

        try {
            const res = await fetch('/api/moments');
            if (!res.ok) throw new Error('HTTP ' + res.status);
            momentsData = await res.json();

            // Build sources list
            const seenSources = {};
            momentsSources = [];
            momentsData.forEach(function(m) {
                const src = m.sourceTitle || m.sourceUrl;
                if (src && !seenSources[src]) {
                    seenSources[src] = true;
                    momentsSources.push({ label: src, url: m.sourceUrl });
                }
            });

            applyMomentsFilterAndSort();
        } catch (e) {
            console.warn('[Remote] Failed to fetch moments:', e.message);
            momentsData = [];
            momentsFilteredList = [];
        } finally {
            momentsLoading = false;
            if (el.momentsLoading) el.momentsLoading.classList.add('hidden');
        }
    }

    function applyMomentsFilterAndSort() {
        var list = momentsData.slice();

        if (momentsFilter === 'loved') {
            list = list.filter(function(m) { return m.loved; });
        } else if (momentsFilter !== 'all') {
            var r = parseInt(momentsFilter, 10);
            list = list.filter(function(m) { return (m.rating || 0) === r; });
        }

        if (momentsFilterSource) {
            list = list.filter(function(m) { return m.sourceUrl === momentsFilterSource; });
        }

        if (momentsSort === 'newest') {
            list.sort(function(a, b) { return (b.createdAt || 0) - (a.createdAt || 0); });
        } else if (momentsSort === 'oldest') {
            list.sort(function(a, b) { return (a.createdAt || 0) - (b.createdAt || 0); });
        } else if (momentsSort === 'rating') {
            list.sort(function(a, b) { return (b.rating || 0) - (a.rating || 0); });
        } else if (momentsSort === 'duration') {
            list.sort(function(a, b) { return ((b.end - b.start) || 0) - ((a.end - a.start) || 0); });
        }

        momentsFilteredList = list;
        momentsSelectedIndex = 0;
    }

    function openMomentsBrowser() {
        momentsBrowserOpen = true;
        if (el.momentsBrowser) el.momentsBrowser.classList.remove('hidden');

        fetchMoments().then(function() {
            renderMomentsGrid();
            updateMomentsSourceDropdown();
        });
    }

    function closeMomentsBrowser() {
        momentsBrowserOpen = false;
        if (el.momentsBrowser) el.momentsBrowser.classList.add('hidden');
    }

    function createMomentCard(m, idx) {
        var card = document.createElement('div');
        card.className = 'moment-card';
        card.dataset.idx = idx;

        var thumbUrl = '/api/moments/' + encodeURIComponent(m.id) + '/thumb.jpg';
        var img = document.createElement('img');
        img.className = 'moment-card-img';
        img.src = thumbUrl;
        img.alt = '';
        img.loading = 'lazy';

        var placeholder = document.createElement('div');
        placeholder.className = 'moment-card-placeholder';
        placeholder.style.display = 'none';
        placeholder.textContent = '\u25B6';

        img.addEventListener('error', function() {
            img.style.display = 'none';
            placeholder.style.display = 'flex';
        });
        card.appendChild(img);
        card.appendChild(placeholder);

        if (m.loved) {
            var love = document.createElement('span');
            love.className = 'moment-card-love';
            love.textContent = '\u2665';
            card.appendChild(love);
        }

        var rating = m.rating || 0;
        if (rating > 0) {
            var badge = document.createElement('span');
            badge.className = 'moment-card-badge';
            badge.dataset.rating = rating;
            badge.textContent = rating;
            card.appendChild(badge);
        }

        var duration = (m.end && m.start) ? m.end - m.start : 0;
        if (duration > 0) {
            var dur = document.createElement('span');
            dur.className = 'moment-card-duration';
            dur.textContent = formatTime(duration);
            card.appendChild(dur);
        }

        if (m.extracted) {
            var dot = document.createElement('span');
            dot.className = 'moment-card-extracted';
            card.appendChild(dot);
        }

        return card;
    }

    function renderMomentsGrid() {
        if (!el.momentsGrid) return;

        if (el.momentsBrowserCount) {
            el.momentsBrowserCount.textContent = momentsFilteredList.length;
        }

        // Clear existing cards
        while (el.momentsGrid.firstChild) {
            el.momentsGrid.removeChild(el.momentsGrid.firstChild);
        }

        if (momentsFilteredList.length === 0) {
            if (el.momentsEmpty) el.momentsEmpty.classList.remove('hidden');
            return;
        }
        if (el.momentsEmpty) el.momentsEmpty.classList.add('hidden');

        var fragment = document.createDocumentFragment();
        momentsFilteredList.forEach(function(m, idx) {
            fragment.appendChild(createMomentCard(m, idx));
        });
        el.momentsGrid.appendChild(fragment);
    }

    function updateMomentsSourceDropdown() {
        if (!el.momentsSourceSelect) return;
        while (el.momentsSourceSelect.options.length > 1) {
            el.momentsSourceSelect.remove(1);
        }
        momentsSources.forEach(function(s) {
            var label = s.label.length > 40 ? s.label.substring(0, 37) + '...' : s.label;
            var opt = document.createElement('option');
            opt.value = s.url;
            opt.textContent = label;
            if (s.url === momentsFilterSource) opt.selected = true;
            el.momentsSourceSelect.appendChild(opt);
        });
    }

    function openMomentsPlayer(index) {
        if (index < 0 || index >= momentsFilteredList.length) return;

        momentsPlayerOpen = true;
        momentsPlayerIndex = index;
        if (el.momentsPlayer) el.momentsPlayer.classList.remove('hidden');

        var moment = momentsFilteredList[index];
        loadMomentVideo(moment);
        updateMomentsPlayerUI(moment);
        showMomentsPlayerControls();
    }

    function closeMomentsPlayer() {
        momentsPlayerOpen = false;
        if (el.momentsPlayer) el.momentsPlayer.classList.add('hidden');

        if (momentPlayerHls) {
            momentPlayerHls.destroy();
            momentPlayerHls = null;
        }
        if (el.momentsPlayerVideo) {
            el.momentsPlayerVideo.pause();
            el.momentsPlayerVideo.removeAttribute('src');
            el.momentsPlayerVideo.load();
        }
        if (_mpProgressRAF) {
            cancelAnimationFrame(_mpProgressRAF);
            _mpProgressRAF = null;
        }
        clearTimeout(_mpControlsTimeout);
    }

    function loadMomentVideo(moment) {
        if (!el.momentsPlayerVideo || !moment) return;

        if (momentPlayerHls) {
            momentPlayerHls.destroy();
            momentPlayerHls = null;
        }

        var video = el.momentsPlayerVideo;

        // Prefer extracted clip
        if (moment.extracted) {
            var clipUrl = '/api/moments/' + encodeURIComponent(moment.id) + '/clip.mp4';
            video.src = clipUrl;
            video.currentTime = 0;
            video.play().catch(function() {});
            setupMomentBoundaryEnforcement(moment, video, true);
            return;
        }

        // Non-extracted: play source video seeked to start
        var sourceUrl = getMomentSourceUrl(moment.sourceUrl);
        if (!sourceUrl) return;

        if (isHlsUrl(sourceUrl)) {
            if (typeof Hls !== 'undefined' && Hls.isSupported()) {
                var hls = new Hls({ enableWorker: true, lowLatencyMode: false });
                hls.loadSource(sourceUrl);
                hls.attachMedia(video);
                hls.on(Hls.Events.MANIFEST_PARSED, function() {
                    video.currentTime = moment.start || 0;
                    video.play().catch(function() {});
                });
                hls.on(Hls.Events.ERROR, function(ev, data) {
                    if (data.fatal) console.warn('[Remote] Moment HLS error:', data.details);
                });
                momentPlayerHls = hls;
            } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = sourceUrl;
                video.addEventListener('loadedmetadata', function() {
                    video.currentTime = moment.start || 0;
                    video.play().catch(function() {});
                }, { once: true });
            }
        } else {
            video.src = sourceUrl;
            video.addEventListener('loadedmetadata', function() {
                video.currentTime = moment.start || 0;
                video.play().catch(function() {});
            }, { once: true });
        }

        setupMomentBoundaryEnforcement(moment, video, false);
    }

    function setupMomentBoundaryEnforcement(moment, video, isClip) {
        if (video._momentTimeUpdate) {
            video.removeEventListener('timeupdate', video._momentTimeUpdate);
        }
        if (video._momentEnded) {
            video.removeEventListener('ended', video._momentEnded);
        }

        var onEnded = function() {
            if (momentsAutoAdvance && momentsPlayerOpen) {
                navigateMoment('next');
            }
        };

        if (isClip) {
            video.addEventListener('ended', onEnded);
            video._momentEnded = onEnded;
            return;
        }

        var onTimeUpdate = function() {
            if (!momentsPlayerOpen) return;
            if (moment.end && video.currentTime >= moment.end) {
                video.pause();
                if (momentsAutoAdvance) {
                    navigateMoment('next');
                }
            }
            updateMomentsPlayerProgress(moment, video);
        };
        video.addEventListener('timeupdate', onTimeUpdate);
        video._momentTimeUpdate = onTimeUpdate;
        video.addEventListener('ended', onEnded);
        video._momentEnded = onEnded;
    }

    function getMomentSourceUrl(sourceUrl) {
        if (!sourceUrl) return null;
        if (sourceUrl.startsWith('/')) return sourceUrl;
        try {
            var u = new URL(sourceUrl);
            if (u.hostname === 'localhost' || u.hostname === '127.0.0.1' ||
                u.hostname === window.location.hostname) return sourceUrl;
        } catch (e) { return sourceUrl; }
        if (isHlsUrl(sourceUrl)) return '/api/proxy/hls?url=' + encodeURIComponent(sourceUrl);
        return '/api/proxy/video?url=' + encodeURIComponent(sourceUrl);
    }

    function navigateMoment(direction) {
        if (momentsFilteredList.length === 0) return;
        var idx = momentsPlayerIndex;
        if (direction === 'next') {
            idx = (idx + 1) % momentsFilteredList.length;
        } else if (direction === 'prev') {
            idx = (idx - 1 + momentsFilteredList.length) % momentsFilteredList.length;
        } else if (direction === 'random') {
            idx = Math.floor(Math.random() * momentsFilteredList.length);
        }
        momentsPlayerIndex = idx;
        var moment = momentsFilteredList[idx];
        if (moment) {
            loadMomentVideo(moment);
            updateMomentsPlayerUI(moment);
            showMomentsPlayerIndicator(moment);
        }
    }

    function updateMomentsPlayerUI(moment) {
        if (!moment) return;

        if (el.momentsPlayerTitle) {
            var title = moment.sourceTitle || 'Moment';
            el.momentsPlayerTitle.textContent = title.length > 40 ? title.substring(0, 37) + '...' : title;
        }

        if (el.momentsPlayerSource) {
            var src = moment.sourceUrl || '';
            try {
                var u = new URL(src);
                el.momentsPlayerSource.textContent = u.hostname;
            } catch (e) {
                el.momentsPlayerSource.textContent = src.startsWith('/') ? 'Local' : '';
            }
        }

        if (el.momentsPlayerCounter) {
            el.momentsPlayerCounter.textContent = (momentsPlayerIndex + 1) + '/' + momentsFilteredList.length;
        }

        // Tags — build safely with DOM methods
        if (el.momentsPlayerTags) {
            while (el.momentsPlayerTags.firstChild) {
                el.momentsPlayerTags.removeChild(el.momentsPlayerTags.firstChild);
            }
            var tags = moment.aiTags || [];
            tags.slice(0, 8).forEach(function(t) {
                var span = document.createElement('span');
                span.className = 'mp-tag';
                span.textContent = typeof t === 'string' ? t : (t.tag || '');
                el.momentsPlayerTags.appendChild(span);
            });
        }

        updateMomentsPlayerRating(moment);

        if (el.mpAutoAdvance) {
            el.mpAutoAdvance.classList.toggle('active', momentsAutoAdvance);
        }

        if (el.momentsPlayerProgressFill) el.momentsPlayerProgressFill.style.width = '0%';
        if (el.momentsPlayerTime) {
            var dur = (moment.end && moment.start) ? moment.end - moment.start : 0;
            el.momentsPlayerTime.textContent = '0:00 / ' + formatTime(dur);
        }

        startMomentsProgressLoop(moment);
    }

    function updateMomentsPlayerRating(moment) {
        if (!el.momentsPlayerRating) return;
        var rating = moment.rating || 0;
        var loved = moment.loved || false;

        if (el.mpRatingLove) el.mpRatingLove.classList.toggle('active', loved);

        el.momentsPlayerRating.querySelectorAll('.mp-rating-btn[data-rating]').forEach(function(btn) {
            var r = parseInt(btn.dataset.rating, 10);
            btn.classList.toggle('active', r === rating);
        });
    }

    var _mpProgressRAF = null;
    function startMomentsProgressLoop(moment) {
        if (_mpProgressRAF) cancelAnimationFrame(_mpProgressRAF);

        var tick = function() {
            if (!momentsPlayerOpen) return;
            updateMomentsPlayerProgress(moment, el.momentsPlayerVideo);
            _mpProgressRAF = requestAnimationFrame(tick);
        };
        _mpProgressRAF = requestAnimationFrame(tick);
    }

    function updateMomentsPlayerProgress(moment, video) {
        if (!video || !moment) return;
        var isClip = moment.extracted;
        var start = isClip ? 0 : (moment.start || 0);
        var end = isClip ? video.duration : (moment.end || video.duration);
        var total = end - start;
        if (!total || total <= 0) return;

        var current = video.currentTime - start;
        var pct = Math.max(0, Math.min(100, (current / total) * 100));

        if (el.momentsPlayerProgressFill) el.momentsPlayerProgressFill.style.width = pct + '%';
        if (el.momentsPlayerTime) {
            el.momentsPlayerTime.textContent = formatTime(Math.max(0, current)) + ' / ' + formatTime(total);
        }
    }

    async function rateMoment(momentId, updates) {
        try {
            var moment = momentsData.find(function(m) { return m.id === momentId; });
            if (moment) Object.assign(moment, updates);

            await fetch('/api/moments', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(Object.assign({ id: momentId }, updates))
            });
        } catch (e) {
            console.warn('[Remote] Failed to rate moment:', e.message);
        }
    }

    var _mpControlsTimeout = null;
    function showMomentsPlayerControls() {
        if (!el.momentsPlayerControls) return;
        el.momentsPlayerControls.classList.remove('hidden');
        clearTimeout(_mpControlsTimeout);
        _mpControlsTimeout = setTimeout(function() {
            if (momentsPlayerOpen) el.momentsPlayerControls.classList.add('hidden');
        }, 4000);
    }

    function toggleMomentsPlayerControls() {
        if (!el.momentsPlayerControls) return;
        if (el.momentsPlayerControls.classList.contains('hidden')) {
            showMomentsPlayerControls();
        } else {
            clearTimeout(_mpControlsTimeout);
            el.momentsPlayerControls.classList.add('hidden');
        }
    }

    function showMomentsPlayerIndicator(moment) {
        if (!el.momentsPlayerIndicator) return;
        var title = moment.sourceTitle || 'Moment';
        el.momentsPlayerIndicator.textContent = title.length > 30 ? title.substring(0, 27) + '...' : title;
        el.momentsPlayerIndicator.classList.add('visible');
        setTimeout(function() { el.momentsPlayerIndicator.classList.remove('visible'); }, 1000);
    }

    // ============================================
    // Moments Event Setup
    // ============================================

    function setupMomentsBrowserEvents() {
        el.momentsBrowserClose?.addEventListener('click', closeMomentsBrowser);

        el.momentsFilterTabs?.addEventListener('click', function(e) {
            var tab = e.target.closest('.moments-filter-tab');
            if (!tab) return;
            var filter = tab.dataset.filter;
            if (!filter) return;
            momentsFilter = filter;
            el.momentsFilterTabs.querySelectorAll('.moments-filter-tab').forEach(function(t) {
                t.classList.toggle('active', t.dataset.filter === filter);
            });
            applyMomentsFilterAndSort();
            renderMomentsGrid();
            haptic.light();
        });

        el.momentsSortSelect?.addEventListener('change', function() {
            momentsSort = el.momentsSortSelect.value;
            applyMomentsFilterAndSort();
            renderMomentsGrid();
        });

        el.momentsSourceSelect?.addEventListener('change', function() {
            momentsFilterSource = el.momentsSourceSelect.value;
            applyMomentsFilterAndSort();
            renderMomentsGrid();
        });

        el.momentsGrid?.addEventListener('click', function(e) {
            var card = e.target.closest('.moment-card');
            if (!card) return;
            var idx = parseInt(card.dataset.idx, 10);
            if (!isNaN(idx)) {
                openMomentsPlayer(idx);
                haptic.medium();
            }
        });
    }

    function setupMomentsPlayerEvents() {
        el.momentsPlayerClose?.addEventListener('click', closeMomentsPlayer);

        el.mpRatingLove?.addEventListener('click', function() {
            var moment = momentsFilteredList[momentsPlayerIndex];
            if (!moment) return;
            moment.loved = !moment.loved;
            rateMoment(moment.id, { loved: moment.loved });
            updateMomentsPlayerRating(moment);
            haptic.success();
        });

        el.momentsPlayerRating?.querySelectorAll('.mp-rating-btn[data-rating]').forEach(function(btn) {
            btn.addEventListener('click', function() {
                var moment = momentsFilteredList[momentsPlayerIndex];
                if (!moment) return;
                var r = parseInt(btn.dataset.rating, 10);
                if (isNaN(r)) return;
                moment.rating = r;
                rateMoment(moment.id, { rating: r });
                updateMomentsPlayerRating(moment);
                haptic.success();
            });
        });

        el.mpAutoAdvance?.addEventListener('click', function() {
            momentsAutoAdvance = !momentsAutoAdvance;
            el.mpAutoAdvance.classList.toggle('active', momentsAutoAdvance);
            haptic.light();
        });

        el.momentsPlayerProgress?.addEventListener('click', function(e) {
            var moment = momentsFilteredList[momentsPlayerIndex];
            if (!moment || !el.momentsPlayerVideo) return;
            var rect = el.momentsPlayerProgress.getBoundingClientRect();
            var pct = (e.clientX - rect.left) / rect.width;
            var isClip = moment.extracted;
            var start = isClip ? 0 : (moment.start || 0);
            var end = isClip ? el.momentsPlayerVideo.duration : (moment.end || el.momentsPlayerVideo.duration);
            var total = end - start;
            if (total > 0) {
                el.momentsPlayerVideo.currentTime = start + (pct * total);
            }
            haptic.light();
        });

        // Touch gestures for moments player
        var startX = 0, startY = 0, isSwiping = false;

        el.momentsPlayer?.addEventListener('touchstart', function(e) {
            if (e.target.closest('.mp-rating-btn, .mp-rating-love, .mp-action-btn, .moments-player-close, .moments-player-progress')) return;
            startX = e.touches[0].clientX;
            startY = e.touches[0].clientY;
            isSwiping = true;
        }, { passive: true });

        el.momentsPlayer?.addEventListener('touchend', function(e) {
            if (!isSwiping) return;
            isSwiping = false;

            var endX = e.changedTouches[0].clientX;
            var endY = e.changedTouches[0].clientY;
            var deltaX = endX - startX;
            var deltaY = endY - startY;
            var absX = Math.abs(deltaX);
            var absY = Math.abs(deltaY);

            // Tap = toggle controls
            if (absX < 15 && absY < 15) {
                toggleMomentsPlayerControls();
                return;
            }

            // Horizontal swipe = next/prev moment
            if (absX > SWIPE_THRESHOLD && absX > absY) {
                if (deltaX > 0) {
                    navigateMoment('prev');
                } else {
                    navigateMoment('next');
                }
                haptic.medium();
            // Vertical swipe
            } else if (absY > SWIPE_THRESHOLD && absY > absX) {
                if (deltaY > 0) {
                    closeMomentsPlayer();
                    haptic.medium();
                } else {
                    navigateMoment('random');
                    haptic.heavy();
                }
            }
        }, { passive: true });
    }

    // ============================================
    // Initialize
    // ============================================
    function init() {
        cacheElements();
        setupEventListeners();
        setupMomentsBrowserEvents();
        setupMomentsPlayerEvents();
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
