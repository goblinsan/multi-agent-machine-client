# Database Migration Strategy

**Project:** Multi-Agent Machine Client - Dashboard API  
**Database:** SQLite 3.35+  
**Version:** 1.0.0  
**Date:** October 19, 2025

---

## Overview

This document defines the migration strategy for the Dashboard API database schema, including versioning, migration execution, rollback procedures, and data integrity verification.

---

## Schema Versioning

### Version Format

**Semantic Versioning:** `MAJOR.MINOR.PATCH`

- **MAJOR:** Breaking changes (require data migration, API incompatibility)
- **MINOR:** Backward-compatible additions (new tables, columns, indexes)
- **PATCH:** Bug fixes, constraint changes, index optimizations

**Current Version:** `1.0.0`

### Schema Version Table

```sql
CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    description TEXT NOT NULL,
    applied_at TEXT NOT NULL DEFAULT (datetime('now')),
    checksum TEXT,  -- SHA256 of migration SQL
    execution_time_ms INTEGER,
    status TEXT NOT NULL DEFAULT 'pending',  -- 'pending', 'applied', 'failed', 'rolled_back'
    
    CHECK (status IN ('pending', 'applied', 'failed', 'rolled_back'))
);

-- Initial version entry
INSERT INTO schema_migrations (version, description, status)
VALUES ('1.0.0', 'Initial schema with projects, repositories, milestones, tasks', 'applied');
```

---

## Migration Files Structure

```
docs/dashboard-api/
├── schema.sql                      # Current complete schema
├── migrations/
│   ├── 001_initial_schema.sql      # v1.0.0 - Initial schema
│   ├── 001_initial_schema.down.sql # v1.0.0 - Rollback
│   ├── 002_add_task_tags.sql       # v1.1.0 - Example: Add tags
│   ├── 002_add_task_tags.down.sql  # v1.1.0 - Rollback
│   └── README.md                   # Migration instructions
```

### Migration File Naming

**Format:** `{sequence}_{description}.sql`

- **sequence:** Zero-padded 3-digit number (001, 002, 003)
- **description:** Snake_case description
- **Extension:** `.sql` for forward migration, `.down.sql` for rollback

**Examples:**
- `001_initial_schema.sql`
- `002_add_task_tags.sql`
- `003_optimize_priority_queue_index.sql`

---

## Migration Execution

### Method 1: Manual Execution (Development)

```bash
# Apply migration
sqlite3 data/dashboard.db < docs/dashboard-api/migrations/001_initial_schema.sql

# Verify schema version
sqlite3 data/dashboard.db "SELECT * FROM schema_migrations ORDER BY applied_at DESC LIMIT 1;"

# Check foreign keys enabled
sqlite3 data/dashboard.db "PRAGMA foreign_keys;"
```

### Method 2: Automated Script (Production)

```typescript
// src/db/migrate.ts
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';
import { createHash } from 'crypto';

interface Migration {
  version: string;
  file: string;
  description: string;
}

async function applyMigration(db: Database.Database, migration: Migration) {
  const sql = readFileSync(migration.file, 'utf-8');
  const checksum = createHash('sha256').update(sql).digest('hex');
  const startTime = Date.now();
  
  try {
    // Begin transaction
    db.exec('BEGIN TRANSACTION');
    
    // Execute migration SQL
    db.exec(sql);
    
    // Record migration
    db.prepare(`
      INSERT INTO schema_migrations (version, description, checksum, execution_time_ms, status)
      VALUES (?, ?, ?, ?, 'applied')
    `).run(migration.version, migration.description, checksum, Date.now() - startTime);
    
    // Commit transaction
    db.exec('COMMIT');
    
    console.log(`✅ Migration ${migration.version} applied successfully`);
  } catch (error) {
    // Rollback on error
    db.exec('ROLLBACK');
    
    // Record failure
    db.prepare(`
      INSERT INTO schema_migrations (version, description, checksum, status)
      VALUES (?, ?, ?, 'failed')
    `).run(migration.version, migration.description, checksum);
    
    console.error(`❌ Migration ${migration.version} failed:`, error);
    throw error;
  }
}

async function migrate(db: Database.Database) {
  // Get applied migrations
  const applied = db.prepare('SELECT version FROM schema_migrations WHERE status = "applied"').all();
  const appliedVersions = new Set(applied.map(r => r.version));
  
  // Get pending migrations
  const migrations: Migration[] = [
    { version: '1.0.0', file: 'docs/dashboard-api/migrations/001_initial_schema.sql', description: 'Initial schema' },
    { version: '1.1.0', file: 'docs/dashboard-api/migrations/002_add_task_tags.sql', description: 'Add task tags' },
  ];
  
  const pending = migrations.filter(m => !appliedVersions.has(m.version));
  
  // Apply pending migrations in order
  for (const migration of pending) {
    await applyMigration(db, migration);
  }
  
  console.log(`✅ All migrations applied (${migrations.length} total, ${pending.length} new)`);
}
```

