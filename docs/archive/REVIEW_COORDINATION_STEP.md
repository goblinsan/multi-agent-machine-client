# ReviewCoordinationStep Base Class

## Overview

The `ReviewCoordinationStep` base class standardizes review failure coordination across QA, code review, and security review workflows. This eliminates duplicate code and ensures bugs like the recent `interpretPersonaStatus()` issues can't recur in multiple places.

## Problem Context

During production debugging, we discovered **systematic bugs** where multiple workflow steps had custom `parseQAStatus()` / `parseReviewStatus()` methods that didn't use the centralized `interpretPersonaStatus()` function. This caused:

1. **QA PASS workflows stuck in loops** - `QAIterationLoopStep.parseQAStatus()` tried to parse JSON directly, but personas return TEXT with JSON embedded in markdown code fences. Result: status was "unknown" even when QA passed.

2. **UNKNOWN QA status not creating tasks** - `QAFailureCoordinationStep.parseQAStatus()` stringified entire payload as details when details/message fields didn't exist. Task titles became garbage like `"QA failure: {\"output\":\"**Test...\"}"`, causing task creation to fail.

3. **Code duplication** - THREE places (QAIterationLoopStep, QAFailureCoordinationStep, PersonaRequestStep) all needed to parse persona responses, but only PersonaRequestStep was doing it correctly.

## Solution: Base Class Pattern

The `ReviewCoordinationStep` base class extracts the common coordination pattern:

```typescript
// Standardized flow for ALL review types
1. Parse review result using interpretPersonaStatus() ← BUG FIX: Always use centralized parser
2. Detect special contexts (TDD, previous failures)
3. Decide: create new tasks vs iterate on existing plan
4. Execute PM evaluation and plan revision cycle (if supported)
5. Forward created tasks to implementation planner
```

## Architecture

```
ReviewCoordinationStep (abstract base class)
├── QAReviewCoordinationStep
│   ├── tddAware: true
│   ├── supportsIteration: true
│   └── urgentPriorityScore: 1200
├── CodeReviewCoordinationStep
│   ├── tddAware: false
│   ├── supportsIteration: false
│   └── urgentPriorityScore: 1000
└── SecurityReviewCoordinationStep
    ├── tddAware: false
    ├── supportsIteration: false
    └── urgentPriorityScore: 1100
```

## Key Features

### 1. Consistent Status Parsing

**Before** (QAFailureCoordinationStep - BUGGY):
```typescript
private parseQAStatus(qaResult: any): { status: string; details?: string; tasks?: any[] } {
  if (typeof qaResult === 'object') {
    const payload = qaResult.payload || qaResult;
    return {
      status: payload.status || qaResult.status || 'unknown',
      details: payload.details || payload.message || JSON.stringify(payload), // BUG!
      tasks: payload.tasks || qaResult.tasks || []
    };
  }
  return { status: 'unknown', details: String(qaResult) };
}
```

**After** (ReviewCoordinationStep - FIXED):
```typescript
protected parseReviewStatus(reviewResult: any): ParsedReviewStatus {
  const rawOutput = reviewResult?.output || (typeof reviewResult === 'string' ? reviewResult : JSON.stringify(reviewResult));
  const statusInfo = interpretPersonaStatus(rawOutput); // ← Always use centralized parser
  
  return {
    status: statusInfo.status as 'pass' | 'fail' | 'unknown',
    details: statusInfo.details, // ← Clean extracted text, not stringified JSON
    tasks: statusInfo.payload?.tasks || statusInfo.payload?.suggested_tasks || []
  };
}
```

### 2. Configurable Behavior

```typescript
export interface ReviewCoordinationConfig {
  reviewType: 'qa' | 'code_review' | 'security_review';
  reviewResultVariable?: string;
  maxPlanRevisions?: number; // Default: 5
  taskCreationStrategy?: "always" | "never" | "auto"; // Default: auto
  tddAware?: boolean; // Default: true for QA, false for others
  evaluationStep?: string;
  revisionStep?: string;
  createdTasksStep?: string;
  urgentPriorityScore?: number; // Default: 1200 (QA), 1100 (security), 1000 (code)
  deferredPriorityScore?: number; // Default: 50
  supportsIteration?: boolean; // Default: true for QA, false for others
}
```

### 3. Extensible Methods

Subclasses can override specific methods to customize behavior:

```typescript
// Override status parsing for review-type-specific logic
protected parseReviewStatus(reviewResult: any): ParsedReviewStatus

// Override TDD detection for custom contexts
protected detectTDDContext(context: WorkflowContext, task: any): TDDContext

// Override task creation decision logic
protected shouldCreateNewTasks(...): boolean

// Override urgency detection
protected isUrgentFailure(...): boolean

// Override task creation
protected async createReviewFailureTasks(...): Promise<any[]>
```

## Usage Examples

### QA Review Coordination

```typescript
// Minimal - uses all defaults
export class QAReviewCoordinationStep extends ReviewCoordinationStep {
  constructor(config: any) {
    super(config);
    (this.config.config as any).reviewType = 'qa';
  }
}
```

```yaml
# In workflow YAML
steps:
  - name: qa_failure_coordination
    type: QAReviewCoordinationStep
    depends_on: [qa_request]
    config:
      reviewType: qa
      maxPlanRevisions: 5
      taskCreationStrategy: auto
      # All other config uses defaults
```

### Security Review with Custom Urgency

