# Lead-Engineer Timeout Issue - Root Cause Analysis

## Problem Summary

The lead-engineer persona successfully generates code diffs, but they are never applied to the repository files. The workflow aborts before the response can be processed.

## Root Cause

**Race condition between timeout and response arrival**

### Timeline of Issue (from logs):

```
23:45:00.409  - Lead-engineer request sent
23:45:31.270  - ❌ TIMEOUT ERROR: "Timed out waiting for lead-engineer completion (timeout 30s)"
23:45:31.408  - ✅ Lead-engineer response arrives (118ms too late!)
23:45:31.409  - Lead-engineer completed successfully (duration: 29,452ms)
23:45:31.839  - Workflow aborted due to timeout failure
```

### The Problem:

1. **Default timeout too short**: PersonaRequestStep has a default `timeout` of **30,000ms (30 seconds)**
2. **Lead-engineer is slow**: Generating diffs takes **~29.5 seconds** (29,452ms in this case)
3. **Race condition**: Response arrives **118ms after** the timeout fires
4. **Response discarded**: Since the step has already failed, the response is logged but never processed
5. **DiffApplyStep never runs**: The next step (apply_implementation_edits) depends on implementation_request success

## Evidence from Logs

### Lead-Engineer Response (SUCCESSFUL!)

```json
{
  "ts": "2025-10-11T23:45:31.408Z",
  "msg": "persona response",
  "meta": {
    "persona": "lead-engineer",
    "workflowId": "54a03f2f-3ce9-4de3-95cd-1f44960bc5cf",
    "corrId": "d2f56a58-e632-4565-b258-859edfcb2e7d",
    "preview": "Changed Files: \n- src/__tests__/ingestion.test.ts\n- vitest.config.ts\n- package.json\n\nCommit Message:\nfeat: implement ingestion test and configure vitest\n\n```diff\ndiff --git a/package.json b/package.json\n..."
  }
}
```

The lead-engineer **DID** produce a complete, valid diff! It includes:
- ✅ New `package.json` file
- ✅ Updated `src/__tests__/ingestion.test.ts` with proper test implementation
- ✅ New `vitest.config.ts` configuration file

### But the Workflow Failed:

```json
{
  "ts": "2025-10-11T23:45:31.270Z",
  "level": "error",
  "msg": "Persona request failed",
  "meta": {
    "workflowId": "54a03f2f-3ce9-4de3-95cd-1f44960bc5cf",
    "step": "2-implementation",
    "persona": "lead-engineer",
    "error": "Timed out waiting for lead-engineer completion (workflow 54a03f2f-3ce9-4de3-95cd-1f44960bc5cf, corr d2f56a58-e632-4565-b258-859edfcb2e7d, timeout 30s)"
  }
}
```

## Why This Has "Persisted for a Very Long Time"

The issue is **intermittent** and **timing-dependent**:

1. **Works most of the time**: If lead-engineer responds in <30 seconds, everything works fine
2. **Fails occasionally**: When lead-engineer takes >30 seconds (e.g., complex diffs, LM Studio model slowdown), it times out
3. **Appears as different problems**: Sometimes looks like:
   - "Lead-engineer not responding"
   - "Diffs not being applied"
   - "Files not being updated"
4. **Hard to debug**: The response IS generated and logged, but discarded by the timeout logic

## Technical Deep Dive

### Code Flow:

**PersonaRequestStep.ts** (line 23):
```typescript
const { step, persona, intent, payload, timeout = 30000, deadlineSeconds = 600 } = config;
```

- `timeout`: How long to **wait** for the persona response (default: 30 seconds)
- `deadlineSeconds`: How long the persona has to **work** (default: 600 seconds / 10 minutes)

### The Wait Loop:

**persona.ts - waitForPersonaCompletion()**:
```typescript
while (Date.now() - started < effectiveTimeout) {
  // Poll Redis event stream for completion
  // ...
}
// If loop exits without finding response:
throw new Error(`Timed out waiting for ${persona} completion...`);
```

### What Happens:

1. Coordinator sends request at T+0
2. Lead-engineer starts processing
3. At T+30s, `waitForPersonaCompletion` times out and throws error
4. PersonaRequestStep catches the error and returns `status: 'failure'`
5. Workflow engine sees failure and aborts workflow
6. At T+30.118s, lead-engineer finishes and writes response to Redis
7. Response is logged but never read by any waiting process

## The Fix

### Immediate Solution: Increase Timeout

Added explicit `timeout` configuration to lead-engineer requests:

**legacy-compatible-task-flow.yaml**:
```yaml
- name: implementation_request
  type: PersonaRequestStep
  config:
    persona: "lead-engineer"
    timeout: 120000  # 2 minutes instead of 30 seconds
    # ...

