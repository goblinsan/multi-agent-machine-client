REFACTOR PLAN — 2025-10-21
=============================

Progress Update — 2025-10-22
----------------------------
- Migrated fully to the modern WorkflowEngine; legacy path removed.
- Cleaned/validated workflow YAMLs; fixed blocked-task steps and legacy-compatible workflow.
- Improved PersonaRequestStep transport lifecycle; aborts purge Redis queues safely with test-friendly guards.
- Dashboard client/mocks aligned with integration tests; stateful behavior with filters and bulk validation.
- All tests green locally (49 passed | 10 skipped); TypeScript build and no-emit typecheck pass.
- Dead code cleanup: Removed duplicate `src/workflows/engine/WorkflowEngine.ts` and unused `src/git/GitService.ts`.
- Legacy path elimination: Removed `src/process.ts` (+ `.bak`), `src/worker.ts`, local legacy tools, and redis helper utilities tied to the old path. `dev` now targets `run_coordinator.ts`.
- Quality gates added:
  - Scripts: `npm run typecheck`, `npm run lint`, `npm run lint:fix`.
  - Config: `.eslintrc.cjs`, `.eslintignore` (lightweight rules to avoid noise; can tighten later).
- Test log noise reduced:
  - Persona config warnings downgraded to debug in test runs (or when `QUIET_CONFIG_LOGS=1`).
  - Abort purge failures now guarded and logged at debug in tests.

Goal
----
Aggressively refactor the repository to remove hidden side-effects, centralize git lifecycle management, reduce god objects (notably `src/process.ts` and `src/workflows/WorkflowCoordinator.ts`), and make the codebase maintainable and testable for distributed multi-agent workflows.

Scope and priorities
--------------------
1. Centralize Git operations and lifecycle (High priority)
   - Consolidate branch creation/checkout/commit/push into a single `GitWorkflowManager`.
   - Remove hidden branch creation from `applyEditOps()` / `writeArtifacts()`.
   - Ensure the WorkflowEngine (coordinator) is the single owner of branch lifecycle.

2. Split `process.ts` responsibilities (High priority)
   - Extract `ContextScanner` (repo scanning + snapshot generation) into `src/git/contextScanner.ts`.
   - Extract `PersonaRequestHandler` to process LLM interactions.
   - Make `process.ts` an orchestration thin layer only.

3. Reduce duplication and unify git helpers (Medium priority)
   - Decide canonical layers:
     - `gitUtils.ts` — low-level exec wrappers and guarded utilities
     - `GitWorkflowManager` — workflow-focused git lifecycle
  - `GitService` — removed (no references); consider adding a thin adapter only if needed for external consumers

4. Tests and CI updates (High priority)
   - Add unit tests for `GitWorkflowManager` and `ContextScanner`.
   - Update existing tests to use the new manager instead of scattered git calls.
   - Maintain existing test guards that prevent accidental workspace mutation.

5. Gradual removal of god objects across workflows (Medium to Low)
   - Identify large step files and extract sub-steps and helpers (e.g., `BulkTaskCreationStep`, `TaskCreationStep`).

Timeline (suggested incremental plan)
-------------------------------------
- Day 0 (today):
  - Add `REFACTOR_PLAN_2025-10-21.md` to `./docs` (this file).
  - Create `GitWorkflowManager` (completed).
  - Integrate `GitWorkflowManager.ensureBranch()` into `WorkflowEngine` (completed).
  - Remove `checkout -B` from `applyEditOps()` and `branchName` from `writeArtifacts()` (completed).

- Day 1: ContextScanner extraction
  - Implement `src/git/contextScanner.ts` (pure function: scanRepo -> snapshot, ndjson, summary)
  - Update `process.ts` to call `ContextScanner` and then `writeArtifacts()` + `gitWorkflowManager.commitFiles()`.
  - Add unit tests for `ContextScanner`.

- Day 2: Commit handling refactor
  - Replace direct commit/push calls in `fileops.ts` and other places with `gitWorkflowManager.commitFiles()` or a thin wrapper.
  - Add tests for `commitFiles` (happy/error paths) with mocked `runGit`.

- Day 3: PersonaRequestHandler extraction
  - Move LLM prompt and response parsing into `src/personas/PersonaRequestHandler.ts`.
  - Wire `process.ts` to use that handler.
  - Add tests (parse and handle-edge-cases).

- Day 4–5: Migrate GitService or retire
  - Create thin adapter for backwards compatibility, update callers incrementally.
  - Remove duplicate implementations across the codebase.

- Week 2–3: Larger workflow step decomposition
  - Extract helpers for large step files, add unit tests, and incrementally reduce file sizes.

Rollout strategy and migration approach
--------------------------------------
- Use feature branches for each major change (context-scanner, persona-handler, commit-migration).
- Keep changes small and iterative; update and run tests after each change.
- Provide thin adapters to keep the rest of the code compiling while migrating.
- Be aggressive about removing dead code once tests pass.

Testing matrix and validation
-----------------------------
- Unit tests:
  - `GitWorkflowManager`: ensureBranch (exists/created), commitFiles (stages & pushes), getBranchState.
  - `ContextScanner`: returns snapshot structure for input repo.
  - `applyEditOps`: verify no `runGit` calls (mock runGit and assert no invocation).

- Integration/Workflow tests:
  - `WorkflowEngine`: ensure branch created and context passed correctly.
  - Workflow end-to-end test: coordinator creates branch, personas work on branch, no random feature branches.

- CI:
  - Run subset of tests for each PR, full test suite for merge to main.

Risks & Mitigations
-------------------
- Risk: Merge conflicts and broken tests as signatures change.
  - Mitigation: use thin adapters and do incremental changes.
- Risk: Race conditions when multiple workers act on same repo path.
  - Mitigation: ensure GitWorkflowManager is stateless and consider file-based locks or per-worker clones.
- Risk: Accidentally mutate developer workspace.
  - Mitigation: keep `guardWorkspaceMutation` checks and preserve `MC_ALLOW_WORKSPACE_GIT` behavior.

Files to audit / high-impact refactor list
-----------------------------------------
- `src/process.ts` — REMOVED in 2025-10-23 cleanup
- `src/workflows/WorkflowCoordinator.ts` (898 LOC) — split orchestration vs logic
- `src/workflows/steps/BulkTaskCreationStep.ts` (856 LOC) — split into helpers
- `src/workflows/WorkflowEngine.ts` (804 LOC) — ensure only high-level execution
- `src/git/GitService.ts` — REMOVED in 2025-10-23 cleanup
- `src/fileops.ts` & `src/artifacts.ts` — already partly refactored, finish commit separation

Follow-ups
----------
1. I can implement Day 1 now (create `src/git/contextScanner.ts` and wire `process.ts`).
2. After implementing, I will run the context-related tests and report results.

If you'd like, I'll start with Day 1 now and create the `ContextScanner` and tests. Otherwise tell me which task from the plan to begin with.
