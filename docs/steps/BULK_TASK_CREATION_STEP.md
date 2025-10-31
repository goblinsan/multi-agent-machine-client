# BulkTaskCreationStep - Workflow Step Documentation

## Overview

The `BulkTaskCreationStep` creates multiple tasks in a single bulk operation, solving the N+1 problem by creating all tasks in one API call instead of sequential individual calls.

## Features

### 1. Idempotency Support
- Automatically generates `external_id` for each task
- Format: `${workflow_run_id}:${step_name}:${task_index}`
- Enables safe workflow re-runs (duplicate prevention via external_id)
- Custom templates supported via `external_id_template` config

### 2. Priority-Based Routing
- `critical` / `high` priority → immediate milestone
- `medium` / `low` priority → deferred milestone
- Configurable priority scores:
  - `critical`: 1500
  - `high`: 1200
  - `medium`: 800
  - `low`: 50

### 3. Duplicate Detection
Three strategies available:
- **external_id** (100% match threshold)
- **title** (80% match threshold)
- **title_and_milestone** (70% match threshold)

Features:
- Detailed match scoring with overlap percentages
- Automatic duplicate skipping
- Configurable match strategy

### 4. Retry Logic
- Exponential backoff (default: 3 attempts with 1s/2s/4s delays)
- Smart retryable error detection:
  - Timeouts
  - Rate limits
  - 5xx server errors
- Workflow abort signal on partial failure (opt-in)

## Configuration

### Required Fields

- **project_id** (string): Project to create tasks in
- **tasks** (array): Array of task objects to create

### Optional Fields

- **workflow_run_id** (string): Unique workflow execution ID for idempotency
- **priority_mapping** (object): Map priority string to numeric score
- **milestone_strategy** (object): Milestone routing configuration
- **parent_task_mapping** (object): Parent task assignment rules
- **title_prefix** (string): Prefix to add to all task titles

### Retry Configuration

```typescript
retry: {
  max_attempts: 3,              // Number of retry attempts
  initial_delay_ms: 1000,       // Initial delay (1 second)
  backoff_multiplier: 2,        // Exponential backoff multiplier
  retryable_errors: []          // Custom error messages to retry
}
```

### Options

```typescript
options: {
  create_milestone_if_missing: boolean,     // Create milestone if not found
  upsert_by_external_id: boolean,          // Enable idempotent creation
  external_id_template: string,            // Custom external_id template
  check_duplicates: boolean,               // Enable duplicate detection
  existing_tasks: ExistingTask[],          // Tasks for duplicate checking
  duplicate_match_strategy: string,        // Matching strategy
  abort_on_partial_failure: boolean        // Abort on partial failure
}
```

## Task Object Schema

```typescript
interface TaskToCreate {
  title: string;                    // Required
  description?: string;
  priority?: TaskPriority;          // 'critical' | 'high' | 'medium' | 'low'
  milestone_slug?: string;
  parent_task_id?: string;
  external_id?: string;
  assignee_persona?: string;
  metadata?: Record<string, any>;
  is_duplicate?: boolean;
  duplicate_of_task_id?: string;
  skip_reason?: string;
}
```

## Example Usage

### Basic Example

```yaml
- name: create_tasks_bulk
  type: BulkTaskCreationStep
  config:
    project_id: "${project_id}"
    tasks: "${follow_up_tasks}"
```

### Full Configuration Example

```yaml
- name: create_tasks_bulk
  type: BulkTaskCreationStep
  config:
    project_id: "${project_id}"
    workflow_run_id: "${workflow_run_id}"  # For idempotency
    tasks: "${follow_up_tasks}"
    
    # Priority configuration
    priority_mapping:
      critical: 1500
      high: 1200
      medium: 800
      low: 50
    
    # Milestone routing
    milestone_strategy:
      urgent: "${milestone_id}"
      deferred: "future-enhancements"
    
    # Prefix all task titles
    title_prefix: "[Auto] "
    
    # Retry configuration
    retry:
      max_attempts: 3
      initial_delay_ms: 1000
      backoff_multiplier: 2
    
    # Options
    options:
      create_milestone_if_missing: true
      upsert_by_external_id: true           # Enable idempotency
      external_id_template: "${workflow_run_id}:${step_name}:${task_index}"
      check_duplicates: true
      duplicate_match_strategy: "external_id"
      abort_on_partial_failure: false
```

## Output Schema

The step outputs a `BulkCreationResult` object:

```typescript
{
  tasks_created: number,           // Total tasks created
  urgent_tasks_created: number,    // High-priority tasks created
  deferred_tasks_created: number,  // Low-priority tasks created
  task_ids: string[],              // IDs of created tasks
  duplicate_task_ids: string[],    // IDs of duplicate tasks found
  skipped_duplicates: number,      // Number of duplicates skipped
  errors: string[]                 // Any errors encountered
}
```

## Error Handling

### Retryable Errors
The step automatically retries on:
- Network timeouts
- Rate limit errors (429)
- Server errors (5xx)
- Database connection errors

### Non-Retryable Errors
The step fails immediately on:
- Invalid configuration
- Authentication errors (401, 403)
- Not found errors (404)
- Validation errors (400)

### Partial Failures
By default, the step continues even if some tasks fail. Set `abort_on_partial_failure: true` to abort the workflow on any task creation failure after all retries.

## Best Practices

### 1. Use Idempotency
Always provide a `workflow_run_id` and enable `upsert_by_external_id` for production workflows:

```yaml
config:
  workflow_run_id: "${workflow_run_id}"
  options:
    upsert_by_external_id: true
```

### 2. Batch Size Limits
Keep task batches under 100 tasks per step. For larger batches, split across multiple steps:

```yaml
- name: create_tasks_batch_1
  type: BulkTaskCreationStep
  config:
    tasks: "${tasks[:100]}"

- name: create_tasks_batch_2
  type: BulkTaskCreationStep
  config:
    tasks: "${tasks[100:]}"
```

### 3. Duplicate Detection
When using duplicate detection, always provide `existing_tasks` from context:

```yaml
options:
  check_duplicates: true
  existing_tasks: "${context.existing_tasks}"
  duplicate_match_strategy: "title_and_milestone"
```

### 4. Priority Routing
Use milestone strategy to route urgent vs deferred tasks:

```yaml
milestone_strategy:
  urgent: "sprint-current"
  deferred: "backlog"
```

## Performance Considerations

- **Bulk Creation**: Creates all tasks in one API call (N+1 → 1 call)
- **Duplicate Detection**: O(n*m) where n=new tasks, m=existing tasks
- **Retry Overhead**: Max delay = initial_delay * (multiplier^attempts)
  - Default: 1s + 2s + 4s = 7s total

## Troubleshooting

### Issue: Tasks Not Created
**Solution**: Check that `project_id` exists and user has permissions

### Issue: Duplicates Not Detected
**Solution**: Ensure `existing_tasks` array is populated in context

### Issue: Retries Exhausted
**Solution**: Increase `max_attempts` or check for persistent API issues

### Issue: Wrong Milestone Assignment
**Solution**: Verify `milestone_strategy` configuration and milestone existence

## Related Steps

- **ContextStep**: Gathers existing tasks for duplicate detection
- **PlanEvaluationStep**: Generates task lists for bulk creation
- **ReviewFailureTasksStep**: Handles failed task creation

## See Also

- [Task Priority Calculator](./TASK_PRIORITY_CALCULATOR.md)
- [Task Duplicate Detector](./TASK_DUPLICATE_DETECTOR.md)
- [Task Router](./TASK_ROUTER.md)
- [Workflow System Overview](./WORKFLOW_SYSTEM.md)
