import type { WorkflowContext } from "../../engine/WorkflowContext.js";
import { logger } from "../../../logger.js";

export function lookupContextValue(
  varPath: string,
  context: WorkflowContext,
): any {
  const cleanedPath = varPath.trim();
  if (!cleanedPath.length) return undefined;

  const parts = cleanedPath.split(".");
  const [firstPart, ...rest] = parts;

  let value: any;

  switch (firstPart) {
    case "repo_root":
      value = context.repoRoot;
      break;
    case "branch":
      value = context.branch;
      break;
    case "workflow_id":
      value = context.workflowId;
      break;
    case "project_id":
      value = context.projectId;
      break;
    default:
      value = context.getVariable(firstPart);
      break;
  }

  for (const segment of rest) {
    if (value && typeof value === "object" && segment in value) {
      value = value[segment];
    } else {
      return undefined;
    }
  }

  return value;
}

export function resolveVariables(
  value: string,
  context: WorkflowContext,
  lookup: (varPath: string) => any,
): string {
  return value.replace(/\$\{([^}]+)\}/g, (match, varPath) => {
    try {
      const resolved = lookup(varPath);
      if (resolved === undefined || resolved === null) {
        return match;
      }
      return typeof resolved === "string" ? resolved : String(resolved);
    } catch (error) {
      logger.warn(`Failed to resolve variable ${varPath}`, {
        error,
      });
      return match;
    }
  });
}

export function determineRepoPath(
  configuredRepoPath: string | undefined,
  context: WorkflowContext,
  lookup: (varPath: string) => any,
): string {
  if (typeof configuredRepoPath === "string" && configuredRepoPath.trim().length) {
    const resolved = resolveVariables(configuredRepoPath, context, lookup).trim();
    if (resolved && !resolved.includes("${")) {
      return resolved;
    }

    logger.warn(
      "ContextStep: repoPath could not be fully resolved, defaulting to workflow repo",
      {
        configuredRepoPath,
        resolved,
        workflowId: context.workflowId,
      },
    );
  }

  if (context.repoRoot) {
    return context.repoRoot;
  }

  const fallback = lookup("repo_root");
  if (typeof fallback === "string" && fallback.trim().length) {
    return fallback.trim();
  }

  const legacy = lookup("REPO_PATH");
  if (typeof legacy === "string" && legacy.trim().length) {
    return legacy.trim();
  }

  return "";
}
