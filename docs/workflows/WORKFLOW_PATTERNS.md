# Workflow Pattern Extraction
**Date:** October 19, 2025  
**Phase:** Phase 0 - Day 2  
**Status:** Analysis Complete

---

## Executive Summary

Analyzed `legacy-compatible-task-flow.yaml` (446 lines, 30 steps) to identify reusable patterns for sub-workflow decomposition.

**Key Patterns Identified:** 7 major patterns
1. **Git Operations** (4 steps) - branch management, verification
2. **Task Status Management** (5 steps) - dashboard status updates
3. **Review Execution** (4 review types) - QA, Code, Security, DevOps
4. **Review Failure Handling** (3 implementations) - PM evaluation + task creation
5. **Planning & Implementation** (4 steps) - context, plan, implement, apply
6. **Iteration Loops** (2 types) - QA fixes, planning evaluation
7. **Milestone Operations** (2 steps) - completion check, suggestion evaluation

**Dashboard Operations Documented:** 6 distinct patterns

---

## Pattern 1: Git Operations

### Steps Involved
1. `checkout_branch` - GitOperationStep
2. `verify_diff` - GitOperationStep
3. `ensure_branch_published` - GitOperationStep
4. (Implicit: `apply_implementation_edits` includes commit/push)

### Pattern Structure
```yaml
# Git initialization
checkout_branch:
  type: GitOperationStep
  operation: checkoutBranchFromBase
  baseBranch: main
  newBranch: ${featureBranchName}

# Verify changes exist
verify_diff:
  type: GitOperationStep
  operation: verifyRemoteBranchHasDiff
  depends_on: [apply_edits]

# Ensure remote sync
ensure_branch_published:
  type: GitOperationStep
  operation: ensureBranchPublished
  depends_on: [verify_diff]
```

### Inputs
- `baseBranch` (default: "main")
- `featureBranchName` (from milestone slug or task id)
- Context: `repoRoot`, `branch`, `remote`

### Outputs
- `currentBranch` - active branch name
- `branchPublished` - boolean, branch on remote
- `hasDiff` - boolean, changes vs base

### Dashboard Interactions
**None** - purely git/local operations

### Reusability
**HIGH** - every workflow needs git setup
- Can be extracted to `sub-workflows/git-setup.yml`
- Parameterize base branch, branch naming strategy
- Used by: task workflows, hotfix workflows, feature workflows

---

## Pattern 2: Task Status Management

### Steps Involved
1. `mark_task_in_progress` - SimpleTaskStatusStep (status: "in_progress")
2. `mark_task_in_review` - SimpleTaskStatusStep (status: "in_review")
3. `mark_task_needs_rework_after_code_review` - SimpleTaskStatusStep (status: "blocked")
4. `mark_task_security_blocked` - SimpleTaskStatusStep (status: "blocked")
5. `mark_task_done` - SimpleTaskStatusStep (status: "done")
6. (Failure handler: `mark_task_blocked` - status: "blocked")

### Pattern Structure
```yaml
# Status transition
mark_task_{status}:
  type: SimpleTaskStatusStep
  config:
    status: "in_progress" | "in_review" | "blocked" | "done"
    comment: "Optional explanation"
    task_id: "${taskId}"  # optional, defaults to context
    project_id: "${projectId}"  # optional, defaults to context
```

### Dashboard API Called
**Endpoint:** `PATCH /projects/{projectId}/tasks/{taskId}`
**Payload:**
```json
{
  "status": "in_progress" | "in_review" | "blocked" | "done",
  "comment": "Optional explanation"
}
```

### Status Flow
```
not_started 
  → in_progress (workflow starts)
  → in_review (QA passes)
  → blocked (review fails)
  OR
  → done (all reviews pass)
```

### Reusability
**HIGH** - every workflow updates task status
- Can be extracted to utility function or simple step
- Consider: `sub-workflows/task-status-update.yml`
- Or: built-in step type (already SimpleTaskStatusStep)

**Current Status:** Already reusable (SimpleTaskStatusStep)
**Improvement:** Standardize when status updates happen across workflows

---

## Pattern 3: Review Execution

### Review Types (4)
1. **QA Review** (qa_request)
2. **Code Review** (code_review_request)
3. **Security Review** (security_request)
4. **DevOps Review** (devops_request)

