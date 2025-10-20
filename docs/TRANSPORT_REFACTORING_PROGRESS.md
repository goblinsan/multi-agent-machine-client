# Transport Abstraction Refactoring - Progress Report

## Completed Work ✅

### Phase 1: Core Infrastructure (COMPLETE)
- ✅ Added `transport: MessageTransport` field to `WorkflowContext`
- ✅ Updated `WorkflowContext` constructor to require transport parameter  
- ✅ Updated `clone()` method to pass transport to cloned context
- ✅ Added transport import to `WorkflowContext.ts`

### Phase 2: WorkflowEngine (COMPLETE)
- ✅ Added `MessageTransport` import to `WorkflowEngine.ts`
- ✅ Updated `executeWorkflow()` to accept `transport` parameter
- ✅ Updated `executeWorkflowDefinition()` to accept `transport` parameter
- ✅ Pass transport to `WorkflowContext` constructor in engine

### Phase 3: WorkflowCoordinator (COMPLETE)
- ✅ Added `MessageTransport` import to `WorkflowCoordinator.ts`
- ✅ Updated `handleCoordinator()` to accept `transport` as first parameter
- ✅ Updated `processTask()` to accept `transport` as first parameter
- ✅ Updated call to `engine.executeWorkflowDefinition()` to pass transport
- ✅ Updated legacy export wrapper to accept and pass transport
- ✅ Updated caller in `run_local_stack.ts` to pass transport

### Phase 4: Testing Infrastructure
- ✅ Documented breaking changes in `TRANSPORT_REFACTORING_PLAN.md`
- ✅ Identified all files that need updates (13 workflow steps + helpers)
- ✅ Created migration guide for tests

## What Changed

### API Signatures

**WorkflowContext Constructor:**
```typescript
// Before
new WorkflowContext(workflowId, projectId, repoRoot, branch, config, initialVariables)

// After  
new WorkflowContext(workflowId, projectId, repoRoot, branch, config, transport, initialVariables)
```

**WorkflowEngine.executeWorkflow:**
```typescript
// Before
engine.executeWorkflow(name, projectId, repoRoot, branch, variables)

// After
engine.executeWorkflow(name, projectId, repoRoot, branch, transport, variables)
```

**WorkflowCoordinator.handleCoordinator:**
```typescript
// Before
coordinator.handleCoordinator(r, msg, payload)

// After
coordinator.handleCoordinator(transport, r, msg, payload)
```

## Remaining Work ⏳

### High Priority
1. **Update Tests** - All tests creating WorkflowContext need transport parameter
   - `tests/qaFollowupExecutes.test.ts` 
   - `tests/blockedTaskResolution.test.ts`
   - `tests/coordinator.test.ts`
   - `tests/workflowCoordinator.test.ts`
   - Many more (~50+ test files)

2. **Update Workflow Steps** - 13 files still call `makeRedis()`:
   - `src/workflows/steps/PersonaRequestStep.ts` (line 53)
   - `src/workflows/steps/QAFailureCoordinationStep.ts` (line 84)
   - `src/workflows/steps/ReviewCoordinationStep.ts` (line 125)
   - `src/workflows/steps/PlanningLoopStep.ts` (line 49)
   - `src/workflows/steps/BlockedTaskAnalysisStep.ts` (line 95)
   - `src/workflows/steps/PullTaskStep.ts` (line 49)
   - `src/workflows/steps/QAIterationLoopStep.ts` (line 53)
   - `src/workflows/steps/SubWorkflowStep.ts` (line 113)
   
3. **Update Helpers** - Still using makeRedis():
   - `src/workflows/helpers/workflowAbort.ts` (line 13)

4. **Update Agents** - Still using makeRedis():
   - `src/agents/persona.ts` (line 22)
   - Update `sendPersonaRequest()` to accept transport
   - Update `waitForPersonaCompletion()` to accept transport

5. **Update Process Layer**:
   - `src/process.ts` - Update `processContext()` and `processPersona()` if needed

### Medium Priority
6. **Remove makeRedis() from WorkflowCoordinator**:
   - Line 492: Used in `sendLegacyPersonaRequests()` 
   - This is for `ENABLE_PERSONA_COMPAT_MODE` - legacy code path
   - Needs transport parameter added

