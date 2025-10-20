#!/bin/bash
# Test the local stack command with a dummy project
# This is safe to run and won't affect your real projects

set -e

echo "🧪 Testing Local Stack Command"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""

# Check if dashboard is running
if ! curl -s http://localhost:3000/health > /dev/null 2>&1; then
    echo "⚠️  Dashboard backend is not running."
    echo "   Starting dashboard backend..."
    cd "$(dirname "$0")/../src/dashboard-backend"
    npm run dev > /dev/null 2>&1 &
    DASHBOARD_PID=$!
    echo "   Dashboard PID: $DASHBOARD_PID"
    sleep 3
    echo "✅ Dashboard started"
    echo ""
else
    echo "✅ Dashboard already running"
    echo ""
fi

# Create a test project
echo "📝 Creating test project..."
TEST_PROJECT_ID=$(curl -s -X POST http://localhost:3000/projects \
    -H "Content-Type: application/json" \
    -d '{
        "name": "Local Stack Test",
        "slug": "test-local-'$(date +%s)'",
        "description": "Temporary test project for npm run local"
    }' | grep -o '"id":[0-9]*' | cut -d':' -f2)

if [ -z "$TEST_PROJECT_ID" ]; then
    echo "❌ Failed to create test project"
    exit 1
fi

echo "✅ Test project created with ID: $TEST_PROJECT_ID"
echo ""

# Create a test milestone
echo "📋 Creating test milestone..."
MILESTONE_ID=$(curl -s -X POST "http://localhost:3000/projects/$TEST_PROJECT_ID/milestones" \
    -H "Content-Type: application/json" \
    -d '{
        "name": "Test Milestone",
        "slug": "test-milestone",
        "status": "active",
        "description": "Test milestone for local stack"
    }' | grep -o '"id":[0-9]*' | cut -d':' -f2)

echo "✅ Test milestone created with ID: $MILESTONE_ID"
echo ""

# Create a few test tasks
echo "📌 Creating test tasks..."
for i in 1 2 3; do
    curl -s -X POST "http://localhost:3000/projects/$TEST_PROJECT_ID/tasks:bulk" \
        -H "Content-Type: application/json" \
        -d "[{
            \"title\": \"Test Task $i\",
            \"description\": \"This is test task number $i\",
            \"status\": \"open\",
            \"priority_score\": 0,
            \"milestone_id\": $MILESTONE_ID,
            \"external_id\": \"test-task-$i-$(date +%s)\"
        }]" > /dev/null
done

echo "✅ Test tasks created"
echo ""

echo "🎯 Test project setup complete!"
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
echo ""
echo "Project ID: $TEST_PROJECT_ID"
echo "Dashboard: http://localhost:3000"
echo ""
echo "You can now test the local stack command:"
echo ""
echo "  npm run local -- $TEST_PROJECT_ID"
echo ""
echo "Or run the quick test (auto-cleanup after 5 seconds):"
echo ""
echo "  timeout 5 npm run local -- $TEST_PROJECT_ID || true"
echo ""
echo "To clean up the test project when done:"
echo ""
echo "  curl -X DELETE http://localhost:3000/projects/$TEST_PROJECT_ID"
echo ""
