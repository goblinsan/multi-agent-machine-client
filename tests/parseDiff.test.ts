import { describe, it, expect } from 'vitest'
import { parseUnifiedDiffToEditSpec } from '../src/fileops'

describe('parseUnifiedDiffToEditSpec', () => {
  it('parses a multi-file unified diff bundle and produces upsert ops', () => {
    const diff = `diff --git a/package.json b/package.json
index e69de29..4b825dc 100644
--- a/package.json
+++ b/package.json
@@ -0,0 +1,6 @@
{
  "name": "example",
  "version": "1.0.0"
}
diff --git a/src/App.test.tsx b/src/App.test.tsx
new file mode 100644
index 0000000..e69de29
--- /dev/null
+++ b/src/App.test.tsx
@@ -0,0 +1,3 @@
import React from 'react'
import { render } from '@testing-library/react'
`

    const spec = parseUnifiedDiffToEditSpec(diff)
    expect(spec).toBeDefined()
    expect(spec.ops).toBeInstanceOf(Array)
    // should produce at least two upsert ops
    const upserts = spec.ops.filter((o: any) => o.action === 'upsert')
    expect(upserts.length).toBeGreaterThanOrEqual(2)
    // check paths exist and content is non-empty
    expect(upserts.map((u: any) => u.path)).toContain('package.json')
    expect(upserts.map((u: any) => u.path)).toContain('src/App.test.tsx')
  const pkg = upserts.find((u: any) => u.path === 'package.json')
  expect(pkg).toBeDefined()
  // non-null assertion because we just checked it's defined
  expect(pkg!.content).toContain('"name": "example"')
  })
})