### Pattern Structure (Identical for all reviews)
```yaml
{review_type}_request:
  type: PersonaRequestStep
  depends_on: [previous_step]
  outputs: ["{review_type}_request_result", "{review_type}_request_status"]
  config:
    step: "N-{review-type}"
    persona: "{review-persona}"
    intent: "{review_intent}"
    payload:
      task: "${task}"
      plan: "${planning_loop_plan_result}"
      implementation: "${implementation_request_result}"
      # Previous review results
      qa_result: "${qa_request_result}"  # for code/security/devops
      code_review_result: "${code_review_request_result}"  # for security/devops
      security_result: "${security_request_result}"  # for devops
      repo: "${repo_remote}"
      project_id: "${projectId}"
```

### Common Elements
- **Type:** PersonaRequestStep
- **Outputs:** `{type}_request_result`, `{type}_request_status`
- **Payload:** task, plan, implementation, repo, project_id
- **Dependencies:** Previous review results passed forward

### Differences
| Review Type | Persona | Depends On | Condition |
|------------|---------|------------|-----------|
| QA | tester-qa | ensure_branch_published | (none) |
| Code Review | code-reviewer | mark_task_in_review | (none) |
| Security | security-review | code_review_request | code_review_status == 'pass' |
| DevOps | devops | security_request | security_status == 'pass' |

### Dashboard Interactions
**None directly** - reviews write to `.ma/reviews/` directory
Results stored locally, not on dashboard (yet)

### Reusability
**MEDIUM** - similar structure but context differs
- Could extract common pattern: `sub-workflows/persona-review.yml`
- Parameters: persona, intent, previous_results, condition
- Challenge: Each review has different payload structure

---

## Pattern 4: Review Failure Handling ⚠️ **CRITICAL - 3 IMPLEMENTATIONS**

### Implementation 1: QA Failures (Complex, Embedded)
```yaml
qa_failure_coordination:
  type: QAFailureCoordinationStep  # Custom step type
  depends_on: [qa_request]
  condition: "${qa_request_status} == 'fail' || ${qa_request_status} == 'unknown'"
  config:
    maxPlanRevisions: 5
    taskCreationStrategy: "auto"
    tddAware: true
    evaluationStep: "evaluate-qa-plan"
    revisionStep: "qa-plan-revision"
    createdTasksStep: "qa-created-tasks"
    urgentPriorityScore: 1200
    deferredPriorityScore: 50
```

**Characteristics:**
- Custom step type (QAFailureCoordinationStep)
- **PM evaluation embedded inside step** (not visible in YAML)
- Plan revision loop embedded
- Task creation embedded
- TDD awareness built-in
- Code path: `createDashboardTaskEntriesWithSummarizer()` → `createDashboardTaskEntries()` → `createDashboardTask()`

---

### Implementation 2: Code Review Failures (Separate PM Step)
```yaml
# Step 1: PM evaluates failures
pm_prioritize_code_review_failures:
  type: PersonaRequestStep
  depends_on: [code_review_request]
  condition: "${code_review_request_status} == 'fail' || ${code_review_request_status} == 'unknown'"
  outputs: ["pm_code_review_decision"]
  config:
    persona: "project-manager"
    intent: "prioritize_code_review_failures"
    payload:
      code_review_result: "${code_review_request_result}"
      milestone: "${milestone}"
      # ... 200 lines of context_for_pm prompt ...

# Step 2: Create tasks from PM decision
create_code_review_followup_tasks:
  type: ReviewFailureTasksStep  # Different step type!
  depends_on: [pm_prioritize_code_review_failures]
  outputs: ["code_review_tasks_created"]
  config:
    pmDecisionVariable: "pm_code_review_decision"
    reviewType: "code_review"
    urgentPriorityScore: 1000
    deferredPriorityScore: 50
```

**Characteristics:**
- PM evaluation is separate PersonaRequestStep
- **200+ lines of prompt embedded in YAML** (context_for_pm)
- Task creation is separate ReviewFailureTasksStep
- No TDD awareness
- No plan revision loop
- Code path: `createDashboardTask()` directly from dashboard.ts

---

