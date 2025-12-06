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

        // Connect stream manager to layout updates
        PlexdStream.setLayoutUpdateCallback(updateLayout);

        // Handle window resize
        window.addEventListener('resize', debounce(updateLayout, 100));

        // Listen for extension messages
        setupExtensionListener();

        // Load streams from URL parameters (from extension)
        loadStreamsFromUrl();

        console.log('Plexd initialized');
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

            // Clear URL params
            if (window.history.replaceState) {
                window.history.replaceState({}, '', window.location.pathname);
            }
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

        // F key for true fullscreen on fullscreen stream
        document.addEventListener('keydown', (e) => {
            if (e.target.tagName === 'INPUT') return;

            if (e.key === 'f' || e.key === 'F') {
                const fullscreenStream = PlexdStream.getFullscreenStream && PlexdStream.getFullscreenStream();
                if (fullscreenStream) {
                    PlexdStream.toggleTrueFullscreen(fullscreenStream.id);
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
        console.log('[Plexd] addStream called with:', url);
        console.log('[Plexd] Current stream count:', PlexdStream.getStreamCount());

        const stream = PlexdStream.createStream(url, {
            autoplay: true,
            muted: true
        });

        containerEl.appendChild(stream.wrapper);
        updateStreamCount();
        updateLayout();

        console.log('[Plexd] New stream count:', PlexdStream.getStreamCount());
        console.log('[Plexd] All streams:', PlexdStream.getAllStreams().map(s => s.id));
        showMessage(`Added stream: ${truncateUrl(url)}`, 'success');
    }

    /**
     * Update the grid layout
     */
    function updateLayout() {
        if (!containerEl) return;

        const streams = PlexdStream.getAllStreams();
        if (streams.length === 0) {
            showEmptyState();
            return;
        }

        hideEmptyState();

        const container = {
            width: containerEl.clientWidth,
            height: containerEl.clientHeight
        };

        const layout = PlexdGrid.calculateLayout(container, streams);
        PlexdGrid.applyLayout(containerEl, layout, PlexdStream.getVideoElements());

        // Update efficiency display if element exists
        const efficiencyEl = document.getElementById('layout-efficiency');
        if (efficiencyEl) {
            efficiencyEl.textContent = Math.round(layout.efficiency * 100) + '%';
        }
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
    function showEmptyState() {
        let emptyState = document.getElementById('empty-state');
        if (!emptyState) {
            emptyState = document.createElement('div');
            emptyState.id = 'empty-state';
            emptyState.className = 'plexd-empty-state';
            emptyState.innerHTML = `
                <h2>No Streams</h2>
                <p>Enter a video URL above to add your first stream</p>
            `;
            containerEl.appendChild(emptyState);
        }
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
        // Ignore if typing in input
        if (e.target.tagName === 'INPUT') return;

        const selected = PlexdStream.getSelectedStream();

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
                PlexdStream.selectNextStream('right');
                break;
            case 'ArrowLeft':
                e.preventDefault();
                PlexdStream.selectNextStream('left');
                break;
            case 'ArrowUp':
                e.preventDefault();
                PlexdStream.selectNextStream('up');
                break;
            case 'ArrowDown':
                e.preventDefault();
                PlexdStream.selectNextStream('down');
                break;
            case 'Enter':
                if (selected) {
                    PlexdStream.toggleFullscreen(selected.id);
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
                // Exit fullscreen or deselect
                const fullscreenStream = PlexdStream.getFullscreenStream();
                if (fullscreenStream) {
                    PlexdStream.toggleFullscreen(fullscreenStream.id);
                } else {
                    PlexdStream.selectStream(null);
                }
                if (inputEl) inputEl.blur();
                break;
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

    /**
     * Save current streams to localStorage
     */
    function saveCurrentStreams() {
        const streams = PlexdStream.getAllStreams();
        const urls = streams.map(s => s.url);
        localStorage.setItem('plexd_streams', JSON.stringify(urls));
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

        const name = prompt('Enter a name for this stream combination:');
        if (!name) return;

        const combinations = JSON.parse(localStorage.getItem('plexd_combinations') || '{}');
        combinations[name] = {
            urls: streams.map(s => s.url),
            savedAt: Date.now()
        };
        localStorage.setItem('plexd_combinations', JSON.stringify(combinations));
        showMessage(`Saved combination: ${name}`, 'success');
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
            return `
                <div class="plexd-combo-item" data-name="${escapeAttr(name)}">
                    <span class="plexd-combo-name">${escapeHtml(name)}</span>
                    <span class="plexd-combo-count">${combo.urls.length} streams</span>
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
        getSavedCombinations
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
