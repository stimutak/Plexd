/**
 * Plexd Extension - Content Script (ISOLATED world)
 *
 * Receives intercepted URLs from intercept.js (MAIN world) via postMessage.
 * Scans DOM for <video> elements on request from popup.
 * Reports detection count to background for badge updates.
 */
(function() {
    'use strict';

    const interceptedStreams = new Set();

    // Receive URLs from MAIN world interceptor (intercept.js)
    window.addEventListener('message', (event) => {
        if (event.source !== window || !event.data || event.data.type !== '__plexd_url') return;
        var url = event.data.url;
        if (typeof url !== 'string') return;
        if (isStreamUrl(url)) {
            var fullUrl = url.startsWith('http') ? url : tryResolveUrl(url);
            if (fullUrl && !interceptedStreams.has(fullUrl)) {
                interceptedStreams.add(fullUrl);
                saveInterceptedStreams();
                chrome.runtime.sendMessage({ action: 'streamIntercepted', url: fullUrl }).catch(() => {});
            }
        }
    });

    function isStreamUrl(url) {
        var lower = url.toLowerCase();
        return lower.includes('.m3u8') || lower.includes('.mpd');
    }

    function tryResolveUrl(url) {
        try { return new URL(url, window.location.href).href; } catch (e) { return null; }
    }

    // Debounced save to chrome.storage
    var saveTimer = null;
    function saveInterceptedStreams() {
        if (saveTimer) clearTimeout(saveTimer);
        saveTimer = setTimeout(function() {
            var pageKey = 'streams_' + window.location.hostname + window.location.pathname;
            chrome.storage.local.set({
                [pageKey]: {
                    streams: Array.from(interceptedStreams),
                    title: document.title,
                    url: window.location.href,
                    timestamp: Date.now()
                }
            }).catch(function() {});
        }, 500);
    }

    // Detect Aylo scene pages (SpiceVids, SpiceVidsGay, Brazzers, Mofos, etc.)
    var AYLO_SCENE_HOSTS = {
        'www.spicevids.com': 'spicevids',
        'spicevids.com': 'spicevids',
        'www.spicevidsgay.com': 'spicevidsgay',
        'spicevidsgay.com': 'spicevidsgay',
        'www.brazzers.com': 'brazzers',
        'brazzers.com': 'brazzers',
        'www.mofos.com': 'mofos',
        'mofos.com': 'mofos'
    };

    function detectAyloScene() {
        var host = window.location.hostname;
        var site = AYLO_SCENE_HOSTS[host];
        if (!site) return null;
        var match = window.location.pathname.match(/^\/scene\/(\d+)/);
        if (!match) return null;
        var sceneId = match[1];
        var title = document.querySelector('h1')?.textContent?.trim()
            || document.querySelector('[data-test-id="scene-title"]')?.textContent?.trim()
            || document.title.replace(/ \|.*$/, '').trim()
            || 'Scene ' + sceneId;
        return { type: 'aylo-scene', sceneId: sceneId, site: site, title: title, url: window.location.href };
    }

    /**
     * Find all video sources on the current page
     */
    function findVideoSources() {
        var sources = [];
        var seen = new Set();

        // Aylo scene detection (SpiceVids, etc.) — highest priority
        var ayloScene = detectAyloScene();
        if (ayloScene) {
            sources.push(ayloScene);
            seen.add(ayloScene.url);
        }

        // Intercepted streams
        interceptedStreams.forEach(function(url) {
            if (!seen.has(url)) {
                seen.add(url);
                sources.push({ type: 'stream', url: url, title: document.title, intercepted: true });
            }
        });

        // <video> elements
        document.querySelectorAll('video').forEach(function(video) {
            [video.src, video.currentSrc].forEach(function(src) {
                if (src && !src.startsWith('blob:') && !src.startsWith('data:') && !seen.has(src)) {
                    try { new URL(src); } catch (e) { return; }
                    seen.add(src);
                    sources.push({ type: 'video', url: src, title: getVideoTitle(video) });
                }
            });
            video.querySelectorAll('source[src]').forEach(function(source) {
                var src = source.src;
                if (src && !src.startsWith('blob:') && !src.startsWith('data:') && !seen.has(src)) {
                    try { new URL(src); } catch (e) { return; }
                    seen.add(src);
                    sources.push({ type: 'video', url: src, title: getVideoTitle(video) });
                }
            });
        });

        // Data attributes
        document.querySelectorAll('[data-video-url], [data-src], [data-video]').forEach(function(el) {
            var url = el.dataset.videoUrl || el.dataset.src || el.dataset.video;
            if (url && !url.startsWith('blob:') && !url.startsWith('data:') && !seen.has(url)) {
                try { new URL(url); } catch (e) { return; }
                seen.add(url);
                sources.push({ type: 'video', url: url, title: el.title || 'Video' });
            }
        });

        return sources;
    }

    function getVideoTitle(video) {
        if (video.title) return video.title;
        if (video.getAttribute('aria-label')) return video.getAttribute('aria-label');
        var parent = video.parentElement;
        for (var i = 0; i < 3 && parent; i++) {
            var heading = parent.querySelector('h1, h2, h3');
            if (heading && heading.textContent) return heading.textContent.trim().slice(0, 80);
            parent = parent.parentElement;
        }
        return document.title || 'Video';
    }

    // Respond to popup requests
    chrome.runtime.onMessage.addListener(function(request, sender, sendResponse) {
        if (request.action === 'getVideos') {
            sendResponse({ videos: findVideoSources(), pageUrl: window.location.href });
        }
        return true;
    });

    // Notify background of video count for badge
    function notifyCount() {
        var count = findVideoSources().length;
        if (count > 0) {
            chrome.runtime.sendMessage({ action: 'videosDetected', count: count }).catch(function() {});
        }
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', notifyCount);
    } else {
        notifyCount();
    }
    setTimeout(notifyCount, 3000);
})();
