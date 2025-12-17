/**
 * Plexd Stream Manager
 *
 * Handles creation, management, and control of video streams.
 * Manages the lifecycle of video elements and their playback state.
 */

const PlexdStream = (function() {
    'use strict';

    // Stream registry
    const streams = new Map();
    let streamIdCounter = 0;

    // Default aspect ratio until video metadata loads
    const DEFAULT_ASPECT_RATIO = 16 / 9;

    // Currently selected stream for keyboard navigation
    let selectedStreamId = null;

    // Audio focus mode - when true, unmuting one mutes all others
    let audioFocusMode = true;

    // Show stream info overlay
    let showInfoOverlay = false;

    // Current grid layout for navigation
    let gridCols = 1;

    // Ratings map - stores stream URL -> rating (1-5 stars, 0 = not rated)
    const ratings = new Map();

    // ===== STREAM RECOVERY CONFIGURATION =====
    const RECOVERY_CONFIG = {
        maxRetries: 5,                    // Maximum auto-recovery attempts
        baseRetryDelay: 1000,             // Base delay (1 second)
        maxRetryDelay: 30000,             // Max delay (30 seconds)
        watchdogInterval: 5000,           // Check streams every 5 seconds
        stallTimeout: 10000,              // Consider stalled after 10s no progress
        bufferEmptyTimeout: 15000,        // Timeout for empty buffer
        hlsRecoveryDelay: 500,            // Delay before HLS recovery attempt
        enableAutoRecovery: true          // Master switch for auto-recovery
    };

    // Health monitoring state
    let healthCheckInterval = null;
    let isPageVisible = true;

    // Callback for ratings updates
    let ratingsUpdateCallback = null;

    /**
     * Create a new stream from a URL
     * @param {string} url - Video stream URL
     * @param {Object} options - Optional configuration
     * @returns {Object} Stream object with id, element, and metadata
     */
    function createStream(url, options = {}) {
        const id = 'stream-' + (++streamIdCounter);

        // Create wrapper element
        const wrapper = document.createElement('div');
        wrapper.className = 'plexd-stream';
        wrapper.id = id;
        wrapper.tabIndex = -1; // Make focusable for keyboard events in fullscreen modes

        // Create video element
        const video = document.createElement('video');
        video.className = 'plexd-video';
        video.autoplay = options.autoplay !== false;
        video.muted = options.muted !== false; // Muted by default for autoplay
        video.loop = options.loop || false;
        video.playsInline = true; // Required for iOS
        // Don't set crossOrigin - it causes CORS preflight which many video servers reject

        // Create controls overlay
        const controls = createControlsOverlay(id);

        // Create info overlay
        const infoOverlay = createInfoOverlay(url);

        // Create rating indicator (tappable on touch devices)
        const ratingIndicator = document.createElement('div');
        ratingIndicator.className = 'plexd-rating-indicator';
        ratingIndicator.innerHTML = '☆'; // Show empty star initially
        ratingIndicator.title = 'Tap to rate';
        ratingIndicator.onclick = (e) => {
            e.stopPropagation();
            cycleRating(id);
        };

        // Assemble
        wrapper.appendChild(video);
        wrapper.appendChild(controls);
        wrapper.appendChild(infoOverlay);
        wrapper.appendChild(ratingIndicator);

        // Make draggable and focusable (for keyboard in fullscreen)
        wrapper.draggable = true;
        wrapper.dataset.streamId = id;
        wrapper.tabIndex = 0; // Makes it focusable

        // Stream state
        const stream = {
            id,
            url,
            wrapper,
            video,
            controls,
            infoOverlay,
            hls: null, // HLS.js instance if used
            aspectRatio: DEFAULT_ASPECT_RATIO,
            state: 'loading', // loading, playing, paused, buffering, error, recovering
            error: null,
            // Recovery state
            recovery: {
                retryCount: 0,
                lastRetryTime: 0,
                isRecovering: false,
                retryTimer: null
            },
            // Health monitoring state
            health: {
                lastTimeUpdate: Date.now(),
                lastCurrentTime: 0,
                stallStartTime: null,
                bufferEmptyStartTime: null,
                consecutiveStalls: 0
            }
        };

        // Set up event listeners
        setupVideoEvents(stream);

        // Set source - use HLS.js for .m3u8 streams
        if (isHlsUrl(url) && typeof Hls !== 'undefined' && Hls.isSupported()) {
            const hls = createHlsInstance(stream, url);
            stream.hls = hls;
        } else if (isHlsUrl(url) && video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari has native HLS support
            video.src = url;
            // Explicitly trigger play for native HLS (autoplay may not work)
            video.addEventListener('canplay', function onCanPlay() {
                video.removeEventListener('canplay', onCanPlay);
                video.play().catch(() => {});
            }, { once: true });
        } else {
            // Regular video file
            video.src = url;
            // Explicitly trigger play (autoplay attribute may be ignored by browsers)
            video.addEventListener('canplay', function onCanPlay() {
                video.removeEventListener('canplay', onCanPlay);
                video.play().catch(() => {});
            }, { once: true });
        }

        // Register stream
        streams.set(id, stream);

        return stream;
    }

    /**
     * Check if URL is an HLS stream
     */
    function isHlsUrl(url) {
        return url.toLowerCase().includes('.m3u8');
    }

    /**
     * Get adaptive HLS configuration based on active stream count
     */
    function getAdaptiveHlsConfig() {
        const streamCount = streams.size;

        // Base config optimized for low latency and quality
        const config = {
            enableWorker: true,
            lowLatencyMode: true,
            autoStartLoad: true,
            startLevel: -1,
            capLevelToPlayerSize: false,
            // Recovery settings
            manifestLoadingTimeOut: 10000,
            manifestLoadingMaxRetry: 4,
            manifestLoadingRetryDelay: 500,
            levelLoadingTimeOut: 10000,
            levelLoadingMaxRetry: 4,
            levelLoadingRetryDelay: 500,
            fragLoadingTimeOut: 20000,
            fragLoadingMaxRetry: 6,
            fragLoadingRetryDelay: 500
        };

        // Adapt buffer sizes based on stream count for memory efficiency
        if (streamCount <= 2) {
            // Few streams - generous buffers for smooth playback
            config.maxBufferLength = 30;
            config.maxMaxBufferLength = 60;
            config.maxBufferSize = 60 * 1000 * 1000; // 60MB
            config.maxBufferHole = 0.5;
        } else if (streamCount <= 4) {
            // Moderate streams - balanced buffers
            config.maxBufferLength = 20;
            config.maxMaxBufferLength = 40;
            config.maxBufferSize = 30 * 1000 * 1000; // 30MB
            config.maxBufferHole = 0.5;
        } else if (streamCount <= 8) {
            // Many streams - reduced buffers
            config.maxBufferLength = 15;
            config.maxMaxBufferLength = 30;
            config.maxBufferSize = 20 * 1000 * 1000; // 20MB
            config.maxBufferHole = 0.8;
        } else {
            // Lots of streams - minimal buffers
            config.maxBufferLength = 10;
            config.maxMaxBufferLength = 20;
            config.maxBufferSize = 10 * 1000 * 1000; // 10MB
            config.maxBufferHole = 1.0;
        }

        return config;
    }

    /**
     * Create HLS.js instance with robust error handling and recovery
     */
    function createHlsInstance(stream, url) {
        const config = getAdaptiveHlsConfig();
        const hls = new Hls(config);
        const video = stream.video;

        hls.loadSource(url);
        hls.attachMedia(video);

        // Manifest parsed - start playback
        hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
            // Select highest quality level
            if (data.levels && data.levels.length > 0) {
                const maxLevel = data.levels.length - 1;
                hls.currentLevel = maxLevel;
            }
            video.play().catch(() => {});
            // Reset recovery state on successful manifest load
            stream.recovery.retryCount = 0;
            stream.recovery.isRecovering = false;
        });

        // Comprehensive error handling with recovery
        hls.on(Hls.Events.ERROR, (event, data) => {
            handleHlsError(stream, hls, data);
        });

        // Buffer state monitoring
        hls.on(Hls.Events.BUFFER_APPENDED, () => {
            // Buffer got data, reset stall tracking
            stream.health.bufferEmptyStartTime = null;
        });

        hls.on(Hls.Events.BUFFER_EOS, () => {
            // End of stream - normal completion
            stream.state = 'paused';
        });

        // Fragment loading progress - indicates healthy streaming
        hls.on(Hls.Events.FRAG_LOADED, () => {
            // Reset health indicators on successful fragment load
            stream.health.consecutiveStalls = 0;
            if (stream.state === 'recovering') {
                stream.state = 'playing';
                updateStreamInfo(stream);
            }
        });

        return hls;
    }

    /**
     * Handle HLS.js errors with intelligent recovery
     */
    function handleHlsError(stream, hls, data) {
        console.warn(`HLS error [${stream.id}]:`, data.type, data.details, data.fatal ? '(FATAL)' : '');

        // Non-fatal errors - let HLS.js handle internally
        if (!data.fatal) {
            // Track buffer stalls
            if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
                stream.health.consecutiveStalls++;
                if (stream.health.consecutiveStalls > 3) {
                    // Too many stalls - try recovery
                    triggerRecovery(stream, 'excessive_stalls');
                }
            }
            return;
        }

        // Fatal error - need recovery
        stream.state = 'error';

        if (!RECOVERY_CONFIG.enableAutoRecovery) {
            stream.error = `HLS Error: ${data.type}`;
            showStreamError(stream);
            return;
        }

        // Different recovery strategies based on error type
        switch (data.type) {
            case Hls.ErrorTypes.NETWORK_ERROR:
                // Network errors are often transient - aggressive retry
                console.log(`[${stream.id}] Network error - attempting recovery`);
                scheduleRecovery(stream, 'network_error');
                break;

            case Hls.ErrorTypes.MEDIA_ERROR:
                // Media errors might be recoverable
                console.log(`[${stream.id}] Media error - attempting HLS recovery`);
                try {
                    hls.recoverMediaError();
                    stream.state = 'recovering';
                    updateStreamInfo(stream);
                } catch (e) {
                    // If recovery fails, schedule full reload
                    scheduleRecovery(stream, 'media_error');
                }
                break;

            case Hls.ErrorTypes.OTHER_ERROR:
            default:
                // Other errors - try full reload
                console.log(`[${stream.id}] Other error - scheduling reload`);
                scheduleRecovery(stream, 'other_error');
                break;
        }
    }

    /**
     * Schedule recovery with exponential backoff
     */
    function scheduleRecovery(stream, reason) {
        if (stream.recovery.isRecovering) {
            return; // Already recovering
        }

        if (stream.recovery.retryCount >= RECOVERY_CONFIG.maxRetries) {
            console.log(`[${stream.id}] Max retries (${RECOVERY_CONFIG.maxRetries}) reached - giving up`);
            stream.error = `Stream failed after ${RECOVERY_CONFIG.maxRetries} retries (${reason})`;
            stream.state = 'error';
            showStreamError(stream);
            return;
        }

        stream.recovery.isRecovering = true;
        stream.recovery.retryCount++;
        stream.state = 'recovering';
        stream.wrapper.dataset.recovering = 'true';
        updateStreamInfo(stream);

        // Calculate delay with exponential backoff
        const delay = Math.min(
            RECOVERY_CONFIG.baseRetryDelay * Math.pow(2, stream.recovery.retryCount - 1),
            RECOVERY_CONFIG.maxRetryDelay
        );

        console.log(`[${stream.id}] Scheduling recovery in ${delay}ms (attempt ${stream.recovery.retryCount}/${RECOVERY_CONFIG.maxRetries})`);

        // Clear any existing retry timer
        if (stream.recovery.retryTimer) {
            clearTimeout(stream.recovery.retryTimer);
        }

        stream.recovery.retryTimer = setTimeout(() => {
            stream.recovery.lastRetryTime = Date.now();
            performRecovery(stream);
        }, delay);
    }

    /**
     * Perform actual stream recovery
     */
    function performRecovery(stream) {
        console.log(`[${stream.id}] Performing recovery attempt ${stream.recovery.retryCount}`);

        // Remove any existing error overlay
        const errorOverlay = stream.wrapper.querySelector('.plexd-error-overlay');
        if (errorOverlay) {
            errorOverlay.remove();
        }

        // Reset error state
        stream.error = null;

        // Destroy existing HLS instance
        if (stream.hls) {
            stream.hls.destroy();
            stream.hls = null;
        }

        // Reset video element
        const video = stream.video;
        video.src = '';
        video.load();

        // Small delay before reload
        setTimeout(() => {
            if (isHlsUrl(stream.url) && typeof Hls !== 'undefined' && Hls.isSupported()) {
                // Create fresh HLS instance
                const hls = createHlsInstance(stream, stream.url);
                stream.hls = hls;
            } else if (isHlsUrl(stream.url) && video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = stream.url;
                video.play().catch(() => {});
            } else {
                video.src = stream.url;
                video.load();
                video.play().catch(() => {});
            }

            stream.recovery.isRecovering = false;
            stream.state = 'loading';
            delete stream.wrapper.dataset.recovering;
            updateStreamInfo(stream);
        }, 100);
    }

    /**
     * Trigger recovery from health check failures
     */
    function triggerRecovery(stream, reason) {
        if (!RECOVERY_CONFIG.enableAutoRecovery || stream.recovery.isRecovering) {
            return;
        }
        scheduleRecovery(stream, reason);
    }

    /**
     * Show error overlay on stream
     */
    function showStreamError(stream) {
        // Remove any existing error overlay first
        const existing = stream.wrapper.querySelector('.plexd-error-overlay');
        if (existing) {
            existing.remove();
        }

        const errorOverlay = document.createElement('div');
        errorOverlay.className = 'plexd-error-overlay';
        errorOverlay.innerHTML = `
            <div class="plexd-error-content">
                <div class="plexd-error-msg">⚠️ ${stream.error || 'Stream error'}</div>
                <div class="plexd-error-actions">
                    <button class="plexd-error-retry" title="Retry">↻ Retry</button>
                    <button class="plexd-error-close" title="Remove stream">✕ Close</button>
                </div>
            </div>
        `;
        errorOverlay.querySelector('.plexd-error-retry').onclick = (e) => {
            e.stopPropagation();
            // Reset retry count for manual retry
            stream.recovery.retryCount = 0;
            performRecovery(stream);
        };
        errorOverlay.querySelector('.plexd-error-close').onclick = (e) => {
            e.stopPropagation();
            removeStream(stream.id);
        };
        stream.wrapper.appendChild(errorOverlay);
        updateStreamInfo(stream);
    }

    /**
     * Create controls overlay for a stream
     */
    function createControlsOverlay(streamId) {
        const controls = document.createElement('div');
        controls.className = 'plexd-controls';

        // Seek bar container
        const seekContainer = document.createElement('div');
        seekContainer.className = 'plexd-seek-container';

        const seekBar = document.createElement('input');
        seekBar.type = 'range';
        seekBar.className = 'plexd-seek-bar';
        seekBar.min = '0';
        seekBar.max = '100';
        seekBar.value = '0';
        seekBar.title = 'Seek';

        const timeDisplay = document.createElement('span');
        timeDisplay.className = 'plexd-time-display';
        timeDisplay.textContent = '0:00 / 0:00';

        seekContainer.appendChild(seekBar);
        seekContainer.appendChild(timeDisplay);

        // Button row
        const buttonRow = document.createElement('div');
        buttonRow.className = 'plexd-btn-row';

        // Skip backward button
        const skipBackBtn = document.createElement('button');
        skipBackBtn.className = 'plexd-btn plexd-skip-btn';
        skipBackBtn.innerHTML = '⏪';
        skipBackBtn.title = 'Skip back 10s';
        skipBackBtn.onclick = (e) => {
            e.stopPropagation();
            seekRelative(streamId, -10);
        };

        // Mute/unmute button
        const muteBtn = document.createElement('button');
        muteBtn.className = 'plexd-btn plexd-mute-btn';
        muteBtn.innerHTML = '&#128263;'; // Speaker icon
        muteBtn.title = 'Toggle audio (audio focus: unmute one mutes others)';
        muteBtn.onclick = (e) => {
            e.stopPropagation();
            toggleMute(streamId);
        };

        // Skip forward button
        const skipFwdBtn = document.createElement('button');
        skipFwdBtn.className = 'plexd-btn plexd-skip-btn';
        skipFwdBtn.innerHTML = '⏩';
        skipFwdBtn.title = 'Skip forward 10s';
        skipFwdBtn.onclick = (e) => {
            e.stopPropagation();
            seekRelative(streamId, 10);
        };

        // PiP button
        const pipBtn = document.createElement('button');
        pipBtn.className = 'plexd-btn plexd-pip-btn';
        pipBtn.innerHTML = '&#x1F5D7;'; // Window icon
        pipBtn.title = 'Picture-in-Picture';
        pipBtn.onclick = (e) => {
            e.stopPropagation();
            togglePiP(streamId);
        };

        // Pop-out button (new window)
        const popoutBtn = document.createElement('button');
        popoutBtn.className = 'plexd-btn plexd-popout-btn';
        popoutBtn.innerHTML = '&#x2197;'; // Arrow pointing out
        popoutBtn.title = 'Open in new window';
        popoutBtn.onclick = (e) => {
            e.stopPropagation();
            popoutStream(streamId);
        };

        // Fullscreen button (click = browser-fill, double-click = true fullscreen)
        const fullscreenBtn = document.createElement('button');
        fullscreenBtn.className = 'plexd-btn plexd-fullscreen-btn';
        fullscreenBtn.innerHTML = '&#x26F6;'; // Fullscreen icon
        fullscreenBtn.title = 'Click: fill window | Double-click: true fullscreen';
        fullscreenBtn.onclick = (e) => {
            e.stopPropagation();
            toggleFullscreen(streamId);
        };
        fullscreenBtn.ondblclick = (e) => {
            e.stopPropagation();
            toggleTrueFullscreen(streamId);
        };

        // Rating button (cycles through 0-5 stars)
        const ratingBtn = document.createElement('button');
        ratingBtn.className = 'plexd-btn plexd-rating-btn';
        ratingBtn.innerHTML = '☆';
        ratingBtn.title = 'Rate stream (G to cycle 1-5, or click)';
        ratingBtn.onclick = (e) => {
            e.stopPropagation();
            cycleRating(streamId);
        };

        // Info toggle button
        const infoBtn = document.createElement('button');
        infoBtn.className = 'plexd-btn plexd-info-btn';
        infoBtn.innerHTML = 'ⓘ';
        infoBtn.title = 'Toggle stream info';
        infoBtn.onclick = (e) => {
            e.stopPropagation();
            toggleStreamInfo(streamId);
        };

        // Copy URL button
        const copyBtn = document.createElement('button');
        copyBtn.className = 'plexd-btn plexd-copy-btn';
        copyBtn.innerHTML = '📋';
        copyBtn.title = 'Copy stream URL';
        copyBtn.onclick = (e) => {
            e.stopPropagation();
            copyStreamUrl(streamId);
        };

        // Reload button
        const reloadBtn = document.createElement('button');
        reloadBtn.className = 'plexd-btn plexd-reload-btn';
        reloadBtn.innerHTML = '↻';
        reloadBtn.title = 'Reload stream';
        reloadBtn.onclick = (e) => {
            e.stopPropagation();
            reloadStream(streamId);
        };

        // Remove button
        const removeBtn = document.createElement('button');
        removeBtn.className = 'plexd-btn plexd-remove-btn';
        removeBtn.innerHTML = '&times;';
        removeBtn.title = 'Remove stream';
        removeBtn.onclick = (e) => {
            e.stopPropagation();
            removeStream(streamId);
        };

        buttonRow.appendChild(skipBackBtn);
        buttonRow.appendChild(muteBtn);
        buttonRow.appendChild(skipFwdBtn);
        buttonRow.appendChild(ratingBtn);
        buttonRow.appendChild(pipBtn);
        buttonRow.appendChild(popoutBtn);
        buttonRow.appendChild(fullscreenBtn);
        buttonRow.appendChild(infoBtn);
        buttonRow.appendChild(copyBtn);
        buttonRow.appendChild(reloadBtn);
        buttonRow.appendChild(removeBtn);

        controls.appendChild(seekContainer);
        controls.appendChild(buttonRow);

        return controls;
    }

    /**
     * Seek relative to current position
     */
    function seekRelative(streamId, seconds) {
        const stream = streams.get(streamId);
        if (!stream) return;

        const video = stream.video;
        if (video.duration && isFinite(video.duration)) {
            video.currentTime = Math.max(0, Math.min(video.duration, video.currentTime + seconds));
        }
    }

    /**
     * Seek to absolute position (0-1)
     */
    function seekTo(streamId, position) {
        const stream = streams.get(streamId);
        if (!stream) return;

        const video = stream.video;
        if (video.duration && isFinite(video.duration)) {
            video.currentTime = video.duration * position;
        }
    }

    /**
     * Format time in seconds to M:SS or H:MM:SS
     */
    function formatTime(seconds) {
        if (!isFinite(seconds) || seconds < 0) return '0:00';

        const h = Math.floor(seconds / 3600);
        const m = Math.floor((seconds % 3600) / 60);
        const s = Math.floor(seconds % 60);

        if (h > 0) {
            return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
        }
        return `${m}:${s.toString().padStart(2, '0')}`;
    }

    /**
     * Create info overlay for a stream
     */
    function createInfoOverlay(url) {
        const overlay = document.createElement('div');
        overlay.className = 'plexd-info-overlay';
        overlay.style.display = 'none';

        const urlDisplay = url.length > 60 ? url.substring(0, 57) + '...' : url;
        overlay.innerHTML = `
            <div class="plexd-info-url">${escapeHtml(urlDisplay)}</div>
            <div class="plexd-info-stats">
                <span class="plexd-info-resolution">Loading...</span>
                <span class="plexd-info-state">⏳</span>
            </div>
        `;
        return overlay;
    }

    /**
     * Escape HTML for safe display
     */
    function escapeHtml(text) {
        const div = document.createElement('div');
        div.textContent = text;
        return div.innerHTML;
    }

    /**
     * Toggle PiP for a stream
     */
    async function togglePiP(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return;

        try {
            if (document.pictureInPictureElement === stream.video) {
                await document.exitPictureInPicture();
            } else if (document.pictureInPictureEnabled) {
                await stream.video.requestPictureInPicture();
            }
        } catch (err) {
            console.log('PiP error:', err);
        }
    }

    // Track pop-out windows for intelligent placement
    let popoutWindows = [];
    let popoutCounter = 0;

    /**
     * Pop out stream to new window with intelligent placement
     */
    function popoutStream(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return;

        const url = stream.url;
        const currentTime = stream.video.currentTime || 0;

        // Clean up closed windows from tracking
        popoutWindows = popoutWindows.filter(w => w && !w.closed);

        // Calculate intelligent placement
        const screenW = window.screen.availWidth;
        const screenH = window.screen.availHeight;
        const windowW = 640;
        const windowH = 360;
        const padding = 10;

        // Calculate how many windows fit in a row/column
        const cols = Math.floor(screenW / (windowW + padding));
        const rows = Math.floor(screenH / (windowH + padding));
        const maxWindows = cols * rows;

        // Position based on count (tile pattern)
        const index = popoutCounter % maxWindows;
        const col = index % cols;
        const row = Math.floor(index / cols);

        const left = col * (windowW + padding) + padding;
        const top = row * (windowH + padding) + padding;

        popoutCounter++;

        // Create minimal HTML for the popup
        const popupHtml = `
<!DOCTYPE html>
<html>
<head>
    <title>Plexd - Stream ${popoutCounter}</title>
    <style>
        * { margin: 0; padding: 0; box-sizing: border-box; }
        html, body { width: 100%; height: 100%; background: #000; overflow: hidden; }
        video { width: 100%; height: 100%; object-fit: contain; }
    </style>
</head>
<body>
    <video id="video" autoplay controls></video>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <script>
        const video = document.getElementById('video');
        const url = ${JSON.stringify(url)};
        const startTime = ${currentTime};

        if (url.includes('.m3u8') && Hls.isSupported()) {
            const hls = new Hls({ capLevelToPlayerSize: false });
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, (e, data) => {
                if (data.levels && data.levels.length > 0) {
                    hls.currentLevel = data.levels.length - 1;
                }
                video.currentTime = startTime;
                video.play();
            });
        } else {
            video.src = url;
            video.addEventListener('loadedmetadata', () => {
                video.currentTime = startTime;
            });
        }
    </script>
</body>
</html>`;

        // Open popup window with calculated position
        const popup = window.open('', '_blank',
            `width=${windowW},height=${windowH},left=${left},top=${top},resizable=yes`);

        if (popup) {
            popup.document.write(popupHtml);
            popup.document.close();
            popoutWindows.push(popup);
        }
    }

    /**
     * Pop out all streams to individual windows (tiled)
     */
    function popoutAllStreams() {
        popoutCounter = 0; // Reset counter for clean tiling
        popoutWindows.forEach(w => { if (w && !w.closed) w.close(); });
        popoutWindows = [];

        streams.forEach((stream) => {
            popoutStream(stream.id);
        });
    }

    /**
     * Toggle stream info overlay for a single stream
     */
    function toggleStreamInfo(streamId) {
        const stream = streams.get(streamId);
        if (!stream || !stream.infoOverlay) return;

        const isVisible = stream.infoOverlay.style.display !== 'none';
        stream.infoOverlay.style.display = isVisible ? 'none' : 'flex';
    }

    /**
     * Toggle all stream info overlays
     */
    function toggleAllStreamInfo() {
        showInfoOverlay = !showInfoOverlay;
        streams.forEach(stream => {
            if (stream.infoOverlay) {
                stream.infoOverlay.style.display = showInfoOverlay ? 'flex' : 'none';
            }
        });
        return showInfoOverlay;
    }

    // Clean mode state (hide all per-stream controls)
    let cleanMode = false;

    /**
     * Toggle clean mode (hide all per-stream overlays for distraction-free viewing)
     */
    function toggleCleanMode() {
        cleanMode = !cleanMode;
        const app = document.querySelector('.plexd-app');
        if (cleanMode) {
            app.classList.add('clean-mode');
        } else {
            app.classList.remove('clean-mode');
        }
        return cleanMode;
    }

    /**
     * Get clean mode state
     */
    function isCleanMode() {
        return cleanMode;
    }

    /**
     * Update stream info overlay with current stats
     */
    function updateStreamInfo(stream) {
        if (!stream.infoOverlay) return;

        const resEl = stream.infoOverlay.querySelector('.plexd-info-resolution');
        const stateEl = stream.infoOverlay.querySelector('.plexd-info-state');

        if (resEl && stream.video.videoWidth) {
            resEl.textContent = `${stream.video.videoWidth}×${stream.video.videoHeight}`;
        }

        if (stateEl) {
            const stateIcons = {
                loading: '⏳',
                buffering: '⏳',
                recovering: '🔄',
                playing: '▶️',
                paused: '⏸️',
                error: '❌'
            };
            stateEl.textContent = stateIcons[stream.state] || '❓';
        }
    }

    // Track which stream is fullscreen
    let fullscreenStreamId = null;

    // Track fullscreen modes:
    // - 'none': normal windowed mode
    // - 'browser-fill': CSS fullscreen (fills viewport, browser chrome visible)
    // - 'true-grid': True fullscreen on app container (grid view)
    // - 'true-focused': True fullscreen on a specific stream
    let fullscreenMode = 'none';

    /**
     * Toggle fullscreen for a stream (browser-fill mode)
     * In true fullscreen, this focuses/unfocuses a stream without exiting true fullscreen
     */
    function toggleFullscreen(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return;

        // If we're in true-grid fullscreen, focus this stream (enter true-focused mode)
        if (fullscreenMode === 'true-grid') {
            enterFocusedMode(streamId);
            return;
        }

        if (fullscreenStreamId === streamId) {
            // Exit fullscreen
            stream.wrapper.classList.remove('plexd-fullscreen');
            fullscreenStreamId = null;
            fullscreenMode = 'none';
            // Also exit true fullscreen if active
            if (document.fullscreenElement) {
                document.exitFullscreen();
            }
        } else {
            // Exit any existing fullscreen first
            if (fullscreenStreamId) {
                const prevStream = streams.get(fullscreenStreamId);
                if (prevStream) {
                    prevStream.wrapper.classList.remove('plexd-fullscreen');
                }
            }
            // Enter fullscreen
            stream.wrapper.classList.add('plexd-fullscreen');
            fullscreenStreamId = streamId;
            fullscreenMode = 'browser-fill';
        }
        triggerLayoutUpdate();
    }

    /**
     * Enter focused mode on a stream (used from grid mode in true fullscreen)
     */
    function enterFocusedMode(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return;

        // Blur any focused input to enable keyboard shortcuts
        if (document.activeElement && document.activeElement.tagName === 'INPUT') {
            document.activeElement.blur();
        }

        // Exit any existing browser-fill fullscreen
        if (fullscreenStreamId && fullscreenStreamId !== streamId) {
            const prevStream = streams.get(fullscreenStreamId);
            if (prevStream) {
                prevStream.wrapper.classList.remove('plexd-fullscreen');
            }
        }

        // Apply CSS fullscreen to this stream
        stream.wrapper.classList.add('plexd-fullscreen');
        fullscreenStreamId = streamId;

        // If we're in true fullscreen grid mode, switch to focused mode
        if (document.fullscreenElement) {
            fullscreenMode = 'true-focused';
        } else {
            fullscreenMode = 'browser-fill';
        }
        // Focus wrapper for keyboard events (Z/Enter to exit, etc.)
        stream.wrapper.focus();

        // Select this stream
        selectStream(streamId);
        triggerLayoutUpdate();
    }

    /**
     * Exit focused mode back to grid view (stays in true fullscreen if applicable)
     */
    function exitFocusedMode() {
        if (fullscreenStreamId) {
            const stream = streams.get(fullscreenStreamId);
            if (stream) {
                stream.wrapper.classList.remove('plexd-fullscreen');
                // Blur wrapper so focus returns to document for keyboard handling
                stream.wrapper.blur();
            }
            fullscreenStreamId = null;
        }

        // If we were in true-focused mode, return to true-grid mode
        if (fullscreenMode === 'true-focused' && document.fullscreenElement) {
            fullscreenMode = 'true-grid';
            // Focus container for keyboard events
            const container = document.querySelector('.plexd-app');
            if (container) container.focus();
        } else {
            fullscreenMode = 'none';
        }

        triggerLayoutUpdate();
    }

    /**
     * Toggle true fullscreen (hides browser chrome)
     * If no stream specified, enters grid fullscreen mode
     */
    function toggleTrueFullscreen(streamId) {
        if (document.fullscreenElement) {
            // Exit true fullscreen completely
            exitTrueFullscreen();
        } else if (streamId) {
            // Enter true fullscreen focused on a specific stream
            const stream = streams.get(streamId);
            if (!stream) return;

            // First ensure browser-fill mode is active
            if (fullscreenStreamId !== streamId) {
                if (fullscreenStreamId) {
                    const prevStream = streams.get(fullscreenStreamId);
                    if (prevStream) {
                        prevStream.wrapper.classList.remove('plexd-fullscreen');
                    }
                }
                stream.wrapper.classList.add('plexd-fullscreen');
                fullscreenStreamId = streamId;
            }

            // Request true fullscreen on the stream
            stream.wrapper.requestFullscreen().then(() => {
                fullscreenMode = 'true-focused';
                stream.wrapper.focus();
            }).catch(err => {
                console.log('Fullscreen request failed:', err);
            });
        } else {
            // Enter grid fullscreen (fullscreen on app container)
            enterGridFullscreen();
        }
    }

    /**
     * Enter true fullscreen in grid mode (shows all streams)
     */
    function enterGridFullscreen() {
        const container = document.querySelector('.plexd-app');
        if (!container) return;

        // Blur any focused input to enable keyboard shortcuts
        if (document.activeElement && document.activeElement.tagName === 'INPUT') {
            document.activeElement.blur();
        }

        // Exit any focused stream first
        if (fullscreenStreamId) {
            const stream = streams.get(fullscreenStreamId);
            if (stream) {
                stream.wrapper.classList.remove('plexd-fullscreen');
            }
            fullscreenStreamId = null;
        }

        container.requestFullscreen().then(() => {
            fullscreenMode = 'true-grid';
            // Focus container for keyboard events
            container.focus();
            triggerLayoutUpdate();
        }).catch(err => {
            console.log('Grid fullscreen request failed:', err);
        });
    }

    /**
     * Exit true fullscreen completely
     */
    function exitTrueFullscreen() {
        if (!document.fullscreenElement) return;

        document.exitFullscreen().then(() => {
            // Also exit browser-fill mode
            if (fullscreenStreamId) {
                const stream = streams.get(fullscreenStreamId);
                if (stream) {
                    stream.wrapper.classList.remove('plexd-fullscreen');
                }
                fullscreenStreamId = null;
            }
            fullscreenMode = 'none';
            triggerLayoutUpdate();
        }).catch(() => {
            // Fallback
            if (fullscreenStreamId) {
                const stream = streams.get(fullscreenStreamId);
                if (stream) {
                    stream.wrapper.classList.remove('plexd-fullscreen');
                }
                fullscreenStreamId = null;
            }
            fullscreenMode = 'none';
            triggerLayoutUpdate();
        });
    }

    /**
     * Get the current fullscreen mode
     */
    function getFullscreenMode() {
        return fullscreenMode;
    }

    /**
     * Check if any stream is fullscreen
     */
    function isAnyFullscreen() {
        return fullscreenStreamId !== null || document.fullscreenElement !== null;
    }

    /**
     * Get fullscreen stream if any (checks both CSS fullscreen and true fullscreen)
     */
    function getFullscreenStream() {
        // First check our tracked fullscreen
        if (fullscreenStreamId) {
            return streams.get(fullscreenStreamId);
        }
        // Also check true browser fullscreen element
        if (document.fullscreenElement) {
            const streamId = document.fullscreenElement.dataset?.streamId || document.fullscreenElement.id;
            if (streamId && streams.has(streamId)) {
                return streams.get(streamId);
            }
        }
        return null;
    }

    /**
     * Switch to next/prev stream while in fullscreen
     */
    function switchFullscreenStream(direction) {
        if (!fullscreenStreamId) return;

        const streamList = Array.from(streams.values());
        if (streamList.length <= 1) return;

        const currentIndex = streamList.findIndex(s => s.id === fullscreenStreamId);
        if (currentIndex === -1) return;

        let newIndex;
        if (direction === 'next') {
            newIndex = (currentIndex + 1) % streamList.length;
        } else {
            newIndex = (currentIndex - 1 + streamList.length) % streamList.length;
        }

        const currentStream = streamList[currentIndex];
        const newStream = streamList[newIndex];

        // Switch fullscreen to new stream
        currentStream.wrapper.classList.remove('plexd-fullscreen');
        newStream.wrapper.classList.add('plexd-fullscreen');
        fullscreenStreamId = newStream.id;

        // Focus the new stream for keyboard controls
        newStream.wrapper.focus();
    }

    /**
     * Set up video element event listeners
     */
    function setupVideoEvents(stream) {
        const { video, wrapper, controls } = stream;

        // Seek bar and time display
        const seekBar = controls.querySelector('.plexd-seek-bar');
        const timeDisplay = controls.querySelector('.plexd-time-display');

        if (seekBar) {
            seekBar.addEventListener('input', (e) => {
                e.stopPropagation();
                const position = parseFloat(e.target.value) / 100;
                seekTo(stream.id, position);
            });

            seekBar.addEventListener('click', (e) => e.stopPropagation());
            seekBar.addEventListener('mousedown', (e) => e.stopPropagation());
        }

        // Update seek bar and time display during playback
        video.addEventListener('timeupdate', () => {
            if (seekBar && video.duration && isFinite(video.duration)) {
                const progress = (video.currentTime / video.duration) * 100;
                seekBar.value = progress;
            }
            if (timeDisplay && video.duration && isFinite(video.duration)) {
                timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
            }
            // Track health - video is making progress
            if (video.currentTime !== stream.health.lastCurrentTime) {
                stream.health.lastTimeUpdate = Date.now();
                stream.health.lastCurrentTime = video.currentTime;
                stream.health.stallStartTime = null;
            }
        });

        // Click to select stream and focus for keyboard events
        wrapper.addEventListener('click', () => {
            selectStream(stream.id);
            wrapper.focus();
        });

        // Double-click to toggle fullscreen
        wrapper.addEventListener('dblclick', () => {
            toggleFullscreen(stream.id);
        });

        // Keyboard handling on wrapper (for fullscreen mode only)
        // Note: Arrow keys and most keys are handled by app.js
        // This handler only catches keys when actually in a fullscreen mode
        wrapper.addEventListener('keydown', (e) => {
            // Only handle when in true fullscreen or browser-fill mode
            const inTrueFullscreen = document.fullscreenElement === wrapper;
            const inBrowserFill = wrapper.classList.contains('plexd-fullscreen');
            if (!inTrueFullscreen && !inBrowserFill) {
                return;
            }

            switch (e.key) {
                case ' ':
                    e.preventDefault();
                    e.stopPropagation();
                    if (video.paused) {
                        video.play().catch(() => {});
                    } else {
                        video.pause();
                    }
                    break;
                case 'ArrowLeft':
                case 'ArrowRight':
                case 'ArrowUp':
                case 'ArrowDown':
                    // Prevent default video seeking behavior
                    // Let the event bubble to app.js handleKeyboard for stream switching
                    e.preventDefault();
                    break;
                case 'Enter':
                    // Prevent any default behavior, let app.js handle focus mode
                    e.preventDefault();
                    break;
                case 'z':
                case 'Z':
                case 'Enter':
                    // Z/Enter in focused mode: exit focus mode (toggle behavior)
                    e.preventDefault();
                    e.stopPropagation(); // Prevent app.js from re-entering focused mode
                    exitFocusedMode();
                    break;
                case 'Escape':
                    e.preventDefault();
                    e.stopPropagation();
                    // Escape only handles true fullscreen modes
                    if (fullscreenMode === 'true-focused') {
                        // Return to grid view (stay in true fullscreen)
                        exitFocusedMode();
                    }
                    // In browser-fill mode: do nothing (use Z/Enter to exit)
                    break;
                case 'f':
                case 'F':
                    e.preventDefault();
                    e.stopPropagation();
                    toggleTrueFullscreen(stream.id);
                    break;
                case 'm':
                case 'M':
                    e.preventDefault();
                    e.stopPropagation();
                    toggleMute(stream.id);
                    break;
            }
        });

        // Swipe gesture handling for fullscreen stream switching
        let touchStartX = 0;
        let touchStartY = 0;
        let touchStartTime = 0;

        wrapper.addEventListener('touchstart', (e) => {
            touchStartX = e.touches[0].clientX;
            touchStartY = e.touches[0].clientY;
            touchStartTime = Date.now();
        }, { passive: true });

        wrapper.addEventListener('touchend', (e) => {
            // Only handle swipes in fullscreen mode
            if (!wrapper.classList.contains('plexd-fullscreen')) return;

            const touchEndX = e.changedTouches[0].clientX;
            const touchEndY = e.changedTouches[0].clientY;
            const deltaX = touchEndX - touchStartX;
            const deltaY = touchEndY - touchStartY;
            const deltaTime = Date.now() - touchStartTime;

            // Require: horizontal swipe > 50px, faster than 300ms, more horizontal than vertical
            if (Math.abs(deltaX) > 50 && deltaTime < 300 && Math.abs(deltaX) > Math.abs(deltaY)) {
                if (deltaX > 0) {
                    // Swipe right = previous stream
                    switchFullscreenStream('prev');
                } else {
                    // Swipe left = next stream
                    switchFullscreenStream('next');
                }
            }
        }, { passive: true });

        // Drag and drop handlers
        wrapper.addEventListener('dragstart', (e) => {
            e.dataTransfer.setData('text/plain', stream.id);
            e.dataTransfer.effectAllowed = 'move';
            wrapper.classList.add('plexd-dragging');
        });

        wrapper.addEventListener('dragend', () => {
            wrapper.classList.remove('plexd-dragging');
        });

        wrapper.addEventListener('dragover', (e) => {
            e.preventDefault();
            e.dataTransfer.dropEffect = 'move';
            wrapper.classList.add('plexd-drag-over');
        });

        wrapper.addEventListener('dragleave', () => {
            wrapper.classList.remove('plexd-drag-over');
        });

        wrapper.addEventListener('drop', (e) => {
            e.preventDefault();
            wrapper.classList.remove('plexd-drag-over');
            const draggedId = e.dataTransfer.getData('text/plain');
            if (draggedId && draggedId !== stream.id) {
                reorderStreams(draggedId, stream.id);
            }
        });

        // Get aspect ratio when metadata loads
        video.addEventListener('loadedmetadata', () => {
            if (video.videoWidth && video.videoHeight) {
                stream.aspectRatio = video.videoWidth / video.videoHeight;
            }
            stream.state = 'playing';
            updateStreamInfo(stream);
            triggerLayoutUpdate();
        });

        // Handle play/pause
        video.addEventListener('play', () => {
            stream.state = 'playing';
            updateStreamInfo(stream);
        });

        video.addEventListener('pause', () => {
            stream.state = 'paused';
            updateStreamInfo(stream);
        });

        // Handle errors
        video.addEventListener('error', (e) => {
            stream.state = 'error';
            stream.error = getVideoError(video.error);
            console.error(`Stream ${stream.id} error:`, stream.error, 'URL:', stream.url);

            // For non-HLS streams, try automatic recovery
            if (!stream.hls && RECOVERY_CONFIG.enableAutoRecovery) {
                scheduleRecovery(stream, stream.error);
            } else if (!stream.hls) {
                showStreamError(stream);
            }
            // HLS errors are handled by handleHlsError
        });

        // Handle stalled/waiting
        video.addEventListener('waiting', () => {
            stream.state = 'buffering';
            // Track when stall started for health monitoring
            if (!stream.health.stallStartTime) {
                stream.health.stallStartTime = Date.now();
            }
            updateStreamInfo(stream);
        });

        video.addEventListener('playing', () => {
            stream.state = 'playing';
            // Reset health indicators on playback resumption
            stream.health.stallStartTime = null;
            stream.health.consecutiveStalls = 0;
            stream.recovery.retryCount = 0;
            stream.recovery.isRecovering = false;
            delete stream.wrapper.dataset.recovering;
            updateStreamInfo(stream);
        });

        // Stalled event - network issues
        video.addEventListener('stalled', () => {
            console.log(`[${stream.id}] Network stalled - waiting for data`);
            if (!stream.health.stallStartTime) {
                stream.health.stallStartTime = Date.now();
            }
        });
    }

    /**
     * Reorder streams by moving one before another
     */
    function reorderStreams(draggedId, targetId) {
        const streamArray = Array.from(streams.entries());
        const draggedIndex = streamArray.findIndex(([id]) => id === draggedId);
        const targetIndex = streamArray.findIndex(([id]) => id === targetId);

        if (draggedIndex === -1 || targetIndex === -1) return;

        // Remove dragged item
        const [draggedEntry] = streamArray.splice(draggedIndex, 1);

        // Insert at target position
        streamArray.splice(targetIndex, 0, draggedEntry);

        // Rebuild the map in new order
        streams.clear();
        streamArray.forEach(([id, stream]) => streams.set(id, stream));

        // Trigger layout update
        triggerLayoutUpdate();
    }

    /**
     * Get human-readable error message
     */
    function getVideoError(error) {
        if (!error) return 'Unknown error';

        switch (error.code) {
            case MediaError.MEDIA_ERR_ABORTED:
                return 'Playback aborted';
            case MediaError.MEDIA_ERR_NETWORK:
                return 'Network error';
            case MediaError.MEDIA_ERR_DECODE:
                return 'Decode error';
            case MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED:
                return 'Format not supported';
            default:
                return 'Unknown error';
        }
    }

    /**
     * Remove a stream
     */
    function removeStream(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return false;

        // Clean up recovery timer if pending
        if (stream.recovery.retryTimer) {
            clearTimeout(stream.recovery.retryTimer);
            stream.recovery.retryTimer = null;
        }

        // Clean up HLS instance if present
        if (stream.hls) {
            stream.hls.destroy();
            stream.hls = null;
        }

        // Clean up video
        stream.video.pause();
        stream.video.src = '';
        stream.video.load();

        // Remove from DOM
        if (stream.wrapper.parentNode) {
            stream.wrapper.parentNode.removeChild(stream.wrapper);
        }

        // Unregister
        streams.delete(streamId);

        triggerLayoutUpdate();
        return true;
    }

    /**
     * Reload a stream (handles errors, stalled, paused - gets it playing again)
     */
    function reloadStream(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return false;

        const url = stream.url;
        const video = stream.video;

        // Remove any error overlay
        const errorOverlay = stream.wrapper.querySelector('.plexd-error-overlay');
        if (errorOverlay) {
            errorOverlay.remove();
        }

        // Reset error state
        stream.error = null;

        // Check if video is just paused (simple case - just play)
        if (video.paused && !video.ended && video.readyState >= 2 && !stream.error) {
            video.play().catch(() => {});
            return true;
        }

        // Check if stalled but has data - try seeking to unstick
        if (video.readyState >= 2 && video.networkState === 2) {
            // Try seeking slightly to unstick
            const currentTime = video.currentTime;
            video.currentTime = currentTime + 0.1;
            video.play().catch(() => {});
            return true;
        }

        // Full reload needed - destroy and recreate
        if (stream.hls) {
            stream.hls.destroy();
            stream.hls = null;
        }

        // Reload the video
        if (isHlsUrl(url) && Hls.isSupported()) {
            const hls = new Hls({
                maxMaxBufferLength: 30,
                startLevel: -1
            });
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                video.play().catch(() => {});
            });
            hls.on(Hls.Events.ERROR, (event, data) => {
                if (data.fatal) {
                    stream.error = `HLS Error: ${data.type}`;
                    updateStreamInfo(stream);
                }
            });
            stream.hls = hls;
        } else {
            video.src = url;
            video.load();
            video.play().catch(() => {});
        }

        return true;
    }

    /**
     * Copy stream URL to clipboard
     */
    function copyStreamUrl(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return false;

        navigator.clipboard.writeText(stream.url).then(() => {
            // Visual feedback - briefly highlight the copy button
            const copyBtn = stream.controls.querySelector('.plexd-copy-btn');
            if (copyBtn) {
                copyBtn.innerHTML = '✓';
                setTimeout(() => {
                    copyBtn.innerHTML = '📋';
                }, 1000);
            }
        }).catch(err => {
            console.warn('Copy failed:', err);
        });

        return true;
    }

    /**
     * Copy all stream URLs to clipboard (newline separated)
     */
    function copyAllStreamUrls() {
        const urls = [];
        streams.forEach(stream => {
            urls.push(stream.url);
        });

        if (urls.length === 0) return false;

        navigator.clipboard.writeText(urls.join('\n')).catch(err => {
            console.warn('Copy all failed:', err);
        });

        return urls.length;
    }

    /**
     * Toggle mute for a stream (with audio focus support)
     */
    function toggleMute(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return;

        const willUnmute = stream.video.muted;

        // Audio focus mode: unmuting one stream mutes all others
        if (willUnmute && audioFocusMode) {
            streams.forEach((s, id) => {
                if (id !== streamId && !s.video.muted) {
                    s.video.muted = true;
                    updateMuteButton(s);
                }
            });
        }

        stream.video.muted = !willUnmute;
        updateMuteButton(stream);
    }

    /**
     * Update mute button icon
     */
    function updateMuteButton(stream) {
        const muteBtn = stream.controls.querySelector('.plexd-mute-btn');
        if (muteBtn) {
            muteBtn.innerHTML = stream.video.muted ? '&#128263;' : '&#128266;';
        }
    }

    /**
     * Toggle audio focus mode
     */
    function toggleAudioFocus() {
        audioFocusMode = !audioFocusMode;
        return audioFocusMode;
    }

    /**
     * Get audio focus mode state
     */
    function getAudioFocusMode() {
        return audioFocusMode;
    }

    /**
     * Select a stream for keyboard navigation
     */
    function selectStream(streamId) {
        // Deselect previous
        if (selectedStreamId) {
            const prevStream = streams.get(selectedStreamId);
            if (prevStream) {
                prevStream.wrapper.classList.remove('plexd-selected');
            }
        }

        // Select new
        selectedStreamId = streamId;
        if (streamId) {
            const stream = streams.get(streamId);
            if (stream) {
                stream.wrapper.classList.add('plexd-selected');
            }
        }
    }

    /**
     * Get selected stream
     */
    function getSelectedStream() {
        return selectedStreamId ? streams.get(selectedStreamId) : null;
    }

    /**
     * Set grid columns for navigation
     */
    function setGridCols(cols) {
        gridCols = cols || 1;
    }

    /**
     * Get grid columns for navigation
     */
    function getGridCols() {
        return gridCols;
    }

    /**
     * Compute grid columns from actual DOM positions of visible streams
     */
    function computeGridCols() {
        // Only use visible streams (not hidden by rating filter)
        const streamList = Array.from(streams.values()).filter(s =>
            s.wrapper.style.display !== 'none'
        );
        if (streamList.length <= 1) return 1;

        // Get Y positions of first few visible streams
        const positions = streamList.slice(0, Math.min(8, streamList.length)).map(s => {
            const rect = s.wrapper.getBoundingClientRect();
            return { y: Math.round(rect.top), x: Math.round(rect.left) };
        });

        // Count how many streams share the same Y as the first one (same row)
        const firstRowY = positions[0].y;
        let cols = 0;
        for (const pos of positions) {
            if (Math.abs(pos.y - firstRowY) < 10) {
                cols++;
            } else {
                break;
            }
        }

        return Math.max(1, cols);
    }

    /**
     * Select next stream in grid order (respects visual grid layout and view mode filter)
     */
    function selectNextStream(direction = 'right') {
        // Respect current view mode filter
        const viewMode = window._plexdViewMode || 'all';
        let streamList;
        if (viewMode === 'all') {
            streamList = Array.from(streams.keys());
        } else {
            // Get only streams with the current rating filter
            const filteredStreams = getStreamsByRating(viewMode);
            streamList = filteredStreams.map(s => s.id);
        }

        const count = streamList.length;
        if (count === 0) return;

        if (!selectedStreamId || !streamList.includes(selectedStreamId)) {
            selectStream(streamList[0]);
            return;
        }

        const currentIndex = streamList.indexOf(selectedStreamId);

        // Compute cols from actual layout
        const cols = computeGridCols();
        const rows = Math.ceil(count / cols);
        const currentRow = Math.floor(currentIndex / cols);
        const currentCol = currentIndex % cols;

        let newRow = currentRow;
        let newCol = currentCol;

        switch (direction) {
            case 'right':
                newCol = currentCol + 1;
                if (newCol >= cols) {
                    newCol = 0;
                    newRow = (currentRow + 1) % rows;
                }
                break;
            case 'left':
                newCol = currentCol - 1;
                if (newCol < 0) {
                    newCol = cols - 1;
                    newRow = (currentRow - 1 + rows) % rows;
                }
                break;
            case 'down':
                newRow = currentRow + 1;
                if (newRow >= rows) newRow = 0;
                break;
            case 'up':
                newRow = currentRow - 1;
                if (newRow < 0) newRow = rows - 1;
                break;
            default:
                return;
        }

        let newIndex = newRow * cols + newCol;

        // Handle edge case: last row may have fewer items
        if (newIndex >= count) {
            if (direction === 'down') {
                newIndex = newCol;
            } else if (direction === 'up') {
                // Go to last item in that column
                const lastRowStart = Math.floor((count - 1) / cols) * cols;
                newIndex = Math.min(lastRowStart + newCol, count - 1);
            } else {
                newIndex = count - 1;
            }
        }

        selectStream(streamList[newIndex]);
    }

    /**
     * Get all active streams
     */
    function getAllStreams() {
        return Array.from(streams.values());
    }

    /**
     * Get stream by ID
     */
    function getStream(streamId) {
        return streams.get(streamId);
    }

    /**
     * Get stream count
     */
    function getStreamCount() {
        return streams.size;
    }

    /**
     * Pause all streams
     */
    function pauseAll() {
        streams.forEach(stream => {
            stream.video.pause();
        });
    }

    /**
     * Play all streams
     */
    function playAll() {
        streams.forEach(stream => {
            stream.video.play().catch(() => {
                // Autoplay may be blocked, that's ok
            });
        });
    }

    /**
     * Mute all streams
     */
    function muteAll() {
        streams.forEach(stream => {
            stream.video.muted = true;
            const muteBtn = stream.controls.querySelector('.plexd-mute-btn');
            if (muteBtn) muteBtn.innerHTML = '&#128263;';
        });
    }

    // Global pause state
    let globalPaused = false;

    /**
     * Toggle pause/play all streams
     */
    function togglePauseAll() {
        globalPaused = !globalPaused;
        if (globalPaused) {
            pauseAll();
        } else {
            playAll();
        }
        return globalPaused;
    }

    /**
     * Check if globally paused
     */
    function isGloballyPaused() {
        return globalPaused;
    }

    // Global mute state
    let globalMuted = false;

    /**
     * Toggle mute all streams
     */
    function toggleMuteAll() {
        globalMuted = !globalMuted;
        streams.forEach(stream => {
            stream.video.muted = globalMuted;
            const muteBtn = stream.controls.querySelector('.plexd-mute-btn');
            if (muteBtn) muteBtn.innerHTML = globalMuted ? '&#128263;' : '&#128266;';
        });
        return globalMuted;
    }

    /**
     * Request fullscreen for the entire app container
     */
    function toggleGlobalFullscreen() {
        const container = document.querySelector('.plexd-app');
        if (!document.fullscreenElement) {
            container.requestFullscreen().catch(err => {
                console.warn('Fullscreen not supported:', err);
            });
            return true;
        } else {
            document.exitFullscreen();
            return false;
        }
    }

    /**
     * Get video elements map for layout engine
     */
    function getVideoElements() {
        const elements = new Map();
        streams.forEach((stream, id) => {
            elements.set(id, stream.wrapper);
        });
        return elements;
    }

    /**
     * Trigger layout update callback
     * Set by app.js
     */
    let layoutUpdateCallback = null;
    function setLayoutUpdateCallback(callback) {
        layoutUpdateCallback = callback;
    }

    function triggerLayoutUpdate() {
        if (layoutUpdateCallback) {
            layoutUpdateCallback();
        }
    }

    /**
     * Cycle rating for a stream (1 -> 2 -> 3 -> 4 -> 5 -> 0 -> 1...)
     */
    function cycleRating(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return 0;

        const currentRating = ratings.get(stream.url) || 0;
        const newRating = (currentRating + 1) % 6; // 0, 1, 2, 3, 4, 5, 0...

        setRating(streamId, newRating);
        return newRating;
    }

    /**
     * Set rating for a stream (0-5)
     */
    function setRating(streamId, rating) {
        const stream = streams.get(streamId);
        if (!stream) return;

        // Clamp rating 0-5
        rating = Math.max(0, Math.min(5, rating));

        if (rating === 0) {
            ratings.delete(stream.url);
        } else {
            ratings.set(stream.url, rating);
        }

        // Update wrapper classes for all rating levels
        for (let i = 1; i <= 5; i++) {
            stream.wrapper.classList.toggle(`plexd-rated-${i}`, rating === i);
        }
        stream.wrapper.classList.toggle('plexd-rated', rating > 0);

        // Update rating button and indicator
        updateRatingDisplay(stream);

        // Persist ratings
        saveRatings();

        // Notify callback
        if (ratingsUpdateCallback) {
            ratingsUpdateCallback();
        }
    }

    /**
     * Clear rating for a stream
     */
    function clearRating(streamId) {
        setRating(streamId, 0);
    }

    /**
     * Update rating button and indicator appearance
     */
    function updateRatingDisplay(stream) {
        const rating = ratings.get(stream.url) || 0;

        // Update button - show ★N format to keep it compact
        const ratingBtn = stream.controls.querySelector('.plexd-rating-btn');
        if (ratingBtn) {
            if (rating === 0) {
                ratingBtn.innerHTML = '☆';
                ratingBtn.className = 'plexd-btn plexd-rating-btn';
            } else {
                ratingBtn.innerHTML = `★${rating}`;
                ratingBtn.className = `plexd-btn plexd-rating-btn rated rated-${rating}`;
            }
        }

        // Update indicator - always show on touch, tappable to rate
        const indicator = stream.wrapper.querySelector('.plexd-rating-indicator');
        if (indicator) {
            if (rating === 0) {
                indicator.innerHTML = '☆';
                indicator.className = 'plexd-rating-indicator';
            } else {
                indicator.innerHTML = `★${rating}`;
                indicator.className = `plexd-rating-indicator rated rated-${rating}`;
            }
        }
    }

    /**
     * Get rating for a stream URL
     */
    function getRating(url) {
        return ratings.get(url) || 0;
    }

    /**
     * Get streams with a specific rating
     */
    function getStreamsByRating(rating) {
        return Array.from(streams.values()).filter(s => (ratings.get(s.url) || 0) === rating);
    }

    /**
     * Get streams with any rating (rated streams)
     */
    function getRatedStreams() {
        return Array.from(streams.values()).filter(s => ratings.has(s.url));
    }

    /**
     * Get count of streams with a specific rating
     */
    function getRatingCount(rating) {
        if (rating === 0) {
            return Array.from(streams.values()).filter(s => !ratings.has(s.url)).length;
        }
        return Array.from(streams.values()).filter(s => ratings.get(s.url) === rating).length;
    }

    /**
     * Get all rating counts
     */
    function getAllRatingCounts() {
        const counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
        streams.forEach(stream => {
            const rating = ratings.get(stream.url) || 0;
            counts[rating]++;
        });
        return counts;
    }

    /**
     * Distribute ratings evenly across all unrated streams
     * Assigns ratings 1-5 in a round-robin fashion to streams without ratings
     * @returns {number} Number of streams that were assigned ratings
     */
    function distributeRatingsEvenly() {
        // Get all unrated streams
        const unratedStreams = Array.from(streams.values()).filter(s => !ratings.has(s.url));

        if (unratedStreams.length === 0) {
            return 0;
        }

        // Shuffle the unrated streams for random distribution
        for (let i = unratedStreams.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [unratedStreams[i], unratedStreams[j]] = [unratedStreams[j], unratedStreams[i]];
        }

        // Assign ratings 1-5 in round-robin fashion
        unratedStreams.forEach((stream, index) => {
            const rating = (index % 5) + 1; // 1, 2, 3, 4, 5, 1, 2, 3, 4, 5...
            setRating(stream.id, rating);
        });

        return unratedStreams.length;
    }

    /**
     * Save ratings to localStorage
     */
    function saveRatings() {
        const obj = {};
        ratings.forEach((rating, url) => {
            obj[url] = rating;
        });
        localStorage.setItem('plexd_ratings', JSON.stringify(obj));
    }

    /**
     * Load ratings from localStorage
     */
    function loadRatings() {
        // Load new ratings format
        const saved = localStorage.getItem('plexd_ratings');
        if (saved) {
            const obj = JSON.parse(saved);
            ratings.clear();
            Object.keys(obj).forEach(url => {
                ratings.set(url, obj[url]);
            });
        }

        // Migrate old favorites to 5-star ratings
        const oldFavorites = localStorage.getItem('plexd_favorites');
        if (oldFavorites) {
            const urls = JSON.parse(oldFavorites);
            urls.forEach(url => {
                if (!ratings.has(url)) {
                    ratings.set(url, 5); // Migrate favorites to 5-star
                }
            });
            // Remove old format after migration
            localStorage.removeItem('plexd_favorites');
            saveRatings();
        }
    }

    /**
     * Set ratings update callback
     */
    function setRatingsUpdateCallback(callback) {
        ratingsUpdateCallback = callback;
    }

    /**
     * Sync rating status for existing streams (call after loading ratings)
     */
    function syncRatingStatus() {
        streams.forEach(stream => {
            const rating = ratings.get(stream.url);
            if (rating) {
                for (let i = 1; i <= 5; i++) {
                    stream.wrapper.classList.toggle(`plexd-rated-${i}`, rating === i);
                }
                stream.wrapper.classList.add('plexd-rated');
                updateRatingDisplay(stream);
            }
        });
    }

    /**
     * Update stream controls based on cell size (responsive controls)
     */
    function updateControlsSize(streamId, cellWidth, cellHeight) {
        const stream = streams.get(streamId);
        if (!stream) return;

        const wrapper = stream.wrapper;

        // Remove existing size classes
        wrapper.classList.remove('plexd-compact-controls', 'plexd-minimal-controls');

        // Apply appropriate class based on cell size
        if (cellWidth < 200 || cellHeight < 150) {
            wrapper.classList.add('plexd-minimal-controls');
        } else if (cellWidth < 300 || cellHeight < 220) {
            wrapper.classList.add('plexd-compact-controls');
        }
    }

    // ===== HEALTH MONITORING WATCHDOG =====

    /**
     * Check health of all streams and trigger recovery if needed
     */
    function runHealthCheck() {
        if (!RECOVERY_CONFIG.enableAutoRecovery || !isPageVisible) {
            return;
        }

        const now = Date.now();

        streams.forEach((stream) => {
            // Skip if already in error/recovering state
            if (stream.state === 'error' || stream.recovery.isRecovering) {
                return;
            }

            // Skip if paused (user intended)
            if (stream.video.paused && stream.state === 'paused') {
                return;
            }

            const video = stream.video;

            // Check for frozen video (no timeupdate for too long while supposedly playing)
            if (stream.state === 'playing' && !video.paused) {
                const timeSinceUpdate = now - stream.health.lastTimeUpdate;
                if (timeSinceUpdate > RECOVERY_CONFIG.stallTimeout) {
                    console.log(`[${stream.id}] Frozen detected - no time updates for ${timeSinceUpdate}ms`);
                    triggerRecovery(stream, 'frozen_video');
                    return;
                }
            }

            // Check for prolonged stall
            if (stream.health.stallStartTime) {
                const stallDuration = now - stream.health.stallStartTime;
                if (stallDuration > RECOVERY_CONFIG.stallTimeout) {
                    console.log(`[${stream.id}] Prolonged stall detected - ${stallDuration}ms`);
                    triggerRecovery(stream, 'prolonged_stall');
                    return;
                }
            }

            // Check buffer health for HLS streams
            if (stream.hls && video.buffered.length > 0) {
                const bufferEnd = video.buffered.end(video.buffered.length - 1);
                const bufferAhead = bufferEnd - video.currentTime;

                // If buffer is nearly empty and we're playing
                if (bufferAhead < 1 && !video.paused && stream.state === 'playing') {
                    if (!stream.health.bufferEmptyStartTime) {
                        stream.health.bufferEmptyStartTime = now;
                    } else if (now - stream.health.bufferEmptyStartTime > RECOVERY_CONFIG.bufferEmptyTimeout) {
                        console.log(`[${stream.id}] Buffer empty for too long - ${bufferAhead}s ahead`);
                        triggerRecovery(stream, 'buffer_underrun');
                        stream.health.bufferEmptyStartTime = null;
                    }
                } else {
                    stream.health.bufferEmptyStartTime = null;
                }
            }
        });
    }

    /**
     * Start the health monitoring watchdog
     */
    function startHealthMonitoring() {
        if (healthCheckInterval) {
            clearInterval(healthCheckInterval);
        }
        healthCheckInterval = setInterval(runHealthCheck, RECOVERY_CONFIG.watchdogInterval);
        console.log('Stream health monitoring started');
    }

    /**
     * Stop the health monitoring watchdog
     */
    function stopHealthMonitoring() {
        if (healthCheckInterval) {
            clearInterval(healthCheckInterval);
            healthCheckInterval = null;
        }
    }

    // ===== VISIBILITY-BASED OPTIMIZATION =====

    /**
     * Handle page visibility changes to optimize resource usage
     */
    function handleVisibilityChange() {
        isPageVisible = !document.hidden;

        if (isPageVisible) {
            console.log('Page visible - resuming streams');
            // Page is visible again - resume/recover streams
            streams.forEach((stream) => {
                // If stream was supposed to be playing, try to resume
                if (stream.state === 'buffering' ||
                    (stream.video.paused && stream.state !== 'paused' && stream.state !== 'error')) {
                    stream.video.play().catch(() => {});
                }
            });
            // Restart health monitoring
            startHealthMonitoring();
        } else {
            console.log('Page hidden - reducing activity');
            // Page is hidden - pause health checks to save resources
            // Note: We don't pause streams as user might be listening to audio
            stopHealthMonitoring();
        }
    }

    // Listen for visibility changes
    document.addEventListener('visibilitychange', handleVisibilityChange);

    /**
     * Get recovery configuration (for debugging/testing)
     */
    function getRecoveryConfig() {
        return { ...RECOVERY_CONFIG };
    }

    /**
     * Update recovery configuration
     */
    function setRecoveryConfig(config) {
        Object.assign(RECOVERY_CONFIG, config);
    }

    /**
     * Get health status of all streams
     */
    function getStreamHealthStatus() {
        const status = [];
        streams.forEach((stream) => {
            status.push({
                id: stream.id,
                state: stream.state,
                recoveryRetries: stream.recovery.retryCount,
                isRecovering: stream.recovery.isRecovering,
                timeSinceUpdate: Date.now() - stream.health.lastTimeUpdate,
                stallDuration: stream.health.stallStartTime
                    ? Date.now() - stream.health.stallStartTime
                    : 0,
                consecutiveStalls: stream.health.consecutiveStalls
            });
        });
        return status;
    }

    // Start health monitoring on init
    startHealthMonitoring();

    // Load ratings on init
    loadRatings();

    // Listen for fullscreen changes (when user exits via browser UI)
    document.addEventListener('fullscreenchange', () => {
        if (!document.fullscreenElement) {
            // Exited fullscreen - reset mode
            if (fullscreenStreamId) {
                const stream = streams.get(fullscreenStreamId);
                if (stream) {
                    stream.wrapper.classList.remove('plexd-fullscreen');
                }
                fullscreenStreamId = null;
            }
            fullscreenMode = 'none';
            triggerLayoutUpdate();
        }
    });

    // Public API
    return {
        createStream,
        removeStream,
        reloadStream,
        copyStreamUrl,
        copyAllStreamUrls,
        getStream,
        getAllStreams,
        getStreamCount,
        toggleMute,
        toggleFullscreen,
        toggleTrueFullscreen,
        isAnyFullscreen,
        getFullscreenStream,
        getFullscreenMode,
        enterFocusedMode,
        exitFocusedMode,
        enterGridFullscreen,
        exitTrueFullscreen,
        pauseAll,
        playAll,
        muteAll,
        togglePauseAll,
        isGloballyPaused,
        getVideoElements,
        setLayoutUpdateCallback,
        // New features
        togglePiP,
        popoutStream,
        popoutAllStreams,
        toggleAudioFocus,
        getAudioFocusMode,
        toggleAllStreamInfo,
        selectStream,
        getSelectedStream,
        selectNextStream,
        setGridCols,
        getGridCols,
        reorderStreams,
        seekRelative,
        seekTo,
        // Ratings
        cycleRating,
        setRating,
        clearRating,
        getRating,
        getStreamsByRating,
        getRatedStreams,
        getRatingCount,
        getAllRatingCounts,
        distributeRatingsEvenly,
        setRatingsUpdateCallback,
        syncRatingStatus,
        // Responsive controls
        updateControlsSize,
        // Global controls
        toggleCleanMode,
        isCleanMode,
        togglePauseAll,
        toggleMuteAll,
        toggleGlobalFullscreen,
        // Stream health and recovery
        getStreamHealthStatus,
        getRecoveryConfig,
        setRecoveryConfig,
        startHealthMonitoring,
        stopHealthMonitoring
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlexdStream;
}
