# Workflow Reliability Issues - Diagnostic Report

## Issues Identified

### 1. Plan Evaluator Not Running
**Status:** NEEDS INVESTIGATION  
**Location:** `src/workflows/steps/PlanningLoopStep.ts`

**Evidence:**
- PlanningLoopStep code shows evaluator SHOULD be called after planner (line 135-200)
- Need to check actual workflow logs to see if evaluator requests are being sent
- Possible causes:
  - Planning loop exiting early (max iterations = 1?)
  - Evaluator request timing out silently
  - Evaluator response not being processed

**Diagnostic Steps:**
1. Check workflow logs for "Making evaluation request" messages
2. Verify `maxIterations` is not set to 1 in workflow YAML
3. Check if evaluator persona has model mapping
4. Verify evaluator timeout settings

### 2. QA Status Parsing Too Liberal - FALSE POSITIVES
**Status:** **CONFIRMED BUG**  
**Location:** `src/agents/persona.ts` lines 140-213

**Root Cause:**
The `interpretPersonaStatus()` function uses overly broad keyword matching that scans the ENTIRE response text:

```typescript
// Fourth priority (fallback): Scan entire text for keywords
for (const key of PASS_STATUS_KEYWORDS) {
  if (lower.includes(key)) return { status: "pass", details: raw, raw };
}
```

**Problem Scenarios:**

1. **Test output contains "ok" anywhere:**
   ```
   Test failed but the initial connection was ok
   → Interpreted as PASS because "ok" found
   ```

2. **Test output describes success in narrative:**
   ```
   If this were to succeed, we would see...
   → Interpreted as PASS because "succeed" found
   ```

3. **Empty or minimal test output:**
   ```
   No tests run, output: "Process completed successfully"
   → Interpreted as PASS because "successfully" matches "success"
   ```

**Impact:** High - QA failures being misclassified as passes, allowing broken code to proceed

### 3. QA Pass Continuing to Planning Loop
**Status:** NEEDS INVESTIGATION  
**Location:** Workflow definition and QA step configuration

**Observed Behavior:**
- QA returns PASS status
- Workflow continues to planning loop instead of code review

**Possible Causes:**
1. `qa_request_status` variable not being set correctly
2. Workflow condition `${qa_request_status} == 'pass'` not evaluating properly
3. QA iteration loop step has incorrect dependency/condition logic
4. Variable name mismatch between step outputs and conditions

**Diagnostic Steps:**
1. Check actual `qa_request_status` value in context after QA completes
2. Verify workflow condition syntax in YAML
3. Check if QA iteration loop is running when it shouldn't
4. Review step dependency tree

## Proposed Fixes

### Fix 1: Stricter QA Status Parsing

**Change:** Make status interpretation require explicit JSON structure, not just keyword scanning

```typescript
export function interpretPersonaStatus(output: string | undefined): PersonaStatusInfo {
  const raw = (output || "").trim();
  let json = extractJsonPayloadFromText(raw);
  
  // PRIORITY 1: Explicit JSON status field (REQUIRED)
  if (json && typeof json.status === "string") {
    const statusLower = json.status.trim().toLowerCase();
    let normalized: "pass" | "fail" | "unknown" = "unknown";
    if (PASS_STATUS_KEYWORDS.has(statusLower)) normalized = "pass";
    else if (FAIL_STATUS_KEYWORDS.has(statusLower)) normalized = "fail";
    return { status: normalized, details: JSON.stringify(json), raw, payload: json };
  }
  
  // PRIORITY 2: Check nested output field
  if (json && typeof json.output === "string") {
    const innerJson = extractJsonPayloadFromText(json.output);
    if (innerJson && typeof innerJson.status === "string") {
      const statusLower = innerJson.status.trim().toLowerCase();
      let normalized: "pass" | "fail" | "unknown" = "unknown";
      if (PASS_STATUS_KEYWORDS.has(statusLower)) normalized = "pass";
      else if (FAIL_STATUS_KEYWORDS.has(statusLower)) normalized = "fail";
      return { status: normalized, details: json.output, raw, payload: innerJson };
    }
  }
  
  // PRIORITY 3: Look for explicit status declarations at START of response
  // Only check first 500 characters to avoid false positives from narrative text
  const firstPart = raw.substring(0, 500).toLowerCase();
  const statusLineMatch = firstPart.match(/^(?:status|result):\s*(pass|fail|success|error)/m);
  if (statusLineMatch) {
    const status = statusLineMatch[1];
    const normalized = PASS_STATUS_KEYWORDS.has(status) ? "pass" : 
                       FAIL_STATUS_KEYWORDS.has(status) ? "fail" : "unknown";
    return { status: normalized, details: raw, raw, payload: json };
  }
  
  // DEFAULT: No clear status found - return UNKNOWN (fail-safe)
  // DO NOT scan entire text for keywords - too error-prone
  logger.warn('QA status unclear - no explicit status found', {
    rawPreview: raw.substring(0, 200),
    hasJson: !!json
  });
  
  return { status: "unknown", details: raw, raw, payload: json };
}
```

