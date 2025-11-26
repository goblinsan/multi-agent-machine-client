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

type DefaultResponseFactory = () => Record<string, any>;

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

  private static readonly DEFAULT_RESPONSES: Record<string, DefaultResponseFactory> = {
    lead_analysis: () => ({
      status: "success",
      strategy: "automated_fix",
      resolution_plan: {
        description: "Apply a minimal automated fix to unblock the task",
        fix_type: "config_fix",
        ready_for_validation: true,
        steps: [
          "Re-run context scan to verify repository state",
          "Apply configuration fix for failing step",
          "Trigger QA validation to confirm unblock",
        ],
      },
    }),
    validate_unblock: () => ({
      status: "pass",
      normalizedStatus: "pass",
      message: "Validation bypassed in test mode",
    }),
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

    const defaultResponse = TestModeHandler.getDefaultResponse(stepName);

    const responseValue =
      preseededResult !== undefined
        ? preseededResult
        : fallbackResponse !== undefined
          ? fallbackResponse
          : defaultResponse ?? { status: "pass" };

    let derivedStatus = mapping
      ? (context.getVariable(mapping.statusKey) as string | undefined)
      : undefined;

    if (!derivedStatus) {
      derivedStatus = TestModeHandler.extractStatus(responseValue);
    }

    const seededStatus = derivedStatus || "pass";

    return {
      shouldSkip: true,
      statusValue: seededStatus,
      responseValue,
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

  private static getDefaultResponse(stepName: string): Record<string, any> | undefined {
    const factory = TestModeHandler.DEFAULT_RESPONSES[stepName];
    return factory ? factory() : undefined;
  }

  private static extractStatus(value: any): string | undefined {
    if (value === undefined || value === null) {
      return undefined;
    }

    if (typeof value === "string") {
      return value;
    }

    if (typeof value === "object") {
      if (typeof value.status === "string") {
        return value.status;
      }

      if (typeof value.normalizedStatus === "string") {
        return value.normalizedStatus;
      }
    }

    return undefined;
  }
}
