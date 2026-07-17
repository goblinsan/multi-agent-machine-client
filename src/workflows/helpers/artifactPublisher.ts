import path from "path";
import { logger } from "../../logger.js";
import { ArtifactAPI } from "../../dashboard/ArtifactAPI.js";

const artifactAPI = new ArtifactAPI();

export function inferArtifactKindFromPath(artifactPath: string): string {
  const base = path.basename(artifactPath);
  const withoutExt = base.replace(/\.[^.]+$/, "");
  return withoutExt.replace(/-/g, "_").toLowerCase();
}

export async function publishProjectArtifactToDashboard(input: {
  projectId: string | number | null | undefined;
  workflowId?: string | null;
  kind: string;
  content: string;
}): Promise<boolean> {
  if (!input.projectId) return false;

  try {
    const result = await artifactAPI.publishProjectArtifact({
      projectId: input.projectId,
      workflowId: input.workflowId ?? null,
      kind: input.kind,
      content: input.content,
    });

    if (!result.ok) {
      logger.warn("Project artifact publish to dashboard failed", {
        kind: input.kind,
        projectId: input.projectId,
        status: result.status,
        error: result.error,
      });
      return false;
    }

    logger.info("Project artifact published to dashboard", {
      kind: input.kind,
      projectId: input.projectId,
      artifactId: result.artifactId,
    });
    return true;
  } catch (error) {
    logger.warn("Project artifact publish to dashboard threw", {
      kind: input.kind,
      projectId: input.projectId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}

export async function publishArtifactToDashboard(input: {
  projectId: string | number | null | undefined;
  taskId: string | number | null | undefined;
  workflowId?: string | null;
  kind: string;
  iteration?: number | null;
  content: string;
}): Promise<boolean> {

  if (!input.projectId || !input.taskId || input.taskId === "unknown") {
    logger.debug("Artifact publish skipped: missing project or task id", {
      kind: input.kind,
      projectId: input.projectId,
      taskId: input.taskId,
    });
    return false;
  }

  try {
    const result = await artifactAPI.publishTaskArtifact({
      projectId: input.projectId,
      taskId: input.taskId,
      workflowId: input.workflowId ?? null,
      kind: input.kind,
      iteration: input.iteration ?? null,
      content: input.content,
    });

    if (!result.ok) {
      logger.warn("Artifact publish to dashboard failed", {
        kind: input.kind,
        taskId: input.taskId,
        status: result.status,
        error: result.error,
      });
      return false;
    }

    logger.info("Artifact published to dashboard", {
      kind: input.kind,
      taskId: input.taskId,
      iteration: input.iteration ?? undefined,
      artifactId: result.artifactId,
    });
    return true;
  } catch (error) {
    logger.warn("Artifact publish to dashboard threw", {
      kind: input.kind,
      taskId: input.taskId,
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
