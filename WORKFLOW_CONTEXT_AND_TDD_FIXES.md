# Workflow Context and TDD Awareness Fixes

## Overview
Fixed three critical disconnects in the workflow system:
1. Context scanner not including config files
2. QA iteration loop not passing cumulative feedback history
3. QA agent not TDD-aware for failing test scenarios

## Problem 1: Context Scanner Skipping Config Files

### Issue
Planning personas mentioned missing config files (package.json, tsconfig.json, etc.) even though they existed in the project. The context scanner was only looking at:
- `src/**`
- `app/**`
- `tests/**`

This meant essential project configuration files were never included in context gathering.

### Solution
Updated `SCAN_INCLUDE` default in `src/config.ts` to include:
- `*.json` - package.json, tsconfig.json, etc.
- `*.yaml`, `*.yml` - Config files
- `*.toml` - Config files
- `*.config.js`, `*.config.ts` - Webpack, Vite, etc.
- `Makefile`, `Dockerfile` - Build configs
- `.env.example` - Environment templates

Also added common build output directories to `SCAN_EXCLUDE`:
- `**/build/**`
- `**/coverage/**`

### Impact
- ✅ Context gathering now includes all project configuration
- ✅ Planning personas can see package.json dependencies
- ✅ Implementation personas can reference tsconfig settings
- ✅ QA personas can identify test framework configs

## Problem 2: QA Iteration Loop Missing Cumulative History

### Issue
The `QAIterationLoopStep.retestQA()` method was only passing:
- `plan` - Current iteration's plan
- `implementation` - Current iteration's implementation

But NOT passing:
- `previous_attempts` - Full history of all prior iterations
- Previous QA feedback
- What was already tried

This meant the QA persona was re-testing without context of previous failures, potentially giving the same feedback repeatedly.

### Solution
Enhanced `retestQA()` method in `src/workflows/steps/QAIterationLoopStep.ts`:

1. **Added `previousHistory` parameter** - Array of all prior iteration attempts
2. **Pass cumulative history to QA** - Includes plan, implementation, QA result from each iteration
3. **Updated call site** - Pass `iterationHistory` array when retesting

```typescript
// Before
qaResult = await this.retestQA(context, redis, plan, implementation, qaRetestStep, currentIteration);

// After  
qaResult = await this.retestQA(context, redis, plan, implementation, qaRetestStep, currentIteration, iterationHistory);
```

### Impact
- ✅ QA persona sees full context of all previous attempts
- ✅ Can avoid repeating the same feedback
- ✅ Can recognize when different approaches were tried
- ✅ Better iteration convergence

## Problem 3: QA Agent Not TDD-Aware

### Issue
When a task's goal is to write a **failing test** (TDD Red phase), the QA agent would mark the step as failed because the test fails. But in TDD, a failing test is the **expected and correct outcome** at this stage.

The workflow has `QAFailureCoordinationStep` with TDD detection logic, but:
- QA persona itself wasn't TDD-aware
- QA iteration loop wasn't detecting TDD context
- No `tdd_stage` being passed to QA requests

### Solution

#### Part A: Added TDD Detection to QA Iteration Loop
In `src/workflows/steps/QAIterationLoopStep.ts`:

```typescript
// Detect TDD context
const task = context.getVariable('task');
const tddStage = context.getVariable('tdd_stage') || task?.tdd_stage;
const isFailingTestStage = tddStage === 'write_failing_test' || tddStage === 'failing_test';
```

Pass TDD context to QA persona:
```typescript
payload: {
  // ... other fields
  tdd_stage: tddStage,
  is_tdd_failing_test_stage: isFailingTestStage,
  previous_attempts: previousHistory || []
}
```

#### Part B: Enhanced QA Persona Prompt
Updated `tester-qa` system prompt in `src/personas.ts`:

**Added TDD awareness instructions:**
> "IMPORTANT TDD AWARENESS: If the payload includes 'is_tdd_failing_test_stage: true' or 'tdd_stage: write_failing_test', this is a TDD Red phase where the task goal is to CREATE a failing test. In this case, respond with {\"status\": \"pass\"} if a new failing test was successfully created and executed (even if it fails), and {\"status\": \"fail\"} only if the test file could not be created or has syntax errors. Include 'tdd_red_phase_detected: true' in your response when this applies."

