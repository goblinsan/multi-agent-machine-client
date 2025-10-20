# Phase 4 Day 4: Idempotency (external_id) + PM Prompt Updates - COMPLETE ✅

## Overview
Enhanced `BulkTaskCreationStep` with automatic external_id generation for idempotent task creation. Updated PM prompt to remove deprecated `backlog` field and document priority level routing.

---

## Changes Summary

### Files Modified

#### 1. `src/workflows/steps/BulkTaskCreationStep.ts`
- **Before:** 708 lines
- **After:** 787 lines
- **Added:** +79 lines (~11% increase)

**Key Additions:**

##### Automatic external_id Generation
```typescript
/**
 * Generate default external ID for idempotency
 * Format: ${workflow_run_id}:${step_name}:${task_index}
 * 
 * Example: "wf-550e8400-e29b:create_tasks_bulk:0"
 */
private generateDefaultExternalId(task: TaskToCreate, taskIndex: number): string {
  const workflowRunId = (this.config.config as any).workflow_run_id || 'unknown';
  const stepName = this.config.name;
  
  return `${workflowRunId}:${stepName}:${taskIndex}`;
}
```

**Behavior:**
- If `upsert_by_external_id: true` and no `external_id` provided → auto-generates
- Format: `${workflow_run_id}:${step_name}:${task_index}`
- Enables safe workflow re-runs (same external_id = same task)

##### Enhanced Template Variables
```typescript
/**
 * Available template variables:
 * - ${workflow_run_id} - Unique workflow execution ID
 * - ${step_name} - Name of the current step
 * - ${task_index} - Index of task in array (0-based)
 * - ${task.title_slug} - Slugified task title
 * - ${task.title} - Original task title
 * - ${task.priority} - Task priority (critical, high, medium, low)
 * - ${task.milestone_slug} - Milestone slug if set
 */
```

**Custom Template Example:**
```yaml
options:
  external_id_template: "${workflow_run_id}:${step_name}:${task_index}"
  # Result: "wf-550e8400-e29b:create_tasks_bulk:0"
```

##### Configuration Updates
```typescript
interface BulkTaskCreationConfig {
  workflow_run_id?: string;  // NEW: For idempotency
  options?: {
    upsert_by_external_id?: boolean;  // Enable idempotent task creation
    external_id_template?: string;    // Custom template or auto-generate
    // ... existing options
  };
}
```

##### Enhanced Documentation
- Added comprehensive JSDoc with idempotency, priority routing, duplicate detection, and retry logic
- Documented all template variables
- Added YAML configuration example with all Phase 4 features

#### 2. `src/workflows/prompts/pm-review-prioritization.txt`
- **Before:** 162 lines
- **After:** 176 lines
- **Added:** +14 lines (~9% increase)

**Key Changes:**

##### Removed Deprecated `backlog` Field
```diff
- "backlog": [ ... ]  // DEPRECATED
+ // Use ONLY follow_up_tasks array
```

**Migration:**
- Old format had both `backlog` and `follow_up_tasks` arrays
- New format uses only `follow_up_tasks` with priority levels
- System automatically routes based on priority (critical/high → immediate, medium/low → deferred)

##### Added Priority Level Guidelines
```markdown
## Priority Level Guidelines

- **critical:** Blocks all work (security, crashes, data loss)
  - → immediate milestone (score: 1500)
  
- **high:** Blocks current milestone (test failures, broken functionality)
  - → immediate milestone (score: 1200 for QA, 1000 for others)
  
- **medium:** Important but can wait (technical debt, minor bugs)
  - → deferred milestone (score: 800)
  
- **low:** Nice to have (code style, documentation)
  - → deferred milestone (score: 50)
```

##### Updated Output Format
```json
{
  "decision": "immediate_fix" | "defer",
  "reasoning": "...",
  "immediate_issues": ["issue1", "issue2"],
  "deferred_issues": ["issue3", "issue4"],
  "follow_up_tasks": [
    {
      "title": "...",
      "description": "...",
      "priority": "critical | high | medium | low",  // NEW: Maps to milestone
      "estimated_effort": "small | medium | large",
      "is_duplicate": false,
      "duplicate_of_task_id": null,
      "skip_reason": null
    }
  ]
}
```

**Key Improvements:**
- Explicit priority → milestone mapping documented
- Removed confusion about `backlog` vs `follow_up_tasks`
- Clearer severity guidelines for PM decision-making
- Auto-routing based on priority (no manual milestone assignment)

---

## Feature Details

### 1. Idempotency via external_id

**Purpose:** Enable safe workflow re-runs without creating duplicate tasks.

**How it Works:**
1. Workflow starts with unique `workflow_run_id`
2. BulkTaskCreationStep generates `external_id` for each task
3. Format: `${workflow_run_id}:${step_name}:${task_index}`
4. Dashboard checks `external_id` before creating task
5. If `external_id` exists → skip (idempotent)
6. If new → create task

