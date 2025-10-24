# Workflow System

## Overview

A distributed multi-agent system that orchestrates AI personas to plan, implement, test, and review code changes. Uses YAML-defined workflows with the WorkflowEngine for execution and Redis or LocalTransport for messaging.

## Architecture

### Core Components

**WorkflowCoordinator** (`src/workflows/WorkflowCoordinator.ts`)
- Orchestrates the project loop
- Fetches tasks from dashboard
- Selects and executes appropriate workflows
- Continues until all tasks complete or critical failure

**WorkflowEngine** (`src/workflows/WorkflowEngine.ts`)
- Loads and executes YAML workflow definitions
- Manages step dependencies and execution order
- Handles context and state management
- Returns success/failure results

**Workflow Steps** (`src/workflows/steps/`)
- PersonaRequestStep - Dispatches work to AI personas
- GitOperationStep - Git operations (checkout, commit, push)
- DiffApplyStep - Applies code diffs
- TaskUpdateStep - Updates task status
- PlanningLoopStep - Iterative planning with TDD gates
- ConditionalStep - Conditional execution based on state

**Personas** (`src/agents/persona.ts`)
- Individual AI agents with specific roles
- Communicate via message transport (Redis or local)
- Examples: implementation-planner, lead-engineer, tester-qa, code-reviewer

### System Flow

```
Dashboard → Message Transport → Coordinator → WorkflowEngine → Personas
                                      ↓              ↓             ↓
                                   Context        Steps      Implementation
                                      ↓              ↓             ↓
                                    Git ←────── Results ──────── Git
```

## Workflows

### YAML Structure

Workflows are defined in `src/workflows/definitions/` as YAML files:

```yaml
name: "task-flow"
version: "1.0.0"
description: "Standard task workflow"

variables:
  planning_timeout: 1800      # 30 minutes
  implementation_timeout: 3600 # 60 minutes

steps:
  - id: "planning"
    name: "Implementation Planning"
    type: "PersonaRequestStep"
    config:
      persona: "implementation-planner"
      intent: "plan"
      timeout: 1800
      maxRetries: 2
      
  - id: "implementation"
    name: "Code Implementation"
    type: "PersonaRequestStep"
    config:
      persona: "lead-engineer"
      intent: "implement"
      timeout: 3600
    depends_on: ["planning"]
    
  - id: "qa"
    name: "Quality Assurance"
    type: "PersonaRequestStep"
    config:
      persona: "tester-qa"
      intent: "test"
      timeout: 1200
    depends_on: ["implementation"]
```

### Available Workflows

- `task-flow.yaml` - Standard development workflow
- `hotfix.yaml` - Emergency hotfix workflow  
- `feature.yaml` - Feature-specific workflow
- `blocked-task-resolution.yaml` - Handles blocked tasks
- `review-failure-handling.yaml` - Handles review failures (QA, code review, security)

## Timeout & Retry

### Configuration

Timeouts and retries are configurable at three levels:

**1. Global defaults** (`.env`):
```bash
PERSONA_DEFAULT_TIMEOUT_MS=60000              # 1 minute
PERSONA_DEFAULT_MAX_RETRIES=3                 # 3 retries
PERSONA_RETRY_BACKOFF_INCREMENT_MS=30000      # 30s backoff
```

**2. Per-persona overrides** (`.env`):
```bash
PERSONA_TIMEOUTS_JSON='{"lead-engineer":180000,"tester-qa":120000}'
PERSONA_MAX_RETRIES_JSON='{"lead-engineer":5,"tester-qa":2}'
```

**3. Per-step overrides** (YAML):
```yaml
- id: "critical-step"
  type: "PersonaRequestStep"
  config:
    persona: "lead-engineer"
    timeout: 300000      # Override to 5 minutes
    maxRetries: 5        # Override to 5 retries
```

### Retry Behavior

PersonaRequestStep implements progressive backoff:

```
Attempt 1 → [timeout] → Wait 30s →
Attempt 2 → [timeout] → Wait 60s →
Attempt 3 → [timeout] → Wait 90s →
Attempt 4 → [timeout] → Fail
```

Only timeout errors trigger retries. Other errors fail immediately.

## Message Transport

The system supports two transport implementations:

**RedisTransport** (distributed, multi-machine):
```bash
TRANSPORT_TYPE=redis
REDIS_HOST=localhost
REDIS_PORT=6379
```

**LocalTransport** (single process, in-memory):
```bash
TRANSPORT_TYPE=local
```

All workflow steps use the transport abstraction via `WorkflowContext.transport`, enabling seamless switching between local and distributed modes.

## Git Coordination

Multi-machine workflows coordinate via git:

1. **Pull before read** - Always fetch latest state
2. **Write artifacts** - Store context, plans, QA logs in `.ma/`
3. **Commit and push** - Share state with other machines
4. **Priority ordering** - Blocked tasks processed first

Example:
```
Machine A: Context scan → .ma/context/summary.md → commit → push
Machine B: Pull → read context → plan → .ma/planning/task-*.log → commit → push
Machine C: Pull → read plan → implement → commit → push
Machine A: Pull → QA test → .ma/qa/task-*.log → commit → push
```

## WorkflowContext

Shared state passed through all workflow steps:

```typescript
interface WorkflowContext {
  // Identifiers
  workflowId: string;
  projectId: string;
  
  // Repository
  repoRoot: string;
  branch: string;
  repoRemote: string;
  
  // Transport
  transport: MessageTransport;
  
  // State
  getVariable(key: string): any;
  setVariable(key: string, value: any): void;
  
  // Task data
  task: any;
  milestone?: any;
}
```

Steps access context to:
- Read task/milestone data
- Get previous step results via `getVariable()`
- Store results via `setVariable()`
- Use `transport` for persona communication

## Configuration

**Required** (`.env`):
```bash
PROJECT_BASE=/path/to/projects
TRANSPORT_TYPE=redis                          # or 'local'
DASHBOARD_API_BASE_URL=http://localhost:3000
LM_STUDIO_BASE_URL=http://localhost:1234
```

**Transport (Redis)**:
```bash
REDIS_HOST=localhost
REDIS_PORT=6379
```

**Personas**:
```bash
ALLOWED_PERSONAS=coordination,implementation-planner,lead-engineer,tester-qa
PERSONA_MODELS_JSON='{"lead-engineer":"qwen2.5-coder:32b","tester-qa":"gpt-4"}'
```

**Workflow Limits**:
```bash
COORDINATOR_MAX_ITERATIONS=500               # Max project loop iterations
```

## Testing

The system includes `LocalTransport` for fast, isolated testing:

```typescript
import { getTransport } from '../src/transport/transportFactory.js';
import { WorkflowEngine } from '../src/workflows/WorkflowEngine.js';

// Tests automatically use LocalTransport via tests/setup.ts
const transport = getTransport();
const engine = new WorkflowEngine();

await engine.executeWorkflow(
  'task-flow',
  'project-1',
  '/repo/path',
  'main',
  transport,
  { task: mockTask }
);
```

Test helpers in `tests/helpers/`:
- `coordinatorTestHelper.ts` - Coordinator test utilities
- `makeTempRepo.ts` - Temporary git repositories

Shared mocks in `tests/setup.ts`:
- Redis client (auto-mocked in tests)
- Dashboard API
- Git operations

## Running the System

**Start coordinator**:
```bash
npm run dev
```

**Execute workflow for a project**:
```bash
npx tsx src/tools/run_coordinator.ts <project_id>
```

**Run tests**:
```bash
npm test
```

---

*Documentation reflects current system architecture as of October 2025*
