/**
 * Plexd Extension - Background Service Worker
 *
 * Manages badge count and tab cleanup.
 * Stream detection handled by intercept.js (MAIN world) + content.js + popup.js Performance API.
 */

// Badge count per tab (from content.js reports)
const tabCounts = new Map();

/**
 * Handle messages from content scripts
 */
chrome.runtime.onMessage.addListener((message, sender) => {
    if (message.action === 'videosDetected' && sender.tab) {
        tabCounts.set(sender.tab.id, message.count);
        updateBadge(sender.tab.id, message.count);
    }
    if (message.action === 'streamIntercepted' && sender.tab) {
        const current = tabCounts.get(sender.tab.id) || 0;
        tabCounts.set(sender.tab.id, current + 1);
        updateBadge(sender.tab.id, current + 1);
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
        tabCounts.delete(tabId);
        chrome.storage.local.remove(['intercepted_' + tabId]);
        chrome.action.setBadgeText({ text: '', tabId });
    }
});

/**
 * Clean up when tab closes
 */
chrome.tabs.onRemoved.addListener((tabId) => {
    tabCounts.delete(tabId);
    chrome.storage.local.remove(['intercepted_' + tabId]);
});

chrome.runtime.onInstalled.addListener(() => {
    console.log('[Plexd] Extension v2.0 installed');
});
