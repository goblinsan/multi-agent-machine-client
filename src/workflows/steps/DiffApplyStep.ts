import {
  WorkflowStep,
  WorkflowStepConfig,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import {
  DiffParser,
  DiffParseResult as _DiffParseResult,
} from "../../agents/parsers/DiffParser.js";
import { applyEditOps } from "../../fileops.js";

interface DiffApplyStepConfig {
  source_output?: string;
  source_variable?: string;
  validation?: "none" | "syntax_check" | "full";
  backup?: boolean;
  max_file_size?: number;
  allowed_extensions?: string[];
  commit_message?: string;
  dry_run?: boolean;
}

export class DiffApplyStep extends WorkflowStep {
  constructor(config: WorkflowStepConfig) {
    super(config);
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const stepConfig = (this.config.config as DiffApplyStepConfig) || {};
    const startTime = Date.now();

    try {
      const skipOps = ((): boolean => {
        try {
          return (
            context.getVariable("SKIP_GIT_OPERATIONS") === true ||
            context.getVariable("SKIP_PERSONA_OPERATIONS") === true
          );
        } catch {
          return false;
        }
      })();

      if (skipOps) {
        context.logger.info("DiffApplyStep bypassed due to SKIP flags", {
          stepName: this.config.name,
        });
        const branch = context.getCurrentBranch();
        return {
          status: "success",
          data: {
            parseResult: null,
            applyResult: { changed: [], sha: "skipped", branch },
          },
          outputs: {
            applied_files: [],
            commit_sha: "skipped",
            operations_count: 0,
            branch,
          },
          metrics: { duration_ms: Date.now() - startTime, operations_count: 0 },
        };
      }
      context.logger.info("Starting diff application", {
        stepName: this.config.name,
        sourceOutput: stepConfig.source_output,
        sourceVariable: stepConfig.source_variable,
        validation: stepConfig.validation || "syntax_check",
        dryRun: stepConfig.dry_run || false,
      });

      const diffContent = this.getDiffContent(context, stepConfig);
      if (!diffContent) {
        context.logger.error("CRITICAL: No diff content available to apply", {
          stepName: this.config.name,
          sourceOutput: stepConfig.source_output,
          sourceVariable: stepConfig.source_variable,
          availableOutputs: Object.keys(context.getAllStepOutputs()),
        });
        throw new Error(
          "CRITICAL: No diff content found. Implementation step may have failed or returned no changes.",
        );
      }

      const parseResult = DiffParser.parsePersonaResponse(diffContent);

      if (!parseResult.success) {
        context.logger.error("Diff parsing failed", {
          stepName: this.config.name,
          errors: parseResult.errors,
          warnings: parseResult.warnings,
        });

        throw new Error(
          `Diff parsing failed: ${parseResult.errors.join(", ")}`,
        );
      }

      context.logger.info("Diff parsing completed", {
        stepName: this.config.name,
        diffBlocksFound: parseResult.diffBlocks.length,
        operationsFound: parseResult.editSpec?.ops.length || 0,
        warnings: parseResult.warnings,
      });

      if (parseResult.warnings.length > 0) {
        context.logger.warn("Diff parsing warnings", {
          stepName: this.config.name,
          warnings: parseResult.warnings,
        });
      }

      if (!parseResult.editSpec || parseResult.editSpec.ops.length === 0) {
        context.logger.error(
          "Critical failure: No edit operations found in diff",
          {
            stepName: this.config.name,
            diffContent: diffContent.substring(0, 500) + "...",
          },
        );

        throw new Error(
          "Coordinator-critical: Implementation returned no diff operations to apply. Aborting.",
        );
      }

      if (stepConfig.validation && stepConfig.validation !== "none") {
        await this.validateChanges(parseResult.editSpec, context, stepConfig);
      }

      let applyResult;
      if (stepConfig.dry_run) {
        context.logger.info("Dry run mode - changes not applied", {
          stepName: this.config.name,
          operationsCount: parseResult.editSpec.ops.length,
        });

        applyResult = {
          changed: parseResult.editSpec.ops.map((op) => op.path),
          branch: context.getCurrentBranch(),
          sha: "dry-run",
        };
      } else {
        const editSpecJson = JSON.stringify(parseResult.editSpec);

        const currentBranch = context.getCurrentBranch();

        applyResult = await applyEditOps(editSpecJson, {
          repoRoot: context.repoRoot,
          maxBytes: stepConfig.max_file_size || 512 * 1024,
          allowedExts: stepConfig.allowed_extensions || [
            ".ts",
            ".tsx",
            ".js",
            ".jsx",
            ".py",
            ".md",
            ".json",
            ".yml",
            ".yaml",
            ".css",
            ".html",
            ".sh",
            ".bat",
          ],
          branchName: currentBranch,
          commitMessage:
            stepConfig.commit_message || this.generateCommitMessage(context),
        });

        if (!applyResult.changed || applyResult.changed.length === 0) {
          context.logger.error(
            "Critical failure: No file changes after applying diffs",
            {
              stepName: this.config.name,
              operationsCount: parseResult.editSpec.ops.length,
              applyResult,
            },
          );

          throw new Error(
            "Coordinator-critical: Implementation edits produced no file changes. Aborting.",
          );
        }

        if (!applyResult.sha || applyResult.sha === "") {
          context.logger.error(
            "Critical failure: No commit SHA after applying changes",
            {
              stepName: this.config.name,
              filesChanged: applyResult.changed.length,
              applyResult,
            },
          );

          throw new Error(
            "Coordinator-critical: Implementation changes were not committed to repository. Aborting.",
          );
        }
      }

      context.logger.info("Diff application completed", {
        stepName: this.config.name,
        filesChanged: applyResult.changed.length,
        commitSha: applyResult.sha,
        branch: applyResult.branch,
      });

      return {
        status: "success",
        data: {
          parseResult,
          applyResult,
        },
        outputs: {
          applied_files: applyResult.changed,
          commit_sha: applyResult.sha,
          operations_count: parseResult.editSpec.ops.length,
          branch: applyResult.branch,
        },
        metrics: {
          duration_ms: Date.now() - startTime,
          operations_count: parseResult.editSpec.ops.length,
        },
      };
    } catch (error) {
      context.logger.error("Diff application failed", {
        stepName: this.config.name,
        error: String(error),
        stack: error instanceof Error ? error.stack : undefined,
      });

      return {
        status: "failure",
        error: error instanceof Error ? error : new Error(String(error)),
        metrics: {
          duration_ms: Date.now() - startTime,
        },
      };
    }
  }

  protected async validateConfig(
    context: WorkflowContext,
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const warnings: string[] = [];
    const stepConfig = (this.config.config as DiffApplyStepConfig) || {};

    if (!stepConfig.source_output && !stepConfig.source_variable) {
      errors.push(
        "Must specify either source_output or source_variable for diff content",
      );
    }

    if (
      stepConfig.source_output &&
      !context.hasStepOutput(stepConfig.source_output)
    ) {
      errors.push(
        `Source output '${stepConfig.source_output}' not found in context`,
      );
    }

    if (
      stepConfig.source_variable &&
      !context.getVariable(stepConfig.source_variable)
    ) {
      warnings.push(
        `Source variable '${stepConfig.source_variable}' not found in context`,
      );
    }

    if (
      stepConfig.validation &&
      !["none", "syntax_check", "full"].includes(stepConfig.validation)
    ) {
      errors.push(`Invalid validation setting: ${stepConfig.validation}`);
    }

    if (
      stepConfig.max_file_size !== undefined &&
      stepConfig.max_file_size <= 0
    ) {
      errors.push("max_file_size must be positive");
    }

    return { valid: errors.length === 0, errors, warnings };
  }

  private getDiffContent(
    context: WorkflowContext,
    config: DiffApplyStepConfig,
  ): string | null {
    if (config.source_output) {
      const output = context.getStepOutput(config.source_output);

      context.logger.debug("DiffApplyStep: retrieving diff content", {
        source_output: config.source_output,
        outputType: typeof output,
        outputKeys:
          output && typeof output === "object"
            ? Object.keys(output)
            : undefined,
      });

      if (output) {
        if (typeof output === "string") {
          return output;
        } else if (output.diffs || output.code_diffs) {
          return output.diffs || output.code_diffs;
        } else if (output.implementation_diff) {
          return output.implementation_diff;
        } else if (output.diff) {
          return output.diff;
        } else if (output.ops && Array.isArray(output.ops)) {
          context.logger.info(
            "DiffApplyStep: detected pre-parsed ops structure, converting to diff format",
            {
              opsCount: output.ops.length,
            },
          );
          return this.convertOpsToDiffFormat(output.ops);
        } else if (output.result) {
          if (typeof output.result === "string") {
            return output.result;
          } else if (output.result.diffs || output.result.code_diffs) {
            return output.result.diffs || output.result.code_diffs;
          } else if (output.result.ops && Array.isArray(output.result.ops)) {
            context.logger.info(
              "DiffApplyStep: detected pre-parsed ops in result field, converting to diff format",
              {
                opsCount: output.result.ops.length,
              },
            );
            return this.convertOpsToDiffFormat(output.result.ops);
          }
        } else if (output.output) {
          return output.output;
        }

        context.logger.warn(
          "DiffApplyStep: could not extract diff content from output",
          {
            source_output: config.source_output,
            outputPreview: JSON.stringify(output).substring(0, 500),
          },
        );
      }
    }

    if (config.source_variable) {
      const variable = context.getVariable(config.source_variable);
      if (typeof variable === "string") {
        return variable;
      }
    }

    return null;
  }

  private convertOpsToDiffFormat(ops: any[]): string {
    const diffBlocks: string[] = [];

    for (const op of ops) {
      if (op.action === "upsert" && op.path && op.content !== undefined) {
        const content = op.content;
        const lines = content.split("\n");
        const hunks = lines.map((line: string) => `+${line}`).join("\n");

        const diffBlock = `\`\`\`diff
--- a/${op.path}
+++ b/${op.path}
@@ -0,0 +1,${lines.length} @@
${hunks}
\`\`\``;

        diffBlocks.push(diffBlock);
      } else if (op.action === "delete" && op.path) {
        const diffBlock = `\`\`\`diff
--- a/${op.path}
+++ /dev/null
@@ -1 +0,0 @@
\`\`\``;

        diffBlocks.push(diffBlock);
      }
    }

    return diffBlocks.join("\n\n");
  }

  private async validateChanges(
    editSpec: any,
    context: WorkflowContext,
    config: DiffApplyStepConfig,
  ): Promise<void> {
    if (config.validation === "syntax_check") {
      context.logger.debug("Syntax validation not yet implemented", {
        stepName: this.config.name,
      });
    } else if (config.validation === "full") {
      context.logger.debug("Full validation not yet implemented", {
        stepName: this.config.name,
      });
    }
  }

  private generateCommitMessage(context: WorkflowContext): string {
    const task = context.getVariable("selected_task");
    const milestone = context.getVariable("selected_milestone");

    if (task?.name) {
      return `feat: ${task.name}`;
    } else if (milestone?.name) {
      return `feat: ${milestone.name}`;
    } else {
      return "feat: apply agent changes";
    }
  }
}
