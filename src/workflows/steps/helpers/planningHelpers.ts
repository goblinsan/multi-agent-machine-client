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
  sanitizeVerificationOnlySteps(planData);
  return { planData, parsed, rawText: resultText };
}

const VERIFICATION_GOAL_PATTERN =
  /\b(verify|verification|run(ning)?\s+(the\s+)?(full\s+)?tests?|test\s+suite|typecheck|type-check|run\s+lint|smoke\s*test|regression\s+(test|suite|check))\b/i;
const IMPLEMENTATION_GOAL_PATTERN =
  /\b(add|create|define|implement|modify|update|fix|repair|replace|write)\b/i;

export function sanitizeVerificationOnlySteps(planData: any): void {
  if (!Array.isArray(planData?.plan)) return;

  const removed: string[] = [];
  planData.plan = planData.plan.filter((step: any) => {
    const goal = typeof step?.goal === "string" ? step.goal : "";
    if (!VERIFICATION_GOAL_PATTERN.test(goal)) return true;
    if (IMPLEMENTATION_GOAL_PATTERN.test(goal)) return true;

    removed.push(goal || "unnamed step");
    return false;
  });

  if (removed.length > 0) {
    logger.info(
      "Removed verification-only plan steps - the workflow validates each step automatically",
      { removed },
    );
  }
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
  if (parsed.name === "index" && dir) {
    return dir;
  }
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

export type DeterministicPlanValidationIssue = {
  guard: string;
  reason: string;
  details?: Record<string, unknown>;
};

export type DeterministicPlanValidationResult = {
  valid: boolean;
  issues: DeterministicPlanValidationIssue[];
};

export function validateDeterministicPlan(
  planData: any,
  options: {
    existingPaths?: Set<string>;
    allowedLanguages?: Set<string>;
    taskTitle?: string;
    taskDescription?: string;
    requiredScopeFiles?: string[];
  } = {},
): DeterministicPlanValidationResult {
  const issues: DeterministicPlanValidationIssue[] = [];

  if (!planData || typeof planData !== "object" || Array.isArray(planData)) {
    issues.push({
      guard: "plan_schema",
      reason: "Plan payload must be a JSON object.",
    });
    return { valid: false, issues };
  }

  if (!Array.isArray(planData.plan) || planData.plan.length === 0) {
    issues.push({
      guard: "plan_schema",
      reason: "Plan payload must contain a non-empty plan array.",
    });
    return { valid: false, issues };
  }

  planData.plan.forEach((step: any, index: number) => {
    const stepLabel = `Step ${index + 1}`;
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      issues.push({
        guard: "plan_schema",
        reason: `${stepLabel} must be an object.`,
      });
      return;
    }

    if (typeof step.goal !== "string" || step.goal.trim().length === 0) {
      issues.push({
        guard: "plan_schema",
        reason: `${stepLabel} must include a concrete goal.`,
      });
    }

    if (!Array.isArray(step.key_files) || step.key_files.length === 0) {
      issues.push({
        guard: "key_files",
        reason: `${stepLabel} must include at least one key_files entry.`,
      });
      return;
    }

    step.key_files.forEach((entry: any) => {
      if (typeof entry !== "string" || entry.trim().length === 0) {
        issues.push({
          guard: "key_files",
          reason: `${stepLabel} has an empty or non-string key_files entry.`,
        });
        return;
      }

      const normalized = normalizePlanFilePath(entry);
      const invalidReason = validateConcreteKeyFilePath(normalized);
      if (invalidReason) {
        issues.push({
          guard: "key_files",
          reason: `${stepLabel} key_files entry '${entry}' is not concrete: ${invalidReason}`,
        });
      }
    });
  });

  for (const conflict of findAmbiguousPlanKeyFiles(planData)) {
    issues.push({
      guard: "ambiguous_key_files",
      reason: `${conflict.stepGoal} lists mutually exclusive key_files alternatives: ${conflict.variants.join(" vs ")}`,
      details: { conflict },
    });
  }

  const requiredScopeFiles = Array.from(
    new Set(
      (options.requiredScopeFiles || [])
        .map((file) => normalizePlanFilePath(file))
        .filter((file) => file.length > 0),
    ),
  );
  if (requiredScopeFiles.length > 0) {
    const plannedFiles = new Set(collectPlanKeyFiles(planData).map(normalizePlanFilePath));
    const missing = requiredScopeFiles.filter((file) => !plannedFiles.has(file));
    if (missing.length > 0) {
      issues.push({
        guard: "scope_viability_required_files",
        reason:
          "Scope expansion is required. The plan must include root-cause files: " +
          missing.map((file) => `'${file}'`).join(", ") + ".",
        details: {
          required_scope_files: requiredScopeFiles,
          missing_scope_files: missing,
        },
      });
    }
  }

  const dependencyIssues = validatePlanDependencyGraph(planData);
  issues.push(...dependencyIssues);

  const targetedBaselineFiles = extractTargetedBaselineCompileFiles(
    `${options.taskTitle || ""}\n${options.taskDescription || ""}`,
  );
  if (targetedBaselineFiles.length > 0) {
    const allowedTargets = new Set(targetedBaselineFiles);
    const outOfScopeFiles = collectPlanKeyFiles(planData)
      .map(normalizePlanFilePath)
      .filter((file) => file && !allowedTargets.has(file));

    if (outOfScopeFiles.length > 0) {
      issues.push({
        guard: "targeted_task_scope",
        reason:
          "Baseline compile-error tasks are file-scoped. Plan key_files must stay limited to " +
          `${targetedBaselineFiles.map((file) => `'${file}'`).join(", ")}; ` +
          `remove out-of-scope files: ${Array.from(new Set(outOfScopeFiles)).map((file) => `'${file}'`).join(", ")}.`,
        details: {
          targeted_files: targetedBaselineFiles,
          out_of_scope_files: Array.from(new Set(outOfScopeFiles)),
        },
      });
    }
  }

  const allowedLanguages = options.allowedLanguages ?? new Set<string>();
  if (allowedLanguages.size > 0) {
    for (const violation of findPlanLanguageViolations(planData, allowedLanguages)) {
      issues.push({
        guard: "language_policy",
        reason: `Plan introduces unsupported language: ${violation.file} (${violation.language})`,
        details: { violation },
      });
    }
  }

  const existingPaths = options.existingPaths ?? new Set<string>();
  if (existingPaths.size > 0) {
    for (const file of collectPlanKeyFiles(planData)) {
      const normalized = normalizePlanFilePath(file);
      if (!normalized || existingPaths.has(normalized)) continue;
      const invalidReason = validateConcreteKeyFilePath(normalized);
      if (invalidReason) continue;
      const nearby = findNearbyExistingPaths(normalized, existingPaths);
      if (nearby.length > 0) {
        issues.push({
          guard: "path_violations",
          reason: `'${file}' does not exist. Did you mean: ${nearby.map((match) => `'${match}'`).join(" or ")}?`,
          details: { file, suggestions: nearby },
        });
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

export function extractTargetedBaselineCompileFiles(text: string): string[] {
  const files = new Set<string>();
  const pattern =
    /\bFix\s+baseline\s+compile\s+errors?\s+in\s+([A-Za-z0-9_.@/+\\-]+\.[A-Za-z0-9]+)\b/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    const normalized = normalizePlanFilePath(match[1]);
    if (validateConcreteKeyFilePath(normalized) === null) {
      files.add(normalized);
    }
  }
  return Array.from(files);
}

function validateConcreteKeyFilePath(normalized: string): string | null {
  if (!normalized) return "path is empty";
  if (normalized.startsWith("/") || normalized.includes("..")) {
    return "path must stay inside the repository";
  }
  if (normalized.includes("*") || normalized.includes("{") || normalized.includes("}")) {
    return "glob patterns are not allowed";
  }
  if (/\b(or|and\/or)\b/i.test(normalized) || normalized.includes("|")) {
    return "alternatives are not allowed";
  }
  if (normalized.endsWith("/")) {
    return "directory placeholders are not allowed";
  }
  if (normalized.includes("...") || /<[^>]+>/.test(normalized)) {
    return "placeholder paths are not allowed";
  }
  const base = normalized.split("/").pop() || "";
  if (!base.includes(".")) {
    return "file path must include a concrete filename and extension";
  }
  return null;
}

function validatePlanDependencyGraph(
  planData: any,
): DeterministicPlanValidationIssue[] {
  if (!Array.isArray(planData?.plan)) return [];

  const issues: DeterministicPlanValidationIssue[] = [];
  const steps = planData.plan;
  const edges = new Map<number, number[]>();
  const goalToIndex = new Map<string, number>();

  steps.forEach((step: any, index: number) => {
    edges.set(index, []);
    if (typeof step?.goal === "string" && step.goal.trim()) {
      goalToIndex.set(step.goal.trim().toLowerCase(), index);
    }
  });

  steps.forEach((step: any, index: number) => {
    const dependencies = Array.isArray(step?.dependencies)
      ? step.dependencies
      : Array.isArray(step?.depends_on)
        ? step.depends_on
        : [];

    for (const dependency of dependencies) {
      const depIndex = resolveDependencyIndex(dependency, goalToIndex);
      if (depIndex === null) continue;
      if (depIndex === index) {
        issues.push({
          guard: "dependency_graph",
          reason: `Step ${index + 1} depends on itself.`,
        });
      }
      edges.get(index)!.push(depIndex);
    }
  });

  const visiting = new Set<number>();
  const visited = new Set<number>();

  const visit = (node: number, stack: number[]): boolean => {
    if (visiting.has(node)) {
      const cycle = [...stack, node].map((idx) => `Step ${idx + 1}`);
      issues.push({
        guard: "dependency_graph",
        reason: `Plan dependency graph contains a cycle: ${cycle.join(" -> ")}`,
      });
      return true;
    }
    if (visited.has(node)) return false;
    visiting.add(node);
    for (const dep of edges.get(node) || []) {
      visit(dep, [...stack, node]);
    }
    visiting.delete(node);
    visited.add(node);
    return false;
  };

  for (let i = 0; i < steps.length; i++) {
    visit(i, []);
  }

  return issues;
}

function resolveDependencyIndex(
  dependency: any,
  goalToIndex: Map<string, number>,
): number | null {
  if (typeof dependency === "number" && Number.isInteger(dependency)) {
    return dependency > 0 ? dependency - 1 : dependency;
  }
  if (typeof dependency === "string") {
    const trimmed = dependency.trim();
    const stepMatch = trimmed.match(/^step\s+(\d+)$/i);
    if (stepMatch) return parseInt(stepMatch[1], 10) - 1;
    if (/^\d+$/.test(trimmed)) return parseInt(trimmed, 10) - 1;
    return goalToIndex.get(trimmed.toLowerCase()) ?? null;
  }
  if (dependency && typeof dependency === "object") {
    return resolveDependencyIndex(
      dependency.step ??
        dependency.step_index ??
        dependency.stepNumber ??
        dependency.goal ??
        dependency.dependency,
      goalToIndex,
    );
  }
  return null;
}

function findNearbyExistingPaths(file: string, existingPaths: Set<string>): string[] {
  const fileNorm = file.replace(/\\/g, "/");
  const fileLower = fileNorm.toLowerCase();
  const fileBase = fileNorm.split("/").pop() || "";
  const fileBaseLower = fileBase.toLowerCase();
  const matches: string[] = [];

  for (const p of existingPaths) {
    const pLower = p.toLowerCase();
    const pBase = p.split("/").pop() || "";
    const pBaseLower = pBase.toLowerCase();
    const fileBaseNoExt = fileBase.substring(0, fileBase.lastIndexOf(".")) || fileBase;
    const pBaseNoExt = pBase.substring(0, pBase.lastIndexOf(".")) || pBase;

    if (
      pLower === fileLower ||
      fileBaseLower === pBaseLower ||
      (fileBaseNoExt.toLowerCase() === pBaseNoExt.toLowerCase() &&
        p.split("/").slice(0, -1).join("/") === fileNorm.split("/").slice(0, -1).join("/")) ||
      p.endsWith(`/${fileNorm}`) ||
      fileNorm.endsWith(`/${p}`)
    ) {
      matches.push(p);
    }
  }

  if (matches.length === 0 && fileBase.length > 3) {
    for (const p of existingPaths) {
      const pBase = p.split("/").pop() || "";
      if (levenshtein(fileBase.toLowerCase(), pBase.toLowerCase()) <= 2) {
        matches.push(p);
      }
    }
  }

  return [...new Set(matches)].slice(0, 3);
}

function levenshtein(a: string, b: string): number {
  const matrix = Array.from({ length: a.length + 1 }, () =>
    Array(b.length + 1).fill(0),
  );
  for (let i = 0; i <= a.length; i++) matrix[i][0] = i;
  for (let j = 0; j <= b.length; j++) matrix[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      matrix[i][j] =
        a[i - 1] === b[j - 1]
          ? matrix[i - 1][j - 1]
          : Math.min(matrix[i - 1][j - 1] + 1, matrix[i][j - 1] + 1, matrix[i - 1][j] + 1);
    }
  }
  return matrix[a.length][b.length];
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
