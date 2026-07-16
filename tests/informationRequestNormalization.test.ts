import { describe, it, expect } from "vitest";
import { normalizeInformationRequests } from "../src/workflows/steps/helpers/informationRequest/normalization";

describe("normalizeInformationRequests — repo_file tolerance", () => {
  it("parses the 9B string form", () => {
    const out = normalizeInformationRequests({
      status: "info_request",
      requests: [{ repo_file: "src/api.ts", reason: "check types" }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "repo_file", path: "src/api.ts" });
  });

  it("parses the 14B object form with no explicit type", () => {
    const out = normalizeInformationRequests({
      status: "info_request",
      requests: [{ repo_file: { path: "src/api.ts" } }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ type: "repo_file", path: "src/api.ts" });
  });

  it("extracts nested start/end lines from the object form", () => {
    const out = normalizeInformationRequests({
      requests: [
        { repo_file: { path: "src/x.ts", start_line: 10, end_line: 20 } },
      ],
    });
    expect(out[0]).toMatchObject({
      type: "repo_file",
      path: "src/x.ts",
      startLine: 10,
      endLine: 20,
    });
  });

  it("handles an absolute path in the object form (path preserved for downstream normalization)", () => {
    const out = normalizeInformationRequests({
      requests: [{ repo_file: { path: "/Users/x/code/app/src/api.ts" } }],
    });
    expect(out).toHaveLength(1);
    expect(out[0].type).toBe("repo_file");
    expect((out[0] as { path: string }).path).toContain("src/api.ts");
  });

  it("still parses http_get and the explicit type form", () => {
    const out = normalizeInformationRequests({
      requests: [
        { type: "repo_file", path: "src/types.ts" },
        { http_get: "https://example.com/spec" },
      ],
    });
    expect(out.map((r) => r.type)).toEqual(["repo_file", "http_get"]);
  });
});
