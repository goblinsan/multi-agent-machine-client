import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs/promises";
import os from "os";
import path from "path";
import { repairRelativeImportErrors } from "../src/workflows/steps/helpers/importPathRepair";

describe("repairRelativeImportErrors", () => {
  let repo: string;

  beforeEach(async () => {
    repo = await fs.mkdtemp(path.join(os.tmpdir(), "import-repair-"));
    await fs.mkdir(path.join(repo, "src/config"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "src/config/schema.ts"),
      "export type Config = { name: string };\n",
    );
    await fs.writeFile(
      path.join(repo, "src/config/index.ts"),
      "export type { Config } from './config/schema';\nexport { defaults } from './defaults';\n",
    );
    await fs.writeFile(
      path.join(repo, "src/config/defaults.ts"),
      "export const defaults = {};\n",
    );
  });

  afterEach(async () => {
    await fs.rm(repo, { recursive: true, force: true });
  });

  it("fixes the duplicated-directory-segment mistake", async () => {
    const repairs = await repairRelativeImportErrors(
      repo,
      [
        {
          file: "src/config/index.ts",
          code: "TS2307",
          message: "Cannot find module './config/schema' or its corresponding type declarations.",
        },
      ],
      ["src/config/index.ts"],
    );

    expect(repairs).toEqual([
      { file: "src/config/index.ts", from: "./config/schema", to: "./schema" },
    ]);
    const content = await fs.readFile(
      path.join(repo, "src/config/index.ts"),
      "utf-8",
    );
    expect(content).toContain("from './schema'");
    expect(content).not.toContain("./config/schema");
    expect(content).toContain("from './defaults'");
  });

  it("skips ambiguous targets", async () => {
    await fs.mkdir(path.join(repo, "src/config/nested"), { recursive: true });
    await fs.writeFile(
      path.join(repo, "src/config/nested/util.ts"),
      "export const a = 1;\n",
    );
    await fs.writeFile(path.join(repo, "src/util.ts"), "export const b = 2;\n");
    await fs.writeFile(
      path.join(repo, "src/config/util.ts"),
      "export const c = 3;\n",
    );
    await fs.writeFile(
      path.join(repo, "src/config/index.ts"),
      "import { a } from './bogus/util';\n",
    );

    const repairs = await repairRelativeImportErrors(
      repo,
      [
        {
          file: "src/config/index.ts",
          code: "TS2307",
          message: "Cannot find module './bogus/util'.",
        },
      ],
      ["src/config/index.ts"],
    );

    expect(repairs).toEqual([]);
  });

  it("ignores non-2307 errors, absolute specs, and out-of-scope files", async () => {
    const repairs = await repairRelativeImportErrors(
      repo,
      [
        {
          file: "src/config/index.ts",
          code: "TS1005",
          message: "',' expected.",
        },
        {
          file: "src/config/index.ts",
          code: "TS2307",
          message: "Cannot find module 'left-pad'.",
        },
        {
          file: "src/other.ts",
          code: "TS2307",
          message: "Cannot find module './config/schema'.",
        },
      ],
      ["src/config/index.ts"],
    );

    expect(repairs).toEqual([]);
  });

  it("trims hallucinated package subpaths down to an installed package root", async () => {
    await fs.mkdir(path.join(repo, "node_modules/@testing-library/react"), {
      recursive: true,
    });
    await fs.writeFile(
      path.join(repo, "node_modules/@testing-library/react/package.json"),
      '{"name":"@testing-library/react"}\n',
    );
    await fs.writeFile(
      path.join(repo, "src/config/index.ts"),
      "import { render } from '@testing-library/react/dom';\n",
    );

    const repairs = await repairRelativeImportErrors(
      repo,
      [
        {
          file: "src/config/index.ts",
          code: "TS2307",
          message:
            "Cannot find module '@testing-library/react/dom' or its corresponding type declarations.",
        },
      ],
      ["src/config/index.ts"],
    );

    expect(repairs).toEqual([
      {
        file: "src/config/index.ts",
        from: "@testing-library/react/dom",
        to: "@testing-library/react",
      },
    ]);
    const content = await fs.readFile(
      path.join(repo, "src/config/index.ts"),
      "utf-8",
    );
    expect(content).toContain("from '@testing-library/react'");
    expect(content).not.toContain("react/dom");
  });

  it("leaves package subpaths alone when the package is not installed", async () => {
    await fs.writeFile(
      path.join(repo, "src/config/index.ts"),
      "import { x } from 'ghost-pkg/sub';\n",
    );

    const repairs = await repairRelativeImportErrors(
      repo,
      [
        {
          file: "src/config/index.ts",
          code: "TS2307",
          message: "Cannot find module 'ghost-pkg/sub'.",
        },
      ],
      ["src/config/index.ts"],
    );

    expect(repairs).toEqual([]);
  });

  it("matches errors that only carry a reason string", async () => {
    const repairs = await repairRelativeImportErrors(
      repo,
      [
        {
          file: "src/config/index.ts",
          reason:
            "Typecheck TS2307 at src/config/index.ts:1:29 - Cannot find module './config/schema' or its corresponding type declarations.",
        },
      ],
      ["src/config/index.ts"],
    );

    expect(repairs).toHaveLength(1);
    expect(repairs[0].to).toBe("./schema");
  });
});