**Configuration:**
```yaml
- name: create_tasks_bulk
  type: BulkTaskCreationStep
  config:
    project_id: "${project_id}"
    workflow_run_id: "${workflow_run_id}"  # From WorkflowEngine
    tasks: "${follow_up_tasks}"
    options:
      upsert_by_external_id: true  # Enable idempotency
```

**Default Format:**
- `wf-550e8400-e29b:create_tasks_bulk:0`
- `wf-550e8400-e29b:create_tasks_bulk:1`
- `wf-550e8400-e29b:create_tasks_bulk:2`

**Custom Template:**
```yaml
options:
  external_id_template: "${workflow_run_id}:qa:${task.priority}:${task_index}"
  # Result: "wf-550e8400-e29b:qa:high:0"
```

**Benefits:**
- ✅ Safe to re-run failed workflows
- ✅ No duplicate tasks on retry
- ✅ Predictable external_ids for debugging
- ✅ Works with dashboard bulk upsert endpoint

### 2. PM Prompt Consolidation

**Purpose:** Remove deprecated `backlog` field, clarify priority-based routing.

**Before (Ambiguous):**
```json
{
  "backlog": ["task1", "task2"],  // Which milestone?
  "follow_up_tasks": [...]         // Which milestone?
}
```

**After (Clear):**
```json
{
  "follow_up_tasks": [
    {
      "title": "Fix critical security bug",
      "priority": "critical",  // → immediate milestone (1500)
    },
    {
      "title": "Refactor legacy code",
      "priority": "medium",    // → deferred milestone (800)
    }
  ]
}
```

**Routing Logic:**
- `critical` / `high` → urgent milestone (immediate)
- `medium` / `low` → deferred milestone (future-enhancements)
- System handles routing automatically based on `priority` field

**Priority Score Mapping:**
| Priority  | Score | Milestone  | Use Case |
|-----------|-------|------------|----------|
| critical  | 1500  | immediate  | Security, crashes, data loss |
| high      | 1200* | immediate  | Test failures, broken features |
| medium    | 800   | deferred   | Technical debt, minor bugs |
| low       | 50    | deferred   | Code style, documentation |

*Note: QA high = 1200, others high = 1000

---

## Testing Scenarios

### Idempotency Tests

1. **Successful Workflow Re-run**
   - Run workflow: creates 5 tasks with external_ids
   - Re-run same workflow: 0 new tasks (all external_ids match)
   - Expected: Tasks already exist, skipped via external_id

2. **Partial Failure Recovery**
   - Run workflow: 3 tasks created, 2 failed
   - Re-run workflow: Only 2 new tasks created (3 already exist via external_id)
   - Expected: Idempotent recovery, no duplicates

3. **Different Workflow Runs**
   - Run workflow A: creates 5 tasks (workflow_run_id = wf-abc)
   - Run workflow B: creates 5 tasks (workflow_run_id = wf-xyz)
   - Expected: 10 total tasks (different external_ids)

4. **Custom Template**
   - Template: `"${workflow_run_id}:${task.priority}:${task_index}"`
   - Task 0 (high): `"wf-abc:high:0"`
   - Task 1 (medium): `"wf-abc:medium:1"`
   - Expected: Priority-based external_ids

### PM Prompt Tests

1. **Critical Priority → Immediate Milestone**
   - Input: Review failure with security vulnerability
   - PM Output: `priority: "critical"`
   - Expected: Task routed to immediate milestone (score: 1500)

2. **Medium Priority → Deferred Milestone**
   - Input: Review failure with code smell
   - PM Output: `priority: "medium"`
   - Expected: Task routed to deferred milestone (score: 800)

3. **No Backlog Field**
   - PM Output: Only `follow_up_tasks` array (no `backlog`)
   - Expected: PMDecisionParserStep handles merge (backward compat)

4. **Priority Guidelines Followed**
   - Test failure → `high` priority (blocks milestone)
   - Documentation issue → `low` priority (nice to have)
   - Expected: PM follows documented guidelines

---

## Configuration Examples

### Minimal (Auto-generate external_id)
```yaml
- name: create_tasks_bulk
  type: BulkTaskCreationStep
  config:
    project_id: "${project_id}"
    workflow_run_id: "${workflow_run_id}"
    tasks: "${follow_up_tasks}"
    options:
      upsert_by_external_id: true  # Auto-generates external_id
```

### Custom Template (Priority-based)
```yaml
- name: create_tasks_bulk
  type: BulkTaskCreationStep
  config:
    project_id: "${project_id}"
    workflow_run_id: "${workflow_run_id}"
    tasks: "${follow_up_tasks}"
    options:
      upsert_by_external_id: true
      external_id_template: "${workflow_run_id}:${task.priority}:${task_index}"
```

### Full Configuration (All Phase 4 Features)
```yaml
- name: create_tasks_bulk
  type: BulkTaskCreationStep
  config:
    project_id: "${project_id}"
    workflow_run_id: "${workflow_run_id}"
    tasks: "${follow_up_tasks}"
    priority_mapping:
      critical: 1500
      high: 1200
      medium: 800
      low: 50
    milestone_strategy:
      urgent: "${milestone_id}"
      deferred: "future-enhancements"
    retry:
      max_attempts: 3
      initial_delay_ms: 1000
      backoff_multiplier: 2
    options:
      upsert_by_external_id: true
      external_id_template: "${workflow_run_id}:${step_name}:${task_index}"
      check_duplicates: true
      duplicate_match_strategy: "external_id"
      abort_on_partial_failure: false
```

