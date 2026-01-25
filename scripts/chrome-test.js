#!/usr/bin/env node
/**
 * Plexd Chrome Test & Reporter Script
 *
 * Connects to Chrome via DevTools Protocol to:
 * 1. Monitor console output (logs, warnings, errors)
 * 2. Track autoload status and stream loading
 * 3. Detect JavaScript errors and exceptions
 * 4. Test for specific fixes (if --last-fix provided)
 * 5. Generate detailed report for Claude Code
 *
 * Usage: node chrome-test.js [options]
 *   --debug-port PORT    Chrome debugging port (default: 9222)
 *   --timeout SECONDS    Test timeout in seconds (default: 30)
 *   --report FILE        Write report to file (default: stdout)
 *   --last-fix "DESC"    Description of last fix to verify
 *   --json               Output report as JSON
 *   --watch              Keep watching indefinitely (for monitoring)
 */

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

// Parse command line arguments
const args = process.argv.slice(2);
const config = {
    debugPort: 9222,
    timeout: 30,
    reportFile: null,
    lastFix: null,
    json: false,
    watch: false
};

for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg.startsWith('--debug-port=')) {
        config.debugPort = parseInt(arg.split('=')[1]);
    } else if (arg === '--debug-port') {
        config.debugPort = parseInt(args[++i]);
    } else if (arg.startsWith('--timeout=')) {
        config.timeout = parseInt(arg.split('=')[1]);
    } else if (arg === '--timeout') {
        config.timeout = parseInt(args[++i]);
    } else if (arg.startsWith('--report=')) {
        config.reportFile = arg.split('=')[1];
    } else if (arg === '--report') {
        config.reportFile = args[++i];
    } else if (arg.startsWith('--last-fix=')) {
        config.lastFix = arg.split('=')[1];
    } else if (arg === '--last-fix') {
        config.lastFix = args[++i];
    } else if (arg === '--json') {
        config.json = true;
    } else if (arg === '--watch') {
        config.watch = true;
    }
}

// Report data structure
const report = {
    timestamp: new Date().toISOString(),
    config: { ...config },
    connection: {
        success: false,
        chromeVersion: null,
        url: null
    },
    autoload: {
        success: false,
        setName: null,
        streamCount: 0,
        error: null
    },
    console: {
        logs: [],
        warnings: [],
        errors: []
    },
    exceptions: [],
    streams: {
        total: 0,
        playing: 0,
        errored: 0,
        details: []
    },
    performance: {
        loadTime: null,
        memoryUsage: null
    },
    lastFixVerification: {
        tested: false,
        description: config.lastFix,
        passed: null,
        details: null
    },
    summary: {
        success: false,
        issues: [],
        recommendations: []
    }
};

// Logging
function log(msg) {
    if (!config.json) {
        console.log(`[Test] ${msg}`);
    }
}

function logError(msg) {
    if (!config.json) {
        console.error(`[Test] ERROR: ${msg}`);
    }
}

// Connect to Chrome
async function connectToChrome() {
    log(`Connecting to Chrome on port ${config.debugPort}...`);

    try {
        const browser = await puppeteer.connect({
            browserURL: `http://localhost:${config.debugPort}`,
            defaultViewport: null
        });

        const version = await browser.version();
        report.connection.chromeVersion = version;
        report.connection.success = true;
        log(`Connected to ${version}`);

        return browser;
    } catch (err) {
        report.connection.success = false;
        report.summary.issues.push(`Failed to connect to Chrome: ${err.message}`);
        throw err;
    }
}

// Get the Plexd page
async function getPlexdPage(browser) {
    const pages = await browser.pages();
    const plexdPage = pages.find(p => p.url().includes('localhost') && p.url().includes('autoload'));

    if (!plexdPage) {
        // Try to find any localhost page
        const localPage = pages.find(p => p.url().includes('localhost'));
        if (localPage) {
            report.connection.url = localPage.url();
            return localPage;
        }
        throw new Error('No Plexd page found');
    }

    report.connection.url = plexdPage.url();
    log(`Found Plexd page: ${plexdPage.url()}`);
    return plexdPage;
}

