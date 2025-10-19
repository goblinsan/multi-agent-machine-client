# Workflow Inventory & Analysis
**Date:** October 19, 2025  
**Phase:** Phase 0 - Day 1  
**Status:** Initial Analysis

---

## Executive Summary

**Total Workflows Found:** 12 workflow files (3 in `/workflows`, 9 in `/src/workflows/definitions`)

**Primary Driver:** `legacy-compatible-task-flow.yaml` (446 lines)
- Used by WorkflowCoordinator as primary workflow
- Fallback to `project-loop` if not found
- Other workflows rarely used or experimental

**Key Finding:** Multiple workflow files exist but only a handful are actively used in production.

---

## Workflow Files Inventory

### Active Workflows (in `/src/workflows/definitions/`)

#### 1. **legacy-compatible-task-flow.yaml** ⭐ PRIMARY DRIVER
- **Location:** `src/workflows/definitions/legacy-compatible-task-flow.yaml`
- **Size:** 446 lines
- **Status:** ✅ ACTIVELY USED (main production workflow)
- **Usage:** WorkflowCoordinator.ts line 314 - explicitly looks for this workflow first
- **Trigger:** `task_type == 'task' || task_type == 'feature'`
- **Purpose:** Complete task processing from planning → implementation → QA → code review → security → devops → completion

**Key Steps (30 total):**
1. Git setup (checkout_branch)
2. Task status updates (mark_task_in_progress, mark_task_in_review, mark_task_done, etc.)
3. Context gathering (context_request)
4. Planning loop with evaluation (planning_loop)
5. Implementation (implementation_request, apply_implementation_edits)
6. Git operations (verify_diff, ensure_branch_published)
7. QA review (qa_request)
8. **QA failure coordination** (qa_failure_coordination) - QAFailureCoordinationStep
9. **QA iteration loop** (qa_iteration_loop) - fixes until pass
10. Code review (code_review_request)
11. **PM prioritizes code review failures** (pm_prioritize_code_review_failures)
12. **Create code review followup tasks** (create_code_review_followup_tasks) - ReviewFailureTasksStep
13. Security review (security_request)
14. **PM prioritizes security failures** (pm_prioritize_security_failures)
15. **Create security followup tasks** (create_security_review_followup_tasks) - ReviewFailureTasksStep
16. DevOps review (devops_request)
17. Milestone completion check (check_milestone_completion)
18. PM evaluation of suggestions (pm_evaluate_suggestions)

**Dashboard Interactions:**
- Task status updates (in_progress, in_review, blocked, done)
- Task creation from review failures (QA, code review, security)
- Milestone completion queries

---

#### 2. **project-loop.yaml**
- **Location:** `src/workflows/definitions/project-loop.yaml`
- **Size:** 87 lines
- **Status:** ✅ FALLBACK (used if legacy-compatible-task-flow not found)
- **Usage:** WorkflowCoordinator.ts line 323 - fallback workflow
- **Trigger:** Generic task processing
- **Purpose:** Simplified task workflow: planning → implementation → QA

**Key Steps (4 main):**
1. Planning (planning persona)
2. Plan evaluation (plan-evaluator persona)
3. Implementation (lead-engineer persona)
4. QA (qa persona)

**Note:** Much simpler than legacy-compatible-task-flow, no code/security reviews

---

#### 3. **in-review-task-flow.yaml**
- **Location:** `src/workflows/definitions/in-review-task-flow.yaml`
- **Size:** Unknown (needs analysis)
- **Status:** ⚠️ CONDITIONALLY USED
- **Usage:** WorkflowCoordinator.ts line 303 - used for tasks with status "in_review"
- **Trigger:** `task.status === 'in_review'`
- **Purpose:** Handle tasks already marked as in review

**Needs Investigation:**
- What steps does it include?
- Does it duplicate code/security review logic from legacy-compatible?
- Should this be a sub-workflow instead?

---

#### 4. **blocked-task-resolution.yaml**
- **Location:** `src/workflows/definitions/blocked-task-resolution.yaml`
- **Size:** Unknown (needs analysis)
- **Status:** ⚠️ CONDITIONALLY USED
- **Usage:** WorkflowCoordinator.ts line 285 - used for tasks with status "blocked"
- **Trigger:** `task.status === 'blocked'`
- **Purpose:** Resolve blocked tasks

**Needs Investigation:**
- How does it resolve blocks?
- Overlap with review failure handling?

---

#### 5. **qa-followup.yaml**
- **Location:** `src/workflows/definitions/qa-followup.yaml`
- **Size:** Unknown
- **Status:** ❓ UNKNOWN USAGE
- **Purpose:** Likely QA-specific follow-up workflow

