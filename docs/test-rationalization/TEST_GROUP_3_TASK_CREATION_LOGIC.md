# Test Group 3: Task Creation Logic

**Status:** In Analysis  
**Priority:** Medium  
**Phase:** 3 (Test Rationalization)  
**Date:** 2025-10-19  
**Completion:** 0% (Analysis in progress)

---

## 1. Executive Summary

This test group validates task creation, routing, priority assignment, and milestone management after review failures. Analysis covers:

- **Task Creation from PM Decisions:** How follow_up_tasks become dashboard tasks
- **Priority Score Assignment:** Urgent (1000-1200) vs Deferred (50) based on review type and severity
- **Milestone Routing:** Same milestone (urgent) vs backlog milestone (deferred)
- **Task Metadata:** Titles, descriptions, parent linking, assignee personas
- **Duplicate Detection:** How to avoid creating redundant tasks

### Key Findings (Preliminary)

- ✅ **Three Priority Tiers Identified:**
  - QA urgent tasks: 1200 (highest priority)
  - Code/Security urgent tasks: 1000
  - All deferred tasks: 50
  
- ✅ **Routing Strategy Confirmed:**
  - Urgent (critical/high) → Same milestone as parent task
  - Deferred (medium/low) → Backlog milestone (`future-enhancements`)
  
- ✅ **Title Formatting:**
  - Urgent: `🚨 [Review Type] Task Title`
  - Deferred: `📋 [Review Type] Task Title`
  
- ⚠️ **Open Questions:**
  - Should all review types use same urgent priority (1000)?
  - Should QA remain higher priority (1200) than code review?
  - How should parent task linking work (always link vs conditional)?
  - Should assignee_persona vary by review type?

---

## 2. Test Files Analyzed

### 2.1 `tests/qaFailureTaskCreation.integration.test.ts` (442 lines)

**Business Intent:**
- Prove that QA 'unknown' or 'fail' status creates dashboard tasks
- Validate task titles are readable (not stringified JSON)
- Verify QAFailureCoordinationStep parses realistic QA responses
- Ensure created tasks have correct priority scores and metadata

**Test Scenarios:**

#### Scenario 1: QA Returns 'unknown' Status in Markdown Format
```typescript
// Production scenario: QA passes tests but identifies code quality issues
const qaResponse = {
  output: `**Test Execution Results**

All tests passed: 3
All tests failed: 0

However, I identified the following code quality issues:

1. Missing error handling in authentication flow (line 42)
2. Potential race condition in async operations (line 67)
3. No input validation for user-provided data (line 89)

