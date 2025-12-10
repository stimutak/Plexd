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
            state: 'loading', // loading, playing, paused, error
            error: null
        };

        // Set up event listeners
        setupVideoEvents(stream);

        // Set source - use HLS.js for .m3u8 streams
        if (isHlsUrl(url) && typeof Hls !== 'undefined' && Hls.isSupported()) {
            const hls = new Hls({
                enableWorker: true,
                lowLatencyMode: true,
                // Auto quality selection with preference for higher quality
                autoStartLoad: true,
                startLevel: -1, // Auto select
                capLevelToPlayerSize: false // Don't cap to player size - use max quality
            });
            hls.loadSource(url);
            hls.attachMedia(video);
            hls.on(Hls.Events.MANIFEST_PARSED, (event, data) => {
                // Select highest quality level
                if (data.levels && data.levels.length > 0) {
                    const maxLevel = data.levels.length - 1;
                    hls.currentLevel = maxLevel;
                }
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
                playing: '▶️',
                paused: '⏸️',
                error: '❌'
            };
            stateEl.textContent = stateIcons[stream.state] || '❓';
        }
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
            // Exit both true fullscreen and browser-fill mode
            document.exitFullscreen().then(() => {
                // Also exit browser-fill mode after fullscreen exits
                if (fullscreenStreamId) {
                    const fsStream = streams.get(fullscreenStreamId);
                    if (fsStream) {
                        fsStream.wrapper.classList.remove('plexd-fullscreen');
                    }
                    fullscreenStreamId = null;
                    triggerLayoutUpdate();
                }
            }).catch(() => {
                // Fallback - try anyway
                if (fullscreenStreamId) {
                    const fsStream = streams.get(fullscreenStreamId);
                    if (fsStream) {
                        fsStream.wrapper.classList.remove('plexd-fullscreen');
                    }
                    fullscreenStreamId = null;
                    triggerLayoutUpdate();
                }
            });
        } else {
            // First ensure browser-fill mode is active
            if (fullscreenStreamId !== streamId) {
                toggleFullscreen(streamId);
            }
            // Then request true fullscreen
            stream.wrapper.requestFullscreen().then(() => {
                // Focus the wrapper so it receives keyboard events
                stream.wrapper.focus();
            }).catch(err => {
                console.log('Fullscreen request failed:', err);
            });
        }
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
        });

        // Click to select stream
        wrapper.addEventListener('click', () => {
            selectStream(stream.id);
        });

        // Double-click to toggle fullscreen
        wrapper.addEventListener('dblclick', () => {
            toggleFullscreen(stream.id);
        });

        // Keyboard handling on wrapper (for fullscreen mode)
        wrapper.addEventListener('keydown', (e) => {
            // Only handle when this element or fullscreen is active
            if (document.fullscreenElement !== wrapper && document.activeElement !== wrapper) {
                return;
            }

            switch (e.key) {
                case 'ArrowRight':
                    e.preventDefault();
                    seekRelative(stream.id, 10);
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    seekRelative(stream.id, -10);
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    seekRelative(stream.id, 60);
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    seekRelative(stream.id, -60);
                    break;
                case ' ':
                    e.preventDefault();
                    if (video.paused) {
                        video.play().catch(() => {});
                    } else {
                        video.pause();
                    }
                    break;
                case 'z':
                case 'Z':
                case 'Escape':
                    e.preventDefault();
                    toggleFullscreen(stream.id);
                    break;
                case 'f':
                case 'F':
                    e.preventDefault();
                    toggleTrueFullscreen(stream.id);
                    break;
                case 'm':
                case 'M':
                    e.preventDefault();
                    toggleMute(stream.id);
                    break;
            }
        });

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
            updateStreamInfo(stream);

            // Show error visually with close button
            const errorOverlay = document.createElement('div');
            errorOverlay.className = 'plexd-error-overlay';
            errorOverlay.innerHTML = `
                <div class="plexd-error-content">
                    <div class="plexd-error-msg">⚠️ ${stream.error}</div>
                    <button class="plexd-error-close" title="Remove stream">✕ Close</button>
                </div>
            `;
            errorOverlay.querySelector('.plexd-error-close').onclick = () => {
                removeStream(stream.id);
            };
            stream.wrapper.appendChild(errorOverlay);
        });

        // Handle stalled/waiting
        video.addEventListener('waiting', () => {
            stream.state = 'buffering';
            updateStreamInfo(stream);
        });

        video.addEventListener('playing', () => {
            stream.state = 'playing';
            updateStreamInfo(stream);
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
     * Select next stream in grid order (respects visual grid layout)
     */
    function selectNextStream(direction = 'right') {
        const streamList = Array.from(streams.keys());
        const count = streamList.length;
        if (count === 0) return;

        if (!selectedStreamId) {
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

    // Load ratings on init
    loadRatings();

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
        pauseAll,
        playAll,
        muteAll,
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
        setRatingsUpdateCallback,
        syncRatingStatus,
        // Responsive controls
        updateControlsSize,
        // Global controls
        toggleCleanMode,
        isCleanMode,
        togglePauseAll,
        toggleMuteAll,
        toggleGlobalFullscreen
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlexdStream;
}
