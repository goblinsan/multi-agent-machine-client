# How to Resume a Failed Workflow

## Bug Fix Applied

Fixed persona name from `qa-engineer` to `tester-qa` in:
- `src/workflows/definitions/legacy-compatible-task-flow.yaml` (line 115)

## Resuming the Workflow

When a workflow times out at a step (like the QA step), you have several options:

### Option 1: Restart the Entire Task (Simplest)

Re-trigger the task from the dashboard. The workflow will start from scratch but with all the changes already committed to the branch.

**Pros**: Clean restart, all steps execute
**Cons**: Redoes work (context, planning, implementation)

### Option 2: Manual QA Intervention (Fastest)

Since the implementation is already committed and pushed, you can:

1. **Find the workflow ID from the logs**:
   ```bash
   grep "workflowId.*34046006-e6af-4db3-a050-113dca3fd054" machine-client.log | tail -5
   ```

2. **Manually send a QA completion message to Redis**:
   ```bash
   # Get the correlation ID from logs
   grep "qa_request.*corrId" machine-client.log | tail -1
   
   # Send completion event to Redis (example)
   redis-cli XADD agent.events "*" \
     workflow_id "34046006-e6af-4db3-a050-113dca3fd054" \
     step "3-qa" \
     from_persona "tester-qa" \
     status "done" \
     corr_id "3f3e9a84-c18c-471d-a2ed-28bf78ff61f0" \
     result '{"status":"pass","summary":"Manual QA approval","details":"Implementation looks good"}'
   ```

**Pros**: Fast, preserves all workflow state
**Cons**: Requires manual intervention, bypasses actual QA

### Option 3: Resume from QA Step (Recommended for Production)

The workflow system doesn't have built-in resume capability yet, but you can:

1. **Verify the current state**:
   - Branch: `milestone/project-test-harness-setup`
   - Changes committed: ✅ Yes
   - Changes pushed: ✅ Yes
   - QA pending: ✅ Yes

2. **Trigger just the QA step** by creating a minimal workflow:
   ```yaml
   # Save as: qa-only-workflow.yaml
   name: "qa-only"
   steps:
     - name: qa_request
       type: PersonaRequestStep
       config:
         step: "3-qa"
         persona: "tester-qa"
         intent: "qa"
         payload:
           task: "${task}"
           repo: "${repo_remote}"
           branch: "milestone/project-test-harness-setup"
           project_id: "${projectId}"
   ```

3. **Or use the coordinator override script**:
   ```bash
   # Edit scripts/run_handleCoordinator_test_runner.ts
   # Set the workflow to start at qa_request step
   ```

### Option 4: Let It Naturally Retry (If Configured)

If your workflow has retry logic configured, it may automatically retry the QA step after the timeout.

Check for retry configuration in:
```yaml
failure_handling:
  retry:
    max_attempts: 3
    backoff: exponential
```

## Checking Workflow State

### View the workflow in Redis:
```bash
# Check if workflow is still waiting
redis-cli XREAD BLOCK 0 STREAMS workflow-requests > 0-0

# Check workflow events
redis-cli XREAD BLOCK 0 STREAMS workflow-events > 0-0 | grep "34046006-e6af-4db3-a050-113dca3fd054"
```

### Check logs for workflow status:
```bash
# Get workflow status
grep "workflowId.*34046006-e6af-4db3-a050-113dca3fd054" machine-client.log | tail -20

# Check what step it's stuck on
grep "Step.*failed\|timeout" machine-client.log | tail -10
```

## Current Workflow State (from your logs)

```json
{
  "workflowId": "34046006-e6af-4db3-a050-113dca3fd054",
  "projectId": "1808e304-fc52-49f6-9a42-71044b4cb4b5",
  "branch": "milestone/project-test-harness-setup",
  "repoRoot": "/Users/jamescoghlan/code/machine-client-log-summarizer",
  
  "completed_steps": [
    "checkout_branch",
    "context_request", 
    "planning_loop",
    "implementation_request",
    "apply_implementation_edits",  // ✅ Diffs applied!
    "commit_implementation",        // ✅ Committed!
    "verify_diff",                 // ✅ Verified!
    "ensure_branch_published"      // ✅ Pushed!
  ],
  
  "failed_step": "qa_request",
  "failure_reason": "timeout (persona tester-qa not responding)",
  
  "next_steps": [
    "qa_request",              // Needs retry with correct persona name
    "code_review_request",     // After QA passes
    "security_request",        // After QA passes
    "devops_request",          // After reviews
    "mark_task_done"           // Final step
  ]
}
```

## Recommendation

**For your current situation**:

1. ✅ **Fix is applied**: Persona name changed to `tester-qa`
2. ✅ **Changes are pushed**: Branch has all implementation changes
3. 🔄 **Restart the task**: Let it go through from the beginning

Since the branch already exists with changes, the workflow will:
- Skip context gathering (may be cached)
- Potentially skip planning if cached
- Skip implementation (branch already has changes)
- **Execute QA step** with correct persona name ✅
- Continue through code review, security, devops
- Mark task as done

The workflow engine should detect existing commits and skip redundant work.

## Alternative: Fresh Start

If you want a truly clean slate:

```bash
# Delete the feature branch
cd /Users/jamescoghlan/code/machine-client-log-summarizer
git checkout main
git branch -D milestone/project-test-harness-setup
git push origin --delete milestone/project-test-harness-setup

# Then restart the task from dashboard
```

This will run everything from scratch with the correct persona names.
