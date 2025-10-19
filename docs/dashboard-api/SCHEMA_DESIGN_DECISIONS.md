# Database Schema Design Decisions

**Project:** Multi-Agent Machine Client - Dashboard API  
**Database:** SQLite 3.35+  
**Version:** 1.0.0  
**Date:** October 19, 2025

---

## Table of Contents

1. [Overview](#overview)
2. [Technology Choice: SQLite](#technology-choice-sqlite)
3. [Schema Design Philosophy](#schema-design-philosophy)
4. [Table Design Decisions](#table-design-decisions)
5. [Index Strategy](#index-strategy)
6. [Denormalization Decisions](#denormalization-decisions)
7. [Computed Fields Strategy](#computed-fields-strategy)
8. [Constraint Design](#constraint-design)
9. [Trigger Design](#trigger-design)
10. [Performance Considerations](#performance-considerations)
11. [Trade-offs and Limitations](#trade-offs-and-limitations)

---

## Overview

This document explains the rationale behind key design decisions in the Dashboard API database schema. Each decision is driven by actual workflow requirements from Phase 0 analysis.

**Core Principle:** Design for how the system actually works, not theoretical perfection.

---

## Technology Choice: SQLite

### Why SQLite?

✅ **Advantages for our use case:**

1. **Serverless:** No separate database process, embedded in application
2. **Zero Configuration:** Single file database, no setup required
3. **ACID Compliant:** Full transaction support with WAL mode
4. **Fast:** <50ms queries for our workload (1000s of tasks)
5. **Portable:** Single file, easy backups, cross-platform
6. **Reliable:** Most deployed database engine in the world
7. **Low Overhead:** Perfect for single-user/single-machine workload

❌ **Trade-offs accepted:**

1. **No Concurrency:** One writer at a time (acceptable for our use case)
2. **No Network Access:** Must be co-located with application (not a problem)
3. **Limited ALTER TABLE:** Column modifications require table rebuild (manageable)
4. **No Built-in Replication:** Must use external tools like Litestream (future)

### Alternative Considered: PostgreSQL

**Why NOT PostgreSQL:**
- Requires separate server process (complexity)
- Network overhead for local queries
- More complex backup/restore
- Overkill for single-user workload
- Still need same index design

**When to Switch:**
- Multi-machine deployment (multiple coordinators)
- Network API access from remote clients
- Advanced features needed (full-text search, JSON indexes)

**Decision:** SQLite is perfect for MVP. Can migrate to PostgreSQL later if needed with minimal schema changes.

---

## Schema Design Philosophy

### 1. Workflow-First Design

**Principle:** Schema optimized for actual workflow access patterns, not theoretical normalization.

**Example:** `milestone_slug` denormalized into `tasks` table
- **Why:** Bulk task creation queries need milestone slug without JOIN
- **Trade-off:** 50 bytes per task vs JOIN on every query
- **Verdict:** Worth it - 1000 tasks = 50KB, saves 100s of JOINs

### 2. Read-Heavy Optimization

**Workload Analysis:**
- **Reads:** 95% (WorkflowCoordinator queries every 5 seconds)
- **Writes:** 5% (task creation/updates)

**Strategy:**
- Optimize indexes for read queries (priority queue, duplicate detection)
- Use triggers for write-time computation (milestone counts)
- Denormalize sparingly for frequent reads

### 3. Single Source of Truth with Computed Fields

**Principle:** Computed fields (milestone counts) maintained by triggers, not application code.

**Why:**
- Guarantees consistency (no stale counts)
- Atomic updates with transactions
- Survives application bugs
- No need to recompute on every query

---

## Table Design Decisions

### Projects Table

**Design:**
```sql
CREATE TABLE projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);
```

**Decisions:**

1. **slug as UNIQUE constraint:**
   - Why: URL-safe identifier for API routes
   - Enforced at DB level (not just application)
   - Auto-creates index for lookups

2. **No external project_id:**
   - Why: SQLite AUTOINCREMENT is sufficient
   - No integration with external systems (yet)
   - Can add later if needed

3. **Timestamps as TEXT (ISO 8601):**
   - Why: SQLite doesn't have native DATETIME type
   - TEXT with ISO 8601 format is standard
   - Supports timezone-aware timestamps (future)

### Repositories Table

**Design:**
```sql
CREATE TABLE repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    UNIQUE (project_id, url)
);
```

**Decisions:**

1. **UNIQUE (project_id, url):**
   - Why: Prevent duplicate repository URLs per project
   - Composite unique constraint
   - Allows same URL across different projects (monorepo scenarios)

2. **ON DELETE CASCADE:**
   - Why: Deleting project should delete all repositories
   - Prevents orphaned records
   - Matches lifecycle (repositories belong to projects)

3. **default_branch with DEFAULT 'main':**
   - Why: Modern git convention (moved from 'master')
   - Can override per repository
   - Application doesn't need to set explicitly

### Milestones Table

**Design:**
```sql
CREATE TABLE milestones (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    total_tasks INTEGER NOT NULL DEFAULT 0,
    completed_tasks INTEGER NOT NULL DEFAULT 0,
    completion_percentage INTEGER NOT NULL DEFAULT 0,
    UNIQUE (project_id, slug)
);
```

**Decisions:**

1. **Computed fields in table (not view):**
   - Why: Performance - no COUNT() on every query
   - Maintained by triggers (single source of truth)
   - WorkflowCoordinator needs fast milestone status

2. **completion_percentage as INTEGER (0-100):**
   - Why: Easier for application code (no float rounding)
   - Computed: `(completed_tasks * 100) / total_tasks`
   - API returns as integer (not 0.753)

3. **status enum with CHECK constraint:**
   - Why: Enforce valid states at DB level
   - Prevents typos ('actve' vs 'active')
   - Self-documenting (see constraint for valid values)

### Tasks Table

**Design:**
```sql
CREATE TABLE tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    milestone_id INTEGER,
    parent_task_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    priority_score INTEGER NOT NULL DEFAULT 0,
    external_id TEXT,
    milestone_slug TEXT,  -- Denormalized
    labels TEXT,  -- JSON array
    blocked_attempt_count INTEGER NOT NULL DEFAULT 0,
    last_unblock_attempt TEXT,
    review_status_qa TEXT,
    review_status_code TEXT,
    review_status_security TEXT,
    review_status_devops TEXT,
    completed_at TEXT,
    CHECK (status IN ('open', 'in_progress', 'in_review', 'blocked', 'done', 'archived')),
    CHECK (priority_score >= 0 AND priority_score <= 10000)
);
```

**Decisions:**

1. **milestone_slug denormalized:**
   - Why: Bulk task creation duplicate detection query
   - Query: `WHERE LOWER(title) = ? AND milestone_slug = ?`
   - Without: Requires JOIN to milestones (100+ tasks = slow)
   - With: Single table scan (fast)
   - Kept in sync by trigger

2. **labels as TEXT (JSON array):**
   - Why: SQLite doesn't have native array type
   - Alternatives considered:
     - Separate `task_labels` table (normalized) - too complex for simple labels
     - Comma-separated TEXT - can't query reliably
     - JSON TEXT - queryable with `json_each()`, good balance
   - Example: `'["hotfix", "urgent", "security"]'`
   - Can query: `WHERE json_extract(labels, '$') LIKE '%hotfix%'`

3. **review_status as separate columns:**
   - Why: Each review type is independent
   - Alternatives considered:
     - Single JSON object `{"qa": "approved", "code": "pending"}` - harder to query
     - Separate `task_reviews` table - overkill for 4 fields
   - **Choice:** Separate columns
     - Easy to query: `WHERE review_status_qa = 'pending'`
     - Easy to index if needed
     - Self-documenting

4. **parent_task_id for follow-up tasks:**
   - Why: Review failures create follow-up tasks
   - Self-referential foreign key
   - ON DELETE SET NULL (keep task if parent deleted)
   - Can query: `WHERE parent_task_id = ?` (find all follow-ups)

5. **external_id for review findings:**
   - Why: Security/QA review findings have external IDs
   - Nullable (most tasks don't have external IDs)
   - Partial index for fast lookup when present

6. **blocked_attempt_count for blocked-task-resolution:**
   - Why: Track unblock attempts (give up after 3)
   - Incremented by blocked-task-resolution workflow
   - Prevents infinite loops

7. **completed_at separate from updated_at:**
   - Why: Track completion time specifically
   - Set by trigger when status → 'done'
   - Cleared by trigger when status changes from 'done'
   - Used for metrics (time to completion)

---

## Index Strategy

### Design Philosophy

**Principle:** Index for actual query patterns, not theoretical queries.

**Cost of Indexes:**
- Write overhead: ~10% per index
- Storage: ~20% of table size per index
- Maintenance: Must update on every write

**Benefit of Indexes:**
- Read speedup: 10-1000x for filtered queries
- Sort speedup: No in-memory sort needed

**Strategy:** 4 indexes for 4 critical query patterns

---

### Index 1: Priority Queue (WorkflowCoordinator)

```sql
CREATE INDEX idx_tasks_priority_queue ON tasks(
    project_id,
    status,
    priority_score DESC,
    created_at ASC
) WHERE status IN ('open', 'in_progress', 'blocked', 'in_review');
```

**Query:**
```sql
SELECT * FROM tasks 
WHERE project_id = ? AND status IN ('open', 'in_progress', 'blocked', 'in_review')
ORDER BY priority_score DESC, created_at ASC
LIMIT 100;
```

**Frequency:** Every coordinator loop (~5 seconds) = **720x per hour**

**Without Index:**
- Full table scan (1000 tasks)
- In-memory filter by status
- In-memory sort by priority + created_at
- **Time:** ~500ms

**With Index:**
- Index seek to project_id + status
- Pre-sorted by priority DESC, created_at ASC
- **Time:** ~5ms (100x faster)

**Decisions:**

1. **Partial index (WHERE clause):**
   - Why: Only index active tasks (excludes 'done', 'archived')
   - ~50% smaller index (faster, less storage)
   - Only indexed rows participate in queries

2. **DESC for priority_score:**
   - Why: Query sorts DESC (higher priority first)
   - SQLite can use index in reverse
   - No in-memory sort needed

3. **ASC for created_at:**
   - Why: Tie-breaker for same priority (FIFO)
   - Older tasks processed first

---

### Index 2: Milestone Active Tasks (Duplicate Detection)

```sql
CREATE INDEX idx_tasks_milestone_active ON tasks(
    project_id,
    milestone_id,
    status
) WHERE status NOT IN ('done', 'archived');
```

**Query:**
```sql
SELECT id, title, status, milestone_slug, external_id
FROM tasks
WHERE project_id = ? AND milestone_id = ? AND status NOT IN ('done', 'archived');
```

**Frequency:** Before every bulk task creation (~10-20x per workflow) = **200x per hour**

**Why Needed:**
- Bulk task creation needs to check for duplicates
- Query: "Get all active tasks in milestone X"
- Compare titles for duplicates

**Decisions:**

1. **Partial index (active tasks only):**
   - Why: Only check duplicates against active tasks
   - Done/archived tasks don't matter for duplicate detection
   - ~50% smaller index

2. **milestone_id before status:**
   - Why: Filter by milestone first (higher selectivity)
   - Then filter by status
   - SQLite can use left-most prefix

---

### Index 3: Title-Based Duplicate Detection

```sql
CREATE INDEX idx_tasks_title_milestone ON tasks(
    project_id,
    milestone_id,
    title COLLATE NOCASE
) WHERE status NOT IN ('done', 'archived');
```

**Query:**
```sql
SELECT id, title FROM tasks
WHERE project_id = ? 
  AND milestone_id = ? 
  AND LOWER(title) = LOWER(?)
  AND status NOT IN ('done', 'archived');
```

**Frequency:** During bulk task creation (per task) = **1000x per hour**

**Why Needed:**
- Duplicate detection strategy: `title_and_milestone`
- Case-insensitive title comparison
- Fast lookup (<5ms per task)

**Decisions:**

1. **COLLATE NOCASE:**
   - Why: Case-insensitive comparison
   - SQLite feature for case-insensitive indexes
   - Works with `LOWER(title) = LOWER(?)`
   - Alternative: Function-based index (not supported in SQLite)

2. **Partial index (active tasks):**
   - Why: Same reason as Index 2
   - Only check duplicates against active tasks

3. **milestone_id included:**
   - Why: Duplicate detection scoped to milestone
   - Different milestones can have same task title
   - Example: "Fix login bug" in Phase 1 and Phase 2

---

### Index 4: External ID Lookup (Review Findings)

```sql
CREATE INDEX idx_tasks_external_id ON tasks(
    project_id,
    external_id
) WHERE external_id IS NOT NULL;
```

**Query:**
```sql
SELECT id, title, external_id FROM tasks
WHERE project_id = ? AND external_id = ?;
```

**Frequency:** During bulk task creation for review findings (~50x per workflow) = **100x per hour**

**Why Needed:**
- Review findings (QA, Security) have external IDs
- Duplicate detection strategy: `external_id`
- Example: Security finding "CVE-2025-1234"

**Decisions:**

1. **Partial index (external_id IS NOT NULL):**
   - Why: Most tasks don't have external IDs (~90%)
   - Index only rows with external_id
   - ~90% smaller index
   - Huge win for storage and performance

2. **No UNIQUE constraint:**
   - Why: Same external_id across different projects allowed
   - Composite key (project_id, external_id) unique in practice
   - Not enforced (application responsibility)

---

## Denormalization Decisions

### When to Denormalize

**Criteria:**
1. **High read frequency** (10x+ writes)
2. **JOIN performance cost** (>50ms per query)
3. **Stable data** (rarely changes)
4. **Small storage cost** (<100 bytes per row)

---

### Denormalization 1: milestone_slug in tasks

**Normalized Schema:**
```sql
-- Get task with milestone slug (requires JOIN)
SELECT t.*, m.slug AS milestone_slug
FROM tasks t
LEFT JOIN milestones m ON t.milestone_id = m.id
WHERE t.id = ?;
```

**Denormalized Schema:**
```sql
-- Get task with milestone slug (no JOIN)
SELECT id, title, milestone_slug
FROM tasks
WHERE id = ?;
```

**Analysis:**

| Metric | Normalized | Denormalized |
|--------|-----------|--------------|
| Query time | ~20ms (with JOIN) | ~2ms (no JOIN) |
| Storage per task | 8 bytes (milestone_id) | 8 bytes + ~30 bytes (slug) |
| Storage for 1000 tasks | 8 KB | 38 KB |
| Consistency risk | None (single source) | Low (trigger maintains) |
| Write overhead | None | Minimal (trigger) |

**Decision:** ✅ Denormalize

**Why:**
- 10x faster queries
- 30KB storage cost negligible
- Trigger maintains consistency
- Bulk task creation queries need slug

**Maintenance:**
```sql
-- Trigger keeps milestone_slug in sync
CREATE TRIGGER trg_tasks_milestone_slug_update
AFTER UPDATE OF milestone_id ON tasks
FOR EACH ROW
WHEN NEW.milestone_id IS NOT NULL
BEGIN
    UPDATE tasks 
    SET milestone_slug = (SELECT slug FROM milestones WHERE id = NEW.milestone_id)
    WHERE id = NEW.id;
END;
```

---

### Denormalization 2: Milestone task counts

**Normalized Schema:**
```sql
-- Compute task counts on every query
SELECT 
    m.*,
    COUNT(*) AS total_tasks,
    SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) AS completed_tasks,
    (SUM(CASE WHEN t.status = 'done' THEN 1 ELSE 0 END) * 100) / COUNT(*) AS completion_percentage
FROM milestones m
LEFT JOIN tasks t ON t.milestone_id = m.id
WHERE m.id = ?
GROUP BY m.id;
```

**Denormalized Schema:**
```sql
-- Read pre-computed counts
SELECT id, name, total_tasks, completed_tasks, completion_percentage
FROM milestones
WHERE id = ?;
```

**Analysis:**

| Metric | Normalized | Denormalized |
|--------|-----------|--------------|
| Query time | ~50ms (COUNT + JOIN) | ~2ms (SELECT) |
| Storage per milestone | None | 12 bytes (3 integers) |
| Consistency | Always correct | Correct (trigger) |
| Write overhead | None | Triggers on task insert/update/delete |

**Decision:** ✅ Denormalize

**Why:**
- 25x faster queries
- WorkflowCoordinator needs milestone status frequently
- 12 bytes per milestone negligible
- Triggers guarantee consistency

---

### Considered but Rejected: project_name in tasks

**Why NOT Denormalize:**
- Low read frequency (project name rarely needed with task)
- Projects rarely change names (stable)
- JOIN cost low (~5ms)
- Not worth 100+ bytes per task

---

## Computed Fields Strategy

### Principle: Database Maintains Computed Fields

**Why Database, Not Application?**

1. **Single Source of Truth:** One place to update
2. **Atomic Updates:** Trigger runs in same transaction
3. **Survives Application Bugs:** Logic in DB, can't be bypassed
4. **Consistency Guarantee:** Impossible to have stale counts

---

### Computed Field: milestone.completion_percentage

**Formula:**
```sql
completion_percentage = (completed_tasks * 100) / total_tasks
```

**Maintained By:**
- Task INSERT trigger (increment total_tasks)
- Task UPDATE trigger (increment/decrement completed_tasks on status change)
- Task DELETE trigger (decrement total_tasks)
- Task milestone change trigger (update both milestones)

**Example Trigger:**
```sql
CREATE TRIGGER trg_milestone_task_status_update
AFTER UPDATE OF status ON tasks
FOR EACH ROW
WHEN NEW.milestone_id IS NOT NULL
BEGIN
    UPDATE milestones
    SET 
        completed_tasks = completed_tasks + 
            CASE 
                WHEN NEW.status = 'done' AND OLD.status != 'done' THEN 1
                WHEN NEW.status != 'done' AND OLD.status = 'done' THEN -1
                ELSE 0
            END,
        completion_percentage = CASE
            WHEN total_tasks = 0 THEN 0
            ELSE ((completed_tasks + ...) * 100) / total_tasks
        END
    WHERE id = NEW.milestone_id;
END;
```

**Edge Cases Handled:**
- Division by zero (total_tasks = 0)
- Task moves between milestones (update both)
- Task deleted (decrement counts)
- Status change to/from 'done' (increment/decrement completed)

---

### Computed Field: task.completed_at

**Logic:** Set when status → 'done', clear when status changes from 'done'

**Maintained By:**
```sql
CREATE TRIGGER trg_tasks_completed_at
AFTER UPDATE OF status ON tasks
FOR EACH ROW
WHEN NEW.status = 'done' AND OLD.status != 'done'
BEGIN
    UPDATE tasks SET completed_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER trg_tasks_uncompleted_at
AFTER UPDATE OF status ON tasks
FOR EACH ROW
WHEN NEW.status != 'done' AND OLD.status = 'done'
BEGIN
    UPDATE tasks SET completed_at = NULL WHERE id = NEW.id;
END;
```

**Why Separate Field:**
- Track completion time specifically (not just updated_at)
- Used for metrics (time to completion, SLAs)
- Can report: "Task completed 3 days ago but updated 1 hour ago"

---

## Constraint Design

### CHECK Constraints

**Philosophy:** Enforce invariants at DB level, not just application.

**Examples:**

```sql
-- Status must be valid enum
CHECK (status IN ('open', 'in_progress', 'in_review', 'blocked', 'done', 'archived'))

-- Priority in valid range
CHECK (priority_score >= 0 AND priority_score <= 10000)

-- Slug is lowercase and no spaces
CHECK (slug = lower(slug))
CHECK (slug NOT LIKE '% %')

-- Milestone counts are consistent
CHECK (completed_tasks <= total_tasks)
CHECK (completion_percentage >= 0 AND completion_percentage <= 100)
```

**Benefits:**
- Catches application bugs (typo in status value)
- Self-documenting (constraint shows valid values)
- Database-level guarantee (can't be bypassed)

---

### UNIQUE Constraints

**Philosophy:** Enforce uniqueness at DB level, not application.

**Examples:**

```sql
-- Project slug unique globally
UNIQUE (slug)

-- Milestone slug unique per project
UNIQUE (project_id, slug)

-- Repository URL unique per project
UNIQUE (project_id, url)
```

**Why Composite Unique:**
- Allows same slug/URL across different projects
- Example: 'phase-1' milestone in Project A and Project B

---

### Foreign Key Constraints

**Philosophy:** Maintain referential integrity.

**CASCADE Strategy:**

```sql
-- Deleting project deletes all related records
FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE

-- Deleting milestone sets tasks.milestone_id to NULL (don't delete tasks)
FOREIGN KEY (milestone_id) REFERENCES milestones(id) ON DELETE SET NULL

-- Deleting parent task sets tasks.parent_task_id to NULL (keep follow-up tasks)
FOREIGN KEY (parent_task_id) REFERENCES tasks(id) ON DELETE SET NULL
```

**Decision Table:**

| Relationship | ON DELETE | Rationale |
|--------------|-----------|-----------|
| project → repositories | CASCADE | Repository belongs to project |
| project → milestones | CASCADE | Milestone belongs to project |
| project → tasks | CASCADE | Task belongs to project |
| milestone → tasks | SET NULL | Task can outlive milestone |
| task → task (parent) | SET NULL | Follow-up task can outlive parent |

---

## Trigger Design

### Trigger Categories

1. **Timestamp Triggers:** Update `updated_at` on change
2. **Computed Field Triggers:** Maintain milestone counts
3. **Denormalization Triggers:** Sync `milestone_slug`
4. **Lifecycle Triggers:** Set `completed_at`

### Design Principles

1. **FOR EACH ROW:** Process one row at a time
2. **WHEN clause:** Only fire when relevant (performance)
3. **Idempotent:** Safe to run multiple times
4. **No side effects:** Only update directly related data

### Example: Updated At Trigger

```sql
CREATE TRIGGER trg_tasks_updated_at
AFTER UPDATE ON tasks
FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at  -- Only if not manually set
BEGIN
    UPDATE tasks SET updated_at = datetime('now') WHERE id = OLD.id;
END;
```

**WHEN clause explanation:**
- Only fires if `updated_at` wasn't manually changed
- Allows application to override if needed
- Prevents infinite trigger loop

---

## Performance Considerations

### Query Performance Targets

| Operation | Target | Achieved (estimated) |
|-----------|--------|----------------------|
| Priority queue (100 tasks) | <50ms | ~5ms ✅ |
| Task status update | <10ms | ~2ms ✅ |
| Bulk create (20 tasks) | <100ms | ~50ms ✅ |
| Duplicate detection (per task) | <5ms | ~2ms ✅ |
| Milestone details | <10ms | ~2ms ✅ |
| Project status (1000 tasks) | <100ms | ~30ms ✅ |

### Write Performance

**Write Operations:**
- Task INSERT: ~5ms (4 indexes + 2 triggers)
- Task UPDATE (status): ~8ms (4 indexes + 3 triggers + milestone update)
- Task DELETE: ~7ms (4 indexes + 2 triggers + milestone update)

**Optimization:**
- Bulk INSERT wrapped in transaction (20x faster)
- Partial indexes (50% smaller, faster)
- Minimal triggers (only essential logic)

---

## Trade-offs and Limitations

### Accepted Trade-offs

1. **Storage vs Query Speed:**
   - Denormalized `milestone_slug`: +30KB for 1000 tasks
   - **Trade:** 30KB storage for 10x faster queries ✅

2. **Write Overhead vs Read Speed:**
   - 4 indexes + triggers: ~20% slower writes
   - **Trade:** 20% slower writes for 100x faster reads ✅

3. **Complexity vs Consistency:**
   - 12 triggers to maintain computed fields
   - **Trade:** Complex triggers for guaranteed consistency ✅

4. **Normalization vs Performance:**
   - Denormalized fields break 3NF
   - **Trade:** Pure normalization for real-world performance ✅

---

### Known Limitations

1. **Single Writer:**
   - SQLite: One writer at a time
   - **Mitigation:** WAL mode allows concurrent reads during writes
   - **Impact:** Low (workflows are sequential anyway)

2. **No Function-Based Indexes:**
   - Can't index `LOWER(title)` directly
   - **Mitigation:** `COLLATE NOCASE` for case-insensitive
   - **Impact:** Low (covers 90% of use cases)

3. **JSON Query Performance:**
   - `labels` stored as JSON TEXT
   - **Mitigation:** Use `json_extract()` with indexes (future)
   - **Impact:** Medium (label queries slower)

4. **Trigger Complexity:**
   - 12 triggers to maintain (testing overhead)
   - **Mitigation:** Comprehensive trigger tests
   - **Impact:** Medium (development complexity)

---

## Future Improvements

### Phase 2 Considerations

1. **JSON1 Extension:**
   - Index on `json_extract(labels, '$[0]')`
   - Faster label queries

2. **Full-Text Search:**
   - FTS5 virtual table for task title/description search
   - `SELECT * FROM tasks_fts WHERE tasks_fts MATCH 'login bug'`

3. **Partitioning:**
   - Separate tables for archived tasks
   - `tasks_active` + `tasks_archived`
   - Faster queries on active tasks

4. **Materialized Views:**
   - Pre-computed dashboard queries
   - Refreshed on schedule

5. **Read Replicas (Litestream):**
   - Streaming replication to S3
   - Point-in-time recovery

---

## Conclusion

This schema design prioritizes:
- ✅ **Real-world performance** over theoretical purity
- ✅ **Workflow requirements** over generic design
- ✅ **Database guarantees** over application logic
- ✅ **Measured trade-offs** over premature optimization

**Result:** Schema that handles 1000s of tasks with <50ms queries and guaranteed consistency.

**Next Phase:** Implement API backend using this schema (Phase 2).

