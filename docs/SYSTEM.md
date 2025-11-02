# Multi-Agent Machine Client System

## Overview

TypeScript multi-agent workflow runner that coordinates persona requests against LM Studio-hosted models. The system executes YAML-defined workflows, manages git repositories under `PROJECT_BASE`, and runs in either a local EventEmitter mode or a Redis-backed distributed topology.

## Architecture

### Core Components

**Workflow Engine**: Loads YAML definitions, evaluates triggers, and executes step graphs.
**Persona System**: Persona workers share context extraction, message formatting, and LM Studio invocation logic.
**Transport Layer**: EventEmitter bus for single-process runs; Redis Streams transport for multi-process deployments.
**Git Management**: Utilities that clone, branch, and apply diff specs safely within `PROJECT_BASE`.
**Dashboard Integrations**: Optional project/task API provides payloads, milestones, and governance hints.

### Key Directories

```
src/
├── agents/           # Parsers and persona-specific response handling
├── workflows/        # Engine, step registry, templates, and YAML definitions
├── personas/         # Persona request execution and context extraction
├── tasks/            # Task ingestion and lifecycle helpers
├── milestones/       # Milestone tracking utilities
├── git/              # Repository and branch operations
├── transport/        # EventEmitter and Redis implementations
└── tools/            # CLI entry points (coordinator, workers, local run)
```

## Transport Layer

- **EventEmitter (local)**: Default for `npm run local -- <projectId>`. Coordinator and personas share a process and communicate via in-memory events.
- **Redis Streams (distributed)**: Launch coordinator (`npm run coordinator`) and persona workers (`npm run dev`) as separate processes or machines while reusing the same workflow logic.

Transports are interchangeable; workflows and persona behaviors do not depend on which option is active.

## Workflow System

- Workflows live in `src/workflows/definitions/` and inherit common templates from `src/workflows/templates/`.
- The `WorkflowCoordinator` evaluates trigger conditions to select a workflow per task (status, priority, labels, repository hints).
- Steps include persona requests, git operations, conditional branches, and evaluation loops.
- Template expansion, variable resolution, and edit safety checks happen in shared helpers such as `ConfigResolver` and `VariableResolver`.

### Example Step

```yaml
- id: implementation
  type: persona-request
  persona: lead-engineer
  timeout_ms: 3600000
  retries:
    max: 2
    strategy: exponential
```

## Persona System

- Active personas are declared in `src/personaNames.ts` and cover context scanning, planning, engineering, QA, governance, PM, architecture, and summarization functions.
- `PersonaConsumer` spins up loops per persona using the selected transport and delegates work to `PersonaRequestExecutor`.
- `ContextExtractor` ensures artifacts are read from `repo_root` when available, falling back to cloned directories under `PROJECT_BASE`.
- Coordination persona bypasses the LLM path and invokes the workflow coordinator directly for recursive flows.

## TDD and Governance Coordination

- Dashboard labels or payload hints set `workflow_mode`, `tdd_stage`, and QA expectations.
- Governance personas (code review, security) are skipped during failing-test stages and re-enabled after QA success.
- CLI overrides let operators adjust stages without mutating dashboard data.

## Git Operations

- All git commands operate inside repositories rooted in `PROJECT_BASE`.
- Diff application uses a deny-list policy for blocked extensions and protects `.git` internals.
- Workflow steps can request commits, create branches, or collect artifacts for persona prompts.

## Configuration

- `.env.example` lists required variables such as transport selection, Redis connection string (optional), LM Studio base URL, dashboard endpoint, and log level.
- `src/config.ts` merges environment variables with defaults for persona models and timeouts.

## Testing and Tooling

- Vitest suite (`npm test -s`) covers workflows, persona routing, diff application, and git safety.
- `tests/makeTempRepo.ts` provisions sandbox repositories so git-related tests never touch real worktrees.
- ESLint enforces the zero-comment policy; TypeScript strict mode keeps runtime contracts explicit.

## Operational Notes

- `npm run local -- <projectId>`: Single-process EventEmitter run for rapid iteration.
- `npm run coordinator -- --drain <projectId>` plus `npm run dev`: Redis-backed deployment.
- `scripts/monitor-redis-streams.ts` remains available for diagnosing Redis traffic when that transport is in use.

## Future Work

- Parallel step execution support within the workflow engine.
- Additional transport adapters for message buses beyond Redis.
- Enhanced persona analytics surfaced through the dashboard backend.
