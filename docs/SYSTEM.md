# Multi-Agent Machine Client System

## Overview

Redis-based multi-agent orchestration system that coordinates autonomous personas to execute software development tasks. Written in TypeScript with LM Studio integration for local LLM execution.

## Architecture

### Core Components

**Redis Streams**: Asynchronous message transport between coordinator and persona agents
**LM Studio**: Local LLM inference server (default: http://127.0.0.1:1234)
**Git Integration**: Automated repository management under PROJECT_BASE directory
**Dashboard Backend**: Optional HTTP API for task/project management (port 8787)

### Key Directories

```
src/
├── agents/           # Persona implementations and response parsers
├── workflows/        # Workflow engine and step definitions
│   ├── definitions/  # YAML workflow files
│   ├── templates/    # Reusable step templates
│   ├── engine/       # Core workflow execution
│   └── steps/        # Step type implementations
├── tasks/            # Task management and lifecycle
├── milestones/       # Milestone tracking
├── git/              # Git operations and repository management
├── personas/         # Persona execution and context management
└── tools/            # Entry points (run_coordinator, run_persona_workers)
```

## Workflow System

### Template-Based Architecture

Workflows use YAML definitions with template inheritance to eliminate duplication. Templates defined in `src/workflows/templates/step-templates.yaml`.

**Available Templates**:

- `context_analysis`: Repository scanning and context extraction
- `implementation`: Code generation and modification
- `qa_review`: Quality assurance validation
- `code_review`: Code quality and standards review
- `security_review`: Security vulnerability assessment
- `devops_review`: Infrastructure and deployment review

**Template Usage**:

```yaml
- type: PersonaRequestStep
  name: implementation
  template: implementation
  overrides:
    payload:
      fast_track: true
```

### Active Workflows

**task-flow.yaml**: Main task processing (default fallback)

- Context analysis → Implementation → QA → Code Review → Security → DevOps

**in-review-task-flow.yaml**: Resume workflow for tasks marked 'in_review'

- Code Review → Security → DevOps (skips implementation)

**hotfix-task-flow.yaml**: Fast-track critical production fixes

- Priority ≥ 2000 or labels: hotfix/urgent/emergency
- All steps flagged with `hotfix_mode: true`, `fast_track: true`

**blocked-task-resolution.yaml**: Analyze and resolve blocked tasks

- Context analysis → Lead analysis → Validation → Unblock attempt

### Workflow Selection Logic

Located in `src/workflows/coordinator/WorkflowSelector.ts`:

1. Status = 'blocked' → blocked-task-resolution
2. Status = 'in_review' → in-review-task-flow
3. Priority ≥ 2000 OR hotfix labels → hotfix-task-flow
4. Default → task-flow

## Persona System

### Active Personas

Defined in `src/personaNames.ts`:

- `context`: Repository scanning and context extraction
- `plan-evaluator`: Planning validation
- `implementation-planner`: Implementation strategy
- `lead-engineer`: Technical leadership and unblocking
- `code-reviewer`: Code quality assessment
- `security-review`: Security analysis
- `tester-qa`: Quality assurance
- `coordination`: Cross-persona orchestration
- `project-manager`: Task creation and prioritization
- `architect`: System design decisions
- `summarization`: Context summarization

### Execution Flow

1. **Coordinator** (`src/tools/run_coordinator.ts`): Fetches tasks, selects workflow, executes steps
2. **PersonaRequestStep**: Publishes message to Redis stream for target persona
3. **Persona Worker** (`src/tools/run_persona_workers.ts`): Consumes message, executes LLM request
4. **Response Processing**: Parses persona output (status, diffs, decisions)
5. **Next Step**: Coordinator continues workflow based on conditions

### Timeout & Retry

Configured per-persona in workflow definitions:

```yaml
timeout_ms: 60000
max_retries: 2
```

Retry mechanism in `src/personas/execution/PersonaRequestExecutor.ts`.

## Git Operations

### Repository Management

**PROJECT_BASE**: Environment variable defining root directory for all repositories
**Branch Strategy**: Feature branches created per task (`feature/task-{id}`)
**Commit Flow**: Changes committed automatically after implementation steps
**Push Strategy**: Pushes to origin after successful commit

### Key Classes

- `GitService` (`src/git/GitService.ts`): High-level git operations
- `BranchOperations` (`src/git/operations/BranchOperations.ts`): Branch management
- `GitArtifactStep` (`src/workflows/steps/GitArtifactStep.ts`): Commit and push workflow step

## Task Lifecycle

### States

1. `pending`: Created, awaiting processing
2. `in_progress`: Coordinator executing workflow
3. `in_review`: Awaiting review persona feedback
4. `blocked`: Cannot proceed, needs intervention
5. `completed`: Successfully finished
6. `failed`: Execution failed

### Task Properties

```typescript
{
  id: string
  title: string
  description: string
  status: string
  priority: number
  labels: string[]
  project_id: string
  repo_url?: string
  branch?: string
}
```

## Configuration

### Environment Variables

```bash
REDIS_URL=redis://localhost:6379
LMS_BASE_URL=http://127.0.0.1:1234
DASHBOARD_BASE_URL=http://localhost:8787
PROJECT_BASE=/path/to/projects
LOG_LEVEL=info
```

### Models

Configured in `src/config.ts`:

- Default: `deepseek-coder-v2.5`
- Planning personas: `qwen2.5-coder-32b-instruct`

## Testing

### Test Strategy

**Framework**: Vitest
**Test Files**: 64 files, 421 tests
**Coverage**: Critical paths (workflows, git ops, persona routing, TDD governance)

**Key Test Patterns**:

- `makeTempRepo()`: Creates isolated git repos for testing
- `coordinatorTestHelper`: Workflow execution mocking
- Safety guards prevent modifications to working repository

### Running Tests

```bash
npm test                  # Full suite
npm run typecheck         # TypeScript validation
npm run lint              # ESLint (zero-comment policy enforced)
```

## Code Quality Standards

### Zero-Comment Policy

Comments prohibited via `eslint-plugin-no-comments`. Code must be self-documenting through clear naming and structure.

### Type Safety

TypeScript strict mode enabled. `@typescript-eslint` enforces best practices.

### File Size Limits

Pre-commit hook warns on files >400 lines. Refactoring recommended.

## Development Workflow

### Starting Services

```bash
npm run coordinator       # Start workflow coordinator
npm run dev              # Start persona workers
npm run monitor          # Monitor Redis streams (debugging)
```

### Creating Tasks

Tasks created via:

1. Dashboard API: `POST /projects/:projectId/tasks`
2. `BulkTaskCreationStep`: PM persona output parsing
3. Manual insertion: `TaskManager.createTask()`

### Debugging

**Logs**: `machine-client.log` in project root
**Redis Monitoring**: `scripts/monitor-redis-streams.ts`
**Task State**: Check `src/outputs/task_{id}.log` for execution history

## Key Algorithms

### Template Merging

Deep merge strategy in `src/workflows/engine/TemplateLoader.ts`:

- Base template loaded from `step-templates.yaml`
- Workflow overrides applied recursively
- Arrays concatenated, objects merged deeply
- Primitive values replaced

### Variable Resolution

Workflow context variables resolved in steps via `${variable}` syntax:

- Direct variables: `${task.id}`
- Step outputs: `${stepName.property}`
- Nested access: `${context.repo.branch}`

Implemented in `src/workflows/steps/helpers/VariableResolver.ts`.

### Diff Parsing

Multi-strategy parser in `src/agents/parsers/DiffParser.ts`:

1. Extract code blocks from markdown
2. Detect unified diff format
3. Parse edit specifications (file operations)
4. Convert to standard diff format
5. Validate against target files

### Condition Evaluation

Boolean expressions in workflow conditions:

- Variable comparison: `task.status == 'completed'`
- Inequality: `plan_status != 'fail'`
- Step output access: `qa_result.status == 'pass'`

Evaluated in `src/workflows/engine/ConditionEvaluator.ts`.

## Production Considerations

### Scalability

**Horizontal**: Multiple persona workers can consume from same Redis stream
**Vertical**: Coordinator is single-threaded (one workflow execution at a time)

### Reliability

**Retries**: Configurable per-persona with exponential backoff
**State Persistence**: Task state stored in dashboard backend
**Git Safety**: All operations in isolated branches, manual merge to main

### Monitoring

**Metrics**: Task completion rates, persona response times
**Logging**: Structured JSON logs with task/workflow context
**Alerts**: Task stuck in `in_progress` >1 hour indicates coordinator issue

## Common Issues

### Task Stuck in 'in_progress'

**Cause**: Coordinator crashed or workflow timeout
**Fix**: Restart coordinator, check logs for errors

### Persona Timeout

**Cause**: LM Studio slow response, model overloaded
**Fix**: Increase `timeout_ms` in workflow, check LMS load

### Git Push Failures

**Cause**: No remote configured, authentication failure
**Fix**: Set remote URL, configure git credentials

### Template Not Found

**Cause**: Template name mismatch in workflow
**Fix**: Check `step-templates.yaml` for exact template name

## Future Enhancements

- Parallel step execution (currently sequential)
- Workflow versioning and rollback
- Multi-coordinator for high-throughput scenarios
- Persona performance analytics dashboard
- Dynamic template composition based on task characteristics
