import { logger } from "../../logger.js";
import { cfg } from "../../config.js";
import fs from "fs/promises";
import path from "path";

export interface ContextExtractionParams {
  persona: string;
  workflowId: string;
  intent: string;
  payload: any;
  repo?: string;
  branch?: string;
}

export interface ExtractedContext {
  userText: string;
  scanSummary: string | null;
  dashboardContext: string | null;
}

export class ContextExtractor {
  async extractContext(
    params: ContextExtractionParams,
  ): Promise<ExtractedContext> {
    const { persona, repo, branch } = params;

    const userText = await this.extractUserText(params);

    const scanSummary = await this.extractScanSummary(persona, repo, branch);

    const dashboardContext = await this.extractDashboardContext(
      persona,
      params.payload,
    );

    return {
      userText,
      scanSummary,
      dashboardContext,
    };
  }

  async extractUserText(params: ContextExtractionParams): Promise<string> {
    const { persona, workflowId, intent, payload, repo } = params;

    if (payload.user_text) {
      return payload.user_text;
    }

    if (payload.plan_artifact) {
      const content = await this.readArtifact(
        persona,
        "plan_artifact",
        payload.plan_artifact,
        payload,
        repo,
      );
      if (content) return content;
    }

    if (payload.qa_result_artifact) {
      const content = await this.readArtifact(
        persona,
        "qa_result_artifact",
        payload.qa_result_artifact,
        payload,
        repo,
      );
      if (content) return content;
    }

    if (payload.context_artifact) {
      const content = await this.readArtifact(
        persona,
        "context_artifact",
        payload.context_artifact,
        payload,
        repo,
      );
      if (content) return content;
    }

    if (payload.task?.data?.description) {
      return this.buildTaskText(persona, workflowId, payload.task.data);
    }

    if (payload.task?.description) {
      return this.buildTaskText(persona, workflowId, payload.task);
    }

    if (payload.description) {
      logger.info("PersonaConsumer: Using payload.description", {
        persona,
        workflowId,
        descriptionLength: payload.description.length,
      });
      return payload.description;
    }

    const taskTitle = payload.task?.data?.title || payload.task?.title;
    const taskId = payload.task?.data?.id || payload.task?.id;
    if (taskTitle) {
      logger.error("PersonaConsumer: CRITICAL - Task has no description", {
        persona,
        workflowId,
        taskId,
        taskTitle,
        taskKeys: Object.keys(payload.task || {}),
        taskDataKeys: payload.task?.data ? Object.keys(payload.task.data) : [],
        reason: "Task description is required for planning and implementation",
      });
      throw new Error(
        `Task ${taskId} ("${taskTitle}") has no description. Cannot proceed with planning.`,
      );
    }

    logger.error("PersonaConsumer: No task context found in payload", {
      persona,
      workflowId,
      intent,
      payloadKeys: Object.keys(payload),
      hasTask: !!payload.task,
      taskKeys: payload.task ? Object.keys(payload.task) : [],
    });
    return intent || "planning";
  }

  private async readArtifact(
    persona: string,
    artifactType: string,
    artifactPath: string,
    payload: any,
    repo?: string,
  ): Promise<string | null> {
    try {
      const resolvedPath = this.resolveArtifactPath(artifactPath, payload);
      const content = await this.readArtifactFromGit(resolvedPath, repo);

      logger.info(`Loaded ${artifactType} from git`, {
        persona,
        artifactPath: resolvedPath,
        contentLength: content.length,
      });

      return content;
    } catch (error) {
      logger.error(`Failed to read ${artifactType} from git`, {
        persona,
        artifactPath,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  private buildTaskText(
    persona: string,
    workflowId: string,
    task: any,
  ): string {
    let userText = `Task: ${task.title || "Untitled"}\n\nDescription: ${task.description}`;

    logger.info("PersonaConsumer: Using task description", {
      persona,
      workflowId,
      taskId: task.id,
      taskTitle: task.title,
      hasDescription: true,
      descriptionLength: task.description.length,
    });

    if (task.type) {
      userText += `\n\nType: ${task.type}`;
    }
    if (task.scope) {
      userText += `\nScope: ${task.scope}`;
    }

    return userText;
  }

  private async extractScanSummary(
    persona: string,
    repo?: string,
    branch?: string,
  ): Promise<string | null> {
    if (!repo || !cfg.injectDashboardContext) {
      return null;
    }

    try {
      logger.debug(
        "PersonaConsumer: Repo context requested but not yet implemented",
        {
          persona,
          repo,
          branch,
        },
      );
      return null;
    } catch (error: any) {
      logger.warn("PersonaConsumer: Failed to get scan summary", {
        persona,
        repo,
        error: error.message,
      });
      return null;
    }
  }

  private async extractDashboardContext(
    _persona: string,
    _payload: any,
  ): Promise<string | null> {
    return null;
  }

  resolveArtifactPath(artifactPath: string, payload: any): string {
    let resolved = artifactPath;

    if (payload.repo) {
      const repoName =
        payload.repo.split("/").pop()?.replace(".git", "") || payload.repo;
      resolved = resolved.replace(/{repo}/g, repoName);
    }

    if (payload.branch) {
      resolved = resolved.replace(/{branch}/g, payload.branch);
    }

    if (payload.workflow_id) {
      resolved = resolved.replace(/{workflow_id}/g, payload.workflow_id);
    }

    return resolved;
  }

  async readArtifactFromGit(
    artifactPath: string,
    repoUrl: string | undefined,
  ): Promise<string> {
    if (!repoUrl) {
      throw new Error("Repository URL is required to read artifact");
    }

    const repoName = repoUrl.split("/").pop()?.replace(".git", "") || repoUrl;
    const repoPath = path.join(cfg.projectBase, repoName);

    const fullPath = path.join(repoPath, artifactPath);

    logger.debug("Reading artifact from git", {
      repoUrl,
      repoName,
      repoPath,
      artifactPath,
      fullPath,
    });

    try {
      const content = await fs.readFile(fullPath, "utf-8");
      return content;
    } catch (error) {
      logger.error("Failed to read artifact file", {
        fullPath,
        error: error instanceof Error ? error.message : String(error),
      });
      throw new Error(
        `Failed to read artifact at ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
}
