import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { runGit } from "../../git/core.js";

interface GitDiffExportConfig {
  repoPath?: string;
  branch?: string;
  baseBranch?: string;
  output_prefix?: string;
  max_bytes?: number;
  fail_on_empty_diff?: boolean;
  compare_remote?: boolean;
}

export class GitDiffExportStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = (this.config.config || {}) as GitDiffExportConfig;

    const repoRoot =
      this.resolveVariable(config.repoPath, context) || context.repoRoot;
    if (!repoRoot) {
      const error = new Error(
        "GitDiffExportStep: repoPath is required but was not resolved",
      );
      return { status: "failure", error };
    }

    const branch =
      this.resolveVariable(config.branch, context) ||
      context.getVariable("featureBranchName") ||
      context.getVariable("branch") ||
      context.getCurrentBranch();

    if (!branch) {
      const error = new Error(
        "GitDiffExportStep: Unable to determine target branch for diff",
      );
      return { status: "failure", error };
    }

    const baseBranch =
      this.resolveVariable(config.baseBranch, context) ||
      context.getVariable("baseBranch") ||
      "main";

    const outputPrefix =
      this.sanitizePrefix(config.output_prefix || this.config.name || "diff");
    const maxBytes = config.max_bytes && config.max_bytes > 0
      ? config.max_bytes
      : 200_000;
    const failOnEmptyDiff =
      config.fail_on_empty_diff !== undefined
        ? !!config.fail_on_empty_diff
        : true;
    const compareRemote =
      config.compare_remote !== undefined ? !!config.compare_remote : true;

    try {
      const branchRef = compareRemote ? `origin/${branch}` : branch;
      const baseRef = baseBranch
        ? compareRemote ? `origin/${baseBranch}` : baseBranch
        : null;

      if (compareRemote) {
        await this.safeFetch(repoRoot, branch);
        if (baseRef) {
          await this.safeFetch(repoRoot, baseBranch!);
        }
      }

      const diffRange = baseRef ? `${baseRef}..${branchRef}` : branchRef;

      const diffText = await this.runGitCommand(
        repoRoot,
        ["diff", "--unified=3", diffRange],
      );
      const diffSummary = await this.runGitCommand(
        repoRoot,
        ["diff", "--stat", diffRange],
      );
      const changedFilesRaw = await this.runGitCommand(
        repoRoot,
        ["diff", "--name-only", diffRange],
      );

      const trimmedDiff = this.truncateDiff(diffText, maxBytes);
      const changedFiles = changedFilesRaw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      if (failOnEmptyDiff && trimmedDiff.trim().length === 0) {
        const error = new Error(
          "GitDiffExportStep: No code diff found between base and feature branches",
        );
        logger.error(error.message, {
          branch,
          baseBranch,
          repoRoot,
        });
        return { status: "failure", error };
      }

      context.setVariable(`${outputPrefix}_patch`, trimmedDiff);
      context.setVariable(`${outputPrefix}_summary`, diffSummary.trim());
      context.setVariable(`${outputPrefix}_files`, changedFiles);

      logger.info("Git diff exported", {
        stepName: this.config.name,
        branch,
        baseBranch,
        repoRoot,
        bytes: trimmedDiff.length,
        files: changedFiles.length,
      });

      return {
        status: "success",
        data: {
          patch: trimmedDiff,
          summary: diffSummary.trim(),
          changed_files: changedFiles,
          branch,
          baseBranch,
        },
        outputs: {
          patch: trimmedDiff,
          summary: diffSummary.trim(),
          changed_files: changedFiles,
          patch_variable: `${outputPrefix}_patch`,
          files_variable: `${outputPrefix}_files`,
          summary_variable: `${outputPrefix}_summary`,
        },
      } satisfies StepResult;
    } catch (error: any) {
      logger.error("Failed to export git diff", {
        stepName: this.config.name,
        branch,
        baseBranch,
        repoRoot,
        error: error?.message || String(error),
      });

      return {
        status: "failure",
        error: error instanceof Error ? error : new Error(String(error)),
      } satisfies StepResult;
    }
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    return { valid: true, errors: [], warnings: [] };
  }

  private async safeFetch(repoRoot: string, ref: string): Promise<void> {
    if (!ref) return;
    try {
      await runGit(["fetch", "origin", ref], { cwd: repoRoot });
    } catch (error) {
      logger.warn("GitDiffExportStep: fetch failed", {
        repoRoot,
        ref,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runGitCommand(
    repoRoot: string,
    args: string[],
  ): Promise<string> {
    const result = await runGit(args, { cwd: repoRoot });
    return result.stdout?.toString() ?? "";
  }

  private truncateDiff(diff: string, maxBytes: number): string {
    if (!diff || diff.length <= maxBytes) {
      return diff;
    }
    const truncated = diff.slice(diff.length - maxBytes);
    return `--- DIFF TRUNCATED (${diff.length - maxBytes} bytes omitted) ---\n${truncated}`;
  }

  private resolveVariable(
    value: string | undefined,
    context: WorkflowContext,
  ): string | undefined {
    if (!value) return undefined;
    if (value.startsWith("${") && value.endsWith("}")) {
      const variableName = value.slice(2, -1).trim();
      const resolved = context.getVariable(variableName);
      return resolved !== undefined && resolved !== null
        ? String(resolved)
        : undefined;
    }
    return value;
  }

  private sanitizePrefix(prefix: string): string {
    return prefix.replace(/[^a-zA-Z0-9_]/g, "_");
  }
}