### Method 3: SQL Migration Runner (Simple)

```bash
#!/bin/bash
# scripts/migrate.sh

DB_FILE="data/dashboard.db"
MIGRATION_DIR="docs/dashboard-api/migrations"

# Enable foreign keys
sqlite3 "$DB_FILE" "PRAGMA foreign_keys = ON;"

# Apply all migrations in order
for migration in "$MIGRATION_DIR"/*.sql; do
  # Skip rollback files
  if [[ "$migration" == *.down.sql ]]; then
    continue
  fi
  
  echo "Applying migration: $(basename "$migration")"
  sqlite3 "$DB_FILE" < "$migration"
  
  if [ $? -eq 0 ]; then
    echo "✅ Migration applied successfully"
  else
    echo "❌ Migration failed"
    exit 1
  fi
done

echo "✅ All migrations completed"
```

---

## Rollback Procedures

### Rollback Single Migration

```bash
# Apply rollback script
sqlite3 data/dashboard.db < docs/dashboard-api/migrations/002_add_task_tags.down.sql

# Update migration status
sqlite3 data/dashboard.db "UPDATE schema_migrations SET status = 'rolled_back' WHERE version = '1.1.0';"
```

### Rollback Strategy by Change Type

| Change Type | Rollback Strategy | Data Loss Risk |
|-------------|-------------------|----------------|
| **Add table** | DROP TABLE | ⚠️ High - all data in table |
| **Add column** | ALTER TABLE DROP COLUMN (SQLite 3.35+) | ⚠️ High - column data |
| **Add index** | DROP INDEX | ✅ None - can recreate |
| **Add trigger** | DROP TRIGGER | ✅ None - logic only |
| **Modify column** | Complex - requires table rebuild | ⚠️ High - requires backup |
| **Add constraint** | Recreate table without constraint | ⚠️ Medium - data validation |

### Complete Database Rollback

```bash
# Backup current database
cp data/dashboard.db data/dashboard.db.backup

# Drop all tables (nuclear option)
sqlite3 data/dashboard.db "
  DROP TABLE IF EXISTS tasks;
  DROP TABLE IF EXISTS milestones;
  DROP TABLE IF EXISTS repositories;
  DROP TABLE IF EXISTS projects;
  DROP TABLE IF EXISTS schema_migrations;
"

# Reapply schema from clean state
sqlite3 data/dashboard.db < docs/dashboard-api/schema.sql
```

---

## Data Integrity Verification

### Post-Migration Checks

```sql
-- 1. Verify all tables exist
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;
-- Expected: projects, repositories, milestones, tasks, schema_migrations

-- 2. Verify foreign key constraints
PRAGMA foreign_key_check;
-- Expected: Empty result (no violations)

-- 3. Verify index usage (explain query plan)
EXPLAIN QUERY PLAN 
SELECT * FROM tasks 
WHERE project_id = 1 AND status IN ('open', 'in_progress')
ORDER BY priority_score DESC
LIMIT 100;
-- Expected: SEARCH tasks USING INDEX idx_tasks_priority_queue

-- 4. Verify trigger functionality
INSERT INTO tasks (project_id, milestone_id, title, status) 
VALUES (1, 1, 'Test Task', 'open');

SELECT total_tasks, completed_tasks FROM milestones WHERE id = 1;
-- Expected: total_tasks incremented by 1

UPDATE tasks SET status = 'done' WHERE id = last_insert_rowid();

SELECT completed_tasks FROM milestones WHERE id = 1;
-- Expected: completed_tasks incremented by 1

DELETE FROM tasks WHERE id = last_insert_rowid();
-- Expected: milestone counts decremented

-- 5. Verify constraints
INSERT INTO tasks (project_id, title, status, priority_score) 
VALUES (1, 'Test', 'invalid_status', 5000);
-- Expected: CHECK constraint failed (invalid status)

INSERT INTO tasks (project_id, title, status, priority_score) 
VALUES (1, 'Test', 'open', 15000);
-- Expected: CHECK constraint failed (priority out of range)

-- 6. Verify computed fields
SELECT id, total_tasks, completed_tasks, completion_percentage 
FROM milestones;
-- Expected: completion_percentage = (completed_tasks * 100) / total_tasks

-- 7. Verify timestamps
SELECT created_at, updated_at FROM tasks WHERE id = 1;
-- Expected: Both non-null, ISO 8601 format

UPDATE tasks SET title = 'Updated' WHERE id = 1;
SELECT updated_at > created_at AS updated_after_created FROM tasks WHERE id = 1;
-- Expected: 1 (true)
```

