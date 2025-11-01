# Redis Machine Client (TypeScript)

Per-machine worker that:

1. Listens on Redis Streams for its **allowed personas**.
2. Pulls project context from your dashboard.
3. Calls the **local LM Studio** model (single-loaded identifier).
4. Emits a result event to Redis and (optionally) updates the dashboard.
5. (Optional) **Applies file edits** safely and commits to a branch.
6. (Optional) **Context scanner** writes `.ma/context` artifacts before the model call when persona===context.
7. **Multi-component scanning**: set SCAN_COMPONENTS or pass payload.components.
8. **Alembic aware**: if an `alembic/` tree exists, summary includes latest version files.

See `.env.example` for config.

## Repo workspace semantics

- PROJECT_BASE is a parent directory where local repositories are managed. It is not itself a git repo.
- There is no placeholder repo under PROJECT_BASE (no implicit `active`). Repositories are always resolved from the dashboard (or payload override) and cloned/ensured under PROJECT_BASE.
- For multi-repo workflows, the coordinator resolves the target repository dynamically from the payload (repo_root when it points to an actual git repo, or by cloning from the dashboard’s repository URL using a project name/slug hint).

## Development

### Testing

- Tests run with a guard that prevents git commands from running outside OS temp directories when an explicit `cwd` is provided. This protects your working repo (e.g., the branch won’t be changed by tests).
- Use a temp directory for any test that shells out to git. The helper `tests/makeTempRepo.ts` can be used to create a barebones repo for integration-ish tests.
- The test setup also sets `PROJECT_BASE` to a unique temp dir so any repo resolution during tests happens under a sandbox.

Example usage in a test:

```ts
import { makeTempRepo } from "./makeTempRepo";

it("does git things safely", async () => {
  const repo = await makeTempRepo();
  // shell out with { cwd: repo } or pass repoRoot: repo to functions under test
});
```

## TDD-aware coordinator

The coordinator can infer Test-Driven Development (TDD) context directly from your dashboard data. No special run flags are required, though optional flags exist for ad‑hoc runs.

### How inference works

For each task, the coordinator aggregates TDD hints from (highest to lowest priority):

1. Explicit message/payload hints passed at dispatch time
2. Task metadata and labels/tags
3. Milestone metadata and labels/tags
4. Project metadata and labels/tags

Supported hint keys and label patterns:

- workflow_mode: mark with label `tdd` to indicate a TDD workflow
- tdd_stage: use labels like `stage:write_failing_test` or `stage:make_tests_pass`
- qa_expectations: use `qa:expect_failures` when failures are expected during the failing‑test stage

Example labels on a task:

- `tdd`
- `stage:write_failing_test`
- `qa:expect_failures`

These hints are propagated into the QA persona payload for clear expectations and are used to gate governance personas.

### Governance gating

When `tdd_stage` is `write_failing_test`, governance personas (code‑reviewer and security‑review) are skipped. After QA passes (e.g., in `make_tests_pass` stage), governance runs normally (subject to your allowed personas config).

### Optional CLI flags (ad‑hoc)

You can still run the coordinator with flags to override or supply hints without editing dashboard data:

- `--workflow-mode <mode>` (e.g., `tdd`)
- `--tdd-stage <stage>` (e.g., `write_failing_test` or `make_tests_pass`)
- `--qa-expectations <value>` (e.g., `expect_failures`)

Example:

```sh
npm run coordinator -- --drain <project_id> --workflow-mode tdd --tdd-stage write_failing_test --qa-expectations expect_failures
```

Notes:

- Flags are optional; dashboard labels are the preferred source of truth.
- Governance dispatch is tolerant to unknown statuses and respects `allowedPersonas` configuration.

## Workflow System

The multi-agent client now includes a YAML-based workflow system that provides declarative coordination workflows while maintaining full backward compatibility.

### Key Features

- **YAML Configuration**: Define workflows declaratively in `workflows/` directory
- **Step-based Execution**: Modular workflow steps with dependency management
- **Error Handling**: Configurable retry policies and graceful error recovery
- **Conditional Logic**: Dynamic workflow routing based on runtime conditions

### Basic Usage

Workflows are automatically selected based on task type and properties. The system includes built-in workflows:

- `project-loop.yml`: Standard development workflow with planning, implementation, and QA
- `hotfix.yml`: Emergency hotfix workflow with abbreviated process
- `feature.yml`: Feature-specific workflow with enhanced validation

### Example Workflow Structure

```yaml
name: "project-loop"
version: "1.0.0"
description: "Standard project workflow"

steps:
  - id: "planning"
    name: "Implementation Planning"
    type: "persona-request"
    persona: "implementation-planner"
    timeout: 1800

  - id: "implementation"
    name: "Lead Engineer Implementation"
    type: "persona-request"
    persona: "lead-engineer"
    dependencies: ["planning"]
    timeout: 3600

  - id: "qa"
    name: "Quality Assurance"
    type: "persona-request"
    persona: "qa-engineer"
    dependencies: ["implementation"]
```

### Architecture

The workflow system consists of:

- **WorkflowEngine**: Core execution engine for YAML workflows
- **WorkflowCoordinator**: Integration layer maintaining backward compatibility
- **Step Registry**: Built-in step implementations (persona-request, git-operation, conditional, parallel)
- **WorkflowContext**: Shared execution context across workflow steps

For detailed documentation, see [docs/WORKFLOW_SYSTEM.md](docs/WORKFLOW_SYSTEM.md).

## Workflow selection: defaults and how to choose a different YAML

This project uses declarative YAML workflows loaded from `src/workflows/definitions/`. When you dispatch the coordinator (for example with `npm run coordinator -- <project_id>`), the coordinator loads all YAMLs and selects a workflow per task as follows:

- Default preference: if `legacy-compatible-task-flow.yaml` exists, it is selected first for every task. This preserves legacy test behavior and acts as the default workflow.
- Trigger-based match: if the legacy-compatible file isn’t present, the engine matches workflows by each file’s `trigger.condition` against the inferred task type/scope.
- Fallback: if no trigger matches, the coordinator falls back to `project-loop.yaml`.

What drives trigger matching

- The coordinator infers `task_type` and `scope` from task name/description/labels:
  - task_type examples: `hotfix`, `feature`, `analysis`, `bugfix`, `task` (default)
  - scope examples: `large`, `medium`, `small`
- Typical built-ins:
  - `feature.yaml` triggers on `task_type == 'feature' || scope == 'large'`
  - `hotfix.yaml` triggers on `task_type == 'hotfix'` or critical/high severity
  - `project-loop.yaml` has a gentle trigger and also serves as fallback

Ways to select a different workflow

1. Quick override (no code change): Rename or add a copy of your desired workflow file as `legacy-compatible-task-flow.yaml`. The coordinator will prefer it automatically.

2. Trigger-based selection (recommended):
   - Add a new YAML to `src/workflows/definitions/` with a `trigger.condition` that matches your tasks, for example:
     - `task_type == 'feature' && scope == 'small'`
     - `task_type == 'analysis'`
   - Ensure your task title/description/labels in the dashboard include keywords so the coordinator infers the intended `task_type`/`scope`.

3. Tune the mapping (advanced): Edit `determineTaskType`/`determineTaskScope` in `src/workflows/WorkflowCoordinator.ts` to change how tasks are classified for trigger matching.

Operational notes

- The coordinator logs the list of loaded workflows and which one is used per task.
- Workflows are hot-loaded at process start; changing YAMLs requires a restart of the worker to pick up changes.
