# Test and Commit Workflow

Run multi-agent verification, then commit if passing. Fix issues if failing.

## Phase 1: Parallel Verification (Launch 4 subagents)

Launch these subagents IN PARALLEL using the Task tool:

### Subagent 1: Syntax Checker
```
Check JavaScript syntax and common errors:
- Run: node --check server.js
- Run: node --check web/js/app.js
- Run: node --check web/js/stream.js
- Run: node --check web/js/grid.js
- Look for undefined variables, missing brackets, typos
```

### Subagent 2: Bug Hunter
Search changed files for:
- Null/undefined access without checks
- Race conditions in async code
- Resource leaks (intervals not cleared, listeners not removed)
- Missing error handling in fetch/async calls
- Off-by-one errors in array operations

### Subagent 3: Style & Guidelines Checker
Verify against CLAUDE.md rules:
- No duplicate functions
- No duplicate files
- Fix existing code, don't create "v2" versions
- Uses existing patterns from codebase
- Proper cleanup in removeStream, destroy functions

### Subagent 4: Functionality Verifier
Check that changed code works correctly:
- Server endpoints return proper responses
- Event handlers are properly attached/removed
- State is properly managed
- DOM manipulation is correct

## Phase 2: Challenge (Launch 1 subagent)

### Subagent 5: False Positive Filter
Review ALL findings from Phase 1 and determine:
- Which are REAL issues that need fixing
- Which are FALSE POSITIVES (not actual bugs)
- Which are LOW PRIORITY (can ignore for now)

Provide final verdict for each finding.

## Phase 3: Evaluate and Act

### If issues found:
1. List confirmed issues with severity
2. Fix each issue
3. Re-run Phase 1 verification
4. Repeat until clean

### If all checks pass:
1. Stage changes:
   ```bash
   git add -A
   git status
   ```

2. Generate commit message:
   - Look at staged files with `git diff --cached`
   - Summarize the "why" not the "what"
   - Use conventional commit format

3. Create commit:
   ```bash
   git commit -m "$(cat <<'EOF'
   <type>: <description>

   <body if needed>
   EOF
   )"
   ```

## Commit Message Format

```
<type>: <short description>

<longer description if needed>
```

Types:
- `feat`: New feature
- `fix`: Bug fix
- `refactor`: Code restructuring
- `perf`: Performance improvement
- `style`: Code style/formatting
- `chore`: Maintenance tasks

## Output Format

```markdown
## Test and Commit Results

### Phase 1: Verification
- Syntax Check: PASS/FAIL
- Bug Hunter: X findings
- Style Checker: X findings
- Functionality: X findings

### Phase 2: Challenge
- Confirmed issues: X
- False positives filtered: X

### Phase 3: Action
- [ ] All issues fixed
- [ ] Changes committed

### Commit
<commit hash> <commit message>
```
