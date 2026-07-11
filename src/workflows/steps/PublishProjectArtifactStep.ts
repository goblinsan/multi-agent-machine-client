import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { publishProjectArtifactToDashboard } from "../helpers/artifactPublisher.js";

interface PublishProjectArtifactConfig {
  source_variable: string;
  kind: string;
  allow_missing?: boolean;
}

export class PublishProjectArtifactStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as PublishProjectArtifactConfig;
    const allowMissing = config.allow_missing !== false;

    let value: unknown;
    try {
      value = context.getVariable(config.source_variable);
    } catch {
      value = undefined;
    }

    if (value === undefined || value === null || value === "") {
      if (allowMissing) {
        context.logger.info(
          "PublishProjectArtifactStep: source variable empty, skipping",
          {
            workflowId: context.workflowId,
            sourceVariable: config.source_variable,
            kind: config.kind,
          },
        );
        return {
          status: "success",
          data: { published: false, reason: "missing source" },
        } satisfies StepResult;
      }
      return {
        status: "failure",
        error: new Error(
          `PublishProjectArtifactStep: variable '${config.source_variable}' is empty`,
        ),
      } satisfies StepResult;
    }

    const content =
      typeof value === "string" ? value : JSON.stringify(value, null, 2);

    const published = await publishProjectArtifactToDashboard({
      projectId: context.projectId,
      workflowId: context.workflowId,
      kind: config.kind,
      content,
    });

    return {
      status: "success",
      data: {
        published,
        kind: config.kind,
        byteSize: Buffer.byteLength(content, "utf8"),
      },
    } satisfies StepResult;
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as PublishProjectArtifactConfig;
    const errors: string[] = [];

    if (!config.source_variable || typeof config.source_variable !== "string") {
      errors.push(
        "PublishProjectArtifactStep: source_variable is required and must be a string",
      );
    }
    if (!config.kind || typeof config.kind !== "string") {
      errors.push(
        "PublishProjectArtifactStep: kind is required and must be a string",
      );
    }

    return { valid: errors.length === 0, errors, warnings: [] };
  }
}
