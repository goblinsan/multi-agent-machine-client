# Local Transport - Remaining Work

## Summary
The local transport system is partially implemented but several components still use Redis directly, causing connection errors even when `TRANSPORT_TYPE=local`.

## Issues Identified

### 1. ✅ FIXED: Duplicate Dashboard Operations
**Problem**: `WorkflowCoordinator.fetchProjectTasks()` duplicated code from `dashboard.ts`
**Solution**: Removed duplicate, now uses centralized `fetchProjectTasks()` from `dashboard.ts`
**Benefit**: Single source of truth for dashboard operations

### 2. ✅ FIXED: Branch Naming Used Project Slug Instead of Milestone Slug  
**Problem**: Tasks didn't include milestone information, so branch computation fell back to project slug
**Root Cause**: API design issue - tasks only had `milestone_id`, not milestone details
**Solution**: Updated `/projects/:projectId/tasks` endpoint to JOIN with milestones table
**Result**: Tasks now include `milestone: { id, name, slug, status }` object
**Branch names now**: `milestone/foundation-config` instead of `milestone/multi-agent-log-summarizer`

### 3. ⚠️ PARTIAL: Dashboard Task Update Endpoint Mismatch
**Problem**: Client code tries `/v1/tasks/:id/status` or `/v1/tasks/by-external/:external_id/status`
**Reality**: Local dashboard has `/projects/:projectId/tasks/:taskId`
**Status**: Added TODO comment, needs broader API alignment
**Options**:
  - A) Update local dashboard to match external API contract
  - B) Create adapter layer to translate between APIs
  - C) Make client code configurable for different dashboard backends

### 4. ❌ NOT FIXED: Redis Calls Throughout Workflow System
**Problem**: Many workflow steps and helpers still call `makeRedis()` directly
**Impact**: Connection errors logged even with `TRANSPORT_TYPE=local`
**Scope**: 13 files need updating

## Files Still Using Direct Redis Calls

1. `src/workflows/WorkflowCoordinator.ts` (line 489)
2. `src/agents/persona.ts` (line 22)
3. `src/workflows/steps/QAFailureCoordinationStep.ts` (line 84)
4. `src/workflows/steps/ReviewCoordinationStep.ts` (line 125)
5. `src/workflows/steps/PlanningLoopStep.ts` (line 49)
6. `src/workflows/steps/BlockedTaskAnalysisStep.ts` (line 95)
7. `src/workflows/steps/PullTaskStep.ts` (line 49)
8. `src/workflows/steps/QAIterationLoopStep.ts` (line 53)
9. `src/workflows/steps/PersonaRequestStep.ts` (line 53)
10. `src/workflows/helpers/workflowAbort.ts` (line 13)
11. `src/tools/seed_example.ts` (line 53)

## Recommended Refactoring Approach

### Phase 1: Transport Interface Extension
Ensure `MessageTransport` interface has all methods needed:
- `xAdd()`, `xReadGroup()`, `xAck()` - ✅ Already present
- `xGroupCreate()`, `xLen()` - ✅ Already present  
- Need to audit what other Redis methods are used in workflow steps

### Phase 2: Update Workflow Steps
For each step file:
1. Add `transport: MessageTransport` parameter to step execution
2. Replace `await makeRedis()` with passed transport
3. Remove Redis-specific calls, use transport interface
4. Handle LocalTransport limitations (no persistence, single-process)

### Phase 3: Update WorkflowCoordinator
- Pass transport through to all step executions
- Remove direct `makeRedis()` calls
- Consider: Does coordinator need Redis for anything beyond message passing?

### Phase 4: Update Helper Functions
- `workflowAbort.ts` and similar helpers need transport parameter
- Consider: Create a context object that includes transport

## API Design Improvements

### Current State
- Local dashboard: `/projects/:projectId/tasks`
- External dashboard: `/v1/tasks?project_id=...`
- Client expects: Both formats depending on context

### Recommendation
1. **Standardize on one API contract** across all dashboards
2. **Version the API properly** (v1, v2) with clear migration path
3. **Use consistent response wrapping**: `{ data: [...] }` everywhere
4. **JOIN related data** (like milestones) to reduce round trips
5. **Document the API** in OpenAPI/Swagger format

## Testing Strategy

### Unit Tests Needed
- Each workflow step with LocalTransport mock
- Verify no Redis calls when using LocalTransport
- Test transport interface compatibility

### Integration Tests Needed
- Full workflow with LocalTransport end-to-end
- Verify no connection errors in logs
- Test workflow abort/retry scenarios

### Performance Considerations
- LocalTransport is in-memory, no persistence
- Workflow state lost on process restart
- For production: Use Redis
- For development/testing: LocalTransport is sufficient

## Priority Order

1. **HIGH**: Fix Redis errors in workflow steps (breaks local development)
2. **MEDIUM**: Standardize dashboard API (affects external integrations)
3. **LOW**: Optimize API responses (performance enhancement)

## Next Steps

1. Review `MessageTransport` interface for completeness
2. Create transport-aware base class for workflow steps
3. Refactor one step as example (e.g., `PersonaRequestStep`)
4. Apply pattern to remaining steps
5. Update documentation and examples
6. Add integration tests for local transport workflows

## Related Files
- `src/transport/index.ts` - Transport factory
- `src/transport/LocalTransport.ts` - EventEmitter implementation
- `src/transport/RedisTransport.ts` - Redis implementation
- `docs/LOCAL_TRANSPORT.md` - User-facing documentation
- `docs/QUICK_START.md` - Quick start guide
