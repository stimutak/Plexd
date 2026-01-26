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

// Ensure uploads and HLS directories exist
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
}
if (!fs.existsSync(HLS_DIR)) {
    fs.mkdirSync(HLS_DIR, { recursive: true });
}

// Track active transcoding jobs: { fileId: { progress, status, process } }
const transcodingJobs = {};

// Transcoding queue - limit concurrent jobs to avoid CPU overload
const transcodeQueue = [];
const activeTranscodes = new Set();
const MAX_CONCURRENT_TRANSCODES = 4; // M4 Max can handle more with hardware encoding

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

// Find existing HLS by original filename and size
function findExistingHLS(fileName, size) {
    for (const [fileId, meta] of Object.entries(fileMetadata)) {
        if (meta.originalFileName === fileName && meta.originalSize === size && meta.hlsReady) {
            return { fileId, meta };
        }
    }
    return null;
}

// Queue a file for HLS transcoding
function startHLSTranscode(fileId) {
    if (!ffmpegAvailable) return;

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

    const encoder = useSoftwareEncoder ? 'libx264' : 'h264_videotoolbox';
    console.log(`[Server] Starting HLS transcode (${encoder}): ${meta.fileName} (${activeTranscodes.size}/${MAX_CONCURRENT_TRANSCODES} active)`);

    // ffmpeg command - try hardware first, fall back to software
    const ffmpegArgs = useSoftwareEncoder ? [
        '-i', inputPath,
        '-c:v', 'libx264',
        '-preset', 'fast',
        '-crf', '23',
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
        '-c:v', 'h264_videotoolbox',  // Hardware encoder on Apple Silicon
        '-b:v', '5M',                  // Target bitrate (hardware encoder needs this vs CRF)
        '-c:a', 'aac',
        '-b:a', '128k',
        '-ac', '2',
        '-f', 'hls',
        '-hls_time', '4',
        '-hls_list_size', '0',
        '-hls_segment_filename', path.join(hlsDir, 'segment_%03d.ts'),
        outputPath
    ];

    const ffmpeg = spawn('ffmpeg', ffmpegArgs);
    transcodingJobs[fileId].process = ffmpeg;

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
            transcodingJobs[fileId].progress = Math.round((current / duration) * 100);
        }
    });

    ffmpeg.on('close', (code) => {
        activeTranscodes.delete(fileId);

        if (code === 0) {
            console.log(`[Server] HLS transcode complete: ${meta.fileName}`);

            // Update metadata
            fileMetadata[fileId].hlsReady = true;
            fileMetadata[fileId].hlsPath = `/api/hls/${fileId}/playlist.m3u8`;
            fileMetadata[fileId].originalFileName = meta.fileName;
            fileMetadata[fileId].originalSize = meta.size;
            saveMetadata();

            // Keep original - user can delete manually via HLS manager
            transcodingJobs[fileId] = { status: 'complete', progress: 100 };
        } else {
            // Check if hardware encoder failed - retry with software
            if (!useSoftwareEncoder && (
                stderrOutput.includes('videotoolbox') ||
                stderrOutput.includes('Encoder not found') ||
                stderrOutput.includes('Unknown encoder')
            )) {
                console.log(`[Server] Hardware encoder failed, retrying with libx264: ${meta.fileName}`);
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

// Auto-start pending transcodes after server is ready
setTimeout(queuePendingTranscodes, 2000);

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

const server = http.createServer((req, res) => {
    // Enable CORS for all requests
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

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

    // Delete a specific HLS transcode (keeps original if exists)
    if (pathname.startsWith('/api/hls/delete/') && req.method === 'DELETE') {
        const fileId = pathname.replace('/api/hls/delete/', '');
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
        const fileId = pathname.replace('/api/hls/delete-original/', '');
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
        const fileId = pathname.replace('/api/hls/transcode/', '');
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

    // ========================================
    // File Upload/Serving API
    // ========================================

    // Upload a file
    if (pathname === '/api/files/upload' && req.method === 'POST') {
        const contentType = req.headers['content-type'] || '';
        const fileName = decodeURIComponent(req.headers['x-file-name'] || 'unknown');
        const setName = req.headers['x-set-name'] ? decodeURIComponent(req.headers['x-set-name']) : null;
        const fileSize = parseInt(req.headers['content-length'] || '0', 10);

        // Check if we already have an HLS version of this file
        const existing = findExistingHLS(fileName, fileSize);
        if (existing) {
            console.log(`[Server] HLS exists for: ${fileName} -> returning existing`);
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                fileId: existing.fileId,
                url: existing.meta.hlsPath,
                hlsUrl: existing.meta.hlsPath,
                fileName: existing.meta.fileName,
                size: existing.meta.originalSize,
                hlsReady: true,
                existing: true
            }));
            // Drain the request body
            req.resume();
            return;
        }

        // Generate unique file ID
        const fileId = crypto.randomBytes(16).toString('hex');
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
        const fileId = parts[0];
        const hlsFile = parts.slice(1).join('/');

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
    if (pathname === '/api/files/list' && req.method === 'GET') {
        const files = Object.keys(fileMetadata).map(fileId => {
            const meta = fileMetadata[fileId];
            const transcodeJob = transcodingJobs[fileId];
            return {
                fileId,
                url: meta.hlsReady ? meta.hlsPath : `/api/files/${fileId}`,
                hlsUrl: meta.hlsReady ? meta.hlsPath : null,
                hlsReady: meta.hlsReady || false,
                transcoding: transcodeJob?.status === 'transcoding',
                transcodeProgress: transcodeJob?.progress || (meta.hlsReady ? 100 : 0),
                ...meta
            };
        });
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(files));
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
        const fileId = pathname.replace('/api/files/', '');
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
        const range = req.headers.range;

        // Support range requests for video seeking
        if (range) {
            const parts = range.replace(/bytes=/, '').split('-');
            const start = parseInt(parts[0], 10);
            const end = parts[1] ? parseInt(parts[1], 10) : stat.size - 1;
            const chunkSize = end - start + 1;

            res.writeHead(206, {
                'Content-Range': `bytes ${start}-${end}/${stat.size}`,
                'Accept-Ranges': 'bytes',
                'Content-Length': chunkSize,
                'Content-Type': meta.contentType
            });

            fs.createReadStream(filePath, { start, end }).pipe(res);
        } else {
            res.writeHead(200, {
                'Content-Length': stat.size,
                'Content-Type': meta.contentType,
                'Accept-Ranges': 'bytes'
            });
            fs.createReadStream(filePath).pipe(res);
        }
        return;
    }

    // Delete a specific file
    if (pathname.startsWith('/api/files/') && req.method === 'DELETE') {
        const fileId = pathname.replace('/api/files/', '');
        const meta = fileMetadata[fileId];

        if (meta) {
            deleteFileAndHLS(fileId);
            delete fileMetadata[fileId];
            saveMetadata();
            console.log(`[Server] Deleted: ${meta.fileName}`);
        }

        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ success: true }));
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
