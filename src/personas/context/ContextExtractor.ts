import { logger } from '../../logger.js';
import { cfg } from '../../config.js';
import fs from 'fs/promises';
import path from 'path';

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

/**
 * ContextExtractor - Extracts and builds context for persona requests
 * 
 * Responsibilities:
 * - Extract user text from various payload sources (priority: user_text > artifacts > task > description > intent)
 * - Read artifacts from git repositories
 * - Fetch scan summaries (future)
 * - Fetch dashboard context (future)
 * - Resolve artifact path variables
 */
export class ContextExtractor {
  /**
   * Extract all context needed for a persona request
   */
  async extractContext(params: ContextExtractionParams): Promise<ExtractedContext> {
    const { persona, workflowId, intent, payload, repo, branch } = params;

    // Extract user text from payload (priority order)
    const userText = await this.extractUserText(params);

    // Get scan summary if repo provided
    const scanSummary = await this.extractScanSummary(persona, repo, branch);

    // Get dashboard context if project/task provided
    const dashboardContext = await this.extractDashboardContext(persona, payload);

    return {
      userText,
      scanSummary,
      dashboardContext
    };
  }

  /**
   * Extract user text from payload with priority:
   * 1. user_text (explicit)
   * 2. plan_artifact (from git)
   * 3. qa_result_artifact (from git)
   * 4. context_artifact (from git)
   * 5. task.description
   * 6. description
   * 7. task.title (ERROR - should have description)
   * 8. intent (fallback)
   */
  async extractUserText(params: ContextExtractionParams): Promise<string> {
    const { persona, workflowId, intent, payload, repo } = params;

    // Priority 1: Explicit user_text
    if (payload.user_text) {
      return payload.user_text;
    }

    // Priority 2: plan_artifact from git
    if (payload.plan_artifact) {
      const content = await this.readArtifact(persona, 'plan_artifact', payload.plan_artifact, payload, repo);
      if (content) return content;
    }

    // Priority 3: qa_result_artifact from git
    if (payload.qa_result_artifact) {
      const content = await this.readArtifact(persona, 'qa_result_artifact', payload.qa_result_artifact, payload, repo);
      if (content) return content;
    }

    // Priority 4: context_artifact from git
    if (payload.context_artifact) {
      const content = await this.readArtifact(persona, 'context_artifact', payload.context_artifact, payload, repo);
      if (content) return content;
    }

    // Priority 5: task.description
    if (payload.task && payload.task.description) {
      return this.buildTaskText(persona, workflowId, payload.task);
    }

    // Priority 6: payload.description
    if (payload.description) {
      logger.info('PersonaConsumer: Using payload.description', {
        persona,
        workflowId,
        descriptionLength: payload.description.length
      });
      return payload.description;
    }

    // Priority 7: task.title only (ERROR - missing description)
    if (payload.task && payload.task.title) {
      logger.error('PersonaConsumer: CRITICAL - Task has no description', {
        persona,
        workflowId,
        taskId: payload.task.id,
        taskTitle: payload.task.title,
        taskKeys: Object.keys(payload.task),
        reason: 'Task description is required for planning and implementation'
      });
      throw new Error(`Task ${payload.task.id} ("${payload.task.title}") has no description. Cannot proceed with planning.`);
    }

    // Priority 8: Fallback to intent (log error)
    logger.error('PersonaConsumer: No task context found in payload', {
      persona,
      workflowId,
      intent,
      payloadKeys: Object.keys(payload),
      hasTask: !!payload.task,
      taskKeys: payload.task ? Object.keys(payload.task) : []
    });
    return intent || 'planning';
  }

