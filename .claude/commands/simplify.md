# Simplify Code

Run after completing a feature to reduce unnecessary complexity.

## When to Use

Run this command:
- After implementing a new feature
- After fixing a complex bug
- When code feels "over-engineered"
- During refactoring sprints

## Simplification Process

### 1. Identify Complexity

Look for:
- Functions longer than 30 lines
- Deeply nested code (>3 levels)
- Duplicate logic across files
- Unused variables or functions
- Over-abstracted utilities
- Wrapper functions that just call another function

### 2. Apply Simplifications

Use the `@code-simplifier` agent to:
- Remove dead code
- Consolidate duplicates
- Flatten unnecessary nesting
- Simplify complex conditionals
- Remove premature abstractions

### 3. Verify Functionality

CRITICAL: After simplifying, verify nothing broke!
- Run tests if available
- Test affected features manually
- Check for console errors

## Simplification Rules for Plexd

### DO
- Remove console.log debugging
- Consolidate duplicate event handlers
- Simplify grid calculation logic
- Remove unused CSS rules
- Flatten deeply nested callbacks

### DON'T
- Remove intentional error handling
- Simplify performance-critical video code
- Remove browser compatibility checks
- Create new abstractions (just remove)

## Output

```
## Simplification Results

### Changes Made
- [File]: [What was simplified]

### Code Removed
- X lines of dead code
- Y unused functions
- Z duplicate blocks

### Verification
- [ ] Tests pass
- [ ] Features work
- [ ] No console errors

### Metrics
- Before: X lines
- After: Y lines
- Reduction: Z%
```
