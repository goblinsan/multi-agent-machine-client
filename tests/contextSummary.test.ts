import { describe, it, expect } from "vitest";

import { buildContextSummary } from "../src/workflows/steps/context/contextSummary.js";
import type { FileInfo } from "../src/scanRepo.js";

function makeFile(path: string, bytes = 128, lines = 10): FileInfo {
  return {
    path,
    bytes,
    lines,
    mtime: Date.now(),
  };
}

describe("Context summary setup guidance", () => {
  it("emits setup commands and gaps derived from repo manifests", () => {
    const repoScan: FileInfo[] = [
      makeFile("package.json"),
      makeFile("package-lock.json"),
      makeFile("src/api.ts"),
      makeFile("api/requirements.txt"),
      makeFile("api/service.py"),
      makeFile("cmd/tool.go"),
    ];

    const metadata = {
      scannedAt: Date.now(),
      repoPath: "/tmp/example",
      fileCount: repoScan.length,
      totalBytes: repoScan.reduce((sum, file) => sum + file.bytes, 0),
      maxDepth: 3,
    };

    const summary = buildContextSummary({ repoScan, metadata });

    expect(summary.summary).toContain("## Local Environment Setup");
    expect(summary.summary).toContain("npm install --no-package-lock");
    expect(summary.summary).toContain("python -m pip install -r requirements.txt");
    expect(summary.summary).toContain("## Missing Setup Guidance");
    expect(summary.summary).toContain("Go");

    expect(summary.insights.setupCommands).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          ecosystem: "node",
          commands: ["npm install --no-package-lock"],
        }),
        expect.objectContaining({
          ecosystem: "python",
          commands: ["python -m pip install -r requirements.txt"],
        }),
      ]),
    );

    expect(summary.insights.setupGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ language: "Go" }),
      ]),
    );
  });
});
