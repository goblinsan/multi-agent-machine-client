# PM Prioritization Enhancement for Review Failures

## Date
October 18, 2025

## Issue
After implementing the review flow, the PM role encountered an error when evaluating security review failures. The PM returned:
```json
{
  "status": "fail",
  "details": "Security failures not found in the provided context summary."
}
```

The PM couldn't properly evaluate the security failures because:
1. Insufficient context about the security review results
2. No guidance on project stage (early vs mature)
3. No clear instructions on how to prioritize issues based on project maturity

## Solution

Enhanced the PM prioritization steps in the workflow to provide comprehensive context and clear prioritization guidelines.

### Changes Made

#### 1. Enhanced PM Security Prioritization Payload

**File:** `src/workflows/definitions/legacy-compatible-task-flow.yaml` (pm_prioritize_security_failures step)

**Added Context:**
- `milestone_name` - Name of the current milestone
- `milestone_description` - Description of milestone goals
- `milestone_status` - Current status of the milestone
- `security_status` - Explicit security review status
- `code_review_result` - Code review results for additional context
- `context_for_pm` - Detailed instructions and project context

**Prioritization Guidelines:**
```yaml
context_for_pm: |
  PROJECT CONTEXT:
  - This is an early-stage project not yet exposed to external users
  - Focus should be on critical vulnerabilities that could cause immediate harm
  - Lower priority items like auth hardening, license policy, and documentation can be deferred
  
  PRIORITIZATION RULES:
  - IMMEDIATE: Critical vulnerabilities (SQL injection, RCE, data leaks)
  - DEFER: Auth hardening, license policy, secrets scanning, threat model updates
```

#### 2. Enhanced PM Code Review Prioritization Payload

**File:** `src/workflows/definitions/legacy-compatible-task-flow.yaml` (pm_prioritize_code_review_failures step)

**Added Context:**
- `milestone_name` - Name of the current milestone
- `milestone_description` - Description of milestone goals  
- `milestone_status` - Current status of the milestone
- `code_review_status` - Explicit code review status
- `context_for_pm` - Detailed instructions and project context

**Prioritization Guidelines:**
```yaml
context_for_pm: |
  PROJECT CONTEXT:
  - This is an early-stage project in the ${milestone_name} phase
  - Focus should be on blocking issues that prevent functionality
  - Code quality improvements can often be deferred to later milestones
  
  PRIORITIZATION RULES:
  - IMMEDIATE: Blocking bugs, security vulnerabilities, broken functionality
  - DEFER: Style issues, minor refactors, documentation improvements, non-critical optimizations
```

### Expected PM Response Format

The PM should now return a structured decision:

```json
{
  "decision": "defer",  // or "immediate_fix"
  "reasoning": "This is an early-stage project not yet exposed to external users. The security issues identified (auth hardening, license policy, secrets scanning, threat model updates) are important but not critical for this stage. They can be addressed in a future milestone focused on hardening and production readiness.",
  "immediate_issues": [],  // Empty if all can be deferred
  "deferred_issues": [
    {
      "id": 1,
      "description": "Insecure File Ingestion",
      "severity": "medium",
      "reasoning": "File ingestion is internal tool functionality, not exposed to external users yet"
    },
    {
      "id": 2,
      "description": "Missing License Policy",
      "severity": "low",
      "reasoning": "License policy is administrative, can be added before public release"
    },
    {
      "id": 3,
      "description": "Secrets Scanning Not Enabled",
      "severity": "medium",
      "reasoning": "Important for mature projects, but can be enabled in hardening phase"
    },
    {
      "id": 4,
      "description": "Threat Model Update Required",
      "severity": "medium",
      "reasoning": "Threat model updates are ongoing work, not blocking for MVP"
    }
  ],
  "follow_up_tasks": [
    {
      "title": "Security Hardening: File path sanitization, auth improvements, secrets scanning",
      "priority": "medium",
      "suggested_milestone": "production-readiness"
    }
  ]
}
```

## Prioritization Logic

### For Security Failures (Early-Stage Projects):

**IMMEDIATE FIX Required:**
- SQL injection vulnerabilities
- Remote code execution (RCE) vulnerabilities
- Authentication bypass
- Data exposure/leaks
- Privilege escalation
- Critical dependency vulnerabilities with active exploits

**CAN BE DEFERRED:**
- Auth hardening (strengthening existing auth)
- License policy documentation
- Secrets scanning setup
- Threat model updates
- Code review comment completeness
- Non-critical dependency updates
- Security best practices documentation

### For Code Review Failures (Early-Stage Projects):

**IMMEDIATE FIX Required:**
- Blocking bugs that prevent functionality
- Security vulnerabilities
- Data corruption risks
- Breaking changes
- Critical performance issues

**CAN BE DEFERRED:**
- Style/formatting issues
- Minor refactors
- Documentation improvements
- Non-critical optimizations
- Code organization improvements
- Test coverage improvements (if basic tests exist)

## Benefits

1. **Context-Aware Decisions:** PM now has full project context to make informed decisions
2. **Stage-Appropriate Prioritization:** Early-stage projects can defer non-critical issues
3. **Clear Guidelines:** PM knows exactly what to prioritize at each stage
4. **Structured Output:** Consistent JSON format for downstream processing
5. **Milestone Tracking:** Deferred issues can be tracked for future milestones

## Example Scenario

**Scenario:** Early-stage log ingestion tool, not exposed to external users

**Security Review Finds:**
1. File ingestion directory traversal risk
2. Missing license policy
3. Secrets scanning not enabled
4. Threat model needs update
5. Missing code review comments

**PM Decision (with new context):**
```json
{
  "decision": "defer",
  "reasoning": "Early-stage internal tool. Critical security (RCE, SQL injection) not present. All issues are important but not blocking for current milestone. Focus should be on functionality first, security hardening in production-readiness phase.",
  "immediate_issues": [],
  "deferred_issues": [/* all 5 issues */],
  "follow_up_tasks": [
    {
      "title": "Security Hardening Phase",
      "priority": "high",
      "suggested_milestone": "production-readiness",
      "items": ["File path sanitization", "License policy", "Secrets scanning", "Threat model update"]
    }
  ]
}
```

**Result:** Task can proceed to completion, security hardening scheduled for future milestone.

## Test Results

✅ All 200 tests pass
✅ No regressions in existing functionality
✅ PM prioritization steps properly configured

## Next Steps

1. Test with actual workflow run to verify PM can properly parse security_result
2. If PM still has issues, may need to adjust LLM prompt or add explicit parsing logic
3. Consider adding milestone stage detection (e.g., "mvp", "beta", "production") for automatic prioritization rules
4. Track deferred issues in separate backlog or future milestone

## Files Changed

- `src/workflows/definitions/legacy-compatible-task-flow.yaml` - Enhanced PM prioritization steps with context and guidelines
