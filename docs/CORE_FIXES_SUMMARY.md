# Core Fixes: From Dead End to Working Pipeline

A retrospective on the critical fixes that turned a non-functional multi-agent system into one that can autonomously complete tasks against a target repo using a local 9B-parameter LLM.

**Runs**: 1–38 | **Target**: `machine-client-log-summarizer` | **Model**: qwen3.5-9b via LM Studio

---

## The Starting Point

Early runs couldn't complete a single task. The LLM would generate code, but the output never survived the pipeline — diffs wouldn't apply, reviews would false-positive into infinite loops, tasks would re-queue endlessly, and the coordinator would abort before anything meaningful landed. The system had a working architecture on paper, but dozens of failure modes in practice.

By Run 38: **6 tasks completed in a single run**, code merged to main, reviews handled, cascade tasks created and resolved.

---

## 1. Diff Application Was Destroying Files

**The problem**: The lead-engineer LLM produces unified diffs, and `applyHunksToLines()` was silently generating corrupted output — trailing duplicate JSON blocks, unbalanced braces, appended garbage. Every file it touched was potentially destroyed. In Run 37, `package.json`, `config.test.ts`, and `smoke.test.ts` all ended up with duplicate content blocks that broke the entire target repo.

**The fix** (`applyEditOps.ts`): Post-apply validation that catches structural corruption before it hits disk.

- After hunks are applied, `validateStructuredContent()` checks the result (JSON parse for `.json`, brace/bracket balance for `.ts`/`.js`)
- If invalid, attempts recovery via `buildNewFileFromHunks()` — reconstructs the file from hunk target lines only
- If recovery also fails, preserves the original base file instead of writing garbage

**Impact**: In Run 38 alone, this fix triggered **11 times** — 3 successful recoveries by rebuild, 8 base file preservations. Without it, every task's output would have been corrupted.

*Commit: `bc5e6c7` — Fix diff append corruption and coordinator task re-processing*

---

## 2. Fuzzy Hunk Matching for Imprecise LLM Diffs

**The problem**: A small LLM doesn't produce exact context lines in its diffs. Hunks would fail to apply because the context was off by whitespace, a changed variable name, or shifted line numbers. The entire implementation would fail even when the actual code changes were correct.

**The fix** (`hunkHelpers.ts`): A sliding-window fuzzy matcher that finds the best match location for a hunk even when context lines don't match exactly. Uses a scoring system that tolerates minor discrepancies while still requiring structural alignment.

**Impact**: Went from most hunks failing to apply, to most hunks finding their target location. This was a prerequisite for any implementation task completing.

*Commit: `32df95f` — Raise circuit breaker thresholds, add fuzzy hunk matching with sliding window*

---

## 3. Breaking the False-Positive Review Cascade

**The problem**: Code review and security review personas would "fail" tasks for non-issues — flagging `package-lock.json` for being over 500 lines, fabricating CVE numbers, citing SRP violations as "severe." Each review failure spawned follow-up tasks, which spawned more reviews, creating an exponential cascade that consumed the entire run budget on phantom issues.

**The fix**: A multi-layered approach across several commits:

- **Abort override system**: Review failures are normalized by severity. Non-blocking findings (no `severe` issues) get auto-overridden so the workflow continues rather than aborting
- **Follow-up depth limit**: Cascade tasks can only go one level deep, preventing infinite review→follow-up→review loops
- **Lock file exclusion**: Generated files like `package-lock.json` are excluded from review diff scanning entirely
- **Review output validation**: Persona responses are validated for structural correctness before being treated as authoritative

**Impact**: Runs 32-34 were entirely consumed by review cascades. After these fixes, reviews still run but no longer derail the pipeline.

*Key commits: `5d6ff77`, `fbbbddb`, `af1c40b`, `9a46cd2`*

---

## 4. Plan Text Wasn't Reaching the Engineer

**The problem**: The planning loop would produce a solid implementation plan, save it as a git artifact, and then... the lead-engineer never saw it. The plan reference was passed as a file path, but the LLM had no way to read files. It would either hallucinate what the plan said or send `info_request` loops trying to retrieve it, burning through attempt budgets.

**The fix** (`ImplementationLoopStep.ts` + `step-templates.yaml` + prompt): `loadPlanArtifactText()` reads the plan artifact from git and injects the full text directly into the lead-engineer's prompt via a `{{#if plan_text}}` block. No more file path references — the plan content is inline in the LLM context.

