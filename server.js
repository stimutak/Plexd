#!/usr/bin/env node
/**
 * Plexd Server with Remote Control Relay
 *
 * Simple HTTP server that serves static files AND relays remote control
 * commands between devices (iPhone to MBP, etc.)
 *
 * Features:
 * - Static file serving
 * - Remote control relay (state + commands)
 * - Video file upload/serving for cross-device playback
 *
 * Usage: node server.js [port]
 * Default port: 8080
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawn } = require('child_process');

// Crash protection — log and survive instead of dying on unhandled errors.
// Without this, a single uncaught exception kills the server, orphaning ffmpeg
// processes and causing ERR_CONNECTION_REFUSED for all browser connections.
process.on('uncaughtException', (err) => {
    console.error('[Server] UNCAUGHT EXCEPTION (survived):', err.message);
    console.error(err.stack);
});
process.on('unhandledRejection', (reason) => {
    console.error('[Server] UNHANDLED REJECTION (survived):', reason);
});

function jsonOk(res, data) {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
}
function jsonError(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: message }));
}

const PORT = process.argv[2] || 8080;
const WEB_ROOT = path.join(__dirname, 'web');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const UPLOADS_META = path.join(UPLOADS_DIR, 'metadata.json');
const HLS_DIR = path.join(UPLOADS_DIR, 'hls');
const FILE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours
const MIN_DISK_SPACE_MB = 500; // Minimum free space required for transcoding
const TRANSCODE_POLL_MS = 5000; // Polling interval for transcode status
const VIDEO_RANGE_CAP = 4 * 1024 * 1024; // 4MB max per video range response — prevents HTTP/1.1 connection starvation

// Default local folder to scan for videos (user's Downloads)
const os = require('os');
const DEFAULT_SCAN_FOLDER = path.join(os.homedir(), 'Downloads');
const VIDEO_EXTENSIONS = new Set(['.mov', '.mp4', '.m4v', '.webm', '.mkv', '.avi', '.ogv', '.3gp', '.flv', '.mpeg', '.mpg', '.ts', '.mts', '.m2ts', '.wmv', '.asf', '.vob', '.divx', '.f4v']);

// Ensure uploads and HLS directories exist
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(HLS_DIR)) {
    fs.mkdirSync(HLS_DIR, { recursive: true });
}

// Track active transcoding jobs: { fileId: { progress, status, process } }
const transcodingJobs = {};

// HLS transcoding disabled — originals stream fine on LAN, HLS segments waste disk space
const HLS_TRANSCODE_ENABLED = false;

// Transcoding queue - limit concurrent jobs to avoid CPU overload
const transcodeQueue = [];
const activeTranscodes = new Set();
const MAX_CONCURRENT_TRANSCODES = 4; // M4 media engine handles multiple hardware encodes
let transcodePaused = true; // Start paused - user must click Start in Files modal

// Background HLS download queue (mirrors transcode queue pattern)
const downloadJobs = {};           // { jobId: { status, progress, url, filename, filepath, process, pid, error, startedAt, completedAt } }
const downloadQueue = [];          // FIFO queue of jobIds
const activeDownloads = new Set();
const MAX_CONCURRENT_DOWNLOADS = 2;
const DOWNLOADS_DIR = path.join(UPLOADS_DIR, 'downloads');

// Ensure downloads directory exists
if (!fs.existsSync(DOWNLOADS_DIR)) {
    fs.mkdirSync(DOWNLOADS_DIR, { recursive: true });
}

// Moment clip extraction queue (mirrors download queue pattern)
const MOMENTS_DIR = path.join(UPLOADS_DIR, 'moments');
const extractJobs = {};           // { jobId: { momentId, status, progress, outputPath, process, pid, error, startedAt, completedAt } }
const extractQueue = [];          // FIFO queue of jobIds
const activeExtracts = new Set();
const MAX_CONCURRENT_EXTRACTS = 2;
let extractsPaused = false; // One at a time (MAX_CONCURRENT_EXTRACTS=1), triggered on demand

// Moments persistence
const MOMENTS_JSON = path.join(MOMENTS_DIR, 'moments.json');
const MOMENTS_THUMBS = path.join(MOMENTS_DIR, 'thumbnails');

// Ensure moments directories exist
if (!fs.existsSync(MOMENTS_DIR)) {
    fs.mkdirSync(MOMENTS_DIR, { recursive: true });
}
if (!fs.existsSync(MOMENTS_THUMBS)) {
    fs.mkdirSync(MOMENTS_THUMBS, { recursive: true });
}

// Load moments database from JSON
let momentsDb = [];
try {
    momentsDb = JSON.parse(fs.readFileSync(MOMENTS_JSON, 'utf-8'));
    console.log(`[Server] Loaded ${momentsDb.length} moments from disk`);
} catch (e) {
    if (e.code === 'ENOENT') {
        console.log('[Server] No moments file found, starting fresh');
    } else {
        console.error('[Server] Failed to load moments database:', e.message);
        try { fs.copyFileSync(MOMENTS_JSON, MOMENTS_JSON + '.corrupted.' + Date.now()); } catch (_) {}
    }
    momentsDb = [];
}
let batchProgress = { total: 0, done: 0, current: '', errors: 0, running: false };

function saveMomentsDb() {
    try {
        const data = JSON.stringify(momentsDb, null, 2);
        const tmpPath = MOMENTS_JSON + '.tmp';
        fs.writeFileSync(tmpPath, data);
        fs.renameSync(tmpPath, MOMENTS_JSON);
    } catch (e) {
        console.error('[Server] Failed to save moments database:', e.message);
    }
}

// Kill orphaned ffmpeg extraction processes from previous server runs.
// Without detached:true these shouldn't accumulate, but clean up any existing ones.
(function killOrphanedFfmpeg() {
    try {
        const { execFileSync } = require('child_process');
        const result = execFileSync('pgrep', ['-f', 'ffmpeg.*-ss.*-i http'], { encoding: 'utf-8', timeout: 5000 }).trim();
        if (result) {
            const pids = result.split('\n').map(p => parseInt(p)).filter(p => !isNaN(p));
            for (const pid of pids) {
                try { process.kill(pid, 'SIGTERM'); } catch (_) {}
            }
            if (pids.length > 0) console.log(`[Server] Killed ${pids.length} orphaned ffmpeg extraction process(es)`);
        }
    } catch (_) { /* pgrep returns exit code 1 when no matches — normal */ }
})();

// Reconcile moments at startup: fix blob URLs and extracted flags
(function reconcileMoments() {
    let fixedBlobs = 0, fixedExtracted = 0;
    for (const m of momentsDb) {
        // Fix blob: sourceUrls — resolve to server file path by sourceTitle (filename)
        if (m.sourceUrl && m.sourceUrl.startsWith('blob:') && m.sourceTitle) {
            const filePath = path.join(UPLOADS_DIR, m.sourceTitle);
            if (fs.existsSync(filePath)) {
                m.sourceUrl = `/api/files/${m.sourceTitle}`;
                m.sourceFileId = m.sourceTitle;
                fixedBlobs++;
            }
        }
        // Fix extracted flag — mark if clip file exists on disk
        if (!m.extracted) {
            const clipPath = path.join(MOMENTS_DIR, `${m.id}.mp4`);
            if (fs.existsSync(clipPath)) {
                m.extracted = true;
                m.extractedPath = `/api/moments/${m.id}/clip.mp4`;
                fixedExtracted++;
            }
        }
    }
    if (fixedBlobs > 0 || fixedExtracted > 0) {
        saveMomentsDb();
        if (fixedBlobs > 0) console.log(`[Server] Reconciled ${fixedBlobs} blob URLs → server files`);
        if (fixedExtracted > 0) console.log(`[Server] Reconciled ${fixedExtracted} moments with existing clips`);
    }
    // Queue extraction for moments that don't have clips yet
    let queued = 0;
    for (const m of momentsDb) {
        if (m.extracted) continue;
        if (!m.sourceUrl || m.sourceUrl.startsWith('blob:')) continue;
        const clipPath = path.join(MOMENTS_DIR, `${m.id}.mp4`);
        if (fs.existsSync(clipPath)) continue;
        const startF = parseFloat(m.start), endF = parseFloat(m.end);
        if (!isFinite(startF) || !isFinite(endF) || startF >= endF) continue;
        const jobId = `ext_boot_${m.id}`;
        extractJobs[jobId] = {
            status: 'queued', progress: 0,
            momentId: m.id, sourceUrl: m.sourceUrl,
            sourceFileId: m.sourceFileId || null,
            start: startF, end: endF,
            outputPath: path.join(MOMENTS_DIR, `${m.id}.mp4`),
            process: null, pid: null, error: null,
            startedAt: null, completedAt: null
        };
        extractQueue.push(jobId);
        queued++;
    }
    if (queued > 0) {
        console.log(`[Server] Queued ${queued} moments for extraction`);
        setTimeout(processExtractQueue, 5000); // Start after server is fully up
    }
})();

// Validate momentId (no path separators or traversal)
function isValidMomentId(id) {
    return typeof id === 'string' && id.length > 0 && !id.includes('/') && !id.includes('\\') && !id.includes('..');
}

// Strip large fields from moment for list responses
function stripLargeFields(m) {
    const copy = {};
    const keys = Object.keys(m);
    for (let i = 0; i < keys.length; i++) {
        if (keys[i] !== 'thumbnailDataUrl' && keys[i] !== 'aiEmbedding') {
            copy[keys[i]] = m[keys[i]];
        }
    }
    return copy;
}

// Restore thumbnailDataUrl from saved file on disk
function restoreThumbnail(m) {
    if (m.thumbnailPath) {
        const thumbPath = path.join(MOMENTS_THUMBS, m.thumbnailPath);
        if (fs.existsSync(thumbPath)) {
            try {
                const data = fs.readFileSync(thumbPath);
                m.thumbnailDataUrl = 'data:image/jpeg;base64,' + data.toString('base64');
            } catch (e) { console.warn('[Moments] Failed to restore thumbnail for', m.id, ':', e.message); }
        }
    }
    return m;
}

// Save thumbnail data URL to file, return filename
function saveThumbnailFile(id, dataUrl) {
    if (!dataUrl || !dataUrl.startsWith('data:')) return null;
    try {
        const match = dataUrl.match(/^data:image\/[^;]+;base64,(.+)$/);
        if (!match) return null;
        const buffer = Buffer.from(match[1], 'base64');
        const filename = id + '.jpg';
        fs.writeFileSync(path.join(MOMENTS_THUMBS, filename), buffer);
        return filename;
    } catch (e) {
        console.error('[Moments] Failed to save thumbnail:', e.message);
        return null;
    }
}

// Upsert a single moment into momentsDb
function upsertMoment(incoming) {
    if (!incoming || !incoming.id) return null;
    if (!isValidMomentId(incoming.id)) return null;

    // Handle thumbnail
    if (incoming.thumbnailDataUrl && incoming.thumbnailDataUrl.startsWith('data:')) {
        const thumbFile = saveThumbnailFile(incoming.id, incoming.thumbnailDataUrl);
        if (thumbFile) {
            incoming.thumbnailPath = thumbFile;
        }
        delete incoming.thumbnailDataUrl;
    }
    // Strip aiEmbedding from storage
    delete incoming.aiEmbedding;

    // AI fields are server-only — strip from client sync to prevent overwrites
    delete incoming.aiTags;
    delete incoming.aiDescription;
    delete incoming.aiConfidences;

    const existingIdx = momentsDb.findIndex(m => m.id === incoming.id);
    if (existingIdx !== -1) {
        // Merge: incoming wins for user fields, server keeps AI + extracted data
        const existing = momentsDb[existingIdx];
        const merged = Object.assign({}, existing, incoming);
        if (existing.thumbnailPath && !incoming.thumbnailPath) {
            merged.thumbnailPath = existing.thumbnailPath;
        }
        if (existing.extractedPath) {
            merged.extractedPath = existing.extractedPath;
        }
        momentsDb[existingIdx] = merged;
        return merged;
    } else {
        momentsDb.push(incoming);
        return incoming;
    }
}

// Check if ffmpeg is available
let ffmpegAvailable = false;
try {
    const { execSync } = require('child_process');
    execSync('which ffmpeg', { stdio: 'ignore' });
    ffmpegAvailable = true;
    console.log('[Server] ffmpeg available - HLS transcoding enabled');
} catch (e) {
    console.log('[Server] ffmpeg not found - HLS transcoding disabled');
}

// === AI Integration (Skier Multi-Model) ===
// Multiple Skier servers run specialized models, each on its own port:
//   actions (8000), bodyparts (8001), bdsm (8002), positions (8003)
// Discovered from nsfw-ai-manage.sh server-status.json. All hit in parallel.

const SKIER_MANAGE_SCRIPT = path.join(os.homedir(), 'Projects/nsfw_ai_model_server/nsfw-ai-manage.sh');
const SKIER_STATUS_FILE = path.join(os.homedir(), 'Projects/nsfw_ai_model_server/server-status.json');

// Each entry: { category, model, port, tags, available }
let skierServers = [];
let skierAvailable = false;

// Try to auto-start Skier servers via manage script (hardcoded path, no user input)
function autoStartSkier() {
    try {
        if (!fs.existsSync(SKIER_MANAGE_SCRIPT)) return;
        console.log('[Server] Starting Skier AI servers...');
        const { execFileSync } = require('child_process');
        execFileSync(SKIER_MANAGE_SCRIPT, ['start'], { timeout: 30000, stdio: 'pipe' });
        console.log('[Server] Skier AI servers started');
    } catch (e) {
        console.warn('[Server] Skier auto-start failed:', e.message?.split('\n')[0]);
    }
}

// Discover available servers from status file + health check
async function checkSkier() {
    const servers = [];

    // Read status file for server list
    try {
        const data = JSON.parse(fs.readFileSync(SKIER_STATUS_FILE, 'utf-8'));
        for (const entry of data) {
            servers.push({
                category: entry.category,
                model: entry.model,
                port: entry.port,
                tagCount: entry.tags,
                url: `http://localhost:${entry.port}`,
                available: false
            });
        }
    } catch {
        // Fallback: single default server
        servers.push({ category: 'default', model: 'unknown', port: 8000, tagCount: 0, url: 'http://localhost:8000', available: false });
    }

    // Health-check each server in parallel
    await Promise.all(servers.map(async (s) => {
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 3000);
            const res = await fetch(s.url + '/openapi.json', { signal: controller.signal });
            clearTimeout(timeout);
            s.available = res.ok;
        } catch {
            s.available = false;
        }
    }));

    const prev = skierServers.filter(s => s.available).length;
    skierServers = servers;
    skierAvailable = servers.some(s => s.available);

    const live = servers.filter(s => s.available);
    if (live.length > 0 && live.length !== prev) {
        console.log('[Server] Skier AI:', live.map(s => `${s.category}/${s.model}:${s.port}`).join(', '));
    }
}

// Query a single Skier server, returns { tags, confidences, category }
async function querySingleSkier(server, thumbPath) {
    const res = await fetch(server.url + '/process_images/', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ paths: [thumbPath], return_confidence: true })
    });
    if (!res.ok) throw new Error(`Skier ${server.category} returned ${res.status}`);
    const data = await res.json();
    const entry = data.result?.[0] || {};
    const tags = [];
    const confidences = {};
    for (const key of Object.keys(entry)) {
        if (Array.isArray(entry[key])) {
            for (const [tag, conf] of entry[key]) {
                const clean = tag.replace(/_AI$/i, '').toLowerCase().replace(/_/g, ' ');
                tags.push(clean);
                confidences[clean] = conf;
            }
        }
    }
    return { tags, confidences, category: server.category };
}

// Analyze with ALL available servers in parallel, merge results
async function analyzeWithSkier(thumbPath) {
    const live = skierServers.filter(s => s.available);
    if (live.length === 0) throw new Error('No Skier servers available');

    const results = await Promise.allSettled(
        live.map(s => querySingleSkier(s, thumbPath))
    );

    const allTags = [];
    const allConfidences = {};
    const categories = [];

    for (const r of results) {
        if (r.status === 'fulfilled') {
            categories.push(r.value.category);
            for (const tag of r.value.tags) {
                if (!allConfidences[tag] || r.value.confidences[tag] > allConfidences[tag]) {
                    allConfidences[tag] = r.value.confidences[tag];
                }
            }
        }
    }

    // Sort by confidence descending, dedup
    const sorted = Object.entries(allConfidences).sort((a, b) => b[1] - a[1]);
    for (const [tag] of sorted) allTags.push(tag);

    return { tags: allTags, confidences: allConfidences, provider: 'skier', categories };
}

// Auto-start on server boot, then health-check every 5 minutes
autoStartSkier();
checkSkier();
setInterval(checkSkier, 5 * 60 * 1000);

// Check available disk space (returns MB)
function getFreeDiskSpaceMB() {
    try {
        const { execSync } = require('child_process');
        // Use df to get free space on the uploads directory
        const output = execSync(`df -m "${UPLOADS_DIR}" | tail -1 | awk '{print $4}'`, { encoding: 'utf8' });
        return parseInt(output.trim(), 10) || 0;
    } catch (e) {
        console.warn('[Server] Could not check disk space:', e.message);
        return 0;
    }
}

