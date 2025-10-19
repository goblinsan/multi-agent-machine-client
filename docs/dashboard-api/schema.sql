-- ============================================================================
-- Multi-Agent Machine Client - Dashboard API Database Schema
-- ============================================================================
-- Version: 1.0.0
-- Database: SQLite 3.35+
-- Date: 2025-10-19
-- Description: Complete database schema for Dashboard API with optimized
--              indexes for workflow query patterns
-- ============================================================================

-- Enable foreign key constraints (SQLite requires this per connection)
PRAGMA foreign_keys = ON;

-- Enable Write-Ahead Logging for better concurrency
PRAGMA journal_mode = WAL;

-- ============================================================================
-- TABLE: projects
-- ============================================================================
-- Purpose: Top-level container for tasks, milestones, repositories
-- Access Pattern: Low frequency, mostly reads
-- ============================================================================

CREATE TABLE IF NOT EXISTS projects (
    -- Primary Key
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Core Fields
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    
    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    -- Constraints
    CHECK (length(name) > 0),
    CHECK (length(slug) > 0),
    CHECK (slug = lower(slug)),  -- Enforce lowercase slugs
    CHECK (slug NOT LIKE '% %')  -- No spaces in slugs
);

-- Index for slug lookups (unique constraint already creates index)
-- No additional index needed

-- ============================================================================
-- TABLE: repositories
-- ============================================================================
-- Purpose: Git repositories associated with projects
-- Access Pattern: Read frequently (WorkflowCoordinator), write rarely
-- ============================================================================

CREATE TABLE IF NOT EXISTS repositories (
    -- Primary Key
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Foreign Key
    project_id INTEGER NOT NULL,
    
    -- Core Fields
    url TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    
    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    -- Constraints
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CHECK (length(url) > 0),
    CHECK (length(default_branch) > 0),
    UNIQUE (project_id, url)  -- One URL per project
);

-- Index for project lookups (common in WorkflowCoordinator)
CREATE INDEX idx_repositories_project ON repositories(project_id);

-- ============================================================================
-- TABLE: milestones
-- ============================================================================
-- Purpose: Project milestones for organizing tasks
-- Access Pattern: Read frequently, write occasionally
-- Computed Fields: total_tasks, completed_tasks, completion_percentage
-- ============================================================================

CREATE TABLE IF NOT EXISTS milestones (
    -- Primary Key
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    
    -- Foreign Key
    project_id INTEGER NOT NULL,
    
    -- Core Fields
    name TEXT NOT NULL,
    slug TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'active',
    
    -- Computed Fields (updated by triggers)
    total_tasks INTEGER NOT NULL DEFAULT 0,
    completed_tasks INTEGER NOT NULL DEFAULT 0,
    completion_percentage INTEGER NOT NULL DEFAULT 0,
    
    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    
    -- Constraints
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
    UNIQUE (project_id, slug)  -- Unique slug per project
);

-- Index for project lookups
CREATE INDEX idx_milestones_project ON milestones(project_id);

-- Index for status filtering
CREATE INDEX idx_milestones_project_status ON milestones(project_id, status);

-- ============================================================================
-- TABLE: tasks
-- ============================================================================
-- Purpose: Individual work items managed by workflows
-- Access Pattern: Very high frequency reads/writes, complex queries
-- Query Patterns: See indexes below
-- ============================================================================

