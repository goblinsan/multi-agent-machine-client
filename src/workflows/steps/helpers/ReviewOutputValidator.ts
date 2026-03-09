import { logger } from "../../../logger.js";

export interface ReviewFinding {
  file?: string;
  line?: number | null;
  issue?: string;
  recommendation?: string;
  category?: string;
  vulnerability?: string;
  impact?: string;
  mitigation?: string;
}

export interface ReviewFindings {
  severe?: ReviewFinding[];
  high?: ReviewFinding[];
  medium?: ReviewFinding[];
  low?: ReviewFinding[];
}

export interface ValidationContext {
  persona: string;
  workflowId: string;
  step: string;
  corrId: string;
  changedFiles?: string[];
  repoPaths?: string[];
}

export interface ValidationResult {
  valid: boolean;
  overrideStatus?: "pass" | "fail";
  reason?: string;
  droppedFindings?: ReviewFinding[];
}

const KNOWN_HALLUCINATION_PATTERNS = [
  /insecure dependency.*zod/i,
  /code injection.*zod/i,
  /arbitrary code execution.*(?:zod|ajv|yup|joi)/i,
  /(?:prototype pollution|RCE).*(?:zod|ajv|yup|joi|typescript|eslint)/i,
  /package-lock\.json.*(?:large|too big|size|bloat)/i,
];

const STANDARD_PROJECT_ARTIFACTS = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  ".gitignore",
  "license",
  "LICENSE",
  "LICENSE.md",
  ".env.example",
]);

export function validateReviewFindings(
  payload: any,
  status: "pass" | "fail" | "unknown",
  ctx: ValidationContext,
): ValidationResult {
  if (status === "pass" || status === "unknown") {
    return { valid: true };
  }

  const findings = extractFindings(payload);
  if (!findings) {
    return { valid: true };
  }

  const blockingFindings = [
    ...(findings.severe || []),
    ...(findings.high || []),
  ];

  if (blockingFindings.length === 0) {
    logger.warn("Review returned fail status but has no severe/high findings", {
      persona: ctx.persona,
      workflowId: ctx.workflowId,
      step: ctx.step,
      corrId: ctx.corrId,
    });
    return {
      valid: false,
      overrideStatus: "pass",
      reason: "Review failed with no blocking findings — overriding to pass",
    };
  }

  const hallucinated = detectHallucinatedFindings(blockingFindings);
  if (hallucinated.length > 0 && hallucinated.length === blockingFindings.length) {
    logger.warn(
      "All blocking findings match known hallucination patterns — overriding to pass",
      {
        persona: ctx.persona,
        workflowId: ctx.workflowId,
        step: ctx.step,
        corrId: ctx.corrId,
        hallucinatedCount: hallucinated.length,
        patterns: hallucinated.map((f) => f.issue || f.vulnerability || ""),
      },
    );
    return {
      valid: false,
      overrideStatus: "pass",
      reason: `All ${hallucinated.length} blocking findings matched hallucination patterns`,
      droppedFindings: hallucinated,
    };
  }

  if (ctx.changedFiles && ctx.changedFiles.length > 0) {
    const { valid: filesValid, unmatched } = validateFindingFiles(
      blockingFindings,
      ctx.changedFiles,
      ctx.repoPaths,
    );

    if (!filesValid && unmatched.length === blockingFindings.length) {
      logger.warn(
        "All blocking findings reference files outside the change set — overriding to pass",
        {
          persona: ctx.persona,
          workflowId: ctx.workflowId,
          step: ctx.step,
          corrId: ctx.corrId,
          unmatchedCount: unmatched.length,
          changedFileCount: ctx.changedFiles.length,
          unmatchedFiles: unmatched
            .map((f) => f.file)
            .filter(Boolean)
            .slice(0, 5),
        },
      );
      return {
        valid: false,
        overrideStatus: "pass",
        reason: `All ${unmatched.length} blocking findings reference files outside the change set`,
        droppedFindings: unmatched,
      };
    }
  }

  const artifactFindings = blockingFindings.filter(
    (f) => f.file && isStandardArtifact(f.file),
  );
  if (
    artifactFindings.length > 0 &&
    artifactFindings.length === blockingFindings.length
  ) {
    logger.warn(
      "All blocking findings target standard project artifacts — overriding to pass",
      {
        persona: ctx.persona,
        workflowId: ctx.workflowId,
        step: ctx.step,
        corrId: ctx.corrId,
        artifacts: artifactFindings.map((f) => f.file),
      },
    );
    return {
      valid: false,
      overrideStatus: "pass",
      reason: "All blocking findings target standard project artifacts (lock files, licenses)",
      droppedFindings: artifactFindings,
    };
  }

  return { valid: true };
}

function extractFindings(payload: any): ReviewFindings | null {
  if (!payload || typeof payload !== "object") return null;
  if (payload.findings && typeof payload.findings === "object") {
    return payload.findings;
  }
  if (Array.isArray(payload.severe) || Array.isArray(payload.high)) {
    return payload as ReviewFindings;
  }
  return null;
}

function detectHallucinatedFindings(
  findings: ReviewFinding[],
): ReviewFinding[] {
  return findings.filter((finding) => {
    const text = [
      finding.issue,
      finding.vulnerability,
      finding.recommendation,
      finding.impact,
      finding.category,
    ]
      .filter(Boolean)
      .join(" ");

    return KNOWN_HALLUCINATION_PATTERNS.some((pattern) => pattern.test(text));
  });
}

function validateFindingFiles(
  findings: ReviewFinding[],
  changedFiles: string[],
  repoPaths?: string[],
): { valid: boolean; unmatched: ReviewFinding[] } {
  const normalizedChanged = new Set(
    changedFiles.map((f) => normalizePath(f)),
  );
  const normalizedRepo = repoPaths
    ? new Set(repoPaths.map((f) => normalizePath(f)))
    : null;

  const unmatched: ReviewFinding[] = [];

  for (const finding of findings) {
    if (!finding.file) continue;

    const normalizedFile = normalizePath(finding.file);

    const inChangeSet = normalizedChanged.has(normalizedFile) ||
      [...normalizedChanged].some(
        (changed) =>
          changed.endsWith(normalizedFile) ||
          normalizedFile.endsWith(changed),
      );

    if (inChangeSet) continue;

    const inRepo = normalizedRepo
      ? normalizedRepo.has(normalizedFile) ||
        [...normalizedRepo].some(
          (known) =>
            known.endsWith(normalizedFile) ||
            normalizedFile.endsWith(known),
        )
      : true;

    if (!inRepo) {
      unmatched.push(finding);
    }
  }

  return {
    valid: unmatched.length === 0,
    unmatched,
  };
}

function normalizePath(filePath: string): string {
  return filePath
    .replace(/^\/+/, "")
    .replace(/\\/g, "/")
    .toLowerCase();
}

function isStandardArtifact(filePath: string): boolean {
  const basename = filePath.split("/").pop() || filePath;
  return STANDARD_PROJECT_ARTIFACTS.has(basename);
}
