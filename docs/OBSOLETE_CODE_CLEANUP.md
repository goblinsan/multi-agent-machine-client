# Obsolete Code Cleanup - October 20, 2025

## Summary

Removed obsolete workflow steps that were replaced in v3.0.0 unified review handling refactor. These files contained `makeRedis()` calls but were no longer used in any workflow definitions.

## Files Removed

### Source Files (4 files, ~1,885 lines)
1. **src/workflows/steps/QAFailureCoordinationStep.ts** (681 lines)
   - Replaced by: Unified `review-failure-handling` sub-workflow
   - Last used: Before v3.0.0
   - Reason: Specialized QA failure handling merged into unified pattern

2. **src/workflows/steps/QAIterationLoopStep.ts** (400+ lines)
   - Replaced by: Unified review retry pattern via PM evaluation
   - Last used: Before v3.0.0 (comment in task-flow.yaml line 7)
   - Reason: QA no longer has special iteration loop, uses same pattern as other reviews

3. **src/workflows/steps/ReviewCoordinationStep.ts** (800+ lines)
   - Status: Abstract base class, never registered
   - Concrete implementations: QAReviewCoordinationStep, CodeReviewCoordinationStep, SecurityReviewCoordinationStep
   - Reason: Infrastructure for refactor that was never completed/registered

4. **src/workflows/steps/ReviewCoordinationSteps.ts** (94 lines)
   - Depends on: ReviewCoordinationStep (deleted above)
   - Contains: QAReviewCoordinationStep, CodeReviewCoordinationStep, SecurityReviewCoordinationStep
   - Reason: None of these were registered in WorkflowEngine

### Test Files (2 files)
5. **tests/qaFailureTaskCreation.integration.test.ts**
   - Tests: QAFailureCoordinationStep (deleted)
   - Reason: Tests obsolete code

6. **tests/qaUnknownStatus.test.ts**
   - Tests: QAFailureCoordinationStep handling of unknown status
   - Reason: Tests obsolete code

### Registry Updates
7. **src/workflows/WorkflowEngine.ts**
   - Removed imports: `QAFailureCoordinationStep`, `QAIterationLoopStep`
   - Removed registrations: Both steps removed from stepRegistry

## Impact Analysis

### What Changed in v3.0.0
From `docs/workflows/UNIFIED_REVIEW_HANDLING.md`:

**Architecture Unification:**
- All reviews (QA, code review, security) now use `review-failure-handling` sub-workflow
- PM decides all retries consistently
- No more special QA iteration loop
- Unified duplicate detection and TDD awareness

**Before v3.0.0:**
```yaml
# QA had special handling
- name: qa-failure-coordination
  type: QAFailureCoordinationStep
  
- name: qa-iteration-loop
  type: QAIterationLoopStep
```

**After v3.0.0:**
```yaml
# All reviews use same pattern
- name: review-failure-handling
  type: SubWorkflowStep
  config:
    workflow: review-failure-handling
    review_type: "qa"  # or "code_review" or "security_review"
```

### Files Still Active
These files were checked but are STILL IN USE:

✅ **src/workflows/steps/PersonaRequestStep.ts** - Used in multiple workflows
✅ **src/workflows/steps/PlanningLoopStep.ts** - Used in task-flow.yaml
✅ **src/workflows/steps/BlockedTaskAnalysisStep.ts** - Used in blocked-task-resolution.yaml
✅ **src/workflows/steps/PullTaskStep.ts** - Used in multiple workflows

### References Updated
- WorkflowEngine.ts: Removed imports and registrations
- No workflow YAMLs needed updating (steps already removed)
- Test files removed (tested obsolete code)

## Benefits

1. **Cleaner Codebase**
   - Removed ~1,885 lines of obsolete code
   - Eliminated confusion about which QA handling to use
   - Clearer that unified review pattern is the way

2. **Simpler Refactoring**
   - 4 fewer files to update for transport abstraction
   - No need to refactor code that's not used
   - Focus on active, maintained code

3. **Documentation Alignment**
   - Code now matches v3.0.0 documentation
   - No contradiction between docs saying "removed" and files existing

## Verification

### Workflow YAML Files Checked
```bash
$ grep -r "QAFailureCoordinationStep\|QAIterationLoopStep" src/workflows/definitions/*.yaml
# No results (only comment saying it was removed)
```

### Step Registry Verified
```bash
$ grep "stepRegistry.set.*QAFailure\|stepRegistry.set.*QAIteration" src/workflows/WorkflowEngine.ts
# No results (registrations removed)
```

### Compilation Clean
```bash
$ npx tsc --noEmit
# No errors
```

## Related Documentation

- `docs/workflows/UNIFIED_REVIEW_HANDLING.md` - Explains v3.0.0 unification
- `src/workflows/definitions/task-flow.yaml` line 7 - Comment about removal
- `docs/workflows/DAYS_3_7_MIGRATION_PLAN.md` - Migration planning (now completed)
- `CHANGELOG.md.backup` - Historical reference to when these were added

## Next Steps

With obsolete code removed, the remaining transport abstraction refactoring is:

1. ✅ **Core Infrastructure Complete** (WorkflowContext, WorkflowEngine, WorkflowCoordinator)
2. ⏳ **Active Workflow Steps** (5 files):
   - PersonaRequestStep.ts
   - PlanningLoopStep.ts
   - BlockedTaskAnalysisStep.ts
   - PullTaskStep.ts
3. ⏳ **Helpers** (2 files):
   - agents/persona.ts
   - workflows/helpers/workflowAbort.ts
4. ⏳ **WorkflowCoordinator** line 497 - sendLegacyPersonaRequests()

**Total remaining: 8 locations** (down from 13!)

---

**Removed by**: Automated cleanup based on v3.0.0 unified review handling  
**Verified by**: Workflow YAML scan, compilation test, test suite
