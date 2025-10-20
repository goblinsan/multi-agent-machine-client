# Dashboard Client Mocking Guide

**Version:** 1.0.0  
**Date:** October 20, 2025  
**File:** `tests/helpers/dashboardMocks.ts`

## Overview

This guide explains how to use the DashboardClient mock helpers for testing code that depends on the dashboard backend API. The mock helpers provide a simple, type-safe way to simulate dashboard API responses without needing a running dashboard backend.

## Quick Start

### Basic Setup

```typescript
import { describe, it, expect } from 'vitest';
import { createMockDashboardClient, mockBulkCreateResponse } from './helpers/dashboardMocks';

describe('MyWorkflowStep', () => {
  it('should create tasks successfully', async () => {
    // Create a mock client
    const mockClient = createMockDashboardClient();
    
    // Configure the mock response
    mockClient.bulkCreateTasks.mockResolvedValue(
      mockBulkCreateResponse({ created: 5, skipped: 0 })
    );
    
    // Your test code here
    const result = await myStep.execute(context);
    
    // Assertions
    expect(mockClient.bulkCreateTasks).toHaveBeenCalledTimes(1);
    expect(result.outputs?.tasks_created).toBe(5);
  });
});
```

## Core Functions

### createMockDashboardClient()

Creates a fully mocked Dashboard Client instance with all methods mocked.

**Returns:** Mock client with these methods:
- `createTask()`
- `bulkCreateTasks()`
- `updateTask()`
- `listTasks()`
- `getTask()`

**Default Behavior:** All methods return successful responses by default.

```typescript
const mockClient = createMockDashboardClient();

// Override specific methods as needed
mockClient.bulkCreateTasks.mockResolvedValue(/* custom response */);
```

### Response Builders

#### mockTaskResponse(overrides?)

Creates a single Task response with default values.

```typescript
const task = mockTaskResponse({
  id: 42,
  title: 'My Test Task',
  priority_score: 1500
});
```

**Default Values:**
- `id`: 1
- `project_id`: 1
- `title`: "Test Task"
- `status`: "open"
- `priority_score`: 1200
- `external_id`: `test-${timestamp}`
- All other fields: null or default values

#### mockBulkCreateResponse(options?)

Creates a BulkTaskCreateResponse with created and skipped tasks.

```typescript
const response = mockBulkCreateResponse({
  created: 3,
  skipped: 2,
  projectId: 1
});

// response.created: Task[] (3 tasks)
// response.skipped: Array<{task, reason, external_id}> (2 tasks)
// response.summary: { totalRequested: 5, created: 3, skipped: 2 }
```

**Options:**
- `created` (default: 2) - Number of tasks created
- `skipped` (default: 0) - Number of tasks skipped
- `projectId` (default: 1) - Project ID for all tasks

#### mockListTasksResponse(count?, projectId?)

Creates a TaskListResponse with multiple tasks.

```typescript
const response = mockListTasksResponse(10, 1);
// response.data: Array of 10 tasks
```

## Test Data Generators

### mockTaskCreateInput(overrides?)

Generates a TaskCreateInput object for task creation.

```typescript
const input = mockTaskCreateInput({
  title: 'My Task',
  priority_score: 1500,
  external_id: 'my-task-123'
});
```

### mockBulkTaskCreateInput(count?, priorities?)

Generates an array of TaskCreateInput objects for bulk operations.

```typescript
const inputs = mockBulkTaskCreateInput(5, [1500, 1200, 800, 50]);
// Returns 5 TaskCreateInput objects with cycling priorities
```

## Common Testing Scenarios

### 1. Successful Task Creation

```typescript
import { mockSuccessfulTaskCreation } from './helpers/dashboardMocks';

const mockClient = createMockDashboardClient();
mockSuccessfulTaskCreation(mockClient, 'critical');

// Test code that creates a task
await myStep.execute(context);

// Verify
expect(mockClient.createTask).toHaveBeenCalledWith(
  expect.any(Number),
  expect.objectContaining({
    priority_score: 1500 // critical
  })
);
```

### 2. Successful Bulk Creation

```typescript
import { mockSuccessfulBulkCreation } from './helpers/dashboardMocks';

const mockClient = createMockDashboardClient();
mockSuccessfulBulkCreation(mockClient, { created: 10, skipped: 0 });

// Test bulk creation
await myStep.execute(context);

// Verify
expect(mockClient.bulkCreateTasks).toHaveBeenCalledTimes(1);
```

### 3. Idempotent Task Creation

Test that creating the same task twice returns the existing task.