// Sanitize filename for filesystem use (keep readable, remove dangerous chars)
function sanitizeFileName(name) {
    return name
        .replace(/[<>:"/\\|?*\x00-\x1f]/g, '_')  // Remove invalid filesystem chars
        .replace(/\s+/g, '_')                      // Spaces to underscores
        .replace(/_+/g, '_')                       // Collapse multiple underscores
        .replace(/^_|_$/g, '');                    // Trim leading/trailing underscores
}

// Generate a readable file ID from filename, handling collisions
function generateFileId(fileName) {
    const sanitized = sanitizeFileName(fileName);

    // If no collision, use as-is
    if (!fileMetadata[sanitized]) {
        return sanitized;
    }

    // Split into name and extension
    const lastDot = sanitized.lastIndexOf('.');
    const baseName = lastDot > 0 ? sanitized.slice(0, lastDot) : sanitized;
    const ext = lastDot > 0 ? sanitized.slice(lastDot) : '';

    // Find next available number
    let counter = 1;
    let candidate;
    do {
        candidate = `${baseName}_${counter}${ext}`;
        counter++;
    } while (fileMetadata[candidate]);

    return candidate;
}

// Find existing HLS by original filename and size
function findExistingFile(fileName, size) {
    for (const [fileId, meta] of Object.entries(fileMetadata)) {
        if (meta.originalFileName === fileName && meta.originalSize === size) {
            return { fileId, meta };
        }
    }
    return null;
}

// Queue a file for HLS transcoding
function startHLSTranscode(fileId) {
    if (!HLS_TRANSCODE_ENABLED || !ffmpegAvailable) return;

    const meta = fileMetadata[fileId];
    if (!meta || !meta.contentType?.startsWith('video/')) return;

    // Don't re-queue if already queued or transcoding
    if (transcodeQueue.includes(fileId) || activeTranscodes.has(fileId)) return;

    // Add to queue
    transcodeQueue.push(fileId);
    transcodingJobs[fileId] = { status: 'queued', progress: 0 };
    console.log(`[Server] Queued for transcode: ${meta.fileName} (${transcodeQueue.length} in queue)`);

    // Try to start processing
    processTranscodeQueue();
}

// Process the transcode queue
function processTranscodeQueue() {
    if (transcodePaused) return; // Don't start new transcodes when paused
    while (activeTranscodes.size < MAX_CONCURRENT_TRANSCODES && transcodeQueue.length > 0) {
        const fileId = transcodeQueue.shift();
        runTranscode(fileId);
    }
}

// Actually run the ffmpeg transcode
function runTranscode(fileId, useSoftwareEncoder = false) {
    const meta = fileMetadata[fileId];
    if (!meta) return;

    const inputPath = path.join(UPLOADS_DIR, fileId);
    const hlsDir = path.join(HLS_DIR, fileId);
    const outputPath = path.join(hlsDir, 'playlist.m3u8');

    // Skip if input file doesn't exist
    if (!fs.existsSync(inputPath)) {
        console.error(`[Server] Input file missing: ${meta.fileName}`);
        transcodingJobs[fileId] = { status: 'failed', progress: 0 };
        processTranscodeQueue();
        return;
    }

    // Check disk space before starting
    const freeMB = getFreeDiskSpaceMB();
    if (freeMB < MIN_DISK_SPACE_MB) {
        console.error(`[Server] Low disk space (${freeMB}MB free), skipping transcode: ${meta.fileName}`);
        transcodingJobs[fileId] = { status: 'failed', progress: 0, error: 'Low disk space' };
        processTranscodeQueue();
        return;
    }

    // Create HLS directory for this file
    if (!fs.existsSync(hlsDir)) {
        fs.mkdirSync(hlsDir, { recursive: true });
    }

    activeTranscodes.add(fileId);
    transcodingJobs[fileId] = { status: 'transcoding', progress: 0, usingSoftware: useSoftwareEncoder };

    const encoder = useSoftwareEncoder ? 'libx265' : 'hevc_videotoolbox';
    console.log(`[Server] Starting HLS transcode (${encoder}): ${meta.fileName} (${activeTranscodes.size}/${MAX_CONCURRENT_TRANSCODES} active)`);

    // ffmpeg command - HEVC for better compression (~40-50% smaller than H.264)
    // Hardware encoder (hevc_videotoolbox) on Apple Silicon, libx265 fallback
    const ffmpegArgs = useSoftwareEncoder ? [
        '-i', inputPath,
        '-c:v', 'libx265',
        '-preset', 'fast',
        '-crf', '26',                  // HEVC CRF 26 ≈ H.264 CRF 23 quality
        '-tag:v', 'hvc1',              // Required for Safari/iPhone HLS compatibility
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ac', '2',
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '0',
        '-hls_segment_filename', path.join(hlsDir, 'segment_%03d.ts'),
        outputPath
    ] : [
        '-i', inputPath,
        '-c:v', 'hevc_videotoolbox',   // M4 hardware HEVC encoder
        '-b:v', '4M',                  // Lower bitrate than H.264 — HEVC is more efficient
        '-tag:v', 'hvc1',              // Required for Safari/iPhone HLS compatibility
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ac', '2',
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '0',
        '-hls_segment_filename', path.join(hlsDir, 'segment_%03d.ts'),
        outputPath
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    transcodingJobs[fileId].process = ffmpeg;
    transcodingJobs[fileId].pid = ffmpeg.pid;

    let duration = 0;
    let stderrOutput = '';

    ffmpeg.stderr.on('data', (data) => {
        const str = data.toString();
        stderrOutput += str;
        // Parse duration from ffmpeg output
        const durationMatch = str.match(/Duration: (\d+):(\d+):(\d+)/);
        if (durationMatch) {
            duration = parseInt(durationMatch[1]) * 3600 +
                       parseInt(durationMatch[2]) * 60 +
                       parseInt(durationMatch[3]);
        }
        // Parse progress
        const timeMatch = str.match(/time=(\d+):(\d+):(\d+)/);
        if (timeMatch && duration > 0) {
            const current = parseInt(timeMatch[1]) * 3600 +
                           parseInt(timeMatch[2]) * 60 +
                           parseInt(timeMatch[3]);
            if (transcodingJobs[fileId]) transcodingJobs[fileId].progress = Math.round((current / duration) * 100);
        }
    });

    ffmpeg.on('close', (code) => {
        activeTranscodes.delete(fileId);

        // Check if file still exists in metadata (could have been purged during transcode)
        if (!fileMetadata[fileId]) {
            console.log(`[Server] File was deleted during transcode: ${meta.fileName}`);
            delete transcodingJobs[fileId];
            processTranscodeQueue();
            return;
        }

        if (code === 0) {
            console.log(`[Server] HLS transcode complete: ${meta.fileName}`);

            // Update metadata
            fileMetadata[fileId].hlsReady = true;
            fileMetadata[fileId].hlsPath = `/api/hls/${fileId}/playlist.m3u8`;
            fileMetadata[fileId].originalFileName = meta.fileName;
            fileMetadata[fileId].originalSize = meta.size;
            saveMetadata();

            // Delete original file after successful transcode
            const originalPath = path.join(UPLOADS_DIR, fileId);
            if (fs.existsSync(originalPath)) {
                fs.unlinkSync(originalPath);
                console.log(`[Server] Deleted original after transcode: ${fileId}`);
            }

            transcodingJobs[fileId] = { status: 'complete', progress: 100 };
        } else {
            // Check if hardware encoder failed - retry with software
            if (!useSoftwareEncoder && (
                stderrOutput.includes('videotoolbox') ||
                stderrOutput.includes('Encoder not found') ||
                stderrOutput.includes('Unknown encoder')
            )) {
                console.log(`[Server] Hardware encoder failed, retrying with libx265: ${meta.fileName}`);
                // Clean up partial HLS files
                try {
                    if (fs.existsSync(hlsDir)) {
                        fs.rmSync(hlsDir, { recursive: true });
                    }
                } catch (e) { /* ignore */ }
                // Retry with software encoder
                runTranscode(fileId, true);
                return;
            }

            console.error(`[Server] HLS transcode failed: ${meta.fileName} (code ${code})`);
            transcodingJobs[fileId] = { status: 'failed', progress: 0 };

            // Clean up partial HLS files
            try {
                if (fs.existsSync(hlsDir)) {
                    fs.rmSync(hlsDir, { recursive: true });
                }
            } catch (e) { /* ignore */ }
        }

        // Process next in queue
        processTranscodeQueue();
    });

    ffmpeg.on('error', (err) => {
        console.error(`[Server] ffmpeg error: ${err.message}`);
        activeTranscodes.delete(fileId);
        transcodingJobs[fileId] = { status: 'failed', progress: 0 };
        processTranscodeQueue();
    });
}

// Process the download queue (mirrors processTranscodeQueue)
function processDownloadQueue() {
    while (activeDownloads.size < MAX_CONCURRENT_DOWNLOADS && downloadQueue.length > 0) {
        const jobId = downloadQueue.shift();
        runDownload(jobId);
    }
}

// Process the extraction queue (mirrors processDownloadQueue)
function processExtractQueue() {
    if (extractsPaused) return;
    while (activeExtracts.size < MAX_CONCURRENT_EXTRACTS && extractQueue.length > 0) {
        const jobId = extractQueue.shift();
        runExtract(jobId);
    }
}

// Run a moment clip extraction (mirrors runDownload pattern)
function runExtract(jobId, useSoftwareEncoder = false) {
    const job = extractJobs[jobId];
    if (!job) return;

    // Resolve input source: prefer local server file over remote URL
    let inputSource = job.sourceUrl;
    if (job.sourceFileId) {
        const hlsPath = path.join(HLS_DIR, job.sourceFileId, 'playlist.m3u8');
        const rawPath = path.join(UPLOADS_DIR, job.sourceFileId);
        if (fs.existsSync(hlsPath)) inputSource = hlsPath;
        else if (fs.existsSync(rawPath)) inputSource = rawPath;
    }

    // For HTTP URLs, ffmpeg needs a browser User-Agent (some servers like Stash
    // reject ffmpeg's default UA). Use -user_agent flag instead of routing through
    // our own proxy — the loopback consumed HTTP connections for entire extraction
    // durations, starving browser video streams of their 6-per-origin connection limit.
    const needsUserAgent = inputSource.startsWith('http://') || inputSource.startsWith('https://');

    const partPath = job.outputPath + '.part';

    // Check disk space
    const freeMB = getFreeDiskSpaceMB();
    if (freeMB < MIN_DISK_SPACE_MB) {
        console.error(`[Server] Low disk space (${freeMB}MB free), skipping extraction: ${job.momentId}`);
        job.status = 'failed';
        job.error = 'Low disk space';
        activeExtracts.delete(jobId);
        processExtractQueue();
        return;
    }

    activeExtracts.add(jobId);
    job.status = 'extracting';
    job.startedAt = Date.now();

    const duration = job.end - job.start;
    // Use H.264 for extracted clips — universally playable in <video> elements.
    // (HEVC is used for HLS transcodes served via hls.js, but raw MP4 clips
    // need H.264 for Chrome/Firefox compatibility.)
    const encoder = useSoftwareEncoder ? 'libx264' : 'h264_videotoolbox';
    console.log(`[Server] Starting extraction (${encoder}): ${job.momentId} [${job.start.toFixed(1)}s - ${job.end.toFixed(1)}s = ${duration.toFixed(1)}s]`);

    const uaArgs = needsUserAgent ? ['-user_agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'] : [];
    const ffmpegArgs = [
        ...uaArgs,
        '-ss', String(job.start),
        '-i', inputSource,
        '-t', String(duration),
        ...(useSoftwareEncoder
            ? ['-c:v', 'libx264', '-preset', 'fast', '-crf', '23']
            : ['-c:v', 'h264_videotoolbox', '-b:v', '5M']),
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', '+faststart',
        '-f', 'mp4', '-y', partPath
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    job.process = ffmpeg;
    job.pid = ffmpeg.pid;

    let clipDuration = 0;
    let stderrOutput = '';
    let stderrBuffer = '';

    ffmpeg.stderr.on('data', (data) => {
        stderrBuffer += data.toString();
        stderrOutput += data.toString();
        const lines = stderrBuffer.split(/\r?\n|\r/);
        stderrBuffer = lines.pop(); // Keep incomplete trailing fragment
        for (const line of lines) {
            const durationMatch = line.match(/Duration: (\d+):(\d+):(\d+)/);
            if (durationMatch) {
                clipDuration = parseInt(durationMatch[1]) * 3600 +
                               parseInt(durationMatch[2]) * 60 +
                               parseInt(durationMatch[3]);
            }
            const timeMatch = line.match(/time=(\d+):(\d+):(\d+)/);
            if (timeMatch && clipDuration > 0 && extractJobs[jobId]) {
                const current = parseInt(timeMatch[1]) * 3600 +
                                parseInt(timeMatch[2]) * 60 +
                                parseInt(timeMatch[3]);
                extractJobs[jobId].progress = Math.round((current / clipDuration) * 100);
            }
        }
    });

    ffmpeg.on('close', (code) => {
        activeExtracts.delete(jobId);
        if (!extractJobs[jobId]) { processExtractQueue(); return; } // cancelled

        if (code === 0 && fs.existsSync(partPath)) {
            fs.renameSync(partPath, job.outputPath);
            const sizeMB = (fs.statSync(job.outputPath).size / 1048576).toFixed(1);
            console.log(`[Server] Extraction complete: ${job.momentId} (${sizeMB}MB)`);
            job.status = 'complete';
            job.progress = 100;
            job.completedAt = Date.now();
            delete job.process;
            // Update moment metadata so extracted flag persists server-side
            const mom = momentsDb.find(m => m.id === job.momentId);
            if (mom) {
                mom.extracted = true;
                mom.extractedPath = `/api/moments/${job.momentId}/clip.mp4`;
                saveMomentsDb();
            }
            // Auto-generate thumbnail from clip (avoids cold ffmpeg spawn on first request)
            const thumbPath = path.join(MOMENTS_THUMBS, `${job.momentId}.jpg`);
            if (!fs.existsSync(thumbPath)) {
                const thumbFfmpeg = spawn('ffmpeg', [
                    '-i', job.outputPath, '-vframes', '1', '-ss', '0.5',
                    '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
                    '-q:v', '4', '-y', thumbPath
                ]);
                thumbFfmpeg.on('close', (tc) => {
                    if (tc === 0) console.log(`[Server] Thumbnail generated: ${job.momentId}`);
                });
            }
        } else if (!useSoftwareEncoder && (
            stderrOutput.includes('videotoolbox') ||
            stderrOutput.includes('Encoder not found') ||
            stderrOutput.includes('Unknown encoder')
        )) {
            console.log(`[Server] Hardware encoder failed, retrying with libx264: ${job.momentId}`);
            try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (e) {}
            runExtract(jobId, true);
            return;
        } else {
            console.error(`[Server] Extraction failed: ${job.momentId} (code ${code})`);
            job.status = 'failed';
            job.error = `ffmpeg exited with code ${code}`;
            delete job.process;
            try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (e) {}
        }
        processExtractQueue();
    });

    ffmpeg.on('error', (err) => {
        console.error(`[Server] ffmpeg error (extraction): ${err.message}`);
        activeExtracts.delete(jobId);
        if (extractJobs[jobId]) {
            extractJobs[jobId].status = 'failed';
            extractJobs[jobId].error = err.message;
            delete extractJobs[jobId].process;
        }
        processExtractQueue();
    });
}

// Run a background HLS download (mirrors runTranscode pattern)
function runDownload(jobId) {
    const job = downloadJobs[jobId];
    if (!job) return;

    // Check disk space before starting
    const freeMB = getFreeDiskSpaceMB();
    if (freeMB < MIN_DISK_SPACE_MB) {
        console.error(`[Server] Low disk space (${freeMB}MB free), skipping download: ${job.filename}`);
        job.status = 'failed';
        job.error = 'Low disk space';
        processDownloadQueue();
        return;
    }

    activeDownloads.add(jobId);
    job.status = 'downloading';
    job.startedAt = Date.now();

    const partPath = job.filepath + '.part';
    console.log(`[Server] Download started: ${job.filename} (${activeDownloads.size}/${MAX_CONCURRENT_DOWNLOADS} active)`);

    const ffmpegArgs = [
        '-user_agent', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
        '-i', job.url,
        '-c', 'copy',
        '-bsf:a', 'aac_adtstoasc',
        '-movflags', '+faststart',
        '-f', 'mp4',
        '-y', partPath
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
        stdio: ['ignore', 'pipe', 'pipe']
    });
    job.process = ffmpeg;
    job.pid = ffmpeg.pid;

    let duration = 0;
    let stderrBuffer = '';

    ffmpeg.stderr.on('data', (data) => {
        // Buffer stderr to handle lines split across chunks
        stderrBuffer += data.toString();
        const lines = stderrBuffer.split(/\r?\n|\r/);
        stderrBuffer = lines.pop(); // Keep incomplete trailing fragment

        for (const line of lines) {
            const durationMatch = line.match(/Duration: (\d+):(\d+):(\d+)/);
            if (durationMatch) {
                duration = parseInt(durationMatch[1]) * 3600 +
                           parseInt(durationMatch[2]) * 60 +
                           parseInt(durationMatch[3]);
            }
            const timeMatch = line.match(/time=(\d+):(\d+):(\d+)/);
            if (timeMatch && duration > 0 && downloadJobs[jobId]) {
                const current = parseInt(timeMatch[1]) * 3600 +
                               parseInt(timeMatch[2]) * 60 +
                               parseInt(timeMatch[3]);
                downloadJobs[jobId].progress = Math.round((current / duration) * 100);
            }
        }
    });

    ffmpeg.on('close', (code) => {
        activeDownloads.delete(jobId);

        if (!downloadJobs[jobId]) {
            // Job was cancelled/deleted during download
            try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (e) { /* ignore */ }
            processDownloadQueue();
            return;
        }

        if (code === 0 && fs.existsSync(partPath)) {
            // Rename .part to final file
            try {
                fs.renameSync(partPath, job.filepath);
                const sizeMB = (fs.statSync(job.filepath).size / 1048576).toFixed(1);
                console.log(`[Server] Download complete: ${job.filename} (${sizeMB}MB)`);
                job.status = 'complete';
                job.progress = 100;
                job.completedAt = Date.now();
                delete job.process;
            } catch (e) {
                console.error(`[Server] Download rename failed: ${e.message}`);
                job.status = 'failed';
                job.error = 'File rename failed';
                delete job.process;
            }
        } else {
            console.error(`[Server] Download failed (code ${code}): ${job.filename}`);
            job.status = 'failed';
            job.error = `ffmpeg exited with code ${code}`;
            delete job.process;
            // Clean up partial file
            try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (e) { /* ignore */ }
        }

        processDownloadQueue();
    });

    ffmpeg.on('error', (err) => {
        console.error(`[Server] Download ffmpeg error: ${err.message}`);
        activeDownloads.delete(jobId);
        if (downloadJobs[jobId]) {
            downloadJobs[jobId].status = 'failed';
            downloadJobs[jobId].error = err.message;
            delete downloadJobs[jobId].process;
        }
        try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (e) { /* ignore */ }
        processDownloadQueue();
    });
}

// Clean up stale .part files on startup
try {
    const partFiles = fs.readdirSync(DOWNLOADS_DIR).filter(f => f.endsWith('.part'));
    if (partFiles.length > 0) {
        partFiles.forEach(f => {
            try { fs.unlinkSync(path.join(DOWNLOADS_DIR, f)); } catch (e) { /* ignore */ }
        });
        console.log(`[Server] Cleaned up ${partFiles.length} stale partial download(s)`);
    }
} catch (e) { /* ignore */ }

// Clean up stale extraction .part files from unclean shutdown
try {
    const partFiles = fs.readdirSync(MOMENTS_DIR).filter(f => f.endsWith('.part'));
    if (partFiles.length > 0) {
        partFiles.forEach(f => {
            try { fs.unlinkSync(path.join(MOMENTS_DIR, f)); } catch (e) { /* ignore */ }
        });
        console.log(`[Server] Cleaned up ${partFiles.length} stale extraction partial file(s)`);
    }
} catch (e) { /* ignore */ }

// Clean up completed downloads older than 24h
function cleanupExpiredDownloads() {
    const now = Date.now();
    let cleaned = 0;
    for (const [jobId, job] of Object.entries(downloadJobs)) {
        if (job.status === 'complete' && job.completedAt && (now - job.completedAt) > FILE_EXPIRY_MS) {
            try { if (fs.existsSync(job.filepath)) fs.unlinkSync(job.filepath); } catch (e) { /* ignore */ }
            delete downloadJobs[jobId];
            cleaned++;
        }
        // Also clean up failed jobs older than 1h (no file to delete, just memory)
        if (job.status === 'failed' && job.startedAt && (now - job.startedAt) > 60 * 60 * 1000) {
            delete downloadJobs[jobId];
            cleaned++;
        }
    }
    if (cleaned > 0) console.log(`[Server] Cleaned up ${cleaned} expired download job(s)`);
}
setInterval(cleanupExpiredDownloads, 60 * 60 * 1000);

// Clean up expired extraction jobs (mirrors cleanupExpiredDownloads)
function cleanupExpiredExtracts() {
    const now = Date.now();
    let cleaned = 0;
    for (const [jobId, job] of Object.entries(extractJobs)) {
        // Clean up completed job metadata older than 24h (files are persistent, just free memory)
        if (job.status === 'complete' && job.completedAt && (now - job.completedAt) > FILE_EXPIRY_MS) {
            delete extractJobs[jobId];
            cleaned++;
        }
        // Clean up failed jobs older than 1h
        if (job.status === 'failed' && job.startedAt && (now - job.startedAt) > 60 * 60 * 1000) {
            delete extractJobs[jobId];
            cleaned++;
        }
    }
    if (cleaned > 0) console.log(`[Server] Cleaned up ${cleaned} expired extraction job(s)`);
}
setInterval(cleanupExpiredExtracts, 60 * 60 * 1000);

// In-memory state for remote control relay
let currentState = { streams: [], timestamp: 0 };
let pendingCommands = [];

// File metadata: { fileId: { fileName, size, savedAt, setName, contentType } }
let fileMetadata = {};
try {
    if (fs.existsSync(UPLOADS_META)) {
        fileMetadata = JSON.parse(fs.readFileSync(UPLOADS_META, 'utf8'));
    }
} catch (e) {
    console.error('[Server] Failed to load file metadata:', e.message);
}

function saveMetadata() {
    try {
        const data = JSON.stringify(fileMetadata, null, 2);
        const tmpPath = UPLOADS_META + '.tmp';
        fs.writeFileSync(tmpPath, data);
        fs.renameSync(tmpPath, UPLOADS_META);
    } catch (e) {
        console.error('[Server] Failed to save file metadata:', e.message);
    }
}

// Sync HLS state on startup - detect completed transcodes that weren't marked in metadata
function syncHLSState() {
    let updated = 0;
    Object.keys(fileMetadata).forEach(fileId => {
        const meta = fileMetadata[fileId];
        if (meta.hlsReady) return; // Already marked

        const hlsPlaylist = path.join(HLS_DIR, fileId, 'playlist.m3u8');
        if (fs.existsSync(hlsPlaylist)) {
            meta.hlsReady = true;
            meta.hlsPath = `/api/hls/${encodeURIComponent(fileId)}/playlist.m3u8`;
            updated++;
        }
    });
    if (updated > 0) {
        saveMetadata();
        console.log(`[Server] Synced HLS state: ${updated} files marked as ready`);
    }
}
syncHLSState();

// Helper to delete a file and its HLS transcode
function deleteFileAndHLS(fileId, { deleteOriginal = true, deleteHLS = true, cancelTranscode = true } = {}) {
    const meta = fileMetadata[fileId];
    if (!meta) return false;

    // Cancel any active transcoding
    if (cancelTranscode && transcodingJobs[fileId]?.process) {
        try { transcodingJobs[fileId].process.kill(); } catch (_) { /* process already exited */ }
        activeTranscodes.delete(fileId);
        delete transcodingJobs[fileId];
    }

    // Delete original file
    if (deleteOriginal) {
        const filePath = path.join(UPLOADS_DIR, fileId);
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) { console.warn('[Server] Failed to delete file', fileId, ':', e.message); }
    }

    // Delete HLS directory
    if (deleteHLS) {
        const hlsDir = path.join(HLS_DIR, fileId);
        try {
            if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true });
        } catch (e) { console.warn('[Server] Failed to delete HLS dir', fileId, ':', e.message); }
    }

    return true;
}

// Cleanup expired files (not tied to a saved set) on startup and periodically
function cleanupExpiredFiles() {
    const now = Date.now();
    let cleaned = 0;
    Object.keys(fileMetadata).forEach(fileId => {
        const meta = fileMetadata[fileId];
        // Only auto-delete if not tied to a saved set and older than 24h
        if (!meta.setName && (now - meta.savedAt) > FILE_EXPIRY_MS) {
            deleteFileAndHLS(fileId);
            delete fileMetadata[fileId];
            cleaned++;
        }
    });
    if (cleaned > 0) {
        saveMetadata();
        console.log(`[Server] Cleaned up ${cleaned} expired file(s)`);
    }
}

