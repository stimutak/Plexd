# Commit, Push, and Create PR

Automate the full workflow from staged changes to pull request.

## Steps

1. **Review Changes**
   - Run `git status` to see all modified files
   - Run `git diff --staged` to see staged changes
   - Run `git diff` to see unstaged changes

2. **Stage Changes**
   - Add relevant files to staging
   - Exclude any sensitive files (.env, credentials, etc.)

3. **Create Commit**
   - Analyze the changes to understand what was done
   - Write a clear, concise commit message:
     - First line: Type + brief summary (50 chars max)
     - Types: feat, fix, refactor, docs, style, test, chore
     - Body: Explain "why" not "what" if needed

4. **Push to Remote**
   - Push to the current feature branch
   - Use `-u origin <branch>` to set upstream

5. **Create Pull Request**
   - Use `gh pr create`
   - Title: Clear summary of the change
   - Body format:
     ```
     ## Summary
     - Bullet points of what changed

     ## Test Plan
     - How to verify the changes work
     ```

## Example Commit Messages

Good:
```
feat: Add keyboard navigation to favorites panel

Enables arrow key navigation through favorites list for
accessibility. Follows existing focus management patterns.
```

Bad:
```
updated code
```

## Checklist Before Running

- [ ] All changes are intentional
- [ ] No console.log debugging statements
- [ ] No commented-out code
- [ ] Tests pass (if applicable)
- [ ] CLAUDE.md guidelines followed
