# Workflow System Redesign - Requirements Analysis

**Date:** October 26, 2025  
**Status:** Planning Phase

## Problem Analysis

Based on the latest run logs, the current system has inefficiencies that need addressing:

### Current Issues Observed

1. **Coordination Persona Called Unnecessarily** (lines 13-27 of log)
   - `coordination` persona invoked with LLM call (24s duration)
   - Returns generic orchestration advice, not actionable work
   - **Problem:** Wasted LLM tokens and time for workflow kick-off

2. **Variable Resolution Failure** (lines 119, 127, 135)
   ```
   Failed to read plan_artifact from git
   artifactPath: ".ma/tasks/${task.id}/03-plan-final.md"
   error: ENOENT: no such file or directory, open '/Users/.../machine-client-log-summarizer/.ma/tasks/${task.id}/03-plan-final.md'
   ```
   - **Problem:** `${task.id}` not resolved before file read
   - Personas receive artifact path templates instead of resolved paths
   - **Root Cause:** Artifact path resolution happens AFTER persona payload construction

3. **Context Scan Runs Every Time** (line 42)
   - Context persona called for every task, regardless of changes
   - No detection of new files vs existing artifacts
   - **Problem:** Expensive LLM call when `.ma/` already has context

## Requirements

### 1. Coordinator Changes

**Goal:** Transform coordinator from LLM-based orchestrator to pure task dispatcher

#### Current Flow (BROKEN)
```typescript
handleCoordinator() {
  // 1. Send request to coordination persona (LLM call - UNNECESSARY)
  sendPersonaRequest('coordination', payload)
  
  // 2. Wait for generic advice
  await waitForPersonaCompletion()
  
  // 3. Fetch tasks from dashboard
  const tasks = await fetchProjectTasks(projectId)
  
  // 4. Process first pending task
  processTask(tasks[0])
}
```

#### New Flow (REQUIRED)
```typescript
handleCoordinator() {
  // 1. Query dashboard directly for tasks (NO LLM)
  const tasks = await fetchProjectTasks(projectId)
  
  // 2. Sort by priority (dashboard provides priority_score)
  const prioritized = tasks
    .filter(t => t.status !== 'done')
    .sort((a, b) => (b.priority_score || 0) - (a.priority_score || 0))
  
  // 3. Select highest priority task
  const nextTask = prioritized[0]
  
  // 4. Route to task-flow.yaml workflow (NO planning loop at coordinator level)
  executeWorkflow('task-flow', nextTask)
}
```

**Implementation Changes:**

- ✅ **Remove:** Coordination persona LLM call from `WorkflowCoordinator.handleCoordinator()`
- ✅ **Keep:** `TaskFetcher.fetchTasks()` - already fetches from dashboard API
- ✅ **Keep:** `TaskFetcher.compareTaskPriority()` - already sorts by `priority_score`
- ✅ **Remove:** Planning loop invocation at coordinator level
- ✅ **Remove:** Any engineering work from coordinator (already done - coordinator just routes)

**Rationale:**
- Dashboard is canonical source of truth for task priority
- No LLM needed to select "highest priority open task"
- Coordinator should be fast dispatch layer (<100ms overhead)

---

### 2. Context Scanning Changes

**Goal:** Only run context scan when new files exist outside `.ma/` directory

#### Current Behavior (INEFFICIENT)
```yaml
# task-flow.yaml
steps:
  - name: context_request
    type: PersonaRequestStep
    depends_on: ["mark_task_in_progress"]
    # ALWAYS runs, even if .ma/tasks/{id}/01-context.md exists
```