7. **Update Other Callers**:
   - Find any other places calling `handleCoordinator()`
   - Update to pass transport

### Low Priority  
8. **Cleanup**:
   - Remove unused `makeRedis` imports once all calls are eliminated
   - Update documentation
   - Add migration guide for external callers

## Testing Strategy

### Immediate: Fix Compilation Errors
Run `npm run build` or use tsx to check for TypeScript errors:
```bash
npx tsx src/workflows/WorkflowCoordinator.ts
```

### Unit Tests
Update each test to create and pass transport:
```typescript
import { LocalTransport } from '../src/transport/LocalTransport';

// In test setup
const transport = new LocalTransport();

// When calling coordinator
await coordinator.handleCoordinator(transport, {}, msg, payload);

// When creating context
const context = new WorkflowContext(
  'workflow-id',
  'project-id',
  '/repo/path',
  'main',
  config,
  transport,  // ← Add this
  {}
);
```

### Integration Tests
```bash
# Test with local transport
TRANSPORT_TYPE=local npm test

# Verify no Redis connection errors
npm run local -- 1 2>&1 | grep -i "redis.*error"
# Should return nothing if successful
```

## Success Metrics

### Immediate Success (Current State)
- ✅ Core infrastructure accepts transport via dependency injection
- ✅ WorkflowEngine passes transport to context
- ✅ WorkflowCoordinator accepts transport parameter
- ✅ Main execution path uses transport abstraction

### Next Milestone (After Test Updates)
- ⏳ All tests pass with transport parameter
- ⏳ No compilation errors
- ⏳ Local development workflow works end-to-end

### Final Success (After All Refactoring)
- ⏳ Zero `makeRedis()` calls outside transport factory
- ⏳ Zero Redis connection errors with `TRANSPORT_TYPE=local`
- ⏳ All workflow steps use `context.transport`
- ⏳ All tests use `LocalTransport` by default
- ⏳ Documentation updated with new patterns

## Impact Analysis

### Breaking Changes
1. **All test files** must be updated to pass transport
2. **External callers** of `handleCoordinator()` must add transport parameter
3. **Workflow step implementations** will need context.transport instead of makeRedis()

### Non-Breaking (Backward Compatible)
- Existing workflow YAML definitions don't change
- Dashboard API remains the same
- Configuration (`TRANSPORT_TYPE`) already exists

## Next Actions (Priority Order)

1. **Run tests** to see compilation errors: `npm test`
2. **Fix one test file** as template (e.g., `coordinator.test.ts`)
3. **Create helper** for test setup with transport
4. **Batch update** all test files
5. **Update one workflow step** as template (e.g., `PersonaRequestStep`)
6. **Apply pattern** to remaining steps
7. **Verify locally**: `npm run local -- 1`
8. **Check for Redis errors**: Should be zero!

## Estimated Timeline

- Fix tests: 3-4 hours (50+ files)
- Update workflow steps: 2-3 hours (13 files)
- Update helpers/agents: 1 hour (3 files)
- Testing & verification: 1-2 hours
- Documentation: 30 minutes

**Total: 7-10 hours of focused work**

## Benefits Already Achieved

Even with tests not yet updated:

1. ✅ **Clear dependency flow** - Transport explicitly passed through call chain
2. ✅ **Testable architecture** - Easy to inject mock transport
3. ✅ **Preparation complete** - Infrastructure ready for full migration
4. ✅ **No new Redis coupling** - New code uses proper pattern
5. ✅ **Foundation laid** - Remaining work is systematic application of pattern

## Current System State

**Works:** ✅
- `npm run local -- 1` executes workflows
- Repository cloning succeeds
- Task fetching succeeds
- Milestone data included in tasks
- Branch naming uses milestone slug

**Still Logs Errors:** ⚠️
- Redis connection errors from workflow steps
- Non-fatal but noisy in logs

**Broken:** ❌
- Tests that create WorkflowContext without transport
- Tests that call handleCoordinator() without transport

## Roll Forward Strategy

The refactoring is **one-way** - we should complete it rather than roll back because:

1. The new architecture is objectively better (dependency injection)
2. Core infrastructure is already updated
3. Tests were already going to break (they use temp repos, need updates anyway)
4. LocalTransport enables true local development without Docker/Redis

**Recommendation:** Continue forward, fix tests systematically, complete the refactoring.