**Impact**: Task 4 went from never completing (Runs 32-36) to completing on the first implementation attempt (Run 37).

*Commit: `bd73f66` — Bump snippet size limit and inject plan text into implementation prompt*

---

## 5. Snippet Truncation Was Starving the Engineer of Context

**The problem**: The implementation prompt includes file snippets from the target repo so the engineer can write accurate diffs. `MAX_SNIPPET_BYTES` was set to 8KB, which silently truncated larger files. The LLM would write diffs against incomplete file content, producing hunks that couldn't match the real file.

**The fix**: `MAX_SNIPPET_BYTES` bumped from 8192 to 16384.

**Impact**: Run 36 loaded 2 out of 4 plan-required files. Run 37 loaded 6 out of 6. The engineer could finally see what it was modifying.

*Commit: `bd73f66` — Bump snippet size limit and inject plan text into implementation prompt*

---

## 6. Tasks Were Running Multiple Times

**The problem**: The coordinator loops through pending tasks, executes a workflow for each, then fetches the list again. But `exhaustedTaskIds.add(taskId)` was only called when the task's post-workflow status hadn't changed. Successfully completed tasks (status changed `open` → `done`) were *not* added to the exhausted set, so they'd be re-selected and re-processed on the next iteration. In Run 37, Tasks 158, 160, and 161 each ran twice. The second run of Task 161 hit a corrupted file (from bug #1), exhausted its retry budget, and triggered `failFast` — aborting the entire run.

**The fix** (`WorkflowCoordinator.ts`): Move `exhaustedTaskIds.add(taskId)` to fire immediately on workflow success, before the status-check logic.

**Impact**: Run 38 shows a clean, growing exhausted set: `[4] → [4,163] → [4,163,165] → ...` with zero re-processed tasks.

*Commit: `bc5e6c7` — Fix diff append corruption and coordinator task re-processing*

---

## 7. Task Descriptions Were Silently Null

**The problem**: The LLM was receiving tasks with no description. The dashboard API nests the description inside `task.data.description`, but the workflow was reading `task.description` (which was `undefined`). The planner and engineer were flying blind — planning and implementing based on just a task title.

**The fix**: Extract description from `task.data.description` with proper fallback chain. Also removed a dangerous `extractTasks` fallback that would silently invent task data when the real data was missing.

**Impact**: Every task from this point forward had its full description available to all personas. Plans became specific and implementation became targeted.

*Commits: `7750711`, `bd83123`*

---

## 8. Smart Merge Conflict Resolution

**The problem**: Each task works on a milestone branch and merges back to main. When tasks complete in sequence, merge conflicts arise on `.ma/` artifact files and context snapshots. The system would abort on any merge conflict, even when the conflicts were trivially resolvable (JSON files that could be deep-merged, context files that should just take the source branch version).

**The fix** (`gitUtils.ts`): Auto-resolve merge conflicts for `.ma/` artifact paths by accepting the source branch version. For JSON files, attempt a deep-merge. Includes corruption detection to fall back safely if auto-resolution produces invalid content.

**Impact**: Tasks can now complete and merge back to main without manual intervention, enabling the coordinator to process multiple tasks in sequence.

*Commit: `86d058f` — Smart merge conflict resolution: JSON deep-merge and corruption detection*

---

## 9. LM Studio Circuit Breaker

**The problem**: LM Studio would occasionally hang or respond with garbage after extended sessions. The system would wait for the full timeout (up to 12 minutes for lead-engineer), get nothing useful, retry, wait again — burning 30+ minutes on a dead model instance.

**The fix**: A windowed circuit breaker that tracks consecutive failures per persona. After a threshold of failures within a time window, the circuit opens and requests fail fast rather than waiting for timeouts. The breaker resets after a cooldown period.

**Impact**: Failed model interactions are detected in seconds rather than minutes, preserving the run budget for tasks that can actually succeed.

*Commits: `af1c40b`, `0ba0ac4`, `32df95f`*

---

## Where It Stands

Run 38 completed **6 tasks** against the target repo — implementing a LogEvent normalizer, JSON preview parser, path extractor, hash/deduplication module, a settings panel, and an analysis task — all autonomously, with code reviewed, committed, and merged to main.

The remaining bottleneck is the LLM itself. The 9B model consistently produces structurally invalid diffs (the validation fix catches them), takes 45+ minutes on complex tasks, and hallucinates CVEs during security review. But the pipeline around it is now robust enough to absorb those failures and still make forward progress.

377 commits. 38 runs. One task at a time.
