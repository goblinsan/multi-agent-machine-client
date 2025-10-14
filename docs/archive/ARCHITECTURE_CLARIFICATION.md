# Architecture Clarification: Project Loop vs Workflow Execution

**Date**: October 13, 2025  
**Issue**: Confusion about top-level workflow variables and project continuation logic

## Problem Statement

The `project-loop.yml` workflow had top-level variables (`max_retries`, `timeout_minutes`) that suggested the entire project loop would timeout or abort after those limits. This was **misleading** because:

1. Individual personas have their own `timeout` and `retries` per step
2. The project should continue processing all dashboard tasks until completion
3. Only critical errors should abort the entire project loop

## Solution

### Two-Level Architecture

```
LEVEL 1: PROJECT LOOP (WorkflowCoordinator)
│
├─ Responsibility: Process ALL pending tasks
├─ Continuation Logic: 
│  ├─ ✓ Continue: While tasks exist with status != 'done'
│  ├─ ✓ Success Exit: When all tasks complete
│  └─ ✗ Abort: Only on critical workflow failure
│
└─> LEVEL 2: WORKFLOW EXECUTION (WorkflowEngine)
    │
    ├─ Responsibility: Process ONE task through steps
    ├─ Per-Step Configuration:
    │  ├─ Individual timeout (e.g., planning: 1800s)
    │  └─ Individual retries (e.g., planning: 2 attempts)
    │
    └─ Return: success or failure to Project Loop
```

### What Changed

**1. `workflows/project-loop.yml`**:
- **Removed**: Misleading `max_retries: 3` and `timeout_minutes: 30` variables
- **Kept**: Specific timeout variables for each persona (`planning_timeout`, `implementation_timeout`, `qa_timeout`)
- **Added**: Comment explaining that this workflow processes ONE task, while WorkflowCoordinator loops through ALL tasks

**2. `docs/WORKFLOW_SYSTEM.md`**:
- **Added**: "Two-Level Architecture" section with clear visual hierarchy
- **Updated**: Component descriptions to clarify Project Loop vs Workflow Execution
- **Clarified**: YAML structure example with comments about independence of per-step timeouts/retries
- **Documented**: Completion conditions (all tasks done vs critical error abort)

## Key Takeaways

### ✅ What IS Configured Per-Workflow
- Individual step timeouts (seconds)
- Individual step retries (count)
- Step dependencies and execution order
- Conditional logic for step execution

### ✅ What IS Controlled by WorkflowCoordinator
- Looping through all pending tasks
- Refetching fresh tasks from dashboard at each iteration
- Processing 1 task per iteration (sequential, not parallel)
- Priority-based task selection (blocked > in_review > in_progress > open)
- Project-level continuation until all tasks complete
- Abort decision on critical failures
- Safety iteration limit (500 by default, configurable via `COORDINATOR_MAX_ITERATIONS`)

### ❌ What Does NOT Exist
- Workflow-level timeout that stops the entire project
- Workflow-level max_retries that aborts after N task failures
- Global timeout for processing all dashboard tasks

## Example Flow

```yaml
# A project has 5 tasks, QA creates 2 urgent follow-ups

Iteration 1:
  Fetch tasks: [Task 1 (open), Task 2 (open), Task 3 (open), Task 4 (open), Task 5 (open)]
  Process: Task 1
    - Planning ✓
    - Implementation ✓
    - QA ✓
    → Success

Iteration 2:
  Fetch tasks: [Task 2 (open), Task 3 (open), Task 4 (open), Task 5 (open)]
  Process: Task 2
    - Planning ✓
    - Implementation ✓
    - QA ✗ Test failures detected
    → QA creates 2 urgent follow-up tasks
    → Task 2 marked as in_review
    → Continue (not critical)

Iteration 3:
  Fetch tasks: [Task 2 (in_review), Task 3 (open), Task 4 (open), Task 5 (open), 
                Task 2a (blocked - QA fix), Task 2b (blocked - QA fix)]
  Process: Task 2a (highest priority - blocked)
    - Planning ✓
    - Implementation ✓
    - QA ✓
    → Success

Iteration 4:
  Fetch tasks: [Task 2 (in_review), Task 3 (open), Task 4 (open), Task 5 (open), 
                Task 2b (blocked)]
  Process: Task 2b
    - Planning ✓
    - Implementation ✗ Git conflict (unrecoverable)
    → ABORT PROJECT LOOP

Tasks 3-5: Not processed due to abort

Note: Fresh fetching at each iteration allows immediate response to 
      urgent tasks added during processing (QA failures, security issues).
      With 100 max iterations, system handles 100+ tasks.
```

## Implementation Notes

### WorkflowCoordinator Logic
```typescript
// Safety limit: 500 iterations by default (configurable) to prevent infinite loops
// Each iteration processes 1 task after fetching fresh list from dashboard
const maxIterations = this.isTestEnv() ? 2 : (cfg.coordinatorMaxIterations ?? 500);

while (iterationCount < maxIterations) {
  // CRITICAL: Fetch fresh tasks at each iteration
  // Allows immediate response to urgent tasks added during processing
  const pendingTasks = await fetchPendingTasks(projectId);
  
  if (pendingTasks.length === 0) {
    // SUCCESS: All tasks done
    break;
  }
  
  // Sort by priority: blocked > in_review > in_progress > open
  pendingTasks.sort((a, b) => compareTaskPriority(a, b));
  
  // Process highest priority task
  const task = pendingTasks[0];
  const result = await workflowEngine.executeWorkflow(task);
  
  if (!result.success && result.critical) {
    // ABORT: Critical error (git conflict, unrecoverable failure)
    abortProjectLoop();
    break;
  }
  
  // Continue to next iteration (refetch tasks) even if non-critical failure
  // This allows QA follow-ups, security issues to be picked up immediately
}

// Warn if hit iteration limit with tasks remaining
if (iterationCount >= maxIterations) {
  logger.warn("Hit maximum iteration limit", {
    maxIterations,
    remainingTasks: await getRemainingTaskCount(projectId)
  });
}
```

### Per-Persona Configuration
```yaml
steps:
  - id: "planning"
    persona: "implementation-planner"
    timeout: 1800    # This persona gets 30 minutes
    retries: 2       # Will retry twice on failure
    
  - id: "implementation"
    persona: "lead-engineer"
    timeout: 3600    # This persona gets 60 minutes
    retries: 1       # Will retry once on failure
```

## Testing

All 139 tests passing after clarification changes:
- No code behavior changed
- Only documentation and comments updated
- Test suite duration: ~7.5s

## References

- `src/workflows/WorkflowCoordinator.ts` lines 98-180: Project loop logic
- `src/workflows/WorkflowEngine.ts` lines 200-250: Single workflow execution
- `workflows/project-loop.yml`: Updated with clarifying comments
- `docs/WORKFLOW_SYSTEM.md`: Comprehensive two-level architecture documentation
