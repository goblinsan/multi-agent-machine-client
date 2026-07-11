import { normalizePlanPayload } from "./planningHelpers.js";

export type ImplementationStage = {
  index: number;
  total: number;
  goal: string;
  files: string[];
  acceptance: string[];
};

const MAX_STAGES = 10;

function normalizePaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) =>
      typeof entry === "string"
        ? entry.replace(/\\/g, "/").replace(/^\.\/+/, "").trim()
        : "",
    )
    .filter((entry) => entry.length > 0);
}

function normalizeStrings(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => (typeof entry === "string" ? entry.trim() : ""))
    .filter((entry) => entry.length > 0);
}

export function resolvePlanStages(
  planResult: unknown,
  fallbackFiles: string[],
): ImplementationStage[] {
  const singleStage: ImplementationStage[] = [
    {
      index: 1,
      total: 1,
      goal: "",
      files: [...fallbackFiles],
      acceptance: [],
    },
  ];

  if (!planResult) return singleStage;

  let planData: any = null;
  try {
    planData = normalizePlanPayload(planResult).planData;
  } catch {
    return singleStage;
  }

  const planSteps = Array.isArray(planData?.plan) ? planData.plan : [];
  if (planSteps.length <= 1 || planSteps.length > MAX_STAGES) {
    return singleStage;
  }

  const stages: ImplementationStage[] = [];
  for (const step of planSteps) {
    if (!step || typeof step !== "object") return singleStage;
    const files = normalizePaths((step as any).key_files);
    if (files.length === 0) return singleStage;
    stages.push({
      index: stages.length + 1,
      total: planSteps.length,
      goal:
        typeof (step as any).goal === "string"
          ? (step as any).goal.trim()
          : `Plan step ${stages.length + 1}`,
      files,
      acceptance: normalizeStrings((step as any).acceptance_criteria),
    });
  }

  return stages;
}

export function typecheckErrorSignature(input: {
  file: string;
  code?: string;
  message?: string;
  reason?: string;
}): string {
  const file = String(input.file || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .trim();
  const code =
    input.code ||
    /\b(TS\d+)\b/.exec(input.reason || "")?.[1] ||
    "unknown";
  const message = (input.message || input.reason || "")
    .replace(/\b\d+:\d+\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
  return `${file}|${code}|${message}`;
}