### Implementation 3: Security Review Failures (Copy-Paste of Code Review)
```yaml
# Step 1: PM evaluates failures
pm_prioritize_security_failures:
  type: PersonaRequestStep
  depends_on: [security_request]
  condition: "${security_request_status} == 'fail' || ${security_request_status} == 'unknown'"
  outputs: ["pm_security_decision"]
  config:
    persona: "project-manager"
    intent: "prioritize_security_failures"
    payload:
      security_result: "${security_request_result}"
      milestone: "${milestone}"
      # ... 250 lines of context_for_pm prompt ...

# Step 2: Create tasks from PM decision
create_security_review_followup_tasks:
  type: ReviewFailureTasksStep  # Same step type as code review
  depends_on: [pm_prioritize_security_failures]
  outputs: ["security_review_tasks_created"]
  config:
    pmDecisionVariable: "pm_security_decision"
    reviewType: "security_review"
    urgentPriorityScore: 1500  # Different priority!
    deferredPriorityScore: 50
```

**Characteristics:**
- **Identical structure to code review** (copy-paste)
- PM evaluation is separate PersonaRequestStep
- **250+ lines of prompt embedded in YAML** (slightly different context)
- Only difference: priority scores (1500 vs 1000)
- Same code path: `createDashboardTask()` directly from dashboard.ts

---

### Pattern Comparison

| Aspect | QA | Code Review | Security |
|--------|----|-----------|------------|
| **Step Type** | QAFailureCoordinationStep | ReviewFailureTasksStep | ReviewFailureTasksStep |
| **PM Evaluation** | Embedded (hidden) | Separate step | Separate step |
| **PM Prompt** | In code | 200 lines YAML | 250 lines YAML |
| **Task Creation** | Embedded | Separate step | Separate step |
| **Code Path** | taskManager.ts | dashboard.ts | dashboard.ts |
| **TDD Awareness** | ✅ Yes | ❌ No | ❌ No |
| **Plan Revision** | ✅ Yes | ❌ No | ❌ No |
| **Urgent Priority** | 1200 | 1000 | 1500 |
| **Lines in YAML** | 10 | 250 | 270 |

### Dashboard API Called

**For QA (via taskManager.ts):**
```
POST /projects/{projectId}/tasks (sequential, N tasks = N requests)
Body per task:
{
  title: "QA: {issue}",
  description: "...",
  status: "backlog",
  priority_score: 1200 or 50,
  milestone_slug: "future-enhancements" or current,
  parent_task_id: current task (if urgent),
  options: {
    create_milestone_if_missing: true  # Added in recent fix
  }
}
```

**For Code/Security (via dashboard.ts):**
```
POST /projects/{projectId}/tasks (sequential, N tasks = N requests)
Body per task:
{
  title: "CODE_REVIEW: {issue}" or "SECURITY: {issue}",
  description: "...",
  status: "backlog",
  priority_score: 1000/1500 or 50,
  milestone_slug: "future-enhancements" or current,
  parent_task_id: current task (if urgent),
  options: {
    create_milestone_if_missing: true  # Added in recent fix
  }
}
```

### Problem Summary
**Three different implementations for identical business logic:**
1. Different step types (QAFailureCoordinationStep vs ReviewFailureTasksStep)
2. Different code paths (taskManager.ts vs dashboard.ts)
3. Different PM patterns (embedded vs separate step)
4. Massive prompt duplication in YAML (450+ lines total)
5. N+1 API calls (should be bulk)

### Ideal Unified Pattern
```yaml
# Sub-workflow: review-failure-handling.yml
inputs:
  review_type: "qa" | "code_review" | "security_review"
  review_result: object
  review_status: string
  milestone: object
  urgent_priority: number
  deferred_priority: number

steps:
  # 1. PM evaluates failures
  - name: pm_evaluation
    type: PersonaRequestStep
    persona: project-manager
    intent: "prioritize_{review_type}_failures"
    prompt_template: "pm-review-prioritization.txt"  # Externalized!
    
  # 2. Create tasks in bulk
  - name: create_tasks
    type: BulkTaskCreationStep  # New step type!
    input: pm_evaluation.follow_up_tasks
    config:
      urgent_priority_score: ${urgent_priority}
      deferred_priority_score: ${deferred_priority}
      milestone_strategy: "urgent_to_current_deferred_to_backlog"
      
outputs:
  tasks_created: ${create_tasks.tasks_created}
  urgent_count: ${create_tasks.urgent_count}
  deferred_count: ${create_tasks.deferred_count}
```

