# Multi-Agent Setup Guide

**This guide has been superseded by the comprehensive workflow documentation.**

See: **[multi-agent-workflow.md](./multi-agent-workflow.md)**

The new guide includes:
- Quick start (5 minutes)
- Boris Cherny's workflow patterns
- Two-phase review loops
- Skills system (new)
- Hooks configuration
- Power user guide
- Context management
- Implementation roadmap

---

## Quick Reference

### Directory Structure

```
.claude/
├── agents/           # Specialized subagent prompts
├── commands/         # Slash command definitions
├── skills/           # Skills (next-gen commands with scripts/templates)
└── settings.local.json
```

### Most Important Commands

```
/verify              # Verification loop (2-3x quality)
/two-phase-review    # Review + challenge false positives
/commit-push-pr      # Ship it
/retrospective       # Extract learnings to CLAUDE.md
```

### The Key Insight

> "Give Claude a way to verify its work. If Claude has that feedback loop, it will 2-3x the quality of the final result." — Boris Cherny
