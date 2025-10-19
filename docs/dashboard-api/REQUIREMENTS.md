# Dashboard API Requirements
**Date:** October 19, 2025  
**Phase:** Phase 1 - Dashboard API Design  
**Status:** Requirements Gathering Complete

---

## Executive Summary

This document defines the Dashboard API requirements based on actual workflow usage patterns from Phase 0 analysis and Week 1-2 implementation.

**Key Drivers:**
- 6 active workflows (task-flow, legacy-compatible, in-review, blocked-resolution, hotfix, project-loop)
- Unified review-failure-handling sub-workflow (4 review types)
- BulkTaskCreationStep (fixes N+1 problem)
- TDD awareness across all workflows
- Duplicate detection at PM + step levels

**Design Principles:**
1. **Workflow-first:** API designed for how YAML workflows actually work
2. **Batch operations:** No N+1 queries (bulk endpoints required)
3. **Query optimization:** Common access patterns get optimized queries
4. **No legacy cruft:** Ignore old dashboard API, design from scratch
5. **SQLite-optimized:** Leverage SQLite strengths (JSON support, FTS, etc.)

---

## Table of Contents

1. [Workflow Usage Analysis](#workflow-usage-analysis)
2. [Dashboard Operations Catalog](#dashboard-operations-catalog)
3. [API Endpoints](#api-endpoints)
4. [Data Models](#data-models)
5. [Query Patterns](#query-patterns)
6. [Bulk Operations](#bulk-operations)
7. [Success Criteria](#success-criteria)

---

## Workflow Usage Analysis

### Active Workflows (6 Total)

1. **task-flow.yaml** (v3.0.0, ~320 lines)
   - Primary workflow for new tasks
   - All 4 review types unified
   - TDD-aware, duplicate detection
   - Usage: 60%+ of tasks

2. **legacy-compatible-task-flow.yaml** (v1.0.0, ~450 lines)
   - Fallback for compatibility
   - Legacy PM prompts inline
   - Usage: 30%+ of tasks

3. **in-review-task-flow.yaml** (v2.0.0, 178 lines)
   - Tasks already in review status
   - Uses review-failure-handling sub-workflow
   - Usage: 5% of tasks

4. **blocked-task-resolution.yaml** (v2.0.0, 193 lines)
   - Unblock stuck tasks
   - TDD-aware
   - Usage: 3% of tasks

5. **hotfix-task-flow.yaml** (v1.0.0, 258 lines)
   - Emergency production fixes
   - Fast-track, higher priority
   - Usage: 1% of tasks

6. **project-loop.yaml** (v1.0.0, ~87 lines)
   - Fallback workflow
   - Usage: <1% of tasks

### Sub-Workflows (1)

1. **review-failure-handling.yaml** (v2.0.0, ~70 lines)
   - Unified PM evaluation + bulk task creation
   - Used by: QA, Code, Security, DevOps reviews
   - Called 4+ times per workflow execution

---

## Dashboard Operations Catalog

### Based on Actual Workflow Step Types

#### 1. Task Status Updates
**Step Type:** SimpleTaskStatusStep  
**Workflows:** All 6 workflows  
**Frequency:** 3-5 times per workflow execution  
**Operations:**
- Mark task in_progress (workflow start)
- Mark task in_review (QA passes)
- Mark task blocked (review fails)
- Mark task done (all reviews pass)

**Current API (assumed):**
```
PATCH /projects/{projectId}/tasks/{taskId}
Body: { status: "in_progress" | "in_review" | "blocked" | "done", comment?: string }
```

**Requirements:**
- Fast single-task status update
- Optional comment for audit trail
- Should support batch status updates (future optimization)

---

#### 2. Bulk Task Creation
**Step Type:** BulkTaskCreationStep  
**Workflows:** review-failure-handling.yaml (called by all workflows)  
**Frequency:** 1-4 times per workflow (one per review failure)  
**Operations:**
- Create 1-20 tasks from PM decision
- Urgent tasks (priority 1000-2000)
- Deferred tasks (priority 50)
- Link to parent task
- Set milestone (current or backlog)

**Current API (N+1 problem):**
```
POST /projects/{projectId}/tasks (called N times sequentially)
Body: { title, description, priority_score, status, milestone_id, parent_task_id }
```

**Required API:**
```
POST /projects/{projectId}/tasks:bulk
Body: {
  tasks: [
    { title, description, priority_score, status, milestone_id, parent_task_id, external_id? },
    ...
  ],
  options: {
    duplicate_detection?: { strategy: "title" | "title_and_milestone" | "external_id" },
    return_duplicates?: boolean
  }
}
Response: {
  created: [{ id, title, ... }],
  duplicates?: [{ id, duplicate_of_id, reason }],
  skipped: number
}
```

**Requirements:**
- Single HTTP request for N tasks
- Duplicate detection (title+milestone or external_id)
- Return both created and duplicate IDs
- Atomic operation (all or none)
- Performance: <100ms for 20 tasks

---

#### 3. Query Existing Tasks (Duplicate Detection)
**Step Type:** BulkTaskCreationStep (TODO: DashboardQueryStep)  
**Workflows:** review-failure-handling.yaml  
**Frequency:** 1-4 times per workflow  
**Operations:**
- Query tasks in current milestone
- Filter by status (exclude done/archived)
- Return: id, title, status, milestone_slug, external_id

**Required API:**
```
GET /projects/{projectId}/tasks?milestone_id={id}&status=open,in_progress,blocked,in_review&fields=id,title,status,milestone_slug,external_id
Response: {
  tasks: [{ id, title, status, milestone_slug, external_id }]
}
```

**Requirements:**
- Fast milestone-scoped query
- Status filtering (multiple values)
- Field selection (don't return full task)
- Performance: <50ms for 100 tasks

---

#### 4. Milestone Completion Check
**Step Type:** MilestoneStatusCheckStep  
**Workflows:** legacy-compatible-task-flow.yaml  
**Frequency:** 1 time per workflow  
**Operations:**
- Query incomplete tasks in milestone
- Return: list of tasks + count

**Required API:**
```
GET /projects/{projectId}/milestones/{milestoneId}/tasks?status=in_progress,blocked&fields=id,title,status
Response: {
  tasks: [{ id, title, status }],
  total: number
}
```

**Requirements:**
- Milestone-scoped query
- Status filtering
- Count-only option (don't need full task list)
- Performance: <50ms for 100 tasks

---

#### 5. Milestone Details Fetch
**Step Type:** Context resolution (WorkflowCoordinator)  
**Workflows:** All workflows (pre-workflow execution)  
**Frequency:** 1 time per workflow  
**Operations:**
- Fetch milestone metadata
- Return: id, name, slug, description, status, completion_percentage

**Required API:**
```
GET /projects/{projectId}/milestones/{milestoneId}
Response: {
  id, name, slug, description, status, completion_percentage, total_tasks, completed_tasks
}
```

**Requirements:**
- Fast single milestone fetch
- Include computed fields (completion_percentage)
- Performance: <10ms

---

#### 6. Project Status Details (Workflow Coordinator)
**Step Type:** WorkflowCoordinator.handleCoordinator()  
**Workflows:** All workflows (pre-workflow execution)  
**Frequency:** 1 time per workflow invocation  
**Operations:**
- Fetch project metadata
- Fetch tasks (with priority sorting)
- Fetch repositories
- Fetch milestones (optional)

**Current API (assumed):**
```
GET /projects/{projectId}/status
Response: {
  project: { id, name, slug },
  tasks: [{ id, title, status, priority_score, milestone_id, ... }],
  repositories: [{ url, branch }],
  milestones?: [{ id, name, slug }]
}
```

**Requirements:**
- Single query for workflow coordination
- Tasks sorted by priority (descending)
- Filter by status (optional)
- Performance: <100ms for 1000 tasks

---

## API Endpoints

### Core Requirements

Based on workflow analysis, the dashboard API must support:

1. **Task Operations:**
   - Create single task: `POST /projects/{id}/tasks`
   - Create bulk tasks: `POST /projects/{id}/tasks:bulk` ⭐ **NEW**
   - Update task status: `PATCH /projects/{id}/tasks/{taskId}`
   - Query tasks: `GET /projects/{id}/tasks?filters`
   - Get task details: `GET /projects/{id}/tasks/{taskId}`

2. **Milestone Operations:**
   - Get milestone details: `GET /projects/{id}/milestones/{milestoneId}`
   - Get milestone tasks: `GET /projects/{id}/milestones/{milestoneId}/tasks?filters`
   - List milestones: `GET /projects/{id}/milestones`

3. **Project Operations:**
   - Get project status: `GET /projects/{id}/status` (workflow coordinator)
   - Get project details: `GET /projects/{id}`

4. **Repository Operations:**
   - List repositories: `GET /projects/{id}/repositories`

---

## Data Models

### Task

```typescript
interface Task {
  // Identity
  id: string;
  project_id: string;
  external_id?: string;  // For duplicate detection
  
  // Content
  title: string;
  description?: string;
  
  // Organization
  milestone_id?: string;
  milestone_slug?: string;  // Denormalized for queries
  parent_task_id?: string;  // For follow-up tasks
  
  // Workflow State
  status: "open" | "in_progress" | "in_review" | "blocked" | "done" | "archived";
  priority_score: number;  // Higher = more urgent
  
  // Metadata
  created_at: string;  // ISO 8601
  updated_at: string;
  completed_at?: string;
  
  // Workflow Context
  labels?: string[];  // e.g., ["hotfix", "urgent"]
  blocked_attempt_count?: number;  // For blocked-task-resolution
  last_unblock_attempt?: string;  // ISO 8601
  
  // Review Context (optional)
  review_status?: {
    qa?: "pass" | "fail" | "unknown";
    code_review?: "pass" | "fail" | "unknown";
    security_review?: "pass" | "fail" | "unknown";
    devops_review?: "pass" | "fail" | "unknown";
  };
}
```

### Milestone

```typescript
interface Milestone {
  // Identity
  id: string;
  project_id: string;
  
  // Content
  name: string;
  slug: string;  // For branch naming
  description?: string;
  
  // State
  status: "active" | "completed" | "archived";
  
  // Computed
  total_tasks: number;
  completed_tasks: number;
  completion_percentage: number;  // 0-100
  
  // Metadata
  created_at: string;
  updated_at: string;
  completed_at?: string;
}
```

### Project

```typescript
interface Project {
  // Identity
  id: string;
  name: string;
  slug: string;
  
  // Metadata
  description?: string;
  created_at: string;
  updated_at: string;
}
```

### Repository

```typescript
interface Repository {
  // Identity
  id: string;
  project_id: string;
  
  // Git Details
  url: string;  // Git remote URL
  default_branch: string;  // Usually "main"
  
  // Metadata
  created_at: string;
}
```

---

## Query Patterns

### Pattern 1: Task Priority Queue (Workflow Coordinator)

**Use Case:** WorkflowCoordinator needs tasks sorted by priority

**Query:**
```sql
SELECT * FROM tasks
WHERE project_id = ? AND status IN ('open', 'in_progress', 'blocked', 'in_review')
ORDER BY priority_score DESC, created_at ASC
LIMIT 100;
```

**API:**
```
GET /projects/{id}/tasks?status=open,in_progress,blocked,in_review&sort=priority_score:desc,created_at:asc&limit=100
```

**Index Required:**
```sql
CREATE INDEX idx_tasks_priority_queue ON tasks(project_id, status, priority_score DESC, created_at ASC);
```

---

### Pattern 2: Milestone Task List (Duplicate Detection)

**Use Case:** BulkTaskCreationStep checks for duplicates in current milestone

**Query:**
```sql
SELECT id, title, status, milestone_slug, external_id
FROM tasks
WHERE project_id = ? AND milestone_id = ? AND status NOT IN ('done', 'archived');
```

**API:**
```
GET /projects/{id}/milestones/{milestoneId}/tasks?status=!done,!archived&fields=id,title,status,milestone_slug,external_id
```

**Index Required:**
```sql
CREATE INDEX idx_tasks_milestone_active ON tasks(project_id, milestone_id, status);
```

---

### Pattern 3: Duplicate Detection by Title

**Use Case:** BulkTaskCreationStep finds existing task by title+milestone

**Query:**
```sql
SELECT id, title FROM tasks
WHERE project_id = ? AND milestone_id = ? AND LOWER(title) = LOWER(?) AND status NOT IN ('done', 'archived')
LIMIT 1;
```

**API:** (Built into bulk create endpoint)

**Index Required:**
```sql
CREATE INDEX idx_tasks_title_milestone ON tasks(project_id, milestone_id, LOWER(title));
```

---

### Pattern 4: Duplicate Detection by External ID

**Use Case:** BulkTaskCreationStep finds existing task by external_id

**Query:**
```sql
SELECT id, title FROM tasks
WHERE project_id = ? AND external_id = ? AND status NOT IN ('done', 'archived')
LIMIT 1;
```

**API:** (Built into bulk create endpoint)

**Index Required:**
```sql
CREATE INDEX idx_tasks_external_id ON tasks(project_id, external_id) WHERE external_id IS NOT NULL;
```

---

## Bulk Operations

### Bulk Task Creation

**Endpoint:** `POST /projects/{projectId}/tasks:bulk`

**Request:**
```json
{
  "tasks": [
    {
      "title": "Fix memory leak in event handler",
      "description": "Code review found memory leak...",
      "priority_score": 1000,
      "status": "open",
      "milestone_id": "milestone-123",
      "parent_task_id": "task-456",
      "external_id": "code-review-finding-1",
      "labels": ["code-quality", "urgent"]
    },
    {
      "title": "Add error handling to API calls",
      "description": "Security review found missing error handling...",
      "priority_score": 1500,
      "status": "open",
      "milestone_id": "milestone-backlog",
      "parent_task_id": "task-456",
      "external_id": "security-review-finding-2"
    }
  ],
  "options": {
    "duplicate_detection": {
      "strategy": "title_and_milestone",  // or "external_id"
      "action": "skip"  // or "return_id"
    },
    "return_duplicates": true
  }
}
```

**Response:**
```json
{
  "created": [
    {
      "id": "task-789",
      "title": "Fix memory leak in event handler",
      "status": "open",
      "priority_score": 1000,
      "created_at": "2025-10-19T10:30:00Z"
    }
  ],
  "duplicates": [
    {
      "title": "Add error handling to API calls",
      "duplicate_of_id": "task-999",
      "reason": "Matching title in same milestone",
      "match_strategy": "title_and_milestone"
    }
  ],
  "summary": {
    "total_requested": 2,
    "created": 1,
    "duplicates": 1,
    "skipped": 0,
    "errors": 0
  }
}
```

**Performance Requirements:**
- 20 tasks: <100ms
- 100 tasks: <500ms
- Atomic: all or none (transaction)

**Duplicate Detection Strategies:**

1. **title_and_milestone:**
   - Match: LOWER(title) + milestone_id
   - Excludes: done/archived tasks
   - Use case: PM-created follow-up tasks

2. **external_id:**
   - Match: exact external_id
   - Excludes: done/archived tasks
   - Use case: Review findings with unique IDs

3. **none:**
   - No duplicate detection
   - Always create new tasks

---

## Success Criteria

### Performance Targets

1. **Task Status Update:** <10ms (single task)
2. **Bulk Task Creation:** <100ms for 20 tasks, <500ms for 100 tasks
3. **Task Query (milestone):** <50ms for 100 tasks
4. **Milestone Details:** <10ms
5. **Project Status:** <100ms for 1000 tasks
6. **Duplicate Detection:** <5ms per task (within bulk operation)

### Correctness Requirements

1. **Atomic Bulk Operations:** All tasks created or none (transaction)
2. **Duplicate Detection:** 100% accuracy for configured strategy
3. **Index Coverage:** All queries use indexes (no table scans)
4. **Referential Integrity:** Foreign keys enforced (project_id, milestone_id, parent_task_id)

### Scalability Targets

1. **Projects:** 100+ projects
2. **Tasks per project:** 10,000+ tasks
3. **Milestones per project:** 100+ milestones
4. **Bulk create:** Up to 100 tasks per request
5. **Concurrent workflows:** 10+ simultaneous workflow executions

---

## Non-Requirements (Out of Scope)

1. **Real-time updates:** No WebSocket or SSE required
2. **Full-text search:** No advanced search (use simple filters)
3. **Task comments/history:** Audit trail not required for MVP
4. **User management:** No users, permissions, or auth
5. **Task dependencies:** No dependency graph (parent_task_id sufficient)
6. **Custom fields:** No arbitrary metadata (predefined schema only)
7. **Webhooks:** No external notifications
8. **GraphQL:** REST API only

---

## Next Steps

1. **Day 2-3:** Design API endpoints (OpenAPI spec)
2. **Day 4:** Design SQLite schema
3. **Day 5:** Documentation + USER CHECKPOINT #2

---

## Appendix: Workflow Coverage

### Which workflows use which operations?

| Operation | task-flow | legacy | in-review | blocked | hotfix | project-loop |
|-----------|-----------|--------|-----------|---------|--------|--------------|
| Task status update | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Bulk task create | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Query existing tasks | ✅ | ✅ | ✅ | ❌ | ✅ | ❌ |
| Milestone check | ❌ | ✅ | ❌ | ❌ | ❌ | ✅ |
| Milestone details | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |
| Project status | ✅ | ✅ | ✅ | ✅ | ✅ | ✅ |

**Coverage:**
- Task status update: 100% (all 6 workflows)
- Bulk task create: 67% (4 of 6 workflows)
- Query existing tasks: 67% (4 of 6 workflows)
- Milestone operations: 100% (all workflows need milestone context)
- Project status: 100% (WorkflowCoordinator requirement)

**Conclusion:** All operations are required for production workflows.