// Run cleanup on startup and every hour
cleanupExpiredFiles();
setInterval(cleanupExpiredFiles, 60 * 60 * 1000);

// Check if HLS transcode is complete (has ENDLIST marker)
function isHLSComplete(fileId) {
    const playlistPath = path.join(HLS_DIR, fileId, 'playlist.m3u8');
    if (!fs.existsSync(playlistPath)) return false;
    try {
        const content = fs.readFileSync(playlistPath, 'utf8');
        return content.includes('#EXT-X-ENDLIST');
    } catch (e) {
        return false;
    }
}

// Get HLS directory size in bytes
function getHLSSize(fileId) {
    const hlsDir = path.join(HLS_DIR, fileId);
    if (!fs.existsSync(hlsDir)) return 0;
    let size = 0;
    try {
        fs.readdirSync(hlsDir).forEach(file => {
            const stat = fs.statSync(path.join(hlsDir, file));
            size += stat.size;
        });
    } catch (e) { /* ignore */ }
    return size;
}

// Queue pending transcodes on startup (files uploaded but not yet HLS-converted)
function queuePendingTranscodes() {
    if (!ffmpegAvailable) return;

    let queued = 0;
    let skippedComplete = 0;
    let cleanedPartial = 0;

    Object.keys(fileMetadata).forEach(fileId => {
        const meta = fileMetadata[fileId];
        if (!meta.contentType?.startsWith('video/')) return;

        const inputPath = path.join(UPLOADS_DIR, fileId);
        const hlsDir = path.join(HLS_DIR, fileId);

        // Already marked as HLS ready - skip
        if (meta.hlsReady) {
            skippedComplete++;
            return;
        }

        // Check if HLS exists and is complete (from previous run)
        if (isHLSComplete(fileId)) {
            // Mark as complete - keep original, user can delete via HLS manager
            meta.hlsReady = true;
            meta.hlsPath = `/api/hls/${fileId}/playlist.m3u8`;
            console.log(`[Server] Found complete HLS: ${meta.fileName}`);
            skippedComplete++;
            return;
        }

        // Partial HLS exists - clean it up and re-transcode
        if (fs.existsSync(hlsDir)) {
            fs.rmSync(hlsDir, { recursive: true });
            cleanedPartial++;
        }

        // Queue for transcoding if original exists
        if (fs.existsSync(inputPath)) {
            startHLSTranscode(fileId);
            queued++;
        }
    });

    saveMetadata();

    if (queued > 0 || cleanedPartial > 0) {
        console.log(`[Server] Transcodes: ${queued} queued, ${skippedComplete} already done, ${cleanedPartial} partial cleaned`);
    }
}

// Don't auto-start transcodes - user must click Start in Files modal
// setTimeout(queuePendingTranscodes, 2000);

// Fetch a URL with redirect following (up to 5 redirects)
function fetchUrl(targetUrl, callback, redirectCount = 0, extraHeaders = {}) {
    if (redirectCount > 5) {
        callback(new Error('Too many redirects'));
        return;
    }

    // Validate URL protocol to prevent server crash from malformed URLs
    if (!targetUrl.startsWith('http://') && !targetUrl.startsWith('https://')) {
        callback(new Error(`Invalid URL protocol: ${targetUrl.substring(0, 30)}`));
        return;
    }

    const mod = targetUrl.startsWith('https') ? https : http;
    const headers = { 'User-Agent': 'Plexd/1.0', ...extraHeaders };
    const req = mod.get(targetUrl, { headers, timeout: 30000 }, (proxyRes) => {
        // Follow redirects
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
            const redirectUrl = new URL(proxyRes.headers.location, targetUrl).href;
            proxyRes.resume(); // Consume response to free socket
            fetchUrl(redirectUrl, callback, redirectCount + 1, extraHeaders);
            return;
        }
        callback(null, proxyRes);
    });
    req.on('error', callback);
    req.on('timeout', () => {
        req.destroy(new Error('Request timeout'));
    });
}

// Promise wrapper around fetchUrl for scraping (returns full body as string)
const BROWSER_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
function fetchPage(url) {
    return new Promise((resolve, reject) => {
        fetchUrl(url, (err, res) => {
            if (err) return reject(err);
            if (res.statusCode !== 200) {
                res.resume();
                return reject(new Error('HTTP ' + res.statusCode));
            }
            let body = '';
            res.on('data', chunk => body += chunk);
            res.on('end', () => resolve(body));
            res.on('error', reject);
        }, 0, { 'User-Agent': BROWSER_UA });
    });
}

// Scrape xHamster listing page for video URLs
async function scrapeXhamsterListing(count) {
    const page = Math.floor(Math.random() * 20) + 1;
    const listUrl = 'https://xhamster.com/best/' + page;
    console.log('[Demo] Fetching listing: ' + listUrl);

    const html = await fetchPage(listUrl);

    // Extract video page URLs from listing (exclude /my/ nav links)
    const linkPattern = /href="(https:\/\/xhamster\.com\/videos\/[a-z0-9][\w-]+-\w+)"/gi;
    const urls = [];
    const seen = new Set();
    let match;
    while ((match = linkPattern.exec(html)) !== null) {
        if (!seen.has(match[1])) {
            seen.add(match[1]);
            urls.push(match[1]);
        }
    }

    // Grab more than needed to absorb failures
    return urls.slice(0, Math.ceil(count * 1.5));
}

// Extract HLS URL + title from an xHamster video page
async function scrapeXhamsterVideo(pageUrl) {
    const html = await fetchPage(pageUrl);

    // Extract title (xHamster uses <title > with space before >)
    const titleMatch = html.match(/<title[^>]*>([^<]+)<\/title>/i);
    const title = titleMatch
        ? titleMatch[1].replace(/\s*[\|:]\s*xHamster.*$/i, '').trim()
        : 'Untitled';

    // Try window.initials JSON (primary method)
    const initialsMatch = html.match(
        /window\.initials\s*=\s*(\{.+?\});\s*<\/script>/s
    );
    if (initialsMatch) {
        try {
            const initials = JSON.parse(initialsMatch[1]);
            const sources = initials
                && initials.videoModel
                && initials.videoModel.sources;
            const hlsUrl = (sources && sources.hls && sources.hls.url)
                || (sources && sources.mp4 && (
                    sources.mp4['1080p']
                    || sources.mp4['720p']
                    || sources.mp4['480p']
                ));
            if (hlsUrl) return { url: hlsUrl, title: title };
        } catch (e) {
            console.log('[Demo] JSON parse failed for '
                + pageUrl + ': ' + e.message);
        }
    }

    // Fallback: look for .m3u8 URLs directly in page source
    const m3u8Match = html.match(/(https?:\/\/[^\s"']+\.m3u8[^\s"']*)/);
    if (m3u8Match) return { url: m3u8Match[1], title: title };

    // Fallback: look for MP4 URLs
    const mp4Match = html.match(/(https?:\/\/[^\s"']+\.mp4[^\s"']*)/);
    if (mp4Match) return { url: mp4Match[1], title: title };

    return null;
}

// ── Aylo Network Integration ──────────────────────────────────────────────
// Multi-site Aylo (MindGeek) support.
// All sites share the API at site-api.project1service.com with identical cookie names.
// Auth cookie domains: site-ma.brazzers.com, site-ma.mofos.com, etc.
// Cross-network access: a subscription (e.g. Mofos) unlocks content from other brands
// via the `groupId` API parameter (each brand has a numeric group ID).

const AYLO_SITES = {
    brazzers:     { origin: 'site-ma.brazzers.com',     cookieHost: 'brazzers' },
    mofos:        { origin: 'site-ma.mofos.com',        cookieHost: 'mofos' },
    spicevids:    { origin: 'site-ma.spicevids.com',    cookieHost: 'spicevids' },
    spicevidsgay: { origin: 'site-ma.spicevidsgay.com', cookieHost: 'spicevidsgay' },
    // Add more: log into site-ma.X.com in Chrome, then add entry here
};

// Brand groups: accessible via `groupId=` parameter on /v2/releases.
// A subscription may unlock multiple groups. Groups with no video files through a
// given subscription are auto-detected and skipped at startup.
// Synthetic tag IDs: -(groupId) e.g. groupId 1 → tagId -1
const AYLO_GROUPS = {
    'Reality Kings':      { groupId: 1 },
    'Babes':              { groupId: 3 },
    'Brazzers':           { groupId: 5 },
    'Bromo':              { groupId: 7 },
    'Digital Playground': { groupId: 9 },
    'Erito':              { groupId: 11 },
    'Hentai Pros':        { groupId: 13 },
    'Mofos':              { groupId: 15 },
    'Men':                { groupId: 17 },
    'Reality Dudes':      { groupId: 19 },
    'Sean Cody':          { groupId: 21 },
    'Trans Angels':       { groupId: 23 },
    'True Amateurs':      { groupId: 27 },
    'Twistys':            { groupId: 29 },
};

// Per-auth playable groups — populated at startup by probing each group for video files.
// Map: siteName → [{ name, groupId, tagId, total, native }]
let _playableGroups = {};

// Reverse lookup: synthetic tagId → { groupName, groupId }
const AYLO_GROUP_BY_TAG_ID = {};
for (const [name, g] of Object.entries(AYLO_GROUPS)) {
    AYLO_GROUP_BY_TAG_ID[-g.groupId] = { name, groupId: g.groupId };
}

// Collection (sub-brand) cache — populated from /v1/collections API per site.
let _collectionCache = null;

// ── Reptyle (Paper Street Media) Auth ──────────────────────────────────────────
// OAuth via auth.reptyle.com. refresh_token (~30 days) in Chrome cookies,
// exchanged for access_token (~30 min) via POST /oauth/refresh.
// API at api2.reptyle.com/api/v1.
const REPTYLE_CONFIG = {
    authHost: 'auth.reptyle.com',
    apiHost: 'api2.reptyle.com',
    origin: 'app.reptyle.com',
    cookieHost: 'reptyle',
};
let _reptyleAccessToken = null; // Cached access token

function getReptyleRefreshToken() {
    const cookies = readChromeCookies('%reptyle%');
    return cookies.refresh_token || null;
}

function refreshReptyleAuth() {
    const refreshToken = getReptyleRefreshToken();
    if (!refreshToken) return Promise.resolve(null);
    if (isJwtExpired(refreshToken)) {
        console.log('[Reptyle] Refresh token expired — log into app.reptyle.com in Chrome');
        return Promise.resolve(null);
    }
    return new Promise((resolve) => {
        const body = JSON.stringify({ refresh_token: refreshToken });
        const req = https.request({
            hostname: REPTYLE_CONFIG.authHost,
            path: '/oauth/refresh',
            method: 'POST',
            headers: {
                'User-Agent': BROWSER_UA,
                'Origin': 'https://' + REPTYLE_CONFIG.origin,
                'Referer': 'https://' + REPTYLE_CONFIG.origin + '/',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Accept': 'application/json'
            }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode === 200 && json.access_token) {
                        _reptyleAccessToken = json.access_token;
                        resolve(json.access_token);
                    } else {
                        console.log('[Reptyle] Refresh failed (' + res.statusCode + '):', data.slice(0, 200));
                        resolve(null);
                    }
                } catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.write(body);
        req.end();
    });
}

async function getReptyleAuth() {
    // Return cached if still valid
    if (_reptyleAccessToken && !isJwtExpired(_reptyleAccessToken)) {
        return { accessToken: _reptyleAccessToken, _site: 'reptyle' };
    }
    const token = await refreshReptyleAuth();
    if (token) return { accessToken: token, _site: 'reptyle' };
    return { error: 'Reptyle login expired. Log into app.reptyle.com in Chrome.', _site: 'reptyle' };
}

// ── Stash Server Integration ───────────────────────────────────────────────────
// Stash is a local media server with a GraphQL API. Scenes, tags, performers,
// and studios are accessed directly — no auth needed on Tailscale.
// ID namespacing: Stash IDs are offset to avoid collisions with Aylo IDs.
//   Tags/Performers: stashId + 100000 (Stash tag 42 → 100042)
//   Studios:         -1000 - stashId  (Stash studio 5 → -1005)
//   Stash umbrella:  -1000            (all Stash content)

const STASH_CONFIG = {
    url: 'http://100.100.33.117:9999',
    apiKey: null,
};
const STASH_TAG_OFFSET = 100000;
const STASH_PERFORMER_OFFSET = 100000;
const STASH_STUDIO_OFFSET = -1000;

async function fetchStashGraphQL(query, variables) {
    const headers = { 'Content-Type': 'application/json' };
    if (STASH_CONFIG.apiKey) headers['ApiKey'] = STASH_CONFIG.apiKey;
    const resp = await fetch(STASH_CONFIG.url + '/graphql', {
        method: 'POST',
        headers,
        body: JSON.stringify({ query, variables: variables || {} }),
    });
    if (!resp.ok) throw new Error('Stash GraphQL error: ' + resp.status);
    const json = await resp.json();
    if (json.errors && json.errors.length > 0) throw new Error('Stash: ' + json.errors[0].message);
    return json.data;
}

async function checkStashConnection() {
    try {
        await fetchStashGraphQL('{ systemStatus { status } }');
        return { connected: true };
    } catch (e) {
        return { connected: false, error: e.message };
    }
}

// Scrape scenes from Stash with optional tag/performer/studio filters.
// Returns streams in the same shape as Aylo: { url, title, tags, actors, category, site }
async function scrapeStashScenes(count, stashTagIds, stashActorIds, stashStudioIds) {
    const sceneFilter = {};

    // Un-offset IDs back to real Stash IDs
    if (stashTagIds && stashTagIds.length > 0) {
        sceneFilter.tags = {
            value: stashTagIds.map(id => String(id - STASH_TAG_OFFSET)),
            modifier: 'INCLUDES',
        };
    }
    if (stashActorIds && stashActorIds.length > 0) {
        sceneFilter.performers = {
            value: stashActorIds.map(id => String(id - STASH_PERFORMER_OFFSET)),
            modifier: 'INCLUDES',
        };
    }
    if (stashStudioIds && stashStudioIds.length > 0) {
        // Un-offset: -1005 → 5 (STASH_STUDIO_OFFSET is -1000)
        // Skip umbrella ID (-1000 → 0) — it means "all Stash", not a real studio
        const realStudioIds = stashStudioIds
            .map(id => STASH_STUDIO_OFFSET - id)
            .filter(id => id > 0);
        if (realStudioIds.length > 0) {
            sceneFilter.studios = {
                value: realStudioIds.map(String),
                modifier: 'INCLUDES',
            };
        }
    }

    const query = `query FindScenes($filter: FindFilterType, $scene_filter: SceneFilterType) {
        findScenes(filter: $filter, scene_filter: $scene_filter) {
            scenes {
                id title rating100
                paths { stream screenshot }
                performers { id name }
                tags { id name }
                studio { id name }
                files { width height duration }
            }
        }
    }`;

    const variables = {
        filter: { per_page: count * 2, sort: 'random', direction: 'DESC' },
        scene_filter: Object.keys(sceneFilter).length > 0 ? sceneFilter : undefined,
    };

    const data = await fetchStashGraphQL(query, variables);
    const scenes = data.findScenes?.scenes || [];

    return scenes.slice(0, count).map(scene => {
        const tags = (scene.tags || []).map(t => t.name);
        const actors = (scene.performers || []).map(p => p.name);
        const studioName = scene.studio?.name || '';
        // Add "Stash" source tag
        if (!tags.includes('Stash')) tags.unshift('Stash');
        return {
            url: scene.paths?.stream || '',
            title: scene.title || 'Stash Scene',
            tags,
            actors,
            category: studioName,
            site: 'Stash',
            thumbnail: scene.paths?.screenshot || null,
            rating: scene.rating100 != null ? scene.rating100 : null,
        };
    }).filter(s => s.url);
}

// ── Chrome cookie decryption (macOS) + Aylo API helpers ────────────────────────
// Auth tokens: access_token_ma (~1hr), refresh_token_ma (~30min), instance_token (~2 days)
// All stored as encrypted cookies in Chrome profile

const CHROME_COOKIE_DB = path.join(__dirname, '.chrome-profile', 'Default', 'Cookies');
let _chromeCookieKey = null; // Cached decryption key

function getChromeCookieKey() {
    if (_chromeCookieKey) return _chromeCookieKey;
    try {
        const { execSync } = require('child_process');
        const chromePass = execSync(
            'security find-generic-password -w -s "Chrome Safe Storage" -a "Chrome"',
            { encoding: 'utf8' }
        ).trim();
        _chromeCookieKey = crypto.pbkdf2Sync(chromePass, 'saltysalt', 1003, 16, 'sha1');
        return _chromeCookieKey;
    } catch (e) {
        console.error('[Aylo] Failed to get Chrome cookie key:', e.message);
        return null;
    }
}

function decryptChromeCookie(hexStr) {
    const key = getChromeCookieKey();
    if (!key || !hexStr) return '';
    try {
        const enc = Buffer.from(hexStr, 'hex');
        if (enc.length < 4) return '';
        const data = enc.slice(3); // Strip "v10" prefix
        const iv = Buffer.alloc(16, 0x20);
        const decipher = crypto.createDecipheriv('aes-128-cbc', key, iv);
        decipher.setAutoPadding(false);
        const dec = Buffer.concat([decipher.update(data), decipher.final()]);
        const s = dec.toString('utf8');
        // Extract JWT (starts with eyJ)
        const jwtStart = s.indexOf('eyJ');
        if (jwtStart >= 0) {
            const jwtMatch = s.substring(jwtStart).match(/^[A-Za-z0-9_\-\.]+/);
            return jwtMatch ? jwtMatch[0] : '';
        }
        // Extract UUID (e.g., app_session_id) — decryption padding can leave garbage prefix
        const uuidMatch = s.match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
        if (uuidMatch) return uuidMatch[0];
        // Non-JWT, non-UUID: strip leading non-printable bytes
        let start = 0;
        while (start < s.length && s.charCodeAt(start) < 32) start++;
        return s.substring(start).replace(/[\x00-\x1f]+$/g, '');
    } catch (e) {
        return '';
    }
}

function readChromeCookies(hostPattern) {
    try {
        const { execSync } = require('child_process');
        const rows = execSync(
            `sqlite3 "${CHROME_COOKIE_DB}" "SELECT name, hex(encrypted_value) FROM cookies WHERE host_key LIKE '${hostPattern}'"`,
            { encoding: 'utf8' }
        ).trim();
        const cookies = {};
        for (const line of rows.split('\n')) {
            if (!line) continue;
            const [name, hex] = line.split('|');
            const val = decryptChromeCookie(hex);
            if (val) cookies[name] = val;
        }
        return cookies;
    } catch (e) {
        console.error('[Aylo] Failed to read Chrome cookies:', e.message);
        return {};
    }
}

function isJwtExpired(token) {
    try {
        const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString());
        return !payload.exp || (payload.exp * 1000) < Date.now();
    } catch (e) {
        return true;
    }
}

// Fetch JSON from Aylo API with proper auth headers
// CRITICAL: Aylo API requires raw JWT — NO "Bearer" prefix on Authorization header
function fetchAyloApi(apiPath, auth, method) {
    return new Promise((resolve, reject) => {
        const urlObj = new URL(apiPath, 'https://site-api.project1service.com');
        const origin = auth._origin || 'site-ma.brazzers.com';
        const headers = {
            'User-Agent': BROWSER_UA,
            'Origin': 'https://' + origin,
            'Referer': 'https://' + origin + '/',
            'Accept': 'application/json',
            'Instance': auth.instanceToken
        };
        if (auth.accessToken) headers['Authorization'] = auth.accessToken;
        if (auth.appSessionId) headers['X-APP-SESSION-ID'] = auth.appSessionId;
        if (auth.externalIp) headers['X-Forwarded-For'] = auth.externalIp;

        const req = https.request({
            hostname: urlObj.hostname,
            path: urlObj.pathname + urlObj.search,
            method: method || 'GET',
            headers: headers
        }, res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                try { resolve({ status: res.statusCode, data: JSON.parse(body) }); }
                catch (e) { resolve({ status: res.statusCode, data: body }); }
            });
        });
        req.on('error', reject);
        req.end();
    });
}

// Try to refresh access_token using refresh_token via auth service
// Re-authenticate with Aylo using instance token only (no refresh token needed).
// Returns { access_token, refresh_token } or null.
function reauthAyloWithInstance(instanceToken, origin) {
    const siteOrigin = origin || 'site-ma.brazzers.com';
    return new Promise((resolve) => {
        const body = JSON.stringify({});
        const req = https.request({
            hostname: 'auth-service.project1service.com',
            path: '/v1/authenticate',
            method: 'POST',
            headers: {
                'User-Agent': BROWSER_UA,
                'Origin': 'https://' + siteOrigin,
                'Referer': 'https://' + siteOrigin + '/',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Instance': instanceToken
            }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode === 200 && json.access_token) {
                        resolve({ access_token: json.access_token, refresh_token: json.refresh_token || null });
                    } else {
                        console.log('[Aylo] Reauth failed (' + res.statusCode + '):', data.slice(0, 200));
                        resolve(null);
                    }
                } catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.write(body);
        req.end();
    });
}

function refreshAyloAccessToken(instanceToken, refreshToken, origin) {
    const siteOrigin = origin || 'site-ma.brazzers.com';
    return new Promise((resolve, reject) => {
        const body = JSON.stringify({ refreshToken: refreshToken });
        const req = https.request({
            hostname: 'auth-service.project1service.com',
            path: '/v1/authenticate/renew',
            method: 'POST',
            headers: {
                'User-Agent': BROWSER_UA,
                'Origin': 'https://' + siteOrigin,
                'Referer': 'https://' + siteOrigin + '/',
                'Content-Type': 'application/json',
                'Content-Length': Buffer.byteLength(body),
                'Instance': instanceToken
            }
        }, res => {
            let data = '';
            res.on('data', c => data += c);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    if (res.statusCode === 200 && json.access_token) {
                        resolve(json.access_token);
                    } else {
                        resolve(null);
                    }
                } catch (e) { resolve(null); }
            });
        });
        req.on('error', () => resolve(null));
        req.write(body);
        req.end();
    });
}

