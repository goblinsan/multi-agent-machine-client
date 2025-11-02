import type { WorkflowContext } from "../../engine/WorkflowContext.js";

export function resolveBooleanExpression(
  value: any,
  context: WorkflowContext,
  lookup: (varPath: string) => any,
): boolean {
  if (value === undefined || value === null) {
    return false;
  }

  if (typeof value === "boolean") {
    return value;
  }

  if (typeof value === "number") {
    return value !== 0;
  }

  if (typeof value === "string") {
    const trimmed = value.trim();
    if (!trimmed.length) return false;

    if (trimmed.startsWith("${") && trimmed.endsWith("}")) {
      return resolveBooleanExpression(trimmed.slice(2, -1), context, lookup);
    }

    if (trimmed.includes("||")) {
      return trimmed
        .split("||")
        .map((segment) => segment.trim())
        .some((segment) => resolveBooleanExpression(segment, context, lookup));
    }

    const lowered = trimmed.toLowerCase();
    if (["true", "1", "yes", "y", "on"].includes(lowered)) return true;
    if (["false", "0", "no", "n", "off"].includes(lowered)) return false;

    const contextValue = lookup(trimmed);
    if (contextValue !== undefined) {
      return resolveBooleanExpression(contextValue, context, lookup);
    }

    return Boolean(trimmed);
  }

  return Boolean(value);
}

export function coalesceRescanFlags(
  context: WorkflowContext,
  rawForceRescan: any,
  lookup: (varPath: string) => any,
): boolean {
  const forceRescanFlag = lookup("force_rescan") ?? lookup("forceRescan");
  const legacyFlag = lookup("FORCE_RESCAN");

  let forceRescan = resolveBooleanExpression(forceRescanFlag, context, lookup);
  forceRescan ||= resolveBooleanExpression(legacyFlag, context, lookup);
  forceRescan ||= resolveBooleanExpression(rawForceRescan, context, lookup);

  return forceRescan;
}
