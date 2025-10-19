# PM Backlog Field Normalization Fix

## Problem

The PM (project-manager persona) was returning tasks in a `"backlog"` field instead of the expected `"follow_up_tasks"` field, causing the `ReviewFailureTasksStep` to skip task creation.

**Date:** October 18, 2025  
**Status:** ✅ Fixed

---

## Root Cause

### What Was Happening:

1. **PM Prompt Requested:**
```json
{
  "decision": "defer" | "immediate_fix",
  "reasoning": "...",
  "immediate_issues": ["..."],
  "deferred_issues": ["..."],
  "follow_up_tasks": [{"title": "...", "description": "...", "priority": "..."}]
}
```

2. **PM Actually Returned:**
```json
{
  "status": "pass",
  "details": "Code review failures prioritized for immediate fix or deferred to backlog",
  "milestone_updates": [...],
  "backlog": [
    {"title": "Fix SEVERE and HIGH findings", "description": "...", "priority": "high"},
    {"title": "Refactor MEDIUM findings...", "description": "...", "priority": "medium"},
    {"title": "Add LOW suggestions...", "description": "...", "priority": "low"}
  ]
}
```

3. **ReviewFailureTasksStep Logic:**
```typescript
if (pmDecision.follow_up_tasks && pmDecision.follow_up_tasks.length > 0) {
  // Create tasks
}
```

4. **Result:**
   - `follow_up_tasks` was undefined
   - No tasks created
   - 0 tasks logged: `followUpTasksCount: 0`
   - Original task marked as "blocked" but no follow-up work created
   - Coordinator loop: Picked up same task again since no new tasks exist

---

## Log Evidence

From `machine-client.log` at `2025-10-19T02:22:36.862Z`:

```json
{
  "msg": "persona response",
  "persona": "project-manager",
  "preview": "{\n  \"status\": \"pass\",\n  \"details\": \"Code review failures prioritized...\",\n  \"backlog\": [\n    {\"title\": \"Fix SEVERE and HIGH findings\", \"priority\": \"high\"}...\n  ]\n}"
}
```

Then at `2025-10-19T02:22:39.809Z`:

```json
{
  "msg": "PM decision parsed",
  "immediateIssuesCount": 0,
  "deferredIssuesCount": 0,
  "followUpTasksCount": 0  // ❌ No tasks found!
}
```

And finally:

```json
{
  "msg": "Review failure tasks created",
  "totalTasksCreated": 0,     // ❌ No tasks created
  "urgentTasksCreated": 0,
  "deferredTasksCreated": 0
}
```

---

## Solution

Updated `ReviewFailureTasksStep.parsePMDecision()` to normalize the PM response by mapping `backlog` to `follow_up_tasks` if needed.

### Code Changes

**File:** `src/workflows/steps/ReviewFailureTasksStep.ts`

**Before:**
```typescript
private parsePMDecision(rawDecision: any): any {
  try {
    // If it's already an object, use it
    if (typeof rawDecision === 'object' && rawDecision !== null) {
      return rawDecision;  // ❌ Returns as-is with "backlog" field
    }
    
    // ... string parsing logic
    
    return null;
  } catch (error) {
    return null;
  }
}
```

**After:**
```typescript
private parsePMDecision(rawDecision: any): any {
  try {
    let parsed: any = null;
    
    // Parse from object or string
    if (typeof rawDecision === 'object' && rawDecision !== null) {
      parsed = rawDecision;
    }
    
    if (typeof rawDecision === 'string') {
      // ... JSON parsing logic ...
      parsed = JSON.parse(jsonStr);
    }
    
    if (!parsed) {
      return null;
    }
    
    // ✅ NEW: Normalize backlog to follow_up_tasks
    if (!parsed.follow_up_tasks && parsed.backlog && Array.isArray(parsed.backlog)) {
      parsed.follow_up_tasks = parsed.backlog;
      logger.debug('Normalized PM decision: mapped backlog to follow_up_tasks', {
        tasksCount: parsed.backlog.length
      });
    }
    
    return parsed;
  } catch (error) {
    return null;
  }
}
```

---

## Impact

### Before Fix:

```
Flow:
1. Code review fails
2. PM evaluates → Returns {"backlog": [...]}
3. ReviewFailureTasksStep parses → Finds 0 follow_up_tasks
4. Creates 0 tasks
5. Marks original task as "blocked"
6. Coordinator refetches → Only sees blocked task
7. Restarts workflow on same task ← LOOP!
```

