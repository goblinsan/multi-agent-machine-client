# Multi-Agent Machine Client (TypeScript)

Distributed coordinator that executes YAML-defined workflows by routing persona requests through local transports and LM Studio-backed models.

## Overview

- Orchestrates multi-step workflows described in `src/workflows/definitions/*.yaml`
- Supports multiple message transports: Redis Streams for distributed setups, EventEmitter for local runs (`npm run local`)
- Integrates with local LM Studio models while keeping persona prompts and responses on the host machine
- Manages git worktrees under `PROJECT_BASE`, cloning or reusing repositories per task
- Implements TDD-aware planning and evaluation loops that steer persona execution order
- Designed for multi-machine execution but defaults to a single-process local mode for debugging

## Transports

- **EventEmitter (default local mode)**: `npm run local -- <projectId>` starts coordinator and persona loops inside one process using an in-memory bus. Ideal for development and CI.
- **Redis Streams**: `npm run coordinator` with worker processes started via `npm run dev` enables distributed personas. Redis remains fully supported but is optional.

Both transports share the same workflow engine and persona execution stack; switching is a configuration choice, not a feature gap.

## Repo Workspace Semantics

- `PROJECT_BASE` points to a directory that stores checked-out repositories; it is not itself a git repo.
- Repositories are resolved from payload hints (e.g., `repo_root`) or cloned using dashboard metadata. No implicit default repo exists.
- Multi-repo workflows resolve paths per step so each persona receives consistent artifact locations.

## Workflow System

- YAML workflows describe persona steps, git actions, conditionals, and retries.
- Coordinator selects a workflow per task based on triggers (status, priority, labels) or falls back to a legacy-compatible definition.
- Steps use shared helpers for variable resolution, template inheritance, and diff application safety.
- See `docs/WORKFLOW_SYSTEM.md` for the full specification.

## TDD-Aware Coordination

- Dashboard labels and payload hints drive the active TDD stage.
- Governance personas are gated while tests are expected to fail, then re-enabled when implementation passes QA.
- Optional CLI overrides (`--workflow-mode`, `--tdd-stage`, `--qa-expectations`) allow ad-hoc control during manual runs.

## Development

- Tests run via `npm test -s`. Vitest fixtures enforce sandboxed git operations using temp repos created by `tests/makeTempRepo.ts`.
- Type checking (`npm run typecheck`) and linting (`npm run lint`) execute in pre-commit hooks alongside the test suite.
- `npm run local -- <projectId>` starts a self-contained EventEmitter session.
- `npm run coordinator -- --drain <projectId>` pairs with `npm run dev` persona workers for Redis-backed runs.

## LM Studio Integration

- Models and persona timeouts are configured in `src/config.ts`.
- Default setup targets LM Studio at `http://127.0.0.1:1234`. Adjust `LMS_BASE_URL` to match your local endpoint.

## Environment

See `.env.example` for the full set of configuration flags, including transport selection, dashboard URLs, and git settings.
