import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { parse } from "yaml";

describe("Review Flow Validation", () => {
  async function loadWorkflowSteps() {
    const workflowPath = path.resolve(
      process.cwd(),
      "src/workflows/definitions/task-flow.yaml",
    );
    const fileContent = await readFile(workflowPath, "utf-8");
    const workflow = parse(fileContent) as {
      steps: Array<{
        name: string;
        depends_on?: string[];
        condition?: string;
        config?: any;
        outputs?: string[];
      }>;
    };
    return Object.fromEntries(workflow.steps.map((step) => [step.name, step]));
  }

  it("validates workflow structure: QA pass → mark in_review → code review → security → done", async () => {
    const steps = await loadWorkflowSteps();

    const markInReview = steps["mark_task_in_review"];
    expect(markInReview).toBeDefined();
    expect(markInReview?.depends_on).toEqual(["qa_request"]);
    expect(markInReview?.condition).toBe("${qa_request_status} == 'pass'");
    expect(markInReview?.config?.status).toBe("in_review");

    const codeReview = steps["code_review_request"];
    expect(codeReview).toBeDefined();
    expect(codeReview?.depends_on).toEqual(["mark_task_in_review"]);
    expect(codeReview?.condition).toBeUndefined();
    expect((codeReview as any)?.template).toBe("code_review");

    const handleCodeReviewFailure = steps["handle_code_review_failure"];
    expect(handleCodeReviewFailure).toBeDefined();
    expect(handleCodeReviewFailure?.depends_on).toEqual([
      "code_review_request",
    ]);
    expect(handleCodeReviewFailure?.condition).toBe(
      "${code_review_request_status} == 'fail' || ${code_review_request_status} == 'unknown'",
    );
    expect(handleCodeReviewFailure?.config?.workflow).toBe(
      "review-failure-handling",
    );

    const security = steps["security_request"];
    expect(security).toBeDefined();
    expect(security?.depends_on).toEqual(["code_review_request"]);
    expect(security?.condition).toBe("${code_review_request_status} == 'pass'");
    expect((security as any)?.template).toBe("security_review");

    const handleSecurityFailure = steps["handle_security_failure"];
    expect(handleSecurityFailure).toBeDefined();
    expect(handleSecurityFailure?.depends_on).toEqual(["security_request"]);
    expect(handleSecurityFailure?.condition).toBe(
      "${security_request_status} == 'fail' || ${security_request_status} == 'unknown'",
    );
    expect(handleSecurityFailure?.config?.workflow).toBe(
      "review-failure-handling",
    );

    const devops = steps["devops_request"];
    expect(devops).toBeDefined();
    expect(devops?.depends_on).toEqual(["security_request"]);
    expect(devops?.condition).toBe("${security_request_status} == 'pass'");

    const handleDevOpsFailure = steps["handle_devops_failure"];
    expect(handleDevOpsFailure).toBeDefined();
    expect(handleDevOpsFailure?.depends_on).toEqual(["devops_request"]);
    expect(handleDevOpsFailure?.condition).toBe(
      "${devops_request_status} == 'fail' || ${devops_request_status} == 'unknown'",
    );
    expect(handleDevOpsFailure?.config?.workflow).toBe(
      "review-failure-handling",
    );

    const markDone = steps["mark_task_done"];
    expect(markDone).toBeDefined();
    expect(markDone?.depends_on).toEqual(["devops_request"]);
    expect(markDone?.condition).toBe("${devops_request_status} == 'pass'");
    expect(markDone?.config?.status).toBe("done");
  });

  it("ensures QA failure handling does not block mark_in_review when skipped", async () => {
    const steps = await loadWorkflowSteps();

    const handleQaFailure = steps["handle_qa_failure"];
    const markInReview = steps["mark_task_in_review"];

    expect(handleQaFailure?.condition).toBe(
      "${qa_request_status} == 'fail' || ${qa_request_status} == 'unknown'",
    );

    expect(markInReview?.depends_on).toEqual(["qa_request"]);
    expect(markInReview?.depends_on).not.toContain("handle_qa_failure");
  });

  it("validates review flow is sequential: code review → security → devops → done", async () => {
    const steps = await loadWorkflowSteps();

    const codeReview = steps["code_review_request"];
    const security = steps["security_request"];
    const devops = steps["devops_request"];
    const markDone = steps["mark_task_done"];

    expect(codeReview?.depends_on).toEqual(["mark_task_in_review"]);

    expect(security?.depends_on).toEqual(["code_review_request"]);
    expect(security?.condition).toBe("${code_review_request_status} == 'pass'");

    expect(devops?.depends_on).toEqual(["security_request"]);
    expect(devops?.condition).toBe("${security_request_status} == 'pass'");

    expect(markDone?.depends_on).toEqual(["devops_request"]);
    expect(markDone?.condition).toBe("${devops_request_status} == 'pass'");
  });

  it("validates review failure handling steps exist for all review types", async () => {
    const steps = await loadWorkflowSteps();

    expect(steps["handle_code_review_failure"]).toBeDefined();
    expect(steps["handle_security_failure"]).toBeDefined();
    expect(steps["handle_devops_failure"]).toBeDefined();

    expect(steps["handle_code_review_failure"]?.config?.workflow).toBe(
      "review-failure-handling",
    );
    expect(steps["handle_security_failure"]?.config?.workflow).toBe(
      "review-failure-handling",
    );
    expect(steps["handle_devops_failure"]?.config?.workflow).toBe(
      "review-failure-handling",
    );

    expect(
      steps["handle_code_review_failure"]?.config?.inputs?.review_type,
    ).toBe("code_review");
    expect(steps["handle_security_failure"]?.config?.inputs?.review_type).toBe(
      "security_review",
    );
    expect(steps["handle_devops_failure"]?.config?.inputs?.review_type).toBe(
      "devops_review",
    );
  });

  it("validates workflow does not have circular dependencies in review flow", async () => {
    const steps = await loadWorkflowSteps();

    const visited = new Set<string>();
    const recursionStack = new Set<string>();

    function hasCycle(stepName: string): boolean {
      if (recursionStack.has(stepName)) {
        return true;
      }
      if (visited.has(stepName)) {
        return false;
      }

      visited.add(stepName);
      recursionStack.add(stepName);

      const step = steps[stepName];
      if (step?.depends_on) {
        for (const dep of step.depends_on) {
          if (hasCycle(dep)) {
            return true;
          }
        }
      }

      recursionStack.delete(stepName);
      return false;
    }

    for (const stepName of Object.keys(steps)) {
      expect(hasCycle(stepName)).toBe(false);
    }
  });
});
