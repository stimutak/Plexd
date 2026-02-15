---
name: retrospective
description: "Analyze the current session and extract learnings for CLAUDE.md. Use at the end of a session to capture mistakes made, patterns discovered, and rules that should be added."
allowed-tools: "Read,Write,Edit,Grep"
disable-model-invocation: true
---

# Session Retrospective

Analyze this session's conversation and extract learnings to improve future sessions.

## Process

### Step 1: Identify Mistakes

Review the session for:
- Errors Claude made that required correction
- Wrong assumptions about the codebase
- Patterns that didn't work
- Commands that failed unexpectedly

For each mistake, formulate a clear rule to prevent it.

### Step 2: Identify Discoveries

Look for:
- Patterns that worked well
- Gotchas specific to this project
- Browser compatibility issues found
- Performance considerations discovered
- API behaviors learned

### Step 3: Check Existing CLAUDE.md

Read the current CLAUDE.md and check:
- Is this learning already documented?
- Where would this rule fit best?
- Does it conflict with existing rules?

### Step 4: Propose Updates

Format proposed additions:

```markdown
## Proposed CLAUDE.md Updates

### Mistakes to Prevent

**Section**: [Prohibited Practices / Technical Knowledge / etc.]

**Rule**: [Clear, actionable guideline]

**Reason**: [Why this matters, what went wrong]

---

### Patterns to Follow

**Section**: [Development Guidelines / Technical Knowledge]

**Rule**: [Pattern description]

**Reason**: [Why this works]

---
```

### Step 5: Apply Updates (If Approved)

After user approval:
1. Edit CLAUDE.md to add the new rules
2. Place rules in appropriate sections
3. Keep rules concise and actionable

## Output Format

```markdown
## Session Retrospective

### Session Summary
[Brief description of what was worked on]

### Mistakes Identified
1. [Mistake]: [What went wrong]
   - Proposed rule: [Rule text]
   - Section: [Where to add in CLAUDE.md]

### Patterns Discovered
1. [Pattern]: [What worked well]
   - Proposed rule: [Rule text]
   - Section: [Where to add in CLAUDE.md]

### Already Documented
[List any learnings that are already in CLAUDE.md]

### Proposed Updates
[Formatted additions to CLAUDE.md]

---

Shall I update CLAUDE.md with these learnings?
```

## Guidelines

- Only propose rules that are **universally applicable** to this project
- Avoid one-off fixes or temporary workarounds
- Keep rules **actionable** — Claude should know exactly what to do
- Include the "why" when it's not obvious
- Don't duplicate existing rules
