# Days 3-7 Migration Plan: task-flow.yaml Sub-Workflow Integration

**Goal:** Replace manual review failure handling in `legacy-compatible-task-flow.yaml` with sub-workflow calls

**Timeline:** Oct 28 - Nov 1, 2025 (5 days)

---

## 🎯 Migration Strategy

### Current State Analysis

The `legacy-compatible-task-flow.yaml` has **3 review failure handling patterns** that repeat:

1. **QA Failure Handling** (Steps: qa_failure_coordination, qa_iteration_loop)
   - Uses: QAFailureCoordinationStep, QAIterationLoopStep
   - Status: Uses specialized step types (NOT migrating - different pattern)

2. **Code Review Failure Handling** (Steps: pm_prioritize_code_review_failures, create_code_review_followup_tasks, mark_task_needs_rework_after_code_review)
   - PM prioritization → Task creation → Original task blocked
   - ✅ **CAN REPLACE** with review-failure-handling sub-workflow

3. **Security Review Failure Handling** (Steps: pm_prioritize_security_failures, create_security_review_followup_tasks, mark_task_security_blocked)
   - PM prioritization → Task creation → Original task blocked
   - ✅ **CAN REPLACE** with review-failure-handling sub-workflow

### Migration Scope

**MIGRATE (Code Review + Security Review):**
- Replace 6 steps with 2 SubWorkflowStep calls
- ~120 lines → ~40 lines (67% reduction)

**DO NOT MIGRATE (QA):**
- QA uses specialized iteration loop (QAIterationLoopStep)
- Different pattern (iterative fix-retest loop)
- Keep as-is for now

---

## 📋 Day-by-Day Plan

### Day 3 (Oct 28): Verify Missing Step Types ✅ ALREADY DONE
- [x] SimpleTaskStatusStep exists
- [x] GitOperationStep exists (multi-purpose)
- [x] git-operations.yaml updated to use GitOperationStep
- [ ] PersonaRequestStep exists (verify)

### Day 4 (Oct 29): Create task-flow.yaml from legacy-compatible

**Actions:**
1. Copy `legacy-compatible-task-flow.yaml` → `task-flow.yaml`
2. Update metadata (name, description, version)
3. Add comment explaining this is the new consolidated workflow

**No functional changes yet** - just renaming

### Day 5 (Oct 30): Replace Code Review Failure Handling

**Current (3 steps, ~40 lines):**
```yaml
- name: pm_prioritize_code_review_failures
  type: PersonaRequestStep
  # ... ~20 lines of PM prompt ...

- name: create_code_review_followup_tasks
  type: ReviewFailureTasksStep
  # ... task creation logic ...

- name: mark_task_needs_rework_after_code_review
  type: SimpleTaskStatusStep
  # ... mark blocked ...
```

**New (1 step, ~15 lines):**
```yaml
- name: handle_code_review_failure
  type: SubWorkflowStep
  description: "PM prioritization and task creation for code review failures"
  depends_on: ["code_review_request"]
  condition: "${code_review_request_status} == 'fail' || ${code_review_request_status} == 'unknown'"
  config:
    workflow: "review-failure-handling"
    inputs:
      review_type: "code_review"
      review_result: "${code_review_request_result}"
      review_status: "${code_review_request_status}"
      milestone_context: "${milestone}"
      task: "${task}"
      parent_task_id: "${taskId}"
      priority_scores:
        urgent: 1000
        deferred: 50
      config:
        block_original_task: true
      project_id: "${projectId}"
      repo: "${repo_remote}"
```

### Day 6 (Oct 31): Replace Security Review Failure Handling

**Current (3 steps, ~60 lines):**
```yaml
- name: pm_prioritize_security_failures
  type: PersonaRequestStep
  # ... ~40 lines of PM prompt ...

- name: create_security_review_followup_tasks
  type: ReviewFailureTasksStep
  # ... task creation logic ...

- name: mark_task_security_blocked
  type: SimpleTaskStatusStep
  # ... mark blocked ...
```

