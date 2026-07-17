import fs from "fs/promises";
import os from "os";
import path from "path";
import { describe, expect, it } from "vitest";

import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { MutationTestStep } from "../../src/workflows/steps/MutationTestStep.js";
import { generateMutants } from "../../src/workflows/helpers/mutationOperators.js";

async function makeRepo(files: Record<string, string>): Promise<string> {
  const repoRoot = await fs.mkdtemp(path.join(os.tmpdir(), "mutation-"));
  for (const [file, content] of Object.entries(files)) {
    const fullPath = path.join(repoRoot, file);
    await fs.mkdir(path.dirname(fullPath), { recursive: true });
    await fs.writeFile(fullPath, content, "utf8");
  }
  return repoRoot;
}

function makeContext(repoRoot: string, changedFiles: string[]): WorkflowContext {
  const context = new WorkflowContext(
    "wf-mutation",
    "project-mutation",
    repoRoot,
    "main",
    { name: "test", version: "1.0.0", steps: [] },
    {} as any,
  );
  context.setVariable("review_diff_files", changedFiles);
  return context;
}

function step(config: Record<string, any> = {}) {
  return new MutationTestStep({
    name: "mutation_test",
    type: "MutationTestStep",
    config: {
      output_prefix: "mutation",
      testCommand: "node --test",
      max_mutants_per_file: 4,
      mutant_timeout_ms: 20000,
      ...config,
    },
  });
}

const SOURCE = `export function isAdult(age) {
  return age >= 18 && age < 130;
}
`;

const STRONG_TEST = `import { test } from "node:test";
import assert from "node:assert";
import { isAdult } from "../src/rules.js";

test("at the lower boundary", () => { assert.strictEqual(isAdult(18), true); });
test("below the lower boundary", () => { assert.strictEqual(isAdult(17), false); });
test("at the upper boundary", () => { assert.strictEqual(isAdult(129), true); });
test("above the upper boundary", () => { assert.strictEqual(isAdult(130), false); });
`;

const WEAK_TEST = `import { test } from "node:test";
import assert from "node:assert";
import { isAdult } from "../src/rules.js";

test("returns something", () => { assert.ok(isAdult(20) !== undefined); });
`;

describe("mutation operators", () => {
  it("generates deterministic mutants for boolean and comparison logic", () => {
    const mutants = generateMutants("src/a.ts", "const ok = a === b && c;\n", 10);

    expect(mutants.map((m) => m.operator).sort()).toEqual([
      "equality",
      "logical_and",
    ]);
    expect(mutants.find((m) => m.operator === "equality")?.mutated).toContain("!==");
  });

  it("does not mutate imports or comments", () => {
    const source = [
      'import { a } from "./a.js";',
      "// this === that && other",
      "const real = x === y;",
    ].join("\n");

    const mutants = generateMutants("src/a.ts", source, 10);

    expect(mutants).toHaveLength(1);
    expect(mutants[0].line).toBe(3);
  });

  it("caps the mutant count deterministically", () => {
    const source = Array.from({ length: 20 }, (_, i) => `const v${i} = a === b;`).join("\n");

    const first = generateMutants("src/a.ts", source, 5);
    const second = generateMutants("src/a.ts", source, 5);

    expect(first).toHaveLength(5);
    expect(first.map((m) => m.line)).toEqual(second.map((m) => m.line));
  });

  it("mutates comparison boundaries, which is where off-by-one hides", () => {
    const mutants = generateMutants("src/a.ts", "return age >= 18 && age < 130;\n", 10);

    expect(mutants.map((m) => m.operator).sort()).toEqual([
      "boundary_gte",
      "boundary_lt",
      "logical_and",
    ]);
  });

  it("does not mutate TypeScript generics or arrow functions into syntax errors", () => {
    const tricky = [
      "const f = (a: Array<string>) => a.map((x) => x);",
      "const g: Promise<void> = h();",
    ].join("\n");

    expect(generateMutants("src/t.ts", tricky, 10)).toHaveLength(0);
  });

  it("produces no mutants for code with no mutable operators", () => {
    expect(generateMutants("src/a.ts", "export const greet = () => 1;\n", 10)).toHaveLength(0);
  });
});

