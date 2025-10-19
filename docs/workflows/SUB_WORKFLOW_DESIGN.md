# Sub-Workflow Design
**Date:** October 19, 2025  
**Phase:** Phase 0 - Day 3  
**Status:** Design Complete

---

## Executive Summary

Designed 3 core sub-workflows to replace 530+ lines of duplicated code in `legacy-compatible-task-flow.yaml`:

1. **review-failure-handling** - Unified review failure coordination (Priority 1)
2. **task-implementation** - Reusable planning + implementation flow (Priority 2)
3. **git-operations** - Standard git setup pattern (Priority 3)

**Impact:** 446-line workflow → ~200 lines (55% reduction)  
**Maintenance:** 3 implementations → 1 (67% reduction)

---

## Sub-Workflow Architecture

### Design Principles

1. **Single Responsibility** - Each sub-workflow does ONE thing well
2. **Clear Interfaces** - Explicit inputs/outputs, no hidden dependencies
3. **Composability** - Sub-workflows can be chained and nested
4. **Parameterization** - Behavior configurable via inputs
5. **Reusability** - Used by multiple parent workflows
6. **Testability** - Can be tested in isolation

### Sub-Workflow Invocation Pattern

```yaml
# In parent workflow
- name: handle_review_failure
  type: SubWorkflowStep
  workflow: "review-failure-handling"  # Sub-workflow name
  inputs:
    review_type: "qa"
    review_result: "${qa_request_result}"
    review_status: "${qa_request_status}"
    milestone_context:
      id: "${milestone}"
      name: "${milestone_name}"
      completion_percentage: "${milestone_completion_percentage}"
    priority_scores:
      urgent: 1200
      deferred: 50
  outputs:
    tasks_created: "${handle_review_failure_tasks_created}"
    urgent_count: "${handle_review_failure_urgent_count}"
```

**Key Features:**
- Type: `SubWorkflowStep` (new step type to implement)
- `workflow` parameter specifies which sub-workflow
- `inputs` passed to sub-workflow (validated against schema)
- `outputs` mapped back to parent context
- Sub-workflow runs in isolated context, returns outputs

---

## Sub-Workflow 1: review-failure-handling ⭐ PRIORITY 1

### Purpose
Unified handling of all review failures (QA, Code Review, Security, DevOps)

### Current Problem
- QA: QAFailureCoordinationStep (10 lines YAML + complex hidden code)
- Code Review: PM step + ReviewFailureTasksStep (250 lines YAML)
- Security: PM step + ReviewFailureTasksStep (270 lines YAML)
- **Total: 530 lines, 3 implementations, 2 code paths**

### Proposed Solution
**Single sub-workflow:** 50 lines YAML, external prompts, unified code path

---

### Interface Definition

```yaml
name: "review-failure-handling"
version: "1.0.0"
description: "Unified review failure coordination with PM prioritization and bulk task creation"

# Input schema
inputs:
  # Review context
  review_type:
    type: string
    required: true
    enum: ["qa", "code_review", "security_review", "devops_review"]
    description: "Type of review that failed"
  
  review_result:
    type: object
    required: true
    description: "Full review result output (includes findings, status, details)"
  
  review_status:
    type: string
    required: true
    enum: ["pass", "fail", "unknown"]
    description: "Review status"
  
  # Milestone context for PM decision
  milestone_context:
    type: object
    required: true
    properties:
      id: string
      name: string
      slug: string
      description: string
      status: string
      completion_percentage: number
    description: "Current milestone information for PM evaluation"
  
  # Task context
  task:
    type: object
    required: true
    description: "Current task being processed"
  
  parent_task_id:
    type: string
    required: false
    description: "ID of parent task (for urgent subtasks)"
  
  # Priority configuration
  priority_scores:
    type: object
    required: true
    properties:
      urgent: number
      deferred: number
    description: "Priority scores for urgent vs deferred tasks"
  
  # Optional configuration
  config:
    type: object
    required: false
    properties:
      tdd_aware: boolean
      tdd_stage: string
      create_deferred_tasks: boolean
      backlog_milestone_slug: string
      block_original_task: boolean
    defaults:
      tdd_aware: false
      create_deferred_tasks: true
      backlog_milestone_slug: "future-enhancements"
      block_original_task: true
  
  # Project context
  project_id:
    type: string
    required: true
  
  repo:
    type: string
    required: true

# Output schema
outputs:
  tasks_created:
    type: number
    description: "Total number of tasks created"
  
  urgent_tasks_created:
    type: number
    description: "Number of urgent tasks created (linked to current milestone)"
  
  deferred_tasks_created:
    type: number
    description: "Number of deferred tasks created (added to backlog)"
  
  task_ids:
    type: array
    items: string
    description: "IDs of all created tasks"
  
  pm_decision:
    type: object
    description: "Full PM decision object"
  
  original_task_blocked:
    type: boolean
    description: "Whether original task was marked as blocked"
```

