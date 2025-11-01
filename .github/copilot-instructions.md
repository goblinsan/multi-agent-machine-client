# GitHub Copilot Instructions

## Project Overview

This is a Redis-based multi-agent machine client written in TypeScript that:

- Listens on Redis Streams for persona-based tasks
- Integrates with local LM Studio models
- Manages git repositories under PROJECT_BASE
- Implements TDD-aware coordination

## Key Architecture

- `src/workflows/coordinator.ts` - Main orchestration logic
- `src/agents/` - Persona implementations
- `src/milestones/` - Milestone management
- `src/tasks/` - Task management
- `tests/` - Comprehensive test suite with safety guards

## Development Patterns

- Use existing TypeScript patterns from src/
- Follow test patterns in tests/ directory
- Git operations must use temp directories in tests
- Persona system handles different agent types
- Redis streams for async communication

## Testing Guidelines

- Use vitest framework
- Import test helpers from tests/setup.ts
- Use makeTempRepo() for git operations in tests
- Tests run with safety guards to protect working repo

## Common Commands

- `npm test` - Run test suite
- `npm run dev` - Development mode
- Tests are configured via vitest.config.ts