**Benefits:**
- ✅ Single implementation for all review types
- ✅ PM prompts externalized (easier to maintain)
- ✅ Bulk task creation (10-100x faster)
- ✅ TDD awareness can be added uniformly
- ✅ Fix bugs once, applies to all reviews

### Reusability
**CRITICAL** - This is the main consolidation target
- Extract to `sub-workflows/review-failure-handling.yml`
- Replace 530 lines with ~50 lines
- Primary goal of Phase 2 (Review Consolidation)

---

## Pattern 5: Planning & Implementation

### Steps Involved
1. `context_request` - PersonaRequestStep (context persona)
2. `planning_loop` - PlanningLoopStep (planner + evaluator)
3. `implementation_request` - PersonaRequestStep (lead-engineer)
4. `apply_implementation_edits` - DiffApplyStep (parse, apply, commit, push)

### Pattern Structure
```yaml
# 1. Context gathering
context_request:
  type: PersonaRequestStep
  persona: context
  intent: context_gathering
  payload:
    task: "${task}"
    repo: "${repo_remote}"

# 2. Planning with evaluation loop
planning_loop:
  type: PlanningLoopStep
  depends_on: [context_request]
  config:
    maxIterations: 5
    plannerPersona: implementation-planner
    evaluatorPersona: plan-evaluator
    payload:
      task: "${task}"
      context: "${context_request_result}"

# 3. Implementation
implementation_request:
  type: PersonaRequestStep
  depends_on: [planning_loop]
  persona: lead-engineer
  intent: implementation
  payload:
    task: "${task}"
    plan: "${planning_loop_plan_result}"

# 4. Apply changes
apply_implementation_edits:
  type: DiffApplyStep
  depends_on: [implementation_request]
  config:
    source_output: "implementation_request"
    validation: "syntax_check"
    commit_message: "feat: implement ${taskName}"
```

### Inputs
- `task` - task object from dashboard
- `repo_remote` - repository URL
- `project_id` - project identifier

### Outputs
- `context_request_result` - gathered context
- `planning_loop_plan_result` - approved plan
- `implementation_request_result` - implementation details
- Git changes committed and pushed

### Dashboard Interactions
**None directly** - reads task from context, no updates

### Reusability
**HIGH** - core workflow for any task
- Can be extracted to `sub-workflows/task-implementation.yml`
- Used by: normal tasks, QA fix iterations, hotfixes
- Already somewhat modular (PlanningLoopStep encapsulates iteration)

---

## Pattern 6: Iteration Loops

### Type 1: Planning Evaluation Loop (Embedded in PlanningLoopStep)
```yaml
planning_loop:
  type: PlanningLoopStep
  config:
    maxIterations: 5
    plannerPersona: implementation-planner
    evaluatorPersona: plan-evaluator
    planStep: "2-plan"
    evaluateStep: "2.5-evaluate-plan"
```

**Loop Logic:** Plan → Evaluate → (if not approved) → Revise → Evaluate → ...
**Max Iterations:** 5
**Exit Condition:** Plan approved OR max iterations reached

---

### Type 2: QA Fix Iteration Loop
```yaml
qa_iteration_loop:
  type: QAIterationLoopStep
  condition: "${qa_request_status} == 'fail' || ${qa_request_status} == 'unknown'"
  config:
    maxIterations: null  # unlimited
    planningStep: "qa-fix-planning"
    implementationStep: "qa-fix-implementation"
    qaRetestStep: "qa-retest"
```

**Loop Logic:** Plan fix → Implement fix → Apply changes → Retest → (if still failing) → ...
**Max Iterations:** Unlimited (respects env COORDINATOR_MAX_REVISION_ATTEMPTS)
**Exit Condition:** QA passes OR max iterations reached

---

### Pattern Commonality
Both loops:
- Encapsulated in custom step types
- Support max iteration limits
- Iterate until success or limit
- Use persona requests internally

### Dashboard Interactions
**None directly** - iteration logic is internal

### Reusability
**MEDIUM** - already encapsulated in step types
- Current implementation works well
- Could be standardized interface: `IterationLoopStep`
- Parameters: steps to execute, exit condition, max iterations

---

## Pattern 7: Milestone Operations

### Steps Involved
1. `check_milestone_completion` - MilestoneStatusCheckStep
2. `pm_evaluate_suggestions` - PersonaRequestStep (only if incomplete)

