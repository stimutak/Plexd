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

        // Assemble
        wrapper.appendChild(video);
        wrapper.appendChild(controls);

        // Stream state
        const stream = {
            id,
            url,
            wrapper,
            video,
            controls,
            hls: null, // HLS.js instance if used
            aspectRatio: DEFAULT_ASPECT_RATIO,
            state: 'loading', // loading, playing, paused, error
            error: null
        };

        // Set up event listeners
        setupVideoEvents(stream);

        // Set source - use HLS.js for .m3u8 streams
        if (isHlsUrl(url) && typeof Hls !== 'undefined' && Hls.isSupported()) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true
            });
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                video.play().catch(() => {});
            });
            hls.on(Hls.Events.ERROR, (event, data) => {
                console.error('HLS error:', data);
                if (data.fatal) {
                    stream.state = 'error';
                    stream.error = 'HLS stream error: ' + data.type;
                }
            });
            stream.hls = hls;
        } else if (isHlsUrl(url) && video.canPlayType('application/vnd.apple.mpegurl')) {
            // Safari has native HLS support
            video.src = url;
        } else {
            // Regular video file
            video.src = url;
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
     * Create controls overlay for a stream
     */
    function createControlsOverlay(streamId) {
        const controls = document.createElement('div');
        controls.className = 'plexd-controls';

        // Mute/unmute button
        const muteBtn = document.createElement('button');
        muteBtn.className = 'plexd-btn plexd-mute-btn';
        muteBtn.innerHTML = '&#128263;'; // Speaker icon
        muteBtn.title = 'Toggle audio';
        muteBtn.onclick = () => toggleMute(streamId);

        // Fullscreen button (click = browser-fill, double-click = true fullscreen)
        const fullscreenBtn = document.createElement('button');
        fullscreenBtn.className = 'plexd-btn plexd-fullscreen-btn';
        fullscreenBtn.innerHTML = '&#x26F6;'; // Fullscreen icon
        fullscreenBtn.title = 'Click: fill window | Double-click: true fullscreen';
        fullscreenBtn.onclick = () => toggleFullscreen(streamId);
        fullscreenBtn.ondblclick = (e) => {
            e.stopPropagation();
            toggleTrueFullscreen(streamId);
        };

        // Remove button
        const removeBtn = document.createElement('button');
        removeBtn.className = 'plexd-btn plexd-remove-btn';
        removeBtn.innerHTML = '&times;';
        removeBtn.title = 'Remove stream';
        removeBtn.onclick = () => removeStream(streamId);

        controls.appendChild(muteBtn);
        controls.appendChild(fullscreenBtn);
        controls.appendChild(removeBtn);

        return controls;
    }

    // Track which stream is fullscreen
    let fullscreenStreamId = null;

    /**
     * Toggle fullscreen for a stream (browser-fill mode)
     */
    function toggleFullscreen(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return;

        if (fullscreenStreamId === streamId) {
            // Exit fullscreen
            stream.wrapper.classList.remove('plexd-fullscreen');
            fullscreenStreamId = null;
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
        }
        triggerLayoutUpdate();
    }

    /**
     * Toggle true fullscreen (hides browser chrome)
     */
    function toggleTrueFullscreen(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return;

        if (document.fullscreenElement) {
            document.exitFullscreen();
        } else {
            // First ensure browser-fill mode is active
            if (fullscreenStreamId !== streamId) {
                toggleFullscreen(streamId);
            }
            // Then request true fullscreen
            stream.wrapper.requestFullscreen().catch(err => {
                console.log('Fullscreen request failed:', err);
            });
        }
    }

    /**
     * Check if any stream is fullscreen
     */
    function isAnyFullscreen() {
        return fullscreenStreamId !== null;
    }

    /**
     * Get fullscreen stream if any
     */
    function getFullscreenStream() {
        return fullscreenStreamId ? streams.get(fullscreenStreamId) : null;
    }

    /**
     * Set up video element event listeners
     */
    function setupVideoEvents(stream) {
        const { video, wrapper } = stream;

        // Double-click to toggle fullscreen
        wrapper.addEventListener('dblclick', () => {
            toggleFullscreen(stream.id);
        });

        // Get aspect ratio when metadata loads
        video.addEventListener('loadedmetadata', () => {
            if (video.videoWidth && video.videoHeight) {
                stream.aspectRatio = video.videoWidth / video.videoHeight;
            }
            stream.state = 'playing';
            triggerLayoutUpdate();
        });

        // Handle play/pause
        video.addEventListener('play', () => {
            stream.state = 'playing';
        });

        video.addEventListener('pause', () => {
            stream.state = 'paused';
        });

        // Handle errors
        video.addEventListener('error', (e) => {
            stream.state = 'error';
            stream.error = getVideoError(video.error);
            console.error(`Stream ${stream.id} error:`, stream.error, 'URL:', stream.url);

            // Show error visually
            const errorOverlay = document.createElement('div');
            errorOverlay.className = 'plexd-error-overlay';
            errorOverlay.innerHTML = `<div class="plexd-error-msg">⚠️ ${stream.error}</div>`;
            stream.wrapper.appendChild(errorOverlay);
        });

        // Handle stalled/waiting
        video.addEventListener('waiting', () => {
            stream.state = 'buffering';
        });

        video.addEventListener('playing', () => {
            stream.state = 'playing';
        });
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
     * Toggle mute for a stream
     */
    function toggleMute(streamId) {
        const stream = streams.get(streamId);
        if (!stream) return;

        stream.video.muted = !stream.video.muted;

        // Update button icon
        const muteBtn = stream.controls.querySelector('.plexd-mute-btn');
        if (muteBtn) {
            muteBtn.innerHTML = stream.video.muted ? '&#128263;' : '&#128266;';
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

    // Public API
    return {
        createStream,
        removeStream,
        getStream,
        getAllStreams,
        getStreamCount,
        toggleMute,
        toggleFullscreen,
        toggleTrueFullscreen,
        isAnyFullscreen,
        getFullscreenStream,
        pauseAll,
        playAll,
        muteAll,
        getVideoElements,
        setLayoutUpdateCallback
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlexdStream;
}
