# Multi-Agent Development Environment Setup Guide

A guide for Claude to set up a Boris Cherny-inspired multi-agent development environment on any project.

## Quick Setup Instructions for Claude

When a user asks you to set up a multi-agent development environment, follow these steps:

### Step 1: Create Directory Structure

```bash
mkdir -p .claude/agents .claude/commands
```

### Step 2: Create Subagents

Create these 8 files in `.claude/agents/`:

---

#### `.claude/agents/code-reviewer.md`

```markdown
# Code Reviewer Agent

Expert code review specialist. Focuses on quality, security, performance, and maintainability.

## Role

You are a senior code reviewer checking for:
- Code quality and patterns
- Security vulnerabilities (OWASP Top 10)
- Performance issues
- Maintainability concerns

## Review Checklist

### Code Quality
- Clear naming conventions
- Single responsibility principle
- No duplicate code
- Proper error handling

### Security
- No XSS vulnerabilities
- No injection risks
- Safe DOM manipulation
- Input validation

### Performance
- Efficient algorithms
- Memory leak prevention
- Resource cleanup

## Output Format

```
## Critical Issues
- [file:line] Issue and fix

## Warnings
- [file:line] Potential problem

## Suggestions
- [file:line] Improvement

## Status: APPROVED / NEEDS CHANGES / DISCUSS
```
```

---

#### `.claude/agents/bug-finder.md`

```markdown
# Bug Finder Agent

Specialized in identifying bugs, edge cases, and potential issues.

## Role

Find:
- Logic errors
- Off-by-one errors
- Null/undefined handling
- Race conditions
- Resource leaks
- Type coercion issues

## Detection Process

For each function, ask:
1. What inputs could break it?
2. What state could be invalid?
3. What timing issues could occur?
4. What resources might leak?

## Output Format

```
## Critical Bugs
- [file:line] BUG: Description
  - Trigger: How to reproduce
  - Impact: What goes wrong
  - Fix: Suggested solution

## High/Medium/Low Priority
- [file:line] Description...

## Summary
- Critical: X, High: X, Medium: X, Low: X
```
```

---

#### `.claude/agents/style-checker.md`

```markdown
# Style Checker Agent

Ensures code follows project style guidelines.

## Style Rules

### Naming
- Variables/Functions: camelCase
- Constants: UPPER_SNAKE_CASE
- CSS Classes: kebab-case
- Files: lowercase

### Code Structure
- Max function length: 50 lines
- Max nesting: 4 levels
- One responsibility per function

### Prohibited
- No `var` (use const/let)
- No `==` (use ===)
- No eval()
- No magic numbers

## Output Format

```
## Naming Issues
- [file:line] `bad` should be `good`

## Formatting Issues
- [file:line] Issue

## Prohibited Patterns
- [file:line] Pattern found

## Status: PASS / NEEDS CLEANUP
```
```

---

#### `.claude/agents/verifier.md`

```markdown
# Verifier Agent

End-to-end verification and testing specialist.

## Verification Methods

1. **Code Review**: Verify logic correctness
2. **Static Analysis**: Check for error patterns
3. **Edge Cases**: Test boundary conditions
4. **If tests exist**: Run them

## Checklist

- [ ] Features work as specified
- [ ] Edge cases handled
- [ ] Error states display properly
- [ ] No console errors
- [ ] Resources cleaned up

## Output Format

```
## Passed
- [Feature]: Verification notes

## Failed
- [Feature]: What failed

## Warnings
- [Feature]: Potential issues

## Status: VERIFIED / ISSUES FOUND / NEEDS MANUAL TESTING
```
```

---

#### `.claude/agents/code-simplifier.md`

```markdown
# Code Simplifier Agent

Reduces complexity after implementation is complete.

## Simplification Targets

- Functions over 30 lines
- Nesting deeper than 3 levels
- Duplicate logic
- Unused variables/functions
- Wrapper functions
- Premature abstractions

## Actions

1. Remove dead code
2. Consolidate duplicates
3. Flatten nesting
4. Simplify conditionals
5. Remove console.logs

## Output Format

```
## Changes Made
- [file]: What was simplified

## Code Removed
- X lines removed
- Y functions consolidated

