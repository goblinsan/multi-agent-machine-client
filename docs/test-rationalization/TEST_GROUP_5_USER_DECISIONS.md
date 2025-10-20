# Test Group 5: Cross-Review Consistency - User Decisions

**Date:** October 19, 2025  
**Status:** ✅ APPROVED  
**Analysis Document:** `TEST_GROUP_5_CROSS_REVIEW_CONSISTENCY.md`

---

## Executive Summary

User has approved **full standardization** of review system with severity-based classification across all review types (QA, Code Review, Security Review, DevOps Review). This establishes a **unified review architecture** with consistent severity levels, iteration limits, stage detection, response formats, and TDD awareness.

**Key Decisions:**
1. ✅ All reviews adopt SEVERE/HIGH/MEDIUM/LOW severity classification
2. ✅ All reviews use severity-based JSON response format
3. ✅ All reviews have configurable max iteration limits (abort on exhaustion)
4. ✅ All reviews use stage detection for PM context (milestone maturity awareness)
5. ✅ All reviews receive TDD context (with special handling for failing test goals)

**Implementation Impact:**
- Persona prompts: ~200 lines modified (add severity to QA/DevOps)
- Workflow updates: ~100 lines modified (TDD context, iteration limits)
- PM context: ~150 lines added (severity + stage guidance for all reviews)
- Step updates: ~100 lines modified (parse severity-based responses)
- Tests: ~300 lines added (QA/DevOps severity tests)
- **Total:** ~850 lines estimated

---

## Q1-Q3: QA Severity Levels ✅ APPROVED

### Q1: Should QA adopt 4-tier severity model (SEVERE/HIGH/MEDIUM/LOW)?

**User Decision:** ✅ **YES - Adopt SEVERE/HIGH/MEDIUM/LOW format**

**Rationale:** QA findings need prioritization just like Code/Security reviews. Not all test failures are equal - compile errors that prevent test suite from running are more critical than individual failing tests, which are more critical than test structure suggestions.

---

### Q2: How should test failures map to severity?

**User Decision:** ✅ **Defined severity mapping**

**QA Severity Classification:**

- **SEVERE:**
  - Compile errors (code doesn't compile, tests can't run)
  - Unrunnable test suite (configuration errors, missing dependencies, framework failures)
  - Test suite completely broken (0 tests execute)

- **HIGH:**
  - Failing tests (tests execute but fail assertions)
  - Critical functionality broken (auth, data integrity, core features)
  - Tests that were passing now fail (regressions)

- **MEDIUM:**
  - Poor test structure (unclear test names, missing assertions, bad organization)
  - Test maintainability issues (duplicated setup, brittle tests, flaky tests)
  - Coverage gaps (missing tests for critical paths)

- **LOW:**
  - Test improvement suggestions (refactoring opportunities, better patterns)
  - Style/lint issues in test code
  - Performance optimizations for test suite

**Status Logic:**
- `status="fail"` when SEVERE or HIGH findings exist
- `status="pass"` when only MEDIUM or LOW findings exist (or no findings)

---

### Q3: Should QA severity map to task priority?

**User Decision:** ✅ **YES - Direct mapping like Code/Security**

**Task Priority Mapping:**
- SEVERE/HIGH findings → **Urgent tasks** (priority 1200, same milestone)
- MEDIUM/LOW findings → **Deferred tasks** (priority 50, backlog milestone)

**Consistency:** This aligns with Code Review (priority 1000) and Security Review (priority 1000), with QA maintaining higher priority (1200) as approved in Test Group 3.

---

## Q4-Q6: DevOps Review Consistency ✅ APPROVED

### Q4: Should DevOps have severity levels?

**User Decision:** ✅ **YES - Adopt SEVERE/HIGH/MEDIUM/LOW format**

**Rationale:** DevOps issues range from build-breaking failures to improvement suggestions. Severity classification helps PM prioritize CI/CD fixes vs optimizations.

---

### Q5: How should DevOps issues map to severity?

**User Decision:** ✅ **Defined severity mapping**

**DevOps Severity Classification:**

