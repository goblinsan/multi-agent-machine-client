# GitHub Copilot Instructions

## Project Overview

This is a multi-agent machine client written in TypeScript that:

- Manages workflow execution via YAML-based workflow definitions
- Supports multiple transports (Redis Streams, EventEmitter for local mode)
- Integrates with local LM Studio models for persona-based agents
- Manages git repositories under PROJECT_BASE
- Implements TDD-aware coordination with planning/evaluation loops
- Designed for distributed execution across machines, currently running in local mode for debugging

## Key Architecture

- `src/workflows/` - Workflow engine and coordinator
  - `WorkflowCoordinator.ts` - Main orchestration logic
  - `WorkflowEngine.ts` - Executes workflow definitions
  - `templates/*.yaml` - YAML workflow and step templates
- `src/agents/` - Persona implementations and request handlers
- `src/tasks/` - Task management and API integration
- `src/milestones/` - Milestone management
- `src/dashboard-backend/` - Local project dashboard (alternative to remote dashboard for distributed workflow)
- `tests/` - Comprehensive test suite with safety guards

## Development Patterns

- Use existing TypeScript patterns from src/
- Follow test patterns in tests/ directory
- Git operations must use temp directories in tests
- Persona system handles different agent types
- Multiple transports supported (Redis Streams for distributed, EventEmitter for local)
- YAML templates define workflow steps and configurations
- Template expansion happens in ConfigResolver and VariableResolver
- Local dashboard-backend is alternative to remote project dashboard for distributed workflow design
- Project currently runs in local mode for debugging, designed for distributed execution across network

## Git Commit Guidelines

- Use single-line commit messages only (no multi-line messages)
- Format: Brief imperative description (e.g., "Fix task payload conversion bug")
- Do not add additional body or footer text
- NEVER attempt to bypass the pre-commit husky hook with --no-verify or similar flags
- Pre-commit hooks run: file size checks, TypeScript type checking, ESLint with --max-warnings=0, and tests

## Testing Guidelines

- Use vitest framework
- Import test helpers from tests/setup.ts
- Use makeTempRepo() for git operations in tests
- Tests run with safety guards to protect working repo

## Common Commands

- `npm test` - Run test suite
- `npm run dev` - Development mode
- Tests are configured via vitest.config.ts
