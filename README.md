# Redis Machine Client (TypeScript)

Per-machine worker that:
1) Listens on Redis Streams for its **allowed personas**.
2) Pulls project context from your dashboard.
3) Calls the **local LM Studio** model (single-loaded identifier).
4) Emits a result event to Redis and (optionally) updates the dashboard.
5) (Optional) **Applies file edits** safely and commits to a branch.
6) (Optional) **Context scanner** writes `.ma/context` artifacts before the model call when persona===context.
7) **Multi-component scanning**: set SCAN_COMPONENTS or pass payload.components.
8) **Alembic aware**: if an `alembic/` tree exists, summary includes latest version files.

See `.env.example` for config.

## Repo workspace semantics

- PROJECT_BASE is a parent directory where local repositories are managed.
- DEFAULT_REPO_NAME defines the default folder name used when no repository is specified in the payload (effective default path: PROJECT_BASE/DEFAULT_REPO_NAME).
- REPO_ROOT is deprecated and ignored. If set, it will be logged as deprecated and not used.
- For multi-repo workflows, the coordinator resolves the target repository dynamically from the payload (repo_root when it points to an actual git repo, or by cloning from the dashboard’s repository URL using a project name/slug hint).
