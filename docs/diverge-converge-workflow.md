# Diverge–Converge Workflow (design)

Status: proposal. Motivated by measured behaviour, not speculation.

## Decisions (2026-07-17)

1. **Escalation is a seam, not an implementation.** On exhausted convergence
   retries, raise a typed `EscalationRequiredError` and block the change; do not
   call a frontier model yet. The single catch site is where that automation
   plugs in later.
2. **Contracts come from the `plan-for-14b` hand-off**, authored by a premium
   planner (Claude/Codex). The orchestrator does not self-plan a change from the
   14B — the interface derivation is precisely what the 14B cannot do, and this
   dependency is accepted. This is why the skill and `AGENTS.md` pointers exist.
3. **Convergence reuses `QAStep` + `DeterministicReviewStep`** on the change
   branch rather than a new step type.

## The problem this solves

The local 14B builds **one self-contained file** well but cannot derive a
cross-file module graph or reconcile structure across files (see
`docs/` capability notes and the plan evaluator's `designDerivationRequired` /
integration signals). The obvious workaround — cram a multi-file feature into
one file — is **self-defeating**, and we have proof:

> The OpenAPI probe (project 5, task 59) asked the 14B to build the whole
> OpenAPI layer as one `src/routes/openapi.ts`. It succeeded at the *content*
> (a correct 220-line OpenAPI document, `/openapi.json` + `/docs`) but the
> deterministic QA rejected it: `registerOpenApiRoutes has 218 lines, exceeding
> the configured limit of 120 (HIGH)`, plus a coverage-ratchet miss. It never
> merged.

So the model's limitation and our own quality gates (`method_size`,
`test_coverage`) point the same way: **we need well-composed multi-file changes,
built by a model that can only do single files.** That is what this workflow
delivers.

## Principle: contract-first

Split the work by *who is good at what*:

- **Planner (strong model — Claude/Codex via the `plan-for-14b` hand-off):** does
  the **derivation**. Decomposes the change into single-responsibility files and
  writes the **interface contract** between them — each file's exports, and the
  *verbatim* import line every sibling uses. This is precisely the cross-file
  reasoning the 14B lacks.
- **Executor (14B):** does the **execution**. Builds each file in isolation
  against its contract — its proven strength.
- **Deterministic tooling:** does the **integration validation**. `tsc` + tests
  on the assembled change verify the files compose. Cross-file *derivation*
  becomes cross-file *validation*.

## Git topology

```
main
 └── change/<slug>                 change branch, off main — the converge target
      ├── change/<slug>__file-a    sub-branch, off change branch — exactly one file
      ├── change/<slug>__file-b
      └── change/<slug>__file-c
```

Note the `__` separator, not a `/`. A git ref cannot be both a file and a
directory, so `change/<slug>` (a branch) and `change/<slug>/file-a` (a branch)
collide in `refs/heads`. `change/<slug>__file-a` keeps the file branch a sibling
of the change branch under `change/`, which git accepts. See
`src/git/branchNaming.ts`.

- Each file-task branches **off the change branch** (not main), edits **one
  file**, and merges **back into the change branch** (not main).
- File-tasks run in **dependency order** (a file that imports a sibling depends
  on it), which the existing dependency queue already provides via
  `blocked_dependencies`. Because a file's dependencies are built and merged
  into the change branch *before* it, its sub-branch (off the current change
  branch) already contains them — so its imports resolve and **per-file `tsc`
  works**. The 14B still does not *derive* the order; the planner encodes it in
  the contracts (who imports whom), and the queue enforces it.
- The build is still **contract-guided**: each file is written against the
  verbatim import lines the planner supplied, not by reverse-engineering sibling
  code. Disjoint files ⇒ no merge conflicts.
- The change branch merges to **main exactly once**, after convergence passes.

This differs from today's model, where all tasks in a milestone share one branch
and each merges to main individually.

## Phases

1. **Diverge (plan).** The planner produces `{ goal, files: [{ path,
   responsibility, contract }] }`. Each file-task's description embeds the
   verbatim import contracts for its siblings. Pre-flight every file-task through
   `POST /plans/evaluate` — each must come back `fits` (single file + explicit
   contracts). Create `change/<slug>` off main; create the file-tasks linked to
   the change.

