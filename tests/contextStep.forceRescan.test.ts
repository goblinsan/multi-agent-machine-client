import { it, describe, expect, vi } from "vitest";
import { makeTempRepo } from "./makeTempRepo.js";
import { ContextStep } from "../src/workflows/steps/ContextStep.js";
import { WorkflowContext } from "../src/workflows/engine/WorkflowContext.js";
import * as scanModule from "../src/scanRepo.js";
import fs from "fs/promises";
import path from "path";

describe("ContextStep forceRescan behavior", () => {
  it("calls scanRepo when forceRescan=true", async () => {
    const tmp = await makeTempRepo();
    const repoRoot = tmp;

    
    const ctxDir = path.join(repoRoot, ".ma", "context");
    await fs.mkdir(ctxDir, { recursive: true });
    const snapshot = {
      timestamp: Date.now() - 1000 * 60 * 60,
      files: [],
      totals: { files: 0, bytes: 0 },
    };
    await fs.writeFile(path.join(ctxDir, "snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");
    await fs.writeFile(path.join(ctxDir, "summary.md"), "# summary", "utf8");
    await fs.writeFile(path.join(ctxDir, "files.ndjson"), "", "utf8");

    const scanSpy = vi.spyOn(scanModule, "scanRepo").mockResolvedValue([
      { path: "file.txt", bytes: 10, mtime: Date.now() },
    ] as any);

    const cfg = {
      name: "context_scan",
      type: "ContextStep",
      config: {
        repoPath: "${repo_root}",
        forceRescan: true,
      },
    } as any;

    const workflowCfg = { name: "wf", version: "1.0.0", steps: [] } as any;
    const ctx = new WorkflowContext("wf-1", "proj-1", repoRoot, "main", workflowCfg, {} as any, { force_rescan: true });

    ctx.setVariable("force_rescan", true);

    const step = new ContextStep(cfg);
    const res = await step.execute(ctx);

    const hadFullScan = scanSpy.mock.calls.some(
      (c: any[]) => !!c[0] && c[0].track_lines === true,
    );
    expect(scanSpy).toHaveBeenCalled();
    expect(hadFullScan).toBe(true);
    expect(res.status).toBe("success");
    expect(res.outputs?.reused_existing).toBe(false);

    scanSpy.mockRestore();
  });

  it("reuses existing context when forceRescan=false", async () => {
    const tmp = await makeTempRepo();
    const repoRoot = tmp;

    const ctxDir = path.join(repoRoot, ".ma", "context");
    await fs.mkdir(ctxDir, { recursive: true });
    const timestamp = Date.now() - 1000 * 60 * 60;
    const snapshot = {
      timestamp,
      files: [{ path: "file.txt", bytes: 10, mtime: timestamp }],
      totals: { files: 1, bytes: 10 },
    };
    await fs.writeFile(path.join(ctxDir, "snapshot.json"), JSON.stringify(snapshot, null, 2), "utf8");
    await fs.writeFile(path.join(ctxDir, "summary.md"), "# summary", "utf8");
    await fs.writeFile(path.join(ctxDir, "files.ndjson"), "", "utf8");

    const scanSpy = vi.spyOn(scanModule, "scanRepo").mockResolvedValue([
      { path: "file.txt", bytes: 10, mtime: timestamp },
    ] as any);

    const cfg = {
      name: "context_scan",
      type: "ContextStep",
      config: {
        repoPath: "${repo_root}",
        forceRescan: false,
      },
    } as any;

    const workflowCfg = { name: "wf", version: "1.0.0", steps: [] } as any;
    const ctx = new WorkflowContext("wf-2", "proj-1", repoRoot, "main", workflowCfg, {} as any, { force_rescan: false });


    const step = new ContextStep(cfg);
    const res = await step.execute(ctx);

    
    const hadFullScan2 = scanSpy.mock.calls.some(
      (c: any[]) => !!c[0] && c[0].track_lines === true,
    );
    expect(scanSpy).toHaveBeenCalled();
    expect(hadFullScan2).toBe(false);
    expect(res.status).toBe("success");
    expect(res.outputs?.reused_existing).toBe(true);

    scanSpy.mockRestore();
  });
});
