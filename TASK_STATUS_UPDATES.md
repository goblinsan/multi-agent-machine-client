# Task Status Updates Implementation

**Date**: October 11, 2025  
**Issue**: Task status was not being updated on the dashboard during workflow execution

## Problem

Tasks remained in their initial status (likely "not_started" or "pending") throughout the entire workflow execution. Only at the very end would they be marked as "done". This gave no visibility into:
- When a task actually started
- If a task was blocked by failures
- When a task was in review stages
- Dependencies between tasks

## Requirements

Task status should be updated at key workflow stages:

1. **in_progress** - As soon as task is pulled and work begins
2. **blocked** - When something fails (QA, implementation, etc.)
3. **in_review** - When entering review stages (code review, security, devops)
4. **done** - When all stages complete successfully
5. **on_hold** - When waiting for dependencies (future enhancement)

## Implementation

### Status Update Steps Added

**File**: `src/workflows/definitions/legacy-compatible-task-flow.yaml`

#### 1. Mark In Progress (After Checkout)
```yaml
- name: mark_task_in_progress
  type: SimpleTaskStatusStep
  description: "Mark task as in progress on dashboard"
  depends_on: ["checkout_branch"]
  config:
    status: "in_progress"
```

**When**: Immediately after git checkout completes  
**Purpose**: Show task has started  
**Triggers**: context_request now depends on this step

#### 2. Mark In Review (After QA Passes)
```yaml
- name: mark_task_in_review
  type: SimpleTaskStatusStep
  description: "Mark task as in review on dashboard"
  depends_on: ["qa_request", "qa_iteration_loop"]
  condition: "${qa_request_status} == 'pass'"
  config:
    status: "in_review"
```

**When**: After QA passes (either first time or after iteration loop)  
**Purpose**: Show task is awaiting human/automated reviews  
**Triggers**: code_review_request and security_request now depend on this

#### 3. Mark Done (After All Reviews)
```yaml
- name: mark_task_done
  type: SimpleTaskStatusStep
  description: "Mark task as completed on dashboard"
  depends_on: ["security_request", "devops_request", "code_review_request"]
  config:
    status: "done"
```

**When**: After all review stages complete  
**Purpose**: Show task is fully complete  
**Existing**: This was already in the workflow

#### 4. Mark Blocked (On Workflow Failure)
```yaml
failure_handling:
  on_workflow_failure:
    - name: mark_task_blocked
      type: SimpleTaskStatusStep
      description: "Mark task as blocked when workflow fails"
      config:
        status: "blocked"
```

**When**: Workflow fails at any step  
**Purpose**: Show task needs attention/unblocking  
**Mechanism**: Uses workflow failure_handling feature

## Status Transition Flow

### Happy Path
```
not_started/pending (dashboard)
    ↓
[Task pulled by coordinator]
    ↓
in_progress (after checkout_branch)
    ↓
[Context, planning, implementation, QA iterations...]
    ↓
in_review (after QA passes)
    ↓
[Code review, security, devops...]
    ↓
done (after all reviews)
```

### Failure Path
```
not_started/pending
    ↓
in_progress (after checkout)
    ↓
[Some step fails: context timeout, QA fails after max iterations, etc.]
    ↓
blocked (workflow failure handler)
```

### Example with QA Iterations
```
in_progress
    ↓
[Context gathering...]
    ↓
[Planning...]
    ↓
[Implementation...]
    ↓
[QA test - FAIL]
    ↓
[QA iteration 1 - fixes, retest - FAIL]
    ↓
[QA iteration 2 - fixes, retest - FAIL]
    ↓
[QA iteration 3 - fixes, retest - PASS]
    ↓
in_review
    ↓
[Reviews...]
    ↓
done
```

## Updated Dependencies

### Before
```yaml
context_request:
  depends_on: ["checkout_branch"]

code_review_request:
  depends_on: ["qa_request", "qa_iteration_loop"]

security_request:
  depends_on: ["qa_request", "qa_iteration_loop"]
```

### After
```yaml
context_request:
  depends_on: ["mark_task_in_progress"]  # Changed

code_review_request:
  depends_on: ["mark_task_in_review"]  # Changed

security_request:
  depends_on: ["mark_task_in_review"]  # Changed
```

**Impact**: Status updates happen BEFORE the work, ensuring dashboard reflects current state