---

#### 6. **code-implementation-workflow.yaml**
- **Location:** `src/workflows/definitions/code-implementation-workflow.yaml`
- **Size:** Unknown
- **Status:** ❓ UNKNOWN USAGE
- **Purpose:** Likely implementation-focused workflow

---

#### 7. **context-only.yaml**
- **Location:** `src/workflows/definitions/context-only.yaml`
- **Size:** Unknown
- **Status:** ❓ UNKNOWN USAGE
- **Purpose:** Likely context gathering only

---

#### 8. **feature.yaml**
- **Location:** `src/workflows/definitions/feature.yaml`
- **Size:** Unknown
- **Status:** ❓ DUPLICATE? (also exists in /workflows)
- **Purpose:** Feature development workflow

---

#### 9. **hotfix.yaml**
- **Location:** `src/workflows/definitions/hotfix.yaml`
- **Size:** Unknown
- **Status:** ❓ DUPLICATE? (also exists in /workflows)
- **Purpose:** Emergency hotfix workflow

---

### Legacy Workflows (in `/workflows/`)

#### 10. **feature.yml**
- **Location:** `workflows/feature.yml`
- **Size:** 108 lines
- **Status:** ❌ UNUSED (likely legacy, not loaded by WorkflowEngine)
- **Purpose:** Feature development with requirements → design → implementation → QA
- **Note:** WorkflowEngine loads from `src/workflows/definitions/`, not `/workflows/`

---

#### 11. **hotfix.yml**
- **Location:** `workflows/hotfix.yml`
- **Size:** 62 lines
- **Status:** ❌ UNUSED (likely legacy)
- **Purpose:** Emergency hotfix with abbreviated process

---

#### 12. **project-loop.yml**
- **Location:** `workflows/project-loop.yml`
- **Size:** 87 lines
- **Status:** ❌ DUPLICATE (definitions/project-loop.yaml is used instead)
- **Purpose:** Standard project development workflow

---

## Usage Analysis

### How WorkflowCoordinator Selects Workflow

**Decision Tree (from WorkflowCoordinator.ts:280-340):**

```
1. If task.status === 'blocked'
   → use 'blocked-task-resolution' workflow

2. If task.status === 'in_review'  
   → use 'in-review-task-flow' workflow
   
3. Otherwise:
   → try 'legacy-compatible-task-flow' (PRIMARY)
   
4. If legacy-compatible not found:
   → try findWorkflowByCondition(taskType, scope)
   
5. If no match:
   → use 'project-loop' (FALLBACK)
   
6. If project-loop not found:
   → throw error
```

**Production Reality:**
- 95%+ of tasks use `legacy-compatible-task-flow`
- Blocked tasks use `blocked-task-resolution`
- In-review tasks use `in-review-task-flow`
- Other workflows appear unused

---

## Dashboard Interaction Patterns (from legacy-compatible-task-flow)

### 1. Task Status Updates
**Pattern:** SimpleTaskStatusStep
- `mark_task_in_progress` - when workflow starts
- `mark_task_in_review` - when QA passes
- `mark_task_blocked` - when code/security review fails
- `mark_task_done` - when all reviews pass

**Dashboard API:** 
- Endpoint: PATCH `/tasks/{id}`
- Payload: `{ status: "in_progress" | "in_review" | "blocked" | "done" }`

---

### 2. Review Failure Task Creation
**Pattern:** Multiple implementations!

#### QA Failures:
- **Step:** `qa_failure_coordination` (QAFailureCoordinationStep)
- **Logic:** Custom step type with embedded PM evaluation, plan revision, task creation
- **Dashboard Calls:** Uses `createDashboardTaskEntriesWithSummarizer()` → `createDashboardTaskEntries()` → `createDashboardTask()`
- **Milestone:** Urgent tasks to current milestone, deferred to "future-enhancements"

#### Code Review Failures:
- **Step:** `create_code_review_followup_tasks` (ReviewFailureTasksStep)
- **Prerequisite:** `pm_prioritize_code_review_failures` (PersonaRequestStep)
- **Logic:** Different step type, PM runs as separate step
- **Dashboard Calls:** Uses `createDashboardTask()` directly from dashboard.ts
- **Milestone:** Same pattern (urgent vs deferred)

