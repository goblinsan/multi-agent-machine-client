# PersonaConsumer Refactoring Plan

## Problem
`PersonaConsumer.ts` has grown to **613 lines**, making it difficult to maintain and test. The class has multiple responsibilities that should be separated.

## Current Structure Analysis

### Methods and Responsibilities:
1. **Consumer Loop Management** (Lines 52-186)
   - `start()` - Start consumer loops
   - `stop()` - Stop consumer loops gracefully
   - `startPersonaLoop()` - Main consumer loop for each persona
   - `waitForCompletion()` - Wait for all loops to finish

2. **Request Handling** (Lines 189-309)
   - `handlePersonaRequest()` - Parse and route incoming requests
   - Coordinates retries, error handling, status updates

3. **Request Execution** (Lines 310-553)
   - `executePersonaRequest()` - **MASSIVE 240+ line method**
   - Extracts context from payload
   - Builds user text from various sources
   - Gets scan summaries
   - Gets dashboard context
   - Calls LLM
   - Publishes results
   - **This method does too many things!**

4. **Artifact Handling** (Lines 563-614)
   - `resolveArtifactPath()` - Resolve artifact paths
   - `readArtifactFromGit()` - Read artifacts from git repos

## Proposed Refactoring

### Phase 1: Extract Context Building (Priority: HIGH)
**File:** `src/personas/context/ContextExtractor.ts`

```typescript
export class ContextExtractor {
  extractUserText(payload: any, intent: string): string
  buildDashboardContext(projectId: string, taskId: string): Promise<any>
  getScanSummary(repo: string, branch: string): Promise<string>
  resolveArtifactPath(path: string, payload: any): string
  readArtifactFromGit(path: string, repoUrl: string): Promise<string>
}
```

**Benefits:**
- Reduces `executePersonaRequest` from 240 lines to ~80 lines
- Makes context extraction logic testable in isolation
- Clear separation of concerns

### Phase 2: Extract Retry Logic (Priority: MEDIUM)
**File:** `src/personas/retry/RetryHandler.ts`

```typescript
export class RetryHandler {
  shouldRetry(error: any, attempt: number): boolean
  calculateBackoff(attempt: number): number
  handleTimeout(persona: string, workflowId: string): void
  trackRetryMetrics(persona: string, attempts: number): void
}
```

**Benefits:**
- Centralizes retry logic currently spread across `handlePersonaRequest`
- Makes timeout behavior consistent
- Easier to adjust retry strategies

### Phase 3: Extract Message Formatting (Priority: LOW)
**File:** `src/personas/messaging/MessageFormatter.ts`

```typescript
export class MessageFormatter {
  formatPersonaResponse(result: any): StreamMessage
  formatErrorResponse(error: any): StreamMessage
  formatTimeoutResponse(): StreamMessage
}
```

### Phase 4: Simplify PersonaConsumer (Priority: HIGH)
After extraction, `PersonaConsumer.ts` should:
- Manage consumer loops (start/stop/lifecycle)
- Delegate to `ContextExtractor` for context building
- Delegate to `RetryHandler` for retry logic
- Delegate to `MessageFormatter` for message formatting
- Target size: **< 300 lines**

## File Structure After Refactoring

```
src/personas/
├── PersonaConsumer.ts          (300 lines) - Consumer lifecycle management
├── PersonaRequestHandler.ts    (existing)  - LLM calls
├── context/
│   ├── ContextExtractor.ts     (200 lines) - Context extraction
│   ├── ArtifactReader.ts       (100 lines) - Artifact handling
│   └── DashboardContextBuilder.ts (150 lines) - Dashboard API integration
├── retry/
│   └── RetryHandler.ts         (150 lines) - Retry logic
└── messaging/
    └── MessageFormatter.ts     (100 lines) - Message formatting
```

## Migration Strategy

### Step 1: Create ContextExtractor (Non-breaking)
1. Create new file with extracted methods
2. Add tests for ContextExtractor
3. Keep old code in PersonaConsumer initially

### Step 2: Switch PersonaConsumer to use ContextExtractor
1. Inject ContextExtractor into PersonaConsumer
2. Replace inline logic with ContextExtractor calls
3. Run full test suite
4. Remove old inline code

### Step 3: Repeat for RetryHandler and MessageFormatter

## Testing Strategy

### New Tests Required:
- `tests/personas/ContextExtractor.test.ts`
  - Test userText extraction from various payload formats
  - Test artifact resolution
  - Test dashboard context building
  - Test scan summary retrieval

- `tests/personas/RetryHandler.test.ts`
  - Test retry decision logic
  - Test backoff calculation
  - Test timeout handling

### Existing Tests to Update:
- `tests/personaPlanningContext.test.ts` - May need to mock ContextExtractor
- `tests/personaTaskContextExtraction.test.ts` - May need to mock ContextExtractor

## Success Metrics

- ✅ PersonaConsumer.ts reduced from 613 to < 300 lines
- ✅ executePersonaRequest() reduced from 240 to < 80 lines
- ✅ All extracted logic has unit tests with > 80% coverage
- ✅ All existing tests continue to pass
- ✅ No performance regression (< 5% overhead acceptable)

## Timeline Estimate

- Phase 1 (ContextExtractor): 2-3 hours
- Phase 2 (RetryHandler): 1-2 hours
- Phase 3 (MessageFormatter): 1 hour
- Phase 4 (Integration & Testing): 2 hours
- **Total: 6-8 hours**

## Notes

- This refactoring should be done **after** the current bug fixes are complete
- Each phase should be a separate commit
- Keep backward compatibility during migration
- Consider using dependency injection for easier testing
