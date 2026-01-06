# Multi-Agent Code Review

Launch a comprehensive code review using multiple specialized agents in parallel.

## Workflow

### Phase 1: Parallel Analysis
Launch these agents simultaneously to review the changes:

1. **code-reviewer** - Overall code quality and patterns
2. **bug-finder** - Bugs, edge cases, and failure modes
3. **style-checker** - Style guide compliance
4. **verifier** - Functional correctness verification

### Phase 2: Challenge False Positives
After Phase 1 completes:

1. **verification-challenger** - Review all findings from Phase 1
   - Filter out false positives
   - Confirm real issues
   - Adjust severity levels

### Phase 3: Aggregate Results
Combine findings into a unified report:

```
## Code Review Results

### Critical Issues (Must Fix)
[Issues confirmed by challenger as real and critical]

### High Priority
[Confirmed high-severity issues]

### Medium Priority
[Confirmed medium-severity issues]

### Suggestions
[Style improvements and nice-to-haves]

### False Positives Filtered
[Issues that were challenged and removed]

## Summary
- Total findings: X
- Confirmed issues: X
- False positives: X
- Approval: APPROVED / NEEDS CHANGES
```

## Usage

Run this command on:
- All PRs before merge
- After significant code changes
- When uncertain about code quality

## Quick Review Alternative

For smaller changes, use just:
1. bug-finder
2. verification-challenger

This provides faster feedback with lower token cost.