---

### Implementation

```yaml
name: "review-failure-handling"
version: "1.0.0"
description: "Unified review failure coordination with PM prioritization and bulk task creation"

steps:
  # Step 1: Check TDD awareness (skip task creation during failing test stage)
  - name: check_tdd_gate
    type: ConditionalStep
    description: "Skip task creation if in TDD failing test stage"
    config:
      condition: |
        ${config.tdd_aware} == true && 
        (${config.tdd_stage} == 'write_failing_test' || 
         ${config.tdd_stage} == 'failing_test' ||
         ${task.tdd_stage} == 'write_failing_test' ||
         ${task.tdd_stage} == 'failing_test')
      on_true:
        action: "skip_workflow"
        message: "Skipping task creation: TDD failing test stage"
      on_false:
        action: "continue"

  # Step 2: PM evaluates failures and decides priority
  - name: pm_evaluation
    type: PersonaRequestStep
    description: "PM evaluates review failures and prioritizes follow-up work"
    depends_on: ["check_tdd_gate"]
    config:
      step: "pm-review-prioritization"
      persona: "project-manager"
      intent: "prioritize_${review_type}_failures"
      prompt_template: "prompts/pm-review-prioritization.txt"  # EXTERNALIZED!
      payload:
        review_type: "${review_type}"
        review_result: "${review_result}"
        review_status: "${review_status}"
        task: "${task}"
        milestone: "${milestone_context}"
        project_id: "${project_id}"
        repo: "${repo}"
    outputs:
      pm_decision: object

  # Step 3: Parse PM decision and normalize format
  - name: parse_pm_decision
    type: PMDecisionParserStep  # New step type using ReviewFailureService
    description: "Parse and normalize PM decision (handles multiple formats)"
    depends_on: ["pm_evaluation"]
    config:
      input: "${pm_evaluation}"
      normalize: true
    outputs:
      decision: string  # "immediate_fix" | "defer"
      reasoning: string
      immediate_issues: array
      deferred_issues: array
      follow_up_tasks: array

  # Step 4: Create tasks in bulk (NEW!)
  - name: create_tasks_bulk
    type: BulkTaskCreationStep  # New step type
    description: "Create all follow-up tasks in single bulk operation"
    depends_on: ["parse_pm_decision"]
    condition: "${parse_pm_decision.follow_up_tasks.length} > 0"
    config:
      project_id: "${project_id}"
      tasks: "${parse_pm_decision.follow_up_tasks}"
      priority_mapping:
        critical: "${priority_scores.urgent}"
        high: "${priority_scores.urgent}"
        medium: "${priority_scores.deferred}"
        low: "${priority_scores.deferred}"
      milestone_strategy:
        urgent: "${milestone_context.id}"
        deferred: "${config.backlog_milestone_slug}"
      parent_task_mapping:
        urgent: "${parent_task_id}"
        deferred: null
      title_prefix: "${review_type.upper()}"
      options:
        create_milestone_if_missing: true
        upsert_by_external_id: true
        external_id_template: "${review_type}-${task.id}-${task.title_slug}"
    outputs:
      tasks_created: number
      urgent_tasks_created: number
      deferred_tasks_created: number
      task_ids: array
      skipped_duplicates: number

  # Step 5: Mark original task as blocked (if configured)
  - name: mark_original_blocked
    type: SimpleTaskStatusStep
    description: "Mark original task as blocked to prevent loop"
    depends_on: ["create_tasks_bulk"]
    condition: "${config.block_original_task} == true && ${create_tasks_bulk.urgent_tasks_created} > 0"
    config:
      status: "blocked"
      comment: "${review_type} failed - ${create_tasks_bulk.urgent_tasks_created} urgent tasks created"
      task_id: "${task.id}"
      project_id: "${project_id}"
    outputs:
      original_task_blocked: boolean

# Outputs mapped from steps
outputs:
  tasks_created: "${create_tasks_bulk.tasks_created || 0}"
  urgent_tasks_created: "${create_tasks_bulk.urgent_tasks_created || 0}"
  deferred_tasks_created: "${create_tasks_bulk.deferred_tasks_created || 0}"
  task_ids: "${create_tasks_bulk.task_ids || []}"
  pm_decision: "${pm_evaluation.pm_decision}"
  original_task_blocked: "${mark_original_blocked.original_task_blocked || false}"
```

