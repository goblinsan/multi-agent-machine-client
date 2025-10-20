# Testing the Local Stack Command

## Safe Testing Without Affecting Real Projects

### Option 1: Automated Test Script (Recommended)

Use the provided test script that creates a temporary test project:

```bash
./scripts/test-local-stack.sh
```

This will:
1. Check if dashboard is running (start it if needed)
2. Create a test project with milestones and tasks
3. Show you the project ID to use
4. Provide cleanup commands

**Example output:**
```
🧪 Testing Local Stack Command
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

✅ Dashboard already running

📝 Creating test project...
✅ Test project created with ID: 5

📋 Creating test milestone...
✅ Test milestone created with ID: 3

📌 Creating test tasks...
✅ Test tasks created

🎯 Test project setup complete!
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━

Project ID: 5
Dashboard: http://localhost:3000

You can now test the local stack command:

  npm run local -- 5
```

### Option 2: Manual Test Project Creation

Create a test project manually:

```bash
# 1. Ensure dashboard is running
cd src/dashboard-backend
npm run dev

# 2. In another terminal, create a test project
curl -X POST http://localhost:3000/projects \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Test Project",
    "slug": "test-'$(date +%s)'",
    "description": "Temporary test project"
  }'

# Note the project ID from the response (e.g., "id": 5)

# 3. Test the local stack
npm run local -- 5

# 4. Clean up when done
curl -X DELETE http://localhost:3000/projects/5
```

### Option 3: Use Existing Test Data

If you have existing test projects in your dashboard:

```bash
# List projects to find a test one
curl http://localhost:3000/projects

# Use a test project ID
npm run local -- 999
```

## Quick 5-Second Test

Test that everything starts up correctly without running a full workflow:

```bash
# This will start everything and automatically stop after 5 seconds
timeout 5 npm run local -- 999 || true
```

**Expected output:**
```
🚀 Starting Local Stack
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
📊 Starting dashboard backend...
✅ Dashboard backend started
   URL: http://localhost:3000

⚙️  Starting worker...
✅ Worker ready

📤 Dispatching coordinator workflow...
✅ Workflow dispatched
   Workflow ID: wf_coord_1760984562123
   Project ID: 999

🔄 Processing workflow...
━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━
[info] processing request { persona: 'coordination', ... }
```

## Cleanup After Testing

Remove test projects:

```bash
# Delete a specific test project
curl -X DELETE http://localhost:3000/projects/999

# Or delete all projects with "test" in the name (careful!)
curl http://localhost:3000/projects | jq '.[] | select(.name | contains("Test")) | .id' | while read id; do
  curl -X DELETE http://localhost:3000/projects/$id
done
```

## Common Test Scenarios

### Test 1: Verify Stack Starts

```bash
# Create test project
./scripts/test-local-stack.sh

# Run for 5 seconds to verify startup
timeout 5 npm run local -- <PROJECT_ID> || true

# Should see:
# - Dashboard started
# - Worker ready
# - Workflow dispatched
# - Starting to process
```

### Test 2: Complete Mini Workflow

```bash
# Create a small test project with 1-2 tasks
PROJECT_ID=$(curl -s -X POST http://localhost:3000/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"Mini Test","slug":"mini-'$(date +%s)'"}' | jq -r '.id')

# Let it run (will auto-stop when complete)
npm run local -- $PROJECT_ID

# Clean up
curl -X DELETE http://localhost:3000/projects/$PROJECT_ID
```

### Test 3: Monitor in Dashboard

```bash
# 1. Start dashboard separately (to keep it running)
cd src/dashboard-backend && npm run dev

# 2. In another terminal, create test project
./scripts/test-local-stack.sh

# 3. Open dashboard in browser
open http://localhost:3000

# 4. Run local stack with test project
npm run local -- <PROJECT_ID>

# 5. Watch progress in dashboard UI
```

## Troubleshooting Tests

### Dashboard Already Running

If you see errors about port 3000 being in use:

```bash
# Find what's using port 3000
lsof -i :3000

# Kill it
kill -9 <PID>

# Or let the script detect it
./scripts/test-local-stack.sh
```

### Test Project Creation Fails

```bash
# Check dashboard health
curl http://localhost:3000/health

# Check if database exists
ls -la src/dashboard-backend/data/

# Restart dashboard
pkill -f dashboard-backend
cd src/dashboard-backend && npm run dev
```

### Workflow Doesn't Start

```bash
# Check transport type
grep TRANSPORT_TYPE .env
# Should be: TRANSPORT_TYPE=local

# Check logs
tail -f machine-client.log

# Verify worker is running
ps aux | grep "tsx.*worker"
```

## CI/CD Testing

For automated testing in CI/CD:

```bash
#!/bin/bash
set -e

# Start dashboard in background
cd src/dashboard-backend
npm run dev &
DASHBOARD_PID=$!
sleep 5

# Create test project
PROJECT_ID=$(curl -s -X POST http://localhost:3000/projects \
  -H "Content-Type: application/json" \
  -d '{"name":"CI Test","slug":"ci-'$CI_BUILD_ID'"}' \
  | jq -r '.id')

# Run workflow with timeout
timeout 300 npm run local -- $PROJECT_ID || true

# Cleanup
kill $DASHBOARD_PID
```

## Best Practices

1. **Always use test project IDs** - Never test with production project ID 1
2. **Clean up after tests** - Delete test projects when done
3. **Use unique slugs** - Include timestamps to avoid conflicts
4. **Monitor logs** - Check `machine-client.log` for issues
5. **Timeout long tests** - Use `timeout` command to prevent hanging
6. **Verify cleanup** - Check dashboard after tests to ensure projects deleted

## Example Test Session

```bash
# 1. Setup
./scripts/test-local-stack.sh
# Note the PROJECT_ID output (e.g., 7)

# 2. Quick startup test
timeout 5 npm run local -- 7 || true

# 3. Full workflow test (if startup worked)
npm run local -- 7

# 4. Verify in dashboard
open http://localhost:3000

# 5. Clean up
curl -X DELETE http://localhost:3000/projects/7
```

## Summary

✅ **Do:**
- Use `./scripts/test-local-stack.sh` for safe testing
- Create temporary test projects
- Clean up after testing
- Use `timeout` for quick tests

❌ **Don't:**
- Test with production project IDs
- Leave test projects in dashboard
- Run full workflows on first test
- Forget to check logs

## Next Steps

After successful testing:
1. Review logs: `tail -f machine-client.log`
2. Check dashboard UI: http://localhost:3000
3. Read [Quick Start Guide](./QUICK_START.md)
4. Try with a real project
