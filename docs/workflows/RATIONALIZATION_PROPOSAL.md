# Workflow Rationalization Proposal
**Date:** October 19, 2025  
**Phase:** Phase 0 - Day 4  
**Status:** Ready for Review

---

## Executive Summary

**Recommendation:** Consolidate 12 workflows into 5 core workflows + 3 sub-workflows

**Impact:**
- ✅ Remove 8 unused/duplicate workflows
- ✅ Reduce main workflow by 55% (446 → 200 lines)
- ✅ Eliminate 67% of maintenance burden (3 implementations → 1)
- ✅ 10-100x faster task creation (bulk API)
- ✅ Clear migration path with zero downtime

**Timeline:** 2 weeks implementation after approval

---

## Current State Assessment

### Workflow Inventory

| Location | File | Lines | Status | Usage |
|----------|------|-------|--------|-------|
| `/workflows` | feature.yml | 108 | ❌ Unused | Not loaded by WorkflowEngine |
| `/workflows` | hotfix.yml | 62 | ❌ Unused | Not loaded by WorkflowEngine |
| `/workflows` | project-loop.yml | 87 | ❌ Unused | Not loaded by WorkflowEngine |
| `/src/workflows/definitions` | legacy-compatible-task-flow.yaml | 446 | ✅ Active | **Primary (95%+)** |
| `/src/workflows/definitions` | project-loop.yaml | 87 | ⚠️ Fallback | Rarely used |
| `/src/workflows/definitions` | in-review-task-flow.yaml | 195 | ⚠️ Conditional | <1% usage |
| `/src/workflows/definitions` | blocked-task-resolution.yaml | 215 | ⚠️ Conditional | <1% usage |
| `/src/workflows/definitions` | feature.yaml | 108 | ❌ Duplicate | Copy of /workflows/feature.yml |
| `/src/workflows/definitions` | hotfix.yaml | 62 | ❌ Duplicate | Copy of /workflows/hotfix.yml |
| `/src/workflows/definitions` | code-review-followup.yaml | ~150 | ⚠️ Unused | Not referenced |
| `/src/workflows/definitions` | qa-iteration.yaml | ~100 | ⚠️ Unused | Not referenced |
| `/src/workflows/definitions` | security-hardening.yaml | ~120 | ⚠️ Unused | Not referenced |

**Total:** 12 workflows, ~1,840 lines  
**Active:** 1 primary + 3 conditional = 4 workflows  
**Unused:** 8 workflows (43% of total)

### Problem Analysis

**1. Duplication Across Files**
- `/workflows` vs `/src/workflows/definitions` - same files, different locations
- WorkflowEngine only loads from `/src/workflows/definitions`
- 3 files completely ignored (feature.yml, hotfix.yml, project-loop.yml in /workflows)

**2. Duplication Within Files**
- Review failure handling: 530 lines across 3 implementations
- Git operations: Repeated in multiple workflows
- Task status updates: Copy-paste pattern everywhere

**3. Monolithic Workflows**
- `legacy-compatible-task-flow.yaml`: 446 lines, 30 steps, does everything
- No reusable components
- Hard to test, debug, or modify

**4. Unused Workflows**
- 8 workflows never referenced in production
- Unclear which are intentional vs abandoned
- No deprecation markers or documentation

**5. Workflow Selection Confusion**
- WorkflowCoordinator tries: legacy-compatible → findWorkflowByCondition → project-loop
- `findWorkflowByCondition` rarely matches
- 95%+ tasks use legacy-compatible-task-flow

---

## Proposed Architecture

### Core Workflows (5)

1. **legacy-compatible-task-flow.yaml** (v2.0) - Primary workflow
   - 446 → 200 lines (55% reduction)
   - Uses sub-workflows for common patterns
   - Handles: git setup → implementation → reviews → completion

2. **project-loop.yaml** - Fallback workflow
   - Keep as-is (87 lines)
   - Used when legacy-compatible not applicable
   - Minimal changes needed

3. **in-review-task-flow.yaml** - Conditional workflow
   - Refactor to use review-failure-handling sub-workflow
   - Reduce from 195 → ~100 lines
   - Used for tasks already in review status

