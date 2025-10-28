# Context Cache Optimization

## Overview
The workflow now intelligently skips LLM calls to the context persona when the repository context has not changed since the last scan.

## How It Works

### 1. Context Scan Step
The `ContextStep` checks if source files have changed since the last scan:

```typescript
// Check if any source files modified since last snapshot
const needsRescan = await this.isRescanNeeded(repoPath, includePatterns, excludePatterns);

if (!needsRescan) {
  // Reuse existing context from .ma/context/snapshot.json and summary.md
  contextData = existingContext;
  reusedExisting = true;
}
```

### 2. Conditional Persona Call
The workflow YAML conditionally skips the context persona LLM call:

```yaml
- name: context_request
  type: PersonaRequestStep
  description: "Request context analysis from context persona"
  depends_on: ["context_scan"]
  condition: "${context_scan.reused_existing} != true"  # Skip LLM if reusing cache
  config:
    persona: "context"
    payload:
      repoScan: "${repoScan}"
      reused_existing: "${context_scan.reused_existing}"
```

## Benefits

1. **Performance**: Skip expensive LLM calls when context hasn't changed
2. **Cost**: Reduce LM Studio API calls
3. **Reliability**: Context analysis from previous run is still valid if source hasn't changed
4. **Efficiency**: Workflow continues immediately with cached context

## When Context is Reused

Context is reused when:
- ✅ `.ma/context/snapshot.json` and `summary.md` exist
- ✅ No source files modified since last scan (based on mtime)
- ✅ Only `.ma/**` directory changes (excluded from scan)

Context is rescanned when:
- ❌ Context files don't exist
- ❌ Any source file modified since last scan
- ❌ `forceRescan: true` in config

## Test Coverage

See `tests/contextCacheReuse.test.ts` for comprehensive test coverage:

1. ✅ Initial scan creates artifacts
2. ✅ Reuses context when source unchanged
3. ✅ Rescans when source modified
4. ✅ Ignores `.ma/` directory changes
5. ✅ Forces rescan when requested
6. ✅ Sets `reused_existing` flag correctly in outputs

See `tests/workflowConditionalContext.test.ts` for workflow integration tests:

1. ✅ Workflow has condition to skip context_request
2. ✅ Documentation explains the optimization
3. ✅ Passes `reused_existing` flag to persona

## Implementation Details

### ContextStep Outputs
```typescript
{
  status: 'success',
  outputs: {
    context: contextData,
    repoScan: contextData.repoScan,
    reused_existing: reusedExisting,  // ← Used in workflow condition
    scan_timestamp: contextData.metadata.scannedAt
  }
}
```

### Workflow Variable Access
The workflow can access the flag via step output:
```yaml
condition: "${context_scan.reused_existing} != true"
```

## Performance Impact

**Before optimization:**
- Every workflow run: 1 LLM call to context persona (~20-40s)

**After optimization:**
- First run: 1 LLM call (~20-40s)
- Subsequent runs (no source changes): **0 LLM calls** (~instant)

**Example scenario:**
- Working on bug fixes in same codebase
- Workflow runs multiple times during debugging
- Context only analyzed once, reused for subsequent runs
- **Saves 20-40 seconds per workflow run**

## Edge Cases Handled

1. **Dirty .ma/ directory**: Excluded from scan, doesn't trigger rescan
2. **Concurrent modifications**: Uses mtime comparison, safe for concurrent workflows
3. **Missing cache**: Falls back to full scan automatically
4. **Force rescan**: `forceRescan: true` bypasses cache for explicit refresh

## Future Enhancements

Consider adding:
- TTL (time-to-live) for cached context
- Hash-based validation (not just mtime)
- Cache invalidation on dependency changes (package.json, etc.)
