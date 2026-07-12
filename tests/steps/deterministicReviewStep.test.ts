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

function makeContext(repoRoot: string, changedFiles: string[]): WorkflowContext {
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
});
