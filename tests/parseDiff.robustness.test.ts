import { describe, it, expect } from 'vitest'
import { DiffParser } from '../src/agents/parsers/DiffParser'

describe('DiffParser robustness tests', () => {
  describe('malformed diff recovery', () => {
    it('handles diff blocks with wrong line numbers but valid structure', () => {
      // LLM often generates diffs with incorrect @@ line numbers
      const response = `
Here's the implementation:

\`\`\`diff
--- a/src/newfile.ts
+++ b/src/newfile.ts
@@ -1,3 +1,5 @@
+export function newFunction() {
+  return 'hello';
+}
\`\`\`
`
      const result = DiffParser.parsePersonaResponse(response)
      
      // Should still extract the content despite wrong line numbers
      expect(result.diffBlocks.length).toBeGreaterThan(0)
      if (result.editSpec) {
        const upsert = result.editSpec.ops.find((op: any) => op.action === 'upsert')
        expect(upsert).toBeDefined()
        expect((upsert as any).content).toContain('newFunction')
      }
    })

    it('handles diff blocks without explicit file markers', () => {
      const response = `
\`\`\`diff
+++ b/src/test.ts
@@ -0,0 +1,3 @@
+export const test = true;
+export const value = 42;
\`\`\`
`
      const result = DiffParser.parsePersonaResponse(response)
      
      expect(result.diffBlocks.length).toBeGreaterThan(0)
    })

    it('handles mixed content with prose and diffs', () => {
      const response = `
I've implemented the feature. Here are the changes:

1. First, I created a new file
2. Then I modified the existing file

\`\`\`diff
--- a/src/existing.ts
+++ b/src/existing.ts
@@ -10,5 +10,6 @@
 function old() {
-  return false;
+  return true;
 }
\`\`\`

And here's another change:

\`\`\`diff
--- a/src/another.ts
+++ b/src/another.ts
@@ -1,2 +1,3 @@
 const x = 1;
+const y = 2;
\`\`\`

Changed Files:
- src/existing.ts
- src/another.ts
`
      const result = DiffParser.parsePersonaResponse(response)
      
      expect(result.diffBlocks.length).toBeGreaterThanOrEqual(2)
      expect(result.success).toBe(true)
      if (result.editSpec) {
        expect(result.editSpec.ops.length).toBeGreaterThanOrEqual(2)
      }
    })

    it('handles diffs with extra markdown noise', () => {
      const response = `
**Implementation:**

\`\`\`typescript
// This is NOT a diff, just explanatory code
function example() {}
\`\`\`

**Actual Changes:**

\`\`\`diff
--- a/src/real.ts
+++ b/src/real.ts
@@ -1,1 +1,2 @@
 const original = 1;
+const added = 2;
\`\`\`
`
      const result = DiffParser.parsePersonaResponse(response)
      
      // Should find only the real diff, not the typescript code block
      expect(result.diffBlocks.length).toBe(1)
      expect(result.diffBlocks[0].content).toContain('const added')
      expect(result.diffBlocks[0].content).not.toContain('function example')
    })
  })

  describe('edge cases', () => {
    it('handles empty response gracefully', () => {
      const result = DiffParser.parsePersonaResponse('')
      
      expect(result.success).toBe(false)
      expect(result.errors).toContain('No diff blocks detected in persona response')
      expect(result.diffBlocks.length).toBe(0)
    })

    it('handles response with no diffs gracefully', () => {
      const response = `
I cannot implement this because the requirements are unclear.
Please provide more details.
`
      const result = DiffParser.parsePersonaResponse(response)
      
      expect(result.success).toBe(false)
      expect(result.warnings).toContain('No diff blocks found in response')
    })

    it('handles diffs with only deletions', () => {
      const response = `
\`\`\`diff
--- a/src/old.ts
+++ b/src/old.ts
@@ -1,5 +0,0 @@
-function deprecated() {
-  return null;
-}
-
-export default deprecated;
\`\`\`
`
      const result = DiffParser.parsePersonaResponse(response)
      
      // Should handle deletion-only diffs
      expect(result.diffBlocks.length).toBeGreaterThan(0)
    })

    it('handles diffs for new files (no --- a/ prefix)', () => {
      const response = `
\`\`\`diff
--- /dev/null
+++ b/src/brand-new.ts
@@ -0,0 +1,5 @@
+export function brand() {
+  return 'new';
+}
+
+export default brand;
\`\`\`
`
      const result = DiffParser.parsePersonaResponse(response)
      
      expect(result.diffBlocks.length).toBeGreaterThan(0)
      if (result.editSpec) {
        const upsert = result.editSpec.ops.find((op: any) => 
          op.action === 'upsert' && op.path.includes('brand-new')
        )
        expect(upsert).toBeDefined()
      }
    })

    it('handles multiple diffs for the same file', () => {
      const response = `
\`\`\`diff
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,2 +1,3 @@
 const a = 1;
+const b = 2;
 const c = 3;
@@ -10,2 +11,3 @@
 const x = 10;
+const y = 20;
 const z = 30;
\`\`\`
`
      const result = DiffParser.parsePersonaResponse(response)
      
      expect(result.diffBlocks.length).toBeGreaterThan(0)
      expect(result.success).toBe(true)
    })
  })

  describe('validation and error reporting', () => {
    it('provides helpful error messages for unparseable diffs', () => {
      const response = `
\`\`\`diff
this is not a valid diff at all
just random text
+++ but with some plus signs
--- and minus signs
\`\`\`
`
      const result = DiffParser.parsePersonaResponse(response)
      
      // Should fail but provide useful error info
      expect(result.success).toBe(false)
      expect(result.errors.length).toBeGreaterThan(0)
    })

    it('warns about suspicious diff patterns', () => {
      const response = `
\`\`\`diff
--- a/src/file.ts
+++ b/src/file.ts
@@ -1,100 +1,200 @@
+
+...
\`\`\`
`
      const result = DiffParser.parsePersonaResponse(response)
      
      // Should parse but potentially warn
      expect(result.diffBlocks.length).toBeGreaterThan(0)
    })
  })

  describe('real-world LLM output patterns', () => {
    it('handles "Implementation Plan" format with embedded diffs', () => {
      const response = `
### Implementation Plan

1. **Create new file**: src/ingest/fileIngest.ts

\`\`\`diff
--- /dev/null
+++ b/src/ingest/fileIngest.ts
@@ -0,0 +1,10 @@
+import fs from 'fs';
+
+export async function ingest(path: string) {
+  const data = await fs.promises.readFile(path, 'utf8');
+  return JSON.parse(data);
+}
\`\`\`

2. **Update tests**: src/ingest/fileIngest.test.ts

\`\`\`diff
--- a/src/ingest/fileIngest.test.ts
+++ b/src/ingest/fileIngest.test.ts
@@ -1,0 +1,5 @@
+import { ingest } from './fileIngest';
+
+test('ingests file', async () => {
+  const result = await ingest('test.json');
+});
\`\`\`

**Commit Message:**
feat: implement file ingestion

**Changed Files:**
- src/ingest/fileIngest.ts
- src/ingest/fileIngest.test.ts
`
      const result = DiffParser.parsePersonaResponse(response)
      
      expect(result.diffBlocks.length).toBeGreaterThanOrEqual(2)
      expect(result.success).toBe(true)
      if (result.editSpec) {
        expect(result.editSpec.ops.length).toBeGreaterThanOrEqual(2)
        const paths = result.editSpec.ops.map((op: any) => op.path)
        expect(paths).toContain('src/ingest/fileIngest.ts')
        expect(paths).toContain('src/ingest/fileIngest.test.ts')
      }
    })
  })
})
