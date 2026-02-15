# Multi-Agent Workflow Guide

Based on [Boris Cherny's workflow](https://paddo.dev/blog/how-boris-uses-claude-code/) (creator of Claude Code) and [Anthropic's official best practices](https://code.claude.com/docs).

---

## Quick Start (5 minutes)

### 1. Use Plan Mode First

Before any non-trivial task, plan first:

```
Shift+Tab twice → Plan Mode
```

Go back and forth refining the plan until you like it. Then switch to auto-accept mode and Claude can usually one-shot it.

> "A good plan is really important!" — Boris Cherny

### 2. Give Claude a Verification Loop

The single most important practice:

```
Write Code → Verify → Fix → Re-verify → Done
```

Always give Claude a way to test its work. This 2-3x the quality of results.

### 3. Use Slash Commands

Available commands (type `/` to see):

| Command | What It Does |
|---------|--------------|
| `/verify` | Run verification loop |
| `/review` | Multi-agent code review |
| `/two-phase-review` | Review + challenge false positives |
| `/simplify` | Simplify code after implementation |
| `/commit-push-pr` | Full commit/push/PR workflow |
| `/test-and-commit` | Verify in parallel, then commit |
| `/plan` | Enter planning mode |
| `/shared-knowledge` | Update CLAUDE.md with learnings |

### 4. Update CLAUDE.md When Claude Errs

When Claude makes a mistake:
1. Fix the immediate issue
2. Add a rule to CLAUDE.md
3. Commit it

This makes all future sessions smarter.

---

## Core Concepts

### The Boris Cherny Philosophy

1. **Parallel > Sequential** — Run 5+ Claudes simultaneously
2. **Specialization > Generalization** — Each agent focuses on one thing
3. **Verification is Critical** — Always provide a feedback loop
4. **Two-Phase Loop** — Initial review + challenger filters false positives
5. **Shared Knowledge** — CLAUDE.md evolves with learnings

### Model Choice

Boris uses **Opus 4.5 with thinking** for everything:

> "Even though it's bigger & slower than Sonnet, since you have to steer it less and it's better at tool use, it is almost always faster than using a smaller model in the end."

### Directory Structure

```
.claude/
├── agents/           # Specialized subagent prompts
│   ├── code-reviewer.md
│   ├── bug-finder.md
│   ├── style-checker.md
│   ├── verifier.md
│   ├── code-simplifier.md
│   ├── verification-challenger.md
│   ├── planner.md
│   └── parallel-coordinator.md
├── commands/         # Slash command definitions
│   ├── verify.md
│   ├── review.md
│   ├── two-phase-review.md
│   ├── simplify.md
│   ├── commit-push-pr.md
│   ├── test-and-commit.md
│   ├── plan.md
│   ├── parallel-review.md
│   └── shared-knowledge.md
└── settings.local.json  # Local permissions
```

---

## Workflows

### New Feature Workflow

```
/plan                  # Create implementation plan
  ↓
Implement              # Auto-accept mode after plan approval
  ↓
/verify                # Run verification loop
  ↓
/simplify              # Remove unnecessary complexity
  ↓
/two-phase-review      # Full review with challenge phase
  ↓
/commit-push-pr        # Ship it
```

### Bug Fix Workflow

```
Investigate → Fix      # Direct fix
  ↓
/verify                # Confirm fix works
  ↓
/review                # Quick review
  ↓
/commit-push-pr        # Ship it
```

### Code Quality Workflow

```
/parallel-review       # Comprehensive multi-agent review
  ↓
Fix confirmed issues   # Only real issues after challenge
  ↓
/shared-knowledge      # Document learnings in CLAUDE.md
```

### Fast Iteration Workflow

```
/test-and-commit       # Parallel verify + auto-commit if passing
```

---

## The Two-Phase Review Loop

Boris Cherny's signature technique. Filters 20-40% false positives.

### Phase 1: Fan-Out (Parallel)

Launch simultaneously:
```
├── code-reviewer    → Quality findings
├── bug-finder       → Bug findings
├── style-checker    → Style findings
└── verifier         → Verification findings
```

### Phase 2: Challenge (Filter)

For EACH finding, the challenger asks:
1. Is this actually a problem?
2. Can I reproduce it realistically?
3. Is there defensive code elsewhere?
4. Is the severity correct?
5. Would the fix introduce new issues?

### Result

Only confirmed, actionable issues remain.

---

## Verification Patterns

### Give Claude What It Needs

| Domain | Verification Method |
|--------|---------------------|
| Has tests | `npm test` |
| Has build | `npm run build` |
| Has linter | `npm run lint` |
| Web app | Browser testing |
| API | `curl` or request tool |
| UI | Chrome extension or screenshots |

### Long-Running Task Verification

Options:
1. Prompt Claude to verify with background agent when done
2. Use `SubagentStop` hook for deterministic verification
3. Use ["ralph-wiggum" plugin](https://github.com/disler/claude-code-hooks-mastery) for autonomous operation

---

## Subagents Reference

### Available Agents

| Agent | When to Use |
|-------|-------------|
| `code-reviewer` | Quality, security, maintainability checks |
| `bug-finder` | Finding bugs, edge cases, race conditions |
| `style-checker` | Style guide compliance |
| `verifier` | End-to-end functional verification |
| `code-simplifier` | Post-implementation cleanup |
| `verification-challenger` | Filtering false positives |
| `planner` | Creating implementation plans |
| `parallel-coordinator` | Orchestrating multiple agents |

### Invoke Directly

```
"Use the code-reviewer agent on the recent changes"
"Run bug-finder on web/js/app.js"
"Have the planner create a plan for adding X feature"
```

### Why Subagents Work

Complex tasks require X tokens of input context, accumulate Y tokens of working context, and produce Z tokens of answer. Subagents farm out the (X + Y) work and return only the Z token answer, keeping your main context clean.

---

## Power User Guide

### Parallel Sessions (Boris's Setup)

Boris runs 5 terminal tabs numbered 1-5, each with a Claude session:

```bash
# Tab 1 - Main feature work
claude

# Tab 2 - Bug fixes
claude

# Tab 3 - Documentation
claude

# Tab 4 - Reviews
claude

# Tab 5 - Experiments
claude
```

Each session uses its own git checkout (not branches) to avoid conflicts.

Use system notifications to know when Claude needs input.

### Teleport Between Local and Web

Move sessions between terminal and claude.ai:

```bash
claude --teleport  # Opens in web browser
```

Useful for:
- Long-running tasks that outlast terminal
- Sharing sessions with teammates
- Visual debugging

### Hooks Configuration

Add to `.claude/settings.json`:

```json
{
  "hooks": {
    "PostToolUse": [
      {
        "matcher": "Write|Edit",
        "command": "prettier --write \"$FILE_PATH\" || true"
      }
    ],
    "Stop": [
      {
        "command": "echo 'Task complete. Running final verification...' && npm test"
      }
    ],
    "SubagentStop": [
      {
        "command": "echo 'Subagent finished. Verifying output quality...'"
      }
    ]
  }
}
```

### Hook Events

| Event | When It Fires | Use Case |
|-------|---------------|----------|
| `PreToolUse` | Before tool calls | Block dangerous commands |
| `PostToolUse` | After tool calls | Auto-format, auto-lint |
| `Stop` | When agent finishes | Final verification |
| `SubagentStop` | When subagent finishes | Quality gates |
| `UserPromptSubmit` | When you send a message | Pre-processing |

### Permissions (Avoid --dangerously-skip-permissions)

Instead of skipping all permissions, allow specific safe commands:

```json
{
  "permissions": {
    "allow": [
      "Bash(npm run build:*)",
      "Bash(npm run test:*)",
      "Bash(npm run lint:*)",
      "Bash(git status:*)",
      "Bash(git diff:*)",
      "Bash(node --check:*)"
    ]
  }
}
```

### Context Management

The 200k token limit requires strategy:

1. **`/clear` often** — Start fresh for new tasks
2. **"Document & Clear"** — For complex tasks:
   - Have Claude dump plan/progress to `.md`
   - Use `/clear`
   - New session reads the `.md` and continues
3. **Avoid `/compact`** — Auto-compaction is lossy; prefer explicit `/clear`

### Resume Sessions

```bash
claude --resume     # Continue last session
claude --continue   # Same as --resume
```

Useful for:
- Debugging after terminal crash
- Asking "how did you solve that error?"
- Building on previous work

### MCP Servers

Configure external services in `.mcp.json`:

```json
{
  "mcpServers": {
    "slack": {
      "command": "mcp-slack",
      "env": { "SLACK_TOKEN": "${SLACK_TOKEN}" }
    },
    "database": {
      "command": "mcp-postgres",
      "env": { "DATABASE_URL": "${DATABASE_URL}" }
    }
  }
}
```

Commit this to repo so team shares configuration.

### Background Agents

Send work to background and continue:

```
Ctrl+B  # During agent execution → sends to background
```

Check on it later:
```
/tasks  # List running tasks
```

---

## CLAUDE.md Best Practices

### Keep It Minimal

> "Your CLAUDE.md should contain as few instructions as possible — ideally only ones which are universally applicable." — [HumanLayer Blog](https://www.humanlayer.dev/blog/writing-a-good-claude-md)

### Structure

```markdown
# Project Name

## Core Principles
[Non-negotiables that apply to every task]

## Prohibited Practices
[Things Claude should never do]

## Technical Knowledge
[Project-specific patterns and gotchas]

## Multi-Agent Environment
[Agent/command reference]
```

### Good Rules

- "Always search with Grep before creating utility functions"
- "Grid layout must recalculate in <100ms"
- "Safari requires webkit prefix for fullscreen"
- "Use deleteFileAndHLS() helper, not inline deletion"

### Bad Rules

- Temporary implementation notes
- One-off bug fixes
- Personal preferences
- Already documented patterns

### The Learning Loop

```
Claude makes mistake
       ↓
You fix immediate issue
       ↓
Add rule to CLAUDE.md
       ↓
Commit with message: "docs: Add [topic] guideline"
       ↓
All future sessions benefit
```

---

## Troubleshooting

### Agent Produces Too Many False Positives

Use `/two-phase-review` instead of `/review`. The challenger phase typically filters 20-40% of findings.

### Context Getting Too Long

1. Use `/clear` and start fresh
2. Use "Document & Clear" pattern for complex tasks
3. Use subagents to offload context-heavy work

### Subagent Not Following Guidelines

Subagents don't automatically inherit all context. Ensure:
- Critical rules are in CLAUDE.md (always loaded)
- Agent-specific rules are in the agent's `.md` file
- Task description includes necessary context

### Permission Prompts Annoying

Add frequently-used safe commands to `settings.json`:

```json
{
  "permissions": {
    "allow": ["Bash(npm run *)", "Bash(git diff:*)"]
  }
}
```

---

---

## Skills System

Skills are the next evolution of slash commands — self-contained capability packages that give Claude specialized knowledge and tools.

> Skills were merged with slash commands in Claude Code 2.1. Files in `.claude/commands/` and `.claude/skills/` both create `/command-name`.

### Skills vs Commands

| Feature | Commands (`.claude/commands/`) | Skills (`.claude/skills/`) |
|---------|-------------------------------|----------------------------|
| Format | Single `.md` file | Directory with `SKILL.md` |
| Supporting files | No | Yes (scripts, templates, references) |
| Frontmatter | Optional | Required (name, description) |
| Auto-invocation | No | Yes (Claude can invoke automatically) |
| Context control | No | Yes (`context: fork`, `allowed-tools`) |

**When to use commands**: Simple prompts, quick workflows
**When to use skills**: Complex workflows, need scripts/templates, want auto-invocation

### Skill Structure

```
.claude/skills/
└── my-skill/
    ├── SKILL.md           # Required: frontmatter + instructions
    ├── scripts/           # Optional: executable Python/Bash
    │   └── analyze.py
    ├── references/        # Optional: docs loaded via Read tool
    │   └── guide.md
    ├── templates/         # Optional: output templates
    │   └── report.md
    └── assets/            # Optional: static files
```

### SKILL.md Frontmatter

```yaml
---
name: skill-name
description: "Action-oriented description. Use when users ask to..."
allowed-tools: "Read,Write,Bash,Grep,Glob,Edit"
model: inherit
disable-model-invocation: false
context: fork
---

# Instructions

Your detailed instructions here...
```

**Required:**
- `name`: Identifier, becomes `/skill-name`
- `description`: When Claude should use this (crucial for auto-invocation)

**Optional:**
- `allowed-tools`: Restrict tools (security)
- `model`: Override model (`"opus"`, `"sonnet"`, `"inherit"`)
- `disable-model-invocation`: Prevent auto-invoke, only manual `/skill-name`
- `context: fork`: Run in isolated sub-agent (keeps main context clean)
- `mode: true`: Marks as "mode command" for behavioral contexts

### Invocation Patterns

**1. Manual (Slash Command)**
```
/skill-name
/skill-name arg1 arg2
```

**2. Auto-Invocation**
Claude reads skill descriptions and automatically invokes when relevant. Control with:
- Good `description` field → Claude knows when to use it
- `disable-model-invocation: true` → Manual only

**3. Explicit Request**
```
"Use the code-review skill on the recent changes"
```

### Skill Discovery

Skills are loaded from (in priority order):
1. `~/.claude/skills/` — Personal, all projects
2. `.claude/skills/` — Project-specific
3. Plugin skills
4. Built-in skills

**Hot-reload**: Changes are instant, no restart needed.

### Progressive Disclosure

Skills load efficiently:
1. **Metadata scan** (~100 tokens) — name + description only
2. **Full load** (<5k tokens) — When skill matches task
3. **Resources** — Scripts/references loaded on-demand

This means dozens of skills don't slow down normal interactions.

### Common Skill Patterns

**1. Script Automation**
```markdown
Execute `{baseDir}/scripts/analyze.py` on the target file.
Parse the JSON output and present findings.
```

**2. Template-Based Generation**
```markdown
Load template from `{baseDir}/templates/report.md`.
Fill in placeholders based on analysis.
Write to specified output location.
```

**3. Iterative Refinement**
```markdown
Phase 1: Broad scan with Grep for patterns
Phase 2: Deep analysis of matching files
Phase 3: Generate structured recommendations
```

**4. Wizard Workflow**
```markdown
Step 1: Gather requirements (ask user)
Step 2: Analyze codebase
Step 3: Present plan for approval
Step 4: Execute changes
```

### Creating Skills for This Project

Recommended skills for Plexd:

| Skill | Purpose |
|-------|---------|
| `verify-app` | End-to-end app verification (browser + server) |
| `retrospective` | Generate learnings from session, update CLAUDE.md |
| `debug-mode` | Enhanced logging, step-by-step execution |
| `perf-audit` | Performance analysis for video streaming |

---

## Implementation Roadmap

### Phase 1: Foundation (Current)
- [x] Commands in `.claude/commands/`
- [x] Agents in `.claude/agents/`
- [x] CLAUDE.md with project rules
- [x] Basic verification workflows

### Phase 2: Skills Migration
- [ ] Convert high-value commands to skills
- [ ] Add `verify-app` skill with browser testing script
- [ ] Add `retrospective` skill for automated learning
- [ ] Add `perf-audit` skill for video performance

### Phase 3: Hooks Integration
- [ ] `PostToolUse` hook for auto-formatting
- [ ] `Stop` hook for final verification
- [ ] `SubagentStop` hook for quality gates

### Phase 4: Advanced
- [ ] MCP server integration (if needed)
- [ ] GitHub Actions for PR automation
- [ ] Team-wide skill registry

---

## Sources

- [How Boris Cherny Uses Claude Code](https://paddo.dev/blog/how-boris-uses-claude-code/)
- [Boris Cherny's Twitter Thread](https://twitter-thread.com/t/2007179832300581177)
- [VentureBeat: Creator of Claude Code Workflow](https://venturebeat.com/technology/the-creator-of-claude-code-just-revealed-his-workflow-and-developers-are)
- [How to Run Coding Agents in Parallel](https://towardsdatascience.com/how-to-run-coding-agents-in-parallell/)
- [Writing a Good CLAUDE.md](https://www.humanlayer.dev/blog/writing-a-good-claude-md)
- [How I Use Every Claude Code Feature](https://blog.sshh.io/p/how-i-use-every-claude-code-feature)
- [Claude Code Hooks Guide](https://code.claude.com/docs/en/hooks-guide)
- [Awesome Claude Code](https://github.com/hesreallyhim/awesome-claude-code)