// Get valid auth tokens for a specific Aylo site from Chrome cookies.
// Multiple sites can share a cookieHost (e.g. all Mofos-network sites use mofos cookies).
// Cookie reads are cached per cookieHost to avoid redundant decryption.
let _cookieCache = {};       // cookieHost → { cookies, ts }
let _refreshedTokens = {};   // cookieHost → refreshed accessToken
const COOKIE_CACHE_TTL = 30000; // 30s

async function getAyloAuth(siteName) {
    const site = AYLO_SITES[siteName];
    if (!site) return { error: 'Unknown Aylo site: ' + siteName };

    // Cache cookie reads per cookieHost (many sites share the same cookies)
    const cached = _cookieCache[site.cookieHost];
    let cookies;
    if (cached && (Date.now() - cached.ts) < COOKIE_CACHE_TTL) {
        cookies = cached.cookies;
    } else {
        cookies = readChromeCookies('%' + site.cookieHost + '%');
        _cookieCache[site.cookieHost] = { cookies, ts: Date.now() };
    }

    const instanceToken = cookies.instance_token;
    const appSessionId = cookies.app_session_id || '';
    if (!instanceToken || isJwtExpired(instanceToken)) {
        return { error: 'No valid ' + siteName + ' session. Log into ' + site.origin + ' in Chrome.', _origin: site.origin, _site: siteName };
    }

    // Check for already-refreshed token (shared across sites with same cookieHost)
    let accessToken = _refreshedTokens[site.cookieHost] || cookies.access_token_ma;
    if (accessToken && !isJwtExpired(accessToken)) {
        return { accessToken, instanceToken, appSessionId, _origin: site.origin, _site: siteName };
    }

    // Try refresh with refresh_token (once per cookieHost)
    const refreshToken = cookies.refresh_token_ma;
    if (refreshToken && !isJwtExpired(refreshToken)) {
        console.log('[Aylo:' + siteName + '] Access token expired, attempting refresh...');
        accessToken = await refreshAyloAccessToken(instanceToken, refreshToken, site.origin);
        if (accessToken) {
            console.log('[Aylo:' + siteName + '] Token refreshed via refresh_token');
            _refreshedTokens[site.cookieHost] = accessToken;
            return { accessToken, instanceToken, appSessionId, _origin: site.origin, _site: siteName };
        }
    }

    // Fallback: re-authenticate using instance_token alone (no refresh_token needed)
    if (instanceToken && !isJwtExpired(instanceToken)) {
        console.log('[Aylo:' + siteName + '] Refresh token missing/expired, trying instance reauth...');
        const result = await reauthAyloWithInstance(instanceToken, site.origin);
        if (result) {
            console.log('[Aylo:' + siteName + '] Reauth via instance token succeeded');
            _refreshedTokens[site.cookieHost] = result.access_token;
            return { accessToken: result.access_token, instanceToken, appSessionId, _origin: site.origin, _site: siteName };
        }
    }

    return {
        instanceToken,
        accessToken: null,
        appSessionId,
        _origin: site.origin,
        _site: siteName,
        error: siteName + ' login expired. Log into ' + site.origin + ' in Chrome, then try again.'
    };
}

// Get all valid auths across all Aylo sites (for multi-site scraping)
async function getAllAyloAuths() {
    const auths = [];
    for (const name of Object.keys(AYLO_SITES)) {
        const auth = await getAyloAuth(name);
        if (auth.accessToken) auths.push(auth);
    }
    return auths;
}

// Convenience: get first available Aylo auth (for single-auth endpoints like performer search)
async function getAnyAyloAuth() {
    for (const name of Object.keys(AYLO_SITES)) {
        const auth = await getAyloAuth(name);
        if (auth.accessToken) return auth;
    }
    // No valid auth — return first site's error for messaging
    return getAyloAuth(Object.keys(AYLO_SITES)[0]);
}

// Extract best video URL from Aylo videos.full.files array
// Format: [{type: "hls"|"http", format: "320p"|"480p"|..., urls: {view}, sizeBytes}, ...]
function extractBestVideoUrl(files) {
    if (!files || !Array.isArray(files) || files.length === 0) return null;
    // Prefer HLS, sorted by resolution descending (pick highest quality)
    const hlsFiles = files
        .filter(f => f.type === 'hls' && f.urls && f.urls.view)
        .sort((a, b) => (parseInt(b.format) || 0) - (parseInt(a.format) || 0));
    if (hlsFiles.length > 0) return hlsFiles[0].urls.view;
    // Fallback: highest resolution MP4
    const mp4s = files
        .filter(f => f.type === 'http' && f.urls && f.urls.view)
        .sort((a, b) => (parseInt(b.format) || 0) - (parseInt(a.format) || 0));
    return mp4s.length > 0 ? mp4s[0].urls.view : null;
}

// Detect external IP (cached) — needed for X-Forwarded-For header
let _cachedExternalIp = null;
function getExternalIp() {
    if (_cachedExternalIp) return Promise.resolve(_cachedExternalIp);
    return new Promise(resolve => {
        https.get('https://api.ipify.org', res => {
            let body = '';
            res.on('data', c => body += c);
            res.on('end', () => {
                _cachedExternalIp = body.trim() || null;
                resolve(_cachedExternalIp);
            });
        }).on('error', () => resolve(null));
    });
}

// ── Disk-cached Tags & Performers (Multi-Site) ────────────────────────────────────
// Per-site cache files: {site}-tags.json, {site}-performers.json
// Merged when serving /api/demo/tags and /api/demo/actors — deduplicated by ID.
// Background-refreshed for each site with valid auth.
const CACHE_DIR = path.join(__dirname, 'uploads', 'cache');
const CATALOG_REFRESH_INTERVAL = 6 * 60 * 60 * 1000; // 6 hours
const STASH_TAGS_CACHE = path.join(CACHE_DIR, 'stash-tags.json');
const STASH_PERFORMERS_CACHE = path.join(CACHE_DIR, 'stash-performers.json');
const STASH_STUDIOS_CACHE = path.join(CACHE_DIR, 'stash-studios.json');

let _tagCache = null;   // Merged tag cache (byCategory format)
let _actorCache = null;  // Merged actor cache (sorted array)

function siteTagsCacheFile(siteName) { return path.join(CACHE_DIR, siteName + '-tags.json'); }
function siteActorsCacheFile(siteName) { return path.join(CACHE_DIR, siteName + '-performers.json'); }

function loadCacheFromDisk() {
    try { fs.mkdirSync(CACHE_DIR, { recursive: true }); } catch (e) { /* exists */ }

    // Load per-site caches and merge
    const allTags = {};  // byCategory merged
    const allActors = {}; // by id
    let tagSites = 0, actorSites = 0;

    for (const siteName of Object.keys(AYLO_SITES)) {
        try {
            const siteTags = JSON.parse(fs.readFileSync(siteTagsCacheFile(siteName), 'utf8'));
            for (const cat of Object.keys(siteTags)) {
                if (!allTags[cat]) allTags[cat] = {};
                for (const t of siteTags[cat]) allTags[cat][t.id] = t;
            }
            tagSites++;
        } catch (e) { /* no cache for this site */ }
        try {
            const siteActors = JSON.parse(fs.readFileSync(siteActorsCacheFile(siteName), 'utf8'));
            for (const a of siteActors) allActors[a.id] = a;
            actorSites++;
        } catch (e) { /* no cache for this site */ }
    }

    // Load Stash caches (offset IDs already applied in cache files)
    try {
        const stashTags = JSON.parse(fs.readFileSync(STASH_TAGS_CACHE, 'utf8'));
        for (const cat of Object.keys(stashTags)) {
            if (!allTags[cat]) allTags[cat] = {};
            for (const t of stashTags[cat]) allTags[cat][t.id] = t;
        }
        tagSites++;
    } catch (e) { /* no stash tags cache */ }
    try {
        const stashActors = JSON.parse(fs.readFileSync(STASH_PERFORMERS_CACHE, 'utf8'));
        for (const a of stashActors) allActors[a.id] = a;
        actorSites++;
    } catch (e) { /* no stash performers cache */ }

    // Fallback: load old single-file caches if no per-site caches exist
    if (tagSites === 0) {
        try {
            _tagCache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'tags.json'), 'utf8'));
            console.log('[Cache] Loaded legacy tags.json: ' + Object.keys(_tagCache).length + ' categories');
        } catch (e) { _tagCache = null; }
    } else {
        // Convert merged map to sorted arrays
        _tagCache = {};
        for (const cat of Object.keys(allTags)) {
            _tagCache[cat] = Object.values(allTags[cat]).sort((a, b) => a.name.localeCompare(b.name));
        }
        console.log('[Cache] Loaded tags from ' + tagSites + ' sites: ' + Object.keys(_tagCache).length + ' categories');
    }

    if (actorSites === 0) {
        try {
            _actorCache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'performers.json'), 'utf8'));
            console.log('[Cache] Loaded legacy performers.json: ' + _actorCache.length + ' performers');
        } catch (e) { _actorCache = null; }
    } else {
        _actorCache = Object.values(allActors).sort((a, b) => a.name.localeCompare(b.name));
        console.log('[Cache] Loaded performers from ' + actorSites + ' sites: ' + _actorCache.length + ' performers');
    }
}

function saveCacheToDisk(file, data) {
    try {
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(file, JSON.stringify(data));
    } catch (e) {
        console.error('[Cache] Failed to write ' + file + ':', e.message);
    }
}

// Rebuild merged caches from all per-site files on disk (Aylo + Stash)
function rebuildMergedCaches() {
    const allTags = {};
    const allActors = {};
    // Aylo per-site caches
    for (const siteName of Object.keys(AYLO_SITES)) {
        try {
            const siteTags = JSON.parse(fs.readFileSync(siteTagsCacheFile(siteName), 'utf8'));
            for (const cat of Object.keys(siteTags)) {
                if (!allTags[cat]) allTags[cat] = {};
                for (const t of siteTags[cat]) allTags[cat][t.id] = t;
            }
        } catch (e) { /* skip */ }
        try {
            const siteActors = JSON.parse(fs.readFileSync(siteActorsCacheFile(siteName), 'utf8'));
            for (const a of siteActors) allActors[a.id] = a;
        } catch (e) { /* skip */ }
    }
    // Stash caches (offset IDs already applied)
    try {
        const stashTags = JSON.parse(fs.readFileSync(STASH_TAGS_CACHE, 'utf8'));
        for (const cat of Object.keys(stashTags)) {
            if (!allTags[cat]) allTags[cat] = {};
            for (const t of stashTags[cat]) allTags[cat][t.id] = t;
        }
    } catch (e) { /* no stash tags cache */ }
    try {
        const stashActors = JSON.parse(fs.readFileSync(STASH_PERFORMERS_CACHE, 'utf8'));
        for (const a of stashActors) allActors[a.id] = a;
    } catch (e) { /* no stash performers cache */ }

    if (Object.keys(allTags).length > 0) {
        _tagCache = {};
        for (const cat of Object.keys(allTags)) {
            _tagCache[cat] = Object.values(allTags[cat]).sort((a, b) => a.name.localeCompare(b.name));
        }
    }
    if (Object.keys(allActors).length > 0) {
        _actorCache = Object.values(allActors).sort((a, b) => a.name.localeCompare(b.name));
    }
}

async function refreshTagsFromApi(auth) {
    auth.externalIp = await getExternalIp();
    const siteName = auth._site || 'brazzers';
    let tags;
    try {
        const resp = await fetchAyloApi('/v2/tags?limit=500&orderBy=name', auth);
        if (resp.status === 200 && resp.data.result) {
            tags = resp.data.result.filter(t => t.isVisible !== false)
                .map(t => ({ id: t.id, name: t.name, category: t.category || 'Other' }));
        }
    } catch (e) { /* fall through */ }

    if (!tags) {
        try {
            const resp = await fetchAyloApi('/v2/releases?limit=100&type=scene&orderBy=-dateReleased', auth);
            const tagMap = {};
            for (const scene of (resp.data.result || [])) {
                for (const t of (scene.tags || [])) {
                    if (!tagMap[t.id]) tagMap[t.id] = { id: t.id, name: t.name, category: t.category || 'Other' };
                }
            }
            tags = Object.values(tagMap);
        } catch (e) { return _tagCache; }
    }

    const byCategory = {};
    for (const t of tags) {
        (byCategory[t.category] ||= []).push({ id: t.id, name: t.name });
    }
    for (const cat of Object.keys(byCategory)) {
        byCategory[cat].sort((a, b) => a.name.localeCompare(b.name));
    }

    if (Object.keys(byCategory).length > 0) {
        saveCacheToDisk(siteTagsCacheFile(siteName), byCategory);
        console.log('[Cache] Refreshed ' + siteName + ' tags: ' + Object.keys(byCategory).length + ' categories');
        rebuildMergedCaches();
    }
    return _tagCache;
}

async function refreshActorsFromApi(auth) {
    auth.externalIp = await getExternalIp();
    const siteName = auth._site || 'brazzers';

    // Build group queries: native (no groupId) + each playable cross-network group
    const groups = _playableGroups[siteName] || [];
    const groupQueries = ['']; // empty = native catalog
    for (const g of groups) {
        if (!g.native && g.groupId) groupQueries.push('&groupId=' + g.groupId);
    }

    // Extract performers from top-rated scenes across all accessible groups
    const allQueries = [];
    for (const groupParam of groupQueries) {
        const pages = Array.from({ length: 5 }, (_, i) => i * 50);
        for (const offset of pages) {
            allQueries.push(fetchAyloApi(
                `/v2/releases?limit=50&offset=${offset}&type=scene&orderBy=-stats.rating${groupParam}`, auth
            ));
        }
    }
    const pageResults = await Promise.allSettled(allQueries);
    const actorMap = {};
    for (const r of pageResults) {
        if (r.status !== 'fulfilled' || r.value.status !== 200) continue;
        for (const scene of (r.value.data.result || [])) {
            const rating = scene.stats && scene.stats.rating;
            if (rating !== undefined && rating < 80) continue;
            for (const a of (scene.actors || [])) {
                if (a.id && a.name && !actorMap[a.id]) {
                    actorMap[a.id] = { id: a.id, name: a.name };
                }
            }
        }
    }

    const actors = Object.values(actorMap).sort((a, b) => a.name.localeCompare(b.name));
    if (actors.length > 0) {
        saveCacheToDisk(siteActorsCacheFile(siteName), actors);
        console.log('[Cache] Refreshed ' + siteName + ' performers: ' + actors.length + ' from ' + groupQueries.length + ' groups (4+ star scenes)');
        rebuildMergedCaches();
    }
    return _actorCache;
}

// ── Stash cache refresh functions ──────────────────────────────────────────────
// Tags, performers, and studios fetched via GraphQL, saved with offset IDs.

async function refreshStashTags() {
    const data = await fetchStashGraphQL('{ allTags { id name } }');
    const tags = (data.allTags || []).map(t => ({
        id: parseInt(t.id) + STASH_TAG_OFFSET,
        name: t.name,
    }));
    // Stash tags are flat (no categories) — group under 'Stash'
    const byCategory = { Stash: tags.sort((a, b) => a.name.localeCompare(b.name)) };
    saveCacheToDisk(STASH_TAGS_CACHE, byCategory);
    console.log('[Cache] Refreshed Stash tags: ' + tags.length);
    rebuildMergedCaches();
}

async function refreshStashPerformers() {
    const data = await fetchStashGraphQL('{ allPerformers { id name } }');
    const performers = (data.allPerformers || []).map(p => ({
        id: parseInt(p.id) + STASH_PERFORMER_OFFSET,
        name: p.name,
    })).sort((a, b) => a.name.localeCompare(b.name));
    saveCacheToDisk(STASH_PERFORMERS_CACHE, performers);
    console.log('[Cache] Refreshed Stash performers: ' + performers.length);
    rebuildMergedCaches();
}

async function refreshStashStudios() {
    const data = await fetchStashGraphQL('{ allStudios { id name } }');
    const studios = (data.allStudios || []).map(s => ({
        id: parseInt(s.id),
        name: s.name,
    })).sort((a, b) => a.name.localeCompare(b.name));
    saveCacheToDisk(STASH_STUDIOS_CACHE, studios);
    console.log('[Cache] Refreshed Stash studios: ' + studios.length);
}

// Fetch collections (sub-brands) for a site from /v1/collections API
async function refreshCollectionsFromApi(auth) {
    const siteName = auth._site || 'unknown';
    try {
        const resp = await fetchAyloApi('/v1/collections?limit=100', auth);
        if (resp.status === 200 && resp.data.result) {
            return resp.data.result.map(c => ({ name: c.name, collectionId: c.id, site: siteName }));
        }
    } catch (e) { /* fall through */ }
    return [];
}

// Probe which AYLO_GROUPS are playable through a given auth.
// A group is playable if at least one recent scene has video files in the response.
// Also checks "native" content (no groupId) for brands like Brazzers that don't support groupId.
async function discoverPlayableGroups(auth) {
    const playable = [];
    const probes = [];

    // Probe each group with explicit groupId=
    for (const [name, g] of Object.entries(AYLO_GROUPS)) {
        probes.push(
            fetchAyloApi('/v2/releases?limit=5&type=scene&groupId=' + g.groupId + '&orderBy=-dateReleased', auth)
                .then(r => {
                    if (r.status === 200 && r.data.result?.length) {
                        const total = r.data.meta?.total || 0;
                        const hasFiles = r.data.result.some(s => s.videos?.full?.files?.length > 0);
                        if (hasFiles) {
                            playable.push({ name, groupId: g.groupId, tagId: -g.groupId, total, native: false });
                        }
                    }
                })
                .catch(() => {})
        );
    }

    // Also probe native content (no groupId) — the auth's own brand catalog.
    // Checks 5 scenes because the newest may be upcoming/preview with no video files.
    probes.push(
        fetchAyloApi('/v2/releases?limit=5&type=scene&orderBy=-dateReleased', auth)
            .then(r => {
                if (r.status !== 200 || !r.data?.result?.length) return;
                const total = r.data.meta?.total || 0;
                const brand = r.data.result[0].brand || auth._site;
                const hasFiles = r.data.result.some(s => s.videos?.full?.files?.length > 0);
                if (hasFiles) {
                    for (const [name, g] of Object.entries(AYLO_GROUPS)) {
                        if (name.toLowerCase().replace(/\s/g, '') === brand.toLowerCase().replace(/\s/g, '')) {
                            if (!playable.some(p => p.groupId === g.groupId)) {
                                playable.push({ name, groupId: g.groupId, tagId: -g.groupId, total, native: true });
                            }
                            break;
                        }
                    }
                }
            })
            .catch(() => {})
    );

    await Promise.allSettled(probes);
    // Dedupe by groupId (race between groupId and native probes can cause duplicates)
    const deduped = new Map();
    for (const g of playable) {
        if (!deduped.has(g.groupId)) deduped.set(g.groupId, g);
    }
    return [...deduped.values()];
}

// Background refresh — runs every 6 hours.
async function backgroundCatalogRefresh() {
    try {
        const refreshes = [];
        const collectionResults = [];
        for (const name of Object.keys(AYLO_SITES)) {
            const auth = await getAyloAuth(name);
            if (!auth.accessToken) continue;
            auth.externalIp = await getExternalIp();
            refreshes.push(refreshTagsFromApi(auth));
            refreshes.push(refreshActorsFromApi(auth));
            collectionResults.push(refreshCollectionsFromApi(auth));
            refreshes.push(
                discoverPlayableGroups(auth).then(groups => {
                    _playableGroups[name] = groups;
                    console.log('[Cache] ' + name + ' playable groups: ' + groups.map(g => g.name + '(' + g.total + ')').join(', '));
                })
            );
        }
        if (refreshes.length > 0) {
            await Promise.allSettled(refreshes);
        }
        const allColls = [];
        const collResults = await Promise.allSettled(collectionResults);
        for (const r of collResults) {
            if (r.status === 'fulfilled') allColls.push(...r.value);
        }
        if (allColls.length > 0) {
            _collectionCache = allColls;
            saveCacheToDisk(path.join(CACHE_DIR, 'collections.json'), _collectionCache);
        }
        saveCacheToDisk(path.join(CACHE_DIR, 'playable-groups.json'), _playableGroups);
        console.log('[Cache] Background refresh complete');
        // Stash refresh (independent of Aylo auth)
        try {
            await Promise.allSettled([refreshStashTags(), refreshStashPerformers(), refreshStashStudios()]);
            console.log('[Cache] Stash background refresh complete');
        } catch (e) {
            console.log('[Cache] Stash refresh failed:', e.message);
        }
    } catch (e) {
        console.log('[Cache] Background refresh failed:', e.message);
    }
}