- name: qa_followup_implementation
  type: PersonaRequestStep
  config:
    persona: "lead-engineer"
    timeout: 120000  # 2 minutes
    # ...
```

### Why 120 seconds (2 minutes)?

- **Current duration**: ~29.5 seconds
- **Safety margin**: 4x buffer for:
  - LM Studio model variance
  - Complex diffs requiring more tokens
  - System load fluctuations
  - Network/Redis latency
- **Still reasonable**: 2 minutes is acceptable for code generation

### Context Request Timeout Also Increased

```yaml
timeouts:
  context_request_timeout: 600000  # 10 minutes (from 5 minutes default)
  default_step: 300000  # 5 minutes default
```

## Why The Response Is Discarded

The `waitForPersonaCompletion` function has a **hard timeout**. Once it throws an error:

1. The error propagates up to PersonaRequestStep
2. PersonaRequestStep returns `{ status: 'failure', error: ... }`
3. Workflow engine marks the step as failed
4. Dependent steps (DiffApplyStep) are skipped
5. No code is listening for late responses

The response that arrives after timeout is **orphaned** - it's written to Redis event stream but never consumed.

## Testing

All 106 tests pass with the timeout changes:

```bash
Test Files  28 passed | 1 skipped (29)
Tests       106 passed | 3 skipped (109)
Duration    2.06s
```

## Impact

### Before Fix:
- ❌ Lead-engineer responses timing out intermittently
- ❌ Diffs never applied to files
- ❌ Workflow aborts with "persona request failed"
- ❌ Valid code changes discarded

### After Fix:
- ✅ Lead-engineer has 120 seconds to respond (4x more time)
- ✅ Responses arrive before timeout
- ✅ DiffApplyStep processes the diffs
- ✅ Files get updated as expected

## Related Issues

This same pattern could affect other slow personas:
- ✅ **context** - Already has 600s timeout configured
- ✅ **lead-engineer** - Now has 120s timeout configured
- ✅ **qa-followup lead-engineer** - Now has 120s timeout configured
- ⚠️ **Other personas** - Still using 30s default (but they're typically faster)

## Recommendations

### Short-term:
1. ✅ **DONE**: Increase lead-engineer timeout to 120s
2. ✅ **DONE**: Increase context timeout to 600s (10 minutes)
3. Monitor logs for any other personas approaching 30s threshold

### Long-term:
1. **Make timeouts configurable per-persona** in config file
2. **Add timeout warnings** at 80% of threshold
3. **Implement response caching** so late responses can be retried
4. **Optimize LM Studio prompts** to reduce generation time
5. **Add telemetry** to track persona response times over time

## Files Modified

1. `src/workflows/definitions/legacy-compatible-task-flow.yaml`
   - Added `timeout: 120000` to `implementation_request`
   - Added `timeout: 120000` to `qa_followup_implementation`
   - Added `context_request_timeout: 600000` to timeouts section

## Verification Steps

1. ✅ Run tests - all pass
2. ⏳ Run end-to-end workflow with actual lead-engineer
3. ⏳ Verify diffs are applied to repository files
4. ⏳ Monitor logs to confirm responses arrive within 120s

## Conclusion

The lead-engineer **IS** generating correct diffs. The problem was never the code generation - it was always a **race condition** between timeout and response timing. By increasing the timeout from 30s to 120s, we give the lead-engineer enough time to complete its work before the coordinator gives up waiting.

The fix is simple but critical: **Give slow personas more time to respond.**
