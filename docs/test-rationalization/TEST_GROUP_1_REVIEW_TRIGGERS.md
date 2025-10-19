# Test Group 1: Review Trigger Logic
**Phase 3 - Test Rationalization**  
**Date:** October 19, 2025  
**Status:** ✅ APPROVED - October 19, 2025

---

## USER CHECKPOINT #3 SUMMARY ✅ APPROVED

**Date:** October 19, 2025  
**Status:** ✅ APPROVED with Action Items

### Decisions Made

1. ✅ **UNKNOWN Status:** Triggers PM evaluation (same as fail) - CONFIRMED CORRECT
2. ⚠️ **TDD Governance:** Reviews should be TDD-context-aware (not skipped) - NEEDS VERIFICATION
3. ❌ **DevOps Failures:** BUG FOUND - DevOps failures should trigger PM eval, currently don't
4. ✅ **Review Statuses:** Only 3 statuses (pass/fail/unknown), anything not "pass" → PM eval
5. ✅ **Security-Sensitive:** Not needed, all tasks treated equally
6. ✅ **PM Bypass:** No bypass, PM handles severity/duplication
7. ⚠️ **TDD Variables:** Make `tdd_aware` default, investigate `workflow_mode` purpose

### Critical Bug Found

**DevOps Review Failures Not Handled:**
- Current: DevOps failures don't trigger PM evaluation
- Expected: DevOps failures should use review-failure-handling sub-workflow
- Impact: DevOps issues go untracked, tasks marked done incorrectly
- Fix: Add `pm_prioritize_devops_failures` step, update `mark_task_done` condition

### Action Items

**High Priority (Bugs):**
1. ❌ Fix DevOps review failure handling (add PM evaluation step)
2. ⚠️ Verify TDD context is passed to review prompts
3. ⚠️ Test that reviewers don't fail tasks with intentional failing tests

**Medium Priority (Cleanup):**
4. Make `tdd_aware` default to true (always TDD-aware)
5. Investigate `workflow_mode` variable (possibly legacy/unused)
6. Simplify status check logic: `reviewStatus !== 'pass'` instead of OR conditions

**Low Priority (Enhancements):**
7. Add logging to differentiate `unknown` from `fail` (debugging)
8. Document timeout/retry logic that leads to `unknown` status
9. Consider removing `tdd_aware` flag if always enabled

---

## Files Analyzed

1. **`tests/qaFailureCoordination.test.ts`** (177 lines)
   - Tests OR condition logic in workflow conditions
   - Validates `qa_request_status == 'fail' || qa_request_status == 'unknown'` patterns

2. **`tests/reviewFlowValidation.test.ts`** (178 lines)
   - Validates complete review flow sequence: QA → code → security → devops → done
   - Tests PM prioritization triggers for review failures
   - Validates no circular dependencies in workflow graph

3. **`tests/tddGovernanceGate.test.ts`** (45 lines)
   - Tests TDD governance gating (code review/security skipped during `write_failing_test` stage)
   - Validates TDD-aware workflow behavior

---

## Business Intent Extracted

### 1. Review Trigger Conditions

**Pattern: Fail OR Unknown Status Triggers PM Evaluation**

All review types (QA, Code Review, Security, DevOps) follow the same trigger pattern:

```yaml
condition: "${<review>_request_status} == 'fail' || ${<review>_request_status} == 'unknown'"
```

**Current Behavior:**
- Review failures (`fail`) trigger PM prioritization
- **UNKNOWN status ALSO triggers PM evaluation** (treat as failure)
- Review passes (`pass`) proceed to next stage
- Reviews are sequential: QA → Code → Security → DevOps → Done

**Evidence from Workflows:**
- `task-flow.yaml` lines 143, 196, 242 (QA, Code, Security)
- `in-review-task-flow.yaml` lines 38, 84 (Code, Security)
- `hotfix-task-flow.yaml` lines 99, 156, 205 (QA, Code, Security)
- `legacy-compatible-task-flow.yaml` lines 128, 184, 285 (QA, Code, Security)

### 2. Sequential Review Flow

**Pattern: Each Review Blocks Next Review**

```
QA pass → mark_in_review → Code Review
                               ↓ pass
                          Security Review
                               ↓ pass
                          DevOps Review
                               ↓ pass (+ security pass)
                          mark_task_done
```

**Failure Paths:**
```
QA fail/unknown → PM prioritization → (create tasks, workflow ends)
Code fail/unknown → PM prioritization → (create tasks, workflow ends)
Security fail/unknown → PM prioritization → (create tasks, workflow ends)
```

