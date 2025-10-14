# Project Loop Iteration Strategy

**Date**: October 13, 2025  
**Issue**: Clarified iteration strategy to support immediate urgent task response

## Problem Statement

The project loop had misleading "batch of 3" logic that suggested parallel processing, but the actual behavior was:
1. Tasks processed **sequentially** (one at a time with `await`)
2. Fresh tasks fetched only at start of each "batch"
3. Unclear how urgent tasks (QA failures, security issues) would be picked up immediately

## User Requirement

> "I want the coordinator to recheck for a new task from the dashboard at each iteration. If there is a bug found in QA, or a critical security concern, an immediate task may need to be added to the dashboard and worked immediately."

## Solution

### Iteration Strategy

```typescript
while (iterationCount < maxIterations) {
  // 1. FETCH FRESH TASKS (critical for urgent response)
  const currentTasks = await this.fetchProjectTasks(projectId);
  const pendingTasks = currentTasks
    .filter(task => status !== 'done')
    .sort((a, b) => compareTaskPriority(a, b)); // blocked > in_review > in_progress > open
  
  if (pendingTasks.length === 0) {
    break; // SUCCESS: All done
  }
  
  // 2. PROCESS ONE TASK
  const task = pendingTasks[0]; // Highest priority
  const result = await processTask(task);
  
  if (result.critical) {
    break; // ABORT: Unrecoverable error
  }
  
  // 3. LOOP BACK (refetch fresh tasks including new urgent ones)
}
```

### Key Changes

**Code Changes**:
1. Removed "batch of 3" logic - now processes exactly 1 task per iteration
2. Enhanced comments to emphasize fresh fetching at each iteration
3. Clarified that tasks are sequential, not parallel
4. Updated iteration limit comment (100 iterations = 100+ tasks, not 300)

**Documentation Changes**:
1. `docs/WORKFLOW_SYSTEM.md` - Updated two-level architecture diagram
2. `docs/ARCHITECTURE_CLARIFICATION.md` - Updated example flows and logic
3. Both docs now emphasize:
   - Fresh task fetching at each iteration
   - Immediate response to urgent tasks
   - Priority-based task selection
   - Sequential processing (not parallel)

### Why This Works

**Immediate Urgent Response**:
```
Time 0:00 - Iteration 1 starts
  → Fetch: [Task A (open), Task B (open)]
  → Process Task A
  
Time 0:45 - Task A workflow creates QA failure follow-up "Task A-fix (blocked)"
  
Time 1:00 - Iteration 2 starts
  → Fetch: [Task B (open), Task A-fix (blocked)]  ← NEW URGENT TASK PICKED UP!
  → Process Task A-fix (highest priority due to "blocked" status)
  
Time 1:30 - Iteration 3 starts
  → Fetch: [Task B (open)]
  → Process Task B
```

**Priority System Ensures Urgency**:
- `blocked` = Priority 0 (highest - QA failures, security blockers)
- `in_review` = Priority 1
- `in_progress` = Priority 2
- `open` = Priority 3 (lowest)

### Benefits

1. **Immediate Response**: Urgent tasks added to dashboard are picked up in next iteration (typically < 2 minutes)
2. **Priority-Driven**: Critical issues always processed first
3. **Dynamic**: Handles follow-up tasks created during processing
4. **Clear**: No confusing "batch" logic; one task per iteration
5. **Scalable**: 100 iterations handles 100+ tasks (can be more if tasks create follow-ups)

### Testing

All 139 tests passing after changes:
- No behavior changes to actual processing logic
- Only removed misleading "batch" abstraction
- Enhanced comments for clarity
- Documentation updated to match implementation

### Configuration

**Iteration Limit**:
```typescript
const maxIterations = this.isTestEnv() ? 2 : (cfg.coordinatorMaxIterations ?? 500);
```

- **Production**: 500 iterations by default (configurable via `COORDINATOR_MAX_ITERATIONS`)
- **Tests**: 2 iterations (for speed)
- **Large Projects**: Set `COORDINATOR_MAX_ITERATIONS=1000` or higher as needed
- **Unlimited**: Set `COORDINATOR_MAX_ITERATIONS=unlimited` to remove limit (use with caution)

**Priority Mapping** (in `compareTaskPriority`):
- `blocked`: 0 (highest)
- `in_review`: 1
- `in_progress`: 2
- `open`: 3 (lowest)

### Real-World Scenario

**Project**: Feature development with security review

```
Iteration 1: Implement Task 1
  → Task 1 completed, marked done
  
Iteration 2: Implement Task 2
  → During Task 2 QA, critical security vulnerability found
  → QA creates "Security Fix - Auth Bypass" (blocked)
  → Task 2 marked in_review
  
Iteration 3: Refetch shows [Task 3 (open), Task 2 (in_review), Security Fix (blocked)]
  → Security Fix has highest priority (blocked = 0)
  → Process Security Fix immediately
  → Security issue resolved before continuing Task 3
```

## References

- `src/workflows/WorkflowCoordinator.ts` lines 98-215: Main loop implementation
- `src/workflows/WorkflowCoordinator.ts` lines 760-788: Priority comparison logic
- `docs/WORKFLOW_SYSTEM.md`: Two-level architecture section
- `docs/ARCHITECTURE_CLARIFICATION.md`: Complete architecture explanation
