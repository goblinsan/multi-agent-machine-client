# Distributed Workflow Push Fix

## Problem
The multi-agent workflow was stuck in an infinite loop where:
1. **Lead engineer** generated implementation diffs
2. **DiffApplyStep** parsed and applied diffs locally, creating a commit
3. **commit_implementation step** tried to commit but found nothing (already committed)
4. **Changes were never pushed to remote**
5. **QA and Context agents** (running on different machines) never saw the changes
6. **Loop repeated infinitely** on the same unchanged code

## Root Cause
- `applyEditOps()` in `src/fileops.ts` committed changes locally but **did not push to remote**
- The workflow had a separate `commit_implementation` GitOperationStep to handle push, but it found nothing to commit
- In a distributed environment, **remote push is mandatory** for other machines to see changes

## Solution

### 1. Added Push to `applyEditOps` (`src/fileops.ts`)
```typescript
// Push changes to remote so distributed agents can see them
// Only push if a remote exists (skip for test repos without remotes)
try {
  const remotes = await runGit(["remote"], { cwd: repoRoot });
  const hasRemote = remotes.stdout.trim().length > 0;
  
  if (hasRemote) {
    await runGit(["push", "origin", branch, "--force"], { cwd: repoRoot });
  } else {
    // Log warning that no remote exists (typically only in tests)
    await writeDiagnostic(repoRoot, 'apply-no-remote.json', {
      branch, sha, changed,
      note: 'No remote configured - skipping push (test environment?)'
    });
  }
} catch (pushErr) {
  // Log and rethrow so workflow knows push failed
  await writeDiagnostic(repoRoot, 'apply-push-failure.json', {
    branch, sha, changed, error: String(pushErr)
  });
  throw new Error(`Failed to push branch ${branch}: ${pushErr}`);
}
```

**Benefits:**
- ✅ Changes immediately available on remote for distributed agents
- ✅ Push failure causes workflow to abort (enforced by throw)
- ✅ Gracefully handles test repos without remotes (skips push)
- ✅ Diagnostic logging for troubleshooting
- ✅ Force push ensures branch state matches local changes

### 2. Removed Redundant Workflow Step (`legacy-compatible-task-flow.yaml`)

**Before:**
```yaml
- name: apply_implementation_edits
  type: DiffApplyStep
  ...

- name: commit_implementation
  type: GitOperationStep
  depends_on: ["apply_implementation_edits"]
  config:
    operation: "commitAndPushPaths"
    ...

- name: verify_diff
  depends_on: ["commit_implementation"]
  ...
```

**After:**
```yaml
- name: apply_implementation_edits
  type: DiffApplyStep
  description: "Parse, apply, commit, and push implementation edits"
  ...

- name: verify_diff
  type: GitOperationStep
  depends_on: ["apply_implementation_edits"]  # Direct dependency
  ...
```

## Workflow Enforcement

### Start
- ✅ Coordinator receives project ID from dashboard
- ✅ Pulls task with correct status/priority
- ✅ Ensures branch is clean for milestone

### Context Agent
- ✅ Checks if new scan needed (compares commits)
- ✅ If needed, pushes scan to remote via `applyEditOps`
- ✅ If not needed, responds "no changes since last scan"

### Implementation Loop
- ✅ Creates plan based on task goal/acceptance criteria
- ✅ Plan sent to evaluator agent
- ✅ Engineer implements the plan
- ✅ **DiffApplyStep applies, commits, AND pushes** (enforced)
- ✅ Workflow aborts on push failure (enforced)
- ✅ Workflow aborts if no changes after diff application (enforced in DiffApplyStep)

### QA Testing
- ✅ On fail: returns to planning loop (context → plan → eval → implement → QA)
- ✅ On pass: task marked as `in_review`

### Code Review → Security → Completion
- ✅ Reviews run on pushed changes
- ✅ Failures go to PM for prioritization
- ✅ Success marks task complete, pulls next task

## Testing Recommendations

1. **Test push failures** - Verify workflow aborts with diagnostic
2. **Test no-change scenarios** - Verify workflow aborts when diff produces no changes
3. **Test distributed agents** - Verify context/QA agents see pushed changes
4. **Test context scan caching** - Verify scans only pushed when needed

## Related Files
- `src/fileops.ts` - Core fix (push after commit)
- `src/workflows/definitions/legacy-compatible-task-flow.yaml` - Workflow simplification
- `src/artifacts.ts` - Context scans also use `applyEditOps` (now includes push)
- `src/workflows/steps/DiffApplyStep.ts` - Validates non-empty changes
- `src/gitUtils.ts` - `commitAndPushPaths` function (still used by QA iteration loop)

## Migration Notes
- **No breaking changes** - `applyEditOps` return signature unchanged
- **Workflow YAML** requires manual update (remove redundant commit step)
- **Tests** may need updating if they mock `applyEditOps` without expecting push
