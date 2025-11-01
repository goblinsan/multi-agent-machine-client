import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { ContextStep } from "../src/workflows/steps/ContextStep.js";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import { makeTempRepo } from "./makeTempRepo.js";
import { LocalTransport } from "../src/transport/LocalTransport.js";
import * as fs from "fs/promises";
import * as path from "path";

describe("Context Cache Reuse", () => {
  let tempRepoDir: string;
  let context: WorkflowContext;
  let transport: LocalTransport;

  beforeEach(async () => {
    tempRepoDir = await makeTempRepo({
      "README.md": "# Test Project\n",
      "src/index.ts": 'console.log("hello");\n',
      "src/utils.ts": "export const add = (a: number, b: number) => a + b;\n",
    });

    transport = new LocalTransport();
    await transport.connect();

    context = new WorkflowContext(
      "test-workflow",
      "1",
      tempRepoDir,
      "main",
      { name: "test", version: "1.0", steps: [] },
      transport,
      {
        task: { id: "1", title: "Test", description: "Test", type: "feature" },
      },
    );
  });

  afterEach(async () => {
    await transport.disconnect();
  });

  it("should perform initial scan and write context artifacts", async () => {
    const step = new ContextStep({
      name: "context_scan",
      type: "ContextStep",
      config: {
        repoPath: tempRepoDir,
        includePatterns: ["**/*"],
        excludePatterns: ["node_modules/**", ".git/**"],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false,
      },
    });

    const result = await step.execute(context);

    expect(result.status).toBe("success");
    expect(result.outputs?.reused_existing).toBe(false);
    expect(result.outputs?.repoScan).toHaveLength(3);

    const snapshotPath = path.join(tempRepoDir, ".ma/context/snapshot.json");
    const summaryPath = path.join(tempRepoDir, ".ma/context/summary.md");

    const snapshotExists = await fs
      .access(snapshotPath)
      .then(() => true)
      .catch(() => false);
    const summaryExists = await fs
      .access(summaryPath)
      .then(() => true)
      .catch(() => false);

    expect(snapshotExists).toBe(true);
    expect(summaryExists).toBe(true);

    const snapshotContent = await fs.readFile(snapshotPath, "utf-8");
    const snapshot = JSON.parse(snapshotContent);
    expect(snapshot.files).toHaveLength(3);
    expect(snapshot.totals.files).toBe(3);
  });

  it("should reuse existing context when source files unchanged", async () => {
    const step1 = new ContextStep({
      name: "context_scan",
      type: "ContextStep",
      config: {
        repoPath: tempRepoDir,
        includePatterns: ["**/*"],
        excludePatterns: ["node_modules/**", ".git/**", ".ma/**"],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false,
      },
    });

    const result1 = await step1.execute(context);
    expect(result1.status).toBe("success");
    expect(result1.outputs?.reused_existing).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const step2 = new ContextStep({
      name: "context_scan",
      type: "ContextStep",
      config: {
        repoPath: tempRepoDir,
        includePatterns: ["**/*"],
        excludePatterns: ["node_modules/**", ".git/**", ".ma/**"],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false,
      },
    });

    const result2 = await step2.execute(context);

    expect(result2.status).toBe("success");
    expect(result2.outputs?.reused_existing).toBe(true);
    expect(result2.outputs?.repoScan).toHaveLength(3);
  });

  it("should rescan when source files are modified", async () => {
    const step1 = new ContextStep({
      name: "context_scan",
      type: "ContextStep",
      config: {
        repoPath: tempRepoDir,
        includePatterns: ["**/*"],
        excludePatterns: ["node_modules/**", ".git/**"],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false,
      },
    });

    const result1 = await step1.execute(context);
    expect(result1.status).toBe("success");
    expect(result1.outputs?.reused_existing).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 100));

    await fs.writeFile(
      path.join(tempRepoDir, "src/index.ts"),
      'console.log("modified");\n',
      "utf-8",
    );

    const step2 = new ContextStep({
      name: "context_scan",
      type: "ContextStep",
      config: {
        repoPath: tempRepoDir,
        includePatterns: ["**/*"],
        excludePatterns: ["node_modules/**", ".git/**"],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false,
      },
    });

    const result2 = await step2.execute(context);

    expect(result2.status).toBe("success");
    expect(result2.outputs?.reused_existing).toBe(false);

    expect(result2.outputs?.repoScan.length).toBeGreaterThan(0);
  });

  it("should NOT rescan when only .ma/ files change", async () => {
    const step1 = new ContextStep({
      name: "context_scan",
      type: "ContextStep",
      config: {
        repoPath: tempRepoDir,
        includePatterns: ["**/*"],
        excludePatterns: ["node_modules/**", ".git/**", ".ma/**"],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false,
      },
    });

    const result1 = await step1.execute(context);
    expect(result1.status).toBe("success");

    await new Promise((resolve) => setTimeout(resolve, 100));

    await fs.mkdir(path.join(tempRepoDir, ".ma/tasks"), { recursive: true });
    await fs.writeFile(
      path.join(tempRepoDir, ".ma/tasks/plan.md"),
      "# Plan\n",
      "utf-8",
    );

    const step2 = new ContextStep({
      name: "context_scan",
      type: "ContextStep",
      config: {
        repoPath: tempRepoDir,
        includePatterns: ["**/*"],
        excludePatterns: ["node_modules/**", ".git/**", ".ma/**"],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false,
      },
    });

    const result2 = await step2.execute(context);

    expect(result2.status).toBe("success");
    expect(result2.outputs?.reused_existing).toBe(true);
  });

  it("should force rescan when forceRescan is true", async () => {
    const step1 = new ContextStep({
      name: "context_scan",
      type: "ContextStep",
      config: {
        repoPath: tempRepoDir,
        includePatterns: ["**/*"],
        excludePatterns: ["node_modules/**", ".git/**"],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false,
      },
    });

    const result1 = await step1.execute(context);
    expect(result1.status).toBe("success");
    expect(result1.outputs?.reused_existing).toBe(false);

    const step2 = new ContextStep({
      name: "context_scan",
      type: "ContextStep",
      config: {
        repoPath: tempRepoDir,
        includePatterns: ["**/*"],
        excludePatterns: ["node_modules/**", ".git/**"],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: true,
      },
    });

    const result2 = await step2.execute(context);

    expect(result2.status).toBe("success");
    expect(result2.outputs?.reused_existing).toBe(false);
  });

  it("should set reused_existing flag correctly in step outputs", async () => {
    const step1 = new ContextStep({
      name: "context_scan",
      type: "ContextStep",
      config: {
        repoPath: tempRepoDir,
        includePatterns: ["**/*"],
        excludePatterns: ["node_modules/**", ".git/**", ".ma/**"],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false,
      },
    });

    const result1 = await step1.execute(context);

    expect(result1.status).toBe("success");
    expect(result1.outputs?.reused_existing).toBe(false);

    await new Promise((resolve) => setTimeout(resolve, 100));

    const step2 = new ContextStep({
      name: "context_scan",
      type: "ContextStep",
      config: {
        repoPath: tempRepoDir,
        includePatterns: ["**/*"],
        excludePatterns: ["node_modules/**", ".git/**", ".ma/**"],
        maxFiles: 100,
        maxBytes: 1024 * 1024,
        maxDepth: 10,
        trackLines: true,
        trackHash: false,
        forceRescan: false,
      },
    });

    const result2 = await step2.execute(context);

    expect(result2.status).toBe("success");
    expect(result2.outputs?.reused_existing).toBe(true);

    const stepOutputs = context.getStepOutput("context_scan");
    if (stepOutputs) {
      expect(stepOutputs.reused_existing).toBe(true);
    }
  });
});
