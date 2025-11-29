import {
  WorkflowStep,
  StepResult,
  ValidationResult,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { TestModeHandler } from "./helpers/TestModeHandler.js";
import { PersonaResponseInterpreter } from "./helpers/PersonaResponseInterpreter.js";
import { PersonaPayloadBuilder } from "./helpers/personaRequest/payloadUtils.js";
import type { PersonaRequestConfig } from "./helpers/personaRequest/types.js";
import { executePersonaRequestFlow } from "./helpers/personaRequest/personaRequestExecutor.js";

export class PersonaRequestStep extends WorkflowStep {
  private payloadBuilder = new PersonaPayloadBuilder();
  private testModeHandler = new TestModeHandler();
  private responseInterpreter = new PersonaResponseInterpreter();

  constructor(config: any) {
    super(config);
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as PersonaRequestConfig;
    const {
      step,
      persona,
      intent,
      payload,
      deadlineSeconds = 600,
    } = config;

    if (this.testModeHandler.shouldSkipPersonaOperation(context)) {
      return this.executeTestMode(context, step, persona);
    }

    return executePersonaRequestFlow({
      context,
      persona,
      step,
      intent,
      payload,
      deadlineSeconds,
      config,
      payloadBuilder: this.payloadBuilder,
      responseInterpreter: this.responseInterpreter,
      stepName: this.config.name || "",
      outputs: this.config.outputs,
    });
  }

  private executeTestMode(
    context: WorkflowContext,
    step: string,
    persona: string,
  ): StepResult {
    const stepName = this.config.name || "";
    const mockResult = this.testModeHandler.getMockResponse(
      stepName,
      this.config.outputs,
      context,
    );

    this.testModeHandler.setMockOutputs(
      stepName,
      this.config.outputs,
      context,
      mockResult.statusValue!,
      mockResult.responseValue,
    );
    logger.info("PersonaRequestStep bypassed (SKIP_PERSONA_OPERATIONS)", {
      workflowId: context.workflowId,
      step: stepName,
      persona,
    });

    return {
      status: "success",
      data: {
        step,
        persona,
        bypassed: true,
        seededStatus: mockResult.statusValue,
        result: mockResult.responseValue,
      },
      outputs: mockResult.responseValue,
    } satisfies StepResult;
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const errors: string[] = [];
    const config = this.config.config as PersonaRequestConfig;

    if (!config.step || typeof config.step !== "string") {
      errors.push("PersonaRequestStep: step is required and must be a string");
    }

    if (!config.persona || typeof config.persona !== "string") {
      errors.push(
        "PersonaRequestStep: persona is required and must be a string",
      );
    }

    if (!config.intent || typeof config.intent !== "string") {
      errors.push(
        "PersonaRequestStep: intent is required and must be a string",
      );
    }

    if (!config.payload || typeof config.payload !== "object") {
      errors.push(
        "PersonaRequestStep: payload is required and must be an object",
      );
    }

    if (
      config.timeout !== undefined &&
      (typeof config.timeout !== "number" || config.timeout < 0)
    ) {
      errors.push("PersonaRequestStep: timeout must be a non-negative number");
    }

    if (
      config.deadlineSeconds !== undefined &&
      (typeof config.deadlineSeconds !== "number" || config.deadlineSeconds < 0)
    ) {
      errors.push(
        "PersonaRequestStep: deadlineSeconds must be a non-negative number",
      );
    }

    if (
      config.maxRetries !== undefined &&
      (typeof config.maxRetries !== "number" || config.maxRetries < 0)
    ) {
      errors.push(
        "PersonaRequestStep: maxRetries must be a non-negative number",
      );
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings: [],
    };
  }
}
