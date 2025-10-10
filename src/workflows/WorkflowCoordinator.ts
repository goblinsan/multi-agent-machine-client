import { randomUUID } from "crypto";
import { cfg } from "../config.js";
import { fetchProjectStatus, fetchProjectStatusDetails } from "../dashboard.js";
import { resolveRepoFromPayload } from "../gitUtils.js";
import { logger } from "../logger.js";
import { firstString, slugify } from "../util.js";
import { WorkflowEngine, workflowEngine } from "./WorkflowEngine.js";
import { join } from "path";

/**
 * Enhanced coordinator that uses the new WorkflowEngine for task processing
 */
export class WorkflowCoordinator {
  private engine: WorkflowEngine;
  private workflowsLoaded: boolean = false;

  constructor(engine?: WorkflowEngine) {
    this.engine = engine || workflowEngine;
  }

  /**
   * Load workflow definitions from the definitions directory
   */
  async loadWorkflows(): Promise<void> {
    if (this.workflowsLoaded) return;

    try {
      const workflowsPath = join(process.cwd(), 'src', 'workflows', 'definitions');
      const definitions = await this.engine.loadWorkflowsFromDirectory(workflowsPath);
      
      logger.info(`Loaded ${definitions.length} workflow definitions`, {
        workflows: definitions.map(d => ({ name: d.name, version: d.version }))
      });
      
      this.workflowsLoaded = true;
    } catch (error: any) {
      logger.error('Failed to load workflow definitions', { error: error.message });
      throw error;
    }
  }

  /**
   * Main coordination function that processes tasks using workflow engine
   */
  async handleCoordinator(r: any, msg: any, payload: any): Promise<any> {
    const workflowId: string = firstString(msg?.workflow_id) || randomUUID();
    const projectId: string = firstString(msg?.project_id, payload?.project_id, payload?.projectId) || '';
    
    if (!projectId) {
      throw new Error("Coordinator requires project_id");
    }

    // Ensure workflows are loaded
    await this.loadWorkflows();

    logger.info("WorkflowCoordinator starting", {
      workflowId,
      projectId,
      availableWorkflows: this.engine.getWorkflowDefinitions().map(d => d.name)
    });

    try {
      // Fetch project information
      const projectInfo: any = await fetchProjectStatus(projectId);
      const details: any = await fetchProjectStatusDetails(projectId).catch(() => null);
      
      const projectName = firstString(projectInfo?.name, payload?.project_name) || 'project';
      const projectSlug = slugify(firstString(projectInfo?.slug, payload?.project_slug, projectName) || projectName || 'project');

      // Resolve repository
      const repoRemoteCandidate = this.extractRepoRemote(details, projectInfo, payload);
      if (!repoRemoteCandidate) {
        throw new Error(`No repository remote available for project ${projectId}. Set the project's repository URL in the dashboard.`);
      }

      const repoResolution = await resolveRepoFromPayload({ 
        ...payload, 
        repo: repoRemoteCandidate, 
        project_name: projectName, 
        project_slug: projectSlug 
      });

      // Extract tasks from project
      const tasks = this.extractTasks(details, projectInfo);
      const pendingTasks = tasks.filter(task => this.normalizeTaskStatus(task?.status) !== 'done');
      
      if (pendingTasks.length === 0) {
        logger.info("No pending tasks found", { workflowId, projectId });
        return { success: true, message: "No pending tasks to process" };
      }

      // Process each task with appropriate workflow
      const results = [];
      for (const task of pendingTasks.slice(0, 5)) { // Limit to 5 tasks for safety
        try {
          const result = await this.processTask(task, {
            workflowId,
            projectId,
            projectName,
            projectSlug,
            repoRoot: repoResolution.repoRoot,
            branch: repoResolution.branch || 'main'
          });
          results.push(result);
        } catch (error: any) {
          logger.error(`Failed to process task ${task?.id}`, {
            workflowId,
            taskId: task?.id,
            error: error.message
          });
          results.push({
            success: false,
            taskId: task?.id,
            error: error.message
          });
        }
      }

      logger.info("WorkflowCoordinator completed", {
        workflowId,
        projectId,
        tasksProcessed: results.length,
        successful: results.filter(r => r.success).length,
        failed: results.filter(r => !r.success).length
      });

      return {
        success: true,
        workflowId,
        projectId,
        results
      };

    } catch (error: any) {
      logger.error("WorkflowCoordinator failed", {
        workflowId,
        projectId,
        error: error.message
      });
      throw error;
    }
  }

  /**
   * Process a single task using the appropriate workflow
   */
  private async processTask(task: any, context: {
    workflowId: string;
    projectId: string;
    projectName: string;
    projectSlug: string;
    repoRoot: string;
    branch: string;
  }): Promise<any> {
    const taskType = this.determineTaskType(task);
    const scope = this.determineTaskScope(task);
    
    // Find appropriate workflow
    const workflow = this.engine.findWorkflowByCondition(taskType, scope);
    if (!workflow) {
      // Fallback to project-loop workflow
      const fallbackWorkflow = this.engine.getWorkflowDefinition('project-loop');
      if (!fallbackWorkflow) {
        throw new Error(`No suitable workflow found for task ${task?.id} (type: ${taskType}, scope: ${scope})`);
      }
      logger.warn(`No specific workflow found for task, using project-loop fallback`, {
        taskId: task?.id,
        taskType,
        scope
      });
      return this.executeWorkflow(fallbackWorkflow, task, context);
    }

    logger.info(`Executing workflow for task`, {
      taskId: task?.id,
      workflowName: workflow.name,
      taskType,
      scope
    });

    return this.executeWorkflow(workflow, task, context);
  }

