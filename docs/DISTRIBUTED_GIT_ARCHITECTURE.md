# Distributed Git Architecture

## Overview

The multi-agent system now implements a **git-first distributed architecture** where **every workflow step commits its outputs to git**. This enables distributed agents to pick up work from any point in the workflow by pulling from git.

## Key Principle

**Almost every step pushes to git** - except when reusing cached context that hasn't changed since the last scan.

## Architecture Changes

### 1. Context Scanning (ContextStep)

**Before:** PersonaRequestStep sent request to context persona (LLM) without actual repo scanning.

**After:** 
- `ContextStep` scans repository using `scanRepo()` utility
- Writes artifacts to `.ma/context/`:
  - `snapshot.json` - Full scan data (files, sizes, line counts, timestamps)
  - `summary.md` - Human-readable summary (directory tree, stats, large files, file types)
- **Commits and pushes** to git
- Checks modification times to reuse existing context when no code changes detected
- If `reused_existing: true`, indicates cached context was used

**Git Commits:**
```
chore(ma): update context scan (142 files)
```

**Context Persona** now receives scan data in payload and analyzes it:
- `repoScan` - Array of FileInfo objects
- `context_metadata` - Scan statistics
- `reused_existing` - Boolean indicating if cached context was used

### 2. Planning (PlanningLoopStep)

**Already implemented** - PlanningLoopStep commits each iteration:

**Artifacts:**
- `.ma/tasks/{id}/02-plan-iteration-1.md`
- `.ma/tasks/{id}/02-plan-iteration-2.md`
- `.ma/tasks/{id}/03-plan-final.md` (approved plan)

**Git Commits:**
```
docs(ma): plan iteration 1 for task 123
docs(ma): plan iteration 2 for task 123
docs(ma): approved plan for task 123
```

### 3. Implementation (DiffApplyStep)

**Already implemented** - DiffApplyStep applies diffs and commits/pushes:

**Git Commits:**
```
feat: implement logging configuration system
```

### 4. Reviews (GitArtifactStep)

**New** - Added GitArtifactStep after each review persona:

**Artifacts:**
- `.ma/tasks/{id}/reviews/qa.json`
- `.ma/tasks/{id}/reviews/code-review.json`
- `.ma/tasks/{id}/reviews/security.json`
- `.ma/tasks/{id}/reviews/devops.json`

**Git Commits:**
```
test(ma): QA review for task 123
refactor(ma): code review for task 123
security(ma): security review for task 123
ci(ma): DevOps review for task 123
```

## Workflow Sequence

### task-flow.yaml (New Task)

```
1. checkout_branch (GitOperationStep)
2. mark_task_in_progress (SimpleTaskStatusStep)
3. context_scan (ContextStep) → commits .ma/context/*.{json,md}
4. context_request (PersonaRequestStep) → analyzes scan data
5. planning_loop (PlanningLoopStep) → commits .ma/tasks/{id}/02-plan-*.md
6. implementation_request (PersonaRequestStep)
7. apply_implementation_edits (DiffApplyStep) → commits code changes
8. qa_request (PersonaRequestStep)
9. commit_qa_result (GitArtifactStep) → commits .ma/tasks/{id}/reviews/qa.json
10. code_review_request (PersonaRequestStep)
11. commit_code_review_result (GitArtifactStep) → commits .ma/tasks/{id}/reviews/code-review.json
12. security_request (PersonaRequestStep)
13. commit_security_result (GitArtifactStep) → commits .ma/tasks/{id}/reviews/security.json
14. devops_request (PersonaRequestStep)
15. commit_devops_result (GitArtifactStep) → commits .ma/tasks/{id}/reviews/devops.json
16. mark_task_done (SimpleTaskStatusStep)
```

### in-review-task-flow.yaml (Resume Task in Review)

