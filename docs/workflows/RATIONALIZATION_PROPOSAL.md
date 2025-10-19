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

**Step 2.1: Feature Flag Setup (Day 1)**
- [ ] Add `use_sub_workflows` feature flag to config
- [ ] Default: `false` (use current implementation)
- [ ] Can toggle per-environment or per-task
- **Risk:** Low - Just configuration
- **Benefit:** Zero-downtime rollback if issues found

**Step 2.2: Create v2.0 Workflow (Day 1-2)**
- [ ] Copy `legacy-compatible-task-flow.yaml` → `legacy-compatible-task-flow-v2.yaml`
- [ ] Replace review failure steps with sub-workflow calls
- [ ] Replace implementation steps with task-implementation sub-workflow
- [ ] Replace git steps with git-operations sub-workflow
- [ ] Keep all other steps identical
- **Risk:** Low - Side-by-side implementation
- **Testing:** Can test v2 without affecting v1

**Step 2.3: Parallel Testing (Day 2-3)**
- [ ] Deploy v2 with feature flag OFF
- [ ] Run integration tests against v2
- [ ] Compare v1 vs v2 outputs for same tasks
- [ ] Verify all personas, reviews, status updates work
- **Risk:** Medium - Need to ensure parity
- **Success Criteria:** 100% feature parity with v1

**Step 2.4: Canary Rollout (Day 3-4)**
- [ ] Enable feature flag for 10% of tasks
- [ ] Monitor task completion, errors, timing
- [ ] Compare metrics: v1 vs v2
- [ ] If issues: disable flag, debug, fix
- [ ] If success: increase to 50%, then 100%
- **Risk:** Low - Can rollback instantly
- **Monitoring:** Task success rate, review pass rate, timing

**Step 2.5: Full Migration (Day 4-5)**
- [ ] Enable feature flag for 100% of tasks
- [ ] Monitor for 24 hours
- [ ] If stable: rename v2 → v1, archive old v1
- [ ] Remove feature flag code
- [ ] Update documentation
- **Risk:** Low - Already validated at 100%
- **Rollback:** Keep old v1 in archive for 1 week

**Deliverable:** Primary workflow using sub-workflows, 55% smaller, 100% feature parity

---

### Phase 3: Migrate Other Workflows (Optional, Post-Approval)
**Goal:** Apply sub-workflow pattern to conditional workflows

This phase can be done later (after Phase 0-2 complete) or in parallel with dashboard work.

**Step 3.1: Refactor in-review-task-flow.yaml**
- Use review-failure-handling sub-workflow
- Reduce from 195 → ~100 lines
- Timeline: 2 days

**Step 3.2: Refactor blocked-task-resolution.yaml**
- Use task-implementation sub-workflow
- Reduce from 215 → ~120 lines
- Timeline: 2 days

**Step 3.3: Create hotfix-task-flow.yaml**
- New workflow for expedited fixes
- Uses all 3 sub-workflows
- ~80 lines
- Timeline: 2 days

**Step 3.4: Archive Unused Workflows**
- Move 5 files to `/src/workflows/archive/`
- Delete 3 files from `/workflows/`
- Update documentation
- Timeline: 1 day

**Total Timeline:** 1 week (can be deferred)

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
  (empty - delete directory)

src/workflows/definitions/
  legacy-compatible-task-flow.yaml  (200 lines, primary - refactored)
  project-loop.yaml                 (87 lines, fallback - unchanged)
  in-review-task-flow.yaml          (100 lines, refactored)
  blocked-task-resolution.yaml      (120 lines, refactored)
  hotfix-task-flow.yaml             (80 lines, new)

src/workflows/sub-workflows/
  review-failure-handling.yaml      (50 lines, new)
  task-implementation.yaml          (60 lines, new)
  git-operations.yaml               (30 lines, new)

src/workflows/archive/
  legacy-compatible-task-flow-v1.yaml.bak  (446 lines, backup)
  code-review-followup.yaml                (150 lines, unused)
  qa-iteration.yaml                        (100 lines, unused)
  security-hardening.yaml                  (120 lines, unused)
  feature.yaml                             (108 lines, duplicate)
  hotfix.yaml                              (62 lines, duplicate)

prompts/
  pm-review-prioritization.txt      (new, externalized prompt)

Total: 5 core workflows + 3 sub-workflows = 8 active files, ~727 lines
Reduction: 1,840 → 727 lines (60% reduction)
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

### Instant Rollback (Feature Flag)
- **If:** Issues found during canary rollout
- **Action:** Set `use_sub_workflows: false` in config
- **Time:** <1 minute
- **Impact:** Zero - reverts to v1 workflow
- **Risk:** None - v1 remains unchanged

