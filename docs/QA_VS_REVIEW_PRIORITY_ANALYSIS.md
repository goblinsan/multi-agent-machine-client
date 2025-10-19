# QA vs Review Failure Priority Analysis

## Current State Comparison

### Review Failures (Code Review / Security Review)
**Mechanism:** `ReviewFailureTasksStep` 
**File:** `src/workflows/steps/ReviewFailureTasksStep.ts`

**Priority Assignment:**
- ✅ Uses `priority_score` field
- ✅ Urgent tasks: `priority_score: 1000-1500`
- ✅ Deferred tasks: `priority_score: 50` (backlog)
- ✅ Coordinator prioritizes by score FIRST

**Task Creation:**
```typescript
createDashboardTask({
  priorityScore: urgentPriorityScore, // 1000 or 1500
  // ... other fields
})
```

**Result:** Urgent review failure tasks jump to front of queue immediately.

---

### QA Failures
**Mechanism:** `QAFailureCoordinationStep`
**File:** `src/workflows/steps/QAFailureCoordinationStep.ts`

**Priority Assignment:**
- ❌ Does NOT set `priority_score` on suggested tasks
- ⚠️ Uses `scheduleHint: 'urgent'` only
- ⚠️ Defaults to `priorityScore: task.defaultPriority ?? 5` (line 351 in taskManager.ts)

**Task Creation:**
```typescript
// In QAFailureCoordinationStep (line 300-303):
suggestedTasks = [{
  title,
  description: qaStatus.details.slice(0, 5000),
  schedule: 'urgent',  // ⚠️ Only sets schedule, not priority_score
  assigneePersona: 'implementation-planner',
  stage: 'qa',
  parent_task_id: task?.id || task?.external_id
}];

// In taskManager.ts createDashboardTaskEntries (line 351):
createDashboardTask({
  priorityScore: task.defaultPriority ?? 5,  // ❌ Defaults to 5!
  // ... other fields
})
```

**Result:** QA failure tasks get `priority_score: 5` → NOT prioritized by coordinator!

---

## The Problem

### Inconsistent Priority Mechanisms

1. **Review failures:** Use explicit `priority_score` (1000+) → High priority
2. **QA failures:** Use `scheduleHint` only → Low priority (5)

### Why This Matters

The coordinator's `compareTaskPriority()` now checks `priority_score` FIRST:

```typescript
// Priority order:
1. priority_score (higher = more urgent)
2. Status (blocked > in_review > in_progress > open)  
3. Task order/position
```

**Example scenario:**
- QA fails on Task A → Creates follow-up Task B with `priority_score: 5`
- Some other task (Task C) in `in_review` status (no score)
- Coordinator picks: **Task C before Task B** (status-based priority wins)
- Expected: Task B should be picked first since it's an urgent QA failure

---

## Impact Analysis

### What Works:
- ✅ QA failure tasks ARE created on dashboard
- ✅ They ARE marked with `initial_status: 'in_progress'`
- ✅ They ARE linked to parent task
- ✅ Original task gets revised plan

### What Doesn't Work:
- ❌ QA urgent tasks don't jump to front of queue
- ❌ Coordinator doesn't prioritize them over in_review tasks
- ❌ No differentiation between urgent vs deferred QA failures

### Real-World Scenario:
```
Timeline:
1. Task A in progress → QA fails (critical test failure)
2. QAFailureCoordinationStep creates Task B (priority_score: 5)
3. Some Task C enters code review (no priority_score)
4. Coordinator fetches tasks:
   - Task B: priority_score=5, status=in_progress
   - Task C: no score, status=in_review
   
Current behavior: Picks Task C (status wins)
Expected behavior: Pick Task B (urgent QA failure should win)
```

---

## Recommendation: Rationalize the Systems

### Option 1: Add Priority Scores to QA Failures (Recommended)

**Changes needed:**

1. **Update `QAFailureCoordinationStep.createQAFailureTasks()`**
   - Add `priority_score` field to suggested tasks based on urgency
   - Align with review failure mechanism

2. **Update `createDashboardTaskEntries()`**
   - Accept `priority_score` from task object
   - Use it if provided, otherwise fall back to defaultPriority

3. **Add configuration to QAFailureCoordinationStep**
   - `urgentPriorityScore: 1200` (between code review and security)
   - `deferredPriorityScore: 50`

**Benefits:**
- ✅ Consistent with review failure system
- ✅ Urgent QA failures properly prioritized
- ✅ Can differentiate critical vs non-critical QA failures
- ✅ Works with existing coordinator priority logic

**Example:**
```typescript
// QA test failures (critical)
priority_score: 1200

// Code review failures (SEVERE/HIGH)  
priority_score: 1000

// Security review failures (SEVERE/HIGH)
priority_score: 1500

// Deferred improvements (all stages)
priority_score: 50
```

