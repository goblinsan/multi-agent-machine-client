import { describe, it, expect } from "vitest";
import { parseUnifiedDiffToEditSpec } from "../src/fileops";
import {
  extractDiffCandidates,
  parseAgentEditsFromResponse,
} from "../src/workflows/helpers/agentResponseParser";

describe("parseUnifiedDiffToEditSpec", () => {
  it("parses a multi-file unified diff bundle and produces upsert ops", () => {
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
`;

    const spec = parseUnifiedDiffToEditSpec(diff);
    expect(spec).toBeDefined();
    expect(spec.ops).toBeInstanceOf(Array);

    const upserts = spec.ops.filter((o: any) => o.action === "upsert");
    expect(upserts.length).toBeGreaterThanOrEqual(2);

    expect(upserts.map((u: any) => u.path)).toContain("package.json");
    expect(upserts.map((u: any) => u.path)).toContain("src/App.test.tsx");
    const pkg = upserts.find((u: any) => u.path === "package.json");
    expect(pkg).toBeDefined();

    expect(pkg!.content).toContain('"name": "example"');
  });
});

describe("extractDiffCandidates", () => {
  it("extracts diff from preview field with mixed content", () => {
    const leadOutcome = {
      result: {
        preview: `Changed Files:
- src/__tests__/ingestion.test.ts
- src/__tests__/App.test.tsx

Commit Message:
\`\`\`
feat: write failing unit test for ingestion API and update App.test.tsx

- Added a new failing unit test to verify that the ingestion API can read a single JSON file and return a parsed object.
- Updated App.test.tsx to ensure it passes with current implementation.
\`\`\`

diff --git a/src/__tests__/ingestion.test.ts b/src/__tests__/ingestion.test.ts
index 3c6a0d8..9f4b7e1 100644
--- a/src/__tests__/ingestion.test.ts
+++ b/src/__tests__/ingestion.test.ts
@@ -1,6 +1,6 @@
 import { describe, it, expect } from 'vitest';
 import { render, screen } from '@testing-library/react';
-import App from '../App';
+import App from '../App'; // importing App from App.tsx
 
 describe('App component', () => {
   it('renders learn react link', () => {
@@ -10,3 +10,22 @@ describe('App component', () => {
     expect(linkElement).toBeInTheDocument();
   });
 });
+
+describe('Ingestion API', () => {
+  it('should read a single JSON file and return a parsed object', async () => {
+
+    
+    const mockFilePath = 'test-data.json';
+    const expectedData = { key: 'value', number: 42 };
+    
+
+    const result = null;
+    
+    expect(result).toEqual(expectedData);
+  });
+});

diff --git a/src/__tests__/App.test.tsx b/src/__tests__/App.test.tsx
index d76787e..51d3ad1 100644
--- a/src/__tests__/App.test.tsx
+++ b/src/__tests__/App.test.tsx
@@ -6,6 +6,7 @@ describe('App component', () => {
   it('renders learn react link', () => {
     render(<App />);
     const linkElement = screen.getByText(/learn react/i);
+
     expect(linkElement).toBeInTheDocument();
   });
 });`,
      },
    };

    const candidates = extractDiffCandidates(leadOutcome);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toContain(
      "diff --git a/src/__tests__/ingestion.test.ts",
    );
    expect(candidates[0]).toContain("diff --git a/src/__tests__/App.test.tsx");
    expect(candidates[0]).toContain("@@ -1,6 +1,6 @@");
    expect(candidates[0]).toContain(
      "+import App from '../App'; // importing App from App.tsx",
    );
  });

  it("ignores fenced code blocks without diff markers", () => {
    const leadOutcome = {
      result: {
        output: `Here's my analysis:

\`\`\`
This is just a regular code block without diff markers.
It should be ignored.
\`\`\`

And here's the actual diff:

diff --git a/README.md b/README.md
index 1111111..2222222 100644
--- a/README.md
+++ b/README.md
@@ -1,2 +1,2 @@
-Old content
+New content`,
      },
    };

    const candidates = extractDiffCandidates(leadOutcome);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toContain("diff --git a/README.md b/README.md");
    expect(candidates[0]).toContain("-Old content");
    expect(candidates[0]).toContain("+New content");
    expect(candidates[0]).not.toContain("This is just a regular code block");
  });

  it("extracts diff from nested result field", () => {
    const leadOutcome = {
      result: {
        output: "done",
        result: `\`\`\`diff
diff --git a/test.js b/test.js
index 1111111..2222222 100644
--- a/test.js
+++ b/test.js
@@ -1,1 +1,1 @@
-console.log('old');
+console.log('new');
\`\`\``,
      },
    };

    const candidates = extractDiffCandidates(leadOutcome);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toContain("diff --git a/test.js b/test.js");
    expect(candidates[0]).toContain("-console.log('old');");
    expect(candidates[0]).toContain("+console.log('new');");
  });

  it("handles multiple response formats", () => {
    const stringResponse = {
      result: "diff --git a/file.txt b/file.txt\n+added line",
    };
    expect(extractDiffCandidates(stringResponse)).toHaveLength(1);

    const topLevelPreview = {
      preview: "diff --git a/file.txt b/file.txt\n+added line",
    };
    expect(extractDiffCandidates(topLevelPreview)).toHaveLength(1);

    expect(extractDiffCandidates({})).toHaveLength(0);
    expect(extractDiffCandidates({ result: null })).toHaveLength(0);
    expect(extractDiffCandidates({ result: { preview: null } })).toHaveLength(
      0,
    );
  });

  it("handles direct string input and raw field response structure", () => {
    const directString = `Here's the fix:

\`\`\`diff
diff --git a/src/test.js b/src/test.js
index 1234567..89abcde 100644
--- a/src/test.js
+++ b/src/test.js
@@ -1,3 +1,4 @@
 console.log('hello');
+console.log('world');
 const x = 1;
\`\`\``;

    const candidates1 = extractDiffCandidates(directString);
    expect(candidates1).toHaveLength(1);
    expect(candidates1[0]).toContain("diff --git a/src/test.js");
    expect(candidates1[0]).toContain("+console.log('world');");

    const rawResponse = {
      raw: `Here's the fix:

\`\`\`diff  
diff --git a/package.json b/package.json
index 1234567..89abcde 100644
--- a/package.json
+++ b/package.json
@@ -1,5 +1,6 @@
 {
   "name": "test",
+  "version": "1.0.0",
   "dependencies": {}
 }
\`\`\``,
    };

    const candidates2 = extractDiffCandidates(rawResponse);
    expect(candidates2).toHaveLength(1);
    expect(candidates2[0]).toContain("diff --git a/package.json");
    expect(candidates2[0]).toContain('+  "version": "1.0.0",');
  });
});

