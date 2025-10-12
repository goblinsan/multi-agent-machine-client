# Lead-Engineer Timeout Issue - ACTUAL Root Cause

## Problem Summary

The lead-engineer persona successfully generates code diffs, but they are never applied to the repository files. The workflow times out even though `PERSONA_TIMEOUTS_JSON` is configured with a 600-second timeout for lead-engineer.

## The ACTUAL Root Cause

**PersonaRequestStep was ignoring the env-configured persona timeouts**

### The Bug:

In `PersonaRequestStep.ts` line 23:
```typescript
// BEFORE (BUG):
const { step, persona, intent, payload, timeout = 30000, deadlineSeconds = 600 } = config;
```

The hardcoded default `timeout = 30000` (30 seconds) **overrides** the persona-specific timeouts from `PERSONA_TIMEOUTS_JSON` env variable!

### How Persona Timeouts Should Work:

1. User sets `PERSONA_TIMEOUTS_JSON='{"lead-engineer":600000}'` in `.env`
2. Config loads this into `cfg.personaTimeouts`
3. `personaTimeoutMs(persona)` function checks `PERSONA_TIMEOUT_OVERRIDES[persona]`
4. Returns 600000ms (10 minutes) for lead-engineer

### What Was Actually Happening:

1. PersonaRequestStep defaults `timeout = 30000` when not set in YAML
2. Passes this **explicit** 30s timeout to `waitForPersonaCompletion()`
3. `waitForPersonaCompletion()` uses the explicit value instead of calling `personaTimeoutMs()`
4. Lead-engineer times out at 30s, even though env says 600s

### Timeline from Logs:

```
23:45:00.409  - Lead-engineer request sent
23:45:31.270  - ❌ TIMEOUT at 30s: "Timed out waiting for lead-engineer completion (timeout 30s)"
23:45:31.408  - ✅ Lead-engineer responds with complete diff (118ms too late)
23:45:31.409  - Response completed successfully (29.45 seconds total)
```

**Key observation**: The error says "timeout 30s", NOT "timeout 600s"! This proves the env timeout wasn't being used.

## The Fix

### Change 1: Remove Hardcoded Default

**File**: `src/workflows/steps/PersonaRequestStep.ts`

```typescript
// BEFORE (BUG):
const { step, persona, intent, payload, timeout = 30000, deadlineSeconds = 600 } = config;

// AFTER (FIXED):
const { step, persona, intent, payload, timeout, deadlineSeconds = 600 } = config;
// timeout is now undefined when not set in YAML
```

### Change 2: Better Error Message

```typescript
// BEFORE:
error: new Error(`Persona request timed out after ${timeout}ms`)

// AFTER:
const timeoutInfo = timeout ? `${timeout}ms` : 'persona default timeout';
error: new Error(`Persona request timed out after ${timeoutInfo}`)
```

### Change 3: Document Behavior in YAML

```yaml
- name: implementation_request
  config:
    persona: "lead-engineer"
    # timeout not set - will use persona-specific timeout from PERSONA_TIMEOUTS_JSON env (600s for lead-engineer)
```

## How It Works Now

### Priority Order for Timeouts:

1. **YAML `timeout` (if set)** - Explicit override for specific workflow step
2. **`PERSONA_TIMEOUTS_JSON` env** - Per-persona defaults (e.g., `{"lead-engineer":600000}`)
3. **`CODING_TIMEOUT_MS`** - Default for coding personas (180s)
4. **`DEFAULT_PERSONA_TIMEOUT_MS`** - Fallback (30s)

### Example Flow:

```typescript
// In PersonaRequestStep:
timeout = undefined  // Not set in YAML

// Passed to waitForPersonaCompletion:
waitForPersonaCompletion(redis, "lead-engineer", workflowId, corrId, undefined)

// In waitForPersonaCompletion:
effectiveTimeout = personaTimeoutMs("lead-engineer")
  → checks PERSONA_TIMEOUT_OVERRIDES["lead-engineer"]
  → returns 600000 (from env)
  
// Result: 600 second timeout! ✅
```

