# Parallel Multi-Agent Review

Launch multiple Claude instances in parallel for comprehensive code review. This is the "real-time strategy mode" approach.

## Parallel Execution Strategy

### The Boris Cherny Approach
Run 5+ Claude instances simultaneously, each focused on a specific task:

```
Instance 1: code-reviewer    -> Quality analysis
Instance 2: bug-finder       -> Bug hunting
Instance 3: style-checker    -> Style compliance
Instance 4: verifier         -> Functionality check
Instance 5: security-auditor -> Security review (if applicable)
```

### Coordination Pattern

```
        ┌─────────────────┐
        │  Coordinator    │
        │  (Main Claude)  │
        └────────┬────────┘
                 │
    ┌────────────┼────────────┐
    │            │            │
    ▼            ▼            ▼
┌────────┐  ┌────────┐  ┌────────┐
│Agent 1 │  │Agent 2 │  │Agent 3 │
│Review  │  │ Bugs   │  │ Style  │
└────┬───┘  └────┬───┘  └────┬───┘
     │           │           │
     └───────────┼───────────┘
                 │
        ┌────────▼────────┐
        │  Challenger     │
        │ (Filter Phase)  │
        └────────┬────────┘
                 │
        ┌────────▼────────┐
        │  Final Report   │
        └─────────────────┘
```

## Execution Commands

### Launch Parallel Agents
Use the Task tool to spawn multiple subagents simultaneously:

```
Task: code-reviewer - Review all changed files for quality
Task: bug-finder - Find bugs in changed files
Task: style-checker - Check style compliance
Task: verifier - Verify functionality
```

All run in parallel, returning results independently.

### Aggregate Results
Collect outputs from all agents into unified view.

### Challenge Phase
Run verification-challenger on combined findings.

## Benefits

1. **Speed**: Parallel execution is faster than sequential
2. **Coverage**: Multiple perspectives catch more issues
3. **Quality**: Two-phase filtering removes false positives
4. **Focus**: Each agent specializes in one concern

## Usage

For full codebase review:
```
/parallel-review --scope=all
```

For recent changes only:
```
/parallel-review --scope=staged
```

For specific files:
```
/parallel-review --files=web/js/app.js,web/js/grid.js
```

## Output

```
## Parallel Review Complete

### Agents Executed
- code-reviewer: X findings
- bug-finder: X findings
- style-checker: X findings
- verifier: X findings

### After Challenge Phase
- Total findings: X
- Confirmed: X
- Filtered: X

### Action Items
[Prioritized list of real issues to fix]
```