2. **Build (dependency-ordered).** For each file-task, in dependency order:
   branch off the change branch (which already holds this file's dependencies),
   build the one file against its contract, run typecheck (its imports resolve
   because the deps are present) plus the file-local deterministic rules
   (`file_size`, `method_size`, `secret_scan`, `conflict_markers`,
   `forbidden_comments`), then merge back into the change branch. Skipped
   per-file: **tests and the `test_coverage` ratchet** (a source file's test is
   its own file-task, and whole-change behaviour is a convergence concern), and
   the model **code/security/devops reviews** (run once at convergence, not per
   file). A genuinely circular import pair is the one shape per-file typecheck
   cannot resolve; convergence is the backstop for it.

3. **Converge (validate the whole).** Once every file-task has merged into the
   change branch, all files exist together. Run the **full** gate suite on the
   change branch: `tsc` (cross-file integration now checked deterministically),
   tests, `test_coverage` ratchet, mutation, `method_size` across the set. This
   is the real gate — the point where composition is verified.

4. **Merge.** Convergence green ⇒ `syncBranchWithBase` against current main ⇒
   `merge_preflight_validation` ⇒ merge `change/<slug>` → main (→ deploy).

## Failure localization

A convergence `tsc` error names a file and a symbol (`Module '"./a"' has no
exported member 'X'`). Map it to the file-task whose **contract** was wrong
(file-b imported `X`; file-a exported `Y`). Re-run **only that sub-branch** with
a corrected contract — the planner adjusts the contract from the error — then
re-merge and re-converge. Failure localizes to one file + one contract instead
of re-running the whole change.

Bound the re-run count (`change.convergence_attempts`, small — e.g. 2). When it
is exhausted the convergence sub-workflow does **not** try to be clever and does
**not** call out to a stronger model yet. It **raises a typed exception —
`EscalationRequiredError`** — and stops.

This is a deliberate **seam**, not an implementation. The exception carries the
structured context a future expert-review automation will need:

```ts
class EscalationRequiredError extends Error {
  readonly changeSlug: string;
  readonly failingFiles: { path: string; contract: string }[];
  readonly convergenceErrors: string[];   // the tsc/test output history
  readonly attempts: number;
}
```

The workflow catches it, marks the change `blocked` with reason
`escalation_required`, and persists the context as an artifact. That is all it
does today — a human picks it up. Later, a single documented handler at the
catch site is where the **frontier-model escape hatch** plugs in: it consumes
the escalation context, proposes corrected contracts, and re-drives the change.
Building the seam now (one throw site, one catch site, one typed payload) means
adding the automation later is a local change, not a reshaping. No frontier call,
no token cost, until we choose to wire it.

## Gate placement

| Level | Gates | Why |
|---|---|---|
| Per file (sub-branch) | file_size, method_size, secret_scan, conflict_markers, forbidden_comments | File-local; no siblings needed |
| Converge (change branch) | tsc, tests, test_coverage, mutation, method_size | All files present; the real integration check |
| Pre-main | syncBranchWithBase + merge_preflight_validation | Guard against main advancing (built this session) |

`method_size` at both levels is what makes the single-file compromise
impossible: each file must carry a focused, under-limit function, so proper
composition is the *only* way to pass — the gate and the architecture agree.

## Tests are first-class files

The `test_coverage` ratchet requires a test per new source file. So a "change"
includes **test files as their own file-tasks**. A test file-task's contract is
"`import { X } from '../src/a'`; assert behaviour B". This is why the manifest
probe was a natural route+test pair — the ratchet makes tests part of the
composition, not an afterthought.

## Engine mapping (reuse, don't rebuild)

The primitives already exist:

- `computeFeatureBranchName` already derives a shared branch from the
  milestone/change slug. `src/git/branchNaming.ts` now emits `change/<slug>`
  (`changeBranchName`) and the sibling per-file `change/<slug>__<file>`
  (`fileBranchName`), sanitizing paths into git-safe segments. **Implemented.**
- `checkoutBranchFromBase` with `baseBranch = change/<slug>` gives file-tasks
  their sub-branch off the change branch.
- `mergeBranchToMain` is already parameterized on `targetBranch` — merging a
  sub-branch into the change branch is the same op with `targetBranch =
  change/<slug>`.
- `syncBranchWithBase` + `merge_preflight_validation` (this session) handle the
  final change→main step.
- The dependency queue (`selectNextDependencyTask`, `blocked_dependencies`)
  already orders tasks; file-tasks are independent so they need no ordering,
  and the **convergence task depends on all file-tasks** (blocked until they are
  done) — expressible with the existing dependency mechanism.

New pieces:

- A `change-flow.yaml` (coordinator sub-workflow) that: creates the change
  branch, lets the per-file `task-flow` runs target the change branch instead of
  main, then runs a **convergence step** (full gates on the change branch) and
  the merge-to-main.
- A per-file variant of `task-flow.yaml` whose `checkout_branch` base is the
  change branch and whose final merge target is the change branch (not main) —
  i.e. drop `merge_branch_to_main`'s `targetBranch` from `main` to
  `change/<slug>`, and move the main-merge into the convergence step.
- **Convergence reuses the hardened gates**, no new `ConvergenceStep`: point
  `QAStep` (typecheck + tests, delta-based) and the `DeterministicReviewStep`
  (`method_size`, `test_coverage`, `secret_scan`, …) at the whole change branch,
  then `syncBranchWithBase` + `merge_preflight_validation` + merge to main. Less
  code, and it inherits every fix made to those steps this session. The only new
  logic is the retry-bound + the `EscalationRequiredError` throw described under
  *Failure localization*.

## What it buys

- Real composition — no architecture bent to fit the model.
- Every model task stays single-file (capability-fit).
- Cross-file derivation → deterministic cross-file validation.
- Failures localize to a file + contract.
- The quality gates are *satisfied by* good composition instead of *fought*.

## Risks / open questions

- **Contract quality is load-bearing.** The whole scheme rests on the planner
  writing correct interface contracts up front. That derivation must come from a
  strong planner (the `plan-for-14b` hand-off), not the 14B.
- **Interface-only independence.** Sub-branches are order-free *only* if each
  file builds against its sibling's interface, not its implementation. A file
  that needs a sibling's actual behaviour (not just its signature) breaks the
  independence — the discipline is interface-first design.
- **Convergence retry loops.** A subtly wrong contract can fail convergence
  repeatedly; needs a bounded retry and the escape-hatch escalation.
- **Planner-side cost.** More planning work per change (the contracts). That is
  the point — move the hard reasoning to where the capability is.
