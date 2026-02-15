---
name: verify-app
description: "End-to-end verification of the Plexd app. Use after making changes to verify everything works. Runs syntax checks, server verification, and provides browser testing guidance."
allowed-tools: "Read,Bash,Grep,Glob"
---

# Verify Plexd Application

End-to-end verification skill that ensures the app works correctly after changes.

## Verification Steps

### Step 1: Syntax Check (Run All)

```bash
# Check all JavaScript files for syntax errors
node --check server.js
node --check web/js/app.js
node --check web/js/stream.js
node --check web/js/grid.js
node --check web/js/remote.js
```

Report any syntax errors found.

### Step 2: Server Health Check

If the server is running, test endpoints:

```bash
# Test server is responding
curl -s http://localhost:8080/api/health || echo "Server not running"

# Test files endpoint
curl -s http://localhost:8080/api/files | head -c 500
```

If server is not running, note it but continue with other checks.

### Step 3: Static Analysis

Search for common issues:

1. **Undefined variables**: Search for common undefined reference patterns
2. **Missing cleanup**: Look for event listeners without removal
3. **Console.log statements**: Find debugging statements that should be removed
4. **Resource leaks**: Check for intervals/timeouts without cleanup

### Step 4: CLAUDE.md Compliance

Verify changes follow project rules:

- No duplicate functions (search codebase before creating)
- No "v2" implementations (fix existing code instead)
- Vanilla JS only (no framework imports)
- Grid layout optimizations preserved

### Step 5: Browser Testing Guidance

Provide manual testing checklist:

```
[ ] Load app in browser (http://localhost:8080)
[ ] Add 2-4 video streams
[ ] Verify grid layout adapts
[ ] Test stream removal (resources cleaned?)
[ ] Check for console errors
[ ] Test audio mute/unmute
[ ] Verify responsive behavior (resize window)
```

## Output Format

```markdown
## Verification Results

### Syntax Checks
- server.js: PASS/FAIL
- web/js/app.js: PASS/FAIL
- web/js/stream.js: PASS/FAIL
- web/js/grid.js: PASS/FAIL

### Server Status
- Status: Running/Not Running
- Endpoints: OK/Error

### Static Analysis
- Issues found: X
- Details: [list]

### CLAUDE.md Compliance
- Violations: X
- Details: [list]

### Manual Testing Checklist
[Provide checklist above]

## Overall Status
[ ] VERIFIED - All automated checks pass
[ ] ISSUES FOUND - See details above
[ ] NEEDS MANUAL TESTING - Automated checks pass, manual verification needed
```
