import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { DeterministicReviewStep } from "../../src/workflows/steps/DeterministicReviewStep.js";

async function makeRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "det-review-"));
  for (const [file, content] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, file);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
  }
  return repoRoot;
}

function makeContext(
  repoRoot: string,
  changedFiles: string[],
  addedFiles: string[] = [],
): WorkflowContext {
  const context = new WorkflowContext(
    "wf-review",
    "project-review",
    repoRoot,
    "main",
    {
      name: "test",
      version: "1.0.0",
      steps: [],
    },
    {} as any,
  );
  context.setVariable("review_diff_files", changedFiles);
  context.setVariable("review_diff_added_files", addedFiles);
  return context;
}

describe("DeterministicReviewStep", () => {
  it("fails on configured file size limits and sets review variables", async () => {
    const content = Array.from({ length: 7 }, (_, i) => `export const v${i} = ${i};`).join("\n");
    const repoRoot = await makeRepo({ "src/large.ts": content });
    const context = makeContext(repoRoot, ["src/large.ts"]);

    const step = new DeterministicReviewStep({
      name: "code_review_request",
      type: "DeterministicReviewStep",
      config: {
        output_prefix: "code_review_request",
        changed_files: ["src/large.ts"],
        block_on: ["high"],
        rules: [{ id: "file_size", max_lines: 5, severity: "high" }],
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(context.getVariable("code_review_request_status")).toBe("fail");
    expect(context.getVariable("code_review_request_result").findings.high).toHaveLength(1);
  });

  it("secret_scan fails on a real hardcoded secret", async () => {
    const repoRoot = await makeRepo({
      "src/config.ts": [
        'export const apiKey = "9f8a7b6c5d4e3f2a1b0c9d8e";',
        "export const url = process.env.API_URL;",
      ].join("\n"),
    });
    const context = makeContext(repoRoot, ["src/config.ts"]);
    const step = new DeterministicReviewStep({
      name: "security_request",
      type: "DeterministicReviewStep",
      config: {
        review_type: "security",
        output_prefix: "security_request",
        changed_files: ["src/config.ts"],
        block_on: ["severe"],
        rules: [{ id: "secret_scan", severity: "severe" }],
      },
    });

    const result = await step.execute(context);
    expect(result.status).toBe("success");
    expect(context.getVariable("security_request_status")).toBe("fail");
    expect(context.getVariable("security_request_result").findings.severe).toHaveLength(1);
  });

  it("secret_scan passes on placeholders and env refs", async () => {
    const repoRoot = await makeRepo({
      "src/config.ts": [
        'const apiKey = "your-api-key-here";',
        'const token = "fixture_api_token_not_a_secret";',
        "const secret = process.env.SECRET;",
      ].join("\n"),
    });
    const context = makeContext(repoRoot, ["src/config.ts"]);
    const step = new DeterministicReviewStep({
      name: "security_request",
      type: "DeterministicReviewStep",
      config: {
        review_type: "security",
        output_prefix: "security_request",
        changed_files: ["src/config.ts"],
        block_on: ["severe", "high"],
        rules: [{ id: "secret_scan", severity: "severe" }],
      },
    });

    const result = await step.execute(context);
    expect(result.status).toBe("success");
    expect(context.getVariable("security_request_status")).toBe("pass");
  });

  it("detects methods larger than configured limits", async () => {
    const repoRoot = await makeRepo({
      "src/service.ts": [
        "export function tooLarge() {",
        "  const a = 1;",
        "  const b = 2;",
        "  const c = 3;",
        "  return a + b + c;",
        "}",
      ].join("\n"),
    });
    const context = makeContext(repoRoot, ["src/service.ts"]);

    const step = new DeterministicReviewStep({
      name: "review",
      type: "DeterministicReviewStep",
      config: {
        changed_files: ["src/service.ts"],
        block_on: ["high"],
        rules: [{ id: "method_size", max_lines: 4, severity: "high" }],
      },
    });

    await step.execute(context);

    const review = context.getVariable("review_result");
    expect(review.status).toBe("fail");
    expect(review.findings.high[0]).toMatchObject({
      rule_id: "method_size",
      file: "src/service.ts",
      line: 1,
    });
  });

  it("alerts on duplicated code without blocking when severity is not in block_on", async () => {
    const duplicate = [
      "const first = input.trim();",
      "const second = first.toLowerCase();",
      "const third = second.replaceAll(' ', '-');",
    ].join("\n");
    const repoRoot = await makeRepo({
      "src/a.ts": `export function a(input: string) {\n${duplicate}\nreturn third;\n}`,
      "src/b.ts": `export function b(input: string) {\n${duplicate}\nreturn third;\n}`,
    });
    const context = makeContext(repoRoot, ["src/a.ts", "src/b.ts"]);

    const step = new DeterministicReviewStep({
      name: "review",
      type: "DeterministicReviewStep",
      config: {
        changed_files: ["src/a.ts", "src/b.ts"],
        block_on: ["high"],
        rules: [{ id: "duplicate_code", min_lines: 3, severity: "medium" }],
      },
    });

    await step.execute(context);

    const review = context.getVariable("review_result");
    expect(review.status).toBe("pass");
    expect(review.findings.medium[0]).toMatchObject({
      rule_id: "duplicate_code",
      file: "src/a.ts",
    });
  });

  it("fails when a file-task changes files outside its file label", async () => {
    const repoRoot = await makeRepo({
      "src/openapi/document.ts": "export const openApiDocument = {};\n",
      "src/routes/health.ts": "export function registerHealthRoutes() {}\n",
    });
    const context = makeContext(repoRoot, [
      "src/openapi/document.ts",
      "src/routes/health.ts",
    ]);
    context.setVariable("task", {
      id: "66",
      labels: [
        "change_file",
        "change:openapi-layer",
        "file:src/openapi/document.ts",
      ],
    });

    const step = new DeterministicReviewStep({
      name: "qa_request",
      type: "DeterministicReviewStep",
      config: {
        output_prefix: "qa_request",
        block_on: ["high"],
        rules: [
          {
            id: "allowed_files",
            severity: "high",
            from_task_file_labels: true,
          },
        ],
      },
    });

    await step.execute(context);

    expect(context.getVariable("qa_request_status")).toBe("fail");
    const findings = context.getVariable("qa_request_result").findings;
    expect(findings.high[0]).toMatchObject({
      rule_id: "allowed_files",
      file: "src/routes/health.ts",
    });
  });
});

describe("DeterministicReviewStep test_coverage rule", () => {
  const coverageStep = (extra: Record<string, any> = {}) =>
    new DeterministicReviewStep({
      name: "qa_request",
      type: "DeterministicReviewStep",
      config: {
        output_prefix: "qa_request",
        block_on: ["severe", "high"],
        rules: [{ id: "test_coverage", severity: "medium", ...extra }],
      },
    });

  it("flags a changed module that no test imports", async () => {
    const repoRoot = await makeRepo({
      "src/views/HomeView.tsx": "export function HomeView() { return null; }\n",
      "tests/other.test.ts": 'import { other } from "../src/other.js";\n',
    });
    const context = makeContext(repoRoot, ["src/views/HomeView.tsx"]);

    const result = await coverageStep().execute(context);

    const findings = context.getVariable("qa_request_result").findings;
    expect(findings.medium.map((f: any) => f.file)).toContain(
      "src/views/HomeView.tsx",
    );
    expect(result.status).toBe("success");
  });

  it("accepts a module imported by a test whose filename does not match", async () => {
    const repoRoot = await makeRepo({
      "src/git/operations/BranchOperations.ts":
        "export function syncBranchWithBase() { return true; }\n",
      "tests/syncBranchWithBase.test.ts":
        'import { syncBranchWithBase } from "../src/git/operations/BranchOperations.js";\n',
    });
    const context = makeContext(repoRoot, [
      "src/git/operations/BranchOperations.ts",
    ]);

    await coverageStep().execute(context);

    const findings = context.getVariable("qa_request_result").findings;
    expect(findings.medium).toHaveLength(0);
  });

  it("accepts a module reached through a dynamic import in a test", async () => {
    const repoRoot = await makeRepo({
      "src/thing.ts": "export const thing = 1;\n",
      "tests/thing.test.ts":
        'const { thing } = await import("../src/thing.js");\n',
    });
    const context = makeContext(repoRoot, ["src/thing.ts"]);

    await coverageStep().execute(context);

    expect(context.getVariable("qa_request_result").findings.medium).toHaveLength(0);
  });

  it("ignores type-only modules that have nothing to execute", async () => {
    const repoRoot = await makeRepo({
      "src/types.ts": "export type Project = { id: number; name: string };\n",
      "tests/other.test.ts": 'import { other } from "../src/other.js";\n',
    });
    const context = makeContext(repoRoot, ["src/types.ts"]);

    await coverageStep().execute(context);

    expect(context.getVariable("qa_request_result").findings.medium).toHaveLength(0);
  });

  it("ignores the test files in the change itself, even when they export helpers", async () => {
    const repoRoot = await makeRepo({
      "src/thing.ts": "export const thing = 1;\n",
      "tests/thing.test.ts":
        'import { thing } from "../src/thing.js";\nexport const makeFixture = () => thing;\n',
    });
    const context = makeContext(repoRoot, ["tests/thing.test.ts"]);

    await coverageStep().execute(context);

    expect(context.getVariable("qa_request_result").findings.medium).toHaveLength(0);
  });

  it("honours exclude patterns for generated or entrypoint files", async () => {
    const repoRoot = await makeRepo({
      "src/main.tsx": "export function main() { return 1; }\n",
      "tests/other.test.ts": 'import { other } from "../src/other.js";\n',
    });
    const context = makeContext(repoRoot, ["src/main.tsx"]);

    await coverageStep({ exclude: ["src/main.tsx"] }).execute(context);

    expect(context.getVariable("qa_request_result").findings.medium).toHaveLength(0);
  });

  it("reports once when the repository has no tests at all", async () => {
    const repoRoot = await makeRepo({
      "src/a.ts": "export const a = 1;\n",
      "src/b.ts": "export const b = 2;\n",
    });
    const context = makeContext(repoRoot, ["src/a.ts", "src/b.ts"]);

    await coverageStep().execute(context);

    const findings = context.getVariable("qa_request_result").findings;
    expect(findings.medium).toHaveLength(1);
    expect(findings.medium[0].issue).toContain("no test files");
  });

  it("does not scan node_modules for test files", async () => {
    const repoRoot = await makeRepo({
      "src/thing.ts": "export const thing = 1;\n",
      "node_modules/pkg/thing.test.js":
        'import { thing } from "../src/thing.js";\n',
    });
    const context = makeContext(repoRoot, ["src/thing.ts"]);

    await coverageStep().execute(context);

    const findings = context.getVariable("qa_request_result").findings;
    expect(findings.medium).toHaveLength(1);
  });
});

describe("test_coverage ratchet on new work", () => {
  const ratchetStep = () =>
    new DeterministicReviewStep({
      name: "qa_request",
      type: "DeterministicReviewStep",
      config: {
        output_prefix: "qa_request",
        block_on: ["severe", "high"],
        rules: [
          { id: "test_coverage", severity: "medium", new_file_severity: "high" },
        ],
      },
    });

  it("blocks a new uncovered file so debt cannot grow", async () => {
    const repoRoot = await makeRepo({
      "src/views/NewView.tsx": "export function NewView() { return null; }\n",
      "tests/other.test.ts": 'import { other } from "../src/other.js";\n',
    });
    const context = makeContext(
      repoRoot,
      ["src/views/NewView.tsx"],
      ["src/views/NewView.tsx"],
    );

    await ratchetStep().execute(context);

    expect(context.getVariable("qa_request_status")).toBe("fail");
    const findings = context.getVariable("qa_request_result").findings;
    expect(findings.high.map((f: any) => f.file)).toContain("src/views/NewView.tsx");
    expect(findings.high[0].issue).toContain("new file");
  });

  it("only advises on a pre-existing uncovered file that the task touched", async () => {
    const repoRoot = await makeRepo({
      "src/legacy.ts": "export function legacy() { return 1; }\n",
      "tests/other.test.ts": 'import { other } from "../src/other.js";\n',
    });
    const context = makeContext(repoRoot, ["src/legacy.ts"], []);

    await ratchetStep().execute(context);

    expect(context.getVariable("qa_request_status")).toBe("pass");
    const findings = context.getVariable("qa_request_result").findings;
    expect(findings.medium.map((f: any) => f.file)).toContain("src/legacy.ts");
    expect(findings.high).toHaveLength(0);
  });

  it("passes a new file that ships with its test", async () => {
    const repoRoot = await makeRepo({
      "src/views/NewView.tsx": "export function NewView() { return null; }\n",
      "src/views/NewView.test.tsx":
        'import { NewView } from "./NewView";\nexpect(NewView).toBeDefined();\n',
    });
    const context = makeContext(
      repoRoot,
      ["src/views/NewView.tsx", "src/views/NewView.test.tsx"],
      ["src/views/NewView.tsx", "src/views/NewView.test.tsx"],
    );

    await ratchetStep().execute(context);

    expect(context.getVariable("qa_request_status")).toBe("pass");
    const findings = context.getVariable("qa_request_result").findings;
    expect(findings.high).toHaveLength(0);
    expect(findings.medium).toHaveLength(0);
  });

  it("does not flag a barrel that only re-exports other modules", async () => {
    const repoRoot = await makeRepo({
      "src/index.ts":
        'export { a } from "./a.js";\nexport { b } from "./b.js";\nexport type { C } from "./c.js";\n',
      "tests/other.test.ts": 'import { other } from "../src/other.js";\n',
    });
    const context = makeContext(repoRoot, ["src/index.ts"], ["src/index.ts"]);

    await ratchetStep().execute(context);

    expect(context.getVariable("qa_request_status")).toBe("pass");
    const findings = context.getVariable("qa_request_result").findings;
    expect(findings.high).toHaveLength(0);
    expect(findings.medium).toHaveLength(0);
  });

  it("still flags a module that re-exports and also defines its own logic", async () => {
    const repoRoot = await makeRepo({
      "src/mixed.ts":
        'export { a } from "./a.js";\nexport function compute() { return 1; }\n',
      "tests/other.test.ts": 'import { other } from "../src/other.js";\n',
    });
    const context = makeContext(repoRoot, ["src/mixed.ts"], ["src/mixed.ts"]);

    await ratchetStep().execute(context);

    expect(context.getVariable("qa_request_status")).toBe("fail");
  });

  it("does not block a new type-only module", async () => {
    const repoRoot = await makeRepo({
      "src/model.ts": "export type Model = { id: number };\n",
      "tests/other.test.ts": 'import { other } from "../src/other.js";\n',
    });
    const context = makeContext(repoRoot, ["src/model.ts"], ["src/model.ts"]);

    await ratchetStep().execute(context);

    expect(context.getVariable("qa_request_status")).toBe("pass");
  });

  it("does not block when a new test file is the only addition", async () => {
    const repoRoot = await makeRepo({
      "src/thing.ts": "export const thing = 1;\n",
      "tests/thing.test.ts": 'import { thing } from "../src/thing.js";\n',
    });
    const context = makeContext(
      repoRoot,
      ["tests/thing.test.ts"],
      ["tests/thing.test.ts"],
    );

    await ratchetStep().execute(context);

    expect(context.getVariable("qa_request_status")).toBe("pass");
  });
});