**Key Findings:**
- Code review **depends on** `mark_task_in_review` (not directly on QA status)
- Security review **depends on** code review pass
- DevOps review **depends on** security review pass
- Task marked `done` **only if** security passes (DevOps failure still marks done)

**Evidence:** `reviewFlowValidation.test.ts` lines 36-86

### 3. TDD Governance Gating

**Pattern: TDD Stages Control Review Execution**

**Current Behavior:**
- `tdd_stage == 'write_failing_test'` → Governance reviews (code, security) **SHOULD NOT RUN**
- `tdd_stage == 'implementation'` → Normal review flow
- `tdd_stage == 'failing_test'` → Blocked task resolution warns "EXPECTED failures"

**TDD Context Variables:**
- `tdd_aware` (boolean) - Is this task TDD-aware?
- `tdd_stage` (string) - Current TDD stage (`write_failing_test`, `failing_test`, `implementation`)

**Evidence:**
- `tddGovernanceGate.test.ts` line 29 (test expects governance hook NOT called)
- `blocked-task-resolution.yaml` lines 107-119 (TDD context in lead engineer prompt)
- All review-failure-handling sub-workflow calls include TDD context (lines 160-161, 213-214, 259-260 in task-flow.yaml)

### 4. QA Iteration Loop Special Case

**Pattern: QA Iteration Loop Does NOT Block mark_in_review**

**Current Behavior:**
- `qa_iteration_loop` step runs **only if** QA fails/unknown (condition line 128)
- `mark_task_in_review` depends on `qa_request`, **NOT** on `qa_iteration_loop`
- This prevents deadlock: if QA passes first time, iteration loop is skipped

**Rationale:**
- QA may fail multiple times (iteration loop handles retry logic)
- But if QA passes, workflow should proceed immediately
- **AVOID:** `mark_in_review` waiting for skipped step

**Evidence:** `reviewFlowValidation.test.ts` lines 94-103

---

## Extracted Test Scenarios

### Scenario 1: Review Status Triggers
```gherkin
Given a workflow with a review step (QA, Code, Security, DevOps)
When the review returns status "fail"
Then PM prioritization step SHOULD execute
And PM should evaluate whether to create tasks immediately or defer

When the review returns status "unknown"
Then PM prioritization step SHOULD execute (same as fail)

When the review returns status "pass"
Then the workflow proceeds to the next review stage
And PM prioritization step is SKIPPED
```

### Scenario 2: Sequential Review Dependencies
```gherkin
Given a task passes QA review
When task is marked "in_review"
Then code review step executes (no condition check)

Given code review returns "pass"
Then security review executes

Given code review returns "fail" or "unknown"
Then PM prioritization executes
And security review is SKIPPED
And workflow ends after PM evaluation

Given security review returns "pass"
Then DevOps review executes

Given security review returns "fail" or "unknown"
Then PM prioritization executes
And DevOps review is SKIPPED
And workflow ends after PM evaluation
```

### Scenario 3: TDD Governance Gating
```gherkin
Given a task is TDD-aware (tdd_aware = true)
And tdd_stage = "write_failing_test"
Then code review and security review SHOULD NOT execute
And governance hooks SHOULD NOT be called

Given a task is TDD-aware
And tdd_stage = "implementation"
Then normal review flow executes (code, security, devops)

Given a task is TDD-aware
And tdd_stage = "failing_test"
And task is blocked
Then lead engineer prompt includes warning: "⚠️ CAUTION: Failing tests may be EXPECTED"
```

### Scenario 4: No Circular Dependencies
```gherkin
Given a workflow with multiple review steps
When traversing the dependency graph
Then no step should depend on itself (direct cycle)
And no step should transitively depend on itself (indirect cycle)
And all steps should have a valid topological ordering
```

### Scenario 5: QA Iteration Loop Independence
```gherkin
Given QA review fails or returns unknown
Then qa_iteration_loop step executes

Given QA review passes on first attempt
Then qa_iteration_loop step is SKIPPED
And mark_task_in_review step still executes
And mark_task_in_review does NOT wait for qa_iteration_loop
```

---

## Open Questions for User (USER CHECKPOINT #3)

### Question 1: UNKNOWN Status Behavior ✅ ANSWERED
**Current:** `unknown` status is treated identically to `fail` (triggers PM prioritization)

**User Response:** ✅ **CONFIRMED - Unknown counts as a fail and should trigger PM eval**

**Decision:**
- ✅ `unknown` status triggers PM evaluation (same as `fail`)
- ✅ No automatic retry for `unknown` (PM decides whether to retry)
- ⚠️ **TODO:** Consider logging `unknown` differently from `fail` for monitoring/debugging
- ⚠️ **TODO:** Document timeout/max-retries logic that leads to `unknown` status