### Full Rollback (Git Revert)
- **If:** Critical issues after full migration
- **Action:** `git revert <commit>` to restore old workflow files
- **Time:** ~5 minutes
- **Impact:** Reverts to pre-sub-workflow state
- **Risk:** Low - clean git history

### Partial Rollback (Per-Workflow)
- **If:** One workflow has issues, others work
- **Action:** Revert specific workflow file, keep sub-workflows
- **Time:** ~2 minutes
- **Impact:** Isolated to affected workflow
- **Risk:** None - sub-workflows independent

### Data Rollback
- **Not Needed:** No database schema changes
- **Not Needed:** No task data format changes
- **Not Needed:** No milestone changes
- Sub-workflows only change execution flow, not data

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

### Phase 1: Implement Sub-Workflows (Week 1)
- Days 1-2: SubWorkflowStep + support steps
- Days 3-4: Create sub-workflow YAML files
- Days 4-5: Integration tests

### Phase 2: Migrate Primary Workflow (Week 2)
- Day 1: Feature flag + v2 creation
- Days 2-3: Parallel testing + canary rollout
- Days 4-5: Full migration + monitoring

### Phase 3: Other Workflows (Optional, Week 3)
- Days 1-2: in-review-task-flow
- Days 3-4: blocked-task-resolution + hotfix
- Day 5: Cleanup and archive

**Total Timeline:** 2 weeks (required), 3 weeks (complete)

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

### 1. Workflow Naming
- Keep `legacy-compatible-task-flow` name or rename?
  - **Option A:** Keep name (easy migration, but "legacy" is confusing)
  - **Option B:** Rename to `standard-task-flow` (clearer, but requires updates)
  - **Recommendation:** Keep name until Phase 6 cleanup

### 2. Archive vs Delete
- Move unused workflows to archive or delete entirely?
  - **Option A:** Archive (can reference later, but clutters repo)
  - **Option B:** Delete (clean, but loses history - though git preserves)
  - **Recommendation:** Archive for 1 release cycle, then delete

### 3. Feature Flag Duration
- How long to keep `use_sub_workflows` flag?
  - **Option A:** Remove after 1 week of stable v2 (fast cleanup)
  - **Option B:** Keep for 1 release cycle (safer rollback)
  - **Recommendation:** Keep for 2 weeks, remove in Phase 0 final cleanup

### 4. Sub-Workflow Versioning
- Should sub-workflows have version numbers?
  - **Option A:** No versioning (simpler, assume always compatible)
  - **Option B:** Version sub-workflows (explicit compatibility, more complex)
  - **Recommendation:** Start without, add later if needed

### 5. Phase 3 Priority
- Should we migrate conditional workflows immediately or defer?
  - **Option A:** Do Phase 3 immediately (complete consolidation)
  - **Option B:** Defer Phase 3 to after dashboard work (focus on critical path)
  - **Recommendation:** Defer - conditional workflows used <1% of time

---

## Approval Checklist

For **User Checkpoint #0**, please review and approve:

- [ ] **Workflow Consolidation:** 12 → 5 core + 3 sub-workflows
- [ ] **Code Reduction:** 60% reduction (1,840 → 727 lines)
- [ ] **File Structure:** Delete /workflows, create /sub-workflows, archive unused
- [ ] **Migration Strategy:** 2-week timeline with feature flag + canary
- [ ] **Sub-Workflow Designs:** review-failure-handling, task-implementation, git-operations
- [ ] **Breaking Changes:** Internal only (no user-facing changes)
- [ ] **Risk Assessment:** Medium risk items acceptable with mitigations
- [ ] **Success Metrics:** Code quality, performance, reliability, maintainability
- [ ] **Open Questions:** Decisions on naming, archiving, versioning

**If Approved:** Proceed to implement sub-workflows (Phase 1)  
**If Changes Needed:** Update proposal based on feedback  
**If Rejected:** Provide alternative approach or defer rationalization

---

## Next Steps After Approval

1. ✅ **Phase 0 Complete** - Mark Day 4 complete, prepare for checkpoint
2. 📋 **User Checkpoint #0** - Review and approve proposal (Day 5)
3. 🚀 **Begin Phase 1** - Dashboard API Design (uses rationalized workflow insights)
4. 🔧 **Parallel Track** - Start sub-workflow implementation (Week 2-3)
5. 🎯 **User Checkpoint #1** - Review dashboard API design

**Timeline Alignment:**
- Phase 0 complete: Oct 25, 2025 (end of Week 1)
- Phase 1 API design: Oct 26 - Nov 8 (Week 2-3)
- Sub-workflow implementation: Nov 2-15 (parallel with API design)
- Workflow migration: Nov 9-22 (after API design approved)

This ensures dashboard API requirements drive both API design AND workflow implementation.
