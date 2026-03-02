#!/bin/bash
#
# Plexd Server Startup Script
#
# Ensures a clean single-instance server start. Kills any existing server
# processes, waits for the port to be free, starts the server, and verifies
# it's responding. The server auto-starts Skier AI servers on boot.
#
# Usage: ./scripts/start-server.sh
#

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
PORT=8080
LOG="/tmp/plexd-server.log"

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

# 1. Kill ALL existing processes on port 8080
pids=$(lsof -ti:$PORT 2>/dev/null)
if [ -n "$pids" ]; then
    echo -e "${YELLOW}Killing existing processes on port $PORT: $pids${NC}"
    echo "$pids" | xargs kill 2>/dev/null
    # Wait for port to actually be free (up to 5s)
    for i in $(seq 1 10); do
        if ! lsof -ti:$PORT >/dev/null 2>&1; then
            break
        fi
        if [ "$i" -eq 5 ]; then
            echo -e "${YELLOW}Force-killing stubborn processes...${NC}"
            lsof -ti:$PORT 2>/dev/null | xargs kill -9 2>/dev/null
        fi
        sleep 0.5
    done
    if lsof -ti:$PORT >/dev/null 2>&1; then
        echo -e "${RED}Failed to free port $PORT${NC}"
        exit 1
    fi
    echo -e "${GREEN}Port $PORT is free${NC}"
fi

# 2. Start server with --watch for auto-reload on code changes
# Without --watch, editing server.js while the server runs causes stale code
# bugs (e.g., moment browser videos fail because the running process doesn't
# have the latest route handlers). --watch restarts automatically on file change.
cd "$PROJECT_DIR"
node --watch server.js > "$LOG" 2>&1 &
SERVER_PID=$!
echo "Starting server (PID: $SERVER_PID)..."

# 3. Wait for server to respond (up to 15s)
for i in $(seq 1 30); do
    if curl -sf http://localhost:$PORT/api/remote/state >/dev/null 2>&1; then
        # Verify exactly one listener
        listeners=$(lsof -ti:$PORT 2>/dev/null | wc -l | tr -d ' ')
        echo -e "${GREEN}Server running on port $PORT (PID: $SERVER_PID)${NC}"

        # 4. Check AI servers
        ai_status=$(curl -sf http://localhost:$PORT/api/ai/status 2>/dev/null)
        if [ -n "$ai_status" ]; then
            ai_count=$(echo "$ai_status" | python3 -c "import sys,json; d=json.load(sys.stdin); print(sum(1 for s in d.get('servers',[]) if s.get('available')))" 2>/dev/null)
            echo -e "${GREEN}Skier AI: ${ai_count:-0} model(s) available${NC}"
        fi

        echo -e "${GREEN}Log: $LOG${NC}"
        exit 0
    fi
    # Check if process died
    if ! kill -0 $SERVER_PID 2>/dev/null; then
        echo -e "${RED}Server process died. Log:${NC}"
        tail -20 "$LOG"
        exit 1
    fi
    sleep 0.5
done

echo -e "${RED}Server failed to respond within 15s. Log:${NC}"
tail -20 "$LOG"
exit 1
