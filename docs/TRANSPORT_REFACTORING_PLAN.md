# Transport Abstraction - Dependency Injection Refactoring

## Problem Statement
The codebase has tight coupling to Redis, with `makeRedis()` called directly in 13+ locations. This violates dependency injection principles and makes testing difficult.

## Goals
1. **Eliminate all direct `makeRedis()` calls** outside of the transport factory
2. **Use dependency injection** - pass `MessageTransport` through the call chain
3. **Enable true local development** without Redis connection errors
4. **Improve testability** - easy to mock transport in tests
5. **Support multiple backends** - Redis, LocalTransport, or future implementations

## Architecture Pattern

### Current (Bad) Pattern
```typescript
// Tightly coupled - creates Redis client internally
async function someWorkflowStep() {
  const redis = await makeRedis();  // ❌ Direct dependency
  await redis.xAdd('stream', '*', { data: 'value' });
  await redis.quit();
}
```

### Target (Good) Pattern
```typescript
// Dependency injection - transport passed from caller
async function someWorkflowStep(transport: MessageTransport) {
  await transport.xAdd('stream', '*', { data: 'value' });  // ✅ Uses abstraction
  // No cleanup needed - caller manages lifecycle
}
```

## Refactoring Strategy

### Phase 1: Core Infrastructure (CRITICAL)
1. ✅ Create `MessageTransport` interface
2. ✅ Implement `LocalTransport` and `RedisTransport`
3. ✅ Create transport factory with singleton
4. ⏳ Add transport to workflow execution context
5. ⏳ Update `WorkflowEngine` to pass transport

### Phase 2: Worker & Coordinator (DONE)
1. ✅ Update `worker.ts` to use `getTransport()`
2. ✅ Update `run_coordinator.ts` to use `getTransport()`
3. ✅ Update `run_local_stack.ts` to use `getTransport()`

### Phase 3: Process Layer (TODO)
1. ⏳ Update `process.ts` - `processContext()` and `processPersona()`
2. ⏳ Pass transport through to persona handlers

### Phase 4: Agents & Personas (TODO)
1. ⏳ Update `agents/persona.ts` - `sendPersonaRequest()`, `waitForPersonaCompletion()`
2. ⏳ Remove `makeRedis()` from persona layer
3. ⏳ Accept transport as parameter

### Phase 5: Workflow Steps (MAJOR EFFORT)
Update each step to accept transport via context:

#### Pattern to Apply
```typescript
// Before
class SomeStep extends WorkflowStep {
  async execute(config: any, context: WorkflowContext): Promise<StepResult> {
    const redis = await makeRedis();  // ❌
    // ... use redis
    await redis.quit();
  }
}

// After
class SomeStep extends WorkflowStep {
  async execute(config: any, context: WorkflowContext): Promise<StepResult> {
    const transport = context.transport;  // ✅
    // ... use transport
    // No cleanup - context manages lifecycle
  }
}
```

#### Files to Update (13 total)
- [ ] `src/workflows/WorkflowCoordinator.ts` (line 489)
- [ ] `src/workflows/steps/PersonaRequestStep.ts` (line 53)
- [ ] `src/workflows/steps/QAFailureCoordinationStep.ts` (line 84)
- [ ] `src/workflows/steps/ReviewCoordinationStep.ts` (line 125)
- [ ] `src/workflows/steps/PlanningLoopStep.ts` (line 49)
- [ ] `src/workflows/steps/BlockedTaskAnalysisStep.ts` (line 95)
- [ ] `src/workflows/steps/PullTaskStep.ts` (line 49)
- [ ] `src/workflows/steps/QAIterationLoopStep.ts` (line 53)
- [ ] `src/workflows/helpers/workflowAbort.ts` (line 13)

### Phase 6: WorkflowContext Enhancement (FOUNDATION)
Add transport to the context object:

```typescript
// src/workflows/WorkflowContext.ts
export class WorkflowContext {
  // Existing fields...
  public readonly transport: MessageTransport;  // ✅ Add this
  
  constructor(params: {
    // ... existing params
    transport: MessageTransport;  // ✅ Require this
  }) {
    // ... existing initialization
    this.transport = params.transport;
  }
}
```

### Phase 7: WorkflowEngine Integration
Update engine to receive and pass transport:

```typescript
// src/workflows/WorkflowEngine.ts
export class WorkflowEngine {
  async executeWorkflow(
    workflowName: string,
    initialContext: Partial<WorkflowContext>,
    transport: MessageTransport  // ✅ Add parameter
  ): Promise<WorkflowExecutionResult> {
    const context = new WorkflowContext({
      ...initialContext,
      transport  // ✅ Pass to context
    });
    // ... rest of execution
  }
}
```

