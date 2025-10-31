# Large Files Refactoring Assessment

## Files Over 400 Lines (Sorted by Size)

| Rank | File | Lines | Priority | Complexity |
|------|------|-------|----------|------------|
| 1 | `BulkTaskCreationStep.ts` | 708 | HIGH | Very High |
| 2 | `PersonaRequestStep.ts` | 607 | HIGH | High |
| 3 | `ContextStep.ts` | 582 | MEDIUM | High |
| 4 | `PlanningLoopStep.ts` | 505 | MEDIUM | High |
| 5 | `repository.ts` | 504 | HIGH | Very High |
| 6 | `WorkflowCoordinator.ts` | 494 | MEDIUM | High |
| 7 | `PlanEvaluationStep.ts` | 484 | LOW | Medium |
| 8 | `fileops.ts` | 476 | MEDIUM | Medium |
| 9 | `taskManager.ts` | 468 | MEDIUM | High |
| 10 | `LocalTransport.ts` | 467 | LOW | Low (wrapper) |
| 11 | `DiffParser.ts` | 466 | MEDIUM | High |
| 12 | `ReviewFailureTasksStep.ts` | 455 | LOW | Medium |
| 13 | `WorkflowEngine.ts` | 445 | MEDIUM | High |

**Total lines to refactor**: ~6,800 lines across 13 files

## Recommended Approach: Low-Hanging Fruit First

### Phase 1: Quick Wins (Est. 2-3 hours)

**Target**: Files with clear separation opportunities

1. **`repository.ts` (504 lines)** - GIT OPERATIONS
   - Extract: `GitCommandExecutor` (command execution)
   - Extract: `BranchManager` (branch operations)
   - Extract: `CommitManager` (commit/push operations)
   - Estimated reduction: 504 → 280 lines

2. **`fileops.ts` (476 lines)** - FILE OPERATIONS
   - Extract: `FileReader` (read operations)
   - Extract: `FileWriter` (write operations)
   - Extract: `PathResolver` (path utilities)
   - Estimated reduction: 476 → 250 lines

3. **`LocalTransport.ts` (467 lines)** - WRAPPER CLASS
   - This is mostly just wrapping Redis commands
   - Extract: `StreamOperations` (xAdd, xRead, etc.)
   - Extract: `GroupOperations` (consumer groups)
   - Estimated reduction: 467 → 200 lines

**Phase 1 Total**: Reduce ~1,447 lines to ~730 lines (save 717 lines)

### Phase 2: Workflow Steps (Est. 4-5 hours)

**Target**: Complex workflow steps with multiple responsibilities

4. **`BulkTaskCreationStep.ts` (708 lines)** - TASK CREATION
   - Already has helpers: TaskPriorityCalculator, TaskDuplicateDetector, TaskRouter
   - Extract: `TaskValidator` (validation logic)
   - Extract: `TaskBatchProcessor` (batch processing)
   - Extract: `RetryHandler` (retry logic - reusable!)
   - Estimated reduction: 708 → 350 lines

5. **`PersonaRequestStep.ts` (607 lines)** - PERSONA REQUESTS
   - Extract: `TimeoutManager` (timeout handling)
   - Extract: `ResponseParser` (response parsing)
   - Extract: `ArtifactManager` (artifact handling)
   - Estimated reduction: 607 → 350 lines

6. **`ContextStep.ts` (582 lines)** - CONTEXT GATHERING
   - Extract: `RepoScanner` (repo scanning logic)
   - Extract: `ContextAggregator` (aggregating context)
   - Estimated reduction: 582 → 320 lines

**Phase 2 Total**: Reduce ~1,897 lines to ~1,020 lines (save 877 lines)

### Phase 3: Core Components (Est. 3-4 hours)

7. **`taskManager.ts` (468 lines)** - TASK MANAGEMENT
   - Extract: `TaskFetcher` (fetching logic)
   - Extract: `TaskStatusManager` (status updates)
   - Extract: `TaskQueryBuilder` (query building)
   - Estimated reduction: 468 → 250 lines

8. **`WorkflowCoordinator.ts` (494 lines)** - COORDINATION
   - Extract: `TaskSelector` (task selection logic)
   - Extract: `WorkflowRouter` (workflow routing)
   - Estimated reduction: 494 → 300 lines

**Phase 3 Total**: Reduce ~962 lines to ~550 lines (save 412 lines)

## Overall Impact

| Phase | Files | Lines Before | Lines After | Savings | Time Est. |
|-------|-------|--------------|-------------|---------|-----------|
| 1 | 3 | 1,447 | 730 | 717 | 2-3h |
| 2 | 3 | 1,897 | 1,020 | 877 | 4-5h |
| 3 | 2 | 962 | 550 | 412 | 3-4h |
| **Total** | **8** | **4,306** | **2,300** | **2,006** | **9-12h** |

**Result**: All files under 400 lines, saving over 2,000 lines through better organization

## Immediate Recommendation

Start with **Phase 1: repository.ts** because:

1. ✅ Clear separation (git commands, branches, commits)
2. ✅ High impact (504 → 280 lines)
3. ✅ Reusable components (other files use git operations)
4. ✅ Quick win (1-2 hours)
5. ✅ Less risky (git operations are well-defined)

## Files to Skip

These are OK for now (under 450 or low priority):

- `PlanEvaluationStep.ts` (484) - Medium complexity, not urgent
- `PlanningLoopStep.ts` (505) - Will get smaller when we extract retry logic
- `DiffParser.ts` (466) - Specialized parser, acceptable size
- `ReviewFailureTasksStep.ts` (455) - Specific purpose, OK
- `WorkflowEngine.ts` (445) - Core engine, acceptable

## Strategy

1. **Do repository.ts NOW** (biggest git operations file)
2. **Then fileops.ts** (file operations used everywhere)
3. **Then LocalTransport.ts** (if we have time)
4. **Save workflow steps for later** (more complex, need more planning)

## Success Criteria

- ✅ All refactored files under 400 lines
- ✅ All tests still passing
- ✅ No breaking changes
- ✅ Clear separation of concerns
- ✅ Reusable extracted components
