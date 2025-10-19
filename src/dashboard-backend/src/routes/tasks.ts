import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb } from '../db/connection';

const taskCreateSchema = z.object({
  title: z.string().min(1).max(500),
  description: z.string().optional(),
  milestone_id: z.number().int().positive().optional(),
  parent_task_id: z.number().int().positive().optional(),
  status: z.enum(['open','in_progress','in_review','blocked','done','archived']).default('open'),
  priority_score: z.number().int().min(0).max(10000).optional().default(0),
  external_id: z.string().optional(),
  labels: z.array(z.string()).optional()
});

export function registerTaskRoutes(fastify: FastifyInstance) {
  // GET list
  fastify.get('/projects/:projectId/tasks', async (request: any, reply: any) => {
    const projectId = parseInt((request.params as any).projectId);
    const db = getDb();

    const tasks = db.prepare('SELECT id, title, status, priority_score, milestone_id, labels FROM tasks WHERE project_id = ? LIMIT 100').all(projectId);
    tasks.forEach((t: any) => { if (t.labels) t.labels = JSON.parse(t.labels); });
    return { data: tasks };
  });

  // GET single
  fastify.get('/projects/:projectId/tasks/:taskId', async (request: any, reply: any) => {
    const { projectId, taskId } = request.params as any;
    const db = getDb();
    const task = db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(parseInt(taskId), parseInt(projectId));
    if (!task) return reply.status(404).send({ type: 'https://api.example.com/errors/not-found', title: 'Task Not Found', status: 404, detail: `Task ${taskId} not found` });
    if (task.labels) task.labels = JSON.parse(task.labels);
    return task;
  });

  // POST single
  fastify.post('/projects/:projectId/tasks', async (request: any, reply: any) => {
    const projectId = parseInt((request.params as any).projectId);
    const parse = taskCreateSchema.safeParse(request.body);
    if (!parse.success) return reply.status(400).send({ type: 'https://api.example.com/errors/validation-error', title: 'Validation Error', status: 400, detail: 'Invalid payload', errors: parse.error.errors });
    const data = parse.data as any;

    const db = getDb();
    const stmt = db.prepare(`INSERT INTO tasks (project_id, title, description, milestone_id, parent_task_id, status, priority_score, external_id, labels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const info = stmt.run(projectId, data.title, data.description || null, data.milestone_id || null, data.parent_task_id || null, data.status, data.priority_score || 0, data.external_id || null, data.labels ? JSON.stringify(data.labels) : null);
    const created = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
    if (created.labels) created.labels = JSON.parse(created.labels);
    return reply.status(201).send(created);
  });

  // POST bulk
  fastify.post('/projects/:projectId/tasks:bulk', async (request: any, reply: any) => {
    const projectId = parseInt((request.params as any).projectId);
    const body = request.body as any;
    if (!Array.isArray(body.tasks) || body.tasks.length === 0) return reply.status(400).send({ type: 'https://api.example.com/errors/validation-error', title: 'Invalid Request', status: 400, detail: 'tasks array required' });
    if (body.tasks.length > 100) return reply.status(400).send({ type: 'https://api.example.com/errors/validation-error', title: 'Batch Too Large', status: 400, detail: 'Max 100 tasks' });

    const db = getDb();
    const insert = db.prepare('INSERT INTO tasks (project_id, title, description, milestone_id, parent_task_id, status, priority_score, external_id, labels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
    db.exec('BEGIN TRANSACTION');
    const created: any[] = [];
    try {
      for (const t of body.tasks) {
        const parsed = taskCreateSchema.parse(t);
        const info = insert.run(projectId, parsed.title, parsed.description || null, parsed.milestone_id || null, parsed.parent_task_id || null, parsed.status, parsed.priority_score || 0, parsed.external_id || null, parsed.labels ? JSON.stringify(parsed.labels) : null);
        const row = db.prepare('SELECT * FROM tasks WHERE id = ?').get(info.lastInsertRowid);
        if (row.labels) row.labels = JSON.parse(row.labels);
        created.push(row);
      }
      db.exec('COMMIT');
      return reply.status(201).send({ created, summary: { totalRequested: body.tasks.length, created: created.length } });
    } catch (err) {
      db.exec('ROLLBACK');
      return reply.status(500).send({ type: 'https://api.example.com/errors/internal-error', title: 'Bulk Failed', status: 500, detail: (err as any).message });
    }
  });

  // PATCH update
  fastify.patch('/projects/:projectId/tasks/:taskId', async (request: any, reply: any) => {
    const { projectId, taskId } = request.params as any;
    const db = getDb();
    const existing = db.prepare('SELECT * FROM tasks WHERE id = ? AND project_id = ?').get(parseInt(taskId), parseInt(projectId));
    if (!existing) return reply.status(404).send({ type: 'https://api.example.com/errors/not-found', title: 'Task Not Found', status: 404 });

    const payload = request.body as any;
    const updates: string[] = [];
    const params: any[] = [];
    if (payload.title !== undefined) { updates.push('title = ?'); params.push(payload.title); }
    if (payload.status !== undefined) { updates.push('status = ?'); params.push(payload.status); }
    if (payload.priority_score !== undefined) { updates.push('priority_score = ?'); params.push(payload.priority_score); }
    if (payload.milestone_id !== undefined) { updates.push('milestone_id = ?'); params.push(payload.milestone_id); }
    if (payload.labels !== undefined) { updates.push('labels = ?'); params.push(JSON.stringify(payload.labels)); }

    if (updates.length === 0) return reply.status(400).send({ type: 'https://api.example.com/errors/validation-error', title: 'No updates provided', status: 400 });
    updates.push('updated_at = datetime("now")');
    params.push(parseInt(taskId), parseInt(projectId));

    const stmt = db.prepare(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`);
    stmt.run(...params);
    const updated = db.prepare('SELECT * FROM tasks WHERE id = ?').get(parseInt(taskId));
    if (updated.labels) updated.labels = JSON.parse(updated.labels);
    return updated;
  });
}
