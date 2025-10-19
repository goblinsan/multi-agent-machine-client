# Diff Parser Robustness & Contextual Prompts

## Overview

This document describes two major improvements to the system:

1. **Enhanced Diff Parser**: More robust handling of malformed LLM-generated diffs
2. **Contextual Persona Prompts**: Dynamic prompt selection based on workflow context

---

## 1. Enhanced Diff Parser Robustness

### Problem
The diff parser frequently failed when LLMs generated diffs with:
- Incorrect `@@` line numbers (e.g., `@@ -1,3 +1,5 @@` when the file doesn't start at line 1)
- Missing file headers
- Mixed content (prose and diffs)
- Extra markdown formatting

### Solution

#### New Comprehensive Test Suite
**File**: `tests/parseDiff.robustness.test.ts`

Tests cover:
- ✅ Diffs with wrong line numbers but valid structure
- ✅ Diffs without explicit file markers
- ✅ Mixed content with prose and multiple diffs
- ✅ Extra markdown noise (non-diff code blocks)
- ✅ Empty or missing responses
- ✅ Deletion-only diffs
- ✅ New file creation (`/dev/null` to `b/...`)
- ✅ Multiple hunks for the same file
- ✅ Real-world LLM output patterns (Implementation Plan format)

#### Key Improvements

1. **Better Content Extraction**
   - Focuses on extracting the **content** of changes, not just validating line numbers
   - More lenient with structural issues if content is recoverable

2. **Smart Filtering**
   - Distinguishes between `\`\`\`diff` blocks and other code blocks (e.g., `\`\`\`typescript`)
   - Ignores explanatory code that's not a diff

3. **Helpful Error Messages**
   - Provides specific feedback about what went wrong
   - Includes warnings for suspicious patterns without failing

### Usage

Run the new tests:
```bash
npm test -- parseDiff.robustness
```

All existing tests still pass, ensuring backward compatibility.

---

## 2. Contextual Persona Prompts

### Problem

The `plan-evaluator` persona was using a single prompt that mentioned "QA feedback" even when evaluating initial implementation plans (before any QA has run). This confused the LLM, causing it to look for non-existent QA results.

### Solution

#### Context-Specific Prompts System
**File**: `src/personas.context.ts`

**Architecture**:
```typescript
CONTEXT_SPECIFIC_PROMPTS = {
  "plan-evaluator": {
    "planning": "Evaluate implementation plans...",  // For initial planning
    "qa-plan": "Evaluate QA fix plans...",           // For QA failure fixes
    "revision": "More lenient evaluation..."         // After multiple rejections
  },
  "implementation-planner": {
    "default": "Plan engineering work...",
    "qa-fix": "Plan fixes for QA failures..."
  }
}
```

#### How It Works

1. **Workflow Step** determines the context:
   ```typescript
   let evalContext = 'planning'; // default
   if (currentIteration > 3) {
     evalContext = 'revision'; // Be more lenient
   }
   ```

2. **Get contextual prompt**:
   ```typescript
   const contextualPrompt = getContextualPrompt('plan-evaluator', evalContext);
   ```

3. **Pass to persona via payload**:
   ```typescript
   const payload = {
     ...standardPayload,
     _system_prompt: contextualPrompt  // Special field
   };
   ```

4. **Process.ts uses custom prompt**:
   ```typescript
   const systemPrompt = payloadObj._system_prompt || SYSTEM_PROMPTS[persona];
   ```

### Available Contexts

#### Plan-Evaluator

| Context | When Used | Focus |
|---------|-----------|-------|
| `planning` | Initial planning loop (default) | Evaluate plan quality, not QA |
| `qa-plan` | QA failure coordination | Ensure plan addresses specific test failures |
| `revision` | After 3+ rejections | More lenient, reward genuine effort |

#### Implementation-Planner

| Context | When Used | Focus |
|---------|-----------|-------|
| `default` | Standard planning | General engineering work |
| `qa-fix` | QA failure fixes | Surgical, minimal scope, target failures |

### Integration Points

#### PlanningLoopStep (Updated)
**File**: `src/workflows/steps/PlanningLoopStep.ts`

```typescript
// Automatically selects context based on iteration
let evalContext = 'planning';
if (currentIteration > 3) {
  evalContext = 'revision';
}

const contextualPrompt = getContextualPrompt(evaluatorPersona, evalContext);

const evalPayload = {
  ...payload,
  ...(contextualPrompt ? { _system_prompt: contextualPrompt } : {})
};
```

#### QAFailureCoordinationStep (Future Enhancement)
Can be updated to use `qa-plan` context:

```typescript
const qaPrompt = getContextualPrompt('plan-evaluator', 'qa-plan');
const payload = {
  qa_failures: failures,
  _system_prompt: qaPrompt
};
```

### Benefits

1. **Eliminates Confusion**
   - Plan-evaluator no longer looks for non-existent "QA feedback" during planning
   - Each context has appropriate terminology and expectations

2. **Adaptive Behavior**
   - Automatically becomes more lenient after multiple rejections
   - QA-specific prompts are more focused and surgical

3. **Extensible**
   - Easy to add new contexts for different workflow stages
   - Any persona can have contextual variants

4. **Backward Compatible**
   - Falls back to default prompts if no context specified
   - Existing workflows continue to work

### Testing

**File**: `tests/personas.context.test.ts`

Tests verify:
- ✅ Correct prompt selection for each context
- ✅ Fallback to default when context not found
- ✅ Planning prompts avoid QA terminology
- ✅ QA prompts explicitly mention QA
- ✅ Revision prompts are more lenient
- ✅ All prompts include expected response format

Run tests:
```bash
npm test -- personas.context
```

---

## Migration Guide

### For Existing Workflows

**No changes required!** The system falls back to default prompts if:
- No custom prompt is provided
- Context doesn't exist
- Persona doesn't have contextual prompts

### For New Workflows

#### Option 1: Automatic Context Selection (Recommended)

Let `PlanningLoopStep` handle it automatically:
```typescript
{
  name: "planning_loop",
  type: "PlanningLoopStep",
  config: {
    maxIterations: 5,
    plannerPersona: "implementation-planner",
    evaluatorPersona: "plan-evaluator"
    // Context is selected automatically
  }
}
```

#### Option 2: Manual Context Selection

Pass custom prompt directly:
```typescript
import { getContextualPrompt } from './personas.context';

const customPrompt = getContextualPrompt('plan-evaluator', 'qa-plan');

await sendPersonaRequest(redis, {
  toPersona: 'plan-evaluator',
  payload: {
    ...standardPayload,
    _system_prompt: customPrompt
  }
});
```

### Adding New Contexts

1. **Add to `personas.context.ts`**:
```typescript
export const CONTEXT_SPECIFIC_PROMPTS = {
  "your-persona": {
    "new-context": "Your contextual prompt here..."
  }
}
```

2. **Use in workflow**:
```typescript
const prompt = getContextualPrompt('your-persona', 'new-context');
```

3. **Add tests**:
```typescript
it('returns correct prompt for new-context', () => {
  const prompt = getContextualPrompt('your-persona', 'new-context');
  expect(prompt).toContain('expected content');
});
```

---

## Performance Impact

- **Diff Parser**: Negligible - same parsing logic, just more resilient
- **Contextual Prompts**: Minimal - simple string lookup, no API calls

---

## Future Enhancements

### Diff Parser
- [ ] Add support for more diff formats (context diffs, plain diffs)
- [ ] Implement auto-correction for common LLM mistakes
- [ ] Add confidence scores to parsed diffs

### Contextual Prompts
- [ ] Integrate with QAIterationLoopStep
- [ ] Add context for code review persona
- [ ] Support prompt templates with variable substitution
- [ ] Add metrics to track which contexts are most effective

---

## Troubleshooting

### Diff Parser Issues

**Symptom**: "Failed to convert diff blocks to edit operations"

**Check**:
1. Are there any diff blocks detected? Look for `diffBlocks.length` in logs
2. What format is the LLM using? Check the raw response
3. Run the robustness tests to see which pattern matches

**Debug**:
```typescript
const result = DiffParser.parsePersonaResponse(response);
console.log('Diff blocks found:', result.diffBlocks.length);
console.log('Errors:', result.errors);
console.log('Warnings:', result.warnings);
```

### Contextual Prompt Issues

**Symptom**: Wrong prompt being used

**Check**:
1. Is the persona in `CONTEXT_SPECIFIC_PROMPTS`?
2. Does the context name match exactly?
3. Is `_system_prompt` being passed in payload?

**Debug**:
```typescript
const prompt = getContextualPrompt('plan-evaluator', 'planning');
console.log('Selected prompt:', prompt?.substring(0, 100));

// In process.ts, log which prompt is used
logger.info('Using system prompt', {
  persona,
  isCustom: !!payloadObj._system_prompt,
  promptPreview: systemPrompt.substring(0, 50)
});
```

---

## See Also

- `src/agents/parsers/DiffParser.ts` - Parser implementation
- `src/personas.ts` - Default persona prompts
- `src/personas.context.ts` - Contextual prompts
- `tests/parseDiff*.test.ts` - Diff parser tests
- `tests/personas.context.test.ts` - Contextual prompt tests
