# Architecture

**Last Updated**: October 25, 2025

## Core Principles

1. **Transport Abstraction**: All messaging goes through `MessageTransport` interface
2. **Local-First Development**: Primary development mode uses in-memory `LocalTransport`
3. **No Direct Redis Dependencies**: Use transport layer, never import redis client directly
4. **Single Entry Point**: `run_coordinator.ts` dispatches coordinator messages

## Transport Layer

### MessageTransport Interface

All message passing uses the `MessageTransport` abstraction located in `src/transport/`:

- `MessageTransport.ts` - Interface definition
- `LocalTransport.ts` - In-memory implementation (single process)
- `RedisTransport.ts` - Distributed implementation (multi-worker)

**Usage:**
```typescript
import { getTransport } from "./transport/index.js";

const transport = await getTransport();  // Returns LocalTransport or RedisTransport based on TRANSPORT_TYPE
await transport.xAdd(streamName, "*", fields);
await transport.xReadGroup(group, consumer, streams);
```

### Transport Selection

Controlled by `TRANSPORT_TYPE` environment variable:

- `TRANSPORT_TYPE=local` - Uses `LocalTransport` (default, recommended for development)
- `TRANSPORT_TYPE=redis` - Uses `RedisTransport` (for distributed/production)

## Workflow Execution

### Entry Points

#### run_coordinator.ts

**Purpose**: Dispatch coordinator messages to trigger workflow execution

**Usage**:
```bash
npm run coordinator -- <project_id> [repo_url] [base_branch]
npm run coordinator -- --drain-only  # Clear streams
npm run coordinator -- --nuke        # Destroy streams and groups
```

**What it does**:
1. Creates transport connection
2. Sends message to `cfg.requestStream` with `to_persona: COORDINATION`
3. Exits immediately (does NOT stay running)

#### run_local.ts

**Purpose**: Full local development stack orchestration (all-in-one)

**Usage**:
```bash
npm run local -- <project_id> [repo_url] [base_branch]
```

**What it does**:
1. Starts dashboard backend (port 3000)
2. Dispatches coordinator message to `cfg.requestStream`
3. Processes the coordinator workflow using `handleCoordinator()`
4. Shuts down gracefully on completion or SIGINT/SIGTERM

**When to use**: Local development with single-process execution

## Dashboard

### Local Dashboard

Located in `src/dashboard-backend/`, provides:
- Project API
- Task API
- Context snapshots
- Event recording

Start with: `npm run dev` (from dashboard-backend directory)

### Remote Dashboard

Optional external dashboard for distributed mode. Set `DASHBOARD_URL` environment variable.

## Architecture Validation

**Test**: `tests/architectureValidation.test.ts`

This test enforces architectural boundaries:
- ✅ No `src/redis/` directory exists
- ✅ No imports from `redis/` subdirectory
- ✅ No usage of old helper functions (`publishEvent`, `acknowledgeRequest`, `groupForPersona`)
- ✅ Transport abstraction files exist
- ✅ `run_coordinator.ts` exists

**If this test fails, you are regressing to old architecture!**

## Migration from Old Architecture

### What Was Removed

- ❌ `src/redis/eventPublisher.ts` - Old helper, use `transport.xAdd(cfg.eventStream, ...)`
- ❌ `src/redis/requestHandlers.ts` - Old helper, use `transport.xAck(...)` directly
- ❌ `src/worker.ts` - Old worker loop, replaced by transport-based coordination
- ❌ Direct redis client imports - All messaging through transport layer

### What Replaced It

- ✅ `src/transport/MessageTransport.ts` - Abstract interface
- ✅ `src/transport/LocalTransport.ts` - In-memory implementation
- ✅ `src/transport/RedisTransport.ts` - Redis implementation  
- ✅ `src/tools/run_coordinator.ts` - Entry point for dispatching workflows

### Correct Patterns

**Old (WRONG)**:
```typescript
import { publishEvent } from './redis/eventPublisher.js';
await publishEvent(redis, { workflowId, status: 'done' });
```

**New (CORRECT)**:
```typescript
import { getTransport } from './transport/index.js';
const transport = await getTransport();
await transport.xAdd(cfg.eventStream, '*', {
  workflow_id: workflowId,
  status: 'done',
  ts: new Date().toISOString()
});
```

## File Organization

```
src/
├── transport/           # Message transport abstraction
│   ├── MessageTransport.ts
│   ├── LocalTransport.ts
│   └── RedisTransport.ts
├── tools/              # CLI entry points
│   ├── run_coordinator.ts  (dispatch coordinator messages)
│   └── seed_example.ts     (seed example data)
├── dashboard-backend/  # Local dashboard server
├── workflows/          # Workflow definitions and engine
├── agents/             # Persona implementations
├── tasks/              # Task management
└── milestones/         # Milestone management
```

## Development Workflow

1. Set `TRANSPORT_TYPE=local` in `.env`
2. Run the local orchestrator: `npm run local -- <project_id>`
   - This starts dashboard, dispatches coordinator, and processes workflows
   
**OR** for separate components:

1. Start local dashboard: `cd src/dashboard-backend && npm run dev`
2. Dispatch coordinator: `npm run coordinator -- <project_id>`
3. (Future) Run worker process to handle messages

## Common Pitfalls

### ❌ Don't: Import from redis/ subdirectory
```typescript
import { publishEvent } from './redis/eventPublisher.js';  // WRONG!
```

### ✅ Do: Use transport abstraction
```typescript
import { getTransport } from './transport/index.js';
const transport = await getTransport();
await transport.xAdd(...);
```

### ❌ Don't: Create redis client directly
```typescript
import { createClient } from 'redis';
const redis = createClient();  // WRONG!
```

### ✅ Do: Use getTransport
```typescript
import { getTransport } from './transport/index.js';
const transport = await getTransport();  // Returns LocalTransport or RedisTransport
```

### ❌ Don't: Reference worker.ts patterns
worker.ts no longer exists - it was part of the old architecture.

### ✅ Do: Use run_coordinator.ts pattern
Dispatch messages to the coordination persona, let WorkflowCoordinator handle execution.
