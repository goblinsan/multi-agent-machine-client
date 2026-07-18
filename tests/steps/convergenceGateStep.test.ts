import { beforeEach, describe, expect, it, vi } from "vitest";
import { WorkflowContext } from "../../src/workflows/engine/WorkflowContext.js";
import { ConvergenceGateStep } from "../../src/workflows/steps/ConvergenceGateStep.js";
import { isEscalationRequired } from "../../src/workflows/escalation/escalationRequired.js";

const mocks = vi.hoisted(() => ({
  fetchArtifactContentFromApi: vi.fn(),
  publishArtifactToDashboard: vi.fn(),
  updateTaskStatus: vi.fn(),
}));

vi.mock("../../src/workflows/helpers/artifactReader.js", () => ({
  fetchArtifactContentFromApi: mocks.fetchArtifactContentFromApi,
}));

vi.mock("../../src/workflows/helpers/artifactPublisher.js", () => ({
  publishArtifactToDashboard: mocks.publishArtifactToDashboard,
}));

vi.mock("../../src/dashboard/TaskAPI.js", () => ({
  TaskAPI: class {
    updateTaskStatus = mocks.updateTaskStatus;
  },
}));

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
  context.setVariable("taskId", 42);
  context.setVariable("task", { id: 42 });
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
  beforeEach(() => {
    mocks.fetchArtifactContentFromApi.mockReset().mockResolvedValue(null);
    mocks.publishArtifactToDashboard.mockReset().mockResolvedValue(true);
    mocks.updateTaskStatus
      .mockReset()
      .mockResolvedValue({ ok: true, status: 200, body: {} });
  });

  it("passes when the gates are green", async () => {
    const c = ctx({ changeSlug: "openapi", qa_request_status: "pass", testsPassed: true });
    const result = await step().execute(c);
    expect(result.status).toBe("success");
    expect(c.getVariable("convergence_status")).toBe("pass");
    expect(mocks.publishArtifactToDashboard).not.toHaveBeenCalled();
    expect(mocks.updateTaskStatus).not.toHaveBeenCalled();
  });

  it("persists attempts and requeues the converge task on the first failed attempt", async () => {
    const c = ctx({
      changeSlug: "openapi",
      qa_request_status: "fail",
      testsPassed: true,
      convergence_attempts: 0,
    });
    const result = await step().execute(c);
    expect(result.status).toBe("success");
    expect(result.data?.outcome).toBe("retry");
    expect(c.getVariable("convergence_status")).toBe("retry");
    expect(c.getVariable("convergence_attempts")).toBe(1);
    expect(c.getVariable("workflow_stop_requested")).toBe(true);
    expect(c.getVariable("workflow_stop_reason")).toBe("convergence_retry");
    expect(mocks.publishArtifactToDashboard).toHaveBeenCalledWith(
      expect.objectContaining({
        projectId: "project-1",
        taskId: 42,
        kind: "convergence_attempts",
      }),
    );
    expect(mocks.updateTaskStatus).toHaveBeenCalledWith("42", "open", "project-1");
  });

  it("counts testsPassed=false as a failure", async () => {
    const c = ctx({ changeSlug: "openapi", qa_request_status: "pass", testsPassed: false, convergence_attempts: 0 });
    const result = await step().execute(c);
    expect(result.status).toBe("success");
    expect(c.getVariable("convergence_status")).toBe("retry");
  });

  it("loads persisted attempts when a retry re-run starts with a fresh context", async () => {
    mocks.fetchArtifactContentFromApi.mockResolvedValue(
      JSON.stringify({ changeSlug: "openapi", attempts: 1, maxAttempts: 2 }),
    );
    const c = ctx({
      changeSlug: "openapi",
      qa_request_status: "fail",
      testsPassed: true,
    });
    let thrown: unknown;
    try {
      await step().execute(c);
    } catch (err) {
      thrown = err;
    }
    expect(isEscalationRequired(thrown)).toBe(true);
    expect(c.getVariable("convergence_attempts")).toBe(2);
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