### Impact
- ✅ TDD failing test tasks can pass QA successfully
- ✅ QA checks if test was created and runs (not if it passes)
- ✅ Proper TDD Red → Green → Refactor workflow support
- ✅ No false failures for intentional failing tests

## TDD Workflow Example

### Task: "Write failing test for user authentication"

#### Stage 1: Write Failing Test (TDD Red)
```json
{
  "task": {
    "name": "Write failing test for user authentication",
    "tdd_stage": "write_failing_test"
  }
}
```

**QA Persona Behavior:**
- Detects `is_tdd_failing_test_stage: true`
- Checks: Did test file get created? ✅
- Checks: Does test run? ✅  
- Checks: Does test fail? ✅ (Expected!)
- **Result:** `{"status": "pass", "tdd_red_phase_detected": true}`

#### Stage 2: Implement Feature (TDD Green)
```json
{
  "task": {
    "name": "Implement user authentication to pass test",
    "tdd_stage": "implement"
  }
}
```

**QA Persona Behavior:**
- Normal QA mode (no TDD flag)
- Checks: Do all tests pass? 
- **Result:** `{"status": "pass"}` only if tests actually pass

## Testing

### Test Suite Results
- ✅ **106 tests passed** (3 skipped)
- ✅ All TDD governance tests pass
- ✅ All QA iteration tests pass
- ✅ All context gathering tests pass
- ✅ No regressions

### Key Tests Validated
- `tddGovernanceGate.test.ts` - TDD stage detection
- `qaFailure.test.ts` - QA failure handling
- `qaPlanIterationMax.test.ts` - Iteration limits
- `qaFollowupExecutes.test.ts` - QA iteration execution
- `happyPath.test.ts` - Full workflow end-to-end

## Files Modified

### 1. `src/config.ts`
- Updated `scanInclude` default pattern
- Added config file patterns
- Enhanced `scanExclude` with build dirs

### 2. `src/workflows/steps/QAIterationLoopStep.ts`
- Added TDD detection in `retestQA()`
- Added `previousHistory` parameter
- Pass TDD context to QA persona
- Pass cumulative history to QA
- Added `crypto` import for UUID generation

### 3. `src/personas.ts`
- Enhanced `tester-qa` system prompt
- Added comprehensive TDD awareness instructions
- Defined TDD Red phase detection criteria
- Specified pass/fail logic for TDD scenarios

## Configuration

### Environment Variables

Users can override defaults:

```bash
# Context scanning includes
SCAN_INCLUDE="src/**,app/**,tests/**,*.json,*.yaml,*.yml"

# Context scanning excludes
SCAN_EXCLUDE="**/node_modules/**,**/.git/**,**/dist/**,**/build/**"

# Task-level TDD stage
task.tdd_stage="write_failing_test"  # or "implement", "refactor"
```

### Context Variables

Workflow can set TDD stage:
```typescript
context.setVariable('tdd_stage', 'write_failing_test');
```

Task object can include:
```json
{
  "task": {
    "tdd_stage": "write_failing_test",
    "labels": ["tdd", "red_phase"]
  }
}
```

## Benefits

### 1. Better Context Awareness
- Personas see complete project structure
- Config files inform technology choices
- Dependencies guide implementation decisions

### 2. Smarter QA Iterations
- Avoid repeated identical feedback
- Recognize previous attempts
- Faster convergence to passing state
- Better debugging with full history

### 3. TDD Workflow Support
- Proper Red-Green-Refactor cycle
- Failing tests don't block TDD Red phase
- Clear distinction between stages
- Supports TDD best practices

## Future Enhancements

### Potential Improvements
1. **TDD stage transitions** - Auto-advance from Red → Green → Refactor
2. **Context caching** - Cache parsed config file contents
3. **History summarization** - Compress long iteration histories
4. **TDD metrics** - Track Red/Green/Refactor cycle times
5. **Smart file watching** - Only rescan changed config files

## Related Documentation
- `DIFF_APPLY_FLEXIBILITY.md` - Diff parsing enhancements
- `TASK_STATUS_UPDATES.md` - Dashboard status tracking
- `QA_ITERATION_LOOP.md` - Unlimited iteration loop
- `docs/WORKFLOW_SYSTEM.md` - Overall workflow architecture
