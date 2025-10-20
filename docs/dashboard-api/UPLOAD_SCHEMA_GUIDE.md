# Dashboard API Upload Schema Guide

**Project:** Multi-Agent Machine Client - Dashboard API  
**Version:** 1.0.0  
**Date:** October 20, 2025

---

## Overview

This guide provides the complete schema and API endpoints for uploading projects, milestones, and tasks to the Dashboard API. It includes JSON structures, validation rules, and practical examples.

**Key Features:**
- ✅ **Idempotency** - Safe to retry operations with `external_id`
- ✅ **Bulk Operations** - Create up to 100 tasks in a single request
- ✅ **Hierarchical Data** - Projects → Milestones → Tasks
- ✅ **Validation** - Strong constraints enforced by SQLite

---

## Table of Contents

1. [Projects](#1-projects)
2. [Milestones](#2-milestones)
3. [Tasks](#3-tasks)
4. [Complete Hierarchical Example](#4-complete-hierarchical-example)
5. [Idempotency Patterns](#5-idempotency-patterns)
6. [Bulk Operations](#6-bulk-operations)
7. [Validation Rules](#7-validation-rules)

---

## 1. Projects

### Database Schema

```sql
CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    -- Constraints
    CHECK (length(name) > 0),
    CHECK (length(slug) > 0),
    CHECK (slug = lower(slug)),
    CHECK (slug NOT LIKE '% %')
);
```

### API Endpoint

**Create Project:**
```
POST /projects
```

### Request Schema

```typescript
{
  name: string,           // Required, max 255 chars
  slug: string,           // Required, unique, lowercase, no spaces
  description?: string    // Optional
}
```

### Example Request

```bash
curl -X POST http://localhost:3000/projects \
  -H "Content-Type: application/json" \
  -d '{
    "name": "User Authentication System",
    "slug": "user-auth-v2",
    "description": "Redesign authentication with OAuth2 support"
  }'
```

### Example Response (201 Created)

```json
{
  "id": 1,
  "name": "User Authentication System",
  "slug": "user-auth-v2",
  "description": "Redesign authentication with OAuth2 support",
  "created_at": "2025-10-20T14:30:00.000Z",
  "updated_at": "2025-10-20T14:30:00.000Z"
}
```

### Validation Rules

- ✅ **name**: Required, min 1 char, max 255 chars
- ✅ **slug**: Required, unique, lowercase only, no spaces
- ✅ **slug format**: Alphanumeric and hyphens only (e.g., `user-auth-v2`)
- ✅ **description**: Optional, max 2000 chars

---

## 2. Milestones

### Database Schema

```sql
CREATE TABLE milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    description TEXT,
    total_tasks INTEGER NOT NULL DEFAULT 0,
    completed_tasks INTEGER NOT NULL DEFAULT 0,
    completion_percentage INTEGER NOT NULL DEFAULT 0,
    
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CHECK (status IN ('active', 'completed', 'archived')),
    CHECK (length(name) > 0),
    CHECK (length(slug) > 0),
    CHECK (slug = lower(slug)),
    CHECK (slug NOT LIKE '% %'),
    CHECK (total_tasks >= 0),
    CHECK (completed_tasks >= 0),
    CHECK (completed_tasks <= total_tasks),
    CHECK (completion_percentage >= 0 AND completion_percentage <= 100),
    UNIQUE (project_id, slug)
);
```

### API Endpoint

**Create Milestone:**
```
POST /projects/{projectId}/milestones
```

### Request Schema

```typescript
{
  name: string,              // Required
  slug: string,              // Required, unique per project
  status?: string,           // 'active' | 'completed' | 'archived' (default: 'active')
  description?: string       // Optional, describes the milestone
}
```

### Example Request

```bash
curl -X POST http://localhost:3000/projects/1/milestones \
  -H "Content-Type: application/json" \
  -d '{
    "name": "OAuth2 Integration",
    "slug": "oauth2-integration",
    "status": "active",
    "description": "Integrate Google and GitHub OAuth2 providers"
  }'
```

### Example Response (201 Created)

```json
{
  "id": 1,
  "project_id": 1,
  "name": "OAuth2 Integration",
  "slug": "oauth2-integration",
  "status": "active",
  "total_tasks": 0,
  "completed_tasks": 0,
  "completion_percentage": 0,
  "created_at": "2025-10-20T14:35:00.000Z",
  "updated_at": "2025-10-20T14:35:00.000Z"
}
```

### Validation Rules

- ✅ **name**: Required, min 1 char
- ✅ **slug**: Required, unique per project, lowercase, no spaces
- ✅ **status**: Must be 'active', 'completed', or 'archived'
- ✅ **Computed fields**: `total_tasks`, `completed_tasks`, `completion_percentage` managed by triggers

---

## 3. Tasks

### Database Schema

```sql
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Foreign Keys
    project_id INTEGER NOT NULL,
    milestone_id INTEGER,
    parent_task_id INTEGER,
    
    -- Core Fields
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    priority_score INTEGER NOT NULL DEFAULT 0,
    
    -- External Integration (Idempotency Key)
    external_id TEXT UNIQUE,
    
    -- Denormalized Milestone Data
    milestone_slug TEXT,
    
    -- Labels (JSON array)
    labels TEXT,
    
    -- Blocked Task Tracking
    blocked_attempt_count INTEGER NOT NULL DEFAULT 0,
    last_unblock_attempt TEXT,
    
    -- Review Status
    review_status_qa TEXT,
    review_status_code TEXT,
    review_status_security TEXT,
    review_status_devops TEXT,
    
    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    FOREIGN KEY (milestone_id) REFERENCES milestones(id) ON DELETE SET NULL,
    FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL,
    CHECK (status IN ('open', 'in_progress', 'in_review', 'blocked', 'done', 'archived')),
    CHECK (priority_score >= 0 AND priority_score <= 10000),
    CHECK (length(title) > 0 AND length(title) <= 500),
    CHECK (blocked_attempt_count >= 0),
    CHECK (review_status_qa IS NULL OR review_status_qa IN ('pending', 'approved', 'rejected')),
    CHECK (review_status_code IS NULL OR review_status_code IN ('pending', 'approved', 'rejected')),
    CHECK (review_status_security IS NULL OR review_status_security IN ('pending', 'approved', 'rejected')),
    CHECK (review_status_devops IS NULL OR review_status_devops IN ('pending', 'approved', 'rejected'))
);
```

### API Endpoints

**Create Single Task:**
```
POST /projects/{projectId}/tasks
```

**Create Multiple Tasks (Bulk):**
```
POST /projects/{projectId}/tasks:bulk
```

**Update Task:**
```
PATCH /projects/{projectId}/tasks/{taskId}
```

**Get Task:**
```
GET /projects/{projectId}/tasks/{taskId}
```

**List Tasks:**
```
GET /projects/{projectId}/tasks
```

### Request Schema (Single Task)

```typescript
{
  // Required
  title: string,                    // min 1 char, max 500 chars
  
  // Optional
  description?: string,
  milestone_id?: number,            // integer, references milestones.id
  parent_task_id?: number,          // integer, references tasks.id
  status?: string,                  // 'open' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'archived' (default: 'open')
  priority_score?: number,          // 0-10000 (default: 0)
  external_id?: string,             // Unique, for idempotency
  labels?: string[],                // e.g., ["hotfix", "urgent"]
  
  // Advanced (optional)
  review_status_qa?: string,        // 'pending' | 'approved' | 'rejected' | null
  review_status_code?: string,
  review_status_security?: string,
  review_status_devops?: string
}
```

### Example Request (Single Task)

```bash
curl -X POST http://localhost:3000/projects/1/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Implement Google OAuth2 flow",
    "description": "Add Google OAuth2 authentication with passport.js",
    "milestone_id": 1,
    "status": "open",
    "priority_score": 1000,
    "external_id": "oauth-google-123",
    "labels": ["oauth", "google", "backend"]
  }'
```

### Example Response (201 Created)

```json
{
  "id": 1,
  "project_id": 1,
  "milestone_id": 1,
  "parent_task_id": null,
  "title": "Implement Google OAuth2 flow",
  "description": "Add Google OAuth2 authentication with passport.js",
  "status": "open",
  "priority_score": 1000,
  "external_id": "oauth-google-123",
  "milestone_slug": "oauth2-integration",
  "labels": ["oauth", "google", "backend"],
  "blocked_attempt_count": 0,
  "last_unblock_attempt": null,
  "review_status_qa": null,
  "review_status_code": null,
  "review_status_security": null,
  "review_status_devops": null,
  "created_at": "2025-10-20T14:40:00.000Z",
  "updated_at": "2025-10-20T14:40:00.000Z",
  "completed_at": null
}
```

### Validation Rules

- ✅ **title**: Required, min 1 char, max 500 chars
- ✅ **status**: Must be one of: 'open', 'in_progress', 'in_review', 'blocked', 'done', 'archived'
- ✅ **priority_score**: Integer 0-10000
- ✅ **external_id**: Unique across all tasks (enforced by unique constraint)
- ✅ **labels**: JSON array, stored as TEXT
- ✅ **milestone_id**: Must reference existing milestone
- ✅ **parent_task_id**: Must reference existing task
- ✅ **milestone_slug**: Auto-populated by trigger when milestone_id is set

---

## 4. Complete Hierarchical Example

### Scenario: Create Project with Milestones and Tasks

```bash
#!/bin/bash
BASE_URL="http://localhost:3000"

# Step 1: Create Project
PROJECT=$(curl -s -X POST $BASE_URL/projects \
  -H "Content-Type: application/json" \
  -d '{
    "name": "E-commerce Platform",
    "slug": "ecommerce-v2",
    "description": "Next-generation e-commerce platform with microservices"
  }')

PROJECT_ID=$(echo $PROJECT | jq -r '.id')
echo "Created project ID: $PROJECT_ID"

# Step 2: Create Milestones
MILESTONE_AUTH=$(curl -s -X POST $BASE_URL/projects/$PROJECT_ID/milestones \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Authentication & Authorization",
    "slug": "auth",
    "status": "active"
  }')

MILESTONE_AUTH_ID=$(echo $MILESTONE_AUTH | jq -r '.id')
echo "Created milestone ID: $MILESTONE_AUTH_ID"

MILESTONE_PAYMENTS=$(curl -s -X POST $BASE_URL/projects/$PROJECT_ID/milestones \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Payment Integration",
    "slug": "payments",
    "status": "active"
  }')

MILESTONE_PAYMENTS_ID=$(echo $MILESTONE_PAYMENTS | jq -r '.id')
echo "Created milestone ID: $MILESTONE_PAYMENTS_ID"

# Step 3: Create Tasks (using bulk endpoint for efficiency)
curl -X POST "$BASE_URL/projects/$PROJECT_ID/tasks:bulk" \
  -H "Content-Type: application/json" \
  -d '{
    "tasks": [
      {
        "title": "Implement JWT authentication",
        "description": "Add JWT token generation and validation",
        "milestone_id": '$MILESTONE_AUTH_ID',
        "status": "open",
        "priority_score": 1500,
        "external_id": "auth-jwt-001",
        "labels": ["auth", "backend", "high-priority"]
      },
      {
        "title": "Add OAuth2 social login",
        "description": "Support Google, Facebook, GitHub login",
        "milestone_id": '$MILESTONE_AUTH_ID',
        "status": "open",
        "priority_score": 1200,
        "external_id": "auth-oauth-002",
        "labels": ["auth", "oauth", "backend"]
      },
      {
        "title": "Implement role-based access control (RBAC)",
        "description": "Admin, seller, customer roles with permissions",
        "milestone_id": '$MILESTONE_AUTH_ID',
        "status": "open",
        "priority_score": 1000,
        "external_id": "auth-rbac-003",
        "labels": ["auth", "authorization", "backend"]
      },
      {
        "title": "Integrate Stripe payment gateway",
        "description": "Accept credit card payments via Stripe",
        "milestone_id": '$MILESTONE_PAYMENTS_ID',
        "status": "open",
        "priority_score": 2000,
        "external_id": "pay-stripe-001",
        "labels": ["payments", "stripe", "backend"]
      },
      {
        "title": "Add PayPal payment option",
        "description": "Support PayPal checkout",
        "milestone_id": '$MILESTONE_PAYMENTS_ID',
        "status": "open",
        "priority_score": 1500,
        "external_id": "pay-paypal-002",
        "labels": ["payments", "paypal", "backend"]
      }
    ]
  }'

echo "Project setup complete!"
```

### Expected Output

```json
{
  "created": [
    { "id": 1, "title": "Implement JWT authentication", ... },
    { "id": 2, "title": "Add OAuth2 social login", ... },
    { "id": 3, "title": "Implement role-based access control (RBAC)", ... },
    { "id": 4, "title": "Integrate Stripe payment gateway", ... },
    { "id": 5, "title": "Add PayPal payment option", ... }
  ],
  "skipped": [],
  "summary": {
    "totalRequested": 5,
    "created": 5,
    "skipped": 0
  }
}
```

---

## 5. Idempotency Patterns

### Why Idempotency?

Idempotency ensures that retrying the same operation multiple times produces the same result as doing it once. This is crucial for:
- ✅ **Workflow retries** - Safely re-run workflows without duplicates
- ✅ **Network failures** - Retry failed requests without creating duplicates
- ✅ **Review findings** - Import external issues without duplicates

### Using `external_id` for Idempotency

The `external_id` field acts as a unique idempotency key:
- ✅ **Unique constraint** - Database enforces uniqueness across all tasks
- ✅ **Automatic skip** - Bulk endpoint skips tasks with existing `external_id`
- ✅ **200 OK response** - Single task endpoint returns existing task (not 201)

### Example: Idempotent Task Creation

```bash
# First attempt - creates task (201 Created)
curl -X POST http://localhost:3000/projects/1/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Fix security vulnerability CVE-2024-1234",
    "milestone_id": 1,
    "priority_score": 2000,
    "external_id": "security-cve-2024-1234",
    "labels": ["security", "critical"]
  }'

# Response: 201 Created
# { "id": 42, "external_id": "security-cve-2024-1234", ... }

# Second attempt - returns existing task (200 OK)
curl -X POST http://localhost:3000/projects/1/tasks \
  -H "Content-Type: application/json" \
  -d '{
    "title": "Fix security vulnerability CVE-2024-1234",
    "milestone_id": 1,
    "priority_score": 2000,
    "external_id": "security-cve-2024-1234",
    "labels": ["security", "critical"]
  }'

# Response: 200 OK (NOT 201 Created)
# { "id": 42, "external_id": "security-cve-2024-1234", ... }
# Same task returned, no duplicate created
```

### Example: Bulk Idempotent Creation

```bash
curl -X POST http://localhost:3000/projects/1/tasks:bulk \
  -H "Content-Type: application/json" \
  -d '{
    "tasks": [
      {
        "title": "Fix login bug",
        "external_id": "bug-login-001",
        "priority_score": 1500
      },
      {
        "title": "Update documentation",
        "external_id": "doc-update-002",
        "priority_score": 500
      },
      {
        "title": "Fix login bug",
        "external_id": "bug-login-001",
        "priority_score": 1500
      }
    ]
  }'

# Response:
{
  "created": [
    { "id": 101, "title": "Fix login bug", "external_id": "bug-login-001" },
    { "id": 102, "title": "Update documentation", "external_id": "doc-update-002" }
  ],
  "skipped": [
    {
      "task": { "id": 101, "title": "Fix login bug", "external_id": "bug-login-001" },
      "reason": "duplicate_external_id",
      "external_id": "bug-login-001"
    }
  ],
  "summary": {
    "totalRequested": 3,
    "created": 2,
    "skipped": 1
  }
}
```

### Best Practices

1. ✅ **Always use external_id** for tasks from external sources (tickets, review findings, etc.)
2. ✅ **Use meaningful IDs** - e.g., `jira-PROJ-1234`, `github-issue-456`, `qa-finding-789`
3. ✅ **Check response status** - 201 = created, 200 = already exists
4. ✅ **Review skipped array** - Bulk endpoint shows which tasks were skipped
5. ✅ **Don't rely on title matching** - Use `external_id` for true idempotency

---

## 6. Bulk Operations

### Bulk Task Creation

The bulk endpoint allows creating up to **100 tasks** in a single transaction:

```
POST /projects/{projectId}/tasks:bulk
```

### Request Schema

```typescript
{
  tasks: Array<{
    title: string,
    description?: string,
    milestone_id?: number,
    parent_task_id?: number,
    status?: string,
    priority_score?: number,
    external_id?: string,
    labels?: string[]
  }>  // Max 100 tasks
}
```

### Performance Benefits

- ✅ **Single transaction** - All tasks committed atomically
- ✅ **Reduced network overhead** - 1 HTTP request vs 100
- ✅ **Automatic rollback** - If any task fails, all tasks rollback
- ✅ **Idempotency handling** - Automatically skips duplicates

### Example: QA Review Findings

```bash
curl -X POST http://localhost:3000/projects/1/tasks:bulk \
  -H "Content-Type: application/json" \
  -d '{
    "tasks": [
      {
        "title": "QA: Login validation missing",
        "description": "Username field accepts invalid characters",
        "milestone_id": 2,
        "parent_task_id": 15,
        "priority_score": 1500,
        "external_id": "qa-finding-001",
        "labels": ["qa", "validation", "high"]
      },
      {
        "title": "QA: Error messages unclear",
        "description": "Generic error messages confuse users",
        "milestone_id": 2,
        "parent_task_id": 15,
        "priority_score": 1000,
        "external_id": "qa-finding-002",
        "labels": ["qa", "ux", "medium"]
      },
      {
        "title": "QA: Password reset broken",
        "description": "Reset email not sent after timeout",
        "milestone_id": 2,
        "parent_task_id": 15,
        "priority_score": 2000,
        "external_id": "qa-finding-003",
        "labels": ["qa", "critical", "auth"]
      }
    ]
  }'
```

### Response Structure

```json
{
  "created": [
    { "id": 201, "title": "QA: Login validation missing", ... },
    { "id": 202, "title": "QA: Error messages unclear", ... },
    { "id": 203, "title": "QA: Password reset broken", ... }
  ],
  "skipped": [],
  "summary": {
    "totalRequested": 3,
    "created": 3,
    "skipped": 0
  }
}
```

### Error Handling

If **any** task fails validation, the **entire transaction** rolls back:

```json
// Response: 500 Internal Server Error
{
  "type": "https://api.example.com/errors/internal-error",
  "title": "Bulk Failed",
  "status": 500,
  "detail": "Validation error: priority_score must be <= 10000"
}
```

---

## 7. Validation Rules

### Project Validation

| Field | Rule | Example |
|-------|------|---------|
| `name` | Required, min 1 char, max 255 chars | ✅ "User Authentication" |
| `slug` | Required, unique, lowercase, no spaces | ✅ "user-auth", ❌ "User Auth" |
| `slug` | Alphanumeric + hyphens only | ✅ "api-v2", ❌ "api_v2" |

### Milestone Validation

| Field | Rule | Example |
|-------|------|---------|
| `name` | Required, min 1 char | ✅ "OAuth Integration" |
| `slug` | Required, unique per project, lowercase | ✅ "oauth-integration" |
| `status` | Must be: 'active', 'completed', 'archived' | ✅ "active", ❌ "pending" |
| `slug` | No spaces, lowercase | ✅ "phase-1", ❌ "Phase 1" |

### Task Validation

| Field | Rule | Example |
|-------|------|---------|
| `title` | Required, 1-500 chars | ✅ "Implement JWT auth" |
| `status` | 'open', 'in_progress', 'in_review', 'blocked', 'done', 'archived' | ✅ "open" |
| `priority_score` | Integer 0-10000 | ✅ 1500, ❌ 15000 |
| `external_id` | Unique across ALL tasks (not per project) | ✅ "jira-PROJ-123" |
| `labels` | Array of strings | ✅ ["auth", "backend"] |
| `milestone_id` | Must reference existing milestone | ✅ 5 (if exists) |
| `parent_task_id` | Must reference existing task | ✅ 10 (if exists) |
| `review_status_*` | 'pending', 'approved', 'rejected', or null | ✅ "pending" |

### Common Validation Errors

```json
// Missing required field
{
  "type": "https://api.example.com/errors/validation-error",
  "title": "Validation Error",
  "status": 400,
  "detail": "Invalid payload",
  "errors": [
    {
      "code": "invalid_type",
      "expected": "string",
      "received": "undefined",
      "path": ["title"],
      "message": "Required"
    }
  ]
}

// Invalid slug format
{
  "error": "CHECK constraint failed: slug = lower(slug)"
}

// Duplicate external_id
{
  "error": "UNIQUE constraint failed: tasks.external_id"
}

// Invalid priority_score
{
  "error": "CHECK constraint failed: priority_score >= 0 AND priority_score <= 10000"
}
```

---

## Priority Score Guidelines

| Range | Category | Description | Example Use Case |
|-------|----------|-------------|------------------|
| 9000-10000 | Critical | System-breaking bugs | Security vulnerabilities, production outages |
| 7000-8999 | Urgent | High-priority features | Blocking dependencies, hotfixes |
| 5000-6999 | High | Important features | Core functionality, major features |
| 3000-4999 | Normal | Standard features | Regular development tasks |
| 1000-2999 | Low | Nice-to-have | Documentation, refactoring |
| 0-999 | Backlog | Future work | Ideas, research tasks |

### Example Priority Scores

```json
{
  "tasks": [
    {
      "title": "Fix production security vulnerability",
      "priority_score": 9500,
      "labels": ["security", "critical", "hotfix"]
    },
    {
      "title": "Implement new payment gateway",
      "priority_score": 7000,
      "labels": ["payments", "urgent", "feature"]
    },
    {
      "title": "Refactor authentication module",
      "priority_score": 3000,
      "labels": ["refactoring", "technical-debt"]
    },
    {
      "title": "Update README documentation",
      "priority_score": 500,
      "labels": ["documentation", "low-priority"]
    }
  ]
}
```

---

## Status Workflow

### Task Status Transitions

```
open → in_progress → in_review → done
         ↓              ↓
      blocked      (reviews failed)
                      ↓
                  in_progress
                  (fixing issues)
```

### Status Descriptions

| Status | Description | Next Actions |
|--------|-------------|--------------|
| `open` | Task ready to be worked on | Assign to agent → `in_progress` |
| `in_progress` | Task actively being worked on | Complete work → `in_review` or `blocked` |
| `in_review` | Task waiting for review (QA, code, security) | Reviews pass → `done`, fail → `in_progress` |
| `blocked` | Task cannot proceed (missing deps, blocked) | Resolve blocker → `in_progress` |
| `done` | Task completed and approved | Archive milestone when all done |
| `archived` | Task no longer relevant | N/A (terminal state) |

### Example: Update Task Status

```bash
# Start working on task
curl -X PATCH http://localhost:3000/projects/1/tasks/42 \
  -H "Content-Type: application/json" \
  -d '{ "status": "in_progress" }'

# Submit for review
curl -X PATCH http://localhost:3000/projects/1/tasks/42 \
  -H "Content-Type: application/json" \
  -d '{ "status": "in_review" }'

# Mark as done
curl -X PATCH http://localhost:3000/projects/1/tasks/42 \
  -H "Content-Type: application/json" \
  -d '{ "status": "done" }'
```

---

## Quick Reference

### Common curl Commands

```bash
# Create project
curl -X POST http://localhost:3000/projects \
  -H "Content-Type: application/json" \
  -d '{"name": "My Project", "slug": "my-project"}'

# Create milestone
curl -X POST http://localhost:3000/projects/1/milestones \
  -H "Content-Type: application/json" \
  -d '{"name": "Phase 1", "slug": "phase-1"}'

# Create task
curl -X POST http://localhost:3000/projects/1/tasks \
  -H "Content-Type: application/json" \
  -d '{"title": "My Task", "milestone_id": 1, "priority_score": 1000}'

# Bulk create tasks
curl -X POST http://localhost:3000/projects/1/tasks:bulk \
  -H "Content-Type: application/json" \
  -d '{"tasks": [{"title": "Task 1"}, {"title": "Task 2"}]}'

# Update task
curl -X PATCH http://localhost:3000/projects/1/tasks/42 \
  -H "Content-Type: application/json" \
  -d '{"status": "done"}'

# Get task
curl http://localhost:3000/projects/1/tasks/42

# List tasks
curl http://localhost:3000/projects/1/tasks
```

---

## Additional Resources

- **Schema Design Decisions**: See `docs/dashboard-api/SCHEMA_DESIGN_DECISIONS.md`
- **Workflow API Usage**: See `docs/dashboard-api/WORKFLOW_API_USAGE.md`
- **Implementation Guide**: See `docs/dashboard-api/IMPLEMENTATION_GUIDE.md`
- **Migration Strategy**: See `docs/dashboard-api/MIGRATION_STRATEGY.md`

---

**Last Updated:** October 20, 2025  
**Maintainer:** GitHub Copilot
