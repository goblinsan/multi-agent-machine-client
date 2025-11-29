import { cfg } from "../../../../config.js";
import { isInformationRequestResult } from "../InformationRequestHandler.js";

export function appendInformationContract(baseText: string): string {
  const contractLines = [
    "Information acquisition protocol:",
    "1. If you need extra context before proceeding, respond with JSON { \"status\": \"info_request\", \"requests\": [...] }.",
    "2. Supported request types: repo_file (path plus optional start/end lines) and http_get (URL). Include a short reason for each request.",
    `3. Keep requests scoped; you have at most ${cfg.informationRequests?.maxIterations ?? 5} acquisition iteration(s).`,
    "4. After receiving the supplemental context you must continue the task unless another info_request is absolutely necessary.",
  ];
  const contractBlock = contractLines.join("\n");
  if (!baseText || !baseText.trim().length) {
    return contractBlock;
  }
  if (baseText.includes(contractLines[0])) {
    return baseText;
  }
  return `${baseText.trimEnd()}\n\n${contractBlock}`;
}

export function buildIterationPayload(
  basePayload: Record<string, any>,
  baseUserText: string,
  infoBlocks: string[],
  iteration: number,
  maxIterations: number,
): Record<string, any> {
  const cloned = clonePayload(basePayload);
  cloned.user_text = composeUserText(baseUserText, infoBlocks);
  if (infoBlocks.length) {
    cloned.acquired_information_blocks = [...infoBlocks];
  } else {
    delete cloned.acquired_information_blocks;
  }
  cloned.information_request_iteration = iteration;
  cloned.information_request_max_iterations = maxIterations;
  cloned.information_request_iterations_remaining = Math.max(
    0,
    maxIterations - iteration,
  );
  return cloned;
}

export function buildSystemInformationBlock(message: string): string {
  return `Information Request Notice:\n${message}`;
}

export function extractInformationRequestPayload(
  result: any,
  completion: any,
): any | null {
  if (isInformationRequestResult(result)) {
    return result;
  }

  const nested = extractInformationRequestFromFields(result);
  if (nested) {
    return nested;
  }

  if (
    result &&
    typeof result === "object" &&
    result.status === "info_request" &&
    Array.isArray(result.requests)
  ) {
    return result;
  }

  const raw = getRawCompletionText(completion);
  if (!raw) {
    return null;
  }

  const parsed = parseJsonFromString(raw);
  if (parsed && isInformationRequestResult(parsed)) {
    return parsed;
  }

  if (
    parsed &&
    typeof parsed === "object" &&
    parsed.status === "info_request" &&
    Array.isArray(parsed.requests)
  ) {
    return parsed;
  }

  return null;
}

export function clonePayload<T extends Record<string, any>>(payload: T): T {
  return JSON.parse(JSON.stringify(payload));
}

function composeUserText(baseText: string, infoBlocks: string[]): string {
  if (!infoBlocks.length) {
    return baseText;
  }
  const header =
    "Additional context retrieved after your previous response:\n";
  return `${baseText}\n\n${header}${infoBlocks.join("\n\n")}`;
}

function extractInformationRequestFromFields(result: any): any | null {
  if (!result || typeof result !== "object") {
    return null;
  }

  const candidateFields = [
    "output",
    "details",
    "message",
    "text",
    "preview",
  ];

  for (const field of candidateFields) {
    const value = (result as any)[field];
    if (typeof value !== "string" || value.trim().length === 0) {
      continue;
    }

    const parsed = parseJsonFromString(value);
    if (!parsed) {
      continue;
    }

    if (isInformationRequestResult(parsed)) {
      return parsed;
    }

    if (
      typeof parsed === "object" &&
      parsed.status === "info_request" &&
      Array.isArray(parsed.requests)
    ) {
      return parsed;
    }
  }

  if (result.payload && typeof result.payload === "object") {
    return extractInformationRequestFromFields(result.payload);
  }

  return null;
}

function getRawCompletionText(completion: any): string | null {
  const rawResult = completion?.fields?.result;
  if (typeof rawResult === "string" && rawResult.trim().length > 0) {
    return rawResult;
  }

  if (typeof completion === "string" && completion.trim().length > 0) {
    return completion;
  }

  return null;
}

function parseJsonFromString(raw: string): any | null {
  const direct = tryParseJson(raw);
  if (direct !== null) {
    return direct;
  }

  const cleaned = stripDanglingFences(raw);
  if (cleaned !== raw) {
    const cleanedResult = tryParseJson(cleaned);
    if (cleanedResult !== null) {
      return cleanedResult;
    }
  }

  const fencedMatch = raw.match(/```(?:json)?\s*([\s\S]+?)```/i);
  if (fencedMatch && fencedMatch[1]) {
    return tryParseJson(fencedMatch[1]);
  }

  return null;
}

function tryParseJson(candidate: string): any | null {
  try {
    const trimmed = candidate.trim();
    if (!trimmed.length) {
      return null;
    }
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function stripDanglingFences(value: string): string {
  return value
    .replace(/^```(?:json)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
}
