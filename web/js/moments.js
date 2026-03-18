/**
 * Plexd Moments Store
 *
 * Manages the lifecycle of Moments — persistent, range-based sub-clips
 * that represent the best parts of video streams. Provides CRUD operations,
 * filtering, sorting, and localStorage persistence.
 */

const PlexdMoments = (function() {
    'use strict';

    // In-memory store
    let moments = [];

    // Session ID for this browser session
    const sessionId = 'sess_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);

    // Change listeners
    const listeners = [];

    /**
     * Shallow-copy a moment object, excluding specified keys
     */
    function _copyExcluding(m, exclude) {
        var copy = {};
        var keys = Object.keys(m);
        for (var i = 0; i < keys.length; i++) {
            if (exclude.indexOf(keys[i]) === -1) copy[keys[i]] = m[keys[i]];
        }
        return copy;
    }

    /**
     * Find the index of a moment by ID, or -1 if not found
     */
    function _findIndex(id) {
        for (var i = 0; i < moments.length; i++) {
            if (moments[i].id === id) return i;
        }
        return -1;
    }

    // Dirty flag for sync
    let dirty = false;

    // Storage key
    const STORAGE_KEY = 'plexd_moments';

    /**
     * Generate a unique moment ID
     */
    function generateId() {
        return 'm_' + Date.now().toString(36) + '_' + Math.random().toString(36).slice(2, 6);
    }

    /**
     * Notify all registered listeners of a change
     */
    function _notifyUpdate(type, moment) {
        dirty = true;
        if (moment && moment.id) _markDirty(moment.id);
        for (var i = 0; i < listeners.length; i++) {
            try { listeners[i](type, moment); } catch (e) { console.error('[Moments] Listener[' + i + '] error on ' + type + ':', e); }
        }
    }

    /**
     * Create a new moment
     * @param {Object} opts - Moment properties
     * @returns {Object} The created moment
     */
    function createMoment(opts) {
        var moment = {
            id: generateId(),
            sourceUrl: opts.sourceUrl || '',
            sourceFileId: opts.sourceFileId || null,
            sourceTitle: opts.sourceTitle || '',
            streamId: opts.streamId || null,
            start: (opts.start !== null && opts.start !== undefined) ? opts.start : 0,
            end: (opts.end !== null && opts.end !== undefined) ? opts.end : 0,
            peak: (opts.peak !== null && opts.peak !== undefined) ? opts.peak : 0,
            peakEnd: (opts.peakEnd !== null && opts.peakEnd !== undefined) ? opts.peakEnd : null,
            rating: opts.rating || 0,
            loved: opts.loved || false,
            tags: opts.tags || [],
            userTags: opts.userTags || [],
            notes: opts.notes || '',
            aiDescription: opts.aiDescription || '',
            aiTags: opts.aiTags || [],
            aiEmbedding: opts.aiEmbedding || null,
            thumbnailDataUrl: opts.thumbnailDataUrl || null,
            extracted: false,
            extractedPath: null,
            sessionId: sessionId,
            createdAt: Date.now(),
            updatedAt: Date.now(),
            playCount: 0,
            lastPlayedAt: null,
            sortOrder: moments.length
        };
        moments.push(moment);
        _notifyUpdate('create', moment);
        save();
        return moment;
    }

    /**
     * Get a single moment by ID
     */
    function getMoment(id) {
        var idx = _findIndex(id);
        return idx >= 0 ? moments[idx] : null;
    }

    /**
     * Get all moments
     */
    function getAllMoments() {
        return moments.slice();
    }

    /**
     * Get moments for a specific source URL
     */
    function getMomentsForSource(url) {
        if (!url) return [];
        return moments.filter(function(m) { return m.sourceUrl === url; });
    }

    /**
     * Get moments for a specific stream ID
     */
    function getMomentsForStream(streamId) {
        if (!streamId) return [];
        return moments.filter(function(m) { return m.streamId === streamId; });
    }

    /**
     * Get moments for the current session
     */
    function getSessionMoments() {
        return moments.filter(function(m) { return m.sessionId === sessionId; });
    }

    /**
     * Update a moment (partial merge)
     */
    function updateMoment(id, updates) {
        var moment = getMoment(id);
        if (!moment) return null;
        var keys = Object.keys(updates);
        for (var i = 0; i < keys.length; i++) {
            if (keys[i] !== 'id' && keys[i] !== 'createdAt' && keys[i] !== '__proto__' && keys[i] !== 'constructor' && keys[i] !== 'prototype') {
                moment[keys[i]] = updates[keys[i]];
            }
        }
        moment.updatedAt = Date.now();
        _notifyUpdate('update', moment);
        save();
        return moment;
    }

    /**
     * Delete a moment
     */
    function deleteMoment(id) {
        var idx = _findIndex(id);
        if (idx === -1) return null;
        var removed = moments.splice(idx, 1)[0];
        _notifyUpdate('delete', removed);
        save();
        return removed;
    }

    /**
     * Record a play event
     */
    function recordPlay(id) {
        var moment = getMoment(id);
        if (!moment) return;
        moment.playCount++;
        moment.lastPlayedAt = Date.now();
        moment.updatedAt = Date.now();
        _notifyUpdate('play', moment);
        save();
    }

    /**
     * Count moments for a source URL
     */
    function countForSource(url) {
        if (!url) return 0;
        var count = 0;
        for (var i = 0; i < moments.length; i++) {
            if (moments[i].sourceUrl === url) count++;
        }
        return count;
    }

    /**
     * Count moments for a stream ID
     */
    function countForStream(streamId) {
        if (!streamId) return 0;
        var count = 0;
        for (var i = 0; i < moments.length; i++) {
            if (moments[i].streamId === streamId) count++;
        }
        return count;
    }

    /**
     * Filter moments by criteria
     * @param {Object} opts - Filter options
     */
    function filter(opts) {
        opts = opts || {};
        var result = moments.slice();
        if (opts.sessionId) {
            result = result.filter(function(m) { return m.sessionId === opts.sessionId; });
        }
        if (opts.minRating) {
            result = result.filter(function(m) { return m.rating >= opts.minRating; });
        }
        if (opts.loved) {
            result = result.filter(function(m) { return m.loved; });
        }
        if (opts.sourceUrl) {
            result = result.filter(function(m) { return m.sourceUrl === opts.sourceUrl; });
        }
        if (opts.tag) {
            result = result.filter(function(m) {
                return m.tags.indexOf(opts.tag) !== -1 || m.aiTags.indexOf(opts.tag) !== -1;
            });
        }
        if (opts.hasPeak) {
            result = result.filter(function(m) { return m.peakEnd !== null && m.peakEnd !== undefined; });
        }
        return result;
    }

    /**
     * Sort an array of moments
     * @param {Array} arr - Moments to sort
     * @param {string} by - Sort field
     */
    function sort(arr, by) {
        by = by || 'rating';
        var sorted = arr.slice();
        switch (by) {
            case 'rating':
                sorted.sort(function(a, b) { return (b.rating || 0) - (a.rating || 0); });
                break;
            case 'created':
                sorted.sort(function(a, b) { return b.createdAt - a.createdAt; });
                break;
            case 'played':
                sorted.sort(function(a, b) { return (b.lastPlayedAt || 0) - (a.lastPlayedAt || 0); });
                break;
            case 'playCount':
                sorted.sort(function(a, b) { return b.playCount - a.playCount; });
                break;
            case 'duration':
                sorted.sort(function(a, b) { return (b.end - b.start) - (a.end - a.start); });
                break;
            case 'manual':
                sorted.sort(function(a, b) { return a.sortOrder - b.sortOrder; });
                break;
            case 'unseen':
                sorted.sort(function(a, b) { return (a.playCount || 0) - (b.playCount || 0); });
                break;
            case 'random':
                for (var i = sorted.length - 1; i > 0; i--) {
                    var j = Math.floor(Math.random() * (i + 1));
                    var tmp = sorted[i]; sorted[i] = sorted[j]; sorted[j] = tmp;
                }
                break;
        }
        return sorted;
    }

    /**
     * Set sort order from an array of IDs
     */
    function reorder(orderedIds) {
        for (var i = 0; i < orderedIds.length; i++) {
            var moment = getMoment(orderedIds[i]);
            if (moment) moment.sortOrder = i;
        }
        _notifyUpdate('reorder', null);
        save();
    }

    /**
     * Get a random moment, weighted by rating
     * @param {Array} pool - Optional subset of moments to pick from
     */
    function getRandomMoment(pool) {
        pool = pool || moments;
        if (pool.length === 0) return null;
        // Weight by rating^2 + 1 (higher rated = more likely)
        var weights = [];
        var total = 0;
        for (var i = 0; i < pool.length; i++) {
            var w = (pool[i].rating || 0) * (pool[i].rating || 0) + 1;
            weights.push(w);
            total += w;
        }
        var rand = Math.random() * total;
        var cumulative = 0;
        for (var j = 0; j < pool.length; j++) {
            cumulative += weights[j];
            if (rand <= cumulative) return pool[j];
        }
        return pool[pool.length - 1];
    }

    /**
     * Save moments to localStorage (strips aiEmbedding to save space)
     */
    var _saveTimer = null;
    function save() {
        // Debounce: batch rapid saves into one write
        if (_saveTimer) return;
        _saveTimer = setTimeout(function() {
            _saveTimer = null;
            _saveNow();
        }, 500);
    }
    function _saveNow() {
        try {
            var toSave = moments.map(function(m) {
                return _copyExcluding(m, ['aiEmbedding', 'thumbnailDataUrl']);
            });
            localStorage.setItem(STORAGE_KEY, JSON.stringify(toSave));
        } catch (e) {
            console.error('Failed to save moments:', e);
        }
    }

    /**
     * Load moments from localStorage
     */
    function load() {
        try {
            var data = localStorage.getItem(STORAGE_KEY);
            if (data) {
                var parsed = JSON.parse(data);
                if (Array.isArray(parsed)) {
                    moments = parsed;
                }
            }
        } catch (e) {
            console.error('Failed to load moments:', e);
        }
    }

    // === Server Sync ===

    // Track which moment IDs have been modified since last sync
    var _dirtyIds = {};

    /**
     * Mark a moment ID as dirty (needs server sync)
     */
    function _markDirty(id) {
        if (id) _dirtyIds[id] = true;
    }

    /**
     * Sync dirty moments to the server
     * Posts only moments that have changed since last sync.
     * On success, merges server response (server wins for timestamps).
     */
    function syncToServer() {
        var ids = Object.keys(_dirtyIds);
        if (ids.length === 0) return Promise.resolve();

        // Collect dirty moments (strip aiEmbedding — too large for bulk sync)
        var toSync = [];
        for (var i = 0; i < ids.length; i++) {
            var m = getMoment(ids[i]);
            if (m) {
                toSync.push(_copyExcluding(m, ['aiEmbedding']));
            }
        }

        if (toSync.length === 0) {
            _dirtyIds = {};
            dirty = false;
            return Promise.resolve();
        }

        return plexdFetch('/api/moments/sync', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ moments: toSync })
        })
        .then(function(res) {
            if (!res.ok) throw new Error('Sync failed: ' + res.status);
            return res.json();
        })
        .then(function(data) {
            if (data && Array.isArray(data.moments)) {
                _mergeServerMoments(data.moments);
            }
            // Remove moments that server says were deleted (prevents re-sync of purged moments)
            if (data && Array.isArray(data.deletedIds) && data.deletedIds.length > 0) {
                var deletedSet = {};
                for (var d = 0; d < data.deletedIds.length; d++) deletedSet[data.deletedIds[d]] = true;
                var beforeLen = moments.length;
                moments = moments.filter(function(m) { return !deletedSet[m.id]; });
                if (moments.length < beforeLen) {
                    save();
                    console.log('[Moments] Removed ' + (beforeLen - moments.length) + ' server-deleted moments from local');
                }
            }
            // Clear only the IDs we actually synced (new dirties added mid-flight survive)
            for (var j = 0; j < ids.length; j++) delete _dirtyIds[ids[j]];
            dirty = Object.keys(_dirtyIds).length > 0;
            var logMsg = '[Moments] Synced ' + toSync.length + ' moments to server';
            if (data && data.blocked > 0) logMsg += ' (' + data.blocked + ' blocked as deleted)';
            console.log(logMsg);
        })
        .catch(function(e) {
            // Offline-first: swallow errors, will retry on next interval
            console.warn('[Moments] Server sync failed (offline?):', e.message);
        });
    }

    /**
     * Load all moments from the server and merge with local store
     */
    function loadFromServer() {
        return plexdFetch('/api/moments')
        .then(function(res) {
            if (!res.ok) throw new Error('Load failed: ' + res.status);
            return res.json();
        })
        .then(function(serverMoments) {
            if (Array.isArray(serverMoments)) {
                _mergeServerMoments(serverMoments);
                save();
                console.log('[Moments] Loaded ' + serverMoments.length + ' moments from server');
            }
        })
        .catch(function(e) {
            console.warn('[Moments] Server load failed (offline?):', e.message);
        });
    }

    /**
     * Merge server moments into local store.
     * For new server-side moments, add to local.
     * For existing, keep whichever has newer updatedAt.
     * Server wins for timestamps; client wins for range (start/end/peak).
     */
    function _mergeServerMoments(serverMoments) {
        for (var i = 0; i < serverMoments.length; i++) {
            var sm = serverMoments[i];
            if (!sm || !sm.id) continue;

            var localIdx = -1;
            for (var j = 0; j < moments.length; j++) {
                if (moments[j].id === sm.id) { localIdx = j; break; }
            }

            if (localIdx === -1) {
                // New from server — add locally
                moments.push(sm);
            } else {
                // Exists locally — merge INTO existing object (preserves references)
                var local = moments[localIdx];
                var serverTime = sm.updatedAt || 0;
                var localTime = local.updatedAt || 0;

                if (serverTime > localTime) {
                    // Server is newer: apply server fields to local object
                    var sKeys = Object.keys(sm);
                    for (var k = 0; k < sKeys.length; k++) {
                        var key = sKeys[k];
                        // Client wins for range/edit fields if locally modified
                        if (_dirtyIds[sm.id] && (key === 'start' || key === 'end' || key === 'peak' || key === 'peakEnd' || key === 'userTags')) {
                            continue;
                        }
                        local[key] = sm[key];
                    }
                }
                // else: local is newer or same, keep local version
            }
        }
    }

    // Sync interval handle
    var _syncInterval = null;

    /**
     * Register an update callback
     * @param {Function} cb - Called with (type, moment) on changes
     */
    function onUpdate(cb) {
        if (typeof cb === 'function') {
            listeners.push(cb);
        }
    }

    /**
     * Get the current session ID
     */
    function getSessionId() {
        return sessionId;
    }

    /**
     * Get total moment count
     */
    function count() {
        return moments.length;
    }

    /**
     * Check if dirty (has unsaved server changes)
     */
    function isDirty() {
        return dirty;
    }

    /**
     * Clear dirty flag (after server sync)
     */
    function clearDirty() {
        dirty = false;
    }

    /**
     * Purge all moments (in-memory + localStorage)
     */
    function clearAll() {
        moments = [];
        if (_saveTimer) { clearTimeout(_saveTimer); _saveTimer = null; }
        try { localStorage.removeItem(STORAGE_KEY); } catch (e) { console.error('[Moments] Failed to clear localStorage:', e.message); }
        _notifyUpdate('purge', null);
    }

    // Initialize: load from localStorage, then merge from server
    load();
    loadFromServer();

    // Periodic sync: push dirty moments to server every 30 seconds
    _syncInterval = setInterval(function() {
        if (dirty && Object.keys(_dirtyIds).length > 0) {
            syncToServer();
        }
    }, 30000);

    // Flush pending saves on page unload
    window.addEventListener('beforeunload', function() {
        if (_saveTimer) { clearTimeout(_saveTimer); _saveNow(); }
    });

    return {
        createMoment: createMoment,
        getMoment: getMoment,
        getAllMoments: getAllMoments,
        getMomentsForSource: getMomentsForSource,
        getMomentsForStream: getMomentsForStream,
        getSessionMoments: getSessionMoments,
        updateMoment: updateMoment,
        deleteMoment: deleteMoment,
        recordPlay: recordPlay,
        countForSource: countForSource,
        countForStream: countForStream,
        filter: filter,
        sort: sort,
        reorder: reorder,
        getRandomMoment: getRandomMoment,
        save: save,
        saveNow: _saveNow,
        load: load,
        onUpdate: onUpdate,
        getSessionId: getSessionId,
        count: count,
        isDirty: isDirty,
        clearDirty: clearDirty,
        clearAll: clearAll,
        syncToServer: syncToServer,
        loadFromServer: loadFromServer
    };
})();
