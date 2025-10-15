# Bug Analysis: Plan Evaluation Status & Task Completion Logic

## Issue 1: Plan Evaluation Shows "pass" but Stage Shows "fail"

### Root Cause
The `interpretPersonaStatus()` function in `src/agents/persona.ts` has a **flawed fallback logic** that causes false negatives.

**Current Logic (Lines 167-185):**
```typescript
export function interpretPersonaStatus(output: string | undefined): PersonaStatusInfo {
  const raw = (output || "").trim();
  const json = extractJsonPayloadFromText(raw);
  
  // ✅ CORRECT: Extract JSON status first
  if (json && typeof json.status === "string") {
    const statusLower = json.status.trim().toLowerCase();
    let normalized: "pass" | "fail" | "unknown" = "unknown";
    if (PASS_STATUS_KEYWORDS.has(statusLower)) normalized = "pass";
    else if (FAIL_STATUS_KEYWORDS.has(statusLower)) normalized = "fail";
    const details = typeof json.details === "string" ? json.details : raw || JSON.stringify(json);
    return { status: normalized, details, raw, payload: json };
  }
  
  // ❌ BUG: Fallback scans ENTIRE response text for keywords
  if (!raw.length) return { status: "unknown", details: raw, raw };
  const lower = raw.toLowerCase();
  
  // FAIL keywords checked FIRST
  for (const key of FAIL_STATUS_KEYWORDS) {
    if (lower.includes(key)) return { status: "fail", details: raw, raw };
  }
  
  // PASS keywords checked second (never reached if "fail" found anywhere)
  for (const key of PASS_STATUS_KEYWORDS) {
    if (lower.includes(key)) return { status: "pass", details, raw };
  }
  
  return { status: "unknown", details: raw, raw, payload: json };
}
```

### The Problem
When the LLM returns:
```json
{ "status": "pass" }

The proposed implementation plan is concrete, actionable, and appropriate for the task.

Here's why:

1. **Clear Steps**: The plan outlines specific steps to be taken...
2. **Specific Files to Modify**: The plan identifies files to modify...
3. **Realistic Acceptance Criteria**: The acceptance criteria are realistic...
4. **Addressing Previous Feedback**: Although no previous feedback is provided, the plan appears to address concerns...

Overall, the plan demonstrates good understanding and provides a foundation for moving forward.
```

The function:
1. ✅ **Correctly extracts** `{ "status": "pass" }` from JSON
2. ✅ **Correctly normalizes** to `"pass"`
3. ✅ **Returns** `{ status: "pass", ... }`

But then in `summarizeEvaluationResult()` (line 313-322 in `PlanningLoopStep.ts`):
```typescript
function summarizeEvaluationResult(event: any) {
  const fields = event.fields ?? {};
  const payload = parseEventResult(fields.result);
  const normalized = interpretPersonaStatus(fields.result);  // Called again!

  return {
    corrId: fields.corr_id,
    status: event.status ?? fields.status ?? normalized.status,
    normalizedStatus: normalized.status,  // ❌ BUG: Wrong value used here
    statusDetails: truncate(normalized.details, 2000),
    payloadPreview: payload ? truncate(payload, 2000) : undefined,
    rawLength: typeof fields.result === 'string' ? fields.result.length : undefined
  };
}
```

Wait, that should work... Let me check the actual log output more carefully:

Looking at line 121 of the logs:
```
"normalizedStatus":"fail"
"statusDetails":"{\"output\":\"{ \\\"status\\\": \\\"pass\\\" }\\n\\nThe proposed..."
```

The **statusDetails** contains the full LLM response wrapped in another JSON object with an `"output"` field!

So the actual structure is:
```json
{
  "output": "{ \"status\": \"pass\" }\n\nThe proposed implementation plan...",
  "model": "qwen3-coder-30b",
  "duration_ms": 13956
}
```

The `interpretPersonaStatus()` function receives this WRAPPED version, and when it looks for JSON, it finds the outer object which has NO "status" field, so it falls back to scanning the entire `"output"` string for keywords... and finds "fail" in the explanatory text!

### Evidence from Logs
**Line 51** (First workflow - SUCCESS):
- `"normalizedStatus":"pass"` ✅
- LLM correctly returned simple JSON

**Lines 121, 142, 163** (Second workflow - FAILURE):
- `"normalizedStatus":"fail"` ❌
- LLM returned wrapped JSON with outer `"output"` field
- Function scans explanatory text, finds word "fail", returns false negative

### Fix Strategy
The function needs to:
1. **Try to extract JSON status** (current behavior)
2. **If no JSON status found**, scan for JSON inside string fields like `"output"`
3. **Only fall back to keyword scanning** if no JSON found anywhere

## Issue 2: QA Test Passed But Task Not Marked Complete

### Root Cause
The workflow definition does not automatically mark tasks as "done" when QA passes. The current `legacy-compatible-task-flow.yaml` has:

```yaml
- name: mark_task_in_review
  type: simple_task_status
  config:
    status: in_review
  depends_on:
    - qa_request
    - qa_iteration_loop
  condition: ${qa_request_status} == 'pass'
```

This marks the task as "in_review" (for code review/security/devops), but there's NO automatic transition to "done" or "completed".

### Expected Behavior
When QA passes:
1. ✅ Task should move to "in_review" status (current)
2. ❌ **Missing**: After review stages complete, task should be marked "done"
3. ❌ **Missing**: If additional work is identified (new tasks suggested), those should be sent to PM for urgency evaluation

### Current Workflow Flow
```
Planning → Implementation → QA → [QA Pass] → Mark In Review → Code Review → Security → DevOps → [END]
                                                                                                    ↓
                                                                                         No "mark_task_done" step!
```

### What Should Happen
According to your requirement:
> "if there are more tasks that need to be completed for this milestone to be completed, then the suggested tasks need to get sent to the PM to evaluate the urgency"

**Option A: Task is complete when reviews pass**
```
QA Pass → Reviews Pass → Mark Task Done → Check for Suggested Tasks → Send to PM if tasks exist
```

**Option B: Task completes only when milestone is done**
```
QA Pass → Reviews Pass → Check Milestone Status → If incomplete: Send remaining tasks to PM
                                                 → If complete: Mark Task & Milestone Done
```

### Missing Steps in Workflow
1. **`mark_task_done` step** - After all review stages complete
2. **Milestone completion check** - Verify all milestone tasks are done
3. **PM urgency evaluation** - Route suggested tasks to PM for prioritization
4. **Conditional completion** - Only mark done if no blocking follow-ups exist

## Recommended Fixes

### Fix 1: interpretPersonaStatus() Function

**File**: `src/agents/persona.ts`
**Lines**: 167-185

```typescript
export function interpretPersonaStatus(output: string | undefined): PersonaStatusInfo {
  const raw = (output || "").trim();
  
  // Try to extract JSON payload
  let json = extractJsonPayloadFromText(raw);
  
  // If JSON found and has status field, use it
  if (json && typeof json.status === "string") {
    const statusLower = json.status.trim().toLowerCase();
    let normalized: "pass" | "fail" | "unknown" = "unknown";
    if (PASS_STATUS_KEYWORDS.has(statusLower)) normalized = "pass";
    else if (FAIL_STATUS_KEYWORDS.has(statusLower)) normalized = "fail";
    const details = typeof json.details === "string" ? json.details : raw || JSON.stringify(json);
    return { status: normalized, details, raw, payload: json };
  }
  
  // NEW: If JSON has "output" field (LM Studio wrapper), try to extract from there
  if (json && typeof json.output === "string") {
    const innerJson = extractJsonPayloadFromText(json.output);
    if (innerJson && typeof innerJson.status === "string") {
      const statusLower = innerJson.status.trim().toLowerCase();
      let normalized: "pass" | "fail" | "unknown" = "unknown";
      if (PASS_STATUS_KEYWORDS.has(statusLower)) normalized = "pass";
      else if (FAIL_STATUS_KEYWORDS.has(statusLower)) normalized = "fail";
      const details = typeof innerJson.details === "string" ? innerJson.details : json.output;
      return { status: normalized, details, raw, payload: innerJson };
    }
  }
  
  // Fallback: scan text for keywords (only if NO JSON status found)
  if (!raw.length) return { status: "unknown", details: raw, raw };
  const lower = raw.toLowerCase();
  
  // Check for explicit JSON-like status declarations first
  const jsonStatusMatch = lower.match(/["\']status["\']\s*:\s*["\'](pass|fail|success|error)["\']/)  if (jsonStatusMatch) {
    const declaredStatus = jsonStatusMatch[1];
    const normalized = PASS_STATUS_KEYWORDS.has(declaredStatus) ? "pass" : 
                       FAIL_STATUS_KEYWORDS.has(declaredStatus) ? "fail" : "unknown";
    return { status: normalized, details: raw, raw };
  }
  
  // IMPORTANT: Only scan for keywords if no structured status found
  // Prioritize PASS over FAIL to avoid false negatives from explanatory text
  for (const key of PASS_STATUS_KEYWORDS) {
    if (lower.includes(key)) return { status: "pass", details: raw, raw };
  }
  for (const key of FAIL_STATUS_KEYWORDS) {
    if (lower.includes(key)) return { status: "fail", details: raw, raw };
  }
  
  return { status: "unknown", details: raw, raw, payload: json };
}
```

**Key Changes**:
1. Check for nested `"output"` field in JSON response
2. Prioritize PASS keywords over FAIL to avoid false negatives
3. Add explicit JSON status pattern matching before keyword fallback

### Fix 2: Add Task Completion Logic