// Load from disk immediately, schedule background refreshes
loadCacheFromDisk();
try {
    _collectionCache = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'collections.json'), 'utf8'));
} catch (e) { _collectionCache = null; }
try {
    _playableGroups = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, 'playable-groups.json'), 'utf8'));
    const total = Object.values(_playableGroups).reduce((s, gs) => s + gs.length, 0);
    console.log('[Cache] Loaded ' + total + ' playable groups from disk');
} catch (e) { _playableGroups = {}; }
setTimeout(backgroundCatalogRefresh, 10000);
setInterval(backgroundCatalogRefresh, CATALOG_REFRESH_INTERVAL);

// ── Auth Keepalive ─────────────────────────────────────────────────────────────
// Proactively refresh Aylo tokens every 45 minutes (access_token expires ~1hr).
// Without this, tokens go stale if no API calls happen for >1 hour.
const AUTH_KEEPALIVE_INTERVAL = 45 * 60 * 1000; // 45 minutes

async function authKeepalive() {
    const seen = new Set();
    let refreshed = 0, failed = 0;
    for (const siteName of Object.keys(AYLO_SITES)) {
        const host = AYLO_SITES[siteName].cookieHost;
        if (seen.has(host)) continue;
        seen.add(host);
        try {
            // Clear cached token for this host to force a fresh refresh
            delete _refreshedTokens[host];
            delete _cookieCache[host];
            const auth = await getAyloAuth(siteName);
            if (auth.accessToken) { refreshed++; } else { failed++; }
        } catch (e) {
            console.error('[Auth:keepalive] Error refreshing ' + siteName + ':', e.message);
            failed++;
        }
    }
    if (refreshed > 0 || failed > 0) {
        console.log('[Auth:keepalive] Refreshed ' + refreshed + ' site(s)' + (failed > 0 ? ', ' + failed + ' failed' : ''));
    }
}
// First keepalive at 5 minutes (let server fully start), then every 45 min
setTimeout(authKeepalive, 5 * 60 * 1000);
setInterval(authKeepalive, AUTH_KEEPALIVE_INTERVAL);

// Build list of { auth, groupId, groupName } combos to query.
// Groups marked `native: true` are queried WITHOUT groupId (native brand catalog).
function getAuthGroupCombos(auths, filterGroupIds) {
    const combos = [];
    for (const auth of auths) {
        const groups = _playableGroups[auth._site];
        if (groups && groups.length > 0) {
            for (const g of groups) {
                if (filterGroupIds && !filterGroupIds.has(g.groupId)) continue;
                combos.push({ auth, groupId: g.native ? null : g.groupId, groupName: g.name, total: g.total || 500 });
            }
        } else {
            if (!filterGroupIds) combos.push({ auth, groupId: null, groupName: auth._site });
        }
    }
    return combos;
}

// Scrape top-rated scenes from ALL logged-in Aylo sites + cross-network groups.
// Group filter: negative tagIds (e.g. -1=groupId 1=Reality Kings) restrict to specific brands.
async function scrapeAyloScenes(count, tagIds, actorIds) {
    const filterGroupIds = new Set();
    const realTagIds = [];
    let hasGroupFilter = false;
    for (const id of (tagIds || [])) {
        if (id < 0 && AYLO_GROUP_BY_TAG_ID[id]) {
            filterGroupIds.add(AYLO_GROUP_BY_TAG_ID[id].groupId);
            hasGroupFilter = true;
        } else if (id > 0) {
            realTagIds.push(id);
        }
    }

    const auths = await getAllAyloAuths();
    if (auths.length === 0) throw new Error('No valid Aylo login. Log into any site in Chrome.');

    const externalIp = await getExternalIp();
    for (const auth of auths) auth.externalIp = externalIp;

    const combos = getAuthGroupCombos(auths, hasGroupFilter ? filterGroupIds : null);
    if (combos.length === 0) throw new Error('No playable groups for selected brands.');

    const limit = Math.ceil(count * 3);
    const hasFilters = (realTagIds.length > 0) || (actorIds && actorIds.length > 0);
    const sceneMap = {};

    if (hasFilters) {
        const tagIdSet = new Set(realTagIds);
        const actorIdSet = new Set(actorIds || []);

        const queries = [];
        for (const combo of combos) {
            // Filtered result sets are much smaller (~5-15% of catalog), use conservative offset
            const maxOffset = Math.max(10, Math.floor((combo.total || 500) * 0.05));
            const offset = Math.floor(Math.random() * maxOffset);
            const groupParam = combo.groupId ? '&groupId=' + combo.groupId : '';
            const basePath = `/v2/releases?limit=${limit}&offset=${offset}&type=scene&orderBy=-stats.rating${groupParam}`;
            for (const id of tagIdSet) queries.push(fetchAyloApi(basePath + '&tagId=' + id, combo.auth).then(r => ({ r, groupName: combo.groupName })));
            for (const id of actorIdSet) queries.push(fetchAyloApi(basePath + '&actorId=' + id, combo.auth).then(r => ({ r, groupName: combo.groupName })));
        }

        const results = await Promise.allSettled(queries);
        for (const res of results) {
            if (res.status !== 'fulfilled') continue;
            const { r, groupName } = res.value;
            if (r.status !== 200) continue;
            for (const scene of (r.data.result || [])) {
                if (sceneMap[scene.id]) continue;
                let score = 0;
                for (const t of (scene.tags || [])) if (tagIdSet.has(t.id)) score++;
                for (const a of (scene.actors || [])) if (actorIdSet.has(a.id)) score++;
                sceneMap[scene.id] = { scene, score, groupName };
            }
        }
        console.log('[Demo] Relaxed match: ' + Object.keys(sceneMap).length + ' unique scenes from ' + combos.length + ' combos');
    } else {
        const perCombo = Math.ceil(limit / combos.length);
        const comboQueries = combos.map(combo => {
            // Use catalog size to compute a wide random offset — avoids returning the same top-rated scenes every time
            const maxOffset = Math.max(50, Math.floor((combo.total || 500) * 0.6) - perCombo);
            const offset = Math.floor(Math.random() * maxOffset);
            const groupParam = combo.groupId ? '&groupId=' + combo.groupId : '';
            return fetchAyloApi(
                `/v2/releases?limit=${perCombo}&offset=${offset}&type=scene&orderBy=-stats.rating${groupParam}`,
                combo.auth
            ).then(resp => ({ resp, groupName: combo.groupName }));
        });

        const results = await Promise.allSettled(comboQueries);
        for (const r of results) {
            if (r.status !== 'fulfilled') continue;
            const { resp, groupName } = r.value;
            if (resp.status !== 200 || !resp.data.result) continue;
            for (const scene of resp.data.result) {
                if (!sceneMap[scene.id]) sceneMap[scene.id] = { scene, score: 0, groupName };
            }
        }
        if (Object.keys(sceneMap).length === 0) throw new Error('Aylo API returned no scenes');
        console.log('[Demo] Multi-group: ' + Object.keys(sceneMap).length + ' unique scenes from ' + combos.length + ' combos');
    }

    let sorted = Object.values(sceneMap);
    for (let i = sorted.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [sorted[i], sorted[j]] = [sorted[j], sorted[i]];
    }
    if (hasFilters) sorted.sort((a, b) => b.score - a.score);

    const streams = [];
    for (const entry of sorted) {
        const scene = entry.scene;
        const rating = scene.stats && scene.stats.rating;
        if (!hasFilters && rating !== undefined && rating < 70) continue;

        const url = (scene.videos?.full && extractBestVideoUrl(scene.videos.full.files)) || null;
        if (url) {
            const tags = (scene.tags || []).map(t => t.name);
            const actors = (scene.actors || []).map(a => a.name);
            const category = (scene.collections || []).map(c => c.name).join(', ');
            const brandName = entry.groupName || scene.brand || '';
            if (brandName && !tags.includes(brandName)) tags.unshift(brandName);
            streams.push({ url, title: scene.title || category || 'Scene', tags, actors, category, site: brandName });
        }
        if (streams.length >= count) break;
    }

    return streams;
}

// Rewrite URLs in an m3u8 manifest to route through our proxy
function rewriteM3u8(content, manifestUrl) {
    return content.split('\n').map(line => {
        const trimmed = line.trim();

        // Skip empty lines and plain comments
        if (!trimmed) return line;

        // Rewrite URI= attributes in tags (#EXT-X-MAP, #EXT-X-KEY, #EXT-X-MEDIA, etc.)
        if (trimmed.startsWith('#') && trimmed.includes('URI=')) {
            return line.replace(/URI="([^"]+)"/g, (match, uri) => {
                const absoluteUrl = new URL(uri, manifestUrl).href;
                return `URI="/api/proxy/hls?url=${encodeURIComponent(absoluteUrl)}"`;
            });
        }

        // Skip other comment lines
        if (trimmed.startsWith('#')) return line;

        // Non-comment lines are URLs (segments or sub-playlists)
        const absoluteUrl = new URL(trimmed, manifestUrl).href;
        return `/api/proxy/hls?url=${encodeURIComponent(absoluteUrl)}`;
    }).join('\n');
}

// MIME types
const MIME_TYPES = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.m3u8': 'application/vnd.apple.mpegurl',
    '.ts': 'video/mp2t'
};

/**
 * Serve a file with byte-range support + optional range cap for video.
 * The cap prevents HTTP/1.1 connection starvation: Chrome holds video connections
 * open for the entire playback duration (backpressure throttles to playback rate).
 * By capping each response at VIDEO_RANGE_CAP (4MB), connections free in ~4ms on
 * localhost, letting all streams share the 6-connection pool fairly.
 * Chrome automatically makes follow-up range requests as its buffer drains.
 */
function serveFileWithRange(req, res, filePath, stat, contentType) {
    const range = req.headers.range;
    const isVideo = contentType.startsWith('video/');
    if (range && stat.size > 0) {
        const parts = range.replace(/bytes=/, '').split('-');
        const start = Math.min(parseInt(parts[0], 10) || 0, stat.size - 1);
        let end = parts[1] ? Math.min(parseInt(parts[1], 10), stat.size - 1) : stat.size - 1;
        if (end < start) end = start;
        // Cap video responses so connections cycle fast
        if (isVideo && (end - start + 1) > VIDEO_RANGE_CAP) {
            end = start + VIDEO_RANGE_CAP - 1;
        }
        const chunkSize = end - start + 1;
        res.writeHead(206, {
            'Content-Range': `bytes ${start}-${end}/${stat.size}`,
            'Accept-Ranges': 'bytes',
            'Content-Length': chunkSize,
            'Content-Type': contentType
        });
        fs.createReadStream(filePath, { start, end }).pipe(res);
    } else {
        res.writeHead(200, {
            'Content-Length': stat.size,
            'Content-Type': contentType,
            'Accept-Ranges': 'bytes'
        });
        fs.createReadStream(filePath).pipe(res);
    }
}