### Pattern Structure
```yaml
# 1. Check if milestone has remaining tasks
check_milestone_completion:
  type: MilestoneStatusCheckStep
  depends_on: [mark_task_done]
  config:
    check_type: "incomplete_tasks"
    include_cancelled: false
  outputs:
    milestone_has_remaining_tasks: boolean
    remaining_tasks: array

# 2. PM evaluates urgency of remaining/suggested tasks
pm_evaluate_suggestions:
  type: PersonaRequestStep
  depends_on: [check_milestone_completion]
  condition: "${milestone_has_remaining_tasks} == true"
  persona: project-manager
  intent: evaluate_task_urgency
  payload:
    milestone: "${milestone}"
    completed_task: "${task}"
    remaining_tasks: "${check_milestone_completion_remaining_tasks}"
    suggested_tasks: "${qa_iteration_loop_suggested_tasks}"
```

### Dashboard API Called

**Check Completion:**
```
GET /projects/{projectId}/milestones/{milestoneId}/tasks
  ?status=in_progress,blocked,backlog
  &include_cancelled=false

Response:
{
  tasks: [array of incomplete tasks],
  total: count
}
```

**Milestone Context (implicit, fetched earlier):**
```
GET /projects/{projectId}/milestones/{milestoneId}

Response:
{
  id: string,
  name: string,
  slug: string,
  status: string,
  completion_percentage: number
}
```

### Reusability
**LOW** - very specific to end-of-task workflow
- Milestone completion check is useful
- PM suggestion evaluation is optional
- Not worth extracting to sub-workflow

---

## Dashboard Operations Summary

### 1. Task Status Updates (Pattern 2)
**Operation:** Update task status  
**API:** `PATCH /projects/{projectId}/tasks/{taskId}`  
**Frequency:** 5-6 times per task (in_progress → in_review → blocked/done)  
**Current:** Working, no changes needed  
**Future:** Could batch status updates if multiple tasks

---

### 2. Task Creation from Review Failures (Pattern 4)
**Operation:** Create follow-up tasks  
**API:** `POST /projects/{projectId}/tasks` (sequential, N+1 problem)  
**Frequency:** 0-10+ tasks per review failure  
**Current:** **BROKEN** - 3 implementations, milestone bugs, N+1 calls  
**Future:** **MUST FIX** - Bulk endpoint `POST /tasks:bulk`

**Proposed Bulk API:**
```
POST /projects/{projectId}/tasks:bulk

Body:
{
  tasks: [
    {
      title: "...",
      description: "...",
      status: "backlog",
      priority_score: 1200,
      milestone_slug: "future-enhancements",
      parent_task_id: "parent-uuid",
      external_id: "qa-failure-abc123"  # for deduplication
    },
    // ... more tasks
  ],
  options: {
    create_milestone_if_missing: true,
    upsert_by_external_id: true  # update if exists
  }
}

Response:
{
  created: 8,
  updated: 2,
  skipped: 0,
  tasks: [array of created/updated tasks]
}
```

**Benefits:**
- Single HTTP request vs N requests
- 10-100x faster
- Transactional (all or nothing option)
- Deduplication built-in

---

### 3. Milestone Queries (Pattern 7)
**Operation:** Get incomplete tasks  
**API:** `GET /projects/{projectId}/milestones/{milestoneId}/tasks?status=...`  
**Frequency:** Once per task (at completion)  
**Current:** Working, could optimize with pagination  
**Future:** Add `summary` endpoint for counts only

**Proposed Summary API:**
```
GET /projects/{projectId}/milestones/{milestoneId}/summary

Response:
{
  total_tasks: 45,
  completed: 30,
  in_progress: 10,
  blocked: 3,
  backlog: 2,
  completion_percentage: 66.7
}
```

---

### 4. Milestone Context Resolution (Implicit)
**Operation:** Get milestone details  
**API:** `GET /projects/{projectId}/milestones/{milestoneId}`  
**Frequency:** Once per workflow (before starting)  
**Current:** Working, no changes needed  
**Future:** Cache milestone data (rarely changes during workflow)

---

### 5. Project Status (Not in legacy-compatible-task-flow)
**Operation:** Get overall project status  
**API:** `GET /projects/{projectId}/status`  
**Frequency:** Unknown (WorkflowCoordinator level)  
**Current:** Working  
**Future:** Include in new dashboard design

---