```typescript
import { mockIdempotentTaskCreation } from './helpers/dashboardMocks';

const mockClient = createMockDashboardClient();
mockIdempotentTaskCreation(mockClient, 'my-external-id');

// First call: creates task
const result1 = await createTask('my-external-id');
expect(result1.id).toBe(42);

// Second call: returns existing task
const result2 = await createTask('my-external-id');
expect(result2.id).toBe(42); // Same ID!
```

### 4. Bulk Idempotency

Test that re-creating tasks in bulk skips duplicates.

```typescript
import { mockIdempotentBulkCreation } from './helpers/dashboardMocks';

const mockClient = createMockDashboardClient();
mockIdempotentBulkCreation(mockClient, 5);

// First call: all created
const result1 = await bulkCreate(tasks);
expect(result1.created.length).toBe(5);
expect(result1.skipped?.length ?? 0).toBe(0);

// Second call: all skipped
const result2 = await bulkCreate(tasks);
expect(result2.created.length).toBe(0);
expect(result2.skipped?.length).toBe(5);
```

### 5. Task Creation Failure

Test error handling when task creation fails.

```typescript
import { mockTaskCreationFailure } from './helpers/dashboardMocks';

const mockClient = createMockDashboardClient();
mockTaskCreationFailure(mockClient, 'Database connection failed');

// Test error handling
await expect(myStep.execute(context)).rejects.toThrow('Database connection failed');
```

### 6. Network Failure

Test network error handling.

```typescript
import { mockNetworkFailure } from './helpers/dashboardMocks';

const mockClient = createMockDashboardClient();
mockNetworkFailure(mockClient);

// All API calls will fail with fetch error
await expect(myStep.execute(context)).rejects.toThrow('fetch failed');
```

## Priority Mapping

### priorityToPriorityScore(priority)

Converts priority strings to numeric scores (matches BulkTaskCreationStep).

```typescript
import { priorityToPriorityScore } from './helpers/dashboardMocks';

priorityToPriorityScore('critical'); // 1500
priorityToPriorityScore('high');     // 1200
priorityToPriorityScore('medium');   // 800
priorityToPriorityScore('low');      // 50
```

### isUrgentPriority(priorityScore)

Determines if a priority score represents an urgent task (>= 1000).

```typescript
import { isUrgentPriority } from './helpers/dashboardMocks';

isUrgentPriority(1500); // true (critical)
isUrgentPriority(1200); // true (high)
isUrgentPriority(800);  // false (medium)
isUrgentPriority(50);   // false (low)
```

## Assertion Helpers

### assertBulkCreateResponse(response, expected)

Asserts that a BulkTaskCreateResponse has the expected counts.

```typescript
import { assertBulkCreateResponse } from './helpers/dashboardMocks';

const response = await bulkCreate(tasks);
assertBulkCreateResponse(response, { created: 5, skipped: 0 });
// Throws if counts don't match
```

### assertTaskPriority(task, expectedPriority)

Asserts that a Task has the expected priority.

```typescript
import { assertTaskPriority } from './helpers/dashboardMocks';

const task = await createTask({ priority: 'critical' });
assertTaskPriority(task, 'critical');
// Throws if priority doesn't match
```

## Advanced Usage

### Custom Mock Responses

For complex scenarios, build custom responses:

```typescript
const mockClient = createMockDashboardClient();

mockClient.bulkCreateTasks.mockResolvedValue({
  created: [
    mockTaskResponse({ id: 1, title: 'Critical Task', priority_score: 1500 }),
    mockTaskResponse({ id: 2, title: 'High Task', priority_score: 1200 })
  ],
  skipped: [
    {
      task: mockTaskResponse({ id: 3, title: 'Duplicate Task' }),
      reason: 'Task already exists',
      external_id: 'duplicate-123'
    }
  ],
  summary: {
    totalRequested: 3,
    created: 2,
    skipped: 1
  }
});
```

### Sequence of Responses

Test retries or state changes by mocking a sequence:

```typescript
const mockClient = createMockDashboardClient();

mockClient.createTask
  .mockRejectedValueOnce(new Error('Transient failure'))  // First call fails
  .mockRejectedValueOnce(new Error('Still failing'))      // Second call fails
  .mockResolvedValue(mockTaskResponse({ id: 1 }));         // Third call succeeds

// Test retry logic
const result = await retryableCreate();
expect(result.id).toBe(1);
```

### Spy on Mock Calls

Verify that the API was called correctly:

