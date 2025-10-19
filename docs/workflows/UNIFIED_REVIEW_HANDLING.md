# Unified Review Failure Handling (v3.0.0)

**Date:** Nov 1, 2025  
**Commit:** 7131f47

---

## Changes

### Architecture Unification
- **All reviews use same pattern:** QA, code review, and security now use `review-failure-handling` sub-workflow
- **Removed QAIterationLoopStep:** QA failures no longer have special retry loop
- **PM decides all retries:** PM evaluates all review failures consistently

### TDD Awareness
- All review types receive `tdd_aware` and `tdd_stage` flags
- PM prompt includes TDD context warnings for failing test stages
- Prevents inappropriate task creation during TDD workflow

### Duplicate Detection
- PM evaluates `existing_tasks` list before creating new tasks
- BulkTaskCreationStep filters duplicates by title+milestone
- Returns `duplicate_task_ids` for reference
- `skipped_duplicates` count in results

### Breaking Changes
- QAFailureCoordinationStep no longer used
- QAIterationLoopStep removed from task-flow.yaml
- Review-failure-handling.yaml now v2.0.0

---

## Migration Impact

**Before:**
- 3 different review failure patterns
- QA had special iteration loop
- No duplicate detection
- No TDD awareness

**After:**
- 1 unified review failure pattern
- All reviews handled consistently
- Duplicate detection built-in
- TDD-aware across all reviews

**TODO:**
- Implement dashboard query for `existing_tasks`
- Replace BulkTaskCreationStep placeholder with real API