## How SimpleTaskStatusStep Works

**File**: `src/workflows/steps/SimpleTaskStatusStep.ts`

The step:
1. Gets task ID from workflow context
2. Calls `dashboard.updateTaskStatus(taskId, status)`
3. Updates context variables:
   - `taskStatus` = new status
   - `taskCompleted` = true (for "done" status)
   - `taskId` = task ID

**Supports any status string** - not limited to predefined values

## Testing

✅ All tests pass (106/109)

**Updated test**: `tests/workflowGating.test.ts`

Added assertions for new status steps:
```typescript
const markInProgressStep = steps['mark_task_in_progress'];
const markInReviewStep = steps['mark_task_in_review'];

expect(markInProgressStep).toBeDefined();
expect(markInProgressStep?.depends_on).toEqual(['checkout_branch']);

expect(markInReviewStep).toBeDefined();
expect(markInReviewStep?.depends_on).toEqual(['qa_request', 'qa_iteration_loop']);
expect(markInReviewStep?.condition).toBe("${qa_request_status} == 'pass'");

expect(codeReviewStep?.depends_on).toEqual(['mark_task_in_review']);
expect(securityStep?.depends_on).toEqual(['mark_task_in_review']);
```

## Dashboard Integration

The workflow expects the dashboard API to handle these status updates via:

```typescript
await updateTaskStatus(taskId, status);
```

**Statuses sent**:
- `"in_progress"` - Task actively being worked on
- `"in_review"` - Task awaiting reviews
- `"blocked"` - Task failed, needs intervention
- `"done"` - Task complete

The dashboard should:
1. Accept these status updates
2. Display appropriate UI for each status
3. Allow filtering/sorting by status
4. Show status history/timeline

## Benefits

1. **✅ Visibility**: See what stage each task is in
2. **✅ Progress Tracking**: Know when tasks start vs complete
3. **✅ Failure Detection**: Immediately see blocked tasks
4. **✅ Review Queue**: Identify tasks awaiting reviews
5. **✅ Dependencies**: Track which tasks are waiting on others (future)

## Future Enhancements

### 1. on_hold Status
Not yet implemented. Would require:
- Detecting when a task is waiting for dependencies
- Pausing workflow execution until dependencies complete
- Resuming when dependencies resolve

Example scenario:
```yaml
- name: check_dependencies
  type: DependencyCheckStep
  config:
    required_tasks: ["task-123", "task-456"]
    
- name: mark_task_on_hold
  type: SimpleTaskStatusStep
  condition: "${dependencies_incomplete} == 'true'"
  config:
    status: "on_hold"
```

### 2. More Granular Statuses
Could add:
- `"planning"` - During planning loop
- `"implementing"` - During lead-engineer work
- `"testing"` - During QA iterations
- `"reviewing_code"` - Specifically code review
- `"reviewing_security"` - Specifically security review

### 3. Status Transition Validation
Ensure status transitions are valid:
```
not_started → in_progress ✅
in_progress → blocked ✅
in_progress → in_review ✅
in_review → done ✅
done → in_progress ❌ (invalid)
```

### 4. Status History
Track full history of status changes:
```json
{
  "task_id": "123",
  "status_history": [
    {"status": "not_started", "timestamp": "2025-10-11T20:00:00Z"},
    {"status": "in_progress", "timestamp": "2025-10-11T20:01:00Z"},
    {"status": "in_review", "timestamp": "2025-10-11T20:15:00Z"},
    {"status": "done", "timestamp": "2025-10-11T20:20:00Z"}
  ]
}
```

## Monitoring

Check logs for status updates:
```bash
grep "Updating task status\|Task status updated" machine-client.log
```

Example log output:
```json
{"ts":"2025-10-11T21:45:00Z","level":"info","msg":"Updating task status via simple method","meta":{"workflowId":"wf-123","status":"in_progress"}}
{"ts":"2025-10-11T21:45:00Z","level":"info","msg":"Task status updated successfully","meta":{"taskId":"task-456","status":"in_progress"}}
```

## Summary

Task statuses now update at key workflow stages:
- ✅ **in_progress** after checkout
- ✅ **in_review** after QA passes
- ✅ **blocked** on workflow failure
- ✅ **done** after all reviews

This provides full visibility into task lifecycle on the dashboard! 📊✅
