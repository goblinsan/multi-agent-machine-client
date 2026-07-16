import { describe, it, expect } from "vitest";
import { DiffParser } from "../src/agents/parsers/DiffParser";

function opCount(raw: string): number {
  const parsed = DiffParser.parsePersonaResponse(raw);
  return parsed.success ? parsed.editSpec?.ops?.length ?? 0 : 0;
}

const fileBlock = [
  "```file path=src/views/ProjectsView.tsx",
  'import { apiGet } from "../api";',
  "export function ProjectsView() {",
  "  return null;",
  "}",
  "```",
].join("\n");

describe("DiffParser edit detection", () => {
  it("recognizes a full-file rewrite block as applicable edits", () => {
    expect(opCount(fileBlock)).toBeGreaterThan(0);
  });

  it("recognizes edits even when an info_request is also present", () => {
    const mixed =
      fileBlock +
      "\n" +
      JSON.stringify({
        status: "info_request",
        requests: [{ type: "repo_file", path: "src/types.ts" }],
      });
    expect(opCount(mixed)).toBeGreaterThan(0);
  });

  it("returns no ops for a pure information request", () => {
    const infoOnly = JSON.stringify({
      status: "info_request",
      requests: [{ type: "repo_file", path: "src/types.ts" }],
    });
    expect(opCount(infoOnly)).toBe(0);
  });

  it("returns no ops for empty input", () => {
    expect(opCount("")).toBe(0);
  });
});
