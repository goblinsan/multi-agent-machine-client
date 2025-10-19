# Dashboard + Review Consolidation Refactor Tracker
**Start Date:** October 19, 2025  
**Status:** In Progress  
**Plan:** [REFACTOR_PLAN_OCT_2025.md](./REFACTOR_PLAN_OCT_2025.md)

---

## Overview

This tracker monitors progress on the two-part refactor:
1. **New Dashboard Backend** - SQLite + Fastify, YAML-first API design
2. **Review Failure Consolidation** - Single service for QA, Code Review, Security

**Key Principles:**
- ✅ API designed for workflows (ignore legacy)
- ✅ Test rationalization with user validation FIRST
- ✅ No refactoring until business intent validated
- ✅ User checkpoints at every stage

---

## Phase 1: Dashboard API Design
**Timeline:** Week 1-2 (Oct 19 - Nov 1, 2025)  
**Goal:** Design clean API optimized for YAML workflows

### Tasks
- [ ] **Day 1: Requirements Gathering**
  - [ ] Review all YAML workflows (feature.yml, hotfix.yml, project-loop.yml)
  - [ ] Document every dashboard interaction pattern
  - [ ] Identify common operations (create task, bulk sync, query status)
  - [ ] Define success criteria
  - **Status:** Not Started
  - **Branch:** `feature/dashboard-api-design`

- [ ] **Day 2-3: API Design Workshop**
  - [ ] Design endpoints from workflow perspective
  - [ ] Define request/response formats
  - [ ] Design error handling strategy
  - [ ] NO references to old API
  - **Status:** Not Started
  - **Deliverable:** `docs/dashboard-api/spec.yml`

- [ ] **Day 4: Schema Design**
  - [ ] SQLite schema optimized for workflow queries
  - [ ] Indexes for common access patterns
  - [ ] Migration strategy
  - **Status:** Not Started
  - **Deliverable:** `docs/dashboard-api/schema.sql`

- [ ] **Day 5: Documentation + Review**
  - [ ] Write OpenAPI spec
  - [ ] Document design decisions
  - [ ] Create examples for each endpoint
  - [ ] **USER CHECKPOINT:** Review API design
  - **Status:** Not Started
  - **Deliverable:** `docs/dashboard-api/DESIGN_DECISIONS.md`

### Checkpoint #0: API Design Review
**Date:** TBD  
**Status:** ⏳ Pending

**Review Questions:**
- [ ] Does API match how YAML workflows actually work?
- [ ] Are there any missing operations?
- [ ] Is error handling clear and actionable?
- [ ] Are request/response formats intuitive?

**Approval:** ❌ Not Yet Approved

---

## Phase 2: Dashboard Backend Proof
**Timeline:** Week 2 (Nov 2 - Nov 8, 2025)  
**Goal:** Minimal implementation to validate API design

### Tasks
- [ ] **Day 1-2: Core Backend**
  - [ ] Setup SQLite + Fastify
  - [ ] Implement 3-4 critical endpoints
  - [ ] Basic validation, error handling
  - **Status:** Not Started
  - **Branch:** `feature/dashboard-backend-proof`

- [ ] **Day 3-4: Integration Proof**
  - [ ] Create simple test workflow
  - [ ] Verify API works for real workflow case
  - [ ] Measure performance (bulk operations)
  - **Status:** Not Started

- [ ] **Day 5: Refinement**
  - [ ] Address any design issues discovered
  - [ ] **USER CHECKPOINT:** Validate API behavior
  - **Status:** Not Started

### Checkpoint #0.5: API Behavior Validation
**Date:** TBD  
**Status:** ⏳ Pending

**Approval:** ❌ Not Yet Approved

---

## Phase 3: Test Rationalization
**Timeline:** Weeks 3-5 (Nov 9 - Nov 29, 2025)  
**Goal:** Extract and validate business intent from existing tests

### Week 3: Test Groups 1-3