---

### Option 2: Keep Current QA System (Not Recommended)

**Why this doesn't work:**
- QA failures are just as urgent as review failures
- Test failures block progress just like code review failures
- Inconsistent developer experience (some failures prioritized, others not)
- The `scheduleHint` field doesn't integrate with new coordinator logic

---

## Proposed Implementation

### Step 1: Update QAFailureCoordinationStep Config

Add configuration options:

```typescript
interface QAFailureCoordinationConfig {
  // ... existing fields
  
  /**
   * Priority score for urgent QA failures (critical test failures)
   * @default 1200
   */
  urgentPriorityScore?: number;
  
  /**
   * Priority score for deferred QA improvements
   * @default 50
   */
  deferredPriorityScore?: number;
}
```

### Step 2: Enhance Task Creation Logic

In `createQAFailureTasks()` method:

```typescript
private async createQAFailureTasks(
  context: WorkflowContext,
  redis: any,
  qaResult: any,
  qaStatus: { status: string; details?: string; tasks?: any[] }
): Promise<any[]> {
  const config = this.config.config as QAFailureCoordinationConfig || {};
  const urgentPriorityScore = config.urgentPriorityScore ?? 1200;
  const deferredPriorityScore = config.deferredPriorityScore ?? 50;
  
  // ... existing code
  
  // Determine urgency from QA result
  const isUrgent = this.isUrgentQAFailure(qaResult, qaStatus);
  const priorityScore = isUrgent ? urgentPriorityScore : deferredPriorityScore;
  
  suggestedTasks = [{
    title,
    description: qaStatus.details.slice(0, 5000),
    schedule: isUrgent ? 'urgent' : 'medium',
    priority_score: priorityScore,  // ✅ Add this
    assigneePersona: 'implementation-planner',
    stage: 'qa',
    parent_task_id: task?.id || task?.external_id
  }];
  
  // ... rest of method
}

private isUrgentQAFailure(qaResult: any, qaStatus: any): boolean {
  // Check if QA failure is urgent (critical tests, blocking bugs, etc.)
  // Could analyze:
  // - Test type (integration vs unit)
  // - Number of failures
  // - Failure severity from QA output
  // - TDD context
  
  // For now, default to urgent for all QA failures
  return true;
}
```

### Step 3: Update Task Manager

In `createDashboardTaskEntries()`, line ~351:

```typescript
// BEFORE:
priorityScore: task.defaultPriority ?? 5,

// AFTER:
priorityScore: task.priority_score ?? task.defaultPriority ?? 5,
```

This allows tasks to specify their own priority_score.

### Step 4: Update Workflow Definitions

Add configuration to `legacy-compatible-task-flow.yaml`:

```yaml
- name: qa_failure_coordination
  type: QAFailureCoordinationStep
  description: "Coordinate QA failures with plan revision and task creation"
  depends_on: ["qa_request"]
  condition: "${qa_request_status} == 'fail'"
  config:
    maxPlanRevisions: 3
    taskCreationStrategy: "auto"
    urgentPriorityScore: 1200  # ✅ Add this
    deferredPriorityScore: 50  # ✅ Add this
```

---

## Priority Score Guidelines

Recommended priority score ranges:

| Severity Level | Score Range | Use Case |
|----------------|-------------|----------|
| **Critical Security** | 1500-1999 | SEVERE security vulnerabilities |
| **Urgent QA Failures** | 1200-1499 | Critical test failures, blocking bugs |
| **Critical Code Issues** | 1000-1199 | SEVERE/HIGH code review findings |
| **High Priority Tasks** | 500-999 | Important but not blocking |
| **Normal Priority** | 100-499 | Regular development tasks |
| **Deferred/Backlog** | 1-99 | Future enhancements, low priority |
| **No Score (default)** | 0 | Legacy tasks, status-based priority |

---

## Testing Strategy

1. **Create test with critical QA failure**
   - Verify task created with `priority_score: 1200`
   - Verify coordinator picks it before in_review tasks

2. **Compare with review failures**
   - QA failure task: score 1200
   - Code review failure: score 1000
   - Security failure: score 1500
   - Verify correct ordering

3. **Test with mixed priority scenarios**
   - Multiple tasks with different scores
   - Verify coordinator respects score order

---

## Conclusion

**Yes, the systems should be rationalized.**

The current state has:
- ✅ Review failures: Explicit priority scores (1000-1500)
- ❌ QA failures: No priority scores (default to 5)

This creates an inconsistent experience where:
- Review failures are properly prioritized
- QA failures are NOT prioritized despite being equally urgent

**Recommendation:** Implement Option 1 to add explicit `priority_score` to QA failure tasks, aligning with the review failure mechanism.
