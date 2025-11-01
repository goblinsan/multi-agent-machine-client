# Changelog

A chronological history of major changes and improvements to the multi-agent machine client system.

---

## October 2025 - Code Quality & Infrastructure

### Documentation Consolidation (October 13, 2025)

**Impact**: Clean, maintainable documentation structure

**Changes**:

- Consolidated architecture clarifications into `WORKFLOW_SYSTEM.md`
- Added comprehensive "Project Loop Iteration Strategy" section
- Clarified two-level architecture (Project Loop vs Workflow Execution)
- Documented configurable iteration limits for large projects
- Archived 3 clarification documents to `docs/archive/`

**Configuration Added**:

- `COORDINATOR_MAX_ITERATIONS` environment variable (default: 500)
- Supports large projects with 500+ tasks (previously hardcoded at 100)
- Can be set to `unlimited` for very large projects

**Key Insights Documented**:

- Each iteration processes 1 task (not batches)
- Fresh task fetching enables immediate urgent response
- Priority-based task selection (blocked > in_review > in_progress > open)
- Tasks are sequential, allowing QA follow-ups to be picked up immediately

### Refactoring Project (Phases 1-3)

**Impact**: 337 lines eliminated, 10 reusable modules created, 100% test stability maintained

**Phase 1 - Test Infrastructure** (232 lines saved)

- Created `createFastCoordinator()` helper eliminating repetitive test setup
- Implemented `__mocks__` pattern solving Vitest's vi.mock() hoisting limitation
- Consolidated Redis mocks across 16 test files
- Files: 31 test files improved

**Phase 2 - Mock Consolidation** (25 lines saved)

- Created `__mocks__` for gitUtils, scanRepo, process modules
- Established "infrastructure vs data mocks" design pattern
- Strategic completion focusing on high-value consolidations
- Files: 7 test files improved

**Phase 3 - Production Code** (80 lines saved)

- Fixed timeout/retry duplication in persona and WorkflowEngine
- Created `src/redis/eventPublisher.ts` for centralized event publishing
- Created `src/redis/requestHandlers.ts` for request acknowledgment
- Files: 6 production files improved

**Key Learning**: Discovered that Vitest's vi.mock() is hoisted before imports, preventing helper function calls. Solution: `tests/__mocks__/[module].js` files that Vitest automatically uses when vi.mock() is called without a factory.

---

## October 2025 - Timeout & Retry Redesign

### Progressive Backoff System

**Problem**: Workflows aborted during valid retry attempts, no progressive backoff, inconsistent timeout handling.

**Solution Implemented**:

- Two-layer timeout system: PersonaRequestStep retries + WorkflowEngine wrapper
- Progressive backoff: 30s → 60s → 90s between attempts
- Smart timeout calculation: `(retries + 1) × timeout + backoff_sum + 30s buffer`
- Per-persona configuration via `PERSONA_TIMEOUTS_JSON`

**Example**: Context persona (60s timeout, 3 retries)

- Total: 4 attempts × 60s + 180s backoff + 30s buffer = 7.5 minutes

**Configuration**:

```bash
PERSONA_TIMEOUT_MAX_RETRIES=3
PERSONA_RETRY_BACKOFF_INCREMENT_MS=30000
PERSONA_TIMEOUTS_JSON='{"context":60000,"lead-engineer":180000}'
```

**Test Coverage**: 22 comprehensive tests covering retry logic, backoff progression, and edge cases.

---

## October 2025 - Distributed Coordination

### Task Logging & Context Synchronization

**Problem**: Multiple machines working on same project had stale context, unshared QA results, no planning history.

**Features Added**:

**QA Log Management**:

- Results written to `.ma/qa/task-{taskId}-qa.log`
- Automatic git commit and push after each QA run
- Timestamped entries with status, duration, full results
- Cross-machine visibility of test results

**Planning Log Management**:

- Plans written to `.ma/planning/task-{id}-plan.log`
- Git pull before read ensures latest from other machines
- Planning history awareness for iterative refinement
- Automatic commit and push after planning

**Context Synchronization**:

- `git pull --ff-only` before reading context files
- Priority: payload context → git-pulled disk context → fallback
- Ensures planners always see latest context scans

**Automatic Cleanup**:

- Task logs removed when task completes successfully
- Summaries preserved in `.ma/changelog.md`
- Reduces repository clutter while maintaining history

**Multi-Machine Flow**:

1. Machine A: Scans context → commits → pushes
2. Machine B: Pulls → plans using latest context → commits plan → pushes
3. Machine C: Pulls → tests → commits QA log → pushes
4. Machine B: Pulls → refines plan based on QA → commits → pushes
5. Any Machine: Completes task → cleanup logs → commit summary

---

## September 2025 - Workflow System

