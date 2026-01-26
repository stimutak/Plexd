#!/bin/bash
#
# Plexd MBP Autostart Script
#
# This script:
# 1. Kills existing Chrome and Plexd server processes
# 2. Starts the Plexd server
# 3. Launches Chrome with remote debugging enabled
# 4. Opens Plexd with the last saved set auto-loaded
# 5. Optionally runs test/reporter (puppeteer or claude observation)
#
# Usage: ./autostart.sh [options]
#   --port PORT       Server port (default: 8080)
#   --debug-port PORT Chrome debugging port (default: 9222)
#   --test-mode MODE  Test mode: puppeteer, claude, or none (default: puppeteer)
#   --report FILE     Write test report to file (puppeteer mode only)
#   --last-fix DESC   Description of last fix to test for
#   --watch           Keep monitoring after initial test (puppeteer mode)
#
# Test Modes:
#   puppeteer - Run automated chrome-test.js script (requires npm install)
#   claude    - Launch for Claude Code browser observation (no automated test)
#   none      - Just start server and Chrome, no testing
#

set -e

# Configuration
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PORT="${PLEXD_PORT:-8080}"
DEBUG_PORT="${PLEXD_DEBUG_PORT:-9222}"
TEST_MODE="puppeteer"
REPORT_FILE=""
LAST_FIX=""
WATCH_MODE=false

# Parse arguments
while [[ $# -gt 0 ]]; do
    case $1 in
        --port)
            PORT="$2"
            shift 2
            ;;
        --debug-port)
            DEBUG_PORT="$2"
            shift 2
            ;;
        --test-mode)
            TEST_MODE="$2"
            shift 2
            ;;
        --no-test)
            TEST_MODE="none"
            shift
            ;;
        --report)
            REPORT_FILE="$2"
            shift 2
            ;;
        --last-fix)
            LAST_FIX="$2"
            shift 2
            ;;
        --watch)
            WATCH_MODE=true
            shift
            ;;
        -h|--help)
            head -27 "$0" | tail -25
            exit 0
            ;;
        *)
            echo "Unknown option: $1"
            echo "Use --help for usage"
            exit 1
            ;;
    esac
done

# Validate test mode
if [[ ! "$TEST_MODE" =~ ^(puppeteer|claude|none)$ ]]; then
    echo "Invalid test mode: $TEST_MODE"
    echo "Valid modes: puppeteer, claude, none"
    exit 1
fi

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

log() {
    echo -e "${BLUE}[Plexd]${NC} $1"
}

success() {
    echo -e "${GREEN}[Plexd]${NC} $1"
}

warn() {
    echo -e "${YELLOW}[Plexd]${NC} $1"
}

error() {
    echo -e "${RED}[Plexd]${NC} $1"
}

# Detect OS
detect_os() {
    case "$(uname -s)" in
        Darwin*)
            OS="macos"
            CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
            ;;
        Linux*)
            OS="linux"
            CHROME_PATH="$(which google-chrome 2>/dev/null || which chromium-browser 2>/dev/null || echo '/usr/bin/google-chrome')"
            ;;
        *)
            error "Unsupported OS: $(uname -s)"
            exit 1
            ;;
    esac
    log "Detected OS: $OS"
}

# Kill existing processes
cleanup() {
    log "Cleaning up existing processes..."

    # Kill existing Plexd server
    if pgrep -f "node.*server.js" > /dev/null 2>&1; then
        warn "Killing existing Plexd server..."
        pkill -f "node.*server.js" || true
        sleep 1
    fi

    # Kill Chrome instances with our debug port (macOS and Linux differ)
    if [ "$OS" = "macos" ]; then
        # On macOS, check for Chrome with our debugging port
        if lsof -i ":$DEBUG_PORT" > /dev/null 2>&1; then
            warn "Killing Chrome on debug port $DEBUG_PORT..."
            lsof -ti ":$DEBUG_PORT" | xargs kill -9 2>/dev/null || true
            sleep 1
        fi
    else
        # On Linux, kill chrome with debug port
        if pgrep -f "chrome.*remote-debugging-port=$DEBUG_PORT" > /dev/null 2>&1; then
            warn "Killing Chrome with debug port $DEBUG_PORT..."
            pkill -f "chrome.*remote-debugging-port=$DEBUG_PORT" || true
            sleep 1
        fi
    fi

    success "Cleanup complete"
}

# Start the Plexd server
start_server() {
    log "Starting Plexd server on port $PORT..."

    cd "$PROJECT_DIR"

    # Start server in background
    node server.js "$PORT" > /tmp/plexd-server.log 2>&1 &
    SERVER_PID=$!

    # Wait for server to be ready
    local retries=0
    local max_retries=30
    while ! curl -s "http://localhost:$PORT/" > /dev/null 2>&1; do
        retries=$((retries + 1))
        if [ $retries -ge $max_retries ]; then
            error "Server failed to start. Check /tmp/plexd-server.log"
            cat /tmp/plexd-server.log
            exit 1
        fi
        sleep 0.5
    done

    success "Server started (PID: $SERVER_PID)"
}