// Set up console monitoring
function setupConsoleMonitoring(page) {
    page.on('console', msg => {
        const entry = {
            type: msg.type(),
            text: msg.text(),
            timestamp: new Date().toISOString(),
            location: msg.location()
        };

        if (msg.type() === 'error') {
            report.console.errors.push(entry);
        } else if (msg.type() === 'warning') {
            report.console.warnings.push(entry);
        } else {
            report.console.logs.push(entry);
        }
    });

    page.on('pageerror', err => {
        report.exceptions.push({
            message: err.message,
            stack: err.stack,
            timestamp: new Date().toISOString()
        });
        logError(`Page exception: ${err.message}`);
    });

    page.on('requestfailed', request => {
        report.console.errors.push({
            type: 'network',
            text: `Request failed: ${request.url()} - ${request.failure()?.errorText}`,
            timestamp: new Date().toISOString(),
            url: request.url()
        });
    });
}

// Wait for autoload to complete
async function waitForAutoload(page) {
    log('Waiting for autoload to complete...');

    const startTime = Date.now();
    const timeout = config.timeout * 1000;

    while (Date.now() - startTime < timeout) {
        const result = await page.evaluate(() => {
            return window.plexdAutoloadResult;
        });

        if (result && !result.loading) {
            report.autoload = {
                success: result.success,
                setName: result.setName,
                streamCount: result.streamCount || 0,
                error: result.error || null
            };
            report.performance.loadTime = Date.now() - startTime;

            if (result.success) {
                log(`Autoload successful: "${result.setName}" with ${result.streamCount} streams`);
            } else {
                logError(`Autoload failed: ${result.error}`);
                report.summary.issues.push(`Autoload failed: ${result.error}`);
            }
            return;
        }

        await new Promise(r => setTimeout(r, 500));
    }

    report.summary.issues.push('Autoload timed out');
    logError('Autoload timed out');
}

// Get stream status
async function getStreamStatus(page) {
    log('Checking stream status...');

    const streamData = await page.evaluate(() => {
        if (!window.PlexdStream) {
            return { error: 'PlexdStream not available' };
        }

        const streams = PlexdStream.getAllStreams();
        return {
            total: streams.length,
            streams: streams.map(s => ({
                id: s.id,
                url: s.url?.substring(0, 100),
                fileName: s.fileName,
                isPlaying: s.video && !s.video.paused,
                isMuted: s.video?.muted,
                hasError: s.video?.error !== null,
                errorCode: s.video?.error?.code,
                errorMessage: s.video?.error?.message,
                readyState: s.video?.readyState,
                currentTime: s.video?.currentTime,
                duration: s.video?.duration,
                buffered: s.video?.buffered?.length > 0
            }))
        };
    });

    if (streamData.error) {
        report.summary.issues.push(streamData.error);
        return;
    }

    report.streams.total = streamData.total;
    report.streams.playing = streamData.streams.filter(s => s.isPlaying).length;
    report.streams.errored = streamData.streams.filter(s => s.hasError).length;
    report.streams.details = streamData.streams;

    if (report.streams.errored > 0) {
        const erroredStreams = streamData.streams.filter(s => s.hasError);
        erroredStreams.forEach(s => {
            report.summary.issues.push(
                `Stream error: ${s.fileName || s.url} - Code ${s.errorCode}: ${s.errorMessage || 'Unknown error'}`
            );
        });
    }

    log(`Streams: ${report.streams.total} total, ${report.streams.playing} playing, ${report.streams.errored} errored`);
}

// Get memory usage
async function getMemoryUsage(page) {
    try {
        const metrics = await page.metrics();
        report.performance.memoryUsage = {
            jsHeapUsedSize: metrics.JSHeapUsedSize,
            jsHeapTotalSize: metrics.JSHeapTotalSize,
            formatted: `${Math.round(metrics.JSHeapUsedSize / 1024 / 1024)}MB / ${Math.round(metrics.JSHeapTotalSize / 1024 / 1024)}MB`
        };
        log(`Memory: ${report.performance.memoryUsage.formatted}`);
    } catch (err) {
        // Metrics might not be available
    }
}

