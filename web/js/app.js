/**
 * Plexd Main Application
 *
 * Coordinates the grid layout engine and stream manager.
 * Handles user interactions and application state.
 */

const PlexdApp = (function() {
    'use strict';

    // ========================================
    // IndexedDB for Local File Storage
    // ========================================

    const DB_NAME = 'PlexdLocalFiles';
    const DB_VERSION = 1;
    const STORE_NAME = 'files';
    let dbInstance = null;

    /**
     * Open or create the IndexedDB database
     */
    function openDatabase() {
        return new Promise((resolve, reject) => {
            if (dbInstance) {
                resolve(dbInstance);
                return;
            }

            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => {
                console.error('[Plexd] IndexedDB error:', request.error);
                reject(request.error);
            };

            request.onsuccess = () => {
                dbInstance = request.result;
                resolve(dbInstance);
            };

            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    const store = db.createObjectStore(STORE_NAME, { keyPath: 'id' });
                    store.createIndex('setName', 'setName', { unique: false });
                    store.createIndex('fileName', 'fileName', { unique: false });
                }
            };
        });
    }

    /**
     * Save a local file blob to IndexedDB
     * @param {string} setName - The combination/set name
     * @param {string} fileName - Original file name
     * @param {Blob} blob - The file blob data
     */
    async function saveLocalFileToDisc(setName, fileName, blob) {
        try {
            const db = await openDatabase();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);

            const id = `${setName}::${fileName}`;
            const data = {
                id: id,
                setName: setName,
                fileName: fileName,
                blob: blob,
                savedAt: Date.now(),
                size: blob.size,
                type: blob.type
            };

            await new Promise((resolve, reject) => {
                const request = store.put(data);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });

            console.log(`[Plexd] Saved local file to disc: ${fileName} (${formatBytes(blob.size)})`);
            return true;
        } catch (err) {
            console.error('[Plexd] Failed to save local file:', err);
            return false;
        }
    }

    /**
     * Load a local file from IndexedDB
     * @param {string} setName - The combination/set name
     * @param {string} fileName - Original file name
     * @returns {Promise<{url: string, fileName: string}|null>}
     */
    async function loadLocalFileFromDisc(setName, fileName) {
        try {
            const db = await openDatabase();
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);

            const id = `${setName}::${fileName}`;
            const data = await new Promise((resolve, reject) => {
                const request = store.get(id);
                request.onsuccess = () => resolve(request.result);
                request.onerror = () => reject(request.error);
            });

            if (data && data.blob) {
                const url = URL.createObjectURL(data.blob);
                console.log(`[Plexd] Loaded local file from disc: ${fileName}`);
                return { url, fileName: data.fileName };
            }
            return null;
        } catch (err) {
            console.error('[Plexd] Failed to load local file:', err);
            return null;
        }
    }

    /**
     * Get all saved local files for a set
     * @param {string} setName - The combination/set name
     * @returns {Promise<Array<{fileName: string, size: number}>>}
     */
    async function getSavedLocalFiles(setName) {
        try {
            const db = await openDatabase();
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const index = store.index('setName');

            const files = await new Promise((resolve, reject) => {
                const request = index.getAll(setName);
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });

            return files.map(f => ({ fileName: f.fileName, size: f.size }));
        } catch (err) {
            console.error('[Plexd] Failed to get saved files:', err);
            return [];
        }
    }

    /**
     * Delete all local files for a set from IndexedDB
     * @param {string} setName - The combination/set name
     */
    async function deleteLocalFilesForSet(setName) {
        try {
            const db = await openDatabase();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);
            const index = store.index('setName');

            const keys = await new Promise((resolve, reject) => {
                const request = index.getAllKeys(setName);
                request.onsuccess = () => resolve(request.result || []);
                request.onerror = () => reject(request.error);
            });

            for (const key of keys) {
                store.delete(key);
            }

            await new Promise((resolve, reject) => {
                tx.oncomplete = () => resolve();
                tx.onerror = () => reject(tx.error);
            });

            if (keys.length > 0) {
                console.log(`[Plexd] Deleted ${keys.length} local files for set: ${setName}`);
            }
        } catch (err) {
            console.error('[Plexd] Failed to delete local files:', err);
        }
    }

    /**
     * Format bytes to human readable string
     */
    function formatBytes(bytes) {
        if (bytes === 0) return '0 B';
        const k = 1024;
        const sizes = ['B', 'KB', 'MB', 'GB'];
        const i = Math.floor(Math.log(bytes) / Math.log(k));
        return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    }

    // DOM references
    let containerEl = null;
    let inputEl = null;
    let addButtonEl = null;
    let streamCountEl = null;

    // Queue and History
    const streamQueue = [];
    const streamHistory = [];

    // View mode: 'all', 'favorites', or 1-9 for rating slots
    let viewMode = 'all';
    window._plexdViewMode = viewMode;

    // View mode cycle order: favorites -> all -> 1 -> 2 -> ... -> 9 -> favorites
    const viewModes = ['favorites', 'all', 1, 2, 3, 4, 5, 6, 7, 8, 9];

    // Layout modes
    // Tetris mode: Intelligent bin-packing that eliminates black bars (object-fit: cover)
    // 0 = off, 1 = row-pack (rows with varying heights), 2 = column-pack (columns with varying widths),
    // 3 = split-pack (treemap-style recursive splitting)
    let tetrisMode = 0;
    window._plexdTetrisMode = tetrisMode;

    // Coverflow mode: Z-depth overlapping with hover-to-front effects
    let coverflowMode = false;
    window._plexdCoverflowMode = coverflowMode;

    // Legacy alias for compatibility (maps to coverflow)
    let smartLayoutMode = false;
    window._plexdSmartLayoutMode = smartLayoutMode;

    // Header visibility (starts hidden)
    let headerVisible = false;
    window._plexdHeaderVisible = headerVisible;

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

        // Sync audio focus UI to actual state
        if (PlexdStream.getAudioFocusMode) {
            updateAudioFocusButton(PlexdStream.getAudioFocusMode());
        }

        // Set up ratings callback
        PlexdStream.setRatingsUpdateCallback(updateRatingsUI);
        updateRatingsUI();

        // Set up favorites callback
        PlexdStream.setFavoritesUpdateCallback(updateFavoritesUI);
        updateFavoritesUI();

        // Load streams from URL parameters (from extension)
        loadStreamsFromUrl();

        // Sync rating and favorite status for loaded streams and auto-assign ratings to unrated videos
        // Only assign ratings if streams don't already have saved ratings
        setTimeout(() => {
            PlexdStream.syncRatingStatus();
            PlexdStream.syncFavoriteStatus();
            // distributeRatingsEvenly() now only assigns to streams without saved ratings
            const assigned = PlexdStream.distributeRatingsEvenly();
            if (assigned > 0) {
                console.log(`[Plexd] Auto-assigned ratings to ${assigned} unrated videos`);
            }
        }, 100);

        // Set up focus handling
        setupFocusHandling();

        console.log('Plexd initialized');
    }

    /**
     * Set up focus handling to ensure keyboard shortcuts work
     * Shows a warning when focus is in an input field
     */
    function setupFocusHandling() {
        const app = document.querySelector('.plexd-app');

        // Make the app focusable
        if (app) {
            app.tabIndex = -1;
        }

        // Create focus warning element
        const focusWarning = document.createElement('div');
        focusWarning.className = 'plexd-focus-warning';
        focusWarning.innerHTML = 'Press <kbd>Esc</kbd> or click here to enable shortcuts';
        focusWarning.onclick = () => {
            // Reset focus to app container
            if (isTypingTarget(document.activeElement)) {
                document.activeElement.blur();
            }
            if (app) app.focus();
            focusWarning.classList.remove('visible');
        };
        document.body.appendChild(focusWarning);

        // Monitor focus changes
        document.addEventListener('focusin', (e) => {
            if (isTypingTarget(e.target)) {
                // Show warning that shortcuts won't work while typing
                focusWarning.classList.add('visible');
            } else {
                focusWarning.classList.remove('visible');
            }
        });

        document.addEventListener('focusout', () => {
            // Small delay to check if focus moved to another input
            setTimeout(() => {
                if (!isTypingTarget(document.activeElement)) {
                    focusWarning.classList.remove('visible');
                }
            }, 50);
        });

        // Click on container (not on streams) should reset focus
        if (containerEl) {
            containerEl.addEventListener('click', (e) => {
                // Only if click wasn't on a stream
                if (e.target === containerEl || e.target.id === 'empty-state') {
                    if (app) app.focus();
                }
            });
        }
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

        // Store the filename for display and rating persistence
        stream.fileName = fileName;

        // Apply any persisted rating/favorite for this fileName immediately (blob URLs are ephemeral).
        PlexdStream.syncRatingStatus();
        PlexdStream.syncFavoriteStatus();

        containerEl.appendChild(stream.wrapper);
        updateStreamCount();
        updateLayout();

        // Sync rating/favorite status first (restores saved state for this fileName)
        PlexdStream.syncRatingStatus();
        PlexdStream.syncFavoriteStatus();

        // Auto-assign rating only if no saved rating exists
        // distributeRatingsEvenly() now only assigns to streams without saved ratings
        PlexdStream.distributeRatingsEvenly();

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
        window._plexdHeaderVisible = headerVisible;

        if (headerVisible) {
            header.classList.remove('plexd-header-hidden');
            toggleBtn.classList.add('header-visible');
            toggleBtn.innerHTML = '☰';
            toggleBtn.title = 'Hide toolbar (H)';
            app.classList.remove('header-hidden');
        } else {
            header.classList.add('plexd-header-hidden');
            toggleBtn.classList.remove('header-visible');
            toggleBtn.innerHTML = '☰';
            toggleBtn.title = 'Show toolbar (H)';
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
        for (let i = 1; i <= 9; i++) {
            const badge = document.getElementById(`rating-${i}-count`);
            if (badge) {
                const count = counts[i] || 0;
                badge.textContent = count ? count : '';
                badge.dataset.count = String(count);
            }
        }

        // Update current view button active state
        updateViewButtons();

        // Update filter indicator count (in case rating changed affects count)
        updateFilterIndicator();
    }

    /**
     * Update favorites UI elements
     */
    function updateFavoritesUI() {
        const count = PlexdStream.getFavoriteCount();

        // Update favorites button badge
        const badge = document.getElementById('favorites-count');
        if (badge) {
            badge.textContent = count ? count : '';
            badge.dataset.count = String(count);
        }

        // Update current view button active state
        updateViewButtons();

        // Update filter indicator count (in case favorites changed affects count)
        updateFilterIndicator();

        // If in favorites view mode, update layout to reflect changes
        if (viewMode === 'favorites') {
            updateLayout();
        }
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

        // Load saved streams (deduped by normalized equality key)
        const savedKeys = new Set();
        const dedupedSavedStreams = [];
        savedStreams.forEach(url => {
            if (!url || !isValidUrl(url)) return;
            const key = urlEqualityKey(url);
            if (savedKeys.has(key)) return;
            savedKeys.add(key);
            dedupedSavedStreams.push(url);
            addStreamSilent(url);
        });

        // If localStorage contained duplicates/variants, clean it up for future runs.
        if (dedupedSavedStreams.length !== savedStreams.length) {
            localStorage.setItem('plexd_streams', JSON.stringify(dedupedSavedStreams));
        }

        // Check for new streams in URL params
        const params = new URLSearchParams(window.location.search);
        const streamsParam = params.get('streams');
        const queueParam = params.get('queue');

        if (streamsParam) {
            const urls = streamsParam.split('|||').map(s => decodeURIComponent(s.trim()));
            console.log('[Plexd] New streams from URL:', urls);

            let addedCount = 0;
            urls.forEach(url => {
                if (!url || !isValidUrl(url)) return;
                const key = urlEqualityKey(url);
                if (savedKeys.has(key)) return;
                if (addStream(url)) {
                    savedKeys.add(key);
                    dedupedSavedStreams.push(url);
                    addedCount++;
                }
            });

            // Save updated list
            localStorage.setItem('plexd_streams', JSON.stringify(dedupedSavedStreams));

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
                openPanel('queue-panel');
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
        // Avoid duplicates - equality based on normalized URL (network URLs).
        const key = urlEqualityKey(url);
        const existing = PlexdStream.getAllStreams().find(s => urlEqualityKey(s.url) === key);
        if (existing) {
            PlexdStream.selectStream(existing.id);
            return;
        }

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

        // F key for true fullscreen - toggles true fullscreen (hides browser chrome)
        document.addEventListener('keydown', (e) => {
            if (isTypingTarget(e.target)) return;

            if (e.key === 'f' || e.key === 'F') {
                e.preventDefault();
                const mode = PlexdStream.getFullscreenMode();

                // F toggles true fullscreen
                if (mode === 'true-grid' || mode === 'true-focused') {
                    // Exit true fullscreen completely
                    PlexdStream.exitTrueFullscreen();
                } else {
                    // Enter true fullscreen (grid mode)
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

        const input = inputEl.value.trim();
        if (!input) {
            showMessage('Please enter a stream URL', 'error');
            return;
        }

        // Split by newlines, commas, or spaces to support multiple URLs
        const urls = input.split(/[\n,\s]+/).filter(u => u.trim());
        let addedCount = 0;

        urls.forEach(url => {
            url = url.trim();
            if (url && isValidUrl(url)) {
                if (addStream(url)) {
                    addedCount++;
                }
            }
        });

        if (addedCount === 0) {
            showMessage('No valid URLs found', 'error');
        } else if (addedCount > 1) {
            showMessage(`Added ${addedCount} streams`, 'success');
        }

        inputEl.value = '';
        inputEl.focus();
    }

    /**
     * Add a stream to the display
     */
    function addStream(url) {
        // Avoid duplicates - equality based on normalized URL (network URLs).
        const key = urlEqualityKey(url);
        const existing = PlexdStream.getAllStreams().find(s => urlEqualityKey(s.url) === key);
        if (existing) {
            PlexdStream.selectStream(existing.id);
            if (existing.wrapper && existing.wrapper.focus) {
                existing.wrapper.focus();
            }
            showMessage('Stream already added', 'info');
            return false;
        }

        const stream = PlexdStream.createStream(url, {
            autoplay: true,
            muted: true
        });

        containerEl.appendChild(stream.wrapper);
        updateStreamCount();
        updateLayout();

        // Auto-assign rating to the new video
        PlexdStream.distributeRatingsEvenly();

        // Add to history
        addToHistory(url);

        showMessage(`Added stream: ${truncateUrl(url)}`, 'success');
        return true;
    }

    /**
     * Update the grid layout
     */
    function updateLayout() {
        if (!containerEl) return;

        const allStreams = PlexdStream.getAllStreams();

        // Filter based on view mode (all, favorites, or specific star rating)
        let streamsToShow = allStreams;
        if (viewMode === 'favorites') {
            streamsToShow = PlexdStream.getFavoriteStreams();
        } else if (viewMode !== 'all') {
            streamsToShow = PlexdStream.getStreamsByRating(viewMode);
        }

        // Handle visibility and playback of streams based on view mode
        // When filtering by rating/favorites, pause hidden streams to save bandwidth
        // Use position-preserving pause/resume to avoid streams restarting
        const isGloballyPaused = PlexdStream.isGloballyPaused();
        allStreams.forEach(stream => {
            if (viewMode === 'all') {
                stream.wrapper.style.display = '';
                // Resume playback for all streams when viewing all (if not globally paused)
                // Only resume streams we auto-paused for filtering (so we don't override user pauses).
                if (!isGloballyPaused && stream._plexdAutoPausedForFilter) {
                    PlexdStream.resumeStream(stream.id);
                    stream._plexdAutoPausedForFilter = false;
                }
            } else {
                // Determine visibility based on view mode (favorites or rating)
                let isVisible;
                if (viewMode === 'favorites') {
                    isVisible = PlexdStream.getFavorite(stream.url, stream.fileName);
                } else {
                    const rating = PlexdStream.getRating(stream.url);
                    isVisible = (rating === viewMode);
                }
                stream.wrapper.style.display = isVisible ? '' : 'none';
                // Pause hidden streams to save bandwidth, play visible ones (if not globally paused)
                if (isVisible && !isGloballyPaused && stream._plexdAutoPausedForFilter) {
                    PlexdStream.resumeStream(stream.id);
                    stream._plexdAutoPausedForFilter = false;
                } else if (!isVisible) {
                    // IMPORTANT:
                    // Pausing live/HLS streams frequently causes an apparent "restart" when shown again.
                    // To avoid that UX regression, we only auto-pause streams that look safe to pause
                    // (finite-duration files/VOD). Live/HLS streams stay playing but hidden.
                    const duration = stream.video ? stream.video.duration : 0;
                    const isFiniteDuration = duration && Number.isFinite(duration) && duration > 0;
                    const isLocalFile = stream.url && stream.url.startsWith('blob:');
                    const isHlsLike = !!stream.hls || (stream.url && stream.url.toLowerCase().includes('.m3u8'));

                    const safeToAutoPause = isLocalFile || (isFiniteDuration && !isHlsLike);

                    if (safeToAutoPause) {
                        // Mark as auto-paused only if it was actually playing.
                        // This lets us resume it later without overriding user-intended pauses.
                        if (stream.video && !stream.video.paused) {
                            stream._plexdAutoPausedForFilter = true;
                        }
                        PlexdStream.pauseStream(stream.id);
                    } else {
                        // Not safe to pause: do not touch playback state.
                        stream._plexdAutoPausedForFilter = false;
                    }
                }
            }
        });

        if (streamsToShow.length === 0) {
            if (viewMode === 'favorites' && allStreams.length > 0) {
                showEmptyState('No Favorites', 'Press * on a selected stream to add it to favorites');
            } else if (viewMode !== 'all' && allStreams.length > 0) {
                showEmptyState(`No ★${viewMode} Streams`, `Assign streams to slot ${viewMode} to see them here`);
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
        if (tetrisMode > 0) {
            // Tetris mode: Intelligent bin-packing that eliminates black bars
            // Pass the specific mode (1=rows, 2=columns, 3=treemap)
            layout = PlexdGrid.calculateTetrisLayout(container, streamsToShow, tetrisMode);
        } else if (coverflowMode) {
            // Coverflow mode: Z-depth overlapping with hover effects
            layout = PlexdGrid.calculateCoverflowLayout(container, streamsToShow);
        } else {
            // Standard grid layout
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

        // Update streams panel UI
        updateStreamsPanelUI();
    }

    /**
     * Set view mode (all, favorites, or 1-9 for star ratings)
     */
    function setViewMode(mode) {
        viewMode = mode;
        window._plexdViewMode = mode;
        updateViewButtons();
        updateFilterIndicator();
        updateLayout();

        if (mode === 'all') {
            showMessage('View: All Streams', 'info');
        } else if (mode === 'favorites') {
            const count = PlexdStream.getFavoriteCount();
            showMessage(`View: Favorites ★ (${count} streams)`, 'info');
        } else {
            const count = PlexdStream.getStreamsByRating(mode).length;
            showMessage(`View: ★${mode} (${count} streams)`, 'info');
        }
    }

    /**
     * Update the filter indicator badge in header
     */
    function updateFilterIndicator() {
        const indicator = document.getElementById('filter-indicator');
        const starsEl = document.getElementById('filter-stars');
        const countEl = document.getElementById('filter-count');

        if (!indicator) return;

        if (viewMode === 'all') {
            indicator.style.display = 'none';
        } else if (viewMode === 'favorites') {
            const count = PlexdStream.getFavoriteCount();
            starsEl.textContent = '★ Favorites';
            countEl.textContent = `(${count})`;
            indicator.style.display = 'flex';
        } else {
            const count = PlexdStream.getStreamsByRating(viewMode).length;
            starsEl.textContent = `★${viewMode}`;
            countEl.textContent = `(${count})`;
            indicator.style.display = 'flex';
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
        const favBtn = document.getElementById('view-favorites-btn');
        if (favBtn) favBtn.classList.toggle('active', viewMode === 'favorites');

        const allBtn = document.getElementById('view-all-btn');
        if (allBtn) allBtn.classList.toggle('active', viewMode === 'all');

        for (let i = 1; i <= 9; i++) {
            const btn = document.getElementById(`view-${i}-btn`);
            if (btn) btn.classList.toggle('active', viewMode === i);
        }
    }

    /**
     * Tetris mode names for display
     * Mode 4 is the special "Content Visible" mode that shows all content without cropping
     */
    const tetrisModeNames = ['OFF', 'Rows', 'Columns', 'Treemap', 'Content Visible'];

    /**
     * Cycle Tetris mode - Intelligent bin-packing layouts
     * Cycles through: 0 (off) -> 1 (rows) -> 2 (columns) -> 3 (treemap) -> 4 (content-visible) -> 0 (off)
     *
     * Modes 1-3: Use object-fit: cover to crop videos and fill space (eliminates black bars)
     * Mode 4: Shows ALL video content without cropping, allows smart overlap of black bars
     */
    function cycleTetrisMode() {
        // Turn off coverflow if it's on
        if (coverflowMode) {
            coverflowMode = false;
            window._plexdCoverflowMode = false;
            const coverflowBtn = document.getElementById('coverflow-btn');
            if (coverflowBtn) coverflowBtn.classList.remove('active');
        }

        // Cycle through modes: 0 -> 1 -> 2 -> 3 -> 4 -> 0
        tetrisMode = (tetrisMode + 1) % 5;
        window._plexdTetrisMode = tetrisMode;

        const tetrisBtn = document.getElementById('tetris-btn');
        const app = document.querySelector('.plexd-app');

        if (tetrisBtn) tetrisBtn.classList.toggle('active', tetrisMode > 0);
        if (app) {
            app.classList.toggle('tetris-mode', tetrisMode > 0);
            // Add specific mode class for CSS targeting
            app.classList.remove('tetris-mode-1', 'tetris-mode-2', 'tetris-mode-3', 'tetris-mode-4');
            if (tetrisMode > 0) {
                app.classList.add(`tetris-mode-${tetrisMode}`);
            }
            // Special class for content visible mode
            app.classList.toggle('tetris-content-visible', tetrisMode === 4);
            app.classList.remove('coverflow-mode');
            app.classList.remove('smart-layout-mode');
        }

        updateLayout();
        showMessage(`Tetris: ${tetrisModeNames[tetrisMode]}`, 'info');
    }

    /**
     * Legacy toggle function for compatibility - cycles to next mode or off
     */
    function toggleTetrisMode() {
        cycleTetrisMode();
    }

    /**
     * Toggle Coverflow mode - Z-depth overlapping with hover-to-front effects
     * Videos can overlap into each other's letterbox zones with visual layering
     */
    function toggleCoverflowMode() {
        // Turn off tetris if it's on
        if (tetrisMode) {
            tetrisMode = false;
            window._plexdTetrisMode = false;
            const tetrisBtn = document.getElementById('tetris-btn');
            if (tetrisBtn) tetrisBtn.classList.remove('active');
        }

        coverflowMode = !coverflowMode;
        window._plexdCoverflowMode = coverflowMode;

        // Keep legacy alias in sync
        smartLayoutMode = coverflowMode;
        window._plexdSmartLayoutMode = smartLayoutMode;

        const coverflowBtn = document.getElementById('coverflow-btn');
        const smartBtn = document.getElementById('smart-layout-btn');
        const app = document.querySelector('.plexd-app');

        if (coverflowBtn) coverflowBtn.classList.toggle('active', coverflowMode);
        if (smartBtn) smartBtn.classList.toggle('active', coverflowMode);
        if (app) {
            app.classList.toggle('coverflow-mode', coverflowMode);
            app.classList.toggle('smart-layout-mode', coverflowMode); // Legacy class
            app.classList.remove('tetris-mode');
        }

        updateLayout();
        if (coverflowMode) {
            showMessage('Selector: ON (← → to browse, Enter to focus)', 'info');
        } else {
            showMessage('Selector: OFF', 'info');
        }
    }

    /**
     * Legacy alias for backward compatibility - maps to Coverflow
     */
    function toggleSmartLayoutMode() {
        toggleCoverflowMode();
    }

    // Bug Eye mode state
    let bugEyeMode = false;
    let bugEyeOverlay = null;
    let bugEyeAnimationFrame = null;

    /**
     * Toggle Bug Eye mode - creates a compound eye / kaleidoscope effect
     * with the focused stream replicated at different sizes around the edges
     */
    function toggleBugEyeMode() {
        const fullscreenStream = PlexdStream.getFullscreenStream();
        const selected = PlexdStream.getSelectedStream();
        const targetStream = fullscreenStream || selected;

        if (!targetStream) {
            showMessage('Select or focus a stream first (Z key)', 'warning');
            return;
        }

        // If Mosaic mode is on, turn it off first (they share visual space)
        if (mosaicMode) {
            destroyMosaicOverlay();
        }

        bugEyeMode = !bugEyeMode;
        const app = document.querySelector('.plexd-app');

        if (bugEyeMode) {
            if (app) app.classList.add('bugeye-mode');
            createBugEyeOverlay(targetStream);
            showMessage('Bug Eye: ON (B to exit)', 'info');
        } else {
            if (app) app.classList.remove('bugeye-mode');
            destroyBugEyeOverlay();
            showMessage('Bug Eye: OFF', 'info');
        }
    }

    /**
     * Create the bug eye overlay with multiple video copies
     */
    function createBugEyeOverlay(stream) {
        destroyBugEyeOverlay(); // Clean up any existing bug eye
        // Ensure mosaic is also destroyed (mutual exclusivity)
        if (mosaicOverlay) {
            destroyMosaicOverlay();
        }

        const container = document.getElementById('plexd-container');
        if (!container) return;

        // Create overlay container
        bugEyeOverlay = document.createElement('div');
        bugEyeOverlay.className = 'plexd-bugeye-overlay';
        bugEyeOverlay.id = 'plexd-bugeye-overlay';

        // Add close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'plexd-bugeye-close-btn';
        closeBtn.innerHTML = '&times;';
        closeBtn.title = 'Close Bug Eye (B)';
        closeBtn.style.cssText = `
            position: absolute;
            top: 12px;
            right: 12px;
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: rgba(0, 0, 0, 0.8);
            border: 2px solid rgba(255, 255, 255, 0.3);
            color: #fff;
            font-size: 24px;
            font-weight: bold;
            cursor: pointer;
            z-index: 100;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
            pointer-events: auto;
        `;
        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.background = 'rgba(245, 158, 11, 0.9)';
            closeBtn.style.borderColor = 'rgba(245, 158, 11, 1)';
            closeBtn.style.transform = 'scale(1.1)';
        });
        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = 'rgba(0, 0, 0, 0.8)';
            closeBtn.style.borderColor = 'rgba(255, 255, 255, 0.3)';
            closeBtn.style.transform = 'scale(1)';
        });
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleBugEyeMode();
        });
        bugEyeOverlay.appendChild(closeBtn);

        const videoSource = stream.video;
        const vw = window.innerWidth;
        const vh = window.innerHeight;

        // Define cells - arranged in rings around center
        // Each cell: { x%, y%, size%, zIndex, opacity }
        // Center is left clear for the main video
        const cells = [];

        // Ring 1 - Medium cells close to center (but not blocking it)
        const ring1Angles = [0, 45, 90, 135, 180, 225, 270, 315];
        ring1Angles.forEach((angle, i) => {
            const rad = (angle * Math.PI) / 180;
            const dist = 28; // % from center
            cells.push({
                x: 50 + Math.cos(rad) * dist,
                y: 50 + Math.sin(rad) * dist,
                size: 18 + (i % 3) * 4, // 18-26%
                zIndex: 20 - (i % 5),
                opacity: 0.85
            });
        });

        // Ring 2 - Smaller cells further out
        const ring2Angles = [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5];
        ring2Angles.forEach((angle, i) => {
            const rad = (angle * Math.PI) / 180;
            const dist = 42;
            cells.push({
                x: 50 + Math.cos(rad) * dist,
                y: 50 + Math.sin(rad) * dist,
                size: 14 + (i % 4) * 3, // 14-23%
                zIndex: 15 - (i % 4),
                opacity: 0.75
            });
        });

        // Ring 3 - Even smaller cells at edges
        for (let i = 0; i < 12; i++) {
            const angle = i * 30;
            const rad = (angle * Math.PI) / 180;
            const dist = 55 + (i % 3) * 5;
            cells.push({
                x: 50 + Math.cos(rad) * dist,
                y: 50 + Math.sin(rad) * dist,
                size: 10 + (i % 5) * 2, // 10-18%
                zIndex: 10 - (i % 6),
                opacity: 0.6
            });
        }

        // Ring 4 - Tiny cells at corners and edges
        const corners = [
            { x: 8, y: 8 }, { x: 92, y: 8 }, { x: 8, y: 92 }, { x: 92, y: 92 },
            { x: 50, y: 5 }, { x: 50, y: 95 }, { x: 5, y: 50 }, { x: 95, y: 50 },
            { x: 25, y: 5 }, { x: 75, y: 5 }, { x: 25, y: 95 }, { x: 75, y: 95 },
            { x: 5, y: 25 }, { x: 5, y: 75 }, { x: 95, y: 25 }, { x: 95, y: 75 }
        ];
        corners.forEach((pos, i) => {
            cells.push({
                x: pos.x,
                y: pos.y,
                size: 8 + (i % 4) * 2, // 8-14%
                zIndex: 5 - (i % 3),
                opacity: 0.5
            });
        });

        // Create video clones for each cell
        cells.forEach((cell, index) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'plexd-bugeye-cell';
            wrapper.style.cssText = `
                position: absolute;
                left: ${cell.x}%;
                top: ${cell.y}%;
                width: ${cell.size}%;
                height: ${cell.size * (vh / vw)}%;
                transform: translate(-50%, -50%);
                z-index: ${cell.zIndex};
                opacity: ${cell.opacity};
                border-radius: 8px;
                overflow: hidden;
                box-shadow: 0 4px 20px rgba(0,0,0,0.6);
                pointer-events: none;
            `;

            // Clone the video - will share the same MediaSource
            const videoClone = document.createElement('video');
            videoClone.className = 'plexd-bugeye-video';
            videoClone.src = videoSource.src;
            videoClone.currentTime = videoSource.currentTime;
            videoClone.muted = true;
            videoClone.loop = videoSource.loop;
            videoClone.playsInline = true;
            videoClone.autoplay = true;
            videoClone.style.cssText = `
                width: 100%;
                height: 100%;
                object-fit: cover;
            `;

            // Sync playback
            videoClone.play().catch(() => {});

            wrapper.appendChild(videoClone);
            bugEyeOverlay.appendChild(wrapper);
        });

        // Add subtle animation class
        bugEyeOverlay.classList.add('active');

        container.appendChild(bugEyeOverlay);

        // Sync all clones with main video periodically
        function syncVideos() {
            if (!bugEyeMode || !bugEyeOverlay) return;
            const clones = bugEyeOverlay.querySelectorAll('video');
            const mainTime = videoSource.currentTime;
            clones.forEach(clone => {
                // Only sync if drifted more than 0.5s
                if (Math.abs(clone.currentTime - mainTime) > 0.5) {
                    clone.currentTime = mainTime;
                }
                // Match play state
                if (videoSource.paused && !clone.paused) {
                    clone.pause();
                } else if (!videoSource.paused && clone.paused) {
                    clone.play().catch(() => {});
                }
            });
            bugEyeAnimationFrame = requestAnimationFrame(syncVideos);
        }
        bugEyeAnimationFrame = requestAnimationFrame(syncVideos);
    }

    /**
     * Destroy the bug eye overlay
     */
    function destroyBugEyeOverlay() {
        if (bugEyeAnimationFrame) {
            cancelAnimationFrame(bugEyeAnimationFrame);
            bugEyeAnimationFrame = null;
        }
        if (bugEyeOverlay) {
            // Pause all clones before removing
            const clones = bugEyeOverlay.querySelectorAll('video');
            clones.forEach(clone => {
                clone.pause();
                clone.src = '';
            });
            bugEyeOverlay.remove();
            bugEyeOverlay = null;
        }
        const app = document.querySelector('.plexd-app');
        if (app) app.classList.remove('bugeye-mode');
        bugEyeMode = false;
    }

    // Mosaic mode state (simpler version with fewer, non-overlapping copies)
    let mosaicMode = false;
    let mosaicOverlay = null;
    let mosaicAnimationFrame = null;
    let mosaicPausedStreams = []; // Track streams we paused for power efficiency

    /**
     * Toggle Mosaic mode - simpler effect with a few non-overlapping video copies
     */
    function toggleMosaicMode() {
        const fullscreenStream = PlexdStream.getFullscreenStream();
        const selected = PlexdStream.getSelectedStream();
        const targetStream = fullscreenStream || selected;

        if (!targetStream) {
            showMessage('Select or focus a stream first (Z key)', 'warning');
            return;
        }

        // If bug eye is on, turn it off first
        if (bugEyeMode) {
            destroyBugEyeOverlay();
        }

        mosaicMode = !mosaicMode;
        const app = document.querySelector('.plexd-app');

        if (mosaicMode) {
            if (app) app.classList.add('mosaic-mode');
            createMosaicOverlay(targetStream);
            showMessage('Mosaic: ON (Shift+B to exit)', 'info');
        } else {
            if (app) app.classList.remove('mosaic-mode');
            destroyMosaicOverlay();
            showMessage('Mosaic: OFF', 'info');
        }
    }

    /**
     * Create the mosaic overlay with a few non-overlapping video copies
     */
    function createMosaicOverlay(stream) {
        destroyMosaicOverlay(); // Clean up any existing mosaic
        // Ensure bug eye is also destroyed (mutual exclusivity)
        if (bugEyeOverlay) {
            destroyBugEyeOverlay();
        }

        const container = document.getElementById('plexd-container');
        if (!container) return;

        // Pause all background streams for power efficiency and add grey overlay
        mosaicPausedStreams = [];
        const allStreams = PlexdStream.getAllStreams();
        allStreams.forEach(s => {
            if (s.id !== stream.id) {
                // Track if stream was playing so we can resume it later
                if (s.video && !s.video.paused) {
                    mosaicPausedStreams.push(s.id);
                    s.video.pause();
                }
                // Add grey overlay to background stream
                if (s.element) {
                    const overlay = document.createElement('div');
                    overlay.className = 'plexd-mosaic-dimmer';
                    overlay.style.cssText = `
                        position: absolute;
                        inset: 0;
                        background: rgba(0, 0, 0, 0.7);
                        z-index: 40;
                        pointer-events: none;
                    `;
                    s.element.appendChild(overlay);
                }
            }
        });

        // Create overlay container
        mosaicOverlay = document.createElement('div');
        mosaicOverlay.className = 'plexd-mosaic-overlay';
        mosaicOverlay.id = 'plexd-mosaic-overlay';

        // Add close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'plexd-mosaic-close-btn';
        closeBtn.innerHTML = '&times;';
        closeBtn.title = 'Close Mosaic (Shift+B)';
        closeBtn.style.cssText = `
            position: absolute;
            top: 12px;
            right: 12px;
            width: 40px;
            height: 40px;
            border-radius: 50%;
            background: rgba(0, 0, 0, 0.8);
            border: 2px solid rgba(255, 255, 255, 0.3);
            color: #fff;
            font-size: 24px;
            font-weight: bold;
            cursor: pointer;
            z-index: 100;
            display: flex;
            align-items: center;
            justify-content: center;
            transition: all 0.2s ease;
            pointer-events: auto;
        `;
        closeBtn.addEventListener('mouseenter', () => {
            closeBtn.style.background = 'rgba(239, 68, 68, 0.9)';
            closeBtn.style.borderColor = 'rgba(239, 68, 68, 1)';
            closeBtn.style.transform = 'scale(1.1)';
        });
        closeBtn.addEventListener('mouseleave', () => {
            closeBtn.style.background = 'rgba(0, 0, 0, 0.8)';
            closeBtn.style.borderColor = 'rgba(255, 255, 255, 0.3)';
            closeBtn.style.transform = 'scale(1)';
        });
        closeBtn.addEventListener('click', (e) => {
            e.stopPropagation();
            toggleMosaicMode();
        });
        mosaicOverlay.appendChild(closeBtn);

        const videoSource = stream.video;

        // Define cells - non-overlapping layout
        // Main video stays in center, these are arranged around it
        const cells = [
            // Large copy top-left
            { x: 5, y: 5, w: 30, h: 35 },
            // Medium copy top-right
            { x: 65, y: 5, w: 30, h: 28 },
            // Small copy bottom-left
            { x: 5, y: 70, w: 22, h: 25 },
            // Medium copy bottom-right
            { x: 70, y: 65, w: 25, h: 30 },
            // Tiny copy top-center
            { x: 40, y: 3, w: 15, h: 18 },
            // Small copy left-middle
            { x: 3, y: 45, w: 18, h: 20 },
        ];

        // Create video clones for each cell
        cells.forEach((cell, index) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'plexd-mosaic-cell';
            wrapper.style.cssText = `
                position: absolute;
                left: ${cell.x}%;
                top: ${cell.y}%;
                width: ${cell.w}%;
                height: ${cell.h}%;
                border-radius: 6px;
                overflow: hidden;
                box-shadow: 0 4px 15px rgba(0,0,0,0.5);
                pointer-events: none;
            `;

            // Clone the video
            const videoClone = document.createElement('video');
            videoClone.className = 'plexd-mosaic-video';
            videoClone.src = videoSource.src;
            videoClone.currentTime = videoSource.currentTime;
            videoClone.muted = true;
            videoClone.loop = videoSource.loop;
            videoClone.playsInline = true;
            videoClone.autoplay = true;
            videoClone.style.cssText = `
                width: 100%;
                height: 100%;
                object-fit: cover;
            `;

            videoClone.play().catch(() => {});

            wrapper.appendChild(videoClone);
            mosaicOverlay.appendChild(wrapper);
        });

        mosaicOverlay.classList.add('active');
        container.appendChild(mosaicOverlay);

        // Sync all clones with main video
        function syncVideos() {
            if (!mosaicMode || !mosaicOverlay) return;
            const clones = mosaicOverlay.querySelectorAll('video');
            const mainTime = videoSource.currentTime;
            clones.forEach(clone => {
                if (Math.abs(clone.currentTime - mainTime) > 0.5) {
                    clone.currentTime = mainTime;
                }
                if (videoSource.paused && !clone.paused) {
                    clone.pause();
                } else if (!videoSource.paused && clone.paused) {
                    clone.play().catch(() => {});
                }
            });
            mosaicAnimationFrame = requestAnimationFrame(syncVideos);
        }
        mosaicAnimationFrame = requestAnimationFrame(syncVideos);
    }

    /**
     * Destroy the mosaic overlay
     */
    function destroyMosaicOverlay() {
        if (mosaicAnimationFrame) {
            cancelAnimationFrame(mosaicAnimationFrame);
            mosaicAnimationFrame = null;
        }
        if (mosaicOverlay) {
            const clones = mosaicOverlay.querySelectorAll('video');
            clones.forEach(clone => {
                clone.pause();
                clone.src = '';
            });
            mosaicOverlay.remove();
            mosaicOverlay = null;
        }

        // Remove grey overlays from all streams
        const allStreams = PlexdStream.getAllStreams();
        allStreams.forEach(s => {
            if (s.element) {
                const dimmer = s.element.querySelector('.plexd-mosaic-dimmer');
                if (dimmer) dimmer.remove();
            }
        });

        // Resume streams that were paused by mosaic mode
        mosaicPausedStreams.forEach(streamId => {
            const stream = PlexdStream.getStream(streamId);
            if (stream && stream.video) {
                stream.video.play().catch(() => {});
            }
        });
        mosaicPausedStreams = [];

        const app = document.querySelector('.plexd-app');
        if (app) app.classList.remove('mosaic-mode');
        mosaicMode = false;
    }

    /**
     * Force sync all overlay clones to the current video position
     * Called after seeking to immediately update all clones
     */
    function syncOverlayClones() {
        // Sync mosaic clones
        if (mosaicMode && mosaicOverlay) {
            const fullscreenStream = PlexdStream.getFullscreenStream();
            const selected = PlexdStream.getSelectedStream();
            const targetStream = fullscreenStream || selected;
            if (targetStream && targetStream.video) {
                const mainTime = targetStream.video.currentTime;
                const clones = mosaicOverlay.querySelectorAll('video');
                clones.forEach(clone => {
                    clone.currentTime = mainTime;
                    if (!targetStream.video.paused && clone.paused) {
                        clone.play().catch(() => {});
                    }
                });
            }
        }

        // Sync bug eye clones
        if (bugEyeMode && bugEyeOverlay) {
            const fullscreenStream = PlexdStream.getFullscreenStream();
            const selected = PlexdStream.getSelectedStream();
            const targetStream = fullscreenStream || selected;
            if (targetStream && targetStream.video) {
                const mainTime = targetStream.video.currentTime;
                const clones = bugEyeOverlay.querySelectorAll('video');
                clones.forEach(clone => {
                    clone.currentTime = mainTime;
                    if (!targetStream.video.paused && clone.paused) {
                        clone.play().catch(() => {});
                    }
                });
            }
        }
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
        const enabled = PlexdStream.toggleAudioFocus();
        updateAudioFocusButton(enabled);
        showMessage(`Audio focus: ${enabled ? 'ON' : 'OFF'}`, 'info');
    }

    /**
     * Update audio focus button to reflect actual state.
     * Audio focus ON = unmuting one stream mutes the others.
     */
    function updateAudioFocusButton(enabled) {
        const btn = document.getElementById('audio-focus-btn');
        if (!btn) return;
        btn.classList.toggle('active', !!enabled);
        // Keep icon compact, but make state obvious.
        btn.textContent = enabled ? '🎧' : '🔈';
        btn.title = enabled
            ? 'Audio focus: ON (audio follows selection)'
            : 'Audio focus: OFF (independent audio per stream)';
    }

    /**
     * Toggle clean mode (hide per-stream controls)
     */
    function toggleCleanMode() {
        const clean = PlexdStream.toggleCleanMode();
        const btn = document.getElementById('clean-mode-btn');
        if (btn) {
            btn.classList.toggle('active', clean);
            btn.textContent = clean ? '🙈' : '👁';
            btn.title = clean ? 'Show per-stream controls' : 'Hide per-stream controls';
        }
        showMessage(clean ? 'Controls hidden' : 'Controls visible', 'info');
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
     * Improved Tetris Layout - Skyline bin-packing with gap filling
     * Tries 4 strategies and picks the most efficient one:
     * 1. Row-based packing (videos in horizontal rows)
     * 2. Column-based packing (videos in vertical columns)
     * 3. Skyline bin-packing (true tetris-style gap filling)
     * 4. Balanced grid (uniform cells with aspect ratio fitting)
     */
    function calculateTetrisLayout(container, streams) {
        const count = streams.length;
        if (count === 0) return { cells: [], rows: 0, cols: 0, efficiency: 0 };

        // Single stream - maximize it
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

        // Try multiple layout strategies and pick the best one
        const layouts = [
            tryRowBasedLayout(container, streams),
            tryColumnBasedLayout(container, streams),
            trySkylineLayout(container, streams),
            tryBalancedGridLayout(container, streams)
        ];

        // Pick layout with highest efficiency
        let bestLayout = layouts[0];
        for (const layout of layouts) {
            if (layout.efficiency > bestLayout.efficiency) {
                bestLayout = layout;
            }
        }

        return bestLayout;
    }

    /**
     * Row-based layout - pack videos in rows, varying heights
     */
    function tryRowBasedLayout(container, streams) {
        const count = streams.length;
        const targetRowHeight = container.height / Math.ceil(Math.sqrt(count));
        const cells = [];

        let currentY = 0;
        let rowStart = 0;

        while (rowStart < count) {
            // Figure out how many videos fit in this row
            let rowWidth = 0;
            let rowEnd = rowStart;
            const rowHeight = Math.min(targetRowHeight, container.height - currentY);

            // Calculate widths for videos at this row height
            const rowVideos = [];
            for (let i = rowStart; i < count; i++) {
                const ar = streams[i].aspectRatio || 16/9;
                const videoWidth = rowHeight * ar;

                if (rowWidth + videoWidth <= container.width * 1.1 || rowVideos.length === 0) {
                    rowVideos.push({ stream: streams[i], width: videoWidth });
                    rowWidth += videoWidth;
                    rowEnd = i + 1;
                } else {
                    break;
                }
            }

            // Scale row to fit container width exactly
            const scale = Math.min(container.width / rowWidth, 1);
            const scaledHeight = rowHeight * scale;

            // Center row horizontally if it doesn't fill width
            const actualRowWidth = rowWidth * scale;
            let x = (container.width - actualRowWidth) / 2;

            for (const rv of rowVideos) {
                const scaledWidth = rv.width * scale;
                cells.push({
                    streamId: rv.stream.id,
                    x: x,
                    y: currentY,
                    width: scaledWidth,
                    height: scaledHeight
                });
                x += scaledWidth;
            }

            currentY += scaledHeight;
            rowStart = rowEnd;
        }

        // Center vertically
        const totalHeight = currentY;
        const offsetY = (container.height - totalHeight) / 2;
        if (offsetY > 0) {
            cells.forEach(cell => cell.y += offsetY);
        }

        return buildLayoutResult(container, cells, count);
    }

    /**
     * Column-based layout - pack videos in columns, varying widths
     */
    function tryColumnBasedLayout(container, streams) {
        const count = streams.length;
        const targetColWidth = container.width / Math.ceil(Math.sqrt(count));
        const cells = [];

        let currentX = 0;
        let colStart = 0;

        while (colStart < count) {
            let colHeight = 0;
            let colEnd = colStart;
            const colWidth = Math.min(targetColWidth, container.width - currentX);

            const colVideos = [];
            for (let i = colStart; i < count; i++) {
                const ar = streams[i].aspectRatio || 16/9;
                const videoHeight = colWidth / ar;

                if (colHeight + videoHeight <= container.height * 1.1 || colVideos.length === 0) {
                    colVideos.push({ stream: streams[i], height: videoHeight });
                    colHeight += videoHeight;
                    colEnd = i + 1;
                } else {
                    break;
                }
            }

            // Scale column to fit container height exactly
            const scale = Math.min(container.height / colHeight, 1);
            const scaledWidth = colWidth * scale;

            // Center column vertically if it doesn't fill height
            const actualColHeight = colHeight * scale;
            let y = (container.height - actualColHeight) / 2;

            for (const cv of colVideos) {
                const scaledHeight = cv.height * scale;
                cells.push({
                    streamId: cv.stream.id,
                    x: currentX,
                    y: y,
                    width: scaledWidth,
                    height: scaledHeight
                });
                y += scaledHeight;
            }

            currentX += scaledWidth;
            colStart = colEnd;
        }

        // Center horizontally
        const totalWidth = currentX;
        const offsetX = (container.width - totalWidth) / 2;
        if (offsetX > 0) {
            cells.forEach(cell => cell.x += offsetX);
        }

        return buildLayoutResult(container, cells, count);
    }

    /**
     * Skyline layout - place videos at lowest available point (true bin-packing)
     */
    function trySkylineLayout(container, streams) {
        const count = streams.length;

        // Calculate uniform size that would fit all videos
        const targetArea = (container.width * container.height) / count;
        const avgAspectRatio = streams.reduce((sum, s) => sum + (s.aspectRatio || 16/9), 0) / count;
        const baseHeight = Math.sqrt(targetArea / avgAspectRatio);

        // Skyline tracks the top edge at each x position
        // Start with flat ground at y=0
        let skyline = [{ x: 0, y: 0, width: container.width }];
        const cells = [];

        // Sort by height (tallest first for better packing)
        const sorted = [...streams].map(s => ({
            stream: s,
            aspectRatio: s.aspectRatio || 16/9
        })).sort((a, b) => (1/a.aspectRatio) - (1/b.aspectRatio));

        for (const item of sorted) {
            const ar = item.aspectRatio;
            // Size based on target, but respect aspect ratio
            let height = baseHeight;
            let width = height * ar;

            // Scale down if too wide
            if (width > container.width * 0.6) {
                width = container.width * 0.6;
                height = width / ar;
            }

            // Find best position in skyline (lowest point that fits)
            let bestPos = null;
            let bestY = Infinity;

            for (let i = 0; i < skyline.length; i++) {
                const seg = skyline[i];
                if (seg.width >= width) {
                    // Check if this position works
                    const y = seg.y;
                    if (y + height <= container.height && y < bestY) {
                        bestY = y;
                        bestPos = { x: seg.x, y: y, segIndex: i };
                    }
                }
                // Also try spanning multiple segments
                if (i < skyline.length - 1) {
                    let spanWidth = seg.width;
                    let maxY = seg.y;
                    for (let j = i + 1; j < skyline.length && spanWidth < width; j++) {
                        spanWidth += skyline[j].width;
                        maxY = Math.max(maxY, skyline[j].y);
                    }
                    if (spanWidth >= width && maxY + height <= container.height && maxY < bestY) {
                        bestY = maxY;
                        bestPos = { x: seg.x, y: maxY, segIndex: i };
                    }
                }
            }

            if (!bestPos) {
                // Fallback: scale down to fit
                const availableHeight = container.height - skyline.reduce((max, s) => Math.max(max, s.y), 0);
                if (availableHeight > 0) {
                    height = Math.min(height, availableHeight);
                    width = height * ar;
                    bestPos = { x: 0, y: container.height - height, segIndex: 0 };
                }
            }

            if (bestPos) {
                cells.push({
                    streamId: item.stream.id,
                    x: bestPos.x,
                    y: bestPos.y,
                    width: width,
                    height: height
                });

                // Update skyline
                skyline = updateSkyline(skyline, bestPos.x, bestPos.y + height, width);
            }
        }

        // Scale and center the layout
        const bounds = getCellBounds(cells);
        const scaleX = container.width / bounds.width;
        const scaleY = container.height / bounds.height;
        const scale = Math.min(scaleX, scaleY, 1.2); // Allow slight upscale

        cells.forEach(cell => {
            cell.x = (cell.x - bounds.minX) * scale;
            cell.y = (cell.y - bounds.minY) * scale;
            cell.width *= scale;
            cell.height *= scale;
        });

        // Center
        const newBounds = getCellBounds(cells);
        const offsetX = (container.width - newBounds.width) / 2;
        const offsetY = (container.height - newBounds.height) / 2;
        cells.forEach(cell => {
            cell.x += offsetX;
            cell.y += offsetY;
        });

        return buildLayoutResult(container, cells, count);
    }

    /**
     * Balanced grid layout - equal sized cells but respecting aspect ratios
     */
    function tryBalancedGridLayout(container, streams) {
        const count = streams.length;

        // Find best grid dimensions
        let bestGrid = { rows: 1, cols: count, score: -Infinity };
        for (let rows = 1; rows <= count; rows++) {
            const cols = Math.ceil(count / rows);
            const cellWidth = container.width / cols;
            const cellHeight = container.height / rows;
            const cellRatio = cellWidth / cellHeight;

            // Score based on how close to 16:9 and fill efficiency
            const targetRatio = 16/9;
            const ratioScore = 1 - Math.abs(cellRatio - targetRatio) / targetRatio;
            const fillScore = count / (rows * cols);
            const score = ratioScore * 0.4 + fillScore * 0.6;

            if (score > bestGrid.score) {
                bestGrid = { rows, cols, score };
            }
        }

        const { rows, cols } = bestGrid;
        const cellWidth = container.width / cols;
        const cellHeight = container.height / rows;
        const cells = [];

        // Place videos in grid, fitting each to its cell
        let streamIndex = 0;
        for (let row = 0; row < rows && streamIndex < count; row++) {
            // Center partial rows
            const videosInRow = Math.min(cols, count - streamIndex);
            const rowOffset = (cols - videosInRow) * cellWidth / 2;

            for (let col = 0; col < videosInRow; col++) {
                const stream = streams[streamIndex];
                const ar = stream.aspectRatio || 16/9;

                // Fit video in cell
                const fit = PlexdGrid.fitToContainer({ width: cellWidth, height: cellHeight }, ar);

                cells.push({
                    streamId: stream.id,
                    x: col * cellWidth + rowOffset + (cellWidth - fit.width) / 2,
                    y: row * cellHeight + (cellHeight - fit.height) / 2,
                    width: fit.width,
                    height: fit.height
                });

                streamIndex++;
            }
        }

        return buildLayoutResult(container, cells, count);
    }

    /**
     * Update skyline after placing a rectangle
     */
    function updateSkyline(skyline, x, newY, width) {
        const newSkyline = [];
        const endX = x + width;

        for (const seg of skyline) {
            const segEnd = seg.x + seg.width;

            if (segEnd <= x || seg.x >= endX) {
                // Segment doesn't overlap with placed rect
                newSkyline.push(seg);
            } else {
                // Segment overlaps - split it
                if (seg.x < x) {
                    newSkyline.push({ x: seg.x, y: seg.y, width: x - seg.x });
                }
                if (segEnd > endX) {
                    newSkyline.push({ x: endX, y: seg.y, width: segEnd - endX });
                }
            }
        }

        // Add new segment for placed rect
        newSkyline.push({ x: x, y: newY, width: width });

        // Sort by x and merge adjacent segments at same height
        newSkyline.sort((a, b) => a.x - b.x);

        const merged = [];
        for (const seg of newSkyline) {
            if (merged.length > 0) {
                const last = merged[merged.length - 1];
                if (Math.abs(last.x + last.width - seg.x) < 1 && Math.abs(last.y - seg.y) < 1) {
                    last.width += seg.width;
                    continue;
                }
            }
            merged.push({ ...seg });
        }

        return merged;
    }

    /**
     * Get bounding box of all cells
     */
    function getCellBounds(cells) {
        if (cells.length === 0) return { minX: 0, minY: 0, width: 0, height: 0 };

        let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
        for (const cell of cells) {
            minX = Math.min(minX, cell.x);
            minY = Math.min(minY, cell.y);
            maxX = Math.max(maxX, cell.x + cell.width);
            maxY = Math.max(maxY, cell.y + cell.height);
        }

        return { minX, minY, width: maxX - minX, height: maxY - minY };
    }

    /**
     * Build final layout result with efficiency metrics
     */
    function buildLayoutResult(container, cells, count) {
        const videoArea = cells.reduce((sum, cell) => sum + (cell.width * cell.height), 0);
        const efficiency = videoArea / (container.width * container.height);

        // Estimate grid dimensions for keyboard nav
        const avgWidth = cells.length > 0 ?
            cells.reduce((sum, cell) => sum + cell.width, 0) / cells.length :
            container.width;
        const cols = Math.max(1, Math.round(container.width / avgWidth));

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


    /**
     * Handle keyboard shortcuts
     */
    function handleKeyboard(e) {
        // If a modal is open, avoid accidental destructive/global shortcuts.
        // Let modal-specific handlers deal with Escape/etc.
        if (document.querySelector('.plexd-modal-overlay') && e.key !== 'Escape') {
            return;
        }

        // Ignore only when typing into text-entry controls (not sliders/buttons).
        if (isTypingTarget(e.target)) return;

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
                    const muted = PlexdStream.toggleMuteAll();
                    showMessage(muted ? 'All streams muted' : 'All streams unmuted', 'info');
                }
                break;
            case 'n':
            case 'N':
                // N for audio focus (next to M for mute - audio controls cluster)
                {
                    const audioFocus = PlexdStream.toggleAudioFocus();
                    updateAudioFocusButton(audioFocus);
                    showMessage(`Audio focus: ${audioFocus ? 'ON' : 'OFF'}`, 'info');
                }
                break;
            case 'i':
            case 'I':
                const showInfo = PlexdStream.toggleAllStreamInfo();
                showMessage(`Stream info: ${showInfo ? 'ON' : 'OFF'}`, 'info');
                break;
            case '`':
                // ` (backtick): Toggle favorites modal overlay
                e.preventDefault();
                toggleFavoritesModal();
                break;
            case 'c':
            case 'C':
                // Copy stream URL(s) - Shift+C for all, C for selected/focused
                if (e.shiftKey) {
                    // Copy all stream URLs
                    const count = PlexdStream.copyAllStreamUrls();
                    if (count) {
                        showMessage(`Copied ${count} stream URL(s)`, 'success');
                    } else {
                        showMessage('No streams to copy', 'info');
                    }
                } else {
                    // Copy selected or focused stream URL
                    const targetStream = PlexdStream.getFullscreenStream() || selected;
                    if (targetStream) {
                        PlexdStream.copyStreamUrl(targetStream.id);
                        showMessage('URL copied to clipboard', 'success');
                    } else {
                        showMessage('Select a stream first (use arrow keys)', 'info');
                    }
                }
                break;
            case 'p':
            case 'P':
                if (selected) {
                    PlexdStream.togglePiP(selected.id);
                }
                break;
            case 'ArrowRight':
                e.preventDefault();
                if (fullscreenStream) {
                    // In focused fullscreen: switch to next stream (stay in focused mode)
                    switchFullscreenStream('right');
                } else if (coverflowMode) {
                    // Coverflow mode: navigate carousel to next stream
                    const streams = getFilteredStreams();
                    if (streams.length > 0) {
                        PlexdGrid.coverflowNavigate('next', streams.length);
                        updateLayout();
                        showCoverflowPosition();
                    }
                } else {
                    PlexdStream.selectNextStream('right');
                }
                break;
            case 'ArrowLeft':
                e.preventDefault();
                if (fullscreenStream) {
                    // In focused fullscreen: switch to prev stream (stay in focused mode)
                    switchFullscreenStream('left');
                } else if (coverflowMode) {
                    // Coverflow mode: navigate carousel to previous stream
                    const streams = getFilteredStreams();
                    if (streams.length > 0) {
                        PlexdGrid.coverflowNavigate('prev', streams.length);
                        updateLayout();
                        showCoverflowPosition();
                    }
                } else {
                    PlexdStream.selectNextStream('left');
                }
                break;
            case 'ArrowUp':
                e.preventDefault();
                if (fullscreenStream) {
                    // In focused fullscreen: switch to stream above (stay in focused mode)
                    switchFullscreenStream('up');
                } else if (coverflowMode) {
                    // Coverflow mode: navigate carousel to previous stream (same as left)
                    const streams = getFilteredStreams();
                    if (streams.length > 0) {
                        PlexdGrid.coverflowNavigate('prev', streams.length);
                        updateLayout();
                        showCoverflowPosition();
                    }
                } else {
                    PlexdStream.selectNextStream('up');
                }
                break;
            case 'ArrowDown':
                e.preventDefault();
                if (fullscreenStream) {
                    // In focused fullscreen: switch to stream below (stay in focused mode)
                    switchFullscreenStream('down');
                } else if (coverflowMode) {
                    // Coverflow mode: navigate carousel to next stream (same as right)
                    const streams = getFilteredStreams();
                    if (streams.length > 0) {
                        PlexdGrid.coverflowNavigate('next', streams.length);
                        updateLayout();
                        showCoverflowPosition();
                    }
                } else {
                    PlexdStream.selectNextStream('down');
                }
                break;
            // Seeking controls - grouped near arrow keys for easy access
            // , . for 10s seek, < > (Shift+,/.) for 60s seek
            case ',':
                // Seek backward 10 seconds
                e.preventDefault();
                {
                    const targetStream = fullscreenStream || selected;
                    if (targetStream) {
                        PlexdStream.seekRelative(targetStream.id, -10);
                        syncOverlayClones();
                    }
                }
                break;
            case '.':
                // Seek forward 10 seconds
                e.preventDefault();
                {
                    const targetStream = fullscreenStream || selected;
                    if (targetStream) {
                        PlexdStream.seekRelative(targetStream.id, 10);
                        syncOverlayClones();
                    }
                }
                break;
            case '<':
                // Seek backward 60 seconds (Shift+,)
                e.preventDefault();
                {
                    const targetStream = fullscreenStream || selected;
                    if (targetStream) {
                        PlexdStream.seekRelative(targetStream.id, -60);
                        syncOverlayClones();
                    }
                }
                break;
            case '>':
                // Seek forward 60 seconds (Shift+.)
                e.preventDefault();
                {
                    const targetStream = fullscreenStream || selected;
                    if (targetStream) {
                        PlexdStream.seekRelative(targetStream.id, 60);
                        syncOverlayClones();
                    }
                }
                break;
            case 'Enter':
            case 'z':
            case 'Z':
                e.preventDefault();
                // Enter or Z: toggle between grid and focused view (browser-fill)
                // In coverflow mode: enter focused mode on the center-selected stream
                // In grid mode: enter focused mode on selected stream
                // In focused mode: exit back to grid
                {
                    const mode = PlexdStream.getFullscreenMode();
                    if (mode === 'true-focused' || mode === 'browser-fill') {
                        // In focused mode - exit back to grid
                        // Also exit any overlay modes
                        if (mosaicMode) {
                            destroyMosaicOverlay();
                            const app = document.querySelector('.plexd-app');
                            if (app) app.classList.remove('mosaic-mode');
                        }
                        if (bugEyeMode) {
                            destroyBugEyeOverlay();
                            const app = document.querySelector('.plexd-app');
                            if (app) app.classList.remove('bugeye-mode');
                        }
                        PlexdStream.exitFocusedMode();
                    } else if (coverflowMode) {
                        // In coverflow mode - enter focused mode on the carousel-selected stream
                        const streams = getFilteredStreams();
                        const selectedIdx = PlexdGrid.getCoverflowSelectedIndex();
                        if (streams.length > 0 && selectedIdx < streams.length) {
                            const targetStream = streams[selectedIdx];
                            PlexdStream.enterFocusedMode(targetStream.id);
                            showMessage('Focused on selected stream', 'info');
                        }
                    } else {
                        // In grid mode - enter focused mode
                        if (selected) {
                            PlexdStream.enterFocusedMode(selected.id);
                        } else {
                            // No selection - quick jump to first stream matching current filter
                            const streams = viewMode === 'all'
                                ? PlexdStream.getAllStreams()
                                : PlexdStream.getStreamsByRating(viewMode);
                            if (streams.length > 0) {
                                PlexdStream.enterFocusedMode(streams[0].id);
                            } else if (viewMode !== 'all') {
                                showMessage(`No ★${viewMode} streams to show`, 'warning');
                            }
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
                } else {
                    // Plain S toggles streams panel
                    e.preventDefault();
                    togglePanel('streams-panel');
                }
                break;
            case 'Escape':
                // Escape handles all fullscreen modes:
                // - true-focused: return to true-grid (stay in true fullscreen)
                // - true-grid: exit true fullscreen completely
                // - browser-fill: exit to grid view
                // - none: deselect, or reset fullscreen state if something looks stuck
                {
                    const mode = PlexdStream.getFullscreenMode();
                    if (mode === 'true-focused') {
                        // Return to grid view in true fullscreen
                        PlexdStream.exitFocusedMode();
                    } else if (mode === 'true-grid') {
                        // Exit true fullscreen completely
                        PlexdStream.exitTrueFullscreen();
                    } else if (mode === 'browser-fill') {
                        // Exit browser-fill mode back to grid
                        PlexdStream.exitFocusedMode();
                    } else {
                        // Normal mode - deselect
                        PlexdStream.selectStream(null);
                        // Also do a defensive cleanup in case state is stuck
                        // This ensures any lingering fullscreen CSS is removed
                        PlexdStream.resetFullscreenState();
                    }
                    if (inputEl) inputEl.blur();
                }
                break;
            case 't':
            case 'T':
                // Cycle Tetris mode (off -> mode 1 -> mode 2 -> mode 3 -> off)
                cycleTetrisMode();
                break;
            case 'o':
            case 'O':
                // Toggle Coverflow mode (Z-depth overlapping with hover effects)
                toggleCoverflowMode();
                break;
            case 'b':
            case 'B':
                // B = Bug Eye mode (compound vision), Shift+B = Mosaic mode (cleaner)
                if (e.shiftKey) {
                    toggleMosaicMode();
                } else {
                    toggleBugEyeMode();
                }
                break;
            case 'h':
            case 'H':
                // Toggle header toolbar
                toggleHeader();
                break;
            case 'v':
            case 'V':
                // Cycle view mode (all -> 1★ -> 2★ -> 3★ -> 4★ -> 5★ -> all)
                // If in focus mode, exit first to show filtered grid
                if (PlexdStream.getFullscreenMode() !== 'none') {
                    PlexdStream.exitFocusedMode();
                }
                cycleViewMode();
                break;
            case 'g':
            case 'G':
                // Rate selected stream (cycle through ratings)
                if (selected) {
                    const newRating = PlexdStream.cycleRating(selected.id);
                    showMessage(newRating ? `Rated: ★${newRating}` : 'Rating cleared', 'info');
                    // If in focus mode with filter active and new rating doesn't match, exit
                    const isFullscreen = PlexdStream.getFullscreenMode() !== 'none';
                    if (isFullscreen && viewMode !== 'all' && newRating !== viewMode) {
                        PlexdStream.exitFocusedMode();
                    }
                }
                break;
            case 'r':
            case 'R':
                // Reload stream - useful for frozen streams or stuck loading
                {
                    const targetStream = fullscreenStream || selected || getCoverflowSelectedStream();
                    if (targetStream) {
                        PlexdStream.reloadStream(targetStream.id);
                        showMessage('Reloading stream...', 'info');
                    } else {
                        showMessage('Select a stream first (use arrow keys)', 'info');
                    }
                }
                break;
            case 'x':
            case 'X':
                // Close/remove stream
                {
                    const targetStream = fullscreenStream || selected || getCoverflowSelectedStream();
                    if (targetStream) {
                        if (fullscreenStream) {
                            // In fullscreen: find next stream, remove current, fullscreen next
                            const nextStreamId = PlexdStream.getNextStreamId(targetStream.id);
                            PlexdStream.removeStream(targetStream.id);
                            if (nextStreamId) {
                                // Stay in fullscreen on the next stream
                                PlexdStream.enterFocusedMode(nextStreamId);
                            } else {
                                // No more streams, exit fullscreen
                                PlexdStream.exitFocusedMode();
                            }
                        } else {
                            // In grid: remove and select next for quick elimination
                            PlexdStream.removeStreamAndFocusNext(targetStream.id);
                        }
                        updateStreamCount();
                        saveCurrentStreams();
                        showMessage('Stream closed', 'info');
                    } else {
                        showMessage('Select a stream first (use arrow keys)', 'info');
                    }
                }
                break;
            case '0':
                // 0 always returns to grid and shows all streams
                // Shift+0: clear rating on selected/fullscreen stream
                if (e.shiftKey) {
                    // Shift+0: clear rating on targeted stream
                    const targetStream = PlexdStream.getFullscreenStream() || selected;
                    if (targetStream) {
                        PlexdStream.clearRating(targetStream.id);
                        showMessage('Rating cleared', 'info');
                    }
                } else {
                    // Exit fullscreen if in fullscreen mode
                    if (PlexdStream.getFullscreenMode() !== 'none') {
                        PlexdStream.exitFocusedMode();
                    }
                    // Show all streams
                    setViewMode('all');
                }
                break;
            case '1':
            case '2':
            case '3':
            case '4':
            case '5':
            case '6':
            case '7':
            case '8':
            case '9':
                // Context-aware: focused fullscreen = assign slot number, grid = filter by slot
                // Shift+N: opposite action (grid = assign, focused = filter)
                // Note: true-grid mode (F key) has no focused stream, so treat as grid mode for filtering
                if (!e.ctrlKey && !e.metaKey) {
                    const slotNum = parseInt(e.key);
                    const fullscreenMode = PlexdStream.getFullscreenMode();
                    // Only consider "focused" fullscreen modes where there's an actual stream to assign to
                    const isFocusedFullscreen = fullscreenMode === 'true-focused' || fullscreenMode === 'browser-fill';
                    const doAssign = e.shiftKey ? !isFocusedFullscreen : isFocusedFullscreen;
                    const doFilter = !doAssign;

                    if (doAssign) {
                        // Assign slot number to stream
                        const targetStream = isFocusedFullscreen
                            ? PlexdStream.getFullscreenStream()
                            : selected;
                        if (targetStream) {
                            PlexdStream.setRating(targetStream.id, slotNum);
                            showMessage(`Assigned to slot ${slotNum}`, 'info');
                            // If in focus mode with a filter active and new slot doesn't match,
                            // exit focus mode to avoid being stuck viewing a hidden stream
                            if (isFocusedFullscreen && viewMode !== 'all' && slotNum !== viewMode) {
                                PlexdStream.exitFocusedMode();
                            }
                        }
                    } else {
                        // Filter action - if in focused fullscreen, exit first to show filtered grid
                        if (isFocusedFullscreen) {
                            PlexdStream.exitFocusedMode();
                        }
                        const count = PlexdStream.getStreamsByRating(slotNum).length;
                        setViewMode(slotNum);
                        if (count === 0) {
                            showMessage(`No streams in slot ${slotNum}`, 'warning');
                        }
                    }
                }
                break;
            case '*':
                // * (asterisk/Shift+8) : Toggle favorite on selected/fullscreen stream
                {
                    const targetStream = fullscreenStream || selected;
                    if (targetStream) {
                        e.preventDefault();
                        const isFav = PlexdStream.toggleFavorite(targetStream.id);
                        showMessage(isFav ? 'Added to favorites ★' : 'Removed from favorites', isFav ? 'success' : 'info');
                    } else {
                        showMessage('Select a stream first', 'warning');
                    }
                }
                break;
            case '/':
                // / : Random seek selected stream (near arrow keys for easy access)
                e.preventDefault();
                randomSeekSelected();
                break;
            case '?':
                // ? : Toggle shortcuts overlay (standard help key)
                e.preventDefault();
                toggleShortcutsOverlay();
                break;
        }
    }

    /**
     * Switch fullscreen to stream in given direction using spatial grid navigation
     * Stays in the current fullscreen mode (focused mode)
     * Respects current viewMode filter (rating subgroups)
     * Uses actual grid positions for true up/down/left/right navigation
     * Treats local files and remote streams equally
     */
    function switchFullscreenStream(direction) {
        const fullscreenStream = PlexdStream.getFullscreenStream();
        if (!fullscreenStream) return;

        const nextId = PlexdStream.getSpatialNeighborStreamId(fullscreenStream.id, direction);
        if (!nextId || nextId === fullscreenStream.id) return;

        const mode = PlexdStream.getFullscreenMode();
        PlexdStream.enterFocusedMode(nextId);

        // If was in true-focused mode, ensure wrapper gets focus for keyboard events
        if (mode === 'true-focused') {
            const nextStream = PlexdStream.getStream(nextId);
            if (nextStream && nextStream.wrapper) nextStream.wrapper.focus();
        }

        // Update mosaic/bug eye overlay to show the new stream
        updateOverlayStream(nextId);
    }

    /**
     * Update mosaic or bug eye overlay to show a different stream
     * Called when switching streams while an overlay is active
     */
    function updateOverlayStream(streamId) {
        const stream = PlexdStream.getStream(streamId);
        if (!stream) return;

        const app = document.querySelector('.plexd-app');

        // If mosaic mode is active, recreate with new stream
        if (mosaicMode && mosaicOverlay) {
            destroyMosaicOverlay();
            mosaicMode = true; // Keep the mode on
            if (app) app.classList.add('mosaic-mode');
            createMosaicOverlay(stream);
        }

        // If bug eye mode is active, recreate with new stream
        if (bugEyeMode && bugEyeOverlay) {
            destroyBugEyeOverlay();
            bugEyeMode = true; // Keep the mode on
            if (app) app.classList.add('bugeye-mode');
            createBugEyeOverlay(stream);
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
     * Get streams filtered by current view mode
     */
    function getFilteredStreams() {
        if (viewMode === 'all') {
            return PlexdStream.getAllStreams();
        }
        return PlexdStream.getStreamsByRating(viewMode);
    }

    /**
     * Show coverflow position message (e.g., "Stream 2 of 5")
     */
    function showCoverflowPosition() {
        const streams = getFilteredStreams();
        const idx = PlexdGrid.getCoverflowSelectedIndex();
        if (streams.length > 0) {
            showMessage(`Stream ${idx + 1} of ${streams.length}`, 'info');
        }
    }

    /**
     * Get the stream currently selected in coverflow mode
     */
    function getCoverflowSelectedStream() {
        if (!coverflowMode) return null;
        const streams = getFilteredStreams();
        const idx = PlexdGrid.getCoverflowSelectedIndex();
        if (streams.length > 0 && idx < streams.length) {
            return streams[idx];
        }
        return null;
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
     * Returns true if the element is a "typing" target where global shortcuts
     * should not hijack keystrokes (URL bar, text inputs, editable text).
     *
     * Notes:
     * - We intentionally DO NOT treat range inputs (seek bars) as typing targets.
     *   Users expect keyboard shortcuts to keep working after interacting with controls.
     */
    function isTypingTarget(el) {
        if (!el) return false;

        // contenteditable elements should always be treated as typing targets
        if (el.isContentEditable) return true;

        const tag = (el.tagName || '').toUpperCase();
        if (tag === 'TEXTAREA') return true;

        if (tag !== 'INPUT') return false;

        // Default to treating "text-like" input types as typing targets
        const type = (el.getAttribute('type') || 'text').toLowerCase();
        const nonTypingTypes = new Set([
            'button', 'submit', 'reset', 'checkbox', 'radio',
            'range', 'color', 'file', 'image'
        ]);
        return !nonTypingTypes.has(type);
    }

    /**
     * Normalize a network URL for equality checks (dedupe, merge, persistence).
     *
     * We do NOT change the URL used for playback; this is only a stable key.
     * - Lowercases protocol + hostname
     * - Removes default ports (80/443)
     * - Removes hash
     * - Sorts query parameters (stable order)
     * - Trims trailing slash (except root)
     */
    function normalizeUrlForEquality(url) {
        try {
            const u = new URL(url);

            // Only normalize network URLs; blob/file/etc are intentionally left as-is.
            if (u.protocol !== 'http:' && u.protocol !== 'https:') {
                return url;
            }

            u.hash = '';
            u.protocol = u.protocol.toLowerCase();
            u.hostname = u.hostname.toLowerCase();

            // Remove default ports
            if ((u.protocol === 'http:' && u.port === '80') || (u.protocol === 'https:' && u.port === '443')) {
                u.port = '';
            }

            // Trim trailing slash in pathname (but keep root "/")
            if (u.pathname.length > 1 && u.pathname.endsWith('/')) {
                u.pathname = u.pathname.replace(/\/+$/, '');
            }

            // Stable sort query params (preserve duplicates)
            if (u.search) {
                const entries = Array.from(u.searchParams.entries());
                entries.sort((a, b) => {
                    if (a[0] !== b[0]) return a[0].localeCompare(b[0]);
                    return (a[1] || '').localeCompare(b[1] || '');
                });
                u.search = '';
                for (const [k, v] of entries) u.searchParams.append(k, v);
            }

            return u.toString();
        } catch (_) {
            return url;
        }
    }

    function urlEqualityKey(url) {
        return normalizeUrlForEquality((url || '').trim());
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
     * Check if a URL is a local blob URL (from dropped files)
     * Blob URLs are temporary and become invalid after browser session
     */
    function isBlobUrl(url) {
        return url && url.startsWith('blob:');
    }

    /**
     * Check if a stream should be saved (has sufficient duration and is not a blob URL)
     */
    function shouldSaveStream(stream) {
        // Exclude blob URLs - they're temporary and won't work after browser restarts
        if (isBlobUrl(stream.url)) return false;

        const duration = stream.video && stream.video.duration;
        // Save if duration is unknown (not loaded yet) or meets minimum
        if (!duration || !isFinite(duration)) return true;
        return duration >= MIN_STREAM_DURATION;
    }

    /**
     * Save current streams to localStorage (excludes local files and short videos)
     */
    function saveCurrentStreams() {
        const streams = PlexdStream.getAllStreams();
        const urls = [];
        const seen = new Set();
        streams.forEach(s => {
            if (!shouldSaveStream(s)) return;
            const key = urlEqualityKey(s.url);
            if (seen.has(key)) return;
            seen.add(key);
            urls.push(s.url);
        });
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
    async function saveStreamCombination() {
        const streams = PlexdStream.getAllStreams();
        if (streams.length === 0) {
            showMessage('No streams to save', 'error');
            return;
        }

        // Separate local files from URL streams
        const localFileStreams = streams.filter(s => isBlobUrl(s.url) && s.fileName);
        const urlStreams = streams.filter(s => !isBlobUrl(s.url));
        const shortVideos = urlStreams.filter(s => !shouldSaveStream(s)).length;
        const validUrlStreams = urlStreams.filter(s => shouldSaveStream(s));

        // Check if we have anything to save
        if (validUrlStreams.length === 0 && localFileStreams.length === 0) {
            const reasons = [];
            if (shortVideos > 0) reasons.push('videos too short');
            showMessage(`No valid streams to save${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}`, 'error');
            return;
        }

        const name = prompt('Enter a name for this stream combination:');
        if (!name) return;

        // Dedupe URLs by normalized equality key to avoid saving the same stream twice
        const urls = [];
        const seen = new Set();
        validUrlStreams.forEach(s => {
            const key = urlEqualityKey(s.url);
            if (seen.has(key)) return;
            seen.add(key);
            urls.push(s.url);
        });
        // Save local files with their ratings
        const localFilesData = localFileStreams.map(s => ({
            fileName: s.fileName,
            rating: PlexdStream.getRating(s.url) || 0
        }));
        const localFiles = localFilesData.map(f => f.fileName);
        const localFileRatings = {};
        localFilesData.forEach(f => {
            if (f.rating > 0) {
                localFileRatings[f.fileName] = f.rating;
            }
        });
        const loginDomains = extractLoginDomains(urls);

        // Check if user wants to save local files to disc
        let savedToDisc = false;
        if (localFileStreams.length > 0) {
            const saveToDisc = confirm(
                `Save ${localFileStreams.length} local file(s) to browser storage?\n\n` +
                'This allows loading the set without re-providing files.\n' +
                'Note: Large files may use significant storage space.'
            );

            if (saveToDisc) {
                showMessage('Saving local files to disc...', 'info');
                let savedCount = 0;
                for (const stream of localFileStreams) {
                    // Fetch the blob from the blob URL
                    try {
                        const response = await fetch(stream.url);
                        const blob = await response.blob();
                        const success = await saveLocalFileToDisc(name, stream.fileName, blob);
                        if (success) savedCount++;
                    } catch (err) {
                        console.error(`[Plexd] Failed to save ${stream.fileName}:`, err);
                    }
                }
                savedToDisc = savedCount > 0;
                if (savedCount < localFileStreams.length) {
                    console.warn(`[Plexd] Only saved ${savedCount}/${localFileStreams.length} files`);
                }
            }
        }

        // Collect favorites data (which streams are favorited)
        const favoriteUrls = [];
        const favoriteFileNames = [];
        streams.forEach(s => {
            if (PlexdStream.getFavorite(s.url, s.fileName)) {
                if (isBlobUrl(s.url) && s.fileName) {
                    favoriteFileNames.push(s.fileName);
                } else {
                    favoriteUrls.push(s.url);
                }
            }
        });

        const combinations = JSON.parse(localStorage.getItem('plexd_combinations') || '{}');
        combinations[name] = {
            urls: urls,
            localFiles: localFiles,
            localFileRatings: Object.keys(localFileRatings).length > 0 ? localFileRatings : undefined,
            localFilesSavedToDisc: savedToDisc,
            loginDomains: loginDomains,
            favoriteUrls: favoriteUrls.length > 0 ? favoriteUrls : undefined,
            favoriteFileNames: favoriteFileNames.length > 0 ? favoriteFileNames : undefined,
            savedAt: Date.now()
        };

        try {
            localStorage.setItem('plexd_combinations', JSON.stringify(combinations));
        } catch (err) {
            console.error('[Plexd] Failed to save combination to localStorage:', err);
            showMessage('Failed to save: storage quota exceeded', 'error');
            return;
        }

        // Build informative message
        const totalCount = urls.length + localFiles.length;
        const favCount = favoriteUrls.length + favoriteFileNames.length;
        let msg = `Saved: ${name} (${totalCount} stream${totalCount !== 1 ? 's' : ''})`;
        if (localFiles.length > 0) {
            msg += ` | ${localFiles.length} local`;
            if (savedToDisc) {
                msg += ' (stored)';
            }
        }
        if (favCount > 0) {
            msg += ` | ${favCount} fav`;
        }
        if (shortVideos > 0) {
            msg += ` | excluded: ${shortVideos} short`;
        }
        if (loginDomains.length > 0) {
            msg += ` | Login: ${loginDomains.join(', ')}`;
        }
        showMessage(msg, 'success');
        updateCombinationsList();
    }

    /**
     * Save favorite streams as a combination/set
     */
    async function saveFavoritesAsCombination() {
        const streams = PlexdStream.getFavoriteStreams();
        if (streams.length === 0) {
            showMessage('No favorites to save. Press * on selected streams to add them to favorites.', 'warning');
            return;
        }

        // Separate local files from URL streams
        const localFileStreams = streams.filter(s => isBlobUrl(s.url) && s.fileName);
        const urlStreams = streams.filter(s => !isBlobUrl(s.url));
        const shortVideos = urlStreams.filter(s => !shouldSaveStream(s)).length;
        const validUrlStreams = urlStreams.filter(s => shouldSaveStream(s));

        // Check if we have anything to save
        if (validUrlStreams.length === 0 && localFileStreams.length === 0) {
            const reasons = [];
            if (shortVideos > 0) reasons.push('videos too short');
            showMessage(`No valid favorites to save${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}`, 'error');
            return;
        }

        const name = prompt(`Enter a name for this favorites set (${streams.length} favorites):`);
        if (!name) return;

        // Dedupe URLs by normalized equality key
        const urls = [];
        const seen = new Set();
        validUrlStreams.forEach(s => {
            const key = urlEqualityKey(s.url);
            if (seen.has(key)) return;
            seen.add(key);
            urls.push(s.url);
        });

        // Save local files with their ratings
        const localFilesData = localFileStreams.map(s => ({
            fileName: s.fileName,
            rating: PlexdStream.getRating(s.url) || 0
        }));
        const localFiles = localFilesData.map(f => f.fileName);
        const localFileRatings = {};
        localFilesData.forEach(f => {
            if (f.rating > 0) {
                localFileRatings[f.fileName] = f.rating;
            }
        });
        const loginDomains = extractLoginDomains(urls);

        // Check if user wants to save local files to disc
        let savedToDisc = false;
        if (localFileStreams.length > 0) {
            const saveToDisc = confirm(
                `Save ${localFileStreams.length} local file(s) to browser storage?\n\n` +
                'This allows loading the set without re-providing files.\n' +
                'Note: Large files may use significant storage space.'
            );

            if (saveToDisc) {
                showMessage('Saving local files to disc...', 'info');
                let savedCount = 0;
                for (const stream of localFileStreams) {
                    try {
                        const response = await fetch(stream.url);
                        const blob = await response.blob();
                        const success = await saveLocalFileToDisc(name, stream.fileName, blob);
                        if (success) savedCount++;
                    } catch (err) {
                        console.error(`[Plexd] Failed to save ${stream.fileName}:`, err);
                    }
                }
                savedToDisc = savedCount > 0;
            }
        }

        const combinations = JSON.parse(localStorage.getItem('plexd_combinations') || '{}');
        combinations[name] = {
            urls: urls,
            localFiles: localFiles,
            localFileRatings: Object.keys(localFileRatings).length > 0 ? localFileRatings : undefined,
            localFilesSavedToDisc: savedToDisc,
            loginDomains: loginDomains,
            savedAt: Date.now(),
            isFavoritesSet: true // Mark as a favorites set
        };
        localStorage.setItem('plexd_combinations', JSON.stringify(combinations));

        const totalCount = urls.length + localFiles.length;
        let msg = `Saved favorites: ${name} (${totalCount} stream${totalCount !== 1 ? 's' : ''})`;
        if (localFiles.length > 0) {
            msg += ` | ${localFiles.length} local`;
            if (savedToDisc) msg += ' (stored)';
        }
        showMessage(msg, 'success');
        updateCombinationsList();
    }

    /**
     * Load a saved stream combination
     */
    async function loadStreamCombination(name) {
        const combinations = JSON.parse(localStorage.getItem('plexd_combinations') || '{}');
        const combo = combinations[name];

        if (!combo) {
            showMessage(`Combination "${name}" not found`, 'error');
            return;
        }

        // Check if there are local files to provide
        const localFiles = combo.localFiles || [];
        const loginDomains = combo.loginDomains || [];

        // Chain of modals: login domains first, then local files
        const loadWithFiles = (providedFiles) => {
            if (loginDomains.length > 0) {
                showLoginDomainsModal(name, loginDomains, () => {
                    loadCombinationStreams(name, combo, providedFiles);
                });
            } else {
                loadCombinationStreams(name, combo, providedFiles);
            }
        };

        if (localFiles.length > 0) {
            // First try to load from disc storage
            if (combo.localFilesSavedToDisc) {
                showMessage('Loading local files from storage...', 'info');
                const loadedFiles = [];
                let loadedCount = 0;
                const missingFiles = [];

                for (let i = 0; i < localFiles.length; i++) {
                    const fileName = localFiles[i];
                    const file = await loadLocalFileFromDisc(name, fileName);
                    if (file) {
                        loadedFiles[i] = file;
                        loadedCount++;
                    } else {
                        missingFiles.push(fileName);
                    }
                }

                if (missingFiles.length === 0) {
                    // All files loaded from disc
                    loadWithFiles(loadedFiles);
                } else {
                    // Some files missing - show modal for remaining
                    showLocalFilesModal(name, missingFiles, (additionalFiles) => {
                        // Merge loaded and additional files
                        let addIdx = 0;
                        for (let i = 0; i < localFiles.length; i++) {
                            if (!loadedFiles[i] && additionalFiles[addIdx]) {
                                loadedFiles[i] = additionalFiles[addIdx];
                            }
                            if (!loadedFiles[i]) addIdx++;
                        }
                        loadWithFiles(loadedFiles);
                    }, loadedCount);
                }
            } else {
                // Files not saved to disc - show modal
                showLocalFilesModal(name, localFiles, loadWithFiles);
            }
        } else {
            loadWithFiles([]);
        }
    }

    /**
     * Show modal to let user provide local files needed by a combination
     */
    function showLocalFilesModal(name, expectedFiles, onContinue) {
        // Remove existing modal if any
        const existingModal = document.getElementById('local-files-modal');
        if (existingModal) existingModal.remove();

        let providedFiles = [];

        const modal = document.createElement('div');
        modal.id = 'local-files-modal';
        modal.className = 'plexd-modal-overlay';
        modal.innerHTML = `
            <div class="plexd-modal plexd-modal-wide">
                <h3>Local Files Required</h3>
                <p>This set includes ${expectedFiles.length} local file${expectedFiles.length !== 1 ? 's' : ''}. Drop or select the files below:</p>
                <div class="plexd-local-files-list">
                    ${expectedFiles.map((fileName, idx) => `
                        <div class="plexd-local-file-item" data-index="${idx}" data-expected="${escapeAttr(fileName)}">
                            <span class="plexd-local-file-name">${escapeHtml(fileName)}</span>
                            <span class="plexd-local-file-status">Not provided</span>
                        </div>
                    `).join('')}
                </div>
                <div class="plexd-local-files-drop" id="local-files-drop-zone">
                    <div class="plexd-drop-text">Drop video files here or click to browse</div>
                    <input type="file" id="local-files-input" multiple accept="video/*,.mov,.mp4,.m4v,.webm,.mkv,.avi,.ogv,.3gp,.flv,.mpeg,.mpg" style="display: none;">
                </div>
                <div class="plexd-modal-hint">
                    Files will be matched by name. You can skip files you don't have.
                </div>
                <div class="plexd-modal-actions">
                    <button id="local-modal-cancel" class="plexd-button plexd-button-secondary">Cancel</button>
                    <button id="local-modal-skip" class="plexd-button plexd-button-secondary">Skip Local Files</button>
                    <button id="local-modal-continue" class="plexd-button plexd-button-primary">Load Streams</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        const dropZone = document.getElementById('local-files-drop-zone');
        const fileInput = document.getElementById('local-files-input');

        // Handle file selection
        function handleFiles(files) {
            Array.from(files).forEach(file => {
                // Find matching expected file by name
                const fileItems = modal.querySelectorAll('.plexd-local-file-item');
                let matched = false;

                fileItems.forEach(item => {
                    const expected = item.dataset.expected;
                    const idx = parseInt(item.dataset.index);

                    // Match by exact name or similar name (case-insensitive, without extension)
                    const expectedBase = expected.replace(/\.[^/.]+$/, '').toLowerCase();
                    const fileBase = file.name.replace(/\.[^/.]+$/, '').toLowerCase();

                    if (!matched && (file.name === expected || expectedBase === fileBase)) {
                        // Create blob URL and store
                        const objectUrl = URL.createObjectURL(file);
                        providedFiles[idx] = { url: objectUrl, fileName: file.name };

                        // Update UI
                        item.classList.add('plexd-local-file-matched');
                        item.querySelector('.plexd-local-file-status').textContent = '✓ ' + file.name;
                        matched = true;
                    }
                });

                if (!matched) {
                    // Try partial match - file name contains expected name or vice versa
                    fileItems.forEach(item => {
                        if (matched) return;
                        const expected = item.dataset.expected;
                        const idx = parseInt(item.dataset.index);
                        const expectedBase = expected.replace(/\.[^/.]+$/, '').toLowerCase();
                        const fileBase = file.name.replace(/\.[^/.]+$/, '').toLowerCase();

                        if (providedFiles[idx] === undefined &&
                            (expectedBase.includes(fileBase) || fileBase.includes(expectedBase))) {
                            const objectUrl = URL.createObjectURL(file);
                            providedFiles[idx] = { url: objectUrl, fileName: file.name };
                            item.classList.add('plexd-local-file-matched');
                            item.querySelector('.plexd-local-file-status').textContent = '✓ ' + file.name;
                            matched = true;
                        }
                    });
                }
            });
        }

        // Click to browse
        dropZone.addEventListener('click', () => fileInput.click());
        fileInput.addEventListener('change', (e) => {
            if (e.target.files) handleFiles(e.target.files);
        });

        // Drag and drop
        dropZone.addEventListener('dragover', (e) => {
            e.preventDefault();
            dropZone.classList.add('plexd-drop-active');
        });
        dropZone.addEventListener('dragleave', () => {
            dropZone.classList.remove('plexd-drop-active');
        });
        dropZone.addEventListener('drop', (e) => {
            e.preventDefault();
            dropZone.classList.remove('plexd-drop-active');
            if (e.dataTransfer?.files) handleFiles(e.dataTransfer.files);
        });

        // Button handlers
        document.getElementById('local-modal-cancel').addEventListener('click', () => {
            // Revoke any created blob URLs
            providedFiles.forEach(f => f && URL.revokeObjectURL(f.url));
            modal.remove();
        });

        document.getElementById('local-modal-skip').addEventListener('click', () => {
            // Revoke any created blob URLs
            providedFiles.forEach(f => f && URL.revokeObjectURL(f.url));
            modal.remove();
            onContinue([]);
        });

        document.getElementById('local-modal-continue').addEventListener('click', () => {
            modal.remove();
            onContinue(providedFiles);
        });

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                providedFiles.forEach(f => f && URL.revokeObjectURL(f.url));
                modal.remove();
            }
        });

        // Close on Escape
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                providedFiles.forEach(f => f && URL.revokeObjectURL(f.url));
                modal.remove();
                document.removeEventListener('keydown', handleEscape);
            }
        };
        document.addEventListener('keydown', handleEscape);
    }

    /**
     * Actually load the combination streams
     * @param {string} name - Combination name
     * @param {Object} combo - Combination data
     * @param {Array} providedFiles - Array of {url, fileName} for local files
     */
    function loadCombinationStreams(name, combo, providedFiles = []) {
        // Clear current streams
        const currentStreams = PlexdStream.getAllStreams();
        currentStreams.forEach(s => PlexdStream.removeStream(s.id));

        // Log HLS.js availability for debugging
        const hlsAvailable = typeof Hls !== 'undefined' && Hls.isSupported();
        const urlCount = combo.urls?.length || 0;
        const localCount = providedFiles.filter(f => f).length;
        console.log(`[Plexd] Loading "${name}": ${urlCount} URL streams, ${localCount} local files, HLS.js: ${hlsAvailable ? 'available' : 'NOT AVAILABLE'}`);

        // Load URL streams with validation
        let loadedCount = 0;
        let skippedCount = 0;

        if (combo.urls) {
            combo.urls.forEach((url, index) => {
                if (url && isValidUrl(url)) {
                    console.log(`[Plexd] Loading stream ${index + 1}/${urlCount}: ${truncateUrl(url, 80)}`);
                    addStreamSilent(url);
                    loadedCount++;
                } else {
                    console.warn(`[Plexd] Skipping invalid URL at index ${index}:`, url);
                    skippedCount++;
                }
            });
        }

        // Load provided local files and restore their ratings
        let localLoaded = 0;
        const localFileRatings = combo.localFileRatings || {};
        const localFiles = combo.localFiles || [];

        providedFiles.forEach((file, index) => {
            if (file && file.url) {
                const originalFileName = localFiles[index];
                console.log(`[Plexd] Loading local file ${index + 1}: ${file.fileName}`);
                addStreamFromFile(file.url, file.fileName);
                localLoaded++;

                // Restore rating if saved (ratings are now automatically loaded via syncRatingStatus)
                // But we can also explicitly restore here for immediate feedback
                const savedRating = localFileRatings[originalFileName] || localFileRatings[file.fileName];
                if (savedRating && savedRating > 0) {
                    // Find the just-added stream and set its rating
                    const streams = PlexdStream.getAllStreams();
                    const newStream = streams.find(s => s.url === file.url && s.fileName === file.fileName);
                    if (newStream) {
                        PlexdStream.setRating(newStream.id, savedRating);
                        console.log(`[Plexd] Restored rating ${savedRating} for ${file.fileName}`);
                    }
                }
            }
        });

        // Restore favorites
        let favoritesRestored = 0;
        const favoriteUrls = combo.favoriteUrls || [];
        const favoriteFileNames = combo.favoriteFileNames || [];

        if (favoriteUrls.length > 0 || favoriteFileNames.length > 0) {
            // Wait a moment for streams to be fully added
            setTimeout(() => {
                const streams = PlexdStream.getAllStreams();
                streams.forEach(stream => {
                    const isFavByUrl = favoriteUrls.includes(stream.url);
                    const isFavByFileName = stream.fileName && favoriteFileNames.includes(stream.fileName);
                    if (isFavByUrl || isFavByFileName) {
                        PlexdStream.setFavorite(stream.id, true);
                        favoritesRestored++;
                    }
                });
                if (favoritesRestored > 0) {
                    console.log(`[Plexd] Restored ${favoritesRestored} favorites`);
                }
            }, 100);
        }

        // Save to current streams (only URL streams, not local files)
        const validUrls = (combo.urls || []).filter(url => url && isValidUrl(url));
        localStorage.setItem('plexd_streams', JSON.stringify(validUrls));

        // Build message
        const total = loadedCount + localLoaded;
        const favCount = favoriteUrls.length + favoriteFileNames.length;
        let msg = `Loaded: ${name} (${total} stream${total !== 1 ? 's' : ''})`;
        if (localLoaded > 0) {
            msg += ` | ${localLoaded} local`;
        }
        if (favCount > 0) {
            msg += ` | ${favCount} fav`;
        }
        if (skippedCount > 0) {
            msg += ` | ${skippedCount} skipped`;
        }
        showMessage(msg, 'success');
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

    // ===== FAVORITES MODAL OVERLAY =====

    let favoritesModalSelectedIndex = 0;

    /**
     * Toggle the favorites modal overlay
     * Shows all favorite streams in a grid overlay with keyboard navigation
     */
    function toggleFavoritesModal() {
        const existingModal = document.getElementById('favorites-modal');
        if (existingModal) {
            closeFavoritesModal();
            return;
        }
        showFavoritesModal();
    }

    /**
     * Show the favorites modal overlay
     */
    function showFavoritesModal() {
        const favorites = PlexdStream.getFavoriteStreams();

        if (favorites.length === 0) {
            showMessage('No favorites yet. Press * to add streams to favorites.', 'info');
            return;
        }

        favoritesModalSelectedIndex = 0;

        const modal = document.createElement('div');
        modal.id = 'favorites-modal';
        modal.className = 'plexd-modal-overlay plexd-favorites-modal-overlay';

        // Create video grid for favorites
        const gridHtml = favorites.map((stream, idx) => {
            const title = stream.fileName || stream.url.split('/').pop() || 'Stream';
            return `
                <div class="plexd-fav-modal-item${idx === 0 ? ' selected' : ''}" data-index="${idx}" data-stream-id="${stream.id}">
                    <div class="plexd-fav-modal-video-wrapper">
                        <video
                            src="${escapeAttr(stream.url)}"
                            muted
                            loop
                            playsinline
                            preload="metadata"
                        ></video>
                        <div class="plexd-fav-modal-star">★</div>
                    </div>
                    <div class="plexd-fav-modal-title">${escapeHtml(title)}</div>
                </div>
            `;
        }).join('');

        modal.innerHTML = `
            <div class="plexd-favorites-modal">
                <div class="plexd-favorites-modal-header">
                    <h3>★ Favorites (${favorites.length})</h3>
                    <div class="plexd-favorites-modal-hint">Arrow keys to navigate • Enter to view • Esc or \` to close</div>
                </div>
                <div class="plexd-favorites-modal-grid">
                    ${gridHtml}
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Start playing preview videos on hover/selection
        const items = modal.querySelectorAll('.plexd-fav-modal-item');
        items.forEach((item, idx) => {
            const video = item.querySelector('video');

            // Play video when selected or hovered
            item.addEventListener('mouseenter', () => {
                video.currentTime = favorites[idx].video?.currentTime || 0;
                video.play().catch(() => {});
            });
            item.addEventListener('mouseleave', () => {
                if (!item.classList.contains('selected')) {
                    video.pause();
                }
            });

            // Click to view in fullscreen
            item.addEventListener('click', () => {
                closeFavoritesModal();
                PlexdStream.selectStream(favorites[idx].id);
                PlexdStream.enterFocusedMode(favorites[idx].id);
            });
        });

        // Start playing the first selected item
        const firstVideo = items[0]?.querySelector('video');
        if (firstVideo && favorites[0]) {
            firstVideo.currentTime = favorites[0].video?.currentTime || 0;
            firstVideo.play().catch(() => {});
        }

        // Handle keyboard navigation within modal
        const handleModalKeyboard = (e) => {
            const currentItems = modal.querySelectorAll('.plexd-fav-modal-item');
            const currentFavorites = PlexdStream.getFavoriteStreams();
            const count = currentItems.length;

            if (count === 0) {
                closeFavoritesModal();
                return;
            }

            switch (e.key) {
                case 'Escape':
                case '`':
                    e.preventDefault();
                    closeFavoritesModal();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    updateFavoritesModalSelection((favoritesModalSelectedIndex + 1) % count, currentItems, currentFavorites);
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    updateFavoritesModalSelection((favoritesModalSelectedIndex - 1 + count) % count, currentItems, currentFavorites);
                    break;
                case 'ArrowDown':
                    e.preventDefault();
                    // Move down by row (estimate 4 items per row)
                    {
                        const cols = Math.max(1, Math.floor(modal.querySelector('.plexd-favorites-modal-grid').offsetWidth / 220));
                        updateFavoritesModalSelection(Math.min(count - 1, favoritesModalSelectedIndex + cols), currentItems, currentFavorites);
                    }
                    break;
                case 'ArrowUp':
                    e.preventDefault();
                    // Move up by row
                    {
                        const cols = Math.max(1, Math.floor(modal.querySelector('.plexd-favorites-modal-grid').offsetWidth / 220));
                        updateFavoritesModalSelection(Math.max(0, favoritesModalSelectedIndex - cols), currentItems, currentFavorites);
                    }
                    break;
                case 'Enter':
                    e.preventDefault();
                    if (currentFavorites[favoritesModalSelectedIndex]) {
                        closeFavoritesModal();
                        PlexdStream.selectStream(currentFavorites[favoritesModalSelectedIndex].id);
                        PlexdStream.enterFocusedMode(currentFavorites[favoritesModalSelectedIndex].id);
                    }
                    break;
                case '*':
                    // Remove from favorites
                    e.preventDefault();
                    if (currentFavorites[favoritesModalSelectedIndex]) {
                        PlexdStream.toggleFavorite(currentFavorites[favoritesModalSelectedIndex].id);
                        showMessage('Removed from favorites', 'info');
                        // Refresh the modal
                        closeFavoritesModal();
                        if (PlexdStream.getFavoriteCount() > 0) {
                            setTimeout(showFavoritesModal, 100);
                        }
                    }
                    break;
            }
        };

        document.addEventListener('keydown', handleModalKeyboard);
        modal._keyboardHandler = handleModalKeyboard;

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) {
                closeFavoritesModal();
            }
        });
    }

    /**
     * Update selection in favorites modal
     */
    function updateFavoritesModalSelection(newIndex, items, favorites) {
        // Remove selection from current
        items[favoritesModalSelectedIndex]?.classList.remove('selected');
        items[favoritesModalSelectedIndex]?.querySelector('video')?.pause();

        // Add selection to new
        favoritesModalSelectedIndex = newIndex;
        const newItem = items[favoritesModalSelectedIndex];
        if (newItem) {
            newItem.classList.add('selected');
            newItem.scrollIntoView({ behavior: 'smooth', block: 'nearest' });

            const video = newItem.querySelector('video');
            if (video && favorites[favoritesModalSelectedIndex]) {
                video.currentTime = favorites[favoritesModalSelectedIndex].video?.currentTime || 0;
                video.play().catch(() => {});
            }
        }
    }

    /**
     * Close the favorites modal
     */
    function closeFavoritesModal() {
        const modal = document.getElementById('favorites-modal');
        if (modal) {
            if (modal._keyboardHandler) {
                document.removeEventListener('keydown', modal._keyboardHandler);
            }
            modal.remove();
        }
    }

    /**
     * Delete a saved combination
     */
    async function deleteStreamCombination(name) {
        const combinations = JSON.parse(localStorage.getItem('plexd_combinations') || '{}');
        if (combinations[name]) {
            // Delete local files from IndexedDB if they were saved to disc
            if (combinations[name].localFilesSavedToDisc) {
                await deleteLocalFilesForSet(name);
            }
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

                    let merged = 0;
                    Object.keys(data.combinations).forEach(name => {
                        const combo = data.combinations[name];
                        const hasUrls = combo.urls && Array.isArray(combo.urls);
                        const hasLocalFiles = combo.localFiles && Array.isArray(combo.localFiles);

                        if (hasUrls || hasLocalFiles) {
                            if (existing[name]) {
                                let changed = false;
                                // Merge URLs from both sets (avoid duplicates)
                                if (hasUrls) {
                                    const existingUrlList = Array.isArray(existing[name].urls) ? existing[name].urls : [];
                                    const existingKeys = new Set(existingUrlList.map(u => urlEqualityKey(u)));
                                    const mergedUrls = [...existingUrlList];
                                    combo.urls.forEach(url => {
                                        if (!url || !isValidUrl(url)) return;
                                        const key = urlEqualityKey(url);
                                        if (existingKeys.has(key)) return;
                                        existingKeys.add(key);
                                        mergedUrls.push(url);
                                    });
                                    if (mergedUrls.length !== existingUrlList.length) {
                                        existing[name].urls = mergedUrls;
                                        changed = true;
                                    }
                                }
                                // Merge local files (avoid duplicates)
                                if (hasLocalFiles) {
                                    const existingLocal = Array.isArray(existing[name].localFiles) ? existing[name].localFiles : [];
                                    const existingFiles = new Set(existingLocal.map(f => (f || '').toLowerCase()));
                                    const mergedFiles = [...existingLocal];
                                    combo.localFiles.forEach(f => {
                                        if (!f) return;
                                        const key = (f || '').toLowerCase();
                                        if (existingFiles.has(key)) return;
                                        existingFiles.add(key);
                                        mergedFiles.push(f);
                                    });
                                    if (mergedFiles.length !== existingLocal.length) {
                                        existing[name].localFiles = mergedFiles;
                                        changed = true;
                                    }
                                }
                                // Merge login domains
                                const existingDomains = new Set(existing[name].loginDomains || []);
                                const newDomains = (combo.loginDomains || []).filter(d => !existingDomains.has(d));
                                if (newDomains.length > 0) {
                                    existing[name].loginDomains = [...(existing[name].loginDomains || []), ...newDomains];
                                    changed = true;
                                }
                                if (changed) {
                                    merged++;
                                } else {
                                    skipped++;
                                }
                            } else {
                                // Sanitize imported combo: dedupe URLs by normalized equality key.
                                const sanitized = { ...combo };
                                if (hasUrls) {
                                    const seen = new Set();
                                    sanitized.urls = combo.urls
                                        .filter(u => u && isValidUrl(u))
                                        .filter(u => {
                                            const key = urlEqualityKey(u);
                                            if (seen.has(key)) return false;
                                            seen.add(key);
                                            return true;
                                        });
                                }
                                if (hasLocalFiles) {
                                    const seenFiles = new Set();
                                    sanitized.localFiles = combo.localFiles.filter(f => {
                                        if (!f) return false;
                                        const key = (f || '').toLowerCase();
                                        if (seenFiles.has(key)) return false;
                                        seenFiles.add(key);
                                        return true;
                                    });
                                }
                                existing[name] = sanitized;
                                imported++;
                            }
                        } else {
                            skipped++;
                        }
                    });

                    localStorage.setItem('plexd_combinations', JSON.stringify(existing));
                    updateCombinationsList();

                    let msg = [];
                    if (imported > 0) msg.push(`${imported} new`);
                    if (merged > 0) msg.push(`${merged} merged`);
                    if (skipped > 0) msg.push(`${skipped} skipped`);
                    showMessage(msg.length > 0 ? msg.join(', ') : 'No changes', 'success');

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
            // Skip invalid entries
            if (!combo) return '';
            // Defensive: handle missing urls array (corrupted/old data)
            const urlCount = (combo.urls || []).length;
            const localCount = (combo.localFiles || []).length;
            const totalCount = urlCount + localCount;
            const loginCount = (combo.loginDomains || []).length;
            const loginHint = loginCount > 0 ? ` · ${loginCount} login site${loginCount > 1 ? 's' : ''}` : '';
            return `
                <div class="plexd-combo-item" data-name="${escapeAttr(name)}">
                    <span class="plexd-combo-name">${escapeHtml(name)}</span>
                    <span class="plexd-combo-count">${totalCount} stream${totalCount !== 1 ? 's' : ''}${loginHint}</span>
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
            const willOpen = !panel.classList.contains('plexd-panel-open');
            if (willOpen) {
                // Panels are mutually exclusive for a clean UX.
                // When one opens, close the others.
                ['streams-panel', 'saved-panel', 'history-panel', 'queue-panel'].forEach(id => {
                    if (id !== panelId) {
                        const other = document.getElementById(id);
                        if (other) other.classList.remove('plexd-panel-open');
                    }
                });
                // Refresh panel content when opening
                if (panelId === 'saved-panel') {
                    updateCombinationsList();
                } else if (panelId === 'streams-panel') {
                    updateStreamsPanelUI();
                }
            }
            panel.classList.toggle('plexd-panel-open');
        }
    }

    /**
     * Open a panel and close other mutually-exclusive panels.
     */
    function openPanel(panelId) {
        const panel = document.getElementById(panelId);
        if (!panel) return;
        ['streams-panel', 'saved-panel', 'history-panel', 'queue-panel'].forEach(id => {
            if (id !== panelId) {
                const other = document.getElementById(id);
                if (other) other.classList.remove('plexd-panel-open');
            }
        });
        // Refresh panel content when opening
        if (panelId === 'saved-panel') {
            updateCombinationsList();
        } else if (panelId === 'streams-panel') {
            updateStreamsPanelUI();
        }
        panel.classList.add('plexd-panel-open');
    }

    // ========================================
    // Streams Panel Management
    // ========================================

    /**
     * Update streams panel UI with list of all active streams
     */
    function updateStreamsPanelUI() {
        const streamsList = document.getElementById('streams-list');
        if (!streamsList) return;

        const allStreams = PlexdStream.getAllStreams();
        const selectedStream = PlexdStream.getSelectedStream();

        if (allStreams.length === 0) {
            streamsList.innerHTML = '<div class="plexd-panel-empty">No active streams</div>';
            return;
        }

        streamsList.innerHTML = allStreams.map((stream, index) => {
            const isLocal = stream.url.startsWith('blob:');
            const isSelected = selectedStream && selectedStream.id === stream.id;
            const rating = PlexdStream.getRating(stream.url);
            const displayName = stream.fileName || getStreamDisplayName(stream.url);
            const displayUrl = isLocal ? 'Local file' : truncateUrl(stream.url, 30);
            const stateClass = stream.state === 'playing' ? 'playing' :
                              stream.state === 'error' ? 'error' :
                              stream.state === 'buffering' || stream.state === 'loading' ? 'buffering' : '';
            const stateIcon = stream.state === 'playing' ? '▶' :
                             stream.state === 'paused' ? '⏸' :
                             stream.state === 'error' ? '⚠' :
                             stream.state === 'buffering' || stream.state === 'loading' ? '⏳' : '●';
            const ratingDisplay = rating > 0 ? `<span class="plexd-stream-rating rated-${rating}">★${rating}</span>` : '';

            return `
                <div class="plexd-stream-item ${isSelected ? 'selected' : ''} ${isLocal ? 'local-file' : ''}"
                     data-stream-id="${stream.id}"
                     onclick="PlexdApp.selectAndFocusStream('${stream.id}')">
                    <span class="plexd-stream-type ${isLocal ? 'local' : 'stream'}">${isLocal ? 'FILE' : 'URL'}</span>
                    <div class="plexd-stream-info">
                        <div class="plexd-stream-name">${escapeHtml(displayName)}${ratingDisplay}</div>
                        <div class="plexd-stream-url">${escapeHtml(displayUrl)}</div>
                        <div class="plexd-stream-status ${stateClass}">${stateIcon} ${stream.state}</div>
                    </div>
                    <div class="plexd-stream-actions">
                        <button class="plexd-stream-btn reload"
                                onclick="event.stopPropagation(); PlexdApp.reloadStreamFromPanel('${stream.id}')"
                                title="Reload stream">↻</button>
                        <button class="plexd-stream-btn close"
                                onclick="event.stopPropagation(); PlexdApp.closeStreamFromPanel('${stream.id}')"
                                title="Close stream">✕</button>
                    </div>
                </div>
            `;
        }).join('');
    }

    /**
     * Get display name from URL (extracts filename or domain)
     */
    function getStreamDisplayName(url) {
        try {
            const urlObj = new URL(url);
            // Try to get filename from path
            const pathParts = urlObj.pathname.split('/').filter(p => p);
            if (pathParts.length > 0) {
                const lastPart = pathParts[pathParts.length - 1];
                // Remove query parameters and decode
                const filename = decodeURIComponent(lastPart.split('?')[0]);
                if (filename && filename.length > 3) {
                    return filename;
                }
            }
            // Fallback to hostname
            return urlObj.hostname;
        } catch (e) {
            return url.substring(0, 30);
        }
    }

    /**
     * Select a stream and focus on it in the grid
     */
    function selectAndFocusStream(streamId) {
        PlexdStream.selectStream(streamId);
        const stream = PlexdStream.getStream(streamId);
        if (stream) {
            stream.wrapper.scrollIntoView({ behavior: 'smooth', block: 'center' });
            stream.wrapper.focus();
        }
        updateStreamsPanelUI();
    }

    /**
     * Close a stream from the streams panel and focus next
     */
    function closeStreamFromPanel(streamId) {
        const allStreams = PlexdStream.getAllStreams();
        const currentIndex = allStreams.findIndex(s => s.id === streamId);

        // Find next stream to focus (or previous if at end)
        let nextStreamId = null;
        if (allStreams.length > 1) {
            if (currentIndex < allStreams.length - 1) {
                nextStreamId = allStreams[currentIndex + 1].id;
            } else if (currentIndex > 0) {
                nextStreamId = allStreams[currentIndex - 1].id;
            }
        }

        // Remove the stream
        PlexdStream.removeStream(streamId);
        updateStreamCount();
        saveCurrentStreams();
        updateStreamsPanelUI();
        showMessage('Stream closed', 'info');

        // Focus the next close button in the panel for quick sequential closing
        if (nextStreamId) {
            PlexdStream.selectStream(nextStreamId);
            setTimeout(() => {
                const nextItem = document.querySelector(`[data-stream-id="${nextStreamId}"] .plexd-stream-btn.close`);
                if (nextItem) {
                    nextItem.focus();
                }
            }, 50);
        }
    }

    /**
     * Reload a stream from the streams panel
     */
    function reloadStreamFromPanel(streamId) {
        PlexdStream.reloadStream(streamId);
        showMessage('Reloading stream...', 'info');
        // Update UI after a short delay to show new state
        setTimeout(updateStreamsPanelUI, 500);
    }

    /**
     * Reload all streams
     */
    function reloadAllStreams() {
        const allStreams = PlexdStream.getAllStreams();
        allStreams.forEach(stream => {
            PlexdStream.reloadStream(stream.id);
        });
        showMessage(`Reloading ${allStreams.length} stream(s)...`, 'info');
        setTimeout(updateStreamsPanelUI, 500);
    }

    /**
     * Close all streams
     */
    function closeAllStreams() {
        const allStreams = PlexdStream.getAllStreams();
        const count = allStreams.length;
        allStreams.forEach(stream => {
            PlexdStream.removeStream(stream.id);
        });
        localStorage.removeItem('plexd_streams');
        updateStreamCount();
        updateStreamsPanelUI();
        showMessage(`Closed ${count} stream(s)`, 'info');
    }

    /**
     * Seek all streams to random positions with retry logic
     * Updates the button with feedback
     */
    async function randomSeekAll() {
        const btn = document.getElementById('random-seek-all-btn');
        const originalText = btn ? btn.innerHTML : '';

        if (btn) btn.innerHTML = '⏳';

        try {
            const successCount = await PlexdStream.seekAllToRandomPosition();
            const totalCount = PlexdStream.getStreamCount();

            if (btn) {
                btn.innerHTML = successCount === totalCount ? '✓' : `${successCount}/${totalCount}`;
                setTimeout(() => { btn.innerHTML = '🔀'; }, 1500);
            }

            if (successCount === totalCount) {
                showMessage(`All ${successCount} streams playing`, 'success');
            } else if (successCount > 0) {
                showMessage(`${successCount}/${totalCount} streams playing`, 'warning');
            } else {
                showMessage('Could not start any streams', 'error');
            }
        } catch (e) {
            if (btn) btn.innerHTML = '✗';
            setTimeout(() => { if (btn) btn.innerHTML = '🔀'; }, 1500);
            showMessage('Random seek failed', 'error');
        }
    }

    /**
     * Seek selected or focused stream to random position
     */
    async function randomSeekSelected() {
        const selected = PlexdStream.getSelectedStream();
        const fullscreen = PlexdStream.getFullscreenStream();
        const target = fullscreen || selected;

        if (!target) {
            showMessage('Select a stream first', 'info');
            return;
        }

        showMessage('Seeking...', 'info');
        const success = await PlexdStream.seekToRandomPosition(target.id);

        if (success) {
            // Sync overlay clones to the new position
            syncOverlayClones();
            showMessage('Playing from random position', 'success');
        } else {
            showMessage('Could not seek stream', 'warning');
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
        saveFavorites: saveFavoritesAsCombination,
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
        openPanel,
        // Streams panel
        selectAndFocusStream,
        closeStreamFromPanel,
        reloadStreamFromPanel,
        reloadAllStreams,
        closeAllStreams,
        // View modes
        setViewMode,
        cycleViewMode,
        // Layout modes
        toggleTetrisMode,
        cycleTetrisMode,
        toggleCoverflowMode,
        toggleSmartLayoutMode, // Legacy alias for Coverflow
        toggleBugEyeMode,
        toggleMosaicMode,
        toggleHeader,
        // Global controls
        togglePauseAll,
        toggleMuteAll,
        toggleAudioFocus,
        toggleCleanMode,
        toggleGlobalFullscreen,
        randomSeekAll,
        randomSeekSelected
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

// ========================================
// Remote Control via BroadcastChannel + localStorage
// ========================================

/**
 * PlexdRemote - Handles communication between main display and remote control
 * Uses BroadcastChannel for same-browser tabs AND localStorage for cross-device
 */
const PlexdRemote = (function() {
    'use strict';

    let channel = null;
    let stateUpdateInterval = null;
    let commandPollInterval = null;
    const COMMAND_KEY = 'plexd_remote_command';
    const STATE_KEY = 'plexd_remote_state';

    /**
     * Initialize remote control listener (called on main display)
     */
    function init() {
        // BroadcastChannel for same-browser tabs
        if (typeof BroadcastChannel !== 'undefined') {
            channel = new BroadcastChannel('plexd-remote');
            channel.onmessage = (event) => {
                const { action, payload } = event.data;
                handleRemoteCommand(action, payload);
            };
        }

        // localStorage polling for cross-device (iPhone to TV)
        startCommandPolling();

        // Send state updates periodically
        startStateUpdates();

        console.log('Plexd remote control listener initialized');
    }

    /**
     * Poll for commands from remote devices (HTTP API + localStorage fallback)
     */
    function startCommandPolling() {
        // HTTP API polling for cross-device (iPhone to MBP)
        commandPollInterval = setInterval(async () => {
            try {
                const res = await fetch('/api/remote/command');
                if (res.ok) {
                    const cmd = await res.json();
                    if (cmd && cmd.action) {
                        handleRemoteCommand(cmd.action, cmd.payload);
                    }
                }
            } catch (e) {
                // API not available, fall back to localStorage
                const cmdData = localStorage.getItem(COMMAND_KEY);
                if (cmdData) {
                    try {
                        const cmd = JSON.parse(cmdData);
                        if (Date.now() - cmd.timestamp < 5000) {
                            localStorage.removeItem(COMMAND_KEY);
                            handleRemoteCommand(cmd.action, cmd.payload);
                        } else {
                            localStorage.removeItem(COMMAND_KEY);
                        }
                    } catch (err) {
                        localStorage.removeItem(COMMAND_KEY);
                    }
                }
            }
        }, 200);

        // Also listen for storage events (works across tabs on same device)
        window.addEventListener('storage', (e) => {
            if (e.key === COMMAND_KEY && e.newValue) {
                try {
                    const cmd = JSON.parse(e.newValue);
                    localStorage.removeItem(COMMAND_KEY);
                    handleRemoteCommand(cmd.action, cmd.payload);
                } catch (err) {
                    // ignore
                }
            }
        });
    }

    /**
     * Handle incoming remote commands
     */
    function handleRemoteCommand(action, payload = {}) {
        switch (action) {
            // Connection
            case 'ping':
                sendState();
                break;

            // Playback controls
            case 'togglePauseAll':
                PlexdApp.togglePauseAll();
                sendState();
                break;
            case 'toggleMuteAll':
                PlexdApp.toggleMuteAll();
                sendState();
                break;
            case 'togglePause':
                if (payload.streamId) {
                    const stream = PlexdStream.getStream(payload.streamId);
                    if (stream && stream.video) {
                        if (stream.video.paused) {
                            stream.video.play().catch(() => {});
                        } else {
                            stream.video.pause();
                        }
                    }
                }
                sendState();
                break;
            case 'toggleMute':
                if (payload.streamId) {
                    PlexdStream.toggleMute(payload.streamId);
                }
                sendState();
                break;
            case 'seek':
                if (payload.streamId && typeof payload.time === 'number') {
                    PlexdStream.seekTo(payload.streamId, payload.time);
                }
                sendState();
                break;
            case 'seekRelative':
                if (payload.streamId && typeof payload.offset === 'number') {
                    PlexdStream.seekRelative(payload.streamId, payload.offset);
                }
                sendState();
                break;

            // Selection/Navigation
            case 'selectStream':
                PlexdStream.selectStream(payload.streamId || null);
                sendState();
                break;
            case 'selectNext':
                PlexdStream.selectNextStream(payload.direction || 'right');
                sendState();
                break;

            // Fullscreen
            case 'enterFullscreen':
                if (payload.streamId) {
                    PlexdStream.enterFocusedMode(payload.streamId);
                } else {
                    PlexdStream.enterGridFullscreen();
                }
                sendState();
                break;
            case 'exitFullscreen':
                const mode = PlexdStream.getFullscreenMode();
                if (mode === 'true-focused') {
                    PlexdStream.exitFocusedMode();
                } else if (mode === 'true-grid') {
                    PlexdStream.exitTrueFullscreen();
                } else if (mode === 'browser-fill') {
                    const fs = PlexdStream.getFullscreenStream();
                    if (fs) PlexdStream.toggleFullscreen(fs.id);
                }
                sendState();
                break;
            case 'toggleGlobalFullscreen':
                PlexdApp.toggleGlobalFullscreen();
                sendState();
                break;

            // View modes
            case 'setViewMode':
                PlexdApp.setViewMode(payload.mode);
                sendState();
                break;
            case 'cycleViewMode':
                PlexdApp.cycleViewMode();
                sendState();
                break;
            case 'toggleTetrisMode':
                PlexdApp.toggleTetrisMode();
                sendState();
                break;
            case 'toggleCoverflowMode':
            case 'toggleSmartLayoutMode': // Legacy alias
                PlexdApp.toggleCoverflowMode();
                sendState();
                break;

            // Ratings
            case 'setRating':
                if (payload.streamId && typeof payload.rating === 'number') {
                    PlexdStream.setRating(payload.streamId, payload.rating);
                }
                sendState();
                break;
            case 'cycleRating':
                if (payload.streamId) {
                    PlexdStream.cycleRating(payload.streamId);
                }
                sendState();
                break;

            // Stream management
            case 'removeStream':
                if (payload.streamId) {
                    PlexdStream.removeStream(payload.streamId);
                    PlexdApp.saveCurrentStreams();
                }
                sendState();
                break;
            case 'addStream':
                if (payload.url) {
                    PlexdApp.addStream(payload.url);
                }
                sendState();
                break;

            // UI toggles
            case 'toggleHeader':
                PlexdApp.toggleHeader();
                sendState();
                break;
            case 'toggleCleanMode':
                PlexdApp.toggleCleanMode();
                sendState();
                break;
            case 'toggleAudioFocus':
                PlexdApp.toggleAudioFocus();
                sendState();
                break;

            // State request
            case 'getState':
                sendState();
                break;

            default:
                console.warn('Unknown remote command:', action);
        }
    }

    /**
     * Get current application state for remotes
     */
    function getState() {
        const streams = PlexdStream.getAllStreams().map(s => ({
            id: s.id,
            url: s.url,
            state: s.state,
            paused: s.video ? s.video.paused : true,
            muted: s.video ? s.video.muted : true,
            currentTime: s.video ? s.video.currentTime : 0,
            duration: s.video ? s.video.duration : 0,
            aspectRatio: s.aspectRatio,
            rating: PlexdStream.getRating(s.url),
            fileName: s.fileName || null
        }));

        const selected = PlexdStream.getSelectedStream();
        const fullscreenStream = PlexdStream.getFullscreenStream();

        return {
            streams,
            selectedStreamId: selected ? selected.id : null,
            fullscreenStreamId: fullscreenStream ? fullscreenStream.id : null,
            fullscreenMode: PlexdStream.getFullscreenMode(),
            viewMode: window.PlexdAppState?.viewMode || 'all',
            tetrisMode: window.PlexdAppState?.tetrisMode || false,
            headerVisible: window.PlexdAppState?.headerVisible || false,
            cleanMode: PlexdStream.isCleanMode ? PlexdStream.isCleanMode() : false,
            // `getAudioFocusMode()` returns a boolean (true = focus on).
            audioFocusMode: PlexdStream.getAudioFocusMode ? PlexdStream.getAudioFocusMode() : true,
            timestamp: Date.now()
        };
    }

    /**
     * Send current state to all remotes
     */
    function sendState() {
        const state = getState();

        // BroadcastChannel for same-browser
        if (channel) {
            channel.postMessage({
                action: 'stateUpdate',
                payload: state
            });
        }

        // HTTP API for cross-device (iPhone to MBP)
        fetch('/api/remote/state', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(state)
        }).catch(() => {
            // API not available, use localStorage fallback
            try {
                localStorage.setItem(STATE_KEY, JSON.stringify(state));
            } catch (e) {
                // localStorage might be full or unavailable
            }
        });
    }

    /**
     * Start periodic state updates
     */
    function startStateUpdates() {
        // Send state every 500ms for responsive UI
        stateUpdateInterval = setInterval(sendState, 500);

        // Also send on key events that might change state
        document.addEventListener('keydown', () => setTimeout(sendState, 50));
    }

    /**
     * Stop state updates (cleanup)
     */
    function stop() {
        if (stateUpdateInterval) {
            clearInterval(stateUpdateInterval);
        }
        if (channel) {
            channel.close();
        }
    }

    return {
        init,
        sendState,
        getState,
        stop
    };
})();

// Expose state getters for remote
window.PlexdAppState = {
    get viewMode() {
        // Access from closure - need to expose this
        return window._plexdViewMode || 'all';
    },
    get tetrisMode() {
        return window._plexdTetrisMode || false;
    },
    get coverflowMode() {
        return window._plexdCoverflowMode || false;
    },
    get smartLayoutMode() {
        // Legacy alias for coverflowMode
        return window._plexdSmartLayoutMode || false;
    },
    get headerVisible() {
        return window._plexdHeaderVisible || false;
    }
};

// Initialize remote listener when app is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', PlexdRemote.init);
} else {
    PlexdRemote.init();
}

window.PlexdRemote = PlexdRemote;
