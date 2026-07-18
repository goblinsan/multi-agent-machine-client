import { describe, it, expect } from "vitest";
import { DiffParser } from "../src/agents/parsers/DiffParser.js";
import {
  extractDiffBlocks,
  extractFullFileBlocks,
} from "../src/agents/parsers/extraction/BlockExtractor.js";

describe("full-file rewrite parsing", () => {
  it("extracts a full-file block into a content upsert op", () => {
    const response = [
      "The file is corrupted, rewriting it in full.",
      "",
      "```file path=src/config/loader.ts",
      "import { defaults } from './defaults';",
      "",
      "export function getDefaults() {",
      "  return { ...defaults };",
      "}",
      "```",
      "",
      "Changed Files:",
      "- src/config/loader.ts",
      "Commit Message: fix loader",
    ].join("\n");

    const result = DiffParser.parsePersonaResponse(response);

    expect(result.success).toBe(true);
    expect(result.editSpec?.ops.length).toBe(1);
    const op = result.editSpec!.ops[0] as any;
    expect(op.action).toBe("upsert");
    expect(op.path).toBe("src/config/loader.ts");
    expect(op.hunks).toBeUndefined();
    expect(op.content).toContain("export function getDefaults()");
    expect(op.content).toContain("import { defaults } from './defaults';");
  });

  it("accepts the runtime lead-engineer file fence shape", () => {
    const response = [
      "```file path=src/openapi/document.ts",
      "export const openApiDocument = {",
      '  openapi: "3.0.3",',
      "  info: {",
      '    title: "Project Dashboard API",',
      '    version: "1.0.0",',
      "  },",
      "  paths: {",
      '    "/health": {',
      "      get: {",
      '        summary: "Health check",',
      '        responses: { "200": { description: "OK" } },',
      "      },",
      "    },",
      "  },",
      "} as const;",
      "```",
    ].join("\n");

    const result = DiffParser.parsePersonaResponse(response);

    expect(result.success).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.editSpec?.ops).toEqual([
      {
        action: "upsert",
        path: "src/openapi/document.ts",
        content: expect.stringContaining("openApiDocument"),
      },
    ]);
  });

  it("supports the rewrite keyword and quoted paths", () => {
    const response = [
      '```rewrite path="src/app.ts"',
      "export const app = true;",
      "```",
    ].join("\n");

    const { blocks } = extractFullFileBlocks(response);
    expect(blocks.length).toBe(1);
    expect(blocks[0].type).toBe("raw");
    expect(blocks[0].filename).toBe("src/app.ts");
    expect(blocks[0].content).toContain("export const app = true;");
  });

  it("keeps unified diffs and full-file blocks separate in one response", () => {
    const response = [
      "```diff",
      "--- a/src/keep.ts",
      "+++ b/src/keep.ts",
      "@@ -1,1 +1,1 @@",
      "-const a = 1;",
      "+const a = 2;",
      "```",
      "",
      "```file path=src/rewrite.ts",
      "export const rewritten = true;",
      "```",
    ].join("\n");

    const blocks = extractDiffBlocks(response);
    const raw = blocks.filter((b) => b.type === "raw");
    const unified = blocks.filter((b) => b.type !== "raw");
    expect(raw.length).toBe(1);
    expect(raw[0].filename).toBe("src/rewrite.ts");
    expect(unified.length).toBe(1);
    expect(unified[0].content).toContain("const a = 2;");
  });
});
