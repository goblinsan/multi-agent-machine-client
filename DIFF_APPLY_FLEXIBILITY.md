# DiffApplyStep Flexibility Enhancement

## Overview
Enhanced `DiffApplyStep` to robustly handle multiple input formats from persona responses, making the workflow engine more resilient and easier to test.

## Problem
The `DiffApplyStep` was failing when persona responses contained pre-parsed operation structures (JSON with `ops` array) instead of raw diff text format. This caused test failures where mock responses used structured data:

```typescript
// This would fail:
{
  status: 'ok',
  ops: [
    { action: 'upsert', path: 'dummy.txt', content: 'hello' }
  ]
}

// Only this would work:
```diff
--- a/dummy.txt
+++ b/dummy.txt
@@ -0,0 +1 @@
+hello
```
```

## Solution
Made `DiffApplyStep` flexible to accept **both** formats:
1. **Raw diff text** - Traditional unified diff format with `\`\`\`diff` blocks
2. **Pre-parsed ops** - Structured JSON with `ops` array

## Implementation

### Detection Logic
The step now checks multiple locations in the persona response output:
- `output.ops` - Top-level ops array
- `output.result.ops` - Nested ops array in result field
- `output.diffs` / `output.code_diffs` - Traditional diff text
- `output.diff` - Single diff text
- `output.result` (string) - Raw diff string in result

### Conversion Process
When pre-parsed ops are detected:
1. Converts each op to synthetic unified diff format
2. Generates proper diff headers (`--- a/`, `+++ b/`)
3. Creates hunk headers with line counts (`@@ -0,0 +1,N @@`)
4. Prefixes content lines with `+` for additions
5. Wraps in ````diff` blocks for parser compatibility

### Example Conversion

**Input (pre-parsed):**
```json
{
  "ops": [
    {
      "action": "upsert",
      "path": "src/example.ts",
      "content": "export const foo = 'bar';\nexport const baz = 42;"
    }
  ]
}
```

**Output (synthetic diff):**
````
```diff
--- a/src/example.ts
+++ b/src/example.ts
@@ -0,0 +1,2 @@
+export const foo = 'bar';
+export const baz = 42;
```
````

## Benefits

### 1. **Testing Flexibility**
Tests can now use simple JSON mocks instead of complex diff strings:

```typescript
// Before: Complex and error-prone
'2-implementation': { 
  fields: { 
    result: '```diff\n--- a/file.ts\n+++ b/file.ts\n@@ -0,0 +1 @@\n+hello\n```' 
  } 
}

// After: Simple and readable
'2-implementation': { 
  fields: { 
    result: JSON.stringify({ 
      ops: [{ action: 'upsert', path: 'file.ts', content: 'hello' }] 
    }) 
  } 
}
```

### 2. **Real-World Robustness**
Handles various response formats from different LLM models:
- Some models return structured JSON
- Some return markdown-formatted diffs
- Some mix both formats

### 3. **Backward Compatible**
- All existing workflows using raw diff text continue to work
- No changes needed to existing persona implementations
- Graceful handling of multiple format variations

### 4. **Better Error Context**
Enhanced logging shows:
- Detected format type
- Number of operations found
- Conversion details for debugging

## Supported Operations

### Upsert Operations
```json
{
  "action": "upsert",
  "path": "file.ts",
  "content": "file contents..."
}
```
Converted to: Unified diff showing full file addition

### Delete Operations
```json
{
  "action": "delete",
  "path": "file.ts"
}
```
Converted to: Unified diff showing file deletion (`+++ /dev/null`)

## Code Location
- Implementation: `src/workflows/steps/DiffApplyStep.ts`
- Methods:
  - `getDiffContent()` - Detection and extraction logic
  - `convertOpsToDiffFormat()` - Conversion to synthetic diffs

## Testing
- ✅ All 106 tests passing
- ✅ `branchSelection.test.ts` - Uses pre-parsed ops format
- ✅ Other tests - Use traditional diff format
- ✅ Mixed format scenarios - Handled gracefully

## Future Enhancements
1. Support for `edit` operations (find-replace patches)
2. Support for move/rename operations
3. Validation of ops structure before conversion
4. Line-level diff hunks for partial file updates

## Related Files
- `src/workflows/steps/DiffApplyStep.ts` - Main implementation
- `src/agents/parsers/DiffParser.ts` - Diff parsing logic
- `tests/helpers/mockHelpers.ts` - Test mocks using both formats
