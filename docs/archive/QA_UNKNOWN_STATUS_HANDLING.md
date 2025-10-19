# QA Unknown Status Handling

## Overview
This document describes how the workflow system handles QA agent responses with "unknown" status - cases where tests pass but the QA agent identifies issues or recommendations.

## Problem Addressed
Previously, when the QA agent returned an "unknown" status (typically when tests pass but issues are found), the workflow would treat it as "no failure" and skip PM coordination. This meant valuable QA feedback about code quality issues, missing implementations, or other recommendations would be ignored.

### Example Scenario
From logs on 2025-10-19:
```
"status":"UNKNOWN"
"preview":"**Test Execution Results**\n\nBased on the provided project files, I've detected that the test framework used is **Vitest**...\n\n**Pass/Fail Status**: 1 passed, 0 failed, 0 skipped\n\n**Failed Test Details: None**\n\nHowever, there's an issue with the `fileIngest.test.ts` file..."
```

The QA agent found:
- ✅ All tests passing
- ⚠️ Test file has incorrect expectations
- ⚠️ Missing dependency/configuration issues
- ⚠️ Code implementation issues

But the workflow didn't create tasks because status was "unknown", not "fail".

## Solution Implemented

### 1. QA Unknown Status as Failure
**File:** `src/workflows/steps/QAFailureCoordinationStep.ts`

**Change:** Treat "unknown" status the same as "fail" status:

```typescript
// BEFORE:
if (qaStatus.status !== 'fail') {
  return { status: 'success', data: { action: 'no_failure', qaStatus } };
}

// AFTER:
// Treat 'unknown' status as failure - this handles cases where tests pass
// but QA agent identifies issues/recommendations that need PM review
if (qaStatus.status !== 'fail' && qaStatus.status !== 'unknown') {
  return { status: 'success', data: { action: 'no_failure', qaStatus } };
}
```

**Effect:**
- QA unknown status now triggers PM coordination
- PM evaluates the QA feedback and recommendations
- PM creates follow-up tasks as needed
- Ensures no QA insights are lost

### 2. Duplicate Task Detection
**File:** `src/workflows/steps/ReviewFailureTasksStep.ts`

**Added:** Intelligent duplicate detection before creating tasks:

```typescript
private isDuplicateTask(followUpTask: any, existingTasks: any[], formattedTitle: string): boolean {
  // Normalizes titles (removes emojis, prefixes, brackets)
  // Extracts key phrases from descriptions
  // Compares title similarity
  // Checks description overlap (>50% = duplicate)
  // Returns true if duplicate found
}
```

**Benefits:**
- PM can recommend the same fix multiple times safely
- System automatically skips creating duplicate tasks
- Reduces task clutter on the dashboard
- Logs skipped duplicates for visibility

## When QA Unknown Status Occurs

The QA agent returns "unknown" status in several scenarios:

1. **Tests Pass But Issues Found**
   - Test expectations are incorrect
   - Implementation exists but is incomplete
   - Code quality issues present despite passing tests

2. **Missing Explicit Status in Response**
   - QA returns feedback without `{"status": "pass/fail"}` JSON
   - System defaults to "unknown" as safe fallback

3. **Ambiguous Test Results**
   - Some tests pass, some skipped, none failed
   - Test framework not properly configured
   - Tests exist but don't validate requirements

## Workflow Flow with Unknown Status

```
┌─────────────────┐
│  QA Agent Run   │
│  Tests: PASS    │
│  Status: UNKNOWN│
└────────┬────────┘
         │
         ▼
┌─────────────────────────┐
│ QAFailureCoordination   │
│ Detects unknown status  │
│ Treats as failure       │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ PM Evaluates QA Results │
│ Creates recommendations │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ ReviewFailureTasksStep  │
│ Check for duplicates    │
│ Create unique tasks     │
└────────┬────────────────┘
         │
         ▼
┌─────────────────────────┐
│ Tasks on Dashboard      │
│ Priority score: 1200    │
└─────────────────────────┘
```

## Priority Scoring

QA unknown status tasks follow the same priority as QA failures:

- **Urgent QA Issues**: `priority_score: 1200`
  - Critical test failures
  - Blocking implementation issues
  - Security concerns

- **Deferred QA Improvements**: `priority_score: 50`
  - Code quality suggestions
  - Test coverage improvements
  - Refactoring recommendations

## Configuration

In workflow YAML:
```yaml
- name: qa_failure_coordination
  type: QAFailureCoordinationStep
  config:
    taskCreationStrategy: "auto"
    tddAware: true
    urgentPriorityScore: 1200
    deferredPriorityScore: 50
```

## Monitoring

Look for these log entries:

**Unknown status detected:**
```json
{
  "level": "info",
  "msg": "QA failure detected, starting coordination",
  "qaStatus": { "status": "unknown" },
  "isUnknownStatus": true
}
```

**Duplicate task skipped:**
```json
{
  "level": "info",
  "msg": "Skipping duplicate task",
  "title": "Fix fileIngest.test.ts expectations",
  "originalTitle": "Fix fileIngest.test.ts expectations"
}
```

**Tasks created summary:**
```json
{
  "level": "info",
  "msg": "Review failure tasks created",
  "totalTasksCreated": 2,
  "urgentTasksCreated": 2,
  "deferredTasksCreated": 0,
  "skippedDuplicates": 1
}
```

## Testing

To test this feature:

1. Create a scenario where tests pass but code has issues
2. Run QA agent - should return unknown status with recommendations
3. Verify PM is triggered and evaluates the feedback
4. Verify tasks are created on dashboard with priority_score: 1200
5. Run same workflow again
6. Verify duplicate tasks are skipped

## Related Documentation

- [QA Priority Rationalization](./QA_PRIORITY_RATIONALIZATION.md) - Priority scoring system
- [PM Backlog Field Fix](./PM_BACKLOG_FIELD_FIX.md) - PM field normalization
- [Review Failure Loop Fix](./REVIEW_FAILURE_LOOP_FIX.md) - Original review failure handling

## Future Enhancements

Potential improvements:

1. **Smarter Status Detection**
   - Parse QA response text for indicators
   - Use LLM to classify unknown cases as pass/fail/defer

2. **Configurable Duplicate Threshold**
   - Make 50% overlap ratio configurable
   - Allow per-project duplicate detection strategies

3. **Duplicate Merging**
   - Instead of skipping, merge recommendations
   - Update existing task descriptions with new insights

4. **Unknown Status Analytics**
   - Track frequency of unknown status
   - Identify patterns in QA responses
   - Improve QA prompt to reduce ambiguity
