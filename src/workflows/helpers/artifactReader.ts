import { logger } from "../../logger.js";
import { ArtifactAPI } from "../../dashboard/ArtifactAPI.js";

const artifactAPI = new ArtifactAPI();

export type ArtifactRef = { kind: string; iteration?: number };

const REVIEW_KIND_BY_BASENAME: Record<string, string> = {
  "qa.json": "qa",
  "code-review.json": "code_review",
  "security.json": "security",
  "devops.json": "devops",
};

export function resolveArtifactRefFromPath(
  artifactPath: string,
): ArtifactRef | null {
  const normalized = artifactPath.replace(/\\/g, "/");
  const base = normalized.split("/").pop() || "";

  const planIteration = /^02-plan-iteration-(\d+)\.md$/.exec(base);
  if (planIteration) {
    return { kind: "plan", iteration: parseInt(planIteration[1], 10) };
  }

  const evalIteration = /^02-plan-eval-iteration-(\d+)\.md$/.exec(base);
  if (evalIteration) {
    return { kind: "plan_eval", iteration: parseInt(evalIteration[1], 10) };
  }

  if (base === "03-plan-final.md") {
    return { kind: "plan_final" };
  }

  if (REVIEW_KIND_BY_BASENAME[base]) {
    return { kind: REVIEW_KIND_BY_BASENAME[base] };
  }

  return null;
}

export async function fetchArtifactContentFromApi(input: {
  projectId: string | number | null | undefined;
  taskId: string | number | null | undefined;
  kind: string;
  iteration?: number;
}): Promise<string | null> {

  const { projectId, taskId, kind, iteration } = input;
  if (!projectId || !taskId || taskId === "unknown") return null;

  try {
    const artifacts = await artifactAPI.fetchTaskArtifacts({
      projectId,
      taskId,
      kind,
      latest: iteration === undefined,
    });

    if (!artifacts || artifacts.length === 0) return null;

    const match =
      iteration === undefined
        ? artifacts[0]
        : artifacts.find((a) => a.iteration === iteration);

    if (!match || typeof match.content !== "string") return null;

    logger.info("Loaded artifact from dashboard API", {
      taskId,
      kind,
      iteration: iteration ?? match.iteration ?? undefined,
      byteSize: match.byte_size,
    });
    return match.content;
  } catch (error) {
    logger.debug("Artifact API read failed, caller will fall back", {
      taskId,
      kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function fetchProjectArtifactContentFromApi(input: {
  projectId: string | number | null | undefined;
  kind: string;
}): Promise<string | null> {
  if (!input.projectId) return null;

  try {
    const artifacts = await artifactAPI.fetchProjectArtifacts({
      projectId: input.projectId,
      kind: input.kind,
      latest: true,
    });

    if (!artifacts || artifacts.length === 0) return null;
    const match = artifacts[0];
    if (typeof match.content !== "string") return null;

    logger.info("Loaded project artifact from dashboard API", {
      projectId: input.projectId,
      kind: input.kind,
      byteSize: match.byte_size,
    });
    return match.content;
  } catch (error) {
    logger.debug("Project artifact API read failed, caller will fall back", {
      projectId: input.projectId,
      kind: input.kind,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function fetchArtifactContentForPath(input: {
  projectId: string | number | null | undefined;
  taskId: string | number | null | undefined;
  artifactPath: string;
}): Promise<string | null> {
  const ref = resolveArtifactRefFromPath(input.artifactPath);
  if (!ref) return null;
  return fetchArtifactContentFromApi({
    projectId: input.projectId,
    taskId: input.taskId,
    kind: ref.kind,
    iteration: ref.iteration,
  });
}