const server = http.createServer(async (req, res) => {
    // Enable CORS for all requests (including Chrome extension Private Network Access)
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    res.setHeader('Access-Control-Allow-Private-Network', 'true');

    if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
    }

    try { // Top-level try/catch — individual request errors must not crash the server

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // --- Cast / Server Info ---
    if (pathname === '/api/server-info' && req.method === 'GET') {
        const nets = os.networkInterfaces();
        let ip = '127.0.0.1';
        for (const name of Object.keys(nets)) {
            for (const net of nets[name]) {
                if (net.family === 'IPv4' && !net.internal) {
                    ip = net.address;
                    break;
                }
            }
            if (ip !== '127.0.0.1') break;
        }
        return jsonOk(res, { ip, port: parseInt(PORT) });
    }

    // Remote control API endpoints
    if (pathname === '/api/remote/state') {
        if (req.method === 'GET') {
            // Remote fetches current state
            jsonOk(res, currentState);
        } else if (req.method === 'POST') {
            // Main app posts state updates
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    currentState = JSON.parse(body);
                    currentState.timestamp = Date.now();
                    jsonOk(res, { success: true });
                } catch (e) {
                    jsonError(res, 400, 'Invalid JSON');
                }
            });
        }
        return;
    }

    if (pathname === '/api/remote/command') {
        if (req.method === 'GET') {
            // Main app polls for commands
            const cmd = pendingCommands.shift();
            jsonOk(res, cmd || null);
        } else if (req.method === 'POST') {
            // Remote posts commands
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    const cmd = JSON.parse(body);
                    cmd.timestamp = Date.now();
                    pendingCommands.push(cmd);
                    // Keep only last 10 commands
                    if (pendingCommands.length > 10) {
                        pendingCommands = pendingCommands.slice(-10);
                    }
                    jsonOk(res, { success: true });
                } catch (e) {
                    jsonError(res, 400, 'Invalid JSON');
                }
            });
        }
        return;
    }

    // ========================================
    // HLS Management API
    // ========================================

    // List all HLS transcoded files with status and sizes
    if (pathname === '/api/hls/list' && req.method === 'GET') {
        const hlsFiles = [];
        let totalSize = 0;

        Object.keys(fileMetadata).forEach(fileId => {
            const meta = fileMetadata[fileId];
            if (!meta.contentType?.startsWith('video/')) return;

            const hlsSize = getHLSSize(fileId);
            const inputExists = fs.existsSync(path.join(UPLOADS_DIR, fileId));
            const job = transcodingJobs[fileId];

            let status = 'pending';
            if (meta.hlsReady) status = 'complete';
            else if (job?.status === 'transcoding') status = 'transcoding';
            else if (job?.status === 'queued') status = 'queued';
            else if (job?.status === 'failed') status = 'failed';

            hlsFiles.push({
                fileId,
                fileName: meta.fileName,
                originalSize: meta.size,
                hlsSize,
                status,
                progress: job?.progress || (meta.hlsReady ? 100 : 0),
                hlsReady: meta.hlsReady || false,
                hlsUrl: meta.hlsPath || null,
                hasOriginal: inputExists,
                originalPath: path.join(UPLOADS_DIR, fileId),
                hlsPath: path.join(HLS_DIR, fileId)
            });

            totalSize += hlsSize;
        });

        jsonOk(res, {
            files: hlsFiles,
            totalSize,
            totalSizeMB: Math.round(totalSize / 1024 / 1024),
            activeTranscodes: activeTranscodes.size,
            queueLength: transcodeQueue.length
        });
        return;
    }

    // Reconcile HLS metadata: mark orphaned completions as ready, clean empty stubs
    if (pathname === '/api/hls/reconcile' && req.method === 'POST') {
        let marked = 0, cleaned = 0, freedBytes = 0;
        // Scan all HLS subdirectories
        if (fs.existsSync(HLS_DIR)) {
            const hlsDirs = fs.readdirSync(HLS_DIR, { withFileTypes: true });
            for (const entry of hlsDirs) {
                if (!entry.isDirectory()) continue;
                const fileId = entry.name;
                const hlsSubDir = path.join(HLS_DIR, fileId);
                if (isHLSComplete(fileId)) {
                    // Complete transcode — ensure metadata is marked ready
                    const meta = fileMetadata[fileId];
                    if (meta && !meta.hlsReady) {
                        meta.hlsReady = true;
                        meta.hlsPath = `/api/hls/${encodeURIComponent(fileId)}/playlist.m3u8`;
                        marked++;
                        console.log(`[Reconcile] Marked as hlsReady: ${meta.fileName || fileId}`);
                    }
                } else {
                    // No valid playlist — check if empty stub
                    const contents = fs.readdirSync(hlsSubDir);
                    if (contents.length === 0) {
                        fs.rmdirSync(hlsSubDir);
                        cleaned++;
                        console.log(`[Reconcile] Removed empty stub: ${fileId}`);
                    } else {
                        // Partial transcode — remove incomplete files
                        let dirSize = 0;
                        for (const f of contents) {
                            const fp = path.join(hlsSubDir, f);
                            try { dirSize += fs.statSync(fp).size; fs.unlinkSync(fp); } catch(e) { console.warn('[Reconcile] Failed to clean', fp, ':', e.message); }
                        }
                        try { fs.rmdirSync(hlsSubDir); } catch(e) { console.warn('[Reconcile] Failed to remove dir:', e.message); }
                        freedBytes += dirSize;
                        cleaned++;
                        console.log(`[Reconcile] Removed partial transcode: ${fileId} (${(dirSize/1024/1024).toFixed(1)}MB)`);
                    }
                }
            }
        }
        if (marked > 0) saveMetadata();
        jsonOk(res, { marked, cleaned, freedMB: Math.round(freedBytes / 1024 / 1024) });
        return;
    }

    // Delete a specific HLS transcode (keeps original if exists)
    if (pathname.startsWith('/api/hls/delete/') && req.method === 'DELETE') {
        const fileId = decodeURIComponent(pathname.replace('/api/hls/delete/', ''));
        const meta = fileMetadata[fileId];

        if (meta) {
            // Cancel if transcoding
            if (transcodingJobs[fileId]?.process) {
                transcodingJobs[fileId].process.kill();
                activeTranscodes.delete(fileId);
            }

            // Delete HLS directory
            const hlsDir = path.join(HLS_DIR, fileId);
            if (fs.existsSync(hlsDir)) {
                fs.rmSync(hlsDir, { recursive: true });
            }

            // Reset HLS status in metadata
            meta.hlsReady = false;
            meta.hlsPath = null;
            delete transcodingJobs[fileId];
            saveMetadata();

            console.log(`[Server] Deleted HLS: ${meta.fileName}`);
            jsonOk(res, { success: true, fileName: meta.fileName });
        } else {
            jsonError(res, 404, 'File not found');
        }
        return;
    }

    // Delete original file only (keep HLS)
    if (pathname.startsWith('/api/hls/delete-original/') && req.method === 'DELETE') {
        const fileId = decodeURIComponent(pathname.replace('/api/hls/delete-original/', ''));
        const meta = fileMetadata[fileId];

        if (meta) {
            const inputPath = path.join(UPLOADS_DIR, fileId);
            if (fs.existsSync(inputPath)) {
                fs.unlinkSync(inputPath);
                console.log(`[Server] Deleted original: ${meta.fileName}`);
                jsonOk(res, { success: true, fileName: meta.fileName });
            } else {
                jsonError(res, 404, 'Original file not found');
            }
        } else {
            jsonError(res, 404, 'File not found');
        }
        return;
    }

    // Trigger transcoding for a specific file
    if (pathname.startsWith('/api/hls/transcode/') && req.method === 'POST') {
        const fileId = decodeURIComponent(pathname.replace('/api/hls/transcode/', ''));
        const meta = fileMetadata[fileId];

        if (meta && meta.contentType?.startsWith('video/') && !meta.hlsReady) {
            startHLSTranscode(fileId);
            jsonOk(res, { success: true, queued: true });
        } else {
            jsonError(res, 400, 'Cannot transcode');
        }
        return;
    }

    // Cancel all incomplete transcodes (clear queue + kill active)
    if (pathname === '/api/hls/cancel-all' && req.method === 'POST') {
        const queuedCount = transcodeQueue.length;
        const activeCount = activeTranscodes.size;

        // Clear the queue
        transcodeQueue.length = 0;

        // Kill active ffmpeg processes (activeTranscodes is a Set of fileIds)
        for (const fileId of activeTranscodes) {
            try {
                const job = transcodingJobs[fileId];
                if (job?.process) {
                    job.process.kill('SIGKILL');
                }
                transcodingJobs[fileId] = { status: 'cancelled', progress: 0 };
            } catch (e) { /* ignore */ }
        }
        activeTranscodes.clear();

        // Clear all job statuses for incomplete files
        for (const fileId of Object.keys(transcodingJobs)) {
            if (transcodingJobs[fileId].status !== 'complete') {
                delete transcodingJobs[fileId];
            }
        }

        console.log(`[Server] Cancelled all transcodes: ${queuedCount} queued, ${activeCount} active`);
        jsonOk(res, { success: true, cancelledQueued: queuedCount, cancelledActive: activeCount });
        return;
    }

    // Extraction queue control
    if (pathname === '/api/extracts/start' && req.method === 'POST') {
        extractsPaused = false;
        console.log('[Server] Extraction queue started');
        processExtractQueue();
        jsonOk(res, { success: true, paused: false, queued: extractQueue.length, active: activeExtracts.size });
        return;
    }
    if (pathname === '/api/extracts/pause' && req.method === 'POST') {
        extractsPaused = true;
        console.log('[Server] Extraction queue paused');
        jsonOk(res, { success: true, paused: true });
        return;
    }
    if (pathname === '/api/extracts/status' && req.method === 'GET') {
        jsonOk(res, { paused: extractsPaused, queued: extractQueue.length, active: activeExtracts.size });
        return;
    }

    // Pause transcoding (let current finish, don't start new)
    if (pathname === '/api/hls/pause' && req.method === 'POST') {
        transcodePaused = true;
        console.log('[Server] Transcode queue paused');
        jsonOk(res, { success: true, paused: true });
        return;
    }

    // Resume transcoding
    if (pathname === '/api/hls/resume' && req.method === 'POST') {
        transcodePaused = false;
        console.log('[Server] Transcode queue resumed');
        processTranscodeQueue();
        jsonOk(res, { success: true, paused: false });
        return;
    }

    // Start/queue all pending files for transcoding
    if (pathname === '/api/hls/start' && req.method === 'POST') {
        transcodePaused = false;
        let queued = 0;
        for (const [fileId, meta] of Object.entries(fileMetadata)) {
            if (meta.hlsReady) continue;
            const origExists = fs.existsSync(path.join(UPLOADS_DIR, fileId));
            const hlsExists = fs.existsSync(path.join(HLS_DIR, fileId, 'playlist.m3u8'));
            if (origExists && !hlsExists && !transcodeQueue.includes(fileId) && !activeTranscodes.has(fileId)) {
                transcodeQueue.push(fileId);
                transcodingJobs[fileId] = { status: 'queued', progress: 0 };
                queued++;
            }
        }
        processTranscodeQueue();
        console.log(`[Server] Started transcoding: ${queued} files queued`);
        jsonOk(res, { success: true, queued, active: activeTranscodes.size });
        return;
    }

    // Get transcode queue status
    if (pathname === '/api/hls/status' && req.method === 'GET') {
        jsonOk(res, {
            paused: transcodePaused,
            queueLength: transcodeQueue.length,
            activeCount: activeTranscodes.size,
            maxConcurrent: MAX_CONCURRENT_TRANSCODES
        });
        return;
    }

    // Delete redundant original files (where HLS exists and not currently transcoding)
    if (pathname === '/api/files/delete-redundant' && req.method === 'POST') {
        let deleted = 0;
        let freedBytes = 0;
        let skippedTranscoding = 0;
        for (const [fileId, meta] of Object.entries(fileMetadata)) {
            // Skip files that are currently being transcoded
            if (activeTranscodes.has(fileId) || transcodeQueue.includes(fileId)) {
                skippedTranscoding++;
                continue;
            }

            const origPath = path.join(UPLOADS_DIR, fileId);
            const hlsPath = path.join(HLS_DIR, fileId, 'playlist.m3u8');
            const origExists = fs.existsSync(origPath);
            const hlsExists = fs.existsSync(hlsPath);

            if (hlsExists && origExists) {
                const stats = fs.statSync(origPath);
                freedBytes += stats.size;
                fs.unlinkSync(origPath);
                console.log(`[Server] Deleted redundant original: ${meta.fileName}`);
                deleted++;
            }
        }
        console.log(`[Server] Deleted ${deleted} redundant originals, freed ${(freedBytes / 1024 / 1024 / 1024).toFixed(2)} GB${skippedTranscoding > 0 ? `, skipped ${skippedTranscoding} transcoding` : ''}`);
        jsonOk(res, { success: true, deleted, freedBytes, skippedTranscoding });
        return;
    }

    // ========================================
    // File Upload/Serving API
    // ========================================

    // Upload a file
    if (pathname === '/api/files/upload' && req.method === 'POST') {
        const contentType = req.headers['content-type'] || '';
        const fileName = decodeURIComponent(req.headers['x-file-name'] || 'unknown');
        const setName = req.headers['x-set-name'] ? decodeURIComponent(req.headers['x-set-name']) : null;
        const fileSize = parseInt(req.headers['content-length'] || '0', 10);

        // Check if we already have this file (by name+size)
        const existing = findExistingFile(fileName, fileSize);
        if (existing) {
            const isTranscoding = transcodeQueue.includes(existing.fileId) || activeTranscodes.has(existing.fileId);
            const hlsReady = existing.meta.hlsReady;
            console.log(`[Server] File exists: ${fileName} -> ${existing.fileId} (hlsReady: ${hlsReady}, transcoding: ${isTranscoding})`);
            jsonOk(res, {
                success: true,
                fileId: existing.fileId,
                url: hlsReady ? existing.meta.hlsPath : `/api/files/${existing.fileId}`,
                hlsUrl: hlsReady ? existing.meta.hlsPath : null,
                fileName: existing.meta.fileName,
                size: existing.meta.originalSize,
                hlsReady: hlsReady,
                transcoding: isTranscoding,
                existing: true
            });
            // Drain the request body
            req.resume();
            return;
        }

        // Generate file ID from sanitized filename (readable, not random hex)
        const fileId = generateFileId(fileName);
        const filePath = path.join(UPLOADS_DIR, fileId);

        const writeStream = fs.createWriteStream(filePath);
        let size = 0;

        req.on('data', chunk => {
            size += chunk.length;
            writeStream.write(chunk);
        });

        req.on('end', () => {
            writeStream.end();

            // Determine content type from file extension if not provided
            let mimeType = contentType.split(';')[0].trim();
            if (!mimeType || mimeType === 'application/octet-stream') {
                const ext = path.extname(fileName).toLowerCase();
                mimeType = MIME_TYPES[ext] || 'application/octet-stream';
            }

            fileMetadata[fileId] = {
                fileName,
                size,
                savedAt: Date.now(),
                setName,
                contentType: mimeType,
                originalFileName: fileName,
                originalSize: size,
                hlsReady: false
            };
            saveMetadata();

            console.log(`[Server] Uploaded: ${fileName} (${(size / 1024 / 1024).toFixed(2)} MB) -> ${fileId}`);

            // Start HLS transcoding for video files
            if (mimeType.startsWith('video/')) {
                startHLSTranscode(fileId);
            }

            jsonOk(res, {
                success: true,
                fileId,
                url: `/api/files/${fileId}`,
                fileName,
                size,
                hlsReady: false,
                transcoding: mimeType.startsWith('video/')
            });
        });

        req.on('error', (err) => {
            writeStream.end();
            try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
            jsonError(res, 500, 'Upload failed');
        });

        return;
    }

    // Check transcoding status
    if (pathname === '/api/files/transcode-status' && req.method === 'GET') {
        const fileId = url.searchParams.get('fileId');
        if (fileId && transcodingJobs[fileId]) {
            jsonOk(res, transcodingJobs[fileId]);
        } else if (fileId && fileMetadata[fileId]?.hlsReady) {
            jsonOk(res, { status: 'complete', progress: 100, hlsUrl: fileMetadata[fileId].hlsPath });
        } else {
            jsonOk(res, { status: 'unknown', progress: 0 });
        }
        return;
    }

    // Serve HLS files (playlist and segments)
    if (pathname.startsWith('/api/hls/') && req.method === 'GET') {
        const parts = pathname.replace('/api/hls/', '').split('/');
        const fileId = decodeURIComponent(parts[0]);
        const hlsFile = decodeURIComponent(parts.slice(1).join('/'));

        if (!fileId || !hlsFile) {
            jsonError(res, 400, 'Invalid HLS path');
            return;
        }

        const hlsPath = path.join(HLS_DIR, fileId, hlsFile);

        // Security: prevent directory traversal
        if (!hlsPath.startsWith(HLS_DIR)) {
            res.writeHead(403);
            res.end('Forbidden');
            return;
        }

        if (!fs.existsSync(hlsPath)) {
            jsonError(res, 404, 'HLS file not found');
            return;
        }

        const ext = path.extname(hlsPath).toLowerCase();
        let contentType = 'application/octet-stream';
        if (ext === '.m3u8') contentType = 'application/vnd.apple.mpegurl';
        else if (ext === '.ts') contentType = 'video/mp2t';

        const stat = fs.statSync(hlsPath);
        res.writeHead(200, {
            'Content-Type': contentType,
            'Content-Length': stat.size,
            'Cache-Control': ext === '.m3u8' ? 'no-cache' : 'max-age=86400'
        });
        fs.createReadStream(hlsPath).pipe(res);
        return;
    }

    // List all uploaded files
    // Read uploads dir once to avoid per-file existsSync calls
    if (pathname === '/api/files/list' && req.method === 'GET') {
        // Single directory read for all existence checks
        const uploadsContents = new Set(fs.readdirSync(UPLOADS_DIR));

        const files = Object.keys(fileMetadata).map(fileId => {
            const meta = fileMetadata[fileId];
            const transcodeJob = transcodingJobs[fileId];
            const hlsPath = meta.hlsPath || `/api/hls/${encodeURIComponent(fileId)}/playlist.m3u8`;

            return {
                fileId,
                url: meta.hlsReady ? hlsPath : `/api/files/${fileId}`,
                hlsUrl: meta.hlsReady ? hlsPath : null,
                hlsReady: meta.hlsReady || false,
                transcoding: transcodeJob?.status === 'transcoding',
                transcodeProgress: transcodeJob?.progress || (meta.hlsReady ? 100 : 0),
                originalExists: uploadsContents.has(fileId),
                hlsExists: meta.hlsReady || false,
                ...meta
            };
        });
        jsonOk(res, files);
        return;
    }

    // Scan local folder for videos (defaults to Downloads) - recursive
    if (pathname === '/api/files/scan-local' && req.method === 'GET') {
        let folderPath = url.searchParams.get('folder') || DEFAULT_SCAN_FOLDER;
        // Resolve relative paths from project root
        if (!path.isAbsolute(folderPath)) {
            folderPath = path.join(__dirname, folderPath);
        }

        try {
            if (!fs.existsSync(folderPath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Folder not found', folder: folderPath }));
                return;
            }

            const files = [];
            const maxDepth = 5; // Prevent infinite recursion in symlink loops

            // Recursive scan function
            function scanDir(dir, depth = 0) {
                if (depth > maxDepth) return;
                let entries;
                try {
                    entries = fs.readdirSync(dir, { withFileTypes: true });
                } catch (e) {
                    // Skip directories we can't read (permissions, etc.)
                    return;
                }

                for (const entry of entries) {
                    // Skip hidden files/folders
                    if (entry.name.startsWith('.')) continue;

                    const fullPath = path.join(dir, entry.name);

                    if (entry.isDirectory()) {
                        // Recurse into subdirectories
                        scanDir(fullPath, depth + 1);
                    } else if (entry.isFile()) {
                        const ext = path.extname(entry.name).toLowerCase();
                        if (!VIDEO_EXTENSIONS.has(ext)) continue;

                        try {
                            const stats = fs.statSync(fullPath);
                            // Include relative path from base folder for display
                            const relativePath = path.relative(folderPath, fullPath);
                            files.push({
                                name: entry.name,
                                path: fullPath,
                                relativePath: relativePath,
                                size: stats.size,
                                modified: stats.mtime.getTime()
                            });
                        } catch (e) {
                            // Skip files we can't stat
                        }
                    }
                }
            }

            scanDir(folderPath);

            // Sort by modified time, newest first
            files.sort((a, b) => b.modified - a.modified);

            console.log(`[Server] Scanned ${folderPath} (recursive): found ${files.length} video(s)`);
            jsonOk(res, { folder: folderPath, files });
        } catch (e) {
            console.error(`[Server] Scan error: ${e.message}`);
            jsonError(res, 500, e.message);
        }
        return;
    }

    // List orphaned files (in uploads folder but not in metadata)
    if (pathname === '/api/files/orphaned' && req.method === 'GET') {
        try {
            const uploadsFiles = fs.readdirSync(UPLOADS_DIR).filter(f =>
                f !== 'hls' && f !== 'metadata.json' && !f.startsWith('.')
            );
            const orphaned = uploadsFiles.filter(f => !fileMetadata[f]);
            const files = orphaned.map(f => {
                const filePath = path.join(UPLOADS_DIR, f);
                try {
                    const stats = fs.statSync(filePath);
                    return { name: f, size: stats.size, path: filePath };
                } catch (e) {
                    return null; // File deleted between readdir and stat
                }
            }).filter(Boolean);
            jsonOk(res, { files });
        } catch (e) {
            jsonError(res, 500, e.message);
        }
        return;
    }

    // Import a local file (copy to uploads, add metadata, start transcode)
    if (pathname === '/api/files/import' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { filePath } = JSON.parse(body);
                if (!filePath || !fs.existsSync(filePath)) {
                    jsonError(res, 400, 'Invalid file path');
                    return;
                }

                const fileName = path.basename(filePath);
                const stats = fs.statSync(filePath);
                const ext = path.extname(fileName).toLowerCase();
                const contentType = MIME_TYPES[ext] || 'video/mp4';

                // Check if already exists by name and size
                const existing = Object.entries(fileMetadata).find(([id, meta]) =>
                    (meta.fileName === fileName || meta.originalFileName === fileName) &&
                    (meta.size === stats.size || meta.originalSize === stats.size)
                );
                if (existing) {
                    const [fileId, meta] = existing;
                    jsonOk(res, {
                        fileId,
                        url: meta.hlsReady ? meta.hlsPath : `/api/files/${fileId}`,
                        hlsReady: meta.hlsReady || false,
                        existing: true
                    });
                    return;
                }

                // Use filename as fileId for readability, with collision handling
                const fileId = generateFileId(fileName);
                const destPath = path.join(UPLOADS_DIR, fileId);

                // Copy file to uploads (skip if already there - orphaned file adoption)
                if (filePath !== destPath && !fs.existsSync(destPath)) {
                    fs.copyFileSync(filePath, destPath);
                }

                // Add to metadata
                fileMetadata[fileId] = {
                    fileName,
                    size: stats.size,
                    savedAt: Date.now(),
                    contentType,
                    hlsReady: false
                };
                saveMetadata();

                // Queue for transcoding
                startHLSTranscode(fileId);

                console.log(`[Server] Imported local file: ${fileName}`);
                jsonOk(res, {
                    fileId,
                    url: `/api/files/${fileId}`,
                    hlsReady: false,
                    transcoding: true
                });
            } catch (e) {
                console.error(`[Server] Import error: ${e.message}`);
                jsonError(res, 500, e.message);
            }
        });
        return;
    }

    // Serve a local file by path (for scanned files)
    if (pathname === '/api/files/local' && req.method === 'GET') {
        const filePath = url.searchParams.get('path');
        if (!filePath) {
            jsonError(res, 400, 'Missing path parameter');
            return;
        }

        try {
            if (!fs.existsSync(filePath)) {
                jsonError(res, 404, 'File not found');
                return;
            }

            const stats = fs.statSync(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';

            serveFileWithRange(req, res, filePath, stats, contentType);
        } catch (e) {
            console.error(`[Server] Local file error: ${e.message}`);
            jsonError(res, 500, e.message);
        }
        return;
    }

    // Purge all files (or files for a specific set)
    if (pathname === '/api/files/purge' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            let setName = null;
            try {
                const data = JSON.parse(body);
                setName = data.setName;
            } catch (e) { /* purge all */ }

            let deleted = 0;
            Object.keys(fileMetadata).forEach(fileId => {
                const meta = fileMetadata[fileId];
                if (!setName || meta.setName === setName) {
                    deleteFileAndHLS(fileId);
                    delete fileMetadata[fileId];
                    deleted++;
                }
            });
            saveMetadata();

            console.log(`[Server] Purged ${deleted} file(s)${setName ? ` for set: ${setName}` : ''}`);
            jsonOk(res, { success: true, deleted });
        });
        return;
    }

    // Associate files with a saved set (to prevent auto-delete)
    if (pathname === '/api/files/associate' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const { fileIds, setName } = JSON.parse(body);
                let updated = 0;
                (fileIds || []).forEach(fileId => {
                    if (fileMetadata[fileId]) {
                        fileMetadata[fileId].setName = setName;
                        updated++;
                    }
                });
                saveMetadata();
                jsonOk(res, { success: true, updated });
            } catch (e) {
                jsonError(res, 400, 'Invalid JSON');
            }
        });
        return;
    }

    // Serve an uploaded file
    if (pathname.startsWith('/api/files/') && req.method === 'GET') {
        const fileId = decodeURIComponent(pathname.replace('/api/files/', ''));
        const meta = fileMetadata[fileId];

        if (!meta) {
            jsonError(res, 404, 'File not found');
            return;
        }

        const filePath = path.join(UPLOADS_DIR, fileId);
        if (!fs.existsSync(filePath)) {
            delete fileMetadata[fileId];
            saveMetadata();
            jsonError(res, 404, 'File not found');
            return;
        }

        const stat = fs.statSync(filePath);
        serveFileWithRange(req, res, filePath, stat, meta.contentType);
        return;
    }

    // Delete a specific file
    if (pathname.startsWith('/api/files/') && req.method === 'DELETE') {
        const fileId = decodeURIComponent(pathname.replace('/api/files/', ''));
        const meta = fileMetadata[fileId];

        if (meta) {
            deleteFileAndHLS(fileId);
            delete fileMetadata[fileId];
            saveMetadata();
            console.log(`[Server] Deleted: ${meta.fileName}`);
        } else {
            // Handle orphaned file (not in metadata but exists on disk)
            const orphanPath = path.join(UPLOADS_DIR, fileId);
            // Path traversal protection: ensure resolved path stays within UPLOADS_DIR
            const resolvedPath = path.resolve(orphanPath);
            if (!resolvedPath.startsWith(path.resolve(UPLOADS_DIR) + path.sep)) {
                jsonError(res, 400, 'Invalid file path');
                return;
            }
            if (fs.existsSync(orphanPath)) {
                fs.unlinkSync(orphanPath);
                console.log(`[Server] Deleted orphaned file: ${fileId}`);
            }
        }

        jsonOk(res, { success: true });
        return;
    }

    // Video Proxy - CORS bypass with range request support for plain video URLs
    if (pathname === '/api/proxy/video' && req.method === 'GET') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            jsonError(res, 400, 'Missing url parameter');
            return;
        }

        const extraHeaders = {};
        if (req.headers.range) extraHeaders['Range'] = req.headers.range;

        // fetchUrl handles redirects (up to 5) and timeout internally
        fetchUrl(targetUrl, (err, proxyRes) => {
            if (err) {
                console.error(`[Server] Video proxy error: ${err.message}`);
                if (!res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Proxy fetch failed', details: err.message }));
                }
                return;
            }

            const outHeaders = {
                'Content-Type': proxyRes.headers['content-type'] || 'video/mp4',
                'Accept-Ranges': 'bytes'
            };
            if (proxyRes.headers['content-length']) outHeaders['Content-Length'] = proxyRes.headers['content-length'];
            if (proxyRes.headers['content-range']) outHeaders['Content-Range'] = proxyRes.headers['content-range'];

            res.writeHead(proxyRes.statusCode, outHeaders);
            proxyRes.pipe(res);
            proxyRes.on('error', () => { if (!res.writableEnded) res.end(); });
            // Abort upstream fetch when client disconnects (prevents wasted bandwidth)
            res.on('close', () => { proxyRes.destroy(); });
        }, 0, extraHeaders);
        return;
    }

    // HLS Proxy - fetch external HLS manifests/segments to bypass CORS
    if (pathname === '/api/proxy/hls' && req.method === 'GET') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            jsonError(res, 400, 'Missing url parameter');
            return;
        }

        fetchUrl(targetUrl, (err, proxyRes) => {
            if (err) {
                console.error(`[Server] Proxy error: ${err.message}`);
                if (!res.headersSent) {
                    res.writeHead(502, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Proxy fetch failed', details: err.message }));
                }
                return;
            }

            if (proxyRes.statusCode !== 200) {
                res.writeHead(proxyRes.statusCode, { 'Content-Type': 'text/plain' });
                proxyRes.pipe(res);
                return;
            }

            // Determine if this is a manifest or a segment
            const contentType = proxyRes.headers['content-type'] || '';
            const isManifest = targetUrl.toLowerCase().includes('.m3u8') ||
                               contentType.includes('mpegurl') ||
                               contentType.includes('m3u8');

            if (isManifest) {
                // Collect manifest content and rewrite URLs
                let body = '';
                proxyRes.setEncoding('utf8');
                proxyRes.on('data', chunk => body += chunk);
                proxyRes.on('end', () => {
                    const rewritten = rewriteM3u8(body, targetUrl);
                    res.writeHead(200, {
                        'Content-Type': 'application/vnd.apple.mpegurl',
                        'Cache-Control': 'no-cache'
                    });
                    res.end(rewritten);
                });
            } else {
                // Stream segment/binary data directly
                const headers = {
                    'Content-Type': contentType || 'video/mp2t',
                    'Cache-Control': 'max-age=86400'
                };
                if (proxyRes.headers['content-length']) {
                    headers['Content-Length'] = proxyRes.headers['content-length'];
                }
                res.writeHead(200, headers);
                proxyRes.pipe(res);
            }
        });
        return;
    }

    // HLS Download - queue a background download job (returns JSON, not streaming)
    if (pathname === '/api/proxy/hls/download' && req.method === 'GET') {
        const targetUrl = url.searchParams.get('url');
        const name = url.searchParams.get('name') || 'video';
        if (!targetUrl) {
            jsonError(res, 400, 'Missing url parameter');
            return;
        }

        if (!ffmpegAvailable) {
            jsonError(res, 500, 'ffmpeg not available');
            return;
        }

        // Sanitize filename
        const safeName = name.replace(/[^a-zA-Z0-9_\-. ]/g, '_').replace(/\.(m3u8|ts|mp4)$/i, '') + '.mp4';

        // Dedup: return existing job if same URL is already queued/downloading
        const existingJob = Object.entries(downloadJobs).find(
            ([, j]) => j.url === targetUrl && (j.status === 'queued' || j.status === 'downloading')
        );
        if (existingJob) {
            const [existingId, job] = existingJob;
            jsonOk(res, { jobId: existingId, status: job.status, filename: job.filename, deduplicated: true });
            return;
        }

        const jobId = `dl_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
        const filepath = path.join(DOWNLOADS_DIR, `${jobId}_${safeName}`);

        downloadJobs[jobId] = {
            status: 'queued',
            progress: 0,
            url: targetUrl,
            filename: safeName,
            filepath,
            process: null,
            pid: null,
            error: null,
            startedAt: null,
            completedAt: null
        };

        downloadQueue.push(jobId);
        processDownloadQueue();

        console.log(`[Server] Download queued: ${safeName} (${downloadQueue.length} in queue, ${activeDownloads.size} active)`);

        jsonOk(res, { jobId, status: 'queued', filename: safeName });
        return;
    }

    // Download status - list all jobs or get specific job
    if (pathname === '/api/downloads/status' && req.method === 'GET') {
        const jobId = url.searchParams.get('jobId');
        if (jobId) {
            const job = downloadJobs[jobId];
            if (!job) {
                jsonError(res, 404, 'Job not found');
            } else {
                jsonOk(res, {
                    jobId,
                    status: job.status,
                    progress: job.progress,
                    filename: job.filename,
                    error: job.error,
                    startedAt: job.startedAt,
                    completedAt: job.completedAt
                });
            }
        } else {
            // Return all jobs (without process refs)
            const jobs = {};
            for (const [id, job] of Object.entries(downloadJobs)) {
                jobs[id] = {
                    status: job.status,
                    progress: job.progress,
                    filename: job.filename,
                    error: job.error,
                    startedAt: job.startedAt,
                    completedAt: job.completedAt
                };
            }
            jsonOk(res, { jobs, queueLength: downloadQueue.length, activeCount: activeDownloads.size });
        }
        return;
    }

    // Download completed file
    if (pathname === '/api/downloads/file' && req.method === 'GET') {
        const jobId = url.searchParams.get('jobId');
        if (!jobId || !downloadJobs[jobId]) {
            jsonError(res, 404, 'Job not found');
            return;
        }

        const job = downloadJobs[jobId];
        if (job.status !== 'complete') {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Download not complete', status: job.status, progress: job.progress }));
            return;
        }

        if (!fs.existsSync(job.filepath)) {
            jsonError(res, 410, 'File no longer available');
            return;
        }

        const stat = fs.statSync(job.filepath);
        res.writeHead(200, {
            'Content-Type': 'video/mp4',
            'Content-Disposition': `attachment; filename="${job.filename}"`,
            'Content-Length': stat.size
        });

        const readStream = fs.createReadStream(job.filepath);
        readStream.pipe(res);
        readStream.on('error', (err) => {
            console.error(`[Server] Download file read error: ${err.message}`);
            if (!res.headersSent) {
                jsonError(res, 500, 'File read failed');
            } else {
                res.end();
            }
        });
        return;
    }

    // Cancel/delete a download job
    if (pathname.startsWith('/api/downloads/') && req.method === 'DELETE') {
        const jobId = pathname.split('/api/downloads/')[1];
        if (!jobId || !downloadJobs[jobId]) {
            jsonError(res, 404, 'Job not found');
            return;
        }

        const job = downloadJobs[jobId];

        // Kill active ffmpeg process
        if (job.process && job.process.exitCode === null) {
            try { job.process.kill('SIGTERM'); } catch (e) { /* ignore */ }
        }
        activeDownloads.delete(jobId);

        // Remove from queue if still queued
        const queueIdx = downloadQueue.indexOf(jobId);
        if (queueIdx !== -1) downloadQueue.splice(queueIdx, 1);

        // Delete files
        try { if (fs.existsSync(job.filepath)) fs.unlinkSync(job.filepath); } catch (e) { /* ignore */ }
        try { if (fs.existsSync(job.filepath + '.part')) fs.unlinkSync(job.filepath + '.part'); } catch (e) { /* ignore */ }

        delete downloadJobs[jobId];
        console.log(`[Server] Download cancelled/deleted: ${job.filename}`);

        jsonOk(res, { ok: true });
        return;
    }

    // === Moments CRUD API ===

    // GET /api/moments — List all moments (with optional filters)
    if (pathname === '/api/moments' && req.method === 'GET') {
        const params = url.searchParams;
        let result = momentsDb.slice();

        // Filters
        const sessionFilter = params.get('session');
        if (sessionFilter) {
            result = result.filter(m => m.sessionId === sessionFilter);
        }
        const minRating = params.get('minRating');
        if (minRating) {
            const min = parseInt(minRating, 10);
            if (isFinite(min)) {
                result = result.filter(m => (m.rating || 0) >= min);
            }
        }
        const lovedFilter = params.get('loved');
        if (lovedFilter === 'true' || lovedFilter === '1') {
            result = result.filter(m => m.loved);
        }
        const sourceFilter = params.get('source');
        if (sourceFilter) {
            result = result.filter(m => m.sourceUrl === sourceFilter);
        }

        // Strip large fields
        const stripped = result.map(stripLargeFields);

        jsonOk(res, stripped);
        return;
    }

    // POST /api/moments — Upsert a single moment
    if (pathname === '/api/moments' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                if (!data.id) {
                    jsonError(res, 400, 'Missing moment id');
                    return;
                }
                if (!isValidMomentId(data.id)) {
                    jsonError(res, 400, 'Invalid moment id');
                    return;
                }
                const saved = upsertMoment(data);
                saveMomentsDb();
                jsonOk(res, stripLargeFields(saved));
            } catch (e) {
                jsonError(res, 400, 'Invalid JSON');
            }
        });
        return;
    }

    // POST /api/moments/sync — Bulk sync
    if (pathname === '/api/moments/sync' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const incoming = data.moments;
                if (!Array.isArray(incoming)) {
                    jsonError(res, 400, 'Expected { moments: [...] }');
                    return;
                }
                let synced = 0;
                for (let i = 0; i < incoming.length; i++) {
                    if (incoming[i] && incoming[i].id && isValidMomentId(incoming[i].id)) {
                        upsertMoment(incoming[i]);
                        synced++;
                    }
                }
                saveMomentsDb();
                // Return full list (stripped)
                const stripped = momentsDb.map(stripLargeFields);
                jsonOk(res, { synced, moments: stripped });
            } catch (e) {
                jsonError(res, 400, 'Invalid JSON');
            }
        });
        return;
    }

    // GET /api/moments/:id — Get single moment (with thumbnail restored)
    if (pathname.startsWith('/api/moments/') && req.method === 'GET' &&
        !pathname.includes('/clip') && !pathname.includes('/extract') && !pathname.includes('/status') && !pathname.includes('/sync') && !pathname.includes('/analyze') && !pathname.includes('/thumb')) {
        const momentId = pathname.slice('/api/moments/'.length);
        if (!isValidMomentId(momentId)) {
            jsonError(res, 400, 'Invalid moment id');
            return;
        }
        const found = momentsDb.find(m => m.id === momentId);
        if (!found) {
            jsonError(res, 404, 'Moment not found');
            return;
        }
        // Return copy with thumbnail restored
        const copy = Object.assign({}, found);
        restoreThumbnail(copy);
        jsonOk(res, copy);
        return;
    }

    // DELETE /api/moments/:id — Delete a moment
    if (pathname.startsWith('/api/moments/') && req.method === 'DELETE' &&
        !pathname.includes('/clip')) {
        const momentId = pathname.slice('/api/moments/'.length);
        if (!isValidMomentId(momentId)) {
            jsonError(res, 400, 'Invalid moment id');
            return;
        }
        const idx = momentsDb.findIndex(m => m.id === momentId);
        if (idx === -1) {
            jsonError(res, 404, 'Moment not found');
            return;
        }
        const removed = momentsDb.splice(idx, 1)[0];

        // Clean up thumbnail file
        if (removed.thumbnailPath) {
            const thumbPath = path.join(MOMENTS_THUMBS, removed.thumbnailPath);
            try { if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath); } catch (e) { /* ignore */ }
        }

        // Clean up extracted clip
        const clipPath = path.join(MOMENTS_DIR, `${momentId}.mp4`);
        try { if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath); } catch (e) { /* ignore */ }
        const partPath = clipPath + '.part';
        try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (e) { /* ignore */ }

        saveMomentsDb();

        jsonOk(res, { ok: true, deleted: momentId });
        return;
    }

    // === Moment Clip Extraction API ===

    if (pathname === '/api/moments/extract' && req.method === 'POST') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
            try {
                const data = JSON.parse(body);
                const { momentId, sourceUrl, start, end, sourceFileId } = data;

                if (!ffmpegAvailable) {
                    jsonError(res, 500, 'ffmpeg not available');
                    return;
                }
                if (!momentId || !sourceUrl) {
                    jsonError(res, 400, 'Missing momentId or sourceUrl');
                    return;
                }
                // Reject momentIds with path separators
                if (momentId.includes('/') || momentId.includes('\\') || momentId.includes('..')) {
                    jsonError(res, 400, 'Invalid momentId');
                    return;
                }
                const startF = parseFloat(start);
                const endF = parseFloat(end);
                if (!isFinite(startF) || !isFinite(endF) || startF < 0 || startF >= endF) {
                    jsonError(res, 400, 'Invalid time range');
                    return;
                }

                // Idempotency: check for existing queued/active job for this momentId
                const existingJobId = Object.keys(extractJobs).find(
                    id => extractJobs[id].momentId === momentId &&
                          (extractJobs[id].status === 'queued' || extractJobs[id].status === 'extracting')
                );
                if (existingJobId) {
                    jsonOk(res, { jobId: existingJobId, status: extractJobs[existingJobId].status, deduplicated: true });
                    return;
                }

                const jobId = `ext_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
                const outputPath = path.join(MOMENTS_DIR, `${momentId}.mp4`);

                extractJobs[jobId] = {
                    status: 'queued', progress: 0,
                    momentId, sourceUrl, sourceFileId: sourceFileId || null,
                    start: startF, end: endF,
                    outputPath, process: null, pid: null,
                    error: null, startedAt: null, completedAt: null
                };

                extractQueue.push(jobId);
                processExtractQueue();

                jsonOk(res, { jobId, status: 'queued', momentId });
            } catch (e) {
                jsonError(res, 400, 'Invalid JSON');
            }
        });
        return;
    }

    if (pathname === '/api/moments/status' && req.method === 'GET') {
        const momentId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('momentId');
        if (!momentId) {
            jsonError(res, 400, 'Missing momentId');
            return;
        }

        // Check in-memory jobs first
        const jobId = Object.keys(extractJobs).find(id => extractJobs[id].momentId === momentId);
        if (jobId) {
            const job = extractJobs[jobId];
            jsonOk(res, {
                status: job.status, progress: job.progress, jobId,
                extractedUrl: job.status === 'complete' ? `/api/moments/${momentId}/clip.mp4` : null,
                error: job.error || null
            });
            return;
        }

        // Check disk (server may have restarted after successful extraction)
        const filePath = path.join(MOMENTS_DIR, `${momentId}.mp4`);
        if (fs.existsSync(filePath)) {
            jsonOk(res, {
                status: 'complete', progress: 100,
                extractedUrl: `/api/moments/${momentId}/clip.mp4`
            });
            return;
        }

        jsonOk(res, { status: 'none' });
        return;
    }

    if (pathname.startsWith('/api/moments/') && pathname.endsWith('/clip.mp4') && req.method === 'GET') {
        const momentId = pathname.slice('/api/moments/'.length, -'/clip.mp4'.length);
        if (!isValidMomentId(momentId)) {
            jsonError(res, 400, 'Invalid moment ID');
            return;
        }
        const clipPath = path.join(MOMENTS_DIR, `${momentId}.mp4`);

        // Directory traversal guard
        if (!clipPath.startsWith(MOMENTS_DIR)) {
            jsonError(res, 403, 'Forbidden');
            return;
        }

        if (!fs.existsSync(clipPath)) {
            jsonError(res, 404, 'Clip not yet extracted');
            return;
        }

        const stat = fs.statSync(clipPath);
        serveFileWithRange(req, res, clipPath, stat, 'video/mp4');
        return;
    }

    // Serve moment thumbnail — generate from clip via ffmpeg if not cached
    if (pathname.startsWith('/api/moments/') && pathname.endsWith('/thumb.jpg') && req.method === 'GET') {
        const momentId = pathname.slice('/api/moments/'.length, -'/thumb.jpg'.length);
        if (!isValidMomentId(momentId)) {
            jsonError(res, 400, 'Invalid moment ID');
            return;
        }
        const thumbPath = path.join(MOMENTS_THUMBS, momentId + '.jpg');

        // 1) Already cached on disk — serve it
        if (fs.existsSync(thumbPath)) {
            const stat = fs.statSync(thumbPath);
            res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Content-Length': stat.size,
                'Cache-Control': 'public, max-age=86400'
            });
            fs.createReadStream(thumbPath).pipe(res);
            return;
        }

        // 2) No cached thumb — extract via ffmpeg from clip or source video
        const clipPath = path.join(MOMENTS_DIR, `${momentId}.mp4`);
        let inputPath = null;
        let seekTime = 0.5;

        if (clipPath.startsWith(MOMENTS_DIR) && fs.existsSync(clipPath)) {
            inputPath = clipPath;
        } else {
            // 3) No clip — try source video at the moment's peak time
            const mom = momentsDb.find(m => m.id === momentId);
            if (mom) {
                seekTime = mom.peak || mom.start || 0;
                const srcUrl = mom.sourceUrl || mom.streamUrl || '';
                if (srcUrl.startsWith('/api/files/')) {
                    // Local file — resolve to disk path
                    const localFile = path.join(UPLOADS_DIR, srcUrl.replace('/api/files/', ''));
                    if (localFile.startsWith(UPLOADS_DIR) && fs.existsSync(localFile)) {
                        inputPath = localFile;
                    } else {
                        // Check HLS directory for transcoded version
                        const hlsDir = path.join(HLS_DIR, srcUrl.replace('/api/files/', '').replace(/\.[^.]+$/, ''));
                        const hlsPlaylist = path.join(hlsDir, 'playlist.m3u8');
                        if (fs.existsSync(hlsPlaylist)) inputPath = hlsPlaylist;
                    }
                } else if (srcUrl.startsWith('http')) {
                    // External URL — ffmpeg can fetch directly
                    inputPath = srcUrl;
                }
            }
        }

        if (!inputPath) {
            jsonError(res, 404, 'No clip or source video for thumbnail');
            return;
        }

        const ffArgs = ['-ss', String(seekTime), '-i', inputPath,
            '-vframes', '1',
            '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
            '-q:v', '4',
            '-y', thumbPath];
        // External URLs need a timeout and user-agent
        if (inputPath.startsWith('http')) {
            ffArgs.unshift('-timeout', '10000000', '-user_agent', 'Mozilla/5.0');
        }
        const ffmpeg = spawn('ffmpeg', ffArgs);
        ffmpeg.on('close', (code) => {
            if (code !== 0 || !fs.existsSync(thumbPath)) {
                jsonError(res, 500, 'Thumbnail generation failed');
                return;
            }
            const stat = fs.statSync(thumbPath);
            res.writeHead(200, {
                'Content-Type': 'image/jpeg',
                'Content-Length': stat.size,
                'Cache-Control': 'public, max-age=86400'
            });
            fs.createReadStream(thumbPath).pipe(res);
        });
        ffmpeg.on('error', () => {
            jsonError(res, 500, 'ffmpeg not available');
        });
        return;
    }

    if (pathname.startsWith('/api/moments/') && pathname.endsWith('/clip') && req.method === 'DELETE') {
        const momentId = pathname.slice('/api/moments/'.length, -'/clip'.length);
        if (!isValidMomentId(momentId)) {
            jsonError(res, 400, 'Invalid moment ID');
            return;
        }

        // Directory traversal guard
        const clipCheck = path.join(MOMENTS_DIR, `${momentId}.mp4`);
        if (!clipCheck.startsWith(MOMENTS_DIR)) {
            jsonError(res, 403, 'Forbidden');
            return;
        }

        // Cancel any active/queued job
        const jobId = Object.keys(extractJobs).find(id => extractJobs[id].momentId === momentId);
        if (jobId) {
            const job = extractJobs[jobId];
            if (job.process) { try { job.process.kill(); } catch (e) {} }
            // Remove from queue if still queued
            const qIdx = extractQueue.indexOf(jobId);
            if (qIdx !== -1) extractQueue.splice(qIdx, 1);
            activeExtracts.delete(jobId);
            delete extractJobs[jobId];
        }

        // Delete files
        const clipPath = path.join(MOMENTS_DIR, `${momentId}.mp4`);
        const partPath = clipPath + '.part';
        try { if (fs.existsSync(clipPath)) fs.unlinkSync(clipPath); } catch (e) {}
        try { if (fs.existsSync(partPath)) fs.unlinkSync(partPath); } catch (e) {}

        jsonOk(res, { ok: true });
        return;
    }

    // === AI Analysis API (Skier) ===

    // GET /api/ai/status — Check availability of AI backends
    if (pathname === '/api/ai/status' && req.method === 'GET') {
        jsonOk(res, {
            available: skierAvailable,
            servers: skierServers.map(s => ({
                category: s.category, model: s.model,
                port: s.port, tags: s.tagCount, available: s.available
            }))
        });
        return;
    }

    // POST /api/moments/:id/analyze — Analyze single moment with Skier
    const analyzeMatch = pathname.match(/^\/api\/moments\/([^/]+)\/analyze$/);
    if (analyzeMatch && req.method === 'POST') {
        const momentId = decodeURIComponent(analyzeMatch[1]);

        if (!isValidMomentId(momentId)) {
            jsonError(res, 400, 'Invalid moment id');
            return;
        }

        if (!skierAvailable) {
            jsonError(res, 503, 'Skier not available (http://localhost:8000)');
            return;
        }

        const thumbPath = path.join(MOMENTS_THUMBS, momentId + '.jpg');
        try {
            await fs.promises.access(thumbPath);
        } catch {
            jsonError(res, 404, 'No thumbnail found for moment ' + momentId);
            return;
        }

        try {
            const skierResult = await analyzeWithSkier(thumbPath);
            const aiTags = skierResult.tags;
            const confidences = skierResult.confidences;
            const categories = skierResult.categories || [];

            // Update moment in server store — only if we got tags (preserve existing)
            const moment = momentsDb.find(m => m.id === momentId);
            if (moment && aiTags.length > 0) {
                moment.aiTags = aiTags;
                if (Object.keys(confidences).length > 0) moment.aiConfidences = confidences;
                moment.updatedAt = Date.now();
                saveMomentsDb();
            }

            jsonOk(res, {
                momentId, tags: aiTags, confidences,
                providers: categories.length > 0 ? categories : ['skier']
            });

            console.log('[Server] AI analysis complete for', momentId,
                '- models:', categories.join('+'),
                '- tags:', aiTags.join(', '));

        } catch (err) {
            console.error('[Server] AI analysis failed:', err.message);
            jsonError(res, 500, 'AI analysis failed: ' + err.message);
        }
        return;
    }

    // POST /api/moments/analyze-batch — Analyze all untagged moments
    if (pathname === '/api/moments/analyze-batch' && req.method === 'POST') {
        if (!skierAvailable) {
            jsonError(res, 503, 'Skier not available (http://localhost:8000)');
            return;
        }

        if (batchProgress.running) {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Batch already in progress', progress: batchProgress }));
            return;
        }

        const untagged = momentsDb.filter(m =>
            (!m.aiTags || m.aiTags.length === 0) && m.thumbnailPath
        );

        // Respond immediately with count, process in background
        jsonOk(res, { queued: untagged.length, total: momentsDb.length });

        // Process sequentially in background (don't overwhelm the AI servers)
        // Snapshot IDs — lookup fresh references each iteration to avoid stale refs from sync
        const queuedIds = untagged.map(m => m.id);
        batchProgress = { total: queuedIds.length, done: 0, current: '', errors: 0, running: true };
        (async () => {
            for (const momId of queuedIds) {
                const thumbPath = path.join(MOMENTS_THUMBS, momId + '.jpg');
                try {
                    await fs.promises.access(thumbPath);
                } catch { batchProgress.done++; continue; }

                const mom = momentsDb.find(m => m.id === momId);
                batchProgress.current = mom ? (mom.sourceTitle || momId).substring(0, 40) : momId;

                try {
                    let aiTags = [];
                    let aiConfidences = {};
                    if (skierAvailable) {
                        const result = await analyzeWithSkier(thumbPath);
                        aiTags = result.tags;
                        aiConfidences = result.confidences;
                    }
                    // Fresh lookup — sync may have replaced the object reference
                    const freshMom = momentsDb.find(m => m.id === momId);
                    if (!freshMom) { batchProgress.done++; continue; }
                    if (aiTags.length > 0) {
                        freshMom.aiTags = aiTags;
                        if (Object.keys(aiConfidences).length > 0) freshMom.aiConfidences = aiConfidences;
                        batchProgress.lastTags = aiTags.slice(0, 5).join(', ');
                    }
                    freshMom.updatedAt = Date.now();
                    batchProgress.done++;
                    // Save every 5 to avoid data loss
                    if (batchProgress.done % 5 === 0) saveMomentsDb();
                } catch (err) {
                    batchProgress.done++;
                    batchProgress.errors++;
                    console.warn('[Server] Batch analyze failed for', momId, ':', err.message);
                }
            }
            if (batchProgress.done > 0) saveMomentsDb();
            batchProgress.running = false;
            console.log('[Server] Batch analyze complete:', batchProgress.done + '/' + queuedIds.length, 'moments tagged');
        })();
        return;
    }

    // GET /api/moments/analyze-progress — Poll batch analysis progress
    if (pathname === '/api/moments/analyze-progress' && req.method === 'GET') {
        jsonOk(res, batchProgress);
        return;
    }

    // GET /api/stash/scene-info?url=... - Get metadata for a Stash scene URL
    // Extracts scene ID from URL pattern /scene/{id}/stream, queries GraphQL
    if (pathname === '/api/stash/scene-info' && req.method === 'GET') {
        const sceneUrl = url.searchParams.get('url') || '';
        const match = sceneUrl.match(/\/scene\/(\d+)/);
        if (!match) {
            jsonError(res, 400, 'Not a Stash scene URL');
            return;
        }
        const sceneId = match[1];
        try {
            const data = await fetchStashGraphQL(`query ($id: ID!) {
                findScene(id: $id) {
                    id title rating100
                    paths { stream screenshot }
                    performers { id name }
                    tags { id name }
                    studio { id name }
                    files { width height duration }
                }
            }`, { id: sceneId });
            const scene = data.findScene;
            if (!scene) {
                jsonError(res, 404, 'Scene not found in Stash');
                return;
            }
            jsonOk(res, {
                url: scene.paths?.stream || sceneUrl,
                title: scene.title || 'Stash Scene',
                tags: (scene.tags || []).map(t => t.name),
                actors: (scene.performers || []).map(p => p.name),
                category: scene.studio?.name || '',
                site: 'Stash',
                rating: scene.rating100 != null ? scene.rating100 : null,
                thumbnail: scene.paths?.screenshot || null,
            });
        } catch (err) {
            jsonError(res, 500, 'Stash query failed: ' + err.message);
        }
        return;
    }

    // POST /api/demo/refresh-auth - Force re-authenticate all Aylo sites using instance tokens
    if (pathname === '/api/demo/refresh-auth' && req.method === 'POST') {
        _refreshedTokens = {}; // Clear cached tokens to force re-auth
        _cookieCache = {};     // Clear cookie cache to re-read from Chrome
        const results = {};
        const seen = new Set();
        for (const siteName of Object.keys(AYLO_SITES)) {
            const host = AYLO_SITES[siteName].cookieHost;
            if (seen.has(host)) continue;
            seen.add(host);
            const auth = await getAyloAuth(siteName);
            results[siteName] = {
                loggedIn: !!auth.accessToken,
                hasSession: !!auth.instanceToken,
                error: auth.error || null
            };
        }
        const loggedIn = Object.values(results).filter(r => r.loggedIn).length;
        console.log('[Auth] Refresh complete: ' + loggedIn + '/' + Object.keys(results).length + ' sites authenticated');
        jsonOk(res, { results, loggedIn, total: Object.keys(results).length });
        return;
    }

    // GET /api/demo/auth-status - Check Aylo + Stash status
    if (pathname === '/api/demo/auth-status' && req.method === 'GET') {
        const aylo = {};
        for (const siteName of Object.keys(AYLO_SITES)) {
            const auth = await getAyloAuth(siteName);
            aylo[siteName] = {
                loggedIn: !!auth.accessToken,
                hasSession: !!auth.instanceToken,
                warning: auth.warning || auth.error || null
            };
        }
        const stash = await checkStashConnection();
        stash.url = STASH_CONFIG.url;
        const groups = {};
        for (const [site, gs] of Object.entries(_playableGroups)) {
            groups[site] = gs.map(g => g.name);
        }
        // Backward compat: keep top-level 'brazzers' key pointing to brazzers status
        jsonOk(res, { aylo, stash, groups, brazzers: aylo.brazzers || aylo[Object.keys(aylo)[0]] });
        return;
    }

    // GET /api/demo/actors - Serve performers (disk-cached, background-refreshed from all sites)
    if (pathname === '/api/demo/actors' && req.method === 'GET') {
        if (_actorCache && _actorCache.length > 0) {
            jsonOk(res, { actors: _actorCache });
        } else {
            // No cache — try live fetch from any available site
            const auth = await getAnyAyloAuth();
            if (!auth.accessToken) { jsonOk(res, { actors: [], error: 'No cached data and login required' }); return; }
            try { jsonOk(res, { actors: await refreshActorsFromApi(auth) || [] }); }
            catch (err) { jsonError(res, 500, 'Failed to fetch actors: ' + err.message); }
        }
        return;
    }

    // GET /api/demo/tags - Serve tags (disk-cached, background-refreshed from all sites)
    // Includes synthetic "Network" category with Aylo sites + Stash studios (negative IDs)
    if (pathname === '/api/demo/tags' && req.method === 'GET') {
        let tags = _tagCache;
        if (!tags || Object.keys(tags).length === 0) {
            // Try live fetch from Aylo and/or Stash
            const auth = await getAnyAyloAuth();
            if (auth.accessToken) {
                try { tags = await refreshTagsFromApi(auth); } catch (e) { /* continue */ }
            }
            try { await refreshStashTags(); tags = _tagCache; } catch (e) { /* continue */ }
            if (!tags || Object.keys(tags).length === 0) {
                jsonOk(res, { tags: {}, error: 'No cached data available' });
                return;
            }
        }
        // Build response with Network first, then tag categories, then Stash Studios last
        // Network = only our configured Aylo sites + Stash umbrella (not individual studios)
        const networkTags = [];
        const seen = new Set();
        for (const groups of Object.values(_playableGroups)) {
            for (const g of groups) {
                if (!seen.has(g.groupId)) {
                    seen.add(g.groupId);
                    networkTags.push({ id: g.tagId, name: g.name });
                }
            }
        }
        if (networkTags.length === 0) {
            for (const [name, g] of Object.entries(AYLO_GROUPS)) {
                networkTags.push({ id: -g.groupId, name });
            }
        }
        networkTags.push({ id: STASH_STUDIO_OFFSET, name: 'Stash' });
        networkTags.sort((a, b) => a.name.localeCompare(b.name));

        // Stash studios as a separate category at the end
        let stashStudios = [];
        try {
            const studios = JSON.parse(fs.readFileSync(STASH_STUDIOS_CACHE, 'utf8'));
            stashStudios = studios.map(s => ({ id: STASH_STUDIO_OFFSET - s.id, name: s.name }));
            stashStudios.sort((a, b) => a.name.localeCompare(b.name));
        } catch (e) { /* no studios cache yet */ }

        // Ordered: Network first, then tag categories alphabetically, Stash Studios last
        const ordered = { Network: networkTags };
        const catKeys = Object.keys(tags).sort((a, b) => a.localeCompare(b));
        for (const cat of catKeys) ordered[cat] = tags[cat];
        if (stashStudios.length > 0) ordered['Stash Studios'] = stashStudios;
        jsonOk(res, { tags: ordered });
        return;
    }

    // GET /api/demo/performers/search?q=name - Search performers by name (all Aylo sites)
    if (pathname === '/api/demo/performers/search' && req.method === 'GET') {
        const query = url.searchParams.get('q') || '';
        const limit = parseInt(url.searchParams.get('limit')) || 20;
        if (!query) { jsonOk(res, { performers: [] }); return; }
        const auths = await getAllAyloAuths();
        if (auths.length === 0) { jsonOk(res, { performers: [], error: 'Login required' }); return; }
        try {
            const externalIp = await getExternalIp();
            // Search all sites in parallel, merge by performer ID
            const queries = auths.map(auth => {
                auth.externalIp = externalIp;
                return fetchAyloApi(`/v1/actors?limit=${limit}&search=${encodeURIComponent(query)}`, auth);
            });
            const results = await Promise.allSettled(queries);
            const perfMap = {};
            for (const r of results) {
                if (r.status !== 'fulfilled' || r.value.status !== 200 || !r.value.data.result) continue;
                for (const a of r.value.data.result) {
                    if (perfMap[a.id]) continue;
                    let scenes = 0;
                    if (Array.isArray(a.scenesPerBrand)) {
                        for (const b of a.scenesPerBrand) scenes += (b.sceneCount || 0);
                    }
                    const profile = a.images?.profile?.['0'] || a.images?.profile?.[0];
                    const thumb = profile?.xs?.url || profile?.sm?.url || profile?.md?.url || null;
                    perfMap[a.id] = { id: a.id, name: a.name, thumbnail: thumb, scenes };
                }
            }
            const performers = Object.values(perfMap).sort((a, b) => b.scenes - a.scenes).slice(0, limit);
            jsonOk(res, { performers });
        } catch (err) {
            jsonError(res, 500, 'Performer search failed: ' + err.message);
        }
        return;
    }

    // GET /api/demo/performers/:id/scenes - Get scenes by performer (all Aylo sites)
    if (pathname.startsWith('/api/demo/performers/') && pathname.endsWith('/scenes') && req.method === 'GET') {
        const actorId = pathname.split('/')[4];
        const count = parseInt(url.searchParams.get('count')) || 9;
        const auths = await getAllAyloAuths();
        if (auths.length === 0) { jsonOk(res, { streams: [], error: 'Login required' }); return; }
        try {
            const externalIp = await getExternalIp();
            // Query all sites in parallel, merge scenes by ID, track source site
            const queries = auths.map(auth => {
                auth.externalIp = externalIp;
                return fetchAyloApi(`/v2/releases?limit=${count}&type=scene&actorsIds=${actorId}&orderBy=-dateReleased`, auth)
                    .then(r => ({ r, site: auth._site }));
            });
            const results = await Promise.allSettled(queries);
            const sceneMap = {};
            for (const res of results) {
                if (res.status !== 'fulfilled') continue;
                const { r, site } = res.value;
                if (r.status !== 200 || !r.data.result) continue;
                for (const scene of r.data.result) {
                    if (sceneMap[scene.id]) continue;
                    const videoUrl = extractBestVideoUrl(scene.videos?.full?.files || scene.videos?.mediabook?.files || []);
                    if (!videoUrl) continue;
                    const tags = (scene.tags || []).map(t => t.name);
                    const actors = (scene.actors || []).map(a => a.name);
                    const brandName = scene.brand || site;
                    if (brandName && !tags.includes(brandName)) tags.unshift(brandName);
                    sceneMap[scene.id] = { url: videoUrl, title: scene.title || 'Scene', tags, actors, category: scene.collections?.[0]?.name || '', site: brandName };
                }
            }
            const streams = Object.values(sceneMap).slice(0, count);
            console.log('[Demo] Performer ' + actorId + ': ' + streams.length + ' scenes from ' + auths.length + ' sites');
            jsonOk(res, { streams, source: 'aylo', fetched: streams.length });
        } catch (err) {
            jsonError(res, 500, 'Performer scenes failed: ' + err.message);
        }
        return;
    }

    // GET /api/demo/streams - Scrape random streams for xfill demo
    // ?source=xhamster|brazzers|aylo (default: aylo if any login available, else xhamster)
    // ?count=9 — source=brazzers treated as aylo (backward compat)
    // Multi-source: IDs are routed by range — Stash tags >= 100000, Stash studios <= -1000
    if (pathname === '/api/demo/streams' && req.method === 'GET') {
        const count = parseInt(url.searchParams.get('count')) || 9;
        let source = url.searchParams.get('source') || 'auto';
        const tagIdsParam = url.searchParams.get('tagIds');
        const tagIdList = tagIdsParam ? tagIdsParam.split(',').map(Number).filter(Boolean) : [];
        const actorIdsParam = url.searchParams.get('actorIds');
        const actorIdList = actorIdsParam ? actorIdsParam.split(',').map(Number).filter(Boolean) : [];

        // Treat 'brazzers' as 'aylo' for backward compat
        if (source === 'brazzers') source = 'aylo';

        // Partition IDs by source:
        //   Stash tags: >= STASH_TAG_OFFSET (100000)
        //   Stash performers: >= STASH_PERFORMER_OFFSET (100000)
        //   Stash studios: <= STASH_STUDIO_OFFSET (-1000), including -1000 itself (umbrella)
        //   Aylo site filters: -1 to -99 (negative but above -1000)
        //   Aylo tags: positive < 100000
        const stashTagIds = tagIdList.filter(id => id >= STASH_TAG_OFFSET);
        const stashStudioIds = tagIdList.filter(id => id <= STASH_STUDIO_OFFSET);
        const ayloTagIds = tagIdList.filter(id => id > STASH_STUDIO_OFFSET && id < STASH_TAG_OFFSET);
        const stashActorIds = actorIdList.filter(id => id >= STASH_PERFORMER_OFFSET);
        const ayloActorIds = actorIdList.filter(id => id < STASH_PERFORMER_OFFSET);

        const hasStashFilters = stashTagIds.length > 0 || stashActorIds.length > 0 || stashStudioIds.length > 0;
        const hasAyloFilters = ayloTagIds.length > 0 || ayloActorIds.length > 0;

        // Auto-detect: prefer Aylo if logged in, always include Stash if reachable
        if (source === 'auto') {
            const auths = await getAllAyloAuths();
            source = auths.length > 0 ? 'aylo' : 'xhamster';
        }

        if (source === 'aylo' || source === 'auto') {
            try {
                const results = [];

                if (hasStashFilters && !hasAyloFilters) {
                    // Only Stash filters — query Stash only
                    const stashStreams = await scrapeStashScenes(count, stashTagIds, stashActorIds, stashStudioIds);
                    results.push(...stashStreams);
                } else if (hasAyloFilters && !hasStashFilters) {
                    // Only Aylo filters — query Aylo only (existing behavior)
                    const ayloStreams = await scrapeAyloScenes(count, ayloTagIds, ayloActorIds);
                    results.push(...ayloStreams);
                } else if (hasStashFilters && hasAyloFilters) {
                    // Mixed filters — query both with their respective filters
                    const [stashStreams, ayloStreams] = await Promise.allSettled([
                        scrapeStashScenes(Math.ceil(count / 2), stashTagIds, stashActorIds, stashStudioIds),
                        scrapeAyloScenes(Math.ceil(count / 2), ayloTagIds, ayloActorIds),
                    ]);
                    if (stashStreams.status === 'fulfilled') results.push(...stashStreams.value);
                    if (ayloStreams.status === 'fulfilled') results.push(...ayloStreams.value);
                } else {
                    // No filters — query both, split count, shuffle
                    const stashCount = Math.ceil(count / 3);      // ~33% Stash
                    const ayloCount = count - stashCount;          // ~67% Aylo
                    const [stashStreams, ayloStreams] = await Promise.allSettled([
                        scrapeStashScenes(stashCount),
                        scrapeAyloScenes(ayloCount, [], []),
                    ]);
                    if (stashStreams.status === 'fulfilled') results.push(...stashStreams.value);
                    if (ayloStreams.status === 'fulfilled') results.push(...ayloStreams.value);
                }

                // Shuffle merged results for variety
                for (let i = results.length - 1; i > 0; i--) {
                    const j = Math.floor(Math.random() * (i + 1));
                    [results[i], results[j]] = [results[j], results[i]];
                }

                const streams = results.slice(0, count);
                const sources = [...new Set(streams.map(s => s.site || 'unknown'))];
                console.log('[Demo] Multi-source: ' + streams.length + ' scenes from ' + sources.join(', ') +
                    (tagIdList.length ? ' (tags: ' + tagIdList.join(',') + ')' : '') +
                    (actorIdList.length ? ' (actors: ' + actorIdList.join(',') + ')' : ''));

                jsonOk(res, {
                    streams,
                    source: sources.length === 1 ? sources[0].toLowerCase() : 'mixed',
                    fetched: streams.length,
                    failed: 0,
                    authenticated: true
                });
            } catch (err) {
                console.error('[Demo] Stream fetch error:', err.message);
                jsonError(res, 500, 'Failed to fetch streams: ' + err.message);
            }
            return;
        }

        // Default: xHamster scraping
        const CONCURRENCY = 6;
        try {
            const videoPageUrls = await scrapeXhamsterListing(count);
            console.log('[Demo] Found ' + videoPageUrls.length
                + ' video pages, extracting streams...');

            if (videoPageUrls.length === 0) {
                jsonOk(res, {
                    streams: [],
                    source: 'xhamster',
                    fetched: 0,
                    failed: 0,
                    error: 'No videos found on listing page'
                });
                return;
            }

            // Fetch video pages in batches with concurrency limit
            const streams = [];
            let failed = 0;
            for (let i = 0; i < videoPageUrls.length
                    && streams.length < count; i += CONCURRENCY) {
                const batch = videoPageUrls.slice(i, i + CONCURRENCY);
                const results = await Promise.allSettled(
                    batch.map(url => scrapeXhamsterVideo(url))
                );
                for (const r of results) {
                    if (r.status === 'fulfilled' && r.value) {
                        streams.push(r.value);
                    } else {
                        failed++;
                    }
                }
            }

            console.log('[Demo] Extracted ' + streams.length
                + ' streams (' + failed + ' failed)');
            jsonOk(res, {
                streams: streams.slice(0, count),
                source: 'xhamster',
                fetched: streams.length,
                failed: failed
            });
        } catch (err) {
            console.error('[Demo] Scrape error:', err.message);
            jsonError(res, 500,
                'Failed to scrape demo streams: ' + err.message);
        }
        return;
    }

    // Static file serving
    let filePath = pathname === '/' ? '/index.html' : pathname;
    filePath = path.join(WEB_ROOT, filePath);

    // Security: prevent directory traversal
    if (!filePath.startsWith(WEB_ROOT)) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
    }

    fs.readFile(filePath, (err, data) => {
        if (err) {
            if (err.code === 'ENOENT') {
                res.writeHead(404);
                res.end('Not Found');
            } else {
                res.writeHead(500);
                res.end('Server Error');
            }
            return;
        }

        const ext = path.extname(filePath).toLowerCase();
        const contentType = MIME_TYPES[ext] || 'application/octet-stream';

        res.writeHead(200, { 'Content-Type': contentType });
        res.end(data);
    });

    } catch (err) {
        console.error(`[Server] Request handler error: ${err.message}`, req.url);
        if (!res.headersSent) {
            try { jsonError(res, 500, 'Internal server error'); } catch (_) { res.end(); }
        }
    }
});