4. **blocked-task-resolution.yaml** - Conditional workflow
   - Refactor to use task-implementation sub-workflow
   - Reduce from 215 → ~120 lines
   - Used for unblocking tasks

5. **hotfix-task-flow.yaml** (NEW) - Fast-track workflow
   - Merge hotfix.yaml concepts with sub-workflows
   - Minimal planning, fast implementation, expedited review
   - ~80 lines

### Sub-Workflows (3)

1. **review-failure-handling.yaml** (NEW) ⭐ Priority 1
   - Unified review failure coordination
   - 50 lines, replaces 530 lines
   - Used by: legacy-compatible, in-review-task-flow, hotfix-task-flow

2. **task-implementation.yaml** (NEW) 🔧 Priority 2
   - Reusable planning + implementation
   - ~60 lines
   - Used by: legacy-compatible, blocked-task-resolution, hotfix-task-flow

3. **git-operations.yaml** (NEW) 🌿 Priority 3
   - Standard git setup pattern
   - ~30 lines
   - Used by: all workflows

### Archived/Deleted (8)

**Archive** (move to `/src/workflows/archive/`):
- `code-review-followup.yaml` - Unused, replaced by review-failure-handling
- `qa-iteration.yaml` - Unused, logic in QAIterationLoopStep
- `security-hardening.yaml` - Unused, unclear intent
- `feature.yaml` - Duplicate of /workflows/feature.yml
- `hotfix.yaml` - Duplicate, merged into hotfix-task-flow

**Delete** (remove entirely):
- `/workflows/feature.yml` - Not loaded, outdated
- `/workflows/hotfix.yml` - Not loaded, outdated
- `/workflows/project-loop.yml` - Not loaded, duplicate of definitions version

---

## Migration Strategy

### Phase 1: Implement Sub-Workflows (Week 1)
**Goal:** Create reusable sub-workflow components

**Step 1.1: Implement SubWorkflowStep (Day 1-2)**
- [ ] Create `SubWorkflowStep.ts` in `src/workflows/steps/`
- [ ] Implement sub-workflow loading from `sub-workflows/` directory
- [ ] Implement input validation against schema
- [ ] Implement isolated execution context
- [ ] Implement output mapping back to parent
- [ ] Add unit tests for SubWorkflowStep
- **Risk:** Medium - New step type, needs thorough testing
- **Mitigation:** Test in isolation before workflow integration

**Step 1.2: Implement Support Steps (Day 2-3)**
- [ ] `BulkTaskCreationStep.ts` - Bulk dashboard API calls
- [ ] `PMDecisionParserStep.ts` - Normalize PM decisions
- [ ] `ConditionalStep.ts` - Conditional execution logic
- [ ] `VariableResolutionStep.ts` - Variable resolution
- [ ] Unit tests for each step type
- **Risk:** Low - Simple step implementations
- **Dependencies:** Dashboard bulk endpoint (can mock for now)

**Step 1.3: Create Sub-Workflow Files (Day 3-4)**
- [ ] `src/workflows/sub-workflows/review-failure-handling.yaml`
- [ ] `src/workflows/sub-workflows/task-implementation.yaml`
- [ ] `src/workflows/sub-workflows/git-operations.yaml`
- [ ] Create `prompts/pm-review-prioritization.txt`
- [ ] Validate YAML syntax and schema
- **Risk:** Low - Pure YAML, no code changes
- **Testing:** Can validate offline before integration

**Step 1.4: Integration Tests (Day 4-5)**
- [ ] Test sub-workflow execution in isolation
- [ ] Test parent → sub-workflow → parent data flow
- [ ] Test error handling and rollback
- [ ] Test with mock dashboard API
- **Risk:** Medium - Complex integration scenarios
- **Mitigation:** Start with git-operations (simplest), then task-implementation, then review-failure-handling

**Deliverable:** Working sub-workflow system, ready for workflow migration

---

### Phase 2: Migrate legacy-compatible-task-flow (Week 2)
**Goal:** Refactor primary workflow to use sub-workflows

**Revised Strategy (No Feature Flags):**