# Launch Chrome with remote debugging
launch_chrome() {
    log "Launching Chrome with remote debugging on port $DEBUG_PORT..."

    local url="http://localhost:$PORT/?autoload=last"
    local user_data_dir="/tmp/plexd-chrome-profile"

    # Create a clean profile directory
    rm -rf "$user_data_dir"
    mkdir -p "$user_data_dir"

    # Launch Chrome
    if [ "$OS" = "macos" ]; then
        "$CHROME_PATH" \
            --remote-debugging-port="$DEBUG_PORT" \
            --user-data-dir="$user_data_dir" \
            --no-first-run \
            --disable-default-apps \
            --disable-popup-blocking \
            --start-maximized \
            "$url" &
    else
        "$CHROME_PATH" \
            --remote-debugging-port="$DEBUG_PORT" \
            --user-data-dir="$user_data_dir" \
            --no-first-run \
            --disable-default-apps \
            --disable-popup-blocking \
            --start-maximized \
            "$url" &
    fi

    CHROME_PID=$!

    # Wait for Chrome to be ready
    local retries=0
    local max_retries=30
    while ! curl -s "http://localhost:$DEBUG_PORT/json/version" > /dev/null 2>&1; do
        retries=$((retries + 1))
        if [ $retries -ge $max_retries ]; then
            error "Chrome failed to start with remote debugging"
            exit 1
        fi
        sleep 0.5
    done

    success "Chrome launched (PID: $CHROME_PID)"
}

# Run the test/reporter based on mode
run_test() {
    case "$TEST_MODE" in
        none)
            log "Test mode: none (skipping tests)"
            ;;
        claude)
            run_claude_mode
            ;;
        puppeteer)
            run_puppeteer_test
            ;;
    esac
}

# Claude mode - just provide info for Claude Code observation
run_claude_mode() {
    log "Test mode: claude (browser observation)"
    success ""
    success "Ready for Claude Code browser observation!"
    success ""
    success "Claude can now use browser tools to:"
    success "  - Check console for errors: look for red messages"
    success "  - Verify autoload: window.plexdAutoloadResult"
    success "  - Check streams: PlexdStream.getAllStreams()"
    success "  - Monitor memory: performance.memory"
    success ""
    if [ -n "$LAST_FIX" ]; then
        success "Last fix to verify: \"$LAST_FIX\""
        success ""
    fi
    success "Useful console commands for Claude to run:"
    success "  window.plexdAutoloadResult"
    success "  PlexdStream.getAllStreams().map(s => ({id: s.id, playing: !s.video?.paused, error: s.video?.error}))"
    success "  console.log([...document.querySelectorAll('.plexd-stream')].length + ' streams loaded')"
    success ""
}

# Puppeteer mode - run automated test script
run_puppeteer_test() {
    log "Test mode: puppeteer (automated testing)"

    cd "$PROJECT_DIR"

    # Check if node_modules exists
    if [ ! -d "node_modules" ]; then
        warn "Installing dependencies (first run)..."
        npm install
    fi

    # Build test args
    local test_args="--debug-port=$DEBUG_PORT"
    if [ -n "$REPORT_FILE" ]; then
        test_args="$test_args --report=$REPORT_FILE"
    fi
    if [ -n "$LAST_FIX" ]; then
        test_args="$test_args --last-fix=\"$LAST_FIX\""
    fi
    if [ "$WATCH_MODE" = true ]; then
        test_args="$test_args --watch"
    fi

    # Run the test script
    log "Running chrome-test.js..."
    node scripts/chrome-test.js $test_args
}

# Trap to cleanup on exit
trap_cleanup() {
    warn "Shutting down..."
    if [ -n "$SERVER_PID" ]; then
        kill $SERVER_PID 2>/dev/null || true
    fi
    if [ -n "$CHROME_PID" ]; then
        kill $CHROME_PID 2>/dev/null || true
    fi
}

# Main execution
main() {
    log "========================================"
    log "Plexd MBP Autostart Script"
    log "========================================"
    log ""
    log "Configuration:"
    log "  Server port:    $PORT"
    log "  Debug port:     $DEBUG_PORT"
    log "  Test mode:      $TEST_MODE"
    [ -n "$REPORT_FILE" ] && log "  Report file:    $REPORT_FILE"
    [ -n "$LAST_FIX" ] && log "  Last fix:       $LAST_FIX"
    [ "$WATCH_MODE" = true ] && log "  Watch mode:     enabled"
    log ""

    detect_os
    cleanup
    start_server
    launch_chrome
    run_test

    success "========================================"
    success "Plexd is running!"
    success "========================================"
    success ""
    success "Server:  http://localhost:$PORT/"
    success "Debug:   http://localhost:$DEBUG_PORT/"
    success ""
    success "Press Ctrl+C to stop"

    # Keep running (wait for server)
    trap trap_cleanup EXIT INT TERM
    wait $SERVER_PID
}

main "$@"
