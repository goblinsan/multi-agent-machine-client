import os from 'os';
import path from 'path';
import fs from 'fs';
import { execSync } from 'child_process';
import { beforeEach, afterEach, afterAll, vi } from 'vitest';
import * as childProcess from 'child_process';


import { vi as _vi } from 'vitest';


process.env.FAST_TEST_MODE = '1';
process.env.PERSONA_DEFAULT_TIMEOUT_MS = '100';
process.env.PERSONA_DEFAULT_MAX_RETRIES = '0';
process.env.PERSONA_RETRY_BACKOFF_INCREMENT_MS = '10';
process.env.COORDINATOR_MAX_ITERATIONS = '2';
_vi.mock('../src/redisClient.js', async () => {
  try {
    const actual = await _vi.importActual<any>('../src/redisClient.js');
    return {
      ...actual,
      makeRedis: _vi.fn().mockResolvedValue({
        xGroupCreate: _vi.fn().mockResolvedValue(null),
        xReadGroup: _vi.fn().mockResolvedValue([]),
        xAck: _vi.fn().mockResolvedValue(null),
        disconnect: _vi.fn().mockResolvedValue(null),
        quit: _vi.fn().mockResolvedValue(null),
        xRevRange: _vi.fn().mockResolvedValue([]),
        xAdd: _vi.fn().mockResolvedValue('test-id'),
        exists: _vi.fn().mockResolvedValue(1)
      })
    };
  } catch {
    return {
      makeRedis: _vi.fn().mockResolvedValue({
        xGroupCreate: _vi.fn().mockResolvedValue(null),
        xReadGroup: _vi.fn().mockResolvedValue([]),
        xAck: _vi.fn().mockResolvedValue(null),
        disconnect: _vi.fn().mockResolvedValue(null),
        quit: _vi.fn().mockResolvedValue(null),
        xRevRange: _vi.fn().mockResolvedValue([]),
        xAdd: _vi.fn().mockResolvedValue('test-id'),
        exists: _vi.fn().mockResolvedValue(1)
      })
    } as any;
  }
});

function safeGit(cmd: string): string | null {
  try {
    return execSync(cmd, { stdio: ['ignore', 'pipe', 'pipe'] }).toString().trim();
  } catch {
    return null;
  }
}

function isGitRepo(): boolean {
  const res = safeGit('git rev-parse --is-inside-work-tree');
  return res === 'true';
}

function currentBranch(): string | null {
  return safeGit('git rev-parse --abbrev-ref HEAD');
}


const tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'mc-tests-'));
process.env.PROJECT_BASE = tmpBase;

const originalWasRepo = isGitRepo();
const originalBranch = originalWasRepo ? (currentBranch() || null) : null;
let branchBeforeEach: string | null = null;

beforeEach(() => {
  if (originalWasRepo) branchBeforeEach = currentBranch();
});

afterEach(() => {
  if (!originalWasRepo) return;
  const now = currentBranch();
  if (branchBeforeEach && now && branchBeforeEach !== now) {
    
    safeGit(`git checkout ${branchBeforeEach}`);
  }
});

afterAll(() => {
  if (originalWasRepo && originalBranch) {
    const now = currentBranch();
    if (now !== originalBranch) {
      safeGit(`git checkout ${originalBranch}`);
    }
  }
  
  try {
    fs.rmSync(tmpBase, { recursive: true, force: true });
  } catch {  }
});


const origExec = childProcess.exec;
const origExecSync = childProcess.execSync;
const origExecFile = (childProcess as any).execFile;
const origExecFileSync = (childProcess as any).execFileSync;
const origSpawn = childProcess.spawn;
const origSpawnSync = childProcess.spawnSync;

function ensureTmpCwd(opts?: any) {
  
  const cwd = opts && typeof opts === 'object' && 'cwd' in opts ? (opts.cwd || '') : '';
  if (!cwd) return;
  const allowed = String(cwd).startsWith(os.tmpdir());
  if (!allowed) {
    throw new Error(`Test guard: git command attempted outside tmp dir. cwd=${cwd}`);
  }
}