\`\`\`json
{
  "status": "unknown",
  "details": "Tests passed but code quality issues found",
  "suggested_tasks": []
}
\`\`\`

**Recommendation**: Address these issues before proceeding to code review.`
};
```

**Validations:**
- ✅ QAFailureCoordinationStep parses text with embedded JSON
- ✅ interpretPersonaStatus() extracts clean details (not stringified)
- ✅ createDashboardTaskEntriesWithSummarizer() called with correct args
- ✅ Task title is readable: `QA failure: ...` (not `{"output":...}`)
- ✅ Task description is clean (no escaped characters)
- ✅ QA status parsed as 'unknown'
- ✅ createdTasks.length > 0

#### Scenario 2: QA Returns 'fail' Status with Test Failures
```typescript
const qaResponseFail = {
  output: `**Test Execution Results**

All tests passed: 0
All tests failed: 3

Test failures:
1. test/auth.spec.ts:42 - TypeError: Cannot read property 'token'
2. test/api.spec.ts:67 - AssertionError: Expected 200, got 500
3. test/utils.spec.ts:89 - ReferenceError: formatDate is not defined

\`\`\`json
{
  "status": "fail",
  "details": "3 test failures detected",
  "suggested_tasks": []
}
\`\`\`

**Recommendation**: Fix failing tests before merge.`
};
```

**Validations:**
- ✅ 'fail' status triggers task creation (same as 'unknown')
- ✅ Task title reflects test failures
- ✅ Task description includes failure details
- ✅ Priority score: 1200 (QA urgent)

**Configuration:**
```typescript
const step = new QAFailureCoordinationStep({
  name: 'qa_failure_coordination',
  type: 'QAFailureCoordinationStep',
  config: {
    taskCreationStrategy: 'auto',
    maxPlanRevisions: 2,
    urgentPriorityScore: 1200,  // QA highest priority
    deferredPriorityScore: 50
  }
});
```

**Expected Task Creation:**
```typescript
{
  id: 'created-task-1',
  title: 'QA failure: Test failed with TypeError at line 42',
  description: 'Test failed with TypeError at line 42\n\nStack trace: ...',
  priority_score: 1200,
  stage: 'qa'
}
```

---

### 2.2 `tests/codeReviewFailureTaskCreation.integration.test.ts` (520 lines)

**Business Intent:**
- Prove code review 'fail' or 'unknown' status creates dashboard tasks
- Validate PM response parsing handles multiple formats
- Verify task titles are readable (not stringified JSON)
- Ensure createDashboardTask() called with correct arguments

**Test Scenarios:**

#### Scenario 1: PM Returns `{status: "pass", backlog: [...]}` Format (Production Bug)
```typescript
// ACTUAL format from production that caused the bug
const pmDecisionWithStatusField = {
  status: "pass",
  details: "Context summary loaded successfully",
  milestone_updates: [],
  backlog: [
    {
      title: "Address MEDIUM findings in production/beta stage",
      description: "Review code_review_result JSON and create tasks for MEDIUM findings that require fixing before merge.",
      priority: "high"
    },
    {
      title: "Add LOW findings to backlog as future improvements",
      description: "Create tasks for LOW findings to add to the backlog for future refactoring opportunities.",
      priority: "low"
    }
  ],
  follow_up_tasks: [
    {
      title: "Code Review Failure Analysis Report",
      description: "Generate a report detailing the code review failure analysis...",
      priority: "high"
    }
  ]
};
```

**Key Learning:** This is the EXACT production bug scenario (both backlog and follow_up_tasks present).

**Expected Behavior (Post-Consolidation):**
- Parse with PMDecisionParserStep
- Merge backlog + follow_up_tasks (or prefer follow_up_tasks)
- Create 1-3 tasks depending on precedence strategy

**Configuration:**
```typescript
const step = new ReviewFailureTasksStep({
  name: 'create_code_review_followup_tasks',
  type: 'ReviewFailureTasksStep',
  config: {
    pmDecisionVariable: 'pm_code_review_decision',
    reviewType: 'code_review',
    urgentPriorityScore: 1000,  // Code review priority
    deferredPriorityScore: 50
  }
});
```

#### Scenario 2: PM Returns `{decision: "defer", follow_up_tasks: [...]}` Format (Modern)
```typescript
// EXPECTED format according to workflow prompts
const pmDecisionWithDecisionField = {
  decision: "defer",
  reasoning: "Only MEDIUM and LOW findings present. Can defer to backlog for future improvements.",
  immediate_issues: [],
  deferred_issues: [
    "Complex nested logic in fileIngest.ts line 10",
    "Unused interface property 'data' in logEntry.ts"
  ],
  follow_up_tasks: [
    {
      title: "Simplify nested logic in fileIngest.ts",
      description: "Refactor complex conditional statements at line 10...",
      priority: "medium"
    },
    {
      title: "Remove unused properties in logEntry.ts",
      description: "Clean up unused interface properties...",
      priority: "low"
    }
  ]
};
```

**Expected Behavior:**
- Parse with PMDecisionParserStep (consolidated)
- decision = 'defer' → deferred tasks
- priority = 'medium'/'low' → deferredPriorityScore (50)
- Milestone: backlog (`future-enhancements`)
- Title: `📋 [Code Review] Simplify nested logic...`

#### Scenario 3: PM Returns `{decision: "immediate_fix", immediate_issues: [...]}` Format
```typescript
// SEVERE/HIGH findings requiring immediate attention
const pmDecisionImmediateFix = {
  decision: "immediate_fix",
  reasoning: "SEVERE and HIGH findings present that must be addressed before merge.",
  immediate_issues: [
    "Potential bug: Unhandled promise rejection in ingestion.ts line 4",
    "Inconsistent naming convention causing confusion"
  ],
  deferred_issues: [],
  follow_up_tasks: [
    {
      title: "Fix unhandled promise rejection",
      description: "Add proper error handling in ingestion.ts line 4...",
      priority: "critical"
    },
    {
      title: "Standardize naming conventions",
      description: "Refactor variable names to follow consistent pattern...",
      priority: "high"
    }
  ]
};
```

**Expected Behavior:**
- decision = 'immediate_fix' → urgent tasks
- priority = 'critical'/'high' → urgentPriorityScore (1000)
- Milestone: same as parent task (blocks deployment)
- Title: `🚨 [Code Review] Fix unhandled promise rejection`

**Validations Across All Scenarios:**
- ✅ result.status === 'success'
- ✅ result.outputs.tasks_created > 0
- ✅ createDashboardTask() called
- ✅ Task titles are readable (no `{\"output\":...}`)
- ✅ Task titles match pattern: `emoji [Review Type] title`

---

### 2.3 `tests/taskPriorityAndRouting.test.ts` (687 lines)

**Business Intent:**
- Validate task selection priority order (blocked > in_review > in_progress > open)
- Verify coordinator processes tasks in correct priority order
- Test that task status determines processing order
- Ensure tasks with same priority sort by task order

**Test Scenarios:**

#### Scenario 1: Blocked Tasks First (Priority 0)
```typescript
it('processes blocked tasks first (priority 0)', async () => {
  const taskStatuses = new Map([
    ['task-1', 'open'],
    ['task-2', 'in_progress'],
    ['task-3', 'blocked']
  ]);
  
  // Mock dynamic task fetching
  // ... coordinator runs ...
  
  // VALIDATION: Blocked task processed first
  expect(processedTasks[0]).toBe('task-3');  // Blocked (priority 0)
});
```

**Priority Mapping:**
- **blocked:** 0 (highest priority)
- **in_review:** 1
- **in_progress:** 2
- **open:** 3 (lowest priority)

#### Scenario 2: In Review Tasks Second (Priority 1)
```typescript
it('processes in_review tasks second (priority 1)', async () => {
  const taskStatuses = new Map([
    ['task-1', 'open'],
    ['task-2', 'in_progress'],
    ['task-3', 'in_review'],
    ['task-4', 'blocked']
  ]);
  
  // VALIDATION: Order is blocked, then in_review
  expect(processedTasks[0]).toBe('task-4');  // Blocked (priority 0)
  expect(processedTasks[1]).toBe('task-3');  // In Review (priority 1)
});
```

#### Scenario 3: In Progress Tasks Third (Priority 2)
```typescript
it('processes in_progress tasks third (priority 2)', async () => {
  const taskStatuses = new Map([
    ['task-1', 'open'],
    ['task-2', 'in_progress']
  ]);
  
  // VALIDATION: in_progress before open
  expect(processedTasks[0]).toBe('task-2');  // In Progress (priority 2)
  expect(processedTasks[1]).toBe('task-1');  // Open (priority 3)
});
```

#### Scenario 4: All Priorities in Correct Order
```typescript
it('processes all priorities in correct order', async () => {
  const tasks = [
    { id: 'task-open', status: 'open', order: 10 },
    { id: 'task-progress', status: 'in_progress', order: 20 },
    { id: 'task-review', status: 'in_review', order: 30 },
    { id: 'task-blocked', status: 'blocked', order: 40 }
  ];
  
  // VALIDATION: Complete priority order
  expect(processedTasks[0]).toBe('task-blocked');    // Priority 0
  expect(processedTasks[1]).toBe('task-review');     // Priority 1
  expect(processedTasks[2]).toBe('task-progress');   // Priority 2
  expect(processedTasks[3]).toBe('task-open');       // Priority 3
});
```

#### Scenario 5: Task Order Tiebreaker
```typescript
it('sorts by task order when priorities are equal', async () => {
  const tasks = [
    { id: 'task-3', status: 'open', order: 3 },
    { id: 'task-1', status: 'open', order: 1 },
    { id: 'task-2', status: 'open', order: 2 }
  ];
  
  // VALIDATION: Same priority, sorted by order
  expect(processedTasks[0]).toBe('task-1');  // order: 1
  expect(processedTasks[1]).toBe('task-2');  // order: 2
  expect(processedTasks[2]).toBe('task-3');  // order: 3
});
```

**Business Rule:**
> Tasks are selected by: 1) Task status priority (blocked > in_review > in_progress > open), 2) Task order (ascending)

