import {
  WorkflowStep,
  WorkflowStepConfig,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { runGit } from "../../gitUtils.js";
import { logger } from "../../logger.js";
import fs from "fs/promises";
import path from "path";

interface GitArtifactStepConfig {
  source_output: string;
  artifact_path: string;
  commit_message: string;
  format?: "markdown" | "json";
  extract_field?: string;
  template?: string;
}

export class GitArtifactStep extends WorkflowStep {
  constructor(config: WorkflowStepConfig) {
    super(config);
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as GitArtifactStepConfig;
    const startTime = Date.now();

    if (!config.source_output) {
      throw new Error("GitArtifactStep: source_output is required");
    }
    if (!config.artifact_path) {
      throw new Error("GitArtifactStep: artifact_path is required");
    }
    if (!config.commit_message) {
      throw new Error("GitArtifactStep: commit_message is required");
    }

    const skipGitOps = ((): boolean => {
      try {
        return context.getVariable("SKIP_GIT_OPERATIONS") === true;
      } catch (e) {
        logger.debug("Error checking SKIP_GIT_OPERATIONS variable", {
          error: String(e),
        });
        return false;
      }
    })();

    if (skipGitOps) {
      context.logger.info(
        "GitArtifactStep bypassed due to SKIP_GIT_OPERATIONS",
        {
          stepName: this.config.name,
          artifactPath: config.artifact_path,
        },
      );
      return {
        status: "success",
        data: {
          path: config.artifact_path,
          sha: "skipped",
          bypassed: true,
        },
        outputs: {
          [`${this.config.name}_sha`]: "skipped",
          [`${this.config.name}_path`]: config.artifact_path,
        },
      };
    }

    try {
      let data: any;
      try {
        data = context.getVariable(config.source_output);
      } catch (err) {
        throw new Error(
          `GitArtifactStep: Failed to get data from source_output '${config.source_output}': ${err}`,
        );
      }

      if (config.extract_field) {
        if (data && typeof data === "object" && config.extract_field in data) {
          data = data[config.extract_field];
        } else {
          throw new Error(
            `GitArtifactStep: extract_field '${config.extract_field}' not found in source data`,
          );
        }
      }

      if (data === undefined || data === null) {
        throw new Error(
          `GitArtifactStep: No data found at source_output '${config.source_output}'${config.extract_field ? `.${config.extract_field}` : ""}`,
        );
      }

      const format = config.format || "markdown";
      const content =
        format === "json"
          ? JSON.stringify(data, null, 2)
          : this.formatMarkdown(data, config.template);

      const resolvedPath = this.resolveVariables(config.artifact_path, context);

      if (!resolvedPath.startsWith(".ma/")) {
        throw new Error(
          `GitArtifactStep: artifact_path must start with '.ma/' for security (got: ${resolvedPath})`,
        );
      }

      const repoRoot = context.repoRoot;
      const expectedBranch = this.resolveExpectedBranch(context);

      if (!expectedBranch) {
        throw new Error(
          "GitArtifactStep: Unable to determine expected branch for guard check",
        );
      }

      const branchResult = await runGit(
        ["rev-parse", "--abbrev-ref", "HEAD"],
        { cwd: repoRoot },
      );
      const activeBranch = branchResult.stdout.trim();

      if (!activeBranch) {
        throw new Error(
          "GitArtifactStep: Unable to determine current git branch for guard check",
        );
      }

      if (activeBranch !== expectedBranch) {
        const message =
          `GitArtifactStep: Active branch '${activeBranch}' does not match expected branch '${expectedBranch}'`;
        context.logger.error("Branch guard failed before committing artifact", {
          stepName: this.config.name,
          activeBranch,
          expectedBranch,
        });

        return {
          status: "failure",
          error: new Error(message),
          data: {
            path: resolvedPath,
            failed: true,
            activeBranch,
            expectedBranch,
          },
        } satisfies StepResult;
      }

      const fullPath = path.join(repoRoot, resolvedPath);

      context.logger.info("Writing artifact to git", {
        stepName: this.config.name,
        artifactPath: resolvedPath,
        contentLength: content.length,
        format,
      });

      await fs.mkdir(path.dirname(fullPath), { recursive: true });
      await fs.writeFile(fullPath, content, "utf-8");

      const commitMsg = this.resolveVariables(config.commit_message, context);
      const relativePath = path.relative(repoRoot, fullPath);

      try {
        await runGit(["add", relativePath], { cwd: repoRoot });
        await runGit(["commit", "--no-verify", "-m", commitMsg], {
          cwd: repoRoot,
        });
      } catch (err) {
        context.logger.warn("Initial commit failed, retrying with force add", {
          error: err instanceof Error ? err.message : String(err),
        });
        await runGit(["add", "--force", relativePath], { cwd: repoRoot });
        await runGit(["commit", "--no-verify", "-m", commitMsg], {
          cwd: repoRoot,
        });
      }

      const sha = (
        await runGit(["rev-parse", "HEAD"], { cwd: repoRoot })
      ).stdout.trim();

      context.logger.info("Artifact committed to git", {
        stepName: this.config.name,
        artifactPath: resolvedPath,
        sha: sha.substring(0, 7),
        commitMessage: commitMsg,
      });

      const branch = context.getCurrentBranch();
      try {
        const remotes = await runGit(["remote"], { cwd: repoRoot });
        const hasRemote = remotes.stdout.trim().length > 0;

        if (hasRemote) {
          await runGit(["push", "origin", branch], { cwd: repoRoot });
          context.logger.info("Artifact pushed to remote", {
            stepName: this.config.name,
            branch,
            sha: sha.substring(0, 7),
          });
        } else {
          context.logger.warn("No remote configured, skipping push", {
            stepName: this.config.name,
            note: "Typical in test environments",
          });
        }
      } catch (pushErr) {
        context.logger.warn("Failed to push artifact (will retry later)", {
          stepName: this.config.name,
          branch,
          sha: sha.substring(0, 7),
          error: pushErr instanceof Error ? pushErr.message : String(pushErr),
        });
      }

      const elapsed = Date.now() - startTime;

      return {
        status: "success",
        data: {
          path: resolvedPath,
          sha,
          contentLength: content.length,
          format,
          elapsed,
        },
        outputs: {
          [`${this.config.name}_sha`]: sha,
          [`${this.config.name}_path`]: resolvedPath,
        },
      };
    } catch (error) {
      context.logger.error("GitArtifactStep failed", {
        stepName: this.config.name,
        error: error instanceof Error ? error.message : String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      return {
        status: "failure",
        error: error instanceof Error ? error : new Error(String(error)),
        data: {
          path: config.artifact_path,
          failed: true,
        },
      };
    }
  }

  async validate(_context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as GitArtifactStepConfig;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (!config.source_output || typeof config.source_output !== "string") {
      errors.push(
        "GitArtifactStep: source_output is required and must be a string",
      );
    }

    if (!config.artifact_path || typeof config.artifact_path !== "string") {
      errors.push(
        "GitArtifactStep: artifact_path is required and must be a string",
      );
    } else if (!config.artifact_path.startsWith(".ma/")) {
      errors.push(
        "GitArtifactStep: artifact_path must start with '.ma/' for security",
      );
    }

    if (!config.commit_message || typeof config.commit_message !== "string") {
      errors.push(
        "GitArtifactStep: commit_message is required and must be a string",
      );
    }

    if (config.format && !["markdown", "json"].includes(config.format)) {
      errors.push("GitArtifactStep: format must be 'markdown' or 'json'");
    }

    if (config.extract_field && typeof config.extract_field !== "string") {
      errors.push("GitArtifactStep: extract_field must be a string");
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private formatMarkdown(data: any, _template?: string): string {
    if (typeof data === "string") {
      return data;
    }

    if (typeof data === "object") {
      return `# Workflow Artifact\n\nGenerated: ${new Date().toISOString()}\n\n\`\`\`json\n${JSON.stringify(data, null, 2)}\n\`\`\`\n`;
    }

    return String(data);
  }

  private resolveVariables(str: string, context: WorkflowContext): string {
    return str.replace(/\$\{([^}]+)\}/g, (match, varPath) => {
      try {
        const parts = varPath.trim().split(".");
        let value: any = context.getVariable(parts[0]);
        for (let i = 1; i < parts.length; i++) {
          if (value && typeof value === "object" && parts[i] in value) {
            value = value[parts[i]];
          } else {
            return match;
          }
        }

        if (value === undefined || value === null) {
          return match;
        }
        return String(value);
      } catch (e) {
        logger.debug("Failed to resolve template variable", {
          match,
          error: String(e),
        });
        return match;
      }
    });
  }

  private resolveExpectedBranch(context: WorkflowContext): string | null {
    const candidates = [
      context.getVariable("branch"),
      context.getVariable("currentBranch"),
      context.getVariable("featureBranchName"),
      context.branch,
    ];

    for (const candidate of candidates) {
      if (typeof candidate === "string" && candidate.trim().length > 0) {
        return candidate.trim();
      }
    }

    return null;
  }
}