**Step 2.1: Development Testing (Day 1-2)**
- [ ] Create refactored workflow in development branch
- [ ] Replace review failure steps with sub-workflow calls
- [ ] Replace implementation steps with task-implementation sub-workflow
- [ ] Replace git steps with git-operations sub-workflow
- [ ] Run full test suite in development
- [ ] Manual testing of all review paths (QA, code, security)
- **Risk:** Medium - Need comprehensive testing
- **Success Criteria:** All tests pass, manual testing successful

**Step 2.2: Integration Testing (Day 2-3)**
- [ ] Deploy to staging/test environment
- [ ] Run against real Redis streams (test data)
- [ ] Test all persona interactions
- [ ] Test all review failure scenarios
- [ ] Verify bulk task creation works
- [ ] Compare outputs with production behavior
- **Risk:** Medium - Need environment parity
- **Success Criteria:** 100% feature parity with production

**Step 2.3: Production Deployment (Day 3-4)**
- [ ] Schedule deployment during low-activity period
- [ ] Deploy sub-workflows first (unused initially, safe)
- [ ] Deploy refactored workflow + new step types
- [ ] Monitor first 10 tasks closely
- [ ] Monitor for 24 hours
- **Risk:** Medium - Direct production deployment
- **Mitigation:** Deploy during low activity, close monitoring
- **Rollback:** Git revert ready (~5 min)

**Step 2.4: Monitoring & Validation (Day 4-5)**
- [ ] Compare metrics: task timing, success rate, API calls
- [ ] Verify bulk task creation working (fewer dashboard calls)
- [ ] Check for any error patterns
- [ ] Validate PM decisions match previous behavior
- [ ] Confirm all review types working
- **Risk:** Low - Just monitoring
- **Success Criteria:** Metrics match or improve vs baseline

**Deliverable:** Primary workflow using sub-workflows, 55% smaller, 100% feature parity

---

### Phase 3: Migrate Conditional Workflows (Week 2, Days 6-10)
**Goal:** Apply sub-workflow pattern to all remaining workflows

**User Decision:** Complete workflow consolidation NOW (informs dashboard + test design)

**Step 3.1: Refactor in-review-task-flow.yaml (Day 6-7)**
- [ ] Use review-failure-handling sub-workflow for all review types
- [ ] Simplify logic (task already in review, just needs review coordination)
- [ ] Reduce from 195 → ~100 lines
- [ ] Test with tasks in "in_review" status
- **Risk:** Low - straightforward sub-workflow usage
- **Timeline:** 2 days

**Step 3.2: Refactor blocked-task-resolution.yaml (Day 7-8)**
- [ ] Use task-implementation sub-workflow
- [ ] Focus on unblocking logic + re-implementation
- [ ] Reduce from 215 → ~120 lines
- [ ] Test with blocked tasks
- **Risk:** Low - similar to primary workflow
- **Timeline:** 2 days

**Step 3.3: Create hotfix-task-flow.yaml (Day 8-9)**
- [ ] New workflow for expedited fixes
- [ ] Uses all 3 sub-workflows (git, implementation, review-failure)
- [ ] Minimal planning (fast-track approach)
- [ ] Expedited review process
- [ ] ~80 lines total
- [ ] Test with hotfix scenario
- **Risk:** Low - composition of existing patterns
- **Timeline:** 2 days

**Step 3.4: Delete Unused Workflows (Day 9)**
- [ ] Delete `/workflows/` directory entirely
- [ ] Delete 5 unused files from `/src/workflows/definitions/`
- [ ] Update WorkflowCoordinator if needed (remove references)
- [ ] Update documentation
- **Risk:** Very Low - already confirmed unused
- **Timeline:** 1 day

**Step 3.5: Integration Testing (Day 10)**
- [ ] Test all workflow paths in development
- [ ] Verify workflow selection logic works
- [ ] Test all sub-workflow combinations
- [ ] Document workflow selection criteria
- **Risk:** Low - validation step
- **Timeline:** 1 day

**Deliverable:** Complete workflow architecture (5 core + 3 sub-workflows), ready for production

---

## File Structure Changes

