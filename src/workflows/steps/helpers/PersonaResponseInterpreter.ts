import { interpretPersonaStatus } from "../../../agents/persona.js";
import { logger } from "../../../logger.js";
import { requiresStatus } from "./personaStatusPolicy.js";

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

    const statusInfo = interpretPersonaStatus(rawResponse, {
      persona,
      statusRequired: requiresStatus(persona),
    });
    const adjustedStatusInfo =
      persona === "tester-qa" && statusInfo.status === "pass"
        ? this.validateQATestExecution(
            rawResponse,
            result,
            statusInfo,
            workflowId,
            step,
            persona,
            corrId,
          )
        : statusInfo;

    return { result, statusInfo: adjustedStatusInfo };
  }

  private validateQATestExecution(
    rawResponse: string,
    parsedResult: any,
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

    const hasNoTests = this.matchesAnyPattern(rawResponse, noTestsPatterns);
    const structuredPayload =
      this.extractStructuredPayload(parsedResult, rawResponse) || null;
    const tddRedPhase = Boolean(
      structuredPayload?.tdd_red_phase_detected === true,
    );
    const missingFramework = this.detectMissingFramework(structuredPayload);
    const testTotals = this.extractTestTotals(structuredPayload);
    const zeroExecuted = testTotals ? testTotals.executed === 0 : false;

    if (!tddRedPhase && (hasNoTests || missingFramework || zeroExecuted)) {
      const failureReason = missingFramework
        ? "QA validation failed: No runnable test framework detected."
        : "QA validation failed: No tests were executed, so the pass status is invalid.";
      logger.warn(
        "QA reported pass without verified test execution - overriding to fail",
        {
          workflowId,
          step,
          persona,
          corrId,
          originalStatus: statusInfo.status,
          responsePreview: rawResponse.substring(0, 300),
          missingFramework,
          zeroExecuted,
        },
      );

      return {
        status: "fail",
        details: failureReason,
        raw: statusInfo.raw,
        payload: structuredPayload || statusInfo.payload,
      };
    }

    return statusInfo;
  }

  private matchesAnyPattern(value: string, patterns: RegExp[]): boolean {
    return patterns.some((pattern) => pattern.test(value));
  }

  private extractStructuredPayload(
    parsedResult: any,
    rawResponse: string,
  ): any {
    if (
      parsedResult &&
      typeof parsedResult === "object" &&
      Object.keys(parsedResult).length > 0
    ) {
      return parsedResult;
    }

    const fencedMatch = rawResponse.match(/```(?:json)?\s*([\s\S]+?)```/i);
    const candidates = [];
    if (fencedMatch && fencedMatch[1]) {
      candidates.push(fencedMatch[1]);
    }
    candidates.push(rawResponse);

    for (const candidate of candidates) {
      try {
        const trimmed = candidate.trim();
        if (trimmed.length === 0) {
          continue;
        }
        return JSON.parse(trimmed);
      } catch {
        continue;
      }
    }
    return null;
  }

  private detectMissingFramework(payload: any): boolean {
    const framework = payload?.test_framework;
    if (typeof framework !== "string") {
      return false;
    }
    const normalized = framework.toLowerCase();
    return (
      normalized.includes("no test framework") ||
      normalized.includes("test framework not found") ||
      normalized.includes("missing test framework")
    );
  }

  private extractTestTotals(payload: any):
    | { passed: number; failed: number; skipped: number; executed: number }
    | null {
    if (!payload || typeof payload !== "object") {
      return null;
    }

    const summarySource =
      typeof payload.test_results === "object" && payload.test_results
        ? payload.test_results
        : typeof payload.summary === "object" && payload.summary
          ? payload.summary
          : null;

    if (!summarySource) {
      return null;
    }

    const passed = this.toNumber(
      summarySource.passed ?? summarySource.tests_passed ?? 0,
    );
    const failed = this.toNumber(
      summarySource.failed ?? summarySource.tests_failed ?? 0,
    );
    const skipped = this.toNumber(
      summarySource.skipped ?? summarySource.tests_skipped ?? 0,
    );
    const executedValue = summarySource.executed ?? summarySource.total ?? null;
    const executed =
      executedValue !== null
        ? this.toNumber(executedValue)
        : passed + failed + skipped;

    return { passed, failed, skipped, executed };
  }

  private toNumber(value: unknown): number {
    if (typeof value === "number" && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === "string" && value.trim().length > 0) {
      const parsed = Number(value);
      if (!Number.isNaN(parsed) && Number.isFinite(parsed)) {
        return parsed;
      }
    }
    return 0;
  }
}