**New (1 step, ~15 lines):**
```yaml
- name: handle_security_failure
  type: SubWorkflowStep
  description: "PM prioritization and task creation for security failures"
  depends_on: ["security_request"]
  condition: "${security_request_status} == 'fail' || ${security_request_status} == 'unknown'"
  config:
    workflow: "review-failure-handling"
    inputs:
      review_type: "security_review"
      review_result: "${security_request_result}"
      review_status: "${security_request_status}"
      milestone_context: "${milestone}"
      task: "${task}"
      parent_task_id: "${taskId}"
      priority_scores:
        urgent: 1500  # Security higher priority than code review
        deferred: 50
      config:
        block_original_task: true
      project_id: "${projectId}"
      repo: "${repo_remote}"
```

### Day 7 (Nov 1): Testing and Cleanup

1. **Verify compilation:**
   ```bash
   npm run build
   ```

2. **Manual smoke test (if possible):**
   - Verify WorkflowEngine can load task-flow.yaml
   - Verify SubWorkflowStep can load review-failure-handling.yaml
   - Check for variable resolution errors

3. **Update REFACTOR_TRACKER.md:**
   - Mark Implementation Week 1 complete

4. **Commit all changes:**
   ```bash
   git add -A
   git commit -m "feat(workflow): migrate task-flow to use sub-workflows (Week 1 complete)"
   ```

---

## 📊 Impact Metrics

### Code Reduction
- **Before:** 6 steps, ~100 lines (code review + security)
- **After:** 2 steps, ~30 lines
- **Reduction:** 70% fewer lines

### Reusability
- `review-failure-handling.yaml` can now be used by:
  - Code review failures
  - Security review failures
  - Future: DevOps review failures
  - Future: Any persona review failures

### Maintainability
- PM prompts centralized in `prompts/pm-review-prioritization.txt`
- Single source of truth for review failure logic
- Easier to add new review types (just call sub-workflow)

---

## 🚧 Known Limitations

### Not Migrated in This Phase
1. **QA Failure Handling** - Uses specialized QAIterationLoopStep
2. **Implementation Step** - Not yet using task-implementation sub-workflow
3. **Git Operations** - Not yet using git-operations sub-workflow

**Reason:** Focus on proving sub-workflow pattern with review failures first

### Future Enhancements (Week 2)
- Migrate QA failure handling if possible
- Use task-implementation sub-workflow for developer work
- Use git-operations sub-workflow for commit/push
- Add DevOps review failure handling

---

## ✅ Success Criteria

Days 3-7 are complete when:
- [x] task-flow.yaml created and renamed
- [ ] Code review failure handling uses SubWorkflowStep
- [ ] Security review failure handling uses SubWorkflowStep
- [ ] All code compiles without errors
- [ ] REFACTOR_TRACKER.md updated
- [ ] Changes committed to git

---

## 📝 Notes

### Why Not Migrate QA Yet?
QA failure handling uses `QAIterationLoopStep` which:
- Iteratively fixes and retests (loop logic)
- Different pattern than code/security review (one-time evaluation)
- Would require significant refactoring of QAIterationLoopStep
- Better to migrate in Week 2 after proving sub-workflow pattern

### Why Not Use task-implementation Sub-Workflow?
The current implementation step uses:
- PersonaRequestStep (lead-engineer)
- DiffApplyStep (parse and apply edits)
- GitOperationStep (verify and publish)

This is already well-structured and working. Wrapping in a sub-workflow adds indirection without clear benefit yet. May revisit in Week 2.

### Variable Naming Convention
- Parent workflow uses: `${code_review_request_result}`
- Sub-workflow expects: `review_result`
- Mapping handled by SubWorkflowStep `inputs` config

---

## 🎓 Lessons to Capture

1. **Sub-workflows best for repeated patterns** - Code/security review failures are identical patterns
2. **Don't force sub-workflows everywhere** - QA and implementation have different needs
3. **Start with high-value targets** - Review failures are 100+ lines of duplicated logic
4. **Test incrementally** - Migrate one review type at a time

---

**Next:** Day 4 - Create task-flow.yaml from legacy-compatible
