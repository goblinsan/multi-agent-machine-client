import { describe, it, expect } from "vitest";
import { responseHasApplicableEdits } from "../src/workflows/steps/helpers/personaRequest/personaRequestExecutor";

const fileBlock = [
  "```file path=src/views/ProjectsView.tsx",
  'import { apiGet } from "../api";',
  "export function ProjectsView() {",
  "  return null;",
  "}",
  "```",
].join("\n");

describe("responseHasApplicableEdits", () => {
  it("recognizes a full-file rewrite block as applicable edits", () => {
    expect(responseHasApplicableEdits(fileBlock)).toBe(true);
  });

  it("recognizes edits even when an info_request is also present", () => {
    const mixed =
      fileBlock +
      "\n" +
      JSON.stringify({
        status: "info_request",
        requests: [{ type: "repo_file", path: "src/types.ts" }],
      });
    expect(responseHasApplicableEdits(mixed)).toBe(true);
  });

  it("returns false for a pure information request", () => {
    const infoOnly = JSON.stringify({
      status: "info_request",
      requests: [{ type: "repo_file", path: "src/types.ts" }],
    });
    expect(responseHasApplicableEdits(infoOnly)).toBe(false);
  });

  it("returns false for empty input", () => {
    expect(responseHasApplicableEdits("")).toBe(false);
  });
});
