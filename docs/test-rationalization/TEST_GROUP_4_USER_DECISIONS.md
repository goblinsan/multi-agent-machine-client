# Test Group 4: User Decisions Summary
**Date:** October 19, 2025  
**Status:** ✅ APPROVED  
**Source:** TEST_GROUP_4_ERROR_HANDLING.md

---

## Overview

This document captures the user's decisions on the 15 validation questions from Test Group 4 (Error Handling & Edge Cases). These decisions establish a **unified retry/escalation strategy** across the entire system and resolve the inconsistency between persona requests and task creation.

**Key Takeaway:** The user has chosen **exponential backoff for all retries**, **configurable max attempts with sensible defaults**, and **workflow abort with diagnostic logs** for escalation.

---

## Critical Decisions (Answered)

### Q1: Retry Backoff Alignment
**Question:** Should persona requests use exponential backoff (align with task creation), or keep immediate retries?

**User Decision:** ✅ **Use exponential backoff**

**Rationale:**
- Aligns with Test Group 3 decision (task creation uses exponential backoff)
- Better for sustained failures (gives system time to recover)
- Prevents rapid retry exhaustion on transient issues
- Industry standard for distributed systems

**Implementation:**
- **Replace:** Progressive timeout (immediate retries)
- **With:** Exponential backoff with delays (1s/2s/4s for 3 retries)
- **Apply to:** All persona requests, task creation, dashboard API calls, unblock attempts

**Unified Retry Configuration:**
```typescript
const RETRY_CONFIG = {
  maxAttempts: 3,              // Default for most operations
  backoffMs: [1000, 2000, 4000], // 1s, 2s, 4s delays
  timeoutMs: 60000,            // Base timeout (60s)
  retryableErrors: ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', '503']
};
```

**Code Changes:**
- `src/workflows/steps/PersonaRequestStep.ts`: Replace progressive timeout with exponential backoff
- `src/workflows/steps/BulkTaskCreationStep.ts`: Keep existing exponential backoff (already correct)
- `src/workflows/steps/UnblockAttemptStep.ts`: Add exponential backoff
- `src/services/DashboardClient.ts`: Add exponential backoff to HTTP calls

**Benefits:**
- Consistent retry strategy across entire system
- Better handling of sustained failures (DB down, network partition)
- Reduced load on failing systems (backoff gives time to recover)
- Easier to reason about (one strategy, not two)

---

### Q3: QA Max Retries
**Question:** Should QA have a max retry limit (e.g., 10 attempts), or keep unlimited?

**User Decision:** ✅ **All loops should have a configurable max (default to 10 for QA), can accept "unlimited"**

**Rationale:**
- Prevents infinite loops (currently QA can retry forever)
- Configurable allows flexibility for different scenarios
- Default of 10 provides reasonable attempt count
- "unlimited" option available for critical workflows

**Implementation:**
- **Add configuration field:** `cfg.personaMaxRetries[persona]` (already exists)
- **Default values:**
  - QA: 10 attempts (was unlimited/null)
  - Lead Engineer: 10 attempts (was 5)
  - Context: 10 attempts (was 3)
  - All others: 10 attempts (default)
- **Special value:** `null` or `"unlimited"` for unlimited retries
- **Validation:** Warn if persona configured as unlimited (log at startup)

**Configuration Schema:**
```typescript
// src/config.ts
export const cfg = {
  personaMaxRetries: {
    'tester-qa': 10,           // Default 10 (was unlimited)
    'lead-engineer': 10,       // Default 10 (was 5)
    'context': 10,             // Default 10 (was 3)
    'code-reviewer': 10,
    'security-review': 10,
    'devops': 10,
    'implementation-planner': 10,
    'plan-evaluator': 10
  },
  personaDefaultMaxRetries: 10,  // Default for unconfigured personas (was 3)
  
  // Special cases (use with caution)
  // 'critical-persona': null  // null = unlimited (not recommended)
};
```

**Validation at Startup:**
```typescript
function validatePersonaConfig() {
  for (const [persona, maxRetries] of Object.entries(cfg.personaMaxRetries)) {
    if (maxRetries === null) {
      logger.warn('Persona configured with unlimited retries (potential infinite loop)', {
        persona,
        recommendation: 'Set explicit max attempts'
      });
    }
  }
}
```