**Rationale:** Current implementation is correct - defensive coding approach is intentional.

---

### Question 2: TDD Governance Gate Implementation ⚠️ PARTIAL ANSWER
**Current:** Test exists (`tddGovernanceGate.test.ts`) but governance gating may not be fully implemented

**User Response:** ⚠️ **TDD failing test tasks need to be considered in code and security review (not sure if currently implemented)**

**Decision:**
- ✅ Code review and Security review **should understand** when task goal is a failing test
- ⚠️ **UNCLEAR:** Should reviews be skipped entirely or just context-aware?
- ⚠️ **TODO:** Verify if current implementation passes TDD context to reviewers
- ✅ Reviews should NOT fail a task if the goal is to have failing tests
- ✅ `tdd_aware` should be default behavior (all workflows TDD-aware)

**Interpretation:**
- Reviews should run but be **TDD-context-aware** (not skipped entirely)
- Reviewers understand "this task is SUPPOSED to have failing tests"
- Prevents false positives (failing tests marked as review failure)

**Action Items:**
1. Verify review prompts include TDD context (currently: lines 160-161, 213-214, 259-260 in task-flow.yaml)
2. Test that reviewers don't fail tasks with intentional failing tests
3. Consider renaming `tdd_aware` → always enabled, remove flag

---

### Question 3: DevOps Review Special Case ✅ ANSWERED - BUG FOUND
**Current:** Task marked `done` if security passes, **even if DevOps fails** ❌ BUG

**Evidence from `reviewFlowValidation.test.ts`:**
```typescript
// mark_done depends on devops_request
// BUT condition is security_request_status == 'pass'
// This means DevOps can fail but task still marked done
```

**User Response:** ✅ **If DevOps is configured and fails, it should also go to PM Eval**

**Decision:**
- ❌ **BUG:** Current implementation lets DevOps failures skip PM evaluation
- ✅ DevOps failures should trigger PM evaluation (same as Code/Security)
- ✅ Task should NOT be marked `done` if DevOps fails
- ✅ Hotfix workflow correctly skips DevOps entirely (intended behavior)

**Fix Required:**
```yaml
# CURRENT (WRONG):
- name: mark_task_done
  depends_on: ["devops_request"]
  condition: "${security_request_status} == 'pass'"  # ❌ WRONG

# SHOULD BE:
- name: pm_prioritize_devops_failures
  depends_on: ["devops_request"]
  condition: "${devops_request_status} == 'fail' || ${devops_request_status} == 'unknown'"
  type: SubWorkflowStep
  config:
    workflow_name: review-failure-handling

- name: mark_task_done
  depends_on: ["devops_request"]
  condition: "${security_request_status} == 'pass' && ${devops_request_status} == 'pass'"  # ✅ CORRECT
```

**Impact:** Medium - DevOps failures currently go unhandled, tasks marked done incorrectly

---

### Question 4: Review Trigger Conditions - Missing Statuses? ✅ ANSWERED
**Current:** Only `pass`, `fail`, `unknown` statuses handled

**User Response:** ✅ **Have only seen those 3 so far - but anything that is NOT Pass should get eval by PM**

**Decision:**
- ✅ Core statuses: `pass`, `fail`, `unknown` (confirmed sufficient)
- ✅ **Rule:** Anything NOT `pass` → PM evaluation
- ✅ Future statuses (`timeout`, `error`, `canceled`) should also trigger PM eval
- ✅ Defensive coding: default to PM evaluation for unexpected statuses

**Recommended Implementation:**
```typescript
function shouldTriggerPMEvaluation(reviewStatus: string): boolean {
  // Explicit pass check - everything else goes to PM
  return reviewStatus !== 'pass';
}
```

**Benefits:**
- Simpler logic (explicit allow-list vs deny-list)
- Handles future statuses automatically
- Prevents tasks slipping through on unexpected statuses

---

### Question 5: Security-Sensitive Task Gating ✅ ANSWERED - NOT NEEDED
**Current:** No explicit security-sensitive task logic found in tests

**User Response:** ✅ **I have not defined security sensitive tasks**

**Decision:**
- ✅ No security-sensitive metadata needed (all tasks treated equally)
- ✅ All tasks get security review (no special cases)
- ✅ PM evaluation handles all review failures uniformly
- ✅ Remove "security-sensitive" from recommendations

**Rationale:** Simpler - no special task categorization needed.

---

