import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  extractExportNames,
  buildMissingExportDirective,
} from "../src/workflows/steps/helpers/missingExportDirective";

describe("extractExportNames", () => {
  it("extracts const/function/class/type/default and re-exports", () => {
    const source = [
      'import { x } from "./x";',
      "export const apiGet = 1;",
      "export const apiPost = 2;",
      "export function helper() {}",
      "export type Foo = string;",
      "export { a, b as c } from './y';",
      "export default class Widget {}",
    ].join("\n");
    const names = extractExportNames(source);
    expect(names).toEqual(
      expect.arrayContaining([
        "apiGet",
        "apiPost",
        "helper",
        "Foo",
        "a",
        "c",
        "default",
      ]),
    );
  });
});

describe("buildMissingExportDirective", () => {
  it("lists a module's real exports and the hallucinated one", async () => {
    const root = mkdtempSync(join(tmpdir(), "mexp-"));
    try {
      mkdirSync(join(root, "src"), { recursive: true });
      writeFileSync(
        join(root, "src", "api.ts"),
        "export const apiGet = 1;\nexport const apiPost = 2;\n",
      );
      const directive = await buildMissingExportDirective(root, [
        {
          file: "src/views/ProjectsView.tsx",
          message:
            'Module \'"../api"\' has no exported member \'fetchProjects\'.',
        },
      ]);
      expect(directive).toContain("apiGet");
      expect(directive).toContain("apiPost");
      expect(directive).toContain("fetchProjects");
      expect(directive).toContain("does NOT export");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns null when there is no missing-member error", async () => {
    const directive = await buildMissingExportDirective("/tmp", [
      { file: "a.ts", message: "Typecheck TS6133 'React' is declared" },
    ]);
    expect(directive).toBeNull();
  });

  it("ignores bare (non-relative) module specifiers", async () => {
    const directive = await buildMissingExportDirective("/tmp", [
      {
        file: "a.ts",
        message: "Module 'react' has no exported member 'useNope'.",
      },
    ]);
    expect(directive).toBeNull();
  });
});
