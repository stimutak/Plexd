# Verification Loop

Run a verification loop to ensure code works correctly. This is the most important practice for high-quality results.

## The Verification Loop Pattern

```
Write Code -> Test/Verify -> Fix Issues -> Re-verify -> Done
```

## Verification Steps

### 1. Identify Verification Method
For each change, determine how to verify:

- **Has tests?** Run the tests
- **Has build?** Run the build
- **Has linter?** Run the linter
- **Manual testing?** Document test steps
- **Code review?** Use review agents

### 2. Execute Verification

```bash
# If tests exist
npm test

# If build exists
npm run build

# If linter exists
npm run lint

# For Plexd web app
# Open web/index.html in browser and test:
# - Add multiple streams
# - Verify grid layout
# - Test responsive behavior
# - Check for console errors
```

### 3. Analyze Results

If verification fails:
1. Read the error messages carefully
2. Identify the root cause
3. Fix the specific issue
4. Re-run verification

If verification passes:
1. Document what was verified
2. Note any edge cases tested
3. Confirm ready for review

### 4. Re-verify After Fixes

CRITICAL: After making any fix, run verification again!
- Never assume a fix works without testing
- Fixes can introduce new bugs
- Continue loop until all verifications pass

## Plexd-Specific Verifications

### Grid Layout
- [ ] Grid recalculates in <100ms
- [ ] Videos maximize display area
- [ ] Minimal black bars/letterboxing
- [ ] Works with 1, 4, 8+ streams

### Video Playback
- [ ] Streams load correctly
- [ ] Playback is smooth (no frame drops)
- [ ] Audio mute/unmute works
- [ ] Resources cleaned on stream removal

### Browser Compatibility
- [ ] Chrome
- [ ] Firefox
- [ ] Safari (especially iPad)
- [ ] Edge

## Output

After verification completes:

```
## Verification Results

### Tests Run
- [Test type]: PASS/FAIL

### Issues Found and Fixed
- [Issue]: [Fix applied]

### Final Status
[ ] VERIFIED - All checks pass
[ ] BLOCKED - Issues remain
```
