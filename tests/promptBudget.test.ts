import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cfg } from "../src/config";
import { buildPersonaMessages } from "../src/personas/PersonaRequestHandler";

describe("buildPersonaMessages prompt budget", () => {
  const originalBudget = cfg.personaPromptMaxChars;

  beforeEach(() => {
    (cfg as any).personaPromptMaxChars = 5000;
  });

  afterEach(() => {
    (cfg as any).personaPromptMaxChars = originalBudget;
  });

  it("leaves prompts under budget untouched", () => {
    const messages = buildPersonaMessages({
      persona: "lead-engineer",
      systemPrompt: "You are the lead engineer.",
      userText: "Fix the bug.",
      scanSummaryForPrompt: "small summary",
      promptFileSnippets: [{ path: "src/a.ts", content: "const a = 1;" }],
    });

    expect(messages[0].content).toContain("small summary");
    expect(messages[0].content).not.toContain("trimmed to fit prompt budget");
  });

  it("trims the largest context sections when over budget", () => {
    const hugeSummary = "S".repeat(20000);
    const snippetContent = "C".repeat(8000);

    const messages = buildPersonaMessages({
      persona: "lead-engineer",
      systemPrompt: "You are the lead engineer.",
      userText: "Fix the bug.",
      scanSummaryForPrompt: hugeSummary,
      promptFileSnippets: [{ path: "src/a.ts", content: snippetContent }],
    });

    const system = messages[0].content;
    expect(system).toContain("trimmed to fit prompt budget");
    expect(system.length).toBeLessThan(12000);
    expect(system).toContain("You are the lead engineer.");
    expect(messages[1].content).toBe("Fix the bug.");
  });

  it("never trims the system prompt or user text", () => {
    const messages = buildPersonaMessages({
      persona: "tester-qa",
      systemPrompt: "P".repeat(4000),
      userText: "U".repeat(4000),
      scanSummaryForPrompt: "S".repeat(10000),
    });

    expect(messages[0].content).toContain("P".repeat(4000));
    expect(messages[1].content).toBe("U".repeat(4000));
  });

  it("ignores the budget when disabled", () => {
    (cfg as any).personaPromptMaxChars = 0;
    const messages = buildPersonaMessages({
      persona: "lead-engineer",
      systemPrompt: "sys",
      userText: "user",
      scanSummaryForPrompt: "S".repeat(20000),
    });
    expect(messages[0].content).toContain("S".repeat(20000));
  });
});
