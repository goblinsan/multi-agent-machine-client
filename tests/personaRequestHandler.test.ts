import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  buildPersonaMessages,
  callPersonaModel,
} from "../src/personas/PersonaRequestHandler.js";

vi.mock("../src/lmstudio.js", () => ({
  callLMStudio: vi.fn(async (_model: string, messages: any[]) => {
    const user = messages.filter((m: any) => m.role === "user").pop();
    return { content: `ok: ${user?.content?.slice(0, 10) || ""}` };
  }),
}));

describe("PersonaRequestHandler", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("builds messages with scan summary, dashboard, QA, planning, snippets, and extras", () => {
    const msgs = buildPersonaMessages({
      persona: "implementation-planner",
      systemPrompt: "You are a planner",
      userText: "Do the thing",
      scanSummaryForPrompt: "Files: 10",
      labelForScanSummary: "File scan summary",
      dashboardContext: "Tree: /src, Hotspots: a.ts",
      qaHistory: "Latest QA failed on test X",
      planningHistory: "Previous plan had 3 steps",
      promptFileSnippets: [{ path: "src/a.ts", content: "export const a=1" }],
      extraSystemMessages: ["Extra guidance here"],
    });

    expect(msgs[0].role).toBe("system");
    expect(msgs[0].content).toContain("You are a planner");
    expect(msgs.some((m) => m.content.includes("File scan summary"))).toBe(
      true,
    );
    expect(msgs.some((m) => m.content.includes("Dashboard context"))).toBe(
      true,
    );
    expect(msgs.some((m) => m.content.includes("Latest QA Test Results"))).toBe(
      true,
    );
    expect(
      msgs.some((m) => m.content.includes("Previous Planning Iterations")),
    ).toBe(true);
    expect(
      msgs.some((m) =>
        m.content.includes("Existing project files for reference"),
      ),
    ).toBe(true);
    expect(msgs.some((m) => m.content.includes("Extra guidance here"))).toBe(
      true,
    );
    expect(msgs[msgs.length - 1].role).toBe("user");
    expect(msgs[msgs.length - 1].content).toContain("Do the thing");
  });

  it("calls model and returns response content and duration", async () => {
    const messages = buildPersonaMessages({
      persona: "context",
      systemPrompt: "You are context",
      userText: "Scan repo",
      scanSummaryForPrompt: "Files: 2",
      labelForScanSummary: "Authoritative file scan summary",
    });

    const res = await callPersonaModel({
      persona: "context",
      model: "foo:bar",
      messages,
      timeoutMs: 1000,
    });
    expect(res.content).toContain("ok: Scan repo");
    expect(typeof res.duration_ms).toBe("number");
    expect(res.duration_ms).toBeGreaterThanOrEqual(0);
  });
});