### Phase 8: WorkflowCoordinator Entry Point
Coordinator gets transport and passes it down:

```typescript
// src/workflows/WorkflowCoordinator.ts
export class WorkflowCoordinator {
  async handleCoordinator(
    transport: MessageTransport,  // ✅ Accept as parameter
    msg: any,
    payload: any
  ): Promise<any> {
    // ... setup code
    
    const result = await this.engine.executeWorkflow(
      workflowName,
      initialContext,
      transport  // ✅ Pass down
    );
  }
}
```

## Implementation Order (CRITICAL PATH)

1. **WorkflowContext** - Add transport field
2. **WorkflowEngine** - Accept and pass transport
3. **WorkflowCoordinator** - Accept transport parameter
4. **Worker/Process** - Pass transport to coordinator
5. **Each Workflow Step** - Use context.transport
6. **Agents/Personas** - Accept transport parameter
7. **Helpers** - Accept transport parameter

## Testing Strategy

### Unit Tests
```typescript
import { LocalTransport } from '../transport/LocalTransport';

describe('SomeWorkflowStep', () => {
  it('should use injected transport', async () => {
    const transport = new LocalTransport();
    const context = new WorkflowContext({ transport, /* ... */ });
    
    const step = new SomeStep();
    const result = await step.execute({}, context);
    
    expect(result.success).toBe(true);
  });
});
```

### Integration Tests
```typescript
describe('Full Workflow with LocalTransport', () => {
  it('should execute without Redis', async () => {
    const transport = await getTransport(); // Uses TRANSPORT_TYPE=local
    const coordinator = new WorkflowCoordinator();
    
    const result = await coordinator.handleCoordinator(
      transport,
      mockMessage,
      mockPayload
    );
    
    expect(result.success).toBe(true);
  });
});
```

## Breaking Changes

### For Tests
All tests that create workflow contexts must now provide transport:
```typescript
// Before
const context = new WorkflowContext({ workflowId: '123' });

// After
const transport = new LocalTransport();
const context = new WorkflowContext({ workflowId: '123', transport });
```

### For Direct Callers
Anyone calling `WorkflowCoordinator.handleCoordinator()` must pass transport:
```typescript
// Before
await coordinator.handleCoordinator(msg, payload);

// After
const transport = await getTransport();
await coordinator.handleCoordinator(transport, msg, payload);
```

## Benefits

1. **Zero Redis Connection Errors** in local mode
2. **Faster Tests** - use LocalTransport, no Docker needed
3. **Easy Mocking** - inject test doubles
4. **Future-Proof** - swap implementations without code changes
5. **Clear Dependencies** - explicit parameter passing
6. **Better Separation** - business logic independent of transport

## Migration Path

### Step 1: Add Optional Transport (Non-Breaking)
Make transport optional initially to avoid breaking existing code:

```typescript
async handleCoordinator(
  transportOrMsg: MessageTransport | any,
  msgOrPayload?: any,
  payload?: any
): Promise<any> {
  // Detect old vs new calling convention
  let transport: MessageTransport;
  let msg: any;
  let actualPayload: any;
  
  if (transportOrMsg && 'xAdd' in transportOrMsg) {
    // New convention: transport passed
    transport = transportOrMsg;
    msg = msgOrPayload;
    actualPayload = payload;
  } else {
    // Old convention: no transport
    transport = await getTransport();
    msg = transportOrMsg;
    actualPayload = msgOrPayload;
  }
  
  // ... rest of implementation
}
```

### Step 2: Update Callers Gradually
Update each caller one at a time to pass transport.

### Step 3: Remove Backward Compatibility
Once all callers updated, remove optional parameter handling.

## Success Criteria

- [ ] Zero `makeRedis()` calls outside transport factory
- [ ] Zero Redis connection errors with `TRANSPORT_TYPE=local`
- [ ] All tests pass with LocalTransport
- [ ] No breaking changes to external APIs
- [ ] Documentation updated
- [ ] Migration guide created

## Timeline Estimate

- Phase 1 (Context/Engine): 2 hours
- Phase 2 (Coordinator): 1 hour  
- Phase 3 (Worker/Process): 1 hour
- Phase 4 (Agents): 1 hour
- Phase 5 (Workflow Steps): 4 hours
- Phase 6 (Helpers): 1 hour
- Phase 7 (Testing): 2 hours
- Phase 8 (Documentation): 1 hour

**Total: ~13 hours of focused work**

## Next Actions

1. Start with `WorkflowContext` - add transport field
2. Update `WorkflowEngine` to accept and pass transport
3. Update `WorkflowCoordinator` to accept transport
4. Update one workflow step as template
5. Apply pattern to remaining steps
6. Update tests
7. Verify zero Redis errors in local mode