#### New Behavior (REQUIRED)
```yaml
steps:
  - name: check_context_exists
    type: GitOperationStep  # New step type
    description: "Check if context artifact exists and repo has new changes"
    depends_on: ["mark_task_in_progress"]
    config:
      operation: "checkContextFreshness"
      # Returns:
      # - context_exists: boolean (.ma/tasks/{id}/01-context.md exists)
      # - has_new_files: boolean (files changed outside .ma/ since last context)
      # - needs_rescan: boolean (context_exists=false OR has_new_files=true)

  - name: context_request
    type: PersonaRequestStep
    description: "Scan repository and create context artifact"
    depends_on: ["check_context_exists"]
    condition: "${needs_rescan} == true"  # Only run if needed
    config:
      step: "1-context"
      persona: "context"
      intent: "context_gathering"

  - name: commit_context_artifact
    type: GitArtifactStep
    description: "Commit context scan to .ma/tasks/{id}/01-context.md"
    depends_on: ["context_request"]
    condition: "${needs_rescan} == true"
    config:
      source: "context_request_result"
      path: ".ma/tasks/${task.id}/01-context.md"
      commit_message: "docs: context scan for task ${task.id}"

  - name: load_existing_context
    type: GitArtifactStep
    description: "Load existing context if scan was skipped"
    depends_on: ["check_context_exists"]
    condition: "${needs_rescan} == false"
    config:
      operation: "read"
      path: ".ma/tasks/${task.id}/01-context.md"
      output_variable: "context_request_result"
```

**Implementation Requirements:**

1. **New GitOperationStep operation: `checkContextFreshness`**
   ```typescript
   // src/workflows/steps/GitOperationStep.ts
   
   async checkContextFreshness(taskId: string): Promise<{
     context_exists: boolean;
     has_new_files: boolean;
     needs_rescan: boolean;
   }> {
     const artifactPath = `.ma/tasks/${taskId}/01-context.md`;
     const contextExists = await fs.access(artifactPath).then(() => true).catch(() => false);
     
     if (!contextExists) {
       return { context_exists: false, has_new_files: true, needs_rescan: true };
     }
     
     // Get last modified time of context artifact
     const contextStats = await fs.stat(artifactPath);
     const contextTime = contextStats.mtime.getTime();
     
     // Check if any files outside .ma/ changed since context was created
     const changedFiles = await runGit(repoRoot, [
       'diff', '--name-only',
       `@{${new Date(contextTime).toISOString()}}`, 'HEAD'
     ]);
     
     const hasNewFiles = changedFiles
       .split('\n')
       .filter(Boolean)
       .some(file => !file.startsWith('.ma/'));
     
     return {
       context_exists: contextExists,
       has_new_files: hasNewFiles,
       needs_rescan: hasNewFiles
     };
   }
   ```

2. **GitArtifactStep read mode**
   ```typescript
   // Add to GitArtifactStep.ts
   
   async execute(context: WorkflowContext): Promise<void> {
     const config = this.config as GitArtifactStepConfig;
     
     // NEW: Support read mode
     if (config.operation === 'read') {
       const content = await fs.readFile(
         join(context.repoRoot, config.path),
         'utf-8'
       );
       context.setVariable(config.output_variable || 'artifact_content', content);
       return;
     }
     
     // Existing commit/write logic...
   }
   ```

**Benefits:**
- Skip context scan when `.ma/tasks/{id}/01-context.md` exists AND no new files
- Save ~45s per task (context persona LLM call duration from logs)
- Only rescan when actual code changes detected

---

### 3. Planning Flow Changes

**Goal:** Planning loop ONLY runs after coordinator selects task and context completes

#### Current Flow (CORRECT ✅)
```
coordinator selects task
  ↓
context_request (PersonaRequestStep)
  ↓
planning_loop (PlanningLoopStep)
  ↓
implementation_request
```

**This is already correct!** No changes needed here.

The issue is **variable resolution**, not flow order.

---

## Critical Bug Fixes

### Bug 1: Variable Resolution in Artifact Paths

**Problem:**
```typescript
// PersonaConsumer.ts line ~950
const payload = {
  plan_artifact: ".ma/tasks/${task.id}/03-plan-final.md"  // ❌ NOT RESOLVED
};
```

**Root Cause:**  
`task.id` is available in `WorkflowContext` but artifact paths in YAML aren't resolved before persona dispatch.

**Fix Required:**

