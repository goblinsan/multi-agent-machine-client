/**
 * DashboardClient - Thin HTTP client for dashboard backend API
 * 
 * This is the ONLY integration point with the dashboard backend.
 * The dashboard backend is a self-contained service that exposes HTTP endpoints.
 * 
 * Architecture:
 * - Dashboard backend runs independently (e.g., http://localhost:3000)
 * - This client communicates via HTTP only (no direct imports)
 * - Clean separation: workflows use this client, not dashboard code directly
 */

export interface Task {
  id: number;
  project_id: number;
  milestone_id: number | null;
  parent_task_id: number | null;
  title: string;
  description: string | null;
  status: 'open' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'archived';
  priority_score: number;
  external_id: string | null;
  milestone_slug: string | null;
  labels: string[] | null;
  blocked_attempt_count: number;
  last_unblock_attempt: string | null;
  review_status_qa: string | null;
  review_status_code: string | null;
  review_status_security: string | null;
  review_status_devops: string | null;
  created_at: string;
  updated_at: string;
  completed_at: string | null;
}

export interface TaskCreateInput {
  title: string;
  description?: string;
  status?: 'open' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'archived';
  priority_score?: number;
  milestone_id?: number;
  parent_task_id?: number;
  external_id?: string;
  labels?: string[];
  assignee_persona?: string;
}

export interface TaskUpdateInput {
  title?: string;
  description?: string;
  status?: 'open' | 'in_progress' | 'in_review' | 'blocked' | 'done' | 'archived';
  priority_score?: number;
  milestone_id?: number;
  parent_task_id?: number;
  labels?: string[];
  review_status_qa?: string;
  review_status_code?: string;
  review_status_security?: string;
  review_status_devops?: string;
}

export interface BulkTaskCreateInput {
  tasks: TaskCreateInput[];
}

export interface BulkTaskCreateResponse {
  created: Task[];
  skipped?: Array<{
    task: Task;
    reason: string;
    external_id: string;
  }>;
  summary: {
    totalRequested: number;
    created: number;
    skipped?: number;
  };
}

export interface TaskListResponse {
  data: Array<{
    id: number;
    title: string;
    status: string;
    priority_score: number;
    milestone_id: number | null;
    labels: string[] | null;
  }>;
}

export interface DashboardClientConfig {
  baseUrl: string;
  timeout?: number;
}

/**
 * HTTP client for dashboard backend API
 * 
 * Methods:
 * - createTask: Create single task
 * - bulkCreateTasks: Create multiple tasks in one request (fixes N+1 problem)
 * - updateTask: Update existing task
 * - listTasks: Query tasks with filters
 */
export class DashboardClient {
  private baseUrl: string;
  private timeout: number;

  constructor(config: DashboardClientConfig) {
    this.baseUrl = config.baseUrl;
    this.timeout = config.timeout || 5000;
  }

  /**
   * Create a single task
   * 
   * @param projectId - Project ID
   * @param task - Task data
   * @returns Created task with ID
   */
  async createTask(projectId: number, task: TaskCreateInput): Promise<Task> {
    const url = `${this.baseUrl}/projects/${projectId}/tasks`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(task),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Dashboard API error (${response.status}): ${JSON.stringify(error)}`);
    }

    return response.json();
  }

  /**
   * Create multiple tasks in one request (bulk operation)
   * 
   * This solves the N+1 problem where workflows create many tasks sequentially.
   * Instead of N HTTP calls, this makes 1 call with all tasks.
   * 
   * The dashboard backend creates all tasks in a transaction.
   * 
   * @param projectId - Project ID
   * @param input - Array of tasks to create
   * @returns Summary of created tasks
   */
  async bulkCreateTasks(projectId: number, input: BulkTaskCreateInput): Promise<BulkTaskCreateResponse> {
    const url = `${this.baseUrl}/projects/${projectId}/tasks:bulk`;
    
    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(input),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Dashboard API bulk create error (${response.status}): ${JSON.stringify(error)}`);
    }

    return response.json();
  }

  /**
   * Update an existing task
   * 
   * @param projectId - Project ID
   * @param taskId - Task ID
   * @param updates - Fields to update
   * @returns Updated task
   */
  async updateTask(projectId: number, taskId: number, updates: TaskUpdateInput): Promise<Task> {
    const url = `${this.baseUrl}/projects/${projectId}/tasks/${taskId}`;
    
    const response = await fetch(url, {
      method: 'PATCH',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(updates),
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Dashboard API update error (${response.status}): ${JSON.stringify(error)}`);
    }

    return response.json();
  }

  /**
   * List tasks with optional filters
   * 
   * @param projectId - Project ID
   * @param filters - Optional filters (status, milestone_id, labels, etc.)
   * @returns Array of tasks (minimal projection)
   */
  async listTasks(projectId: number, filters?: {
    status?: string;
    milestone_id?: number;
    parent_task_id?: number;
    labels?: string[];
  }): Promise<TaskListResponse> {
    const params = new URLSearchParams();
    
    if (filters?.status) {
      params.append('status', filters.status);
    }
    if (filters?.milestone_id !== undefined) {
      params.append('milestone_id', filters.milestone_id.toString());
    }
    if (filters?.parent_task_id !== undefined) {
      params.append('parent_task_id', filters.parent_task_id.toString());
    }
    if (filters?.labels && filters.labels.length > 0) {
      params.append('labels', filters.labels.join(','));
    }

    const url = `${this.baseUrl}/projects/${projectId}/tasks?${params.toString()}`;
    
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Dashboard API list error (${response.status}): ${JSON.stringify(error)}`);
    }

    return response.json();
  }

  /**
   * Get a single task by ID
   * 
   * @param projectId - Project ID
   * @param taskId - Task ID
   * @returns Full task details
   */
  async getTask(projectId: number, taskId: number): Promise<Task> {
    const url = `${this.baseUrl}/projects/${projectId}/tasks/${taskId}`;
    
    const response = await fetch(url, {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeout),
    });

    if (!response.ok) {
      const error = await response.json().catch(() => ({}));
      throw new Error(`Dashboard API get error (${response.status}): ${JSON.stringify(error)}`);
    }

    return response.json();
  }
}

/**
 * Create a configured dashboard client
 * 
 * Usage in workflows:
 * ```typescript
 * const dashboardClient = createDashboardClient();
 * const task = await dashboardClient.createTask(1, { title: 'Fix bug' });
 * ```
 */
export function createDashboardClient(config?: Partial<DashboardClientConfig>): DashboardClient {
  const baseUrl = config?.baseUrl || process.env.DASHBOARD_API_URL || 'http://localhost:3000';
  const timeout = config?.timeout || 5000;

  return new DashboardClient({ baseUrl, timeout });
}