// Verify last fix
async function verifyLastFix(page) {
    if (!config.lastFix) {
        return;
    }

    report.lastFixVerification.tested = true;
    log(`Testing last fix: "${config.lastFix}"`);

    // Generic checks based on common fix patterns
    const fixLower = config.lastFix.toLowerCase();

    // Check for specific fix patterns
    if (fixLower.includes('autoload') || fixLower.includes('auto-load')) {
        report.lastFixVerification.passed = report.autoload.success;
        report.lastFixVerification.details = report.autoload.success
            ? `Autoload working - loaded "${report.autoload.setName}"`
            : `Autoload failed: ${report.autoload.error}`;
    }
    else if (fixLower.includes('stream') && fixLower.includes('load')) {
        report.lastFixVerification.passed = report.streams.total > 0 && report.streams.errored === 0;
        report.lastFixVerification.details = `${report.streams.total} streams loaded, ${report.streams.errored} errors`;
    }
    else if (fixLower.includes('error') || fixLower.includes('crash') || fixLower.includes('exception')) {
        report.lastFixVerification.passed = report.exceptions.length === 0 && report.console.errors.length === 0;
        report.lastFixVerification.details = `${report.exceptions.length} exceptions, ${report.console.errors.length} console errors`;
    }
    else if (fixLower.includes('memory') || fixLower.includes('leak')) {
        const memMB = report.performance.memoryUsage?.jsHeapUsedSize / 1024 / 1024;
        report.lastFixVerification.passed = memMB < 500; // Reasonable threshold
        report.lastFixVerification.details = `Memory usage: ${Math.round(memMB)}MB`;
    }
    else if (fixLower.includes('play')) {
        report.lastFixVerification.passed = report.streams.playing > 0;
        report.lastFixVerification.details = `${report.streams.playing}/${report.streams.total} streams playing`;
    }
    else {
        // Generic check - no exceptions and autoload worked
        report.lastFixVerification.passed = report.autoload.success && report.exceptions.length === 0;
        report.lastFixVerification.details = 'Generic check: autoload success and no exceptions';
    }

    log(`Last fix verification: ${report.lastFixVerification.passed ? 'PASSED' : 'FAILED'}`);
    log(`  Details: ${report.lastFixVerification.details}`);
}

// Generate summary
function generateSummary() {
    // Determine overall success
    report.summary.success = (
        report.connection.success &&
        report.autoload.success &&
        report.exceptions.length === 0 &&
        report.streams.errored === 0
    );

    // Add recommendations
    if (report.console.errors.length > 0) {
        report.summary.recommendations.push(
            `Review ${report.console.errors.length} console error(s) in the logs`
        );
    }

    if (report.streams.total > 0 && report.streams.playing === 0) {
        report.summary.recommendations.push(
            'No streams are playing - check if video playback is blocked or requires user interaction'
        );
    }

    const memMB = report.performance.memoryUsage?.jsHeapUsedSize / 1024 / 1024;
    if (memMB > 300) {
        report.summary.recommendations.push(
            `Memory usage is high (${Math.round(memMB)}MB) - consider optimizing`
        );
    }

    if (report.lastFixVerification.tested && !report.lastFixVerification.passed) {
        report.summary.issues.push(`Last fix verification FAILED: ${report.lastFixVerification.details}`);
    }
}

