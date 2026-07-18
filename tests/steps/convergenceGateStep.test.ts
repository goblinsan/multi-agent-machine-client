import { describe, it, expect } from "vitest";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { ConvergenceGateStep } from "../../src/workflows/steps/ConvergenceGateStep.js";
import { isEscalationRequired } from "../../src/workflows/escalation/escalationRequired.js";

function ctx(vars: Record<string, any>): WorkflowContext {
  const context = new WorkflowContext(
    "wf-converge",
    "project-1",
    "/tmp/repo",
    "main",
    { name: "change-flow", version: "1.0.0", steps: [] },
    {} as any,
    {},
  );
  for (const [k, v] of Object.entries(vars)) context.setVariable(k, v);
  return context;
}

const step = (config: Record<string, any> = {}) =>
  new ConvergenceGateStep({
    name: "convergence_gate",
    type: "ConvergenceGateStep",
    config: {
      change_slug_variable: "changeSlug",
      attempts_variable: "convergence_attempts",
      max_attempts: 2,
      output_prefix: "convergence",
      ...config,
    },
  });

describe("ConvergenceGateStep", () => {
  it("passes when the gates are green", async () => {
    const c = ctx({ changeSlug: "openapi", qa_request_status: "pass", testsPassed: true });
    const result = await step().execute(c);
    expect(result.status).toBe("success");
    expect(c.getVariable("convergence_status")).toBe("pass");
  });

  it("returns a retriable failure on the first failed attempt", async () => {
    const c = ctx({
      changeSlug: "openapi",
      qa_request_status: "fail",
      testsPassed: true,
      convergence_attempts: 0,
    });
    const result = await step().execute(c);
    expect(result.status).toBe("failure");
    expect(c.getVariable("convergence_status")).toBe("retry");
    expect(c.getVariable("convergence_attempts")).toBe(1);
  });

  it("counts testsPassed=false as a failure", async () => {
    const c = ctx({ changeSlug: "openapi", qa_request_status: "pass", testsPassed: false, convergence_attempts: 0 });
    const result = await step().execute(c);
    expect(result.status).toBe("failure");
    expect(c.getVariable("convergence_status")).toBe("retry");
  });

  it("raises EscalationRequiredError once retries are exhausted", async () => {
    const c = ctx({
      changeSlug: "openapi",
      qa_request_status: "fail",
      testsPassed: true,
      convergence_attempts: 1,
      review_diff_files: ["src/routes/openapi.ts"],
      errorText: "registerOpenApiRoutes has 218 lines",
    });
    let thrown: unknown;
    try {
      await step().execute(c);
    } catch (err) {
      thrown = err;
    }
    expect(isEscalationRequired(thrown)).toBe(true);
    if (isEscalationRequired(thrown)) {
      expect(thrown.changeSlug).toBe("openapi");
      expect(thrown.attempts).toBe(2);
      expect(thrown.failingFiles.map((f) => f.path)).toContain("src/routes/openapi.ts");
      expect(thrown.convergenceErrors.join(" ")).toContain("218 lines");
    }
    expect(c.getVariable("convergence_status")).toBe("escalate");
  });

  it("honours a custom max_attempts", async () => {
    const c = ctx({ changeSlug: "x", qa_request_status: "fail", testsPassed: true, convergence_attempts: 0 });
    let thrown = false;
    try {
      await step({ max_attempts: 1 }).execute(c);
    } catch {
      thrown = true;
    }
    expect(thrown).toBe(true);
  });
});
