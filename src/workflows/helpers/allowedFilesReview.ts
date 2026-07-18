import { WorkflowContext } from "../engine/WorkflowContext.js";

export type AllowedFilesFinding = {
  rule_id: string;
  file: string;
  line: number | null;
  issue: string;
  recommendation: string;
};

export type AllowedFilesRule = {
  severity?: "severe" | "high" | "medium" | "low";
  files?: string[];
  from_task_file_labels?: boolean;
};

export function collectAllowedFiles(
  rule: AllowedFilesRule,
  context: WorkflowContext,
): string[] {
  return Array.from(
    new Set(
      [
        ...(rule.files || []),
        ...(rule.from_task_file_labels
          ? resolveAllowedFilesFromTask(context)
          : []),
      ]
        .map((file) => String(file || "").trim().replace(/\\/g, "/"))
        .filter(Boolean),
    ),
  );
}

export function buildAllowedFilesFindings(
  files: string[],
  rule: AllowedFilesRule,
  context: WorkflowContext,
): AllowedFilesFinding[] {
  const allowed = collectAllowedFiles(rule, context);
  if (allowed.length === 0) return [];

  const allowedSet = new Set(allowed);
  return files
    .filter((file) => !allowedSet.has(file))
    .map((file) => ({
      rule_id: "allowed_files",
      file,
      line: null,
      issue: `${file} is outside the contracted file scope.`,
      recommendation: `Limit this task to: ${allowed.join(", ")}.`,
    }));
}

function resolveAllowedFilesFromTask(context: WorkflowContext): string[] {
  const task = context.getVariable("task");
  const labels = Array.isArray(task?.labels)
    ? task.labels
    : typeof task?.labels === "string"
      ? parseLabels(task.labels)
      : [];

  return Array.from(
    new Set(
      labels
        .filter((label: unknown) => typeof label === "string")
        .map((label: string) => label.trim())
        .filter((label: string) => label.startsWith("file:"))
        .map((label: string) =>
          label.slice("file:".length).trim().replace(/\\/g, "/"),
        )
        .filter(Boolean),
    ),
  );
}

function parseLabels(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.filter((value) => typeof value === "string")
      : [];
  } catch {
    return raw
      .split(",")
      .map((label) => label.trim())
      .filter(Boolean);
  }
}
