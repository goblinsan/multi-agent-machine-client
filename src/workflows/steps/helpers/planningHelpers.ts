import { randomUUID } from "crypto";
import {
  parseEventResult,
  interpretPersonaStatus,
  extractJsonPayloadFromText,
} from "../../../agents/persona.js";
import { logger } from "../../../logger.js";
import fs from "fs/promises";
import path from "path";
import {
  findLanguageViolationsForFiles,
  type LanguageViolation,
} from "./languagePolicy.js";
import { requiresStatus } from "./personaStatusPolicy.js";

export { collectAllowedLanguages } from "./languagePolicy.js";

export async function loadContextDirectory(
  repoRoot: string,
): Promise<Record<string, string>> {
  const contextDir = path.join(repoRoot, ".ma", "context");
  const contextFiles: Record<string, string> = {};

  try {
    const entries = await fs.readdir(contextDir, { withFileTypes: true });
    for (const entry of entries) {
      if (
        entry.isFile() &&
        (entry.name.endsWith(".json") || entry.name.endsWith(".md"))
      ) {
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
  const persona = fields.from_persona || fields.persona;
  const normalized = interpretPersonaStatus(fields.result, {
    persona,
    statusRequired: requiresStatus(persona),
  });

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

export function normalizePlanPayload(planResult: any) {
  const fields = planResult?.fields || {};
  const resultText = typeof fields.result === "string" ? fields.result : "";
  const parsed = parseEventResult(resultText);
  let planData = parsed;
  if (parsed?.output && typeof parsed.output === "string") {
    const structuredOutput =
      extractJsonPayloadFromText(parsed.output) || tryParseJson(parsed.output);
    if (structuredOutput && typeof structuredOutput === "object") {
      planData = structuredOutput;
    }
  }
  return { planData, parsed, rawText: resultText };
}

function tryParseJson(value: string): any | null {
  try {
    const trimmed = value.trim();
    if (!trimmed) return null;
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function normalizePlanFilePath(file: string): string {
  return file
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\/+/g, "")
    .replace(/\/{2,}/g, "/");
}

function buildAmbiguityKey(normalizedPath: string): string {
  if (!normalizedPath) return normalizedPath;
  const parsed = path.posix.parse(normalizedPath);
  const dir = parsed.dir === "." ? "" : parsed.dir;
  const dirPrefix = dir ? `${dir}/` : "";
  return `${dirPrefix}${parsed.name}`.replace(/\/$/, "");
}

export function collectPlanKeyFiles(planData: any): string[] {
  if (!planData?.plan || !Array.isArray(planData.plan)) return [];
  const files = new Set<string>();
  planData.plan.forEach((step: any) => {
    if (step && Array.isArray(step.key_files)) {
      step.key_files.forEach((file: any) => {
        if (typeof file === "string") {
          const trimmed = file.trim();
          if (trimmed.length > 0) {
            files.add(trimmed);
          }
        }
      });
    }
  });
  return Array.from(files);
}

export interface AmbiguousPlanKeyFiles {
  stepGoal: string;
  basePath: string;
  variants: string[];
}

export function findAmbiguousPlanKeyFiles(
  planData: any,
): AmbiguousPlanKeyFiles[] {
  if (!planData?.plan || !Array.isArray(planData.plan)) {
    return [];
  }

  const conflicts: AmbiguousPlanKeyFiles[] = [];

  planData.plan.forEach((step: any) => {
    if (!step || !Array.isArray(step.key_files) || step.key_files.length === 0)
      return;

    const perStepMap = new Map<string, Set<string>>();

    step.key_files.forEach((file: any) => {
      if (typeof file !== "string") return;
      const normalized = normalizePlanFilePath(file);
      if (!normalized) return;
      const key = buildAmbiguityKey(normalized);
      if (!key) return;

      if (!perStepMap.has(key)) {
        perStepMap.set(key, new Set());
      }
      perStepMap.get(key)!.add(normalized);
    });

    perStepMap.forEach((variants, key) => {
      if (variants.size > 1) {
        conflicts.push({
          stepGoal: typeof step.goal === "string" && step.goal.length > 0
            ? step.goal
            : "Unnamed step",
          basePath: key,
          variants: Array.from(variants).sort(),
        });
      }
    });
  });

  return conflicts;
}

export type PlanLanguageViolation = LanguageViolation;

export function findPlanLanguageViolations(
  planData: any,
  allowedLanguages: Set<string>,
): PlanLanguageViolation[] {
  if (!planData?.plan || allowedLanguages.size === 0) return [];
  const files = collectPlanKeyFiles(planData);
  return findLanguageViolationsForFiles(files, allowedLanguages);
}

export function buildSyntheticEvaluationFailure(
  reason: string,
  details: any,
  guard: string = "language_policy",
) {
  return {
    fields: {
      status: "done",
      corr_id: `guard-${guard}-${randomUUID()}`,
      result: JSON.stringify({
        status: "fail",
        reason,
        guard,
        details,
      }),
    },
  };
}

export function formatPlanArtifact(planResult: any, iteration: number): string {
  const { planData, rawText } = normalizePlanPayload(planResult);

  let content = `# Plan Iteration ${iteration}\n\n`;
  content += `Generated: ${new Date().toISOString()}\n\n`;

  if (planData?.plan && Array.isArray(planData.plan)) {
    content += `## Implementation Plan\n\n`;
    planData.plan.forEach((step: any, idx: number) => {
      content += `### Step ${idx + 1}: ${step.goal || "Untitled Step"}\n\n`;
      if (step.key_files && Array.isArray(step.key_files)) {
        content += `**Files:** ${step.key_files.map((f: string) => `\`${f}\``).join(", ")}\n\n`;
      }
      if (step.owners && Array.isArray(step.owners)) {
        content += `**Owners:** ${step.owners.join(", ")}\n\n`;
      }
      if (step.dependencies && Array.isArray(step.dependencies)) {
        content += `**Dependencies:**\n`;
        step.dependencies.forEach((dep: any) => {
          if (typeof dep === "string") {
            content += `  - ${dep}\n`;
          } else if (dep.goal || dep.dependency) {
            content += `  - ${dep.goal || dep.dependency}\n`;
          }
        });
        content += `\n`;
      }
      if (step.acceptance_criteria && Array.isArray(step.acceptance_criteria)) {
        content += `**Acceptance Criteria:**\n`;
        step.acceptance_criteria.forEach((ac: string) => {
          content += `  - ${ac}\n`;
        });
        content += `\n`;
      }
    });
  } else {
    const planText =
      typeof planData?.plan === "string" ? planData.plan : rawText;
    if (planText) {
      content += `## Plan\n\n${planText}\n\n`;
    }
  }

  if (
    planData?.risks &&
    Array.isArray(planData.risks) &&
    planData.risks.length > 0
  ) {
    content += `## Risks\n\n`;
    planData.risks.forEach((risk: any, idx: number) => {
      if (typeof risk === "object") {
        content += `${idx + 1}. **${risk.risk || risk.description || "Unknown Risk"}**\n`;
        if (risk.mitigation) {
          content += `   - Mitigation: ${risk.mitigation}\n`;
        }
      } else {
        content += `${idx + 1}. ${risk}\n`;
      }
    });
    content += `\n`;
  }

  if (
    planData?.open_questions &&
    Array.isArray(planData.open_questions) &&
    planData.open_questions.length > 0
  ) {
    content += `## Open Questions\n\n`;
    planData.open_questions.forEach((q: any, idx: number) => {
      if (typeof q === "object") {
        content += `${idx + 1}. ${q.question || q.description || JSON.stringify(q)}\n`;
        if (q.answer) {
          content += `   - Answer: ${q.answer}\n`;
        }
      } else {
        content += `${idx + 1}. ${q}\n`;
      }
    });
    content += `\n`;
  }

  if (
    planData?.notes &&
    Array.isArray(planData.notes) &&
    planData.notes.length > 0
  ) {
    content += `## Notes\n\n`;
    planData.notes.forEach((note: any, idx: number) => {
      if (typeof note === "object") {
        content += `${idx + 1}. ${note.note || note.description || JSON.stringify(note)}\n`;
        if (note.author) {
          content += `   - By: ${note.author}\n`;
        }
      } else {
        content += `${idx + 1}. ${note}\n`;
      }
    });
    content += `\n`;
  }

  if (planData?.metadata) {
    content += `## Metadata\n\n\`\`\`json\n${JSON.stringify(planData.metadata, null, 2)}\n\`\`\`\n`;
  }

  return content;
}

export function formatEvaluationArtifact(
  evaluationResult: any,
  iteration: number,
): string {
  const fields = evaluationResult?.fields || {};
  const parsed = parseEventResult(fields.result);
  const persona = fields.from_persona || fields.persona;
  const normalized = interpretPersonaStatus(fields.result, {
    persona,
    statusRequired: requiresStatus(persona),
  });

  let content = `# Plan Evaluation - Iteration ${iteration}\n\n`;
  content += `Generated: ${new Date().toISOString()}\n\n`;
  content += `**Status:** ${normalized.status}\n\n`;

  if (normalized.details) {
    content += `## Evaluation Details\n\n${normalized.details}\n\n`;
  }

  if (parsed && typeof parsed === "object") {
    content += `## Structured Feedback\n\n\`\`\`json\n${JSON.stringify(parsed, null, 2)}\n\`\`\`\n`;
  }

  return content;
}
