# Persona and Branch Naming Fixes

## Issues Fixed

### 1. Incorrect Persona Name Causing Message Timeout
**Problem**: The workflow was sending messages to "contextualizer" but the actual persona listening on Redis is "context". This caused all context requests to timeout after 30 seconds because no worker was listening for "contextualizer" messages.

**Root Cause**:
- `src/personaNames.ts` defines `CONTEXT: 'context'`
- `src/workflows/definitions/legacy-compatible-task-flow.yaml` was sending to `persona: "contextualizer"`
- Worker in `src/worker.ts` listens for messages where `to_persona === persona`
- Message mismatch → no worker picks it up → 30s timeout → workflow fails

**Fix**:
```yaml
# Before:
persona: "contextualizer"

# After:
persona: "context"
```

**Files Changed**:
- `src/workflows/definitions/legacy-compatible-task-flow.yaml` - Line 27

### 2. Hardcoded Branch Name Not Using Milestone from Dashboard
**Problem**: The workflow was always checking out `feat/task` regardless of the milestone information from the dashboard. This meant all tasks went to the same branch instead of being organized by milestone.

**Root Cause**:
- Workflow YAML had hardcoded `newBranch: "feat/task"`
- Dashboard sends `milestone_slug: "project-test-harness-setup"` in task data
- This milestone information was being ignored

**Fix**:
Implemented intelligent branch naming that prioritizes:
1. Explicit `milestone.branch` if set
2. Explicit `task.branch` if set
3. `milestone/{milestone_slug}` if milestone has a slug
4. `feat/{task_slug}` if task has a slug
5. `milestone/{projectSlug}` as fallback

**Files Changed**:
1. `src/workflows/WorkflowCoordinator.ts`:
   - Added `milestone_slug` and `task_slug` to workflow variables
   - Added `computeFeatureBranchName()` method implementing branch naming logic
   - Added `featureBranchName` computed variable

2. `src/workflows/definitions/legacy-compatible-task-flow.yaml`:
   - Changed from: `newBranch: "feat/task"`
   - Changed to: `newBranch: "${featureBranchName}"`

3. `tests/branchSelection.test.ts`:
   - Updated test expectation to match new behavior

## Behavior Changes

### Context Persona Messages
**Before**: 
- Coordinator sends to "contextualizer" → Nobody listening → 30s timeout → Workflow fails

**After**:
- Coordinator sends to "context" → Worker picks it up immediately → Context scan begins

### Branch Naming
**Before**:
```
Task 1 (Milestone: project-test-harness-setup) → feat/task
Task 2 (Milestone: api-endpoints) → feat/task
Task 3 (Milestone: database-setup) → feat/task
```

**After**:
```
Task 1 (Milestone: project-test-harness-setup) → milestone/project-test-harness-setup
Task 2 (Milestone: api-endpoints) → milestone/api-endpoints  
Task 3 (Milestone: database-setup) → milestone/database-setup
```

## Testing

All 106 tests pass:
```bash
npm test
# Test Files  28 passed | 1 skipped (29)
# Tests  106 passed | 3 skipped (109)
```

## What This Fixes

### Issue 1: Double-Send Requirement
**Symptom**: Had to send coordinator request twice before worker picked it up

**Root Cause**: Not actually a Redis timing issue - it was the persona name mismatch!
- First send: Worker picked up coordination message, started workflow, sent "contextualizer" message
- "contextualizer" message timed out (30s)
- Workflow failed
- Second send: Same thing happened
- Third send: Finally got lucky or user thought it worked

**Fix**: With correct persona name "context", the message is picked up on first try.

### Issue 2: Contextualizer Machine Never Received Message
**Symptom**: Listener on contextualizer machine never received message

**Root Cause**: The machine was listening for `to_persona: "context"` but workflow sent `to_persona: "contextualizer"`

**Fix**: Messages now go to correct persona name "context"

### Issue 3: Wrong Branch Name (feat/task Instead of Milestone-Based)
**Symptom**: Workflow checked out "feat/task" ignoring milestone information

**Root Cause**: Hardcoded branch name in YAML, milestone data from dashboard was ignored

**Fix**: Dynamic branch naming based on milestone_slug from dashboard

## How to Verify the Fix

### Test 1: Single Send Should Work
```bash
# Clean state
npm run coordinator -- --drain-only

# Start worker on machine 1
npm run dev

# Send coordinator message ONCE
npm run coordinator <project_id>

# Expected: Context scan should start immediately, no timeout
```

### Test 2: Check Branch Name in Logs
Look for log entry with actual milestone slug:
```json
{
  "level": "info",
  "msg": "Checking out branch from base",
  "meta": {
    "baseBranch": "main",
    "newBranch": "milestone/project-test-harness-setup",  // <-- Should match dashboard milestone
    "workflowId": "..."
  }
}
```

### Test 3: Verify Context Persona Receives Message
On the machine running context persona:
```bash
# Check logs for processing
grep "processing request" machine-client.log | grep "context"

# Should see:
{"persona":"context","workflowId":"...","intent":"context_gathering"}
```

## Migration Notes

**No action required** - changes are backward compatible:
- Old workflows without milestone data will use fallback: `milestone/{projectSlug}`
- Workers already listen for "context" persona
- All tests pass

## Related Files

### Persona Definitions
- `src/personaNames.ts` - Defines all persona constants
- `src/worker.ts` - Worker matches messages to personas
- `src/config.ts` - ALLOWED_PERSONAS configuration

### Branch Naming
- `src/branchUtils.ts` - Original branch naming logic (reference)
- `src/workflows/WorkflowCoordinator.ts` - New implementation in workflow context
- `src/workflows/steps/GitOperationStep.ts` - Executes git checkout with resolved variables

### Workflow Definitions
- `src/workflows/definitions/legacy-compatible-task-flow.yaml` - Main task workflow
- `src/workflows/definitions/*.yaml` - Other workflows (may need similar fixes)

## Next Steps

1. **Verify in production**: Send a single coordinator message and confirm:
   - Context scan starts immediately
   - Branch name matches milestone slug from dashboard
   
2. **Check other workflows**: Review other `.yaml` workflow files for:
   - Any references to "contextualizer" (should be "context")
   - Any hardcoded branch names (should use `${featureBranchName}`)

3. **Monitor logs**: Watch for:
   - No more "Timed out waiting for contextualizer completion" errors
   - Branch names matching milestone slugs: `milestone/your-milestone-slug`
   
4. **Dashboard verification**: Ensure dashboard is sending `milestone_slug` field in task data

## Technical Details

### Persona Name Resolution
The persona system works via exact string matching:
```typescript
// Worker checks incoming message
if (msg.to_persona !== persona) { 
  await r.xAck(...); // Not for me, skip
  return; 
}

// Only processes if exact match
processOne(r, persona, entryId, fields);
```

Any typo or mismatch means the message is never processed.

### Variable Substitution in Workflows
The workflow engine supports `${variableName}` syntax:
```yaml
config:
  newBranch: "${featureBranchName}"  # Resolved from context variables
```

The `GitOperationStep` calls `resolveVariable()` which:
1. Checks if value starts with `${` and ends with `}`
2. Extracts variable name
3. Looks up in workflow context
4. Returns resolved value

### Branch Naming Priority
```
1. milestone.branch (explicit)
2. task.branch (explicit)
3. milestone/{milestone_slug} (from dashboard)
4. feat/{task_slug} (task-specific)
5. milestone/{projectSlug} (fallback)
```

This ensures:
- Manual overrides always work
- Dashboard milestones are respected
- Sensible fallbacks for edge cases
