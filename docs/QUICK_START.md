# Quick Start Guide

## Running Workflows Locally

### Option 1: Full Local Stack (Recommended for Quick Testing) ⭐

The easiest way to test workflows locally without Redis:

```bash
# Ensure TRANSPORT_TYPE=local in your .env file
npm run local -- <project_id> [repo_url] [base_branch]
```

**Example:**
```bash
# Use a test project ID (e.g., 999 or any non-production ID)
npm run local -- 999
```

This single command:
1. ✅ Starts the dashboard backend (http://localhost:3000)
2. ✅ Dispatches the coordinator workflow
3. ✅ Starts the worker to process messages
4. ✅ Shows live progress
5. ✅ Shuts down automatically when complete

**When to use:**
- Quick local testing
- No Redis installation needed
- See everything in one terminal
- Automatic cleanup on completion

### Option 2: Multi-Process Development (With Redis)

For production-like development with separate services:

**Terminal 1 - Dashboard:**
```bash
cd src/dashboard-backend
npm run dev
```

**Terminal 2 - Worker:**
```bash
npm run dev
```

**Terminal 3 - Dispatch Workflow:**
```bash
npm run coordinator -- 1
```

**When to use:**
- Testing distributed setups
- Long-running workflows
- Multiple concurrent workflows
- Production-like environment

### Option 3: Single-Process Workflow (Without Dashboard)

For testing just the workflow processing:

```bash
npx tsx src/tools/run_local_workflow.ts 1
```

**When to use:**
- Testing workflow logic only
- No dashboard needed
- CI/CD pipelines
- Automated testing

## Transport Types

### Local Transport (`TRANSPORT_TYPE=local`)

In-memory messaging for single-process development.

**Pros:**
- ✅ No Redis needed
- ✅ Faster setup
- ✅ Perfect for testing

**Cons:**
- ❌ Single process only
- ❌ No persistence
- ❌ Not for production

**Set in `.env`:**
```bash
TRANSPORT_TYPE=local
```

**Use with:**
- `npm run local -- 1`
- `npx tsx src/tools/run_local_workflow.ts 1`

### Redis Transport (`TRANSPORT_TYPE=redis`)

Distributed messaging for multi-process/multi-machine setups.

**Pros:**
- ✅ Multi-process communication
- ✅ Persistent messages
- ✅ Production ready
- ✅ Distributed workflows

**Cons:**
- ❌ Requires Redis installation
- ❌ More setup needed

**Set in `.env`:**
```bash
TRANSPORT_TYPE=redis
REDIS_URL=redis://localhost:6379
```

**Install Redis:**
```bash
# macOS
brew install redis
brew services start redis

# Linux
sudo apt-get install redis-server
sudo systemctl start redis
```

**Use with:**
- `npm run dev` + `npm run coordinator -- 1`

## Complete Examples

### Example 1: Quick Local Test

```bash
# 1. Set transport type
echo "TRANSPORT_TYPE=local" >> .env

# 2. Run everything
npm run local -- 1

# Output:
# 🚀 Starting Local Stack
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# 📊 Starting dashboard backend...
# ✅ Dashboard backend started
#    URL: http://localhost:3000
# ⚙️  Starting worker...
# ✅ Worker ready
# 📤 Dispatching coordinator workflow...
# ✅ Workflow dispatched
#    Workflow ID: wf_coord_1760983794962
#    Project ID: 1
# 🔄 Processing workflow...
# ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
# [info] processing request { persona: 'coordination', ... }
# ...
# ✅ Workflow completed
# 🎉 Local stack completed successfully
```

### Example 2: Multi-Process with Redis

```bash
# 1. Start Redis
brew services start redis

# 2. Set transport type
echo "TRANSPORT_TYPE=redis" >> .env
echo "REDIS_URL=redis://localhost:6379" >> .env

# 3. Terminal 1 - Start dashboard
cd src/dashboard-backend && npm run dev

# 4. Terminal 2 - Start worker  
npm run dev

# 5. Terminal 3 - Dispatch workflow
npm run coordinator -- 1

# 6. View dashboard
open http://localhost:3000
```

### Example 3: With Custom Repository

```bash
npm run local -- 1 https://github.com/username/repo-name main
```

## Troubleshooting

### Worker not picking up messages

**Symptom:** `npm run coordinator` says "dispatched" but nothing happens

**Cause:** Using `TRANSPORT_TYPE=local` with separate processes

**Solution:** Use `npm run local -- 1` or switch to Redis transport

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

### Redis connection errors

**Symptom:** `ECONNREFUSED` errors

**Cause:** Redis not running or wrong URL

**Solution:**
```bash
# Check Redis is running
redis-cli ping
# Should return: PONG

# If not running
brew services start redis

# Check your .env has correct URL
cat .env | grep REDIS_URL
```

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

| Command | Description | Transport | Use Case |
|---------|-------------|-----------|----------|
| `npm run local -- 1` | Full local stack | local | Quick testing, demos |
| `npm run dev` | Worker only | any | Background processing |
| `npm run coordinator -- 1` | Dispatch workflow | any | Trigger workflows |
| `npx tsx src/tools/run_local_workflow.ts 1` | Worker + workflow | local | Testing without dashboard |
| `npm test` | Run test suite | local | Automated testing |

## What Happens When You Run `npm run local -- 1`

1. **Dashboard Startup** (2-5 seconds)
   - Spawns dashboard backend process
   - Waits for server to be ready
   - Dashboard available at http://localhost:3000

2. **Worker Initialization** (1 second)
   - Connects to local transport
   - Creates consumer groups
   - Starts message tracking

3. **Workflow Dispatch** (instant)
   - Creates coordinator message
   - Adds to request stream
   - Assigns workflow ID

4. **Message Processing** (varies)
   - Worker polls for messages
   - Processes each persona's tasks
   - Logs progress to console
   - Continues until workflow completes

5. **Automatic Shutdown** (when idle)
   - Detects no more messages
   - Stops dashboard backend
   - Closes transport connection
   - Exits cleanly

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

- [Local Transport Guide](./docs/LOCAL_TRANSPORT.md) - Detailed transport documentation
- [Workflow System](./docs/WORKFLOW_SYSTEM.md) - How workflows work
- [Persona System](./docs/PERSONA_RETRY_MECHANISM.md) - Agent coordination
- [Task Logging](./docs/TASK_LOGGING.md) - Understanding logs

## Support

If you encounter issues:

1. Check this guide first
2. Review the [Troubleshooting](#troubleshooting) section
3. Check logs: `tail -f machine-client.log`
4. Verify `.env` configuration
5. Try with a fresh dashboard database
