import { describe, it, expect } from "vitest";
import { forcedResponseCarriesEdits } from "../src/workflows/steps/helpers/personaRequest/forcedImplementation";

const fileBlock = [
  "```file path=src/views/ProjectsView.tsx",
  'import { apiGet } from "../api";',
  "export function ProjectsView() {",
  "  return null;",
  "}",
  "```",
].join("\n");

const infoRequest = JSON.stringify({
  status: "info_request",
  requests: [{ type: "repo_file", path: "src/types.ts" }],
});

describe("forcedResponseCarriesEdits", () => {
  it("detects edits when the model text is wrapped in an output envelope", () => {
    const completion = {
      fields: { result: JSON.stringify({ output: fileBlock, duration_ms: 12 }) },
    };
    expect(forcedResponseCarriesEdits(completion, undefined)).toBe(true);
  });

  it("detects edits from a bare interpreted string", () => {
    expect(forcedResponseCarriesEdits({}, fileBlock)).toBe(true);
  });

  it("returns false for a pure info-request envelope", () => {
    const completion = {
      fields: { result: JSON.stringify({ output: infoRequest, duration_ms: 8 }) },
    };
    expect(forcedResponseCarriesEdits(completion, undefined)).toBe(false);
  });

  it("returns false for an empty completion", () => {
    expect(forcedResponseCarriesEdits({}, undefined)).toBe(false);
  });
});
