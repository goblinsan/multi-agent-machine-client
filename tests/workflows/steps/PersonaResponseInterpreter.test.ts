import { describe, expect, it } from "vitest";
import { PersonaResponseInterpreter } from "../../../src/workflows/steps/helpers/PersonaResponseInterpreter";

describe("PersonaResponseInterpreter", () => {
  const interpreter = new PersonaResponseInterpreter();

  const interpret = (raw: string) =>
    interpreter.interpret(raw, "tester-qa", "wf", "qa", "corr", {
      fields: { result: raw },
    });

  it("forces fail when QA reports missing test framework", () => {
    const raw = `{"status":"pass","test_framework":"no test framework found","summary":{"passed":0,"failed":0,"skipped":0}}`;

    const { statusInfo } = interpret(raw);

    expect(statusInfo.status).toBe("fail");
    expect(statusInfo.details).toContain("framework");
  });

  it("forces fail when zero tests executed despite pass status", () => {
    const raw = `{"status":"pass","test_framework":"vitest","summary":{"passed":0,"failed":0,"skipped":0}}`;

    const { statusInfo } = interpret(raw);

    expect(statusInfo.status).toBe("fail");
    expect(statusInfo.details).toContain("tests were executed");
  });

  it("keeps pass status during TDD red phase", () => {
    const raw = `{"status":"pass","test_framework":"no test framework found","summary":{"passed":0,"failed":0,"skipped":0},"tdd_red_phase_detected":true}`;

    const { statusInfo } = interpret(raw);

    expect(statusInfo.status).toBe("pass");
  });
});