  /**
   * Read an artifact from git with error handling
   */
  private async readArtifact(
    persona: string,
    artifactType: string,
    artifactPath: string,
    payload: any,
    repo?: string
  ): Promise<string | null> {
    try {
      const resolvedPath = this.resolveArtifactPath(artifactPath, payload);
      const content = await this.readArtifactFromGit(resolvedPath, repo);
      
      logger.info(`Loaded ${artifactType} from git`, {
        persona,
        artifactPath: resolvedPath,
        contentLength: content.length
      });
      
      return content;
    } catch (error) {
      logger.error(`Failed to read ${artifactType} from git`, {
        persona,
        artifactPath,
        error: error instanceof Error ? error.message : String(error)
      });
      return null;
    }
  }

  /**
   * Build task text from task object
   */
  private buildTaskText(persona: string, workflowId: string, task: any): string {
    let userText = `Task: ${task.title || 'Untitled'}\n\nDescription: ${task.description}`;

    logger.info('PersonaConsumer: Using task description', {
      persona,
      workflowId,
      taskId: task.id,
      taskTitle: task.title,
      hasDescription: true,
      descriptionLength: task.description.length
    });

    // Add task type/scope context if available
    if (task.type) {
      userText += `\n\nType: ${task.type}`;
    }
    if (task.scope) {
      userText += `\nScope: ${task.scope}`;
    }

    return userText;
  }

  /**
   * Extract scan summary for the repository
   * TODO: Implement when needed
   */
  private async extractScanSummary(
    persona: string,
    repo?: string,
    branch?: string
  ): Promise<string | null> {
    if (!repo || !cfg.injectDashboardContext) {
      return null;
    }

    try {
      // For now, we don't have the local repo path in the persona worker
      // This would need to be enhanced to clone/fetch repos in distributed mode
      // For local development, the repo is already cloned by the coordinator
      logger.debug('PersonaConsumer: Repo context requested but not yet implemented', {
        persona,
        repo,
        branch
      });
      return null;
    } catch (error: any) {
      logger.warn('PersonaConsumer: Failed to get scan summary', {
        persona,
        repo,
        error: error.message
      });
      return null;
    }
  }

  /**
   * Extract dashboard context for project/task
   * TODO: Implement dashboard context fetching when needed
   */
  private async extractDashboardContext(
    persona: string,
    payload: any
  ): Promise<string | null> {
    // Future: Fetch context from dashboard API
    return null;
  }

  /**
   * Resolve artifact path with variable placeholders
   * Variables: {repo}, {branch}, {workflow_id}
   */
  resolveArtifactPath(artifactPath: string, payload: any): string {
    let resolved = artifactPath;

    // Replace {repo} with actual repo name
    if (payload.repo) {
      const repoName = payload.repo.split('/').pop()?.replace('.git', '') || payload.repo;
      resolved = resolved.replace(/{repo}/g, repoName);
    }

    // Replace {branch}
    if (payload.branch) {
      resolved = resolved.replace(/{branch}/g, payload.branch);
    }

    // Replace {workflow_id}
    if (payload.workflow_id) {
      resolved = resolved.replace(/{workflow_id}/g, payload.workflow_id);
    }

    return resolved;
  }

  /**
   * Read artifact file from git repository
   * Expects the repo to be cloned under cfg.projectBase
   */
  async readArtifactFromGit(artifactPath: string, repoUrl: string | undefined): Promise<string> {
    if (!repoUrl) {
      throw new Error('Repository URL is required to read artifact');
    }

    // Extract repo name from URL
    const repoName = repoUrl.split('/').pop()?.replace('.git', '') || repoUrl;
    const repoPath = path.join(cfg.projectBase, repoName);

    // Build full artifact path
    const fullPath = path.join(repoPath, artifactPath);

    logger.debug('Reading artifact from git', {
      repoUrl,
      repoName,
      repoPath,
      artifactPath,
      fullPath
    });

    try {
      const content = await fs.readFile(fullPath, 'utf-8');
      return content;
    } catch (error) {
      logger.error('Failed to read artifact file', {
        fullPath,
        error: error instanceof Error ? error.message : String(error)
      });
      throw new Error(`Failed to read artifact at ${artifactPath}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