### Automated Verification Script

```typescript
// src/db/verify.ts
import Database from 'better-sqlite3';

function verifySchema(db: Database.Database) {
  const checks = [
    {
      name: 'Tables exist',
      query: "SELECT COUNT(*) as count FROM sqlite_master WHERE type='table'",
      expected: 5,  // projects, repositories, milestones, tasks, schema_migrations
    },
    {
      name: 'Foreign keys enabled',
      query: 'PRAGMA foreign_keys',
      expected: 1,
    },
    {
      name: 'No foreign key violations',
      query: 'PRAGMA foreign_key_check',
      expected: [],
    },
    {
      name: 'Priority queue index exists',
      query: "SELECT COUNT(*) as count FROM sqlite_master WHERE type='index' AND name='idx_tasks_priority_queue'",
      expected: 1,
    },
  ];
  
  for (const check of checks) {
    const result = db.prepare(check.query).get();
    const success = JSON.stringify(result) === JSON.stringify(check.expected);
    console.log(`${success ? '✅' : '❌'} ${check.name}`);
  }
}
```

---

## Backup Strategy

### Pre-Migration Backup

```bash
# Timestamp-based backup
TIMESTAMP=$(date +%Y%m%d_%H%M%S)
cp data/dashboard.db "data/backups/dashboard_${TIMESTAMP}.db"

# Verify backup
sqlite3 "data/backups/dashboard_${TIMESTAMP}.db" "PRAGMA integrity_check;"
```

### Backup Retention Policy

- **Development:** Keep last 5 backups
- **Staging:** Keep last 30 days
- **Production:** Keep all backups indefinitely (or per compliance requirements)

### Backup Restoration

```bash
# List available backups
ls -lh data/backups/

# Restore from backup
cp data/backups/dashboard_20251019_143000.db data/dashboard.db

# Verify restoration
sqlite3 data/dashboard.db "SELECT version FROM schema_migrations ORDER BY applied_at DESC LIMIT 1;"
```

---

## Migration Best Practices

### 1. Always Use Transactions

```sql
BEGIN TRANSACTION;

-- Migration SQL here

COMMIT;
-- Or ROLLBACK on error
```

### 2. Make Migrations Idempotent

```sql
-- Use IF NOT EXISTS
CREATE TABLE IF NOT EXISTS new_table (...);

-- Check before modifying
ALTER TABLE tasks ADD COLUMN new_column TEXT;
-- Only if column doesn't exist (requires check)
```

### 3. Test in Development First

```bash
# Test migration on dev database
cp data/dashboard.db data/dashboard.db.test
sqlite3 data/dashboard.db.test < migrations/002_new_migration.sql

# Verify results
sqlite3 data/dashboard.db.test ".schema tasks"
```

### 4. Document Breaking Changes

```sql
-- BREAKING CHANGE: Renames tasks.priority to tasks.priority_score
-- Requires: Update all queries to use new column name
-- Data Migration: Copy priority to priority_score
```

### 5. Avoid Data Loss

```sql
-- ❌ BAD: Drops column immediately
ALTER TABLE tasks DROP COLUMN old_column;

-- ✅ GOOD: Deprecate first, drop in next major version
-- Migration 1.1.0: Add new_column, keep old_column
-- Migration 2.0.0: Drop old_column after applications updated
```

### 6. Use Checksums

