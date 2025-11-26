import {
  WorkflowStepConfig,
  StepResult,
} from "../../../engine/WorkflowStep.js";
import { WorkflowContext } from "../../../engine/WorkflowContext.js";
import { PersonaRequestStep } from "../../PersonaRequestStep.js";
import { interpretPersonaStatus } from "../../../../agents/persona.js";
import { requiresStatus } from "../personaStatusPolicy.js";
import {
  PersonaStatus,
  PersonaInvocationConfig,
} from "./types.js";

export async function executePersonaInvocation(
  context: WorkflowContext,
  cfg: PersonaInvocationConfig,
): Promise<StepResult> {
  const stepConfig: WorkflowStepConfig = {
    name: cfg.name,
    type: "PersonaRequestStep",
    config: {
      step: cfg.step,
      persona: cfg.persona,
      intent: cfg.intent,
      payload: cfg.payload,
      prompt_template: cfg.promptTemplate,
      timeout: cfg.timeout,
      deadlineSeconds: cfg.deadlineSeconds,
      maxRetries: cfg.maxRetries,
      abortOnFailure: cfg.abortOnFailure,
    },
  };

  const step = new PersonaRequestStep(stepConfig);
  return step.execute(context);
}

export function extractPersonaOutputs(result: StepResult): any {
  if (result.outputs !== undefined) {
    return result.outputs;
  }
  if (result.data && typeof result.data === "object") {
    const payload = (result.data as any).result;
    if (payload !== undefined) {
      return payload;
    }
  }
  return null;
}

export function resolvePersonaStatus(
  context: WorkflowContext,
  stepName: string,
  persona: string,
  result: any,
): PersonaStatus {
  const contextStatus = context.getVariable(`${stepName}_status`);
  if (contextStatus === "pass" || contextStatus === "fail") {
    return contextStatus;
  }
  if (result && typeof result === "object" && typeof result.status === "string") {
    const normalized = result.status.toLowerCase();
    if (normalized === "pass" || normalized === "approved") return "pass";
    if (normalized === "fail" || normalized === "failed") return "fail";
  }
  if (typeof result === "string") {
    return interpretPersonaStatus(result, {
      persona,
      statusRequired: requiresStatus(persona),
    }).status as PersonaStatus;
  }
  return "unknown";
}

export function wrapAutoPass(
  result: any,
  iteration: number,
  reason?: string,
): Record<string, any> {
  return {
    status: "pass",
    reason: reason || "Auto-approved after exhausting analysis review attempts",
    auto_pass: true,
    iteration,
    previous_feedback: result,
  } satisfies Record<string, any>;
}