## Metrics
- Before: X lines
- After: Y lines
- Reduction: Z%
```
```

---

#### `.claude/agents/verification-challenger.md`

```markdown
# Verification Challenger Agent

Second-phase agent that filters false positives from other reviewers.

## Challenge Process

For each finding, ask:
1. Is this actually a problem?
2. Can I reproduce it realistically?
3. Is there defensive code elsewhere?
4. Is the severity correct?
5. Would the fix introduce new issues?

## False Positive Indicators

- Issue is purely theoretical
- "Problem" is intentional design
- Edge case too rare to matter
- Premature optimization concern

## Output Format

```
## Confirmed (Keep)
- [Finding]: Confirmed because...

## Disputed (Remove)
- [Finding]: Challenge reason
  - Recommendation: Remove / Downgrade

## Summary
- Reviewed: X
- Confirmed: X
- Disputed: X
- False positive rate: X%
```
```

---

#### `.claude/agents/planner.md`

```markdown
# Planner Agent

Creates detailed implementation plans before coding.

## Planning Process

1. Understand the goal
2. Analyze current code
3. Design simplest approach
4. Break into steps
5. Identify risks

## Plan Template

```
## Task: [Name]

### Goal
[What success looks like]

### Approach
[Chosen strategy]

### Steps
1. [ ] Step with file and changes
2. [ ] Next step...

### Testing
- [ ] How to verify

### Risks
- [Risk]: [Mitigation]
```
```

---

#### `.claude/agents/parallel-coordinator.md`

```markdown
# Parallel Coordinator Agent

Orchestrates multiple agents working simultaneously.

## Patterns

### Fan-Out (Parallel Review)
```
Task -> [Agent A, B, C] -> Aggregate -> Challenger -> Final
```

### Pipeline (Sequential)
```
Task -> Agent A -> Agent B -> Final
```

## Agent Combinations

### Full Review
1. code-reviewer (parallel)
2. bug-finder (parallel)
3. style-checker (parallel)
4. verifier (parallel)
5. verification-challenger (filter)

### Quick Review
1. bug-finder
2. verification-challenger

## Output Format

```
## Agents Deployed
- [Agent]: Task

## Aggregated Findings
[Deduplicated, prioritized issues]

## False Positives Filtered
[What was removed]
```
```

---

### Step 3: Create Slash Commands

Create these 8 files in `.claude/commands/`:

---

#### `.claude/commands/commit-push-pr.md`

```markdown
# Commit, Push, and Create PR

1. Run `git status` and `git diff`
2. Stage relevant files
3. Write clear commit message (type: summary)
4. Push to feature branch
5. Create PR with summary and test plan

## Commit Types
feat, fix, refactor, docs, style, test, chore
```

---

#### `.claude/commands/review.md`

```markdown
# Multi-Agent Code Review

## Phase 1: Parallel Analysis
Launch simultaneously:
- code-reviewer
- bug-finder
- style-checker
- verifier

## Phase 2: Challenge
Run verification-challenger on all findings

## Phase 3: Report
Unified, deduplicated results with confirmed issues only
```

---

#### `.claude/commands/verify.md`

```markdown
# Verification Loop

```
Write Code -> Test -> Fix -> Re-test -> Done
```

## Steps
1. Identify verification method (tests, build, lint, manual)
2. Execute verification
3. Fix any failures
4. Re-verify until passing
5. Document what was verified
```

---

#### `.claude/commands/two-phase-review.md`

```markdown
# Two-Phase Review Loop

## Phase 1: Initial Review (Parallel)
- code-reviewer
- bug-finder
- style-checker

## Phase 2: Challenge (Filter)
For each finding:
1. Is this actually a problem?
2. Is there context that invalidates it?
3. Is severity correct?

Typically filters 20-40% as false positives.
```

---

#### `.claude/commands/simplify.md`

```markdown
# Simplify Code

Run after completing a feature.

1. Use code-simplifier agent
2. Remove dead code, duplicates, over-abstraction
3. Verify functionality preserved
4. Report lines removed and simplifications made
```

---

#### `.claude/commands/plan.md`

