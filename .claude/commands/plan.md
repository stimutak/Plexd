# Plan Mode

Enter planning mode before implementing complex features. Create a detailed plan and get approval before writing code.

## When to Use Plan Mode

Use for:
- New features touching multiple files
- Architectural changes
- Complex bug fixes
- Refactoring efforts
- Any task you're uncertain about

Skip for:
- Simple bug fixes
- Single-file changes
- Documentation updates
- Style-only changes

## Planning Process

### Step 1: Understand Requirements
- What is the goal?
- What are the constraints?
- What's in scope vs out of scope?

### Step 2: Explore Existing Code
Use these tools to understand current state:
- `Glob` - Find relevant files
- `Grep` - Search for patterns
- `Read` - Examine implementations

Ask:
- What patterns exist?
- What can be reused?
- What might break?

### Step 3: Design Approach
Consider:
- What's the simplest solution?
- Does it follow CLAUDE.md guidelines?
- Are there alternatives?

### Step 4: Create Implementation Plan
Break down into concrete steps:
```
## Plan: [Feature Name]

### Goal
[What success looks like]

### Approach
[Chosen strategy and rationale]

### Steps
1. [ ] First change
   - File: [path]
   - Change: [description]
2. [ ] Second change...

### Testing
- [ ] How to verify each step
- [ ] How to verify completion

### Risks
- [What could go wrong]
- [Mitigation strategy]
```

### Step 5: Get Approval
Present plan to user. Wait for:
- Approval to proceed
- Feedback for adjustments
- Alternative direction

### Step 6: Execute
Once approved:
- Follow plan step by step
- Mark steps complete as you go
- Verify at each checkpoint

## Using the Planner Agent

For complex tasks, use:
```
@planner: Create implementation plan for [task description]
```

The planner agent will:
1. Analyze the codebase
2. Design the approach
3. Break down into steps
4. Identify risks
5. Present for approval