// Output report
function outputReport() {
    if (config.json) {
        const output = JSON.stringify(report, null, 2);
        if (config.reportFile) {
            fs.writeFileSync(config.reportFile, output);
            console.log(`Report written to ${config.reportFile}`);
        } else {
            console.log(output);
        }
        return;
    }

    // Human-readable report
    const lines = [];
    lines.push('');
    lines.push('========================================');
    lines.push('PLEXD CHROME TEST REPORT');
    lines.push('========================================');
    lines.push(`Timestamp: ${report.timestamp}`);
    lines.push('');

    // Connection
    lines.push('--- Connection ---');
    lines.push(`Status: ${report.connection.success ? 'SUCCESS' : 'FAILED'}`);
    lines.push(`Chrome: ${report.connection.chromeVersion}`);
    lines.push(`URL: ${report.connection.url}`);
    lines.push('');

    // Autoload
    lines.push('--- Autoload ---');
    lines.push(`Status: ${report.autoload.success ? 'SUCCESS' : 'FAILED'}`);
    lines.push(`Set: ${report.autoload.setName || 'N/A'}`);
    lines.push(`Streams: ${report.autoload.streamCount}`);
    if (report.autoload.error) {
        lines.push(`Error: ${report.autoload.error}`);
    }
    lines.push(`Load time: ${report.performance.loadTime}ms`);
    lines.push('');

    // Streams
    lines.push('--- Streams ---');
    lines.push(`Total: ${report.streams.total}`);
    lines.push(`Playing: ${report.streams.playing}`);
    lines.push(`Errored: ${report.streams.errored}`);
    if (report.streams.details.length > 0) {
        lines.push('Details:');
        report.streams.details.forEach((s, i) => {
            const status = s.hasError ? 'ERROR' : (s.isPlaying ? 'PLAYING' : 'PAUSED');
            const name = s.fileName || s.url || 'Unknown';
            lines.push(`  ${i + 1}. [${status}] ${name}`);
            if (s.hasError) {
                lines.push(`      Error: Code ${s.errorCode} - ${s.errorMessage || 'Unknown'}`);
            }
        });
    }
    lines.push('');

    // Console
    lines.push('--- Console Output ---');
    lines.push(`Logs: ${report.console.logs.length}`);
    lines.push(`Warnings: ${report.console.warnings.length}`);
    lines.push(`Errors: ${report.console.errors.length}`);

    if (report.console.errors.length > 0) {
        lines.push('Errors:');
        report.console.errors.slice(0, 10).forEach(e => {
            lines.push(`  - ${e.text}`);
        });
        if (report.console.errors.length > 10) {
            lines.push(`  ... and ${report.console.errors.length - 10} more`);
        }
    }

    if (report.exceptions.length > 0) {
        lines.push('');
        lines.push('--- Exceptions ---');
        report.exceptions.forEach(e => {
            lines.push(`  - ${e.message}`);
            if (e.stack) {
                const stackLines = e.stack.split('\n').slice(0, 3);
                stackLines.forEach(sl => lines.push(`      ${sl}`));
            }
        });
    }
    lines.push('');

    // Performance
    lines.push('--- Performance ---');
    lines.push(`Load time: ${report.performance.loadTime}ms`);
    if (report.performance.memoryUsage) {
        lines.push(`Memory: ${report.performance.memoryUsage.formatted}`);
    }
    lines.push('');

    // Last Fix Verification
    if (report.lastFixVerification.tested) {
        lines.push('--- Last Fix Verification ---');
        lines.push(`Fix: "${report.lastFixVerification.description}"`);
        lines.push(`Result: ${report.lastFixVerification.passed ? 'PASSED' : 'FAILED'}`);
        lines.push(`Details: ${report.lastFixVerification.details}`);
        lines.push('');
    }

    // Summary
    lines.push('========================================');
    lines.push(`OVERALL: ${report.summary.success ? 'SUCCESS' : 'ISSUES FOUND'}`);
    lines.push('========================================');

    if (report.summary.issues.length > 0) {
        lines.push('');
        lines.push('Issues:');
        report.summary.issues.forEach(i => lines.push(`  - ${i}`));
    }

    if (report.summary.recommendations.length > 0) {
        lines.push('');
        lines.push('Recommendations:');
        report.summary.recommendations.forEach(r => lines.push(`  - ${r}`));
    }

    lines.push('');

    const output = lines.join('\n');
    if (config.reportFile) {
        fs.writeFileSync(config.reportFile, output);
        console.log(output);
        console.log(`Report written to ${config.reportFile}`);
    } else {
        console.log(output);
    }
}

// Watch mode - continuous monitoring
async function watchMode(page) {
    log('Entering watch mode (Ctrl+C to exit)...');

    let lastStreamCount = 0;
    let lastErrorCount = 0;

    const interval = setInterval(async () => {
        try {
            const status = await page.evaluate(() => {
                if (!window.PlexdStream) return null;
                const streams = PlexdStream.getAllStreams();
                return {
                    count: streams.length,
                    playing: streams.filter(s => s.video && !s.video.paused).length,
                    errored: streams.filter(s => s.video?.error).length
                };
            });

            if (status) {
                if (status.count !== lastStreamCount || status.errored !== lastErrorCount) {
                    log(`Streams: ${status.count} total, ${status.playing} playing, ${status.errored} errored`);
                    lastStreamCount = status.count;
                    lastErrorCount = status.errored;
                }
            }
        } catch (err) {
            // Page might be navigating
        }
    }, 5000);

    // Handle exit
    process.on('SIGINT', () => {
        clearInterval(interval);
        log('Watch mode ended');
        process.exit(0);
    });

    // Keep running
    await new Promise(() => {});
}

// Main execution
async function main() {
    log('Starting Plexd Chrome Test...');
    log(`Config: port=${config.debugPort}, timeout=${config.timeout}s`);

    let browser;
    try {
        browser = await connectToChrome();
        const page = await getPlexdPage(browser);

        setupConsoleMonitoring(page);

        // Give page a moment to settle
        await new Promise(r => setTimeout(r, 2000));

        await waitForAutoload(page);
        await getStreamStatus(page);
        await getMemoryUsage(page);
        await verifyLastFix(page);

        generateSummary();
        outputReport();

        if (config.watch) {
            await watchMode(page);
        }

        // Exit with appropriate code
        process.exit(report.summary.success ? 0 : 1);

    } catch (err) {
        report.summary.issues.push(`Test error: ${err.message}`);
        generateSummary();
        outputReport();
        process.exit(1);
    }
}

main();