**Status:** These tests are skipped (`describe.skip`) with comment:
> "TODO: Re-enable after fixing dynamic task status updates. These tests need tasks to be marked as 'done' after processing to exit the coordinator loop"

---

## 3. Priority Score Matrix

### Current Implementation

| Review Type | Urgency | Priority Score | Milestone | Title Prefix | Source |
|-------------|---------|----------------|-----------|--------------|--------|
| **QA** | Urgent | 1200 | Same | 🚨 [QA] | QAFailureCoordinationStep.ts:79 |
| **QA** | Deferred | 50 | Backlog | 📋 [QA] | QAFailureCoordinationStep.ts:80 |
| **Code Review** | Urgent | 1000 | Same | 🚨 [Code Review] | ReviewFailureTasksStep (default) |
| **Code Review** | Deferred | 50 | Backlog | 📋 [Code Review] | ReviewFailureTasksStep (default) |
| **Security** | Urgent | 1000 | Same | 🚨 [Security Review] | ReviewFailureTasksStep (default) |
| **Security** | Deferred | 50 | Backlog | 📋 [Security Review] | ReviewFailureTasksStep (default) |
| **DevOps** | Urgent | 1000 | Same | 🚨 [DevOps Review] | ReviewFailureTasksStep (default) |
| **DevOps** | Deferred | 50 | Backlog | 📋 [DevOps Review] | ReviewFailureTasksStep (default) |

