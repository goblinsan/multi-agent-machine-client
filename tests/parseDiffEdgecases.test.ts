import { describe, it, expect } from 'vitest'
import { parseUnifiedDiffToEditSpec } from '../src/fileops'

describe('parseUnifiedDiffToEditSpec edge cases', () => {
  it('parses a deletion diff into a delete op', () => {
    const diff = `diff --git a/src/old.js b/src/old.js
index e69de29..0000000 100644
--- a/src/old.js
+++ b/src/old.js
@@ -1,3 +0,0 @@
-console.log('old file')
-
-
`;
    const spec = parseUnifiedDiffToEditSpec(diff);
    expect(spec.ops.some((o: any) => o.action === 'delete' && o.path === 'src/old.js')).toBeTruthy();
  });

  it('parses multiple hunks and reconstructs new content', () => {
    const diff = `diff --git a/src/multi.js b/src/multi.js
index e69..abc 100644
--- a/src/multi.js
+++ b/src/multi.js
@@ -1,3 +1,3 @@
 console.log('line1')
-console.log('line2-old')
+console.log('line2-new')
@@ -10,3 +10,4 @@
 // tail context
+console.log('added at tail')
`;
    const spec = parseUnifiedDiffToEditSpec(diff);
    const up = spec.ops.find((o: any) => o.action === 'upsert' && o.path === 'src/multi.js');
    expect(up).toBeDefined();
    // Narrow the type and assert content
    const upsert = up as any;
    expect(upsert.content).toBeDefined();
    expect(upsert.content).toContain("console.log('line1')");
    expect(upsert.content).toContain("console.log('line2-new')");
    expect(upsert.content).toContain("console.log('added at tail')");
  })
})