---

## Migration Guide

### For Workflow Authors

**Update workflow YAML to pass workflow_run_id:**
```yaml
# OLD
- name: create_tasks
  type: BulkTaskCreationStep
  config:
    project_id: "${project_id}"
    tasks: "${follow_up_tasks}"

# NEW
- name: create_tasks
  type: BulkTaskCreationStep
  config:
    project_id: "${project_id}"
    workflow_run_id: "${workflow_run_id}"  # ADD THIS
    tasks: "${follow_up_tasks}"
    options:
      upsert_by_external_id: true          # ADD THIS
```

### For PM Persona Prompts

**No migration needed!** Backward compatible:
- Old prompts may still include `backlog` field
- PMDecisionParserStep (Day 1) merges `backlog` + `follow_up_tasks`
- Warning logged but no error

**Recommended:** Update prompts to use only `follow_up_tasks` with `priority` field

---

## Metrics

### Code Changes
- **BulkTaskCreationStep:** 708 → 787 lines (+79 lines, +11%)
- **PM Prompt:** 162 → 176 lines (+14 lines, +9%)
- **Total:** +93 lines

### Feature Coverage
- ✅ Automatic external_id generation (default format)
- ✅ Custom external_id templates (7 template variables)
- ✅ Idempotent task creation (upsert_by_external_id)
- ✅ PM prompt backlog field removed
- ✅ Priority level guidelines documented (critical/high/medium/low)
- ✅ Priority → milestone routing clarified
- ✅ Enhanced JSDoc with all Phase 4 features

### Template Variables
- `${workflow_run_id}` - Unique workflow execution ID
- `${step_name}` - Current step name
- `${task_index}` - Task array index (0-based)
- `${task.title_slug}` - Slugified task title
- `${task.title}` - Original task title
- `${task.priority}` - Task priority level
- `${task.milestone_slug}` - Milestone slug

---

## Breaking Changes

### None (Backward Compatible)

**BulkTaskCreationStep:**
- `workflow_run_id` is optional (defaults to 'unknown')
- `upsert_by_external_id` is opt-in (default: false)
- Existing workflows continue working unchanged

**PM Prompt:**
- `backlog` field deprecated but still supported (PMDecisionParserStep handles merge)
- Warning logged if `backlog` field present
- New prompts should use only `follow_up_tasks`

---

## Next Steps (Day 5)

### Unit Tests
- Test external_id generation (default format)
- Test external_id templates (all 7 variables)
- Test idempotency (duplicate external_id → skip creation)
- Test PM prompt with only follow_up_tasks (no backlog)
- Test priority → milestone routing (critical/high → immediate, medium/low → deferred)

### Integration Validation
- Test complete workflow: PM evaluation → task creation → idempotent re-run
- Test retry logic with external_id (failed tasks retain same external_id)
- Test duplicate detection with external_id strategy (100% match)
- Verify all Phase 4 features work together end-to-end

---

## Lessons Learned

### Idempotency Design
1. **Composite Keys:** `workflow_run_id:step_name:task_index` ensures uniqueness
2. **Index-based:** Task index more stable than title (titles may change)
3. **Template Flexibility:** Different use cases need different external_id formats
4. **Auto-generate Default:** Sensible default reduces configuration burden

### Prompt Engineering
1. **Explicit Guidelines:** PM needs clear priority → milestone mapping
2. **Remove Ambiguity:** Single field (`follow_up_tasks`) > multiple fields (`backlog` + `follow_up_tasks`)
3. **Backward Compatibility:** Deprecation warnings better than breaking changes
4. **Document Scoring:** Priority scores (1500/1200/800/50) help PM understand impact

### API Design
1. **Opt-in Features:** `upsert_by_external_id` doesn't break existing workflows
2. **Sensible Defaults:** Auto-generate if no template provided
3. **Template Variables:** Rich set of variables (7) covers most use cases
4. **Config Validation:** Warn if workflow_run_id missing but don't fail

---

## Success Criteria Met ✅

- [x] Automatic external_id generation implemented
- [x] Default format: `${workflow_run_id}:${step_name}:${task_index}`
- [x] Custom external_id templates supported (7 variables)
- [x] workflow_run_id configuration added to interface
- [x] PM prompt backlog field removed (documented as deprecated)
- [x] Priority level guidelines documented (critical/high/medium/low)
- [x] Priority → milestone routing clarified
- [x] Enhanced JSDoc with idempotency examples
- [x] Build successful (no compilation errors)
- [x] Backward compatible (all features opt-in)

---

**Status:** ✅ COMPLETE  
**Build:** ✅ SUCCESS  
**Phase 4 Progress:** 80% (4 of 5 days complete)  
**Next:** Day 5 - Unit Tests + Integration Validation
