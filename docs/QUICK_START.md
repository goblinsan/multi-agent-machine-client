# Quick Start Guide

Note: This project now centers on the modern Workflow Engine and Coordinator. The legacy worker/process and local single-process runners have been removed.

## Recommended: Run the test suite

The tests exercise the coordinator and workflows end-to-end without requiring any external services.

```bash
npm test
```

## Dispatch a coordinator workflow (advanced)

You can enqueue a coordinator message to the request stream. This is useful when integrating with your own runtime or for manual testing of dispatch. Processing the message requires a worker/executor in your environment; this repository no longer ships a legacy worker process.

```bash
# Example: send a coordinator message for project id 1
npm run coordinator -- 1
```

Environment variables (e.g., repo URL, base branch) can be provided via CLI args or .env and are forwarded by `run_coordinator.ts`.

## Transport

The coordinator tool uses the configured transport abstraction. In tests, an in-memory transport is used. For external runtimes, configure your preferred transport via `.env`.

## Complete Examples

### Example: Multi-Process with Redis

```bash
# 1. Start Redis
brew services start redis

# 2. Set transport type
echo "TRANSPORT_TYPE=redis" >> .env
echo "REDIS_URL=redis://localhost:6379" >> .env

# 3. Terminal 1 - Start dashboard
cd src/dashboard-backend && npm run dev

# 4. Terminal 2 - Dispatch workflow
npm run coordinator -- 1

# 6. View dashboard
open http://localhost:3000
```

### Example: With Custom Repository

```bash
npm run coordinator -- 1 https://github.com/username/repo-name main
```

## Troubleshooting

### No processing after dispatch

**Symptom:** `npm run coordinator` prints "dispatched" but you don’t see processing

**Cause:** This repository no longer includes a legacy worker process

**Solution:** Integrate with your own executor/worker runtime that consumes from the request stream and executes workflows, or use the test suite for in-process execution.

### Dashboard not starting

**Symptom:** "Failed to start dashboard backend"

**Cause:** Dashboard may already be running or port 3000 is in use

**Solution:**
```bash
# Check what's using port 3000
lsof -i :3000

# Kill the process
kill -9 <PID>

# Try again
npm run local -- 1
```

### Transport configuration

If you’re using an external transport (e.g., Redis) in your environment, ensure your `.env` is configured appropriately. The test suite doesn’t require external services.

## Environment Variables

Essential configuration in `.env`:

```bash
# Transport (choose one)
TRANSPORT_TYPE=local          # For single-process
# TRANSPORT_TYPE=redis        # For multi-process

# Redis (only needed if using redis transport)
# REDIS_URL=redis://localhost:6379

# Personas and models
ALLOWED_PERSONAS=context,plan-evaluator,implementation-planner,lead-engineer,code-reviewer,security-review,tester-qa,coordination,project-manager,architect,summarization

PERSONA_MODELS_JSON={"plan-evaluator":"qwen3-coder-30b","implementation-planner":"qwen3-coder-30b","lead-engineer":"qwen3-coder-30b","code-reviewer":"qwen3-coder-30b","security-review":"qwen3-coder-30b","coordination":"llama3-8b-general","project-manager":"llama3-8b-general","architect":"llama3-8b-general","summarization":"llama3-8b-general","tester-qa":"qwen3-coder-30b","context":"llama3-8b-general"}

# LM Studio
LMS_BASE_URL=http://127.0.0.1:1234

# Dashboard
DASHBOARD_BASE_URL=http://localhost:3000

# Git workspace
PROJECT_BASE=~/code
```

## NPM Scripts Reference

| Command | Description |
|---------|-------------|
| `npm test` | Run test suite (in-process execution) |
| `npm run coordinator -- 1` | Dispatch a coordinator message |

## What Happens When You Run `npm run local -- 1`

1. **Workflow Dispatch** (instant)
   - Creates coordinator message
   - Adds to request stream
   - Assigns workflow ID

2. **Processing**
   - Handled by your executor/worker runtime consuming the stream
   - In tests, processing is performed in-process without external services

## Next Steps

1. **First Run:**
   ```bash
   npm run local -- 1
   ```

2. **Check Dashboard:**
   Open http://localhost:3000 in your browser

3. **View Logs:**
   ```bash
   tail -f machine-client.log
   ```

4. **Explore:**
   - Try different project IDs
   - Add repositories to workflows
   - Monitor task progress in dashboard

## Additional Resources

- [Workflow System](./docs/WORKFLOW_SYSTEM.md) - How workflows work (modern engine)
- [Persona System](./docs/PERSONA_RETRY_MECHANISM.md) - Agent coordination
- [Task Logging](./docs/TASK_LOGGING.md) - Understanding logs

## Support

If you encounter issues:

1. Check this guide first
2. Review the [Troubleshooting](#troubleshooting) section
3. Check logs: `tail -f machine-client.log`
4. Verify `.env` configuration
5. Try with a fresh dashboard database