describe("parseAgentEditsFromResponse", () => {
  it("prefers structured edit specs when present", async () => {
    const structured = {
      result: {
        ops: [{ action: "upsert", path: "foo.txt", content: "hello" }],
      },
    };
    const outcome = await parseAgentEditsFromResponse(structured, {
      parseDiff: async () => ({ ops: [] }),
    });
    const ops = Array.isArray(outcome.editSpec?.ops)
      ? outcome.editSpec?.ops
      : [];
    expect(outcome.source).toBe("structured");
    expect(ops.length).toBe(1);
    expect(outcome.diffCandidates).toHaveLength(0);
  });

  it("parses diff candidates when structured edits are absent", async () => {
    const diff = `diff --git a/foo.txt b/foo.txt
index 0000000..1111111 100644
--- a/foo.txt
+++ b/foo.txt
@@ -0,0 +1 @@
+hello
`;
    const response = { result: { preview: diff } };
    const outcome = await parseAgentEditsFromResponse(response, {
      parseDiff: (txt: string) => parseUnifiedDiffToEditSpec(txt),
    });
    const ops = Array.isArray(outcome.editSpec?.ops)
      ? outcome.editSpec?.ops
      : [];
    expect(outcome.source).toBe("diff");
    expect(ops.length).toBeGreaterThan(0);
    expect(outcome.diffCandidates.length).toBeGreaterThan(0);
  });

  it("records diff parse attempts when parsing yields no operations", async () => {
    const diffOnly =
      "```diff\ndiff --git a/foo b/foo\n@@ -1 +1 @@\n-a\n+a\n```";
    const outcome = await parseAgentEditsFromResponse(diffOnly, {
      parseDiff: async () => ({ ops: [] }),
    });
    const ops = Array.isArray(outcome.editSpec?.ops)
      ? outcome.editSpec?.ops
      : [];
    expect(ops.length).toBe(0);
    expect(outcome.errors.length).toBeGreaterThan(0);
    expect(outcome.diffCandidates.length).toBeGreaterThan(0);
  });
});
