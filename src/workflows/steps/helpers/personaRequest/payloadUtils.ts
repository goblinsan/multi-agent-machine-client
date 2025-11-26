import { WorkflowContext } from "../../../engine/WorkflowContext.js";
import { VariableResolver } from "../VariableResolver.js";
import { PromptTemplateRenderer } from "../PromptTemplateRenderer.js";
import { logger } from "../../../../logger.js";

export class PersonaPayloadBuilder {
  constructor(private readonly variableResolver = new VariableResolver()) {}

  resolvePayload(payload: Record<string, any>, context: WorkflowContext) {
    return this.variableResolver.resolvePayload(payload, context);
  }

  async maybeApplyPromptTemplate(
    resolvedPayload: Record<string, any>,
    context: WorkflowContext,
    templatePath?: string,
    persona?: string,
    stepName?: string,
  ): Promise<void> {
    if (!templatePath || resolvedPayload.user_text) {
      return;
    }

    const templateData = {
      workflow_id: context.workflowId,
      project_id: context.projectId,
      ...resolvedPayload,
    } satisfies Record<string, any>;

    const rendered = await PromptTemplateRenderer.render(
      templatePath,
      templateData,
    );

    resolvedPayload.user_text = rendered;

    logger.info("PersonaRequest payload rendered from template", {
      step: stepName,
      persona,
      templatePath,
      renderedLength: rendered.length,
    });
  }
}
