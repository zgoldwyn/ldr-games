---
inclusion: always
---

# Commit Changes on Task Completion

When a spec task is completed, commit the changes for that task to git before moving on to the next task. This keeps the history granular and makes each task's work easy to review, revert, or bisect.

## When to commit

- Commit immediately after a task's implementation and verification (build/tests) succeed and the task is marked complete.
- One commit per task. Do not batch multiple tasks into a single commit.
- If a task is split across sub-tasks, commit when the leaf task finishes.

## What to stage

- Stage only the files that belong to the completed task. Prefer explicit `git add <paths>` over `git add .` to avoid sweeping in unrelated changes.
- Do not stage secrets or local-only files (`.env`, credentials, editor scratch files). Flag anything suspicious instead of committing it.

## Commit message format

Use a concise conventional-commit style that references the spec and task:

```
<type>(ldr-companion-app): <task id> <short description>
```

- `type` is one of `feat`, `fix`, `test`, `chore`, `refactor`, `docs`.
- Example: `feat(ldr-companion-app): 4.1 add HLC clock and resolveConflict`
- Example: `test(ldr-companion-app): 4.2 property test for conflict resolution`

Keep the subject under ~70 characters. Add a short body only if the task needs extra context.

## Safety

- Only create commits — never push, force-push, amend already-pushed commits, or reset without explicit user instruction.
- Never commit directly to `main`/`master` unless the user explicitly asks; work on a feature branch.
- Preserve git hooks (do not use `--no-verify`) unless the user asks otherwise.
