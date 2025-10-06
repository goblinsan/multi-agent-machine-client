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

- PROJECT_BASE is a parent directory where local repositories are managed. It is not itself a git repo.
- There is no placeholder repo under PROJECT_BASE (no implicit `active`). Repositories are always resolved from the dashboard (or payload override) and cloned/ensured under PROJECT_BASE.
- REPO_ROOT and DEFAULT_REPO_NAME are deprecated and ignored. If set, they will be logged as deprecated and not used.
- For multi-repo workflows, the coordinator resolves the target repository dynamically from the payload (repo_root when it points to an actual git repo, or by cloning from the dashboard’s repository URL using a project name/slug hint).

## Development

### Testing

- Tests run with a guard that prevents git commands from running outside OS temp directories when an explicit `cwd` is provided. This protects your working repo (e.g., the branch won’t be changed by tests).
- Use a temp directory for any test that shells out to git. The helper `tests/makeTempRepo.ts` can be used to create a barebones repo for integration-ish tests.
- The test setup also sets `PROJECT_BASE` to a unique temp dir so any repo resolution during tests happens under a sandbox.

Example usage in a test:

```ts
import { makeTempRepo } from './makeTempRepo';

it('does git things safely', async () => {
	const repo = await makeTempRepo();
	// shell out with { cwd: repo } or pass repoRoot: repo to functions under test
});
```
