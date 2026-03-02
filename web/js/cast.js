/**
 * Plexd Cast Module
 *
 * Manages casting a single stream to external displays via
 * Chrome Cast, AirPlay, or the Presentation API.
 * Sender-side module — coordinates with cast-receiver.html on the target device.
 */

const PlexdCast = (function() {
    'use strict';

    // --- State ---

    var castState = {
        active: false,
        mode: null,          // 'cast' | 'airplay' | 'presentation'
        streamId: null,       // Which Plexd stream is being cast
        targetName: '',       // Device name (e.g., "Living Room TV")
        receiverUrl: null     // LAN URL for cast-receiver.html
    };

    var availability = {
        cast: false,
        airplay: false,
        presentation: false
    };

    var stateCallbacks = [];
    var castSession = null;       // Chrome Cast session
    var presentationConn = null;  // Presentation API connection
    var serverInfo = null;        // { ip, port } from /api/server-info

    // Expose state for debugging
    window._plexdCastState = castState;

    // --- Helpers ---

    /**
     * Notify all registered callbacks of a state change
     */
    function notifyStateChange() {
        var state = getState();
        stateCallbacks.forEach(function(cb) {
            try { cb(state); } catch (e) {
                console.error('[PlexdCast] State callback error:', e);
            }
        });
    }

    /**
     * Get a stream's URL rewritten for LAN access (Chromecast can't reach localhost)
     */
    function getStreamCastUrl(streamId) {
        var streams = PlexdStream.getAllStreams();
        var stream = streams.find(function(s) { return s.id === streamId; });
        if (!stream) return null;

        var url = stream.sourceUrl || stream.url;
        if (serverInfo && (url.includes('localhost') || url.includes('127.0.0.1'))) {
            url = url.replace(/localhost|127\.0\.0\.1/, serverInfo.ip);
        }
        return url;
    }

    /**
     * Get the LAN URL for the cast receiver page
     */
    function getReceiverUrl() {
        if (!serverInfo) return null;
        return 'http://' + serverInfo.ip + ':' + serverInfo.port + '/cast-receiver.html';
    }

    // --- Init ---

    /**
     * Initialize the cast module: fetch server info, detect available cast methods
     */
    function init() {
        fetch('/api/server-info')
            .then(function(r) { return r.json(); })
            .then(function(info) {
                serverInfo = info;
                castState.receiverUrl = getReceiverUrl();
                detectAvailability();
            })
            .catch(function(err) {
                console.warn('[PlexdCast] Could not fetch server info:', err);
                detectAvailability();
            });
    }

    /**
     * Detect which casting methods are available in this browser
     */
    function detectAvailability() {
        // Chrome Cast SDK
        if (window.chrome && window.chrome.cast) {
            availability.cast = true;
            initChromeCast();
        }

        // Safari AirPlay
        var testVideo = document.createElement('video');
        if (testVideo.webkitShowPlaybackTargetPicker) {
            availability.airplay = true;
        }

        // Presentation API (Chrome, Edge)
        if (navigator.presentation && navigator.presentation.request) {
            availability.presentation = true;
        }

        notifyStateChange();
    }

    // --- Protocol Stubs (filled in by Tasks 4-6) ---

    function initChromeCast() {
        // Task 4: Chrome Cast SDK initialization
    }

    function castStreamViaCast(streamId) {
        // Task 4: Start casting via Chrome Cast
    }

    function castStreamViaAirPlay(streamId) {
        // Task 5: Start casting via AirPlay
    }

    function castStreamViaPresentation(streamId) {
        // Task 6: Start casting via Presentation API
    }

    function sendCommandViaCast(cmd, data) {
        // Task 4: Send command to Cast receiver
    }

    function sendCommandViaPresentation(cmd, data) {
        // Task 6: Send command to Presentation receiver
    }

    function stopCastingViaCast() {
        // Task 4: Stop Chrome Cast session
    }

    function stopCastingViaPresentation() {
        // Task 6: Stop Presentation API connection
    }

    function handleReceiverMessage(data) {
        // Tasks 4/6: Handle incoming message from receiver
    }

    // --- Public API Dispatch ---

    /**
     * Get a snapshot of the current cast state
     */
    function getState() {
        return {
            active: castState.active,
            mode: castState.mode,
            streamId: castState.streamId,
            targetName: castState.targetName,
            available: availability.cast || availability.airplay || availability.presentation
        };
    }

    /**
     * Get a copy of the availability flags
     */
    function getAvailability() {
        return {
            cast: availability.cast,
            airplay: availability.airplay,
            presentation: availability.presentation
        };
    }

    /**
     * Register a callback for cast state changes
     */
    function onStateChange(callback) {
        if (typeof callback === 'function') {
            stateCallbacks.push(callback);
        }
    }

    /**
     * Cast a stream — dispatches to the best available method
     * Priority: Cast > AirPlay > Presentation
     */
    function castStream(streamId) {
        if (castState.active) {
            console.warn('[PlexdCast] Already casting. Stop first.');
            return;
        }
        if (availability.cast) {
            castStreamViaCast(streamId);
        } else if (availability.airplay) {
            castStreamViaAirPlay(streamId);
        } else if (availability.presentation) {
            castStreamViaPresentation(streamId);
        } else {
            console.warn('[PlexdCast] No casting method available');
        }
    }

    /**
     * Stop casting — dispatches based on active mode
     */
    function stopCasting() {
        if (!castState.active) return;

        switch (castState.mode) {
            case 'cast':
                stopCastingViaCast();
                break;
            case 'presentation':
                stopCastingViaPresentation();
                break;
            case 'airplay':
                // AirPlay is controlled by the OS; no programmatic stop
                break;
        }

        castState.active = false;
        castState.mode = null;
        castState.streamId = null;
        castState.targetName = '';
        notifyStateChange();
    }

    /**
     * Send a control command to the receiver
     */
    function sendCommand(cmd, data) {
        if (!castState.active) return;

        switch (castState.mode) {
            case 'cast':
                sendCommandViaCast(cmd, data);
                break;
            case 'presentation':
                sendCommandViaPresentation(cmd, data);
                break;
            // AirPlay: no message channel, playback controlled locally
        }
    }

    /**
     * Switch the cast to a different stream without stopping the session
     */
    function switchStream(streamId) {
        if (!castState.active) return;

        var url = getStreamCastUrl(streamId);
        if (!url) {
            console.warn('[PlexdCast] Stream not found:', streamId);
            return;
        }

        castState.streamId = streamId;
        sendCommand('load', { url: url });
        notifyStateChange();
    }

    // --- Cleanup ---

    window.addEventListener('beforeunload', function() {
        if (castState.active) {
            stopCasting();
        }
    });

    // --- Public API ---

    return {
        init: init,
        getState: getState,
        getAvailability: getAvailability,
        castStream: castStream,
        stopCasting: stopCasting,
        switchStream: switchStream,
        sendCommand: sendCommand,
        onStateChange: onStateChange
    };
})();

// --- Outside IIFE: SDK callback + fallback init ---

// Chrome Cast SDK calls this when ready
window['__onGCastApiAvailable'] = function(isAvailable) {
    if (isAvailable) {
        PlexdCast.init();
    }
};

// If Cast SDK not present, init on DOM ready for AirPlay/Presentation detection
if (!window.chrome || !window.chrome.cast) {
    document.addEventListener('DOMContentLoaded', function() {
        PlexdCast.init();
    });
}
