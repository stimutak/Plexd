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

    // Audio focus mode - when true, audio follows stream selection
    // Unmuting any stream mutes others, and selecting a stream transfers audio to it
    // Load from localStorage, default to false (audio off by default)
    let audioFocusMode = localStorage.getItem('plexd_audio_focus') === 'true';

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

    // Favorites map - stores stream URL -> boolean (flagged as favorite)
    // For blob URLs (local files), also stores fileName -> boolean for persistence
    const favorites = new Map();
    const fileNameFavorites = new Map(); // fileName -> boolean for blob URLs

    // Callback for favorites updates
    let favoritesUpdateCallback = null;

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
        stallTimeout: 6000,               // Consider stalled after 6s no progress
        bufferEmptyTimeout: 10000,        // Timeout for empty buffer
        hlsRecoveryDelay: 500,            // Delay before HLS recovery attempt
        enableAutoRecovery: true,         // Master switch for auto-recovery
        stablePlaybackThreshold: 10000    // Must play 10s before retryCount resets
    };

    // Health monitoring state
    let healthCheckInterval = null;
    let isPageVisible = true;
    let monitoringStartedAt = 0;
    const LOAD_GRACE_PERIOD = 60000; // 60s grace period after monitoring starts

    // Global recovery throttle — prevent thundering herd when many streams stall
    const MAX_CONCURRENT_RECOVERIES = 3;
    let activeRecoveryCount = 0;
    const recoveryQueue = []; // { stream, reason } waiting for a slot

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
        video.muted = options.muted !== false; // Muted by default for autoplay
        video.loop = options.loop || false;
        video.playsInline = true; // Required for iOS
        if (options.deferred) {
            video.autoplay = false;
            video.preload = 'none';
        } else {
            video.autoplay = options.autoplay !== false;
        }

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

        // Create favorite indicator (tappable on touch devices)
        const favoriteIndicator = document.createElement('div');
        favoriteIndicator.className = 'plexd-favorite-indicator';
        favoriteIndicator.innerHTML = '☆'; // Show empty star initially
        favoriteIndicator.title = 'Like (L)';
        favoriteIndicator.onclick = (e) => {
            e.stopPropagation();
            toggleFavorite(id);
        };

        // Selected badge (purely visual; CSS controls when it shows)
        // This makes it obvious which stream will be acted upon (Enter/Z/etc).
        const selectedBadge = document.createElement('div');
        selectedBadge.className = 'plexd-selected-badge';
        selectedBadge.textContent = 'SELECTED';

        // Moment count badge (gold diamond, shows count of moments for this stream)
        const momentBadge = document.createElement('div');
        momentBadge.className = 'plexd-moment-badge';

        // Assemble
        wrapper.appendChild(video);
        wrapper.appendChild(controls);
        wrapper.appendChild(infoOverlay);
        wrapper.appendChild(ratingIndicator);
        wrapper.appendChild(favoriteIndicator);
        wrapper.appendChild(selectedBadge);
        wrapper.appendChild(momentBadge);

        // Make draggable and focusable (for keyboard in fullscreen)
        wrapper.draggable = true;
        wrapper.dataset.streamId = id;
        wrapper.tabIndex = 0; // Makes it focusable

        // For cross-origin URLs, route through our proxy to bypass CORS
        const sourceUrl = getProxiedHlsUrl(url);

        // Enable CORS on video element for proxied URLs so canvas capture (thumbnails) works
        if (sourceUrl.startsWith('/api/proxy/')) video.crossOrigin = 'anonymous';

        // Stream state
        const stream = {
            id,
            url,       // Original URL (for display, dedup, saving)
            sourceUrl, // Actual URL to load (may be proxied)
            wrapper,
            video,
            controls,
            infoOverlay,
            momentBadge,
            hls: null, // HLS.js instance if used
            hlsFallbackAttempted: false, // Track if we already tried HLS fallback
            aspectRatio: DEFAULT_ASPECT_RATIO,
            state: 'loading', // loading, playing, paused, buffering, error, recovering
            error: null,
            hidden: false, // Whether stream is hidden from grid view
            // Recovery state
            recovery: {
                retryCount: 0,
                lastRetryTime: 0,
                isRecovering: false,
                retryTimer: null,
                lastReason: null
            },
            // Health monitoring state
            health: {
                lastTimeUpdate: Date.now(),
                lastCurrentTime: 0,
                stallStartTime: null,
                bufferEmptyStartTime: null,
                consecutiveStalls: 0,
                playbackResumedAt: null
            },
            hasEverPlayed: false, // Set true on first 'playing' event
            // Pan position for Tetris mode (object-position as percentages, 50/50 = center)
            panPosition: { x: 50, y: 50 },
            // Cleanup functions for document-level event listeners
            cleanupListeners: []
        };

        // Set up event listeners
        setupVideoEvents(stream);

        if (!options.deferred) {
            _loadStreamSource(stream);
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
     * Activate a deferred stream — set autoplay and load source
     */
    function activateStream(streamId) {
        var stream = streams.get(streamId);
        if (!stream || stream.video.src || stream.hls) return;
        stream.video.autoplay = true;
        _loadStreamSource(stream);
    }

    /**
     * Load the video source for a stream (set src / create HLS instance)
     */
    function _loadStreamSource(stream) {
        var url = stream.url;
        var sourceUrl = stream.sourceUrl;
        var video = stream.video;

        if (isHlsUrl(url) && typeof Hls !== 'undefined' && Hls.isSupported()) {
            var hls = createHlsInstance(stream, sourceUrl);
            stream.hls = hls;
        } else if (isHlsUrl(url) && video.canPlayType('application/vnd.apple.mpegurl')) {
            video.src = sourceUrl;
            video.addEventListener('canplay', function onCanPlay() {
                video.removeEventListener('canplay', onCanPlay);
                video.play().catch(function() {});
            }, { once: true });
        } else {
            video.src = sourceUrl;
            video.addEventListener('canplay', function onCanPlay() {
                video.removeEventListener('canplay', onCanPlay);
                video.play().catch(function() {});
            }, { once: true });
        }
    }

    /**
     * Check if URL is an HLS stream
     * Detects both explicit .m3u8 extensions and common streaming endpoints
     */
    function isHlsUrl(url) {
        const lowerUrl = url.toLowerCase();

        // Explicit HLS extension
        if (lowerUrl.includes('.m3u8')) return true;

        // Common streaming server patterns that serve HLS without the .m3u8 extension
        // NOTE: /stream endpoints (Stash, etc.) serve raw MP4, NOT HLS — don't include them
        const hlsPatterns = [
            /\/live$/i,             // /live endpoint
            /\/live\?/i,            // /live with query params
            /\/playlist$/i,         // /playlist endpoint
            /\/master$/i,           // /master playlist
            /\/hls\//i              // /hls/ in path
        ];

        return hlsPatterns.some(pattern => pattern.test(url));
    }

    /**
     * Get proxy URL for cross-origin streams.
     * Routes external HLS through /api/proxy/hls, other video through /api/proxy/video.
     */
    function getProxiedHlsUrl(url) {
        // Skip non-http URLs and already-proxied paths early
        if (url.startsWith('/api/proxy/') || url.startsWith('blob:') || url.startsWith('data:')) return url;

        try {
            const urlObj = new URL(url);
            // Don't proxy our own server or local URLs
            if (urlObj.hostname === 'localhost' ||
                urlObj.hostname === '127.0.0.1' ||
                urlObj.hostname === '[::1]' ||
                urlObj.hostname === window.location.hostname) {
                return url;
            }
        } catch {
            return url;
        }

        // HLS gets the manifest-rewriting proxy
        if (url.toLowerCase().includes('.m3u8')) {
            return `/api/proxy/hls?url=${encodeURIComponent(url)}`;
        }

        // Everything else (MP4, streaming endpoints) gets the range-aware video proxy
        return `/api/proxy/video?url=${encodeURIComponent(url)}`;
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

        // Base config optimized for reliable playback
        const config = {
            enableWorker: true,
            lowLatencyMode: false,         // Disabled: VOD/CDN content, not live streams
            autoStartLoad: true,
            startLevel: -1,
            capLevelToPlayerSize: false,
            // Recovery settings - aggressive retries for transient network issues
            manifestLoadingTimeOut: 15000,
            manifestLoadingMaxRetry: 6,
            manifestLoadingRetryDelay: 1000,
            levelLoadingTimeOut: 15000,
            levelLoadingMaxRetry: 6,
            levelLoadingRetryDelay: 1000,
            fragLoadingTimeOut: 30000,
            fragLoadingMaxRetry: 6,
            fragLoadingRetryDelay: 1000,
            // Buffer gap handling
            nudgeOffset: 0.1,
            nudgeMaxRetry: 5
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
            // Only reset isRecovering — retryCount resets via stablePlaybackThreshold
            // in the timeupdate handler after 10s of sustained playback
            stream.recovery.isRecovering = false;
            releaseRecoverySlot();
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
            // Only mark as completed if we're actually near the end of the video
            // BUFFER_EOS can fire prematurely due to buffer gaps or errors
            const video = stream.video;
            const duration = video.duration;
            if (duration && Number.isFinite(duration) && duration > 0) {
                const remaining = duration - video.currentTime;
                if (remaining < 5) {
                    stream.state = 'paused';
                } else {
                    console.log(`[${stream.id}] BUFFER_EOS fired with ${remaining.toFixed(1)}s remaining - ignoring premature EOS`);
                }
            } else {
                stream.state = 'paused';
            }
        });

        // Fragment loading progress - indicates healthy streaming
        hls.on(Hls.Events.FRAG_LOADED, () => {
            // Reset health indicators on successful fragment load
            stream.health.consecutiveStalls = 0;
            // Don't change state here - let the 'playing' event handle that
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
                // Media errors - route through scheduleRecovery for proper retryCount tracking
                console.log(`[${stream.id}] Media error - scheduling recovery`);
                scheduleRecovery(stream, 'media_error');
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
     * Schedule recovery with exponential backoff + global concurrency limit.
     * Prevents thundering herd when many streams stall simultaneously.
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
        stream.recovery.lastReason = reason;
        stream.state = 'recovering';
        stream.wrapper.dataset.recovering = 'true';
        updateStreamInfo(stream);

        // Calculate delay with exponential backoff + random jitter to spread load
        const baseDelay = Math.min(
            RECOVERY_CONFIG.baseRetryDelay * Math.pow(2, stream.recovery.retryCount - 1),
            RECOVERY_CONFIG.maxRetryDelay
        );
        const jitter = Math.random() * baseDelay * 0.5;
        const delay = baseDelay + jitter;

        // Clear any existing retry timer
        if (stream.recovery.retryTimer) {
            clearTimeout(stream.recovery.retryTimer);
        }

        stream.recovery.retryTimer = setTimeout(() => {
            stream.recovery.lastRetryTime = Date.now();
            // Check global concurrency limit before proceeding
            if (activeRecoveryCount >= MAX_CONCURRENT_RECOVERIES) {
                // Queue this recovery for later
                recoveryQueue.push({ stream, reason });
                return;
            }
            activeRecoveryCount++;
            performRecovery(stream);
        }, delay);
    }

    /**
     * Process next queued recovery if a slot is available
     */
    function drainRecoveryQueue() {
        while (recoveryQueue.length > 0 && activeRecoveryCount < MAX_CONCURRENT_RECOVERIES) {
            var next = recoveryQueue.shift();
            if (!next.stream || !streams.has(next.stream.id) || !next.stream.recovery.isRecovering) continue;
            activeRecoveryCount++;
            performRecovery(next.stream);
        }
    }

    /**
     * Release a recovery slot and process queue
     */
    function releaseRecoverySlot() {
        if (activeRecoveryCount > 0) activeRecoveryCount--;
        drainRecoveryQueue();
    }

    /**
     * Perform actual stream recovery
     */
    function performRecovery(stream) {
        const attempt = stream.recovery.retryCount;
        const video = stream.video;
        const savedTime = video.currentTime || 0;
        console.log(`[${stream.id}] Recovery attempt ${attempt} at ${savedTime.toFixed(1)}s`);

        // Reset health monitoring so watchdog doesn't immediately re-trigger
        stream.health.stallStartTime = null;
        stream.health.bufferEmptyStartTime = null;
        stream.health.lastTimeUpdate = Date.now();

        // Remove any existing error overlay
        const errorOverlay = stream.wrapper.querySelector('.plexd-error-overlay');
        if (errorOverlay) {
            errorOverlay.remove();
        }

        // Reset error state
        stream.error = null;

        // Attempt 1-2: Try HLS-level recovery first (faster, preserves buffer)
        if (attempt <= 2 && stream.hls) {
            try {
                const reason = stream.recovery.lastReason || '';
                if (reason === 'media_error') {
                    // Media/codec errors: recreate SourceBuffers
                    console.log(`[${stream.id}] Media error recovery: calling recoverMediaError()`);
                    stream.hls.recoverMediaError();
                } else {
                    // Network errors, stalls, frozen video: restart fragment loading
                    // recoverMediaError() won't help here — it only recreates SourceBuffers
                    console.log(`[${stream.id}] Recovery (${reason}): calling startLoad()`);
                    stream.hls.startLoad();
                }
                // Keep isRecovering = true until 'playing' event fires
                stream.state = 'recovering';
                updateStreamInfo(stream);

                // If stuck at same position, nudge forward
                setTimeout(() => {
                    if (video.paused || Math.abs(video.currentTime - savedTime) < 0.1) {
                        video.currentTime = savedTime + 0.5;
                        video.play().catch(() => {});
                    }
                }, 1000);
                // Safety timeout: release slot if playing event never fires (source offline)
                setTimeout(() => {
                    if (stream.recovery.isRecovering && stream.state === 'recovering') {
                        console.log(`[${stream.id}] HLS recovery timed out after 15s, releasing slot`);
                        stream.recovery.isRecovering = false;
                        releaseRecoverySlot();
                        delete stream.wrapper.dataset.recovering;
                    }
                }, 15000);
                return;
            } catch (e) {
                console.log(`[${stream.id}] HLS recovery failed (${stream.recovery.lastReason}), doing full reload`);
            }
        }

        // Attempt 3+: Full reload with seek to last position
        if (stream.hls) {
            stream.hls.destroy();
            stream.hls = null;
        }

        video.removeAttribute('src');
        video.load();

        setTimeout(() => {
            // Guard against stream being removed during the 200ms window
            if (!streams.has(stream.id)) return;
            const loadUrl = stream.sourceUrl || stream.url;
            if (isHlsUrl(stream.url) && typeof Hls !== 'undefined' && Hls.isSupported()) {
                const hls = createHlsInstance(stream, loadUrl);
                stream.hls = hls;

                // After manifest loads, seek to where we were (skip past the stall point)
                const onRecoveryManifest = () => {
                    hls.off(Hls.Events.MANIFEST_PARSED, onRecoveryManifest);
                    if (savedTime > 1) {
                        // Seek slightly ahead to skip any problematic segment
                        video.currentTime = savedTime + 2;
                    }
                };
                hls.on(Hls.Events.MANIFEST_PARSED, onRecoveryManifest);
            } else if (isHlsUrl(stream.url) && video.canPlayType('application/vnd.apple.mpegurl')) {
                video.src = loadUrl;
                video.addEventListener('loadedmetadata', () => {
                    if (savedTime > 1) video.currentTime = savedTime + 2;
                }, { once: true });
                video.play().catch(() => {});
            } else {
                video.src = stream.url;
                video.load();
                video.addEventListener('loadedmetadata', () => {
                    if (savedTime > 1) video.currentTime = savedTime + 2;
                }, { once: true });
                video.play().catch(() => {});
            }

            stream.recovery.isRecovering = false;
            releaseRecoverySlot();
            stream.state = 'loading';
            delete stream.wrapper.dataset.recovering;
            updateStreamInfo(stream);
        }, 200);
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
     * Get user-friendly error description
     */
    function getErrorDescription(error, stream) {
        if (!error) return { title: 'Error', message: 'Stream failed to load', detail: '' };

        const url = stream?.url || '';
        const isHls = url.includes('.m3u8') || url.includes('/api/hls/');
        const isLocal = url.startsWith('blob:') || url.includes('/api/files/');

        // Parse error string for better messages
        const errLower = error.toLowerCase();

        if (errLower.includes('network')) {
            return {
                title: 'Connection Failed',
                message: isLocal ? 'Could not load file from server' : 'Network connection failed',
                detail: 'Check if server is running'
            };
        }
        if (errLower.includes('not supported') || errLower.includes('decode')) {
            return {
                title: 'Format Error',
                message: 'This video format cannot be played',
                detail: isHls ? 'HLS stream may be corrupted' : 'Try transcoding to HLS'
            };
        }
        if (errLower.includes('aborted')) {
            return {
                title: 'Cancelled',
                message: 'Playback was interrupted',
                detail: ''
            };
        }
        if (errLower.includes('hls error')) {
            return {
                title: 'Stream Error',
                message: 'HLS playback failed',
                detail: error.replace('HLS Error:', '').trim()
            };
        }
        if (errLower.includes('retries')) {
            return {
                title: 'Max Retries',
                message: 'Stream failed after multiple attempts',
                detail: 'May be offline or unavailable'
            };
        }

        return {
            title: 'Playback Error',
            message: error,
            detail: ''
        };
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

        const { title, message, detail } = getErrorDescription(stream.error, stream);

        const errorOverlay = document.createElement('div');
        errorOverlay.className = 'plexd-error-overlay';
        errorOverlay.innerHTML = `
            <div class="plexd-error-actions">
                <button class="plexd-error-retry" title="Try loading again">Retry</button>
                <button class="plexd-error-close" title="Remove this stream">Close</button>
            </div>
            <div class="plexd-error-content">
                <div class="plexd-error-title">${title}</div>
                <div class="plexd-error-msg">${message}</div>
                ${detail ? `<div class="plexd-error-detail">${detail}</div>` : ''}
            </div>
        `;
        errorOverlay.querySelector('.plexd-error-retry').onclick = (e) => {
            e.stopPropagation();
            stream.recovery.retryCount = 0;
            stream.recovery.isRecovering = true;
            activeRecoveryCount++;
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

        var momentDotsContainer = document.createElement('div');
        momentDotsContainer.className = 'plexd-moment-dots';

        seekContainer.appendChild(seekBar);
        seekContainer.appendChild(momentDotsContainer);
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
            ? 'Toggle audio (focus ON: audio follows selection)'
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

        // Download button
        const downloadBtn = document.createElement('button');
        downloadBtn.className = 'plexd-btn plexd-download-btn';
        downloadBtn.innerHTML = '⬇';
        downloadBtn.title = 'Download stream (D)';
        downloadBtn.onclick = (e) => {
            e.stopPropagation();
            if (window.PlexdApp && PlexdApp.downloadStream) {
                PlexdApp.downloadStream(streamId);
            }
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
        buttonRow.appendChild(downloadBtn);
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
        let attempts = 0;

        // Get seekable range - prefer duration over seekable for full range
        const getSeekRange = () => {
            // For HLS streams, try to get duration from hls.js first
            if (stream.hls && stream.hls.media) {
                const hlsDuration = stream.hls.media.duration;
                if (hlsDuration && isFinite(hlsDuration) && hlsDuration > 0) {
                    return { start: 0, end: hlsDuration };
                }
            }

            // Check video.duration - must be finite and reasonable
            if (video.duration && isFinite(video.duration) && video.duration > 1) {
                return { start: 0, end: video.duration };
            }

            // Fallback to seekable ranges (may be limited for live streams)
            if (video.seekable && video.seekable.length > 0) {
                const start = video.seekable.start(0);
                const end = video.seekable.end(video.seekable.length - 1);
                // Only use if range is reasonable (more than 10 seconds)
                if (end - start > 10) {
                    return { start, end };
                }
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
                } catch (e) { /* autoplay policy — expected */ }
            }
            return !video.paused;
        }

        const getRandomPosition = () => {
            // Simple random position - skip first and last 5% to avoid edges
            const safeStart = range.start + (range.end - range.start) * 0.05;
            const safeEnd = range.end - (range.end - range.start) * 0.05;
            const safeRange = safeEnd - safeStart;

            // Pure random within safe range
            const position = safeStart + Math.random() * safeRange;
            console.log(`[Random Seek] Range: ${range.start.toFixed(1)}-${range.end.toFixed(1)}s, Position: ${position.toFixed(1)}s`);
            return position;
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
            } catch (e) { console.warn('[Stream] HLS recovery attempt failed:', e.message); }
        }

        return false;
    }

    /**
     * Seek all streams to random positions
     * @returns {Promise<number>} - Number of streams successfully started
     */
    async function seekAllToRandomPosition(targetStreams) {
        const streamList = targetStreams || Array.from(streams.values());
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

        const url = stream.sourceUrl || stream.url;
        const originalUrl = stream.url;
        const currentTime = stream.video.currentTime || 0;
        const streamFileName = stream.fileName || '';

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
        .dl-btn {
            position: fixed; bottom: 8px; right: 8px; z-index: 10;
            background: rgba(0,0,0,0.7); color: #fff; border: 1px solid #555;
            border-radius: 6px; padding: 6px 12px; cursor: pointer; font-size: 14px;
            opacity: 0; transition: opacity 0.2s;
        }
        body:hover .dl-btn { opacity: 1; }
        .dl-btn:hover { background: rgba(60,60,60,0.9); }
    </style>
</head>
<body>
    <video id="video" autoplay controls></video>
    <button class="dl-btn" id="dlBtn" title="Download stream">&#x2B07; Download</button>
    <script src="https://cdn.jsdelivr.net/npm/hls.js@latest"></script>
    <script>
        const video = document.getElementById('video');
        const url = ${JSON.stringify(url)};
        const originalUrl = ${JSON.stringify(originalUrl)};
        const fileName = ${JSON.stringify(streamFileName)} || 'stream';
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

        document.getElementById('dlBtn').onclick = async () => {
            const btn = document.getElementById('dlBtn');
            btn.textContent = 'Downloading...';
            try {
                // Try server file first
                // Server file: download original
                const m = (originalUrl || url).match(/\\/api\\/(files|hls)\\/([^/?]+)/);
                if (m) {
                    const r = await fetch('/api/files/' + encodeURIComponent(m[2]));
                    if (r.ok) {
                        const b = await r.blob();
                        const a = document.createElement('a');
                        a.href = URL.createObjectURL(b);
                        a.download = fileName.replace(/\\.m3u8$/, '.mp4') || 'video.mp4';
                        a.click();
                        URL.revokeObjectURL(a.href);
                        btn.textContent = 'Downloaded!';
                        setTimeout(() => btn.innerHTML = '&#x2B07; Download', 2000);
                        return;
                    }
                }
                // HLS stream: use server ffmpeg to remux into MP4
                const srcUrl = originalUrl || url;
                if (srcUrl.includes('.m3u8')) {
                    const a = document.createElement('a');
                    a.href = '/api/proxy/hls/download?url=' + encodeURIComponent(srcUrl) + '&name=' + encodeURIComponent(fileName);
                    a.download = (fileName || 'video').replace(/\\.m3u8$/, '') + '.mp4';
                    a.click();
                    btn.textContent = 'Downloading...';
                    setTimeout(() => btn.innerHTML = '&#x2B07; Download', 3000);
                    return;
                }
                // Regular URL: try direct fetch
                const r = await fetch(url);
                if (r.ok) {
                    const b = await r.blob();
                    const a = document.createElement('a');
                    a.href = URL.createObjectURL(b);
                    a.download = fileName || 'video.mp4';
                    a.click();
                    URL.revokeObjectURL(a.href);
                    btn.textContent = 'Downloaded!';
                } else {
                    btn.textContent = 'Failed';
                }
            } catch(e) {
                btn.textContent = 'Failed';
            }
            setTimeout(() => btn.innerHTML = '&#x2B07; Download', 2000);
        };
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
                idle: '◻️',
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
    let fullscreenKeyHandler = null; // Capture-phase handler for fullscreen keyboard events

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
                if (!isPausedGlobally) {
                    // Always try to play the focused stream
                    if (s.video && s.video.paused) {
                        resumeStream(id);
                    }
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
            // Save whether auto-level was active (currentLevel === -1 means auto)
            stream._plexdPrevHlsCurrentLevel = stream.hls.currentLevel;
            // Force lowest quality while unfocused
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
            if (typeof stream._plexdPrevHlsCurrentLevel === 'number') {
                // Restore previous level (-1 re-enables auto level selection)
                stream.hls.currentLevel = stream._plexdPrevHlsCurrentLevel;
            } else {
                // Default: re-enable auto level selection
                stream.hls.currentLevel = -1;
            }
        } catch (_) {
            // Best-effort only.
        } finally {
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
            // Select this stream (triggers audio follow if audio focus is on)
            selectStream(streamId);
            // Resource saving: pause other streams while focused
            applyFocusResourcePolicy(streamId);
        }
        triggerLayoutUpdate();
    }

    /**
     * Enter focused mode on a stream (used from grid mode in true fullscreen)
     */
    function enterFocusedMode(streamId) {
        console.log(`[Plexd] enterFocusedMode: entering with streamId=${streamId}, current fullscreenStreamId=${fullscreenStreamId}`);
        const stream = streams.get(streamId);
        if (!stream) {
            console.log('[Plexd] enterFocusedMode: stream not found, aborting');
            return;
        }

        // Blur any focused input to enable keyboard shortcuts
        if (document.activeElement && document.activeElement.tagName === 'INPUT') {
            document.activeElement.blur();
        }

        // Exit any existing browser-fill fullscreen
        if (fullscreenStreamId && fullscreenStreamId !== streamId) {
            const prevStream = streams.get(fullscreenStreamId);
            console.log(`[Plexd] enterFocusedMode: removing plexd-fullscreen from ${fullscreenStreamId}, prevStream exists: ${!!prevStream}`);
            if (prevStream) {
                prevStream.wrapper.classList.remove('plexd-fullscreen');
                console.log(`[Plexd] enterFocusedMode: ${fullscreenStreamId} now has plexd-fullscreen: ${prevStream.wrapper.classList.contains('plexd-fullscreen')}`);
            }
        }

        // Apply CSS fullscreen to this stream
        console.log(`[Plexd] enterFocusedMode: adding plexd-fullscreen to ${streamId}`);
        stream.wrapper.classList.add('plexd-fullscreen');
        // Clear inline object-fit set by grid layout — CSS rule handles focused mode default
        stream.video.style.objectFit = '';
        stream.video.style.objectPosition = '';
        stream.video.style.transform = '';
        stream.video.style.transformOrigin = '';
        console.log(`[Plexd] enterFocusedMode: ${streamId} now has plexd-fullscreen: ${stream.wrapper.classList.contains('plexd-fullscreen')}`);
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
     * Always fullscreens the container, not individual wrappers, to allow arrow navigation
     */
    function toggleTrueFullscreen(streamId) {
        if (document.fullscreenElement) {
            // Exit true fullscreen completely
            exitTrueFullscreen();
        } else if (streamId) {
            // Enter true fullscreen focused on a specific stream
            // Use enterTrueFocusedFullscreen which fullscreens the container (not wrapper)
            enterTrueFocusedFullscreen(streamId);
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

        // Add capture-phase keyboard listener on container for fullscreen mode
        if (fullscreenKeyHandler) {
            container.removeEventListener('keydown', fullscreenKeyHandler, true);
        }
        fullscreenKeyHandler = (e) => {
            console.log(`[Plexd] Fullscreen container capture: key=${e.key}, target=${e.target.tagName}`);
            if (e.key.startsWith('Arrow')) {
                e.preventDefault();
                e.stopPropagation();
                console.log(`[Plexd] Fullscreen capture: dispatching ${e.key} to document`);
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
            }
        };
        container.addEventListener('keydown', fullscreenKeyHandler, true);

        container.requestFullscreen().then(() => {
            fullscreenMode = 'true-grid';
            container.focus();
            triggerLayoutUpdate();
        }).catch(err => {
            console.log('Grid fullscreen request failed:', err);
        });
    }

    /**
     * Enter true fullscreen while staying focused on a specific stream
     * Used when upgrading from browser-fill to true-focused
     */
    function enterTrueFocusedFullscreen(streamId) {
        console.log(`[Plexd] enterTrueFocusedFullscreen: streamId=${streamId}`);
        const container = document.querySelector('.plexd-app');
        const stream = streams.get(streamId);
        if (!container || !stream) {
            console.log(`[Plexd] enterTrueFocusedFullscreen: container=${!!container}, stream=${!!stream} - aborting`);
            return;
        }

        // Keep the focused stream state
        stream.wrapper.classList.add('plexd-fullscreen');
        fullscreenStreamId = streamId;
        setAppFocusedMode(true);
        console.log(`[Plexd] enterTrueFocusedFullscreen: set fullscreenStreamId=${fullscreenStreamId}, added plexd-fullscreen class`);

        container.tabIndex = 0;

        // Add capture-phase keyboard listener on container for fullscreen mode
        // This ensures we intercept keys before browser can consume them
        if (fullscreenKeyHandler) {
            container.removeEventListener('keydown', fullscreenKeyHandler, true);
        }
        fullscreenKeyHandler = (e) => {
            console.log(`[Plexd] Fullscreen container capture: key=${e.key}, target=${e.target.tagName}`);

            // Handle arrow keys with capture to ensure they work in fullscreen
            if (e.key.startsWith('Arrow')) {
                e.preventDefault();
                e.stopPropagation();
                console.log(`[Plexd] Fullscreen capture: dispatching ${e.key} to document`);
                // Dispatch to document for app.js to handle
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
            }
        };
        container.addEventListener('keydown', fullscreenKeyHandler, true); // capture phase

        container.requestFullscreen().then(() => {
            fullscreenMode = 'true-focused';
            console.log(`[Plexd] enterTrueFocusedFullscreen: requestFullscreen succeeded, mode=${fullscreenMode}`);
            // Focus the container itself to receive keyboard events
            container.focus();
            triggerLayoutUpdate();
        }).catch(err => {
            console.log('True focused fullscreen request failed:', err);
        });
    }

    /**
     * Exit true fullscreen completely
     */
    function exitTrueFullscreen() {
        if (!document.fullscreenElement) return;

        // Clean up fullscreen key handler
        const container = document.querySelector('.plexd-app');
        if (container && fullscreenKeyHandler) {
            container.removeEventListener('keydown', fullscreenKeyHandler, true);
            fullscreenKeyHandler = null;
        }

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
            console.log(`[Plexd] Fullscreen state inconsistent (stream=${!!stream}, hasClass=${stream?.wrapper?.classList?.contains('plexd-fullscreen')}), cleaning up`);
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

        // Select the new stream (triggers audio follow if audio focus is on)
        selectStream(newStream.id);

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

                // Reset retryCount only after sustained stable playback
                if (stream.recovery.retryCount > 0 && stream.health.playbackResumedAt) {
                    const playingFor = Date.now() - stream.health.playbackResumedAt;
                    if (playingFor > RECOVERY_CONFIG.stablePlaybackThreshold) {
                        stream.recovery.retryCount = 0;
                        stream.health.playbackResumedAt = null;
                    }
                }
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

        // Double-click to toggle focus mode
        wrapper.addEventListener('dblclick', () => {
            if (fullscreenMode === 'browser-fill' && fullscreenStreamId === stream.id) {
                toggleFullscreen(stream.id); // Exit focus
            } else {
                enterFocusedMode(stream.id); // Enter focus
            }
        });

        // Keyboard handling on wrapper (for fullscreen mode)
        // Note: Arrow keys and most keys are handled by app.js
        // This handler catches keys when the wrapper has focus (in true-focused mode)
        wrapper.addEventListener('keydown', (e) => {
            // Priority: focused wrapper handles events. If this wrapper is the fullscreenElement
            // but another stream wrapper has focus, let the focused one handle it to avoid double-processing.
            const activeEl = document.activeElement;
            const isThisFocused = activeEl === wrapper;
            const isThisFullscreen = document.fullscreenElement === wrapper;

            // If we're not focused and not fullscreen element, skip
            if (!isThisFocused && !isThisFullscreen) return;

            // If we're the fullscreen element but ANOTHER stream wrapper has focus, skip
            if (isThisFullscreen && !isThisFocused && activeEl && activeEl.classList.contains('plexd-stream')) return;

            // Only process keys here when in focused/fullscreen mode
            // In grid mode (fullscreenMode === 'none'), let events bubble naturally to document
            if (fullscreenMode !== 'true-focused' && fullscreenMode !== 'browser-fill') {
                // Not in fullscreen mode - don't interfere, let event bubble to document
                return;
            }

            // Number keys (0-9), arrow keys, seeking/random keys, Escape, and B should propagate to document handler
            // for rating filter/assignment, stream navigation, seeking, random seek, Bug Eye, Mosaic, etc.
            // In true fullscreen, we need to manually dispatch since document may be outside fullscreen context
            const propagateKeys = /^[0-9]$/.test(e.key) || e.key.startsWith('Arrow') || /^[,.<>/?bBqQlL;:wWtToOaAeErRxXjJkK'nNmMgGvVhHiIpPcCdDsS=`÷+\-\[\]{}]$/.test(e.key) || e.key === 'Escape' || e.key === ' ' || e.key === 'Tab' || e.key === 'Delete' || e.key === 'Backspace' || e.key === 'Enter';
            if (propagateKeys) {
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
                // Space and Enter are propagated to document via propagateKeys above
                case 'z':
                case 'Z':
                    // Z in focused mode: toggle back to grid
                    e.preventDefault();
                    e.stopPropagation(); // Prevent app.js from re-entering focused mode
                    exitFocusedMode();
                    break;
                // Escape is now handled via propagateKeys dispatch to document
                // where app.js handles Bug Eye/Mosaic priority before fullscreen exit
                case 'f':
                case 'F':
                    e.preventDefault();
                    e.stopPropagation();
                    toggleTrueFullscreen(stream.id);
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
                e.stopPropagation(); // Prevent app-level file drop handler from interfering
                reorderStreams(draggedId, stream.id);
            }
        });

        // Pan-to-position in Tetris mode (drag to reposition video within cropped view)
        // Only active when object-fit: cover is applied (video is cropped)
        let isPanning = false;
        let panStartX = 0;
        let panStartY = 0;
        let panStartPosX = 50;
        let panStartPosY = 50;

        const startPan = (clientX, clientY) => {
            // Only allow panning in Tetris mode (when cell has cover fit)
            if (!wrapper.classList.contains('plexd-tetris-cell')) return false;

            isPanning = true;
            panStartX = clientX;
            panStartY = clientY;
            panStartPosX = stream.panPosition.x;
            panStartPosY = stream.panPosition.y;
            wrapper.classList.add('plexd-panning');
            wrapper.draggable = false; // Disable drag-to-reorder while panning
            return true;
        };

        const updatePan = (clientX, clientY) => {
            if (!isPanning) return;

            // Calculate delta as percentage of video dimensions
            // Moving mouse right should show more of the left side (decrease x%)
            // Moving mouse down should show more of the top (decrease y%)
            const rect = wrapper.getBoundingClientRect();
            const deltaX = (clientX - panStartX) / rect.width * 100;
            const deltaY = (clientY - panStartY) / rect.height * 100;

            // Invert: dragging right reveals left side (lower x%), dragging down reveals top (lower y%)
            const newX = Math.max(0, Math.min(100, panStartPosX - deltaX));
            const newY = Math.max(0, Math.min(100, panStartPosY - deltaY));

            stream.panPosition.x = newX;
            stream.panPosition.y = newY;
            video.style.objectPosition = `${newX}% ${newY}%`;
        };

        const endPan = () => {
            if (!isPanning) return;
            isPanning = false;
            wrapper.classList.remove('plexd-panning');
            wrapper.draggable = true; // Re-enable drag-to-reorder
        };

        // Mouse events for panning
        video.addEventListener('mousedown', (e) => {
            if (startPan(e.clientX, e.clientY)) {
                e.preventDefault();
                e.stopPropagation();
            }
        });

        // Document-level listeners for panning (stored for cleanup)
        const handleMouseMove = (e) => {
            if (isPanning) {
                updatePan(e.clientX, e.clientY);
            }
        };
        const handleMouseUp = () => {
            endPan();
        };

        document.addEventListener('mousemove', handleMouseMove);
        document.addEventListener('mouseup', handleMouseUp);

        // Store cleanup functions to remove document listeners when stream is destroyed
        stream.cleanupListeners.push(
            () => document.removeEventListener('mousemove', handleMouseMove),
            () => document.removeEventListener('mouseup', handleMouseUp)
        );

        // Touch events for panning
        video.addEventListener('touchstart', (e) => {
            // Only pan with single touch
            if (e.touches.length !== 1) return;
            if (startPan(e.touches[0].clientX, e.touches[0].clientY)) {
                // Don't prevent default - allow scrolling if not in Tetris mode
            }
        }, { passive: true });

        video.addEventListener('touchmove', (e) => {
            if (isPanning && e.touches.length === 1) {
                e.preventDefault(); // Prevent scrolling while panning
                updatePan(e.touches[0].clientX, e.touches[0].clientY);
            }
        }, { passive: false });

        video.addEventListener('touchend', () => {
            endPan();
        });

        video.addEventListener('touchcancel', () => {
            endPan();
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

            // For non-HLS streams, try automatic recovery.
            // Streams that have never played are likely connection-starved (Chrome
            // 6-per-host limit), not broken — don't burn retries on them.
            if (!stream.hls && RECOVERY_CONFIG.enableAutoRecovery) {
                // Local server files that 404 are permanently gone — don't retry
                const sourceUrl = stream.sourceUrl || stream.url || '';
                if (sourceUrl.startsWith('/api/files/')) {
                    console.log(`[${stream.id}] Server file not found — not retrying`);
                    showStreamError(stream);
                } else {
                    scheduleRecovery(stream, stream.error);
                }
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
            stream.error = null;
            stream.hasEverPlayed = true;
            // Reset health indicators on playback resumption
            stream.health.stallStartTime = null;
            stream.health.consecutiveStalls = 0;
            if (stream.recovery.isRecovering) releaseRecoverySlot();
            stream.recovery.isRecovering = false;
            delete stream.wrapper.dataset.recovering;
            // Remove error overlay — video recovered successfully
            const errOverlay = stream.wrapper.querySelector('.plexd-error-overlay');
            if (errOverlay) errOverlay.remove();
            // Only start the stable-playback clock once after recovery, not on every
            // playing event (buffering/rebuffering fires playing repeatedly)
            if (stream.recovery.retryCount > 0 && !stream.health.playbackResumedAt) {
                stream.health.playbackResumedAt = Date.now();
            }
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

        // If this stream is currently in fullscreen, switch to next stream before removing
        const wasFullscreen = fullscreenStreamId === streamId;
        const prevFullscreenMode = fullscreenMode;
        let nextStreamForFullscreen = null;

        if (wasFullscreen && streams.size > 1) {
            // Find next stream to show in fullscreen
            const streamList = Array.from(streams.values()).filter(s => !s.hidden);
            const currentIndex = streamList.findIndex(s => s.id === streamId);

            // Try next stream, or previous if at end
            if (currentIndex < streamList.length - 1) {
                nextStreamForFullscreen = streamList[currentIndex + 1];
            } else if (currentIndex > 0) {
                nextStreamForFullscreen = streamList[currentIndex - 1];
            }
        }

        // Clean up recovery timer and release global slot if pending
        if (stream.recovery.retryTimer) {
            clearTimeout(stream.recovery.retryTimer);
            stream.recovery.retryTimer = null;
        }
        if (stream.recovery.isRecovering) releaseRecoverySlot();
        stream.recovery.isRecovering = false;

        // Clean up HLS instance if present
        if (stream.hls) {
            stream.hls.destroy();
            stream.hls = null;
        }

        // Clean up transcode polling if active (PlexdApp tracks this)
        if (typeof PlexdApp !== 'undefined' && PlexdApp.stopTranscodePollForStream) {
            PlexdApp.stopTranscodePollForStream(stream);
        }

        // Clean up document-level event listeners (panning)
        if (stream.cleanupListeners) {
            stream.cleanupListeners.forEach(cleanup => cleanup());
            stream.cleanupListeners = [];
        }

        // Clean up fullscreen state for this stream
        if (wasFullscreen) {
            stream.wrapper.classList.remove('plexd-fullscreen');
            fullscreenStreamId = null;
            // Don't reset fullscreenMode yet if we're switching to another stream
            if (!nextStreamForFullscreen) {
                fullscreenMode = 'none';
            }
        }

        // Clean up video
        stream.video.pause();
        // Revoke blob URL if this was a local file to prevent memory leak
        if (stream.video.src && stream.video.src.startsWith('blob:')) {
            URL.revokeObjectURL(stream.video.src);
        }
        stream.video.src = '';
        stream.video.load();

        // Remove from DOM
        if (stream.wrapper.parentNode) {
            stream.wrapper.parentNode.removeChild(stream.wrapper);
        }

        // Unregister
        streams.delete(streamId);

        // If we were in fullscreen and have another stream, enter fullscreen on it
        if (wasFullscreen && nextStreamForFullscreen) {
            // Use the same fullscreen mode we had before
            if (prevFullscreenMode === 'true-focused' || prevFullscreenMode === 'true-grid') {
                enterFocusedMode(nextStreamForFullscreen.id);
            } else if (prevFullscreenMode === 'browser-fill') {
                toggleFullscreen(nextStreamForFullscreen.id);
            }
        }

        triggerLayoutUpdate();
        return true;
    }

    /**
     * Toggle stream visibility in grid (hide/show)
     * Hidden streams remain active but are not displayed
     */
    function toggleStreamVisibility(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return false;

        stream.hidden = !stream.hidden;

        // Pause hidden streams to save resources, play visible ones
        if (stream.hidden) {
            stream.video.pause();
        } else {
            stream.video.play().catch(() => {});
        }

        triggerLayoutUpdate();
        return stream.hidden;
    }

    /**
     * Set stream visibility explicitly
     */
    function setStreamVisibility(streamId, visible) {
        const stream = streams.get(streamId);
        if (!stream) return false;

        stream.hidden = !visible;

        if (stream.hidden) {
            stream.video.pause();
        } else {
            stream.video.play().catch(() => {});
        }

        triggerLayoutUpdate();
        return true;
    }

    /**
     * Check if stream is visible (not hidden)
     */
    function isStreamVisible(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return false;
        return !stream.hidden;
    }

    /**
     * Get all visible streams (not hidden)
     */
    function getVisibleStreams() {
        return Array.from(streams.values()).filter(s => !s.hidden);
    }

    /**
     * Show all hidden streams
     */
    function showAllStreams() {
        streams.forEach(stream => {
            if (stream.hidden) {
                stream.hidden = false;
                stream.video.play().catch(() => {});
            }
        });
        triggerLayoutUpdate();
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
     * Get the next stream ID in the stream list
     * @param {string} streamId - Current stream ID
     * @param {boolean} wrap - If true, wrap to first stream when at end
     * @returns {string|null} Next stream ID, or null if at end (without wrap), invalid ID, or only one stream
     */
    function getNextStreamId(streamId, wrap = false) {
        const streamList = Array.from(streams.keys());
        const currentIndex = streamList.indexOf(streamId);
        if (currentIndex === -1 || streamList.length <= 1) return null;
        if (currentIndex < streamList.length - 1) {
            return streamList[currentIndex + 1];
        }
        return wrap ? streamList[0] : null;
    }

    /**
     * Get the previous stream ID in the stream list
     * @param {string} streamId - Current stream ID
     * @param {boolean} wrap - If true, wrap to last stream when at start
     * @returns {string|null} Previous stream ID, or null if at start (without wrap), invalid ID, or only one stream
     */
    function getPrevStreamId(streamId, wrap = false) {
        const streamList = Array.from(streams.keys());
        const currentIndex = streamList.indexOf(streamId);
        if (currentIndex === -1 || streamList.length <= 1) return null;
        if (currentIndex > 0) {
            return streamList[currentIndex - 1];
        }
        return wrap ? streamList[streamList.length - 1] : null;
    }

    /**
     * Reload a stream (handles errors, stalled, paused - gets it playing again)
     * Preserves playback position where possible
     */
    function reloadStream(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return false;

        const url = stream.url;
        const loadUrl = stream.sourceUrl || stream.url;
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
        if (stream.recovery.isRecovering) releaseRecoverySlot();
        stream.recovery.isRecovering = false;
        // Reset health so watchdog doesn't immediately trigger recovery
        stream.health.stallStartTime = null;
        stream.health.bufferEmptyStartTime = null;
        stream.health.lastTimeUpdate = Date.now();
        stream.health.consecutiveStalls = 0;
        stream.health.playbackResumedAt = null;
        updateStreamInfo(stream);

        // Store current position for restoration after reload
        const savedTime = video.currentTime;
        const hasFiniteDuration = video.duration && isFinite(video.duration);
        const shouldPlay = !globalPaused;

        // Force a HARD reload.
        // (The previous "smart" early returns often failed to recover partially-stalled streams/files.)

        // Clear any pending retry timer — prevents phantom recovery on reloaded stream
        if (stream.recovery.retryTimer) {
            clearTimeout(stream.recovery.retryTimer);
            stream.recovery.retryTimer = null;
        }

        // Reset recovery state for manual reload attempts
        stream.recovery.retryCount = 0;
        if (stream.recovery.isRecovering) releaseRecoverySlot();
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
                const hls = createHlsInstance(stream, loadUrl);

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
                video.src = loadUrl;
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
            ? 'Toggle audio (focus ON: audio follows selection)'
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
     * When audio focus mode is ON, audio automatically follows the selection
     */
    function selectStream(streamId) {
        const previousStreamId = selectedStreamId;

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

                // Audio follows focus: transfer audio to newly selected stream
                if (audioFocusMode && streamId !== previousStreamId) {
                    // Check if any stream currently has audio
                    let hasActiveAudio = false;
                    streams.forEach((s) => {
                        if (!s.video.muted) {
                            hasActiveAudio = true;
                        }
                    });

                    // If audio is active somewhere, transfer it to the selected stream
                    if (hasActiveAudio) {
                        streams.forEach((s, id) => {
                            if (id !== streamId && !s.video.muted) {
                                s.video.muted = true;
                                updateMuteButton(s);
                            }
                        });
                        stream.video.muted = false;
                        updateMuteButton(stream);
                    }
                }
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
     * Navigation order is row-major: top-left → top-right → next-row-left → ... → bottom-right
     * @param {Array} cells - Array of {streamId, x, y, width, height} from layout engine
     */
    function updateLayoutOrder(cells) {
        if (!cells || cells.length === 0) {
            cachedLayoutOrder = [];
            cachedLayoutRows = [];
            return;
        }

        // Calculate adaptive row tolerance based on median cell height
        const heights = cells.map(c => c.height).filter(h => h > 0).sort((a, b) => a - b);
        const medianHeight = heights.length > 0 ? heights[Math.floor(heights.length / 2)] : 100;
        const rowTolerance = Math.max(30, medianHeight * 0.4);

        // Sort cells by Y position first to find row boundaries
        const byY = [...cells].sort((a, b) => a.y - b.y);

        // Cluster into rows using adaptive tolerance
        const rows = [];
        let currentRow = [];
        let rowCenterY = -Infinity;

        for (const cell of byY) {
            const cellCenterY = cell.y + cell.height / 2;

            if (currentRow.length === 0) {
                // First cell starts a new row
                currentRow.push(cell);
                rowCenterY = cellCenterY;
            } else if (Math.abs(cellCenterY - rowCenterY) <= rowTolerance) {
                // Cell is in the same row
                currentRow.push(cell);
                // Update row center as running average
                rowCenterY = (rowCenterY * (currentRow.length - 1) + cellCenterY) / currentRow.length;
            } else {
                // Cell starts a new row - sort current row by X and save
                currentRow.sort((a, b) => a.x - b.x);
                rows.push(currentRow);
                currentRow = [cell];
                rowCenterY = cellCenterY;
            }
        }

        // Don't forget the last row
        if (currentRow.length > 0) {
            currentRow.sort((a, b) => a.x - b.x);
            rows.push(currentRow);
        }

        // Build flat order (row-major) and row structure
        cachedLayoutOrder = rows.flatMap(row => row.map(c => c.streamId));
        cachedLayoutRows = rows.map(row => row.map(c => c.streamId));
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
        } else if (viewMode === 'favorites') {
            list = getFavoriteStreams();
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

        // In Tetris mode, always use spatial navigation (not row-based)
        // Tetris layouts don't follow row/column structure
        if (window._plexdTetrisMode > 0) {
            return getSpatialNeighborFromDOM(navigable, currentStreamId, direction);
        }

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
     * For Tetris mode, uses true spatial navigation (nearest in direction)
     * For regular grid, uses row-based navigation
     */
    function getSpatialNeighborFromDOM(navigable, currentStreamId, direction) {
        // Check if we're in Tetris mode (complex non-grid layouts)
        const inTetrisMode = window._plexdTetrisMode > 0;

        const items = navigable.map(s => {
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
                id: s.id,
                cx: r.left + r.width / 2,
                cy: r.top + r.height / 2
            };
        });

        const current = items.find(it => it.id === currentStreamId) || items[0];
        if (!current) return null;

        // In Tetris mode, use true spatial navigation
        if (inTetrisMode) {
            return getTrueSpatialNeighbor(items, current, direction);
        }

        // Regular grid: use row-based navigation
        const rows = buildSpatialRows(navigable);
        const flat = rows.flatMap(r => r.items);

        const currentIdx = flat.findIndex(it => it.id === currentStreamId);
        const idx = currentIdx === -1 ? 0 : currentIdx;

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
     * True spatial navigation for Tetris mode
     * Left/Right: sequential through reading order (top-left to bottom-right)
     * Up/Down: nearest item above/below
     */
    function getTrueSpatialNeighbor(items, current, direction) {
        if (items.length <= 1) return current.id;

        // Sort items in reading order (top-to-bottom, left-to-right)
        // Use a tolerance for "same row" grouping
        const sorted = [...items].sort((a, b) => {
            const rowTolerance = 50;
            if (Math.abs(a.cy - b.cy) <= rowTolerance) {
                return a.cx - b.cx; // Same row: sort by X
            }
            return a.cy - b.cy; // Different rows: sort by Y
        });

        const currentIdx = sorted.findIndex(it => it.id === current.id);
        if (currentIdx === -1) return sorted[0].id;

        if (direction === 'right') {
            // Next in reading order
            const nextIdx = (currentIdx + 1) % sorted.length;
            return sorted[nextIdx].id;
        }

        if (direction === 'left') {
            // Previous in reading order
            const prevIdx = (currentIdx - 1 + sorted.length) % sorted.length;
            return sorted[prevIdx].id;
        }

        // Up/Down: find nearest item above/below
        const others = items.filter(it => it.id !== current.id);
        const threshold = 20;

        let candidates;
        if (direction === 'down') {
            candidates = others.filter(it => it.cy > current.cy + threshold);
        } else {
            candidates = others.filter(it => it.cy < current.cy - threshold);
        }

        if (candidates.length === 0) {
            // Wrap: down from bottom goes to top, up from top goes to bottom
            if (direction === 'down') {
                candidates = others.sort((a, b) => a.cy - b.cy);
            } else {
                candidates = others.sort((a, b) => b.cy - a.cy);
            }
            // Pick the one closest horizontally
            let best = candidates[0];
            let bestDx = Math.abs(best.cx - current.cx);
            for (const it of candidates.slice(0, 3)) { // Check top 3
                const dx = Math.abs(it.cx - current.cx);
                if (dx < bestDx) {
                    best = it;
                    bestDx = dx;
                }
            }
            return best.id;
        }

        // Find nearest in direction, preferring similar X position
        let best = candidates[0];
        let bestScore = Infinity;
        for (const it of candidates) {
            const dy = Math.abs(it.cy - current.cy);
            const dx = Math.abs(it.cx - current.cx);
            const score = dy + dx * 0.5; // Slight preference for horizontal alignment
            if (score < bestScore) {
                bestScore = score;
                best = it;
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

        const navigableIds = new Set(navigable.map(s => s.id));
        const currentId = (selectedStreamId && navigableIds.has(selectedStreamId)) ? selectedStreamId : navigable[0].id;
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
     * Reorder streams by rotating the array
     * @param {boolean} reverse - If true, rotate left (first to last), else rotate right (last to first)
     * @param {string[]|null} onlyIds - If provided, only rotate these stream IDs (others stay fixed)
     */
    function rotateStreamOrder(reverse = false, onlyIds = null) {
        const allEntries = Array.from(streams.entries());
        const toRotate = [];
        const fixedPositions = [];

        allEntries.forEach(([id, stream], idx) => {
            if (stream.hidden || (onlyIds && !onlyIds.includes(id))) {
                fixedPositions.push({ idx, entry: [id, stream] });
            } else {
                toRotate.push([id, stream]);
            }
        });

        if (toRotate.length < 2) return;

        if (reverse) {
            const first = toRotate.shift();
            toRotate.push(first);
        } else {
            const last = toRotate.pop();
            toRotate.unshift(last);
        }

        // Reconstruct: insert fixed entries back at their original positions
        const result = [...toRotate];
        fixedPositions.forEach(({ idx, entry }) => {
            result.splice(Math.min(idx, result.length), 0, entry);
        });

        // Rebuild Map and DOM order
        streams.clear();
        result.forEach(([id, stream]) => streams.set(id, stream));

        const container = document.getElementById('plexd-container');
        if (container) {
            result.forEach(([id, stream]) => {
                if (stream.wrapper && stream.wrapper.parentElement === container) {
                    container.appendChild(stream.wrapper);
                }
            });
        }
    }

    /**
     * Shuffle streams into random order (Fisher-Yates)
     * @param {string[]|null} onlyIds - If provided, only shuffle these stream IDs (others stay fixed)
     */
    function shuffleStreamOrder(onlyIds = null) {
        const allEntries = Array.from(streams.entries());
        const toShuffle = [];
        const fixedPositions = [];

        allEntries.forEach(([id, stream], idx) => {
            if (stream.hidden || (onlyIds && !onlyIds.includes(id))) {
                fixedPositions.push({ idx, entry: [id, stream] });
            } else {
                toShuffle.push([id, stream]);
            }
        });

        if (toShuffle.length < 2) return;

        // Fisher-Yates on target streams only
        for (let i = toShuffle.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [toShuffle[i], toShuffle[j]] = [toShuffle[j], toShuffle[i]];
        }

        // Reconstruct: insert fixed entries back at their original positions
        const result = [...toShuffle];
        fixedPositions.forEach(({ idx, entry }) => {
            result.splice(Math.min(idx, result.length), 0, entry);
        });

        streams.clear();
        result.forEach(([id, stream]) => streams.set(id, stream));

        const container = document.getElementById('plexd-container');
        if (container) {
            result.forEach(([id, stream]) => {
                if (stream.wrapper && stream.wrapper.parentElement === container) {
                    container.appendChild(stream.wrapper);
                }
            });
        }
    }

    /**
     * Set streams to a specific order by stream IDs
     * @param {Array<string>} orderedIds - Array of stream IDs in desired order
     */
    function setStreamOrder(orderedIds) {
        const newOrder = [];
        orderedIds.forEach(id => {
            if (streams.has(id)) {
                newOrder.push([id, streams.get(id)]);
            }
        });

        // Add any streams not in the list at the end
        streams.forEach((stream, id) => {
            if (!orderedIds.includes(id)) {
                newOrder.push([id, stream]);
            }
        });

        // Rebuild the Map
        streams.clear();
        newOrder.forEach(([id, stream]) => streams.set(id, stream));

        // Reorder DOM
        const container = document.getElementById('plexd-container');
        if (container) {
            newOrder.forEach(([id, stream]) => {
                if (stream.wrapper && stream.wrapper.parentElement === container) {
                    container.appendChild(stream.wrapper);
                }
            });
        }
    }

    /**
     * Get current stream order as array of IDs
     */
    function getStreamOrder() {
        return Array.from(streams.keys());
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
    function pauseAll(targetStreams) {
        var list = targetStreams || Array.from(streams.values());
        list.forEach(function(stream) {
            stream.savedPosition = stream.video.currentTime;
            stream.video.pause();
        });
    }

    /**
     * Play all streams
     */
    function playAll(targetStreams) {
        var list = targetStreams || Array.from(streams.values());
        list.forEach(function(stream) {
            resumeStream(stream.id);
        });
    }

    /**
     * Mute all streams
     */
    function muteAll(targetStreams) {
        var list = targetStreams || Array.from(streams.values());
        list.forEach(function(stream) {
            stream.video.muted = true;
            updateMuteButton(stream);
        });
    }

    /**
     * Mute all streams except the specified one
     */
    function muteAllExcept(streamId) {
        streams.forEach((stream, id) => {
            if (id !== streamId && stream.video) {
                stream.video.muted = true;
                updateMuteButton(stream);
            }
        });
    }

    // Global pause state
    let globalPaused = false;

    /**
     * Toggle pause/play all streams
     */
    function togglePauseAll(targetStreams) {
        globalPaused = !globalPaused;
        if (globalPaused) {
            pauseAll(targetStreams);
        } else {
            playAll(targetStreams);
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
    function toggleMuteAll(targetStreams) {
        globalMuted = !globalMuted;
        var list = targetStreams || Array.from(streams.values());
        list.forEach(function(stream) {
            stream.video.muted = globalMuted;
            updateMuteButton(stream);
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

    // ===== FAVORITES SYSTEM =====

    /**
     * Toggle favorite status for a stream
     */
    function toggleFavorite(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return false;

        const isFavorite = getFavorite(stream.url, stream.fileName);
        setFavorite(streamId, !isFavorite);
        return !isFavorite;
    }

    /**
     * Set favorite status for a stream
     */
    function setFavorite(streamId, isFavorite) {
        const stream = streams.get(streamId);
        if (!stream) return;

        const urlKey = stream.url;
        if (!urlKey) return;

        // Store by URL (for remote streams)
        if (isFavorite) {
            favorites.set(urlKey, true);
        } else {
            favorites.delete(urlKey);
        }

        // For blob URLs (local files), also store by fileName for persistence
        if (stream.url && stream.url.startsWith('blob:') && stream.fileName) {
            if (isFavorite) {
                fileNameFavorites.set(stream.fileName, true);
            } else {
                fileNameFavorites.delete(stream.fileName);
            }
        }

        // Update wrapper class
        stream.wrapper.classList.toggle('plexd-favorite', isFavorite);

        // Update favorite indicator display
        updateFavoriteDisplay(stream);

        // Persist favorites
        saveFavorites();

        // Notify callback
        if (favoritesUpdateCallback) {
            favoritesUpdateCallback();
        }
    }

    /**
     * Update favorite indicator appearance
     */
    function updateFavoriteDisplay(stream) {
        const isFavorite = getFavorite(stream.url, stream.fileName);

        // Update favorite indicator
        const indicator = stream.wrapper.querySelector('.plexd-favorite-indicator');
        if (indicator) {
            indicator.classList.toggle('active', isFavorite);
            indicator.innerHTML = isFavorite ? '★' : '☆';
            indicator.title = isFavorite ? 'Unlike (L)' : 'Like (L)';
        }

        // Update favorite button in controls if present
        const favBtn = stream.controls.querySelector('.plexd-favorite-btn');
        if (favBtn) {
            favBtn.classList.toggle('active', isFavorite);
            favBtn.innerHTML = isFavorite ? '★' : '☆';
        }
    }

    /**
     * Get favorite status for a stream URL or fileName
     */
    function getFavorite(url, fileName) {
        if (!url) return false;

        // If caller didn't provide fileName for a blob URL, try to infer it from active streams
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
            const fileNameFav = fileNameFavorites.get(fileName);
            if (fileNameFav !== undefined) {
                return fileNameFav;
            }
        }
        // Fall back to URL-based favorite
        return favorites.get(url) || false;
    }

    /**
     * Check if a stream is favorited by streamId
     */
    function isFavorite(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return false;
        return getFavorite(stream.url, stream.fileName);
    }

    /**
     * Get all favorite streams
     */
    function getFavoriteStreams() {
        return Array.from(streams.values()).filter(s => getFavorite(s.url, s.fileName));
    }

    /**
     * Get count of favorite streams
     */
    function getFavoriteCount() {
        return getFavoriteStreams().length;
    }

    /**
     * Save favorites to localStorage
     */
    function saveFavorites() {
        const obj = {};
        favorites.forEach((isFav, url) => {
            if (isFav) obj[url] = true;
        });
        localStorage.setItem('plexd_favorites_list', JSON.stringify(obj));

        // Save fileName-based favorites separately (for blob URLs)
        const fileNameObj = {};
        fileNameFavorites.forEach((isFav, fileName) => {
            if (isFav) fileNameObj[fileName] = true;
        });
        localStorage.setItem('plexd_fileName_favorites', JSON.stringify(fileNameObj));
    }

    /**
     * Load favorites from localStorage
     */
    function loadFavorites() {
        // Load URL-based favorites
        const saved = localStorage.getItem('plexd_favorites_list');
        if (saved) {
            const obj = JSON.parse(saved);
            favorites.clear();
            Object.keys(obj).forEach(url => {
                if (obj[url]) favorites.set(url, true);
            });
        }

        // Load fileName-based favorites (for blob URLs)
        const savedFileNames = localStorage.getItem('plexd_fileName_favorites');
        if (savedFileNames) {
            const obj = JSON.parse(savedFileNames);
            fileNameFavorites.clear();
            Object.keys(obj).forEach(fileName => {
                if (obj[fileName]) fileNameFavorites.set(fileName, true);
            });
        }
    }

    /**
     * Set favorites update callback
     */
    function setFavoritesUpdateCallback(callback) {
        favoritesUpdateCallback = callback;
    }

    /**
     * Sync favorite status for existing streams (call after loading favorites)
     */
    function syncFavoriteStatus() {
        streams.forEach(stream => {
            const isFavorite = getFavorite(stream.url, stream.fileName);
            stream.wrapper.classList.toggle('plexd-favorite', isFavorite);
            updateFavoriteDisplay(stream);
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
        const inGracePeriod = (now - monitoringStartedAt) < LOAD_GRACE_PERIOD;

        streams.forEach((stream) => {
            // Skip if already in error/recovering/loading/idle state, mid-random-seek, or paused for a peer's seek
            if (stream.state === 'error' || stream.state === 'loading' || stream.state === 'idle' || stream.recovery.isRecovering) {
                return;
            }

            // Skip if paused (user intended)
            if (stream.video.paused && stream.state === 'paused') {
                return;
            }

            const video = stream.video;

            // Check for frozen video (no timeupdate for too long while supposedly playing)
            // Use 3x threshold during grace period — connection contention causes slow starts
            if (stream.state === 'playing' && !video.paused) {
                const timeSinceUpdate = now - stream.health.lastTimeUpdate;
                const frozenThreshold = inGracePeriod ? RECOVERY_CONFIG.stallTimeout * 3 : RECOVERY_CONFIG.stallTimeout;
                if (timeSinceUpdate > frozenThreshold) {
                    console.log(`[${stream.id}] Frozen detected - no time updates for ${timeSinceUpdate}ms`);
                    triggerRecovery(stream, 'frozen_video');
                    return;
                }
            }

            // Check for prolonged stall
            if (stream.health.stallStartTime) {
                if (inGracePeriod && stream.recovery.retryCount === 0) {
                    // Connection contention during initial load — wait it out
                } else if (stream.hasEverPlayed) {
                    const stallDuration = now - stream.health.stallStartTime;
                    if (stallDuration > RECOVERY_CONFIG.stallTimeout) {
                        console.log(`[${stream.id}] Prolonged stall detected - ${stallDuration}ms`);
                        triggerRecovery(stream, 'prolonged_stall');
                        return;
                    }
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
        monitoringStartedAt = Date.now();
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
            console.log('Page visible - resuming streams (staggered)');
            // Page is visible again - resume/recover streams with staggered play to avoid thundering herd
            var resumeDelay = 0;
            streams.forEach((stream) => {
                if (stream.state === 'buffering' ||
                    (stream.video.paused && stream.state !== 'paused' && stream.state !== 'error' && stream.state !== 'idle')) {
                    (function(s, d) {
                        setTimeout(function() {
                            if (streams.has(s.id)) s.video.play().catch(function() {});
                        }, d);
                    })(stream, resumeDelay);
                    resumeDelay += 200;
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

    // Load favorites on init
    loadFavorites();

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
            // Clean up capture-phase keyboard handler (prevents stale arrow key interception)
            const container = document.querySelector('.plexd-app');
            if (container && fullscreenKeyHandler) {
                container.removeEventListener('keydown', fullscreenKeyHandler, true);
                fullscreenKeyHandler = null;
            }
            fullscreenStreamId = null;
            fullscreenMode = 'none';
            setAppFocusedMode(false);
            // Resource saving: resume streams that were auto-paused for focus
            clearFocusResourcePolicy();
            triggerLayoutUpdate();
        }
    });

    // =========================================
    // Video Frame Capture for Remote Thumbnails
    // =========================================

    // Reusable canvas for frame capture (avoid creating new ones each time)
    const captureCanvas = document.createElement('canvas');
    const captureCtx = captureCanvas.getContext('2d');

    // Cache for thumbnails (avoid recapturing identical frames)
    const thumbnailCache = new Map();
    const THUMBNAIL_WIDTH = 160;  // Small enough for fast transfer
    const THUMBNAIL_HEIGHT = 90;  // 16:9 aspect ratio
    const THUMBNAIL_QUALITY = 0.6; // JPEG quality (0-1)
    const THUMBNAIL_CACHE_TTL = 2000; // Cache for 2 seconds

    /**
     * Capture a single frame from a video element
     * Returns base64 JPEG data URL or null if capture fails (CORS, etc.)
     */
    function captureVideoFrame(video, width = THUMBNAIL_WIDTH, height = THUMBNAIL_HEIGHT) {
        if (!video || video.readyState < 2) {
            return null; // Video not ready
        }

        try {
            // Set canvas size
            captureCanvas.width = width;
            captureCanvas.height = height;

            // Draw video frame to canvas (scaled down)
            captureCtx.drawImage(video, 0, 0, width, height);

            // Convert to base64 JPEG
            return captureCanvas.toDataURL('image/jpeg', THUMBNAIL_QUALITY);
        } catch (e) {
            // CORS or other security error - video is tainted
            // This is expected for cross-origin streams
            return null;
        }
    }

    /**
     * Capture frame for a specific stream by ID
     * Uses caching to avoid redundant captures
     */
    function captureStreamFrame(streamId) {
        const stream = streams.get(streamId);
        if (!stream || !stream.video) {
            return null;
        }

        // Check cache
        const cached = thumbnailCache.get(streamId);
        if (cached && Date.now() - cached.timestamp < THUMBNAIL_CACHE_TTL) {
            return cached.data;
        }

        // Capture new frame
        const thumbnail = captureVideoFrame(stream.video);

        // Update cache (even if null, to avoid repeated failed attempts)
        thumbnailCache.set(streamId, {
            data: thumbnail,
            timestamp: Date.now()
        });

        return thumbnail;
    }

    /**
     * Capture frames for all streams
     * Returns Map of streamId -> base64 data URL (or null)
     */
    function captureAllFrames() {
        const frames = new Map();
        streams.forEach((stream, id) => {
            frames.set(id, captureStreamFrame(id));
        });
        return frames;
    }

    /**
     * Get all stream thumbnails as an object (for JSON serialization)
     * Format: { streamId: base64DataUrl, ... }
     */
    function getAllThumbnails() {
        const thumbnails = {};
        streams.forEach((stream, id) => {
            const thumb = captureStreamFrame(id);
            if (thumb) {
                thumbnails[id] = thumb;
            }
        });
        return thumbnails;
    }

    /**
     * Clear thumbnail cache (call when streams change significantly)
     */
    function clearThumbnailCache() {
        thumbnailCache.clear();
    }

    /**
     * Update moment dots on a stream's seek bar
     */
    function updateMomentDots(streamId) {
        var stream = streams.get(streamId);
        if (!stream || !stream.controls) return;
        var container = stream.controls.querySelector('.plexd-moment-dots');
        if (!container) return;
        container.textContent = '';
        if (typeof PlexdMoments === 'undefined') return;
        var duration = stream.video ? stream.video.duration : 0;
        if (!duration || !isFinite(duration)) return;
        var moments = PlexdMoments.getMomentsForStream(streamId);
        if (moments.length === 0) {
            moments = PlexdMoments.getMomentsForSource(stream.serverUrl || stream.url);
        }
        moments.forEach(function(m) {
            var pct = (m.peak / duration) * 100;
            if (pct < 0 || pct > 100) return;
            var dot = document.createElement('div');
            dot.className = 'plexd-moment-dot';
            dot.style.left = pct + '%';
            container.appendChild(dot);
        });
    }

    /**
     * Get pan position for a stream (used in Tetris mode for object-position)
     * @param {string} streamId - Stream ID
     * @returns {Object} Pan position {x, y} as percentages (0-100), or {x: 50, y: 50} if not found
     */
    function getPanPosition(streamId) {
        const stream = streams.get(streamId);
        if (stream && stream.panPosition) {
            return { ...stream.panPosition };
        }
        return { x: 50, y: 50 }; // Default: center
    }

    /**
     * Set pan position for a stream (used by auto-detect face centering)
     * @param {string} streamId - Stream ID
     * @param {Object} pos - { x, y } as percentages (0-100)
     */
    function setPanPosition(streamId, pos) {
        const stream = streams.get(streamId);
        if (stream) {
            stream.panPosition = { x: Math.max(0, Math.min(100, pos.x)), y: Math.max(0, Math.min(100, pos.y)) };
        }
    }

    /**
     * Reset pan position to center for a stream
     * @param {string} streamId - Stream ID
     */
    function resetPanPosition(streamId) {
        const stream = streams.get(streamId);
        if (stream) {
            stream.panPosition = { x: 50, y: 50 };
            const video = stream.video;
            if (video) {
                video.style.objectPosition = '50% 50%';
            }
        }
    }

    /**
     * Reset pan position for all streams
     */
    function resetAllPanPositions() {
        streams.forEach((stream) => {
            stream.panPosition = { x: 50, y: 50 };
            if (stream.video) {
                stream.video.style.objectPosition = '50% 50%';
            }
        });
    }

    // Public API
    return {
        createStream,
        activateStream,
        removeStream,
        removeStreamAndFocusNext,
        getNextStreamId,
        getPrevStreamId,
        reloadStream,
        // Visibility control
        toggleStreamVisibility,
        setStreamVisibility,
        isStreamVisible,
        getVisibleStreams,
        showAllStreams,
        // Utilities
        copyStreamUrl,
        copyAllStreamUrls,
        getStream,
        getAllStreams,
        getStreamCount,
        rotateStreamOrder,
        shuffleStreamOrder,
        setStreamOrder,
        getStreamOrder,
        toggleMute,
        toggleFullscreen,
        toggleTrueFullscreen,
        isAnyFullscreen,
        getFullscreenStream,
        getFullscreenMode,
        enterFocusedMode,
        exitFocusedMode,
        enterGridFullscreen,
        enterTrueFocusedFullscreen,
        exitTrueFullscreen,
        resetFullscreenState,
        pauseAll,
        playAll,
        pauseStream,
        resumeStream,
        muteAll,
        muteAllExcept,
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
        // Favorites
        toggleFavorite,
        setFavorite,
        getFavorite,
        isFavorite,
        getFavoriteStreams,
        getFavoriteCount,
        loadFavorites,
        saveFavorites,
        setFavoritesUpdateCallback,
        syncFavoriteStatus,
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
        isLocalFile,
        // Video frame capture for remote thumbnails
        captureStreamFrame,
        captureAllFrames,
        getAllThumbnails,
        clearThumbnailCache,
        // Pan position for Tetris mode
        getPanPosition,
        setPanPosition,
        resetPanPosition,
        resetAllPanPositions,
        // Moment dots on seek bars
        updateMomentDots,
        // URL proxying (for app.js fallback video paths)
        getProxiedHlsUrl
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlexdStream;
}