**File**: `src/workflows/definitions/legacy-compatible-task-flow.yaml`

Add after the `devops_request` step:

```yaml
  # NEW: Mark task as done when all review stages complete
  - name: mark_task_done
    type: simple_task_status
    config:
      status: done
    depends_on:
      - code_review_request
      - security_request
      - devops_request
    condition: >
      ${code_review_request_status} == 'pass' AND
      ${security_request_status} == 'pass' AND
      ${devops_request_status} == 'pass'

  # NEW: Check if milestone has remaining tasks
  - name: check_milestone_completion
    type: milestone_status_check
    config:
      check_type: incomplete_tasks
    depends_on:
      - mark_task_done

  # NEW: Send suggested tasks to PM for urgency evaluation
  - name: pm_evaluate_suggestions
    type: persona_request
    config:
      step: "6-pm-evaluate-suggestions"
      persona: project-manager
      intent: evaluate_task_urgency
      payload:
        milestone: ${milestone}
        completed_task: ${task}
        remaining_tasks: ${check_milestone_completion.remaining_tasks}
        suggested_tasks: ${qa_iteration_loop.suggested_tasks}
    depends_on:
      - check_milestone_completion
    condition: ${check_milestone_completion.has_remaining_tasks} == true
```

### Fix 3: Add Milestone Completion Check Step

**New File**: `src/workflows/steps/MilestoneStatusCheckStep.ts`

```typescript
import { WorkflowStep, StepResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { fetchProjectStatusDetails } from '../../dashboard.js';
import { logger } from '../../logger.js';

export class MilestoneStatusCheckStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const milestone = context.getVariable('milestone');
    const projectId = context.getVariable('projectId');
    
    if (!milestone?.id) {
      return {
        status: 'success',
        data: { has_remaining_tasks: false, remaining_tasks: [] }
      };
    }
    
    const projectStatus = await fetchProjectStatusDetails(projectId);
    const milestoneTasks = projectStatus.tasks.filter((t: any) => 
      t.milestone_id === milestone.id
    );
    
    const incompleteTasks = milestoneTasks.filter((t: any) => 
      !['done', 'completed', 'closed', 'cancelled'].includes(t.status.toLowerCase())
    );
    
    logger.info('Milestone completion check', {
      milestoneId: milestone.id,
      totalTasks: milestoneTasks.length,
      incompleteTasks: incompleteTasks.length
    });
    
    return {
      status: 'success',
      outputs: {
        has_remaining_tasks: incompleteTasks.length > 0,
        remaining_tasks: incompleteTasks,
        total_tasks: milestoneTasks.length
      }
    };
  }
}
```

## Testing Plan

### Test 1: Plan Evaluation Status Parsing
```typescript
describe('interpretPersonaStatus - nested output handling', () => {
  it('should extract status from nested output field', () => {
    const response = JSON.stringify({
      output: '{ "status": "pass" }\n\nThe plan looks good.',
      model: 'qwen3-coder-30b',
      duration_ms: 10000
    });
    
    const result = interpretPersonaStatus(response);
    expect(result.status).toBe('pass'); // Should be pass, not fail!
  });
  
  it('should not be fooled by "fail" in explanatory text', () => {
    const response = JSON.stringify({
      output: '{ "status": "pass" }\n\nIf the plan were to fail, we would need to revise it.',
      model: 'qwen3-coder-30b'
    });
    
    const result = interpretPersonaStatus(response);
    expect(result.status).toBe('pass');
  });
});
```

### Test 2: Task Completion Flow
```typescript
describe('Task completion after QA pass', () => {
  it('should mark task done after all reviews pass', async () => {
    // Setup: Task with QA pass and all review stages pass
    // Expected: Task status updated to "done"
    // Expected: Milestone completion check runs
  });
  
  it('should send suggested tasks to PM when milestone incomplete', async () => {
    // Setup: Task complete but milestone has remaining tasks
    // Expected: PM receives suggested tasks for urgency evaluation
  });
});
```

## Impact Analysis

**Systems Affected**:
- `src/agents/persona.ts` - Core status interpretation
- `src/workflows/definitions/legacy-compatible-task-flow.yaml` - Workflow completion logic
- All workflows using plan-evaluator persona

**Severity**: 
- Issue 1: **HIGH** - Causes false negatives in plan evaluation (blocks progress)
- Issue 2: **MEDIUM** - Tasks remain in limbo, milestone completion unclear

**Backward Compatibility**: 
- Fix 1: Fully backward compatible (improves parsing only)
- Fix 2: Requires new workflow step types - may need migration

## Next Steps

1. **Immediate**: Fix `interpretPersonaStatus()` to handle nested JSON
2. **Short-term**: Add task completion logic to workflows
3. **Medium-term**: Implement PM urgency evaluation for suggested tasks
4. **Long-term**: Consider automatic milestone completion detection