1. **Update PersonaRequestStep to resolve variables**
   ```typescript
   // src/workflows/steps/PersonaRequestStep.ts
   
   async execute(context: WorkflowContext): Promise<void> {
     const config = this.config as PersonaRequestStepConfig;
     const payload = config.payload || {};
     
     // NEW: Resolve ALL string values in payload recursively
     const resolvedPayload = this.resolvePayloadVariables(payload, context);
     
     // Send persona request with RESOLVED payload
     const corrId = await sendPersonaRequest(
       transport,
       config.persona,
       config.intent,
       resolvedPayload,  // ✅ Variables resolved here
       workflowId,
       config.step
     );
   }
   
   private resolvePayloadVariables(obj: any, context: WorkflowContext): any {
     if (typeof obj === 'string') {
       // Resolve ${variable} placeholders
       return this.resolveVariables(obj, context);
     }
     
     if (Array.isArray(obj)) {
       return obj.map(item => this.resolvePayloadVariables(item, context));
     }
     
     if (obj && typeof obj === 'object') {
       const resolved: any = {};
       for (const [key, value] of Object.entries(obj)) {
         resolved[key] = this.resolvePayloadVariables(value, context);
       }
       return resolved;
     }
     
     return obj;
   }
   
   private resolveVariables(template: string, context: WorkflowContext): string {
     return template.replace(/\$\{([^}]+)\}/g, (match, path) => {
       const value = this.resolveVariablePath(path, context);
       return value !== undefined ? String(value) : match;
     });
   }
   
   private resolveVariablePath(path: string, context: WorkflowContext): any {
     const parts = path.split('.');
     let current: any = context.getVariable(parts[0]);
     
     for (let i = 1; i < parts.length && current !== undefined; i++) {
       current = current[parts[i]];
     }
     
     return current;
   }
   ```

2. **Verify task.id is available in context**
   ```typescript
   // WorkflowCoordinator.ts already sets this correctly:
   const initialVariables = {
     task: {
       id: task?.id || task?.key || 'unknown',  // ✅ Already here
       // ...
     },
     taskId: task?.id || task?.key  // ✅ Also here
   };
   ```

**After Fix:**
```
BEFORE: plan_artifact = ".ma/tasks/${task.id}/03-plan-final.md"
AFTER:  plan_artifact = ".ma/tasks/1/03-plan-final.md"  ✅
```

---

### Bug 2: Context Artifact Not Committed

**Problem:**  
Context persona runs but doesn't commit to `.ma/tasks/{id}/01-context.md`

**Fix:**  
Add GitArtifactStep after context_request (shown in section 2 above)

---

## Implementation Phases

### Phase 1: Fix Variable Resolution (CRITICAL) 🔴
**Files:**
- `src/workflows/steps/PersonaRequestStep.ts` - Add payload variable resolution
- `tests/personaRequestStep.test.ts` - Add tests for `${task.id}` resolution

**Validation:**
- Run task-flow workflow
- Check logs: artifact paths should show actual IDs, not `${task.id}`
- Verify personas CAN read plan artifacts

**Estimated Time:** 2-4 hours

---

### Phase 2: Remove Coordination Persona LLM Call 🟡
**Files:**
- `src/workflows/WorkflowCoordinator.ts` - Remove coordination persona request
- `tests/workflowCoordinator.test.ts` - Update tests to not expect coordination call

**Changes:**
```diff
  async handleCoordinator(transport: MessageTransport, r: any, msg: any, payload: any) {
-   // Send coordination request (REMOVED)
-   await sendPersonaRequest(transport, 'coordination', 'orchestrate_milestone', payload);
    
    // Fetch tasks directly (KEEP)
    const currentTasks = await this.fetchProjectTasks(projectId);
    
    // Priority sort (KEEP)
    const prioritized = currentTasks
      .filter(task => this.taskFetcher.normalizeTaskStatus(task?.status) !== 'done')
      .sort((a, b) => this.taskFetcher.compareTaskPriority(a, b));
    
    // Process task (KEEP)
    await this.processTask(transport, prioritized[0], context);
  }
```

**Validation:**
- Run coordinator
- Verify NO coordination persona request in logs
- Verify tasks still processed correctly
- Verify ~24s saved per coordinator run

**Estimated Time:** 1-2 hours

---

### Phase 3: Smart Context Scanning 🟢
**Files:**
- `src/workflows/steps/GitOperationStep.ts` - Add `checkContextFreshness` operation
- `src/workflows/steps/GitArtifactStep.ts` - Add `read` operation mode
- `src/workflows/definitions/task-flow.yaml` - Add conditional context steps
- `tests/contextFreshness.test.ts` - Test context skip logic