#### Test Group 1: Review Trigger Logic
**Files Analyzed:**
- `tests/qaFailureCoordination.test.ts`
- `tests/reviewFlowValidation.test.ts`
- `tests/tddGovernanceGate.test.ts`

**Status:** ⏳ Not Started  
**Deliverable:** Draft test scenarios + questions

**Questions for User:**
- [ ] Should PM evaluation trigger on UNKNOWN status? (Current: yes)
- [ ] What defines "security-sensitive" tasks?
- [ ] Should TDD stage block task creation for all review types?
- [ ] Are there other trigger conditions we're missing?

**USER CHECKPOINT #1**  
**Date:** TBD  
**Approval:** ❌ Not Yet Approved

---

#### Test Group 2: PM Decision Parsing
**Files Analyzed:**
- `tests/productionCodeReviewFailure.test.ts`
- `tests/initialPlanningAckAndEval.test.ts`
- `tests/qaPmGating.test.ts`

**Status:** ⏳ Not Started  
**Deliverable:** Draft test scenarios + questions

**Questions for User:**
- [ ] What are ALL valid PM response formats? (need exhaustive list)
- [ ] Should unknown status default to "defer" or "immediate_fix"?
- [ ] Are there any PM responses that should BLOCK task creation?
- [ ] Should PM provide reasoning/context with decisions?

**USER CHECKPOINT #2**  
**Date:** TBD  
**Approval:** ❌ Not Yet Approved

---

#### Test Group 3: Task Creation Logic
**Files Analyzed:**
- `tests/qaFailureTaskCreation.integration.test.ts` (520 lines)
- `tests/codeReviewFailureTaskCreation.integration.test.ts` (520 lines)
- `tests/taskPriorityAndRouting.test.ts`

**Status:** ⏳ Not Started  
**Deliverable:** Draft test scenarios + questions

**Questions for User:**
- [ ] Priority scores (1200 urgent, 50 deferred) - are these correct?
- [ ] Should urgent tasks ALWAYS link to parent, or only if parent exists?
- [ ] Should assignee_persona vary by review type or always implementation-planner?
- [ ] How should we handle subtasks vs top-level tasks?
- [ ] Should title prefix be configurable per workflow?

**USER CHECKPOINT #3**  
**Date:** TBD  
**Approval:** ❌ Not Yet Approved

---

### Week 4: Test Groups 4-5

#### Test Group 4: Error Handling & Edge Cases
**Files Analyzed:**
- `tests/qaFailure.test.ts`
- `tests/blockedTaskResolution.test.ts`
- `tests/repoResolutionFallback.test.ts`

**Status:** ⏳ Not Started  
**Deliverable:** Draft test scenarios + questions

**Questions for User:**
- [ ] Should we retry on failure, or fail fast?
- [ ] What's the timeout for dashboard API calls?
- [ ] Should partial failure (some tasks created) be treated as success?
- [ ] How should we handle duplicate task creation attempts?

**USER CHECKPOINT #4**  
**Date:** TBD  
**Approval:** ❌ Not Yet Approved

---

#### Test Group 5: Cross-Review Consistency
**Files Analyzed:**
- `tests/severityReviewSystem.test.ts`
- `tests/qaPlanIterationMax.test.ts`
- `tests/personaTimeoutRetry.test.ts`

**Status:** ⏳ Not Started  
**Deliverable:** Draft test scenarios + questions

**Questions for User:**
- [ ] Should QA, Code Review, Security all behave IDENTICALLY?
- [ ] Are there any legitimate differences between review types?
- [ ] Should severity (critical/high/medium/low) map differently per review type?
- [ ] Should iteration limits vary by review type?

**USER CHECKPOINT #5**  
**Date:** TBD  
**Approval:** ❌ Not Yet Approved

---

### Week 5: Consolidated Behavior Tests

