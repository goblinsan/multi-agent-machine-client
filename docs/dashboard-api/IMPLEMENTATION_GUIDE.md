# Dashboard API Implementation Guide

**Project:** Multi-Agent Machine Client - Dashboard API  
**Version:** 1.0.0  
**Date:** October 19, 2025

---

## Table of Contents

1. [Overview](#overview)
2. [Technology Stack](#technology-stack)
3. [Project Structure](#project-structure)
4. [Database Setup](#database-setup)
5. [API Implementation Patterns](#api-implementation-patterns)
6. [Workflow Integration Examples](#workflow-integration-examples)
7. [Error Handling](#error-handling)
8. [Testing Strategy](#testing-strategy)
9. [Performance Optimization](#performance-optimization)
10. [Deployment](#deployment)

---

## Overview

This guide provides implementation details for the Dashboard API based on the OpenAPI specification and SQLite schema designed in Phase 1.

**Key Principles:**
- Self-contained backend (can extract to separate repo)
- HTTP API boundary (no direct imports from parent project)
- SQLite for persistence (simple, fast, reliable)
- Fastify for HTTP server (lightweight, fast)
- TypeScript for type safety

---

## Technology Stack

### Backend Framework: Fastify

**Why Fastify:**
- 2-3x faster than Express
- Built-in validation (JSON Schema)
- TypeScript support
- Plugin architecture
- Low overhead

**Installation:**
```bash
npm install fastify @fastify/cors @fastify/swagger
```

### Database: better-sqlite3

**Why better-sqlite3:**
- Synchronous API (simpler code)
- 2-3x faster than node-sqlite3
- Full transaction support
- Prepared statements
- Type-safe

**Installation:**
```bash
npm install better-sqlite3
npm install -D @types/better-sqlite3
```

### Validation: Zod

**Why Zod:**
- TypeScript-first validation
- Inferred types from schemas
- Composable validators
- Clear error messages

**Installation:**
```bash
npm install zod
```

---

## Project Structure

```
src/dashboard-backend/
├── package.json              # Independent dependencies
├── tsconfig.json             # TypeScript config
├── README.md                 # Setup instructions
├── src/
│   ├── server.ts             # Fastify server setup
│   ├── db/
│   │   ├── connection.ts     # SQLite connection
│   │   ├── migrations.ts     # Migration runner
│   │   └── schema.sql        # Schema (from Phase 1)
│   ├── routes/
│   │   ├── tasks.ts          # Task endpoints
│   │   ├── milestones.ts     # Milestone endpoints
│   │   ├── projects.ts       # Project endpoints
│   │   └── repositories.ts   # Repository endpoints
│   ├── models/
│   │   ├── task.ts           # Task model + validation
│   │   ├── milestone.ts      # Milestone model
│   │   └── project.ts        # Project model
│   ├── services/
│   │   ├── taskService.ts    # Business logic
│   │   └── bulkService.ts    # Bulk operations
│   └── utils/
│       ├── errors.ts         # RFC 7807 error handling
│       └── validators.ts     # Zod schemas
├── tests/
│   ├── tasks.test.ts
│   ├── bulk.test.ts
│   └── integration.test.ts
└── data/
    └── dashboard.db          # SQLite database file
```

---

## Database Setup

### Connection Setup

```typescript
// src/db/connection.ts
import Database from 'better-sqlite3';
import { join } from 'path';

export function createConnection(dbPath?: string): Database.Database {
  const path = dbPath || join(__dirname, '../../data/dashboard.db');
  
  const db = new Database(path);
  
  // Enable foreign keys
  db.pragma('foreign_keys = ON');
  
  // Enable WAL mode for better concurrency
  db.pragma('journal_mode = WAL');
  
  // Optimize for speed
  db.pragma('synchronous = NORMAL');
  db.pragma('cache_size = -64000'); // 64MB cache
  
  return db;
}

// Singleton instance
let dbInstance: Database.Database | null = null;

export function getDb(): Database.Database {
  if (!dbInstance) {
    dbInstance = createConnection();
  }
  return dbInstance;
}

export function closeDb(): void {
  if (dbInstance) {
    dbInstance.close();
    dbInstance = null;
  }
}
```

### Migration Runner

```typescript
// src/db/migrations.ts
import { Database } from 'better-sqlite3';
import { readFileSync } from 'fs';
import { join } from 'path';

export function runMigrations(db: Database): void {
  // Create schema_migrations table if not exists
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      version TEXT NOT NULL UNIQUE,
      description TEXT NOT NULL,
      applied_at TEXT NOT NULL DEFAULT (datetime('now')),
      status TEXT NOT NULL DEFAULT 'applied'
    )
  `);
  
  // Check if initial schema applied
  const applied = db.prepare(
    'SELECT version FROM schema_migrations WHERE version = ?'
  ).get('1.0.0');
  
  if (!applied) {
    console.log('Applying initial schema...');
    
    // Read and execute schema.sql
    const schemaPath = join(__dirname, 'schema.sql');
    const schema = readFileSync(schemaPath, 'utf-8');
    
    db.exec('BEGIN TRANSACTION');
    try {
      db.exec(schema);
      
      // Record migration
      db.prepare(`
        INSERT INTO schema_migrations (version, description, status)
        VALUES (?, ?, 'applied')
      `).run('1.0.0', 'Initial schema');
      
      db.exec('COMMIT');
      console.log('✅ Schema applied successfully');
    } catch (error) {
      db.exec('ROLLBACK');
      console.error('❌ Schema migration failed:', error);
      throw error;
    }
  }
}
```

---

## API Implementation Patterns

### Pattern 1: Simple GET Endpoint

```typescript
// src/routes/tasks.ts
import { FastifyInstance } from 'fastify';
import { getDb } from '../db/connection';
import { taskSchema } from '../models/task';

export async function taskRoutes(fastify: FastifyInstance) {
  // GET /projects/:projectId/tasks/:taskId
  fastify.get<{
    Params: { projectId: string; taskId: string };
  }>('/projects/:projectId/tasks/:taskId', {
    schema: {
      params: {
        type: 'object',
        properties: {
          projectId: { type: 'string' },
          taskId: { type: 'string' }
        },
        required: ['projectId', 'taskId']
      }
    }
  }, async (request, reply) => {
    const { projectId, taskId } = request.params;
    const db = getDb();
    
    const task = db.prepare(`
      SELECT * FROM tasks 
      WHERE id = ? AND project_id = ?
    `).get(taskId, projectId);
    
    if (!task) {
      return reply.status(404).send({
        type: 'https://api.example.com/errors/not-found',
        title: 'Task Not Found',
        status: 404,
        detail: `Task ${taskId} not found in project ${projectId}`
      });
    }
    
    // Parse JSON fields
    if (task.labels) {
      task.labels = JSON.parse(task.labels);
    }
    
    return task;
  });
}
```

### Pattern 2: List with Query Parameters

```typescript
// GET /projects/:projectId/tasks
fastify.get<{
  Params: { projectId: string };
  Querystring: {
    status?: string;
    milestone_id?: string;
    priority_min?: number;
    sort?: string;
    limit?: number;
    offset?: number;
    fields?: string;
  };
}>('/projects/:projectId/tasks', async (request, reply) => {
  const { projectId } = request.params;
  const {
    status,
    milestone_id,
    priority_min,
    sort = 'priority_score:desc',
    limit = 100,
    offset = 0,
    fields
  } = request.query;
  
  const db = getDb();
  
  // Build query dynamically
  let sql = 'SELECT ';
  sql += fields ? fields : '*';
  sql += ' FROM tasks WHERE project_id = ?';
  
  const params: any[] = [projectId];
  
  // Add filters
  if (status) {
    const statuses = status.split(',');
    const placeholders = statuses.map(() => '?').join(',');
    sql += ` AND status IN (${placeholders})`;
    params.push(...statuses);
  }
  
  if (milestone_id) {
    sql += ' AND milestone_id = ?';
    params.push(milestone_id);
  }
  
  if (priority_min) {
    sql += ' AND priority_score >= ?';
    params.push(priority_min);
  }
  
  // Add sorting
  const [sortField, sortDir = 'asc'] = sort.split(':');
  sql += ` ORDER BY ${sortField} ${sortDir.toUpperCase()}`;
  
  // Add pagination
  sql += ' LIMIT ? OFFSET ?';
  params.push(limit, offset);
  
  // Execute query
  const tasks = db.prepare(sql).all(...params);
  
  // Parse JSON fields
  tasks.forEach(task => {
    if (task.labels) task.labels = JSON.parse(task.labels);
  });
  
  // Get total count
  let countSql = 'SELECT COUNT(*) as total FROM tasks WHERE project_id = ?';
  const countParams = [projectId];
  
  if (status) {
    const statuses = status.split(',');
    const placeholders = statuses.map(() => '?').join(',');
    countSql += ` AND status IN (${placeholders})`;
    countParams.push(...statuses);
  }
  
  const { total } = db.prepare(countSql).get(...countParams) as { total: number };
  
  return {
    data: tasks,
    pagination: {
      total,
      limit,
      offset,
      hasMore: offset + tasks.length < total
    }
  };
});
```

### Pattern 3: POST with Validation

```typescript
// src/models/task.ts
import { z } from 'zod';

export const taskCreateSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  milestone_id: z.number().int().positive().optional(),
  parent_task_id: z.number().int().positive().optional(),
  status: z.enum(['open', 'in_progress', 'in_review', 'blocked', 'done', 'archived']).default('open'),
  priority_score: z.number().int().min(0).max(10000).default(0),
  external_id: z.string().optional(),
  labels: z.array(z.string()).optional()
});

export type TaskCreate = z.infer<typeof taskCreateSchema>;

// src/routes/tasks.ts
import { taskCreateSchema } from '../models/task';

// POST /projects/:projectId/tasks
fastify.post<{
  Params: { projectId: string };
  Body: TaskCreate;
}>('/projects/:projectId/tasks', async (request, reply) => {
  const { projectId } = request.params;
  
  // Validate request body
  const result = taskCreateSchema.safeParse(request.body);
  if (!result.success) {
    return reply.status(400).send({
      type: 'https://api.example.com/errors/validation-error',
      title: 'Validation Error',
      status: 400,
      detail: 'Request validation failed',
      errors: result.error.errors.map(err => ({
        field: err.path.join('.'),
        message: err.message,
        code: err.code
      }))
    });
  }
  
  const data = result.data;
  const db = getDb();
  
  // Verify project exists
  const project = db.prepare('SELECT id FROM projects WHERE id = ?').get(projectId);
  if (!project) {
    return reply.status(404).send({
      type: 'https://api.example.com/errors/not-found',
      title: 'Project Not Found',
      status: 404,
      detail: `Project ${projectId} not found`
    });
  }
  
  // Insert task
  const stmt = db.prepare(`
    INSERT INTO tasks (
      project_id, title, description, milestone_id, parent_task_id,
      status, priority_score, external_id, labels
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const info = stmt.run(
    projectId,
    data.title,
    data.description || null,
    data.milestone_id || null,
    data.parent_task_id || null,
    data.status,
    data.priority_score,
    data.external_id || null,
    data.labels ? JSON.stringify(data.labels) : null
  );
  
  // Fetch created task
  const task = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
  
  if (task.labels) {
    task.labels = JSON.parse(task.labels);
  }
  
  return reply.status(201).send(task);
});
```

### Pattern 4: PATCH for Updates

```typescript
// src/models/task.ts
export const taskUpdateSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().optional(),
  status: z.enum(['open', 'in_progress', 'in_review', 'blocked', 'done', 'archived']).optional(),
  priority_score: z.number().int().min(0).max(10000).optional(),
  milestone_id: z.number().int().positive().nullable().optional(),
  labels: z.array(z.string()).optional(),
  comment: z.string().optional() // Audit trail
});

export type TaskUpdate = z.infer<typeof taskUpdateSchema>;

// PATCH /projects/:projectId/tasks/:taskId
fastify.patch<{
  Params: { projectId: string; taskId: string };
  Body: TaskUpdate;
}>('/projects/:projectId/tasks/:taskId', async (request, reply) => {
  const { projectId, taskId } = request.params;
  
  // Validate
  const result = taskUpdateSchema.safeParse(request.body);
  if (!result.success) {
    return reply.status(400).send({
      type: 'https://api.example.com/errors/validation-error',
      title: 'Validation Error',
      status: 400,
      errors: result.error.errors.map(err => ({
        field: err.path.join('.'),
        message: err.message
      }))
    });
  }
  
  const data = result.data;
  const db = getDb();
  
  // Check task exists
  const existing = db.prepare(`
    SELECT * FROM tasks WHERE id = ? AND project_id = ?
  `).get(taskId, projectId);
  
  if (!existing) {
    return reply.status(404).send({
      type: 'https://api.example.com/errors/not-found',
      title: 'Task Not Found',
      status: 404
    });
  }
  
  // Build UPDATE dynamically
  const updates: string[] = [];
  const params: any[] = [];
  
  if (data.title !== undefined) {
    updates.push('title = ?');
    params.push(data.title);
  }
  if (data.description !== undefined) {
    updates.push('description = ?');
    params.push(data.description);
  }
  if (data.status !== undefined) {
    updates.push('status = ?');
    params.push(data.status);
  }
  if (data.priority_score !== undefined) {
    updates.push('priority_score = ?');
    params.push(data.priority_score);
  }
  if (data.milestone_id !== undefined) {
    updates.push('milestone_id = ?');
    params.push(data.milestone_id);
  }
  if (data.labels !== undefined) {
    updates.push('labels = ?');
    params.push(JSON.stringify(data.labels));
  }
  
  if (updates.length === 0) {
    return reply.status(400).send({
      type: 'https://api.example.com/errors/validation-error',
      title: 'No Updates Provided',
      status: 400
    });
  }
  
  // Always update updated_at
  updates.push('updated_at = datetime("now")');
  params.push(taskId, projectId);
  
  // Execute update
  const stmt = db.prepare(`
    UPDATE tasks 
    SET ${updates.join(', ')}
    WHERE id = ? AND project_id = ?
  `);
  
  stmt.run(...params);
  
  // Fetch updated task
  const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(taskId);
  if (updated.labels) {
    updated.labels = JSON.parse(updated.labels);
  }
  
  return updated;
});
```

### Pattern 5: Bulk Operations

```typescript
// src/services/bulkService.ts
import { Database } from 'better-sqlite3';
import { TaskCreate } from '../models/task';

interface BulkCreateOptions {
  projectId: number;
  tasks: TaskCreate[];
  duplicateDetection?: 'title' | 'title_and_milestone' | 'external_id' | 'none';
  onDuplicate?: 'skip' | 'error';
}

interface BulkCreateResult {
  created: any[];
  duplicates: Array<{
    task: TaskCreate;
    reason: string;
    existingTaskId: number;
  }>;
  summary: {
    totalRequested: number;
    created: number;
    duplicates: number;
    skipped: number;
    errors: number;
  };
}

export function bulkCreateTasks(
  db: Database,
  options: BulkCreateOptions
): BulkCreateResult {
  const {
    projectId,
    tasks,
    duplicateDetection = 'title_and_milestone',
    onDuplicate = 'skip'
  } = options;
  
  const result: BulkCreateResult = {
    created: [],
    duplicates: [],
    summary: {
      totalRequested: tasks.length,
      created: 0,
      duplicates: 0,
      skipped: 0,
      errors: 0
    }
  };
  
  // Prepare statements
  const insertStmt = db.prepare(`
    INSERT INTO tasks (
      project_id, title, description, milestone_id, parent_task_id,
      status, priority_score, external_id, labels
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  
  const checkTitleStmt = db.prepare(`
    SELECT id FROM tasks
    WHERE project_id = ? 
      AND milestone_id = ?
      AND LOWER(title) = LOWER(?)
      AND status NOT IN ('done', 'archived')
    LIMIT 1
  `);
  
  const checkExternalIdStmt = db.prepare(`
    SELECT id FROM tasks
    WHERE project_id = ? AND external_id = ?
    LIMIT 1
  `);
  
  // Transaction for atomicity
  db.exec('BEGIN TRANSACTION');
  
  try {
    for (const task of tasks) {
      let duplicate: any = null;
      
      // Check for duplicates
      if (duplicateDetection === 'title_and_milestone' && task.milestone_id) {
        duplicate = checkTitleStmt.get(projectId, task.milestone_id, task.title);
      } else if (duplicateDetection === 'external_id' && task.external_id) {
        duplicate = checkExternalIdStmt.get(projectId, task.external_id);
      }
      
      if (duplicate) {
        result.duplicates.push({
          task,
          reason: `Duplicate found: ${duplicateDetection}`,
          existingTaskId: duplicate.id
        });
        result.summary.duplicates++;
        
        if (onDuplicate === 'error') {
          throw new Error(`Duplicate task found: ${task.title}`);
        }
        
        result.summary.skipped++;
        continue;
      }
      
      // Insert task
      const info = insertStmt.run(
        projectId,
        task.title,
        task.description || null,
        task.milestone_id || null,
        task.parent_task_id || null,
        task.status || 'open',
        task.priority_score || 0,
        task.external_id || null,
        task.labels ? JSON.stringify(task.labels) : null
      );
      
      // Fetch created task
      const created = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
      if (created.labels) {
        created.labels = JSON.parse(created.labels);
      }
      
      result.created.push(created);
      result.summary.created++;
    }
    
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
  
  return result;
}

// Route handler
fastify.post<{
  Params: { projectId: string };
  Body: {
    tasks: TaskCreate[];
    duplicateDetection?: 'title' | 'title_and_milestone' | 'external_id' | 'none';
    onDuplicate?: 'skip' | 'error';
  };
}>('/projects/:projectId/tasks:bulk', async (request, reply) => {
  const { projectId } = request.params;
  const { tasks, duplicateDetection, onDuplicate } = request.body;
  
  if (!Array.isArray(tasks) || tasks.length === 0) {
    return reply.status(400).send({
      type: 'https://api.example.com/errors/validation-error',
      title: 'Invalid Request',
      status: 400,
      detail: 'tasks array is required and must not be empty'
    });
  }
  
  if (tasks.length > 100) {
    return reply.status(400).send({
      type: 'https://api.example.com/errors/validation-error',
      title: 'Batch Too Large',
      status: 400,
      detail: 'Maximum 100 tasks per bulk request'
    });
  }
  
  const db = getDb();
  
  try {
    const result = bulkCreateTasks(db, {
      projectId: parseInt(projectId),
      tasks,
      duplicateDetection,
      onDuplicate
    });
    
    return reply.status(201).send(result);
  } catch (error: any) {
    return reply.status(500).send({
      type: 'https://api.example.com/errors/internal-error',
      title: 'Bulk Operation Failed',
      status: 500,
      detail: error.message
    });
  }
});
```

---

## Workflow Integration Examples

### Example 1: WorkflowCoordinator Priority Queue

```typescript
// Get next task to execute
async function getNextTask(projectId: number): Promise<Task | null> {
  const response = await fetch(
    `http://localhost:3000/projects/${projectId}/tasks?` +
    `status=open,in_progress,blocked,in_review&` +
    `sort=priority_score:desc,created_at:asc&` +
    `limit=1`
  );
  
  const data = await response.json();
  return data.data[0] || null;
}
```

### Example 2: Review Failure - Bulk Task Creation

```typescript
// Create follow-up tasks from review findings
async function createReviewFollowupTasks(
  projectId: number,
  milestoneId: number,
  findings: ReviewFinding[]
): Promise<BulkCreateResult> {
  const tasks = findings.map(finding => ({
    title: `Fix: ${finding.title}`,
    description: finding.description,
    milestone_id: milestoneId,
    status: 'open' as const,
    priority_score: finding.severity === 'critical' ? 1500 : 1200,
    external_id: finding.id,
    labels: ['review-followup', finding.reviewType]
  }));
  
  const response = await fetch(
    `http://localhost:3000/projects/${projectId}/tasks:bulk`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        tasks,
        duplicateDetection: 'external_id',
        onDuplicate: 'skip'
      })
    }
  );
  
  return await response.json();
}
```

### Example 3: Task Status Update

```typescript
// Mark task in progress
async function markTaskInProgress(
  projectId: number,
  taskId: number
): Promise<Task> {
  const response = await fetch(
    `http://localhost:3000/projects/${projectId}/tasks/${taskId}`,
    {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        status: 'in_progress',
        comment: 'Started by WorkflowCoordinator'
      })
    }
  );
  
  return await response.json();
}
```

### Example 4: Duplicate Detection Query

```typescript
// Check for existing tasks in milestone
async function checkDuplicates(
  projectId: number,
  milestoneId: number,
  titles: string[]
): Promise<Task[]> {
  const response = await fetch(
    `http://localhost:3000/projects/${projectId}/milestones/${milestoneId}/tasks?` +
    `status=!done,!archived&` +
    `fields=id,title,status,external_id`
  );
  
  const data = await response.json();
  const existingTitles = new Set(
    data.data.map((t: Task) => t.title.toLowerCase())
  );
  
  return data.data.filter((t: Task) =>
    titles.some(title => title.toLowerCase() === t.title.toLowerCase())
  );
}
```

### Example 5: Milestone Completion Check

```typescript
// Check if milestone is complete
async function isMilestoneComplete(
  projectId: number,
  milestoneId: number
): Promise<boolean> {
  const response = await fetch(
    `http://localhost:3000/projects/${projectId}/milestones/${milestoneId}`
  );
  
  const milestone = await response.json();
  return milestone.completion_percentage === 100;
}
```

---

## Error Handling

### RFC 7807 Problem Details

```typescript
// src/utils/errors.ts
export interface ProblemDetails {
  type: string;
  title: string;
  status: number;
  detail?: string;
  instance?: string;
  errors?: Array<{
    field: string;
    message: string;
    code?: string;
  }>;
}

export function notFound(resource: string, id: string): ProblemDetails {
  return {
    type: 'https://api.example.com/errors/not-found',
    title: 'Resource Not Found',
    status: 404,
    detail: `${resource} ${id} not found`
  };
}

export function validationError(errors: any[]): ProblemDetails {
  return {
    type: 'https://api.example.com/errors/validation-error',
    title: 'Validation Error',
    status: 400,
    detail: 'Request validation failed',
    errors
  };
}

export function conflict(message: string): ProblemDetails {
  return {
    type: 'https://api.example.com/errors/conflict',
    title: 'Conflict',
    status: 409,
    detail: message
  };
}
```

### Global Error Handler

```typescript
// src/server.ts
fastify.setErrorHandler((error, request, reply) => {
  // Log error
  fastify.log.error(error);
  
  // Handle known errors
  if (error.statusCode) {
    return reply.status(error.statusCode).send({
      type: 'https://api.example.com/errors/client-error',
      title: error.name,
      status: error.statusCode,
      detail: error.message
    });
  }
  
  // Unknown errors
  return reply.status(500).send({
    type: 'https://api.example.com/errors/internal-error',
    title: 'Internal Server Error',
    status: 500,
    detail: 'An unexpected error occurred'
  });
});
```

---

## Testing Strategy

### Unit Tests (Services)

```typescript
// tests/bulkService.test.ts
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import Database from 'better-sqlite3';
import { bulkCreateTasks } from '../src/services/bulkService';

describe('bulkCreateTasks', () => {
  let db: Database.Database;
  
  beforeEach(() => {
    db = new Database(':memory:');
    // Apply schema
    db.exec(readFileSync('src/db/schema.sql', 'utf-8'));
    
    // Insert test project
    db.prepare('INSERT INTO projects (id, name, slug) VALUES (1, "Test", "test")').run();
    db.prepare('INSERT INTO milestones (id, project_id, name, slug) VALUES (1, 1, "M1", "m1")').run();
  });
  
  afterEach(() => {
    db.close();
  });
  
  it('creates tasks in bulk', () => {
    const result = bulkCreateTasks(db, {
      projectId: 1,
      tasks: [
        { title: 'Task 1', milestone_id: 1 },
        { title: 'Task 2', milestone_id: 1 }
      ]
    });
    
    expect(result.summary.created).toBe(2);
    expect(result.created).toHaveLength(2);
  });
  
  it('detects duplicates by title and milestone', () => {
    // Create first task
    db.prepare('INSERT INTO tasks (project_id, milestone_id, title, status) VALUES (1, 1, "Task 1", "open")').run();
    
    const result = bulkCreateTasks(db, {
      projectId: 1,
      tasks: [
        { title: 'Task 1', milestone_id: 1 }, // Duplicate
        { title: 'Task 2', milestone_id: 1 }  // New
      ],
      duplicateDetection: 'title_and_milestone',
      onDuplicate: 'skip'
    });
    
    expect(result.summary.created).toBe(1);
    expect(result.summary.duplicates).toBe(1);
    expect(result.duplicates[0].task.title).toBe('Task 1');
  });
});
```

### Integration Tests (API)

```typescript
// tests/integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { build } from '../src/server';

describe('Task API', () => {
  const app = build();
  
  beforeAll(async () => {
    await app.ready();
  });
  
  afterAll(async () => {
    await app.close();
  });
  
  it('creates and retrieves task', async () => {
    // Create project first
    const projectRes = await app.inject({
      method: 'POST',
      url: '/projects',
      payload: { name: 'Test Project', slug: 'test-project' }
    });
    const project = JSON.parse(projectRes.body);
    
    // Create task
    const createRes = await app.inject({
      method: 'POST',
      url: `/projects/${project.id}/tasks`,
      payload: {
        title: 'Test Task',
        status: 'open',
        priority_score: 1000
      }
    });
    
    expect(createRes.statusCode).toBe(201);
    const task = JSON.parse(createRes.body);
    expect(task.title).toBe('Test Task');
    
    // Retrieve task
    const getRes = await app.inject({
      method: 'GET',
      url: `/projects/${project.id}/tasks/${task.id}`
    });
    
    expect(getRes.statusCode).toBe(200);
    const retrieved = JSON.parse(getRes.body);
    expect(retrieved.id).toBe(task.id);
  });
});
```

---

## Performance Optimization

### Query Optimization

```typescript
// Use prepared statements
const stmt = db.prepare('SELECT * FROM tasks WHERE id = ?');
const task = stmt.get(taskId);

// Reuse prepared statements in loops
const insertStmt = db.prepare('INSERT INTO tasks (...) VALUES (...)');
for (const task of tasks) {
  insertStmt.run(...values);
}

// Use transactions for bulk operations
db.exec('BEGIN TRANSACTION');
try {
  // Multiple operations
  db.exec('COMMIT');
} catch (error) {
  db.exec('ROLLBACK');
  throw error;
}
```

### Index Usage Verification

```typescript
// Check query plan
const plan = db.prepare('EXPLAIN QUERY PLAN SELECT * FROM tasks WHERE project_id = ? AND status = ?').all(1, 'open');
console.log(plan);
// Should show: SEARCH tasks USING INDEX idx_tasks_priority_queue
```

### Connection Pooling (Not Needed)

SQLite is serverless - no connection pooling needed. Single connection per process is optimal.

---

## Deployment

### Environment Variables

```bash
# .env
DATABASE_PATH=./data/dashboard.db
PORT=3000
LOG_LEVEL=info
```

### Server Setup

```typescript
// src/server.ts
import Fastify from 'fastify';
import { taskRoutes } from './routes/tasks';
import { runMigrations } from './db/migrations';
import { getDb } from './db/connection';

export function build() {
  const fastify = Fastify({
    logger: {
      level: process.env.LOG_LEVEL || 'info'
    }
  });
  
  // Apply migrations on startup
  runMigrations(getDb());
  
  // Register routes
  fastify.register(taskRoutes);
  
  return fastify;
}

// Start server
const start = async () => {
  try {
    const app = build();
    await app.listen({
      port: parseInt(process.env.PORT || '3000'),
      host: '0.0.0.0'
    });
  } catch (err) {
    console.error(err);
    process.exit(1);
  }
};

start();
```

### Production Checklist

- [ ] Enable CORS for allowed origins
- [ ] Add request rate limiting
- [ ] Setup logging (Winston or Pino)
- [ ] Configure error tracking (Sentry)
- [ ] Setup database backups (Litestream)
- [ ] Add health check endpoint (`GET /health`)
- [ ] Configure process manager (PM2)
- [ ] Setup monitoring (metrics, alerts)

---

## Conclusion

This implementation guide provides:
- ✅ Complete setup instructions
- ✅ Code patterns for all endpoint types
- ✅ Workflow integration examples
- ✅ Error handling strategy
- ✅ Testing approach
- ✅ Performance optimization
- ✅ Deployment guidance

**Next Steps:**
1. Implement Phase 2 proof-of-concept
2. Test with real workflow scenarios
3. Measure performance against targets
4. Iterate based on findings

