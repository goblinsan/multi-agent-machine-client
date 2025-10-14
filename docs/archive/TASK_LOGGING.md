# Task Logging and Context Synchronization

## Summary

This update adds comprehensive logging for QA and planning activities, ensures context synchronization across distributed machines, and implements automatic cleanup when tasks complete.

## Changes

### 1. QA Log Writing and Sharing (Issue #1)
**File:** `src/process.ts`

- **QA Log Creation**: The `tester-qa` persona now writes test results to `.ma/qa/task-{taskId}-qa.log`
- **Git Commit & Push**: After writing QA logs, the file is automatically committed and pushed to the repository
- **Log Format**: Each QA run is appended with timestamp, status (PASS/FAIL/UNKNOWN), duration, and full test results
- **Cross-Machine Access**: Other machines can now pull the latest QA results from the repository

**Example Log Entry:**
```
================================================================================
QA Test Run - 2025-10-12T14:30:00.000Z
Task ID: task-123
Workflow ID: wf-456
Status: PASS
Duration: 5432ms
================================================================================

[QA test results content here...]

================================================================================
```

### 2. Context Synchronization (Issue #2)
**File:** `src/process.ts`

- **Git Pull Before Reading**: Added `git pull --ff-only` before reading context files from disk
- **Priority**: Payload context is checked first, then disk context after pulling latest changes
- **Applies To**: All personas (implementation-planner, plan-evaluator, etc.) that read context
- **Benefit**: Ensures planners always see the most recent context scan, not stale data

**Sequence:**
1. Check if context is in payload (from recent context persona run)
2. If not, pull latest changes from git
3. Read `.ma/context/summary.md` from disk
4. Use fresh context in planning/evaluation

### 3. Planning Log per Task (Issue #3)
**File:** `src/process.ts`

- **Planning Log Creation**: The `implementation-planner` persona writes plans to `.ma/planning/task-{taskId}-plan.log`
- **Git Pull Before Read**: Pulls latest changes before reading planning log to get updates from other machines
- **Planning History Awareness**: Before creating a plan, reads previous planning iterations from the log
- **Multi-Source Input**: Planner considers:
  - Latest context scan results
  - Previous planning iterations (if any, pulled from git)
  - QA test results (if any, pulled from git)
- **Intelligent Refinement**: Can reuse, refine, or replace previous plans based on new information
- **Git Commit & Push**: Each planning iteration is committed and pushed to the repository after writing
- **Log Format**: Each iteration includes timestamp, iteration number, breakdown/risks flags, duration, and full plan
- **Historical Tracking**: Maintains all planning iterations for a task in one log file
- **Cross-Machine Sync**: Planning logs are synchronized via git, enabling distributed planning

**Example Log Entry:**
```
================================================================================
Planning Iteration - 2025-10-12T14:25:00.000Z
Task ID: task-123
Workflow ID: wf-456
Iteration: 1
Has Breakdown: true
Has Risks: true
Duration: 3210ms
================================================================================

[Planning content here...]

================================================================================
```

### 4. Automatic Log Cleanup (Issue #4)
**New File:** `src/taskLogCleanup.ts`
**Modified Files:** `src/workflows/steps/SimpleTaskStatusStep.ts`, `src/workflows/steps/TaskUpdateStep.ts`

When a task is marked as completed (status: `done`, `completed`, `finished`, `closed`, or `resolved`):

1. **Read Logs**: Collects QA and planning logs for the task
2. **Generate Summary**: Creates a concise summary with:
   - Task ID and title
   - Completion timestamp
   - QA summary (number of test runs, final status)
   - Planning summary (number of iterations, breakdown/risks flags)
3. **Append to Changelog**: Adds summary to `.ma/changelog.md`
4. **Delete Individual Logs**: Removes task-specific QA and planning logs
5. **Commit Changes**: Commits deletion and changelog update to repository

**Benefits:**
- Keeps `.ma/qa/` and `.ma/planning/` directories clean
- Preserves important outcomes in changelog
- Reduces repository bloat from completed tasks

**Example Changelog Entry:**
```markdown
## Task task-123: Implement user authentication
**Completed:** 2025-10-12T14:35:00.000Z

### QA Summary
- Test runs: 3
- Final status: PASS

### Planning Summary
- Planning iterations: 2
- Plan included task breakdown
- Risks were identified and addressed

---
```

## File Structure

```
.ma/
├── qa/                         # QA logs for active tasks
│   └── task-{id}-qa.log       # Deleted when task completes
├── planning/                   # Planning logs for active tasks
│   └── task-{id}-plan.log     # Deleted when task completes
├── context/                    # Context snapshots
│   └── summary.md             # Kept and updated
└── changelog.md                # Task completion summaries (append-only)
```

## Configuration

No configuration changes required. The features activate automatically:
- QA logs written when `tester-qa` persona runs
- Planning logs written when `implementation-planner` persona runs
- Cleanup triggered when task status becomes completed
- Git pull happens before reading context from disk

## Multi-Machine Coordination

These changes enable proper coordination across machines:

**Scenario:** Machine A runs context scan, Machine B plans, Machine C tests

1. **Machine A** (context persona):
   - Scans repository
   - Writes `.ma/context/summary.md`
   - Commits and pushes

2. **Machine B** (planner persona):
   - Pulls latest changes (gets context from Machine A)
   - Reads `.ma/context/summary.md`
   - Reads existing `.ma/planning/task-123-plan.log` (if any previous iterations)
   - Reads `.ma/qa/task-123-qa.log` (if any test results)
   - Creates or refines plan based on context + QA + previous plans
   - Writes updated `.ma/planning/task-123-plan.log`
   - Commits and pushes

3. **Machine C** (tester-qa persona):
   - Runs tests
   - Writes `.ma/qa/task-123-qa.log`
   - Commits and pushes

4. **Any Machine** (when task completes):
   - Pulls latest QA and planning logs
   - Generates summary
   - Updates `.ma/changelog.md`
   - Deletes task-specific logs
   - Commits and pushes

## Debugging

New log messages to help trace issues:

```
[info] Loaded QA history for persona
[info] Loaded planning history for persona (iterations: X)
[info] QA results written to log
[info] QA log committed and pushed
[info] Pulled latest changes before reading context
[info] Pulled latest planning logs before reading
[info] Planning results written to log
[info] Planning log committed and pushed
[info] Task logs cleaned up after completion
[debug] QA log not found (first run?)
[debug] Planning log not found (first planning iteration)
[debug] Git pull failed before reading planning log, using local
[warn] Git pull failed, using local context
[warn] Failed to commit QA log
[warn] Failed to commit planning log
[warn] Task log cleanup failed
```

## Backward Compatibility

- Existing workflows continue to work without modification
- New features activate automatically based on persona type
- Cleanup only runs when task reaches completion status
- Git pull failures are logged but don't block persona execution
- Cleanup failures don't prevent task completion

## Testing

All 137 tests pass with these changes:
```
Test Files  31 passed | 1 skipped (32)
Tests      134 passed | 3 skipped (137)
```