**Changes:**
See Section 2 implementation requirements above.

**Validation:**
- Create task, verify context runs (no artifact exists)
- Run same task again, verify context SKIPPED (artifact exists, no new files)
- Add new file, verify context RERUNS (new files detected)

**Estimated Time:** 4-6 hours

---

## Expected Performance Improvements

| Optimization | Time Saved | Frequency |
|--------------|------------|-----------|
| Remove coordination LLM call | ~24s | Every coordinator run (1x per project) |
| Skip context when cached | ~45s | Every task after first (N-1 tasks) |
| Variable resolution fix | N/A | **Fixes broken artifacts** (CRITICAL) |

**Example: 10-task project**
- Current: 24s (coord) + 45s × 10 (context) = **474s total overhead**
- After: 0s (coord) + 45s × 1 (context) = **45s total overhead**
- **Savings: 429s (7.15 minutes) per 10-task project**

---

## Testing Strategy

### Phase 1 Tests (Variable Resolution)
```typescript
// tests/personaRequestStep.test.ts

describe('PersonaRequestStep variable resolution', () => {
  it('resolves ${task.id} in artifact paths', async () => {
    const context = createMockContext({
      task: { id: 42 }
    });
    
    const step = new PersonaRequestStep('test', {
      persona: 'lead-engineer',
      payload: {
        plan_artifact: '.ma/tasks/${task.id}/03-plan-final.md'
      }
    });
    
    await step.execute(context);
    
    const sentRequest = getSentRequests()[0];
    expect(sentRequest.payload.plan_artifact).toBe('.ma/tasks/42/03-plan-final.md');
  });
});
```

### Phase 2 Tests (No Coordination Call)
```typescript
// tests/workflowCoordinator.test.ts

it('does not call coordination persona on startup', async () => {
  const coordinator = new WorkflowCoordinator();
  await coordinator.handleCoordinator(transport, {}, msg, payload);
  
  const requests = getSentRequests();
  expect(requests.find(r => r.persona === 'coordination')).toBeUndefined();
});
```

### Phase 3 Tests (Context Caching)
```typescript
// tests/contextFreshness.test.ts

it('skips context scan when artifact exists and no new files', async () => {
  // Create initial context artifact
  await fs.writeFile('.ma/tasks/1/01-context.md', 'existing context');
  
  const result = await checkContextFreshness('1', repoRoot);
  
  expect(result).toEqual({
    context_exists: true,
    has_new_files: false,
    needs_rescan: false
  });
});
```

---

## Migration Plan

1. **Phase 1 (CRITICAL):** Fix variable resolution - deploy ASAP
2. **Phase 2:** Remove coordination LLM call - low risk, high value
3. **Phase 3:** Smart context caching - adds complexity, but major perf win

**Rollback Strategy:**
- All changes are additive or removals (no destructive changes)
- Git revert available for each phase
- Tests validate behavior before/after

---

## Open Questions

1. **Context artifact format**: Should `.ma/tasks/{id}/01-context.md` be markdown or JSON?
   - **Recommendation:** Markdown (human-readable, git-friendly)

2. **Context freshness threshold**: How old can context be before forced rescan?
   - **Recommendation:** Only rescan on file changes, ignore age

3. **Coordinator persona removal**: Any consumers expecting coordination persona responses?
   - **Action:** Grep for `coordination` persona references in tests/code

---

## Success Criteria

✅ **Phase 1 Complete When:**
- Personas receive resolved artifact paths (no `${task.id}` in logs)
- Lead-engineer successfully reads `.ma/tasks/1/03-plan-final.md`
- All 321 tests passing

✅ **Phase 2 Complete When:**
- Coordinator runs without coordination persona LLM call
- Tasks still selected and processed correctly
- ~24s saved per coordinator invocation

✅ **Phase 3 Complete When:**
- Context scan skipped when artifact exists + no new files
- Context scan runs when new files detected outside `.ma/`
- ~45s saved per task (after first task in project)

---

**Next Steps:**
1. Review this requirements doc
2. Implement Phase 1 (variable resolution) - CRITICAL BUG FIX
3. Test with real task-flow.yaml execution
4. Proceed to Phase 2/3 once Phase 1 validated
