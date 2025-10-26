# Git Artifact Persistence Strategy

## Problem Statement

**The ephemeral transport layer is fundamentally broken.** After a month of debugging invisible state issues, we're replacing it with git-based persistence as the **only** source of truth.

## Current State (BROKEN)

### What's Broken
- ❌ **Planning results** disappear after workflow (can't debug what plan was generated)
- ❌ **Evaluation results** lost in transport (can't see why plan passed/failed)
- ❌ **QA results** invisible (can't debug QA failures)
- ❌ **Context scan results** ephemeral (can't see what context planner had)
- ❌ **Implementation prompts** pull from transport instead of git (wrong/missing data)

### Impact
1. **Debugging is impossible** - Can't see what plan was actually generated
2. **Non-reproducible** - Transport failures lose all state
3. **Distributed agents don't work** - Only git commits are shared
4. **Wrong prompts** - Lead engineer gets empty/stale transport data instead of approved plan

---

## Strategic Implementation

### Core Principle
**Git is the ONLY source of truth. Transport layer is removed from workflow artifacts.**

Every persona output is committed to `.ma/` directory structure immediately after generation. Downstream steps read ONLY from git.

### Directory Structure

```
.ma/
├── tasks/
│   └── {task-id}/
│       ├── 01-context.md          # Context scan results
│       ├── 02-plan-iteration-{N}.md  # Each planning iteration
│       ├── 02-plan-eval-iteration-{N}.md  # Each evaluation
│       ├── 03-plan-final.md       # Final approved plan
│       ├── 04-implementation.md   # Implementation notes/strategy
│       ├── 05-qa-result.md        # QA test results
│       ├── 06-qa-followup-plan.md # Plan for QA failure fixes (if needed)
│       ├── 07-code-review.md      # Code review results
│       ├── 08-security-review.md  # Security review results
│       └── 09-devops-review.md    # DevOps review results
└── metadata.json                  # Task metadata index
```

### Artifact Types and Ownership

| Artifact | Created By | Consumed By | Git Path | Commit Message |
|----------|-----------|-------------|----------|----------------|
| Context scan | context persona | implementation-planner | `.ma/tasks/{id}/01-context.md` | `docs(ma): context scan for task {id}` |
| Plan iteration N | implementation-planner | plan-evaluator | `.ma/tasks/{id}/02-plan-iteration-{N}.md` | `docs(ma): plan iteration {N} for task {id}` |
| Plan evaluation N | plan-evaluator | implementation-planner (next iter) | `.ma/tasks/{id}/02-plan-eval-iteration-{N}.md` | `docs(ma): plan evaluation {N} for task {id}` |
| Final plan | plan-evaluator | lead-engineer | `.ma/tasks/{id}/03-plan-final.md` | `docs(ma): approved plan for task {id}` |
| Implementation notes | lead-engineer | (reference only) | `.ma/tasks/{id}/04-implementation.md` | `docs(ma): implementation notes for task {id}` |
| QA result | qa persona | project-manager (if fail) | `.ma/tasks/{id}/05-qa-result.md` | `docs(ma): QA results for task {id}` |
| QA followup plan | implementation-planner | lead-engineer | `.ma/tasks/{id}/06-qa-followup-plan.md` | `docs(ma): QA followup plan for task {id}` |
| Code review | code-reviewer | project-manager | `.ma/tasks/{id}/07-code-review.md` | `docs(ma): code review for task {id}` |
| Security review | security-reviewer | project-manager | `.ma/tasks/{id}/08-security-review.md` | `docs(ma): security review for task {id}` |
| DevOps review | devops-engineer | project-manager | `.ma/tasks/{id}/09-devops-review.md` | `docs(ma): devops review for task {id}` |

---

## Implementation Plan

### Phase 1: Core Infrastructure (Foundation)

#### 1.1 Create GitArtifactStep
**File:** `src/workflows/steps/GitArtifactStep.ts`

**Purpose:** Generic step to commit persona output to `.ma/` directory

**Interface:**
```typescript
interface GitArtifactStepConfig {
  source_output: string;        // e.g., "planning_loop_plan_result"
  artifact_path: string;         // e.g., ".ma/tasks/${task.id}/03-plan-final.md"
  commit_message: string;        // e.g., "docs(ma): approved plan for task ${task.id}"
  format?: 'markdown' | 'json'; // Default: markdown
  extract_field?: string;        // Optional: extract nested field (e.g., "plan")
  template?: string;             // Optional: template path for formatting
}
```

**Behavior:**
1. Extract data from workflow context via `source_output`
2. Optionally extract nested field (e.g., `result.plan`)
3. Format as markdown or JSON
4. Write to git working tree at `artifact_path`
5. Commit with `commit_message`
6. Push to remote
7. Store git SHA in workflow context as `{step_name}_sha`

**Error Handling:**
- If git commit fails: log diagnostic, retry with `git add -A`
- If push fails: log diagnostic but don't fail workflow (push can be retried)
- Store SHA even if push fails (enables post-workflow recovery)

---

#### 1.2 Create ArtifactLoaderStep
**File:** `src/workflows/steps/ArtifactLoaderStep.ts`

**Purpose:** Load artifacts from `.ma/` directory into workflow context

**Interface:**
```typescript
interface ArtifactLoaderStepConfig {
  artifact_path: string;         // e.g., ".ma/tasks/${task.id}/03-plan-final.md"
  output_variable: string;       // e.g., "approved_plan"
  required?: boolean;            // Default: true (fail if missing)
  parse_json?: boolean;          // Parse JSON content
  fallback_value?: any;          // Use if artifact missing and !required
}
```

**Behavior:**
1. Read file from git working tree at `artifact_path`
2. Optionally parse JSON
3. Store in workflow context as `output_variable`
4. If missing and `required=true`: fail with clear error
5. If missing and `required=false`: use `fallback_value`

---

### Phase 2: Planning Workflow (Critical Path)

#### 2.1 Modify PlanningLoopStep
**Changes:**
1. After each planning iteration: commit plan to `.ma/tasks/{id}/02-plan-iteration-{N}.md`
2. After each evaluation: commit eval to `.ma/tasks/{id}/02-plan-eval-iteration-{N}.md`
3. After final pass: commit to `.ma/tasks/{id}/03-plan-final.md`

**Implementation approach:**
- Extract commit logic to reusable helper: `commitArtifact(repoRoot, content, path, message)`
- Call after each persona response in loop
- Log SHAs for debugging

**Alternative approach (cleaner):**
Replace PlanningLoopStep with YAML workflow steps:
- Use PersonaRequestStep for planning
- Use GitArtifactStep to commit result
- Use PersonaRequestStep for evaluation
- Use GitArtifactStep to commit evaluation
- Use ConditionalStep to loop or proceed

**Recommendation:** Keep PlanningLoopStep but add internal git commits. Cleaner separation of concerns.

---

#### 2.2 Replace DiffApplyStep Input
**Old (BROKEN):**
```typescript
const source = stepConfig.source_output || 'implementation_request';
const diffResult = context.getVariable(source);  // ← EPHEMERAL TRANSPORT
```

**New (GIT ONLY):**
```typescript
const artifactPath = stepConfig.artifact_path;  // e.g., ".ma/tasks/1/04-implementation.md"
const fullPath = path.join(repoRoot, artifactPath);
const diffResult = await fs.readFile(fullPath, 'utf-8');  // ← GIT SOURCE OF TRUTH
```

**Example:**
```yaml
- name: apply_implementation_edits
  type: DiffApplyStep
  config:
    artifact_path: ".ma/tasks/${task.id}/04-implementation.md"  # ONLY read from git
```

---

### Phase 3: QA Workflow

#### 3.1 Commit QA Results
**After:** `qa_request` step in `task-flow.yaml`

**Add:**
```yaml
- name: commit_qa_result
  type: GitArtifactStep
  depends_on: ["qa_request"]
  config:
    source_output: "qa_request_result"
    artifact_path: ".ma/tasks/${task.id}/05-qa-result.md"
    commit_message: "docs(ma): QA results for task ${task.id}"
    extract_field: "result"  # Extract nested result field
```

---

#### 3.2 QA Failure Followup Plan
**When:** QA fails and PM creates followup plan

**Modify:** `review-failure-handling.yaml` to add GitArtifactStep after PM decision

**Flow:**
1. PM evaluates QA failure → decides to create followup plan
2. Planner creates followup plan → commit to `.ma/tasks/{id}/06-qa-followup-plan.md`
3. Lead engineer reads plan from `.ma/tasks/{id}/06-qa-followup-plan.md` (not from transport)

---

### Phase 4: Implementation Prompt Sourcing

#### 4.1 Replace Implementation Request Payload
**Old (BROKEN):**
```yaml
- name: implementation_request
  config:
    payload:
      plan: "${planning_loop_plan_result}"  # ← EPHEMERAL, DISAPPEARS
```

**New (GIT ONLY):**
```yaml
- name: implementation_request
  config:
    payload:
      plan_artifact: ".ma/tasks/${task.id}/03-plan-final.md"  # ← GIT PATH
```

**PersonaConsumer reads artifact:**
```typescript
if (payload.plan_artifact) {
  const planPath = path.join(repoRoot, payload.plan_artifact);
  const plan = await fs.readFile(planPath, 'utf-8');
  userText += `\n\n## Approved Plan\n${plan}`;
}
```

**Benefits:**
- `git show HEAD:.ma/tasks/1/03-plan-final.md` shows exact plan used
- Re-run workflow from clean checkout works
- Distributed agents see same plan via git pull

---

#### 4.2 PersonaConsumer Reads Artifacts from Git
**Change `executePersonaRequest()` to read artifact paths:**

```typescript
// In executePersonaRequest() around line 330-348
let userText = intent || 'Process this request';

// Priority 1: Explicit user_text
if (payload.user_text) {
  userText = payload.user_text;
}
// Priority 2: Artifact paths (NEW - read from git)
else if (payload.plan_artifact) {
  const planPath = path.join(repoRoot, payload.plan_artifact);
  userText = await fs.readFile(planPath, 'utf-8');
} 
else if (payload.qa_result_artifact) {
  const qaPath = path.join(repoRoot, payload.qa_result_artifact);
  userText = await fs.readFile(qaPath, 'utf-8');
}
// Priority 3: Task description
else if (payload.task?.description) {
  userText = `Task: ${payload.task.title}\n\n${payload.task.description}`;
}
// Priority 4: Fallback to intent
```

**This makes PersonaConsumer git-aware** - reads actual committed artifacts instead of ephemeral transport data.

---

### Phase 5: Review Results

#### 5.1 Commit All Review Results
**Steps to modify:**
- `code_review_request` → `.ma/tasks/{id}/07-code-review.md`
- `security_request` → `.ma/tasks/{id}/08-security-review.md`
- `devops_request` → `.ma/tasks/{id}/09-devops-review.md`

**Pattern:**
```yaml
- name: code_review_request
  type: PersonaRequestStep
  # ... existing config ...

- name: commit_code_review
  type: GitArtifactStep
  depends_on: ["code_review_request"]
  config:
    source_output: "code_review_request_result"
    artifact_path: ".ma/tasks/${task.id}/07-code-review.md"
    commit_message: "docs(ma): code review for task ${task.id}"
```

---

### Phase 6: Context Results

#### 6.1 Commit Context Scan
**After:** `context_request` step in `task-flow.yaml`

**Add:**
```yaml
- name: commit_context_scan
  type: GitArtifactStep
  depends_on: ["context_request"]
  config:
    source_output: "context_request_result"
    artifact_path: ".ma/tasks/${task.id}/01-context.md"
    commit_message: "docs(ma): context scan for task ${task.id}"
```

**Benefits:**
- See what context was available during planning
- Debug "why did planner miss this file?"
- Historical context for future refactoring

---

## Migration Strategy

### No Backward Compatibility
**The ephemeral transport approach is broken. We're replacing it entirely.**

**Approach:**
1. Implement GitArtifactStep - commits all persona outputs
2. Implement ArtifactLoaderStep - loads from git (optional, can read directly)
3. **Replace** DiffApplyStep to read from `artifact_path` (remove `source_output`)
4. **Replace** PersonaConsumer to read artifact paths from payload
5. **Replace** all workflow YAML to use git artifacts

**Testing:**
- Tests will break - that's expected and good
- Fix tests to use git artifacts instead of mocked transport
- Add new tests for GitArtifactStep (minimum 10 tests)
- Add integration test: plan → commit → load → implement

---

### Rollout Phases

#### Phase 1: Core Infrastructure (Day 1)
- [ ] Implement GitArtifactStep (commit persona outputs to git)
- [ ] Add tests for GitArtifactStep (minimum 10 tests)
- [ ] Implement helper: `commitArtifact(repoRoot, content, path, message)`

#### Phase 2: Planning Flow (Day 1-2)
- [ ] Replace PlanningLoopStep to commit each iteration to git
- [ ] Commit final plan to `.ma/tasks/{id}/03-plan-final.md`
- [ ] Replace implementation payload to use `plan_artifact` path
- [ ] Update PersonaConsumer to read `plan_artifact` from git
- [ ] Fix broken tests (expected - transport mocks won't work)

#### Phase 3: QA Flow (Day 2-3)
- [ ] Add GitArtifactStep after qa_request → `.ma/tasks/{id}/05-qa-result.md`
- [ ] Replace QA followup to read from git artifact
- [ ] Update PersonaConsumer to read `qa_result_artifact` from git
- [ ] Fix broken QA tests

#### Phase 4: All Reviews (Day 3-4)
- [ ] Add GitArtifactStep after code_review_request
- [ ] Add GitArtifactStep after security_request
- [ ] Add GitArtifactStep after devops_request
- [ ] Fix broken review tests

#### Phase 5: Context & Cleanup (Day 4-5)
- [ ] Add GitArtifactStep after context_request
- [ ] Remove all transport-based artifact code
- [ ] Update all tests to expect git artifacts
- [ ] Verify full workflow end-to-end

---

## Success Criteria

### Functional Requirements
1. ✅ All persona outputs committed to `.ma/tasks/{id}/` directory
2. ✅ Implementation reads plan from git (ONLY)
3. ✅ QA followup reads QA result from git (ONLY)
4. ✅ All commits pushed to remote for distributed coordination
5. ✅ Transport layer removed from workflow artifacts
6. ✅ All workflows source from git, never from ephemeral state

### Debugging Improvements
1. ✅ `git log .ma/tasks/1/` shows full workflow history
2. ✅ `git show HEAD:.ma/tasks/1/03-plan-final.md` shows approved plan
3. ✅ `git diff HEAD~1 .ma/tasks/1/02-plan-iteration-2.md` shows plan changes
4. ✅ Workflow can resume from git checkout (no Redis required)

### Performance
1. ✅ Each git commit < 100ms (similar to DiffApplyStep)
2. ✅ No significant workflow slowdown (< 5% overhead)

---

## Implementation Details

### GitArtifactStep Implementation

```typescript
import { WorkflowStep, StepResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { runGit } from '../../gitUtils.js';
import fs from 'fs/promises';
import path from 'path';

interface GitArtifactStepConfig {
  source_output: string;
  artifact_path: string;
  commit_message: string;
  format?: 'markdown' | 'json';
  extract_field?: string;
  template?: string;
}

export class GitArtifactStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as GitArtifactStepConfig;
    
    // 1. Extract data from context
    let data = context.getVariable(config.source_output);
    
    if (config.extract_field) {
      data = data?.[config.extract_field];
    }
    
    if (!data) {
      throw new Error(`No data found at ${config.source_output}`);
    }
    
    // 2. Format content
    const content = config.format === 'json' 
      ? JSON.stringify(data, null, 2)
      : this.formatMarkdown(data, config.template);
    
    // 3. Resolve artifact path with variables
    const resolvedPath = this.resolveVariables(config.artifact_path, context);
    const repoRoot = context.getRepoRoot();
    const fullPath = path.join(repoRoot, resolvedPath);
    
    // 4. Write file
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, 'utf-8');
    
    // 5. Commit
    const commitMsg = this.resolveVariables(config.commit_message, context);
    await runGit(['add', resolvedPath], { cwd: repoRoot });
    await runGit(['commit', '-m', commitMsg], { cwd: repoRoot });
    
    // 6. Get SHA
    const sha = (await runGit(['rev-parse', 'HEAD'], { cwd: repoRoot }))
      .stdout.trim();
    
    // 7. Push
    const branch = context.getCurrentBranch();
    try {
      await runGit(['push', 'origin', branch], { cwd: repoRoot });
    } catch (err) {
      context.logger.warn('Push failed (will retry later)', { error: err });
    }
    
    return {
      status: 'success',
      data: { path: resolvedPath, sha },
      outputs: { [`${this.config.name}_sha`]: sha }
    };
  }
  
  private formatMarkdown(data: any, template?: string): string {
    if (typeof data === 'string') return data;
    
    // Default markdown format
    return `# Workflow Artifact\n\n${JSON.stringify(data, null, 2)}`;
  }
  
  private resolveVariables(str: string, context: WorkflowContext): string {
    return str.replace(/\$\{([^}]+)\}/g, (_, key) => {
      return context.getVariable(key) ?? '';
    });
  }
}
```

### ArtifactLoaderStep Implementation

```typescript
import { WorkflowStep, StepResult } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import fs from 'fs/promises';
import path from 'path';