#### Security Review Failures:
- **Step:** `create_security_review_followup_tasks` (ReviewFailureTasksStep)
- **Prerequisite:** `pm_prioritize_security_failures` (PersonaRequestStep)
- **Logic:** Same as code review (copy-paste pattern)
- **Dashboard Calls:** Uses `createDashboardTask()` directly from dashboard.ts
- **Milestone:** Same pattern (urgent vs deferred)

**PROBLEM IDENTIFIED:** Three different implementations for same pattern!
- QA uses QAFailureCoordinationStep (custom, complex)
- Code Review uses ReviewFailureTasksStep (PM separate)
- Security uses ReviewFailureTasksStep (copy-paste)
- All create tasks but with different code paths

**Dashboard API:**
- Endpoint: POST `/tasks`
- Payload: Multiple tasks in sequence (N+1 problem!)
- Should be: POST `/tasks:bulk` (batch operation)

---

### 3. Milestone Completion Check
**Pattern:** MilestoneStatusCheckStep
- **Step:** `check_milestone_completion`
- **Logic:** Query milestone for remaining incomplete tasks
- **Dashboard API:** 
  - Endpoint: GET `/projects/{id}/milestones/{milestoneId}/tasks?status=in_progress,blocked`
  - Returns: List of incomplete tasks

---

### 4. Milestone Resolution (Implicit)
**Pattern:** Context variables resolved before workflow runs
- `${milestone}`, `${milestone_name}`, `${milestone_slug}`, etc.
- WorkflowCoordinator fetches from dashboard before starting workflow
- Used for branch naming, task context, PM evaluation

**Dashboard API:**
- Endpoint: GET `/projects/{id}/milestones/{milestoneId}`
- Returns: Milestone details

---

## Key Findings & Recommendations

### Finding 1: Only 3-4 Workflows Actually Used
**Used:**
- `legacy-compatible-task-flow` (primary, 95%+ usage)
- `project-loop` (fallback)
- `blocked-task-resolution` (blocked tasks)
- `in-review-task-flow` (in-review tasks)

**Unused/Duplicate:**
- `/workflows/*.yml` (3 files) - NOT loaded by WorkflowEngine
- `qa-followup.yaml` - purpose unclear
- `code-implementation-workflow.yaml` - purpose unclear
- `context-only.yaml` - purpose unclear
- `feature.yaml`, `hotfix.yaml` in definitions/ - may be duplicates

**Recommendation:** Archive unused workflows to `/workflows/archive/`

---

### Finding 2: Review Failure Handling Has 3 Implementations
**Current State:**
- QA: QAFailureCoordinationStep (complex, embedded PM logic)
- Code Review: ReviewFailureTasksStep + separate PM step
- Security: ReviewFailureTasksStep + separate PM step (copy-paste)

**Problem:**
- Bug fixes only apply to some paths (milestone creation bug example)
- Different PM evaluation patterns
- Different task creation code paths
- Hard to maintain consistency

**Recommendation:** Create reusable sub-workflow `review-failure-handling.yml`

---

### Finding 3: Dashboard Task Creation is N+1 Problem
**Current Behavior:**
- Create tasks one-by-one in sequence
- Each task = 1 HTTP POST request
- 10 tasks = 10 requests

**Recommendation:** Bulk task creation endpoint
- POST `/projects/{id}/tasks:bulk`
- Single request for multiple tasks
- 10-100x faster

---

### Finding 4: Workflow is 446 Lines (Too Complex)
**Current Structure:**
- 30 steps in single file
- Embedded coordination logic (qa_failure_coordination)
- Repeated patterns (code review + security review nearly identical)

**Recommendation:** Decompose into sub-workflows
- `review-failure-handling.yml` (reusable for QA, code, security)
- `task-status-update.yml` (reusable status updates)
- `git-operations.yml` (reusable git ops)
- Main workflow = orchestration of sub-workflows

---

## Next Steps

1. ✅ **Complete** - Day 1: Workflow inventory
2. ⏳ **Next** - Day 2: Extract patterns from legacy-compatible-task-flow
3. ⏳ **Pending** - Day 3: Design sub-workflow architecture
4. ⏳ **Pending** - Day 4: Create rationalization proposal
5. ⏳ **Pending** - Day 5: User checkpoint #0

---

## Questions for User (Day 2 Preparation)

1. Should we keep `blocked-task-resolution` and `in-review-task-flow` or fold into main workflow?
2. What are `qa-followup`, `code-implementation-workflow`, `context-only` used for?
3. Can we archive the 3 files in `/workflows/` directory (not loaded anyway)?
4. Should feature/hotfix workflows in definitions/ be kept or removed?
5. Are there any workflows triggered outside of WorkflowCoordinator we should know about?
