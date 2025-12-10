#!/usr/bin/env node
/**
 * Plexd Server with Remote Control Relay
 *
 * Simple HTTP server that serves static files AND relays remote control
 * commands between devices (iPhone to MBP, etc.)
 *
 * Usage: node server.js [port]
 * Default port: 8080
 */

const http = require('http');
const fs = require('fs');
const path = require('path');

const PORT = process.argv[2] || 8080;
const WEB_ROOT = path.join(__dirname, 'web');

// In-memory state for remote control relay
let currentState = { streams: [], timestamp: 0 };
let pendingCommands = [];

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