CREATE TABLE IF NOT EXISTS tasks (
    -- Primary Key
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
    
    -- External Integration
    external_id TEXT,  -- For review findings, tickets, etc.
    
    -- Denormalized Milestone Data (performance optimization)
    milestone_slug TEXT,  -- Copied from milestone for faster queries
    
    -- Labels (stored as JSON array for SQLite compatibility)
    labels TEXT,  -- JSON array: ["hotfix", "urgent"]
    
    -- Blocked Task Tracking
    blocked_attempt_count INTEGER NOT NULL DEFAULT 0,
    last_unblock_attempt TEXT,  -- ISO 8601 timestamp
    
    -- Review Status (JSON object or separate fields)
    review_status_qa TEXT,           -- 'pending', 'approved', 'rejected', null
    review_status_code TEXT,         -- 'pending', 'approved', 'rejected', null
    review_status_security TEXT,     -- 'pending', 'approved', 'rejected', null
    review_status_devops TEXT,       -- 'pending', 'approved', 'rejected', null
    
    -- Timestamps
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,  -- Set when status changes to 'done'
    
    -- Constraints
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

-- ============================================================================
-- INDEXES: Optimized for Workflow Query Patterns
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Query Pattern 1: Priority Queue (WorkflowCoordinator)
-- ----------------------------------------------------------------------------
-- Query: SELECT * FROM tasks 
--        WHERE project_id = ? AND status IN ('open', 'in_progress', 'blocked', 'in_review')
--        ORDER BY priority_score DESC, created_at ASC
--        LIMIT 100
-- Frequency: Every coordinator loop (~every 5 seconds)
-- Performance Target: <50ms for 1000 tasks
-- ----------------------------------------------------------------------------
CREATE INDEX idx_tasks_priority_queue ON tasks(
    project_id,
    status,
    priority_score DESC,
    created_at ASC
) WHERE status IN ('open', 'in_progress', 'blocked', 'in_review');

-- ----------------------------------------------------------------------------
-- Query Pattern 2: Milestone Task Listing (Duplicate Detection)
-- ----------------------------------------------------------------------------
-- Query: SELECT id, title, status, milestone_slug, external_id
--        FROM tasks
--        WHERE project_id = ? AND milestone_id = ? AND status NOT IN ('done', 'archived')
-- Frequency: Before every bulk task creation (~10-20x per workflow)
-- Performance Target: <50ms for 100 tasks
-- ----------------------------------------------------------------------------
CREATE INDEX idx_tasks_milestone_active ON tasks(
    project_id,
    milestone_id,
    status
) WHERE status NOT IN ('done', 'archived');

-- ----------------------------------------------------------------------------
-- Query Pattern 3: Title-Based Duplicate Detection
-- ----------------------------------------------------------------------------
-- Query: SELECT id, title FROM tasks
--        WHERE project_id = ? AND milestone_id = ? 
--        AND LOWER(title) = LOWER(?)
--        AND status NOT IN ('done', 'archived')
-- Frequency: During bulk task creation (per task)
-- Performance Target: <5ms per lookup
-- Note: SQLite doesn't support function-based indexes, so we use collation
-- ----------------------------------------------------------------------------
CREATE INDEX idx_tasks_title_milestone ON tasks(
    project_id,
    milestone_id,
    title COLLATE NOCASE
) WHERE status NOT IN ('done', 'archived');

-- ----------------------------------------------------------------------------
-- Query Pattern 4: External ID Lookup (Review Findings)
-- ----------------------------------------------------------------------------
-- Query: SELECT id, title, external_id FROM tasks
--        WHERE project_id = ? AND external_id = ?
-- Frequency: During bulk task creation for review findings
-- Performance Target: <5ms per lookup
-- Note: Partial index (only rows with external_id)
-- ----------------------------------------------------------------------------
CREATE INDEX idx_tasks_external_id ON tasks(
    project_id,
    external_id
) WHERE external_id IS NOT NULL;

-- ----------------------------------------------------------------------------
-- Additional Performance Indexes
-- ----------------------------------------------------------------------------

-- Parent task lookups (for follow-up tasks)
CREATE INDEX idx_tasks_parent ON tasks(parent_task_id)
    WHERE parent_task_id IS NOT NULL;

-- Project-wide task queries
CREATE INDEX idx_tasks_project_status ON tasks(project_id, status);

-- Created timestamp for sorting
CREATE INDEX idx_tasks_created ON tasks(created_at);

-- ============================================================================
-- TRIGGERS: Maintain Computed Fields and Data Integrity
-- ============================================================================

-- ----------------------------------------------------------------------------
-- Trigger: Update project.updated_at on any change
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_projects_updated_at
AFTER UPDATE ON projects
FOR EACH ROW
BEGIN
    UPDATE projects SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- ----------------------------------------------------------------------------
-- Trigger: Update repository.updated_at on any change
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_repositories_updated_at
AFTER UPDATE ON repositories
FOR EACH ROW
BEGIN
    UPDATE repositories SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- ----------------------------------------------------------------------------
-- Trigger: Update milestone.updated_at on any change
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_milestones_updated_at
AFTER UPDATE ON milestones
FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at  -- Only if not manually set
BEGIN
    UPDATE milestones SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- ----------------------------------------------------------------------------
-- Trigger: Update task.updated_at on any change
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_tasks_updated_at
AFTER UPDATE ON tasks
FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at  -- Only if not manually set
BEGIN
    UPDATE tasks SET updated_at = datetime('now') WHERE id = OLD.id;
END;

-- ----------------------------------------------------------------------------
-- Trigger: Set task.completed_at when status changes to 'done'
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_tasks_completed_at
AFTER UPDATE OF status ON tasks
FOR EACH ROW
WHEN NEW.status = 'done' AND OLD.status != 'done'
BEGIN
    UPDATE tasks SET completed_at = datetime('now') WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- Trigger: Clear task.completed_at when status changes from 'done'
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_tasks_uncompleted_at
AFTER UPDATE OF status ON tasks
FOR EACH ROW
WHEN NEW.status != 'done' AND OLD.status = 'done'
BEGIN
    UPDATE tasks SET completed_at = NULL WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- Trigger: Sync task.milestone_slug from milestone (denormalization)
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_tasks_milestone_slug_insert
AFTER INSERT ON tasks
FOR EACH ROW
WHEN NEW.milestone_id IS NOT NULL
BEGIN
    UPDATE tasks 
    SET milestone_slug = (SELECT slug FROM milestones WHERE id = NEW.milestone_id)
    WHERE id = NEW.id;
END;

CREATE TRIGGER trg_tasks_milestone_slug_update
AFTER UPDATE OF milestone_id ON tasks
FOR EACH ROW
WHEN NEW.milestone_id IS NOT NULL
BEGIN
    UPDATE tasks 
    SET milestone_slug = (SELECT slug FROM milestones WHERE id = NEW.milestone_id)
    WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- Trigger: Increment milestone.total_tasks when task is created
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_milestone_task_insert
AFTER INSERT ON tasks
FOR EACH ROW
WHEN NEW.milestone_id IS NOT NULL
BEGIN
    UPDATE milestones
    SET 
        total_tasks = total_tasks + 1,
        completion_percentage = CASE
            WHEN (total_tasks + 1) = 0 THEN 0
            ELSE (completed_tasks * 100) / (total_tasks + 1)
        END
    WHERE id = NEW.milestone_id;
END;

-- ----------------------------------------------------------------------------
-- Trigger: Update milestone task counts when task status changes
-- ----------------------------------------------------------------------------
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
            ELSE ((completed_tasks + 
                CASE 
                    WHEN NEW.status = 'done' AND OLD.status != 'done' THEN 1
                    WHEN NEW.status != 'done' AND OLD.status = 'done' THEN -1
                    ELSE 0
                END
            ) * 100) / total_tasks
        END
    WHERE id = NEW.milestone_id;
END;

-- ----------------------------------------------------------------------------
-- Trigger: Update milestone counts when task milestone changes
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_milestone_task_move
AFTER UPDATE OF milestone_id ON tasks
FOR EACH ROW
WHEN OLD.milestone_id IS NOT NULL OR NEW.milestone_id IS NOT NULL
BEGIN
    -- Decrement old milestone
    UPDATE milestones
    SET 
        total_tasks = total_tasks - 1,
        completed_tasks = completed_tasks - CASE WHEN OLD.status = 'done' THEN 1 ELSE 0 END,
        completion_percentage = CASE
            WHEN (total_tasks - 1) = 0 THEN 0
            ELSE ((completed_tasks - CASE WHEN OLD.status = 'done' THEN 1 ELSE 0 END) * 100) / (total_tasks - 1)
        END
    WHERE id = OLD.milestone_id;
    
    -- Increment new milestone
    UPDATE milestones
    SET 
        total_tasks = total_tasks + 1,
        completed_tasks = completed_tasks + CASE WHEN NEW.status = 'done' THEN 1 ELSE 0 END,
        completion_percentage = CASE
            WHEN (total_tasks + 1) = 0 THEN 0
            ELSE ((completed_tasks + CASE WHEN NEW.status = 'done' THEN 1 ELSE 0 END) * 100) / (total_tasks + 1)
        END
    WHERE id = NEW.milestone_id;
END;

-- ----------------------------------------------------------------------------
-- Trigger: Decrement milestone.total_tasks when task is deleted
-- ----------------------------------------------------------------------------
CREATE TRIGGER trg_milestone_task_delete
AFTER DELETE ON tasks
FOR EACH ROW
WHEN OLD.milestone_id IS NOT NULL
BEGIN
    UPDATE milestones
    SET 
        total_tasks = total_tasks - 1,
        completed_tasks = completed_tasks - CASE WHEN OLD.status = 'done' THEN 1 ELSE 0 END,
        completion_percentage = CASE
            WHEN (total_tasks - 1) = 0 THEN 0
            ELSE ((completed_tasks - CASE WHEN OLD.status = 'done' THEN 1 ELSE 0 END) * 100) / (total_tasks - 1)
        END
    WHERE id = OLD.milestone_id;
END;

-- ============================================================================
-- VIEWS: Convenient Query Helpers
-- ============================================================================

-- ----------------------------------------------------------------------------
-- View: tasks_with_milestone_name
-- Purpose: Join tasks with milestone names (avoid denormalization)
-- ----------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS tasks_with_milestone_name AS
SELECT 
    t.*,
    m.name AS milestone_name
FROM tasks t
LEFT JOIN milestones m ON t.milestone_id = m.id;

-- ----------------------------------------------------------------------------
-- View: active_tasks_priority_queue
-- Purpose: Pre-filtered view for WorkflowCoordinator
-- ----------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS active_tasks_priority_queue AS
SELECT 
    t.id,
    t.project_id,
    t.title,
    t.status,
    t.priority_score,
    t.milestone_id,
    t.milestone_slug,
    t.parent_task_id,
    t.labels,
    t.blocked_attempt_count,
    t.created_at,
    t.updated_at
FROM tasks t
WHERE t.status IN ('open', 'in_progress', 'blocked', 'in_review')
ORDER BY t.priority_score DESC, t.created_at ASC;

-- ----------------------------------------------------------------------------
-- View: milestone_completion_status
-- Purpose: Human-readable milestone status with task counts
-- ----------------------------------------------------------------------------
CREATE VIEW IF NOT EXISTS milestone_completion_status AS
SELECT 
    m.id,
    m.project_id,
    m.name,
    m.slug,
    m.status,
    m.total_tasks,
    m.completed_tasks,
    m.completion_percentage,
    m.total_tasks - m.completed_tasks AS remaining_tasks,
    CASE
        WHEN m.total_tasks = 0 THEN 'empty'
        WHEN m.completion_percentage = 100 THEN 'complete'
        WHEN m.completion_percentage >= 75 THEN 'nearly_done'
        WHEN m.completion_percentage >= 50 THEN 'in_progress'
        WHEN m.completion_percentage >= 25 THEN 'started'
        ELSE 'barely_started'
    END AS progress_label,
    m.created_at,
    m.updated_at
FROM milestones m;

-- ============================================================================
-- SAMPLE DATA: For Development/Testing (Optional)
-- ============================================================================
-- Uncomment to insert sample data for local testing

/*
-- Sample Project
INSERT INTO projects (name, slug, description) 
VALUES ('Test Project', 'test-project', 'A sample project for testing');

-- Sample Repository
INSERT INTO repositories (project_id, url, default_branch)
VALUES (1, 'https://github.com/example/repo.git', 'main');

-- Sample Milestones
INSERT INTO milestones (project_id, name, slug, status)
VALUES 
    (1, 'Phase 1: Foundation', 'phase-1', 'active'),
    (1, 'Phase 2: Implementation', 'phase-2', 'active');

-- Sample Tasks
INSERT INTO tasks (project_id, milestone_id, title, status, priority_score, labels)
VALUES 
    (1, 1, 'Setup database schema', 'done', 1000, '["database","setup"]'),
    (1, 1, 'Create API endpoints', 'in_progress', 1000, '["api","backend"]'),
    (1, 2, 'Implement task workflows', 'open', 800, '["workflow","core"]');
*/

-- ============================================================================
-- SCHEMA VERIFICATION QUERIES
-- ============================================================================
-- Run these after schema creation to verify integrity

-- Verify all tables exist
SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;

-- Verify all indexes exist
SELECT name FROM sqlite_master WHERE type='index' ORDER BY name;

-- Verify all triggers exist
SELECT name FROM sqlite_master WHERE type='trigger' ORDER BY name;

-- Verify all views exist
SELECT name FROM sqlite_master WHERE type='view' ORDER BY name;

-- Test foreign key constraints are enabled
PRAGMA foreign_keys;

-- Check index usage for priority queue query (explain query plan)
-- EXPLAIN QUERY PLAN 
-- SELECT * FROM tasks 
-- WHERE project_id = 1 AND status IN ('open', 'in_progress', 'blocked', 'in_review')
-- ORDER BY priority_score DESC, created_at ASC
-- LIMIT 100;

-- ============================================================================
-- END OF SCHEMA
-- ============================================================================