### 6. Task Query (Implicit, WorkflowCoordinator level)
**Operation:** Get single task details  
**API:** `GET /projects/{projectId}/tasks/{taskId}`  
**Frequency:** Once per workflow (before starting)  
**Current:** Working  
**Future:** Could batch if processing multiple tasks

---

## New Dashboard API Requirements (Phase 1)

Based on pattern analysis, the new dashboard API should support:

### Must Have (Core Operations)
1. ✅ **Bulk Task Creation/Update**
   - `POST /projects/{id}/tasks:bulk`
   - Single request for multiple tasks
   - Upsert semantics (external_id deduplication)
   - Milestone auto-creation

2. ✅ **Task Status Update**
   - `PATCH /projects/{id}/tasks/{taskId}`
   - Current implementation works

3. ✅ **Milestone Task Query**
   - `GET /projects/{id}/milestones/{milestoneId}/tasks`
   - Filter by status
   - Pagination

4. ✅ **Milestone Details**
   - `GET /projects/{id}/milestones/{milestoneId}`
   - Include completion percentage

### Should Have (Optimization)
5. **Milestone Summary**
   - `GET /projects/{id}/milestones/{milestoneId}/summary`
   - Counts only (faster than full query)

6. **Batch Task Status Update**
   - `PATCH /projects/{id}/tasks:bulk`
   - Update multiple task statuses in one call

### Nice to Have (Future)
7. **Project Sync**
   - `POST /projects/{id}:sync`
   - Idempotent sync of project state
   - Bulk upsert of milestones + tasks

8. **Webhook/Events**
   - Task status changed
   - Milestone completed
   - For real-time updates

---

## Recommendations for Sub-Workflow Decomposition

### Priority 1: Review Failure Handling (Critical)
**Extract:** `sub-workflows/review-failure-handling.yml`  
**Replaces:** 530 lines → 50 lines  
**Impact:** Fixes 3 implementations, enables bulk creation, centralizes PM logic

**Structure:**
```yaml
name: review-failure-handling
inputs:
  - review_type: string
  - review_result: object
  - milestone_context: object
  - urgent_priority: number
  
steps:
  - pm_evaluation (PersonaRequestStep with externalized prompt)
  - create_tasks_bulk (BulkTaskCreationStep)
  - mark_original_blocked (SimpleTaskStatusStep)
  
outputs:
  - tasks_created: number
  - urgent_count: number
  - deferred_count: number
```

---

### Priority 2: Task Implementation (High Value)
**Extract:** `sub-workflows/task-implementation.yml`  
**Replaces:** Planning + Implementation pattern  
**Impact:** Reusable across task workflows, QA fix iterations, hotfixes

**Structure:**
```yaml
name: task-implementation
inputs:
  - task: object
  - context: object (optional)
  - plan: object (optional, skip planning if provided)
  
steps:
  - context_request (if not provided)
  - planning_loop (if plan not provided)
  - implementation_request
  - apply_edits
  
outputs:
  - plan: object
  - implementation: object
  - changes_applied: boolean
```

---

### Priority 3: Git Operations (Medium Value)
**Extract:** `sub-workflows/git-setup.yml`  
**Replaces:** Branch setup, verification, publishing  
**Impact:** Standardizes git workflow across all task types

**Structure:**
```yaml
name: git-setup
inputs:
  - base_branch: string (default: main)
  - branch_name: string
  - require_diff: boolean (default: true)
  
steps:
  - checkout_branch
  - verify_diff (if require_diff)
  - ensure_published
  
outputs:
  - branch: string
  - has_diff: boolean
  - published: boolean
```

---

### Priority 4: Review Execution (Low Value)
**Extract:** `sub-workflows/persona-review.yml`  
**Replaces:** QA/Code/Security/DevOps review pattern  
**Impact:** Standardizes review execution, but limited reuse benefit

**Decision:** Maybe not worth it - reviews have different contexts
**Alternative:** Keep as inline steps, focus on failure handling standardization

---

## Next Steps

1. ✅ **Complete** - Day 2: Pattern extraction
2. ⏳ **Next** - Day 3: Design sub-workflow architecture
   - Define sub-workflow interfaces
   - Design composition strategy
   - Map dependencies between sub-workflows
3. ⏳ **Pending** - Day 4: Create rationalization proposal
4. ⏳ **Pending** - Day 5: User checkpoint #0
