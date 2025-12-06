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
     * Load streams from URL parameters
     * Supports: ?streams=url1,url2,url3
     */
    function loadStreamsFromUrl() {
        const params = new URLSearchParams(window.location.search);
        const streamsParam = params.get('streams');

        console.log('[Plexd] URL params:', window.location.search);
        console.log('[Plexd] streams param:', streamsParam);

        if (streamsParam) {
            // Split by ||| separator (URLs can contain commas, so we use a unique separator)
            const urls = streamsParam.split('|||').map(s => decodeURIComponent(s.trim()));
            console.log('[Plexd] Parsed URLs:', urls);

            let addedCount = 0;
            urls.forEach(url => {
                console.log('[Plexd] Checking URL:', url, 'valid:', isValidUrl(url));
                if (url && isValidUrl(url)) {
                    addStream(url);
                    addedCount++;
                }
            });
            console.log('[Plexd] Added', addedCount, 'streams');

            // Clear URL params after loading (cleaner URL)
            if (urls.length > 0 && window.history.replaceState) {
                window.history.replaceState({}, '', window.location.pathname);
            }
        }
    }

    /**
     * Set up UI event listeners
     */
    function setupEventListeners() {
        // Add stream button
        if (addButtonEl) {
            addButtonEl.addEventListener('click', handleAddStream);
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

        switch (e.key) {
            case ' ':
                e.preventDefault();
                togglePlayPause();
                break;
            case 'm':
            case 'M':
                PlexdStream.muteAll();
                showMessage('All streams muted', 'info');
                break;
            case 'Escape':
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
        showMessage
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
