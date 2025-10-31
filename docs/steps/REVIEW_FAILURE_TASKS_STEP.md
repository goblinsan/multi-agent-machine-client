# ReviewFailureTasksStep - Workflow Step Documentation

## Overview

The `ReviewFailureTasksStep` creates follow-up tasks based on PM review failure prioritization. This step works in conjunction with `PMDecisionParserStep` to handle review failures and create appropriately prioritized tasks.

## Prerequisites

**IMPORTANT**: This step requires normalized PM decision from `PMDecisionParserStep`. The old `parsePMDecision()` method has been removed (44% code reduction).

## Process Flow

1. Gets normalized PM decision from PMDecisionParserStep (via context variable)
2. Creates high-priority urgent tasks for critical/high priority issues
3. Optionally creates backlog tasks for medium/low priority issues
4. Returns summary of created tasks

## Configuration

### Required Fields

- **pmDecisionVariable** (string): Variable name containing the normalized PM decision from PMDecisionParserStep
- **reviewType** (string): Type of review that failed
  - `'code_review'`
  - `'security_review'`
  - `'qa'`
  - `'devops'`

### Optional Fields

- **urgentPriorityScore** (number): Priority score for urgent tasks
  - QA: 1200 (test failures block all work)
  - Code/Security/DevOps: 1000
  - If not specified, uses review type defaults
  
- **deferredPriorityScore** (number): Priority score for deferred tasks (default: 50)

- **createDeferredTasks** (boolean): Whether to create tasks for deferred issues (default: true)

- **backlogMilestoneSlug** (string): Milestone slug for backlog tasks (default: 'future-enhancements')

## PM Decision Format

Expected format from PMDecisionParserStep:

```typescript
{
  decision: "immediate_fix" | "defer",
  reasoning: string,
  immediate_issues: string[],
  deferred_issues: string[],
  follow_up_tasks: Array<{
    title: string,
    description: string,
    priority: "critical" | "high" | "medium" | "low"
  }>
}
```

## Assignee Logic

**Simplified**: All follow-up tasks are assigned to `'implementation-planner'` persona. This must precede engineering work. Review-type-specific assignee logic has been removed.

## Priority Tiers

- **QA urgent**: 1200 (test failures block all work)
- **Code/Security/DevOps urgent**: 1000
- **All deferred**: 50

## Workflow Integration Example

```yaml
# In review-failure-handling.yaml:

# Step 1: Parse PM decision (required first)
- name: parse_pm_decision
  type: PMDecisionParserStep
  config:
    input: "${pm_evaluation}"
    normalize: true
    review_type: "${review_type}"
  outputs:
    pm_decision: parsed_decision

# Step 2: Create follow-up tasks based on PM decision
- name: create_follow_up_tasks
  type: ReviewFailureTasksStep
  config:
    pmDecisionVariable: "pm_decision"  # Uses PMDecisionParserStep output
    reviewType: "${review_type}"
```

## Complete Configuration Example

```yaml
- name: create_review_failure_tasks
  type: ReviewFailureTasksStep
  config:
    pmDecisionVariable: "pm_decision"
    reviewType: "qa"
    urgentPriorityScore: 1200
    deferredPriorityScore: 50
    createDeferredTasks: true
    backlogMilestoneSlug: "future-enhancements"
```

## Output Schema

```typescript
{
  status: 'success' | 'failure',
  data: {
    tasks_created: number,
    urgent_tasks: number,
    deferred_tasks: number,
    task_ids: string[]
  },
  outputs: {
    tasks_created: number,
    urgent_tasks: number,
    deferred_tasks: number,
    task_ids: string[]
  },
  metrics: {
    duration_ms: number
  }
}
```

## Review Type Labels

| Review Type | Human-Readable Label |
|-------------|---------------------|
| code_review | Code Review |
| security_review | Security Review |
| qa | QA |
| devops | DevOps |

## Error Handling

### Missing PM Decision Variable
If the PM decision variable is not found in context:
- **Error**: `Missing PM decision variable: {variable}. Ensure PMDecisionParserStep runs first.`
- **Resolution**: Ensure PMDecisionParserStep runs before ReviewFailureTasksStep

### Invalid PM Decision Format
If PM decision is missing `follow_up_tasks` array:
- **Error**: `Invalid PM decision format - follow_up_tasks array required. Ensure PMDecisionParserStep normalization is enabled.`
- **Resolution**: Ensure PMDecisionParserStep has `normalize: true` in config

### Task Creation Failures
Individual task creation failures are logged but don't fail the step. Check logs for:
```
Failed to create task: {error}
```

## Best Practices

### 1. Always Use PMDecisionParserStep First
```yaml
# CORRECT:
- name: parse_pm_decision
  type: PMDecisionParserStep
  # ... config

- name: create_tasks
  type: ReviewFailureTasksStep
  config:
    pmDecisionVariable: "pm_decision"

# INCORRECT:
- name: create_tasks
  type: ReviewFailureTasksStep
  config:
    pmDecisionVariable: "some_raw_text"  # Won't work!
```

### 2. Set Appropriate Priority Scores
Match priority to review type severity:
```yaml
# QA failures block all work
reviewType: "qa"
urgentPriorityScore: 1200

# Security is critical but may allow parallel work
reviewType: "security_review"
urgentPriorityScore: 1000
```

### 3. Control Backlog Creation
For critical reviews, disable deferred task creation:
```yaml
createDeferredTasks: false  # Only create urgent tasks
```

### 4. Use Descriptive Variable Names
```yaml
# GOOD:
pmDecisionVariable: "qa_failure_pm_decision"
pmDecisionVariable: "security_review_pm_decision"

# AVOID:
pmDecisionVariable: "data"
pmDecisionVariable: "result"
```

## Common Issues

### Issue: "No PM decision found in context"
**Cause**: PMDecisionParserStep didn't run or used wrong output variable name  
**Solution**: 
1. Ensure PMDecisionParserStep runs before this step
2. Match output variable name to pmDecisionVariable config
3. Check workflow execution logs for PMDecisionParserStep output

### Issue: "Invalid PM decision format"
**Cause**: PM decision not normalized or manually constructed incorrectly  
**Solution**: 
1. Enable `normalize: true` in PMDecisionParserStep config
2. Don't manually construct PM decisions - use PMDecisionParserStep

### Issue: No urgent tasks created
**Cause**: PM decision has empty immediate_issues or all tasks marked low priority  
**Solution**: Review PM decision content, may need to adjust LLM prompt

## Migration from Old Version

If you have old workflows using the removed `parsePMDecision()` method:

**Before (deprecated)**:
```yaml
- name: create_tasks
  type: ReviewFailureTasksStep
  config:
    pmEvaluation: "${raw_pm_text}"  # Direct raw text
    reviewType: "qa"
```

**After (current)**:
```yaml
- name: parse_pm_decision
  type: PMDecisionParserStep
  config:
    input: "${raw_pm_text}"
    normalize: true
    review_type: "qa"
  outputs:
    pm_decision: parsed_decision

- name: create_tasks
  type: ReviewFailureTasksStep
  config:
    pmDecisionVariable: "pm_decision"
    reviewType: "qa"
```

## Related Steps

- **PMDecisionParserStep**: Parses and normalizes PM decisions (required before this step)
- **BulkTaskCreationStep**: Alternative for creating many tasks at once
- **ContextStep**: Gathers existing tasks for duplicate detection

## See Also

- [PM Decision Parser](./PM_DECISION_PARSER_STEP.md)
- [Task Duplicate Detector](./TASK_DUPLICATE_DETECTOR.md)
- [Workflow System Overview](./WORKFLOW_SYSTEM.md)