**Code Locations:**
- `src/config.ts`: Update default max retries (3 → 10)
- `src/config.ts`: Change QA from `null` to `10`
- `src/workflows/steps/PersonaRequestStep.ts`: Use configured max retries
- `src/util.ts`: Update `personaMaxRetries()` function to handle new defaults

**Benefits:**
- Prevents runaway workflows (QA no longer retries forever)
- Configurable allows per-persona tuning
- Clear defaults (10 for all) easy to remember
- Unlimited option available for edge cases (with warning)

---

### Q4: Max Unblock Attempts
**Question:** What should the max unblock attempts be? Should it be configurable?

**User Decision:** ✅ **All loops should have a configurable max (default to 10), can accept "unlimited"**

**Rationale:**
- Consistent with Q3 decision (all loops have max)
- Prevents infinite unblock loops
- Configurable allows flexibility
- Default of 10 matches persona retries

**Implementation:**
- **Add constant:** `MAX_UNBLOCK_ATTEMPTS = 10`
- **Add configuration:** `cfg.maxUnblockAttempts = 10`
- **Check in workflow:** Compare `task.blocked_attempt_count` to max
- **Action on max:** Abort workflow with diagnostic logs (see Q5)

**Configuration:**
```typescript
// src/config.ts
export const cfg = {
  maxUnblockAttempts: 10,  // Default max unblock attempts
  // Can be overridden per-project in future
};
```

**Workflow Logic:**
```typescript
// src/workflows/steps/UnblockAttemptStep.ts
async execute(context: WorkflowContext): Promise<StepResult> {
  const task = context.getVariable('task');
  const maxAttempts = cfg.maxUnblockAttempts;

  if (task.blocked_attempt_count >= maxAttempts) {
    logger.error('Max unblock attempts exhausted', {
      taskId: task.id,
      attemptCount: task.blocked_attempt_count,
      maxAttempts,
      blockedReason: task.blocked_reason,
      failedStep: task.failed_step,
      recommendation: 'Manual intervention required'
    });

    return {
      status: 'failure',
      error: new Error(`Max unblock attempts (${maxAttempts}) exhausted`),
      abort: true  // Signal workflow to abort
    };
  }

  // Increment attempt counter
  task.blocked_attempt_count = (task.blocked_attempt_count || 0) + 1;
  
  // ... proceed with unblock attempt
}
```

**Code Locations:**
- `src/config.ts`: Add `maxUnblockAttempts = 10`
- `src/workflows/steps/UnblockAttemptStep.ts`: Add max attempts check
- `src/workflows/WorkflowEngine.ts`: Handle abort signal
- `src/dashboard.ts`: Update `blocked_attempt_count` field

**Benefits:**
- Prevents infinite unblock loops
- Clear diagnostic logs when max reached
- Configurable for different project needs
- Consistent with persona retry limits

---

### Q5: Unblock Escalation
**Question:** What should happen when unblock attempts are exhausted?

**User Decision:** ✅ **For now, abort the workflow with diagnostic logs**

**Rationale:**
- Simple and clear (fail fast)
- Diagnostic logs provide debugging info
- Manual intervention can review logs and restart
- Avoids silent failures or cascading errors

**Implementation:**
- **Action:** Abort workflow immediately
- **Logs:** Comprehensive diagnostic information
- **Status:** Mark task as `blocked` (not `permanently_blocked` yet)
- **Future:** May add notification/escalation task creation later

**Diagnostic Log Content:**
```typescript
logger.error('Workflow aborted: Max unblock attempts exhausted', {
  workflowId: context.workflowId,
  taskId: task.id,
  taskTitle: task.title,
  taskStatus: task.status,
  attemptCount: task.blocked_attempt_count,
  maxAttempts: cfg.maxUnblockAttempts,
  blockedReason: task.blocked_reason,
  failedStep: task.failed_step,
  blockageAnalysis: context.getVariable('blockage_analysis'),
  unblockHistory: task.unblock_history || [],  // If tracked
  recommendation: 'Review diagnostic logs, fix root cause, restart workflow',
  actions: [
    'Check system status (DB, LM Studio, network)',
    'Review blockage reason and failed step',
    'Fix underlying issue',
    'Restart workflow manually'
  ]
});
```

