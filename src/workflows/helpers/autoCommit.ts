import type { WorkflowContext } from "../engine/WorkflowContext.js";
import type { WorkflowStep } from "../engine/WorkflowStep.js";
import type { WorkingTreeEntry } from "../../git/queries.js";
import { commitAndPushPaths, describeWorkingTree } from "../../gitUtils.js";
import { abortWorkflowDueToPushFailure } from "./workflowAbort.js";

export async function ensureAutoCommitAfterStep(options: {
  context: WorkflowContext;
  step: WorkflowStep;
}): Promise<void> {
  const { context, step } = options;
  const repoRoot = context.repoRoot;
  if (!repoRoot) {
    return;
  }

  const stepConfig = step.config?.config ?? {};
  if (stepConfig.autoCommit === false) {
    return;
  }

  const workingTree = await describeWorkingTree(repoRoot);
  if (!workingTree?.dirty) {
    return;
  }

  const changedPaths = collectPaths(workingTree.entries);
  if (changedPaths.length === 0) {
    return;
  }

  const branch =
    context.getVariable("branch") ||
    context.getVariable("currentBranch") ||
    context.branch;

  const customMessage =
    typeof stepConfig.autoCommitMessage === "string"
      ? stepConfig.autoCommitMessage.trim()
      : "";
  const message =
    customMessage.length > 0
      ? customMessage
      : `auto-commit ${step.config.name}`;

  context.logger.info("auto-commit pending after step", {
    step: step.config.name,
    branch,
    changedPaths: changedPaths.length,
  });

  const result = await commitAndPushPaths({
    repoRoot,
    branch,
    message,
    paths: changedPaths,
  });

  context.setVariable("lastAutoCommit", {
    step: step.config.name,
    branch: result.branch || branch,
    committed: result.committed,
    pushed: result.pushed,
    reason: result.reason,
    paths: changedPaths,
  });

  context.logger.info("auto-commit completed", {
    step: step.config.name,
    branch: result.branch || branch,
    committed: result.committed,
    pushed: result.pushed,
    reason: result.reason,
  });

  if (result.committed && result.pushed === false) {
    await abortWorkflowDueToPushFailure(context, result, {
      message,
      paths: changedPaths,
    });
    throw new Error(`Auto-commit push failed for step ${step.config.name}`);
  }
}

function collectPaths(entries: WorkingTreeEntry[]): string[] {
  const unique = new Set<string>();
  for (const entry of entries || []) {
    if (entry?.path) {
      unique.add(entry.path);
    }
    if (entry?.secondaryPath) {
      unique.add(entry.secondaryPath);
    }
  }
  return Array.from(unique);
}
