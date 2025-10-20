# Project Setup - Quick Reference

This directory contains examples for creating a complete project with milestones and tasks.

## Files

- **`project-setup-example.json`** - JSON data structure with project, 9 milestones, and 3-6 tasks per milestone
- **`create-project.sh`** - Bash script to automate project creation
- **`create-project.ts`** - TypeScript/Node.js script for programmatic setup

---

## Option 1: Using Bash Script (Recommended for Quick Setup)

```bash
# Make script executable
chmod +x examples/create-project.sh

# Run with default settings (http://localhost:3000)
./examples/create-project.sh

# Or specify custom base URL
BASE_URL=http://api.example.com ./examples/create-project.sh
```

**Requirements:**
- `curl` (pre-installed on macOS/Linux)
- `jq` (optional, for pretty output)
  - macOS: `brew install jq`
  - Ubuntu: `sudo apt-get install jq`

---

## Option 2: Using TypeScript Script

```bash
# Use default example data
tsx examples/create-project.ts

# Use custom JSON file
tsx examples/create-project.ts my-project.json

# Use absolute path
tsx examples/create-project.ts /path/to/my-project.json

# Read from stdin
cat my-project.json | tsx examples/create-project.ts -

# With custom base URL
BASE_URL=http://api.example.com tsx examples/create-project.ts my-project.json
```

**Requirements:**
- Node.js 18+
- `tsx` installed: `npm install -g tsx`

---

## Quick Examples

### Example 1: Use Default Project Data
```bash
# TypeScript
tsx examples/create-project.ts

# Bash
./examples/create-project.sh
```

### Example 2: Use Custom Project File
```bash
# TypeScript
tsx examples/create-project.ts examples/custom-project-example.json

# Bash
PROJECT_FILE=examples/custom-project-example.json ./examples/create-project.sh
```

### Example 3: Create Your Own Project
```bash
# 1. Copy the template
cp examples/custom-project-example.json my-project.json

# 2. Edit my-project.json with your project details

# 3. Run the script
tsx examples/create-project.ts my-project.json
```

### Example 4: Use Stdin (for programmatic generation)
```bash
# Generate JSON dynamically and pipe it
echo '{
  "project": {"name": "Quick Test", "slug": "quick-test"},
  "milestones": [{"name": "M1", "slug": "m1", "status": "active"}],
  "tasks": {"m1": [{"title": "Task 1", "status": "open"}]}
}' | tsx examples/create-project.ts -
```

### Example 5: Different API Server
```bash
# Point to a different dashboard API
BASE_URL=https://api.production.com tsx examples/create-project.ts my-project.json
```

---

## Option 4: Programmatic Usage (Import as Module)

You can also import and use the setup functions in your own TypeScript code:

```typescript
import { readFileSync } from 'fs';

// Define your project structure
const projectData = {
  project: {
    name: "AI Assistant Platform",
    slug: "ai-assistant",
    description: "Build an AI-powered assistant"
  },
  milestones: [
    { name: "Foundation", slug: "foundation", status: "active" },
    { name: "AI Integration", slug: "ai", status: "active" }
  ],
  tasks: {
    foundation: [
      { title: "Setup project", status: "open", labels: ["setup"] },
      { title: "Configure CI/CD", status: "open", labels: ["devops"] }
    ],
    ai: [
      { title: "Integrate OpenAI API", status: "open", labels: ["ai", "backend"] },
      { title: "Build chat interface", status: "open", labels: ["ai", "frontend"] }
    ]
  }
};

// Setup project
async function createMyProject() {
  const BASE_URL = 'http://localhost:3000';
  
  // 1. Create project
  const projectResponse = await fetch(`${BASE_URL}/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(projectData.project)
  });
  const project = await projectResponse.json();
  console.log('Created project:', project.id);
  
  // 2. Create milestones and tasks
  for (const milestone of projectData.milestones) {
    const milestoneResponse = await fetch(
      `${BASE_URL}/projects/${project.id}/milestones`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(milestone)
      }
    );
    const createdMilestone = await milestoneResponse.json();
    
    // 3. Create tasks for this milestone
    const tasks = projectData.tasks[milestone.slug];
    if (tasks && tasks.length > 0) {
      const tasksWithMilestone = tasks.map(t => ({
        ...t,
        milestone_id: createdMilestone.id
      }));
      
      await fetch(`${BASE_URL}/projects/${project.id}/tasks:bulk`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tasks: tasksWithMilestone })
      });
    }
  }
  
  console.log('✓ Project setup complete!');
}

createMyProject();
```

---

## Manual curl Commands (Option 5)

### Step 1: Create Project

```bash
curl -X POST http://localhost:3000/projects \
  -H "Content-Type: application/json" \
  -d '{
    "name": "E-Commerce Platform Redesign",
    "slug": "ecommerce-redesign-v2",
    "description": "Complete redesign of the e-commerce platform"
  }'
# Response: {"id": 1, ...}
```

### Step 2: Create Milestone

```bash
curl -X POST http://localhost:3000/projects/1/milestones \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Project Foundation & Architecture",
    "slug": "foundation",
    "status": "active"
  }'
