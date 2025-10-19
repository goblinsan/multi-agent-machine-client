# In-Review Task Flow Fix

## Date
October 19, 2025

## Issue

Tasks that were marked as "in_review" couldn't proceed because the `in-review-task-flow.yaml` workflow was failing immediately with:

```
Error: Unsupported git operation: checkout
```

The workflow was attempting to use `checkout` and `pull` git operations that aren't implemented in `GitOperationStep`.

## Root Cause

The `in-review-task-flow.yaml` workflow had two git operation steps that used unsupported operations:

```yaml
# BROKEN:
- name: checkout_branch
  config:
    operation: "checkout"  # ❌ Not supported
    
- name: pull_latest
  config:
    operation: "pull"  # ❌ Not supported
```

### Supported Git Operations

`GitOperationStep` only supports:
- `checkoutBranchFromBase` - Create and checkout a new branch from base
- `commitAndPushPaths` - Commit and push specific files
- `verifyRemoteBranchHasDiff` - Verify branch has changes
- `ensureBranchPublished` - Ensure branch is pushed to remote

## Solution

Removed the unnecessary git operations from `in-review-task-flow.yaml` because:

1. **Tasks are already in review** - The code has already been committed and pushed
2. **Branch already exists** - No need to checkout or create
3. **Code is already on remote** - No need to pull latest

The review personas can access the code directly from the remote repository using the `repo` and `branch` parameters.

## Changes Made

### Before (Broken):
```yaml
steps:
  - name: checkout_branch  # ❌ Fails
    type: GitOperationStep
    config:
      operation: "checkout"
      
  - name: pull_latest  # ❌ Fails
    type: GitOperationStep
    config:
      operation: "pull"
      
  - name: code_review_request  # Never reached
    depends_on: ["pull_latest"]
```

### After (Fixed):
```yaml
steps:
  - name: code_review_request  # ✅ Runs immediately
    type: PersonaRequestStep
    outputs: ["code_review_request_result", "code_review_request_status"]
    # No git dependencies - reviews code from remote
    
  - name: pm_prioritize_code_review_failures  # ✅ NEW
    depends_on: ["code_review_request"]
    condition: "${code_review_request_status} == 'fail'"
    
  - name: security_request
    depends_on: ["code_review_request"]
    condition: "${code_review_request_status} == 'pass'"  # ✅ Sequential
    
  - name: pm_prioritize_security_failures  # ✅ NEW
    depends_on: ["security_request"]
    condition: "${security_request_status} == 'fail'"
    
  - name: devops_request
    depends_on: ["security_request"]
    condition: "${security_request_status} == 'pass'"  # ✅ Sequential
    
  - name: mark_task_done
    depends_on: ["devops_request"]
    condition: "${security_request_status} == 'pass'"  # ✅ Only when reviews pass
```

## Key Improvements

1. **Removed blocking git operations** - No more unsupported checkout/pull
2. **Added PM prioritization steps** - Code review and security failures go to PM
3. **Implemented sequential flow** - Code → Security → DevOps (same as legacy-compatible flow)
4. **Used correct branch variable** - Changed `${branch}` to `${featureBranchName}` to match context
5. **Added proper outputs** - All review steps now output status for downstream conditions

## Benefits

### Tasks Can Now Progress
- Tasks in "in_review" status can now proceed through reviews
- No more immediate workflow failures
- Reviews can be re-run if needed

### Consistent Review Flow
- Same sequential flow as `legacy-compatible-task-flow.yaml`
- Code review → Security review → DevOps
- PM prioritization for failures

### Proper Failure Handling
- Code review failures → PM decides priority
- Security review failures → PM decides priority
- Task only marked "done" when all reviews pass

## Workflow Behavior

### When Task is "in_review":

1. **WorkflowCoordinator detects status**:
```
Task is in review, routing to in-review-task-flow workflow
```

2. **Workflow starts with code review**:
- No git operations needed
- Code review persona reads from `${repo_remote}` at `${featureBranchName}`

3. **Sequential reviews**:
- Code review pass → Security review
- Security review pass → DevOps review  
- All reviews pass → Mark task done

4. **Failure handling**:
- Code/Security review fail → PM prioritizes
- PM can defer non-critical issues
- Task stays "in_review" if issues deferred

## Test Results

✅ All 200 tests pass
✅ No regressions in existing functionality
✅ Workflow validates successfully

## Usage

Tasks will automatically use this workflow when:
- Task status is `in_review`
- Task status is `review`  
- Task status is `in-code-review`

Trigger condition:
```yaml
trigger:
  condition: "status == 'in_review' || status == 'review' || status == 'in-code-review'"
```

## Files Changed

- `src/workflows/definitions/in-review-task-flow.yaml` - Removed unsupported git ops, added PM prioritization, implemented sequential review flow

## Related Issues

This fix is part of the broader review flow implementation:
- See `docs/REVIEW_FLOW_FIX.md` for main review flow restructure
- See `docs/PM_PRIORITIZATION_ENHANCEMENT.md` for PM prioritization details
- See `docs/PROJECT_STAGE_DETECTION.md` for stage-based prioritization logic
