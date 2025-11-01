import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, saveDb } from '../db/connection';

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
  
  fastify.get('/projects/:projectId/tasks', async (request: any, _reply: any) => {
    const projectId = parseInt((request.params as any).projectId);
    const db = await getDb();

    
    const result = db.exec(`
      SELECT 
        t.id, t.title, t.description, t.status, t.priority_score, t.milestone_id, t.labels,
        m.name as milestone_name, m.slug as milestone_slug, m.status as milestone_status
      FROM tasks t
      LEFT JOIN milestones m ON t.milestone_id = m.id
      WHERE t.project_id = ? 
      LIMIT 100
    `, [projectId]);
    
    const tasks = result[0] ? result[0].values.map((row: any) => {
      const [id, title, description, status, priority_score, milestone_id, labels, milestone_name, milestone_slug, milestone_status] = row;
      return { 
        id, 
        title, 
        description,
        status, 
        priority_score, 
        milestone_id, 
        labels: labels ? JSON.parse(labels) : null,
        
        milestone: milestone_id ? {
          id: milestone_id,
          name: milestone_name,
          slug: milestone_slug,
          status: milestone_status
        } : null
      };
    }) : [];
    
    return { data: tasks };
  });

  
  fastify.get('/projects/:projectId/tasks/:taskId', async (request: any, reply: any) => {
    const { projectId, taskId } = request.params as any;
    const db = await getDb();
    
    const result = db.exec('SELECT * FROM tasks WHERE id = ? AND project_id = ?', [parseInt(taskId), parseInt(projectId)]);
    if (!result[0] || result[0].values.length === 0) {
      return reply.status(404).send({ type: 'https://api.example.com/errors/not-found', title: 'Task Not Found', status: 404, detail: `Task ${taskId} not found` });
    }
    
    const cols = result[0].columns;
    const row = result[0].values[0];
    const task: any = {};
    cols.forEach((col, idx) => { task[col] = row[idx]; });
    if (task.labels) task.labels = JSON.parse(task.labels);
    
    return task;
  });

  
  fastify.post('/projects/:projectId/tasks', async (request: any, reply: any) => {
    const projectId = parseInt((request.params as any).projectId);
    const parse = taskCreateSchema.safeParse(request.body);
    if (!parse.success) return reply.status(400).send({ type: 'https://api.example.com/errors/validation-error', title: 'Validation Error', status: 400, detail: 'Invalid payload', errors: parse.error.errors });
    const data = parse.data as any;

    const db = await getDb();
    
    
    if (data.external_id) {
      const existingResult = db.exec(
        'SELECT * FROM tasks WHERE project_id = ? AND external_id = ?',
        [projectId, data.external_id]
      );
      
      if (existingResult[0] && existingResult[0].values.length > 0) {
        
        const cols = existingResult[0].columns;
        const row = existingResult[0].values[0];
        const existing: any = {};
        cols.forEach((col, idx) => { existing[col] = row[idx]; });
        if (existing.labels) existing.labels = JSON.parse(existing.labels);
        
        return reply.status(200).send(existing);
      }
    }

    
    db.run(`INSERT INTO tasks (project_id, title, description, milestone_id, parent_task_id, status, priority_score, external_id, labels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [projectId, data.title, data.description || null, data.milestone_id || null, data.parent_task_id || null, data.status, data.priority_score || 0, data.external_id || null, data.labels ? JSON.stringify(data.labels) : null]);
    
    const result = db.exec('SELECT * FROM tasks WHERE id = last_insert_rowid()');
    saveDb(db);
    
    const cols = result[0].columns;
    const row = result[0].values[0];
    const created: any = {};
    cols.forEach((col, idx) => { created[col] = row[idx]; });
    if (created.labels) created.labels = JSON.parse(created.labels);
    
    return reply.status(201).send(created);
  });

  
  fastify.post('/projects/:projectId/tasks:bulk', async (request: any, reply: any) => {
    const projectId = parseInt((request.params as any).projectId);
    const body = request.body as any;
    if (!Array.isArray(body.tasks) || body.tasks.length === 0) return reply.status(400).send({ type: 'https://api.example.com/errors/validation-error', title: 'Invalid Request', status: 400, detail: 'tasks array required' });
    if (body.tasks.length > 100) return reply.status(400).send({ type: 'https://api.example.com/errors/validation-error', title: 'Batch Too Large', status: 400, detail: 'Max 100 tasks' });

    const db = await getDb();
    const created: any[] = [];
    const skipped: any[] = [];
    
    try {
      db.run('BEGIN TRANSACTION');
      
      for (const t of body.tasks) {
        const parsed = taskCreateSchema.parse(t);
        
        
        if (parsed.external_id) {
          const existingResult = db.exec(
            'SELECT * FROM tasks WHERE project_id = ? AND external_id = ?',
            [projectId, parsed.external_id]
          );
          
          if (existingResult[0] && existingResult[0].values.length > 0) {
            
            const cols = existingResult[0].columns;
            const row = existingResult[0].values[0];
            const existing: any = {};
            cols.forEach((col, idx) => { existing[col] = row[idx]; });
            if (existing.labels) existing.labels = JSON.parse(existing.labels);
            
            skipped.push({
              task: existing,
              reason: 'duplicate_external_id',
              external_id: parsed.external_id
            });
            continue;
          }
        }
        
        
        db.run('INSERT INTO tasks (project_id, title, description, milestone_id, parent_task_id, status, priority_score, external_id, labels) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
          [projectId, parsed.title, parsed.description || null, parsed.milestone_id || null, parsed.parent_task_id || null, parsed.status, parsed.priority_score || 0, parsed.external_id || null, parsed.labels ? JSON.stringify(parsed.labels) : null]);
        
        const result = db.exec('SELECT * FROM tasks WHERE id = last_insert_rowid()');
        const cols = result[0].columns;
        const row = result[0].values[0];
        const task: any = {};
        cols.forEach((col, idx) => { task[col] = row[idx]; });
        if (task.labels) task.labels = JSON.parse(task.labels);
        created.push(task);
      }
      
      db.run('COMMIT');
      saveDb(db);
      
      return reply.status(201).send({ 
        created, 
        skipped,
        summary: { 
          totalRequested: body.tasks.length, 
          created: created.length,
          skipped: skipped.length
        } 
      });
    } catch (err) {
      db.run('ROLLBACK');
      return reply.status(500).send({ type: 'https://api.example.com/errors/internal-error', title: 'Bulk Failed', status: 500, detail: (err as any).message });
    }
  });

  
  fastify.patch('/projects/:projectId/tasks/:taskId', async (request: any, reply: any) => {
    const { projectId, taskId } = request.params as any;
    const db = await getDb();
    
    const checkResult = db.exec('SELECT * FROM tasks WHERE id = ? AND project_id = ?', [parseInt(taskId), parseInt(projectId)]);
    if (!checkResult[0] || checkResult[0].values.length === 0) {
      return reply.status(404).send({ type: 'https://api.example.com/errors/not-found', title: 'Task Not Found', status: 404 });
    }

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

    db.run(`UPDATE tasks SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`, params);
    saveDb(db);
    
    const result = db.exec('SELECT * FROM tasks WHERE id = ?', [parseInt(taskId)]);
    const cols = result[0].columns;
    const row = result[0].values[0];
    const updated: any = {};
    cols.forEach((col, idx) => { updated[col] = row[idx]; });
    if (updated.labels) updated.labels = JSON.parse(updated.labels);
    
    return updated;
  });
}