# Response: {"id": 1, ...}
```

### Step 3: Create Tasks in Bulk

```bash
curl -X POST http://localhost:3000/projects/1/tasks:bulk \
  -H "Content-Type: application/json" \
  -d '{
    "tasks": [
      {
        "title": "Setup monorepo structure",
        "description": "Configure Turborepo",
        "milestone_id": 1,
        "status": "open",
        "labels": ["infrastructure", "setup"]
      },
      {
        "title": "Configure Docker environment",
        "milestone_id": 1,
        "status": "open",
        "labels": ["docker", "devops"]
      }
    ]
  }'
# Response: {"created": [...], "summary": {"created": 2, "skipped": 0}}
```

---

## Project Structure Overview

The example project contains:

### 📦 Project
- **Name**: E-Commerce Platform Redesign
- **Slug**: `ecommerce-redesign-v2`
- **Description**: Complete platform redesign with modern architecture

### 🎯 9 Milestones
1. **Foundation** (`foundation`) - 5 tasks
2. **Authentication** (`auth`) - 6 tasks
3. **Product Catalog** (`product-catalog`) - 4 tasks
4. **Cart & Checkout** (`cart-checkout`) - 5 tasks
5. **Payments** (`payments`) - 6 tasks
6. **Order Management** (`order-management`) - 4 tasks
7. **User Dashboard** (`user-dashboard`) - 5 tasks
8. **Admin Panel** (`admin-panel`) - 6 tasks
9. **Testing & Deployment** (`testing-deployment`) - 6 tasks

**Total**: 47 tasks across 9 milestones

---

## Task Ordering

Tasks are processed in order based on:

1. **Milestone creation time** - Earlier milestones are processed first
2. **Task array order** - Tasks are created in the order they appear in the `tasks` array
3. **Priority score** - If specified, higher priority tasks are processed first

Since all tasks have the same default priority (0), they will be processed:
- Milestone 1 → Milestone 2 → ... → Milestone 9
- Within each milestone: Task 1 → Task 2 → ... → Task N

---

## Customizing the Example

### Edit `project-setup-example.json`

```json
{
  "project": {
    "name": "Your Project Name",
    "slug": "your-project-slug",
    "description": "Your description"
  },
  "milestones": [
    {
      "name": "Your Milestone",
      "slug": "your-milestone-slug",
      "status": "active"
    }
  ],
  "tasks": {
    "your-milestone-slug": [
      {
        "title": "Your task",
        "description": "Task description",
        "status": "open",
        "labels": ["tag1", "tag2"]
      }
    ]
  }
}
```

### Key Points:
- ✅ **Milestone slugs** must match between `milestones[]` and `tasks{}`
- ✅ **Status** values: `"open"`, `"in_progress"`, `"in_review"`, `"blocked"`, `"done"`, `"archived"`
- ✅ **Labels** are optional arrays of strings
- ✅ **Priority scores** can be added if needed: `"priority_score": 1000`

---

## Expected Output

```
========================================
Dashboard API - Project Setup
========================================

Base URL: http://localhost:3000
Project Data: examples/project-setup-example.json

Step 1: Creating project...
  ✓ Project created: E-Commerce Platform Redesign (ID: 1)

Step 2: Creating milestones...
  ✓ Milestone 1/9: Project Foundation & Architecture (ID: 1, slug: foundation)
  ✓ Milestone 2/9: Authentication & Authorization (ID: 2, slug: auth)
  ✓ Milestone 3/9: Product Catalog & Search (ID: 3, slug: product-catalog)
  ...

Step 3: Creating tasks in bulk...
  ✓ Milestone foundation: Created 5 tasks, Skipped 0 duplicates
  ✓ Milestone auth: Created 6 tasks, Skipped 0 duplicates
  ✓ Milestone product-catalog: Created 4 tasks, Skipped 0 duplicates
  ...

========================================
✓ Project Setup Complete!
========================================

Project ID: 1
Project Name: E-Commerce Platform Redesign
Project Slug: ecommerce-redesign-v2
Milestones Created: 9
Total Tasks Created: 47

Next Steps:
  1. View project: http://localhost:3000/projects/1
  2. List tasks: http://localhost:3000/projects/1/tasks
  3. Start workflow to process tasks
```

---

## Troubleshooting

### Error: "Connection refused"
- Ensure dashboard backend is running: `cd src/dashboard-backend && npm run dev`

### Error: "UNIQUE constraint failed"
- Project slug already exists - change `slug` in JSON file
- Or delete existing project first

### Error: "jq: command not found"
- Bash script works without `jq`, just less pretty output
- Install `jq` for better formatting: `brew install jq` (macOS)

### Tasks appear out of order
- Verify all tasks have same `priority_score` (or none set)
- Check that milestones were created sequentially
- Ensure tasks array order is correct in JSON file

---

## Next Steps

After creating your project:

1. **View all tasks**: `curl http://localhost:3000/projects/1/tasks`
2. **Start workflow**: Configure and run WorkflowCoordinator
3. **Monitor progress**: Check task status updates in dashboard
4. **Review results**: Track completion via milestone completion percentages

For more details, see:
- **Upload Schema Guide**: `docs/dashboard-api/UPLOAD_SCHEMA_GUIDE.md`
- **Workflow API Usage**: `docs/dashboard-api/WORKFLOW_API_USAGE.md`
- **API Implementation**: `docs/dashboard-api/IMPLEMENTATION_GUIDE.md`
