import { WorkflowContext } from "../../engine/WorkflowContext.js";
import { logger } from "../../../logger.js";

interface TestModeMapping {
  statusKey: string;
  responseKey: string;
}

interface TestModeResult {
  shouldSkip: boolean;
  statusValue?: string;
  responseValue?: any;
}

export class TestModeHandler {
  private static readonly STEP_MAPPINGS: Record<string, TestModeMapping> = {
    qa_request: { statusKey: "qa_status", responseKey: "qa_response" },
    code_review_request: {
      statusKey: "code_review_status",
      responseKey: "code_review_response",
    },
    security_request: {
      statusKey: "security_review_status",
      responseKey: "security_response",
    },
    devops_request: {
      statusKey: "devops_status",
      responseKey: "devops_response",
    },
    context_request: {
      statusKey: "context_status",
      responseKey: "context_result",
    },
  };

  public shouldSkipPersonaOperation(context: WorkflowContext): boolean {
    const isTestEnvironment =
      process.env.NODE_ENV === "test" ||
      !!process.env.VITEST ||
      typeof (globalThis as any).vi !== "undefined";

    if (isTestEnvironment) {
      try {
        const explicit = context.getVariable("SKIP_PERSONA_OPERATIONS");
        if (explicit === false) return false;
      } catch (e) {
        logger.debug("Error checking SKIP_PERSONA_OPERATIONS in test mode", {
          error: String(e),
        });
      }
      return true;
    }

    try {
      return context.getVariable("SKIP_PERSONA_OPERATIONS") === true;
    } catch (e) {
      logger.debug("Error checking SKIP_PERSONA_OPERATIONS variable", {
        error: String(e),
      });
    }
    return false;
  }

  public getMockResponse(
    stepName: string,
    outputs: string[] | undefined,
    context: WorkflowContext,
  ): TestModeResult {
    const mapping = TestModeHandler.STEP_MAPPINGS[stepName];

    const outputsList = Array.isArray(outputs) ? outputs : [];
    const resultOutputName = outputsList.find((o) =>
      o.endsWith("_result"),
    ) as string | undefined;

    const preseededResult = resultOutputName
      ? context.getVariable(resultOutputName)
      : undefined;

    const fallbackResponse = mapping
      ? context.getVariable(mapping.responseKey)
      : undefined;

    let derivedStatus = mapping
      ? context.getVariable(mapping.statusKey)
      : undefined;

    if (!derivedStatus) {
      const candidate =
        preseededResult && typeof preseededResult === "object"
          ? preseededResult
          : fallbackResponse;
      if (candidate && typeof candidate === "object" && candidate.status) {
        derivedStatus = candidate.status;
      }
    }

    const seededStatus = (derivedStatus as string) || "pass";
    const seededResponse =
      preseededResult !== undefined ? preseededResult : fallbackResponse || {};

    return {
      shouldSkip: true,
      statusValue: seededStatus,
      responseValue: seededResponse,
    };
  }

  public setMockOutputs(
    stepName: string,
    outputs: string[] | undefined,
    context: WorkflowContext,
    statusValue: string,
    responseValue: any,
  ): void {
    const mapping = TestModeHandler.STEP_MAPPINGS[stepName];

    context.setVariable(`${stepName}_status`, statusValue);

    if (mapping?.statusKey) {
      context.setVariable(mapping.statusKey, statusValue);
    }

    if (outputs && Array.isArray(outputs)) {
      for (const output of outputs) {
        if (output.endsWith("_status")) {
          context.setVariable(output, statusValue);
        } else {
          context.setVariable(output, responseValue);
        }
      }
    }
  }
}
