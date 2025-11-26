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

  async function loadReviewFailureWorkflowSteps() {
    const workflowPath = path.resolve(
      process.cwd(),
      "src/workflows/sub-workflows/review-failure-handling.yaml",
    );
    const fileContent = await readFile(workflowPath, "utf-8");
    const workflow = parse(fileContent) as {
      steps: Array<{
        name: string;
        type: string;
        depends_on?: string[];
        condition?: string;
        config?: any;
      }>;
    };
    return Object.fromEntries(workflow.steps.map((step) => [step.name, step]));
  }

  async function loadReviewFailureWorkflow() {
    const workflowPath = path.resolve(
      process.cwd(),
      "src/workflows/sub-workflows/review-failure-handling.yaml",
    );
    const fileContent = await readFile(workflowPath, "utf-8");
    return parse(fileContent) as Record<string, any>;
  }

  async function loadStepTemplates() {
    const templatePath = path.resolve(
      process.cwd(),
      "src/workflows/templates/step-templates.yaml",
    );
    const fileContent = await readFile(templatePath, "utf-8");
    const templates = parse(fileContent) as {
      templates: Record<
        string,
        {
          config?: { payload?: Record<string, any> };
        }
      >;
    };
    return templates.templates;
  }

  it("validates workflow structure: QA pass → mark in_review → code review → security → done", async () => {
    const steps = await loadWorkflowSteps();

    const markInReview = steps["mark_task_in_review"];
    expect(markInReview).toBeDefined();
    expect(markInReview?.depends_on).toEqual(["qa_request"]);
    expect(markInReview?.condition).toBe("${qa_request_status} == 'pass'");
    expect(markInReview?.config?.status).toBe("in_review");

    const collectDiff = steps["collect_review_diff"];
    expect(collectDiff).toBeDefined();
    expect(collectDiff?.depends_on).toEqual(["ensure_branch_published"]);

    const qaRequest = steps["qa_request"];
    expect(qaRequest).toBeDefined();
    expect(qaRequest?.depends_on).toEqual(["collect_review_diff"]);

    const codeReview = steps["code_review_request"];
    expect(codeReview).toBeDefined();
    expect(codeReview?.depends_on).toEqual(["mark_task_in_review"]);
    expect(codeReview?.condition).toBeUndefined();
    expect((codeReview as any)?.template).toBe("code_review");

    const handleCodeReviewFailure = steps["handle_code_review_failure"];
    expect(handleCodeReviewFailure).toBeDefined();
    expect(handleCodeReviewFailure?.depends_on).toEqual([
      "code_review_request",
      "load_existing_tasks",
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
    expect(handleSecurityFailure?.depends_on).toEqual([
      "security_request",
      "load_existing_tasks",
    ]);
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

  describe("review-failure-handling sub-workflow", () => {
    it("normalizes review payloads and filters follow-ups before task creation", async () => {
      const steps = await loadReviewFailureWorkflowSteps();
      const normalizeStep = steps["normalize_review_failure"];
      const filterStep = steps["filter_follow_up_tasks"];
      const coverageStep = steps["enforce_follow_up_coverage"];
      const createStep = steps["create_tasks_bulk"];

      expect(normalizeStep).toBeDefined();
      expect(normalizeStep?.type).toBe("ReviewFailureNormalizationStep");
      expect(normalizeStep?.depends_on).toEqual(["check_tdd_gate"]);
      expect(normalizeStep?.config?.review_type).toBe("${review_type}");
      expect(normalizeStep?.config?.review_result).toBe("${review_result}");

      expect(filterStep).toBeDefined();
      expect(filterStep?.type).toBe("ReviewFollowUpFilterStep");
      expect(filterStep?.depends_on).toEqual(["merge_follow_up_tasks"]);
      expect(filterStep?.condition).toBeUndefined();

      expect(coverageStep).toBeDefined();
      expect(coverageStep?.type).toBe("ReviewFollowUpCoverageStep");
      expect(coverageStep?.depends_on).toEqual(["filter_follow_up_tasks"]);
      expect(coverageStep?.config?.follow_up_tasks).toBe(
        "${filter_follow_up_tasks.filtered_tasks || []}",
      );
      expect(coverageStep?.config?.normalized_review).toBe(
        "${normalize_review_failure.normalized_review}",
      );

      expect(createStep?.depends_on).toEqual(["enforce_follow_up_coverage"]);
      expect(createStep?.condition).toBe(
        "enforce_follow_up_coverage.follow_up_tasks.length > 0",
      );
    });

    it("registers new blocked dependencies after task creation", async () => {
      const steps = await loadReviewFailureWorkflowSteps();
      const registerStep = steps["register_follow_up_dependencies"];

      expect(registerStep).toBeDefined();
      expect(registerStep?.type).toBe("RegisterBlockedDependenciesStep");
      expect(registerStep?.depends_on).toEqual(["collect_dependency_ids"]);
      expect(registerStep?.condition).toBe(
        "parent_task_id && collect_dependency_ids.dependency_task_ids.length > 0",
      );
      expect(registerStep?.config?.project_id).toBe("${project_id}");
      expect(registerStep?.config?.parent_task_id).toBe("${parent_task_id}");
      expect(registerStep?.config?.dependency_task_ids).toBe(
        "${collect_dependency_ids.dependency_task_ids}",
      );
    });

    it("passes rich review context into the PM evaluation payload", async () => {
      const steps = await loadReviewFailureWorkflowSteps();
      const pmEvaluation = steps["pm_evaluation"];

      expect(pmEvaluation).toBeDefined();
      expect(pmEvaluation?.depends_on).toEqual([
        "normalize_review_failure",
        "auto_follow_up_synthesis",
      ]);
      expect(pmEvaluation?.config?.payload?.review_result).toBe("${review_result}");
      expect(pmEvaluation?.config?.payload?.review_status).toBe("${review_status}");
      expect(pmEvaluation?.config?.payload?.diff_summary).toBe("${diff_summary || ''}");
      expect(pmEvaluation?.config?.payload?.diff_changed_files).toBe(
        "${diff_changed_files || []}",
      );
      expect(pmEvaluation?.config?.payload?.normalized_review).toBe(
        "${normalize_review_failure.normalized_review}",
      );
      expect(pmEvaluation?.config?.payload?.auto_follow_up_summary).toBe(
        "${auto_follow_up_synthesis.auto_follow_up_summary}",
      );
      expect(pmEvaluation?.config?.payload?.auto_follow_up_tasks).toBe(
        "${auto_follow_up_synthesis.auto_follow_up_tasks || []}",
      );
    });

    it("uses deterministic external ids for review follow-up tasks", async () => {
      const steps = await loadReviewFailureWorkflowSteps();
      const createStep = steps["create_tasks_bulk"];

      expect(createStep?.config?.options?.external_id_template).toBe(
        "${review_type}-${task.id}",
      );
    });

    it("exposes normalized review outputs to parent workflows", async () => {
      const workflow = await loadReviewFailureWorkflow();
      const outputs = workflow.outputs ?? {};

      expect(outputs.normalized_review).toBe(
        "${normalize_review_failure.normalized_review}",
      );
      expect(outputs.blocking_issue_count).toBe(
        "${normalize_review_failure.blocking_issue_count || 0}",
      );
      expect(outputs.has_blocking_issues).toBe(
        "${normalize_review_failure.has_blocking_issues || false}",
      );
    });
  });

  describe("review templates", () => {
    it("only the planning personas reference the plan artifact", async () => {
      const templates = await loadStepTemplates();

      expect(
        templates?.implementation?.config?.payload?.plan_artifact,
      ).toBe(".ma/tasks/${task.id}/03-plan-final.md");

      expect(
        templates?.qa_review?.config?.payload?.plan_artifact,
      ).toBeUndefined();
      expect(
        templates?.code_review?.config?.payload?.plan_artifact,
      ).toBeUndefined();
      expect(
        templates?.security_review?.config?.payload?.plan_artifact,
      ).toBeUndefined();
      expect(
        templates?.devops_review?.config?.payload?.plan_artifact,
      ).toBeUndefined();
    });

    it("QA/Code/Security/DevOps receive diff payloads for implementation review", async () => {
      const templates = await loadStepTemplates();

      const qaPayload = templates?.qa_review?.config?.payload ?? {};
      const codePayload = templates?.code_review?.config?.payload ?? {};
      const securityPayload = templates?.security_review?.config?.payload ?? {};
      const devopsPayload = templates?.devops_review?.config?.payload ?? {};

      for (const payload of [qaPayload, codePayload, securityPayload, devopsPayload]) {
        expect(payload.repo_diff_patch).toBe("${review_diff_patch}");
        expect(payload.repo_diff_summary).toBe("${review_diff_summary}");
        expect(payload.repo_changed_files).toBe("${review_diff_files}");
      }
    });
  });
});
