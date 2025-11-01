import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPTS } from "../src/personas.js";

describe("Context Persona Language Detection", () => {
  it("includes language detection instructions in context persona prompt", () => {
    const contextPrompt = SYSTEM_PROMPTS.context;

    expect(contextPrompt).toBeDefined();
    expect(contextPrompt).toContain("Primary Language");
    expect(contextPrompt).toContain("programming language");
    expect(contextPrompt).toContain("file extensions");
    expect(contextPrompt).toContain("TypeScript");
    expect(contextPrompt).toContain("Python");
  });

  it("instructs context persona to check PROJECT_PLAN.md for technology stack", () => {
    const contextPrompt = SYSTEM_PROMPTS.context;

    expect(contextPrompt).toContain("PROJECT_PLAN.md");
    expect(contextPrompt).toContain("technology stack");
  });

  it("warns against using wrong language conventions", () => {
    const contextPrompt = SYSTEM_PROMPTS.context;

    expect(contextPrompt).toContain("CORRECT language file conventions");
    expect(contextPrompt).toContain("language-appropriate file naming");
  });

  it("provides examples of language detection heuristics", () => {
    const contextPrompt = SYSTEM_PROMPTS.context;

    expect(contextPrompt).toContain(".ts/.tsx");
    expect(contextPrompt).toContain(".py");
    expect(contextPrompt).toContain("package.json");
    expect(contextPrompt).toContain("requirements.txt");
  });

  it("instructs to state language at beginning of output", () => {
    const contextPrompt = SYSTEM_PROMPTS.context;

    expect(contextPrompt).toContain("begin your output with");
    expect(contextPrompt).toContain("Primary Language:");
  });
});
