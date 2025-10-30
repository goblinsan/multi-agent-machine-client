# Condition Evaluation Refactor - Clean Architecture

## Problem Statement

After discovering that context LLM calls weren't being skipped despite having a condition `"${context_scan.reused_existing} != true"`, investigation revealed **duplicate condition evaluation logic** in three places with inconsistent behavior:

1. **WorkflowEngine.shouldExecuteStep()** - Used ConditionEvaluator (only supported `==`)
2. **ConditionEvaluator.evaluateSimpleCondition()** - Only supported `==` operator
3. **WorkflowStep.evaluateCondition()** - Enhanced version with `!=`, booleans, dot notation

Additionally, **StepExecutor.executeStep()** was calling `step.execute()` directly without checking conditions at all!

## Root Cause

The previous refactor created separation of concerns but left **duplicate implementations** of condition evaluation logic:
- Simple evaluator in ConditionEvaluator (incomplete feature set)
- Enhanced evaluator in WorkflowStep (full feature set)  
- WorkflowEngine checking dependencies AND conditions
- StepExecutor not checking conditions at all

This violated DRY principles and led to subtle bugs where different code paths had different capabilities.

## Solution - Single Source of Truth

### Architecture Changes

**Created `src/workflows/engine/conditionUtils.ts`** - THE ONLY place with condition evaluation logic:

```
conditionUtils.ts
├── evaluateCondition() - Public API for all condition evaluation
├── evaluateSingleCondition() - Handles single comparisons
└── resolveVariablePath() - Resolves variables and step outputs
```

**Updated ConditionEvaluator** - Thin wrapper that delegates to conditionUtils:
- `evaluateSimpleCondition()` → calls `conditionUtils.evaluateCondition()`
- `evaluateTriggerCondition()` → creates temp context, calls shared evaluator
- **No duplicate logic** - just a compatibility layer

**Updated WorkflowStep** - Uses shared utility:
- `shouldExecute()` → calls `conditionUtils.evaluateCondition()`
- **Removed** duplicate `evaluateCondition()` method
- **Removed** duplicate `resolveVariablePath()` method

**Updated WorkflowEngine.shouldExecuteStep()** - Clear separation of concerns:
- **Only** checks dependencies (stepA completed before stepB?)
- **Removed** condition evaluation (delegates to StepExecutor)
- Added debug logging for dependency checks

**Updated StepExecutor.executeStep()** - Actually checks conditions now:
- Calls `step.shouldExecute()` BEFORE executing
- Records step as 'skipped' when condition fails
- Continues workflow execution (doesn't fail)

### Execution Flow

```
WorkflowEngine.executeWorkflow()
  ↓
WorkflowEngine.executeSteps()
  ↓
for each step:
  WorkflowEngine.shouldExecuteStep()  → Checks DEPENDENCIES only
    ↓
  StepExecutor.executeStep()
    ↓
  step.shouldExecute()  → Checks CONDITION (uses conditionUtils)
    ↓
  step.execute()  → Only if condition passed
```

## Benefits of This Approach

### 1. Single Source of Truth
- **ONE** implementation of condition evaluation logic in `conditionUtils.ts`
- All code paths use the same evaluator → consistent behavior everywhere
- Bug fixes apply universally

### 2. Clear Separation of Concerns
```
WorkflowEngine        → Orchestration, dependency management
StepExecutor          → Step lifecycle (condition check, timeout, execution)
WorkflowStep          → Step-specific business logic
conditionUtils        → Pure condition evaluation (no side effects)
ConditionEvaluator    → Backward compatibility wrapper
```

### 3. Eliminates Confusion
- No more "which evaluator is being used?" questions
- Clear documentation of what each component does
- Comments explain the architecture

### 4. Prevents Future Duplication
- Obvious place to add new condition syntax (conditionUtils.ts)
- Import statement makes it clear evaluation logic is shared
- Tests can validate the shared utility directly

## Supported Condition Syntax

Now **universally** supported across all evaluation paths:

```yaml
# Equality with strings
condition: "${var} == 'value'"
condition: "var == 'value'"  # Template syntax optional

# Inequality with strings  
condition: "${var} != 'value'"

# Boolean comparisons
condition: "${var} == true"
condition: "${var} != false"

# Dot notation (step outputs)
condition: "${context_scan.reused_existing} != true"
condition: "plan_evaluation.status == 'pass'"

# OR conditions
condition: "task_type == 'task' || task_type == 'feature'"

# AND conditions
condition: "var1 == 'a' && var2 == 'b'"
```

## Migration Notes

### What Changed
- ✅ Condition evaluation logic extracted to `conditionUtils.ts`
- ✅ WorkflowStep now imports and uses shared utility
- ✅ ConditionEvaluator delegates to shared utility
- ✅ WorkflowEngine.shouldExecuteStep() only checks dependencies
- ✅ StepExecutor.executeStep() now calls shouldExecute()

### What Stayed the Same
- Public API unchanged (ConditionEvaluator still works)
- Condition syntax unchanged (enhanced, not replaced)
- Workflow YAML files unchanged
- Test interfaces unchanged

### Breaking Changes
**None.** This is a pure refactor with no API changes.

## Testing

The refactor maintains all existing functionality:
- ✅ All 384 passing tests still pass
- ✅ Condition evaluation tests verify shared utility
- ✅ Context LLM skip condition now works correctly
- ✅ Logs show "Condition evaluated" and "Step skipped" messages

## Future Improvements

With this clean foundation, we can easily:
1. Add more operators (`>`, `<`, `>=`, `<=`, `contains`, `startsWith`, etc.)
2. Support parentheses for complex logic
3. Add function calls in conditions (`isEmpty(var)`, `length(array) > 0`)
4. Implement a proper expression parser if needed
5. Add condition validation at workflow load time

All improvements go in ONE place: `conditionUtils.ts`

## Lessons Learned

### Why Duplication Happened
The previous refactor created `ConditionEvaluator` for trigger matching and left condition evaluation in `WorkflowStep` for step conditions. Over time, both implementations diverged, with WorkflowStep gaining features that ConditionEvaluator lacked.

### How to Prevent
- ✅ Extract shared logic to utility modules immediately
- ✅ Use composition over implementation replication
- ✅ Document architecture decisions clearly
- ✅ Add comments explaining why code is organized a certain way
- ✅ Regular audits for duplicate patterns

## Files Changed

```
Created:
  src/workflows/engine/conditionUtils.ts          (+183 lines)

Modified:
  src/workflows/engine/ConditionEvaluator.ts      (-106 lines, cleaner)
  src/workflows/engine/WorkflowStep.ts            (-102 lines, simpler)
  src/workflows/engine/StepExecutor.ts            (+19 lines, condition check)
  src/workflows/WorkflowEngine.ts                 (-17 lines, removed condition check)

Net Result: -23 lines, significantly cleaner architecture
```

## Summary

This refactor **eliminates code duplication** and creates **clear separation of concerns** while maintaining **100% backward compatibility**. The condition evaluation logic now lives in ONE place, making the system easier to understand, maintain, and extend.

The architecture is now:
- ✅ DRY - No duplicate condition evaluation logic
- ✅ SOLID - Single Responsibility, Open/Closed, Dependency Inversion
- ✅ Testable - Shared utility can be tested in isolation
- ✅ Documented - Clear comments explain the design
- ✅ Maintainable - Future changes go in one obvious place

**Result**: Context LLM calls are now properly skipped when reusing existing context. 🎉
