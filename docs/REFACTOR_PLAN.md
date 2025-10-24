# Refactor Plan - Large File Cleanup

**Goal**: No source files over 500 lines. Focus on reuse and maintainability.

## Current State (8 files > 500 lines)

1. **BulkTaskCreationStep.ts** - 1,070 lines
2. **gitUtils.ts** - 972 lines
3. **WorkflowCoordinator.ts** - 928 lines
4. **WorkflowEngine.ts** - 865 lines
5. **TaskCreationStep.ts** - 707 lines
6. **QAAnalysisStep.ts** - 598 lines
7. **PMDecisionParserStep.ts** - 524 lines
8. **dashboard.ts** - 509 lines

---

## Refactor Strategy

### Phase 1: Extract Utilities

#### 1.1 BulkTaskCreationStep.ts (1,070 → ~400 lines)

**Extract to:**
- `src/workflows/steps/helpers/TaskPriorityCalculator.ts` (~150 lines)
- `src/workflows/steps/helpers/TaskDuplicateDetector.ts` (~150 lines)
- `src/workflows/steps/helpers/TaskRouter.ts` (~100 lines)

**Remaining**: Core step orchestration (~400 lines)

#### 1.2 gitUtils.ts (972 → ~300 lines)

**Extract to:**
- `src/git/repository.ts` (~250 lines)
- `src/git/commits.ts` (~250 lines)
- `src/git/queries.ts` (~200 lines)

**Remaining**: Barrel export (~50 lines)

#### 1.3 WorkflowCoordinator.ts (928 → ~400 lines)

**Extract to:**
- `src/workflows/coordinator/TaskFetcher.ts` (~200 lines)
- `src/workflows/coordinator/WorkflowSelector.ts` (~150 lines)

**Remaining**: Core coordinator loop (~400 lines)

---

### Phase 2: Consolidate & Extract

#### 2.1 WorkflowEngine.ts (865 → ~400 lines)

**Extract to:**
- `src/workflows/engine/StepRegistry.ts` (~200 lines)
- `src/workflows/engine/DependencyResolver.ts` (~150 lines)

**Remaining**: Core execution engine (~400 lines)

#### 2.2 TaskCreationStep.ts (707 lines) - REVIEW

**Analysis needed**: Is this superseded by BulkTaskCreationStep?
- If yes: DELETE
- If no: Extract shared logic

#### 2.3 QAAnalysisStep.ts (598 → ~300 lines)

**Extract to:**
- `src/workflows/steps/helpers/QAFailureCategorizor.ts` (~150 lines)
- `src/workflows/steps/helpers/QAReportGenerator.ts` (~150 lines)

**Remaining**: Core analysis step (~300 lines)

#### 2.4 PMDecisionParserStep.ts (524 → ~300 lines)

**Extract to:**
- `src/workflows/steps/helpers/PMDecisionValidator.ts` (~150 lines)
- `src/workflows/steps/helpers/PMDecisionParser.ts` (~150 lines)

**Remaining**: Core parser step (~300 lines)

---

### Phase 3: Finalize

#### 3.1 dashboard.ts (509 → ~300 lines)

**Refactor to:**
- `src/services/DashboardClient.ts` (~300 lines class-based)
- `dashboard.ts` (~50 lines barrel export)

---

## Implementation Timeline

**Week 1**: gitUtils, BulkTaskCreationStep, WorkflowCoordinator  
**Week 2**: WorkflowEngine, QAAnalysisStep, PMDecisionParserStep  
**Week 3**: TaskCreationStep analysis, dashboard refactor, testing

---

## Success Criteria

- No source files over 500 lines
- All tests pass
- TypeScript compilation clean
- Clear module boundaries

---

**Current:** 8 files > 500 lines (~6,173 lines total)  
**Target:** 0 files > 500 lines (~6,000 lines in new modules)  
**New Modules:** ~15-20 helper/service files

*Created: October 23, 2025*