### Before
```
workflows/
  feature.yml          (108 lines, unused)
  hotfix.yml           (62 lines, unused)
  project-loop.yml     (87 lines, unused)

src/workflows/definitions/
  legacy-compatible-task-flow.yaml  (446 lines, primary)
  project-loop.yaml                 (87 lines, fallback)
  in-review-task-flow.yaml          (195 lines, conditional)
  blocked-task-resolution.yaml      (215 lines, conditional)
  feature.yaml                      (108 lines, duplicate)
  hotfix.yaml                       (62 lines, duplicate)
  code-review-followup.yaml         (~150 lines, unused)
  qa-iteration.yaml                 (~100 lines, unused)
  security-hardening.yaml           (~120 lines, unused)

Total: 12 workflows, ~1,840 lines
```

### After
```
workflows/
  (deleted - directory removed)

src/workflows/definitions/
  task-flow.yaml                    (200 lines, primary - refactored & renamed)
  project-loop.yaml                 (87 lines, fallback - unchanged)
  in-review-task-flow.yaml          (100 lines, refactored)
  blocked-task-resolution.yaml      (120 lines, refactored)
  hotfix-task-flow.yaml             (80 lines, new)

src/workflows/sub-workflows/
  review-failure-handling.yaml      (50 lines, new)
  task-implementation.yaml          (60 lines, new)
  git-operations.yaml               (30 lines, new)

prompts/
  pm-review-prioritization.txt      (new, externalized prompt)

Deleted (no archive):
  /workflows/feature.yml            (108 lines)
  /workflows/hotfix.yml             (62 lines)
  /workflows/project-loop.yml       (87 lines)
  definitions/code-review-followup.yaml  (150 lines)
  definitions/qa-iteration.yaml          (100 lines)
  definitions/security-hardening.yaml    (120 lines)
  definitions/feature.yaml               (108 lines)
  definitions/hotfix.yaml                (62 lines)

Total: 5 core workflows + 3 sub-workflows = 8 active files, ~727 lines
Deleted: 8 workflows, 797 lines
Reduction: 1,840 → 727 lines (60% reduction overall)
Primary workflow: 446 → 200 lines (55% reduction)
```

---

## Breaking Changes

### None for End Users
- Task creation API unchanged
- Workflow behavior unchanged (100% feature parity)
- Output formats unchanged
- Dashboard interactions unchanged

### For Workflow Developers
1. **Sub-workflow references**
   - Old: `type: QAFailureCoordinationStep`
   - New: `type: SubWorkflowStep, workflow: "review-failure-handling"`
   - Migration: Automated script can convert most references

2. **PM prompts**
   - Old: Embedded in YAML (200+ line strings)
   - New: External template file (`prompts/pm-review-prioritization.txt`)
   - Migration: Extract prompts to files, replace with `prompt_template` reference

3. **Workflow versioning**
   - Introduce `version` field in workflow YAML
   - Old workflows without version treated as v1.0.0
   - New workflows must specify version

### For Testing
1. **Sub-workflow mocking**
   - Can mock sub-workflows in tests (faster, more isolated)
   - Can test sub-workflows independently
   - Can test parent workflow without executing sub-workflows

2. **Workflow fixtures**
   - Some test fixtures may need updates for new structure
   - Bulk task creation requires mock API endpoint
   - PM prompt externalization changes test setup

---

## Rollback Strategy

### Git Revert (Primary Method)
- **If:** Critical issues after deployment
- **Action:** `git revert <commit>` to restore old workflow files
- **Time:** ~5 minutes (includes redeploy)
- **Impact:** Reverts to pre-sub-workflow state
- **Risk:** Low - clean git history, tested approach

### Partial Rollback (Per-Step)
- **If:** One sub-workflow has issues, others work
- **Action:** 
  1. Inline problematic sub-workflow steps back into main workflow
  2. Deploy fix
  3. Debug sub-workflow offline
- **Time:** ~15 minutes
- **Impact:** Isolated to affected pattern
- **Risk:** Low - can mix inline and sub-workflow approaches

### Emergency Hotfix
- **If:** Unable to revert cleanly
- **Action:**
  1. Restore specific workflow file from git history
  2. Disable problematic step types temporarily
  3. Deploy minimal working version