## Why This Was Confusing

1. **User configured timeouts correctly** in `.env`
2. **Env was loaded correctly** - visible in `cfg.personaTimeouts`
3. **`personaTimeoutMs()` function works** - returns 600s for lead-engineer
4. **But PersonaRequestStep bypassed it** with hardcoded default

The bug wasn't in the timeout system - it was in the **integration** between PersonaRequestStep and the timeout system.

## Evidence from Your Env

```properties
PERSONA_TIMEOUTS_JSON='{"implementation-planner":120000,"lead-engineer":600000,"tester-qa":600000}'
```

You correctly configured:
- implementation-planner: 120s (2 minutes)
- lead-engineer: 600s (10 minutes) ← This should have been used!
- tester-qa: 600s (10 minutes)

But the logs showed: **"timeout 30s"** ← Proof the env was ignored!

## Testing

All 106 tests pass with the fix:

```bash
Test Files  28 passed | 1 skipped (29)
Tests       106 passed | 3 skipped (109)
Duration    2.02s
```

## Impact

### Before Fix:
- ❌ Env-configured persona timeouts ignored by workflows
- ❌ All PersonaRequestSteps defaulted to 30 seconds
- ❌ Lead-engineer with 600s timeout still timed out at 30s
- ❌ Users had to set explicit `timeout` in every YAML step

### After Fix:
- ✅ PersonaRequestStep respects `PERSONA_TIMEOUTS_JSON` env variable
- ✅ Lead-engineer gets full 600 seconds (10 minutes) to respond
- ✅ Other personas use their configured timeouts
- ✅ YAML `timeout` still available for per-step overrides
- ✅ Clear error messages show which timeout was used

## Why It "Persisted for a Very Long Time"

The bug was **invisible** because:

1. **Env looked correct** - timeouts were set properly
2. **Config was loaded** - no error messages
3. **Function existed** - `personaTimeoutMs()` worked fine
4. **Symptom was timing** - looked like lead-engineer was too slow
5. **Hard to trace** - required checking which value was actually passed to `waitForPersonaCompletion()`

Users would naturally assume their env settings were being used, making this a **configuration bug** rather than a **logic bug**.

## Recommendations

### Immediate:
1. ✅ **DONE**: Remove hardcoded 30s default from PersonaRequestStep
2. ✅ **DONE**: Document timeout behavior in YAML comments
3. Test end-to-end with existing env configuration

### Future:
1. **Add config validation** - Warn if persona timeouts seem too short
2. **Log effective timeout** - Show which timeout is being used (env vs YAML vs default)
3. **Add timeout telemetry** - Track how close personas get to timeout
4. **Consider deprecating YAML timeout** - Encourage env-based configuration

## Files Modified

1. `src/workflows/steps/PersonaRequestStep.ts`
   - Removed `timeout = 30000` default
   - Changed to `timeout` (undefined when not set)
   - Updated error message to show which timeout was used

2. `src/workflows/definitions/legacy-compatible-task-flow.yaml`
   - Added comments documenting timeout behavior
   - Removed explicit timeout settings (rely on env)

## Verification

Your existing env configuration should now work correctly:

```properties
PERSONA_TIMEOUTS_JSON='{"implementation-planner":120000,"lead-engineer":600000,"tester-qa":600000}'
```

- implementation-planner: ✅ 120s timeout
- lead-engineer: ✅ 600s timeout (was being ignored, now fixed!)
- tester-qa: ✅ 600s timeout

The lead-engineer response that took 29.45 seconds will now complete successfully within the 600-second window.

## Conclusion

You were 100% correct - the env timeout **was** configured, and it **should** have been used. The bug was that PersonaRequestStep's hardcoded default was silently overriding your carefully configured timeouts. The fix ensures that env-configured timeouts are respected unless explicitly overridden in YAML.

**TL;DR**: Your env config was right all along. The code was wrong. Now it's fixed. 🎯
