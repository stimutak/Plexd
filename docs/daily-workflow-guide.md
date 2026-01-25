# Daily Multi-Agent Workflow Guide for Plexd

A practical guide for using the multi-agent environment in your everyday development.

---

## Morning Startup

When you start a coding session:

```
"Review what I worked on yesterday"
```

Or jump straight into a task:

```
"I need to add [feature]. Use /plan to plan it out."
```

---

## Common Scenarios

### Scenario 1: Adding a New Feature

**Example:** "Add picture-in-picture mode for a single stream"

```
Step 1: Plan
> /plan
Claude creates implementation plan, you approve

Step 2: Implement
> "Implement the plan"
Claude writes the code

Step 3: Verify
> /verify
Claude tests it works (checks for errors, tests in browser if possible)

Step 4: Simplify
> /simplify
Claude removes any unnecessary complexity

Step 5: Review
> /two-phase-review
Multi-agent review catches issues, challenger filters false positives

Step 6: Ship
> /commit-push-pr
Claude commits, pushes, creates PR
```

**Quick version for small features:**
```
> "Add a mute-all button to the controls"
> /verify
> /commit-push-pr
```

---

### Scenario 2: Fixing a Bug

**Example:** "The grid layout breaks when removing the last stream"

```
Step 1: Investigate & Fix
> "Fix the bug where grid breaks when removing the last stream"
Claude finds the issue and fixes it

Step 2: Verify
> /verify
Claude confirms the fix works and didn't break anything else

Step 3: Quick Review
> /review
Sanity check the fix

Step 4: Ship
> /commit-push-pr
```

---

### Scenario 3: Refactoring Code

**Example:** "The stream.js file is getting too big"

```
Step 1: Plan the refactor
> /plan
> "Plan how to refactor stream.js into smaller modules"

Step 2: Execute
> "Execute the refactoring plan"

Step 3: Verify nothing broke
> /verify

Step 4: Full review
> /two-phase-review

Step 5: Ship
> /commit-push-pr
```

---

### Scenario 4: Code Quality Check

**Example:** "Review the codebase for issues before release"

```
> /parallel-review
```

This launches multiple agents in parallel:
- code-reviewer checks quality
- bug-finder hunts bugs
- style-checker validates style
- verifier checks functionality
- challenger filters false positives

You get a final report of confirmed issues only.

---

### Scenario 5: Quick Changes

**Example:** "Change the default grid gap from 4px to 2px"

For trivial changes, skip the ceremony:

```
> "Change default grid gap to 2px"
> /commit-push-pr
```

---

## Slash Command Cheat Sheet

| When you want to... | Use this |
|---------------------|----------|
| Plan before coding | `/plan` |
| Test your changes work | `/verify` |
| Clean up messy code | `/simplify` |
| Quick sanity check | `/review` |
| Thorough review with filtering | `/two-phase-review` |
| Full parallel review | `/parallel-review` |
| Commit and ship | `/commit-push-pr` |
| Document a lesson learned | `/shared-knowledge` |

---

## Invoking Agents Directly

Sometimes you want a specific agent:

```
"Use the bug-finder agent on web/js/grid.js"
"Have the code-reviewer check my changes to app.js"
"Run the planner to figure out how to implement keyboard shortcuts"
"Use code-simplifier on the stream management code"
```

---

## Real Plexd Examples

### Adding Keyboard Shortcuts

```
You: "I want to add keyboard shortcuts for common actions"

Claude: Let me plan this out.
> /plan

[Claude explores codebase, creates plan]

Plan:
1. Add keyboard event listener in app.js
2. Map keys: M=mute all, F=fullscreen, 1-9=focus stream
3. Add visual feedback for key presses
4. Update help/documentation

You: "Looks good, implement it"

[Claude implements]

You: /verify

[Claude tests keyboard shortcuts work]

You: /two-phase-review

[Agents review, challenger filters]

You: /commit-push-pr

[Done!]
```

### Fixing Grid Layout Bug

```
You: "Videos are overlapping when I add a 5th stream"

[Claude investigates grid.js, finds the bug]

Claude: Found it - the calculateGrid function has an off-by-one
error on line 47. Fixed.

You: /verify

Claude: Verified - tested with 1, 4, 5, 8 streams, all layouts correct.
No overlapping. Grid recalculates in <50ms.

You: /commit-push-pr

Claude:
- Committed: "fix: Correct grid calculation for 5+ streams"
- Pushed to branch
- PR created: [link]
```

### Performance Optimization

```
You: "The app feels sluggish with 8 streams"

You: /plan
> "Plan performance optimization for 8+ streams"

[Claude analyzes, creates plan targeting:
- Reduce unnecessary re-renders
- Optimize video element creation
- Batch DOM updates
- Add requestAnimationFrame for layout]

You: "Execute the plan"

[Claude implements optimizations]

You: /verify

Claude: Tested with 8 streams:
- Before: 180ms layout recalculation
- After: 45ms layout recalculation
- Memory usage reduced 15%
- No frame drops observed

You: /parallel-review

[Full review catches one potential memory leak,
challenger confirms it's real]

You: "Fix the memory leak"

You: /commit-push-pr
```

---

## When to Use What

### Use `/plan` when:
- Feature touches multiple files
- You're not sure how to approach it
- It's a significant change
- You want to discuss approach first

### Use `/verify` when:
- After any code change
- Before committing
- After fixing a bug
- To confirm nothing broke

### Use `/review` when:
- Quick sanity check
- Small changes
- Bug fixes

### Use `/two-phase-review` when:
- Before merging to main
- After significant features
- You want thorough review
- Quality is critical

### Use `/simplify` when:
- After completing a feature
- Code feels over-engineered
- Lots of duplication crept in

### Use `/parallel-review` when:
- Pre-release quality check
- Comprehensive codebase review
- You have time for thorough analysis

---

## The Golden Rule

**Always verify your work.**

```
Write Code → /verify → Fix Issues → /verify → Ship
```

This single habit will 2-3x your code quality.

---

## Daily Workflow Template

```
Morning:
1. Pull latest: git pull origin main
2. Start task: "I need to [task]"
3. If complex: /plan first

During development:
4. Implement changes
5. /verify frequently
6. /simplify if needed

Before shipping:
7. /review or /two-phase-review
8. /commit-push-pr

When you learn something:
9. /shared-knowledge (update CLAUDE.md)
```

---

## Tips

1. **Don't skip /verify** - It's the highest-value step
2. **Use /plan for uncertainty** - When you're not sure, plan first
3. **Trust the challenger** - If it filters a finding, it's probably noise
4. **Update shared knowledge** - Future you will thank present you
5. **Small commits** - Ship often with `/commit-push-pr`
