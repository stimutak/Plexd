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
const MAX_CONCURRENT_EXTRACTS = 2; // Clips are short, don't saturate encoder

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
try { momentsDb = JSON.parse(fs.readFileSync(MOMENTS_JSON, 'utf-8')); } catch (e) { momentsDb = []; }
let batchProgress = { total: 0, done: 0, current: '', errors: 0, running: false };

function saveMomentsDb() {
    fs.writeFileSync(MOMENTS_JSON, JSON.stringify(momentsDb, null, 2));
}

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
            } catch (e) { /* ignore */ }
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
        // If we can't check, assume there's space
        return Infinity;
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

    // Detach ffmpeg so it continues if server exits
    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe']
    });
    transcodingJobs[fileId].process = ffmpeg;
    transcodingJobs[fileId].pid = ffmpeg.pid;
    // Don't unref() so we can still track progress while server runs

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

    const ffmpegArgs = useSoftwareEncoder ? [
        '-ss', String(job.start),
        '-i', inputSource,
        '-t', String(duration),
        '-c:v', 'libx264', '-preset', 'fast', '-crf', '23',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', '+faststart',
        '-f', 'mp4', '-y', partPath
    ] : [
        '-ss', String(job.start),
        '-i', inputSource,
        '-t', String(duration),
        '-c:v', 'h264_videotoolbox', '-b:v', '5M',
        '-c:a', 'aac', '-b:a', '128k', '-ac', '2',
        '-movflags', '+faststart',
        '-f', 'mp4', '-y', partPath
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
        detached: true,
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
        '-movflags', 'frag_keyframe+empty_moov',
        '-f', 'mp4',
        '-y', partPath
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs, {
        detached: true,
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
    fs.writeFileSync(UPLOADS_META, JSON.stringify(fileMetadata, null, 2));
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
        transcodingJobs[fileId].process.kill();
        activeTranscodes.delete(fileId);
        delete transcodingJobs[fileId];
    }

    // Delete original file
    if (deleteOriginal) {
        const filePath = path.join(UPLOADS_DIR, fileId);
        try {
            if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
        } catch (e) { /* ignore */ }
    }

    // Delete HLS directory
    if (deleteHLS) {
        const hlsDir = path.join(HLS_DIR, fileId);
        try {
            if (fs.existsSync(hlsDir)) fs.rmSync(hlsDir, { recursive: true });
        } catch (e) { /* ignore */ }
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
function fetchUrl(targetUrl, callback, redirectCount = 0) {
    if (redirectCount > 5) {
        callback(new Error('Too many redirects'));
        return;
    }

    const mod = targetUrl.startsWith('https') ? https : http;
    const req = mod.get(targetUrl, { headers: { 'User-Agent': 'Plexd/1.0' }, timeout: 30000 }, (proxyRes) => {
        // Follow redirects
        if (proxyRes.statusCode >= 300 && proxyRes.statusCode < 400 && proxyRes.headers.location) {
            const redirectUrl = new URL(proxyRes.headers.location, targetUrl).href;
            proxyRes.resume(); // Consume response to free socket
            fetchUrl(redirectUrl, callback, redirectCount + 1);
            return;
        }
        callback(null, proxyRes);
    });
    req.on('error', callback);
    req.on('timeout', () => {
        req.destroy(new Error('Request timeout'));
    });
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

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;

    // Remote control API endpoints
    if (pathname === '/api/remote/state') {
        if (req.method === 'GET') {
            // Remote fetches current state
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(currentState));
        } else if (req.method === 'POST') {
            // Main app posts state updates
            let body = '';
            req.on('data', chunk => body += chunk);
            req.on('end', () => {
                try {
                    currentState = JSON.parse(body);
                    currentState.timestamp = Date.now();
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
                }
            });
        }
        return;
    }

    if (pathname === '/api/remote/command') {
        if (req.method === 'GET') {
            // Main app polls for commands
            const cmd = pendingCommands.shift();
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(cmd || null));
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
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ success: true }));
                } catch (e) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid JSON' }));
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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            files: hlsFiles,
            totalSize,
            totalSizeMB: Math.round(totalSize / 1024 / 1024),
            activeTranscodes: activeTranscodes.size,
            queueLength: transcodeQueue.length
        }));
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
                            try { dirSize += fs.statSync(fp).size; fs.unlinkSync(fp); } catch(e) {}
                        }
                        try { fs.rmdirSync(hlsSubDir); } catch(e) {}
                        freedBytes += dirSize;
                        cleaned++;
                        console.log(`[Reconcile] Removed partial transcode: ${fileId} (${(dirSize/1024/1024).toFixed(1)}MB)`);
                    }
                }
            }
        }
        if (marked > 0) saveMetadata();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ marked, cleaned, freedMB: Math.round(freedBytes / 1024 / 1024) }));
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
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, fileName: meta.fileName }));
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File not found' }));
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
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, fileName: meta.fileName }));
            } else {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Original file not found' }));
            }
        } else {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File not found' }));
        }
        return;
    }

    // Trigger transcoding for a specific file
    if (pathname.startsWith('/api/hls/transcode/') && req.method === 'POST') {
        const fileId = decodeURIComponent(pathname.replace('/api/hls/transcode/', ''));
        const meta = fileMetadata[fileId];

        if (meta && meta.contentType?.startsWith('video/') && !meta.hlsReady) {
            startHLSTranscode(fileId);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, queued: true }));
        } else {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Cannot transcode' }));
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, cancelledQueued: queuedCount, cancelledActive: activeCount }));
        return;
    }

    // Pause transcoding (let current finish, don't start new)
    if (pathname === '/api/hls/pause' && req.method === 'POST') {
        transcodePaused = true;
        console.log('[Server] Transcode queue paused');
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, paused: true }));
        return;
    }

    // Resume transcoding
    if (pathname === '/api/hls/resume' && req.method === 'POST') {
        transcodePaused = false;
        console.log('[Server] Transcode queue resumed');
        processTranscodeQueue();
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, paused: false }));
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, queued, active: activeTranscodes.size }));
        return;
    }

    // Get transcode queue status
    if (pathname === '/api/hls/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            paused: transcodePaused,
            queueLength: transcodeQueue.length,
            activeCount: activeTranscodes.size,
            maxConcurrent: MAX_CONCURRENT_TRANSCODES
        }));
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true, deleted, freedBytes, skippedTranscoding }));
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
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                fileId: existing.fileId,
                url: hlsReady ? existing.meta.hlsPath : `/api/files/${existing.fileId}`,
                hlsUrl: hlsReady ? existing.meta.hlsPath : null,
                fileName: existing.meta.fileName,
                size: existing.meta.originalSize,
                hlsReady: hlsReady,
                transcoding: isTranscoding,
                existing: true
            }));
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

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                fileId,
                url: `/api/files/${fileId}`,
                fileName,
                size,
                hlsReady: false,
                transcoding: mimeType.startsWith('video/')
            }));
        });

        req.on('error', (err) => {
            writeStream.end();
            try { fs.unlinkSync(filePath); } catch (e) { /* ignore */ }
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Upload failed' }));
        });

        return;
    }

    // Check transcoding status
    if (pathname === '/api/files/transcode-status' && req.method === 'GET') {
        const fileId = url.searchParams.get('fileId');
        if (fileId && transcodingJobs[fileId]) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify(transcodingJobs[fileId]));
        } else if (fileId && fileMetadata[fileId]?.hlsReady) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'complete', progress: 100, hlsUrl: fileMetadata[fileId].hlsPath }));
        } else {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ status: 'unknown', progress: 0 }));
        }
        return;
    }

    // Serve HLS files (playlist and segments)
    if (pathname.startsWith('/api/hls/') && req.method === 'GET') {
        const parts = pathname.replace('/api/hls/', '').split('/');
        const fileId = decodeURIComponent(parts[0]);
        const hlsFile = decodeURIComponent(parts.slice(1).join('/'));

        if (!fileId || !hlsFile) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid HLS path' }));
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
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'HLS file not found' }));
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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(files));
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
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ folder: folderPath, files }));
        } catch (e) {
            console.error(`[Server] Scan error: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
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
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ files }));
        } catch (e) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
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
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid file path' }));
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
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({
                        fileId,
                        url: meta.hlsReady ? meta.hlsPath : `/api/files/${fileId}`,
                        hlsReady: meta.hlsReady || false,
                        existing: true
                    }));
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
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    fileId,
                    url: `/api/files/${fileId}`,
                    hlsReady: false,
                    transcoding: true
                }));
            } catch (e) {
                console.error(`[Server] Import error: ${e.message}`);
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: e.message }));
            }
        });
        return;
    }

    // Serve a local file by path (for scanned files)
    if (pathname === '/api/files/local' && req.method === 'GET') {
        const filePath = url.searchParams.get('path');
        if (!filePath) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing path parameter' }));
            return;
        }

        try {
            if (!fs.existsSync(filePath)) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'File not found' }));
                return;
            }

            const stats = fs.statSync(filePath);
            const ext = path.extname(filePath).toLowerCase();
            const contentType = MIME_TYPES[ext] || 'application/octet-stream';

            serveFileWithRange(req, res, filePath, stats, contentType);
        } catch (e) {
            console.error(`[Server] Local file error: ${e.message}`);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: e.message }));
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
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ success: true, deleted }));
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
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ success: true, updated }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // Serve an uploaded file
    if (pathname.startsWith('/api/files/') && req.method === 'GET') {
        const fileId = decodeURIComponent(pathname.replace('/api/files/', ''));
        const meta = fileMetadata[fileId];

        if (!meta) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File not found' }));
            return;
        }

        const filePath = path.join(UPLOADS_DIR, fileId);
        if (!fs.existsSync(filePath)) {
            delete fileMetadata[fileId];
            saveMetadata();
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File not found' }));
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
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid file path' }));
                return;
            }
            if (fs.existsSync(orphanPath)) {
                fs.unlinkSync(orphanPath);
                console.log(`[Server] Deleted orphaned file: ${fileId}`);
            }
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
        return;
    }

    // HLS Proxy - fetch external HLS manifests/segments to bypass CORS
    if (pathname === '/api/proxy/hls' && req.method === 'GET') {
        const targetUrl = url.searchParams.get('url');
        if (!targetUrl) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing url parameter' }));
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
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing url parameter' }));
            return;
        }

        if (!ffmpegAvailable) {
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ffmpeg not available' }));
            return;
        }

        // Sanitize filename
        const safeName = name.replace(/[^a-zA-Z0-9_\-. ]/g, '_').replace(/\.(m3u8|ts)$/i, '') + '.mp4';

        // Dedup: return existing job if same URL is already queued/downloading
        const existingJob = Object.entries(downloadJobs).find(
            ([, j]) => j.url === targetUrl && (j.status === 'queued' || j.status === 'downloading')
        );
        if (existingJob) {
            const [existingId, job] = existingJob;
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jobId: existingId, status: job.status, filename: job.filename, deduplicated: true }));
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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ jobId, status: 'queued', filename: safeName }));
        return;
    }

    // Download status - list all jobs or get specific job
    if (pathname === '/api/downloads/status' && req.method === 'GET') {
        const jobId = url.searchParams.get('jobId');
        if (jobId) {
            const job = downloadJobs[jobId];
            if (!job) {
                res.writeHead(404, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Job not found' }));
            } else {
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({
                    jobId,
                    status: job.status,
                    progress: job.progress,
                    filename: job.filename,
                    error: job.error,
                    startedAt: job.startedAt,
                    completedAt: job.completedAt
                }));
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
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ jobs, queueLength: downloadQueue.length, activeCount: activeDownloads.size }));
        }
        return;
    }

    // Download completed file
    if (pathname === '/api/downloads/file' && req.method === 'GET') {
        const jobId = url.searchParams.get('jobId');
        if (!jobId || !downloadJobs[jobId]) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Job not found' }));
            return;
        }

        const job = downloadJobs[jobId];
        if (job.status !== 'complete') {
            res.writeHead(409, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Download not complete', status: job.status, progress: job.progress }));
            return;
        }

        if (!fs.existsSync(job.filepath)) {
            res.writeHead(410, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'File no longer available' }));
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
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'File read failed' }));
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
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Job not found' }));
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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(stripped));
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
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing moment id' }));
                    return;
                }
                if (!isValidMomentId(data.id)) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid moment id' }));
                    return;
                }
                const saved = upsertMoment(data);
                saveMomentsDb();
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify(stripLargeFields(saved)));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
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
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Expected { moments: [...] }' }));
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
                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ synced, moments: stripped }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    // GET /api/moments/:id — Get single moment (with thumbnail restored)
    if (pathname.startsWith('/api/moments/') && req.method === 'GET' &&
        !pathname.includes('/clip') && !pathname.includes('/extract') && !pathname.includes('/status') && !pathname.includes('/sync') && !pathname.includes('/analyze') && !pathname.includes('/thumb')) {
        const momentId = pathname.slice('/api/moments/'.length);
        if (!isValidMomentId(momentId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid moment id' }));
            return;
        }
        const found = momentsDb.find(m => m.id === momentId);
        if (!found) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Moment not found' }));
            return;
        }
        // Return copy with thumbnail restored
        const copy = Object.assign({}, found);
        restoreThumbnail(copy);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(copy));
        return;
    }

    // DELETE /api/moments/:id — Delete a moment
    if (pathname.startsWith('/api/moments/') && req.method === 'DELETE' &&
        !pathname.includes('/clip')) {
        const momentId = pathname.slice('/api/moments/'.length);
        if (!isValidMomentId(momentId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid moment id' }));
            return;
        }
        const idx = momentsDb.findIndex(m => m.id === momentId);
        if (idx === -1) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Moment not found' }));
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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true, deleted: momentId }));
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
                    res.writeHead(500, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'ffmpeg not available' }));
                    return;
                }
                if (!momentId || !sourceUrl) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Missing momentId or sourceUrl' }));
                    return;
                }
                // Reject momentIds with path separators
                if (momentId.includes('/') || momentId.includes('\\') || momentId.includes('..')) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid momentId' }));
                    return;
                }
                const startF = parseFloat(start);
                const endF = parseFloat(end);
                if (!isFinite(startF) || !isFinite(endF) || startF < 0 || startF >= endF) {
                    res.writeHead(400, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ error: 'Invalid time range' }));
                    return;
                }

                // Idempotency: check for existing queued/active job for this momentId
                const existingJobId = Object.keys(extractJobs).find(
                    id => extractJobs[id].momentId === momentId &&
                          (extractJobs[id].status === 'queued' || extractJobs[id].status === 'extracting')
                );
                if (existingJobId) {
                    res.writeHead(200, { 'Content-Type': 'application/json' });
                    res.end(JSON.stringify({ jobId: existingJobId, status: extractJobs[existingJobId].status, deduplicated: true }));
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

                res.writeHead(200, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ jobId, status: 'queued', momentId }));
            } catch (e) {
                res.writeHead(400, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Invalid JSON' }));
            }
        });
        return;
    }

    if (pathname === '/api/moments/status' && req.method === 'GET') {
        const momentId = new URL(req.url, `http://${req.headers.host}`).searchParams.get('momentId');
        if (!momentId) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Missing momentId' }));
            return;
        }

        // Check in-memory jobs first
        const jobId = Object.keys(extractJobs).find(id => extractJobs[id].momentId === momentId);
        if (jobId) {
            const job = extractJobs[jobId];
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: job.status, progress: job.progress, jobId,
                extractedUrl: job.status === 'complete' ? `/api/moments/${momentId}/clip.mp4` : null,
                error: job.error || null
            }));
            return;
        }

        // Check disk (server may have restarted after successful extraction)
        const filePath = path.join(MOMENTS_DIR, `${momentId}.mp4`);
        if (fs.existsSync(filePath)) {
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                status: 'complete', progress: 100,
                extractedUrl: `/api/moments/${momentId}/clip.mp4`
            }));
            return;
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'none' }));
        return;
    }

    if (pathname.startsWith('/api/moments/') && pathname.endsWith('/clip.mp4') && req.method === 'GET') {
        const momentId = pathname.slice('/api/moments/'.length, -'/clip.mp4'.length);
        const clipPath = path.join(MOMENTS_DIR, `${momentId}.mp4`);

        // Directory traversal guard
        if (!clipPath.startsWith(MOMENTS_DIR)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden' }));
            return;
        }

        if (!fs.existsSync(clipPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Clip not yet extracted' }));
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
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid moment ID' }));
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

        // 2) No cached thumb — extract from clip via ffmpeg
        const clipPath = path.join(MOMENTS_DIR, `${momentId}.mp4`);
        if (!clipPath.startsWith(MOMENTS_DIR) || !fs.existsSync(clipPath)) {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No clip or thumbnail for moment' }));
            return;
        }

        const ffmpeg = spawn('ffmpeg', [
            '-i', clipPath,
            '-vframes', '1',
            '-ss', '0.5',
            '-vf', 'scale=320:180:force_original_aspect_ratio=decrease,pad=320:180:(ow-iw)/2:(oh-ih)/2',
            '-q:v', '4',
            '-y', thumbPath
        ]);
        ffmpeg.on('close', (code) => {
            if (code !== 0 || !fs.existsSync(thumbPath)) {
                res.writeHead(500, { 'Content-Type': 'application/json' });
                res.end(JSON.stringify({ error: 'Thumbnail generation failed' }));
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
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'ffmpeg not available' }));
        });
        return;
    }

    if (pathname.startsWith('/api/moments/') && pathname.endsWith('/clip') && req.method === 'DELETE') {
        const momentId = pathname.slice('/api/moments/'.length, -'/clip'.length);

        // Directory traversal guard
        const clipCheck = path.join(MOMENTS_DIR, `${momentId}.mp4`);
        if (!clipCheck.startsWith(MOMENTS_DIR)) {
            res.writeHead(403, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Forbidden' }));
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

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
        return;
    }

    // === AI Analysis API (Skier) ===

    // GET /api/ai/status — Check availability of AI backends
    if (pathname === '/api/ai/status' && req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
            available: skierAvailable,
            servers: skierServers.map(s => ({
                category: s.category, model: s.model,
                port: s.port, tags: s.tagCount, available: s.available
            }))
        }));
        return;
    }

    // POST /api/moments/:id/analyze — Analyze single moment with Skier
    const analyzeMatch = pathname.match(/^\/api\/moments\/([^/]+)\/analyze$/);
    if (analyzeMatch && req.method === 'POST') {
        const momentId = decodeURIComponent(analyzeMatch[1]);

        if (!isValidMomentId(momentId)) {
            res.writeHead(400, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Invalid moment id' }));
            return;
        }

        if (!skierAvailable) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Skier not available (http://localhost:8000)' }));
            return;
        }

        const thumbPath = path.join(MOMENTS_THUMBS, momentId + '.jpg');
        try {
            await fs.promises.access(thumbPath);
        } catch {
            res.writeHead(404, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'No thumbnail found for moment ' + momentId }));
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

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                momentId, tags: aiTags, confidences,
                providers: categories.length > 0 ? categories : ['skier']
            }));

            console.log('[Server] AI analysis complete for', momentId,
                '- models:', categories.join('+'),
                '- tags:', aiTags.join(', '));

        } catch (err) {
            console.error('[Server] AI analysis failed:', err.message);
            res.writeHead(500, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'AI analysis failed: ' + err.message }));
        }
        return;
    }

    // POST /api/moments/analyze-batch — Analyze all untagged moments
    if (pathname === '/api/moments/analyze-batch' && req.method === 'POST') {
        if (!skierAvailable) {
            res.writeHead(503, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ error: 'Skier not available (http://localhost:8000)' }));
            return;
        }

        const untagged = momentsDb.filter(m =>
            (!m.aiTags || m.aiTags.length === 0) && m.thumbnailPath
        );

        // Respond immediately with count, process in background
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ queued: untagged.length, total: momentsDb.length }));

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
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(batchProgress));
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
