# Update Shared Knowledge

Add learnings to CLAUDE.md so all future Claude sessions benefit. This is how the multi-agent environment learns and improves.

## When to Update Shared Knowledge

Add to CLAUDE.md when:
- Claude makes a mistake that should be prevented
- A pattern is discovered that should be followed
- A gotcha is found that future sessions should know
- Project-specific knowledge is learned

## What to Add

### Good Additions
- "Don't use innerHTML for user-provided URLs"
- "Grid layout must recalculate in <100ms"
- "Safari requires webkit prefix for X"
- "Function Y is the canonical way to do Z"

### Bad Additions
- Temporary implementation notes
- One-off bug fixes
- Personal preferences
- Already documented patterns

## Process

### 1. Identify the Learning
What went wrong or what pattern was discovered?

### 2. Formulate the Rule
Write a clear, actionable guideline:
- Be specific
- Explain why
- Give example if helpful

### 3. Find the Right Section
Choose where in CLAUDE.md this belongs:
- Code Quality Standards
- Development Guidelines
- Prohibited Practices
- Performance Targets
- Plexd-Specific Rules

### 4. Add the Knowledge
Edit CLAUDE.md to include the new rule.

### 5. Commit the Change
Include clear commit message:
```
docs: Add [topic] guideline to CLAUDE.md

After [situation], learned that [lesson].
This prevents [problem] in future sessions.
```

## Example Addition

After discovering Claude created duplicate utility functions:

```markdown
## Prohibited Practices

- Creating duplicate utility files (e.g., `utils.js` AND `helpers.js`)
- **Creating functions that duplicate existing ones** - Always search
  the codebase with Grep before writing new utility functions
```

## Shared Knowledge Categories

### Patterns to Follow
Positive patterns that should be replicated.

### Mistakes to Avoid
Things that went wrong and should be prevented.

### Plexd Gotchas
Project-specific quirks and requirements.

### Browser Compatibility
Cross-browser issues and solutions.

### Performance Rules
Performance-critical patterns for video.

## Output

After updating shared knowledge:

```
## Knowledge Update

### Added to CLAUDE.md
Section: [section name]
Rule: [the new guideline]
Reason: [why this was added]

### Verification
- [ ] CLAUDE.md updated
- [ ] Change committed
- [ ] Future sessions will benefit
```
