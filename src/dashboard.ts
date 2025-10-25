import { cfg } from "./config.js";
import { fetch } from "undici";
import { logger } from "./logger.js";
import { ProjectAPI } from "./dashboard/ProjectAPI.js";
import { TaskAPI, CreateTaskInput, CreateTaskResult } from "./dashboard/TaskAPI.js";

// Initialize API clients
const projectAPI = new ProjectAPI();
const taskAPI = new TaskAPI();

// Re-export types for backward compatibility
export type { CreateTaskInput, CreateTaskResult };

/**
 * Fetch context snapshot for a workflow
 */
export async function fetchContext(workflowId: string) {
  try {
    // Use context-by-workflow endpoint if available in cfg.dashboardContextEndpoint (overrideable)
    if (cfg.dashboardContextEndpoint && cfg.dashboardContextEndpoint.startsWith('http')) {
      const url = new URL(cfg.dashboardContextEndpoint);
      url.searchParams.set('workflow_id', workflowId);
      url.searchParams.set('limit', '5');
      const r = await fetch(url.toString(), {
        headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}` }
      });
      if (!r.ok) throw new Error(`dashboard ${r.status}`);
      const data = await r.json();
      return data;
    }

    const r = await fetch(`${cfg.dashboardBaseUrl.replace(/\/$/, '')}/context/by-workflow?workflow_id=${encodeURIComponent(workflowId)}&limit=5`, {
      headers: { "Authorization": `Bearer ${cfg.dashboardApiKey}` }
    });
    if (!r.ok) throw new Error(`dashboard ${r.status}`);
    const data = await r.json();
    return data;
  } catch {
    return { projectTree: "", fileHotspots: "", limits: "", personaHints: "" };
  }
}

// Delegate project operations to ProjectAPI
export async function fetchProjectStatus(projectId: string | null | undefined) {
  return projectAPI.fetchProjectStatus(projectId);
}

export async function fetchProjectMilestones(projectId: string | null | undefined) {
  return projectAPI.fetchProjectMilestones(projectId);
}

export async function fetchProjectStatusDetails(projectId: string | null | undefined) {
  return projectAPI.fetchProjectStatusDetails(projectId);
}

export async function fetchProjectStatusSummary(projectId: string | null | undefined) {
  return projectAPI.fetchProjectStatusSummary(projectId);
}

export async function fetchProjectTasks(projectId: string) {
  return projectAPI.fetchProjectTasks(projectId);
}

// Delegate task operations to TaskAPI
export async function createDashboardTask(input: CreateTaskInput): Promise<CreateTaskResult | null> {
  return taskAPI.createDashboardTask(input);
}

export async function fetchTask(taskId: string): Promise<any | null> {
  return taskAPI.fetchTask(taskId);
}

export async function updateTaskStatus(
  taskId: string,
  status: string,
  projectId?: string,
  lockVersion?: number
): Promise<CreateTaskResult> {
  return taskAPI.updateTaskStatus(taskId, status, projectId, lockVersion);
}