### YAML-Based Workflow Engine

**Transition**: From monolithic coordinator to declarative, modular workflows.

**Core Components**:

- **WorkflowEngine**: Step-based execution with dependency management
- **WorkflowCoordinator**: Backward-compatible integration layer
- **Step Registry**: Pluggable implementations (PersonaRequestStep, GitOperationStep, etc.)

**Features**:

- YAML workflow definitions for declarative configuration
- Automatic dependency resolution and ordering
- Conditional execution and parallel step support
- Per-step timeout and retry policies
- State management and context preservation

**Workflow Types**:

- `workflows/project-loop.yml`: Standard development workflow
- `workflows/hotfix.yml`: Emergency hotfix workflow
- `workflows/feature.yml`: Feature-specific workflow

**Example Workflow**:

```yaml
steps:
  - id: "planning"
    type: "persona-request"
    persona: "implementation-planner"
    timeout: 1800
    retries: 2

  - id: "implementation"
    type: "persona-request"
    persona: "lead-engineer"
    dependencies: ["planning"]

  - id: "qa"
    type: "persona-request"
    persona: "qa-engineer"
    dependencies: ["implementation"]
```

**Benefits**: Easier modification without code changes, clear visualization, reusable components, improved error handling.

---

## August 2025 - Multi-Agent Foundation

### Persona-Based Architecture

Established core distributed AI agent coordination system.

**Personas Implemented**:

- `coordination`: Workflow orchestration and task routing
- `implementation-planner`: Creates implementation plans
- `plan-evaluator`: Evaluates and refines plans
- `lead-engineer`: Code implementation
- `qa-engineer` / `tester-qa`: Test execution and validation
- `code-reviewer`: Code quality review
- `security-review`: Security assessment
- `architect`: System design decisions
- `project-manager`: Task prioritization

**Communication Layer**:

- Redis Streams for async message passing
- Consumer groups for reliable delivery
- xReadGroup for persona-specific consumption
- Event stream for status updates

**Task Flow**:

1. Task received from dashboard API
2. Coordination routes to appropriate workflow
3. Personas execute steps with dependency management
4. Git operations manage branches, commits, pushes
5. Results synchronized back to dashboard

---

## July 2025 - Core Infrastructure

### Foundation Architecture

**Configuration System**:

- Environment-based via `.env`
- Multiple personas per machine
- Model mappings for LM Studio integration
- Project base directory management

**Redis Integration**:

- Request stream (`machine:requests`) for tasks
- Event stream (`machine:events`) for status
- Consumer groups per persona for distribution
- Stream acknowledgment for reliability

**LM Studio Integration**:

- HTTP API client for local LLM inference
- Configurable timeouts per persona
- Streaming response support
- Error handling and retry logic

**Git Operations**:

- Repository resolution from payloads
- Branch management (create, checkout, switch)
- Commit and push automation
- Remote synchronization

**Dashboard Integration**:

- Task status updates via REST API
- Context and artifact uploads
- Project status queries
- Milestone tracking

---

## Design Principles

### Established Patterns

**1. Infrastructure vs Data Mocks**

- Infrastructure mocks (Redis, git) → Consolidate in `__mocks__/`
- Data mocks (test-specific) → Keep inline for clarity
- Balance: Clean setup + test readability

**2. Timeout Management**

- Per-persona configurable timeouts
- Progressive backoff for retries (30s, 60s, 90s)
- Smart workflow timeout calculation
- Separate timeouts for coding vs non-coding personas

**3. Error Handling**

- Graceful degradation with retry policies
- Comprehensive logging at each failure
- Task marked as "blocked" after exhaustion
- Event stream notifications for monitoring

**4. Distributed Coordination**

- Git as source of truth for shared state
- Redis streams for async messaging
- Pull-before-read for synchronization
- Automatic cleanup when complete

**5. Test-Driven Development**

- 139 tests covering workflows and edge cases
- `__mocks__` for consistent infrastructure
- Test helpers for common patterns
- Performance target: <8s suite

---

## System Evolution

### Architecture Journey

**Monolithic → Modular**

- Before: Single coordinator with embedded logic
- After: YAML workflows with pluggable steps
- Benefit: Easier modification, better visibility, reusable components

**Simple → Sophisticated Retry**

- Before: Single timeout, no retries, early abort
- After: Progressive backoff, calculated timeouts, stays alive
- Benefit: Higher success rate, better resource utilization

**Manual → Automatic Sync**

- Before: Stale context files across machines
- After: Auto git pull before read, fresh context guaranteed
- Benefit: Consistent project state across distributed machines

**Scattered → Consolidated**

- Before: 337 lines duplicate code
- After: Centralized helpers and infrastructure
- Benefit: Easier maintenance, single source of truth

---

## Configuration Reference