describe("MutationTestStep", () => {
  it("reports no survivors when the tests actually constrain the code", async () => {
    const repoRoot = await makeRepo({
      "package.json": JSON.stringify({ name: "t", type: "module" }),
      "src/rules.js": SOURCE,
      "tests/rules.test.js": STRONG_TEST,
    });
    const context = makeContext(repoRoot, ["src/rules.js"]);

    const result = await step().execute(context);

    expect(result.status).toBe("success");
    const report = context.getVariable("mutation_result");
    expect(report.mutants_evaluated).toBeGreaterThan(0);
    expect(report.mutants_survived).toBe(0);
    expect(report.mutation_score).toBe(100);
  }, 60000);

  it("detects surviving mutants when the test asserts almost nothing", async () => {
    const repoRoot = await makeRepo({
      "package.json": JSON.stringify({ name: "t", type: "module" }),
      "src/rules.js": SOURCE,
      "tests/rules.test.js": WEAK_TEST,
    });
    const context = makeContext(repoRoot, ["src/rules.js"]);

    await step().execute(context);

    const report = context.getVariable("mutation_result");
    expect(report.mutants_survived).toBeGreaterThan(0);
    expect(report.mutation_score).toBeLessThan(100);
    expect(report.survivors[0]).toMatchObject({ file: "src/rules.js" });
  }, 60000);

  it("restores the original file after every mutant", async () => {
    const repoRoot = await makeRepo({
      "package.json": JSON.stringify({ name: "t", type: "module" }),
      "src/rules.js": SOURCE,
      "tests/rules.test.js": WEAK_TEST,
    });
    const context = makeContext(repoRoot, ["src/rules.js"]);

    await step().execute(context);

    const after = await fs.readFile(path.join(repoRoot, "src/rules.js"), "utf-8");
    expect(after).toBe(SOURCE);
  }, 60000);

  it("blocks only when configured to block on survivors", async () => {
    const repoRoot = await makeRepo({
      "package.json": JSON.stringify({ name: "t", type: "module" }),
      "src/rules.js": SOURCE,
      "tests/rules.test.js": WEAK_TEST,
    });
    const context = makeContext(repoRoot, ["src/rules.js"]);

    const result = await step({ block_on_survivors: true }).execute(context);

    expect(result.status).toBe("failure");
    expect(context.getVariable("mutation_status")).toBe("fail");
  }, 60000);

  it("skips a changed file that no test covers", async () => {
    const repoRoot = await makeRepo({
      "package.json": JSON.stringify({ name: "t", type: "module" }),
      "src/rules.js": SOURCE,
      "src/uncovered.js": "export const f = (a) => a === 1;\n",
      "tests/rules.test.js": STRONG_TEST,
    });
    const context = makeContext(repoRoot, ["src/uncovered.js"]);

    await step().execute(context);

    const report = context.getVariable("mutation_result");
    expect(report.reason).toBe("no_covered_source_changes");
    expect(report.mutants_evaluated).toBe(0);
  }, 60000);

  it("does not mutate when the covering tests are already failing", async () => {
    const repoRoot = await makeRepo({
      "package.json": JSON.stringify({ name: "t", type: "module" }),
      "src/rules.js": SOURCE,
      "tests/rules.test.js": STRONG_TEST.replace("isAdult(18), true", "isAdult(18), false"),
    });
    const context = makeContext(repoRoot, ["src/rules.js"]);

    await step().execute(context);

    const report = context.getVariable("mutation_result");
    expect(report.mutants_evaluated).toBe(0);
  }, 60000);

  it("reports no test command rather than guessing", async () => {
    const repoRoot = await makeRepo({ "src/rules.js": SOURCE });
    const context = makeContext(repoRoot, ["src/rules.js"]);

    await step({ testCommand: "" }).execute(context);

    expect(context.getVariable("mutation_result").reason).toBe("no_test_command");
  });
});