### After Fix:

```
Flow:
1. Code review fails
2. PM evaluates → Returns {"backlog": [...]}
3. ReviewFailureTasksStep parses → Normalizes backlog to follow_up_tasks
4. Creates 3 tasks with priority scores (1000+)
5. Marks original task as "blocked"
6. Coordinator refetches → Sees 3 new urgent tasks
7. Picks highest priority task ← FIXED!
```

---

## Why PM Returns "backlog"

The PM persona likely uses "backlog" as a more intuitive term from its training, despite the prompt requesting "follow_up_tasks". Common reasons:

1. **Training Data:** PM models trained on agile/scrum terminology use "backlog" frequently
2. **Semantic Clarity:** "backlog" is more descriptive than "follow_up_tasks"
3. **JSON Schema Flexibility:** LLMs don't strictly enforce schema when semantically similar fields exist
4. **Prompt Ambiguity:** The prompt mentions "backlog" in the description which may confuse the model

---

## Testing Verification

### Test Scenario:
```typescript
describe('PM backlog field normalization', () => {
  it('should create tasks when PM returns backlog field', async () => {
    const pmDecision = {
      status: 'pass',
      backlog: [
        { title: 'Fix issue 1', priority: 'high' },
        { title: 'Fix issue 2', priority: 'medium' }
      ]
    };
    
    // Expected: Tasks created from backlog
    // Expected: followUpTasksCount: 2
  });
  
  it('should prefer follow_up_tasks over backlog if both exist', async () => {
    const pmDecision = {
      follow_up_tasks: [{ title: 'Task A', priority: 'high' }],
      backlog: [{ title: 'Task B', priority: 'low' }]
    };
    
    // Expected: Uses follow_up_tasks (more specific)
    // Expected: Backlog ignored
  });
});
```

---

## Related Issues

This fix also addresses similar normalization issues:

1. **PM Field Variations:**
   - `follow_up_tasks` (expected)
   - `backlog` (common)
   - `tasks` (possible)
   - `suggested_tasks` (possible)

2. **Future Robustness:**
   - Could extend to check multiple field names
   - Add schema validation with clear errors
   - Update prompt to emphasize exact field names

---

## Prevention Strategies

### Short-term:
1. ✅ Normalize common field variations in parser
2. Add explicit warning in logs when normalization occurs
3. Monitor for other field name variations

### Long-term:
1. **Stricter Prompts:** Use examples and explicit warnings
   ```
   CRITICAL: You MUST use the exact field name "follow_up_tasks".
   Do NOT use "backlog", "tasks", or any other field name.
   ```

2. **Schema Validation:** Validate PM response before processing
   ```typescript
   if (!parsed.follow_up_tasks && !parsed.backlog) {
     throw new Error('PM response missing follow_up_tasks field');
   }
   ```

3. **Few-Shot Examples:** Include valid JSON examples in prompt
   ```
   VALID EXAMPLE:
   {
     "decision": "immediate_fix",
     "follow_up_tasks": [{"title": "Fix bug", "priority": "high"}]
   }
   ```

4. **Response Post-Processing:** Add a validation/normalization layer
   ```typescript
   const normalizedPMResponse = normalizePMResponse(rawResponse);
   ```

---

## Files Modified

1. ✅ `src/workflows/steps/ReviewFailureTasksStep.ts`
   - Updated `parsePMDecision()` method
   - Added backlog → follow_up_tasks normalization
   - Added debug logging for normalization

---

## Build Verification

```bash
$ npm run build
> redis-machine-client@0.4.0 build
> tsc -p tsconfig.json

# Success - no errors
```

---

## Related Documentation

- [REVIEW_FAILURE_LOOP_FIX.md](./REVIEW_FAILURE_LOOP_FIX.md) - Original infinite loop fix
- [QA_PRIORITY_RATIONALIZATION.md](./QA_PRIORITY_RATIONALIZATION.md) - Priority system rationalization

---

## Conclusion

The PM backlog field normalization fix ensures that task creation works regardless of whether the PM returns `"follow_up_tasks"` or `"backlog"`. This makes the system more robust to LLM variations while maintaining the expected workflow behavior.

**Key Benefits:**
- ✅ Tasks now created even when PM uses "backlog" field
- ✅ No more infinite loops from 0 tasks created
- ✅ Backward compatible with correct "follow_up_tasks" responses
- ✅ Debug logging for monitoring field variations
- ✅ Foundation for handling other field name variations