```typescript
export class SecurityReviewCoordinationStep extends ReviewCoordinationStep {
  constructor(config: any) {
    super(config);
    (this.config.config as any).reviewType = 'security_review';
  }
  
  // All security failures are urgent
  protected isUrgentFailure(): boolean {
    return true;
  }
}
```

## Migration Guide

### Migrating QAFailureCoordinationStep

**Current state:**
- `QAFailureCoordinationStep` at `src/workflows/steps/QAFailureCoordinationStep.ts` (681 lines)
- Has its own `parseQAStatus()`, task creation, PM evaluation, plan revision

**Migration steps:**

1. **Register new step type:**
```typescript
// src/workflows/engine/WorkflowStepRegistry.ts
import { QAReviewCoordinationStep } from '../steps/ReviewCoordinationSteps.js';

stepRegistry.register('QAReviewCoordinationStep', QAReviewCoordinationStep);
```

2. **Update workflow YAML:**
```yaml
# Before
- name: qa_failure_coordination
  type: QAFailureCoordinationStep
  config:
    maxPlanRevisions: 5
    taskCreationStrategy: auto
    # ... other config

# After
- name: qa_failure_coordination
  type: QAReviewCoordinationStep
  config:
    reviewType: qa  # ← Add this
    maxPlanRevisions: 5
    taskCreationStrategy: auto
    # ... other config unchanged
```

3. **Test with existing workflows:**
```bash
npm test -- tests/qaFailureCoordination.test.ts
npm test -- tests/happyPath.test.ts
npm test -- tests/qaFollowupExecutes.test.ts
```

4. **Verify production behavior:**
- Monitor logs for "qa coordination completed successfully"
- Check that UNKNOWN status creates tasks with readable details
- Verify QA PASS workflows proceed to code review

5. **After verification, deprecate old class:**
```typescript
// QAFailureCoordinationStep.ts
/** @deprecated Use QAReviewCoordinationStep instead */
export class QAFailureCoordinationStep extends QAReviewCoordinationStep {
  // Compatibility shim
}
```

### Migrating ReviewFailureTasksStep

**Current state:**
- `ReviewFailureTasksStep` at `src/workflows/steps/ReviewFailureTasksStep.ts`
- Used for code review and security review task creation
- Doesn't have iteration support or PM evaluation

**Migration approach:**

This step is simpler - it only creates tasks, doesn't iterate or revise plans. Options:

1. **Use base class directly with iteration disabled:**
```yaml
- name: create_code_review_tasks
  type: CodeReviewCoordinationStep
  config:
    reviewType: code_review
    supportsIteration: false  # No plan revision
    taskCreationStrategy: always  # Always create tasks
```

2. **Keep ReviewFailureTasksStep for simpler use cases:**
- If you only need task creation without coordination
- No plan revision, no PM evaluation
- Lightweight, focused on one thing

Decision: Keep both. Use `ReviewFailureTasksStep` for simple task creation, use `CodeReviewCoordinationStep` / `SecurityReviewCoordinationStep` when you need full coordination.

## Benefits

1. **Bug Prevention**: Single implementation of `interpretPersonaStatus()` usage eliminates duplicate parsing bugs
2. **DRY Principle**: ~500 lines of duplicate code eliminated across QA/Code/Security
3. **Consistency**: All review types use same coordination pattern
4. **Maintainability**: Fix once, applies everywhere
5. **Testability**: Test base class once, subclasses inherit correct behavior
6. **Extensibility**: Easy to add new review types (e.g., PerformanceReview, AccessibilityReview)

## Testing Strategy

### Unit Tests for Base Class

```typescript
describe('ReviewCoordinationStep', () => {
  it('uses interpretPersonaStatus for parsing', async () => {
    // Mock persona response with markdown code fence
    const mockResponse = {
      output: '```json\n{"status": "fail", "details": "Test failed"}\n```'
    };
    
    const step = new QAReviewCoordinationStep(config);
    const parsed = step['parseReviewStatus'](mockResponse);
    
    expect(parsed.status).toBe('fail');
    expect(parsed.details).toBe('Test failed'); // Not stringified JSON!
  });
  
  it('creates tasks with readable details for UNKNOWN status', async () => {
    // ...
  });
  
  it('handles TEXT responses with embedded JSON', async () => {
    const mockResponse = {
      output: '**Test Results**\n\n```json\n{"status": "pass"}\n```\n\nAll tests passed!'
    };
    
    const parsed = step['parseReviewStatus'](mockResponse);
    expect(parsed.status).toBe('pass');
  });
});
```

### Integration Tests

```typescript
describe('QA coordination integration', () => {
  it('creates dashboard tasks when QA returns UNKNOWN', async () => {
    // Full workflow test
    // Verify tasks appear on dashboard with correct titles
  });
  
  it('proceeds to code review when QA returns PASS', async () => {
    // Verify workflow doesn't loop
  });
});
```

## Future Enhancements

1. **Add PerformanceReviewCoordinationStep**: For performance/benchmark failures
2. **Add AccessibilityReviewCoordinationStep**: For a11y audit failures
3. **Add custom isUrgentFailure logic**: Parse severity from review results
4. **Add retry logic**: Exponential backoff for transient failures
5. **Add metrics collection**: Track coordination performance, task creation rates

## Related Documents

- `PERSONA_RETRY_MECHANISM.md` - Persona timeout handling
- `WORKFLOW_SYSTEM.md` - Overall workflow architecture
- `TASK_LOGGING.md` - Task creation and logging patterns
- Git commits: `9cca251` (QAIterationLoopStep fix), `ae7de43` (QAFailureCoordinationStep fix)
