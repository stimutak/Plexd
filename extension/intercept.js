/**
 * Plexd Extension - MAIN world interceptor
 *
 * Patches the PAGE's actual fetch/XHR to capture stream URLs.
 * Sends them to content.js (ISOLATED world) via postMessage.
 */
(function() {
    'use strict';
    if (window.__plexdInterceptActive) return;
    window.__plexdInterceptActive = true;

    var _fetch = window.fetch;
    window.fetch = function() {
        try {
            var url = arguments[0] && arguments[0].url ? arguments[0].url : arguments[0];
            if (typeof url === 'string') window.postMessage({ type: '__plexd_url', url: url }, '*');
        } catch(e) {}
        return _fetch.apply(this, arguments);
    };

    var _open = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url) {
        try {
            if (typeof url === 'string') window.postMessage({ type: '__plexd_url', url: url }, '*');
        } catch(e) {}
        return _open.apply(this, arguments);
    };
})();