**Tasks:**
- [ ] Write `tests/behavior/reviewTriggers.test.ts`
- [ ] Write `tests/behavior/pmDecisionParsing.test.ts`
- [ ] Write `tests/behavior/taskCreation.test.ts`
- [ ] Write `tests/behavior/errorHandling.test.ts`
- [ ] Write `tests/behavior/crossReviewConsistency.test.ts`

**Verification:**
- [ ] New behavior tests run (expected to fail - no implementation yet)
- [ ] Old integration tests still pass (current implementation)
- [ ] All scenarios from old tests captured in new tests

**FINAL USER CHECKPOINT: Test Rationalization Complete**  
**Date:** TBD  
**Approval:** ❌ Not Yet Approved

---

## Phase 4: Service Implementation
**Timeline:** Week 6 (Nov 30 - Dec 6, 2025)  
**Goal:** Implement ReviewFailureService with validated behavior

### Tasks
- [ ] **Day 1-2: Core Service**
  - [ ] Implement `ReviewFailureService` class
  - [ ] Implement `parseReviewResult()`
  - [ ] Implement `parsePMDecision()`
  - [ ] Implement `createTasksFromPMDecision()`
  - [ ] Implement `shouldCreateTasks()`
  - **Status:** Not Started
  - **File:** `src/workflows/services/ReviewFailureService.ts`

- [ ] **Day 3: Unit Tests**
  - [ ] Test service in isolation (mocked dependencies)
  - [ ] Verify all edge cases covered
  - **Status:** Not Started

- [ ] **Day 4-5: Integration with New Dashboard API**
  - [ ] Connect service to new dashboard backend
  - [ ] Test real workflow scenarios
  - [ ] Verify behavior tests start passing
  - **Status:** Not Started

**Metrics:**
- [ ] All 5 behavior test suites passing
- [ ] Code coverage >90%
- [ ] Service <400 lines of code

---

## Phase 5: Step Refactoring
**Timeline:** Week 7 (Dec 7 - Dec 13, 2025)  
**Goal:** Refactor workflow steps to use ReviewFailureService + new API

### Tasks
- [ ] **Day 1-2: Refactor QAFailureCoordinationStep**
  - [ ] Replace custom logic with ReviewFailureService calls
  - [ ] Update to use new dashboard API
  - [ ] Target: 681 lines → ~150 lines
  - **Status:** Not Started
  - **File:** `src/workflows/steps/QAFailureCoordinationStep.ts`

- [ ] **Day 3-4: Refactor ReviewFailureTasksStep**
  - [ ] Replace custom logic with ReviewFailureService calls
  - [ ] Update to use new dashboard API
  - [ ] Target: 540 lines → ~100 lines
  - **Status:** Not Started
  - **File:** `src/workflows/steps/ReviewFailureTasksStep.ts`

- [ ] **Day 5: Test Updates**
  - [ ] Update all tests to pass with new implementation
  - [ ] Verify behavior tests pass
  - [ ] Verify old integration tests can be deleted
  - **Status:** Not Started

**Metrics:**
- [ ] Total LOC reduction: 1221 → 550 (55% reduction)
- [ ] All 264+ tests passing
- [ ] Zero regression in functionality

---

## Phase 6: Cleanup & Deployment
**Timeline:** Week 8 (Dec 14 - Dec 20, 2025)  
**Goal:** Clean up old code, simplify YAML, deploy to production

### Tasks
- [ ] **Day 1-2: YAML Simplification**
  - [ ] Update `workflows/feature.yml`
  - [ ] Update `workflows/hotfix.yml`
  - [ ] Update `workflows/project-loop.yml`
  - [ ] Remove legacy step references
  - [ ] Standardize review patterns
  - **Status:** Not Started

- [ ] **Day 3: Code Cleanup**
  - [ ] Delete old integration tests
  - [ ] Remove `ReviewCoordinationSteps.ts` (if exists)
  - [ ] Remove legacy helpers
  - [ ] Update imports across codebase
  - **Status:** Not Started