### Urgency Determination Logic

```typescript
// Source: ReviewFailureTasksStep.ts, line 148
const isUrgent = ['critical', 'high'].includes(followUpTask.priority?.toLowerCase() || '');

const priorityScore = isUrgent 
  ? (config.urgentPriorityScore || 1000)
  : (config.deferredPriorityScore || 50);
```

**Rule:**
- **critical** or **high** priority → Urgent (1000-1200)
- **medium** or **low** priority → Deferred (50)

### Priority Score Implications

**In Task Coordinator:**
- Priority score determines task selection order
- Higher priority = processed first
- Tasks with same priority sorted by task order

**Question for User:**
> Should QA remain higher priority (1200) than code review (1000)? Or should all urgent review tasks have same priority?

---

## 4. Milestone Routing Strategy

### Current Implementation

```typescript
// Source: ReviewFailureTasksStep.ts, lines 177-180
const isUrgent = ['critical', 'high'].includes(followUpTask.priority?.toLowerCase() || '');

const targetMilestoneId = isUrgent ? milestoneId : null;
const targetMilestoneSlug = isUrgent ? undefined : (config.backlogMilestoneSlug || 'future-enhancements');
```

**Rules:**

1. **Urgent Tasks (critical/high priority)**
   - Go to: Current milestone (`milestoneId` from context)
   - Must be in same milestone as parent task
   - Blocks deployment until resolved
   - Auto-create milestone: NO (must already exist)

2. **Deferred Tasks (medium/low priority)**
   - Go to: Backlog milestone (`backlogMilestoneSlug` or `'future-enhancements'`)
   - Can be addressed in future sprints
   - Does not block current milestone
   - Auto-create milestone: YES (creates if missing)

### Task Creation Call

```typescript
// Source: ReviewFailureTasksStep.ts, lines 187-201
const result = await createDashboardTask({
  projectId,
  milestoneId: targetMilestoneId,     // Current milestone ID or null
  milestoneSlug: targetMilestoneSlug, // undefined or 'future-enhancements'
  parentTaskId,                        // Link to original task
  title: taskTitle,
  description: taskDescription,
  priorityScore,
  options: {
    create_milestone_if_missing: !isUrgent  // Only for deferred tasks
  }
});
```

**Questions for User:**
1. Should urgent tasks ALWAYS link to parent task? Or only if parent exists?
2. Should backlogMilestoneSlug be configurable per workflow? Or global setting?
3. Should urgent tasks fail if current milestone doesn't exist? Or fall back to creating milestone?

---

## 5. Task Metadata Formatting

### Title Formatting

**Source:** `ReviewFailureTasksStep.formatTaskTitle()` (not shown in grep, but referenced)

```typescript
// Inferred from test expectations and comments
const emoji = isUrgent ? '🚨' : '📋';
const reviewTypeLabel = config.reviewType || 'Review';
const formattedTitle = `${emoji} [${reviewTypeLabel}] ${followUpTask.title}`;

// Examples:
// "🚨 [Code Review] Fix unhandled promise rejection"
// "📋 [Security Review] Update dependency to patch vulnerability"
// "🚨 [QA] Fix failing tests in auth module"
```

