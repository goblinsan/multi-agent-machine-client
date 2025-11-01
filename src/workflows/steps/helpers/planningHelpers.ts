import { parseEventResult, interpretPersonaStatus } from "../../../agents/persona.js";
import { logger } from "../../../logger.js";
import fs from "fs/promises";
import path from "path";

export async function loadContextDirectory(
  repoRoot: string,
): Promise<Record<string, string>> {
  const contextDir = path.join(repoRoot, ".ma", "context");
  const contextFiles: Record<string, string> = {};

  try {
    const entries = await fs.readdir(contextDir, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.isFile() && (entry.name.endsWith(".json") || entry.name.endsWith(".md"))) {
        const filePath = path.join(contextDir, entry.name);
        const content = await fs.readFile(filePath, "utf-8");
        contextFiles[entry.name] = content;
      }
    }
  } catch (error) {
    logger.debug("No .ma/context directory found or error reading it", {
      contextDir,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  return contextFiles;
}

function truncate(value: any, max = 1000): string {
  const text =
    typeof value === "string"
      ? value
      : (() => {
          try {
            return JSON.stringify(value);
          } catch {
            return String(value);
          }
        })();

  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max} chars)`;
}

export function summarizePlanResult(event: any) {
  if (!event) return null;
  const fields = event.fields ?? {};
  const parsed = parseEventResult(fields.result);
  const planText =
    typeof parsed?.plan === "string"
      ? parsed.plan
      : (fields.result ?? undefined);
  const breakdown = Array.isArray(parsed?.breakdown)
    ? parsed.breakdown
    : undefined;
  const risks = Array.isArray(parsed?.risks) ? parsed.risks : undefined;

  const breakdownPreview = breakdown ? truncate(breakdown, 2000) : undefined;
  const risksPreview = risks ? truncate(risks, 1500) : undefined;

  return {
    corrId: fields.corr_id,
    status: event.status ?? fields.status ?? "unknown",
    planPreview: truncate(planText, 2000),
    breakdownSteps: breakdown?.length,
    breakdownPreview,
    riskCount: risks?.length,
    risksPreview,
    metadata: parsed?.metadata,
    rawLength:
      typeof fields.result === "string" ? fields.result.length : undefined,
  };
}

export function summarizeEvaluationResult(event: any) {
  if (!event) return null;
  const fields = event.fields ?? {};
  const payload = parseEventResult(fields.result);
  const normalized = interpretPersonaStatus(fields.result);

  return {
    corrId: fields.corr_id,
    status: event.status ?? fields.status ?? normalized.status ?? "unknown",
    normalizedStatus: normalized.status,
    statusDetails: truncate(payload, 1500),
    payloadPreview: truncate(fields.result, 1500),
    rawLength:
      typeof fields.result === "string" ? fields.result.length : undefined,
  };
}