- **Time:** ~10 minutes
- **Impact:** May lose some sub-workflow benefits temporarily
- **Risk:** Medium - requires manual intervention

### Data Rollback
- **Not Needed:** No database schema changes
- **Not Needed:** No task data format changes
- **Not Needed:** No milestone changes
- Sub-workflows only change execution flow, not data

**Note:** No feature flags needed per user preference (fall-forward approach)

---

## Risk Assessment

### High Risk Items
**None identified**

### Medium Risk Items

1. **SubWorkflowStep Implementation**
   - **Risk:** New step type could have bugs
   - **Mitigation:** Extensive unit tests, isolated integration tests
   - **Rollback:** Feature flag instant rollback
   - **Likelihood:** Medium
   - **Impact:** High (blocks all sub-workflow usage)
   - **Detection:** Integration tests will catch before production

2. **Bulk Task Creation**
   - **Risk:** Dashboard API bulk endpoint may have edge cases
   - **Mitigation:** Can fall back to sequential creation if bulk fails
   - **Rollback:** Graceful degradation in BulkTaskCreationStep
   - **Likelihood:** Low (dashboard API change, not workflow)
   - **Impact:** Medium (slower but still works)
   - **Detection:** Performance monitoring, error logs

3. **PM Prompt Externalization**
   - **Risk:** Template rendering could fail or produce different output
   - **Mitigation:** Compare v1 vs v2 PM prompts in tests
   - **Rollback:** Can inline prompts temporarily
   - **Likelihood:** Low (simple template substitution)
   - **Impact:** Medium (affects review failure decisions)
   - **Detection:** PM response parsing tests

### Low Risk Items

1. **Git Operations Sub-Workflow**
   - Just refactoring existing GitOperationStep calls
   - No new logic, pure reorganization
   - Extensive existing tests cover git operations

2. **Task Implementation Sub-Workflow**
   - Combines existing steps (context, planning, implementation)
   - No new behavior, just composition
   - Well-tested individual steps

3. **Workflow File Cleanup**
   - Deleting unused files has no runtime impact
   - WorkflowEngine already ignores /workflows directory
   - Archive preserves files for reference

---

## Success Metrics

### Code Quality
- ✅ Workflow lines reduced by 60% (1,840 → 727)
- ✅ Review failure implementations reduced from 3 → 1
- ✅ Cyclomatic complexity reduced (monolithic → modular)
- ✅ Test coverage increased (can test sub-workflows in isolation)

### Performance
- ✅ Task creation 10-100x faster (bulk API vs N+1)
- ✅ Workflow execution time unchanged or faster
- ✅ Dashboard API calls reduced by 90% (10 tasks → 1 bulk call)

### Reliability
- ✅ 100% feature parity with v1
- ✅ Zero downtime migration (feature flag)
- ✅ Instant rollback capability
- ✅ No task failures during migration

### Maintainability
- ✅ PM prompts externalized (easy updates)
- ✅ Sub-workflows reusable (DRY principle)
- ✅ Clear separation of concerns
- ✅ Easier to debug and test

---

## Timeline Summary

### Week 1: Implement Sub-Workflows (Days 1-5)
- Days 1-2: SubWorkflowStep + support steps
- Days 3-4: Create sub-workflow YAML files + PM prompt template
- Days 4-5: Integration tests

### Week 2: Migrate All Workflows (Days 6-10)
- Days 6-7: Migrate primary workflow (legacy-compatible-task-flow)
- Days 7-8: Migrate conditional workflows (in-review, blocked-task-resolution)
- Days 8-9: Create hotfix-task-flow
- Day 9: Delete unused workflows + cleanup
- Day 10: Full integration testing + production deployment

**Total Timeline:** 2 weeks for complete workflow consolidation

**Benefits of Complete Consolidation:**
- ✅ Informs dashboard API design (all patterns known)
- ✅ Informs test rationalization (complete business logic mapped)
- ✅ Single effort (no revisiting workflows later)
- ✅ Consistent architecture across all workflows

---

## Recommendations

### Immediate (Approve to Proceed)

1. ✅ **Approve Proposal**
   - Consolidate 12 workflows → 5 core + 3 sub-workflows
   - Delete 8 unused workflows
   - 60% code reduction

