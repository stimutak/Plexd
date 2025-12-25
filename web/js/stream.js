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
    // Load from localStorage, default to true
    let audioFocusMode = localStorage.getItem('plexd_audio_focus') !== 'false';

    // Show stream info overlay
    let showInfoOverlay = false;

    // Current grid layout for navigation
    let gridCols = 1;

    // Cached layout order for consistent navigation (row-major order from last layout)
    // This is updated by the layout engine and used for fullscreen navigation
    let cachedLayoutOrder = [];
    let cachedLayoutRows = [];

    // Ratings map - stores stream URL -> rating slot (1-9, 0 = unrated)
    // For blob URLs (local files), also stores fileName -> rating for persistence across sessions
    const ratings = new Map();
    const fileNameRatings = new Map(); // fileName -> rating for blob URLs

    /**
     * Clamp rating slot to 0-9.
     */
    function clampRatingSlot(rating) {
        rating = Number(rating);
        if (!Number.isFinite(rating)) return 0;
        return Math.max(0, Math.min(9, Math.trunc(rating)));
    }

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

    // ===== PERFORMANCE UTILITIES =====

    /**
     * Throttle function execution to reduce DOM updates
     * @param {Function} fn - Function to throttle
     * @param {number} limit - Minimum time between calls (ms)
     * @returns {Function} Throttled function
     */
    function throttle(fn, limit) {
        let lastCall = 0;
        let pendingCall = null;
        return function(...args) {
            const now = Date.now();
            if (now - lastCall >= limit) {
                lastCall = now;
                fn.apply(this, args);
            } else if (!pendingCall) {
                // Schedule a call at the end of the throttle period
                pendingCall = setTimeout(() => {
                    lastCall = Date.now();
                    pendingCall = null;
                    fn.apply(this, args);
                }, limit - (now - lastCall));
            }
        };
    }

    /**
     * Request animation frame wrapper for batched DOM updates
     * Groups updates that occur within the same frame
     */
    const rafBatch = (() => {
        let pending = new Map();
        let scheduled = false;

        const flush = () => {
            scheduled = false;
            const callbacks = pending;
            pending = new Map();
            callbacks.forEach(cb => cb());
        };

        return (id, callback) => {
            pending.set(id, callback);
            if (!scheduled) {
                scheduled = true;
                requestAnimationFrame(flush);
            }
        };
    })();

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

        // Selected badge (purely visual; CSS controls when it shows)
        // This makes it obvious which stream will be acted upon (Enter/Z/etc).
        const selectedBadge = document.createElement('div');
        selectedBadge.className = 'plexd-selected-badge';
        selectedBadge.textContent = 'SELECTED';

        // Assemble
        wrapper.appendChild(video);
        wrapper.appendChild(controls);
        wrapper.appendChild(infoOverlay);
        wrapper.appendChild(ratingIndicator);
        wrapper.appendChild(selectedBadge);

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
            hlsFallbackAttempted: false, // Track if we already tried HLS fallback
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

        // If fileName is provided in options, store it for rating persistence
        if (options.fileName) {
            stream.fileName = options.fileName;
        }

        return stream;
    }

    /**
     * Check if URL is an HLS stream
     * Detects both explicit .m3u8 extensions and common streaming endpoints
     */
    function isHlsUrl(url) {
        const lowerUrl = url.toLowerCase();

        // Explicit HLS extension
        if (lowerUrl.includes('.m3u8')) return true;

        // Common streaming server patterns (Stash, Jellyfin, Emby, etc.)
        // These often serve HLS without the .m3u8 extension
        const hlsPatterns = [
            /\/stream$/i,           // /stream endpoint
            /\/stream\?/i,          // /stream with query params
            /\/live$/i,             // /live endpoint
            /\/live\?/i,            // /live with query params
            /\/playlist$/i,         // /playlist endpoint
            /\/master$/i,           // /master playlist
            /\/hls\//i,             // /hls/ in path
            /\/scene\/\d+\/stream/i // Stash-style /scene/{id}/stream
        ];

        return hlsPatterns.some(pattern => pattern.test(url));
    }

    /**
     * Check if URL might be HLS (for fallback attempts)
     */
    function mightBeHlsUrl(url) {
        // Already detected as HLS
        if (isHlsUrl(url)) return true;

        // URLs without common video extensions might be HLS
        const videoExtensions = ['.mp4', '.webm', '.mov', '.m4v', '.mkv', '.avi', '.ogv'];
        const lowerUrl = url.toLowerCase();

        // If it has a video extension, probably not HLS
        if (videoExtensions.some(ext => lowerUrl.includes(ext))) return false;

        // URLs ending with just a path segment (no extension) might be HLS
        const urlPath = new URL(url).pathname;
        return !urlPath.includes('.') || urlPath.endsWith('/');
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
        muteBtn.title = audioFocusMode
            ? 'Toggle audio (focus ON: unmute one mutes others)'
            : 'Toggle audio (focus OFF: independent)';
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

        // Random seek button (shuffle icon)
        const randomSeekBtn = document.createElement('button');
        randomSeekBtn.className = 'plexd-btn plexd-random-btn';
        randomSeekBtn.innerHTML = '🔀';
        randomSeekBtn.title = 'Random position (retries if stuck)';
        randomSeekBtn.onclick = async (e) => {
            e.stopPropagation();
            randomSeekBtn.innerHTML = '⏳';
            const success = await seekToRandomPosition(streamId);
            randomSeekBtn.innerHTML = success ? '✓' : '✗';
            setTimeout(() => { randomSeekBtn.innerHTML = '🔀'; }, 1000);
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
            removeStreamAndFocusNext(streamId);
        };

        buttonRow.appendChild(skipBackBtn);
        buttonRow.appendChild(muteBtn);
        buttonRow.appendChild(skipFwdBtn);
        buttonRow.appendChild(randomSeekBtn);
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
     * Works with both VOD (finite duration) and live streams (using seekable ranges)
     */
    function seekRelative(streamId, seconds) {
        const stream = streams.get(streamId);
        if (!stream) return;

        const video = stream.video;
        const newTime = video.currentTime + seconds;

        // For VOD with finite duration
        if (video.duration && isFinite(video.duration)) {
            video.currentTime = Math.max(0, Math.min(video.duration, newTime));
            return;
        }

        // For live streams, use seekable ranges
        if (video.seekable && video.seekable.length > 0) {
            const start = video.seekable.start(0);
            const end = video.seekable.end(video.seekable.length - 1);
            video.currentTime = Math.max(start, Math.min(end, newTime));
            return;
        }

        // Fallback: just try to seek (some streams may support it)
        if (video.currentTime !== undefined) {
            video.currentTime = Math.max(0, newTime);
        }
    }

    /**
     * Seek to absolute position (0-1)
     * Works with both VOD and live streams
     */
    function seekTo(streamId, position) {
        const stream = streams.get(streamId);
        if (!stream) return;

        const video = stream.video;
        position = Math.max(0, Math.min(1, position));

        // For VOD with finite duration
        if (video.duration && isFinite(video.duration)) {
            video.currentTime = video.duration * position;
            return;
        }

        // For live streams, map 0-1 to seekable range
        if (video.seekable && video.seekable.length > 0) {
            const start = video.seekable.start(0);
            const end = video.seekable.end(video.seekable.length - 1);
            video.currentTime = start + (end - start) * position;
            return;
        }
    }

    /**
     * Seek to a random position in the stream with playback verification
     * Will retry with different positions if playback fails to start
     * @param {string} streamId - Stream ID
     * @param {number} maxRetries - Maximum retry attempts (default 5)
     * @returns {Promise<boolean>} - True if playback started successfully
     */
    async function seekToRandomPosition(streamId, maxRetries = 5) {
        const stream = streams.get(streamId);
        if (!stream) return false;

        const video = stream.video;
        const usedPositions = new Set();
        let attempts = 0;

        // Get seekable range
        const getSeekRange = () => {
            if (video.duration && isFinite(video.duration)) {
                return { start: 0, end: video.duration };
            }
            if (video.seekable && video.seekable.length > 0) {
                return {
                    start: video.seekable.start(0),
                    end: video.seekable.end(video.seekable.length - 1)
                };
            }
            return null;
        };

        const range = getSeekRange();
        if (!range || range.end - range.start < 1) {
            // Can't seek - stream too short or not seekable
            // Just try to play from current position
            if (video.paused) {
                try {
                    await video.play();
                } catch (e) {}
            }
            return !video.paused;
        }

        const getRandomPosition = () => {
            // Generate random position, avoiding positions we've already tried
            // Skip first 5% and last 5% to avoid edges
            const safeStart = range.start + (range.end - range.start) * 0.05;
            const safeEnd = range.end - (range.end - range.start) * 0.05;
            const safeRange = safeEnd - safeStart;

            // Divide into segments and pick unused ones
            const numSegments = Math.max(10, maxRetries * 2);
            const segmentSize = safeRange / numSegments;

            // Find unused segment
            for (let i = 0; i < numSegments; i++) {
                const segment = Math.floor(Math.random() * numSegments);
                if (!usedPositions.has(segment)) {
                    usedPositions.add(segment);
                    // Random position within segment
                    return safeStart + segment * segmentSize + Math.random() * segmentSize;
                }
            }
            // All segments used, just pick random
            return safeStart + Math.random() * safeRange;
        };

        const trySeekAndPlay = async (position) => {
            return new Promise((resolve) => {
                const timeout = 3000; // 3 second timeout per attempt
                let resolved = false;

                const cleanup = () => {
                    video.removeEventListener('playing', onPlaying);
                    video.removeEventListener('timeupdate', onTimeUpdate);
                    video.removeEventListener('error', onError);
                    clearTimeout(timer);
                };

                const succeed = () => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        resolve(true);
                    }
                };

                const fail = () => {
                    if (!resolved) {
                        resolved = true;
                        cleanup();
                        resolve(false);
                    }
                };

                const onPlaying = () => succeed();
                const onTimeUpdate = () => {
                    // Verify we're actually making progress
                    if (!video.paused && video.currentTime > 0) {
                        succeed();
                    }
                };
                const onError = () => fail();
                const timer = setTimeout(fail, timeout);

                video.addEventListener('playing', onPlaying);
                video.addEventListener('timeupdate', onTimeUpdate);
                video.addEventListener('error', onError);

                try {
                    video.currentTime = position;
                    video.play().catch(fail);
                } catch (e) {
                    fail();
                }
            });
        };

        while (attempts < maxRetries) {
            attempts++;
            const position = getRandomPosition();

            const success = await trySeekAndPlay(position);
            if (success) {
                return true;
            }

            // Brief pause before retry
            await new Promise(r => setTimeout(r, 200));
        }

        // All attempts failed - try one last reload
        if (stream.hls) {
            // For HLS, try recovery
            try {
                stream.hls.recoverMediaError();
                await new Promise(r => setTimeout(r, 500));
                if (!video.paused) return true;
            } catch (e) {}
        }

        return false;
    }

    /**
     * Seek all streams to random positions
     * @returns {Promise<number>} - Number of streams successfully started
     */
    async function seekAllToRandomPosition() {
        const streamList = Array.from(streams.values());
        if (streamList.length === 0) return 0;

        // Run all seeks in parallel for speed
        const results = await Promise.all(
            streamList.map(stream => seekToRandomPosition(stream.id))
        );

        return results.filter(Boolean).length;
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

    // =====================================================================
    // Resource saving policies (focus/zoom + filtered views)
    // =====================================================================

    /**
     * Apply "focused stream only" playback policy.
     *
     * When zoomed into a stream, we pause other streams to save resources,
     * but ONLY if we can reliably resume them when leaving focus/switching.
     *
     * This does not override user-paused streams (we only auto-pause if playing),
     * and it respects global pause mode (we never auto-resume while globally paused).
     */
    function applyFocusResourcePolicy(focusedStreamId) {
        const isPausedGlobally = globalPaused;

        streams.forEach((s, id) => {
            if (id === focusedStreamId) {
                // Ensure the focused stream plays (unless globally paused)
                if (!isPausedGlobally && s._plexdAutoPausedForFocus) {
                    resumeStream(id);
                    s._plexdAutoPausedForFocus = false;
                }
                // If we previously downgraded HLS quality for this stream, restore it now.
                restoreHlsQualityIfNeeded(s);
                return;
            }

            // Don't touch hidden items (e.g., rating-filtered out) - app.js handles those.
            if (s.wrapper && s.wrapper.style && s.wrapper.style.display === 'none') {
                return;
            }

            // Resource strategy:
            // - For live/HLS streams, pausing often causes a "restart" on resume (jump to live edge),
            //   so we avoid pausing and instead *deprioritize* by forcing low quality on HLS.js.
            // - For finite-duration VOD/local files, pausing is safe and saves CPU/GPU.
            if (isSafeToAutoPauseForResources(s)) {
                if (s.video && !s.video.paused) {
                    s._plexdAutoPausedForFocus = true;
                    pauseStream(id);
                }
            } else {
                downgradeHlsQualityIfPossible(s);
            }
        });
    }

    /**
     * Clear "focused stream only" policy and resume any streams that were
     * auto-paused for focus (best-effort; respects global pause + view filters).
     * IMPORTANT: Only resumes if streams were actually paused by focus policy,
     * and preserves their playback position to prevent restarts.
     */
    function clearFocusResourcePolicy() {
        if (globalPaused) return;

        streams.forEach((s, id) => {
            // Restore any HLS quality downgrades we applied during focus.
            restoreHlsQualityIfNeeded(s);

            if (!s._plexdAutoPausedForFocus) return;
            // Don't resume streams that are currently hidden by filtering.
            if (s.wrapper && s.wrapper.style && s.wrapper.style.display === 'none') {
                return;
            }
            // Only resume if still paused (user didn't manually pause it)
            // This prevents unnecessary resume calls that could cause restarts
            if (s.video.paused) {
                resumeStream(id);
            }
            s._plexdAutoPausedForFocus = false;
        });
    }

    /**
     * Determine if we can safely auto-pause a stream without it "restarting" on resume.
     * We consider local file blobs and finite-duration media safe.
     * We consider HLS/live/infinite-duration media unsafe to auto-pause.
     */
    function isSafeToAutoPauseForResources(stream) {
        if (!stream) return false;
        if (stream.url && stream.url.startsWith('blob:')) return true;

        // HLS streams and common live endpoints are generally unsafe to pause/resume without jumps.
        if (stream.hls || isHlsUrl(stream.url)) return false;

        const video = stream.video;
        if (!video) return false;

        const d = video.duration;
        if (d && Number.isFinite(d) && d > 0) {
            return true; // VOD-ish
        }

        // Unknown duration: err on the side of not pausing (avoids unwanted restarts).
        return false;
    }

    /**
     * Downgrade HLS.js quality for a stream (best-effort), to save resources without pausing.
     * We persist previous state so it can be restored.
     */
    function downgradeHlsQualityIfPossible(stream) {
        if (!stream || !stream.hls) return;
        if (stream._plexdHlsQualityDowngraded) return;

        try {
            stream._plexdPrevHlsAutoLevelEnabled = stream.hls.autoLevelEnabled;
            stream._plexdPrevHlsCurrentLevel = stream.hls.currentLevel;
            // Force lowest quality; keep it stable while unfocused.
            stream.hls.autoLevelEnabled = false;
            stream.hls.currentLevel = 0;
            stream._plexdHlsQualityDowngraded = true;
        } catch (_) {
            // Best-effort only.
        }
    }

    /**
     * Restore HLS.js quality settings if we previously downgraded them.
     */
    function restoreHlsQualityIfNeeded(stream) {
        if (!stream || !stream.hls || !stream._plexdHlsQualityDowngraded) return;

        try {
            if (typeof stream._plexdPrevHlsAutoLevelEnabled === 'boolean') {
                stream.hls.autoLevelEnabled = stream._plexdPrevHlsAutoLevelEnabled;
            } else {
                stream.hls.autoLevelEnabled = true;
            }

            if (typeof stream._plexdPrevHlsCurrentLevel === 'number') {
                stream.hls.currentLevel = stream._plexdPrevHlsCurrentLevel;
            } else {
                // -1 = auto in HLS.js
                stream.hls.currentLevel = -1;
            }
        } catch (_) {
            // Best-effort only.
        } finally {
            delete stream._plexdPrevHlsAutoLevelEnabled;
            delete stream._plexdPrevHlsCurrentLevel;
            stream._plexdHlsQualityDowngraded = false;
        }
    }

    /**
     * Toggle a global app CSS class used to prevent "hover bleed-through"
     * from streams behind the focused/fullscreen stream.
     */
    function setAppFocusedMode(isFocused) {
        const app = document.querySelector('.plexd-app');
        if (!app) return;
        app.classList.toggle('plexd-focused-mode', !!isFocused);
    }

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
            setAppFocusedMode(false);
            // Resource saving: resume streams that were auto-paused for focus
            clearFocusResourcePolicy();
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
            setAppFocusedMode(true);
            // Resource saving: pause other streams while focused
            applyFocusResourcePolicy(streamId);
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
        setAppFocusedMode(true);

        // If we're in true fullscreen grid mode, switch to focused mode
        if (document.fullscreenElement) {
            fullscreenMode = 'true-focused';
        } else {
            fullscreenMode = 'browser-fill';
        }
        // Add focused mode class to app for CSS targeting
        const app = document.querySelector('.plexd-app');
        if (app) app.classList.add('plexd-focused-mode');
        // Focus wrapper for keyboard events (Z/Enter to exit, etc.)
        stream.wrapper.focus();

        // Select this stream
        selectStream(streamId);

        // Resource saving: pause other streams while zoomed in (will resume on exit)
        applyFocusResourcePolicy(streamId);

        triggerLayoutUpdate();
    }

    /**
     * Exit focused mode back to grid view (stays in true fullscreen if applicable)
     */
    function exitFocusedMode() {
        // Remove fullscreen class from any stream that has it (defensive cleanup)
        streams.forEach(stream => {
            if (stream.wrapper.classList.contains('plexd-fullscreen')) {
                stream.wrapper.classList.remove('plexd-fullscreen');
            }
        });
        fullscreenStreamId = null;
        setAppFocusedMode(false);

        // Remove focused mode class
        const app = document.querySelector('.plexd-app');
        if (app) app.classList.remove('plexd-focused-mode');

        // Resource saving: resume streams that were auto-paused for focus
        clearFocusResourcePolicy();

        // If we were in true-focused mode, return to true-grid mode
        if (fullscreenMode === 'true-focused' && document.fullscreenElement) {
            fullscreenMode = 'true-grid';
        } else if (document.fullscreenElement) {
            // We're in some fullscreen state, go to grid mode
            fullscreenMode = 'true-grid';
        } else {
            fullscreenMode = 'none';
        }

        triggerLayoutUpdate();
    }

    /**
     * Force reset all fullscreen state (emergency cleanup)
     * Call this if fullscreen gets stuck
     */
    function resetFullscreenState() {
        console.log('[Plexd] Resetting fullscreen state');

        // Remove fullscreen class from all streams
        streams.forEach(stream => {
            stream.wrapper.classList.remove('plexd-fullscreen');
        });

        // Clear state variables
        fullscreenStreamId = null;
        fullscreenMode = 'none';
        setAppFocusedMode(false);

        // Resource saving: resume streams that were auto-paused for focus
        clearFocusResourcePolicy();

        // Exit true fullscreen if active
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
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
            setAppFocusedMode(true);

            // Request true fullscreen on the stream
            stream.wrapper.requestFullscreen().then(() => {
                fullscreenMode = 'true-focused';
                stream.wrapper.focus();
                selectStream(streamId);
                applyFocusResourcePolicy(streamId);
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
            setAppFocusedMode(false);
            // Returning to grid: resume anything we auto-paused for focus
            clearFocusResourcePolicy();
        }

        // Ensure the fullscreen container can hold focus for keyboard shortcuts.
        // (Some browsers/iPad Safari behave better when the fullscreen element is focusable.)
        container.tabIndex = 0;

        container.requestFullscreen().then(() => {
            fullscreenMode = 'true-grid';
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
            setAppFocusedMode(false);
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
            setAppFocusedMode(false);
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
     * Only returns a stream if we're actually in a fullscreen mode
     */
    function getFullscreenStream() {
        // Validate state: if fullscreenMode is 'none', we shouldn't have a fullscreen stream
        if (fullscreenMode === 'none') {
            // State cleanup: if we have a stale fullscreenStreamId, clear it
            if (fullscreenStreamId) {
                console.log('[Plexd] Cleaning up stale fullscreenStreamId');
                const stream = streams.get(fullscreenStreamId);
                if (stream) {
                    stream.wrapper.classList.remove('plexd-fullscreen');
                }
                fullscreenStreamId = null;
            }
            return null;
        }

        // Check our tracked fullscreen
        if (fullscreenStreamId) {
            const stream = streams.get(fullscreenStreamId);
            // Verify the stream still exists and has the fullscreen class
            if (stream && stream.wrapper.classList.contains('plexd-fullscreen')) {
                return stream;
            }
            // State is inconsistent - clean up
            console.log('[Plexd] Fullscreen state inconsistent, cleaning up');
            fullscreenStreamId = null;
            fullscreenMode = 'none';
            return null;
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

        // Keep resource saving policy consistent while browsing focused streams
        applyFocusResourcePolicy(newStream.id);
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
        // Use RAF batching for efficient DOM updates (timeupdate fires frequently)
        video.addEventListener('timeupdate', () => {
            // Track health first (non-DOM, always do this)
            if (video.currentTime !== stream.health.lastCurrentTime) {
                stream.health.lastTimeUpdate = Date.now();
                stream.health.lastCurrentTime = video.currentTime;
                stream.health.stallStartTime = null;
            }

            // Batch DOM updates using requestAnimationFrame
            rafBatch(stream.id + '-timeupdate', () => {
                // For VOD with finite duration
                if (video.duration && isFinite(video.duration)) {
                    if (seekBar) {
                        const progress = (video.currentTime / video.duration) * 100;
                        seekBar.value = progress;
                    }
                    if (timeDisplay) {
                        timeDisplay.textContent = `${formatTime(video.currentTime)} / ${formatTime(video.duration)}`;
                    }
                }
                // For live streams, use seekable range
                else if (video.seekable && video.seekable.length > 0) {
                    const start = video.seekable.start(0);
                    const end = video.seekable.end(video.seekable.length - 1);
                    const range = end - start;
                    if (seekBar && range > 0) {
                        const progress = ((video.currentTime - start) / range) * 100;
                        seekBar.value = Math.max(0, Math.min(100, progress));
                    }
                    if (timeDisplay) {
                        // Show position relative to start of seekable range (DVR style)
                        const offset = video.currentTime - end;
                        if (offset >= -1) {
                            timeDisplay.textContent = 'LIVE';
                        } else {
                            timeDisplay.textContent = formatTime(offset);
                        }
                    }
                }
            });
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

        // Keyboard handling on wrapper (for fullscreen mode)
        // Note: Arrow keys and most keys are handled by app.js
        // This handler catches keys when the wrapper has focus (in true-focused mode)
        wrapper.addEventListener('keydown', (e) => {
            // Only handle when this element is the fullscreen element or has focus
            if (document.fullscreenElement !== wrapper && document.activeElement !== wrapper) {
                return;
            }

            // Only process keys here when in focused/fullscreen mode
            // In grid mode (fullscreenMode === 'none'), let events bubble naturally to document
            if (fullscreenMode !== 'true-focused' && fullscreenMode !== 'browser-fill') {
                // Not in fullscreen mode - don't interfere, let event bubble to document
                return;
            }

            // Number keys (0-9) and arrow keys should propagate to document handler
            // for rating filter/assignment and stream navigation
            // In true fullscreen, we need to manually dispatch since document may be outside fullscreen context
            if (/^[0-9]$/.test(e.key) || e.key.startsWith('Arrow')) {
                // IMPORTANT:
                // We dispatch a synthetic event to `document` so app-level shortcuts still work
                // in fullscreen/focused contexts. We MUST stop propagation of the original event
                // to avoid double-handling (original bubbling + synthetic dispatch).
                e.stopPropagation();
                e.preventDefault();
                // Dispatch to document for app.js to handle (exactly once)
                // Use setTimeout to ensure the event is processed after current handler completes
                setTimeout(() => {
                    document.dispatchEvent(new KeyboardEvent('keydown', {
                        key: e.key,
                        code: e.code,
                        shiftKey: e.shiftKey,
                        ctrlKey: e.ctrlKey,
                        altKey: e.altKey,
                        metaKey: e.metaKey,
                        bubbles: true,
                        cancelable: true
                    }));
                }, 0);
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
                case 'z':
                case 'Z':
                case 'Enter':
                    // Z or Enter in focused mode: toggle back to grid
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
            const detectedHLS = isHlsUrl(stream.url);
            const hlsAvailable = typeof Hls !== 'undefined' && Hls.isSupported();
            console.error(`Stream ${stream.id} error:`, stream.error,
                'URL:', stream.url,
                'DetectedHLS:', detectedHLS,
                'HLS.js available:', hlsAvailable);

            // Check if this is an HLS stream without HLS.js support
            if (detectedHLS && !hlsAvailable && !video.canPlayType('application/vnd.apple.mpegurl')) {
                stream.error = 'HLS not supported - HLS.js failed to load';
                console.error('[Plexd] HLS.js is not available and browser lacks native HLS support');
            }

            // If not already using HLS.js, try loading as HLS (might be HLS without extension)
            if (!stream.hls && hlsAvailable && !stream.hlsFallbackAttempted && mightBeHlsUrl(stream.url)) {
                console.log(`[${stream.id}] Trying HLS.js fallback for: ${stream.url}`);
                stream.hlsFallbackAttempted = true;
                stream.error = null;
                stream.state = 'loading';

                // Try loading with HLS.js
                const hls = createHlsInstance(stream, stream.url);
                stream.hls = hls;
                return; // Don't show error yet, wait for HLS result
            }

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
     * Remove a stream and focus the next stream's remove button for quick sequential closing
     */
    function removeStreamAndFocusNext(streamId) {
        const streamList = Array.from(streams.keys());
        const currentIndex = streamList.indexOf(streamId);

        // Find next stream to focus (or previous if at end)
        let nextStreamId = null;
        if (streamList.length > 1) {
            if (currentIndex < streamList.length - 1) {
                nextStreamId = streamList[currentIndex + 1];
            } else if (currentIndex > 0) {
                nextStreamId = streamList[currentIndex - 1];
            }
        }

        // Remove the current stream
        removeStream(streamId);

        // Focus the next stream's remove button for quick sequential closing
        if (nextStreamId) {
            const nextStream = streams.get(nextStreamId);
            if (nextStream) {
                // Select the next stream
                selectStream(nextStreamId);

                // Focus its remove button after a short delay (for DOM update)
                setTimeout(() => {
                    const removeBtn = nextStream.controls.querySelector('.plexd-remove-btn');
                    if (removeBtn) {
                        removeBtn.focus();
                    }
                }, 50);
            }
        }
    }

    /**
     * Reload a stream (handles errors, stalled, paused - gets it playing again)
     * Preserves playback position where possible
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
        stream.state = 'loading';
        // Clear any recovering marker so UI doesn't get "stuck"
        delete stream.wrapper.dataset.recovering;
        stream.recovery.isRecovering = false;
        updateStreamInfo(stream);

        // Store current position for restoration after reload
        const savedTime = video.currentTime;
        const hasFiniteDuration = video.duration && isFinite(video.duration);
        const shouldPlay = !globalPaused;

        // Force a HARD reload.
        // (The previous "smart" early returns often failed to recover partially-stalled streams/files.)

        // Reset recovery state for manual reload attempts
        stream.recovery.retryCount = 0;
        stream.recovery.isRecovering = false;
        stream.hlsFallbackAttempted = false;

        // Destroy and recreate streaming pipeline
        if (stream.hls) {
            stream.hls.destroy();
            stream.hls = null;
        }

        // Reset the media element.
        // Clearing src + load() is the most reliable way to force the browser to drop any stuck decode/network state.
        try {
            video.pause();
        } catch (_) {}
        video.src = '';
        video.load();

        // Reload the video
        const hlsSupported = typeof Hls !== 'undefined' && Hls.isSupported && Hls.isSupported();
        setTimeout(() => {
            if (isHlsUrl(url) && hlsSupported) {
                // Use the same robust HLS setup as initial playback (with recovery hooks)
                const hls = createHlsInstance(stream, url);

                // Restore position for VOD streams after reload (best-effort)
                if (hasFiniteDuration && savedTime > 0) {
                    hls.on(Hls.Events.MANIFEST_PARSED, () => {
                        try {
                            video.currentTime = Math.max(0, savedTime);
                        } catch (_) {
                            // Some streams disallow seeking until later; ignore.
                        }
                    });
                }

                stream.hls = hls;
            } else if (isHlsUrl(url) && video.canPlayType('application/vnd.apple.mpegurl')) {
                // Native HLS (Safari): restore VOD position once metadata is available.
                if (hasFiniteDuration && savedTime > 0) {
                    video.addEventListener('loadedmetadata', () => {
                        try {
                            video.currentTime = Math.max(0, savedTime);
                        } catch (_) {}
                    }, { once: true });
                }
                video.src = url;
                video.load();
                if (shouldPlay) video.play().catch(() => {});
            } else {
                // Regular media: restore VOD position once metadata is available.
                if (hasFiniteDuration && savedTime > 0) {
                    video.addEventListener('loadedmetadata', () => {
                        try {
                            video.currentTime = Math.max(0, savedTime);
                        } catch (_) {}
                    }, { once: true });
                }
                video.src = url;
                video.load();
                if (shouldPlay) video.play().catch(() => {});
            }
        }, 0);

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
        localStorage.setItem('plexd_audio_focus', audioFocusMode);
        // Update all mute button tooltips to reflect new mode
        updateAllMuteButtonTooltips();
        return audioFocusMode;
    }

    /**
     * Update all mute button tooltips to reflect current audio focus mode
     */
    function updateAllMuteButtonTooltips() {
        const tooltip = audioFocusMode
            ? 'Toggle audio (focus ON: unmute one mutes others)'
            : 'Toggle audio (focus OFF: independent)';
        streams.forEach(stream => {
            const muteBtn = stream.controls.querySelector('.plexd-mute-btn');
            if (muteBtn) muteBtn.title = tooltip;
        });
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
     * Update cached layout order from the layout engine.
     * This is called after layout is applied to store a consistent navigation order.
     * @param {Array} cells - Array of {streamId, x, y, width, height} from layout engine
     */
    function updateLayoutOrder(cells) {
        if (!cells || cells.length === 0) {
            cachedLayoutOrder = [];
            cachedLayoutRows = [];
            return;
        }

        // Sort cells by row (y) then column (x) to get row-major order
        const sorted = [...cells].sort((a, b) => {
            // Group into rows with tolerance (items within 50px Y are same row)
            const rowA = Math.floor(a.y / 50);
            const rowB = Math.floor(b.y / 50);
            if (rowA !== rowB) return rowA - rowB;
            return a.x - b.x;
        });

        // Build row structure for up/down navigation
        const rows = [];
        let currentRow = [];
        let lastRowIndex = -1;

        for (const cell of sorted) {
            const rowIndex = Math.floor(cell.y / 50);
            if (lastRowIndex !== -1 && rowIndex !== lastRowIndex) {
                if (currentRow.length > 0) {
                    rows.push([...currentRow]);
                }
                currentRow = [];
            }
            currentRow.push(cell.streamId);
            lastRowIndex = rowIndex;
        }
        if (currentRow.length > 0) {
            rows.push(currentRow);
        }

        cachedLayoutOrder = sorted.map(c => c.streamId);
        cachedLayoutRows = rows;
    }

    /**
     * Get cached layout order
     */
    function getLayoutOrder() {
        return cachedLayoutOrder;
    }

    /**
     * Get cached layout rows
     */
    function getLayoutRows() {
        return cachedLayoutRows;
    }

    /**
     * Compute grid columns from actual DOM positions
     */
    function computeGridCols() {
        const streamList = Array.from(streams.values());
        if (streamList.length <= 1) return 1;

        // Get Y positions of first few streams
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
     * Check if a stream URL is a local file (blob URL)
     */
    function isLocalFile(streamId) {
        const stream = streams.get(streamId);
        return stream && stream.url && stream.url.startsWith('blob:');
    }

    // =====================================================================
    // Spatial Navigation (Arrow Keys) - robust across Tetris/overlaps
    // =====================================================================

    /**
     * Get streams included in navigation, respecting current view mode filter,
     * and excluding streams that are not currently visible (display: none).
     */
    function getNavigableStreams() {
        const viewMode = window._plexdViewMode || 'all';
        let list;
        if (viewMode === 'all') {
            list = Array.from(streams.values());
        } else {
            list = getStreamsByRating(viewMode);
        }

        return list.filter(s => {
            if (!s.wrapper) return false;
            if (s.wrapper.style && s.wrapper.style.display === 'none') return false;
            const rect = s.wrapper.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
        });
    }

    /**
     * Build row groups from DOM positions (row-major ordering).
     * Rows are clustered by Y center with a tolerance derived from median height.
     */
    function buildSpatialRows(navigable) {
        const items = navigable.map(s => {
            // Prefer the layout engine's absolute positioning (stable even when a stream is fullscreen),
            // and fall back to DOM rects if styles aren't available yet.
            const styleLeft = parseFloat(s.wrapper.style.left);
            const styleTop = parseFloat(s.wrapper.style.top);
            const styleWidth = parseFloat(s.wrapper.style.width);
            const styleHeight = parseFloat(s.wrapper.style.height);

            const hasStyleRect =
                Number.isFinite(styleLeft) &&
                Number.isFinite(styleTop) &&
                Number.isFinite(styleWidth) &&
                Number.isFinite(styleHeight) &&
                styleWidth > 0 &&
                styleHeight > 0;

            const r = hasStyleRect
                ? { left: styleLeft, top: styleTop, width: styleWidth, height: styleHeight }
                : s.wrapper.getBoundingClientRect();

            return {
                stream: s,
                id: s.id,
                cx: r.left + r.width / 2,
                cy: r.top + r.height / 2,
                h: r.height
            };
        });

        items.sort((a, b) => (a.cy - b.cy) || (a.cx - b.cx));

        const heights = items.map(i => i.h).sort((a, b) => a - b);
        const medianH = heights.length ? heights[Math.floor(heights.length / 2)] : 0;
        const tol = Math.max(20, Math.min(120, medianH * 0.6));

        const rows = [];
        for (const it of items) {
            const lastRow = rows[rows.length - 1];
            if (!lastRow) {
                rows.push({ cy: it.cy, items: [it] });
                continue;
            }

            if (Math.abs(it.cy - lastRow.cy) <= tol) {
                lastRow.cy = (lastRow.cy * lastRow.items.length + it.cy) / (lastRow.items.length + 1);
                lastRow.items.push(it);
            } else {
                rows.push({ cy: it.cy, items: [it] });
            }
        }

        for (const row of rows) {
            row.items.sort((a, b) => a.cx - b.cx);
        }

        return rows;
    }

    /**
     * Get the next stream id in a direction based on spatial layout.
     * Uses cached layout order when available for consistent navigation.
     * - Right/Left: row-major cycling through visible clips (wraps).
     * - Up/Down: same column position in previous/next row (wraps rows).
     */
    function getSpatialNeighborStreamId(currentStreamId, direction) {
        const navigable = getNavigableStreams();
        if (navigable.length === 0) return null;
        if (navigable.length === 1) return navigable[0].id;

        const navigableIds = new Set(navigable.map(s => s.id));

        // Use cached layout if available and contains the current stream
        const useCache = cachedLayoutOrder.length > 0 &&
                         cachedLayoutRows.length > 0 &&
                         cachedLayoutOrder.includes(currentStreamId);

        if (useCache) {
            // Filter cached order to only include currently navigable streams
            const order = cachedLayoutOrder.filter(id => navigableIds.has(id));
            const rows = cachedLayoutRows.map(row => row.filter(id => navigableIds.has(id)))
                                         .filter(row => row.length > 0);

            if (order.length === 0) {
                // Fall back to DOM-based navigation
                return getSpatialNeighborFromDOM(navigable, currentStreamId, direction);
            }

            const currentIdx = order.indexOf(currentStreamId);
            const idx = currentIdx === -1 ? 0 : currentIdx;

            if (direction === 'right' || direction === 'left') {
                const delta = direction === 'right' ? 1 : -1;
                const nextIdx = (idx + delta + order.length) % order.length;
                return order[nextIdx];
            }

            // Up/down: find current row and column position
            let currentRow = -1;
            let currentCol = -1;
            for (let r = 0; r < rows.length; r++) {
                const colIdx = rows[r].indexOf(currentStreamId);
                if (colIdx !== -1) {
                    currentRow = r;
                    currentCol = colIdx;
                    break;
                }
            }

            if (currentRow === -1) {
                // Current stream not in rows, fall back
                return getSpatialNeighborFromDOM(navigable, currentStreamId, direction);
            }

            const rowDelta = direction === 'down' ? 1 : -1;
            const targetRow = (currentRow + rowDelta + rows.length) % rows.length;
            const targetRowItems = rows[targetRow];

            // Try to stay in same column, or closest available
            const targetCol = Math.min(currentCol, targetRowItems.length - 1);
            return targetRowItems[targetCol];
        }

        // No cache or current stream not in cache - use DOM-based navigation
        return getSpatialNeighborFromDOM(navigable, currentStreamId, direction);
    }

    /**
     * Fallback: Get spatial neighbor using DOM positions
     */
    function getSpatialNeighborFromDOM(navigable, currentStreamId, direction) {
        const rows = buildSpatialRows(navigable);
        const flat = rows.flatMap(r => r.items);

        const currentIdx = flat.findIndex(it => it.id === currentStreamId);
        const idx = currentIdx === -1 ? 0 : currentIdx;
        const current = flat[idx];

        if (direction === 'right' || direction === 'left') {
            const delta = direction === 'right' ? 1 : -1;
            const nextIdx = (idx + delta + flat.length) % flat.length;
            return flat[nextIdx].id;
        }

        // Up/down: find current row
        let rowIndex = 0;
        for (let r = 0; r < rows.length; r++) {
            if (rows[r].items.some(it => it.id === current.id)) {
                rowIndex = r;
                break;
            }
        }

        const rowDelta = direction === 'down' ? 1 : -1;
        const targetRowIndex = (rowIndex + rowDelta + rows.length) % rows.length;
        const targetRow = rows[targetRowIndex].items;
        if (!targetRow || targetRow.length === 0) return current.id;

        let best = targetRow[0];
        let bestDist = Math.abs(best.cx - current.cx);
        for (const it of targetRow) {
            const d = Math.abs(it.cx - current.cx);
            if (d < bestDist) {
                best = it;
                bestDist = d;
            }
        }
        return best.id;
    }

    /**
     * Select next stream in grid order (respects visual grid layout and view mode filter)
     * Uses actual DOM positions for accurate navigation, even with Tetris/coverflow layouts
     * When viewMode is 'all', includes all streams (both remote and local files)
     */
    function selectNextStream(direction = 'right') {
        const navigable = getNavigableStreams();
        if (navigable.length === 0) return;

        const currentId = (selectedStreamId && streams.has(selectedStreamId)) ? selectedStreamId : navigable[0].id;
        const nextId = getSpatialNeighborStreamId(currentId, direction) || navigable[0].id;
        selectStream(nextId);

        // Maintain keyboard focus on the newly selected stream
        // This ensures arrow keys continue to work after navigation
        const newStream = streams.get(nextId);
        if (newStream && newStream.wrapper) {
            // Focus the wrapper to maintain keyboard control
            newStream.wrapper.focus();
        }
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
     * Pause a single stream, preserving position for later resume
     * For HLS/live streams, we track that we paused them but avoid actual pause
     * to prevent restart issues on resume.
     */
    function pauseStream(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return;

        const video = stream.video;

        // For HLS/live streams, mark as "soft paused" but don't actually pause
        // This prevents the stream from restarting when resumed
        if (stream.hls || isHlsUrl(stream.url)) {
            stream._plexdSoftPaused = true;
            stream.savedPosition = video.currentTime;
            // Mute instead of pause to save resources without restart
            stream._plexdWasMuted = video.muted;
            video.muted = true;
            return;
        }

        // Store current position before pausing (VOD/local files)
        stream.savedPosition = video.currentTime;
        video.pause();
    }

    /**
     * Resume a single stream
     * IMPORTANT: For HLS streams that were "soft paused", just unmute.
     * For VOD streams, restore position only if stream actually restarted.
     */
    function resumeStream(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return;

        const video = stream.video;

        // Handle soft-paused HLS streams - just unmute, don't seek
        if (stream._plexdSoftPaused) {
            // Restore mute state only if it wasn't muted before
            if (!stream._plexdWasMuted) {
                video.muted = false;
            }
            delete stream._plexdSoftPaused;
            delete stream._plexdWasMuted;
            // Ensure playing (it should already be playing)
            if (video.paused) {
                video.play().catch(() => {});
            }
            return;
        }

        // For VOD/local files: only restore position if stream actually restarted
        if (stream.savedPosition !== undefined && stream.savedPosition > 1) {
            const hasFiniteDuration = video.duration && isFinite(video.duration);
            const isSeekable = video.seekable && video.seekable.length > 0;

            // Only restore for VOD content (not HLS/live)
            if ((hasFiniteDuration || isSeekable) && !stream.hls && !isHlsUrl(stream.url)) {
                // Check if stream appears to have restarted (currentTime near 0 but we were further)
                const timeDiff = Math.abs(video.currentTime - stream.savedPosition);
                if (video.currentTime < 2 && timeDiff > 2) {
                    video.currentTime = stream.savedPosition;
                }
            }
        }

        // Only play if paused - don't restart if already playing
        if (video.paused) {
            video.play().catch(() => {
                // Autoplay may be blocked, that's ok
            });
        }
    }

    /**
     * Pause all streams
     */
    function pauseAll() {
        streams.forEach(stream => {
            stream.savedPosition = stream.video.currentTime;
            stream.video.pause();
        });
    }

    /**
     * Play all streams
     */
    function playAll() {
        streams.forEach(stream => {
            resumeStream(stream.id);
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
     * Cycle rating for a stream (1 -> 2 -> ... -> 9 -> 0 -> 1...)
     */
    function cycleRating(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return 0;

        const currentRating = getRating(stream.url, stream.fileName);
        const newRating = (currentRating + 1) % 10; // 0, 1, 2, ..., 9, 0...

        setRating(streamId, newRating);
        return newRating;
    }

    /**
     * Set rating/slot for a stream (0-9)
     * For blob URLs (local files), also saves by fileName for persistence
     */
    function setRating(streamId, rating) {
        const stream = streams.get(streamId);
        if (!stream) return;

        // Clamp rating 0-9
        rating = clampRatingSlot(rating);

        const urlKey = stream.url;
        if (!urlKey) return;

        // Store by URL (for remote streams)
        if (rating === 0) {
            ratings.delete(urlKey);
        } else {
            ratings.set(urlKey, rating);
        }

        // For blob URLs (local files), also store by fileName for persistence
        // Blob URLs change each time, so we need a stable identifier
        if (stream.url && stream.url.startsWith('blob:') && stream.fileName) {
            if (rating === 0) {
                fileNameRatings.delete(stream.fileName);
            } else {
                fileNameRatings.set(stream.fileName, rating);
            }
        }

        // Update wrapper classes for all rating levels
        for (let i = 1; i <= 9; i++) {
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
        const rating = getRating(stream.url, stream.fileName);

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
     * Get rating for a stream URL or fileName
     * For blob URLs, checks fileName first, then URL
     */
    function getRating(url, fileName) {
        if (!url) return 0;

        // If caller didn't provide fileName for a blob URL, try to infer it from active streams.
        if (!fileName && url.startsWith('blob:')) {
            for (const s of streams.values()) {
                if (s.url === url && s.fileName) {
                    fileName = s.fileName;
                    break;
                }
            }
        }

        // For blob URLs, check fileName first (stable identifier)
        if (fileName && url && url.startsWith('blob:')) {
            const fileNameRating = fileNameRatings.get(fileName);
            if (fileNameRating !== undefined) {
                return fileNameRating;
            }
        }
        // Fall back to URL-based rating
        return ratings.get(url) || 0;
    }

    /**
     * Get streams with a specific rating
     * Checks both URL-based and fileName-based ratings
     */
    function getStreamsByRating(rating) {
        rating = clampRatingSlot(rating);
        return Array.from(streams.values()).filter(s => getRating(s.url, s.fileName) === rating);
    }

    /**
     * Get streams with any rating (rated streams)
     * Checks both URL-based and fileName-based ratings
     */
    function getRatedStreams() {
        return Array.from(streams.values()).filter(s => {
            return getRating(s.url, s.fileName) > 0;
        });
    }

    /**
     * Get count of streams with a specific rating
     * Checks both URL-based and fileName-based ratings
     */
    function getRatingCount(rating) {
        rating = clampRatingSlot(rating);
        if (rating === 0) {
            return Array.from(streams.values()).filter(s => {
                return getRating(s.url, s.fileName) === 0;
            }).length;
        }
        return getStreamsByRating(rating).length;
    }

    /**
     * Get all rating counts
     */
    function getAllRatingCounts() {
        const counts = { 0: 0, 1: 0, 2: 0, 3: 0, 4: 0, 5: 0, 6: 0, 7: 0, 8: 0, 9: 0 };
        streams.forEach(stream => {
            const rating = getRating(stream.url, stream.fileName);
            counts[rating] = (counts[rating] || 0) + 1;
        });
        return counts;
    }

    /**
     * Distribute ratings evenly across all unrated streams
     * Assigns ratings 1-9 in a round-robin fashion to streams without saved ratings
     * Only assigns if stream doesn't already have a saved rating
     * @returns {number} Number of streams that were assigned ratings
     */
    function distributeRatingsEvenly() {
        // Auto-assign slots 1-9 only when a stream has no saved slot yet.
        // We balance across 1..9 (slot 0 remains "unrated").
        const unratedStreams = Array.from(streams.values()).filter(s => getRating(s.url, s.fileName) === 0);

        if (unratedStreams.length === 0) {
            return 0;
        }

        const counts = getAllRatingCounts();

        // Deterministic balancing: always choose the currently least-populated slot.
        // Tie-breaker: smallest slot number.
        unratedStreams.forEach((stream) => {
            let bestSlot = 1;
            let bestCount = Number.POSITIVE_INFINITY;
            for (let slot = 1; slot <= 9; slot++) {
                const c = counts[slot] || 0;
                if (c < bestCount) {
                    bestCount = c;
                    bestSlot = slot;
                }
            }
            setRating(stream.id, bestSlot);
            counts[bestSlot] = (counts[bestSlot] || 0) + 1;
        });

        return unratedStreams.length;
    }

    /**
     * Save ratings to localStorage
     * Saves both URL-based ratings and fileName-based ratings (for blob URLs)
     */
    function saveRatings() {
        const obj = {};
        // Save URL-based ratings
        ratings.forEach((rating, url) => {
            obj[url] = rating;
        });
        localStorage.setItem('plexd_ratings', JSON.stringify(obj));

        // Save fileName-based ratings separately (for blob URLs)
        const fileNameObj = {};
        fileNameRatings.forEach((rating, fileName) => {
            fileNameObj[fileName] = rating;
        });
        localStorage.setItem('plexd_fileName_ratings', JSON.stringify(fileNameObj));
    }

    /**
     * Load ratings from localStorage
     * Loads both URL-based ratings and fileName-based ratings (for blob URLs)
     */
    function loadRatings() {
        // Load URL-based ratings
        const saved = localStorage.getItem('plexd_ratings');
        if (saved) {
            const obj = JSON.parse(saved);
            ratings.clear();
            Object.keys(obj).forEach(url => {
                ratings.set(url, clampRatingSlot(obj[url]));
            });
        }

        // Load fileName-based ratings (for blob URLs)
        const savedFileNames = localStorage.getItem('plexd_fileName_ratings');
        if (savedFileNames) {
            const obj = JSON.parse(savedFileNames);
            fileNameRatings.clear();
            Object.keys(obj).forEach(fileName => {
                fileNameRatings.set(fileName, obj[fileName]);
            });
        }

        // Migrate old favorites to 5-star ratings
        const oldFavorites = localStorage.getItem('plexd_favorites');
        if (oldFavorites) {
            const urls = JSON.parse(oldFavorites);
            urls.forEach(url => {
                if (!ratings.has(url)) {
                    ratings.set(url, 5); // Migrate favorites to slot 5
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
     * Checks both URL-based and fileName-based ratings
     */
    function syncRatingStatus() {
        streams.forEach(stream => {
            const rating = getRating(stream.url, stream.fileName);

            for (let i = 1; i <= 9; i++) {
                stream.wrapper.classList.toggle(`plexd-rated-${i}`, rating === i);
            }
            stream.wrapper.classList.toggle('plexd-rated', rating > 0);
            updateRatingDisplay(stream);
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
            // Exited true fullscreen - clean up all fullscreen state
            // Remove fullscreen class from all streams (defensive)
            streams.forEach(stream => {
                if (stream.wrapper.classList.contains('plexd-fullscreen')) {
                    stream.wrapper.classList.remove('plexd-fullscreen');
                }
            });
            fullscreenStreamId = null;
            fullscreenMode = 'none';
            setAppFocusedMode(false);
            // Resource saving: resume streams that were auto-paused for focus
            clearFocusResourcePolicy();
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
        resetFullscreenState,
        pauseAll,
        playAll,
        pauseStream,
        resumeStream,
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
        // Spatial navigation helper (used by app.js for focused mode switching)
        getSpatialNeighborStreamId,
        setGridCols,
        getGridCols,
        updateLayoutOrder,
        getLayoutOrder,
        getLayoutRows,
        reorderStreams,
        seekRelative,
        seekTo,
        seekToRandomPosition,
        seekAllToRandomPosition,
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
        stopHealthMonitoring,
        // Local file detection
        isLocalFile
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlexdStream;
}