```markdown
# Plan Mode

For complex tasks, plan before coding.

1. Understand requirements
2. Explore existing code (Glob, Grep, Read)
3. Design simplest approach
4. Create step-by-step plan
5. Get user approval
6. Execute plan
```

---

#### `.claude/commands/parallel-review.md`

```markdown
# Parallel Multi-Agent Review

Launch multiple agents simultaneously:

```
┌─────────────┐
│ Coordinator │
└──────┬──────┘
       │
   ┌───┼───┐
   ▼   ▼   ▼
  [A] [B] [C]  ← Parallel agents
   │   │   │
   └───┼───┘
       ▼
  [Challenger] ← Filter phase
       │
       ▼
  [Final Report]
```

Use Task tool to spawn multiple subagents at once.
```

---

#### `.claude/commands/shared-knowledge.md`

```markdown
# Update Shared Knowledge

When Claude makes a mistake:

1. Fix the immediate issue
2. Formulate a clear rule
3. Add to appropriate CLAUDE.md section
4. Commit with message: "docs: Add [topic] guideline"

This helps all future sessions avoid the same mistake.
```

---

### Step 4: Update CLAUDE.md

Add this section to the project's CLAUDE.md:

```markdown
---

## Multi-Agent Development Environment

This project uses a Boris Cherny-inspired multi-agent workflow.

### Philosophy

1. **Parallel beats Sequential** - Run multiple agents simultaneously
2. **Specialization beats Generalization** - Each agent focuses on one concern
3. **Verification is Critical** - Always give Claude a way to verify its work
4. **Two-Phase Loop** - Initial review + challenger filters false positives
5. **Shared Knowledge** - Update CLAUDE.md when mistakes are discovered

### Available Subagents (`.claude/agents/`)

| Agent | Purpose |
|-------|---------|
| `code-reviewer` | Quality, security, maintainability reviews |
| `bug-finder` | Bugs, edge cases, failure modes |
| `style-checker` | Style guide compliance |
| `verifier` | End-to-end verification |
| `code-simplifier` | Post-implementation cleanup |
| `verification-challenger` | Filters false positives |
| `planner` | Implementation planning |
| `parallel-coordinator` | Multi-agent orchestration |

### Slash Commands (`.claude/commands/`)

| Command | Purpose |
|---------|---------|
| `/commit-push-pr` | Commit, push, create PR |
| `/review` | Multi-agent code review |
| `/verify` | Verification loop |
| `/two-phase-review` | Review + challenge loop |
| `/simplify` | Code simplification |
| `/plan` | Planning mode |
| `/parallel-review` | Parallel agent review |
| `/shared-knowledge` | Update CLAUDE.md |

### Two-Phase Review Loop

```
Phase 1: Fan-Out (Parallel)
├── code-reviewer    → Quality findings
├── bug-finder       → Bug findings
├── style-checker    → Style findings
└── verifier         → Verification findings

Phase 2: Challenge (Filter)
└── verification-challenger → Confirms real issues
```

### Recommended Workflows

**New Features:** `/plan` → implement → `/verify` → `/simplify` → `/two-phase-review` → `/commit-push-pr`

**Bug Fixes:** fix → `/verify` → `/review` → `/commit-push-pr`

**Code Quality:** `/parallel-review` → fix issues → `/shared-knowledge`
```

---

## Usage After Setup

### Slash Commands
```
/review              # Multi-agent review
/verify              # Verification loop
/two-phase-review    # Full review with filtering
/simplify            # Simplify code
/plan                # Planning mode
/parallel-review     # Parallel agents
/commit-push-pr      # Ship it
/shared-knowledge    # Document learnings
```

### Invoke Agents Directly
```
"Use the code-reviewer agent to review my changes"
"Run bug-finder on src/app.js"
"Have the planner create a plan for this feature"
```

### The Key Patterns

1. **Verification Loop**: Always test your work
2. **Two-Phase Review**: Review, then challenge findings
3. **Shared Knowledge**: Update CLAUDE.md when you learn something

---

## Customization

Adapt agents for project-specific needs:
- Add project-specific rules to each agent
- Include framework-specific checks (React, Vue, etc.)
- Add language-specific patterns (TypeScript, Python, etc.)
- Reference project's existing CLAUDE.md guidelines