- **SEVERE:**
  - Failing builds (compilation errors in CI)
  - Failing tests in CI pipeline
  - Critical SAST findings (security vulnerabilities blocking deployment)
  - Deployment completely broken (can't deploy to any environment)

- **HIGH:**
  - Slow builds (significantly impacting developer productivity)
  - High-risk SAST findings (should fix before production)
  - Missing critical observability (no error tracking, no logs in production)
  - CI/CD pipeline unstable (frequent failures, flaky tests)

- **MEDIUM:**
  - Missing observability hooks (incomplete telemetry, missing metrics)
  - Incomplete CI/CD (missing stages, no automation for some tasks)
  - Build optimization opportunities (caching, parallelization)

- **LOW:**
  - Improvement suggestions (better tooling, documentation, developer experience)
  - Performance optimizations (faster builds, better caching)
  - Additional monitoring/alerting (nice-to-have metrics)

**Status Logic:**
- `status="fail"` when SEVERE or HIGH findings exist
- `status="pass"` when only MEDIUM or LOW findings exist

---

### Q6: Should DevOps failures always trigger PM evaluation?

**User Decision:** ✅ **YES - Same as Code/Security/QA**

**Trigger Logic:** DevOps review failures use identical pattern:
```yaml
condition: ${devops_status} == 'fail' || ${devops_status} == 'unknown'
```

**Consistency:** All four review types now have identical failure handling:
- QA failure → PM evaluation
- Code failure → PM evaluation
- Security failure → PM evaluation
- DevOps failure → PM evaluation

---

## Q7-Q9: Iteration Limits ✅ APPROVED

### Q7: Should all reviews have max iteration limits?

**User Decision:** ✅ **YES - All personas should have configurable max attempt limit per cycle**

**Rationale:** Prevents infinite loops across all review types, not just QA. Essential for system stability and predictable workflow execution times.

---

### Q8: Should limits be configurable per review type?

**User Decision:** ✅ **YES - Configurable per persona**

**Recommended Configuration:**
```typescript
// src/config.ts
export const config = {
  personaMaxRetries: {
    'tester-qa': 10,           // Test-fix-test cycles can be iterative
    'code-reviewer': 10,        // Code review iterations
    'security-review': 10,      // Security fix iterations
    'devops': 10,              // DevOps fix iterations
    'plan-evaluator': 3,       // Plan evaluation (special case below)
    'implementation-planner': 5,
    'lead-engineer': 5,
    'context': 3,
  }
};
```

**Special Case - Plan Evaluator:**
- Plan evaluator has max attempts (default 3)
- When max exceeded: **Failed plan proceeds to implementation** (unique behavior)
- Rationale: Better to implement imperfect plan than block indefinitely
- All other personas: Abort workflow on max attempts exceeded

---

### Q9: What happens when max iterations exceeded?

**User Decision:** ✅ **Abort workflow (except plan-evaluator special case)**

**Abort Strategy:**
- **QA/Code/Security/DevOps Reviews:** Abort workflow with diagnostic logs
- **Plan Evaluator:** Failed plan proceeds to implementation after max attempts
- **Other Personas:** Abort workflow with diagnostic logs

**Diagnostic Logging (on abort):**
```typescript
{
  workflow_id: '...',
  step_id: '...',
  persona: 'tester-qa',
  attempt_count: 10,
  max_attempts: 10,
  last_error: '...',
  abort_reason: 'Max iteration attempts exceeded',
  recommendations: [
    'Review QA findings - may indicate systemic issue',
    'Consider manual intervention',
    'Check if tests are flaky or environment-specific'
  ],
  action_items: [
    'Investigate root cause of repeated failures',
    'Consider increasing max attempts if legitimate iteration needed',
    'Review workflow logs for patterns'
  ]
}
```

**Consistency:** Aligns with Test Group 4 abort strategy (unified error handling).

---

## Q10-Q12: Stage Detection ✅ APPROVED

### Q10: Should all reviews use stage detection (MVP/POC/beta/production)?

**User Decision:** ✅ **YES - Stage detection is important for PM decisions on failed review stages**

**Rationale:** PM needs to understand project maturity to properly prioritize reviewer comments. Early-stage projects don't need production-grade features that reviewers might suggest.

**Example:** 
> "A project in early stages of development doesn't need a production grade auth system (or possibly even any auth) if it is suggested by a reviewer."

---

### Q11: How should stage affect severity interpretation?

**User Decision:** ✅ **PM uses stage to contextualize severity, not reviewers**

**Important Distinction:**
- **Reviewers:** Always report findings at technical severity (SEVERE if auth is broken, regardless of stage)
- **PM:** Considers stage when prioritizing tasks (may defer auth improvements in MVP stage)

**Stage-Aware PM Logic:**

**Early Stage (MVP/POC/Prototype):**
- SEVERE findings: Still immediate (broken functionality)
- HIGH findings: Context-dependent (missing auth? defer to beta; broken core feature? immediate)
- MEDIUM/LOW findings: Mostly defer to backlog (future improvements)

**Beta/Pre-Production:**
- SEVERE findings: Always immediate
- HIGH findings: Usually immediate (production readiness matters)
- MEDIUM/LOW findings: Evaluate based on launch timeline

**Production:**
- SEVERE findings: Always immediate (critical)
- HIGH findings: Always immediate (quality matters)
- MEDIUM findings: Prioritize based on impact
- LOW findings: Backlog for future iterations

---

### Q12: How is project stage detected?

**User Decision:** ✅ **PM examines current project milestone to understand maturity**

**Detection Strategy:**

1. **Primary: Milestone Metadata**
   - Milestone name parsing (e.g., "MVP Launch", "Beta Release", "Production v1.0")
   - Milestone description analysis (keywords: MVP, POC, prototype, beta, production)
   - Explicit stage field in milestone (if added to schema)

2. **Secondary: Milestone Completion Percentage**
   - <30%: Early stage (likely MVP/POC)
   - 30-70%: Mid-development (features stabilizing)
   - >70%: Mature (approaching production)

3. **Tertiary: Git Branch Naming**
   - `main`/`master`: Production
   - `beta/*`, `release/*`: Beta/Pre-production
   - `feature/*`, `dev/*`: Development/MVP
   - `hotfix/*`: Production (emergency)

**Implementation:**
- PM receives milestone context in payload
- PM prompt includes stage detection guidance
- PM makes final determination based on multiple signals

**PM Prompt Enhancement:**
```yaml
context_for_pm: |
  STAGE DETECTION:
  Analyze the milestone to determine project maturity:
  - Milestone name: ${milestone_name}
  - Milestone description: ${milestone_description}
  - Completion: ${milestone_completion_percentage}%
  
  Early Stage (MVP/POC/Prototype <30%):
  - Focus on core functionality
  - Defer production-grade features (auth, monitoring, optimization)
  - Accept technical debt if it accelerates learning
  
  Beta/Pre-Production (30-70%):
  - Balance feature completion with quality
  - Production-readiness matters
  - HIGH findings should be addressed before launch
  
  Production (>70% or milestone indicates production):
  - Quality and reliability critical
  - SEVERE/HIGH findings must be immediate
  - MEDIUM findings evaluated for impact
```

---

## Q13-Q15: Response Format Standardization ✅ APPROVED

### Q13: Should all reviews use the same JSON structure?

**User Decision:** ✅ **YES - Severity-based format should be the standard**

**Rationale:** Consistent response format enables:
- Unified PM parsing logic (no special cases per review type)
- Consistent dashboard display of findings across review types
- Easier comparison of severity across different review types
- Simplified workflow logic (same handling for all reviews)

---

### Q14: Should QA/DevOps migrate to severity-based format?

**User Decision:** ✅ **YES - All reviews use severity-based JSON**

**Unified Response Format (All Reviews):**
```json
{
  "status": "fail" | "pass" | "unknown",
  "summary": "Brief overview of findings",
  "findings": {
    "severe": [
      {
        "category": "...",       // Domain-specific field
        "description": "...",
        "file": "...",           // Optional (may not apply to all reviews)
        "line": 123,             // Optional
        "recommendation": "..."
      }
    ],
    "high": [...],
    "medium": [...],
    "low": [...]
  }
}
```

**Domain-Specific Finding Fields:**

**QA Findings:**
```json
{
  "category": "test_failure" | "compilation_error" | "test_structure" | "coverage",
  "test_name": "should authenticate user",
  "error_message": "Expected 200, got 401",
  "stack_trace": "...",
  "file": "tests/auth.test.ts",
  "line": 45,
  "recommendation": "Fix authentication middleware"
}
```

**DevOps Findings:**
```json
{
  "category": "build" | "ci_cd" | "sast" | "observability" | "deployment",
  "component": "Build Pipeline",
  "issue": "Tests failing in CI",
  "impact": "Blocks all deployments",
  "fix": "Update test configuration for CI environment",
  "pr_url": "https://github.com/..."  // Optional
}
```

**Code Review Findings (existing):**
```json
{
  "file": "src/auth.ts",
  "line": 123,
  "issue": "Repeated code in validation logic",
  "recommendation": "Extract to shared validator function"
}
```

**Security Review Findings (existing):**
```json
{
  "category": "injection" | "auth" | "crypto" | "secrets",
  "vulnerability": "SQL Injection in user query",
  "file": "src/database.ts",
  "line": 89,
  "impact": "Attacker can access all user data",
  "mitigation": "Use parameterized queries"
}
```

---

### Q15: How should PM parse different response formats?

**User Decision:** ✅ **N/A - All formats standardized (severity-based)**

**Implementation:**
- PMDecisionParserStep expects consistent format from all reviews
- Single parsing logic handles all review types
- Domain-specific fields are preserved but not required for PM logic
- PM focuses on severity arrays, not domain-specific details

---

## Q16-Q18: TDD Completeness ✅ APPROVED

### Q16: Should ALL reviews receive TDD context in YAML?

**User Decision:** ✅ **YES - If current task is to create a failing test, this information should be present for reviewer**

**TDD Context Propagation:**
```yaml
# All review steps receive:
qa_request:
  config:
    payload:
      tdd_aware: ${tdd_aware}
      tdd_stage: ${tdd_stage}
      
code_review_request:
  config:
    payload:
      tdd_aware: ${tdd_aware}
      tdd_stage: ${tdd_stage}
      
security_request:
  config:
    payload:
      tdd_aware: ${tdd_aware}
      tdd_stage: ${tdd_stage}
      
devops_request:
  config:
    payload:
      tdd_aware: ${tdd_aware}
      tdd_stage: ${tdd_stage}
```

**TDD Stages:**
- `write_failing_test`: Goal is to create a failing test (Red phase)
- `failing_test`: Test exists and is intentionally failing (Red phase)
- `make_test_pass`: Implementing code to make test pass (Green phase)
- `refactor`: Refactoring with passing tests (Refactor phase)
- `null` or absent: Normal development (not TDD workflow)

---

### Q17: What should DevOps do during TDD Red phase?

**User Decision:** ✅ **As long as tests are runnable, failing tests would be expected outcome**

**DevOps TDD Handling:**

**write_failing_test or failing_test stage:**
- Build must succeed (code compiles) → If fails, SEVERE
- Test suite must run (tests execute) → If can't run, SEVERE
- Tests failing is EXPECTED → Not a failure if intentional
- Report: `status="pass"` with note about TDD Red phase

**Example DevOps Response (TDD Red Phase):**
```json
{
  "status": "pass",
  "summary": "Build successful, tests failing as expected (TDD Red phase)",
  "tdd_red_phase_detected": true,
  "findings": {
    "severe": [],  // No build failures
    "high": [],    // Failing tests are expected
    "medium": [
      {
        "category": "ci_cd",
        "issue": "Test execution time increased to 45s",
        "recommendation": "Consider test optimization"
      }
    ],
    "low": []
  }
}
```

**Failure Conditions (TDD Red Phase):**
- Compilation errors → SEVERE (tests can't run)
- Test framework errors → SEVERE (tests can't execute)
- Tests passing when should fail → HIGH (TDD Red phase goal not met)

---

### Q18: Should TDD stages affect review severity interpretation?

**User Decision:** ✅ **YES - All stages of workflow need to take this into account**

**TDD-Aware Review Logic:**

**Implementation Planner:**
- `write_failing_test`: Plan focuses on test creation, not implementation
- `failing_test`: Plan focuses on minimum code to pass test
- `make_test_pass`: Plan focuses on making specific test pass
- `refactor`: Plan focuses on code quality improvements

**Plan Evaluator:**
- `write_failing_test`: Plan should include test file creation, not implementation
- `failing_test`: Plan should be minimal (make test pass only)
- `make_test_pass`: Plan evaluation considers test constraints
- `refactor`: Plan should preserve passing tests

**All Reviewers (QA/Code/Security/DevOps):**
- `write_failing_test` or `failing_test`: Failing tests are EXPECTED
- Only fail if:
  - Tests can't run (compilation, framework errors) → SEVERE
  - Tests pass when should fail → HIGH (TDD goal not met)
  - Code quality issues in test code → MEDIUM/LOW

**PM (Final Override Authority):**
- PM receives TDD context in payload
- PM can override reviewer failure if reviewer didn't account for TDD stage
- Example: Code reviewer fails task due to "no implementation", but task goal is write_failing_test → PM overrides to immediate_fix=false, explains TDD stage to reviewer

**PM Prompt Enhancement:**
```yaml
pm_prioritize_code_review_failures:
  config:
    payload:
      tdd_aware: ${tdd_aware}
      tdd_stage: ${tdd_stage}
      context_for_pm: |
        TDD AWARENESS:
        If tdd_stage is "write_failing_test" or "failing_test":
        - Failing tests are EXPECTED (this is TDD Red phase)
        - Reviewer may have failed task incorrectly
        - Only fail if tests can't run or code quality issues
        - Consider overriding reviewer failure if they didn't account for TDD
        
        Current TDD stage: ${tdd_stage}
        TDD aware: ${tdd_aware}
```

---

## Implementation Roadmap

### Phase 4 (Parser Consolidation + Severity Implementation) - 7 Days

**Day 1-2: Persona Prompt Updates**
- Update `tester-qa` prompt with SEVERE/HIGH/MEDIUM/LOW definitions (~50 lines)
- Update `devops` prompt with severity levels (~50 lines)
- Add TDD awareness to DevOps prompt (~30 lines)
- Add severity guidance to all prompts (~20 lines per prompt)

**Day 3: Response Format Migration**
- Update QA persona to return severity-based JSON (~50 lines)
- Update DevOps persona to return severity-based JSON (~50 lines)
- Add domain-specific fields to response examples (~20 lines)

**Day 4-5: PM Context Enhancement**
- Add QA severity guidance to PM context (~75 lines)
- Add DevOps severity guidance to PM context (~75 lines)
- Add stage detection guidance to all PM contexts (~100 lines)
- Add TDD awareness to all PM contexts (~50 lines)

**Day 6: Workflow Updates**
- Add DevOps TDD context (tdd_aware, tdd_stage) to YAML workflows (~20 lines)
- Verify QA TDD context in YAML workflows (~10 lines)
- Add iteration limit configuration to all review steps (~30 lines)

**Day 7: Testing & Validation**
- Add QA severity tests to severityReviewSystem.test.ts (~100 lines)
- Add DevOps severity tests to severityReviewSystem.test.ts (~100 lines)
- Add TDD context tests for QA/DevOps (~100 lines)
- Validate all reviews use consistent format (~50 lines tests)

### Phase 5 (Dashboard Integration) - 5 Days

**Day 1: Dashboard Schema**
- No changes needed (severity stored in JSON findings field)

**Day 2-3: Step Implementation**
- Update PMDecisionParserStep to parse severity-based QA/DevOps responses (~50 lines)
- Update ReviewFailureTasksStep to handle severity uniformly (~30 lines)
- Add stage detection logic to PM steps (~50 lines)

**Day 4: Workflow Integration**
- Test all 4 review types with severity-based responses
- Validate TDD awareness across all workflows
- Verify stage detection working correctly
- Test iteration limits and abort behavior

**Day 5: End-to-End Validation**
- Run complete workflow with all review types
- Verify severity-based task creation
- Verify TDD handling (Red/Green/Refactor phases)
- Verify stage detection affects PM decisions
- Confirm iteration limits prevent infinite loops

---

## Code Changes Estimate

**Persona Prompts:** ~200 lines modified
- tester-qa: +50 lines (severity definitions)
- devops: +50 lines (severity definitions)
- TDD additions: +30 lines per prompt × 4 = +120 lines

**Workflow Updates:** ~100 lines modified
- DevOps TDD context: +20 lines
- QA TDD context validation: +10 lines
- Iteration limits: +30 lines
- Stage detection variables: +40 lines

**PM Context Enhancement:** ~300 lines added
- QA severity guidance: +75 lines
- DevOps severity guidance: +75 lines
- Stage detection (all reviews): +100 lines
- TDD awareness (all reviews): +50 lines

**Step Implementation Updates:** ~100 lines modified
- PMDecisionParserStep: +50 lines (parse QA/DevOps severity)
- ReviewFailureTasksStep: +30 lines (uniform severity handling)
- Stage detection logic: +20 lines

**Test Updates:** ~300 lines added
- QA severity tests: +100 lines
- DevOps severity tests: +100 lines
- TDD context tests: +100 lines

**Total Estimated Changes:** ~1,000 lines
- 200 modified (prompts)
- 700 added (workflows, PM context, tests)
- 100 modified (step implementations)

---

## Validation Criteria

### Persona Prompts ✅
- [ ] tester-qa includes SEVERE/HIGH/MEDIUM/LOW definitions
- [ ] devops includes SEVERE/HIGH/MEDIUM/LOW definitions
- [ ] All prompts include TDD awareness logic
- [ ] All prompts return severity-based JSON format

### Workflow Integration ✅
- [ ] All 4 review types receive tdd_aware and tdd_stage
- [ ] All reviews have configurable max iteration limits
- [ ] All PM steps receive stage detection context
- [ ] DevOps failures trigger PM evaluation (same as others)

### PM Context ✅
- [ ] QA PM context includes severity guidance
- [ ] DevOps PM context includes severity guidance
- [ ] All PM contexts include stage detection guidance
- [ ] All PM contexts include TDD awareness guidance

### Response Format ✅
- [ ] QA returns severity-based JSON (severe/high/medium/low arrays)
- [ ] DevOps returns severity-based JSON (severe/high/medium/low arrays)
- [ ] All reviews use consistent status logic (fail if SEVERE/HIGH)
- [ ] Domain-specific fields preserved (test_name, component, etc.)

### TDD Handling ✅
- [ ] QA passes when failing tests expected (write_failing_test stage)
- [ ] DevOps passes when tests fail in Red phase (build succeeds, tests runnable)
- [ ] Code/Security reviewers account for TDD stage
- [ ] PM can override reviewer failures that didn't account for TDD

### Stage Detection ✅
- [ ] PM receives milestone context (name, description, completion %)
- [ ] PM prompt includes stage detection logic
- [ ] PM adjusts severity interpretation based on stage
- [ ] Early-stage projects can defer production-grade features

### Iteration Limits ✅
- [ ] All review types have configurable max attempts
- [ ] Abort workflow on max exceeded (except plan-evaluator)
- [ ] Plan-evaluator special case: failed plan proceeds to implementation
- [ ] Comprehensive diagnostic logs on abort

---

## Approval Section

**Status:** ✅ APPROVED  
**Date:** October 19, 2025  
**Approved By:** User (comprehensive responses to all 18 questions)

**Decisions Summary:**
1. ✅ **Q1-Q3:** QA adopts SEVERE/HIGH/MEDIUM/LOW with defined mapping
2. ✅ **Q4-Q6:** DevOps adopts severity levels with defined mapping
3. ✅ **Q7-Q9:** All reviews have configurable iteration limits, abort on exhaustion (plan-evaluator exception)
4. ✅ **Q10-Q12:** All reviews use stage detection, PM examines milestone maturity
5. ✅ **Q13-Q15:** All reviews use severity-based JSON format (standardized)
6. ✅ **Q16-Q18:** All reviews receive TDD context, special handling for Red phase

**Implementation Priority:**
- ✅ Phase 4 (Week 7): Persona prompts + severity implementation
- ✅ Phase 5 (Week 8): Workflow integration + PM context
- ✅ Phase 6 (Week 9): Testing + validation

**Next Steps:**
1. ✅ Update REFACTOR_TRACKER.md with Test Group 5 approval
2. ✅ Mark Phase 3 Test Rationalization as 100% complete
3. ⏳ Proceed to Week 6: Consolidated Behavior Tests (if desired)
4. ⏳ Implement Phase 4: Parser Consolidation + Severity System

---

**End of Test Group 5 User Decisions**