```bash
# Generate checksum
sha256sum migrations/001_initial_schema.sql > migrations/001_initial_schema.sql.sha256

# Verify before applying
sha256sum -c migrations/001_initial_schema.sql.sha256
```

---

## Zero-Downtime Migration Strategy

### For Future Production Deployments

1. **Backward-Compatible Changes Only**
   - Add columns as nullable or with defaults
   - Add indexes (non-blocking in SQLite)
   - Add new tables

2. **Multi-Step Migrations for Breaking Changes**
   - **Step 1 (v1.1.0):** Add new column, populate from old column
   - **Step 2 (v1.2.0):** Deploy application code using new column
   - **Step 3 (v2.0.0):** Drop old column

3. **Read Replicas** (Future Consideration)
   - SQLite doesn't support read replicas natively
   - Consider using Litestream for replication

---

## Common Migration Scenarios

### Scenario 1: Add New Column

```sql
-- Forward migration (002_add_task_priority.sql)
BEGIN TRANSACTION;

ALTER TABLE tasks ADD COLUMN priority_level TEXT DEFAULT 'medium';

UPDATE schema_migrations 
SET version = '1.1.0', description = 'Add task priority level'
WHERE id = (SELECT MAX(id) FROM schema_migrations);

COMMIT;
```

```sql
-- Rollback migration (002_add_task_priority.down.sql)
BEGIN TRANSACTION;

ALTER TABLE tasks DROP COLUMN priority_level;

UPDATE schema_migrations 
SET status = 'rolled_back'
WHERE version = '1.1.0';

COMMIT;
```

### Scenario 2: Add Index

```sql
-- Forward migration (003_optimize_task_queries.sql)
BEGIN TRANSACTION;

CREATE INDEX idx_tasks_status_updated 
ON tasks(status, updated_at DESC);

INSERT INTO schema_migrations (version, description, status)
VALUES ('1.1.1', 'Add index for task status queries', 'applied');

COMMIT;
```

```sql
-- Rollback migration (003_optimize_task_queries.down.sql)
BEGIN TRANSACTION;

DROP INDEX IF EXISTS idx_tasks_status_updated;

UPDATE schema_migrations 
SET status = 'rolled_back'
WHERE version = '1.1.1';

COMMIT;
```

### Scenario 3: Modify Column (Requires Rebuild)

```sql
-- Forward migration (004_task_title_not_null.sql)
-- SQLite doesn't support ALTER COLUMN, requires table rebuild

BEGIN TRANSACTION;

-- Create new table with constraint
CREATE TABLE tasks_new (
    -- (copy all columns with new constraint)
    title TEXT NOT NULL,
    -- ...
);

-- Copy data
INSERT INTO tasks_new SELECT * FROM tasks;

-- Drop old table
DROP TABLE tasks;

-- Rename new table
ALTER TABLE tasks_new RENAME TO tasks;

-- Recreate indexes
CREATE INDEX idx_tasks_priority_queue ON tasks(...);

-- Update migration record
INSERT INTO schema_migrations (version, description, status)
VALUES ('1.2.0', 'Make task title NOT NULL', 'applied');

COMMIT;
```

---

## Error Recovery

### Migration Failed Mid-Execution

```bash
# Check migration status
sqlite3 data/dashboard.db "SELECT * FROM schema_migrations WHERE status = 'failed';"

# Check database integrity
sqlite3 data/dashboard.db "PRAGMA integrity_check;"

# If corrupted, restore from backup
cp data/backups/dashboard_latest.db data/dashboard.db

# Verify restoration
sqlite3 data/dashboard.db "SELECT COUNT(*) FROM tasks;"
```

### Foreign Key Violations After Migration

```bash
# Find violations
sqlite3 data/dashboard.db "PRAGMA foreign_key_check;"

# Example output:
# tasks|3|projects|0
# (tasks table, rowid 3, references projects, violation)

# Fix violations manually or rollback
sqlite3 data/dashboard.db < migrations/XXX_migration.down.sql
```

---

## Conclusion

This migration strategy provides:
- ✅ Versioned migrations with checksums
- ✅ Rollback procedures for all change types
- ✅ Data integrity verification
- ✅ Backup/restore procedures
- ✅ Common migration scenarios
- ✅ Error recovery procedures

**Next Steps:**
1. Implement migration runner script (TypeScript or Bash)
2. Create migration test suite
3. Document production deployment procedure
4. Set up automated backups

