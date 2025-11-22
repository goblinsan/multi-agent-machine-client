# Blocked Task Dependency Reconciliation Plan

## Summary

When a code review failure spawns PM follow-up tasks, the current blocked-task
workflow proceeds as though no follow-ups exist. This wastes unblock attempts
and resets the task state prematurely. The goal is to tie the unblock flow to
completion of the follow-up tasks before retrying automation.

## Implementation Steps

- [x] Introduce dependency metadata: update the blocked-task workflow to read
      and write a `blocked_dependencies` array sourced from PM follow-up task IDs.
- [x] Add a `DependencyStatusStep` to load each dependency via `TaskAPI.fetchTask`
      and expose an `allResolved` flag plus task details.
- [x] Gate unblock attempts: insert a pre-check conditional that pauses the
      unblock workflow when dependencies remain open and emit a status update.
- [x] Ensure follow-up task creation adds dependency links back to the blocked
      task so DependencyStatusStep sees newly created IDs immediately.
- [x] Persist `blocked_dependencies` directly on dashboard tasks and surface the
      field through the API so workflows/tests can validate the linkage end-to-end.
- [x] Clear dependencies after success by emptying the metadata once the task is
      marked `open`, ensuring future iterations treat it as unblocked.
- [x] Add rich logging so dependency counts/IDs are visible when debugging runs.

## Test Coverage

- [x] Extend `tests/blockedTaskResolution.test.ts` with scenarios covering both
      pending and resolved dependencies.
- [x] Create `tests/steps/dependencyStatusStep.test.ts` to exercise the new step's
      API interactions and aggregation logic.
- [x] Update dashboard mocks to allow configuring dependency statuses in tests.
- [x] Add structure tests for `review-failure-handling` and
      `blocked-task-resolution` workflows to guarantee the dependency filter and
      clearing steps stay wired into the YAML definitions.

## Notes

- Consider batching dashboard fetches if the API supports it to reduce latency.
- Ensure the plan is kept up to date as tasks are completed.
- Use `scripts/backfill-blocked-dependencies.ts` to repair any legacy blocked
      tasks that were missing dependency metadata before this change shipped.