- [ ] **Day 4: Documentation**
  - [ ] Update README.md
  - [ ] Update API documentation
  - [ ] Document migration notes
  - [ ] Archive old docs
  - **Status:** Not Started

- [ ] **Day 5: Production Deployment**
  - [ ] Deploy new dashboard backend (port 8080)
  - [ ] Deploy refactored workflow steps
  - [ ] Update configuration
  - [ ] Monitor for errors
  - **Status:** Not Started

**Final Verification:**
- [ ] Zero 422 "Unknown milestone" errors
- [ ] All review types working consistently
- [ ] Performance improvement (bulk operations)
- [ ] Clean codebase (no legacy references)

---

## Phase 7: Complete Dashboard Backend
**Timeline:** Week 9 (Dec 21 - Dec 27, 2025)  
**Goal:** Finish remaining dashboard endpoints, full production validation

### Tasks
- [ ] **Remaining Endpoints**
  - [ ] Milestone listing/filtering
  - [ ] Task status updates
  - [ ] Query/search endpoints
  - [ ] Project status endpoint
  - **Status:** Not Started

- [ ] **Production Monitoring**
  - [ ] Monitor error rates
  - [ ] Monitor performance
  - [ ] Validate all workflows end-to-end
  - **Status:** Not Started

- [ ] **Final Documentation**
  - [ ] Complete OpenAPI spec
  - [ ] Usage examples
  - [ ] Troubleshooting guide
  - **Status:** Not Started

---

## Success Criteria Tracking

### Dashboard Backend
- [ ] All 264+ existing tests pass with new backend
- [ ] Load test: 1000 tasks created in <1 second
- [ ] Zero 422 "Unknown milestone" errors in production
- [ ] Bulk sync endpoint reduces API calls by 90%+
- [ ] Dashboard backend can be extracted to separate repo

### Review Consolidation
- [ ] Single ReviewFailureService used by all review types
- [ ] QA, Code Review, Security Review use identical code paths
- [ ] Test suite reduced by 30%+ lines via consolidation
- [ ] YAML workflow under 300 lines (from 600+)
- [ ] Zero references to "legacy" in workflow code
- [ ] All review types handle PM responses consistently

---

## Risk Log

| Risk | Impact | Mitigation | Status |
|------|--------|------------|--------|
| User validation delays | High | Schedule regular checkpoints, async communication | Active |
| SQLite performance issues | Medium | Load test early, can migrate to PostgreSQL | Monitoring |
| Breaking workflows during migration | High | Feature flags, gradual rollout, git rollback plan | Planned |
| Losing functionality during refactor | Medium | Test-first approach, behavior tests capture all scenarios | Mitigated |
| Test rationalization uncovers conflicting requirements | Medium | User checkpoints at each test group | Active |

---

## Notes & Decisions

### Oct 19, 2025
- **Decision:** API design first, ignore legacy completely
- **Decision:** Test rationalization with user validation at EVERY checkpoint
- **Decision:** No refactoring until all 5 test groups validated
- **Reason:** Previous tactical fixes (milestone bugs) showed need for systemic solution
- **Approval:** Refactor plan approved, ready to start Phase 1

---

## Quick Status

| Phase | Status | Completion |
|-------|--------|------------|
| **Phase 1:** API Design | ⏳ Not Started | 0% |
| **Phase 2:** Backend Proof | ⏳ Not Started | 0% |
| **Phase 3:** Test Rationalization | ⏳ Not Started | 0% |
| **Phase 4:** Service Implementation | ⏳ Not Started | 0% |
| **Phase 5:** Step Refactoring | ⏳ Not Started | 0% |
| **Phase 6:** Cleanup & Deploy | ⏳ Not Started | 0% |
| **Phase 7:** Complete Backend | ⏳ Not Started | 0% |

**Overall Progress:** 0% (0/7 phases complete)

---

## Legend
- ✅ Complete
- 🚧 In Progress
- ⏳ Not Started
- ❌ Blocked
- ⚠️ At Risk