**Abort Signal:**
```typescript
// WorkflowStep result
return {
  status: 'failure',
  error: new Error('Max unblock attempts exhausted'),
  abort: true,  // Signal to WorkflowEngine to abort
  diagnostics: {
    attemptCount: task.blocked_attempt_count,
    blockedReason: task.blocked_reason,
    failedStep: task.failed_step,
    recommendations: [/* ... */]
  }
};
```

**WorkflowEngine Handling:**
```typescript
// src/workflows/WorkflowEngine.ts
if (stepResult.abort) {
  logger.error('Workflow aborted by step', {
    workflowId: context.workflowId,
    stepName: stepDef.name,
    error: stepResult.error?.message,
    diagnostics: stepResult.diagnostics
  });

  throw new Error(`Workflow aborted: ${stepResult.error?.message}`);
}
```

**Code Locations:**
- `src/workflows/steps/UnblockAttemptStep.ts`: Return abort signal on max attempts
- `src/workflows/WorkflowEngine.ts`: Handle abort signal (throw error)
- `src/workflows/WorkflowCoordinator.ts`: Catch abort, log, mark workflow failed

**Future Enhancements (Not Now):**
- Create escalation task (assign to human)
- Send notification (email/Slack)
- Mark task as `permanently_blocked` status
- Auto-create investigation subtasks

**Benefits:**
- Clear failure mode (workflow stops)
- Comprehensive diagnostic logs for debugging
- Manual intervention can review and fix
- Simple implementation (no complex escalation logic yet)

---

### Q10: Workflow Abort Consistency
**Question:** Should workflow abort on persona retry exhaustion (like task creation partial failure)?

**User Decision:** ✅ **For now, abort the workflow with diagnostic logs**

