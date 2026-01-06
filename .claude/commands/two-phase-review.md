# Two-Phase Review Loop

Boris Cherny's signature technique: Initial review followed by challenger agents to filter false positives.

## Why Two Phases?

Initial code reviews catch real problems but also produce false alarms. The second phase uses challenger agents specifically tasked with poking holes in the original findings. This produces cleaner, more actionable results.

## Phase 1: Initial Review

Launch multiple review agents in parallel:

```
Parallel Execution:
├── code-reviewer (quality & patterns)
├── bug-finder (bugs & edge cases)
├── style-checker (style compliance)
└── security check (if applicable)
```

Each agent produces findings with severity levels.

## Phase 2: Challenge Loop

For EACH finding from Phase 1, the challenger asks:

1. **Is this actually a problem?**
   - Can I reproduce it?
   - Does it affect real users?

2. **Is there context that invalidates this?**
   - Is there defensive code elsewhere?
   - Is this intentional design?

3. **Is the severity correct?**
   - Would this really cause issues?
   - How likely is the trigger?

4. **Would the fix help?**
   - Does the suggested fix work?
   - Would it introduce new problems?

## Execution Pattern

```
# Step 1: Run initial reviewers
@code-reviewer: Review recent changes
@bug-finder: Find bugs in recent changes
@style-checker: Check style compliance

# Step 2: Collect all findings
# Aggregate into single list

# Step 3: Challenge each finding
@verification-challenger: Review these findings: [list]

# Step 4: Final report
# Only confirmed issues remain
```

## Expected Outcome

Typically filters out 20-40% of initial findings as false positives, leaving only actionable issues.

## Output Format

```
## Two-Phase Review Results

### Phase 1 Findings: X total
### Phase 2 Confirmed: Y total
### False Positive Rate: Z%

### Confirmed Issues
[Only the real issues that survived challenge]

### Filtered Out
[Findings removed and why]

### Action Items
1. [Specific fix needed]
2. [Specific fix needed]
```