**Format Pattern:**
- **Emoji:** 🚨 (urgent) or 📋 (deferred)
- **Label:** `[Review Type]` (Code Review, Security Review, QA, DevOps Review)
- **Title:** Original task title from PM follow_up_tasks

**Question for User:**
> Should title prefix be configurable per workflow? Or standardize across all workflows?

### Description Formatting

**Source:** `ReviewFailureTasksStep.formatTaskDescription()` (not shown in grep, but referenced)

```typescript
// Inferred from production examples
const description = `
${followUpTask.description}

---

**Context:**
- Review Type: ${reviewType}
- PM Decision: ${pmDecision.decision}
- Reasoning: ${pmDecision.reasoning}
- Parent Task: ${parentTaskId || 'N/A'}

**Related Issues:**
${pmDecision.immediate_issues?.map(i => `- ${i}`).join('\n') || 'None'}
${pmDecision.deferred_issues?.map(i => `- ${i}`).join('\n') || 'None'}
`;
```

**Components:**
1. Task description (from PM follow_up_tasks)
2. Context section (review type, decision, reasoning)
3. Parent task link
4. Related issues (immediate + deferred)

**Question for User:**
> Should description format be standardized across all workflows? Or allow custom templates?

### Parent Task Linking

**From Code:**
```typescript
// Source: ReviewFailureTasksStep.ts, line 122
const parentTaskId = task?.id || context.getVariable('taskId');

// Then used in createDashboardTask:
await createDashboardTask({
  // ...
  parentTaskId,  // Link to original task that triggered review failure
  // ...
});
```

**Business Logic:**
- All follow-up tasks link to parent task that triggered the review
- Allows tracing: "Why was this task created?" → "Because task X failed code review"
- Dashboard can show subtask hierarchy

**Questions for User:**
1. Should parent linking be required? Or optional?
2. What if parent task is deleted? Should follow-up tasks be unlinked?
3. Should follow-up tasks inherit parent's labels, assignee, or other metadata?

---

## 6. Assignee Persona Logic

**From QA Test:**
```typescript
// Source: qaFailureTaskCreation.integration.test.ts (expected behavior)
{
  id: 'created-task-1',
  title: 'QA failure: Test failed with TypeError at line 42',
  description: '...',
  priority_score: 1200,
  stage: 'qa',
  // assignee_persona: 'implementation-planner' (inferred, not shown)
}
```

**From Code Review Test:**
```typescript
// Source: codeReviewFailureTaskCreation.integration.test.ts (mocked)
// No explicit assignee_persona set in tests
```

**Question:** Who should be assigned to follow-up tasks?

**Options:**
1. **implementation-planner** - Plan how to fix the issues
2. **implementation-lead** - Implement the fixes directly
3. **Same persona as parent** - Inherit assignee from parent task
4. **Review-specific persona:**
   - QA failures → qa-agent
   - Code review failures → code-reviewer
   - Security failures → security-reviewer

**Current Behavior (Inferred):**
- Not explicitly set in ReviewFailureTasksStep
- Likely defaults to `implementation-planner` (based on dashboard.ts createTask)

**Question for User:**
> Should assignee_persona vary by review type? Or always default to implementation-planner?

---

## 7. Duplicate Detection

**Source:** `ReviewFailureTasksStep.isDuplicateTask()` (lines 390-450, from previous reading)

### Detection Strategy

```typescript
private isDuplicateTask(followUpTask: any, existingTasks: any[], formattedTitle: string): boolean {
  // 1. Normalize titles (remove emojis, brackets, "urgent" markers)
  const normalizeTitle = (title: string): string => {
    return title
      .toLowerCase()
      .replace(/🚨|📋|⚠️|✅/g, '') // Remove emojis
      .replace(/\[.*?\]/g, '')     // Remove [Code Review] etc
      .replace(/urgent/gi, '')     // Remove urgent markers
      .replace(/\s+/g, ' ')        // Normalize whitespace
      .trim();
  };
  
  // 2. Extract key phrases from description (words 5+ chars)
  const extractKeyPhrases = (text: string): Set<string> => {
    return new Set(
      text.toLowerCase().match(/\b\w{5,}\b/g) || []
    );
  };
  
  // 3. Compare with existing tasks
  for (const existingTask of existingTasks) {
    // Title similarity check
    const titleMatch = 
      normalizedExistingTitle.includes(normalizedNewTitle) ||
      normalizedNewTitle.includes(normalizedExistingTitle) ||
      normalizedExistingTitle === normalizedFormattedTitle;
    
    if (titleMatch) {
      // Description overlap check
      const overlapRatio = keyPhrasesOverlap / totalKeyPhrases;
      
      // If >50% of key phrases overlap, consider it a duplicate
      if (overlapRatio > 0.5) {
        return true; // Skip creating this task
      }
    }
  }
  
  return false;
}
```