---

### PM Prompt Externalization

Instead of 450+ lines in YAML, create:

**File:** `prompts/pm-review-prioritization.txt`

```
You are evaluating {{review_type}} failures for a task in the {{milestone.name}} milestone.

CONTEXT:
- Review Type: {{review_type}}
- Review Status: {{review_status}}
- Milestone: {{milestone.name}} ({{milestone.completion_percentage}}% complete)
- Milestone Status: {{milestone.status}}
- Task: {{task.title}}

REVIEW RESULTS:
{{review_result | json}}

{% if review_type == 'qa' %}
SEVERITY LEVELS FOR QA:
- SEVERE: Test failures, broken functionality - MUST fix immediately
- HIGH: Major bugs, data integrity issues - Should fix before merge
- MEDIUM: Minor bugs, edge cases - Can defer if not critical path
- LOW: Suggestions, optimizations - Defer to backlog

DECISION FRAMEWORK:
1. ALWAYS require immediate fix if SEVERE findings exist
2. For HIGH findings: Should fix before merge unless blocking development
3. For MEDIUM/LOW: Can defer to backlog with tasks created
{% endif %}

{% if review_type == 'code_review' %}
SEVERITY LEVELS FOR CODE REVIEW:
- SEVERE: Compile errors, critical bugs, broken functionality - MUST fix immediately
- HIGH: Major tech debt, performance issues - Should fix before merge
- MEDIUM: Code smells, style issues - Stage-dependent (defer if <50% milestone)
- LOW: Refactoring suggestions - Always defer to backlog

DECISION FRAMEWORK:
1. ALWAYS require immediate fix if SEVERE or HIGH findings exist
2. For MEDIUM: Defer if milestone <50% complete OR MVP/POC stage
3. For LOW: Always defer to backlog
{% endif %}

{% if review_type == 'security_review' %}
SEVERITY LEVELS FOR SECURITY:
- SEVERE: Critical vulnerabilities (RCE, auth bypass, data exposure) - MUST fix immediately (ANY stage)
- HIGH: Significant risks (CVEs, weak crypto, XSS) - Fix in production/beta, can defer in early stage
- MEDIUM: Security concerns (missing headers, outdated deps) - Stage-dependent
- LOW: Hardening opportunities - Always defer to backlog

STAGE DETECTION:
- EARLY: MVP, POC, prototype, initial, foundation
- BETA: beta, testing, pre-release, RC
- PRODUCTION: production, release, v1.0, GA, launch

DECISION FRAMEWORK:
1. ALWAYS fix SEVERE (any stage)
2. Fix HIGH in production/beta, can defer in early stage
3. Fix MEDIUM in production, defer in beta/early
4. Always defer LOW to backlog
{% endif %}

YOUR RESPONSE (JSON):
{
  "decision": "defer" | "immediate_fix",
  "reasoning": "Explain why (include severity counts)",
  "detected_stage": "early|beta|production",  // for security only
  "immediate_issues": ["List of SEVERE/HIGH findings requiring immediate fix"],
  "deferred_issues": ["List of MEDIUM/LOW findings to add to backlog"],
  "follow_up_tasks": [
    {
      "title": "Brief task title",
      "description": "Detailed description with context",
      "priority": "critical|high|medium|low"
    }
  ]
}

RULES:
- If SEVERE findings exist, decision MUST be "immediate_fix"
- If HIGH findings exist (and production/beta for security), decision MUST be "immediate_fix"
- Empty follow_up_tasks array is allowed if no actionable issues found
```

