PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    slug TEXT NOT NULL UNIQUE,
    description TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    CHECK (length(name) > 0),
    CHECK (length(slug) > 0),
    CHECK (slug = lower(slug)),
    CHECK (slug NOT LIKE '% %')
);

CREATE TABLE IF NOT EXISTS repositories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    url TEXT NOT NULL,
    default_branch TEXT NOT NULL DEFAULT 'main',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
    CHECK (length(url) > 0),
    CHECK (length(default_branch) > 0),
    UNIQUE (project_id, url)
);

CREATE TABLE IF NOT EXISTS milestones (
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

CREATE TABLE IF NOT EXISTS tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER NOT NULL,
    milestone_id INTEGER,
    parent_task_id INTEGER,
    title TEXT NOT NULL,
    description TEXT,
    status TEXT NOT NULL DEFAULT 'open',
    priority_score INTEGER NOT NULL DEFAULT 0,
    external_id TEXT UNIQUE,
    milestone_slug TEXT,
    labels TEXT,
    blocked_attempt_count INTEGER NOT NULL DEFAULT 0,
    last_unblock_attempt TEXT,
    review_status_qa TEXT,
    review_status_code TEXT,
    review_status_security TEXT,
    review_status_devops TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    completed_at TEXT,
    blocked_dependencies TEXT,
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

CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    version TEXT NOT NULL UNIQUE,
    description TEXT,
    applied_at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_tasks_project_status ON tasks(project_id, status);
CREATE INDEX IF NOT EXISTS idx_tasks_priority_queue ON tasks(
    project_id, status, priority_score DESC, created_at ASC
) WHERE status IN ('open', 'in_progress', 'blocked', 'in_review');
CREATE INDEX IF NOT EXISTS idx_tasks_milestone_active ON tasks(
    project_id, milestone_id, status
) WHERE status NOT IN ('done', 'archived');
CREATE INDEX IF NOT EXISTS idx_tasks_parent ON tasks(parent_task_id)
    WHERE parent_task_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_external_id ON tasks(
    project_id, external_id
) WHERE external_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_tasks_created ON tasks(created_at);
CREATE INDEX IF NOT EXISTS idx_tasks_title_milestone ON tasks(
    project_id, milestone_id, title COLLATE NOCASE
) WHERE status NOT IN ('done', 'archived');
CREATE INDEX IF NOT EXISTS idx_milestones_project ON milestones(project_id);
CREATE INDEX IF NOT EXISTS idx_milestones_project_status ON milestones(project_id, status);
CREATE INDEX IF NOT EXISTS idx_repositories_project ON repositories(project_id);

CREATE TRIGGER IF NOT EXISTS trg_projects_updated_at
AFTER UPDATE ON projects
FOR EACH ROW
BEGIN
    UPDATE projects SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_repositories_updated_at
AFTER UPDATE ON repositories
FOR EACH ROW
BEGIN
    UPDATE repositories SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_milestones_updated_at
AFTER UPDATE ON milestones
FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at
BEGIN
    UPDATE milestones SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_updated_at
AFTER UPDATE ON tasks
FOR EACH ROW
WHEN OLD.updated_at = NEW.updated_at
BEGIN
    UPDATE tasks SET updated_at = datetime('now') WHERE id = OLD.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_completed_at
AFTER UPDATE OF status ON tasks
FOR EACH ROW
WHEN NEW.status = 'done' AND OLD.status != 'done'
BEGIN
    UPDATE tasks SET completed_at = datetime('now') WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_uncompleted_at
AFTER UPDATE OF status ON tasks
FOR EACH ROW
WHEN NEW.status != 'done' AND OLD.status = 'done'
BEGIN
    UPDATE tasks SET completed_at = NULL WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_milestone_slug_insert
AFTER INSERT ON tasks
FOR EACH ROW
WHEN NEW.milestone_id IS NOT NULL
BEGIN
    UPDATE tasks
    SET milestone_slug = (SELECT slug FROM milestones WHERE id = NEW.milestone_id)
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_tasks_milestone_slug_update
AFTER UPDATE OF milestone_id ON tasks
FOR EACH ROW
WHEN NEW.milestone_id IS NOT NULL
BEGIN
    UPDATE tasks
    SET milestone_slug = (SELECT slug FROM milestones WHERE id = NEW.milestone_id)
    WHERE id = NEW.id;
END;

CREATE TRIGGER IF NOT EXISTS trg_milestone_task_insert
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

CREATE TRIGGER IF NOT EXISTS trg_milestone_task_delete
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

CREATE TRIGGER IF NOT EXISTS trg_milestone_task_move
AFTER UPDATE OF milestone_id ON tasks
FOR EACH ROW
WHEN OLD.milestone_id IS NOT NULL OR NEW.milestone_id IS NOT NULL
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

CREATE TRIGGER IF NOT EXISTS trg_milestone_task_status_update
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

CREATE VIEW IF NOT EXISTS tasks_with_milestone_name AS
SELECT
    t.*,
    m.name AS milestone_name
FROM tasks t
LEFT JOIN milestones m ON t.milestone_id = m.id;