interface ArtifactLoaderStepConfig {
  artifact_path: string;
  output_variable: string;
  required?: boolean;
  parse_json?: boolean;
  fallback_value?: any;
}

export class ArtifactLoaderStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as ArtifactLoaderStepConfig;
    
    // Resolve path with variables
    const resolvedPath = this.resolveVariables(config.artifact_path, context);
    const repoRoot = context.getRepoRoot();
    const fullPath = path.join(repoRoot, resolvedPath);
    
    try {
      // Read file
      const content = await fs.readFile(fullPath, 'utf-8');
      
      // Parse if JSON
      const value = config.parse_json ? JSON.parse(content) : content;
      
      // Store in context
      context.setVariable(config.output_variable, value);
      
      return {
        status: 'success',
        data: { path: resolvedPath, loaded: true },
        outputs: { [config.output_variable]: value }
      };
      
    } catch (err) {
      if (config.required !== false) {
        throw new Error(`Required artifact not found: ${resolvedPath}`);
      }
      
      // Use fallback
      const value = config.fallback_value;
      context.setVariable(config.output_variable, value);
      
      return {
        status: 'success',
        data: { path: resolvedPath, loaded: false, usedFallback: true },
        outputs: { [config.output_variable]: value }
      };
    }
  }
  
  private resolveVariables(str: string, context: WorkflowContext): string {
    return str.replace(/\$\{([^}]+)\}/g, (_, key) => {
      return context.getVariable(key) ?? '';
    });
  }
}
```

---

## Testing Strategy

### Unit Tests

#### GitArtifactStep Tests
1. ✅ Should commit persona output to .ma directory
2. ✅ Should extract nested field when extract_field specified
3. ✅ Should format as JSON when format=json
4. ✅ Should format as markdown by default
5. ✅ Should resolve variable placeholders in paths
6. ✅ Should resolve variable placeholders in commit messages
7. ✅ Should push to remote after commit
8. ✅ Should not fail if push fails (log warning)
9. ✅ Should create parent directories if missing
10. ✅ Should store SHA in workflow context

#### ArtifactLoaderStep Tests
1. ✅ Should load artifact from .ma directory
2. ✅ Should parse JSON when parse_json=true
3. ✅ Should fail if required artifact missing
4. ✅ Should use fallback if not required and missing
5. ✅ Should resolve variable placeholders in paths
6. ✅ Should store value in workflow context
7. ✅ Should return correct outputs

### Integration Tests

#### Planning → Implementation Flow
1. ✅ PlanningLoopStep commits iterations to .ma/tasks/{id}/02-plan-iteration-*.md
2. ✅ Final plan committed to .ma/tasks/{id}/03-plan-final.md
3. ✅ ArtifactLoaderStep loads plan from git
4. ✅ PersonaRequestStep receives plan from git (not transport)
5. ✅ DiffApplyStep applies implementation from plan

#### QA Failure → Followup Flow
1. ✅ QA result committed to .ma/tasks/{id}/05-qa-result.md
2. ✅ PM reads QA result from git
3. ✅ Followup plan committed to .ma/tasks/{id}/06-qa-followup-plan.md
4. ✅ Lead engineer reads followup plan from git
5. ✅ Implementation applied based on followup plan

---

## Risk Assessment

### High Risk
1. **Git conflicts** - Multiple agents committing to .ma/ simultaneously
   - **Mitigation:** Use task-specific directories (`.ma/tasks/{id}/`)
   - **Mitigation:** Agent acquires task lock before processing

2. **Large artifacts** - Context scans could be huge
   - **Mitigation:** Add max size validation (fail if > 1MB)
   - **Mitigation:** Truncate context in artifact, store full in database

### Medium Risk
1. **Push failures** - Network issues during push
   - **Mitigation:** Log diagnostic, continue workflow
   - **Mitigation:** Add post-workflow push retry job

2. **Path traversal** - Malicious artifact_path could escape .ma/
   - **Mitigation:** Validate paths start with `.ma/`
   - **Mitigation:** Sanitize task IDs (alphanumeric only)

### Low Risk
1. **Performance** - Extra commits slow workflow
   - **Mitigation:** Commits are fast (< 100ms each)
   - **Mitigation:** Push is async, doesn't block

---

## Implementation Decisions

1. **Commit ALL planning iterations** - needed for debugging why plan evolved
2. **Artifacts use Markdown** - human-readable, diffable, PR-reviewable
3. **Keep `.ma/` forever** - historical debugging is critical
4. **Modify PlanningLoopStep internally** - cleaner than YAML explosion
5. **PersonaConsumer reads artifacts directly** - simpler than extra loader step

## Next Steps

1. Implement GitArtifactStep with tests
2. Replace PlanningLoopStep to commit iterations
3. Update PersonaConsumer to read artifact paths from payload
4. Replace all workflow YAMLs to use git artifacts
5. Fix broken tests (expected - transport approach is dead)

**No backward compatibility. Replace the broken transport approach entirely.**