// Graceful shutdown - kill active ffmpeg processes
function gracefulShutdown(signal) {
    console.log(`\n[Server] Received ${signal}, shutting down...`);

    // Kill active ffmpeg processes (transcodes, downloads + extractions)
    let killed = 0;
    for (const fileId of activeTranscodes) {
        try {
            const job = transcodingJobs[fileId];
            if (job?.process) {
                job.process.kill('SIGTERM');
                killed++;
            }
        } catch (e) { /* ignore */ }
    }
    for (const jobId of activeDownloads) {
        try {
            const job = downloadJobs[jobId];
            if (job?.process) {
                job.process.kill('SIGTERM');
                killed++;
            }
        } catch (e) { /* ignore */ }
    }
    for (const jobId of activeExtracts) {
        try {
            const job = extractJobs[jobId];
            if (job?.process) {
                job.process.kill('SIGTERM');
                killed++;
            }
        } catch (e) { /* ignore */ }
    }

    if (killed > 0) {
        console.log(`[Server] Killed ${killed} active ffmpeg process(es)`);
    }

    // Close the server
    server.close(() => {
        console.log('[Server] Closed');
        process.exit(0);
    });

    // Force exit after 5 seconds if graceful shutdown fails
    setTimeout(() => {
        console.log('[Server] Forcing exit');
        process.exit(1);
    }, 5000);
}

process.on('SIGINT', () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

server.listen(PORT, '0.0.0.0', () => {
    // Get local IP addresses
    const { networkInterfaces } = require('os');
    const nets = networkInterfaces();
    const ips = [];

    for (const name of Object.keys(nets)) {
        for (const net of nets[name]) {
            if (net.family === 'IPv4' && !net.internal) {
                ips.push(net.address);
            }
        }
    }

    console.log('');
    console.log('='.repeat(50));
    console.log('  Plexd Server with Remote Control');
    console.log('='.repeat(50));
    console.log('');
    console.log('  Main app:');
    console.log(`    http://localhost:${PORT}/`);
    ips.forEach(ip => {
        console.log(`    http://${ip}:${PORT}/`);
    });
    console.log('');
    console.log('  Remote control (open on iPhone):');
    console.log(`    http://localhost:${PORT}/remote.html`);
    ips.forEach(ip => {
        console.log(`    http://${ip}:${PORT}/remote.html`);
    });
    console.log('');
    console.log('='.repeat(50));
    console.log('');
});
