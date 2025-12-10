/**
 * Plexd Main Application
 *
 * Coordinates the grid layout engine and stream manager.
 * Handles user interactions and application state.
 */

const PlexdApp = (function() {
    'use strict';

    // DOM references
    let containerEl = null;
    let inputEl = null;
    let addButtonEl = null;
    let streamCountEl = null;

    // Queue and History
    const streamQueue = [];
    const streamHistory = [];

    // View mode: 'all', or 1-5 for star ratings
    let viewMode = 'all';

    // View mode cycle order: all -> 1 -> 2 -> 3 -> 4 -> 5 -> all
    const viewModes = ['all', 1, 2, 3, 4, 5];

    // Tetris layout mode
    let tetrisMode = false;

    // Header visibility (starts hidden)
    let headerVisible = false;

    /**
     * Initialize the application
     */
    function init() {
        // Get DOM elements
        containerEl = document.getElementById('plexd-container');
        inputEl = document.getElementById('stream-url-input');
        addButtonEl = document.getElementById('add-stream-btn');
        streamCountEl = document.getElementById('stream-count');

        if (!containerEl) {
            console.error('Plexd: Container element not found');
            return;
        }

        // Set up event listeners
        setupEventListeners();

        // Set up file drop support (QuickTime, etc.)
        setupFileDrop();

        // Connect stream manager to layout updates
        PlexdStream.setLayoutUpdateCallback(updateLayout);

        // Handle window resize
        window.addEventListener('resize', debounce(updateLayout, 100));

        // Listen for extension messages
        setupExtensionListener();

        // Load queue, history, and saved combinations
        loadQueue();
        loadHistory();
        updateQueueUI();
        updateHistoryUI();
        updateCombinationsList();
        loadShortcutsPreference();

        // Set up header toggle button
        setupHeaderToggle();

        // Set up ratings callback
        PlexdStream.setRatingsUpdateCallback(updateRatingsUI);
        updateRatingsUI();

        // Load streams from URL parameters (from extension)
        loadStreamsFromUrl();

        // Sync rating status for loaded streams
        setTimeout(() => PlexdStream.syncRatingStatus(), 100);

        console.log('Plexd initialized');
    }

    /**
     * Set up header toggle button
     */
    function setupHeaderToggle() {
        const toggleBtn = document.getElementById('header-toggle');
        const header = document.querySelector('.plexd-header');
        const app = document.querySelector('.plexd-app');

        if (toggleBtn && header) {
            toggleBtn.addEventListener('click', () => {
                toggleHeader();
            });
        }
    }

    /**
     * Set up file drop support for QuickTime and other video files
     */
    function setupFileDrop() {
        const app = document.querySelector('.plexd-app');
        if (!app) return;

        // Create drop overlay
        const dropOverlay = document.createElement('div');
        dropOverlay.id = 'plexd-drop-overlay';
        dropOverlay.className = 'plexd-drop-overlay';
        dropOverlay.innerHTML = `
            <div class="plexd-drop-content">
                <div class="plexd-drop-icon">🎬</div>
                <div class="plexd-drop-text">Drop video files here</div>
                <div class="plexd-drop-hint">QuickTime, MP4, WebM, and more</div>
            </div>
        `;
        app.appendChild(dropOverlay);

        // Supported video MIME types
        const videoTypes = [
            'video/quicktime',      // .mov
            'video/mp4',            // .mp4
            'video/webm',           // .webm
            'video/x-m4v',          // .m4v
            'video/x-matroska',     // .mkv
            'video/avi',            // .avi
            'video/x-msvideo',      // .avi (alt)
            'video/ogg',            // .ogv
            'video/3gpp',           // .3gp
            'video/x-flv',          // .flv
            'video/mpeg'            // .mpeg
        ];

        // Also check file extensions as fallback
        const videoExtensions = ['.mov', '.mp4', '.m4v', '.webm', '.mkv', '.avi', '.ogv', '.3gp', '.flv', '.mpeg', '.mpg'];

        function isVideoFile(file) {
            // Check MIME type
            if (file.type && videoTypes.some(t => file.type.startsWith(t.split('/')[0] + '/'))) {
                return true;
            }
            // Fallback to extension check
            const name = file.name.toLowerCase();
            return videoExtensions.some(ext => name.endsWith(ext));
        }

        let dragCounter = 0;

        // Prevent default drag behavior on the whole document
        document.addEventListener('dragover', (e) => {
            e.preventDefault();
        });

        document.addEventListener('drop', (e) => {
            e.preventDefault();
        });

        // Show overlay when dragging files over the app
        app.addEventListener('dragenter', (e) => {
            e.preventDefault();
            dragCounter++;

            // Check if dragging files (not internal drag)
            if (e.dataTransfer && e.dataTransfer.types.includes('Files')) {
                dropOverlay.classList.add('active');
            }
        });

        app.addEventListener('dragleave', (e) => {
            e.preventDefault();
            dragCounter--;

            if (dragCounter === 0) {
                dropOverlay.classList.remove('active');
            }
        });

        app.addEventListener('dragover', (e) => {
            e.preventDefault();
            if (e.dataTransfer) {
                e.dataTransfer.dropEffect = 'copy';
            }
        });

        // Handle file drop
        app.addEventListener('drop', (e) => {
            e.preventDefault();
            dragCounter = 0;
            dropOverlay.classList.remove('active');

            const files = e.dataTransfer?.files;
            if (!files || files.length === 0) return;

            let addedCount = 0;
            let skippedCount = 0;

            Array.from(files).forEach(file => {
                if (isVideoFile(file)) {
                    // Create object URL for the file
                    const objectUrl = URL.createObjectURL(file);

                    // Add as stream
                    addStreamFromFile(objectUrl, file.name);
                    addedCount++;
                } else {
                    skippedCount++;
                }
            });

            if (addedCount > 0) {
                showMessage(`Added ${addedCount} video${addedCount > 1 ? 's' : ''} from dropped file${addedCount > 1 ? 's' : ''}`, 'success');
            }
            if (skippedCount > 0 && addedCount === 0) {
                showMessage('Dropped file(s) are not supported video formats', 'error');
            }
        });
    }

    /**
     * Add a stream from a dropped file
     */
    function addStreamFromFile(objectUrl, fileName) {
        const stream = PlexdStream.createStream(objectUrl, {
            autoplay: true,
            muted: true
        });

        // Store the filename for display
        stream.fileName = fileName;

        containerEl.appendChild(stream.wrapper);
        updateStreamCount();
        updateLayout();

        // Note: We don't add file streams to history since object URLs are temporary
        showMessage(`Added: ${fileName}`, 'success');
    }

    /**
     * Toggle header visibility
     */
    function toggleHeader() {
        const header = document.querySelector('.plexd-header');
        const toggleBtn = document.getElementById('header-toggle');
        const app = document.querySelector('.plexd-app');

        headerVisible = !headerVisible;

        if (headerVisible) {
            header.classList.remove('plexd-header-hidden');
            toggleBtn.classList.add('header-visible');
            toggleBtn.innerHTML = '☰';
            app.classList.remove('header-hidden');
        } else {
            header.classList.add('plexd-header-hidden');
            toggleBtn.classList.remove('header-visible');
            toggleBtn.innerHTML = '☰';
            app.classList.add('header-hidden');
        }

        // Trigger layout update after transition
        setTimeout(updateLayout, 350);
    }

    /**
     * Update ratings UI elements
     */
    function updateRatingsUI() {
        const counts = PlexdStream.getAllRatingCounts();

        // Update view button badges
        for (let i = 1; i <= 5; i++) {
            const badge = document.getElementById(`rating-${i}-count`);
            if (badge) {
                badge.textContent = counts[i];
            }
        }

        // Update current view button active state
        updateViewButtons();
    }

    /**
     * Listen for messages from Plexd browser extension
     */
    function setupExtensionListener() {
        // Listen for messages from extension content script
        if (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.onMessage) {
            chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
                if (message.action === 'addStreams' && message.streams) {
                    message.streams.forEach(stream => {
                        if (stream.url && isValidUrl(stream.url)) {
                            addStream(stream.url);
                        }
                    });
                    sendResponse({ success: true, count: message.streams.length });
                }
                return true;
            });
        }

        // Also listen for postMessage (works across origins)
        window.addEventListener('message', (event) => {
            if (event.data && event.data.action === 'plexd-add-streams') {
                const streams = event.data.streams || [];
                streams.forEach(stream => {
                    if (stream.url && isValidUrl(stream.url)) {
                        addStream(stream.url);
                    }
                });
            }
        });
    }

    /**
     * Load streams from URL parameters and localStorage
     * New streams from URL are ADDED to existing streams in localStorage
     */
    function loadStreamsFromUrl() {
        // Load existing streams from localStorage first
        const savedStreams = JSON.parse(localStorage.getItem('plexd_streams') || '[]');
        console.log('[Plexd] Saved streams:', savedStreams.length);

        // Load saved streams
        savedStreams.forEach(url => {
            if (url && isValidUrl(url)) {
                addStreamSilent(url);
            }
        });

        // Check for new streams in URL params
        const params = new URLSearchParams(window.location.search);
        const streamsParam = params.get('streams');
        const queueParam = params.get('queue');

        if (streamsParam) {
            const urls = streamsParam.split('|||').map(s => decodeURIComponent(s.trim()));
            console.log('[Plexd] New streams from URL:', urls);

            let addedCount = 0;
            urls.forEach(url => {
                if (url && isValidUrl(url) && !savedStreams.includes(url)) {
                    addStream(url);
                    savedStreams.push(url);
                    addedCount++;
                }
            });

            // Save updated list
            localStorage.setItem('plexd_streams', JSON.stringify(savedStreams));

            if (addedCount > 0) {
                showMessage(`Added ${addedCount} new stream(s)`, 'success');
            }
        }

        // Handle queue parameter - add to queue instead of playing
        if (queueParam) {
            const urls = queueParam.split('|||').map(s => decodeURIComponent(s.trim()));
            console.log('[Plexd] Queueing from URL:', urls);

            let queuedCount = 0;
            urls.forEach(url => {
                if (url && isValidUrl(url) && !streamQueue.includes(url)) {
                    streamQueue.push(url);
                    queuedCount++;
                }
            });

            if (queuedCount > 0) {
                saveQueue();
                updateQueueUI();
                showMessage(`Queued ${queuedCount} video(s)`, 'success');
                // Open queue panel to show the newly added items
                const queuePanel = document.getElementById('queue-panel');
                if (queuePanel && !queuePanel.classList.contains('plexd-panel-open')) {
                    queuePanel.classList.add('plexd-panel-open');
                }
            }
        }

        // Clear URL params
        if ((streamsParam || queueParam) && window.history.replaceState) {
            window.history.replaceState({}, '', window.location.pathname);
        }
    }

    /**
     * Add stream without showing message (for loading saved streams)
     */
    function addStreamSilent(url) {
        const stream = PlexdStream.createStream(url, {
            autoplay: true,
            muted: true
        });
        containerEl.appendChild(stream.wrapper);
        updateStreamCount();
        updateLayout();
    }

    /**
     * Set up UI event listeners
     */
    function setupEventListeners() {
        // Add stream button
        if (addButtonEl) {
            addButtonEl.addEventListener('click', handleAddStream);
        }

        // Clear all button
        const clearAllBtn = document.getElementById('clear-all-btn');
        if (clearAllBtn) {
            clearAllBtn.addEventListener('click', clearAllStreams);
        }

        // Save combination button
        const saveComboBtn = document.getElementById('save-combo-btn');
        if (saveComboBtn) {
            saveComboBtn.addEventListener('click', saveStreamCombination);
        }

        // Enter key in input
        if (inputEl) {
            inputEl.addEventListener('keypress', (e) => {
                if (e.key === 'Enter') {
                    handleAddStream();
                }
            });
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', handleKeyboard);

        // F key for true fullscreen - enters grid fullscreen or toggles
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT') return;

            if (e.key === 'f' || e.key === 'F') {
                e.preventDefault();
                const mode = PlexdStream.getFullscreenMode();

                if (mode === 'true-grid' || mode === 'true-focused') {
                    // Already in true fullscreen - exit completely
                    PlexdStream.exitTrueFullscreen();
                } else {
                    // Enter grid fullscreen (shows all streams in true fullscreen)
                    PlexdStream.enterGridFullscreen();
                }
            }
        });
    }

    /**
     * Clear all streams and localStorage
     */
    function clearAllStreams() {
        // Remove all streams from display
        const streams = PlexdStream.getAllStreams();
        streams.forEach(stream => {
            PlexdStream.removeStream(stream.id);
        });

        // Clear localStorage
        localStorage.removeItem('plexd_streams');

        updateStreamCount();
        showMessage('All streams cleared', 'info');
    }

    /**
     * Handle adding a new stream
     */
    function handleAddStream() {
        if (!inputEl) return;

        const url = inputEl.value.trim();
        if (!url) {
            showMessage('Please enter a stream URL', 'error');
            return;
        }

        if (!isValidUrl(url)) {
            showMessage('Please enter a valid URL', 'error');
            return;
        }

        addStream(url);
        inputEl.value = '';
        inputEl.focus();
    }

    /**
     * Add a stream to the display
     */
    function addStream(url) {
        const stream = PlexdStream.createStream(url, {
            autoplay: true,
            muted: true
        });

        containerEl.appendChild(stream.wrapper);
        updateStreamCount();
        updateLayout();

        // Add to history
        addToHistory(url);

        showMessage(`Added stream: ${truncateUrl(url)}`, 'success');
    }

    /**
     * Update the grid layout
     */
    function updateLayout() {
        if (!containerEl) return;

        const allStreams = PlexdStream.getAllStreams();

        // Filter based on view mode (all or specific star rating)
        let streamsToShow = allStreams;
        if (viewMode !== 'all') {
            streamsToShow = PlexdStream.getStreamsByRating(viewMode);
        }

        // Handle visibility of streams based on view mode
        allStreams.forEach(stream => {
            if (viewMode === 'all') {
                stream.wrapper.style.display = '';
            } else {
                const rating = PlexdStream.getRating(stream.url);
                stream.wrapper.style.display = (rating === viewMode) ? '' : 'none';
            }
        });

        if (streamsToShow.length === 0) {
            if (viewMode !== 'all' && allStreams.length > 0) {
                const stars = '★'.repeat(viewMode);
                showEmptyState(`No ${stars} Streams`, `Rate streams with ${viewMode} star${viewMode > 1 ? 's' : ''} to see them here`);
            } else {
                showEmptyState();
            }
            return;
        }

        hideEmptyState();

        const container = {
            width: containerEl.clientWidth,
            height: containerEl.clientHeight
        };

        let layout;
        if (tetrisMode) {
            layout = calculateTetrisLayout(container, streamsToShow);
        } else {
            layout = PlexdGrid.calculateLayout(container, streamsToShow);
        }

        PlexdGrid.applyLayout(containerEl, layout, PlexdStream.getVideoElements());

        // Update stream controls based on cell size (responsive controls)
        layout.cells.forEach(cell => {
            PlexdStream.updateControlsSize(cell.streamId, cell.width, cell.height);
        });

        // Update grid columns for keyboard navigation
        PlexdStream.setGridCols(layout.cols);

        // Update efficiency display if element exists
        const efficiencyEl = document.getElementById('layout-efficiency');
        if (efficiencyEl) {
            efficiencyEl.textContent = Math.round(layout.efficiency * 100) + '%';
        }

        // Update ratings UI
        updateRatingsUI();
    }

    /**
     * Set view mode (all or 1-5 for star ratings)
     */
    function setViewMode(mode) {
        viewMode = mode;
        updateViewButtons();
        updateLayout();

        if (mode === 'all') {
            showMessage('View: All Streams', 'info');
        } else {
            const stars = '★'.repeat(mode);
            showMessage(`View: ${stars} Streams`, 'info');
        }
    }

    /**
     * Cycle to next view mode (V key)
     */
    function cycleViewMode() {
        const currentIndex = viewModes.indexOf(viewMode);
        const nextIndex = (currentIndex + 1) % viewModes.length;
        setViewMode(viewModes[nextIndex]);
    }

    /**
     * Update view button active states
     */
    function updateViewButtons() {
        const allBtn = document.getElementById('view-all-btn');
        if (allBtn) allBtn.classList.toggle('active', viewMode === 'all');

        for (let i = 1; i <= 5; i++) {
            const btn = document.getElementById(`view-${i}-btn`);
            if (btn) btn.classList.toggle('active', viewMode === i);
        }
    }

    /**
     * Toggle tetris layout mode
     */
    function toggleTetrisMode() {
        tetrisMode = !tetrisMode;

        const tetrisBtn = document.getElementById('tetris-btn');
        const app = document.querySelector('.plexd-app');

        if (tetrisBtn) tetrisBtn.classList.toggle('active', tetrisMode);
        if (app) app.classList.toggle('tetris-mode', tetrisMode);

        updateLayout();
        showMessage(`Tetris mode: ${tetrisMode ? 'ON' : 'OFF'}`, 'info');
    }

    /**
     * Toggle pause/play all streams
     */
    function togglePauseAll() {
        const paused = PlexdStream.togglePauseAll();
        const btn = document.getElementById('pause-all-btn');
        if (btn) btn.textContent = paused ? '▶' : '⏸';
        showMessage(paused ? 'All paused' : 'All playing', 'info');
    }

    /**
     * Toggle mute all streams
     */
    function toggleMuteAll() {
        const muted = PlexdStream.toggleMuteAll();
        const btn = document.getElementById('mute-all-btn');
        if (btn) btn.textContent = muted ? '🔊' : '🔇';
        showMessage(muted ? 'All muted' : 'All unmuted', 'info');
    }

    /**
     * Toggle audio focus mode
     */
    function toggleAudioFocus() {
        const mode = PlexdStream.toggleAudioFocus();
        const btn = document.getElementById('audio-focus-btn');
        if (btn) btn.classList.toggle('active', mode !== 'off');
        showMessage(`Audio focus: ${mode}`, 'info');
    }

    /**
     * Toggle clean mode (hide per-stream controls)
     */
    function toggleCleanMode() {
        const clean = PlexdStream.toggleCleanMode();
        const btn = document.getElementById('clean-mode-btn');
        if (btn) btn.classList.toggle('active', clean);
        showMessage(clean ? 'Clean mode ON' : 'Clean mode OFF', 'info');
    }

    /**
     * Toggle global fullscreen (grid fullscreen mode)
     * Enters true fullscreen with grid view (all streams visible)
     */
    function toggleGlobalFullscreen() {
        const mode = PlexdStream.getFullscreenMode();
        if (mode === 'true-grid' || mode === 'true-focused') {
            // Already in true fullscreen - exit
            PlexdStream.exitTrueFullscreen();
        } else {
            // Enter grid fullscreen
            PlexdStream.enterGridFullscreen();
        }
    }

    /**
     * Calculate Tetris-like layout based on video aspect ratios
     * Packs videos more efficiently by considering their actual proportions
     */
    function calculateTetrisLayout(container, streams) {
        const count = streams.length;
        if (count === 0) return { cells: [], rows: 0, cols: 0 };
        if (count === 1) {
            const fit = PlexdGrid.fitToContainer(container, streams[0].aspectRatio || 16/9);
            return {
                cells: [{
                    streamId: streams[0].id,
                    x: (container.width - fit.width) / 2,
                    y: (container.height - fit.height) / 2,
                    width: fit.width,
                    height: fit.height
                }],
                rows: 1,
                cols: 1,
                efficiency: (fit.width * fit.height) / (container.width * container.height)
            };
        }

        // Sort streams by aspect ratio (widest first for better packing)
        const sorted = [...streams].sort((a, b) =>
            (b.aspectRatio || 16/9) - (a.aspectRatio || 16/9)
        );

        // Use a bin-packing approach
        const cells = [];
        const occupied = []; // Track occupied regions

        // Calculate target cell sizes based on count
        const targetArea = (container.width * container.height) / count;
        const targetSize = Math.sqrt(targetArea);

        // Track available rows
        const rowHeights = [];
        let currentY = 0;
        let currentX = 0;
        let currentRowHeight = 0;
        let maxRowWidth = 0;

        sorted.forEach((stream, index) => {
            const aspectRatio = stream.aspectRatio || 16/9;

            // Calculate size for this video
            let width, height;
            if (aspectRatio > 1) {
                // Wide video
                width = Math.min(targetSize * Math.sqrt(aspectRatio), container.width * 0.6);
                height = width / aspectRatio;
            } else {
                // Tall video
                height = Math.min(targetSize / Math.sqrt(aspectRatio), container.height * 0.6);
                width = height * aspectRatio;
            }

            // Check if fits in current row
            if (currentX + width > container.width) {
                // Move to next row
                currentY += currentRowHeight;
                currentX = 0;
                currentRowHeight = 0;
            }

            // Check if fits vertically
            if (currentY + height > container.height) {
                // Scale down remaining videos to fit
                const remainingCount = count - index;
                const remainingHeight = container.height - currentY;
                const scaleFactor = Math.min(1, remainingHeight / height);
                width *= scaleFactor;
                height *= scaleFactor;
            }

            cells.push({
                streamId: stream.id,
                x: currentX,
                y: currentY,
                width: width,
                height: height
            });

            currentX += width;
            currentRowHeight = Math.max(currentRowHeight, height);
            maxRowWidth = Math.max(maxRowWidth, currentX);
        });

        // Center the layout
        const totalHeight = currentY + currentRowHeight;
        const offsetX = (container.width - maxRowWidth) / 2;
        const offsetY = (container.height - totalHeight) / 2;

        cells.forEach(cell => {
            cell.x += Math.max(0, offsetX);
            cell.y += Math.max(0, offsetY);
        });

        // Calculate efficiency
        const videoArea = cells.reduce((sum, cell) => sum + (cell.width * cell.height), 0);
        const efficiency = videoArea / (container.width * container.height);

        // Estimate cols for keyboard nav
        const avgWidth = cells.reduce((sum, cell) => sum + cell.width, 0) / cells.length;
        const cols = Math.round(container.width / avgWidth);

        return {
            cells,
            rows: Math.ceil(count / cols),
            cols,
            efficiency
        };
    }

    /**
     * Update stream count display
     */
    function updateStreamCount() {
        if (streamCountEl) {
            streamCountEl.textContent = PlexdStream.getStreamCount();
        }
    }

    /**
     * Show empty state message
     */
    function showEmptyState(title = 'No Streams', message = 'Enter a video URL above to add your first stream') {
        let emptyState = document.getElementById('empty-state');
        if (!emptyState) {
            emptyState = document.createElement('div');
            emptyState.id = 'empty-state';
            emptyState.className = 'plexd-empty-state';
            containerEl.appendChild(emptyState);
        }
        emptyState.innerHTML = `
            <h2>${escapeHtml(title)}</h2>
            <p>${escapeHtml(message)}</p>
        `;
        emptyState.style.display = 'flex';
    }

    /**
     * Hide empty state message
     */
    function hideEmptyState() {
        const emptyState = document.getElementById('empty-state');
        if (emptyState) {
            emptyState.style.display = 'none';
        }
    }

    // Track K key state for seek modifier
    let kKeyHeld = false;
    document.addEventListener('keydown', (e) => { if (e.key === 'k' || e.key === 'K') kKeyHeld = true; });
    document.addEventListener('keyup', (e) => { if (e.key === 'k' || e.key === 'K') kKeyHeld = false; });

    /**
     * Handle keyboard shortcuts
     */
    function handleKeyboard(e) {
        // Ignore if typing in input
        if (e.target.tagName === 'INPUT') return;

        const selected = PlexdStream.getSelectedStream();
        const fullscreenStream = PlexdStream.getFullscreenStream();

        switch (e.key) {
            case ' ':
                e.preventDefault();
                if (selected) {
                    // Toggle selected stream
                    if (selected.video.paused) {
                        selected.video.play().catch(() => {});
                    } else {
                        selected.video.pause();
                    }
                } else {
                    togglePlayPause();
                }
                break;
            case 'm':
            case 'M':
                if (selected) {
                    PlexdStream.toggleMute(selected.id);
                } else {
                    PlexdStream.muteAll();
                    showMessage('All streams muted', 'info');
                }
                break;
            case 'a':
            case 'A':
                const audioFocus = PlexdStream.toggleAudioFocus();
                showMessage(`Audio focus: ${audioFocus ? 'ON' : 'OFF'}`, 'info');
                break;
            case 'i':
            case 'I':
                const showInfo = PlexdStream.toggleAllStreamInfo();
                showMessage(`Stream info: ${showInfo ? 'ON' : 'OFF'}`, 'info');
                break;
            case 'p':
            case 'P':
                if (selected) {
                    PlexdStream.togglePiP(selected.id);
                }
                break;
            case 'ArrowRight':
                e.preventDefault();
                if (fullscreenStream && kKeyHeld) {
                    // K+Arrow: seek forward 10 seconds
                    PlexdStream.seekRelative(fullscreenStream.id, 10);
                } else if (fullscreenStream) {
                    // In focused fullscreen: switch to next stream (stay in focused mode)
                    switchFullscreenStream('right');
                } else {
                    PlexdStream.selectNextStream('right');
                }
                break;
            case 'ArrowLeft':
                e.preventDefault();
                if (fullscreenStream && kKeyHeld) {
                    // K+Arrow: seek backward 10 seconds
                    PlexdStream.seekRelative(fullscreenStream.id, -10);
                } else if (fullscreenStream) {
                    // In focused fullscreen: switch to prev stream (stay in focused mode)
                    switchFullscreenStream('left');
                } else {
                    PlexdStream.selectNextStream('left');
                }
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (fullscreenStream && kKeyHeld) {
                    // K+Arrow: seek forward 60 seconds
                    PlexdStream.seekRelative(fullscreenStream.id, 60);
                } else if (fullscreenStream) {
                    // In focused fullscreen: switch to stream above (stay in focused mode)
                    switchFullscreenStream('up');
                } else {
                    PlexdStream.selectNextStream('up');
                }
                break;
            case 'ArrowDown':
                e.preventDefault();
                if (fullscreenStream && kKeyHeld) {
                    // K+Arrow: seek backward 60 seconds
                    PlexdStream.seekRelative(fullscreenStream.id, -60);
                } else if (fullscreenStream) {
                    // In focused fullscreen: switch to stream below (stay in focused mode)
                    switchFullscreenStream('down');
                } else {
                    PlexdStream.selectNextStream('down');
                }
                break;
            case 'Enter':
            case 'z':
            case 'Z':
                // Enter or Z: focus on selected stream (enter focused mode)
                // In grid mode (normal or true-grid), this enters focused mode on selected stream
                // In focused mode, this does nothing (stay focused, use arrows to switch)
                {
                    const mode = PlexdStream.getFullscreenMode();
                    if (mode === 'true-focused' || mode === 'browser-fill') {
                        // Already in focused mode - do nothing (stay focused)
                        // User can use arrows to switch streams or Escape to exit
                    } else if (selected) {
                        // Enter focused mode on selected stream
                        PlexdStream.enterFocusedMode(selected.id);
                    } else if (mode === 'true-grid') {
                        // In grid fullscreen but no selection - select first stream
                        const streams = PlexdStream.getAllStreams();
                        if (streams.length > 0) {
                            PlexdStream.enterFocusedMode(streams[0].id);
                        }
                    }
                }
                break;
            case 'Delete':
            case 'Backspace':
                if (selected) {
                    PlexdStream.removeStream(selected.id);
                    updateStreamCount();
                    saveCurrentStreams();
                }
                break;
            case 's':
            case 'S':
                if (e.ctrlKey || e.metaKey) {
                    e.preventDefault();
                    saveStreamCombination();
                }
                break;
            case 'Escape':
                // Escape behavior depends on current mode:
                // - true-focused: return to true-grid (stay in true fullscreen)
                // - true-grid: exit true fullscreen completely
                // - browser-fill: exit to normal grid
                // - none: deselect
                {
                    const mode = PlexdStream.getFullscreenMode();
                    if (mode === 'true-focused') {
                        // Return to grid view in true fullscreen
                        PlexdStream.exitFocusedMode();
                    } else if (mode === 'true-grid') {
                        // Exit true fullscreen completely
                        PlexdStream.exitTrueFullscreen();
                    } else if (mode === 'browser-fill') {
                        // Exit browser-fill fullscreen
                        if (fullscreenStream) {
                            PlexdStream.toggleFullscreen(fullscreenStream.id);
                        }
                    } else {
                        // Normal mode - just deselect
                        PlexdStream.selectStream(null);
                    }
                    if (inputEl) inputEl.blur();
                }
                break;
            case '?':
                // Toggle keyboard shortcuts visibility
                toggleShortcutsOverlay();
                break;
            case 't':
            case 'T':
                // Toggle header toolbar
                toggleHeader();
                break;
            case 'v':
            case 'V':
                // Cycle view mode (all -> 1★ -> 2★ -> 3★ -> 4★ -> 5★ -> all)
                cycleViewMode();
                break;
            case 'g':
            case 'G':
                // Rate selected stream (cycle through ratings)
                if (selected) {
                    const newRating = PlexdStream.cycleRating(selected.id);
                    const stars = '★'.repeat(newRating);
                    showMessage(`Rated: ${stars}`, 'info');
                }
                break;
            case '0':
                // Clear rating on selected stream
                if (selected) {
                    PlexdStream.clearRating(selected.id);
                    showMessage('Rating cleared', 'info');
                }
                break;
            case '1':
            case '2':
            case '3':
            case '4':
            case '5':
                // Set specific rating on selected stream
                if (selected && !e.ctrlKey && !e.metaKey) {
                    const rating = parseInt(e.key);
                    PlexdStream.setRating(selected.id, rating);
                    const stars = '★'.repeat(rating);
                    showMessage(`Rated: ${stars}`, 'info');
                }
                break;
        }
    }

    /**
     * Switch fullscreen to next/prev stream in given direction
     * Stays in the current fullscreen mode (focused mode)
     * Respects current viewMode filter (rating subgroups)
     */
    function switchFullscreenStream(direction) {
        // Get streams based on current view mode filter
        let streams;
        if (viewMode === 'all') {
            streams = PlexdStream.getAllStreams();
        } else {
            streams = PlexdStream.getStreamsByRating(viewMode);
        }

        const fullscreenStream = PlexdStream.getFullscreenStream();
        if (!fullscreenStream || streams.length <= 1) return;

        const currentIndex = streams.findIndex(s => s.id === fullscreenStream.id);
        if (currentIndex === -1) return; // Current stream not in filtered set

        let newIndex;

        if (direction === 'right' || direction === 'down') {
            newIndex = (currentIndex + 1) % streams.length;
        } else {
            newIndex = (currentIndex - 1 + streams.length) % streams.length;
        }

        const newStream = streams[newIndex];
        const mode = PlexdStream.getFullscreenMode();

        // Switch to new stream while staying in focused mode
        PlexdStream.enterFocusedMode(newStream.id);

        // If was in true-focused mode, ensure wrapper gets focus for keyboard events
        if (mode === 'true-focused') {
            newStream.wrapper.focus();
        }
    }

    /**
     * Toggle keyboard shortcuts overlay visibility
     */
    function toggleShortcutsOverlay() {
        const shortcuts = document.querySelector('.plexd-shortcuts');
        if (shortcuts) {
            const isHidden = shortcuts.style.display === 'none';
            shortcuts.style.display = isHidden ? '' : 'none';
            localStorage.setItem('plexd_shortcuts_hidden', isHidden ? 'false' : 'true');
        }
    }

    /**
     * Load shortcuts visibility preference
     */
    function loadShortcutsPreference() {
        const shortcuts = document.querySelector('.plexd-shortcuts');
        const hidden = localStorage.getItem('plexd_shortcuts_hidden') === 'true';
        if (shortcuts && hidden) {
            shortcuts.style.display = 'none';
        }
    }

    /**
     * Toggle play/pause for all streams
     */
    function togglePlayPause() {
        const streams = PlexdStream.getAllStreams();
        if (streams.length === 0) return;

        // Check if any stream is playing
        const anyPlaying = streams.some(s => s.state === 'playing');

        if (anyPlaying) {
            PlexdStream.pauseAll();
            showMessage('All streams paused', 'info');
        } else {
            PlexdStream.playAll();
            showMessage('All streams playing', 'info');
        }
    }

    /**
     * Show a temporary message to the user
     */
    function showMessage(text, type = 'info') {
        let messageEl = document.getElementById('plexd-message');
        if (!messageEl) {
            messageEl = document.createElement('div');
            messageEl.id = 'plexd-message';
            document.body.appendChild(messageEl);
        }

        messageEl.textContent = text;
        messageEl.className = 'plexd-message plexd-message-' + type;
        messageEl.style.opacity = '1';

        // Fade out after delay
        setTimeout(() => {
            messageEl.style.opacity = '0';
        }, 2000);
    }

    /**
     * Validate URL format
     */
    function isValidUrl(string) {
        try {
            new URL(string);
            return true;
        } catch (_) {
            return false;
        }
    }

    /**
     * Truncate URL for display
     */
    function truncateUrl(url, maxLength = 50) {
        if (url.length <= maxLength) return url;
        return url.substring(0, maxLength - 3) + '...';
    }

    // Minimum duration (seconds) for a stream to be saved
    const MIN_STREAM_DURATION = 30;

    /**
     * Check if a stream should be saved (has sufficient duration)
     */
    function shouldSaveStream(stream) {
        const duration = stream.video && stream.video.duration;
        // Save if duration is unknown (not loaded yet) or meets minimum
        if (!duration || !isFinite(duration)) return true;
        return duration >= MIN_STREAM_DURATION;
    }

    /**
     * Save current streams to localStorage (excludes short videos)
     */
    function saveCurrentStreams() {
        const streams = PlexdStream.getAllStreams();
        const urls = streams
            .filter(s => shouldSaveStream(s))
            .map(s => s.url);
        localStorage.setItem('plexd_streams', JSON.stringify(urls));
    }

    /**
     * Extract unique domains from stream URLs
     * Returns domains that might require login (excludes common CDN domains)
     */
    function extractLoginDomains(urls) {
        const cdnPatterns = [
            /cdn\./i, /static\./i, /assets\./i, /media\./i,
            /cloudfront\.net/i, /akamaihd\.net/i, /cloudflare/i,
            /googleapis\.com/i, /gstatic\.com/i, /jsdelivr/i,
            /unpkg\.com/i, /commondatastorage/i
        ];

        const domains = new Set();
        urls.forEach(url => {
            try {
                const parsed = new URL(url);
                const hostname = parsed.hostname;
                // Skip CDN-like domains
                const isCDN = cdnPatterns.some(pattern => pattern.test(hostname));
                if (!isCDN) {
                    // Get the main domain (e.g., "example.com" from "stream.example.com")
                    const parts = hostname.split('.');
                    const mainDomain = parts.length > 2
                        ? parts.slice(-2).join('.')
                        : hostname;
                    domains.add(mainDomain);
                }
            } catch (e) {
                // Invalid URL, skip
            }
        });
        return Array.from(domains);
    }

    /**
     * Save current stream combination with a name
     */
    function saveStreamCombination() {
        const streams = PlexdStream.getAllStreams();
        if (streams.length === 0) {
            showMessage('No streams to save', 'error');
            return;
        }

        // Filter out short videos
        const validStreams = streams.filter(s => shouldSaveStream(s));
        if (validStreams.length === 0) {
            showMessage('No valid streams to save (all too short)', 'error');
            return;
        }

        const name = prompt('Enter a name for this stream combination:');
        if (!name) return;

        const urls = validStreams.map(s => s.url);
        const loginDomains = extractLoginDomains(urls);

        const combinations = JSON.parse(localStorage.getItem('plexd_combinations') || '{}');
        combinations[name] = {
            urls: urls,
            loginDomains: loginDomains,
            savedAt: Date.now()
        };
        localStorage.setItem('plexd_combinations', JSON.stringify(combinations));

        const skipped = streams.length - validStreams.length;
        let msg = `Saved: ${name} (${urls.length} streams)`;
        if (skipped > 0) {
            msg += ` - ${skipped} short video(s) excluded`;
        }
        if (loginDomains.length > 0) {
            msg += ` | Login: ${loginDomains.join(', ')}`;
        }
        showMessage(msg, 'success');
        updateCombinationsList();
    }

    /**
     * Load a saved stream combination
     */
    function loadStreamCombination(name) {
        const combinations = JSON.parse(localStorage.getItem('plexd_combinations') || '{}');
        const combo = combinations[name];

        if (!combo) {
            showMessage(`Combination "${name}" not found`, 'error');
            return;
        }

        // Check if there are login domains
        const loginDomains = combo.loginDomains || [];
        if (loginDomains.length > 0) {
            showLoginDomainsModal(name, loginDomains, () => {
                loadCombinationStreams(name, combo);
            });
        } else {
            loadCombinationStreams(name, combo);
        }
    }

    /**
     * Actually load the combination streams
     */
    function loadCombinationStreams(name, combo) {
        // Clear current streams
        const currentStreams = PlexdStream.getAllStreams();
        currentStreams.forEach(s => PlexdStream.removeStream(s.id));

        // Load saved streams
        combo.urls.forEach(url => {
            if (url && isValidUrl(url)) {
                addStreamSilent(url);
            }
        });

        // Save to current streams
        localStorage.setItem('plexd_streams', JSON.stringify(combo.urls));

        showMessage(`Loaded: ${name} (${combo.urls.length} streams)`, 'success');
        updateStreamCount();
    }

    /**
     * Show modal with login domains before loading combination
     */
    function showLoginDomainsModal(name, domains, onContinue) {
        // Remove existing modal if any
        const existingModal = document.getElementById('login-domains-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'login-domains-modal';
        modal.className = 'plexd-modal-overlay';
        modal.innerHTML = `
            <div class="plexd-modal">
                <h3>Login Required?</h3>
                <p>This combination uses streams from the following sites. You may need to be logged in for them to play:</p>
                <div class="plexd-domain-list">
                    ${domains.map(domain => `
                        <div class="plexd-domain-item">
                            <span>${escapeHtml(domain)}</span>
                            <button onclick="window.open('https://${escapeAttr(domain)}', '_blank')" class="plexd-button-small">
                                Open
                            </button>
                        </div>
                    `).join('')}
                </div>
                <div class="plexd-modal-hint">
                    Open these sites to login, then click "Load Streams" to continue.
                </div>
                <div class="plexd-modal-actions">
                    <button id="modal-cancel" class="plexd-button plexd-button-secondary">Cancel</button>
                    <button id="modal-continue" class="plexd-button plexd-button-primary">Load Streams</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Add event listeners
        document.getElementById('modal-cancel').addEventListener('click', () => {
            modal.remove();
        });

        document.getElementById('modal-continue').addEventListener('click', () => {
            modal.remove();
            onContinue();
        });

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                modal.remove();
            }
        });

        // Close on Escape
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                modal.remove();
                document.removeEventListener('keydown', handleEscape);
            }
        };
        document.addEventListener('keydown', handleEscape);
    }

    /**
     * Delete a saved combination
     */
    function deleteStreamCombination(name) {
        const combinations = JSON.parse(localStorage.getItem('plexd_combinations') || '{}');
        if (combinations[name]) {
            delete combinations[name];
            localStorage.setItem('plexd_combinations', JSON.stringify(combinations));
            showMessage(`Deleted: ${name}`, 'info');
            updateCombinationsList();
        }
    }

    /**
     * Get all saved combinations
     */
    function getSavedCombinations() {
        return JSON.parse(localStorage.getItem('plexd_combinations') || '{}');
    }

    /**
     * Export all saved combinations as a JSON file
     * On iOS, this triggers the share sheet for easy AirDrop
     */
    function exportCombinations() {
        const combinations = getSavedCombinations();
        const names = Object.keys(combinations);

        if (names.length === 0) {
            showMessage('No saved combinations to export', 'error');
            return;
        }

        const exportData = {
            version: 1,
            exportedAt: new Date().toISOString(),
            combinations: combinations
        };

        const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
        const url = URL.createObjectURL(blob);

        const a = document.createElement('a');
        a.href = url;
        a.download = `plexd-saves-${new Date().toISOString().slice(0, 10)}.json`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showMessage(`Exported ${names.length} combination(s)`, 'success');
    }

    /**
     * Import combinations from a JSON file
     */
    function importCombinations() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json,application/json';

        input.onchange = (e) => {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = (event) => {
                try {
                    const data = JSON.parse(event.target.result);

                    // Validate structure
                    if (!data.combinations || typeof data.combinations !== 'object') {
                        showMessage('Invalid file format', 'error');
                        return;
                    }

                    // Merge with existing combinations
                    const existing = getSavedCombinations();
                    let imported = 0;
                    let skipped = 0;

                    Object.keys(data.combinations).forEach(name => {
                        const combo = data.combinations[name];
                        if (combo.urls && Array.isArray(combo.urls)) {
                            if (existing[name]) {
                                // Rename if exists
                                const newName = name + ' (imported)';
                                existing[newName] = combo;
                                imported++;
                            } else {
                                existing[name] = combo;
                                imported++;
                            }
                        } else {
                            skipped++;
                        }
                    });

                    localStorage.setItem('plexd_combinations', JSON.stringify(existing));
                    updateCombinationsList();

                    let msg = `Imported ${imported} combination(s)`;
                    if (skipped > 0) msg += `, ${skipped} skipped`;
                    showMessage(msg, 'success');

                } catch (err) {
                    console.error('Import error:', err);
                    showMessage('Failed to parse file', 'error');
                }
            };
            reader.readAsText(file);
        };

        input.click();
    }

    /**
     * Update combinations list in UI (if present)
     */
    function updateCombinationsList() {
        const listEl = document.getElementById('combinations-list');
        if (!listEl) return;

        const combinations = getSavedCombinations();
        const names = Object.keys(combinations);

        if (names.length === 0) {
            listEl.innerHTML = '<div class="plexd-combo-empty">No saved combinations</div>';
            return;
        }

        listEl.innerHTML = names.map(name => {
            const combo = combinations[name];
            const loginCount = (combo.loginDomains || []).length;
            const loginHint = loginCount > 0 ? ` · ${loginCount} login site${loginCount > 1 ? 's' : ''}` : '';
            return `
                <div class="plexd-combo-item" data-name="${escapeAttr(name)}">
                    <span class="plexd-combo-name">${escapeHtml(name)}</span>
                    <span class="plexd-combo-count">${combo.urls.length} streams${loginHint}</span>
                    <button class="plexd-combo-load" onclick="PlexdApp.loadCombination('${escapeAttr(name)}')">Load</button>
                    <button class="plexd-combo-delete" onclick="PlexdApp.deleteCombination('${escapeAttr(name)}')">×</button>
                </div>
            `;
        }).join('');
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
     * Escape for attribute
     */
    function escapeAttr(text) {
        return text.replace(/'/g, "\\'").replace(/"/g, '&quot;');
    }

    /**
     * Debounce helper
     */
    function debounce(func, wait) {
        let timeout;
        return function(...args) {
            clearTimeout(timeout);
            timeout = setTimeout(() => func.apply(this, args), wait);
        };
    }

    // ========================================
    // Queue Management
    // ========================================

    /**
     * Add stream URL to queue
     */
    function addToQueue(url) {
        if (!url || !isValidUrl(url)) return;
        if (!streamQueue.includes(url)) {
            streamQueue.push(url);
            saveQueue();
            updateQueueUI();
            showMessage('Added to queue', 'info');
        }
    }

    /**
     * Remove from queue by index
     */
    function removeFromQueue(index) {
        if (index >= 0 && index < streamQueue.length) {
            streamQueue.splice(index, 1);
            saveQueue();
            updateQueueUI();
        }
    }

    /**
     * Play next from queue
     */
    function playFromQueue() {
        if (streamQueue.length > 0) {
            const url = streamQueue.shift();
            saveQueue();
            updateQueueUI();
            addStream(url);
        }
    }

    /**
     * Play all from queue
     */
    function playAllFromQueue() {
        while (streamQueue.length > 0) {
            const url = streamQueue.shift();
            addStreamSilent(url);
        }
        saveQueue();
        updateQueueUI();
        updateLayout();
        showMessage('Playing all queued streams', 'success');
    }

    /**
     * Save queue to localStorage
     */
    function saveQueue() {
        localStorage.setItem('plexd_queue', JSON.stringify(streamQueue));
    }

    /**
     * Load queue from localStorage
     */
    function loadQueue() {
        const saved = localStorage.getItem('plexd_queue');
        if (saved) {
            const urls = JSON.parse(saved);
            streamQueue.length = 0;
            streamQueue.push(...urls);
        }
    }

    /**
     * Update queue UI
     */
    function updateQueueUI() {
        const queueList = document.getElementById('queue-list');
        const queueCount = document.getElementById('queue-count');

        if (queueCount) {
            queueCount.textContent = streamQueue.length;
        }

        if (queueList) {
            if (streamQueue.length === 0) {
                queueList.innerHTML = '<div class="plexd-panel-empty">Queue is empty</div>';
            } else {
                queueList.innerHTML = streamQueue.map((url, i) => `
                    <div class="plexd-queue-item">
                        <span class="plexd-queue-url">${escapeHtml(truncateUrl(url, 40))}</span>
                        <button onclick="PlexdApp.removeFromQueue(${i})" title="Remove">×</button>
                    </div>
                `).join('');
            }
        }
    }

    // ========================================
    // History Management
    // ========================================

    /**
     * Add to history
     */
    function addToHistory(url) {
        if (!url) return;

        // Remove if already exists (move to top)
        const existingIndex = streamHistory.findIndex(h => h.url === url);
        if (existingIndex >= 0) {
            streamHistory.splice(existingIndex, 1);
        }

        // Add to beginning
        streamHistory.unshift({
            url,
            timestamp: Date.now()
        });

        // Keep only last 50
        if (streamHistory.length > 50) {
            streamHistory.pop();
        }

        saveHistory();
        updateHistoryUI();
    }

    /**
     * Clear history
     */
    function clearHistory() {
        streamHistory.length = 0;
        saveHistory();
        updateHistoryUI();
        showMessage('History cleared', 'info');
    }

    /**
     * Save history to localStorage
     */
    function saveHistory() {
        localStorage.setItem('plexd_history', JSON.stringify(streamHistory));
    }

    /**
     * Load history from localStorage
     */
    function loadHistory() {
        const saved = localStorage.getItem('plexd_history');
        if (saved) {
            const items = JSON.parse(saved);
            streamHistory.length = 0;
            streamHistory.push(...items);
        }
    }

    /**
     * Update history UI
     */
    function updateHistoryUI() {
        const historyList = document.getElementById('history-list');

        if (historyList) {
            if (streamHistory.length === 0) {
                historyList.innerHTML = '<div class="plexd-panel-empty">No history yet</div>';
            } else {
                historyList.innerHTML = streamHistory.slice(0, 20).map(item => {
                    const ago = formatTimeAgo(item.timestamp);
                    return `
                        <div class="plexd-history-item" onclick="PlexdApp.addStream('${escapeAttr(item.url)}')">
                            <span class="plexd-history-url">${escapeHtml(truncateUrl(item.url, 35))}</span>
                            <span class="plexd-history-time">${ago}</span>
                        </div>
                    `;
                }).join('');
            }
        }
    }

    /**
     * Format timestamp as "X ago"
     */
    function formatTimeAgo(timestamp) {
        const seconds = Math.floor((Date.now() - timestamp) / 1000);

        if (seconds < 60) return 'just now';
        if (seconds < 3600) return Math.floor(seconds / 60) + 'm ago';
        if (seconds < 86400) return Math.floor(seconds / 3600) + 'h ago';
        return Math.floor(seconds / 86400) + 'd ago';
    }

    /**
     * Toggle panel visibility
     */
    function togglePanel(panelId) {
        const panel = document.getElementById(panelId);
        if (panel) {
            panel.classList.toggle('plexd-panel-open');
        }
    }

    // Public API
    return {
        init,
        addStream,
        updateLayout,
        showMessage,
        saveCurrentStreams,
        saveCombination: saveStreamCombination,
        loadCombination: loadStreamCombination,
        deleteCombination: deleteStreamCombination,
        getSavedCombinations,
        exportCombinations,
        importCombinations,
        // Queue
        addToQueue,
        removeFromQueue,
        playFromQueue,
        playAllFromQueue,
        // History
        clearHistory,
        togglePanel,
        // View modes
        setViewMode,
        cycleViewMode,
        toggleTetrisMode,
        toggleHeader,
        // Global controls
        togglePauseAll,
        toggleMuteAll,
        toggleAudioFocus,
        toggleCleanMode,
        toggleGlobalFullscreen
    };
})();

// Expose to window for extension access
window.PlexdApp = PlexdApp;

// Initialize when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', PlexdApp.init);
} else {
    PlexdApp.init();
}

// Export for module systems if available
if (typeof module !== 'undefined' && module.exports) {
    module.exports = PlexdApp;
}