**Benefits:**
- Single template with conditional blocks
- Easy to update (no YAML parsing)
- Can version control separately
- Can test independently
- Reduces workflow file from 530 lines to 50 lines

---

### Usage in legacy-compatible-task-flow

**Before (QA - 10 lines + hidden complexity):**
```yaml
- name: qa_failure_coordination
  type: QAFailureCoordinationStep
  depends_on: ["qa_request"]
  condition: "${qa_request_status} == 'fail' || ${qa_request_status} == 'unknown'"
  config:
    maxPlanRevisions: 5
    taskCreationStrategy: "auto"
    tddAware: true
    urgentPriorityScore: 1200
    deferredPriorityScore: 50
```

**Before (Code Review - 250 lines):**
```yaml
- name: pm_prioritize_code_review_failures
  type: PersonaRequestStep
  # ... 200 lines of prompt ...

- name: create_code_review_followup_tasks
  type: ReviewFailureTasksStep
  # ... 50 lines of config ...
```

**After (All Reviews - ~20 lines each):**
```yaml
# QA failure handling
- name: handle_qa_failure
  type: SubWorkflowStep
  workflow: "review-failure-handling"
  depends_on: ["qa_request"]
  condition: "${qa_request_status} == 'fail' || ${qa_request_status} == 'unknown'"
  inputs:
    review_type: "qa"
    review_result: "${qa_request_result}"
    review_status: "${qa_request_status}"
    milestone_context:
      id: "${milestone}"
      name: "${milestone_name}"
      slug: "${milestone_slug}"
      completion_percentage: "${milestone_completion_percentage}"
    task: "${task}"
    parent_task_id: "${task.id}"
    priority_scores:
      urgent: 1200
      deferred: 50
    config:
      tdd_aware: true
      tdd_stage: "${tdd_stage}"
      block_original_task: false  # QA has iteration loop
  outputs:
    qa_tasks_created: tasks_created
    qa_urgent_count: urgent_tasks_created

# Code review failure handling
- name: handle_code_review_failure
  type: SubWorkflowStep
  workflow: "review-failure-handling"
  depends_on: ["code_review_request"]
  condition: "${code_review_request_status} == 'fail' || ${code_review_request_status} == 'unknown'"
  inputs:
    review_type: "code_review"
    review_result: "${code_review_request_result}"
    review_status: "${code_review_request_status}"
    milestone_context:
      id: "${milestone}"
      name: "${milestone_name}"
      slug: "${milestone_slug}"
      completion_percentage: "${milestone_completion_percentage}"
    task: "${task}"
    parent_task_id: "${task.id}"
    priority_scores:
      urgent: 1000
      deferred: 50
    config:
      block_original_task: true  # Code review blocks immediately
  outputs:
    code_review_tasks_created: tasks_created

# Security review failure handling
- name: handle_security_failure
  type: SubWorkflowStep
  workflow: "review-failure-handling"
  depends_on: ["security_request"]
  condition: "${security_request_status} == 'fail' || ${security_request_status} == 'unknown'"
  inputs:
    review_type: "security_review"
    review_result: "${security_request_result}"
    review_status: "${security_request_status}"
    milestone_context:
      id: "${milestone}"
      name: "${milestone_name}"
      slug: "${milestone_slug}"
      completion_percentage: "${milestone_completion_percentage}"
    task: "${task}"
    parent_task_id: "${task.id}"
    priority_scores:
      urgent: 1500
      deferred: 50
    config:
      block_original_task: true
  outputs:
    security_tasks_created: tasks_created
```

