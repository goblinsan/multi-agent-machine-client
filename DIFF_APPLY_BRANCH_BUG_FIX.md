# DiffApplyStep Branch Bug Fix

**Issue**: Lead-engineer diffs were being successfully applied to files, but git reported "commit skipped: no changes".

## Root Cause

The `DiffApplyStep` was applying diffs to the **wrong branch**.

### The Problem Flow

1. **GitOperationStep** checks out feature branch `milestone/project-test-harness-setup` and updates the branch variable:
   ```typescript
   context.setVariable('branch', newBranch);
   ```

2. **DiffApplyStep** applies diffs but uses the **readonly constructor property**:
   ```typescript
   branchName: context.branch,  // ❌ This is always "main" (initial value)
   ```

3. **Result**: Diffs applied to `main` branch, but subsequent commit step tried to commit on the feature branch where there were no changes.

### Evidence from Logs

```
"apply_implementation_edits": {
  "branch": "main"  // ❌ Wrong! Should be milestone/project-test-harness-setup
}

"commit_implementation": {
  "branch": "milestone/project-test-harness-setup"  // ✅ Correct branch
  "reason": "no_changes"  // ❌ Because changes were on main
}
```

## The Fix

Changed `DiffApplyStep.ts` line 108-122 to use `context.getVariable('branch')`:

```typescript
// BEFORE (BUG):
branchName: context.branch,

// AFTER (FIXED):
const currentBranch = context.getVariable('branch') || context.branch;
// ...
branchName: currentBranch,
```

This matches the pattern already used in `PersonaRequestStep.ts` which was fixed earlier.

## Why This Happened

The `WorkflowContext` class has both:
- **Readonly property**: `public readonly branch: string` (set in constructor, never changes)
- **Variable system**: `setVariable('branch', ...)` and `getVariable('branch')` (dynamic updates)

When `GitOperationStep` creates a new branch, it updates the **variable**, but the **readonly property** stays at its initial value (usually "main").

Components must use `getVariable('branch')` to get the **current** branch, not `context.branch`.

## Related Fixes

This is the **third** instance of this bug:
1. ✅ **PersonaRequestStep** - Fixed in previous session (used `context.branch` instead of `getVariable('branch')`)
2. ✅ **DiffApplyStep** - Fixed in this session (line 125)
3. ⚠️ **Other steps?** - Need audit to ensure all steps use `getVariable('branch')`

## Testing

All tests pass (106 passed, 3 skipped).

## Next Steps

1. ✅ Test end-to-end workflow to confirm diffs are applied to correct branch
2. 🔍 Audit all workflow steps for similar `context.branch` vs `getVariable('branch')` issues
3. 📝 Consider deprecating `context.branch` readonly property to prevent future bugs
4. 🛠️ Add validation that diffs are applied to the same branch as the commit step uses