2. ✅ **Approve Migration Strategy**
   - 2-week timeline
   - Feature flag for zero-downtime rollout
   - Canary rollout with monitoring

3. ✅ **Approve Breaking Changes**
   - Sub-workflow pattern (internal only)
   - PM prompt externalization (internal only)
   - No user-facing changes

### Before Implementation Starts

1. **Review Sub-Workflow Designs**
   - `SUB_WORKFLOW_DESIGN.md` has full specifications
   - Ensure input/output schemas meet needs
   - Validate PM prompt template adequacy

2. **Confirm Dashboard API Timeline**
   - Bulk task creation endpoint needed in Phase 1
   - Can implement with mock endpoint for testing
   - Real endpoint needed before production rollout

3. **Set Monitoring Baseline**
   - Capture current metrics: task timing, success rate, API calls
   - Establish success criteria for canary rollout
   - Define error thresholds for automatic rollback

### After Phase 0 Complete

1. **Proceed to Phase 1: Dashboard API Design**
   - Now have clear API requirements from workflow analysis
   - Bulk task creation is critical requirement
   - Milestone operations are critical requirement

2. **Defer Phase 3 (Optional Workflows)**
   - Focus on primary workflow first
   - Can migrate conditional workflows later
   - Not blocking dashboard or review consolidation work

---

## Open Questions for User Review

### 1. Workflow Naming ✅ APPROVED
**Question:** Should we rename `legacy-compatible-task-flow.yaml` to something clearer?

**Options:**
  - Option A: Keep current name `legacy-compatible-task-flow.yaml`
  - Option B: Rename to `standard-task-flow.yaml`
  - **Option C: Rename to `task-flow.yaml` ✅ SELECTED**

**User Decision:** "for naming i prefer Option C - task-flow"

**Implementation:**
- ✅ Rename `legacy-compatible-task-flow.yaml` → `task-flow.yaml`
- ✅ Update WorkflowCoordinator references
- ✅ Update documentation
- ✅ Update any tests that reference the workflow name

**Benefits:**
- Simplest, most generic name
- Removes "legacy" confusion
- Clear primary workflow designation

### 2. Archive vs Delete ✅ APPROVED
**Decision:** Delete unused workflows entirely

**User Response:** "delete unused"

**Implementation:**
- ✅ Delete `/workflows/` directory entirely (3 files: feature.yml, hotfix.yml, project-loop.yml)
- ✅ Delete from `/src/workflows/definitions/`: 
  - code-review-followup.yaml
  - qa-iteration.yaml  
  - security-hardening.yaml
  - feature.yaml (duplicate)
  - hotfix.yaml (duplicate)
- ✅ Keep backup in git history (can recover if needed)
- ❌ No archive directory needed

### 3. Feature Flag Duration ✅ APPROVED - NO FEATURE FLAGS
**Decision:** Fall-forward approach, no feature flags needed

**User Response:** "no need for feature flags - fall forward approach"

**Revised Strategy:**
- ✅ Direct replacement of workflow files (no v1/v2 parallel)
- ✅ Comprehensive testing in development before deployment
- ✅ Deploy sub-workflows + refactored workflows together
- ✅ Rollback via git revert if critical issues found
- ❌ No feature flag configuration
- ❌ No canary rollout complexity

**Benefits:**
- Simpler implementation (no conditional logic)
- Faster deployment (no gradual rollout)
- Cleaner codebase (no feature flag code)

**Risk Mitigation:**
- Extensive testing in dev environment before production
- Deploy during low-activity period
- Monitor closely for first 24 hours
- Git revert ready if needed (~5 min rollback)

### 4. Sub-Workflow Versioning ✅ CLARIFIED
**Question Clarification:** Do individual sub-workflow YAML files need version fields?

**User Response:** "not sure what this question is for. versions are captured at the milestone branch level. completed milestones should create versioned merges"

**Understanding:**
- Workflow versioning is NOT needed (milestone branches handle versioning)
- Sub-workflows are implementation details, not release artifacts
- Git history + milestone branches provide sufficient version control