### Key Environment Variables

```bash
# Redis
REDIS_HOST=localhost
REDIS_PORT=6379

# Personas
ALLOWED_PERSONAS=coordination,implementation-planner,lead-engineer,qa-engineer
PERSONA_MODELS_JSON='{"lead-engineer":"qwen2.5-coder:32b","qa-engineer":"gpt-4"}'

# Timeouts
PERSONA_TIMEOUTS_JSON='{"context":60000,"lead-engineer":180000}'
PERSONA_DEFAULT_TIMEOUT_MS=60000
PERSONA_CODING_TIMEOUT_MS=180000
PERSONA_TIMEOUT_MAX_RETRIES=3
PERSONA_RETRY_BACKOFF_INCREMENT_MS=30000

# Project
PROJECT_BASE=/path/to/projects
DASHBOARD_API_BASE_URL=https://dashboard.example.com/api

# LM Studio
LM_STUDIO_BASE_URL=http://localhost:1234
```

### Directory Structure

```
.ma/
├── context/
│   ├── summary.md              # Project context
│   └── files.ndjson           # File-by-file context
├── planning/
│   └── task-{id}-plan.log     # Planning logs
└── qa/
    └── task-{id}-qa.log       # QA results

workflows/
├── project-loop.yml            # Standard workflow
├── hotfix.yml                  # Hotfix workflow
└── feature.yml                 # Feature workflow

src/
├── redis/
│   ├── eventPublisher.ts      # Event publishing
│   └── requestHandlers.ts     # Request ack
├── workflows/
│   ├── WorkflowEngine.ts      # Execution engine
│   ├── WorkflowCoordinator.ts # Integration layer
│   └── steps/                 # Step implementations
└── agents/
    └── persona.ts             # Persona handling

tests/
├── __mocks__/                 # Shared infrastructure
│   ├── redisClient.js
│   ├── gitUtils.js
│   └── ...
└── helpers/
    └── coordinatorTestHelper.ts
```

---

## Test Suite

**Current Status**: 139 passing, 9 skipped (148 total), ~7.4s duration

**Key Test Helpers**:

- `tests/__mocks__/` - Shared test infrastructure
- `tests/helpers/coordinatorTestHelper.ts` - Test utilities
- `createFastCoordinator()` - Fast coordinator setup
- `makeTempRepo()` - Temporary git repos for testing

**Testing Best Practices**:

1. Maintain 100% test stability
2. Use `__mocks__` for infrastructure
3. Keep test-specific data inline
4. Test timeout and retry scenarios
5. Consider distributed coordination

---

## Future Roadmap

### Planned

- Visual workflow designer
- Real-time monitoring dashboard
- Advanced analytics and optimization
- Multi-repository coordination

### Under Consideration

- Workflow composition and nesting
- Dynamic workflow generation
- External workflow engine integration
- Plugin architecture for extensions

---

## Migration Guide

### Updating Timeout Configuration

**Old** (pre-October 2025):

```bash
PERSONA_DEFAULT_TIMEOUT_MS=60000
```

**New**:

```bash
PERSONA_DEFAULT_TIMEOUT_MS=60000
PERSONA_TIMEOUT_MAX_RETRIES=3
PERSONA_RETRY_BACKOFF_INCREMENT_MS=30000
PERSONA_TIMEOUTS_JSON='{"context":60000,"lead-engineer":180000}'
```

### Using New Redis Helpers

**Old**:

```typescript
await r.xAdd(cfg.eventStream, "*", {
  workflow_id: msg.workflow_id,
  status: "done",
  result: JSON.stringify(result),
  ts: new Date().toISOString(),
});
```

**New**:

```typescript
import { publishEvent } from "./redis/eventPublisher.js";

await publishEvent(r, {
  workflowId: msg.workflow_id,
  status: "done",
  result,
});
```

### Using New Test Helpers

**Old**:

```typescript
vi.mock("../src/redisClient.js", () => ({
  makeRedis: vi.fn().mockResolvedValue({
    xGroupCreate: vi.fn(),
    xReadGroup: vi.fn(),
    // ... 10 more lines
  }),
}));
```

**New**:

```typescript
vi.mock("../src/redisClient.js"); // Uses tests/__mocks__/redisClient.js
```

---

## Contributing

When making changes:

1. **Test Stability**: All 139 tests must pass
2. **Follow Patterns**: Use `__mocks__` for infrastructure, helpers for setup
3. **Update Docs**: Update CHANGELOG.md and WORKFLOW_SYSTEM.md
4. **Distributed Aware**: Will your change work across multiple machines?
5. **Test Timeouts**: Verify retry logic works as expected

---

_Last Updated: October 13, 2025_
_Test Suite: 139 passing | 9 skipped | 7.44s duration_