### Detection Criteria

1. **Title Match:**
   - Normalized titles must contain each other OR
   - Normalized titles exactly match OR
   - Formatted title matches existing normalized title

2. **Description Overlap:**
   - Extract 5+ character words from both descriptions
   - Calculate overlap ratio
   - If >50% overlap → duplicate

3. **Skipped Duplicates:**
   - Log warning with task details
   - Increment skippedDuplicates counter
   - Continue to next task

### Questions for User

1. **Scope:** Should duplicate detection check ALL tasks (open + closed) or only open/in_progress?
2. **Strictness:** Is 50% overlap the right threshold? Too strict? Too lenient?
3. **Override:** Should PM be able to force creation even if duplicate detected?
4. **Strategy:** Should we create linked tasks instead of skipping? (e.g., "Similar to task #123")

---

## 8. Validation Questions for User

### 8.1 Priority Score Questions

**Q1: Should all review types use the same urgent priority score?**
- Current: QA (1200), Code/Security/DevOps (1000)
- Rationale for difference: QA failures indicate fundamental issues (tests failed)
- Alternative: All urgent review failures = 1000 (equal priority)
- **User Decision:**

**Q2: Should deferred priority score (50) be the same across all review types?**
- Current: All deferred tasks = 50 (same priority)
- Alternative: Different scores for different review types?
- **User Decision:**

**Q3: Should priority scores be configurable per workflow, or global?**
- Current: Set in step config (workflow-specific)
- Alternative: Global configuration (all workflows use same scores)
- Trade-off: Flexibility vs consistency
- **User Decision:**

### 8.2 Milestone Routing Questions

**Q4: Should urgent tasks ALWAYS link to the same milestone as parent task?**
- Current: Yes, urgent tasks go to `milestoneId` from context
- Alternative: Allow urgent tasks in different milestone if parent milestone is closed
- **User Decision:**

**Q5: Should backlogMilestoneSlug be configurable per workflow?**
- Current: Step config allows override (default: `'future-enhancements'`)
- Alternative: Global setting (all workflows use same backlog milestone)
- **User Decision:**

**Q6: Should urgent tasks fail if current milestone doesn't exist?**
- Current: Yes, `create_milestone_if_missing: false` for urgent tasks
- Alternative: Auto-create milestone if missing (like deferred tasks)
- Trade-off: Fail fast vs graceful fallback
- **User Decision:**

### 8.3 Task Metadata Questions

**Q7: Should title prefix be configurable per workflow?**
- Current: Hardcoded emoji + `[Review Type]` format
- Alternative: Custom prefix per workflow (e.g., `[HOTFIX]`, `[URGENT]`)
- **User Decision:**

**Q8: Should description format be standardized across all workflows?**
- Current: `formatTaskDescription()` includes context section
- Alternative: Allow custom description templates per review type
- **User Decision:**

**Q9: Should parent task linking be required?**
- Current: Always link to parent task (if exists)
- Alternative: Optional parent linking (some tasks might be standalone)
- **User Decision:**

**Q10: What should happen if parent task is deleted?**
- Current behavior: Unknown (not handled in tests)
- Options:
  a) Unlink follow-up tasks (parentTaskId = null)
  b) Keep link (orphaned reference)
  c) Delete follow-up tasks (cascade delete)
- **User Decision:**

### 8.4 Assignee Persona Questions

**Q11: Should assignee_persona vary by review type?**
- Current: Not explicitly set (likely defaults to `implementation-planner`)
- Options:
  a) Always `implementation-planner` (plan how to fix)
  b) Always `implementation-lead` (implement directly)
  c) Review-specific: `qa-agent`, `code-reviewer`, `security-reviewer`
  d) Inherit from parent task
- **User Decision:**

**Q12: Should urgent tasks be assigned differently than deferred tasks?**
- Example: Urgent → `implementation-lead`, Deferred → `implementation-planner`
- Trade-off: Urgent tasks might need immediate implementation vs planning
- **User Decision:**

### 8.5 Duplicate Detection Questions

