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

    const projectValidation = steps["run_project_validation"];
    expect(projectValidation).toBeDefined();
    expect((projectValidation as any)?.type).toBe("QAStep");
    expect(projectValidation?.depends_on).toEqual(["pre_qa_auto_repair"]);
    expect(projectValidation?.condition).toBe(
      "detected_test_command.length > 0",
    );
    expect(projectValidation?.config?.testCommand).toBe(
      "${detected_test_command}",
    );
    expect(projectValidation?.config?.softFail).toBe(true);

    const postValidationRepair = steps["post_project_validation_auto_repair"];
    expect(postValidationRepair).toBeDefined();
    expect(postValidationRepair?.depends_on).toEqual([
      "persist_project_validation_signal",
    ]);
    expect(postValidationRepair?.condition).toBe(
      "project_validation_error.length > 0",
    );

    const rerunProjectValidation = steps["rerun_project_validation"];
    expect(rerunProjectValidation).toBeDefined();
    expect((rerunProjectValidation as any)?.type).toBe("QAStep");
    expect(rerunProjectValidation?.depends_on).toEqual([
      "post_project_validation_auto_repair",
    ]);
    expect(rerunProjectValidation?.config?.softFail).toBe(false);

    const syncBranch = steps["sync_branch_with_base"];
    expect(syncBranch).toBeDefined();
    expect((syncBranch as any)?.type).toBe("GitOperationStep");
    expect(syncBranch?.depends_on).toEqual(["rerun_project_validation"]);
    expect(syncBranch?.config?.operation).toBe("syncBranchWithBase");

    const mergePreflight = steps["merge_preflight_validation"];
    expect(mergePreflight).toBeDefined();
    expect((mergePreflight as any)?.type).toBe("QAStep");
    expect(mergePreflight?.depends_on).toEqual(["sync_branch_with_base"]);
    expect(mergePreflight?.condition).toBe(
      "merge_preflight_required == true && detected_test_command.length > 0",
    );
    expect(mergePreflight?.config?.softFail).toBe(false);

    const verifyDiff = steps["verify_diff"];
    expect(verifyDiff).toBeDefined();
    expect(verifyDiff?.depends_on).toEqual(["merge_preflight_validation"]);

    const collectDiff = steps["collect_review_diff"];
    expect(collectDiff).toBeDefined();
    expect(collectDiff?.depends_on).toEqual(["ensure_branch_published"]);

    const mutationTest = steps["mutation_test"];
    expect(mutationTest).toBeDefined();
    expect((mutationTest as any)?.type).toBe("MutationTestStep");
    expect(mutationTest?.depends_on).toEqual(["collect_review_diff"]);
    expect(mutationTest?.config?.block_on_survivors).toBe(false);

    const qaRequest = steps["qa_request"];
    expect(qaRequest).toBeDefined();
    expect(qaRequest?.depends_on).toEqual(["collect_review_diff", "mutation_test"]);

    const codeReview = steps["code_review_request"];
    expect(codeReview).toBeDefined();
    expect(codeReview?.depends_on).toEqual(["mark_task_in_review"]);
    expect(codeReview?.condition).toBe("${qa_request_status} == 'pass'");
    expect((codeReview as any)?.type).toBe("DeterministicReviewStep");
    expect(codeReview?.config?.output_prefix).toBe("code_review_request");
    expect(codeReview?.config?.rules?.map((rule: any) => rule.id)).toContain(
      "duplicate_code",
    );

    const handleCodeReviewFailure = steps["handle_code_review_failure"];
    expect(handleCodeReviewFailure).toBeDefined();
    expect(handleCodeReviewFailure?.depends_on).toEqual([
      "code_review_request",
      "load_existing_tasks",
    ]);
    expect(handleCodeReviewFailure?.condition).toBe(
      "${code_review_request_status} == 'fail'",
    );
    expect(handleCodeReviewFailure?.config?.workflow).toBe(
      "review-failure-handling",
    );

    const security = steps["security_request"];
    expect(security).toBeDefined();
    expect(security?.depends_on).toEqual(["code_review_request"]);
    expect(security?.condition).toBe("${qa_request_status} == 'pass' && ${code_review_request_status} != 'fail'");

    const handleSecurityFailure = steps["handle_security_failure"];
    expect(handleSecurityFailure).toBeDefined();
    expect(handleSecurityFailure?.depends_on).toEqual([
      "security_request",
      "load_existing_tasks",
    ]);
    expect(handleSecurityFailure?.condition).toBe(
      "${security_request_status} == 'fail'",
    );
    expect(handleSecurityFailure?.config?.workflow).toBe(
      "review-failure-handling",
    );

    const devops = steps["devops_request"];
    expect(devops).toBeDefined();
    expect(devops?.depends_on).toEqual(["security_request"]);
    expect(devops?.condition).toBe("${qa_request_status} == 'pass' && ${code_review_request_status} != 'fail' && ${security_request_status} != 'fail'");
    const handleDevOpsFailure = steps["handle_devops_failure"];
    expect(handleDevOpsFailure).toBeDefined();
    expect(handleDevOpsFailure?.depends_on).toEqual(["devops_request"]);
    expect(handleDevOpsFailure?.condition).toBe(
      "${devops_request_status} == 'fail'",
    );
    expect(handleDevOpsFailure?.config?.workflow).toBe(
      "review-failure-handling",
    );

    const markDone = steps["mark_task_done"];
    expect(markDone).toBeDefined();
    expect(markDone?.depends_on).toEqual(["merge_branch_to_main"]);
    expect(markDone?.condition).toBe("${qa_request_status} == 'pass' && ${code_review_request_status} != 'fail' && ${security_request_status} != 'fail' && ${devops_request_status} != 'fail'");
    expect(markDone?.config?.status).toBe("done");

    const mergeToMain = steps["merge_branch_to_main"];
    expect(mergeToMain).toBeDefined();
    expect(mergeToMain?.depends_on).toEqual(["devops_request"]);
    expect(mergeToMain?.condition).toBe(markDone?.condition);
  });

  it("ensures QA failure handling does not block mark_in_review when skipped", async () => {
    const steps = await loadWorkflowSteps();

    const handleQaFailure = steps["handle_qa_failure"];
    const markInReview = steps["mark_task_in_review"];

    expect(handleQaFailure?.condition).toBe(
      "${qa_request_status} != 'pass'",
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
    expect(codeReview?.condition).toBe("${qa_request_status} == 'pass'");

    expect(security?.depends_on).toEqual(["code_review_request"]);
    expect(security?.condition).toBe("${qa_request_status} == 'pass' && ${code_review_request_status} != 'fail'");

    expect(devops?.depends_on).toEqual(["security_request"]);
    expect(devops?.condition).toBe("${qa_request_status} == 'pass' && ${code_review_request_status} != 'fail' && ${security_request_status} != 'fail'");

    expect(markDone?.depends_on).toEqual(["merge_branch_to_main"]);
    expect(markDone?.condition).toBe("${qa_request_status} == 'pass' && ${code_review_request_status} != 'fail' && ${security_request_status} != 'fail' && ${devops_request_status} != 'fail'");
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
      expect(pmEvaluation?.condition).toBe(
        "normalize_review_failure.has_blocking_issues == true && auto_follow_up_synthesis.auto_follow_up_count == 0",
      );
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

    it("Code/Security/DevOps receive diff payloads for implementation review", async () => {
      const templates = await loadStepTemplates();

      const codePayload = templates?.code_review?.config?.payload ?? {};
      const securityPayload = templates?.security_review?.config?.payload ?? {};
      const devopsPayload = templates?.devops_review?.config?.payload ?? {};

      for (const payload of [codePayload, securityPayload, devopsPayload]) {
        expect(payload.repo_diff_patch).toBe("${review_diff_patch}");
        expect(payload.repo_diff_summary).toBe("${review_diff_summary}");
        expect(payload.repo_changed_files).toBe("${review_diff_files}");
      }
    });

    it("qa_review is a deterministic review, not a model persona", async () => {
      const templates = await loadStepTemplates();
      expect(templates?.qa_review?.type).toBe("DeterministicReviewStep");
      expect(
        templates?.qa_review?.config?.rules?.map((r: any) => r.id),
      ).toContain("conflict_markers");
      expect(templates?.qa_review?.config?.payload).toBeUndefined();
    });

    it("qa_review reports missing test coverage without blocking the merge", async () => {
      const templates = await loadStepTemplates();
      const rules = templates?.qa_review?.config?.rules ?? [];
      const coverage = rules.find((r: any) => r.id === "test_coverage");

      expect(coverage).toBeDefined();
      expect(coverage.enabled).not.toBe(false);

      const blockOn: string[] = templates?.qa_review?.config?.block_on ?? [];
      expect(blockOn).not.toContain(coverage.severity);
    });
  });
});
