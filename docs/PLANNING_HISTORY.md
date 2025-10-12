# Planning History Integration

## Overview

The `implementation-planner` persona now reads and considers previous planning iterations before creating a new plan. This enables iterative refinement based on accumulated knowledge from context scans, QA test results, and previous planning attempts.

## Implementation

### File Modified
`src/process.ts`

### What Changed

#### 1. Planning History Loading
Before the planner creates a plan, it now:
1. Pulls latest changes from git (`git pull --ff-only`)
2. Checks for existing `.ma/planning/task-{taskId}-plan.log`
3. Reads all previous planning iterations (including those from other machines)
4. Extracts iteration count and latest plan details

#### 2. Context Integration
The planner receives three key inputs:
```typescript
messages = [
  { role: "system", content: systemPrompt },
  { role: "system", content: "File scan summary: ..." },           // Latest context
  { role: "system", content: "Latest QA Test Results: ..." },      // QA outcomes
  { role: "system", content: "Previous Planning Iterations: ..." }, // Plan history
  { role: "user", content: userPrompt }
]
```

#### 3. Intelligent Instructions
The planner is instructed to:
- Review previous planning attempts
- Consider what may have changed (new context, QA results, etc.)
- Choose one of three approaches:
  1. **Reuse** - Use existing plan if still valid and complete
  2. **Refine** - Improve plan based on new information
  3. **Replace** - Create new plan if requirements changed significantly
- Be explicit about which approach was chosen

## Benefits

### 1. Continuity Across Iterations
- Plans build on previous work rather than starting from scratch
- Planner learns from past mistakes and QA feedback
- Reduces redundant planning work

### 2. QA-Driven Refinement
When QA tests fail, the planner on retry:
- Sees the previous plan
- Sees the QA failure details
- Can adjust the plan to address specific failures

### 3. Context-Aware Evolution
When context changes (new files, updated code):
- Planner compares previous plan with new context
- Identifies what changed
- Updates plan accordingly

### 4. Transparent Decision Making
The planner explicitly states whether it's:
- Keeping the previous plan unchanged
- Making specific refinements
- Creating an entirely new plan

## Example Workflow

### First Planning Iteration
```
Input:
  - Context: Project has src/auth.ts with basic login
  - Previous Plans: None
  - QA Results: None

Planner Output:
  "Creating initial plan:
   1. Add password hashing to auth.ts
   2. Add rate limiting
   3. Add session management"
```

### Second Iteration (After QA Failure)
```
Input:
  - Context: Same (no code changes yet)
  - Previous Plans: Iteration 1 (see above)
  - QA Results: "Password hashing test failed - bcrypt not installed"

Planner Output:
  "Refining previous plan based on QA feedback:
   0. Install bcrypt dependency (NEW - addressing QA failure)
   1. Add password hashing to auth.ts (using bcrypt)
   2. Add rate limiting
   3. Add session management"
```

### Third Iteration (After Context Update)
```
Input:
  - Context: NEW - Found package.json, bcrypt already listed
  - Previous Plans: Iterations 1 & 2
  - QA Results: Previous failure noted

Planner Output:
  "Refining plan - bcrypt dependency already exists:
   1. Add password hashing to auth.ts (bcrypt is available)
   2. Add rate limiting
   3. Add session management
   Note: Removed step 0 - dependency already present"
```

## Log Output

When pulling latest planning logs:
```
[debug] Pulled latest planning logs before reading {
  persona: 'implementation-planner',
  workflowId: 'wf-456',
  repoRoot: '/path/to/repo'
}
```

When planning history is loaded:
```
[info] Loaded planning history for persona {
  persona: 'implementation-planner',
  taskId: 'task-123',
  iterations: 2,
  planLogPath: '.ma/planning/task-123-plan.log',
  workflowId: 'wf-456'
}
```

When planning log is written and committed:
```
[info] Planning results written to log {
  taskId: 'task-123',
  planLogPath: '.ma/planning/task-123-plan.log',
  iteration: '2',
  workflowId: 'wf-456'
}

[info] Planning log committed and pushed {
  taskId: 'task-123',
  planLogPath: '.ma/planning/task-123-plan.log',
  iteration: '2',
  commitResult: { committed: true, pushed: true },
  workflowId: 'wf-456'
}
```

When no history exists (first run):
```
[debug] Planning log not found (first planning iteration) {
  persona: 'implementation-planner',
  taskId: 'task-123',
  planLogPath: '.ma/planning/task-123-plan.log'
}
```

When git pull fails:
```
[debug] Git pull failed before reading planning log, using local {
  persona: 'implementation-planner',
  workflowId: 'wf-456',
  error: 'Already up to date'
}
```

## Code Snippet

### Planning History Prompt
```typescript
if (planningHistory && planningHistory.length > 0) {
  messages.push({
    role: 'system',
    content: `Previous Planning Iterations:\n${clipText(planningHistory, 3000)}\n\n` +
             `You have created plans before for this task. Review the previous planning ` +
             `attempts above, consider what may have changed (new context, QA results, etc.), ` +
             `and either:\n` +
             `1. Use the existing plan if it's still valid and complete\n` +
             `2. Refine and improve the plan based on new information\n` +
             `3. Create a new plan if requirements have changed significantly\n\n` +
             `Be clear about whether you're reusing, refining, or replacing the previous plan.`
  });
}
```

### History Format
For multiple iterations:
```
Previous planning iterations: 3
Latest iteration:
[Full text of iteration 3]
```

For single iteration:
```
[Full text of iteration 1]
```

## Configuration

No configuration required. The feature:
- Activates automatically for `implementation-planner` persona
- Pulls latest changes before reading (falls back gracefully on pull failure)
- Commits and pushes after writing (logs warning on push failure)
- Falls back gracefully if no planning log exists
- Works with existing planning log format
- Supports distributed multi-machine workflows

## Testing

All existing tests pass:
```
Test Files  31 passed | 1 skipped (32)
Tests      134 passed | 3 skipped (137)
```

No new tests needed - the feature enhances existing planning behavior without changing the interface or breaking existing workflows.

## Future Enhancements

Potential improvements:
1. **Diff Analysis**: Show explicit diff between iterations
2. **Change Summary**: Auto-generate "what changed" summary
3. **Plan Versioning**: Track semantic version numbers for plans
4. **Approval Tracking**: Note which iterations were approved by evaluator
5. **Metrics**: Track refinement rate, iteration count trends
