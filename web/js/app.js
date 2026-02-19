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
    const DB_VERSION = 2;  // Keep at 2 - can't downgrade IndexedDB
    const STORE_NAME = 'files';
    let dbInstance = null;

    // ========================================
    // Persistent Video Folder Handle
    // ========================================

    const FOLDER_DB_NAME = 'PlexdVideoFolder';
    const FOLDER_STORE_NAME = 'handle';
    let folderDbInstance = null;
    let cachedFolderHandle = null;

    async function openFolderDb() {
        if (folderDbInstance) return folderDbInstance;
        return new Promise((resolve, reject) => {
            const request = indexedDB.open(FOLDER_DB_NAME, 1);
            request.onerror = () => reject(request.error);
            request.onsuccess = () => {
                folderDbInstance = request.result;
                resolve(folderDbInstance);
            };
            request.onupgradeneeded = (event) => {
                const db = event.target.result;
                if (!db.objectStoreNames.contains(FOLDER_STORE_NAME)) {
                    db.createObjectStore(FOLDER_STORE_NAME);
                }
            };
        });
    }

    async function saveVideoFolderHandle(handle) {
        const db = await openFolderDb();
        return new Promise((resolve, reject) => {
            const tx = db.transaction(FOLDER_STORE_NAME, 'readwrite');
            const store = tx.objectStore(FOLDER_STORE_NAME);
            const request = store.put(handle, 'videoFolder');
            request.onsuccess = () => {
                cachedFolderHandle = handle;
                console.log('[Plexd] Video folder saved:', handle.name);
                resolve();
            };
            request.onerror = () => reject(request.error);
        });
    }

    async function getVideoFolderHandle() {
        if (cachedFolderHandle) return cachedFolderHandle;
        try {
            const db = await openFolderDb();
            return new Promise((resolve) => {
                const tx = db.transaction(FOLDER_STORE_NAME, 'readonly');
                const store = tx.objectStore(FOLDER_STORE_NAME);
                const request = store.get('videoFolder');
                request.onsuccess = () => {
                    cachedFolderHandle = request.result || null;
                    resolve(cachedFolderHandle);
                };
                request.onerror = () => resolve(null);
            });
        } catch (e) {
            return null;
        }
    }

    async function requestFolderPermission(handle) {
        if (!handle) return false;
        try {
            const permission = await handle.requestPermission({ mode: 'read' });
            return permission === 'granted';
        } catch (e) {
            console.log('[Plexd] Folder permission denied or handle invalid');
            return false;
        }
    }

    // ========================================
    // Video File Detection
    // ========================================

    const VIDEO_EXTENSIONS = ['.mov', '.mp4', '.m4v', '.webm', '.mkv', '.avi', '.ogv', '.3gp', '.flv', '.mpeg', '.mpg', '.ts', '.mts', '.m2ts', '.wmv', '.asf', '.rm', '.rmvb', '.vob', '.divx', '.f4v'];

    function isVideoFile(file) {
        // Check MIME type - if it starts with 'video/', it's a video
        if (file.type && file.type.startsWith('video/')) {
            return true;
        }
        // Also accept application/x-mpegURL (HLS) and application/octet-stream for some video files
        if (file.type === 'application/x-mpegURL' || file.type === 'application/vnd.apple.mpegurl') {
            return true;
        }
        // Fallback to extension check
        const name = file.name.toLowerCase();
        return VIDEO_EXTENSIONS.some(ext => name.endsWith(ext));
    }

    /**
     * Open or create the IndexedDB database
     */
    function openDatabase() {
        return new Promise((resolve, reject) => {
            let settled = false;
            const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

            // Timeout - don't wait more than 2 seconds for IndexedDB
            const timeoutId = setTimeout(() => {
                console.warn('[Plexd] IndexedDB open timeout');
                dbInstance = null;
                settle(reject, new Error('Database open timeout'));
            }, 2000);

            // Check if cached instance is still valid
            if (dbInstance) {
                try {
                    // Test if connection is still valid by checking objectStoreNames
                    if (dbInstance.objectStoreNames.contains(STORE_NAME)) {
                        clearTimeout(timeoutId);
                        settle(resolve, dbInstance);
                        return;
                    }
                } catch (e) {
                    // Connection is closed/invalid, clear cache
                    dbInstance = null;
                }
            }

            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = () => {
                clearTimeout(timeoutId);
                console.error('[Plexd] IndexedDB error:', request.error);
                settle(reject, request.error);
            };

            request.onsuccess = () => {
                clearTimeout(timeoutId);
                dbInstance = request.result;
                // Handle connection closing unexpectedly
                dbInstance.onclose = () => { dbInstance = null; };
                dbInstance.onerror = () => { dbInstance = null; };
                settle(resolve, dbInstance);
            };

            request.onblocked = () => {
                clearTimeout(timeoutId);
                console.warn('[Plexd] IndexedDB blocked - close other tabs');
                dbInstance = null;
                settle(reject, new Error('Database blocked'));
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
     * @returns {Promise<{url: string, fileName: string, blob: Blob}|null>}
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
                // Return blob for server upload (remote playback)
                return { url, fileName: data.fileName, blob: data.blob };
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
     * Get all stored files from IndexedDB
     * @returns {Promise<Array<{id: string, setName: string, fileName: string, size: number, savedAt: number}>>}
     */
    async function getAllStoredFiles() {
        try {
            const db = await openDatabase();

            // Fast path: just get keys, never read blob data
            const tx = db.transaction(STORE_NAME, 'readonly');
            const store = tx.objectStore(STORE_NAME);
            const keys = await new Promise((resolve, reject) => {
                let settled = false;
                const settle = (fn, val) => { if (!settled) { settled = true; fn(val); } };

                // Timeout for the transaction itself
                const timeoutId = setTimeout(() => {
                    console.warn('[Plexd] getAllKeys timeout');
                    settle(resolve, []);
                }, 2000);

                const request = store.getAllKeys();
                request.onsuccess = () => {
                    clearTimeout(timeoutId);
                    settle(resolve, request.result || []);
                };
                request.onerror = () => {
                    clearTimeout(timeoutId);
                    settle(reject, request.error);
                };
            });

            // Parse keys to extract metadata (key format: "setName::fileName")
            return keys.map(key => {
                const parts = key.split('::');
                return {
                    id: key,
                    setName: parts[0] || 'Unknown',
                    fileName: parts[1] || key,
                    size: 0,
                    savedAt: 0
                };
            });
        } catch (err) {
            console.error('[Plexd] Failed to get all stored files:', err);
            return [];
        }
    }

    /**
     * Delete a specific stored file by ID
     * @param {string} fileId - The file ID (setName::fileName)
     */
    async function deleteStoredFile(fileId) {
        try {
            const db = await openDatabase();
            const tx = db.transaction(STORE_NAME, 'readwrite');
            const store = tx.objectStore(STORE_NAME);

            await new Promise((resolve, reject) => {
                const request = store.delete(fileId);
                request.onsuccess = () => resolve();
                request.onerror = () => reject(request.error);
            });

            console.log(`[Plexd] Deleted stored file: ${fileId}`);
            return true;
        } catch (err) {
            console.error('[Plexd] Failed to delete stored file:', err);
            return false;
        }
    }

    // ========================================
    // Server File Upload for Remote Playback
    // ========================================

    // Track active transcoding polls: { fileId: { stream, intervalId } }
    const transcodingPolls = {};
    const TRANSCODE_POLL_INTERVAL_MS = 5000; // Poll server for transcode status
    const COMMAND_FRESHNESS_MS = 5000; // Max age for remote commands

    /**
     * Poll for HLS transcoding completion and update stream URL when ready
     * @param {string} fileId - Server file ID
     * @param {object} stream - Stream object to update
     * @param {string} fileName - File name for logging
     */
    function pollTranscodeStatus(fileId, stream, fileName) {
        if (transcodingPolls[fileId]) return; // Already polling

        const intervalId = setInterval(async () => {
            try {
                const res = await fetch(`/api/files/transcode-status?fileId=${fileId}`);
                if (!res.ok) return;

                const status = await res.json();

                if (status.status === 'complete' && status.hlsUrl) {
                    // Transcoding done - update stream URL to HLS
                    stream.serverUrl = status.hlsUrl;
                    console.log(`[Plexd] HLS ready for ${fileName}: ${status.hlsUrl}`);
                    showMessage(`HLS ready: ${fileName}`, 'success');

                    // Stop polling
                    clearInterval(intervalId);
                    delete transcodingPolls[fileId];
                } else if (status.status === 'failed') {
                    console.error(`[Plexd] HLS transcode failed: ${fileName}`);
                    clearInterval(intervalId);
                    delete transcodingPolls[fileId];
                } else if (status.progress > 0) {
                    console.log(`[Plexd] Transcoding ${fileName}: ${status.progress}%`);
                }
            } catch (err) {
                // Silently retry
            }
        }, TRANSCODE_POLL_INTERVAL_MS);

        transcodingPolls[fileId] = { stream, intervalId };
    }

    /**
     * Stop polling for a specific stream (called when stream is removed)
     * @param {object} stream - Stream object being removed
     */
    function stopTranscodePollForStream(stream) {
        // Find and clear any polling interval for this stream
        for (const [fileId, poll] of Object.entries(transcodingPolls)) {
            if (poll.stream === stream || poll.stream?.id === stream?.id) {
                clearInterval(poll.intervalId);
                delete transcodingPolls[fileId];
                console.log(`[Plexd] Stopped transcode polling for removed stream`);
                break;
            }
        }
    }

    /**
     * Upload a file to the server for cross-device playback
     * Checks if file already exists (by name and size) before uploading
     * Server returns HLS URL if already transcoded, or starts transcoding in background
     * @param {File|Blob} fileObj - The file to upload
     * @param {string} fileName - Original filename
     * @returns {Promise<{fileId: string, url: string, transcoding?: boolean}|null>}
     */
    async function uploadFileToServer(fileObj, fileName) {
        try {
            // Check if file already exists on server (may have HLS version)
            const existingFiles = await getServerFileList();
            const fileSize = fileObj.size;
            const existing = existingFiles.find(f =>
                (f.fileName === fileName || f.originalFileName === fileName) &&
                (f.size === fileSize || f.originalSize === fileSize)
            );

            if (existing) {
                // Prefer HLS URL if available
                const url = existing.hlsReady ? existing.hlsUrl : existing.url;
                const status = existing.hlsReady ? ' (HLS)' : (existing.transcoding ? ' (transcoding)' : '');
                console.log(`[Plexd] File already on server: ${fileName} -> ${url}${status}`);
                return {
                    fileId: existing.fileId,
                    url,
                    hlsReady: existing.hlsReady || false,
                    transcoding: existing.transcoding || false
                };
            }

            // Upload new file
            const response = await fetch('/api/files/upload', {
                method: 'POST',
                headers: {
                    'Content-Type': fileObj.type || 'application/octet-stream',
                    'X-File-Name': encodeURIComponent(fileName)
                },
                body: fileObj
            });

            if (!response.ok) {
                console.error('[Plexd] File upload failed:', response.status);
                return null;
            }

            const result = await response.json();

            // Server may return existing HLS if it matched by name+size
            if (result.existing && result.hlsReady) {
                console.log(`[Plexd] Server has HLS: ${fileName} -> ${result.hlsUrl}`);
                return { fileId: result.fileId, url: result.hlsUrl, hlsReady: true };
            }

            console.log(`[Plexd] Uploaded ${fileName} -> ${result.url}${result.transcoding ? ' (transcoding)' : ''}`);
            return {
                fileId: result.fileId,
                url: result.url,
                transcoding: result.transcoding || false
            };
        } catch (err) {
            console.error('[Plexd] File upload error:', err);
            return null;
        }
    }

    /**
     * Associate uploaded files with a saved set (prevents auto-delete)
     * @param {string[]} fileIds - Array of file IDs
     * @param {string} setName - Name of the saved set
     */
    async function associateFilesWithSet(fileIds, setName) {
        if (!fileIds || fileIds.length === 0) return;
        try {
            await fetch('/api/files/associate', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ fileIds, setName })
            });
        } catch (err) {
            console.error('[Plexd] Failed to associate files:', err);
        }
    }

    /**
     * Purge all uploaded files from the server
     * @param {string} [setName] - Optional set name to purge only that set's files
     */
    async function purgeServerFiles(setName = null) {
        try {
            const response = await fetch('/api/files/purge', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(setName ? { setName } : {})
            });
            const result = await response.json();
            console.log(`[Plexd] Purged ${result.deleted} files from server`);
            return result.deleted;
        } catch (err) {
            console.error('[Plexd] Failed to purge files:', err);
            return 0;
        }
    }

    /**
     * Get list of all uploaded files on server
     */
    async function getServerFileList() {
        try {
            const response = await fetch('/api/files/list');
            return await response.json();
        } catch (err) {
            console.error('[Plexd] Failed to get file list:', err);
            return [];
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

    // Double-tap detection for slot keys (1-9)
    // Single tap = assign to slot, double tap = view slot
    let lastSlotKey = null;
    let lastSlotKeyTime = 0;
    let slotAssignTimeout = null;
    const DOUBLE_TAP_THRESHOLD = 300; // ms

    // Double-tap detection for Q key
    // Single Q = star/favorite, double QQ = filter to favorites
    let lastQTime = 0;
    let qTimeout = null;

    // Double-tap detection for / key
    // Single / = random seek selected, double // = random seek all
    let lastSlashTime = 0;
    let slashTimeout = null;

    // Double-tap detection for E key
    // Single e = seek back 10s, ee = seek back 60s
    let lastETime = 0;
    let eTimeout = null;

    // Double-tap detection for R key
    // Single r = seek forward 10s, rr = seek forward 60s
    let lastRTime = 0;
    let rTimeout = null;

    // Double-tap detection for X key
    // Single x = close stream, xx = remove all unstarred
    let lastXTime = 0;
    let xTimeout = null;

    // Layout modes
    // Tetris mode: Intelligent bin-packing that eliminates black bars (object-fit: cover)
    // 0 = off, 1 = row-pack (rows with varying heights), 2 = column-pack (columns with varying widths),
    // 3 = split-pack (treemap-style recursive splitting)
    let tetrisMode = 0;
    window._plexdTetrisMode = tetrisMode;

    // Wall mode: Multi-stream viewing modes for content-dense display
    // 0 = off, 1 = strips (vertical columns), 2 = crop tiles (stackable zoom), 3 = spotlight (hero + thumbs)
    let wallMode = 0;
    window._plexdWallMode = wallMode;

    // Coverflow mode: Z-depth overlapping with hover-to-front effects
    let coverflowMode = false;
    window._plexdCoverflowMode = coverflowMode;

    // Legacy alias for compatibility (maps to coverflow)
    let smartLayoutMode = false;
    window._plexdSmartLayoutMode = smartLayoutMode;

    // Header visibility (starts hidden)
    let headerVisible = false;
    window._plexdHeaderVisible = headerVisible;

    // =========================================================================
    // Theater / Advanced Mode
    // =========================================================================
    let theaterMode = true; // true = Theater (default), false = Advanced
    let theaterScene = 'casting'; // 'casting' | 'lineup' | 'stage' | 'climax' | 'encore'
    let climaxSubMode = 0; // 0=tight-wall, 1=auto-rotate, 2=collage, 3=single-focus
    let encorePreviousScene = null; // Scene to return to when exiting Encore
    let autoRotateTimer = null; // Interval timer for Climax auto-rotate
    const AUTO_ROTATE_INTERVAL = 15000; // 15 seconds between hero rotations
    let bookmarks = []; // Array of { streamId, timestamp, bookmarkedAt }
    let stageHeroId = null; // Currently promoted hero in Stage scene

    // Theater Space double-tap (random seek)
    let lastSpaceTime = 0;
    let spaceTimeout = null;

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

        // Theater mode is on by default — add class so CSS can target it
        const appEl = document.querySelector('.plexd-app');
        if (appEl) appEl.classList.add('theater-mode');

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

        // Check for autoload parameter (used by autostart script)
        handleAutoload();

        // Auto-save session state on page close and periodically
        window.addEventListener('beforeunload', saveCurrentStreams);
        setInterval(saveCurrentStreams, 30000); // Every 30s as safety net

        console.log('Plexd initialized');
    }

    /**
     * Handle autoload URL parameter for automated startup
     * Supports: ?autoload=last (load last set in list) or ?autoload=<setname>
     */
    function handleAutoload() {
        const params = new URLSearchParams(window.location.search);
        const autoload = params.get('autoload');

        if (!autoload) return;

        const combinations = getSavedCombinations();
        const names = Object.keys(combinations);

        if (names.length === 0) {
            console.log('[Plexd] Autoload: No saved sets available');
            window.plexdAutoloadResult = { success: false, error: 'No saved sets' };
            return;
        }

        let targetName;
        if (autoload === 'last') {
            // Load the last set in the list (last added)
            targetName = names[names.length - 1];
            console.log(`[Plexd] Autoload: Loading last set "${targetName}"`);
        } else {
            // Load by name
            targetName = autoload;
            if (!combinations[targetName]) {
                console.error(`[Plexd] Autoload: Set "${targetName}" not found`);
                window.plexdAutoloadResult = { success: false, error: `Set not found: ${targetName}` };
                return;
            }
            console.log(`[Plexd] Autoload: Loading set "${targetName}"`);
        }

        // Mark autoload in progress for external monitoring
        window.plexdAutoloadResult = { success: false, loading: true, setName: targetName };

        // Delay load slightly to ensure everything is initialized
        setTimeout(async () => {
            try {
                await loadStreamCombination(targetName);
                window.plexdAutoloadResult = {
                    success: true,
                    setName: targetName,
                    streamCount: PlexdStream.getAllStreams().length,
                    timestamp: Date.now()
                };
                console.log(`[Plexd] Autoload: Successfully loaded "${targetName}"`);
            } catch (err) {
                window.plexdAutoloadResult = {
                    success: false,
                    error: err.message,
                    setName: targetName
                };
                console.error('[Plexd] Autoload failed:', err);
            }
        }, 500);
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

        // isVideoFile is now defined at module level

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

                    // Add as stream - pass File object for efficient saving later
                    addStreamFromFile(objectUrl, file.name, file);
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
     * @param {string} objectUrl - Blob URL for the file
     * @param {string} fileName - Original filename
     * @param {File} [fileObj] - Original File object (for efficient saving)
     */
    function addStreamFromFile(objectUrl, fileName, fileObj = null) {
        // Check for duplicates by fileName (handles blob vs server URL for same file)
        const existing = findDuplicateStream(objectUrl, fileName);
        if (existing) {
            console.log(`[Plexd] addStreamFromFile: duplicate found for ${fileName}`);
            PlexdStream.selectStream(existing.id);
            showMessage('File already added', 'info');
            // Revoke the blob URL since we're not using it
            URL.revokeObjectURL(objectUrl);
            return;
        }

        const stream = PlexdStream.createStream(objectUrl, {
            autoplay: true,
            muted: true
        });

        // Store the filename for display and rating persistence
        stream.fileName = fileName;
        // Store original File object to avoid re-reading when saving
        if (fileObj) {
            stream.fileObj = fileObj;
        }

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

        // Upload file to server in background for remote playback
        if (fileObj) {
            uploadFileToServer(fileObj, fileName).then(result => {
                if (result) {
                    stream.serverUrl = result.url;
                    stream.serverFileId = result.fileId;
                    console.log(`[Plexd] Server URL ready for ${fileName}: ${result.url}`);

                    // Add server URL to history (blob URLs are ephemeral, server URLs persist)
                    addToHistory(result.url);

                    // If transcoding started, poll for HLS completion
                    if (result.transcoding && !result.hlsReady) {
                        pollTranscodeStatus(result.fileId, stream, fileName);
                    }
                }
            });
        }
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
     * Hides slot buttons that have no streams assigned
     */
    function updateRatingsUI() {
        const counts = PlexdStream.getAllRatingCounts();

        // Update view button badges and visibility
        for (let i = 1; i <= 9; i++) {
            const btn = document.getElementById(`view-${i}-btn`);
            const badge = document.getElementById(`rating-${i}-count`);
            const count = counts[i] || 0;

            if (badge) {
                badge.textContent = count ? count : '';
                badge.dataset.count = String(count);
            }

            // Hide button if empty and not currently active view
            if (btn) {
                const isActive = viewMode === i;
                btn.style.display = (count > 0 || isActive) ? '' : 'none';
            }
        }

        // Update current view button active state
        updateViewButtons();

        // Update filter indicator count (in case rating changed affects count)
        updateFilterIndicator();
    }

    /**
     * Update favorites UI elements
     * Hides favorites button when no favorites exist
     */
    function updateFavoritesUI() {
        const count = PlexdStream.getFavoriteCount();

        // Update favorites button badge and visibility
        const btn = document.getElementById('view-favorites-btn');
        const badge = document.getElementById('favorites-count');

        if (badge) {
            badge.textContent = count ? count : '';
            badge.dataset.count = String(count);
        }

        // Hide button if empty and not currently active view
        if (btn) {
            const isActive = viewMode === 'favorites';
            btn.style.display = (count > 0 || isActive) ? '' : 'none';
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
        let savedStreams;
        try {
            savedStreams = JSON.parse(localStorage.getItem('plexd_streams') || '[]');
        } catch (e) {
            console.warn('[Plexd] Failed to parse saved streams, starting fresh:', e);
            savedStreams = [];
        }
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
        // Avoid duplicates - check by URL, fileName, and server fileId
        const existing = findDuplicateStream(url);
        if (existing) {
            console.log(`[Plexd] addStreamSilent: duplicate, selecting existing stream`);
            PlexdStream.selectStream(existing.id);
            return;
        }

        console.log(`[Plexd] addStreamSilent: creating stream for ${url.substring(0, 60)}...`);
        const stream = PlexdStream.createStream(url, {
            autoplay: true,
            muted: true
        });
        if (!stream) {
            console.error(`[Plexd] addStreamSilent: createStream returned null/undefined`);
            return;
        }
        if (!containerEl) {
            console.error(`[Plexd] addStreamSilent: containerEl is null!`);
            return;
        }
        containerEl.appendChild(stream.wrapper);
        console.log(`[Plexd] addStreamSilent: stream appended, total now: ${PlexdStream.getAllStreams().length}`);
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

        // Capture-phase Escape handler for Bug Eye/Mosaic - highest priority
        document.addEventListener('keydown', (e) => {
            if (e.key !== 'Escape') return;
            if (isTypingTarget(e.target)) return;

            // Priority 1: Close Bug Eye
            if (bugEyeMode) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                toggleBugEyeMode(true);
                return;
            }

            // Priority 2: Close Mosaic
            if (mosaicMode) {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                toggleMosaicMode(true);
                return;
            }
        }, true); // Capture phase

        // F key for true fullscreen - toggles true fullscreen (hides browser chrome)
        document.addEventListener('keydown', (e) => {
            if (isTypingTarget(e.target)) return;

            if (e.key === 'f' || e.key === 'F') {
                // If Sets panel is open, F opens files modal (handled by handleSetsPanelKeyboard)
                const setsPanel = document.getElementById('saved-panel');
                if (setsPanel && setsPanel.classList.contains('plexd-panel-open')) {
                    return; // Let handleSetsPanelKeyboard handle it
                }

                e.preventDefault();
                const mode = PlexdStream.getFullscreenMode();
                console.log(`[Plexd] F key pressed, current mode=${mode}`);

                // F toggles true fullscreen
                if (mode === 'true-grid' || mode === 'true-focused') {
                    // Exit true fullscreen completely
                    console.log('[Plexd] F key: exiting true fullscreen');
                    PlexdStream.exitTrueFullscreen();
                } else if (mode === 'browser-fill') {
                    // Already focused on a stream - upgrade to true fullscreen while keeping focus
                    const focusedStream = PlexdStream.getFullscreenStream();
                    console.log(`[Plexd] F key: browser-fill mode, focusedStream=${focusedStream ? focusedStream.id : 'null'}`);
                    if (focusedStream) {
                        console.log('[Plexd] F key: calling enterTrueFocusedFullscreen');
                        PlexdStream.enterTrueFocusedFullscreen(focusedStream.id);
                    } else {
                        console.log('[Plexd] F key: no focused stream, calling enterGridFullscreen');
                        PlexdStream.enterGridFullscreen();
                    }
                } else {
                    // Enter true fullscreen (grid mode)
                    console.log('[Plexd] F key: mode is none, calling enterGridFullscreen');
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
        // Avoid duplicates - check by URL, fileName, and server fileId
        const existing = findDuplicateStream(url);
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

        // Auto-save session state
        saveCurrentStreams();

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
        // Also exclude individually hidden streams
        let streamsToShow = allStreams.filter(s => !s.hidden);
        if (viewMode === 'favorites') {
            streamsToShow = streamsToShow.filter(s => PlexdStream.getFavorite(s.url, s.fileName));
        } else if (viewMode !== 'all') {
            streamsToShow = streamsToShow.filter(s => PlexdStream.getRating(s.url) === viewMode);
        }

        // Handle visibility and playback of streams based on view mode AND individual hidden state
        // When filtering by rating/favorites, pause hidden streams to save bandwidth
        // Use position-preserving pause/resume to avoid streams restarting
        const isGloballyPaused = PlexdStream.isGloballyPaused();
        allStreams.forEach(stream => {
            // Individually hidden streams are always hidden regardless of view mode
            if (stream.hidden) {
                stream.wrapper.style.display = 'none';
                stream.video.pause();
                return;
            }

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
                showEmptyState('No Stars', 'Press Q on a selected stream to star it');
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
        if (wallMode === 1) {
            // Wall: Strips — vertical columns, center-cropped
            layout = PlexdGrid.calculateStripsLayout(container, streamsToShow);
        } else if (wallMode === 3) {
            // Wall: Spotlight — hero is the selected stream (or first if none selected)
            const selected = PlexdStream.getSelectedStream();
            if (selected) {
                const idx = streamsToShow.findIndex(s => s.id === selected.id);
                if (idx > 0) {
                    // Move selected to front so it becomes the hero
                    const hero = streamsToShow.splice(idx, 1)[0];
                    streamsToShow.unshift(hero);
                }
            }
            layout = PlexdGrid.calculateSpotlightLayout(container, streamsToShow);
        } else if (tetrisMode > 0) {
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

        // Wall: Crop Tiles — edge-to-edge packed wall with aggressive center zoom
        if (wallMode === 2) {
            const selectedStream = PlexdStream.getSelectedStream();
            const selectedId = selectedStream ? selectedStream.id : null;

            // If not stacked on Tetris (which already fills cells), force edge-to-edge grid
            if (tetrisMode === 0 && !coverflowMode) {
                const count = streamsToShow.length;
                if (count > 0) {
                    // Find optimal rows/cols that maximize 16:9 cell shape and fill
                    let bestRows = 1, bestCols = count, bestScore = -Infinity;
                    for (let r = 1; r <= count; r++) {
                        const c = Math.ceil(count / r);
                        if ((r * c) - count >= c) continue; // Skip layouts with entire empty row
                        const cellRatio = (container.width / c) / (container.height / r);
                        const score = (1 - Math.abs(cellRatio - 16/9) / (16/9)) * 0.6 + (count / (r * c)) * 0.4;
                        if (score > bestScore) { bestRows = r; bestCols = c; bestScore = score; }
                    }

                    const cellW = container.width / bestCols;
                    const cellH = container.height / bestRows;
                    layout.cells = streamsToShow.map((stream, i) => ({
                        streamId: stream.id,
                        x: (i % bestCols) * cellW,
                        y: Math.floor(i / bestCols) * cellH,
                        width: cellW,
                        height: cellH,
                    }));
                }
            }

            // Apply zoom and selection highlight to all cells
            layout.cells.forEach(cell => {
                cell.objectFit = 'cover';
                cell.wallCropZoom = (cell.streamId === selectedId) ? 2.2 : 1.8;
                cell.isWallCropSelected = (cell.streamId === selectedId);
            });
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
    function cycleViewMode(backward = false) {
        const currentIndex = viewModes.indexOf(viewMode);
        let nextIndex;
        if (backward) {
            nextIndex = (currentIndex - 1 + viewModes.length) % viewModes.length;
        } else {
            nextIndex = (currentIndex + 1) % viewModes.length;
        }
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

        // Turn off wall layout modes (strips/spotlight) but keep crop tiles (it stacks)
        if (wallMode === 1 || wallMode === 3) {
            wallMode = 0;
            window._plexdWallMode = 0;
            const wallBtn = document.getElementById('wall-btn');
            if (wallBtn) wallBtn.classList.remove('active');
            const app2 = document.querySelector('.plexd-app');
            if (app2) app2.classList.remove('wall-strips', 'wall-spotlight');
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

        // Turn off wall layout modes (strips/spotlight) but keep crop tiles (it stacks)
        if (wallMode === 1 || wallMode === 3) {
            wallMode = 0;
            window._plexdWallMode = 0;
            const wallBtn = document.getElementById('wall-btn');
            if (wallBtn) wallBtn.classList.remove('active');
            const app2 = document.querySelector('.plexd-app');
            if (app2) app2.classList.remove('wall-strips', 'wall-spotlight');
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

    /**
     * Wall mode names for display
     */
    const wallModeNames = ['OFF', 'Strips', 'Crop Tiles', 'Spotlight'];

    /**
     * Cycle Wall mode — multi-stream viewing modes for content-dense display
     * Off → Strips → Crop Tiles → Spotlight → Off
     *
     * Strips & Spotlight are full layouts (turn off Tetris/Coverflow).
     * Crop Tiles is a stackable modifier (works on top of current layout).
     */
    function cycleWallMode(backward = false) {
        if (backward) {
            wallMode = (wallMode - 1 + 4) % 4;
        } else {
            wallMode = (wallMode + 1) % 4;
        }
        window._plexdWallMode = wallMode;

        const app = document.querySelector('.plexd-app');
        const wallBtn = document.getElementById('wall-btn');

        // Clear all wall CSS classes
        if (app) {
            app.classList.remove('wall-strips', 'wall-crop', 'wall-spotlight');
        }

        // Strips and Spotlight are full layouts — turn off other layout modes
        if (wallMode === 1 || wallMode === 3) {
            if (tetrisMode) {
                tetrisMode = 0;
                window._plexdTetrisMode = 0;
                const tetrisBtn = document.getElementById('tetris-btn');
                if (tetrisBtn) tetrisBtn.classList.remove('active');
                if (app) {
                    app.classList.remove('tetris-mode', 'tetris-mode-1', 'tetris-mode-2', 'tetris-mode-3', 'tetris-mode-4', 'tetris-content-visible');
                }
            }
            if (coverflowMode) {
                coverflowMode = false;
                window._plexdCoverflowMode = false;
                const coverflowBtn = document.getElementById('coverflow-btn');
                if (coverflowBtn) coverflowBtn.classList.remove('active');
                if (app) {
                    app.classList.remove('coverflow-mode', 'smart-layout-mode');
                }
            }
        }

        // Apply current wall mode class
        if (app) {
            if (wallMode === 1) app.classList.add('wall-strips');
            else if (wallMode === 2) app.classList.add('wall-crop');
            else if (wallMode === 3) app.classList.add('wall-spotlight');
        }

        if (wallBtn) wallBtn.classList.toggle('active', wallMode > 0);

        updateLayout();

        // Show contextual message
        if (wallMode === 2 && (tetrisMode > 0 || coverflowMode)) {
            const base = tetrisMode > 0 ? `Tetris ${tetrisModeNames[tetrisMode]}` : 'Coverflow';
            showMessage(`Wall: Crop Tiles (on ${base})`, 'info');
        } else {
            showMessage(`Wall: ${wallModeNames[wallMode]}`, 'info');
        }
    }

    // =========================================================================
    // Face Detection Auto-Pan (Smart Zoom)
    // =========================================================================
    // Uses Chrome's FaceDetector API (hardware-accelerated on M4 via Core ML)
    // to automatically center crop on detected faces in video streams.

    let faceDetector = null;
    let faceDetectionActive = false;
    let faceDetectionTimer = null;
    const FACE_DETECT_INTERVAL = 4000; // ms between detection sweeps
    const FACE_DETECT_SMOOTHING = 0.3; // Blend factor (0=keep old, 1=snap to new)

    async function initFaceDetection() {
        if (faceDetector) return true;
        if (!('FaceDetector' in window)) {
            console.log('[Plexd] FaceDetector API not available — enable chrome://flags/#enable-experimental-web-platform-features');
            return false;
        }
        try {
            faceDetector = new FaceDetector({ maxDetectedFaces: 5, fastMode: true });
            console.log('[Plexd] FaceDetector initialized (hardware-accelerated)');
            return true;
        } catch (e) {
            console.log('[Plexd] FaceDetector init failed:', e.message);
            return false;
        }
    }

    async function detectFacesForStream(stream) {
        if (!faceDetector || !stream.video || stream.video.readyState < 2 || stream.video.paused) return;
        try {
            const faces = await faceDetector.detect(stream.video);
            if (faces.length === 0) return;

            // Find the bounding box that covers all detected faces
            let minX = Infinity, minY = Infinity, maxX = 0, maxY = 0;
            for (const face of faces) {
                const bb = face.boundingBox;
                minX = Math.min(minX, bb.x);
                minY = Math.min(minY, bb.y);
                maxX = Math.max(maxX, bb.x + bb.width);
                maxY = Math.max(maxY, bb.y + bb.height);
            }

            // Center of all faces as a percentage of video dimensions
            const vw = stream.video.videoWidth;
            const vh = stream.video.videoHeight;
            if (vw === 0 || vh === 0) return;

            const centerX = ((minX + maxX) / 2 / vw) * 100;
            const centerY = ((minY + maxY) / 2 / vh) * 100;

            // Smooth towards detected position (avoid jarring jumps)
            const current = PlexdStream.getPanPosition(stream.id);
            const newX = current.x + (centerX - current.x) * FACE_DETECT_SMOOTHING;
            const newY = current.y + (centerY - current.y) * FACE_DETECT_SMOOTHING;

            PlexdStream.setPanPosition(stream.id, { x: newX, y: newY });
        } catch (e) {
            // detect() can throw on certain frames — ignore silently
        }
    }

    async function runFaceDetectionSweep() {
        if (!faceDetectionActive || !faceDetector) return;

        const streams = PlexdStream.getAllStreams().filter(s => !s.hidden);
        // Stagger detection across frames to avoid CPU spike
        for (let i = 0; i < streams.length; i++) {
            if (!faceDetectionActive) break;
            await detectFacesForStream(streams[i]);
            // Yield between streams so UI stays responsive
            if (i < streams.length - 1) {
                await new Promise(r => setTimeout(r, 50));
            }
        }

        // Trigger layout refresh to apply new pan positions
        if (faceDetectionActive) {
            updateLayout();
        }
    }

    function startFaceDetection() {
        if (faceDetectionActive) return;
        initFaceDetection().then(ok => {
            if (!ok) {
                showMessage('Smart Zoom unavailable — enable chrome://flags/#enable-experimental-web-platform-features', 'warning');
                return;
            }
            faceDetectionActive = true;
            const btn = document.getElementById('smart-zoom-btn');
            if (btn) btn.classList.add('active');
            runFaceDetectionSweep();
            faceDetectionTimer = setInterval(runFaceDetectionSweep, FACE_DETECT_INTERVAL);
            showMessage('Smart Zoom: ON (face detection)', 'info');
        });
    }

    function stopFaceDetection() {
        if (!faceDetectionActive) return;
        faceDetectionActive = false;
        if (faceDetectionTimer) {
            clearInterval(faceDetectionTimer);
            faceDetectionTimer = null;
        }
        const btn = document.getElementById('smart-zoom-btn');
        if (btn) btn.classList.remove('active');
        showMessage('Smart Zoom: OFF', 'info');
    }

    function toggleFaceDetection() {
        if (faceDetectionActive) {
            stopFaceDetection();
        } else {
            startFaceDetection();
        }
    }

    /**
     * Rotate stream positions in the grid
     * @param {boolean} reverse - If true, rotate counterclockwise, else clockwise
     * CW: each stream moves to next position (first goes to last)
     * CCW: each stream moves to previous position (last goes to first)
     */
    function rotateStreams(reverse = false) {
        const count = PlexdStream.getStreamCount();
        if (count < 2) {
            showMessage('Need 2+ streams to rotate', 'warning');
            return;
        }

        // In focus mode, navigate to next/prev stream instead of rotating
        const fullscreenMode = PlexdStream.getFullscreenMode();
        const focusedId = PlexdStream.getFullscreenStream();
        if ((fullscreenMode === 'true-focused' || fullscreenMode === 'browser-fill') && focusedId) {
            const nextId = reverse
                ? PlexdStream.getPrevStreamId(focusedId, true)
                : PlexdStream.getNextStreamId(focusedId, true);
            if (nextId) {
                PlexdStream.enterFocusedMode(nextId);
            }
            return;
        }

        // In Spotlight or Crop Tiles mode, rotate cycles the selected stream
        // (changes which stream is hero/highlighted) instead of reordering
        if (wallMode === 2 || wallMode === 3) {
            const selected = PlexdStream.getSelectedStream();
            const allStreams = PlexdStream.getAllStreams().filter(s => !s.hidden);
            if (allStreams.length > 0) {
                const currentIdx = selected ? allStreams.findIndex(s => s.id === selected.id) : -1;
                let nextIdx;
                if (reverse) {
                    nextIdx = currentIdx <= 0 ? allStreams.length - 1 : currentIdx - 1;
                } else {
                    nextIdx = currentIdx >= allStreams.length - 1 ? 0 : currentIdx + 1;
                }
                PlexdStream.selectStream(allStreams[nextIdx].id);
                updateLayout();
            }
            return;
        }

        // Normal mode: rotate stream order
        // CW visually = first to last in array
        // CCW visually = last to first in array
        PlexdStream.rotateStreamOrder(!reverse);

        // Relayout with new order
        updateLayout();
        showMessage(`Rotated ${reverse ? 'CCW' : 'CW'}`, 'info');
    }

    /**
     * Force relayout of the grid
     */
    function forceRelayout() {
        updateLayout();
        showMessage('Layout refreshed', 'info');
    }

    // =========================================================================
    // Wall / Tetris CSS class helpers (used by Theater scene management)
    // =========================================================================

    /**
     * Sync wall-mode CSS classes on .plexd-app to match the wallMode variable.
     * Does NOT change wallMode itself — call after setting wallMode.
     */
    function updateWallModeClasses() {
        const app = document.querySelector('.plexd-app');
        const wallBtn = document.getElementById('wall-btn');
        if (app) {
            app.classList.remove('wall-strips', 'wall-crop', 'wall-spotlight');
            if (wallMode === 1) app.classList.add('wall-strips');
            else if (wallMode === 2) app.classList.add('wall-crop');
            else if (wallMode === 3) app.classList.add('wall-spotlight');
        }
        if (wallBtn) wallBtn.classList.toggle('active', wallMode > 0);
    }

    /**
     * Sync tetris-mode CSS classes on .plexd-app to match the tetrisMode variable.
     * Does NOT change tetrisMode itself — call after setting tetrisMode.
     */
    function updateTetrisModeClasses() {
        const app = document.querySelector('.plexd-app');
        const tetrisBtn = document.getElementById('tetris-btn');
        if (app) {
            app.classList.toggle('tetris-mode', tetrisMode > 0);
            app.classList.remove('tetris-mode-1', 'tetris-mode-2', 'tetris-mode-3', 'tetris-mode-4');
            if (tetrisMode > 0) {
                app.classList.add(`tetris-mode-${tetrisMode}`);
            }
            app.classList.toggle('tetris-content-visible', tetrisMode === 4);
        }
        if (tetrisBtn) tetrisBtn.classList.toggle('active', tetrisMode > 0);
    }

    // =========================================================================
    // Theater Mode — Scene Management
    // =========================================================================

    function getSceneName(scene) {
        if (scene === 'climax') {
            return 'Climax: ' + ['Tight Wall', 'Auto-Rotate', 'Collage', 'Single Focus'][climaxSubMode];
        }
        const names = { casting: 'Casting Call', lineup: 'Lineup', stage: 'Stage', encore: 'Encore' };
        return names[scene] || scene;
    }

    function setTheaterScene(scene) {
        const prev = theaterScene;
        if (prev === 'encore') closeEncoreView();
        if (prev === 'climax' && scene !== 'climax') stopAutoRotate();
        theaterScene = scene;
        applyTheaterScene();
        if (typeof updateModeIndicator === 'function') updateModeIndicator();
        showMessage(getSceneName(scene), 'info');
    }

    function nextScene() {
        const order = ['casting', 'lineup', 'stage', 'climax'];
        const idx = order.indexOf(theaterScene);
        const next = idx >= order.length - 1 ? order[0] : order[idx + 1];
        setTheaterScene(next);
    }

    function prevScene() {
        const order = ['casting', 'lineup', 'stage', 'climax'];
        const idx = order.indexOf(theaterScene);
        const prev = idx <= 0 ? order[order.length - 1] : order[idx - 1];
        setTheaterScene(prev);
    }

    function toggleTheaterAdvanced() {
        theaterMode = !theaterMode;
        const app = document.querySelector('.plexd-app');
        if (app) app.classList.toggle('theater-mode', theaterMode);

        if (theaterMode) {
            theaterScene = detectCurrentScene();
            applyTheaterScene();
        }
        if (typeof updateModeIndicator === 'function') updateModeIndicator();
        showMessage(theaterMode ? 'Theater Mode' : 'Advanced Mode', 'info');
    }

    function detectCurrentScene() {
        const mode = PlexdStream.getFullscreenMode();
        if (mode === 'true-focused' || mode === 'browser-fill') return 'stage';
        if (wallMode === 3) return 'stage'; // Spotlight = Stage
        if (viewMode === 'favorites' || (typeof viewMode === 'number' && viewMode >= 5)) return 'lineup';
        if (bugEyeMode || mosaicMode) return 'climax';
        return 'casting';
    }

    function applyTheaterScene() {
        if (coverflowMode) toggleCoverflowMode();

        switch (theaterScene) {
            case 'casting':
                setViewMode('all');
                tetrisMode = 0;
                window._plexdTetrisMode = 0;
                wallMode = 2; // Crop tiles
                window._plexdWallMode = 2;
                if (!faceDetectionActive) startFaceDetection();
                break;

            case 'lineup':
                // Show only starred/high-rated
                {
                    const favCount = PlexdStream.getFavoriteCount();
                    setViewMode(favCount > 0 ? 'favorites' : 'all');
                }
                wallMode = 0;
                window._plexdWallMode = 0;
                tetrisMode = 3; // Treemap
                window._plexdTetrisMode = 3;
                break;

            case 'stage':
                tetrisMode = 0;
                window._plexdTetrisMode = 0;
                wallMode = 3; // Spotlight
                window._plexdWallMode = 3;
                if (!stageHeroId || !PlexdStream.getStream(stageHeroId)) {
                    const streams = getFilteredStreams();
                    stageHeroId = streams.length > 0 ? streams[0].id : null;
                }
                if (stageHeroId) PlexdStream.selectStream(stageHeroId);
                break;

            case 'climax':
                applyClimaxSubMode();
                return; // applyClimaxSubMode handles its own layout

            case 'encore':
                showEncoreView();
                return; // Encore has its own rendering
        }

        updateWallModeClasses();
        updateTetrisModeClasses();
        updateLayout();
    }

    function applyClimaxSubMode() {
        stopAutoRotate();
        switch (climaxSubMode) {
            case 0: // Tight Wall
                tetrisMode = 0;
                window._plexdTetrisMode = 0;
                wallMode = 2;
                window._plexdWallMode = 2;
                break;
            case 1: // Auto-Rotate Hero
                tetrisMode = 0;
                window._plexdTetrisMode = 0;
                wallMode = 3;
                window._plexdWallMode = 3;
                startAutoRotate();
                break;
            case 2: // Collage — handled in updateLayout
                tetrisMode = 0;
                window._plexdTetrisMode = 0;
                wallMode = 0;
                window._plexdWallMode = 0;
                break;
            case 3: // Single Focus
                tetrisMode = 0;
                window._plexdTetrisMode = 0;
                wallMode = 0;
                window._plexdWallMode = 0;
                {
                    const target = PlexdStream.getSelectedStream() || getFilteredStreams()[0];
                    if (target) PlexdStream.enterFocusedMode(target.id);
                }
                return; // Fullscreen handles its own layout
        }
        updateWallModeClasses();
        updateTetrisModeClasses();
        if (typeof updateModeIndicator === 'function') updateModeIndicator();
        updateLayout();
    }

    function startAutoRotate() {
        stopAutoRotate();
        autoRotateTimer = setInterval(() => {
            if (!theaterMode || theaterScene !== 'climax' || climaxSubMode !== 1) {
                stopAutoRotate();
                return;
            }
            const streams = getFilteredStreams();
            if (streams.length < 2) return;
            const sel = PlexdStream.getSelectedStream();
            const currentIdx = sel ? streams.findIndex(s => s.id === sel.id) : -1;
            const nextIdx = (currentIdx + 1) % streams.length;
            PlexdStream.selectStream(streams[nextIdx].id);
            stageHeroId = streams[nextIdx].id;
            updateLayout();
        }, AUTO_ROTATE_INTERVAL);
    }

    function stopAutoRotate() {
        if (autoRotateTimer) {
            clearInterval(autoRotateTimer);
            autoRotateTimer = null;
        }
    }

    // Placeholder stubs for Encore (implemented in Task 11)
    function showEncoreView() {
        if (bookmarks.length === 0) {
            showMessage('No bookmarks yet — press K to bookmark moments', 'info');
            theaterScene = encorePreviousScene || 'casting';
            return;
        }
        showMessage('Encore: ' + bookmarks.length + ' bookmarks', 'info');
    }

    function closeEncoreView() {
        const overlay = document.getElementById('encore-overlay');
        if (overlay) overlay.remove();
    }

    // Bug Eye mode state
    let bugEyeMode = false;
    let bugEyeOverlay = null;
    let bugEyeAnimationFrame = null;
    let bugEyeStreamId = null; // Track which stream we're showing

    /**
     * Toggle Bug Eye mode - creates a compound eye effect
     * B key behavior: first press enables, second press exits (true toggle)
     */
    function toggleBugEyeMode(forceOff = false) {
        if (forceOff || bugEyeMode) {
            destroyBugEyeOverlay();
            showMessage('Bug Eye: OFF', 'info');
            return;
        }

        const fullscreenStream = PlexdStream.getFullscreenStream();
        const selected = PlexdStream.getSelectedStream();
        const targetStream = fullscreenStream || selected;

        if (!targetStream) {
            showMessage('Select or focus a stream first (Z key)', 'warning');
            return;
        }

        // If Mosaic mode is on, turn it off first
        if (mosaicMode) {
            destroyMosaicOverlay();
        }

        bugEyeMode = true;
        const app = document.querySelector('.plexd-app');
        if (app) app.classList.add('bugeye-mode');
        createBugEyeOverlay(targetStream);
        showMessage('Bug Eye: ON (B=off)', 'info');
    }

    /**
     * Create the bug eye overlay - efficient version with 8 random cells
     */
    function createBugEyeOverlay(stream) {
        // Clean up existing without resetting mode
        if (bugEyeAnimationFrame) {
            cancelAnimationFrame(bugEyeAnimationFrame);
            bugEyeAnimationFrame = null;
        }
        if (bugEyeOverlay) {
            bugEyeOverlay.querySelectorAll('video').forEach(v => {
                v.pause();
                v.src = '';
            });
            bugEyeOverlay.remove();
        }

        // Ensure mosaic is destroyed
        if (mosaicOverlay) {
            destroyMosaicOverlay();
        }

        const container = document.getElementById('plexd-container');
        if (!container) return;

        bugEyeStreamId = stream.id;
        const videoSource = stream.video;

        // Create overlay
        bugEyeOverlay = document.createElement('div');
        bugEyeOverlay.className = 'plexd-bugeye-overlay active';
        bugEyeOverlay.id = 'plexd-bugeye-overlay';

        // Click anywhere on overlay to close
        bugEyeOverlay.onclick = () => toggleBugEyeMode(true);

        // Handle keyboard on overlay (Escape or B to close)
        bugEyeOverlay.tabIndex = 0;
        bugEyeOverlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' || e.key === 'b' || e.key === 'B') {
                e.preventDefault();
                e.stopPropagation();
                toggleBugEyeMode(true);
            }
        });
        bugEyeOverlay.focus();

        // Close button
        const closeBtn = document.createElement('button');
        closeBtn.className = 'plexd-bugeye-close';
        closeBtn.innerHTML = '&times;';
        closeBtn.title = 'Close (B or Esc)';
        closeBtn.onclick = (e) => { e.stopPropagation(); toggleBugEyeMode(true); };
        bugEyeOverlay.appendChild(closeBtn);

        // Generate 8 random cells - efficient, visually interesting
        const cells = generateRandomCells(8);

        cells.forEach((cell, i) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'plexd-bugeye-cell';
            wrapper.style.cssText = `
                left: ${cell.x}%;
                top: ${cell.y}%;
                width: ${cell.size}%;
                transform: translate(-50%, -50%) rotate(${cell.rotate}deg);
                opacity: ${cell.opacity};
                z-index: ${10 - i};
                animation-delay: ${i * 0.05}s;
            `;

            const video = document.createElement('video');
            video.src = videoSource.src;
            video.currentTime = videoSource.currentTime;
            video.muted = true;
            video.loop = true;
            video.playsInline = true;
            video.play().catch(() => {});

            wrapper.appendChild(video);
            bugEyeOverlay.appendChild(wrapper);
        });

        container.appendChild(bugEyeOverlay);

        // Efficient sync - only runs every 500ms, not every frame
        let lastSync = 0;
        function syncVideos(timestamp) {
            if (!bugEyeMode || !bugEyeOverlay) return;

            // Sync every 500ms instead of every frame
            if (timestamp - lastSync > 500) {
                lastSync = timestamp;
                const clones = bugEyeOverlay.querySelectorAll('video');
                const mainTime = videoSource.currentTime;
                const isPaused = videoSource.paused;

                clones.forEach(clone => {
                    if (Math.abs(clone.currentTime - mainTime) > 1) {
                        clone.currentTime = mainTime;
                    }
                    if (isPaused && !clone.paused) clone.pause();
                    else if (!isPaused && clone.paused) clone.play().catch(() => {});
                });
            }
            bugEyeAnimationFrame = requestAnimationFrame(syncVideos);
        }
        bugEyeAnimationFrame = requestAnimationFrame(syncVideos);
    }

    /**
     * Generate random cell positions for bug eye effect
     */
    function generateRandomCells(count) {
        const cells = [];
        const centerX = 50;
        const centerY = 50;

        // Place copies in a ring around center, with some randomness
        for (let i = 0; i < count; i++) {
            // Distribute around center in a ring pattern
            const angle = (i / count) * 2 * Math.PI + (Math.random() - 0.5) * 0.5;
            const radius = 25 + Math.random() * 20; // 25-45% from center

            cells.push({
                x: centerX + Math.cos(angle) * radius,
                y: centerY + Math.sin(angle) * radius,
                size: 18 + Math.random() * 15, // 18-33%
                rotate: -10 + Math.random() * 20, // -10 to +10 degrees
                opacity: 0.65 + Math.random() * 0.3 // 0.65-0.95
            });
        }
        return cells;
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
            bugEyeOverlay.querySelectorAll('video').forEach(v => {
                v.pause();
                v.src = '';
            });
            bugEyeOverlay.remove();
            bugEyeOverlay = null;
        }
        const app = document.querySelector('.plexd-app');
        if (app) app.classList.remove('bugeye-mode');
        bugEyeMode = false;
        bugEyeStreamId = null;
    }

    /**
     * Update bug eye or mosaic if stream changes
     */
    function updateBugEyeIfNeeded() {
        const fullscreenStream = PlexdStream.getFullscreenStream();
        const selected = PlexdStream.getSelectedStream();
        const targetStream = fullscreenStream || selected;
        if (!targetStream) return;

        // Update Bug Eye if active
        if (bugEyeMode && targetStream.id !== bugEyeStreamId) {
            createBugEyeOverlay(targetStream);
        }

        // Update Mosaic if active
        if (mosaicMode && targetStream.id !== mosaicStreamId) {
            destroyMosaicOverlay();
            mosaicMode = true; // Keep mode on after destroy resets it
            const app = document.querySelector('.plexd-app');
            if (app) app.classList.add('mosaic-mode');
            createMosaicOverlay(targetStream);
        }
    }

    // Mosaic mode state (simpler version with fewer, non-overlapping copies)
    let mosaicMode = false;
    let mosaicOverlay = null;
    let mosaicAnimationFrame = null;
    let mosaicPausedStreams = []; // Track streams we paused for power efficiency
    let mosaicStreamId = null; // Track which stream is shown in mosaic

    /**
     * Toggle Mosaic mode - simpler effect with a few non-overlapping video copies
     * @param {boolean} forceOff - If true, always turns mosaic off
     */
    function toggleMosaicMode(forceOff = false) {
        // If forcing off or already on, turn off
        if (forceOff || mosaicMode) {
            const app = document.querySelector('.plexd-app');
            if (app) app.classList.remove('mosaic-mode');
            destroyMosaicOverlay();
            showMessage('Mosaic: OFF', 'info');
            return;
        }

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

        mosaicMode = true;
        const app = document.querySelector('.plexd-app');
        if (app) app.classList.add('mosaic-mode');
        createMosaicOverlay(targetStream);
        showMessage('Mosaic: ON (Esc to exit)', 'info');
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

        mosaicStreamId = stream.id; // Track which stream is shown

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
                if (s.wrapper) {
                    const overlay = document.createElement('div');
                    overlay.className = 'plexd-mosaic-dimmer';
                    overlay.style.cssText = `
                        position: absolute;
                        inset: 0;
                        background: rgba(0, 0, 0, 0.7);
                        z-index: 40;
                        pointer-events: none;
                    `;
                    s.wrapper.appendChild(overlay);
                }
            }
        });

        // Create overlay container
        mosaicOverlay = document.createElement('div');
        mosaicOverlay.className = 'plexd-mosaic-overlay';
        mosaicOverlay.id = 'plexd-mosaic-overlay';

        // Click anywhere on overlay to close
        mosaicOverlay.onclick = () => toggleMosaicMode(true);

        // Handle keyboard on overlay (Escape or Shift+B to close)
        mosaicOverlay.tabIndex = 0;
        mosaicOverlay.addEventListener('keydown', (e) => {
            if (e.key === 'Escape' || ((e.key === 'b' || e.key === 'B') && e.shiftKey)) {
                e.preventDefault();
                e.stopPropagation();
                toggleMosaicMode(true);
            }
        });
        mosaicOverlay.focus();

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
            if (s.wrapper) {
                const dimmer = s.wrapper.querySelector('.plexd-mosaic-dimmer');
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
        mosaicStreamId = null;
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
        // Log all key events to debug fullscreen navigation
        if (e.key.startsWith('Arrow')) {
            console.log(`[Plexd] handleKeyboard: received ${e.key}, target=${e.target.tagName}, activeElement=${document.activeElement?.tagName || 'null'}, className=${document.activeElement?.className || 'null'}`);
        }

        // If a modal is open, avoid accidental destructive/global shortcuts.
        // Let modal-specific handlers deal with Escape/etc.
        if (document.querySelector('.plexd-modal-overlay') && e.key !== 'Escape') {
            return;
        }

        // Ignore only when typing into text-entry controls (not sliders/buttons).
        if (isTypingTarget(e.target)) return;

        // Let browser handle Cmd/Ctrl shortcuts (refresh, new tab, etc.)
        // Exception: Ctrl/Cmd+S is intentionally overridden for save
        if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() !== 's') return;

        // Handle Sets panel keyboard navigation first
        if (handleSetsPanelKeyboard(e)) return;

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
                {
                    const targetStream = fullscreenStream || selected;
                    if (targetStream) {
                        const isMuted = targetStream.video.muted;
                        if (isMuted) {
                            // Unmuting: enable audio focus so audio follows navigation
                            PlexdStream.toggleMute(targetStream.id);
                            if (!PlexdStream.getAudioFocusMode()) {
                                PlexdStream.toggleAudioFocus();
                                updateAudioFocusButton(true);
                            }
                            // Mute all others when enabling audio follow
                            PlexdStream.muteAllExcept(targetStream.id);
                            showMessage('Audio ON \u2014 follows selection', 'info');
                        } else {
                            // Muting: disable audio focus
                            PlexdStream.toggleMute(targetStream.id);
                            if (PlexdStream.getAudioFocusMode()) {
                                PlexdStream.toggleAudioFocus();
                                updateAudioFocusButton(false);
                            }
                            showMessage('Audio OFF', 'info');
                        }
                    }
                }
                break;
            case 'n':
            case 'N':
                {
                    PlexdStream.muteAll();
                    if (PlexdStream.getAudioFocusMode()) {
                        PlexdStream.toggleAudioFocus();
                    }
                    updateAudioFocusButton(false);
                    showMessage('All audio OFF', 'info');
                }
                break;
            case 'i':
            case 'I':
                const showInfo = PlexdStream.toggleAllStreamInfo();
                showMessage(`Stream info: ${showInfo ? 'ON' : 'OFF'}`, 'info');
                break;
            case '`':
                // ` (backtick): View favorites (filter to favorites)
                e.preventDefault();
                {
                    const fullscreenMode = PlexdStream.getFullscreenMode();
                    if (fullscreenMode === 'true-focused' || fullscreenMode === 'browser-fill') {
                        PlexdStream.exitFocusedMode();
                    }
                    const count = PlexdStream.getFavoriteCount();
                    setViewMode('favorites');
                    if (count === 0) {
                        showMessage('No favorites yet. Press Q to star streams.', 'info');
                    }
                }
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
                handleArrowNav('right', fullscreenStream, selected);
                updateBugEyeIfNeeded();
                break;
            case 'ArrowLeft':
                e.preventDefault();
                handleArrowNav('left', fullscreenStream, selected);
                updateBugEyeIfNeeded();
                break;
            case 'ArrowUp':
                e.preventDefault();
                handleArrowNav('up', fullscreenStream, selected);
                updateBugEyeIfNeeded();
                break;
            case 'ArrowDown':
                e.preventDefault();
                handleArrowNav('down', fullscreenStream, selected);
                updateBugEyeIfNeeded();
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
            case ';':
                // Frame back (pauses video, steps back ~1 frame)
                e.preventDefault();
                {
                    const targetStream = fullscreenStream || selected;
                    if (targetStream?.video) {
                        targetStream.video.pause();
                        targetStream.video.currentTime = Math.max(0, targetStream.video.currentTime - (1/30));
                        syncOverlayClones();
                    }
                }
                break;
            case "'":
                // Frame forward (pauses video, steps forward ~1 frame)
                e.preventDefault();
                {
                    const targetStream = fullscreenStream || selected;
                    if (targetStream?.video) {
                        targetStream.video.pause();
                        targetStream.video.currentTime += (1/30);
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
            case 'd':
            case 'D':
                // D toggles saved sets panel
                e.preventDefault();
                togglePanel('saved-panel');
                break;
            case '=':
                // = removes duplicate streams (make them equal/unique)
                e.preventDefault();
                removeDuplicateStreams();
                break;
            case 'Escape':
                // Escape priority: Bug Eye > Mosaic > Wall > Fullscreen modes
                // Note: capture-phase handler should catch these first
                if (bugEyeMode) {
                    toggleBugEyeMode(true);
                    break;
                }
                if (mosaicMode) {
                    toggleMosaicMode(true);
                    break;
                }
                if (wallMode > 0) {
                    // Reset wall mode to off
                    wallMode = 0;
                    window._plexdWallMode = 0;
                    const wallBtn = document.getElementById('wall-btn');
                    if (wallBtn) wallBtn.classList.remove('active');
                    const appEl = document.querySelector('.plexd-app');
                    if (appEl) appEl.classList.remove('wall-strips', 'wall-crop', 'wall-spotlight');
                    updateLayout();
                    showMessage('Wall: OFF', 'info');
                    break;
                }
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
                // T = Cycle Tetris mode, Shift+T = Reset all pan positions to center
                if (e.shiftKey) {
                    PlexdStream.resetAllPanPositions();
                    showMessage('Pan positions reset to center', 'info');
                } else {
                    cycleTetrisMode();
                }
                break;
            case 'o':
            case 'O':
                // Toggle Coverflow mode (Z-depth overlapping with hover effects)
                toggleCoverflowMode();
                break;
            case 'w':
            case 'W':
                // W = Cycle Wall mode (Strips → Crop Tiles → Spotlight → Off)
                // Shift+W = Cycle backward
                cycleWallMode(e.shiftKey);
                break;
            case 'a':
            case 'A':
                // A = Toggle Smart Zoom (face detection auto-pan)
                toggleFaceDetection();
                break;
            case '[':
                // [ = Rotate CCW
                rotateStreams(true);
                break;
            case ']':
                // ] = Rotate CW
                rotateStreams(false);
                break;
            case '{':
            case '}':
                // { or } = Shuffle randomly
                PlexdStream.shuffleStreamOrder();
                updateLayout();
                showMessage('Shuffled', 'info');
                break;
            case 'b':
            case 'B':
                // B = Bug Eye mode (compound vision), Shift+B = Mosaic mode (cleaner)
                console.log('[Plexd] B key: shiftKey=' + e.shiftKey + ', mosaicMode=' + mosaicMode + ', bugEyeMode=' + bugEyeMode);
                if (e.shiftKey) {
                    toggleMosaicMode();
                } else {
                    toggleBugEyeMode();
                }
                break;
            case 'h':
            case 'H':
                // H = toggle header toolbar, Shift+H = toggle per-stream controls (clean mode)
                if (e.shiftKey) {
                    toggleCleanMode();
                    showMessage(`Per-stream controls: ${PlexdStream.isCleanMode() ? 'hidden' : 'visible'}`, 'info');
                } else {
                    toggleHeader();
                }
                break;
            case 'v':
            case 'V':
                // Cycle view mode (all -> 1★ -> 2★ -> ... -> all)
                // Shift+V cycles backward
                // If in focus mode, exit first to show filtered grid
                if (PlexdStream.getFullscreenMode() !== 'none') {
                    PlexdStream.exitFocusedMode();
                }
                cycleViewMode(e.shiftKey);
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
            case 'q':
            case 'Q':
                // Q = Star/favorite, QQ = filter to favorites
                e.preventDefault();
                {
                    const now = Date.now();
                    if ((now - lastQTime) < DOUBLE_TAP_THRESHOLD) {
                        if (qTimeout) { clearTimeout(qTimeout); qTimeout = null; }
                        lastQTime = 0;
                        const fullscreenMode = PlexdStream.getFullscreenMode();
                        if (fullscreenMode === 'true-focused' || fullscreenMode === 'browser-fill') {
                            PlexdStream.exitFocusedMode();
                        }
                        const count = PlexdStream.getFavoriteCount();
                        setViewMode('favorites');
                        if (count === 0) {
                            showMessage('No favorites yet — press Q to star streams', 'info');
                        }
                    } else {
                        lastQTime = now;
                        if (qTimeout) clearTimeout(qTimeout);
                        const targetStream = fullscreenStream || selected;
                        qTimeout = setTimeout(() => {
                            qTimeout = null;
                            if (targetStream) {
                                const isFav = PlexdStream.toggleFavorite(targetStream.id);
                                showMessage(isFav ? 'Starred ★' : 'Unstarred', isFav ? 'success' : 'info');
                            } else {
                                showMessage('Select a stream first', 'warning');
                            }
                        }, DOUBLE_TAP_THRESHOLD);
                    }
                }
                break;
            case 'e':
                // e = Seek back 10s, ee = Seek back 60s
                e.preventDefault();
                {
                    const now = Date.now();
                    if ((now - lastETime) < DOUBLE_TAP_THRESHOLD) {
                        if (eTimeout) { clearTimeout(eTimeout); eTimeout = null; }
                        lastETime = 0;
                        const ts = fullscreenStream || selected;
                        if (ts) PlexdStream.seekRelative(ts.id, -60);
                        syncOverlayClones();
                    } else {
                        lastETime = now;
                        if (eTimeout) clearTimeout(eTimeout);
                        const ts = fullscreenStream || selected;
                        eTimeout = setTimeout(() => {
                            eTimeout = null;
                            if (ts) PlexdStream.seekRelative(ts.id, -10);
                            syncOverlayClones();
                        }, DOUBLE_TAP_THRESHOLD);
                    }
                }
                break;
            case 'r':
            case 'R':
                if (e.shiftKey) {
                    // Shift+R = Reload stream (moved from plain R)
                    const ts = fullscreenStream || selected || getCoverflowSelectedStream();
                    if (ts) {
                        PlexdStream.reloadStream(ts.id);
                        showMessage('Reloading stream...', 'info');
                    } else {
                        showMessage('Select a stream first', 'info');
                    }
                    break;
                }
                // r = Seek forward 10s, rr = Seek forward 60s
                e.preventDefault();
                {
                    const now = Date.now();
                    if ((now - lastRTime) < DOUBLE_TAP_THRESHOLD) {
                        if (rTimeout) { clearTimeout(rTimeout); rTimeout = null; }
                        lastRTime = 0;
                        const ts = fullscreenStream || selected;
                        if (ts) PlexdStream.seekRelative(ts.id, 60);
                        syncOverlayClones();
                    } else {
                        lastRTime = now;
                        if (rTimeout) clearTimeout(rTimeout);
                        const ts = fullscreenStream || selected;
                        rTimeout = setTimeout(() => {
                            rTimeout = null;
                            if (ts) PlexdStream.seekRelative(ts.id, 10);
                            syncOverlayClones();
                        }, DOUBLE_TAP_THRESHOLD);
                    }
                }
                break;
            case 'x':
            case 'X':
                // x = Close stream, xx = Remove all unstarred streams
                {
                    const now = Date.now();
                    if ((now - lastXTime) < DOUBLE_TAP_THRESHOLD) {
                        // XX: Remove all unstarred streams
                        if (xTimeout) { clearTimeout(xTimeout); xTimeout = null; }
                        lastXTime = 0;
                        const allStreams = PlexdStream.getAllStreams();
                        const unstarred = allStreams.filter(s => !PlexdStream.isFavorite(s.id));
                        if (unstarred.length === 0) {
                            showMessage('All streams are starred', 'info');
                        } else {
                            unstarred.forEach(s => PlexdStream.removeStream(s.id));
                            updateStreamCount();
                            saveCurrentStreams();
                            showMessage('Removed ' + unstarred.length + ' unstarred streams', 'info');
                        }
                    } else {
                        lastXTime = now;
                        if (xTimeout) clearTimeout(xTimeout);
                        const targetStream = fullscreenStream || selected || getCoverflowSelectedStream();
                        xTimeout = setTimeout(() => {
                            xTimeout = null;
                            if (targetStream) {
                                if (fullscreenStream) {
                                    const nextStreamId = PlexdStream.getNextStreamId(targetStream.id);
                                    PlexdStream.removeStream(targetStream.id);
                                    if (nextStreamId) {
                                        PlexdStream.enterFocusedMode(nextStreamId);
                                    } else {
                                        PlexdStream.exitFocusedMode();
                                    }
                                } else {
                                    PlexdStream.removeStreamAndFocusNext(targetStream.id);
                                }
                                updateStreamCount();
                                saveCurrentStreams();
                                showMessage('Stream closed', 'info');
                            } else {
                                showMessage('Select a stream first', 'info');
                            }
                        }, DOUBLE_TAP_THRESHOLD);
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
                // Double-tap detection: single tap = assign, double tap = view slot
                // Uses timeout to delay single-tap action until we know it's not a double-tap
                if (!e.ctrlKey && !e.metaKey && !e.shiftKey) {
                    const slotNum = parseInt(e.key);
                    const now = Date.now();
                    const isDoubleTap = (lastSlotKey === e.key && (now - lastSlotKeyTime) < DOUBLE_TAP_THRESHOLD);

                    if (isDoubleTap) {
                        // Double tap: cancel pending assign and view/filter to this slot
                        if (slotAssignTimeout) {
                            clearTimeout(slotAssignTimeout);
                            slotAssignTimeout = null;
                        }
                        lastSlotKey = null;
                        lastSlotKeyTime = 0;

                        const fullscreenMode = PlexdStream.getFullscreenMode();
                        if (fullscreenMode === 'true-focused' || fullscreenMode === 'browser-fill') {
                            PlexdStream.exitFocusedMode();
                        }
                        const count = PlexdStream.getStreamsByRating(slotNum).length;
                        setViewMode(slotNum);
                        if (count === 0) {
                            showMessage(`No streams in slot ${slotNum}`, 'warning');
                        }
                    } else {
                        // First tap: schedule assign after threshold (will be cancelled if double-tap)
                        lastSlotKey = e.key;
                        lastSlotKeyTime = now;

                        // Clear any previous pending assign
                        if (slotAssignTimeout) {
                            clearTimeout(slotAssignTimeout);
                        }

                        // Capture current state for the delayed action
                        const fullscreenMode = PlexdStream.getFullscreenMode();
                        const isFocusedFullscreen = fullscreenMode === 'true-focused' || fullscreenMode === 'browser-fill';
                        const targetStream = isFocusedFullscreen
                            ? PlexdStream.getFullscreenStream()
                            : selected;

                        slotAssignTimeout = setTimeout(() => {
                            slotAssignTimeout = null;
                            if (targetStream) {
                                PlexdStream.setRating(targetStream.id, slotNum);
                                showMessage(`Slot ${slotNum}`, 'info');
                                if (isFocusedFullscreen && viewMode !== 'all' && slotNum !== viewMode) {
                                    PlexdStream.exitFocusedMode();
                                }
                            }
                        }, DOUBLE_TAP_THRESHOLD);
                    }
                }
                break;
            case 'l':
            case 'L':
                // L = Force relayout (star moved to Q)
                e.preventDefault();
                forceRelayout();
                break;
            case '/':
                // / : Random seek selected, // : Random seek all
                e.preventDefault();
                {
                    const now = Date.now();
                    if ((now - lastSlashTime) < DOUBLE_TAP_THRESHOLD) {
                        // Double tap: random seek all
                        if (slashTimeout) { clearTimeout(slashTimeout); slashTimeout = null; }
                        lastSlashTime = 0;
                        randomSeekAll();
                    } else {
                        // Single tap: delay to check for double
                        lastSlashTime = now;
                        slashTimeout = setTimeout(() => {
                            slashTimeout = null;
                            randomSeekSelected();
                        }, DOUBLE_TAP_THRESHOLD);
                    }
                }
                break;
            case '\\':
                // \ : Rewind selected stream to beginning
                e.preventDefault();
                rewindSelected();
                break;
            case '|':
                // | (Shift+\) : Rewind all streams to beginning
                e.preventDefault();
                rewindAll();
                break;
            case '?':
                // ? : Toggle shortcuts overlay (standard help key)
                e.preventDefault();
                toggleShortcutsOverlay();
                break;
        }
    }

    /**
     * Handle arrow key navigation for all modes
     * In true-grid mode, select AND focus the next stream
     * In focused mode, switch to next focused stream
     * In coverflow mode, navigate carousel
     * In normal mode, just select next stream
     */
    function handleArrowNav(direction, fullscreenStream, selected) {
        const mode = PlexdStream.getFullscreenMode();

        console.log(`[Plexd] handleArrowNav: direction=${direction}, mode=${mode}, fullscreenStream=${fullscreenStream ? fullscreenStream.id : 'null'}, selected=${selected ? selected.id : 'null'}`);

        if (fullscreenStream) {
            // In focused mode - switch to next focused stream
            console.log('[Plexd] handleArrowNav: calling switchFullscreenStream');
            switchFullscreenStream(direction);
        } else if (mode === 'true-grid') {
            // In true-grid mode - just select the next stream (stay in grid view)
            PlexdStream.selectNextStream(direction);
        } else if (coverflowMode) {
            // In coverflow mode - navigate carousel
            const streams = getFilteredStreams();
            if (streams.length > 0) {
                const navDir = (direction === 'up' || direction === 'left') ? 'prev' : 'next';
                PlexdGrid.coverflowNavigate(navDir, streams.length);
                updateLayout();
                showCoverflowPosition();
            }
        } else {
            // Normal grid mode - just select next stream
            console.log('[Plexd] handleArrowNav: fallback to selectNextStream (not fullscreen, not true-grid, not coverflow)');
            PlexdStream.selectNextStream(direction);
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
        console.log(`[Plexd] switchFullscreenStream: direction=${direction}, fullscreenStream=${fullscreenStream ? fullscreenStream.id : 'null'}`);
        if (!fullscreenStream) {
            console.log('[Plexd] switchFullscreenStream: no fullscreen stream, returning');
            return;
        }

        const nextId = PlexdStream.getSpatialNeighborStreamId(fullscreenStream.id, direction);
        console.log(`[Plexd] switchFullscreenStream: nextId=${nextId}`);
        if (!nextId || nextId === fullscreenStream.id) {
            console.log('[Plexd] switchFullscreenStream: no next stream or same stream, returning');
            return;
        }

        const mode = PlexdStream.getFullscreenMode();
        console.log(`[Plexd] switchFullscreenStream: calling enterFocusedMode(${nextId}), mode=${mode}`);
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
     * Validate URL format (supports both absolute and relative URLs)
     */
    function isValidUrl(string) {
        if (!string || typeof string !== 'string') return false;
        // Allow relative URLs starting with /
        if (string.startsWith('/')) return true;
        // Allow blob URLs
        if (string.startsWith('blob:')) return true;
        // Check absolute URLs
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
        // Exclude blob URLs unless they have a server URL (uploaded/transcoded)
        if (isBlobUrl(stream.url) && !stream.serverUrl) return false;

        const duration = stream.video && stream.video.duration;
        // Save if duration is unknown (not loaded yet) or meets minimum
        if (!duration || !isFinite(duration)) return true;
        return duration >= MIN_STREAM_DURATION;
    }

    /**
     * Save current streams to localStorage (auto-restores on reload)
     * Uses serverUrl when available so blob URLs survive reload.
     */
    function saveCurrentStreams() {
        const streams = PlexdStream.getAllStreams();
        const urls = [];
        const seen = new Set();
        const seenFileIds = new Set();
        streams.forEach(s => {
            if (!shouldSaveStream(s)) return;
            // Prefer serverUrl (HLS/uploaded) over blob/raw URL
            const url = s.serverUrl || s.url;
            const key = urlEqualityKey(url);
            const fileId = extractServerFileId(url);
            if (seen.has(key)) return;
            if (fileId && seenFileIds.has(fileId.toLowerCase())) return;
            seen.add(key);
            if (fileId) seenFileIds.add(fileId.toLowerCase());
            urls.push(url);
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
    async function saveStreamCombination(existingName = null) {
        // Handle being called from click event (existingName would be Event object)
        if (existingName && typeof existingName !== 'string') {
            existingName = null;
        }

        const streams = PlexdStream.getAllStreams();
        if (streams.length === 0) {
            showMessage('No streams to save', 'error');
            return;
        }

        // Separate local files from URL streams
        // If a local file has a server HLS URL, use that instead (no re-upload needed on load)
        const localFileStreams = streams.filter(s => isBlobUrl(s.url) && s.fileName && !s.serverUrl);
        const urlStreams = streams.filter(s => !isBlobUrl(s.url) || s.serverUrl);
        const shortVideos = urlStreams.filter(s => !shouldSaveStream(s)).length;
        const validUrlStreams = urlStreams.filter(s => shouldSaveStream(s));

        // Check if we have anything to save
        if (validUrlStreams.length === 0 && localFileStreams.length === 0) {
            const reasons = [];
            if (shortVideos > 0) reasons.push('videos too short');
            showMessage(`No valid streams to save${reasons.length > 0 ? ` (${reasons.join(', ')})` : ''}`, 'error');
            return;
        }

        const combinations = JSON.parse(localStorage.getItem('plexd_combinations') || '{}');
        let name = existingName;
        let isUpdate = !!existingName;

        if (!name) {
            // Check for existing names and offer update option
            const existingNames = Object.keys(combinations);
            if (existingNames.length > 0) {
                name = prompt(`Enter a name for this set:\n\nExisting sets (enter same name to update):\n• ${existingNames.join('\n• ')}`);
            } else {
                name = prompt('Enter a name for this set:');
            }
            if (!name) return;

            // Check if updating existing set
            if (combinations[name]) {
                const totalToSave = validUrlStreams.length + localFileStreams.length;
                const confirmUpdate = confirm(`"${name}" already exists with ${combinations[name].urls.length} streams.\n\nReplace with current ${totalToSave} streams?`);
                if (!confirmUpdate) return;
                isUpdate = true;
            }
        }

        // Dedupe URLs by normalized equality key AND server fileId to avoid saving the same stream twice
        // Use serverUrl (HLS) when available instead of blob URL
        const urls = [];
        const seenKeys = new Set();
        const seenFileIds = new Set();
        validUrlStreams.forEach(s => {
            const url = s.serverUrl || s.url;
            const key = urlEqualityKey(url);
            // Also extract server fileId to catch /api/files/X vs /api/hls/X duplicates
            const fileId = extractServerFileId(url);
            if (seenKeys.has(key)) return;
            if (fileId && seenFileIds.has(fileId.toLowerCase())) return;
            seenKeys.add(key);
            if (fileId) seenFileIds.add(fileId.toLowerCase());
            urls.push(url);
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
                let savedCount = 0;
                const total = localFileStreams.length;
                for (let i = 0; i < localFileStreams.length; i++) {
                    const stream = localFileStreams[i];
                    showMessage(`Saving file ${i + 1}/${total}: ${stream.fileName}...`, 'info');
                    try {
                        // Use stored File object if available (faster), otherwise fetch from blob URL
                        let blob;
                        if (stream.fileObj) {
                            blob = stream.fileObj;
                        } else {
                            const response = await fetch(stream.url);
                            blob = await response.blob();
                        }
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

        // Collect playback positions for all streams
        const positions = {};
        streams.forEach(s => {
            const currentTime = s.video?.currentTime;
            if (currentTime && currentTime > 1) { // Only save if >1 second in
                if (isBlobUrl(s.url) && s.fileName) {
                    positions[`file:${s.fileName}`] = currentTime;
                } else {
                    positions[s.url] = currentTime;
                }
            }
        });

        combinations[name] = {
            urls: urls,
            localFiles: localFiles,
            localFileRatings: Object.keys(localFileRatings).length > 0 ? localFileRatings : undefined,
            localFilesSavedToDisc: savedToDisc,
            loginDomains: loginDomains,
            favoriteUrls: favoriteUrls.length > 0 ? favoriteUrls : undefined,
            favoriteFileNames: favoriteFileNames.length > 0 ? favoriteFileNames : undefined,
            positions: Object.keys(positions).length > 0 ? positions : undefined,
            savedAt: Date.now()
        };

        try {
            console.log('[Plexd] Saving combination:', name, combinations[name]);
            localStorage.setItem('plexd_combinations', JSON.stringify(combinations));
            console.log('[Plexd] Saved to localStorage successfully');
        } catch (err) {
            console.error('[Plexd] Failed to save combination to localStorage:', err);
            showMessage('Failed to save: storage quota exceeded', 'error');
            return;
        }

        // Associate server-uploaded files with this saved set (prevents 24h auto-delete)
        const serverFileIds = localFileStreams
            .filter(s => s.serverFileId)
            .map(s => s.serverFileId);
        if (serverFileIds.length > 0) {
            associateFilesWithSet(serverFileIds, name);
        }

        // Build informative message
        const totalCount = urls.length + localFiles.length;
        const favCount = favoriteUrls.length + favoriteFileNames.length;
        let msg = isUpdate ? `Updated: ${name}` : `Saved: ${name}`;
        msg += ` (${totalCount} stream${totalCount !== 1 ? 's' : ''})`;
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
        await updateCombinationsList();

        // Auto-open the saved sets panel so user can see the saved set
        const savedPanel = document.getElementById('saved-panel');
        if (savedPanel && !savedPanel.classList.contains('plexd-panel-open')) {
            savedPanel.classList.add('plexd-panel-open');
        }
    }

    /**
     * Update an existing set with current streams
     */
    function updateStreamCombination(name) {
        saveStreamCombination(name);
    }

    /**
     * Add a saved set to current streams (merge without clearing)
     */
    function addStreamCombination(name) {
        loadStreamCombination(name, true);
    }

    /**
     * Save favorite streams as a combination/set
     */
    async function saveFavoritesAsCombination() {
        const streams = PlexdStream.getFavoriteStreams();
        if (streams.length === 0) {
            showMessage('No stars to save. Press Q on selected streams to star them.', 'warning');
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
                let savedCount = 0;
                const total = localFileStreams.length;
                for (let i = 0; i < localFileStreams.length; i++) {
                    const stream = localFileStreams[i];
                    showMessage(`Saving file ${i + 1}/${total}: ${stream.fileName}...`, 'info');
                    try {
                        // Use stored File object if available (faster), otherwise fetch from blob URL
                        let blob;
                        if (stream.fileObj) {
                            blob = stream.fileObj;
                        } else {
                            const response = await fetch(stream.url);
                            blob = await response.blob();
                        }
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
        await updateCombinationsList();
    }

    /**
     * Load a saved stream combination
     * @param {string} name - Name of the combination to load
     * @param {boolean} merge - If true, add to existing streams instead of replacing
     */
    async function loadStreamCombination(name, merge = false) {
        const combinations = JSON.parse(localStorage.getItem('plexd_combinations') || '{}');
        const combo = combinations[name];

        console.log(`[Plexd] loadStreamCombination("${name}") - combo:`, combo);

        if (!combo) {
            showMessage(`Combination "${name}" not found`, 'error');
            return;
        }

        // Check if there are local files to provide
        const localFiles = combo.localFiles || [];
        const loginDomains = combo.loginDomains || [];

        console.log(`[Plexd] Set "${name}" has ${(combo.urls || []).length} URLs, ${localFiles.length} local files`);

        // Upgrade server file URLs to HLS if available
        const serverFiles = await getServerFileList();
        if (combo.urls && combo.urls.length > 0) {
            combo.urls = combo.urls.map(url => {
                // Check if this is a server file URL (/api/files/{fileId})
                // Handle both relative and absolute URLs
                const match = url.match(/\/api\/files\/([^/?]+)/);
                if (match) {
                    const fileId = decodeURIComponent(match[1]);
                    const serverFile = serverFiles.find(f => f.fileId === fileId);
                    if (serverFile && serverFile.hlsReady && serverFile.hlsUrl) {
                        console.log(`[Plexd] Upgrading ${fileId} to HLS: ${serverFile.hlsUrl}`);
                        return serverFile.hlsUrl;
                    }
                }
                return url;
            });
        }

        // Chain of modals: login domains first, then local files
        const loadWithFiles = (providedFiles) => {
            console.log(`[Plexd] loadWithFiles called with ${providedFiles.length} files, now loading streams...`);
            if (loginDomains.length > 0) {
                showLoginDomainsModal(name, loginDomains, () => {
                    loadCombinationStreams(name, combo, providedFiles, merge);
                });
            } else {
                loadCombinationStreams(name, combo, providedFiles, merge);
            }
        };

        if (localFiles.length > 0) {
            // Check if local files exist on server (HLS or original) - reuse serverFiles from above
            const serverMatches = {};
            localFiles.forEach(fileName => {
                const match = serverFiles.find(f =>
                    (f.hlsReady || f.originalExists) && (f.fileName === fileName || f.originalFileName === fileName)
                );
                if (match) {
                    // Prefer HLS URL if available, fall back to original
                    serverMatches[fileName] = match.hlsUrl || match.url;
                }
            });

            // If all files found on server, use server URLs directly
            if (Object.keys(serverMatches).length === localFiles.length) {
                console.log('[Plexd] All local files found on server, using HLS URLs');
                // Convert to URL streams format - add server URLs to combo.urls temporarily
                const serverUrls = localFiles.map(f => serverMatches[f]);
                combo.urls = [...(combo.urls || []), ...serverUrls];
                combo.localFiles = []; // Clear local files since we're using server
                loadWithFiles([]);
                return;
            }

            // Some files on server - filter out matched ones
            const remainingLocalFiles = localFiles.filter(f => !serverMatches[f]);
            if (Object.keys(serverMatches).length > 0) {
                console.log(`[Plexd] ${Object.keys(serverMatches).length} files found on server, ${remainingLocalFiles.length} still needed`);
                // Add server URLs to combo
                const serverUrls = localFiles.filter(f => serverMatches[f]).map(f => serverMatches[f]);
                combo.urls = [...(combo.urls || []), ...serverUrls];
            }

            // No remaining local files needed - all found on server
            if (remainingLocalFiles.length === 0) {
                loadWithFiles([]);
                return;
            }

            // Then try to load remaining from disc storage
            if (combo.localFilesSavedToDisc) {
                showMessage('Loading local files from storage...', 'info');
                const loadedFiles = [];
                let loadedCount = 0;
                const missingFiles = [];

                for (let i = 0; i < remainingLocalFiles.length; i++) {
                    const fileName = remainingLocalFiles[i];
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
                        for (let i = 0; i < remainingLocalFiles.length; i++) {
                            if (!loadedFiles[i]) {
                                if (additionalFiles[addIdx]) {
                                    loadedFiles[i] = additionalFiles[addIdx];
                                }
                                addIdx++;
                            }
                        }
                        loadWithFiles(loadedFiles);
                    }, loadedCount);
                }
            } else {
                // Files not saved to disc - show modal
                showLocalFilesModal(name, remainingLocalFiles, loadWithFiles);
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
                <div style="display: flex; gap: 10px; margin-top: 10px;">
                    <button id="local-modal-autoscan" class="plexd-button plexd-button-primary" style="flex: 1;">
                        Quick Scan
                    </button>
                    <button id="local-modal-folder" class="plexd-button plexd-button-secondary" style="flex: 1;">
                        Pick Folder...
                    </button>
                </div>
                <div id="local-modal-status" class="plexd-modal-hint" style="color: #4ade80; min-height: 20px;"></div>
                <div class="plexd-modal-hint">
                    Quick Scan uses your saved folder (or Downloads). Pick Folder to choose a different location.
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

        // Handle file selection - supports both File objects and server file objects {name, url}
        function handleFiles(files) {
            Array.from(files).forEach(file => {
                // Determine if this is a File object or a server file object
                const isFileObject = file instanceof File;
                const fileName = isFileObject ? file.name : file.name;

                // Find matching expected file by name
                const fileItems = modal.querySelectorAll('.plexd-local-file-item');
                let matched = false;

                fileItems.forEach(item => {
                    const expected = item.dataset.expected;
                    const idx = parseInt(item.dataset.index);

                    // Match by exact name or similar name (case-insensitive, without extension)
                    const expectedBase = expected.replace(/\.[^/.]+$/, '').toLowerCase();
                    const fileBase = fileName.replace(/\.[^/.]+$/, '').toLowerCase();

                    if (!matched && (fileName === expected || expectedBase === fileBase)) {
                        // For File objects, create blob URL; for server files, use provided URL
                        if (isFileObject) {
                            const objectUrl = URL.createObjectURL(file);
                            providedFiles[idx] = { url: objectUrl, fileName: fileName, fileObj: file };
                        } else {
                            // Server file - already has URL
                            providedFiles[idx] = { url: file.url, fileName: fileName, isServerFile: true };
                        }

                        // Update UI
                        item.classList.add('plexd-local-file-matched');
                        item.querySelector('.plexd-local-file-status').textContent = '✓ ' + fileName;
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
                        const fileBase = fileName.replace(/\.[^/.]+$/, '').toLowerCase();

                        if (providedFiles[idx] === undefined &&
                            (expectedBase.includes(fileBase) || fileBase.includes(expectedBase))) {
                            if (isFileObject) {
                                const objectUrl = URL.createObjectURL(file);
                                providedFiles[idx] = { url: objectUrl, fileName: fileName, fileObj: file };
                            } else {
                                providedFiles[idx] = { url: file.url, fileName: fileName, isServerFile: true };
                            }
                            item.classList.add('plexd-local-file-matched');
                            item.querySelector('.plexd-local-file-status').textContent = '✓ ' + fileName;
                            matched = true;
                        }
                    });
                }
            });
        }

        // Click to browse - use File System Access API to start in Downloads
        dropZone.addEventListener('click', async () => {
            if ('showOpenFilePicker' in window) {
                try {
                    const handles = await window.showOpenFilePicker({
                        startIn: 'downloads',
                        multiple: true,
                        types: [{
                            description: 'Video files',
                            accept: { 'video/*': ['.mov', '.mp4', '.m4v', '.webm', '.mkv', '.avi', '.ogv', '.3gp', '.flv', '.mpeg', '.mpg'] }
                        }]
                    });
                    const files = await Promise.all(handles.map(h => h.getFile()));
                    handleFiles(files);
                } catch (e) {
                    if (e.name !== 'AbortError') console.error('File picker error:', e);
                }
            } else {
                fileInput.click();
            }
        });
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

        // Folder selection (File System Access API)
        const folderBtn = document.getElementById('local-modal-folder');
        const statusDiv = document.getElementById('local-modal-status');

        function setStatus(msg, isError = false) {
            if (statusDiv) {
                statusDiv.textContent = msg;
                statusDiv.style.color = isError ? '#f87171' : '#4ade80';
            }
        }

        // Shared folder scanning function
        async function scanFolderForVideos(dirHandle) {
            const foundFiles = [];
            let scannedCount = 0;
            let errorCount = 0;

            async function searchDir(handle, depth = 0) {
                if (depth > 10) return;
                try {
                    for await (const entry of handle.values()) {
                        try {
                            if (entry.kind === 'file') {
                                scannedCount++;
                                if (scannedCount % 50 === 0) {
                                    setStatus(`Scanning... ${scannedCount} files checked`);
                                }
                                const file = await entry.getFile();
                                if (isVideoFile(file)) {
                                    foundFiles.push(file);
                                }
                            } else if (entry.kind === 'directory' && !entry.name.startsWith('.')) {
                                await searchDir(entry, depth + 1);
                            }
                        } catch (e) {
                            errorCount++;
                        }
                    }
                } catch (e) {
                    errorCount++;
                }
            }

            await searchDir(dirHandle);
            console.log(`[Plexd] Scan: ${scannedCount} files, ${foundFiles.length} videos, ${errorCount} skipped`);
            return foundFiles;
        }

        // Quick Scan logic - extracted for auto-scan on modal open
        const autoscanBtn = document.getElementById('local-modal-autoscan');

        // Server-side scan (no permission needed)
        // Priority: 1) Server uploads, 2) HLS folder, 3) Downloads
        async function performServerScan() {
            const allFiles = [];
            const sources = [];

            try {
                // 1. Check server uploads first
                setStatus('Checking server uploads...');
                const uploadResp = await fetch('/api/files/list');
                if (uploadResp.ok) {
                    const uploads = await uploadResp.json();
                    if (uploads.length > 0) {
                        uploads.forEach(f => {
                            allFiles.push({
                                name: f.fileName,
                                url: f.url,
                                size: f.size,
                                isServerUpload: true
                            });
                        });
                        sources.push('uploads');
                    }
                }

                // 2. Scan HLS folder
                setStatus('Checking transcoded files...');
                const hlsResp = await fetch('/api/files/scan-local?folder=uploads/hls');
                if (hlsResp.ok) {
                    const hlsData = await hlsResp.json();
                    if (hlsData.files?.length > 0) {
                        hlsData.files.forEach(f => {
                            allFiles.push({
                                name: f.name,
                                url: `/api/files/local?path=${encodeURIComponent(f.path)}`,
                                size: f.size,
                                isHLS: true
                            });
                        });
                        sources.push('hls');
                    }
                }

                // 3. Scan Downloads
                setStatus('Checking Downloads...');
                const dlResp = await fetch('/api/files/scan-local');
                if (dlResp.ok) {
                    const dlData = await dlResp.json();
                    if (dlData.files?.length > 0) {
                        dlData.files.forEach(f => {
                            allFiles.push({
                                name: f.name,
                                url: `/api/files/local?path=${encodeURIComponent(f.path)}`,
                                size: f.size,
                                isDownloads: true
                            });
                        });
                        sources.push('Downloads');
                    }
                }

                if (allFiles.length === 0) return null;
                return { files: allFiles, sources: sources.join(', ') };
            } catch (e) {
                console.log('[Plexd] Server scan failed:', e.message);
                return null;
            }
        }

        async function performQuickScan(autoMode = false) {
            try {
                autoscanBtn.disabled = true;
                folderBtn.disabled = true;

                // Try server-side scan first (no permission needed)
                const serverResult = await performServerScan();
                if (serverResult && serverResult.files.length > 0) {
                    handleFiles(serverResult.files);
                    const matchedCount = providedFiles.filter(Boolean).length;
                    const matchRatio = matchedCount / expectedFiles.length;
                    if (matchedCount > 0) {
                        setStatus(`Found ${serverResult.files.length} videos (${serverResult.sources}), matched ${matchedCount}/${expectedFiles.length}`);
                        return { success: true, matchedCount, matchRatio };
                    }
                }

                // Fall back to File System Access API
                let dirHandle = await getVideoFolderHandle();
                if (dirHandle) {
                    setStatus(`Requesting access to ${dirHandle.name}...`);
                    const hasPermission = await requestFolderPermission(dirHandle);
                    if (!hasPermission) {
                        if (autoMode) {
                            setStatus('Permission needed - click Quick Scan to grant access');
                            return { success: false, needsPermission: true };
                        }
                        setStatus('Permission denied, pick a new folder...');
                        dirHandle = null;
                    }
                }

                // No saved handle or permission denied - show picker (auto-opens to Downloads)
                if (!dirHandle) {
                    if (autoMode) {
                        setStatus('No matches in Downloads - use Quick Scan or Pick Folder');
                        return { success: false, noFolder: true };
                    }
                    setStatus('Select your video folder...');
                    dirHandle = await window.showDirectoryPicker({
                        startIn: 'downloads',
                        mode: 'read'
                    });
                    await saveVideoFolderHandle(dirHandle);
                }

                setStatus(`Scanning ${dirHandle.name}...`);
                const foundFiles = await scanFolderForVideos(dirHandle);

                if (foundFiles.length > 0) {
                    handleFiles(foundFiles);
                    const matchedCount = providedFiles.filter(Boolean).length;
                    const matchRatio = matchedCount / expectedFiles.length;
                    setStatus(`Found ${foundFiles.length} videos, matched ${matchedCount}/${expectedFiles.length}`);
                    return { success: true, matchedCount, matchRatio };
                } else {
                    setStatus('No videos found in folder', true);
                    return { success: false, noVideos: true };
                }
            } catch (e) {
                if (e.name !== 'AbortError') {
                    setStatus(`Error: ${e.message}`, true);
                } else {
                    setStatus('');
                }
                return { success: false, error: e };
            } finally {
                autoscanBtn.disabled = false;
                folderBtn.disabled = false;
            }
        }

        autoscanBtn.addEventListener('click', () => performQuickScan(false));

        if ('showDirectoryPicker' in window) {
            folderBtn.addEventListener('click', async () => {
                try {
                    folderBtn.disabled = true;
                    autoscanBtn.disabled = true;
                    setStatus('Selecting folder...');
                    const dirHandle = await window.showDirectoryPicker({
                        startIn: 'downloads',
                        mode: 'read'
                    });

                    // Save and scan
                    await saveVideoFolderHandle(dirHandle);
                    setStatus(`Scanning ${dirHandle.name}...`);
                    const foundFiles = await scanFolderForVideos(dirHandle);

                    if (foundFiles.length > 0) {
                        handleFiles(foundFiles);
                        const matchedCount = providedFiles.filter(Boolean).length;
                        setStatus(`Found ${foundFiles.length} videos, matched ${matchedCount}/${expectedFiles.length}`);
                    } else {
                        setStatus('No videos found in folder', true);
                    }
                } catch (err) {
                    if (err.name !== 'AbortError') {
                        setStatus(`Error: ${err.message}`, true);
                    } else {
                        setStatus('');
                    }
                } finally {
                    folderBtn.disabled = false;
                    autoscanBtn.disabled = false;
                }
            });
        } else {
            // Hide buttons if not supported
            folderBtn.style.display = 'none';
            autoscanBtn.style.display = 'none';
            setStatus('Folder search not supported in this browser', true);
        }

        // Button handlers
        document.getElementById('local-modal-cancel').addEventListener('click', () => {
            console.log('[Plexd] Local files modal: Cancel clicked');
            // Revoke any created blob URLs
            providedFiles.forEach(f => f && URL.revokeObjectURL(f.url));
            modal.remove();
        });

        document.getElementById('local-modal-skip').addEventListener('click', () => {
            console.log('[Plexd] Local files modal: Skip clicked, calling onContinue([])');
            // Revoke any created blob URLs
            providedFiles.forEach(f => f && URL.revokeObjectURL(f.url));
            modal.remove();
            onContinue([]);
        });

        document.getElementById('local-modal-continue').addEventListener('click', () => {
            console.log(`[Plexd] Local files modal: Continue clicked with ${providedFiles.filter(Boolean).length} files`);
            modal.remove();
            onContinue(providedFiles);
        });

        // Cleanup function for consistent modal closing
        const cleanupModal = () => {
            document.removeEventListener('keydown', handleEscape, true);
            providedFiles.forEach(f => f && URL.revokeObjectURL(f.url));
            modal.remove();
        };

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) cleanupModal();
        });

        // Close on Escape - capture phase to intercept before fullscreen exit
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                cleanupModal();
            }
        };
        document.addEventListener('keydown', handleEscape, true);

        // Auto-scan on modal open - if >=50% matched, auto-continue
        (async () => {
            if (!('showDirectoryPicker' in window)) return;

            setStatus('Auto-scanning...');
            const result = await performQuickScan(true);

            // Check if modal was closed while scanning (user cancelled)
            if (!document.body.contains(modal)) {
                console.log('[Plexd] Auto-scan: modal was closed during scan, aborting');
                return;
            }

            if (result.success && result.matchRatio >= 0.5) {
                // Good enough match - auto-continue
                console.log(`[Plexd] Auto-scan matched ${result.matchedCount}/${expectedFiles.length} (${Math.round(result.matchRatio * 100)}%) - auto-loading`);
                modal.remove();
                document.removeEventListener('keydown', handleEscape, true);
                onContinue(providedFiles);
            } else {
                // Not enough matches - show modal for manual intervention
                console.log(`[Plexd] Auto-scan: ${result.success ? `only ${result.matchedCount}/${expectedFiles.length} matched` : 'failed'} - showing modal`);
            }
        })();
    }

    /**
     * Actually load the combination streams
     * @param {string} name - Combination name
     * @param {Object} combo - Combination data
     * @param {Array} providedFiles - Array of {url, fileName} for local files
     * @param {boolean} merge - If true, add to existing streams instead of replacing
     */
    function loadCombinationStreams(name, combo, providedFiles = [], merge = false) {
        // Clear current streams (unless merging)
        if (!merge) {
            const currentStreams = PlexdStream.getAllStreams();
            currentStreams.forEach(s => PlexdStream.removeStream(s.id));
        }

        // Pre-dedupe URLs in the combo to catch /api/files/X vs /api/hls/X duplicates
        // Prefer HLS version when both exist
        let dedupedUrls = [];
        if (combo.urls && combo.urls.length > 0) {
            const seenKeys = new Set();
            const seenFileIds = new Set();
            // Sort to process HLS URLs first (so they win over originals)
            const sortedUrls = [...combo.urls].sort((a, b) => {
                const aIsHls = a && a.includes('/api/hls/');
                const bIsHls = b && b.includes('/api/hls/');
                return bIsHls - aIsHls; // HLS first
            });
            sortedUrls.forEach(url => {
                if (!url) return;
                const key = urlEqualityKey(url);
                const fileId = extractServerFileId(url);
                if (seenKeys.has(key)) return;
                if (fileId && seenFileIds.has(fileId.toLowerCase())) return;
                seenKeys.add(key);
                if (fileId) seenFileIds.add(fileId.toLowerCase());
                dedupedUrls.push(url);
            });
        }

        // Get existing URLs/fileIds to avoid duplicates when merging
        const existingUrls = merge ? new Set(PlexdStream.getAllStreams().map(s => s.url)) : new Set();
        const existingFileIds = merge ? new Set(PlexdStream.getAllStreams().map(s => {
            const id = extractServerFileId(s.url) || extractServerFileId(s.serverUrl);
            return id ? id.toLowerCase() : null;
        }).filter(Boolean)) : new Set();

        // Log HLS.js availability for debugging
        const hlsAvailable = typeof Hls !== 'undefined' && Hls.isSupported();
        const urlCount = dedupedUrls.length;
        const localCount = providedFiles.filter(f => f).length;
        console.log(`[Plexd] Loading "${name}": ${urlCount} URL streams, ${localCount} local files, HLS.js: ${hlsAvailable ? 'available' : 'NOT AVAILABLE'}`);

        // Load URL streams with validation
        let loadedCount = 0;
        let skippedCount = 0;
        let duplicateCount = 0;

        dedupedUrls.forEach((url, index) => {
            if (url && isValidUrl(url)) {
                // Skip duplicates when merging (check both URL and fileId)
                if (merge) {
                    if (existingUrls.has(url)) {
                        duplicateCount++;
                        return;
                    }
                    const fileId = extractServerFileId(url);
                    if (fileId && existingFileIds.has(fileId.toLowerCase())) {
                        duplicateCount++;
                        return;
                    }
                }
                console.log(`[Plexd] Loading stream ${index + 1}/${urlCount}: ${truncateUrl(url, 80)}`);
                addStreamSilent(url);
                loadedCount++;
            } else {
                console.warn(`[Plexd] Skipping invalid URL at index ${index}:`, url);
                skippedCount++;
            }
        });

        // Load provided local files and restore their ratings
        let localLoaded = 0;
        const localFileRatings = combo.localFileRatings || {};
        const localFiles = combo.localFiles || [];

        providedFiles.forEach((file, index) => {
            if (file && file.url) {
                const originalFileName = localFiles[index];
                console.log(`[Plexd] Loading local file ${index + 1}: ${file.fileName}`);
                // Pass blob for server upload (enables remote playback)
                addStreamFromFile(file.url, file.fileName, file.blob || file.fileObj || null);
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

        // Restore playback positions (wait for videos to be ready)
        const positions = combo.positions || {};
        if (Object.keys(positions).length > 0) {
            setTimeout(() => {
                let positionsRestored = 0;
                const streams = PlexdStream.getAllStreams();
                streams.forEach(stream => {
                    // Check both URL and file-based position keys
                    const posKey = stream.fileName ? `file:${stream.fileName}` : stream.url;
                    const savedPosition = positions[posKey] || positions[stream.url];
                    if (savedPosition && savedPosition > 0 && stream.video) {
                        // Wait for video to be ready enough to seek
                        const trySeek = () => {
                            if (stream.video.readyState >= 1) {
                                stream.video.currentTime = savedPosition;
                                positionsRestored++;
                                console.log(`[Plexd] Restored position ${Math.round(savedPosition)}s for ${stream.fileName || truncateUrl(stream.url, 50)}`);
                            } else {
                                // Video not ready, try again shortly
                                setTimeout(trySeek, 200);
                            }
                        };
                        trySeek();
                    }
                });
            }, 500);
        }

        // Build message
        const total = loadedCount + localLoaded;
        const favCount = favoriteUrls.length + favoriteFileNames.length;
        let msg = merge ? `Added: ${name}` : `Loaded: ${name}`;
        msg += ` (${total} stream${total !== 1 ? 's' : ''})`;
        if (localLoaded > 0) {
            msg += ` | ${localLoaded} local`;
        }
        if (favCount > 0) {
            msg += ` | ${favCount} fav`;
        }
        if (duplicateCount > 0) {
            msg += ` | ${duplicateCount} duplicate${duplicateCount !== 1 ? 's' : ''} skipped`;
        }
        if (skippedCount > 0) {
            msg += ` | ${skippedCount} invalid`;
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

        // Cleanup function for consistent modal closing
        const cleanupModal = () => {
            document.removeEventListener('keydown', handleEscape, true);
            modal.remove();
        };

        document.getElementById('modal-continue').addEventListener('click', () => {
            cleanupModal();
            onContinue();
        });

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) cleanupModal();
        });

        // Close on Escape - capture phase to intercept before fullscreen exit
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                cleanupModal();
            }
        };
        document.addEventListener('keydown', handleEscape, true);
    }

    /**
     * Show modal to manage all stored files in IndexedDB
     */
    async function showManageStoredFilesModal() {
        // Remove existing modal if any
        const existingModal = document.getElementById('manage-files-modal');
        if (existingModal) existingModal.remove();

        // Show loading indicator immediately - append to fullscreen element if active
        const loadingModal = document.createElement('div');
        loadingModal.id = 'manage-files-modal';
        loadingModal.className = 'plexd-modal-overlay';
        loadingModal.innerHTML = '<div class="plexd-modal"><h3>Loading files...</h3></div>';
        const appendTarget = document.fullscreenElement || document.body;
        appendTarget.appendChild(loadingModal);

        // Fetch all data in parallel with timeout (10s to allow for busy server during transcodes)
        const timeout = (ms) => new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms));
        const withTimeout = (promise, ms) => Promise.race([promise, timeout(ms)]);

        const [files, serverFiles, dlData, orphanedData, queueStatus] = await Promise.all([
            withTimeout(getAllStoredFiles(), 10000).catch((e) => { console.warn('[Plexd] getAllStoredFiles failed:', e); return []; }),
            withTimeout(getServerFileList(), 10000).catch((e) => { console.warn('[Plexd] getServerFileList failed:', e); return []; }),
            withTimeout(fetch('/api/files/scan-local').then(r => r.ok ? r.json() : { files: [] }), 10000).catch((e) => { console.warn('[Plexd] scan-local failed:', e); return { files: [] }; }),
            withTimeout(fetch('/api/files/orphaned').then(r => r.ok ? r.json() : { files: [] }), 10000).catch((e) => { console.warn('[Plexd] orphaned failed:', e); return { files: [] }; }),
            withTimeout(fetch('/api/hls/status').then(r => r.ok ? r.json() : {}), 10000).catch((e) => { console.warn('[Plexd] hls/status failed:', e); return {}; })
        ]);

        const totalSize = files.reduce((sum, f) => sum + f.size, 0);
        const serverTotalSize = serverFiles.reduce((sum, f) => sum + (f.size || 0), 0);
        const downloadsFiles = dlData.files || [];
        const downloadsFolder = dlData.folder || 'Downloads';
        const orphanedFiles = orphanedData.files || [];

        console.log('[Plexd] Files modal data:', {
            browserFiles: files.length,
            serverFiles: serverFiles.length,
            downloadsFiles: downloadsFiles.length,
            downloadsFolder,
            orphanedFiles: orphanedFiles.length,
            dlData
        });
        if (!queueStatus.paused) queueStatus.paused = false;
        if (!queueStatus.queueLength) queueStatus.queueLength = 0;
        if (!queueStatus.activeCount) queueStatus.activeCount = 0;

        // Build set of loaded fileIds for quick lookup (green = already loaded)
        const loadedFileIds = new Set();
        PlexdStream.getAllStreams().forEach(s => {
            const id1 = extractServerFileId(s.url);
            const id2 = extractServerFileId(s.serverUrl);
            if (id1) loadedFileIds.add(id1.toLowerCase());
            if (id2) loadedFileIds.add(id2.toLowerCase());
            if (s.fileName) loadedFileIds.add(s.fileName.toLowerCase());
        });

        // Build map of all fileNames across all sources to detect duplicates
        const fileNameCount = new Map();
        const countFileName = (name) => {
            if (!name) return;
            const key = name.toLowerCase();
            fileNameCount.set(key, (fileNameCount.get(key) || 0) + 1);
        };
        serverFiles.forEach(f => countFileName(f.fileId || f.fileName));
        downloadsFiles.forEach(f => countFileName(f.name));
        orphanedFiles.forEach(f => countFileName(f.name));

        // Also check ratings storage for known clips
        const knownFileNames = new Set();
        try {
            const savedRatings = localStorage.getItem('plexd_fileName_ratings');
            if (savedRatings) {
                Object.keys(JSON.parse(savedRatings)).forEach(fn => knownFileNames.add(fn.toLowerCase()));
            }
        } catch (e) {}

        // Helper functions for file status
        const isFileLoaded = (fileId) => fileId && loadedFileIds.has(fileId.toLowerCase());
        const isFileDuplicate = (fileName) => fileName && fileNameCount.get(fileName.toLowerCase()) > 1;
        const isFileKnown = (fileName) => fileName && knownFileNames.has(fileName.toLowerCase());

        // Get color for file: green=loaded, cyan=known/rated but not loaded, orange=duplicate
        const getFileColor = (fileId, fileName) => {
            if (isFileLoaded(fileId) || isFileLoaded(fileName)) return '#4a4'; // green - in grid
            if (isFileKnown(fileName)) return '#4ad'; // cyan - has rating, not in grid
            if (isFileDuplicate(fileName)) return '#fa0'; // orange - duplicate across sources
            return ''; // default - unknown, not loaded
        };

        // Remove loading modal
        loadingModal.remove();

        // Calculate storage breakdown for server files
        const storageBreakdown = {
            hlsOnly: { count: 0, size: 0 },      // Good - HLS ready, no original
            hlsAndOrig: { count: 0, size: 0 },   // Redundant - both exist
            origOnly: { count: 0, size: 0 },     // Pending - needs transcode
            missing: { count: 0 }                 // Orphaned metadata
        };
        serverFiles.forEach(f => {
            if (f.hlsExists && !f.originalExists) {
                storageBreakdown.hlsOnly.count++;
                storageBreakdown.hlsOnly.size += f.size || 0;
            } else if (f.hlsExists && f.originalExists) {
                storageBreakdown.hlsAndOrig.count++;
                storageBreakdown.hlsAndOrig.size += f.size || 0; // original size (redundant)
            } else if (f.originalExists && !f.hlsExists) {
                storageBreakdown.origOnly.count++;
                storageBreakdown.origOnly.size += f.size || 0;
            } else {
                storageBreakdown.missing.count++;
            }
        });

        // Group browser files by set name
        const filesBySet = {};
        files.forEach(f => {
            if (!filesBySet[f.setName]) filesBySet[f.setName] = [];
            filesBySet[f.setName].push(f);
        });

        // Group server files by set name
        const serverFilesBySet = {};
        serverFiles.forEach(f => {
            const setName = f.setName || '(Unsaved)';
            if (!serverFilesBySet[setName]) serverFilesBySet[setName] = [];
            serverFilesBySet[setName].push(f);
        });

        const modal = document.createElement('div');
        modal.id = 'manage-files-modal';
        modal.className = 'plexd-modal-overlay';

        const renderFileList = () => {
            if (files.length === 0) {
                return '<div class="plexd-panel-empty">No stored files</div>';
            }
            return Object.entries(filesBySet).map(([setName, setFiles]) => `
                <div class="plexd-stored-set">
                    <div class="plexd-stored-set-header">
                        <span class="plexd-stored-set-name">${escapeHtml(setName)}</span>
                        <span class="plexd-stored-set-size">${setFiles.length} file${setFiles.length !== 1 ? 's' : ''}, ${formatBytes(setFiles.reduce((s, f) => s + f.size, 0))}</span>
                        <button class="plexd-button-small plexd-btn-danger" onclick="PlexdApp._deleteStoredSet('${escapeAttr(setName)}')" title="Delete all files in this set">Del Set</button>
                    </div>
                    <div class="plexd-stored-files">
                        ${setFiles.map(f => `
                            <div class="plexd-stored-file" data-id="${escapeAttr(f.id)}">
                                <span class="plexd-stored-file-name" title="${escapeAttr(f.fileName)}">${escapeHtml(f.fileName)}</span>
                                <span class="plexd-stored-file-size">${formatBytes(f.size)}</span>
                                <button class="plexd-btn-icon plexd-btn-danger" onclick="PlexdApp._deleteStoredFile('${escapeAttr(f.id)}')" title="Delete this file">x</button>
                            </div>
                        `).join('')}
                    </div>
                </div>
            `).join('');
        };

        const renderServerFileList = () => {
            if (serverFiles.length === 0) {
                return '<div class="plexd-panel-empty">No server files</div>';
            }
            const getStatus = (f) => {
                // Clear status based on what actually exists
                if (f.hlsExists && !f.originalExists) {
                    return '<span style="color:#4a4" title="Final HLS - ready to use">HLS</span>';
                }
                if (f.hlsExists && f.originalExists) {
                    return '<span style="color:#fa0" title="HLS exists but original redundant">HLS+Orig</span>';
                }
                if (f.transcoding) {
                    return `<span style="color:#08f" title="Transcoding in progress">${f.transcodeProgress || 0}%</span>`;
                }
                if (f.originalExists && !f.hlsExists) {
                    return '<span style="color:#888" title="Original only - waiting for transcode">Pending</span>';
                }
                if (!f.originalExists && !f.hlsExists) {
                    return '<span style="color:#f44" title="Missing - metadata only">Missing</span>';
                }
                return '<span style="color:#f44" title="Unknown state">???</span>';
            };
            return Object.entries(serverFilesBySet).map(([setName, setFiles]) => `
                <div class="plexd-stored-set">
                    <div class="plexd-stored-set-header">
                        <span class="plexd-stored-set-name">${escapeHtml(setName)}</span>
                        <span class="plexd-stored-set-size">${setFiles.length} file${setFiles.length !== 1 ? 's' : ''}</span>
                        <button class="plexd-button-small" onclick="PlexdApp._loadServerSet('${escapeAttr(setName)}')" title="Load all files from this set">Load Set</button>
                    </div>
                    <div class="plexd-stored-files">
                        ${setFiles.map(f => {
                            const color = getFileColor(f.fileId, f.fileName);
                            const loaded = isFileLoaded(f.fileId) || isFileLoaded(f.fileName);
                            return `
                            <div class="plexd-stored-file" data-server-id="${escapeAttr(f.fileId)}">
                                <button class="plexd-button-small" onclick="PlexdApp._loadServerFile('${escapeAttr(f.url)}')" style="padding:2px 6px;font-size:10px;">${loaded ? '...' : 'Load'}</button>
                                <span class="plexd-stored-file-name" title="${escapeAttr(f.fileName)}" style="${color ? 'color:' + color + ';' : ''}">${escapeHtml(f.fileName)}</span>
                                <span class="plexd-stored-file-status">${getStatus(f)}</span>
                                <span class="plexd-stored-file-size">${formatBytes(f.size || 0)}</span>
                                <button class="plexd-btn-icon plexd-btn-danger" onclick="PlexdApp._deleteServerFile('${escapeAttr(f.fileId)}')" title="Delete">x</button>
                            </div>
                        `;}).join('')}
                    </div>
                </div>
            `).join('');
        };

        const renderDownloadsList = () => {
            if (downloadsFiles.length === 0) {
                return '<div class="plexd-panel-empty">No videos in Downloads</div>';
            }
            const totalSize = downloadsFiles.reduce((sum, f) => sum + (f.size || 0), 0);
            return `
                <div class="plexd-stored-set-header" style="margin-bottom: 8px;">
                    <span class="plexd-stored-set-name">Downloads</span>
                    <span class="plexd-stored-set-size">${downloadsFiles.length} file${downloadsFiles.length !== 1 ? 's' : ''} (${formatBytes(totalSize)})</span>
                    <button class="plexd-button-small" onclick="PlexdApp._loadAllDownloads()" title="Import all files">Load All</button>
                </div>
                <div class="plexd-stored-files">
                    ${downloadsFiles.map(f => {
                        const color = getFileColor(f.name, f.name);
                        const loaded = isFileLoaded(f.name);
                        // Show relative path if file is in a subfolder
                        const displayName = f.relativePath && f.relativePath !== f.name ? f.relativePath : f.name;
                        return `
                        <div class="plexd-stored-file">
                            <button class="plexd-button-small" onclick="PlexdApp._importLocalFile('${escapeAttr(f.path)}')" style="padding:2px 6px;font-size:10px;">${loaded ? '...' : 'Load'}</button>
                            <span class="plexd-stored-file-name" title="${escapeAttr(f.path)}" style="${color ? 'color:' + color + ';' : ''}">${escapeHtml(displayName)}</span>
                            <span class="plexd-stored-file-size">${formatBytes(f.size || 0)}</span>
                        </div>
                    `;}).join('')}
                </div>`;
        };

        const renderOrphanedList = () => {
            if (orphanedFiles.length === 0) {
                return '<div class="plexd-panel-empty">No orphaned files</div>';
            }
            const totalSize = orphanedFiles.reduce((sum, f) => sum + (f.size || 0), 0);
            return `
                <div class="plexd-stored-set-header" style="margin-bottom: 8px;">
                    <span class="plexd-stored-set-name" style="color:#f44;">Orphaned</span>
                    <span class="plexd-stored-set-size">${orphanedFiles.length} file${orphanedFiles.length !== 1 ? 's' : ''} (${formatBytes(totalSize)})</span>
                    <button class="plexd-button-small" onclick="PlexdApp._adoptAllOrphans()" title="Adopt all orphaned files">Adopt All</button>
                </div>
                <div class="plexd-stored-files">
                    ${orphanedFiles.map(f => {
                        const color = getFileColor(f.name, f.name);
                        const loaded = isFileLoaded(f.name);
                        return `
                        <div class="plexd-stored-file">
                            <button class="plexd-button-small" onclick="PlexdApp._adoptOrphanedFile('${escapeAttr(f.name)}')" style="padding:2px 6px;font-size:10px;">Adopt</button>
                            <span class="plexd-stored-file-name" title="${escapeAttr(f.name)}" style="${color ? 'color:' + color + ';' : ''}">${escapeHtml(f.name)}</span>
                            <span class="plexd-stored-file-size">${formatBytes(f.size || 0)}</span>
                            <button class="plexd-btn-icon plexd-btn-danger" onclick="PlexdApp._deleteOrphanedFile('${escapeAttr(f.name)}')" title="Delete">x</button>
                        </div>
                    `;}).join('')}
                </div>`;
        };

        modal.innerHTML = `
            <div class="plexd-modal plexd-modal-wide">
                <h3>Server Files</h3>

                <div style="margin: 10px 0; padding: 12px; background: #1a1a1a; border-radius: 6px;">
                    <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 10px; text-align: center;">
                        <div>
                            <div style="font-size: 20px; font-weight: bold; color: #4a4;">${formatBytes(storageBreakdown.hlsOnly.size)}</div>
                            <div style="font-size: 11px; color: #888;">HLS Ready (${storageBreakdown.hlsOnly.count})</div>
                            <div style="font-size: 10px; color: #4a4;">Keep</div>
                        </div>
                        <div>
                            <div style="font-size: 20px; font-weight: bold; color: #fa0;">${formatBytes(storageBreakdown.hlsAndOrig.size)}</div>
                            <div style="font-size: 11px; color: #888;">Redundant (${storageBreakdown.hlsAndOrig.count})</div>
                            <div style="font-size: 10px; color: #fa0;">Can Delete</div>
                        </div>
                        <div>
                            <div style="font-size: 20px; font-weight: bold; color: #888;">${formatBytes(storageBreakdown.origOnly.size)}</div>
                            <div style="font-size: 11px; color: #888;">Pending (${storageBreakdown.origOnly.count})</div>
                            <div style="font-size: 10px; color: #888;">Needs Transcode</div>
                        </div>
                        <div>
                            <div style="font-size: 20px; font-weight: bold; color: #f44;">${storageBreakdown.missing.count}</div>
                            <div style="font-size: 11px; color: #888;">Missing</div>
                            <div style="font-size: 10px; color: #f44;">Orphaned</div>
                        </div>
                    </div>
                    ${storageBreakdown.hlsAndOrig.count > 0 ? `
                    <div style="margin-top: 10px; padding-top: 10px; border-top: 1px solid #333; display: flex; justify-content: space-between; align-items: center;">
                        <span style="color: #fa0; font-size: 12px;">Redundant originals can be deleted to save ${formatBytes(storageBreakdown.hlsAndOrig.size)}</span>
                        <button id="delete-redundant-btn" class="plexd-button-small plexd-btn-danger">Delete Redundant</button>
                    </div>` : ''}
                </div>

                <div style="margin: 10px 0; padding: 8px 10px; background: #1a1a1a; border-radius: 6px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap;">
                    <span style="color: #888; font-size: 12px;">Transcode: <span id="transcode-status" style="color: ${queueStatus.paused ? '#fa0' : '#4a4'}">${queueStatus.paused ? 'Paused' : 'Active'}</span></span>
                    <span style="color: #888; font-size: 12px;">Queue: <span id="queue-count">${queueStatus.queueLength}</span></span>
                    <span style="color: #888; font-size: 12px;">Active: <span id="active-count">${queueStatus.activeCount}</span></span>
                    <span style="flex:1"></span>
                    <button id="load-missing-btn" class="plexd-button-small" title="Load known files not in grid (cyan)">Load Missing</button>
                    <button id="transcode-start" class="plexd-button-small">Start</button>
                    <button id="transcode-pause" class="plexd-button-small">${queueStatus.paused ? 'Resume' : 'Pause'}</button>
                    <button id="transcode-stop" class="plexd-button-small plexd-btn-danger">Stop</button>
                </div>

                <div id="server-files-list" class="plexd-stored-files-container" style="max-height: 300px;">
                    ${renderServerFileList()}
                </div>

                <div id="downloads-list" class="plexd-stored-files-container" style="margin-top: 15px;">
                    ${renderDownloadsList()}
                </div>

                ${orphanedFiles.length > 0 ? `
                <div id="orphaned-list" class="plexd-stored-files-container" style="margin-top: 15px;">
                    ${renderOrphanedList()}
                </div>
                ` : ''}

                <div class="plexd-modal-actions">
                    <button id="manage-files-purge-server" class="plexd-button plexd-button-secondary plexd-btn-danger" ${serverFiles.length === 0 ? 'disabled' : ''}>Purge All</button>
                    <button id="manage-files-close" class="plexd-button plexd-button-primary">Done</button>
                </div>
            </div>
        `;

        // Append to fullscreen element if active, otherwise body
        (document.fullscreenElement || document.body).appendChild(modal);

        // Expose delete function temporarily
        PlexdApp._deleteServerFile = async (fileId) => {
            try {
                const resp = await fetch(`/api/files/${fileId}`, { method: 'DELETE' });
                if (!resp.ok) throw new Error('Delete failed');
                // Remove from local arrays
                const idx = serverFiles.findIndex(f => f.fileId === fileId);
                if (idx >= 0) {
                    const file = serverFiles[idx];
                    serverFiles.splice(idx, 1);
                    const setName = file.setName || '(Unsaved)';
                    const setFiles = serverFilesBySet[setName];
                    if (setFiles) {
                        const setIdx = setFiles.findIndex(f => f.fileId === fileId);
                        if (setIdx >= 0) setFiles.splice(setIdx, 1);
                        if (setFiles.length === 0) delete serverFilesBySet[setName];
                    }
                }
                document.getElementById('server-files-list').innerHTML = renderServerFileList();
                updateSubtitle();
                document.getElementById('manage-files-purge-server').disabled = serverFiles.length === 0;
            } catch (e) {
                console.error('[Plexd] Delete server file failed:', e);
            }
        };

        // Load a single file to current streams
        PlexdApp._loadServerFile = (url) => {
            // addStream handles duplicates and shows appropriate messages
            PlexdApp.addStream(url);
        };

        // Load all files from a set to current streams
        PlexdApp._loadServerSet = (setName) => {
            const setFiles = serverFilesBySet[setName] || [];
            let added = 0;
            setFiles.forEach(f => {
                if (f.url) {
                    PlexdApp.addStream(f.url);
                    added++;
                }
            });
            showMessage(`Added ${added} streams`, 'info');
            modal.remove();
        };

        // Import a local file (from Downloads): copy to server, queue transcode, add to grid
        PlexdApp._importLocalFile = async (filePath) => {
            try {
                showMessage('Importing...', 'info');
                const resp = await fetch('/api/files/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filePath })
                });
                if (!resp.ok) throw new Error('Import failed');
                const result = await resp.json();

                // Add to grid
                PlexdApp.addStream(result.url);

                // Mark as loaded in UI
                const fileName = filePath.split('/').pop();
                if (result.fileId) loadedFileIds.add(result.fileId.toLowerCase());
                if (fileName) loadedFileIds.add(fileName.toLowerCase());

                // Update downloads list to show loaded state
                const dlList = document.getElementById('downloads-list');
                if (dlList) dlList.innerHTML = renderDownloadsList();

                // Start polling for HLS completion
                if (result.transcoding && !result.hlsReady) {
                    const streams = PlexdStream.getAllStreams();
                    const stream = streams.find(s => s.url === result.url);
                    if (stream) {
                        pollTranscodeStatus(result.fileId, stream, fileName);
                    }
                }

                showMessage(result.existing ? 'Already imported' : 'Imported and queued for transcode', 'success');
            } catch (e) {
                console.error('[Plexd] Import failed:', e);
                showMessage('Import failed', 'error');
            }
        };

        // Adopt an orphaned file (add to metadata and queue transcode)
        PlexdApp._adoptOrphanedFile = async (fileName) => {
            try {
                const filePath = `/Users/oliver/Projects/Plexd/uploads/${fileName}`;
                // Import will detect it's already in uploads and just add metadata
                const resp = await fetch('/api/files/import', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ filePath })
                });
                if (!resp.ok) throw new Error('Adopt failed');
                const result = await resp.json();

                // Remove from orphaned list
                const idx = orphanedFiles.findIndex(f => f.name === fileName);
                if (idx >= 0) orphanedFiles.splice(idx, 1);
                document.getElementById('orphaned-list').innerHTML = renderOrphanedList();

                // Add to grid
                PlexdApp.addStream(result.url);
                showMessage('File adopted and queued', 'success');
            } catch (e) {
                console.error('[Plexd] Adopt failed:', e);
                showMessage('Adopt failed', 'error');
            }
        };

        // Delete an orphaned file
        PlexdApp._deleteOrphanedFile = async (fileName) => {
            try {
                // Delete directly from uploads folder
                const resp = await fetch(`/api/files/${encodeURIComponent(fileName)}`, { method: 'DELETE' });
                // Remove from UI even if delete fails (file might not exist)
                const idx = orphanedFiles.findIndex(f => f.name === fileName);
                if (idx >= 0) orphanedFiles.splice(idx, 1);
                document.getElementById('orphaned-list').innerHTML = renderOrphanedList();
                showMessage('Orphaned file deleted', 'success');
            } catch (e) {
                console.error('[Plexd] Delete orphaned failed:', e);
            }
        };

        // Load all downloads at once
        PlexdApp._loadAllDownloads = async () => {
            showMessage(`Importing ${downloadsFiles.length} files...`, 'info');
            let imported = 0;
            for (const f of downloadsFiles) {
                try {
                    await PlexdApp._importLocalFile(f.path);
                    imported++;
                } catch (e) { /* continue with others */ }
            }
            showMessage(`Imported ${imported} files`, 'success');
        };

        // Adopt all orphaned files at once
        PlexdApp._adoptAllOrphans = async () => {
            showMessage(`Adopting ${orphanedFiles.length} files...`, 'info');
            let adopted = 0;
            const toAdopt = [...orphanedFiles]; // Copy since we modify during iteration
            for (const f of toAdopt) {
                try {
                    await PlexdApp._adoptOrphanedFile(f.name);
                    adopted++;
                } catch (e) { /* continue with others */ }
            }
            showMessage(`Adopted ${adopted} files`, 'success');
        };

        const updateSubtitle = () => {
            const browserSize = files.reduce((sum, f) => sum + f.size, 0);
            const serverSize = serverFiles.reduce((sum, f) => sum + (f.size || 0), 0);
            modal.querySelector('.plexd-modal-subtitle').textContent =
                `Browser: ${files.length} files, ${formatBytes(browserSize)} | Server: ${serverFiles.length} files, ${formatBytes(serverSize)}`;
        };

        document.getElementById('manage-files-close').addEventListener('click', () => {
            cleanupModal();
        });

        // Transcode controls
        const updateQueueStatus = async () => {
            try {
                const resp = await fetch('/api/hls/status');
                if (resp.ok) {
                    const s = await resp.json();
                    document.getElementById('transcode-status').textContent = s.paused ? 'Paused' : 'Active';
                    document.getElementById('transcode-status').style.color = s.paused ? '#fa0' : '#4a4';
                    document.getElementById('queue-count').textContent = s.queueLength;
                    document.getElementById('active-count').textContent = s.activeCount;
                    document.getElementById('transcode-pause').textContent = s.paused ? 'Resume' : 'Pause';
                }
            } catch (e) { /* ignore */ }
        };

        document.getElementById('transcode-start').addEventListener('click', async () => {
            await fetch('/api/hls/start', { method: 'POST' });
            await updateQueueStatus();
            showMessage('Transcoding started', 'info');
        });

        document.getElementById('transcode-pause').addEventListener('click', async () => {
            const isPaused = document.getElementById('transcode-status').textContent === 'Paused';
            await fetch(isPaused ? '/api/hls/resume' : '/api/hls/pause', { method: 'POST' });
            await updateQueueStatus();
        });

        document.getElementById('transcode-stop').addEventListener('click', async () => {
            if (confirm('Stop all transcodes? This will cancel queued and active jobs.')) {
                await fetch('/api/hls/cancel-all', { method: 'POST' });
                await updateQueueStatus();
                showMessage('Transcodes stopped', 'info');
            }
        });

        // Load Missing - load server files that are known (rated) but not in grid
        document.getElementById('load-missing-btn').addEventListener('click', () => {
            const missingFiles = serverFiles.filter(f => {
                const loaded = isFileLoaded(f.fileId) || isFileLoaded(f.fileName);
                const known = isFileKnown(f.fileName);
                return known && !loaded && f.url;
            });
            if (missingFiles.length === 0) {
                showMessage('No known files missing from grid', 'info');
                return;
            }
            missingFiles.forEach(f => PlexdApp.addStream(f.url));
            // Update loadedFileIds for UI refresh
            missingFiles.forEach(f => {
                if (f.fileId) loadedFileIds.add(f.fileId.toLowerCase());
                if (f.fileName) loadedFileIds.add(f.fileName.toLowerCase());
            });
            document.getElementById('server-files-list').innerHTML = renderServerFileList();
            showMessage(`Loaded ${missingFiles.length} missing files`, 'success');
        });

        // Delete redundant originals button
        const deleteRedundantBtn = document.getElementById('delete-redundant-btn');
        if (deleteRedundantBtn) {
            deleteRedundantBtn.addEventListener('click', async () => {
                if (confirm(`Delete ${storageBreakdown.hlsAndOrig.count} redundant original files to free ${formatBytes(storageBreakdown.hlsAndOrig.size)}?`)) {
                    const resp = await fetch('/api/files/delete-redundant', { method: 'POST' });
                    const result = await resp.json();
                    showMessage(`Deleted ${result.deleted} redundant files, freed ${formatBytes(result.freedBytes)}`, 'info');
                    // Refresh the modal
                    modal.remove();
                    showManageStoredFilesModal();
                }
            });
        }

        document.getElementById('manage-files-purge-server').addEventListener('click', async () => {
            if (confirm('Purge ALL server files? This cannot be undone.')) {
                const deleted = await purgeServerFiles();
                showMessage(`Purged ${deleted} files from server`, 'info');
                modal.remove();
                showManageStoredFilesModal(); // Refresh
            }
        });

        const cleanupModal = () => {
            delete PlexdApp._deleteServerFile;
            delete PlexdApp._loadServerFile;
            delete PlexdApp._loadServerSet;
            delete PlexdApp._importLocalFile;
            delete PlexdApp._adoptOrphanedFile;
            delete PlexdApp._deleteOrphanedFile;
            delete PlexdApp._loadAllDownloads;
            delete PlexdApp._adoptAllOrphans;
            delete PlexdApp._deleteStoredFile;
            delete PlexdApp._deleteStoredSet;
            document.removeEventListener('keydown', handleEscape, true);
            document.removeEventListener('fullscreenchange', handleFullscreenChange);
            modal.remove();
        };

        // Re-parent modal to body when fullscreen exits (so Escape still works)
        const handleFullscreenChange = () => {
            if (!document.fullscreenElement && modal.parentNode && modal.parentNode !== document.body) {
                document.body.appendChild(modal);
            }
        };
        document.addEventListener('fullscreenchange', handleFullscreenChange);

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) cleanupModal();
        });

        // Close on Escape - capture phase, then re-enter fullscreen after browser exits it
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                const fsEl = document.fullscreenElement;
                cleanupModal();
                // Browser will exit fullscreen despite preventDefault.
                // Re-enter after a short delay (still within transient activation window).
                if (fsEl) {
                    setTimeout(() => {
                        if (!document.fullscreenElement) {
                            fsEl.requestFullscreen().catch(() => {});
                        }
                    }, 150);
                }
            }
        };
        document.addEventListener('keydown', handleEscape, true); // capture phase
    }

    /**
     * Show modal with all keyboard shortcuts
     */
    function showShortcutsModal() {
        // Remove existing modal if any
        const existingModal = document.getElementById('shortcuts-modal');
        if (existingModal) existingModal.remove();

        const modal = document.createElement('div');
        modal.id = 'shortcuts-modal';
        modal.className = 'plexd-modal-overlay';
        modal.innerHTML = `
            <div class="plexd-modal plexd-modal-shortcuts">
                <h3>Keyboard Shortcuts</h3>
                <div class="plexd-shortcuts-grid">
                    <div class="plexd-shortcuts-section">
                        <h4>Navigation</h4>
                        <div class="plexd-shortcut"><kbd>Arrows</kbd> Navigate streams</div>
                        <div class="plexd-shortcut"><kbd>Z</kbd> / <kbd>Enter</kbd> Focus/zoom stream</div>
                        <div class="plexd-shortcut"><kbd>Esc</kbd> Exit focus / back</div>
                        <div class="plexd-shortcut"><kbd>F</kbd> Toggle fullscreen</div>
                    </div>
                    <div class="plexd-shortcuts-section">
                        <h4>Playback</h4>
                        <div class="plexd-shortcut"><kbd>Space</kbd> Play/Pause</div>
                        <div class="plexd-shortcut"><kbd>M</kbd> Mute/unmute</div>
                        <div class="plexd-shortcut"><kbd>N</kbd> Solo (mute others)</div>
                        <div class="plexd-shortcut"><kbd>P</kbd> Pause all</div>
                        <div class="plexd-shortcut"><kbd>E</kbd> / <kbd>,</kbd> Seek back 10s · <kbd>EE</kbd> 60s</div>
                        <div class="plexd-shortcut"><kbd>R</kbd> / <kbd>.</kbd> Seek fwd 10s · <kbd>RR</kbd> 60s</div>
                        <div class="plexd-shortcut"><kbd>&lt;</kbd> <kbd>&gt;</kbd> Seek 60s</div>
                        <div class="plexd-shortcut"><kbd>;</kbd> <kbd>'</kbd> Frame step</div>
                        <div class="plexd-shortcut"><kbd>\\</kbd> Rewind to start</div>
                        <div class="plexd-shortcut"><kbd>|</kbd> Rewind all</div>
                        <div class="plexd-shortcut"><kbd>/</kbd> Random seek · <kbd>//</kbd> All</div>
                    </div>
                    <div class="plexd-shortcuts-section">
                        <h4>Stream Management</h4>
                        <div class="plexd-shortcut"><kbd>X</kbd> Close stream · <kbd>XX</kbd> Remove unstarred</div>
                        <div class="plexd-shortcut"><kbd>Shift+R</kbd> Reload stream</div>
                        <div class="plexd-shortcut"><kbd>D</kbd> Download stream</div>
                        <div class="plexd-shortcut"><kbd>=</kbd> Remove duplicates</div>
                    </div>
                    <div class="plexd-shortcuts-section">
                        <h4>Stars & Slots</h4>
                        <div class="plexd-shortcut"><kbd>Q</kbd> Star · <kbd>QQ</kbd> Filter starred</div>
                        <div class="plexd-shortcut"><kbd>\`</kbd> View starred only</div>
                        <div class="plexd-shortcut"><kbd>1-9</kbd> Assign to slot (tap)</div>
                        <div class="plexd-shortcut"><kbd>1-9</kbd> View slot (double-tap)</div>
                        <div class="plexd-shortcut"><kbd>0</kbd> View all streams</div>
                    </div>
                    <div class="plexd-shortcuts-section">
                        <h4>Layout Modes</h4>
                        <div class="plexd-shortcut"><kbd>T</kbd> Cycle Tetris mode</div>
                        <div class="plexd-shortcut"><kbd>Shift+T</kbd> Reset pan positions</div>
                        <div class="plexd-shortcut"><kbd>O</kbd> Toggle Coverflow</div>
                        <div class="plexd-shortcut"><kbd>W</kbd> Cycle Wall mode (Strips/Crop/Spotlight)</div>
                        <div class="plexd-shortcut"><kbd>A</kbd> Smart Zoom (face auto-pan)</div>
                        <div class="plexd-shortcut"><kbd>]</kbd> / <kbd>[</kbd> Rotate CW / CCW</div>
                        <div class="plexd-shortcut"><kbd>}</kbd> / <kbd>{</kbd> Shuffle randomly</div>
                        <div class="plexd-shortcut"><kbd>L</kbd> Force relayout (L = Layout)</div>
                        <div class="plexd-shortcut"><kbd>B</kbd> Toggle Bug Eye</div>
                        <div class="plexd-shortcut"><kbd>G</kbd> Toggle Mosaic</div>
                    </div>
                    <div class="plexd-shortcuts-section">
                        <h4>UI</h4>
                        <div class="plexd-shortcut"><kbd>H</kbd> Toggle header</div>
                        <div class="plexd-shortcut"><kbd>Shift+H</kbd> Clean mode</div>
                        <div class="plexd-shortcut"><kbd>V</kbd> / <kbd>Shift+V</kbd> Cycle views</div>
                        <div class="plexd-shortcut"><kbd>I</kbd> Stream info</div>
                        <div class="plexd-shortcut"><kbd>S</kbd> Streams panel</div>
                        <div class="plexd-shortcut"><kbd>C</kbd> Copy URL</div>
                        <div class="plexd-shortcut"><kbd>?</kbd> Toggle hints</div>
                    </div>
                </div>
                <div class="plexd-modal-actions">
                    <button id="shortcuts-modal-close" class="plexd-button plexd-button-primary">Done</button>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Cleanup function for consistent modal closing
        const cleanupModal = () => {
            document.removeEventListener('keydown', handleEscape, true);
            modal.remove();
        };

        document.getElementById('shortcuts-modal-close').addEventListener('click', cleanupModal);

        // Close on overlay click
        modal.addEventListener('click', (e) => {
            if (e.target === modal) cleanupModal();
        });

        // Close on Escape - capture phase to intercept before fullscreen exit
        const handleEscape = (e) => {
            if (e.key === 'Escape') {
                e.preventDefault();
                e.stopPropagation();
                e.stopImmediatePropagation();
                cleanupModal();
            }
        };
        document.addEventListener('keydown', handleEscape, true);
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
            await updateCombinationsList();
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
    async function updateCombinationsList() {
        const listEl = document.getElementById('combinations-list');
        if (!listEl) return;

        const combinations = getSavedCombinations();
        const names = Object.keys(combinations);

        if (names.length === 0) {
            listEl.innerHTML = '<div class="plexd-combo-empty">No saved combinations</div>';
            return;
        }

        // Build HTML for each set, fetching file sizes for those with local storage
        const items = await Promise.all(names.map(async name => {
            const combo = combinations[name];
            if (!combo) return '';

            const urlCount = (combo.urls || []).length;
            const localCount = (combo.localFiles || []).length;
            const totalCount = urlCount + localCount;
            const loginCount = (combo.loginDomains || []).length;
            const loginHint = loginCount > 0 ? ` · ${loginCount} login` : '';

            // Get saved file sizes if stored locally
            let storageInfo = '';
            let deleteLocalBtn = '';
            if (combo.localFilesSavedToDisc) {
                const files = await getSavedLocalFiles(name);
                const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);
                if (totalSize > 0) {
                    storageInfo = ` · ${formatBytes(totalSize)}`;
                    deleteLocalBtn = `<button class="plexd-combo-del-local" onclick="PlexdApp.deleteLocalFiles('${escapeAttr(name)}')" title="Delete stored files (${formatBytes(totalSize)})">🗑</button>`;
                }
            }

            return `
                <div class="plexd-combo-item" data-name="${escapeAttr(name)}">
                    <span class="plexd-combo-name">${escapeHtml(name)}</span>
                    <span class="plexd-combo-count">${totalCount} stream${totalCount !== 1 ? 's' : ''}${loginHint}${storageInfo}</span>
                    <div class="plexd-combo-buttons">
                        <button class="plexd-combo-load" onclick="PlexdApp.loadCombination('${escapeAttr(name)}')" title="Load (replace current)">Load</button>
                        <button class="plexd-combo-add" onclick="PlexdApp.addCombination('${escapeAttr(name)}')" title="Add to current streams">+Add</button>
                        <button class="plexd-combo-update" onclick="PlexdApp.updateCombination('${escapeAttr(name)}')" title="Update with current streams">Upd</button>
                        ${deleteLocalBtn}
                        <button class="plexd-combo-delete" onclick="PlexdApp.deleteCombination('${escapeAttr(name)}')" title="Delete this set">×</button>
                    </div>
                </div>
            `;
        }));

        listEl.innerHTML = items.join('');
    }

    /**
     * Delete only the local files for a set (keep the set metadata)
     */
    async function deleteLocalFilesOnly(name) {
        const combinations = JSON.parse(localStorage.getItem('plexd_combinations') || '{}');
        const combo = combinations[name];
        if (!combo || !combo.localFilesSavedToDisc) {
            showMessage('No local files to delete', 'info');
            return;
        }

        const files = await getSavedLocalFiles(name);
        const totalSize = files.reduce((sum, f) => sum + (f.size || 0), 0);

        if (!confirm(`Delete ${files.length} stored file(s) (${formatBytes(totalSize)}) for "${name}"?\n\nThe set will remain but you'll need to provide files when loading.`)) {
            return;
        }

        await deleteLocalFilesForSet(name);
        combo.localFilesSavedToDisc = false;
        localStorage.setItem('plexd_combinations', JSON.stringify(combinations));

        showMessage(`Deleted ${files.length} stored file(s)`, 'success');
        await updateCombinationsList();
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
        // Use JSON.stringify for safe JS string escaping (handles \, ', ", newlines, etc.)
        const jsonEscaped = JSON.stringify(text).slice(1, -1);
        return jsonEscaped.replace(/'/g, '&#39;').replace(/"/g, '&quot;');
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
        try {
            const saved = localStorage.getItem('plexd_history');
            if (saved) {
                const items = JSON.parse(saved);
                if (Array.isArray(items)) {
                    streamHistory.length = 0;
                    streamHistory.push(...items);
                }
            }
        } catch {
            // Corrupted localStorage — start fresh
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
                historyList.innerHTML = streamHistory.slice(0, 30).map((item, idx) => {
                    const ago = formatTimeAgo(item.timestamp);
                    const name = getHistoryDisplayName(item.url);
                    let domain = '';
                    try { domain = new URL(item.url).hostname.replace(/^www\./, ''); } catch {}
                    const isActive = PlexdStream.getAllStreams().some(s => s.url === item.url || s.sourceUrl === item.url);
                    return `
                        <div class="plexd-history-item${isActive ? ' plexd-history-active' : ''}" onclick="PlexdApp.addStream('${escapeAttr(item.url)}')">
                            <div class="plexd-history-info">
                                <span class="plexd-history-name">${escapeHtml(name)}</span>
                                <span class="plexd-history-meta">${escapeHtml(domain)}${domain ? ' · ' : ''}${ago}</span>
                            </div>
                            <button class="plexd-history-delete" onclick="event.stopPropagation(); PlexdApp.removeHistoryItem(${idx})" title="Remove">✕</button>
                        </div>
                    `;
                }).join('');
            }
        }
    }

    function getHistoryDisplayName(url) {
        if (!url) return 'Unknown';
        if (url.startsWith('blob:')) return 'Local File';
        if (url.startsWith('data:')) return 'Embedded Video';
        try {
            const urlObj = new URL(url, window.location.origin);
            // For server files, fileId is the original filename
            if (urlObj.pathname.startsWith('/api/files/') || urlObj.pathname.startsWith('/api/hls/')) {
                const parts = urlObj.pathname.split('/').filter(p => p);
                const fileId = parts[parts.length - 1];
                if (fileId && fileId.length > 3) {
                    return decodeURIComponent(fileId).replace(/\.[^.]+$/, '').replace(/[-_.]+/g, ' ');
                }
            }
            // For external URLs, walk path segments and skip generic HLS names
            const parts = urlObj.pathname.split('/').filter(p => p);
            const genericNames = ['master', 'playlist', 'index', 'stream', 'video', 'chunklist', 'media', 'hls'];
            for (let i = parts.length - 1; i >= 0; i--) {
                const seg = decodeURIComponent(parts[i].split('?')[0]);
                const base = seg.replace(/\.(m3u8|ts|mp4|mpd|key|webm|ogg)$/i, '');
                if (base.length > 3 && !genericNames.includes(base.toLowerCase())) {
                    return base.replace(/[-_.]+/g, ' ');
                }
            }
            return urlObj.hostname.replace(/^www\./, '');
        } catch {
            return url.substring(0, 40);
        }
    }

    function removeHistoryItem(index) {
        if (index >= 0 && index < streamHistory.length) {
            streamHistory.splice(index, 1);
            saveHistory();
            updateHistoryUI();
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

    // Sets panel keyboard navigation state
    let selectedSetIndex = -1;

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
                    selectedSetIndex = -1; // Reset selection
                } else if (panelId === 'streams-panel') {
                    updateStreamsPanelUI();
                } else if (panelId === 'history-panel') {
                    updateHistoryUI();
                }
            } else {
                selectedSetIndex = -1; // Reset when closing
            }
            panel.classList.toggle('plexd-panel-open');
        }
    }

    /**
     * Handle keyboard navigation in Sets panel
     */
    function handleSetsPanelKeyboard(e) {
        const panel = document.getElementById('saved-panel');
        if (!panel || !panel.classList.contains('plexd-panel-open')) return false;

        // Escape closes the panel
        if (e.key === 'Escape') {
            e.preventDefault();
            panel.classList.remove('plexd-panel-open');
            selectedSetIndex = -1;
            return true;
        }

        // F opens Files modal (works even with no saved sets)
        if (e.key === 'f' || e.key === 'F') {
            e.preventDefault();
            showManageStoredFilesModal();
            return true;
        }

        const items = panel.querySelectorAll('.plexd-combo-item');
        if (items.length === 0) return false;

        if (e.key === 'ArrowDown') {
            e.preventDefault();
            selectedSetIndex = Math.min(selectedSetIndex + 1, items.length - 1);
            updateSetSelection(items);
            return true;
        } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            selectedSetIndex = Math.max(selectedSetIndex - 1, 0);
            updateSetSelection(items);
            return true;
        } else if (e.key === 'Enter' && selectedSetIndex >= 0) {
            e.preventDefault();
            const selectedItem = items[selectedSetIndex];
            if (selectedItem) {
                const name = selectedItem.dataset.name;
                if (name) loadStreamCombination(name);
            }
            return true;
        }
        return false;
    }

    /**
     * Update visual selection in Sets panel
     */
    function updateSetSelection(items) {
        items.forEach((item, i) => {
            if (i === selectedSetIndex) {
                item.classList.add('plexd-combo-selected');
                item.scrollIntoView({ block: 'nearest' });
            } else {
                item.classList.remove('plexd-combo-selected');
            }
        });
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
            const isVisible = !stream.hidden;
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
            const visibilityIcon = isVisible ? '👁' : '👁‍🗨';
            const visibilityTitle = isVisible ? 'Hide from grid' : 'Show in grid';
            const hiddenClass = stream.hidden ? 'hidden-stream' : '';

            return `
                <div class="plexd-stream-item ${isSelected ? 'selected' : ''} ${isLocal ? 'local-file' : ''} ${hiddenClass}"
                     data-stream-id="${stream.id}"
                     onclick="PlexdApp.selectAndFocusStream('${stream.id}')">
                    <span class="plexd-stream-visibility ${isVisible ? 'visible' : 'hidden'}"
                          onclick="event.stopPropagation(); PlexdApp.toggleStreamVisibility('${stream.id}')"
                          title="${visibilityTitle}">${visibilityIcon}</span>
                    <span class="plexd-stream-type ${isLocal ? 'local' : 'stream'}">${isLocal ? 'FILE' : 'URL'}</span>
                    <div class="plexd-stream-info">
                        <div class="plexd-stream-name">${escapeHtml(displayName)}${ratingDisplay}</div>
                        <div class="plexd-stream-url">${escapeHtml(displayUrl)}</div>
                        <div class="plexd-stream-status ${stateClass}">${stateIcon} ${stream.state}${stream.hidden ? ' (hidden)' : ''}</div>
                    </div>
                    <div class="plexd-stream-actions">
                        <button class="plexd-stream-btn download"
                                onclick="event.stopPropagation(); PlexdApp.downloadStream('${stream.id}')"
                                title="Download stream">⬇</button>
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
     * Get a meaningful download filename from URL (skips generic HLS names)
     */
    function getDownloadName(url) {
        try {
            const urlObj = new URL(url, window.location.origin);
            const parts = urlObj.pathname.split('/').filter(p => p);
            const genericNames = ['master', 'playlist', 'index', 'stream', 'video', 'chunklist', 'media'];
            // Walk path segments from end, skip generic HLS names
            for (let i = parts.length - 1; i >= 0; i--) {
                const seg = decodeURIComponent(parts[i].split('?')[0]);
                const base = seg.replace(/\.(m3u8|ts|mp4|key)$/i, '');
                if (base.length > 3 && !genericNames.includes(base.toLowerCase())) {
                    return base + '.mp4';
                }
            }
            return urlObj.hostname.replace(/\./g, '-') + '.mp4';
        } catch {
            return 'download.mp4';
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
     * Toggle stream visibility in grid from the streams panel
     */
    function toggleStreamVisibility(streamId) {
        const isNowHidden = PlexdStream.toggleStreamVisibility(streamId);
        const stream = PlexdStream.getStream(streamId);
        const name = stream ? (stream.fileName || getStreamDisplayName(stream.url)) : 'Stream';
        showMessage(isNowHidden ? `Hidden: ${name}` : `Showing: ${name}`, 'info');
        updateStreamsPanelUI();
    }

    /**
     * Show all hidden streams
     */
    function showAllStreams() {
        PlexdStream.showAllStreams();
        showMessage('All streams visible', 'info');
        updateStreamsPanelUI();
    }

    /**
     * Download a stream to disc
     */
    // Track active download polls to avoid duplicate polling for the same job
    const activeDownloadPolls = new Map(); // jobId → intervalId

    /**
     * Queue a background HLS download and poll for progress.
     * Returns the jobId, or null on failure.
     */
    async function queueHlsDownload(hlsUrl, fileName) {
        const dlUrl = `/api/proxy/hls/download?url=${encodeURIComponent(hlsUrl)}&name=${encodeURIComponent(fileName)}`;
        const res = await fetch(dlUrl);
        const data = await res.json();
        if (!res.ok || !data.jobId) {
            throw new Error(data.error || 'Failed to queue download');
        }

        const jobId = data.jobId;

        // Server returned an existing job (dedup) and we're already polling it
        if (data.deduplicated && activeDownloadPolls.has(jobId)) {
            showMessage(`Already downloading: ${fileName}`, 'info');
            return jobId;
        }

        showMessage(`Download queued: ${fileName}`, 'info');

        // Poll for progress (bail after consecutive failures to avoid zombie intervals)
        let pollFailures = 0;
        const pollId = setInterval(async () => {
            try {
                const statusRes = await fetch(`/api/downloads/status?jobId=${encodeURIComponent(jobId)}`);

                // Job vanished (server restart) or unexpected response
                if (!statusRes.ok) {
                    pollFailures++;
                    if (pollFailures >= 5) {
                        clearInterval(pollId);
                        activeDownloadPolls.delete(jobId);
                        showMessage(`Download lost (server restarted?): ${fileName}`, 'error');
                    }
                    return;
                }

                const status = await statusRes.json();
                pollFailures = 0; // Reset on successful response

                if (status.status === 'downloading') {
                    showMessage(`Downloading: ${fileName} (${status.progress}%)`, 'info');
                } else if (status.status === 'complete') {
                    clearInterval(pollId);
                    activeDownloadPolls.delete(jobId);
                    showMessage(`Download ready: ${fileName}`, 'success');
                    // Trigger browser download of the completed file
                    const a = document.createElement('a');
                    a.href = `/api/downloads/file?jobId=${encodeURIComponent(jobId)}`;
                    a.download = fileName.replace(/\.m3u8$/, '.mp4');
                    document.body.appendChild(a);
                    a.click();
                    document.body.removeChild(a);
                } else if (status.status === 'failed') {
                    clearInterval(pollId);
                    activeDownloadPolls.delete(jobId);
                    showMessage(`Download failed: ${fileName} — ${status.error || 'unknown error'}`, 'error');
                }
                // 'queued' status — just keep polling
            } catch (e) {
                // Network error — tolerate a few before giving up
                pollFailures++;
                if (pollFailures >= 5) {
                    clearInterval(pollId);
                    activeDownloadPolls.delete(jobId);
                    showMessage(`Download lost (connection error): ${fileName}`, 'error');
                }
            }
        }, 2000);

        activeDownloadPolls.set(jobId, pollId);
        return jobId;
    }

    async function downloadStream(streamId) {
        const stream = PlexdStream.getStream(streamId);
        if (!stream) {
            showMessage('Stream not found', 'error');
            return;
        }

        const url = stream.url;
        const fileId = extractServerFileId(url) || extractServerFileId(stream.serverUrl);
        // For server files, fileId IS the original filename (e.g. "scene-1.1080p.mp4")
        // For external HLS, use stream.fileName or derive from URL (skip generic "master"/"playlist")
        const fileName = stream.fileName || (fileId ? fileId : getDownloadName(url));

        try {
            // 1. Server-hosted file: download the original from server
            if (fileId) {
                showMessage(`Downloading: ${fileName}...`, 'info');
                const downloadUrl = `/api/files/${encodeURIComponent(fileId)}`;
                try {
                    const response = await fetch(downloadUrl, { method: 'HEAD' });
                    if (response.ok) {
                        // Original file exists - download it directly
                        const a = document.createElement('a');
                        a.href = downloadUrl;
                        a.download = fileName.replace(/\.m3u8$/, '.mp4');
                        document.body.appendChild(a);
                        a.click();
                        document.body.removeChild(a);
                        showMessage(`Download started: ${fileName}`, 'success');
                        return;
                    }
                } catch (e) { /* fall through */ }
                // Original deleted - remux the HLS via background download
                const hlsUrl = url.includes('.m3u8') ? url : (stream.serverUrl || url);
                if (hlsUrl.includes('.m3u8')) {
                    const absHlsUrl = new URL(hlsUrl, window.location.origin).href;
                    await queueHlsDownload(absHlsUrl, fileName);
                    return;
                }
                showMessage('Original file deleted and no HLS available', 'error');
                return;
            }

            // 2. External HLS: background download via server (ffmpeg remuxes segments into MP4)
            if (url.toLowerCase().includes('.m3u8')) {
                await queueHlsDownload(url, fileName);
                return;
            }

            showMessage(`Downloading: ${fileName}...`, 'info');

            // 3. Blob URLs (dropped files) - download directly
            if (isBlobUrl(url)) {
                const response = await fetch(url);
                const blob = await response.blob();
                triggerDownload(blob, fileName);
                showMessage(`Downloaded: ${fileName}`, 'success');
                return;
            }

            // 4. Regular URLs - try to fetch (may fail due to CORS)
            try {
                const response = await fetch(url);
                if (!response.ok) throw new Error('Fetch failed');
                const blob = await response.blob();
                triggerDownload(blob, fileName);
                showMessage(`Downloaded: ${fileName}`, 'success');
            } catch (fetchError) {
                // CORS blocked - try proxying through our server
                try {
                    const proxyUrl = `/api/proxy/hls?url=${encodeURIComponent(url)}`;
                    const response = await fetch(proxyUrl);
                    if (response.ok) {
                        const blob = await response.blob();
                        triggerDownload(blob, fileName);
                        showMessage(`Downloaded: ${fileName}`, 'success');
                        return;
                    }
                } catch (e) { /* fall through */ }
                // Final fallback: open in new tab
                const a = document.createElement('a');
                a.href = url;
                a.download = fileName;
                a.target = '_blank';
                a.rel = 'noopener noreferrer';
                document.body.appendChild(a);
                a.click();
                document.body.removeChild(a);
                showMessage(`Opening download in new tab: ${fileName}`, 'info');
            }
        } catch (err) {
            console.error('[Plexd] Download failed:', err);
            showMessage(`Download failed: ${err.message}`, 'error');
        }
    }

    /**
     * Trigger browser download of a blob
     */
    function triggerDownload(blob, fileName) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);
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
     * Find existing stream that matches by URL, fileName, or server fileId
     * Used for duplicate detection when adding streams
     */
    function findDuplicateStream(url, fileName = null) {
        const allStreams = PlexdStream.getAllStreams();
        const urlKey = urlEqualityKey(url);
        const serverFileId = extractServerFileId(url);

        return allStreams.find(s => {
            // Check by URL
            if (urlEqualityKey(s.url) === urlKey) return true;

            // Check by server fileId (handles /api/files/ vs /api/hls/ for same file)
            if (serverFileId) {
                const existingFileId = extractServerFileId(s.url) || extractServerFileId(s.serverUrl);
                if (existingFileId && existingFileId.toLowerCase() === serverFileId.toLowerCase()) return true;
                // Also check if stream fileName matches the fileId (blob URL for same file)
                if (s.fileName && s.fileName.toLowerCase() === serverFileId.toLowerCase()) return true;
            }

            // Check by fileName (handles blob URL vs server URL for same file)
            if (fileName) {
                if (s.fileName && s.fileName.toLowerCase() === fileName.toLowerCase()) return true;
                // Check if existing stream's server fileId matches our fileName
                const existingFileId = extractServerFileId(s.url) || extractServerFileId(s.serverUrl);
                if (existingFileId && existingFileId.toLowerCase() === fileName.toLowerCase()) return true;
            }

            return false;
        });
    }

    /**
     * Extract server fileId from URL patterns:
     * - /api/files/{fileId}
     * - /api/hls/{fileId}/playlist.m3u8
     * Returns null if not a server file URL
     */
    function extractServerFileId(url) {
        if (!url) return null;
        // Match /api/files/{fileId} - handle both relative and absolute URLs
        const filesMatch = url.match(/\/api\/files\/([^/?]+)/);
        if (filesMatch) return decodeURIComponent(filesMatch[1]);
        // Match /api/hls/{fileId}/... - handle both relative and absolute URLs
        const hlsMatch = url.match(/\/api\/hls\/([^/?]+)/);
        if (hlsMatch) return decodeURIComponent(hlsMatch[1]);
        return null;
    }

    /**
     * Check if URL is an HLS stream (transcoded version)
     * Handles both relative (/api/hls/) and absolute URLs
     */
    function isHlsServerUrl(url) {
        return url && url.includes('/api/hls/');
    }

    /**
     * Remove duplicate streams, preferring HLS (transcoded) over originals
     * Detects duplicates by: server fileId, fileName, or normalized URL
     */
    function removeDuplicateStreams() {
        const allStreams = PlexdStream.getAllStreams();
        // Map of key -> { stream, isHls }
        const streamsByKey = new Map();
        const duplicates = [];

        allStreams.forEach(stream => {
            let key;
            const isHls = isHlsServerUrl(stream.url) || isHlsServerUrl(stream.serverUrl);

            // Try to extract server fileId first (handles both /api/files/ and /api/hls/)
            const fileId = extractServerFileId(stream.url) || extractServerFileId(stream.serverUrl);
            if (fileId) {
                key = 'server:' + fileId.toLowerCase();
            } else if (isBlobUrl(stream.url) && stream.fileName) {
                // For local files (blob URLs), use filename as key
                key = 'file:' + stream.fileName.toLowerCase();
            } else {
                // For other URLs, normalize for comparison
                key = urlEqualityKey(stream.url);
            }

            const existing = streamsByKey.get(key);
            if (existing) {
                // Duplicate found - decide which to keep
                // Prefer HLS version over original
                if (isHls && !existing.isHls) {
                    // New stream is HLS, existing is original - remove existing
                    duplicates.push(existing.stream.id);
                    streamsByKey.set(key, { stream, isHls });
                } else {
                    // Keep existing, remove new
                    duplicates.push(stream.id);
                }
            } else {
                streamsByKey.set(key, { stream, isHls });
            }
        });

        if (duplicates.length === 0) {
            showMessage('No duplicates found', 'info');
            return;
        }

        // Remove duplicates
        duplicates.forEach(id => {
            PlexdStream.removeStream(id);
        });

        updateStreamCount();
        updateStreamsPanelUI();
        saveCurrentStreams();
        showMessage(`Removed ${duplicates.length} duplicate stream${duplicates.length !== 1 ? 's' : ''}`, 'success');
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

    /**
     * Rewind selected or focused stream to beginning
     */
    function rewindSelected() {
        const selected = PlexdStream.getSelectedStream();
        const fullscreen = PlexdStream.getFullscreenStream();
        const target = fullscreen || selected;

        if (!target) {
            showMessage('Select a stream first', 'info');
            return;
        }

        if (target.video) {
            target.video.currentTime = 0;
            syncOverlayClones();
            showMessage('Rewound to start', 'success');
        }
    }

    /**
     * Rewind all streams to beginning
     */
    function rewindAll() {
        const streams = PlexdStream.getAllStreams();
        let count = 0;

        streams.forEach(stream => {
            if (stream.video) {
                stream.video.currentTime = 0;
                count++;
            }
        });

        syncOverlayClones();
        showMessage(`Rewound ${count} stream${count !== 1 ? 's' : ''} to start`, 'success');
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
        updateCombination: updateStreamCombination,
        addCombination: addStreamCombination,
        deleteCombination: deleteStreamCombination,
        deleteLocalFiles: deleteLocalFilesOnly,
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
        removeHistoryItem,
        togglePanel,
        openPanel,
        // Streams panel
        selectAndFocusStream,
        closeStreamFromPanel,
        reloadStreamFromPanel,
        downloadStream,
        reloadAllStreams,
        closeAllStreams,
        removeDuplicateStreams,
        // Visibility control
        toggleStreamVisibility,
        showAllStreams,
        // View modes
        setViewMode,
        cycleViewMode,
        // Layout modes
        toggleTetrisMode,
        cycleTetrisMode,
        toggleCoverflowMode,
        toggleSmartLayoutMode, // Legacy alias for Coverflow
        cycleWallMode,
        toggleFaceDetection,
        rotateStreams,
        forceRelayout,
        // Theater / Advanced mode
        toggleTheaterAdvanced,
        nextScene,
        prevScene,
        setTheaterScene,
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
        randomSeekSelected,
        rewindSelected,
        rewindAll,
        // File management
        showManageStoredFilesModal,
        // Stream cleanup (called by stream.js when streams are removed)
        stopTranscodePollForStream,
        // Help
        showShortcutsModal
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
                if (action === 'stateUpdate') return; // Ignore state broadcasts from ourselves
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
                        console.log('[Remote] Polled command:', cmd.action);
                        handleRemoteCommand(cmd.action, cmd.payload);
                    }
                }
            } catch (e) {
                // Network error - silently continue, next poll will retry
            }

            // Always check localStorage fallback
            const cmdData = localStorage.getItem(COMMAND_KEY);
            if (cmdData) {
                try {
                    const cmd = JSON.parse(cmdData);
                    if (Date.now() - cmd.timestamp < COMMAND_FRESHNESS_MS) {
                        localStorage.removeItem(COMMAND_KEY);
                        handleRemoteCommand(cmd.action, cmd.payload);
                    } else {
                        localStorage.removeItem(COMMAND_KEY);
                    }
                } catch (err) {
                    localStorage.removeItem(COMMAND_KEY);
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
        console.log('[Remote] Command received:', action, payload);
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
                    // Remote sends absolute time in seconds, seekTo expects 0-1 position
                    const seekStream = PlexdStream.getStream(payload.streamId);
                    if (seekStream?.video?.duration > 0) {
                        const position = payload.time / seekStream.video.duration;
                        PlexdStream.seekTo(payload.streamId, position);
                    }
                }
                sendState();
                break;
            case 'seekRelative':
                if (payload.streamId && typeof payload.offset === 'number') {
                    PlexdStream.seekRelative(payload.streamId, payload.offset);
                }
                sendState();
                break;
            case 'randomSeek':
                if (payload.streamId) {
                    PlexdStream.seekToRandomPosition(payload.streamId);
                }
                sendState();
                break;
            case 'randomSeekAll':
                PlexdStream.seekAllToRandomPosition();
                sendState();
                break;

            // Selection/Navigation
            case 'selectStream':
                PlexdStream.selectStream(payload.streamId || null);
                // If in any focused mode, switch focus to the selected stream
                const modeSelect = PlexdStream.getFullscreenMode();
                if (payload.streamId && (modeSelect === 'true-focused' || modeSelect === 'browser-fill')) {
                    PlexdStream.enterFocusedMode(payload.streamId);
                }
                sendState();
                break;
            case 'selectNext':
                PlexdStream.selectNextStream(payload.direction || 'right');
                // If in any focused mode, switch focus to the newly selected stream
                const modeNext = PlexdStream.getFullscreenMode();
                if (modeNext === 'true-focused' || modeNext === 'browser-fill') {
                    const selected = PlexdStream.getSelectedStream();
                    if (selected) {
                        PlexdStream.enterFocusedMode(selected.id);
                    }
                }
                sendState();
                break;

            // Fullscreen
            case 'enterFullscreen':
                console.log('[Remote] enterFullscreen called, streamId:', payload.streamId);
                if (payload.streamId) {
                    PlexdStream.enterFocusedMode(payload.streamId);
                } else {
                    PlexdStream.enterGridFullscreen();
                }
                sendState();
                break;
            case 'exitFullscreen':
                console.log('[Remote] exitFullscreen called');
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
                console.log('[Remote] toggleGlobalFullscreen called');
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
            case 'cycleWallMode':
                PlexdApp.cycleWallMode();
                sendState();
                break;
            case 'toggleFaceDetection':
                PlexdApp.toggleFaceDetection();
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
            case 'queueStream':
                if (payload.url) {
                    PlexdApp.addToQueue(payload.url);
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
        // Get thumbnails for all streams (captures video frames)
        const thumbnails = PlexdStream.getAllThumbnails ? PlexdStream.getAllThumbnails() : {};

        const streams = PlexdStream.getAllStreams().map(s => ({
            id: s.id,
            url: s.url,
            // Include server URL for remote playback (local files use blob: URLs which don't work remotely)
            serverUrl: s.serverUrl || null,
            state: s.state,
            paused: s.video ? s.video.paused : true,
            muted: s.video ? s.video.muted : true,
            currentTime: s.video ? s.video.currentTime : 0,
            duration: s.video ? s.video.duration : 0,
            aspectRatio: s.aspectRatio,
            rating: PlexdStream.getRating(s.url),
            fileName: s.fileName || null,
            thumbnail: thumbnails[s.id] || null
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
            wallMode: window.PlexdAppState?.wallMode || 0,
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
            // Network error - silently continue
        });

        // localStorage fallback (always use)
        try {
            localStorage.setItem(STATE_KEY, JSON.stringify(state));
        } catch (e) {
            // localStorage might be full or unavailable
        }
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
    get wallMode() {
        return window._plexdWallMode || 0;
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
