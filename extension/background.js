/**
 * Plexd Extension - Background Service Worker
 *
 * Handles extension lifecycle, badge updates, and message routing.
 * Note: Network interception for video URLs would require webRequest API
 * which has limitations in Manifest V3. Content script detection is primary.
 */

// Track video counts per tab
const tabVideoCounts = new Map();

/**
 * Update badge when videos are detected
 */
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.action === 'videosDetected' && sender.tab) {
        const tabId = sender.tab.id;
        const count = message.count;

        tabVideoCounts.set(tabId, count);
        updateBadge(tabId, count);
    }

    // Handle addStreams for Plexd tab
    if (message.action === 'addStreams') {
        // Forward to content script in active tab
        chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
            if (tabs[0]) {
                chrome.tabs.sendMessage(tabs[0].id, message);
            }
        });
    }

    return true;
});

/**
 * Update extension badge with video count
 */
function updateBadge(tabId, count) {
    if (count > 0) {
        chrome.action.setBadgeText({ text: count.toString(), tabId });
        chrome.action.setBadgeBackgroundColor({ color: '#6366f1', tabId });
    } else {
        chrome.action.setBadgeText({ text: '', tabId });
    }
}

/**
 * Clear badge when tab is updated
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
        tabVideoCounts.delete(tabId);
        chrome.action.setBadgeText({ text: '', tabId });
    }
});

/**
 * Clean up when tab is closed
 */
chrome.tabs.onRemoved.addListener((tabId) => {
    tabVideoCounts.delete(tabId);
});

/**
 * Handle extension install/update
 */
chrome.runtime.onInstalled.addListener((details) => {
    if (details.reason === 'install') {
        console.log('Plexd extension installed');
    }
});