**Result:**
- 530 lines → 60 lines (89% reduction)
- 3 implementations → 1 sub-workflow
- 2 code paths → 1 unified path
- PM prompts externalized
- Bulk task creation (10-100x faster)
- TDD awareness available for all reviews
- Consistent behavior across all review types

---

## Sub-Workflow 2: task-implementation 🔧 PRIORITY 2

### Purpose
Reusable planning + implementation flow for any task

### Current Usage
- Main task flow: context → planning → implementation → apply
- QA fix iterations: planning → implementation → apply
- Could be used by: hotfix workflows, feature workflows, blocked task resolution

---

### Interface Definition

```yaml
name: "task-implementation"
version: "1.0.0"
description: "Reusable task implementation flow with optional context and planning"

inputs:
  # Task context
  task:
    type: object
    required: true
    description: "Task to implement"
  
  # Optional pre-gathered context (skip context step if provided)
  context:
    type: object
    required: false
    description: "Pre-gathered context (skips context_request if provided)"
  
  # Optional pre-approved plan (skip planning if provided)
  plan:
    type: object
    required: false
    description: "Pre-approved plan (skips planning_loop if provided)"
  
  # Planning configuration
  planning_config:
    type: object
    required: false
    properties:
      max_iterations: number
      planner_persona: string
      evaluator_persona: string
    defaults:
      max_iterations: 5
      planner_persona: "implementation-planner"
      evaluator_persona: "plan-evaluator"
  
  # Implementation configuration
  implementation_config:
    type: object
    required: false
    properties:
      persona: string
      commit_message_template: string
      validation: string
    defaults:
      persona: "lead-engineer"
      commit_message_template: "feat: implement ${task.title}"
      validation: "syntax_check"
  
  # Project context
  project_id:
    type: string
    required: true
  
  repo:
    type: string
    required: true

outputs:
  context:
    type: object
    description: "Gathered context (or passed-through if provided)"
  
  plan:
    type: object
    description: "Approved plan (or passed-through if provided)"
  
  implementation:
    type: object
    description: "Implementation output from lead engineer"
  
  changes_applied:
    type: boolean
    description: "Whether changes were successfully applied and pushed"
  
  files_changed:
    type: array
    description: "List of files that were modified"
```

---

### Implementation

```yaml
name: "task-implementation"
version: "1.0.0"

steps:
  # Step 1: Context gathering (conditional - skip if provided)
  - name: context_request
    type: PersonaRequestStep
    description: "Gather context for task"
    condition: "${context} == null"
    config:
      step: "1-context"
      persona: "context"
      intent: "context_gathering"
      payload:
        task: "${task}"
        repo: "${repo}"
        project_id: "${project_id}"
    outputs:
      context_result: object

  # Step 2: Resolve context (use provided or gathered)
  - name: resolve_context
    type: VariableResolutionStep
    description: "Use provided context or gathered context"
    config:
      variable: "resolved_context"
      value: "${context || context_request.context_result}"
    outputs:
      resolved_context: object

  # Step 3: Planning loop (conditional - skip if provided)
  - name: planning_loop
    type: PlanningLoopStep
    description: "Create and evaluate plan"
    depends_on: ["resolve_context"]
    condition: "${plan} == null"
    config:
      maxIterations: "${planning_config.max_iterations}"
      plannerPersona: "${planning_config.planner_persona}"
      evaluatorPersona: "${planning_config.evaluator_persona}"
      payload:
        task: "${task}"
        context: "${resolved_context}"
        repo: "${repo}"
        project_id: "${project_id}"
    outputs:
      plan_result: object

  # Step 4: Resolve plan (use provided or created)
  - name: resolve_plan
    type: VariableResolutionStep
    description: "Use provided plan or created plan"
    depends_on: ["planning_loop"]
    config:
      variable: "resolved_plan"
      value: "${plan || planning_loop.plan_result}"
    outputs:
      resolved_plan: object

  # Step 5: Implementation
  - name: implementation_request
    type: PersonaRequestStep
    description: "Request implementation from lead engineer"
    depends_on: ["resolve_plan"]
    config:
      step: "2-implementation"
      persona: "${implementation_config.persona}"
      intent: "implementation"
      payload:
        task: "${task}"
        plan: "${resolved_plan}"
        context: "${resolved_context}"
        repo: "${repo}"
        project_id: "${project_id}"
    outputs:
      implementation_result: object

  # Step 6: Apply changes
  - name: apply_edits
    type: DiffApplyStep
    description: "Parse, apply, commit, and push implementation"
    depends_on: ["implementation_request"]
    config:
      source_output: "implementation_request"
      validation: "${implementation_config.validation}"
      commit_message: "${implementation_config.commit_message_template}"
    outputs:
      changes_applied: boolean
      files_changed: array

outputs:
  context: "${resolved_context}"
  plan: "${resolved_plan}"
  implementation: "${implementation_request.implementation_result}"
  changes_applied: "${apply_edits.changes_applied}"
  files_changed: "${apply_edits.files_changed}"
```

