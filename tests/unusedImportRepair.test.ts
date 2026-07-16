import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { repairUnusedImports } from "../src/workflows/steps/helpers/unusedImportRepair";

function setup(content: string): { root: string; rel: string } {
  const root = mkdtempSync(join(tmpdir(), "uimp-"));
  const rel = "src/View.tsx";
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, rel), content, "utf-8");
  return { root, rel };
}

function err(file: string, name: string) {
  return {
    file,
    code: "TS6133",
    message: `'${name}' is declared but its value is never read.`,
  };
}

describe("repairUnusedImports", () => {
  it("removes an unused default import line entirely", async () => {
    const { root, rel } = setup(
      'import React from "react";\nexport const x = 1;\n',
    );
    try {
      const repairs = await repairUnusedImports(root, [err(rel, "React")]);
      const out = readFileSync(join(root, rel), "utf-8");
      expect(repairs[0].removed).toContain("React");
      expect(out).not.toContain("import React");
      expect(out).toContain("export const x = 1;");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("removes only the unused named specifier, keeps the used one", async () => {
    const { root, rel } = setup(
      'import { useState, useEffect } from "react";\nuseEffect(() => {});\n',
    );
    try {
      await repairUnusedImports(root, [err(rel, "useState")]);
      const out = readFileSync(join(root, rel), "utf-8");
      expect(out).toContain("useEffect");
      expect(out).not.toContain("useState");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("drops the default but keeps named when default is unused", async () => {
    const { root, rel } = setup(
      'import React, { useState } from "react";\nuseState();\n',
    );
    try {
      await repairUnusedImports(root, [err(rel, "React")]);
      const out = readFileSync(join(root, rel), "utf-8");
      expect(out).toMatch(/import \{ useState \} from "react";/);
      expect(out).not.toMatch(/import React/);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("leaves non-import unused locals untouched", async () => {
    const { root, rel } = setup(
      'export function f() {\n  const unusedLocal = 1;\n  return 2;\n}\n',
    );
    try {
      const repairs = await repairUnusedImports(root, [
        err(rel, "unusedLocal"),
      ]);
      const out = readFileSync(join(root, rel), "utf-8");
      expect(repairs).toHaveLength(0);
      expect(out).toContain("const unusedLocal = 1;");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