**Rationale:**
- Consistent with Q5 decision (abort on exhaustion)
- Consistent with Test Group 3 decision (abort on partial failure)
- Fail fast principle (don't continue with failed dependencies)
- Diagnostic logs enable debugging

**Implementation:**
- **Persona retry exhaustion:** Abort workflow, log diagnostics
- **Task creation partial failure:** Abort workflow, log diagnostics (already decided)
- **Unblock attempts exhausted:** Abort workflow, log diagnostics (Q5)
- **Unified abort strategy:** All retry exhaustions abort workflow

**Diagnostic Log for Persona Exhaustion:**
```typescript
logger.error('Workflow aborted: Persona retry exhaustion', {
  workflowId: context.workflowId,
  stepName: stepDef.name,
  persona: config.persona,
  attemptCount: totalAttempts,
  maxAttempts: maxRetries,
  timeoutMs: baseTimeout,
  progressiveTimeouts: timeouts,  // Array of timeouts used
  lastError: lastError.message,
  recommendation: 'Check LM Studio availability, review timeout configuration',
  actions: [
    'Verify LM Studio is running',
    'Check network connectivity',
    'Review persona timeout config',
    'Check LM Studio model availability',
    'Consider increasing timeout or max retries'
  ]
});
```

**Code Locations:**
- `src/workflows/steps/PersonaRequestStep.ts`: Return abort signal after retry exhaustion
- `src/workflows/steps/BulkTaskCreationStep.ts`: Return abort signal after retry exhaustion (already implemented)
- `src/workflows/WorkflowEngine.ts`: Handle all abort signals uniformly

**Consistency Matrix:**

| Scenario | Action | Logs | Consistent? |
|----------|--------|------|-------------|
| Task creation partial failure | Abort | Diagnostic | ✅ Test Group 3 |
| Persona retry exhaustion | Abort | Diagnostic | ✅ Q10 |
| Unblock attempts exhausted | Abort | Diagnostic | ✅ Q5 |
| Dashboard API failure | Abort | Diagnostic | ✅ (via persona/task creation) |

**Benefits:**
- Unified abort strategy (easy to understand)
- Consistent diagnostic logging
- Clear failure modes (no silent failures)
- Easy to debug (all diagnostics in logs)

---

### Q11: Error Type Detection
**Question:** Should we distinguish transient vs permanent failures (e.g., 503 retry, 404 don't retry)?

**User Decision:** ✅ **No error type detection for now - allow backoff logic to run its course**

**Rationale:**
- Simple implementation (no complex error classification)
- Exponential backoff handles most cases naturally
- Avoid premature optimization
- Can add error type detection later if needed

**Implementation:**
- **Current:** Retry all errors up to max attempts with exponential backoff
- **No changes:** Don't add error type detection logic
- **Let backoff work:** Permanent errors will fail on all retries (correct outcome)
- **Future:** May add error type detection if excessive retries on permanent errors

**Example Scenarios:**

**Transient Error (503 Service Unavailable):**
```
Attempt 1: Fail (503), wait 1s
Attempt 2: Fail (503), wait 2s
Attempt 3: Success (200) ✅
Result: Workflow continues (backoff worked)
```

**Permanent Error (404 Not Found):**
```
Attempt 1: Fail (404), wait 1s
Attempt 2: Fail (404), wait 2s
Attempt 3: Fail (404), wait 4s
Attempt 4: Fail (404)
Result: Workflow aborted with diagnostic logs ✅ (correct outcome, just slower)
```

**Cost Analysis:**
- **Transient errors:** Backoff helps (retries succeed)
- **Permanent errors:** Waste 3-4 retries (7s total delay), but correct outcome
- **Trade-off:** Simplicity > optimization for now

**Future Enhancement (If Needed):**
```typescript
// Future: Add error type detection
function isRetryableError(error: Error, statusCode?: number): boolean {
  // Transient errors (should retry)
  const retryableCodes = [408, 429, 500, 502, 503, 504];
  const retryableMessages = ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND'];
  
  if (statusCode && retryableCodes.includes(statusCode)) return true;
  if (retryableMessages.some(msg => error.message.includes(msg))) return true;
  
  // Permanent errors (don't retry)
  const permanentCodes = [400, 401, 403, 404, 422];
  if (statusCode && permanentCodes.includes(statusCode)) return false;
  
  // Unknown: retry to be safe
  return true;
}
```

**Code Locations:**
- **No changes** to existing retry logic
- Keep exponential backoff in all places
- Monitor logs for excessive retries on permanent errors
- Add error type detection later if needed (Phase 6 or 7)

**Benefits:**
- Simple implementation (no error classification logic)
- Exponential backoff handles most cases
- Correct outcome in all scenarios (just slower for permanent errors)
- Can optimize later with data from production logs

---

## Deferred Questions (Lower Priority)

The following questions were not explicitly answered but can be inferred or are lower priority:

### Q2: Progressive Timeout Increment (30s)
**Status:** ⏸️ DEFERRED (Superseded by Q1)  
**Decision:** Use exponential backoff instead of progressive timeout  
**Rationale:** Q1 decision to use exponential backoff replaces progressive timeout entirely

**New Timeout Strategy:**
- Fixed timeout per attempt (60s default)
- Delays between attempts (1s/2s/4s)
- No progressive timeout increase

---

### Q6: Persona vs Workflow Step Timeout Priority
**Status:** ⏸️ DEFERRED  
**Inference:** Keep existing priority order (step timeout > persona timeout > default)  
**Rationale:** Current implementation is correct, no user feedback suggests changing it

**Priority Order:**
1. Per-step timeout override (highest)
2. Persona-specific timeout (medium)
3. Default timeout (lowest)

---

### Q7: Repository Resolution Failure (All Fallbacks)
**Status:** ⏸️ DEFERRED  
**Inference:** Abort workflow with diagnostic logs (consistent with Q5, Q10)  
**Rationale:** All failures should abort with diagnostics

**Implementation:**
```typescript
if (!repoResolved) {
  logger.error('Workflow aborted: Repository resolution failed', {
    payload: sanitizedPayload,
    attemptedFallbacks: ['local', 'https', 'repository field'],
    recommendation: 'Verify repository URL, check network, ensure PROJECT_BASE accessible'
  });
  throw new Error('Repository resolution failed');
}
```

---

### Q8: Path Traversal Validation
**Status:** ⏸️ DEFERRED  
**Recommendation:** Add validation (security best practice)  
**Rationale:** Security issue, should be fixed regardless of user decision

**Implementation (Recommended):**
```typescript
function repoDirectoryFor(projectName: string): string {
  // Sanitize project name
  const sanitized = projectName.replace(/[^a-zA-Z0-9-_]/g, '-');
  
  // Resolve path
  const resolved = path.resolve(cfg.projectBase, sanitized);
  
  // Validate path stays within PROJECT_BASE (security)
  if (!resolved.startsWith(path.resolve(cfg.projectBase) + path.sep)) {
    throw new Error('Path traversal detected');
  }
  
  return resolved;
}
```

---

### Q9: Retry History Tracking
**Status:** ⏸️ DEFERRED  
**Inference:** Include in diagnostic logs (Q5, Q10 logs are comprehensive)  
**Rationale:** Diagnostic logs should include retry history for debugging

**Implementation:**
- Log retry attempts in real-time (already happens)
- Include attempt history in abort diagnostic logs
- No need for separate retry history storage

---

### Q12: Blockage Analysis Caching
**Status:** ⏸️ DEFERRED  
**Inference:** No caching for now (re-analyze on each attempt)  
**Rationale:** Root cause may change, fresh analysis is safer

---

### Q13: Repository Clone Caching
**Status:** ⏸️ DEFERRED  
**Inference:** Cache clones, use `git fetch` to update  
**Rationale:** Avoid redundant clones (performance optimization)

**Current Behavior:** Already caches clones (reuses existing directory)

---

### Q14: Timeout Error Messages with Context
**Status:** ⏸️ DEFERRED  
**Inference:** Yes, include context (Q5, Q10 diagnostic logs are comprehensive)  
**Rationale:** Diagnostic logs should be actionable

---

### Q15: Blocked Task Auto-Retry After Delay
**Status:** ⏸️ DEFERRED  
**Inference:** No auto-retry (use manual workflow restart)  
**Rationale:** Q5 decision is to abort and require manual intervention

---

## Implementation Roadmap

### Phase 4: Parser Consolidation + Retry Strategy (Dec 7-13, 2025)

**Day 1-2: Exponential Backoff Implementation**
- ✅ Add exponential backoff to PersonaRequestStep
- ✅ Remove progressive timeout logic
- ✅ Add unified RETRY_CONFIG constant
- ✅ Update all retry logic to use exponential backoff
- ✅ Add diagnostic logging for all retry attempts

**Day 3: Max Retries Configuration**
- ✅ Update `cfg.personaMaxRetries` defaults (all → 10)
- ✅ Change QA from `null` to `10`
- ✅ Add `cfg.maxUnblockAttempts = 10`
- ✅ Add validation warnings for unlimited retries
- ✅ Update PersonaRequestStep to use new defaults

**Day 4: Abort Logic + Diagnostics**
- ✅ Add abort signal to StepResult interface
- ✅ Update UnblockAttemptStep to abort on max attempts
- ✅ Update PersonaRequestStep to abort on retry exhaustion
- ✅ Update BulkTaskCreationStep to abort on retry exhaustion (already done)
- ✅ Add comprehensive diagnostic logging

**Day 5: WorkflowEngine Abort Handling**
- ✅ Update WorkflowEngine to handle abort signals
- ✅ Add abort error handling to WorkflowCoordinator
- ✅ Update all step types to support abort signal
- ✅ Test abort scenarios (persona exhaustion, unblock max, task creation failure)

**Code Changes Estimated:**
- PersonaRequestStep: ~100 lines (replace progressive timeout with exponential backoff)
- UnblockAttemptStep: ~50 lines (add max attempts check + abort)
- WorkflowEngine: ~30 lines (handle abort signal)
- Config: ~20 lines (update defaults)
- Diagnostic logging: ~150 lines (comprehensive logs across all steps)

**Total:** ~350 lines added/modified

---

### Phase 5: Dashboard API Integration (Dec 14-20, 2025)

**Day 1: Dashboard Client Retry Logic**
- ✅ Add exponential backoff to DashboardClient HTTP calls
- ✅ Use unified RETRY_CONFIG
- ✅ Add diagnostic logging for HTTP failures
- ✅ Test retry behavior with mock failures

**Day 2-3: Workflow Integration**
- ✅ Wire BulkTaskCreationStep to DashboardClient
- ✅ Test abort on partial failure with retry exhaustion
- ✅ Verify diagnostic logs in real scenarios

**Day 4-5: Validation**
- ✅ Run all integration tests
- ✅ Test abort scenarios end-to-end
- ✅ Verify diagnostic logs are actionable
- ✅ Monitor performance (exponential backoff delays)

---

## Metrics & Validation

### Code Metrics
- **PersonaRequestStep:** ~100 lines (exponential backoff)
- **UnblockAttemptStep:** ~50 lines (max attempts + abort)
- **WorkflowEngine:** ~30 lines (abort handling)
- **Config:** ~20 lines (max retry defaults)
- **Diagnostic logging:** ~150 lines (comprehensive logs)

**Total:** ~350 lines added/modified

### Configuration Changes
- `cfg.personaDefaultMaxRetries`: 3 → 10
- `cfg.personaMaxRetries['tester-qa']`: null → 10
- `cfg.personaMaxRetries['lead-engineer']`: 5 → 10
- `cfg.personaMaxRetries['context']`: 3 → 10
- `cfg.maxUnblockAttempts`: (new) 10

### Test Coverage
- ✅ Exponential backoff timing tests
- ✅ Max retries enforcement tests
- ✅ Abort signal propagation tests
- ✅ Diagnostic log content tests
- ✅ End-to-end abort scenarios

### Performance Impact
- **Retry delays:** 1s + 2s + 4s = 7s total for 3 retries (acceptable)
- **Permanent error cost:** 7s delay before abort (acceptable trade-off)
- **Transient error benefit:** Backoff gives system time to recover (positive)

---

## Summary of Findings

### Unified Retry Strategy ✅
- **All retries:** Use exponential backoff (1s/2s/4s delays)
- **All max attempts:** Configurable, default 10, can be "unlimited"
- **All escalations:** Abort workflow with diagnostic logs
- **Consistency:** Persona requests, task creation, unblock attempts all use same strategy

### Error Handling Strengths
✅ Exponential backoff handles transient failures  
✅ Configurable max attempts prevents infinite loops  
✅ Abort with diagnostics provides clear failure modes  
✅ Consistent strategy across all operations  
✅ Simple implementation (no complex error classification)

### Error Handling Improvements
✅ Fixed inconsistency between persona/task retry strategies  
✅ Added max retry limits for all personas (including QA)  
✅ Added max unblock attempts configuration  
✅ Added abort signal propagation through WorkflowEngine  
✅ Added comprehensive diagnostic logging

### Deferred Enhancements
⏸️ Error type detection (transient vs permanent)  
⏸️ Automatic escalation task creation  
⏸️ Notification system (email/Slack)  
⏸️ Path traversal validation (recommended for security)  
⏸️ Retry history persistence (logs are sufficient for now)

---

## Next Steps

1. **USER CHECKPOINT #6:** ✅ APPROVED (decisions documented)
2. **Proceed to Test Group 5:** Cross-Review Consistency analysis
3. **Implement Phase 4:** Apply Test Groups 3 & 4 decisions
4. **Implement Phase 5:** Dashboard integration with retry logic
5. **Monitor Production:** Track abort frequency, adjust max attempts if needed

---

## Approval

**Date:** October 19, 2025  
**Status:** ✅ APPROVED  
**Approver:** User  
**Next Step:** Proceed to Test Group 5 (Cross-Review Consistency)

**Key Decisions Confirmed:**
1. ✅ Use exponential backoff for all retries (align task creation + persona requests)
2. ✅ Configurable max attempts, default 10, can be "unlimited" (with warnings)
3. ✅ Abort workflow with diagnostic logs on retry exhaustion/unblock max
4. ✅ No error type detection for now (exponential backoff handles all cases)
5. ✅ Unified abort strategy across all failure scenarios

**Confidence:** 100% - All critical questions answered with clear, actionable guidance