---

### Usage Examples

**Main task flow:**
```yaml
- name: implement_task
  type: SubWorkflowStep
  workflow: "task-implementation"
  depends_on: ["checkout_branch", "mark_task_in_progress"]
  inputs:
    task: "${task}"
    project_id: "${projectId}"
    repo: "${repo_remote}"
  outputs:
    plan: plan
    implementation: implementation
```

**QA fix iteration (skip context, provide plan):**
```yaml
- name: implement_qa_fix
  type: SubWorkflowStep
  workflow: "task-implementation"
  inputs:
    task: "${qa_fix_task}"
    plan: "${qa_fix_plan}"  # Already created by QA fix planner
    project_id: "${projectId}"
    repo: "${repo_remote}"
    implementation_config:
      commit_message_template: "fix: address QA failure - ${qa_issue}"
  outputs:
    implementation: implementation
    changes_applied: changes_applied
```

**Hotfix (minimal planning, fast implementation):**
```yaml
- name: implement_hotfix
  type: SubWorkflowStep
  workflow: "task-implementation"
  inputs:
    task: "${hotfix_task}"
    project_id: "${projectId}"
    repo: "${repo_remote}"
    planning_config:
      max_iterations: 2  # Faster for hotfixes
    implementation_config:
      commit_message_template: "hotfix: ${hotfix_task.title}"
  outputs:
    implementation: implementation
```

---

## Sub-Workflow 3: git-operations 🌿 PRIORITY 3

### Purpose
Standard git setup, verification, and publishing

---

### Interface Definition

```yaml
name: "git-operations"
version: "1.0.0"
description: "Standard git branch setup and verification"

inputs:
  # Branch configuration
  base_branch:
    type: string
    required: false
    default: "main"
    description: "Base branch to branch from"
  
  branch_name:
    type: string
    required: true
    description: "Feature branch name"
  
  # Verification options
  require_diff:
    type: boolean
    required: false
    default: true
    description: "Require branch to have diff from base"
  
  require_published:
    type: boolean
    required: false
    default: true
    description: "Require branch to be published to remote"
  
  # Context
  repo_root:
    type: string
    required: true
    description: "Repository root path"

outputs:
  branch:
    type: string
    description: "Active branch name"
  
  has_diff:
    type: boolean
    description: "Whether branch has changes vs base"
  
  published:
    type: boolean
    description: "Whether branch is on remote"
```

---

### Implementation

