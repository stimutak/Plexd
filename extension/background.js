/**
 * Plexd Extension - Background Service Worker
 *
 * Detects HLS/DASH stream URLs via webRequest API.
 * Stores intercepted URLs per tab for popup access.
 */

// In-memory stream storage (per tab)
const tabStreams = new Map();

/**
 * Check if URL is an HLS/DASH stream manifest
 */
function isStreamUrl(url) {
    const lower = url.toLowerCase();
    return lower.includes('.m3u8') || lower.includes('.mpd');
}

/**
 * webRequest listener - catches ALL network requests from all frames/workers
 */
chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
        if (details.tabId < 0) return; // Not from a tab
        if (!isStreamUrl(details.url)) return;

        if (!tabStreams.has(details.tabId)) tabStreams.set(details.tabId, new Set());
        tabStreams.get(details.tabId).add(details.url);

        const count = tabStreams.get(details.tabId).size;
        updateBadge(details.tabId, count);

        // Persist so popup can read even if service worker restarts
        chrome.storage.local.set({
            ['intercepted_' + details.tabId]: Array.from(tabStreams.get(details.tabId))
        });
    },
    { urls: ["<all_urls>"] }
);

/**
 * Handle messages from content scripts
 */
chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.action === 'videosDetected' && sender.tab) {
        // Only show DOM video count if no streams intercepted
        if (!tabStreams.has(sender.tab.id) || tabStreams.get(sender.tab.id).size === 0) {
            updateBadge(sender.tab.id, message.count);
        }
    }
});

/**
 * Update extension badge
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
 * Clear data when tab navigates
 */
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading') {
        tabStreams.delete(tabId);
        chrome.storage.local.remove(['intercepted_' + tabId]);
        chrome.action.setBadgeText({ text: '', tabId });
    }
});

/**
 * Clean up when tab closes
 */
chrome.tabs.onRemoved.addListener((tabId) => {
    tabStreams.delete(tabId);
    chrome.storage.local.remove(['intercepted_' + tabId]);
});

chrome.runtime.onInstalled.addListener(() => {
    console.log('[Plexd] Extension installed');
});
