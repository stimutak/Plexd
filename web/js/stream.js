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

        // Assemble
        wrapper.appendChild(video);
        wrapper.appendChild(controls);
        wrapper.appendChild(infoOverlay);

        // Make draggable
        wrapper.draggable = true;
        wrapper.dataset.streamId = id;

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

        // Info toggle button
        const infoBtn = document.createElement('button');
        infoBtn.className = 'plexd-btn plexd-info-btn';
        infoBtn.innerHTML = 'ⓘ';
        infoBtn.title = 'Toggle stream info';
        infoBtn.onclick = (e) => {
            e.stopPropagation();
            toggleStreamInfo(streamId);
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
        buttonRow.appendChild(pipBtn);
        buttonRow.appendChild(popoutBtn);
        buttonRow.appendChild(fullscreenBtn);
        buttonRow.appendChild(infoBtn);
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

            // Show error visually
            const errorOverlay = document.createElement('div');
            errorOverlay.className = 'plexd-error-overlay';
            errorOverlay.innerHTML = `<div class="plexd-error-msg">⚠️ ${stream.error}</div>`;
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
        reorderStreams
    };
})();

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlexdStream;
}
