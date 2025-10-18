# Context Agent Improvements

## Problem

The context agent had two issues in distributed multi-machine workflows:

1. **Context scan results not being committed/pushed**: When `APPLY_EDITS=false` (default), the context scan would complete but not commit or push results to the remote repository. This meant distributed agents on other machines couldn't see the updated context data.

2. **Unnecessary rescans**: The context agent would perform full repository scans even when no code changes had occurred since the last scan, wasting time and resources.

## Solutions Implemented

### 1. Force Commit for Context Scans

**File: `src/artifacts.ts`**

Added `forceCommit` parameter to `writeArtifacts()` function:

```typescript
export async function writeArtifacts(options: {
  repoRoot: string;
  artifacts: Artifacts;
  apply: boolean;
  branchName: string;
  commitMessage: string;
  forceCommit?: boolean; // Force commit even if apply is false (for context scans)
})
```

When `forceCommit: true`, the function commits and pushes context artifacts via `applyEditOps()` regardless of the `APPLY_EDITS` config setting.

**File: `src/process.ts`**

Updated context scan to always commit/push:

```typescript
const writeRes = await writeArtifacts({
  repoRoot,
  artifacts: { snapshot, filesNdjson: ndjson, summaryMd: scanMd },
  apply: cfg.applyEdits && cfg.allowedEditPersonas.includes("context"),
  branchName: `feat/context-${msg.workflow_id}-${(msg.corr_id||"c").slice(0,8)}`,
  commitMessage: `context: snapshot for ${msg.workflow_id}`,
  forceCommit: true // Always commit and push context scan results in distributed workflow
});
```

### 2. Skip Scan When No Code Changes

**File: `src/git/contextCommitCheck.ts`** (new)

Created two helper functions:

1. **`isLastCommitContextOnly(repoPath)`**: Checks if the most recent commit only contains `.ma/context/*` files
2. **`hasCommitsSinceLastContextScan(repoPath)`**: Checks if there are any commits after the last context scan

**File: `src/process.ts`**

Integrated check before scan:

```typescript
// Check if we need to rescan by checking if there are new code commits since last context scan
const { isLastCommitContextOnly, hasCommitsSinceLastContextScan } = await import("./git/contextCommitCheck.js");
const lastCommitIsContextOnly = await isLastCommitContextOnly(repoRoot);
const hasNewCommits = await hasCommitsSinceLastContextScan(repoRoot);

// Skip scan if the last commit was context-only AND we're at that commit (no new commits since)
if (lastCommitIsContextOnly && !hasNewCommits) {
  scanSummaryText = "No code changes since last context scan - using existing context data";
  logger.info("context scan skipped: no code changes since last scan", {
    repoRoot,
    branch: repoInfo.branch ?? null,
    workflowId: msg.workflow_id
  });
  
  // Return early - no need to call LLM or commit anything
  const skipMessage = "Context scan skipped: no code changes detected since last scan. The existing context data is still current.";
  logger.info("persona completed (early return)", { persona, workflowId: msg.workflow_id, reason: "no_code_changes" });
  
  await publishEvent(r, {
    workflowId: msg.workflow_id,
    taskId: msg.task_id,
    step: msg.step,
    fromPersona: persona,
    status: "done",
    result: { output: skipMessage, skipped: true, reason: "no_code_changes" },
    corrId: msg.corr_id
  });
  await acknowledgeRequest(r, persona, entryId, true);
  return;
}
```

## Workflow Flow

### When Scan is Needed (Code Changes Detected)

1. Context agent receives task
2. Checks commit history
3. Detects code changes since last scan
4. Performs full repository scan
5. Calls LLM to generate summary
6. **Commits and pushes** context artifacts (snapshot.json, summary.md) via `applyEditOps()`
7. Returns context summary

### When Scan is Skipped (No Code Changes)

1. Context agent receives task
2. Checks commit history
3. Detects no code changes since last scan (last commit was context-only)
4. **Returns early** with message: "Context scan skipped: no code changes detected since last scan"
5. No LLM call, no commit, no push

## Testing

**File: `tests/contextCommitCheck.test.ts`** (new)

Created comprehensive test suite with 11 tests covering:

- **Context-only commits**: Verify detection when only `.ma/context/*` files are in commit
- **Code commits**: Verify detection when code files are in commit
- **Mixed commits**: Verify detection when both context and code files are in commit
- **Empty commits**: Handle edge case of empty commits
- **Commit history checks**: Verify detection of commits since last context scan
- **Integration scenarios**: Test complete skip logic with various commit patterns

All tests pass successfully.

## Benefits

1. **Distributed Workflow Support**: Context scans are now always pushed to remote, ensuring distributed agents can access updated context data
2. **Performance**: Unnecessary scans are skipped when no code changes have occurred
3. **Resource Efficiency**: Reduces load on LLM API and git operations
4. **Clear Feedback**: Users get explicit message when scan is skipped
5. **Consistency**: Context artifacts are always committed regardless of `APPLY_EDITS` config

## Related Files

- `src/artifacts.ts` - Added `forceCommit` parameter to `writeArtifacts()`
- `src/process.ts` - Integrated skip logic and force commit for context scans
- `src/git/contextCommitCheck.ts` - New helper functions for commit checking
- `tests/contextCommitCheck.test.ts` - Comprehensive test suite
- `src/fileops.ts` - `applyEditOps()` handles commit and push (from previous fix)

## Configuration

No new configuration required. The improvements work with existing settings:

- `APPLY_EDITS=false` (default) - Context scans still commit/push due to `forceCommit: true`
- `APPLY_EDITS=true` - Behavior unchanged, context scans commit/push as before

## Example Log Output

### Scan Skipped
```
[info] context scan skipped: no code changes since last scan { repoRoot: '/projects/my-app', branch: 'main', workflowId: 'wf-123' }
[info] persona completed (early return) { persona: 'context', workflowId: 'wf-123', reason: 'no_code_changes' }
```

### Scan Performed
```
[info] context scan starting { repoRoot: '/projects/my-app', branch: 'main', reason: 'last_commit_had_code_changes' }
[info] context scan completed { repoRoot: '/projects/my-app', totals: { files: 245, bytes: 1024000 } }
[info] context artifacts push result { workflowId: 'wf-123', result: { committed: true, pushed: true } }
```
