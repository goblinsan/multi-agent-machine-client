# Workflow Reliability Fix - Status Parsing

## Problem Fixed

**Issue:** QA status parsing was too liberal, causing false positives where test failures were marked as PASS.

**Root Cause:** The `interpretPersonaStatus()` function was scanning the ENTIRE response text for keywords like "pass", "ok", "success". This meant any mention of these words in narrative text would be interpreted as a PASS status.

**Examples of False Positives:**
```
"Test failed but the initial connection was ok"
→ Interpreted as PASS (found "ok")

"If this were to succeed, we would see..."
→ Interpreted as PASS (found "succeed")

"Process completed successfully" (but no actual test output)
→ Interpreted as PASS (found "successfully")
```

## Solution Implemented

Updated `src/agents/persona.ts` `interpretPersonaStatus()` function to use **strict, priority-based parsing**:

### Priority 1: Explicit JSON Status Field (REQUIRED)
```json
{ "status": "pass" }
{ "status": "fail", "details": "..." }
```

### Priority 2: Nested Output Field (LM Studio Wrapper)
```json
{
  "output": "{ \"status\": \"pass\" }\\n\\nThe tests passed.",
  "model": "qwen3-coder-30b"
}
```

### Priority 3: Status Declaration at Start (First 500 chars only)
```
Status: pass
Result: fail
```

### Priority 4: JSON-like Declarations at Start (First 500 chars only)
```
Some text...
{"status": "pass"}
More text...
```

### Default: Return "unknown" (Fail-Safe)
If no explicit status found, return "unknown" instead of guessing from narrative text.

## Key Changes

**Before:**
```typescript
// Scan ENTIRE text for keywords - DANGEROUS
for (const key of PASS_STATUS_KEYWORDS) {
  if (lower.includes(key)) return { status: "pass", details: raw, raw };
}
```

**After:**
```typescript
// Only check first 500 chars for explicit declarations
const firstPart = raw.substring(0, 500);
const statusLineMatch = firstPart.match(/^(?:status|result):\s*(pass|fail|...)/im);
if (statusLineMatch) {
  // Found explicit declaration
  return { status: normalized, details: raw, raw, payload: json };
}

// DEFAULT: No clear status - return unknown (fail-safe)
logger.warn('Persona status unclear - no explicit status declaration found');
return { status: "unknown", details: raw, raw, payload: json };
```

## Benefits

1. **Prevents False Positives:** Narrative text mentioning "ok" or "success" won't be misinterpreted
2. **Fail-Safe Default:** Unknown status forces manual review instead of false approval
3. **Explicit Requirements:** Encourages personas to return proper JSON with status fields
4. **Focused Parsing:** Only checks beginning of response for status declarations
5. **Better Logging:** Warns when status is unclear, helping diagnose issues

## Test Results

- All 195 tests passing
- Updated existing tests to match new strict behavior
- Tests now verify that narrative text without explicit status returns "unknown"

## Recommendations for Personas

All persona prompts should instruct the LLM to return status in one of these formats:

### Recommended Format (JSON):
```json
{
  "status": "pass",
  "details": "All tests passed successfully",
  "test_output": "..."
}
```

### Alternative Format (Status Line):
```
Status: pass

Details: All tests passed successfully
...
```

### LM Studio Wrapper Format:
```json
{
  "output": "{\"status\": \"pass\"}\\n\\nAll tests passed",
  "model": "...",
  "duration_ms": 1000
}
```

## Next Steps

The following issues still need investigation:

1. **Plan-evaluator not running** - Need to check workflow logs
2. **QA pass continuing to planning loop** - Need to verify workflow routing logic
3. **Add workflow state logging** - Will help diagnose future routing issues

See `docs/WORKFLOW_RELIABILITY_ISSUES.md` for full diagnostic report.

## Files Changed

- `src/agents/persona.ts` - Updated `interpretPersonaStatus()` function
- `tests/interpretPersonaStatus.test.ts` - Updated tests to match new behavior
- `docs/WORKFLOW_RELIABILITY_ISSUES.md` - Comprehensive diagnostic report
