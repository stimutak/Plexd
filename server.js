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

const PORT = process.argv[2] || 8080;
const WEB_ROOT = path.join(__dirname, 'web');
const UPLOADS_DIR = path.join(__dirname, 'uploads');
const UPLOADS_META = path.join(UPLOADS_DIR, 'metadata.json');
const FILE_EXPIRY_MS = 24 * 60 * 60 * 1000; // 24 hours

// Ensure uploads directory exists
if (!fs.existsSync(UPLOADS_DIR)) {
    fs.mkdirSync(UPLOADS_DIR, { recursive: true });
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

// Cleanup expired files (not tied to a saved set) on startup and periodically
function cleanupExpiredFiles() {
    const now = Date.now();
    let cleaned = 0;
    Object.keys(fileMetadata).forEach(fileId => {
        const meta = fileMetadata[fileId];
        // Only auto-delete if not tied to a saved set and older than 24h
        if (!meta.setName && (now - meta.savedAt) > FILE_EXPIRY_MS) {
            const filePath = path.join(UPLOADS_DIR, fileId);
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                delete fileMetadata[fileId];
                cleaned++;
            } catch (e) { /* ignore */ }
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
    '.m3u8': 'application/vnd.apple.mpegurl'
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
    // File Upload/Serving API
    // ========================================

    // Upload a file
    if (pathname === '/api/files/upload' && req.method === 'POST') {
        const contentType = req.headers['content-type'] || '';
        const fileName = decodeURIComponent(req.headers['x-file-name'] || 'unknown');
        const setName = req.headers['x-set-name'] ? decodeURIComponent(req.headers['x-set-name']) : null;

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
                contentType: mimeType
            };
            saveMetadata();

            console.log(`[Server] Uploaded: ${fileName} (${(size / 1024 / 1024).toFixed(2)} MB) -> ${fileId}`);

            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({
                success: true,
                fileId,
                url: `/api/files/${fileId}`,
                fileName,
                size
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

    // List all uploaded files
    if (pathname === '/api/files/list' && req.method === 'GET') {
        const files = Object.keys(fileMetadata).map(fileId => ({
            fileId,
            url: `/api/files/${fileId}`,
            ...fileMetadata[fileId]
        }));
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
                    const filePath = path.join(UPLOADS_DIR, fileId);
                    try {
                        if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                        delete fileMetadata[fileId];
                        deleted++;
                    } catch (e) { /* ignore */ }
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
            const filePath = path.join(UPLOADS_DIR, fileId);
            try {
                if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                delete fileMetadata[fileId];
                saveMetadata();
                console.log(`[Server] Deleted: ${meta.fileName}`);
            } catch (e) { /* ignore */ }
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