```yaml
name: "git-operations"
version: "1.0.0"

steps:
  # Step 1: Checkout feature branch
  - name: checkout_branch
    type: GitOperationStep
    description: "Checkout feature branch from base"
    config:
      operation: "checkoutBranchFromBase"
      baseBranch: "${base_branch}"
      newBranch: "${branch_name}"
    outputs:
      current_branch: string

  # Step 2: Verify diff (conditional)
  - name: verify_diff
    type: GitOperationStep
    description: "Verify branch has diff from base"
    depends_on: ["checkout_branch"]
    condition: "${require_diff} == true"
    config:
      operation: "verifyRemoteBranchHasDiff"
    outputs:
      has_diff: boolean

  # Step 3: Ensure published (conditional)
  - name: ensure_published
    type: GitOperationStep
    description: "Ensure branch is published to remote"
    depends_on: ["verify_diff"]
    condition: "${require_published} == true"
    config:
      operation: "ensureBranchPublished"
    outputs:
      published: boolean

outputs:
  branch: "${checkout_branch.current_branch}"
  has_diff: "${verify_diff.has_diff || false}"
  published: "${ensure_published.published || false}"
```

---

### Usage

```yaml
- name: setup_git
  type: SubWorkflowStep
  workflow: "git-operations"
  inputs:
    base_branch: "main"
    branch_name: "${featureBranchName}"
    require_diff: true
    require_published: true
    repo_root: "${repoRoot}"
  outputs:
    current_branch: branch
```

---

## Refactored legacy-compatible-task-flow

### Before: 446 lines

### After: ~200 lines

```yaml
name: "legacy-compatible-task-flow"
version: "2.0.0"
description: "Refactored task workflow using sub-workflows"

steps:
  # Git setup (was 3 steps, now 1 sub-workflow call)
  - name: setup_git
    type: SubWorkflowStep
    workflow: "git-operations"
    inputs:
      base_branch: "main"
      branch_name: "${featureBranchName}"
      repo_root: "${repoRoot}"

  # Mark task in progress
  - name: mark_task_in_progress
    type: SimpleTaskStatusStep
    depends_on: ["setup_git"]
    config:
      status: "in_progress"

  # Implementation (was 4 steps, now 1 sub-workflow call)
  - name: implement_task
    type: SubWorkflowStep
    workflow: "task-implementation"
    depends_on: ["mark_task_in_progress"]
    inputs:
      task: "${task}"
      project_id: "${projectId}"
      repo: "${repo_remote}"

  # Verify and publish (part of git-operations, or separate if after implementation)
  - name: verify_and_publish
    type: SubWorkflowStep
    workflow: "git-operations"
    depends_on: ["implement_task"]
    inputs:
      base_branch: "main"
      branch_name: "${featureBranchName}"
      require_diff: true
      require_published: true
      repo_root: "${repoRoot}"

  # QA review
  - name: qa_request
    type: PersonaRequestStep
    depends_on: ["verify_and_publish"]
    config:
      persona: "tester-qa"
      # ... standard review config ...

  # QA failure handling (was 10 lines + hidden, now 20 lines explicit)
  - name: handle_qa_failure
    type: SubWorkflowStep
    workflow: "review-failure-handling"
    depends_on: ["qa_request"]
    condition: "${qa_request_status} != 'pass'"
    inputs:
      review_type: "qa"
      review_result: "${qa_request_result}"
      review_status: "${qa_request_status}"
      milestone_context: { ... }
      priority_scores: { urgent: 1200, deferred: 50 }
      config: { tdd_aware: true }

  # QA iteration loop (keep as-is, works well)
  - name: qa_iteration_loop
    type: QAIterationLoopStep
    # ... existing config ...

  # Mark in review
  - name: mark_task_in_review
    type: SimpleTaskStatusStep
    condition: "${qa_request_status} == 'pass'"
    config:
      status: "in_review"

  # Code review
  - name: code_review_request
    type: PersonaRequestStep
    depends_on: ["mark_task_in_review"]
    # ... standard review config ...

  # Code review failure handling (was 250 lines, now 20 lines)
  - name: handle_code_review_failure
    type: SubWorkflowStep
    workflow: "review-failure-handling"
    depends_on: ["code_review_request"]
    condition: "${code_review_request_status} != 'pass'"
    inputs:
      review_type: "code_review"
      review_result: "${code_review_request_result}"
      review_status: "${code_review_request_status}"
      milestone_context: { ... }
      priority_scores: { urgent: 1000, deferred: 50 }

  # Security review
  - name: security_request
    type: PersonaRequestStep
    depends_on: ["code_review_request"]
    condition: "${code_review_request_status} == 'pass'"
    # ... standard review config ...

  # Security failure handling (was 270 lines, now 20 lines)
  - name: handle_security_failure
    type: SubWorkflowStep
    workflow: "review-failure-handling"
    depends_on: ["security_request"]
    condition: "${security_request_status} != 'pass'"
    inputs:
      review_type: "security_review"
      review_result: "${security_request_result}"
      review_status: "${security_request_status}"
      milestone_context: { ... }
      priority_scores: { urgent: 1500, deferred: 50 }

  # DevOps review
  - name: devops_request
    type: PersonaRequestStep
    depends_on: ["security_request"]
    condition: "${security_request_status} == 'pass'"
    # ... standard review config ...

  # Mark done
  - name: mark_task_done
    type: SimpleTaskStatusStep
    depends_on: ["devops_request"]
    condition: "${security_request_status} == 'pass'"
    config:
      status: "done"

  # Milestone completion check (keep as-is)
  - name: check_milestone_completion
    type: MilestoneStatusCheckStep
    # ... existing config ...

  # PM evaluate suggestions (keep as-is)
  - name: pm_evaluate_suggestions
    type: PersonaRequestStep
    # ... existing config ...
```

