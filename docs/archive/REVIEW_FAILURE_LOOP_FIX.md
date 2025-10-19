# Review Failure Loop Fix

## Problem

The code review stage was pushing review logs multiple times (6 iterations observed) because:

1. **Code review fails** → PM evaluates → Returns `status: "pass"` (meaning PM decision accepted)
2. **Task remains in `in_review` status** → Coordinator refetches tasks → Finds same task still `in_review`
3. **Routes back to `in-review-task-flow`** → Runs code review again → **LOOP!**

The PM step was **not creating tasks** or **changing task status**, causing an infinite loop.

## Root Cause

After PM prioritization steps (`pm_prioritize_code_review_failures`, `pm_prioritize_security_failures`):
- ❌ No step to create the recommended follow-up tasks
- ❌ No step to change the original task status 
- ❌ Task stayed in `in_review` state
- ❌ Coordinator picked it up again in next iteration

## Solution

### 1. New Step Type: `ReviewFailureTasksStep`

Created `src/workflows/steps/ReviewFailureTasksStep.ts` that:
- **Parses PM decision** from the review failure evaluation
- **Creates urgent tasks** for SEVERE/HIGH issues with `priority_score: 1000+`
- **Creates backlog tasks** for MEDIUM/LOW issues with `priority_score: 50`
- **Links tasks** to the original task as parent
- **Formats task descriptions** with review context and PM reasoning

### 2. Updated Workflows

Both `in-review-task-flow.yaml` and `legacy-compatible-task-flow.yaml` now have:

```yaml
# After PM prioritization:
  
# Create follow-up tasks from PM decision
- name: create_code_review_followup_tasks
  type: ReviewFailureTasksStep
  description: "Create urgent follow-up tasks for code review failures"
  depends_on: ["pm_prioritize_code_review_failures"]
  config:
    pmDecisionVariable: "pm_code_review_decision"
    reviewType: "code_review"
    urgentPriorityScore: 1000  # Urgent tasks jump to front
    deferredPriorityScore: 50
    backlogMilestoneSlug: "future-enhancements"

# Mark original task as blocked to exit loop
- name: mark_task_needs_rework
  type: SimpleTaskStatusStep
  description: "Mark original task as blocked to prevent loop"
  depends_on: ["create_code_review_followup_tasks"]
  config:
    status: "blocked"
    comment: "Code review failed - urgent follow-up tasks created"
```

Same pattern applied for security review failures with `urgentPriorityScore: 1500`.

### 3. Priority-Based Task Scheduling

Updated `WorkflowCoordinator.compareTaskPriority()` to prioritize tasks by:

**Priority Order:**
1. **`priority_score`** (higher score = higher priority)
   - Urgent review tasks: 1000-1500
   - Normal tasks: 0 (default)
   - Backlog tasks: 50
2. **Status-based priority**
   - blocked: 0
   - in_review: 1
   - in_progress: 2
   - open: 3
3. **Task order/position**

This ensures **urgent follow-up tasks** created from review failures are **immediately picked up** by the coordinator, even if the original task was `in_review`.

## How It Works Now

### Flow with Code Review Failure:

```
1. Task in "in_review" status
   ↓
2. Code review finds SEVERE/HIGH issues → status: "fail"
   ↓
3. PM evaluates → Creates follow_up_tasks JSON
   ↓
4. ReviewFailureTasksStep:
   - Creates Task A: "🚨 URGENT [Code Review] Fix compile errors" (priority_score: 1000)
   - Creates Task B: "📋 [Code Review] Refactor for maintainability" (priority_score: 50, backlog)
   ↓
5. SimpleTaskStatusStep: Marks original task as "blocked"
   ↓
6. Coordinator refetches tasks:
   - Task A (priority_score: 1000) → **Picked FIRST**
   - Original task (status: blocked) → Lower priority
   - Task B (priority_score: 50, backlog milestone) → Lowest priority
   ↓
7. No loop! Urgent task processed immediately
```

### Flow with Security Review Failure:

Same pattern with:
- `urgentPriorityScore: 1500` (even higher priority)
- Tasks created with security context
- Original task marked as `blocked`

## Benefits

### ✅ **Prevents Infinite Loops**
- Original task exits `in_review` state immediately
- No repeated code review scanning

### ✅ **Prioritizes Urgent Work**
- SEVERE/HIGH issues get immediate attention
- Urgent tasks (score: 1000+) jump ahead of normal tasks (score: 0)

### ✅ **Organizes Work Properly**
- Urgent fixes go to same milestone
- MEDIUM/LOW improvements go to backlog
- Clear parent-child task relationships

### ✅ **Distributed Coordination**
- New urgent tasks visible to all workers
- Priority scoring works across machines
- Dashboard shows clear task hierarchy

## Configuration

### Priority Scores:

```typescript
// In ReviewFailureTasksStep config:
urgentPriorityScore: 1000      // SEVERE/HIGH issues (critical/high priority)
deferredPriorityScore: 50      // MEDIUM/LOW issues (backlog)
```

For security reviews:
```typescript
urgentPriorityScore: 1500      // Even higher for security issues
```

### Task Routing:

- **Urgent tasks**: Same milestone as original task
- **Deferred tasks**: `future-enhancements` milestone (backlog)

## Testing

To verify the fix works:

1. Create a task with code that will fail review (e.g., syntax errors)
2. Watch the coordinator logs:
   - Code review fails
   - PM evaluates
   - Follow-up tasks created
   - Original task marked blocked
   - Urgent task picked up next iteration
3. Check dashboard:
   - Original task: status = "blocked"
   - New urgent task: priority_score = 1000+
   - Task hierarchy visible

## Files Modified

1. **New Step Type:**
   - `src/workflows/steps/ReviewFailureTasksStep.ts`

2. **Workflow Engine:**
   - `src/workflows/WorkflowEngine.ts` (registered new step)

3. **Coordinator:**
   - `src/workflows/WorkflowCoordinator.ts` (priority scoring)

4. **Workflows:**
   - `src/workflows/definitions/in-review-task-flow.yaml`
   - `src/workflows/definitions/legacy-compatible-task-flow.yaml`

## Related Documentation

- [REVIEW_SYSTEM_WITH_SEVERITY.md](./REVIEW_SYSTEM_WITH_SEVERITY.md) - Severity-based review system
- [WORKFLOW_SYSTEM.md](./WORKFLOW_SYSTEM.md) - Workflow engine architecture
- [TASK_LOGGING.md](./TASK_LOGGING.md) - Task logging patterns

## Future Enhancements

Potential improvements:

1. **Configurable thresholds**: Allow per-project priority scores
2. **Auto-assignment**: Assign urgent tasks to specific personas
3. **SLA tracking**: Monitor time from review failure to fix completion
4. **Escalation**: Auto-escalate if urgent tasks aren't picked up quickly
5. **Batch limits**: Prevent too many urgent tasks from one review failure
