import path from "path";

export type ParsedTypecheckError = {
  file: string;
  reason: string;
  code?: string;
  message?: string;
  line?: number;
  column?: number;
};

export type ValidationFailureScope =
  | "inside_plan_scope"
  | "requires_scope_expansion"
  | "preexisting_unrelated"
  | "blocked_by_dependency";

export type ScopedValidationFailure = ParsedTypecheckError & {
  scope: ValidationFailureScope;
  requiredFiles: string[];
};

const MAX_REASON_CHARS = 220;

export function normalizeWorkflowPath(input: string): string {
  return String(input || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .trim();
}

export function normalizeDiagnosticPath(input: string, repoRoot: string): string {
  const normalized = normalizeWorkflowPath(input);
  const repoNormalized = normalizeWorkflowPath(repoRoot);
  if (path.isAbsolute(normalized)) {
    return normalizeWorkflowPath(path.relative(repoRoot, normalized));
  }
  if (repoNormalized && normalized.startsWith(`${repoNormalized}/`)) {
    return normalizeWorkflowPath(normalized.slice(repoNormalized.length + 1));
  }
  return normalized;
}

export function parseTypecheckErrors(
  output: string,
  repoRoot: string,
): ParsedTypecheckError[] {
  const errors: ParsedTypecheckError[] = [];
  const seen = new Set<string>();
  const lineRegex =
    /^([A-Za-z0-9_./\\:@+-]+\.(?:ts|tsx|js|jsx|mts|cts))\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/;

  for (const rawLine of output.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = line.match(lineRegex);
    if (!match) continue;
    const file = normalizeDiagnosticPath(match[1], repoRoot);
    const key = `${file}:${match[2]}:${match[3]}:${match[4]}:${match[5]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    errors.push({
      file,
      reason: `Typecheck ${match[4]} at ${file}:${match[2]}:${match[3]} - ${truncateDiagnostic(match[5], MAX_REASON_CHARS)}`,
      code: match[4],
      message: match[5],
      line: Number(match[2]),
      column: Number(match[3]),
    });
  }

  return errors;
}

export function classifyValidationFailures(
  errors: ParsedTypecheckError[],
  editableFiles: string[],
  options: {
    candidateFiles?: string[];
    baselineFiles?: string[];
  } = {},
): ScopedValidationFailure[] {
  const editable = new Set(editableFiles.map(normalizeWorkflowPath));
  const candidates = new Set((options.candidateFiles || []).map(normalizeWorkflowPath));
  const baseline = new Set((options.baselineFiles || []).map(normalizeWorkflowPath));

  return errors.map((error) => {
    const file = normalizeWorkflowPath(error.file);
    const requiredFiles = inferRequiredFiles(error, editable, candidates);
    let scope: ValidationFailureScope = "inside_plan_scope";

    if (requiredFiles.length > 0) {
      scope = "requires_scope_expansion";
    } else if (baseline.has(file)) {
      scope = "preexisting_unrelated";
    } else if (!editable.has(file)) {
      scope = "requires_scope_expansion";
    }

    return {
      ...error,
      file,
      scope,
      requiredFiles,
    };
  });
}

export function summarizeScopeExpansion(failures: ScopedValidationFailure[]): {
  requiredFiles: string[];
  blockedFiles: string[];
  reasons: string[];
} {
  const requiredFiles = new Set<string>();
  const blockedFiles = new Set<string>();
  const reasons: string[] = [];

  for (const failure of failures) {
    if (failure.scope !== "requires_scope_expansion") continue;
    blockedFiles.add(failure.file);
    for (const file of failure.requiredFiles) {
      requiredFiles.add(file);
    }
    reasons.push(`${failure.file}: ${failure.message || failure.reason}`);
  }

  return {
    requiredFiles: Array.from(requiredFiles).sort(),
    blockedFiles: Array.from(blockedFiles).sort(),
    reasons,
  };
}

function inferRequiredFiles(
  error: ParsedTypecheckError,
  editable: Set<string>,
  candidates: Set<string>,
): string[] {
  const message = error.message || error.reason || "";
  const file = normalizeWorkflowPath(error.file);
  const inferred = new Set<string>();

  for (const candidate of candidates) {
    if (!candidate || editable.has(candidate)) continue;
    if (isLikelyCausalCandidate(file, message, candidate)) {
      inferred.add(candidate);
    }
  }

  return Array.from(inferred).sort();
}

function isLikelyCausalCandidate(
  failingFile: string,
  message: string,
  candidate: string,
): boolean {
  const lowerMessage = message.toLowerCase();
  const lowerCandidate = candidate.toLowerCase();
  const sameDir =
    path.posix.dirname(failingFile) === path.posix.dirname(candidate);

  if (
    sameDir &&
    /(schema|type|interface|config)/.test(lowerCandidate) &&
    /(does not exist in type|known properties|not assignable to type|missing the following properties)/.test(
      lowerMessage,
    )
  ) {
    return true;
  }

  if (
    /(schema|zod|infer|config)/.test(lowerMessage) &&
    /(schema|types?|config)/.test(lowerCandidate)
  ) {
    return true;
  }

  const candidateBase = path.posix.basename(lowerCandidate).replace(/\.[^.]+$/, "");
  if (
    candidateBase.length >= 4 &&
    lowerMessage.includes(candidateBase.toLowerCase())
  ) {
    return true;
  }

  if (
    /(logevent|rawlogmessage|logeventtype)/.test(lowerMessage) &&
    /types\/(logevent|index)\.ts$/.test(lowerCandidate)
  ) {
    return true;
  }

  return false;
}

function truncateDiagnostic(input: string, maxChars: number): string {
  const normalized = input.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxChars) return normalized;
  return `${normalized.slice(0, maxChars)}...`;
}