**Q13: Should duplicate detection check closed tasks or only open tasks?**
- Current: Checks ALL existing tasks (fetchProjectTasks() returns all)
- Alternative: Only check open + in_progress + blocked tasks
- Trade-off: Avoid re-creating completed tasks vs allow re-opening issues
- **User Decision:**

**Q14: Is 50% description overlap the right duplicate threshold?**
- Current: 50% key phrase overlap → duplicate
- Too strict? Tasks might be wrongly flagged as duplicates
- Too lenient? Actual duplicates might slip through
- Alternative thresholds: 30%, 60%, 70%?
- **User Decision:**

**Q15: Should PM be able to override duplicate detection?**
- Current: No override mechanism
- Alternative: PM includes `force_create: true` in follow_up_task
- Use case: PM knows this is NOT a duplicate despite title similarity
- **User Decision:**

**Q16: Should we create linked tasks instead of skipping duplicates?**
- Current: Skip creating duplicate (log warning)
- Alternative: Create task with note: "Similar to task #123"
- Trade-off: More visibility vs clutter
- **User Decision:**

### 8.6 Task Creation Behavior Questions

**Q17: Should task creation fail if ANY task fails to create?**
- Current: Continues creating remaining tasks (partial success)
- Alternative: Transactional (all or nothing)
- Trade-off: Partial success vs atomic operation
- **User Decision:**

**Q18: Should we retry failed task creation?**
- Current: No retry logic
- Alternative: Retry with exponential backoff (Phase 5 integration)
- Use case: Transient dashboard API failures
- **User Decision:**

**Q19: Should task creation be idempotent?**
- Current: Duplicate detection provides some idempotency
- Alternative: Use external_id to guarantee exactly-once creation
- Use case: Workflow re-runs shouldn't create duplicate tasks
- **User Decision:**

---

## 9. Recommended Actions (Pending User Validation)

### High Priority (Consistency)

1. **Standardize Priority Scores**
   - Based on Q1-Q3 answers
   - Document priority score matrix
   - Update all workflow YAML files

2. **Clarify Milestone Routing Rules**
   - Based on Q4-Q6 answers
   - Document urgent vs deferred routing
   - Add error handling for missing milestones

3. **Standardize Task Metadata**
   - Based on Q7-Q10 answers
   - Create shared formatters (title, description)
   - Document parent linking behavior

### Medium Priority (Enhancements)

4. **Configure Assignee Persona Logic**
   - Based on Q11-Q12 answers
   - Add assignee_persona to follow_up_tasks
   - Document persona assignment rules

5. **Tune Duplicate Detection**
   - Based on Q13-Q16 answers
   - Adjust overlap threshold (if needed)
   - Add override mechanism (if needed)
   - Document duplicate detection strategy

### Low Priority (Improvements)

6. **Add Task Creation Safeguards**
   - Based on Q17-Q19 answers
   - Add retry logic (Phase 5)
   - Add idempotency (external_id)
   - Document error handling

---

## 10. Test Improvement Recommendations

### Add New Tests

1. **`taskMetadataFormatting.test.ts` (NEW)**
   ```typescript
   describe('Task Metadata Formatting', () => {
     it('formats urgent task title with correct emoji and prefix', async () => {});
     it('formats deferred task title with correct emoji and prefix', async () => {});
     it('includes review context in task description', async () => {});
     it('links task to parent with parentTaskId', async () => {});
     it('sets assignee_persona based on review type', async () => {});
   });
   ```

2. **`duplicateDetection.test.ts` (NEW)**
   ```typescript
   describe('Duplicate Task Detection', () => {
     it('skips task with exact title match', async () => {});
     it('skips task with 50%+ description overlap', async () => {});
     it('creates task with different description', async () => {});
     it('normalizes titles before comparison', async () => {});
     it('only checks open/in_progress tasks (not closed)', async () => {});
   });
   ```

3. **`milestoneRouting.test.ts` (NEW)**
   ```typescript
   describe('Milestone Routing', () => {
     it('routes urgent tasks to current milestone', async () => {});
     it('routes deferred tasks to backlog milestone', async () => {});
     it('auto-creates backlog milestone if missing', async () => {});
     it('fails if current milestone missing for urgent task', async () => {});
   });
   ```

