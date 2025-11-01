import { interpretPersonaStatus } from "../../../agents/persona.js";
import { logger } from "../../../logger.js";

interface PersonaStatusInfo {
  status: "pass" | "fail" | "unknown";
  details: string;
  raw: string;
  payload?: any;
}

interface ParsedResponse {
  result: any;
  statusInfo: PersonaStatusInfo;
}

export class PersonaResponseInterpreter {
  public interpret(
    rawResponse: string,
    persona: string,
    workflowId: string,
    step: string,
    corrId: string,
    completion: any,
  ): ParsedResponse {
    let result: any = {};

    try {
      result = completion.fields?.result
        ? JSON.parse(completion.fields.result)
        : {};
    } catch (parseError) {
      logger.warn(
        `Failed to parse persona response as JSON, using raw response`,
        {
          workflowId,
          step,
          persona,
          error:
            parseError instanceof Error
              ? parseError.message
              : "Unknown error",
        },
      );
      result = { raw: rawResponse };
    }

    let statusInfo = interpretPersonaStatus(rawResponse);

    if (persona === "tester-qa" && statusInfo.status === "pass") {
      statusInfo = this.validateQATestExecution(
        rawResponse,
        statusInfo,
        workflowId,
        step,
        persona,
        corrId,
      );
    }

    return { result, statusInfo };
  }

  private validateQATestExecution(
    rawResponse: string,
    statusInfo: PersonaStatusInfo,
    workflowId: string,
    step: string,
    persona: string,
    corrId: string,
  ): PersonaStatusInfo {
    const noTestsPatterns = [
      /0\s+passed,\s+0\s+failed/i,
      /no tests.*present/i,
      /no tests.*found/i,
      /nothing to execute/i,
      /0\s+tests?\s+(?:executed|run)/i,
    ];

    const hasNoTests = noTestsPatterns.some((pattern) =>
      pattern.test(rawResponse),
    );

    if (hasNoTests) {
      logger.warn(
        "QA reported pass but no tests were executed - overriding to fail",
        {
          workflowId,
          step,
          persona,
          corrId,
          originalStatus: statusInfo.status,
          responsePreview: rawResponse.substring(0, 300),
        },
      );

      return {
        status: "fail",
        details:
          "QA validation failed: No tests were executed. Cannot verify code correctness without running tests.",
        raw: statusInfo.raw,
        payload: statusInfo.payload,
      };
    }

    return statusInfo;
  }
}
