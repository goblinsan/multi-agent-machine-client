

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


export class DashboardClient {
  private baseUrl: string;
  private timeout: number;

  constructor(config: DashboardClientConfig) {
    this.baseUrl = config.baseUrl;
    this.timeout = config.timeout || 5000;
  }

  
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


export function createDashboardClient(config?: Partial<DashboardClientConfig>): DashboardClient {
  const baseUrl = config?.baseUrl || process.env.DASHBOARD_API_URL || 'http://localhost:3000';
  const timeout = config?.timeout || 5000;

  return new DashboardClient({ baseUrl, timeout });
}
