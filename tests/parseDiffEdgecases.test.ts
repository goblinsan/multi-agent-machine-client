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

  it('filters out .git/HEAD and emits warning', () => {
    const diff = `diff --git a/.git/HEAD b/.git/HEAD
index e69de29..4b825dc 100644
--- a/.git/HEAD
+++ b/.git/HEAD
@@ -1 +1 @@
-branch: master
+branch: feature/new-branch
`;
    const warnings: string[] = [];
    const spec = parseUnifiedDiffToEditSpec(diff, { warnings });
    expect(spec.ops.length).toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('.git/HEAD');
    expect(warnings[0]).toContain('disallowed extension');
  })

  it('filters out .env file and emits warning', () => {
    const diff = `diff --git a/.env b/.env
index e69de29..4b825dc 100644
--- a/.env
+++ b/.env
@@ -0,0 +1,2 @@
+API_KEY=secret123
+DATABASE_URL=postgres:
`;
    const warnings: string[] = [];
    const spec = parseUnifiedDiffToEditSpec(diff, { warnings });
    expect(spec.ops.length).toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
    expect(warnings[0]).toContain('.env');
  })

  it('filters out files without extensions', () => {
    const diff = `diff --git a/LICENSE b/LICENSE
index e69de29..4b825dc 100644
--- a/LICENSE
+++ b/LICENSE
@@ -0,0 +1 @@
+MIT License
`;
    const warnings: string[] = [];
    const spec = parseUnifiedDiffToEditSpec(diff, { warnings });
    expect(spec.ops.length).toBe(0);
    expect(warnings.length).toBeGreaterThan(0);
  })

  it('allows .txt files', () => {
    const diff = `diff --git a/README.txt b/README.txt
index e69de29..4b825dc 100644
--- a/README.txt
+++ b/README.txt
@@ -0,0 +1 @@
+This is a readme
`;
    const warnings: string[] = [];
    const spec = parseUnifiedDiffToEditSpec(diff, { warnings });
    expect(spec.ops.length).toBe(1);
    expect(warnings.length).toBe(0);
  })

  it('processes allowed files and filters disallowed in mixed diff', () => {
    const diff = `diff --git a/src/app.ts b/src/app.ts
index e69de29..4b825dc 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -0,0 +1,2 @@
+console.log('allowed');
+
diff --git a/.git/config b/.git/config
index e69de29..4b825dc 100644
--- a/.git/config
+++ b/.git/config
@@ -0,0 +1 @@
+[core]
diff --git a/package.json b/package.json
index e69de29..4b825dc 100644
--- a/package.json
+++ b/package.json
@@ -0,0 +1,3 @@
+{
+  "name": "test"
+}
`;
    const warnings: string[] = [];
    const spec = parseUnifiedDiffToEditSpec(diff, { warnings });
    // Should have 2 ops (src/app.ts and package.json) and 1 warning (.git/config)
    expect(spec.ops.length).toBe(2);
    expect(spec.ops.map((o: any) => o.path)).toContain('src/app.ts');
    expect(spec.ops.map((o: any) => o.path)).toContain('package.json');
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain('.git/config');
  })
})
