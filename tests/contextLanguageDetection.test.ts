import { describe, it, expect } from "vitest";
import { SYSTEM_PROMPTS } from "../src/personas.js";

describe("Context Persona Language Detection", () => {
  it("includes language detection instructions in context persona prompt", () => {
    const contextPrompt = SYSTEM_PROMPTS.context;

    expect(contextPrompt).toBeDefined();
    expect(contextPrompt).toContain("Primary Language");
    expect(contextPrompt).toContain("programming language");
    expect(contextPrompt).toContain("NON-EXHAUSTIVE");
    expect(contextPrompt).toContain("file extensions");
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

    expect(contextPrompt).toContain("build.gradle");
    expect(contextPrompt).toContain("Package.swift");
    expect(contextPrompt).toContain("Cargo.toml");
    expect(contextPrompt).toContain("pom.xml");
  });

  it("instructs to state language at beginning of output", () => {
    const contextPrompt = SYSTEM_PROMPTS.context;

    expect(contextPrompt).toContain("begin your output with");
    expect(contextPrompt).toContain("Primary Language:");
  });

  it("requires emitting a test command manifest", () => {
    const contextPrompt = SYSTEM_PROMPTS.context;

    expect(contextPrompt).toContain("test_command_manifest");
    expect(contextPrompt).toContain("candidates array");
  });
});
