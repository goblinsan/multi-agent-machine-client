#!/bin/bash

# ============================================================================
# Project Setup Script for Dashboard API
# ============================================================================
# This script demonstrates how to:
# 1. Create a new project
# 2. Add 9 milestones sequentially
# 3. Add 3-6 tasks per milestone in bulk
#
# Usage:
#   chmod +x examples/create-project.sh
#   ./examples/create-project.sh
#
# Or with custom base URL:
#   BASE_URL=http://localhost:3000 ./examples/create-project.sh
# ============================================================================

set -e  # Exit on any error

# Configuration
BASE_URL="${BASE_URL:-http://localhost:3000}"
PROJECT_FILE="${PROJECT_FILE:-examples/project-setup-example.json}"

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo -e "${BLUE}========================================${NC}"
echo -e "${BLUE}Dashboard API - Project Setup${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Base URL: $BASE_URL"
echo "Project Data: $PROJECT_FILE"
echo ""

# Check if jq is installed
if ! command -v jq &> /dev/null; then
    echo -e "${YELLOW}Warning: 'jq' is not installed. Install it for better output formatting.${NC}"
    echo "  macOS: brew install jq"
    echo "  Ubuntu: sudo apt-get install jq"
    echo ""
fi

# ============================================================================
# Step 1: Create Project
# ============================================================================
echo -e "${GREEN}Step 1: Creating project...${NC}"

PROJECT_NAME=$(jq -r '.project.name' "$PROJECT_FILE")
PROJECT_SLUG=$(jq -r '.project.slug' "$PROJECT_FILE")
PROJECT_DESC=$(jq -r '.project.description' "$PROJECT_FILE")

PROJECT_RESPONSE=$(curl -s -X POST "$BASE_URL/projects" \
  -H "Content-Type: application/json" \
  -d "{
    \"name\": \"$PROJECT_NAME\",
    \"slug\": \"$PROJECT_SLUG\",
    \"description\": \"$PROJECT_DESC\"
  }")

PROJECT_ID=$(echo "$PROJECT_RESPONSE" | jq -r '.id')

if [ "$PROJECT_ID" == "null" ] || [ -z "$PROJECT_ID" ]; then
  echo -e "${YELLOW}Error creating project:${NC}"
  echo "$PROJECT_RESPONSE" | jq '.' 2>/dev/null || echo "$PROJECT_RESPONSE"
  exit 1
fi

echo -e "  ✓ Project created: ${GREEN}$PROJECT_NAME${NC} (ID: $PROJECT_ID)"
echo ""

# ============================================================================
# Step 2: Create Milestones
# ============================================================================
echo -e "${GREEN}Step 2: Creating milestones...${NC}"

MILESTONE_COUNT=$(jq '.milestones | length' "$PROJECT_FILE")
declare -A MILESTONE_IDS

for i in $(seq 0 $((MILESTONE_COUNT - 1))); do
  MILESTONE_NAME=$(jq -r ".milestones[$i].name" "$PROJECT_FILE")
  MILESTONE_SLUG=$(jq -r ".milestones[$i].slug" "$PROJECT_FILE")
  MILESTONE_STATUS=$(jq -r ".milestones[$i].status" "$PROJECT_FILE")
  MILESTONE_DESC=$(jq -r ".milestones[$i].description" "$PROJECT_FILE")
  
  MILESTONE_RESPONSE=$(curl -s -X POST "$BASE_URL/projects/$PROJECT_ID/milestones" \
    -H "Content-Type: application/json" \
    -d "{
      \"name\": \"$MILESTONE_NAME\",
      \"slug\": \"$MILESTONE_SLUG\",
      \"status\": \"$MILESTONE_STATUS\",
      \"description\": \"$MILESTONE_DESC\"
    }")
  
  MILESTONE_ID=$(echo "$MILESTONE_RESPONSE" | jq -r '.id')
  
  if [ "$MILESTONE_ID" == "null" ] || [ -z "$MILESTONE_ID" ]; then
    echo -e "  ${YELLOW}Error creating milestone: $MILESTONE_NAME${NC}"
    echo "$MILESTONE_RESPONSE" | jq '.' 2>/dev/null || echo "$MILESTONE_RESPONSE"
    continue
  fi
  
  # Store milestone ID for task creation
  MILESTONE_IDS[$MILESTONE_SLUG]=$MILESTONE_ID
  
  echo -e "  ✓ Milestone $((i+1))/$MILESTONE_COUNT: ${GREEN}$MILESTONE_NAME${NC} (ID: $MILESTONE_ID, slug: $MILESTONE_SLUG)"
done

echo ""

# ============================================================================
# Step 3: Create Tasks (Bulk)
# ============================================================================
echo -e "${GREEN}Step 3: Creating tasks in bulk...${NC}"

TOTAL_TASKS_CREATED=0

for MILESTONE_SLUG in "${!MILESTONE_IDS[@]}"; do
  MILESTONE_ID=${MILESTONE_IDS[$MILESTONE_SLUG]}
  
  # Check if tasks exist for this milestone
  TASK_COUNT=$(jq ".tasks.\"$MILESTONE_SLUG\" | length" "$PROJECT_FILE" 2>/dev/null || echo "0")
  
  if [ "$TASK_COUNT" == "null" ] || [ "$TASK_COUNT" == "0" ]; then
    echo -e "  ${YELLOW}No tasks defined for milestone: $MILESTONE_SLUG${NC}"
    continue
  fi
  
  # Build tasks JSON array
  TASKS_JSON=$(jq -c ".tasks.\"$MILESTONE_SLUG\" | map(. + {milestone_id: $MILESTONE_ID})" "$PROJECT_FILE")
  
  # Create tasks in bulk
  BULK_RESPONSE=$(curl -s -X POST "$BASE_URL/projects/$PROJECT_ID/tasks:bulk" \
    -H "Content-Type: application/json" \
    -d "{\"tasks\": $TASKS_JSON}")
  
  CREATED_COUNT=$(echo "$BULK_RESPONSE" | jq -r '.summary.created // 0')
  SKIPPED_COUNT=$(echo "$BULK_RESPONSE" | jq -r '.summary.skipped // 0')
  
  if [ "$CREATED_COUNT" == "null" ]; then
    echo -e "  ${YELLOW}Error creating tasks for $MILESTONE_SLUG:${NC}"
    echo "$BULK_RESPONSE" | jq '.' 2>/dev/null || echo "$BULK_RESPONSE"
    continue
  fi
  
  TOTAL_TASKS_CREATED=$((TOTAL_TASKS_CREATED + CREATED_COUNT))
  
  echo -e "  ✓ Milestone ${GREEN}$MILESTONE_SLUG${NC}: Created $CREATED_COUNT tasks, Skipped $SKIPPED_COUNT duplicates"
done

echo ""

# ============================================================================
# Step 4: Summary
# ============================================================================
echo -e "${BLUE}========================================${NC}"
echo -e "${GREEN}✓ Project Setup Complete!${NC}"
echo -e "${BLUE}========================================${NC}"
echo ""
echo "Project ID: $PROJECT_ID"
echo "Project Name: $PROJECT_NAME"
echo "Project Slug: $PROJECT_SLUG"
echo "Milestones Created: ${#MILESTONE_IDS[@]}"
echo "Total Tasks Created: $TOTAL_TASKS_CREATED"
echo ""
echo -e "${BLUE}Next Steps:${NC}"
echo "  1. View project: $BASE_URL/projects/$PROJECT_ID"
echo "  2. List tasks: $BASE_URL/projects/$PROJECT_ID/tasks"
echo "  3. Start workflow to process tasks"
echo ""