  /**
   * Execute a workflow for a specific task
   */
  private async executeWorkflow(workflow: any, task: any, context: {
    workflowId: string;
    projectId: string;
    projectName: string;
    projectSlug: string;
    repoRoot: string;
    branch: string;
  }): Promise<any> {
    const initialVariables = {
      task,
      taskId: task?.id || task?.key,
      taskName: task?.name || task?.title || task?.summary,
      taskType: this.determineTaskType(task),
      taskScope: this.determineTaskScope(task),
      projectId: context.projectId,
      projectName: context.projectName,
      projectSlug: context.projectSlug,
      // Legacy compatibility variables
      REDIS_STREAM_NAME: process.env.REDIS_STREAM_NAME || 'workflow-tasks',
      CONSUMER_GROUP: process.env.CONSUMER_GROUP || 'workflow-consumers',
      CONSUMER_ID: process.env.CONSUMER_ID || 'workflow-engine'
    };

    const result = await this.engine.executeWorkflowDefinition(
      workflow,
      context.projectId,
      context.repoRoot,
      context.branch,
      initialVariables
    );

    return {
      success: result.success,
      workflowName: workflow.name,
      taskId: task?.id,
      completedSteps: result.completedSteps,
      failedStep: result.failedStep,
      duration: result.duration,
      error: result.error?.message
    };
  }

  /**
   * Determine task type for workflow selection
   */
  private determineTaskType(task: any): string {
    if (!task) return 'analysis';
    
    const taskName = (task?.name || task?.title || task?.summary || '').toLowerCase();
    const taskDescription = (task?.description || task?.details || '').toLowerCase();
    const taskLabels = Array.isArray(task?.labels) ? task.labels.map((l: any) => String(l).toLowerCase()) : [];
    
    const content = `${taskName} ${taskDescription} ${taskLabels.join(' ')}`;
    
    // Analyze content for keywords
    if (content.includes('hotfix') || content.includes('urgent') || content.includes('critical') || content.includes('emergency')) {
      return 'hotfix';
    }
    
    if (content.includes('feature') || content.includes('enhancement') || content.includes('new')) {
      return 'feature';
    }
    
    if (content.includes('analysis') || content.includes('understand') || content.includes('review') || content.includes('document')) {
      return 'analysis';
    }
    
    if (content.includes('bug') || content.includes('fix') || content.includes('error') || content.includes('issue')) {
      return 'bugfix';
    }
    
    // Default to standard task
    return 'task';
  }

  /**
   * Determine task scope for workflow selection
   */
  private determineTaskScope(task: any): string {
    if (!task) return 'medium';
    
    const taskName = (task?.name || task?.title || task?.summary || '').toLowerCase();
    const taskDescription = (task?.description || task?.details || '').toLowerCase();
    const content = `${taskName} ${taskDescription}`;
    
    // Analyze scope indicators
    if (content.includes('large') || content.includes('major') || content.includes('comprehensive') || content.includes('complete')) {
      return 'large';
    }
    
    if (content.includes('small') || content.includes('minor') || content.includes('quick') || content.includes('simple')) {
      return 'small';
    }
    
    return 'medium';
  }

  /**
   * Extract repository remote from various sources
   */
  private extractRepoRemote(details: any, projectInfo: any, payload: any): string {
    const pickRemoteFrom = (obj: any) => firstString(
      obj?.repository?.clone_url,
      obj?.repository?.url,
      obj?.repository?.remote,
      obj?.repo?.clone_url,
      obj?.repo?.url,
      obj?.repo?.remote,
      obj?.repo,
      obj?.repository
    );

    return firstString(
      pickRemoteFrom(details),
      pickRemoteFrom(projectInfo),
      pickRemoteFrom(payload)
    ) || '';
  }

  /**
   * Extract tasks from project information
   */
  private extractTasks(details: any, projectInfo: any): any[] {
    const tasks: any[] = [];
    
    // Extract from milestones first
    if (details && Array.isArray(details.milestones) && details.milestones.length) {
      for (const milestone of details.milestones) {
        const milestoneTasks = Array.isArray(milestone?.tasks) ? milestone.tasks : [];
        for (const task of milestoneTasks) {
          tasks.push({ ...task, milestone });
        }
      }
    } else {
      // Fallback to direct tasks
      const directTasks = Array.isArray(projectInfo?.tasks) ? projectInfo.tasks : [];
      tasks.push(...directTasks);
    }
    
    return tasks;
  }

  /**
   * Normalize task status to standard values
   */
  private normalizeTaskStatus(status: string): string {
    if (!status) return 'unknown';
    
    const normalized = String(status).toLowerCase().trim();
    
    if (['done', 'completed', 'finished', 'closed', 'resolved'].includes(normalized)) {
      return 'done';
    }
    
    if (['in_progress', 'in-progress', 'inprogress', 'active', 'working'].includes(normalized)) {
      return 'in_progress';
    }
    
    if (['open', 'new', 'todo', 'pending', 'ready'].includes(normalized)) {
      return 'open';
    }
    
    return 'unknown';
  }
}

/**
 * Backward compatibility function that wraps the new WorkflowCoordinator
 */
export async function handleCoordinator(r: any, msg: any, payload: any, overrides?: any): Promise<any> {
  const coordinator = new WorkflowCoordinator();
  return coordinator.handleCoordinator(r, msg, payload);
}

/**
 * Default export for backward compatibility
 */
export default { handleCoordinator };