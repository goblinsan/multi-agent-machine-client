import { describe, it, expect, vi } from "vitest";
import fs from "fs/promises";
import path from "path";
import { execSync } from "child_process";
import { makeTempRepo } from "../makeTempRepo.js";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { QAStep } from "../../src/workflows/steps/QAStep.js";

vi.mock("../../src/logger.js", () => ({
  logger: {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  },
}));

const typecheckScript =
  "node -e \"const fs=require('fs'); const errs=[]; if(fs.existsSync('INHERITED.txt'))errs.push('src/inherited.ts(1,1): error TS2322: inherited residue.'); if(fs.existsSync('NEWBUG.txt'))errs.push('src/newbug.ts(1,1): error TS2300: fresh regression.'); if(errs.length){errs.forEach(e=>console.error(e)); process.exit(2);}\"";
const testScript = "node -e \"console.log('  Tests  1 passed (1)')\"";

async function setupRepo(): Promise<{ repo: string; runStart: string }> {
  const repo = await makeTempRepo();
  await fs.writeFile(
    path.join(repo, "package.json"),
    JSON.stringify({
      scripts: {
        typecheck: typecheckScript,
        test: testScript,
      },
    }),
    "utf-8",
  );
  execSync("git add . && git commit --no-verify -m base", { cwd: repo });
  execSync("git checkout -b task-branch", { cwd: repo });
  await fs.writeFile(path.join(repo, "INHERITED.txt"), "residue\n", "utf-8");
  execSync("git add . && git commit --no-verify -m residue", { cwd: repo });
  const runStart = execSync("git rev-parse HEAD", {
    cwd: repo,
    encoding: "utf-8",
  }).trim();
  await fs.writeFile(path.join(repo, "notes.md"), "current run change\n", "utf-8");
  execSync("git add . && git commit --no-verify -m current-run", { cwd: repo });
  return { repo, runStart };
}

function makeContext(repo: string): WorkflowContext {
  return new WorkflowContext(
    "wf-qa-inherited",
    "proj-1",
    repo,
    "task-branch",
    { steps: [] } as any,
    {} as any,
    {},
  );
}

function makeStep(): QAStep {
  return new QAStep({
    name: "rerun_project_validation",
    type: "QAStep",
    config: { testCommand: "npm test", retryCount: 0, timeout: 60000 },
  });
}

describe("QAStep inherited regression gating", () => {
  it("does not fail the current task for regressions inherited from earlier commits", async () => {
    const { repo, runStart } = await setupRepo();
    const context = makeContext(repo);
    context.setVariable("implementation_baseline_commit", runStart);

    const result = await makeStep().execute(context);

    expect(result.status, result.error?.message).toBe("success");
    const inherited = context.getVariable("qa_inherited_regressions") as {
      typecheck_errors: Array<{ file: string }>;
      run_start_commit: string;
    };
    expect(inherited).toBeDefined();
    expect(inherited.run_start_commit).toBe(runStart);
    expect(inherited.typecheck_errors).toHaveLength(1);
    expect(inherited.typecheck_errors[0].file).toContain("inherited");
  });

  it("still fails on regressions introduced during the current run", async () => {
    const { repo, runStart } = await setupRepo();
    await fs.writeFile(path.join(repo, "NEWBUG.txt"), "fresh\n", "utf-8");
    execSync("git add . && git commit --no-verify -m fresh-bug", { cwd: repo });
    const context = makeContext(repo);
    context.setVariable("implementation_baseline_commit", runStart);

    const result = await makeStep().execute(context);

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("1 typecheck");
  });

  it("falls back to merge-base gating without a recorded run-start commit", async () => {
    const { repo } = await setupRepo();
    const context = makeContext(repo);

    const result = await makeStep().execute(context);

    expect(result.status).toBe("failure");
    expect(result.error?.message).toContain("1 typecheck");
    expect(context.getVariable("qa_inherited_regressions")).toBeUndefined();
  });
});
