/**
 * Plexd Extension - Content Script
 *
 * Runs on every page to detect video elements and their sources.
 * Responds to requests from the popup to list available videos.
 */

(function() {
    'use strict';

    /**
     * Find all video sources on the current page
     * @returns {Array} Array of video source objects
     */
    function findVideoSources() {
        const sources = [];
        const seen = new Set();

        // 1. Find <video> elements with src attribute
        document.querySelectorAll('video[src]').forEach(video => {
            const src = video.src;
            if (src && !seen.has(src) && isValidVideoUrl(src)) {
                seen.add(src);
                sources.push({
                    type: 'video',
                    url: src,
                    title: getVideoTitle(video),
                    duration: video.duration || null,
                    playing: !video.paused
                });
            }
        });

        // 2. Find <video> elements with <source> children
        document.querySelectorAll('video').forEach(video => {
            video.querySelectorAll('source[src]').forEach(source => {
                const src = source.src;
                if (src && !seen.has(src) && isValidVideoUrl(src)) {
                    seen.add(src);
                    sources.push({
                        type: 'source',
                        url: src,
                        title: getVideoTitle(video),
                        mimeType: source.type || null
                    });
                }
            });

            // Also check currentSrc (the actually playing source)
            if (video.currentSrc && !seen.has(video.currentSrc)) {
                seen.add(video.currentSrc);
                sources.push({
                    type: 'currentSrc',
                    url: video.currentSrc,
                    title: getVideoTitle(video),
                    duration: video.duration || null,
                    playing: !video.paused
                });
            }
        });

        // 3. Find iframes that might contain videos (YouTube, Vimeo embeds)
        document.querySelectorAll('iframe').forEach(iframe => {
            const src = iframe.src;
            if (src && !seen.has(src)) {
                const embedInfo = parseEmbedUrl(src);
                if (embedInfo) {
                    seen.add(src);
                    sources.push({
                        type: 'embed',
                        url: src,
                        embedType: embedInfo.type,
                        videoId: embedInfo.id,
                        title: iframe.title || embedInfo.type + ' video'
                    });
                }
            }
        });

        // 4. Look for video URLs in data attributes
        document.querySelectorAll('[data-video-url], [data-src], [data-video]').forEach(el => {
            const url = el.dataset.videoUrl || el.dataset.src || el.dataset.video;
            if (url && !seen.has(url) && isValidVideoUrl(url)) {
                seen.add(url);
                sources.push({
                    type: 'data-attr',
                    url: url,
                    title: el.title || el.getAttribute('aria-label') || 'Video'
                });
            }
        });

        return sources;
    }

    /**
     * Check if URL looks like a valid video source
     */
    function isValidVideoUrl(url) {
        if (!url || url.startsWith('blob:') || url.startsWith('data:')) {
            return false;
        }
        try {
            new URL(url);
            return true;
        } catch {
            return false;
        }
    }

    /**
     * Try to get a title for the video
     */
    function getVideoTitle(video) {
        // Check various attributes
        if (video.title) return video.title;
        if (video.getAttribute('aria-label')) return video.getAttribute('aria-label');

        // Check parent elements for titles
        let parent = video.parentElement;
        for (let i = 0; i < 3 && parent; i++) {
            if (parent.title) return parent.title;
            const heading = parent.querySelector('h1, h2, h3, h4, [class*="title"]');
            if (heading && heading.textContent) {
                return heading.textContent.trim().slice(0, 100);
            }
            parent = parent.parentElement;
        }

        // Fall back to page title or URL
        return document.title || 'Video';
    }

    /**
     * Parse embed URLs (YouTube, Vimeo, etc.)
     */
    function parseEmbedUrl(url) {
        try {
            const parsed = new URL(url);

            // YouTube
            if (parsed.hostname.includes('youtube.com') || parsed.hostname.includes('youtube-nocookie.com')) {
                const match = parsed.pathname.match(/\/embed\/([^/?]+)/);
                if (match) {
                    return { type: 'youtube', id: match[1] };
                }
            }

            // Vimeo
            if (parsed.hostname.includes('player.vimeo.com')) {
                const match = parsed.pathname.match(/\/video\/(\d+)/);
                if (match) {
                    return { type: 'vimeo', id: match[1] };
                }
            }

            // Dailymotion
            if (parsed.hostname.includes('dailymotion.com')) {
                const match = parsed.pathname.match(/\/embed\/video\/([^/?]+)/);
                if (match) {
                    return { type: 'dailymotion', id: match[1] };
                }
            }
        } catch {
            // Invalid URL
        }
        return null;
    }

    /**
     * Listen for messages from popup
     */
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
        if (request.action === 'getVideos') {
            const videos = findVideoSources();
            sendResponse({ videos, pageUrl: window.location.href, pageTitle: document.title });
        }
        return true; // Keep channel open for async response
    });

    // Also store detected videos for the background script
    const videos = findVideoSources();
    if (videos.length > 0) {
        chrome.runtime.sendMessage({
            action: 'videosDetected',
            count: videos.length,
            pageUrl: window.location.href
        }).catch(() => {
            // Extension context may not be available
        });
    }

})();