4. **`priorityScoreAssignment.test.ts` (NEW)**
   ```typescript
   describe('Priority Score Assignment', () => {
     it('assigns QA urgent priority (1200)', async () => {});
     it('assigns code review urgent priority (1000)', async () => {});
     it('assigns deferred priority (50) for medium/low', async () => {});
     it('uses critical priority for immediate_fix decision', async () => {});
   });
   ```

### Update Existing Tests

5. **`taskPriorityAndRouting.test.ts`**
   - Re-enable skipped tests (fix dynamic task status updates)
   - Add test: Verify priority score affects selection order
   - Add test: Multiple tasks with same status, sorted by order

6. **`qaFailureTaskCreation.integration.test.ts`**
   - Add test: Verify assignee_persona is set correctly
   - Add test: Verify parentTaskId links to original task
   - Add test: Verify duplicate detection skips redundant tasks

7. **`codeReviewFailureTaskCreation.integration.test.ts`**
   - Add test: Verify milestone routing (urgent vs deferred)
   - Add test: Verify priority score matches urgency
   - Add test: Verify backlog milestone auto-creation

---

## 11. Technical Debt Identified

1. **Priority Score Inconsistency**
   - QA (1200) vs Code/Security/DevOps (1000)
   - No documented rationale for difference
   - Solution: Standardize or document reasoning

2. **Hardcoded Values**
   - urgentPriorityScore: 1000/1200
   - deferredPriorityScore: 50
   - backlogMilestoneSlug: 'future-enhancements'
   - Solution: Move to configuration, document defaults

3. **Missing Error Handling**
   - What if createDashboardTask() fails?
   - What if milestone doesn't exist?
   - What if parent task is deleted?
   - Solution: Add error handling, retry logic (Phase 5)

4. **Task Metadata Inconsistency**
   - Title formatting logic in ReviewFailureTasksStep
   - Description formatting logic separate
   - No shared formatter utility
   - Solution: Create shared TaskFormatter utility

5. **Duplicate Detection Limitations**
   - Checks ALL tasks (including completed)
   - 50% threshold is arbitrary
   - No override mechanism
   - Solution: Make configurable, add override

---

## 12. Next Steps

**Awaiting User Validation:**
- Answer validation questions (Q1-Q19)
- Approve recommended actions
- Prioritize fixes vs improvements

**After Validation:**
1. Document priority score matrix (Q1-Q3)
2. Document milestone routing rules (Q4-Q6)
3. Document task metadata standards (Q7-Q10)
4. Document assignee persona logic (Q11-Q12)
5. Tune duplicate detection (Q13-Q16)
6. Move to Test Group 4: Error Handling & Edge Cases

---

## 13. Appendix: Code Snippets

### A. Priority Score Defaults

**QA Urgent Priority (1200):**
```typescript
// src/workflows/steps/QAFailureCoordinationStep.ts, lines 79-80
urgentPriorityScore = 1200,
deferredPriorityScore = 50
```

**Code/Security/DevOps Urgent Priority (1000):**
```typescript
// src/workflows/steps/ReviewFailureTasksStep.ts, line 150
const priorityScore = isUrgent 
  ? (config.urgentPriorityScore || 1000)
  : (config.deferredPriorityScore || 50);
```

### B. Urgency Determination Logic

```typescript
// src/workflows/steps/ReviewFailureTasksStep.ts, line 148
const isUrgent = ['critical', 'high'].includes(followUpTask.priority?.toLowerCase() || '');
```

### C. Milestone Routing Logic

```typescript
// src/workflows/steps/ReviewFailureTasksStep.ts, lines 177-180
const targetMilestoneId = isUrgent ? milestoneId : null;
const targetMilestoneSlug = isUrgent ? undefined : (config.backlogMilestoneSlug || 'future-enhancements');
```

### D. Task Creation Call

```typescript
// src/workflows/steps/ReviewFailureTasksStep.ts, lines 187-201
const result = await createDashboardTask({
  projectId,
  milestoneId: targetMilestoneId,
  milestoneSlug: targetMilestoneSlug,
  parentTaskId,
  title: taskTitle,
  description: taskDescription,
  priorityScore,
  options: {
    create_milestone_if_missing: !isUrgent
  }
});
```

---

**Document Status:** Ready for User Review (USER CHECKPOINT #5)  
**Estimated Review Time:** 25-30 minutes  
**Priority Questions:** Q1 (priority scores), Q4 (milestone routing), Q11 (assignee persona), Q14 (duplicate threshold)
