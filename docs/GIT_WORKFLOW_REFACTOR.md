# Git Workflow Architecture Refactoring

**Date:** October 21, 2025  
**Status:** Phase 1 Complete - Branch Management Centralized

## Problem Statement

The original architecture had severe technical debt in git branch management:

1. **Scattered Responsibilities**: Branch operations spread across 4+ files (process.ts, artifacts.ts, fileops.ts, gitUtils.ts)
2. **Hidden Side Effects**: Functions like `applyEditOps()` and `writeArtifacts()` secretly created branches
3. **No Single Source of Truth**: No centralized branch lifecycle management
4. **Broke Distributed Architecture**: Each persona creating random feature branches instead of using the workflow branch
5. **God Object**: process.ts at 1,563 lines doing LLM calls, git operations, file I/O, dashboard updates, etc.

## Root Cause: Context Persona Creating Random Branches

**Symptom**: Context persona was creating branches like `feat/context-${workflow_id}-${corr_id}` 

**Why This Was Wrong**:
- Workflow engine already created milestone branch (e.g., `milestone/foundation-config`)
- All personas should work on the same branch for coordination
- Creating random branches breaks distributed architecture (multiple machines can't coordinate)
- Leads to "git push failed" and "branch doesn't exist" errors

**Call Stack That Revealed The Problem**:
```
process.ts (line 778) - hardcoded random branch name
  ↓ calls writeArtifacts() with branchName parameter
artifacts.ts (line 33) - passes branch to applyEditOps()
  ↓ calls applyEditOps() with branchName
fileops.ts (line 81) - does `git checkout -B ${branch}`
  ↓ creates/switches branches as side effect!
```

## Solution: Centralized GitWorkflowManager

### New Architecture

Created `src/git/workflowManager.ts` with clear separation of concerns:

**Single Responsibility**: Only git operations, no LLM calls, no file I/O mixing

**Key Methods**:
- `ensureBranch()` - Create or checkout branch (called by WorkflowEngine ONCE at start)
- `checkoutBranch()` - Switch branches (explicit, no hidden side effects)
- `commitFiles()` - Stage and commit specific files
- `pushBranch()` - Push to remote
- `getBranchState()` - Query current state (no caching, always fresh)
- `deleteBranch()` - Cleanup after workflow

**Design Principles**:
- Explicit operations (no hidden side effects)
- Stateless (doesn't cache git state)
- Testable (uses existing gitUtils primitives)
- Clear ownership (WorkflowEngine owns branch lifecycle)

### Changes Made

#### 1. WorkflowEngine (`src/workflows/engine/WorkflowEngine.ts`)

**Before**: WorkflowContext created with branch name, but branch never ensured to exist

**After**: 
```typescript
// Ensure the branch exists before starting workflow
// This is THE place where branches are created for workflows
logger.info('Ensuring workflow branch exists', { branch, repoRoot, workflowId });
await gitWorkflowManager.ensureBranch({
  repoRoot,
  branchName: branch,
  baseBranch: 'main'
});

const context = new WorkflowContext(...);
```

**Impact**: Branch created ONCE at workflow start, passed to all personas

#### 2. fileops.ts (`applyEditOps()`)

**Before**:
```typescript
await runGit(["checkout", "-B", branch], { cwd: repoRoot });
```

**After**:
```typescript
// NOTE: Caller must ensure they are on the correct branch before calling this function.
// This function only applies file edits - it does not manage git branches.
// Branch creation/checkout is now centralized in GitWorkflowManager.
```

**Impact**: Function does what its name says - applies edits, doesn't manage branches

#### 3. artifacts.ts (`writeArtifacts()`)

**Before**: Required `branchName` parameter, passed it to `applyEditOps()` which created branches

**After**: Removed `branchName` parameter entirely. Caller must be on correct branch.

```typescript
/**
 * Write context artifacts to repository
 * 
 * IMPORTANT: Caller must ensure they are on the correct branch before calling.
 * This function does not manage git branches - it only writes files and commits.
 */
export async function writeArtifacts(options: {
  repoRoot: string;
  artifacts: Artifacts;
  apply: boolean;
  commitMessage: string;
  forceCommit?: boolean;
}) {
```

**Impact**: Clear contract - caller manages git state, this just writes files

#### 4. process.ts (Context Persona)

**Before**:
```typescript
await writeArtifacts({
  branchName: 'feat/context-${workflow_id}-${corr_id}',  // WRONG!
  ...
});
```

**After**:
```typescript
await writeArtifacts({
  // branchName removed - caller already on workflow branch
  ...
});
```

**Impact**: Context persona uses workflow branch (milestone/foundation-config), not random branches

#### 5. Test Helpers

**Before**: Mock for `fetchProjectNextAction()` (function that was deleted)

**After**: Removed mock - function doesn't exist

## Benefits

### 1. Clear Ownership
- **WorkflowEngine**: Creates branch at start, cleans up at end
- **Personas**: Work on provided branch, never create branches
- **GitWorkflowManager**: Centralized authority for all git operations

### 2. No Hidden Side Effects
- `applyEditOps()` only applies edits
- `writeArtifacts()` only writes files
- `ensureBranch()` explicitly creates branches
- Each function does what its name says

### 3. Distributed Architecture Support
- All workers use same milestone branch
- No race conditions from creating random branches
- Clear branch lifecycle (create → use → cleanup)

### 4. Testability
- GitWorkflowManager uses existing gitUtils primitives
- Can mock at GitWorkflowManager level
- Clear boundaries between concerns

### 5. Maintainability
- Easy to understand where branches are created (one place)
- Easy to debug git issues (check GitWorkflowManager)
- Easy to extend (add new operations to GitWorkflowManager)

## Remaining Work

### Phase 2: Extract Context Scanner (Not Started)
- Move context scanning logic (lines 600-650 in process.ts) to `src/git/contextScanner.ts`
- Separate persona processing from context scanning concern
- Reduces process.ts size

### Phase 3: Extract Persona Request Handler (Not Started)
- Extract LLM interaction logic into separate class
- process.ts becomes thin orchestrator
- Addresses god object pattern

### Phase 4: Update Test Suite (Not Started)
- Update tests to use GitWorkflowManager
- Remove scattered branch creation in test helpers
- Ensure test isolation

### Phase 5: End-to-End Verification (Not Started)
- Run full workflow test
- Verify coordinator creates branch
- Verify personas work on correct branch
- Verify no random feature branches created

## Architectural Principles Applied

1. **Single Responsibility Principle**: Each module has one reason to change
   - GitWorkflowManager: Git operations
   - WorkflowEngine: Workflow execution
   - Personas: Business logic for their role

2. **Separation of Concerns**: Clear boundaries between modules
   - Git operations separated from file I/O
   - Branch management separated from artifact writing
   - Workflow lifecycle separated from persona execution

3. **Dependency Inversion**: High-level modules don't depend on low-level details
   - WorkflowEngine depends on GitWorkflowManager interface
   - GitWorkflowManager depends on gitUtils primitives
   - No circular dependencies

4. **Open/Closed Principle**: Open for extension, closed for modification
   - Can add new git operations to GitWorkflowManager
   - Can add new workflow steps without changing engine
   - Can add new personas without changing process.ts (once refactored)

5. **Explicit over Implicit**: No hidden side effects
   - Branch creation is explicit (`ensureBranch()`)
   - Commits are explicit (`commitFiles()`)
   - Checkout is explicit (`checkoutBranch()`)

## Migration Path for Future Changes

When adding new git operations:

1. **Add to GitWorkflowManager first** - Define the operation clearly
2. **Use existing gitUtils primitives** - Don't duplicate low-level code
3. **Document ownership** - Who calls this? When? Why?
4. **Test in isolation** - Mock gitUtils, test GitWorkflowManager logic
5. **Update callers** - Ensure they use new centralized operation

When encountering old git operations scattered in code:

1. **Identify the caller** - Where is this git operation called from?
2. **Move to GitWorkflowManager** - Centralize it
3. **Update callers** - Use GitWorkflowManager method
4. **Delete old code** - We have git history, be aggressive

## Lessons Learned

1. **Hidden side effects are poison** - Functions that secretly manage state cause bugs
2. **God objects block progress** - 1,563-line files are impossible to reason about
3. **Distributed architecture requires discipline** - Can't have workers creating random state
4. **Names matter** - `applyEditOps()` shouldn't create branches
5. **Aggressive refactoring is good** - We have git history, delete old code relentlessly

## Verification

### Tests Status
- Test helpers updated (removed `fetchProjectNextAction` mock)
- Compilation errors fixed (removed `branchName` parameter from `writeArtifacts`)
- GitWorkflowManager has no compilation errors
- Full test suite verification pending (Phase 4)

### Next Steps
1. Verify workflow runs end-to-end without errors
2. Monitor for "git push failed" or "branch doesn't exist" errors
3. Extract context scanner (Phase 2)
4. Extract persona request handler (Phase 3)
5. Complete test suite updates (Phase 4)

## Conclusion

Phase 1 complete: Branch management is now centralized in GitWorkflowManager. The workflow engine creates the branch once at start, all personas work on that branch, and there are no hidden side effects in file operations.

The architecture now supports distributed workflows where multiple machines coordinate on the same milestone branch, and the separation of concerns makes the codebase much easier to understand and maintain.

**Key Achievement**: Fixed the root cause of "context persona creating random feature branches" by centralizing ALL branch operations in a single, explicit manager class.