```
1. code_review_request (PersonaRequestStep)
2. commit_code_review_result (GitArtifactStep) → commits review
3. security_request (PersonaRequestStep)
4. commit_security_result (GitArtifactStep) → commits review
5. devops_request (PersonaRequestStep)
6. commit_devops_result (GitArtifactStep) → commits review
7. mark_task_done (SimpleTaskStatusStep)
```

## Benefits

### 1. Distributed Coordination
- Agents can run on different machines
- Work can be picked up from any point by pulling from git
- No single point of failure

### 2. Audit Trail
- Every workflow step has a git commit
- Full history of planning, implementation, and reviews
- Easy to debug workflow issues

### 3. Failure Recovery
- If agent crashes, another agent can resume from git state
- No lost work - everything committed before failure
- Context, plans, and review results persist

### 4. Performance Optimization
- Context reuse avoids redundant scanning when no code changed
- Cached snapshots reduce startup time for distributed agents

### 5. Human Visibility
- `.ma/` directory provides human-readable artifacts
- Can inspect planning iterations, review results in git
- Summary.md provides overview without scanning repo

## Git Repository Structure

```
repo/
├── .ma/
│   ├── context/
│   │   ├── snapshot.json      # Full scan data
│   │   └── summary.md         # Human-readable summary
│   └── tasks/
│       └── {task-id}/
│           ├── 02-plan-iteration-1.md
│           ├── 02-plan-iteration-2.md
│           ├── 03-plan-final.md
│           └── reviews/
│               ├── qa.json
│               ├── code-review.json
│               ├── security.json
│               └── devops.json
├── src/
│   └── (implementation code)
└── tests/
    └── (test code)
```

## Push Strategy

All steps use **best-effort push**:
- Commit always succeeds (or workflow fails)
- Push is attempted but failure is logged, not fatal
- Allows workflow to continue even with network issues
- Distributed agents can pull later when network recovers

## Context Caching Logic

ContextStep checks if rescan is needed:

```typescript
// Check .ma/context/snapshot.json mtime
// Quick scan of sample files to check modification times
// If no files modified since last scan:
//   - Load .ma/context/snapshot.json
//   - Set reused_existing: true
//   - Skip writing/committing (no changes)
// Else:
//   - Perform full scanRepo()
//   - Write snapshot.json and summary.md
//   - Commit and push to git
```

## Testing

Test mode supports `SKIP_GIT_OPERATIONS` context variable:
- ContextStep skips writing artifacts
- GitArtifactStep returns `bypassed: true`
- PlanningLoopStep skips commits
- Allows testing workflow logic without git

## Migration Notes

### Breaking Changes
None - existing workflows continue to work.

### New Dependencies
- GitArtifactStep must be registered in WorkflowEngine
- ContextStep must be registered in WorkflowEngine

### Workflow Updates Required
- Replace `PersonaRequestStep` for context with `ContextStep`
- Add `GitArtifactStep` after review persona requests

### Environment Variables
No new env vars required.

## Future Enhancements

1. **Git LFS for large artifacts** - If reviews include screenshots/videos
2. **Compression** - snapshot.json can be large for big repos
3. **Incremental scans** - Only scan changed directories
4. **Remote artifact storage** - S3/blob storage for .ma/ artifacts
5. **Artifact retention** - Clean up old review results after N days

## Troubleshooting

### Context not finding files
- Check excludePatterns in ContextStep config
- Verify repo_root points to correct directory
- Check .ma/context/snapshot.json exists and has files array

### Git push failures
- Check git remote is configured: `git remote -v`
- Verify branch exists: `git branch -a`
- Check network connectivity
- Review logs for "Failed to push artifact" warnings

### Review results not committed
- Verify GitArtifactStep depends_on review persona step
- Check source_output matches persona step name + "_result"
- Verify artifact_path starts with ".ma/"

### Distributed agent not finding artifacts
- Ensure git pull executed before workflow starts
- Check branch matches (agents must be on same branch)
- Verify .ma/ directory committed (not in .gitignore)