```typescript
const mockClient = createMockDashboardClient();
mockSuccessfulBulkCreation(mockClient);

await bulkCreate(tasks);

// Verify call details
expect(mockClient.bulkCreateTasks).toHaveBeenCalledWith(
  1, // projectId
  {
    tasks: expect.arrayContaining([
      expect.objectContaining({
        title: expect.stringContaining('Task'),
        priority_score: expect.any(Number)
      })
    ])
  }
);
```

## Best Practices

### 1. Use Scenario Helpers

Prefer using scenario helpers over manual mocking:

```typescript
// ❌ Manual (verbose)
mockClient.createTask.mockResolvedValue(
  mockTaskResponse({ priority_score: 1500 })
);

// ✅ Scenario helper (concise)
mockSuccessfulTaskCreation(mockClient, 'critical');
```

### 2. Test External ID Behavior

Always test idempotency when using external_id:

```typescript
it('should skip duplicate tasks with same external_id', async () => {
  const mockClient = createMockDashboardClient();
  mockIdempotentBulkCreation(mockClient, 3);
  
  // First run
  const result1 = await runWorkflow();
  expect(result1.created).toBe(3);
  
  // Second run (should skip all)
  const result2 = await runWorkflow();
  expect(result2.created).toBe(0);
  expect(result2.skipped).toBe(3);
});
```

### 3. Test Error Cases

Don't just test the happy path:

```typescript
describe('error handling', () => {
  it('should handle network failures', async () => {
    const mockClient = createMockDashboardClient();
    mockNetworkFailure(mockClient);
    
    const result = await myStep.execute(context);
    expect(result.status).toBe('failed');
    expect(result.errors).toContain('fetch failed');
  });
  
  it('should retry on transient failures', async () => {
    const mockClient = createMockDashboardClient();
    mockClient.bulkCreateTasks
      .mockRejectedValueOnce(new Error('Transient'))
      .mockResolvedValue(mockBulkCreateResponse({ created: 5 }));
    
    const result = await myStep.execute(context);
    expect(result.status).toBe('success');
    expect(mockClient.bulkCreateTasks).toHaveBeenCalledTimes(2);
  });
});
```

### 4. Verify Mock Calls

Always verify that the API was called correctly:

```typescript
it('should call API with correct parameters', async () => {
  const mockClient = createMockDashboardClient();
  mockSuccessfulBulkCreation(mockClient);
  
  await myStep.execute(context);
  
  expect(mockClient.bulkCreateTasks).toHaveBeenCalledWith(
    expect.any(Number), // projectId
    expect.objectContaining({
      tasks: expect.arrayContaining([
        expect.objectContaining({
          external_id: expect.stringMatching(/^workflow-/),
          priority_score: expect.any(Number)
        })
      ])
    })
  );
});
```

## Migration Guide

### Updating Existing Tests

If you have tests using placeholder dashboard expectations:

```typescript
// ❌ Old (placeholder expectations)
expect(result.outputs?.error).toBeUndefined();
expect(result.outputs?.tasks).toBeDefined();

// ✅ New (with mock client)
const mockClient = createMockDashboardClient();
mockSuccessfulBulkCreation(mockClient, { created: 5 });

// Inject mock client (depends on your DI approach)
myStep.dashboardClient = mockClient;

expect(result.outputs?.tasks_created).toBe(5);
expect(mockClient.bulkCreateTasks).toHaveBeenCalled();
```

### Global Mock Setup (Optional)

For tests that need consistent mocking:

```typescript
// tests/setup.ts
import { vi } from 'vitest';
import { createMockDashboardClient } from './helpers/dashboardMocks';

// Global mock (uncomment if needed)
// vi.mock('../src/services/DashboardClient.js', () => ({
//   DashboardClient: vi.fn(() => createMockDashboardClient())
// }));
```

## Troubleshooting

### Mock Not Working

If your mock isn't being used:

1. Check that you're passing the mock to your code
2. Verify import paths match exactly
3. Use `vi.mock()` for auto-mocking (see Global Mock Setup)

### Type Errors

If you get TypeScript errors:

1. Ensure you're using the latest Task interface
2. Check that all required fields are present
3. Use `Partial<Task>` for overrides

### Call Verification Fails

If `expect().toHaveBeenCalled()` fails:

1. Check that you're testing the right mock instance
2. Verify the mock was injected correctly
3. Use `.mock.calls` to debug: `console.log(mockClient.createTask.mock.calls)`

## Examples Repository

See `tests/examples/dashboardMocking.test.ts` for complete working examples of all patterns.

---

**Questions?** Check `tests/helpers/dashboardMocks.ts` source code for full API documentation.