### Question 6: PM Evaluation Trigger - Should Some Reviews Bypass PM? ✅ ANSWERED
**Current:** ALL review failures trigger PM evaluation

**User Response:** ✅ **PM should understand severity and duplication - don't create duplicate tasks**

**Decision:**
- ✅ ALL review failures trigger PM evaluation (no bypass)
- ✅ PM is responsible for understanding severity (not workflow logic)
- ✅ **PM handles duplicate detection** (don't create duplicate tasks)
- ✅ PM can defer low-severity issues, prioritize high-severity
- ✅ Keep uniform trigger pattern (simplicity)

**Rationale:** 
- PM agent is smart enough to handle severity/priority decisions
- Workflow should be simple: "review failed → ask PM"
- Duplicate detection already exists in BulkTaskCreationStep (title/milestone matching)

**Note:** BulkTaskCreationStep has duplicate detection (lines 159-187 in BulkTaskCreationStep.ts), PM should leverage this.

---

### Question 7: Workflow Mode vs TDD Stage ⚠️ PARTIAL ANSWER
**Current:** Tests reference `workflow_mode: 'tdd'` and `tdd_stage: 'write_failing_test'`

**User Response:** ⚠️ **Not sure about workflow_mode - tdd_aware should just be default (review steps understand task goal might be a failing test). Don't know what workflow_mode is meant to represent**

**Decision:**
- ✅ `tdd_aware` should be **default behavior** (always true)
- ✅ All review steps should understand task goal might be failing tests
- ⚠️ **UNCLEAR:** Purpose of `workflow_mode: 'tdd'` (needs investigation)
- ✅ Keep `tdd_stage` for context (tells reviewers which TDD phase)
- ⚠️ **TODO:** Investigate `workflow_mode` usage in codebase

**Recommended Actions:**
1. Make `tdd_aware` default to `true` (remove need to set it)
2. Keep `tdd_stage` variable (values: `write_failing_test`, `failing_test`, `implementation`)
3. Investigate `workflow_mode` - may be legacy/unused variable
4. Update review prompts to always include TDD context

**TDD Stages (from current usage):**
- `write_failing_test` - Writing the test first (test will fail)
- `failing_test` - Test exists, implementation not complete (expected failure)
- `implementation` - Implementing code to make tests pass

**Note:** Review blocked-task-resolution.yaml line 119 - already warns on `failing_test` stage.

---

## Recommendations

### 1. Consolidate Review Trigger Logic
**Problem:** Same OR condition repeated across 4 workflows, 3 review types

**Recommendation:**
```typescript
// Create shared function
function shouldTriggerPMEvaluation(reviewStatus: string): boolean {
  return reviewStatus === 'fail' || reviewStatus === 'unknown';
}
```

**Benefits:**
- Single source of truth for trigger logic
- Easier to add new statuses (e.g., `timeout`)
- Easier to customize per review type if needed

---

### 2. Make TDD Governance Gating Explicit
**Problem:** Unclear if TDD gating is fully implemented

**Recommendation:**
- Add explicit condition to review steps:
  ```yaml
  condition: "${review_status} == 'pass' && (${tdd_aware} == false || ${tdd_stage} != 'write_failing_test')"
  ```
- Document TDD stage values as enum in schema
- Add test coverage for each TDD stage

---

### 3. Standardize Status Enum
**Problem:** Only 3 statuses handled, production may have more

**Recommendation:**
```typescript
enum ReviewStatus {
  PASS = 'pass',
  FAIL = 'fail',
  UNKNOWN = 'unknown',
  TIMEOUT = 'timeout',  // Retriable
  ERROR = 'error',      // System failure, retriable
  CANCELED = 'canceled', // User intervention
  SKIPPED = 'skipped'   // Not applicable (e.g., TDD stage)
}
```

---

### 4. Document DevOps Special Case
**Problem:** DevOps failures don't block task completion (unlike security)

**Recommendation:**
- If intentional: Document why DevOps is advisory-only
- If bug: Fix `mark_task_done` condition to check DevOps status:
  ```yaml
  condition: "${security_request_status} == 'pass' && ${devops_request_status} == 'pass'"
  ```

---

### 5. Add Security-Sensitive Task Metadata
**Problem:** No way to identify security-sensitive tasks

**Recommendation:**
- Add `security_sensitive` boolean to task metadata
- Add workflow logic:
  ```yaml
  condition: "${security_request_status} == 'pass' || (${security_sensitive} == false)"
  ```
- Security-sensitive tasks **cannot** proceed with security failures

---

## Impact Analysis

### Codebase Coverage
- **4 workflows** use review trigger pattern (task-flow, in-review, hotfix, legacy)
- **4 review types** per workflow (QA, Code, Security, DevOps)
- **~80 lines of YAML** could be unified with shared logic

### Test Coverage
- **3 test files** validate review trigger logic
- **400 total lines** of test code for this pattern
- **5 consolidated scenarios** can replace existing tests

### Breaking Changes
**Low Risk:**
- Consolidating trigger logic is refactor (no behavior change)
- Adding new statuses is additive (backwards compatible)

**Medium Risk:**
- Fixing DevOps special case changes completion behavior
- Making TDD gating explicit may break existing TDD workflows

**High Risk:**
- Changing UNKNOWN status behavior (currently treated as fail)

---

## Next Steps

1. **USER CHECKPOINT #3:** Answer the 7 open questions above
2. **Document Decisions:** Update this document with user answers
3. **Create Behavior Tests:** Write `tests/behavior/reviewTriggers.test.ts` based on approved scenarios
4. **Proceed to Test Group 2:** PM Decision Parsing analysis

---

## Appendix: Current Workflow Patterns

### Pattern 1: QA Review (All Workflows)
```yaml
- name: qa_request
  type: PersonaStep
  outputs: ["qa_request_result", "qa_request_status"]

- name: pm_prioritize_qa_failures
  depends_on: ["qa_request"]
  condition: "${qa_request_status} == 'fail' || ${qa_request_status} == 'unknown'"
  type: SubWorkflowStep
  config:
    workflow_name: review-failure-handling
    inputs:
      review_status: "${qa_request_status}"
      tdd_aware: "${tdd_aware || false}"
      tdd_stage: "${tdd_stage || 'implementation'}"
```

### Pattern 2: Code Review (Task Flow + In-Review)
```yaml
- name: code_review_request
  depends_on: ["mark_task_in_review"]
  type: PersonaStep
  outputs: ["code_review_request_result", "code_review_request_status"]

- name: pm_prioritize_code_review_failures
  depends_on: ["code_review_request"]
  condition: "${code_review_request_status} == 'fail' || ${code_review_request_status} == 'unknown'"
  type: SubWorkflowStep
  config:
    workflow_name: review-failure-handling
    inputs:
      review_status: "${code_review_request_status}"
      tdd_aware: "${tdd_aware || false}"
      tdd_stage: "${tdd_stage || 'implementation'}"
```

### Pattern 3: Security Review (Task Flow + In-Review + Hotfix)
```yaml
- name: security_request
  depends_on: ["code_review_request"]
  condition: "${code_review_request_status} == 'pass'"
  type: PersonaStep
  outputs: ["security_request_result", "security_request_status"]

- name: pm_prioritize_security_failures
  depends_on: ["security_request"]
  condition: "${security_request_status} == 'fail' || ${security_request_status} == 'unknown'"
  type: SubWorkflowStep
  config:
    workflow_name: review-failure-handling
    inputs:
      review_status: "${security_request_status}"
      tdd_aware: "${tdd_aware || false}"
      tdd_stage: "${tdd_stage || 'implementation'}"
```

### Pattern 4: DevOps Review (Task Flow + In-Review)
```yaml
- name: devops_request
  depends_on: ["security_request"]
  condition: "${security_request_status} == 'pass'"
  type: PersonaStep
  outputs: ["devops_request_result", "devops_request_status"]

# NOTE: No PM prioritization for DevOps failures (different from other reviews)

- name: mark_task_done
  depends_on: ["devops_request"]
  condition: "${security_request_status} == 'pass'"  # NOT devops_request_status!
  type: SimpleTaskStatusStep
  config:
    status: done
```

**Key Observation:** DevOps failures do NOT trigger PM evaluation, task marked done if security passes.

---

## Validation Checklist

Before USER CHECKPOINT #3:
- [x] All 3 test files analyzed
- [x] Workflow YAML patterns documented
- [x] Business intent extracted (5 scenarios)
- [x] 7 open questions formulated
- [x] 5 recommendations provided
- [x] Impact analysis complete

After USER CHECKPOINT #3:
- [x] User answers documented ✅
- [x] Conflicting requirements resolved ✅
- [x] Critical bug found (DevOps failures) ❌
- [x] Behavior test scenarios finalized ✅
- [ ] Ready to write `tests/behavior/reviewTriggers.test.ts` ⏳
- [ ] Ready to fix DevOps review handling bug ⏳

**Next Steps:**
1. Fix DevOps review failure handling bug (high priority)
2. Write behavior tests for validated scenarios
3. Proceed to Test Group 2 (PM Decision Parsing)
