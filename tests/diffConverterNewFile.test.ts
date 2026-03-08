import { describe, it, expect } from "vitest";
import { parseDiffBlock } from "../src/agents/parsers/conversion/DiffConverter.js";

describe("parseDiffBlock new-file fallback", () => {
  it("creates upsert via hunks when content extraction returns null", () => {
    const block = {
      content: [
        "diff --git a/src/types/preview.ts b/src/types/preview.ts",
        "new file mode 100644",
        "--- /dev/null",
        "+++ b/src/types/preview.ts",
        "@@ -0,0 +1,5 @@",
        "+export interface Preview {",
        "+  raw: string;",
        "+  json?: unknown;",
        "+  status?: string;",
        "+}",
      ].join("\n"),
      type: "unified" as const,
    };

    const ops = parseDiffBlock(block);
    expect(ops.length).toBe(1);
    expect(ops[0].action).toBe("upsert");
    expect(ops[0].path).toBe("src/types/preview.ts");

    const upsert = ops[0] as any;
    const hasContent = upsert.content !== undefined;
    const hasHunks = Array.isArray(upsert.hunks) && upsert.hunks.length > 0;
    expect(hasContent || hasHunks).toBe(true);
  });

  it("creates upsert with content for standard new file diff", () => {
    const block = {
      content: [
        "diff --git a/src/utils/parser.ts b/src/utils/parser.ts",
        "--- /dev/null",
        "+++ b/src/utils/parser.ts",
        "@@ -0,0 +1,3 @@",
        "+export function parse(s: string) {",
        "+  return JSON.parse(s);",
        "+}",
      ].join("\n"),
      type: "unified" as const,
    };

    const ops = parseDiffBlock(block);
    expect(ops.length).toBe(1);
    expect(ops[0].action).toBe("upsert");
    expect(ops[0].path).toBe("src/utils/parser.ts");
  });
});