**Benefits:**
- Requires explicit status declaration
- Prevents false positives from narrative text
- Unknown status forces manual review instead of false pass

### Fix 2: Enhanced Logging for Workflow Transitions

**Add to each workflow step:**

```typescript
logger.info('Workflow step transition', {
  workflowId: context.workflowId,
  currentStep: this.config.name,
  stepStatus: result.status,
  outputs: Object.keys(result.outputs || {}),
  contextVariables: {
    qa_request_status: context.getVariable('qa_request_status'),
    planning_loop_status: context.getVariable('planning_loop_status'),
    // ... other critical variables
  },
  nextStepDecision: {
    condition: this.config.condition,
    willExecute: evaluateCondition(this.config.condition, context)
  }
});
```

### Fix 3: QA Result Validation

**Add validation step after QA:**

```typescript
export class QAResultValidationStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const qaResult = context.getVariable('qa_request_result');
    const qaStatus = context.getVariable('qa_request_status');
    
    // Validate QA result has expected structure
    if (!qaResult) {
      logger.error('QA result missing', { workflowId: context.workflowId });
      context.setVariable('qa_request_status', 'unknown');
      return { status: 'failure', error: new Error('QA result missing') };
    }
    
    // Check if test output exists
    const hasTestOutput = qaResult.test_output || qaResult.output || qaResult.raw;
    if (!hasTestOutput) {
      logger.warn('QA has no test output - marking as unknown', {
        workflowId: context.workflowId,
        qaStatus
      });
      context.setVariable('qa_request_status', 'unknown');
    }
    
    // Verify status matches test results
    if (qaStatus === 'pass') {
      // Check for test failure indicators even if status says pass
      const output = String(hasTestOutput).toLowerCase();
      if (output.includes('test failed') || output.includes('assertion failed') || 
          output.includes('error:') || output.match(/\d+ failed/)) {
        logger.error('QA status PASS but output contains failure indicators', {
          workflowId: context.workflowId,
          outputPreview: String(hasTestOutput).substring(0, 500)
        });
        context.setVariable('qa_request_status', 'fail');
      }
    }
    
    return { status: 'success', data: { validated: true } };
  }
}
```

## Immediate Action Items

1. **[HIGH PRIORITY]** Fix `interpretPersonaStatus()` to require explicit status declarations
2. **[HIGH PRIORITY]** Add QA result validation step to workflow
3. **[MEDIUM]** Add comprehensive workflow transition logging
4. **[MEDIUM]** Investigate plan-evaluator execution logs
5. **[MEDIUM]** Verify workflow condition evaluation logic
6. **[LOW]** Add workflow state tests to prevent regressions

## Testing Strategy

After fixes, create tests that verify:
1. QA response with "ok" in narrative text → does NOT parse as PASS
2. QA response with no explicit status → parses as UNKNOWN
3. QA response with test failures but success narrative → parses as FAIL
4. Plan evaluator runs after planner completes
5. QA PASS leads to code review, not planning loop
6. QA FAIL leads to QA iteration loop
7. Workflow conditions properly evaluate context variables

## Related Files

- `src/agents/persona.ts` - Status interpretation logic (needs fix)
- `src/workflows/steps/PersonaRequestStep.ts` - Sets status variables
- `src/workflows/steps/PlanningLoopStep.ts` - Plan evaluation loop
- `src/workflows/definitions/legacy-compatible-task-flow.yaml` - Workflow definition
- `src/workflows/engine/WorkflowContext.ts` - Context variable management