try {
  
  if (!vi.isMockFunction((childProcess as any).exec)) {
    vi.spyOn(childProcess as any, 'exec').mockImplementation((...args: any[]) => {
      const command = args[0];
      const options = args[1];
      if (typeof command === 'string' && /\bgit\b/.test(command)) ensureTmpCwd(options);
      return (origExec as any).apply(childProcess, args);
    });
  }
  
  if (!vi.isMockFunction((childProcess as any).execSync)) {
    vi.spyOn(childProcess as any, 'execSync').mockImplementation((...args: any[]) => {
      const command = args[0];
      const options = args[1];
      if (typeof command === 'string' && /\bgit\b/.test(command)) ensureTmpCwd(options);
      return (origExecSync as any).apply(childProcess, args);
    });
  }
  
  if (!vi.isMockFunction((childProcess as any).execFile)) {
    vi.spyOn(childProcess as any, 'execFile').mockImplementation((...args: any[]) => {
      const file = args[0];
      const options = args[2];
      if (file === 'git') ensureTmpCwd(options);
      return (origExecFile as any).apply(childProcess, args);
    });
  }
  
  if (!vi.isMockFunction((childProcess as any).execFileSync)) {
    vi.spyOn(childProcess as any, 'execFileSync').mockImplementation((...args: any[]) => {
      const file = args[0];
      const options = args[2];
      if (file === 'git') ensureTmpCwd(options);
      return (origExecFileSync as any).apply(childProcess, args);
    });
  }
  
  if (!vi.isMockFunction((childProcess as any).spawn)) {
    vi.spyOn(childProcess as any, 'spawn').mockImplementation((...args: any[]) => {
      const command = args[0];
      const options = args[2];
      if (command === 'git') ensureTmpCwd(options);
      return (origSpawn as any).apply(childProcess, args);
    });
  }
  
  if (!vi.isMockFunction((childProcess as any).spawnSync)) {
    vi.spyOn(childProcess as any, 'spawnSync').mockImplementation((...args: any[]) => {
      const command = args[0];
      const options = args[2];
      if (command === 'git') ensureTmpCwd(options);
      return (origSpawnSync as any).apply(childProcess, args);
    });
  }
} catch (e) {
  
}





export {
  createMockDashboardClient,
  mockTaskResponse,
  mockBulkCreateResponse,
  mockListTasksResponse,
  mockTaskCreateInput,
  mockBulkTaskCreateInput,
  mockTaskUpdateInput,
  mockSuccessfulTaskCreation,
  mockSuccessfulBulkCreation,
  mockIdempotentTaskCreation,
  mockIdempotentBulkCreation,
  mockTaskCreationFailure,
  mockNetworkFailure,
  priorityToPriorityScore,
  isUrgentPriority,
  assertBulkCreateResponse,
  assertTaskPriority
} from './helpers/dashboardMocks';



if (process.env.DASHBOARD_MOCK_GLOBAL === '1') {
  
  vi.mock('../src/services/DashboardClient.js', () => {
    
    let nextId = 1;
    const tasks: any[] = [];

    function makeTask(projectId: number, input: any, id?: number) {
      const allowed = new Set(['open','in_progress','in_review','blocked','done','archived']);
      if (input.status && !allowed.has(String(input.status))) {
        throw new Error('Dashboard API error (400)');
      }
      const now = new Date().toISOString();
      const t = {
        id: id ?? nextId++,
        project_id: projectId,
        milestone_id: input.milestone_id ?? null,
        parent_task_id: input.parent_task_id ?? null,
        title: input.title ?? 'Untitled',
        description: input.description ?? null,
        status: input.status ?? 'open',
        priority_score: input.priority_score ?? input.priority ?? 0,
        external_id: input.external_id ?? null,
        milestone_slug: input.milestone_slug ?? null,
        labels: input.labels ?? null,
        blocked_attempt_count: 0,
        last_unblock_attempt: null,
        review_status_qa: null,
        review_status_code: null,
        review_status_security: null,
        review_status_devops: null,
        created_at: now,
        updated_at: now,
        completed_at: null
      };
      return t;
    }

    class DashboardClient {
      constructor(..._args: any[]) {}
      async createTask(projectId: number, task: any) {
        const created = makeTask(projectId, task);
        tasks.push(created);
        return created;
      }
      async bulkCreateTasks(projectId: number, input: any) {
        
        const list: any[] = input?.tasks ?? [];
        const allowed = new Set(['open','in_progress','in_review','blocked','done','archived']);
        for (const t of list) {
          if (t.status && !allowed.has(String(t.status))) {
            throw new Error('Dashboard API bulk create error');
          }
        }
        const created = list.map((t: any) => {
          const ct = makeTask(projectId, t);
          tasks.push(ct);
          return ct;
        });
        return {
          created,
          skipped: undefined,
          summary: { totalRequested: created.length, created: created.length, skipped: 0 }
        };
      }
      async updateTask(projectId: number, taskId: number, updates: any) {
        const idx = tasks.findIndex(t => t.id === taskId && t.project_id === projectId);
        if (idx === -1) {
          const created = makeTask(projectId, updates, taskId);
          tasks.push(created);
          return created;
        }
        const updated = { ...tasks[idx], ...updates, updated_at: new Date().toISOString() };
        tasks[idx] = updated;
        return updated;
      }
      async listTasks(projectId: number, filters?: any) {
        let rows = tasks.filter(t => t.project_id === projectId);
        if (filters?.status) {
          rows = rows.filter(t => t.status === filters.status);
        }
        const data = rows.map(t => ({
          id: t.id, title: t.title, status: t.status, priority_score: t.priority_score, milestone_id: t.milestone_id, labels: t.labels
        }));
        return { data };
      }
      async getTask(projectId: number, taskId: number) {
        const t = tasks.find(t => t.id === taskId && t.project_id === projectId);
        if (t) return t;
        return makeTask(projectId, { title: 'Task to get' }, taskId);
      }
    }

    function createDashboardClient(_config?: any) {
      return new DashboardClient();
    }
    return { DashboardClient, createDashboardClient };
  });
}
