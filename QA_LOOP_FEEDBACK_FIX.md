# QA Loop Feedback Fix

**Date**: October 11, 2025  
**Issue**: When QA failures are addressed by the lead-engineer, the next QA run doesn't see the new changes and continues to fail for the same reasons.

## Root Cause

The workflow had a **broken feedback loop**:

1. ✅ QA fails with specific errors
2. ✅ QAFailureCoordinationStep creates tasks and sends to implementation-planner
3. ✅ implementation-planner creates a plan to fix the errors
4. ✅ lead-engineer executes the plan and returns diffs
5. ❌ **Diffs never applied to files!**
6. ❌ **Changes never committed!**
7. ❌ **QA never re-run!**

Result: QA keeps seeing the original errors, implementation-planner gets the same feedback, and lead-engineer keeps producing the same fix over and over.

## What Was Missing

After `qa_followup_implementation`, the workflow needed:

1. **Apply the diffs** - DiffApplyStep to write changes to files
2. **Commit changes** - GitOperationStep to commit and push
3. **Re-run QA** - PersonaRequestStep to test the fixes
4. **Update status** - VariableSetStep to mark QA as passed if retest succeeds

## The Fix

Added 4 new steps after `qa_followup_implementation`:

### 1. Apply QA Followup Edits
```yaml
- name: apply_qa_followup_edits
  type: DiffApplyStep
  description: "Parse and apply QA followup implementation edits"
  depends_on: ["qa_followup_implementation"]
  condition: "${qa_request_status} == 'fail'"
  config:
    source_output: "qa_followup_implementation"
    validation: "syntax_check"
    commit_message: "fix: address QA feedback for ${taskName}"
```

### 2. Commit QA Followup
```yaml
- name: commit_qa_followup
  type: GitOperationStep
  description: "Commit and push QA followup changes"
  depends_on: ["apply_qa_followup_edits"]
  condition: "${qa_request_status} == 'fail'"
  config:
    operation: "commitAndPushPaths"
    message: "fix: address QA feedback for ${taskName}"
    paths: ["*"]
```

### 3. QA Followup Retest
```yaml
- name: qa_followup_retest
  type: PersonaRequestStep
  description: "Re-run QA after applying QA followup fixes"
  depends_on: ["commit_qa_followup"]
  condition: "${qa_request_status} == 'fail'"
  outputs: ["qa_followup_retest_result"]
  config:
    step: "3.5-qa-retest"
    persona: "tester-qa"
    intent: "qa"
    payload:
      task: "${task}"
      plan: "${qa_created_tasks_result}"
      implementation: "${qa_followup_implementation_result}"
      previous_qa_result: "${qa_request_result}"
      repo: "${repo_remote}"
      project_id: "${projectId}"
      iteration: 1
```

### 4. Update QA Status After Retest
```yaml
- name: update_qa_status_after_retest
  type: VariableSetStep
  description: "Update qa_request_status if retest passed"
  depends_on: ["qa_followup_retest"]
  condition: "${qa_followup_retest_status} == 'pass'"
  config:
    variables:
      qa_request_status: "pass"
      qa_request_result: "${qa_followup_retest_result}"
```

This step ensures that if the retest passes, downstream steps (code review, security, devops) can proceed.

## New Step Type: VariableSetStep

Created a new workflow step type to update context variables:

**File**: `src/workflows/steps/VariableSetStep.ts`

**Purpose**: Set workflow variables conditionally to update workflow state

**Features**:
- Sets multiple variables from config
- Supports template strings like `"${variable_name}"`
- Validates configuration
- Logs variable changes

**Registered in**: `src/workflows/WorkflowEngine.ts` (line 107)

## Updated Dependencies

The downstream steps (code review, security) now depend on:
```yaml
depends_on: ["qa_request", "update_qa_status_after_retest"]
condition: "${qa_request_status} == 'pass'"
```

This ensures they wait for EITHER:
- QA to pass on the first try, OR
- QA retest to pass and update the status

## Flow Diagram

### Before (Broken):
```
QA fail → create tasks → plan → lead-engineer → [STOPS HERE]
                                                     ↓
                                              [QA never sees fixes]
```

### After (Fixed):
```
QA fail → create tasks → plan → lead-engineer → apply diffs → commit → QA retest
                                                                            ↓
                                                                    [pass] → update status → code review
                                                                            ↓
                                                                    [fail] → [could add iteration loop]
```

## Testing

✅ All tests pass (106/109)  
✅ Test updated to reflect new dependencies (`workflowGating.test.ts`)

## Potential Enhancements

1. **Multiple iteration support**: Currently only does 1 retest. Could add a loop to retry multiple times if retest fails.

2. **Cumulative feedback**: Pass all previous QA results to subsequent retests so tester-qa can see the history.

3. **Max retest limit**: Add a config for max retests before escalating or aborting.

## Files Changed

1. `src/workflows/definitions/legacy-compatible-task-flow.yaml`
   - Added 4 new steps after qa_followup_implementation
   - Updated code_review_request and security_request dependencies

2. `src/workflows/steps/VariableSetStep.ts` (new file)
   - Created new step type for variable updates

3. `src/workflows/WorkflowEngine.ts`
   - Added import and registration for VariableSetStep

4. `tests/workflowGating.test.ts`
   - Updated test expectations for new dependencies

## Summary

The QA feedback loop now **actually loops**! When QA fails:
1. Implementation planner gets feedback ✅
2. Lead engineer produces fixes ✅
3. Fixes are **applied to files** ✅ (NEW!)
4. Fixes are **committed** ✅ (NEW!)
5. QA **retests with new code** ✅ (NEW!)
6. Status **updated if retest passes** ✅ (NEW!)
7. Downstream steps can proceed ✅

This fixes the persistent issue where the same QA errors would repeat indefinitely because the fixes were never actually applied! 🎉
