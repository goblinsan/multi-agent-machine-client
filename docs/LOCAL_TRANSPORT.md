# Local Transport Guide

## Overview

The multi-agent machine client supports two transport types for message passing:

1. **Redis Transport** (`TRANSPORT_TYPE=redis`) - Distributed, multi-process messaging
2. **Local Transport** (`TRANSPORT_TYPE=local`) - In-memory, single-process messaging

## Local Transport Limitations

The Local Transport uses Node.js EventEmitter for in-memory messaging. **Important limitations:**

- ❌ **Single process only** - Cannot communicate across different Node.js processes
- ❌ **Messages lost on restart** - No persistence
- ❌ **Not for production** - Development and testing only

### Why separate processes don't work

When you run:
```bash
# Terminal 1
npm run dev

# Terminal 2
npm run coordinator -- 1
```

These are **two separate Node.js processes** with separate memory spaces. The `LocalTransport` in each process has its own `EventEmitter` instance, so they cannot communicate.

## Usage Patterns

### Option 1: Single-Process Workflow (Recommended for Local Transport)

Use the `run_local_workflow.ts` script which runs both the worker and coordinator in the same process:

```bash
# Set transport type in .env
TRANSPORT_TYPE=local

# Run workflow in single process
npx tsx src/tools/run_local_workflow.ts <project_id> [repo_url] [base_branch]

# Example:
npx tsx src/tools/run_local_workflow.ts 1
```

This script:
1. Starts the worker
2. Dispatches the coordinator workflow
3. Processes all messages until completion
4. Shuts down automatically

### Option 2: Redis for Distributed Workflows

For multi-process workflows (worker + coordinator in separate terminals):

```bash
# Set transport type in .env
TRANSPORT_TYPE=redis
REDIS_URL=redis://localhost:6379

# Terminal 1: Start worker
npm run dev

# Terminal 2: Dispatch workflow
npm run coordinator -- 1
```

With Redis, processes can communicate across terminals, containers, or even machines.

### Option 3: Testing with Local Transport

For automated testing, use the LocalTransport directly in your test code:

```typescript
import { LocalTransport } from '../src/transport/LocalTransport.js';

const transport = new LocalTransport();
await transport.connect();

// Dispatch messages
await transport.xAdd('agent.requests', '*', { ... });

// Read messages
const messages = await transport.xReadGroup(...);

await transport.disconnect();
```

## Quick Start

### For Local Development (Single Process)

1. Set in `.env`:
   ```
   TRANSPORT_TYPE=local
   ```

2. Run workflow:
   ```bash
   npx tsx src/tools/run_local_workflow.ts 1
   ```

### For Multi-Process Development

1. Install and start Redis:
   ```bash
   # macOS
   brew install redis
   brew services start redis
   
   # Linux
   sudo apt-get install redis-server
   sudo systemctl start redis
   ```

2. Set in `.env`:
   ```
   TRANSPORT_TYPE=redis
   REDIS_URL=redis://localhost:6379
   ```

3. Run worker and coordinator:
   ```bash
   # Terminal 1
   npm run dev
   
   # Terminal 2
   npm run coordinator -- 1
   ```

## When to Use Each Transport

| Use Case | Transport Type | Reason |
|----------|----------------|--------|
| Quick local testing | Local | No Redis needed, faster setup |
| Multi-terminal development | Redis | Separate worker and coordinator |
| Integration testing | Local | Isolated test environment |
| Production deployment | Redis | Distributed, persistent, scalable |
| CI/CD pipelines | Local | Faster, no external dependencies |
| Team development | Redis | Share state across services |

## Troubleshooting

### Problem: Worker not picking up messages

**Symptom:** You run `npm run coordinator -- 1` and it says "dispatched" but the worker doesn't process it.

**Cause:** You're using `TRANSPORT_TYPE=local` with separate processes.

**Solution:** Use `run_local_workflow.ts` or switch to `TRANSPORT_TYPE=redis`.

### Problem: Redis connection errors with local transport

**Symptom:** You see `ECONNREFUSED` errors even with `TRANSPORT_TYPE=local`.

**Cause:** Some code still tries to connect to Redis directly (not using transport abstraction).

**Solution:** Report this as a bug - all code should use the transport abstraction.

### Problem: Messages lost after restart

**Symptom:** Workflow state disappears when restarting the worker.

**Cause:** Local transport doesn't persist messages.

**Solution:** Use Redis for persistent messaging, or design workflows to be restartable.

## Related Files

- `src/transport/MessageTransport.ts` - Transport interface
- `src/transport/LocalTransport.ts` - Local implementation
- `src/transport/RedisTransport.ts` - Redis implementation
- `src/transport/index.ts` - Transport factory
- `src/tools/run_local_workflow.ts` - Single-process runner
- `src/tools/run_coordinator.ts` - Multi-process coordinator
- `src/worker.ts` - Main worker loop