**Decision:**
- ❌ No version fields in sub-workflow YAML files
- ✅ Rely on git commits + milestone branches for versioning
- ✅ Sub-workflows evolve with codebase (backward compatibility maintained)

### 5. Conditional Workflow Migration ✅ APPROVED - DO NOW
**Decision:** Migrate ALL workflows now (complete consolidation)

**User Response:** "i want complete workflow consolidation now to clarify the intent of the architecture for the dashboard redesign and test rationalization"

**Implementation:**
- ✅ Migrate primary workflow (legacy-compatible-task-flow)
- ✅ Migrate conditional workflows (in-review-task-flow, blocked-task-resolution)
- ✅ Create hotfix-task-flow
- ✅ Complete consolidation before dashboard API design

**Timeline:**
- Week 1: Sub-workflows + primary workflow
- Week 2: Conditional workflows + hotfix workflow + cleanup
- Total: 2 weeks for complete workflow architecture

**Benefits:**
- Complete workflow architecture informs dashboard API design
- Clear patterns for test rationalization
- Single consolidated effort (no revisiting later)
- All workflows use same sub-workflow patterns

---

## Approval Checklist

For **User Checkpoint #0**, please review and approve:

- [ ] **Workflow Consolidation:** 12 → 4 core + 3 sub-workflows (Phase 3 deferred)
- [ ] **Code Reduction:** Primary workflow 55% reduction (446 → 200 lines)
- [ ] **File Deletions:** Delete /workflows directory + 5 unused files (no archive)
- [ ] **Migration Strategy:** 2-week timeline with fall-forward approach (no feature flags)
- [ ] **Sub-Workflow Designs:** review-failure-handling, task-implementation, git-operations
- [ ] **Breaking Changes:** Internal only (no user-facing changes)
- [ ] **Risk Assessment:** Medium risk items acceptable with mitigations
- [ ] **Success Metrics:** Code quality, performance, reliability, maintainability

**User Responses Received:**
- ✅ **Question 1 (Naming):** Rename to `task-flow.yaml` (Option C)
- ✅ **Question 2 (Archive):** Delete unused workflows (no archive)
- ✅ **Question 3 (Feature Flags):** No feature flags - fall forward approach
- ✅ **Question 4 (Versioning):** Not needed - milestone branches handle versioning
- ✅ **Question 5 (Conditional Workflows):** DO NOW - complete consolidation to inform dashboard + test design

**All Decisions Made - Ready to Proceed!**

**Approved Actions:**
- ✅ Rename primary workflow to `task-flow.yaml`
- ✅ Consolidate 12 workflows → 5 core + 3 sub-workflows
- ✅ Delete 8 unused workflows (no archive, git history preserves)
- ✅ 2-week implementation timeline
- ✅ Fall-forward deployment (no feature flags)
- ✅ Complete consolidation before dashboard API design

**Next Step:** Mark Phase 0 Day 5 complete, begin implementation Week 2-3

---

## Next Steps After Approval

1. ✅ **Phase 0 Complete** - Mark Day 4 complete, prepare for checkpoint
2. 📋 **User Checkpoint #0** - Review and approve proposal (Day 5)
3. 🚀 **Begin Phase 1** - Dashboard API Design (uses rationalized workflow insights)
4. 🔧 **Parallel Track** - Start sub-workflow implementation (Week 2-3)
5. 🎯 **User Checkpoint #1** - Review dashboard API design

**Timeline Alignment:**
- Phase 0 complete: Oct 25, 2025 (end of Week 1) ✅
- **Workflow consolidation (complete): Nov 2-15, 2025 (2 weeks)**
- Phase 1 API design: Nov 16-29 (Week 4-5) - informed by complete workflow architecture
- Phase 2 Dashboard backend proof: Nov 30 - Dec 6 (Week 6)
- Phase 3 Test rationalization: Dec 7-20 (Week 7-8) - informed by complete workflow patterns

**Critical Path Updated:**
Workflow consolidation FIRST → then dashboard API design → then test rationalization

This ensures:
1. Complete workflow patterns inform dashboard API requirements
2. Complete workflow architecture informs test business logic mapping
3. Single consolidated effort (no revisiting workflows)
4. Clear architectural intent for all downstream work