**Result:**
- 446 lines → ~200 lines (55% reduction)
- Git operations: 3 steps → 1 sub-workflow
- Implementation: 4 steps → 1 sub-workflow
- Review failures: 530 lines → 60 lines (89% reduction)
- Maintainable, testable, reusable

---

## Implementation Requirements

### New Step Types Needed

1. **SubWorkflowStep** - Execute sub-workflow with inputs/outputs
2. **BulkTaskCreationStep** - Create multiple tasks in single API call
3. **PMDecisionParserStep** - Parse and normalize PM decisions
4. **ConditionalStep** - Execute conditional logic (may exist)
5. **VariableResolutionStep** - Resolve variable from multiple sources

### New WorkflowEngine Features

1. **Sub-workflow loading** - Load from `sub-workflows/` directory
2. **Sub-workflow execution** - Isolated context, input/output mapping
3. **Sub-workflow validation** - Input schema validation
4. **Sub-workflow debugging** - Trace execution through sub-workflows

### External Files Needed

1. **prompts/pm-review-prioritization.txt** - Unified PM prompt template
2. **sub-workflows/review-failure-handling.yaml** - Priority 1
3. **sub-workflows/task-implementation.yaml** - Priority 2
4. **sub-workflows/git-operations.yaml** - Priority 3

---

## Benefits Summary

### Code Reduction
- **Main workflow:** 446 → 200 lines (55% reduction)
- **Review failures:** 530 → 60 lines (89% reduction)
- **Total:** 976 → 260 lines (73% reduction)

### Maintainability
- ✅ Fix bugs once (applies to all reviews)
- ✅ PM prompts externalized (easy updates)
- ✅ Sub-workflows tested independently
- ✅ Clear interfaces (explicit inputs/outputs)

### Performance
- ✅ Bulk task creation (10-100x faster)
- ✅ Reduced dashboard API calls (N+1 → 1)
- ✅ Milestone auto-creation (no 422 errors)

### Reusability
- ✅ review-failure-handling: Used 4 times (QA, code, security, devops)
- ✅ task-implementation: Used 3+ times (main, QA fixes, hotfixes)
- ✅ git-operations: Used 2+ times (setup, verification)

---

## Next Steps

1. ✅ **Complete** - Day 3: Sub-workflow design
2. ⏳ **Next** - Day 4: Create rationalization proposal
   - Recommend which workflows to keep/archive
   - Propose migration timeline
   - Document breaking changes
   - Get user approval
3. ⏳ **Pending** - Day 5: User checkpoint #0
