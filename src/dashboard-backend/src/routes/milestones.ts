import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, saveDb } from '../db/connection';

const milestoneCreateSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  status: z.enum(['active', 'completed', 'archived']).default('active'),
  description: z.string().optional()
});

const milestoneUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  status: z.enum(['active', 'completed', 'archived']).optional(),
  description: z.string().optional()
});

export function registerMilestoneRoutes(fastify: FastifyInstance) {
  // List milestones for a project
  fastify.get('/projects/:projectId/milestones', async (request: any, reply: any) => {
    const projectId = parseInt((request.params as any).projectId);
    const db = await getDb();
    
    const result = db.exec(
      'SELECT id, project_id, name, slug, status, total_tasks, completed_tasks, completion_percentage, created_at, updated_at FROM milestones WHERE project_id = ? ORDER BY created_at ASC',
      [projectId]
    );
    
    const milestones = result[0] ? result[0].values.map((row: any) => {
      const [id, project_id, name, slug, status, total_tasks, completed_tasks, completion_percentage, created_at, updated_at] = row;
      return { 
        id, 
        project_id, 
        name, 
        slug, 
        status, 
        total_tasks, 
        completed_tasks, 
        completion_percentage, 
        created_at, 
        updated_at 
      };
    }) : [];
    
    return { data: milestones };
  });

  // Get single milestone
  fastify.get('/projects/:projectId/milestones/:id', async (request: any, reply: any) => {
    const { projectId, id } = request.params as any;
    const db = await getDb();
    
    const result = db.exec(
      'SELECT * FROM milestones WHERE id = ? AND project_id = ?', 
      [parseInt(id), parseInt(projectId)]
    );
    
    if (!result[0] || result[0].values.length === 0) {
      return reply.status(404).send({ 
        type: 'https://api.example.com/errors/not-found', 
        title: 'Milestone Not Found', 
        status: 404 
      });
    }
    
    const cols = result[0].columns;
    const row = result[0].values[0];
    const milestone: any = {};
    cols.forEach((col, idx) => { milestone[col] = row[idx]; });
    
    return milestone;
  });

  // Create milestone
  fastify.post('/projects/:projectId/milestones', async (request: any, reply: any) => {
    const projectId = parseInt((request.params as any).projectId);
    const parse = milestoneCreateSchema.safeParse(request.body);
    
    if (!parse.success) {
      return reply.status(400).send({ 
        type: 'https://api.example.com/errors/validation-error', 
        title: 'Validation Error', 
        status: 400, 
        detail: 'Invalid payload', 
        errors: parse.error.errors 
      });
    }
    const data = parse.data;

    const db = await getDb();
    
    // Check if project exists
    const projectResult = db.exec('SELECT id FROM projects WHERE id = ?', [projectId]);
    if (!projectResult[0] || projectResult[0].values.length === 0) {
      return reply.status(404).send({ 
        type: 'https://api.example.com/errors/not-found', 
        title: 'Project Not Found', 
        status: 404, 
        detail: `Project with ID ${projectId} not found` 
      });
    }
    
    // Check if slug already exists for this project
    const existingResult = db.exec(
      'SELECT id FROM milestones WHERE project_id = ? AND slug = ?', 
      [projectId, data.slug]
    );
    if (existingResult[0] && existingResult[0].values.length > 0) {
      return reply.status(409).send({ 
        type: 'https://api.example.com/errors/conflict', 
        title: 'Milestone Already Exists', 
        status: 409, 
        detail: `Milestone with slug '${data.slug}' already exists in this project` 
      });
    }

    db.run(
      'INSERT INTO milestones (project_id, name, slug, status, description) VALUES (?, ?, ?, ?, ?)',
      [projectId, data.name, data.slug, data.status, data.description || null]
    );
    
    const result = db.exec('SELECT * FROM milestones WHERE id = last_insert_rowid()');
    saveDb(db);
    
    const cols = result[0].columns;
    const row = result[0].values[0];
    const created: any = {};
    cols.forEach((col, idx) => { created[col] = row[idx]; });
    
    return reply.status(201).send(created);
  });

  // Update milestone
  fastify.patch('/projects/:projectId/milestones/:id', async (request: any, reply: any) => {
    const { projectId, id } = request.params as any;
    const parse = milestoneUpdateSchema.safeParse(request.body);
    
    if (!parse.success) {
      return reply.status(400).send({ 
        type: 'https://api.example.com/errors/validation-error', 
        title: 'Validation Error', 
        status: 400, 
        errors: parse.error.errors 
      });
    }
    const data = parse.data;

    const db = await getDb();
    
    // Check if milestone exists
    const existingResult = db.exec(
      'SELECT id FROM milestones WHERE id = ? AND project_id = ?', 
      [parseInt(id), parseInt(projectId)]
    );
    if (!existingResult[0] || existingResult[0].values.length === 0) {
      return reply.status(404).send({ 
        type: 'https://api.example.com/errors/not-found', 
        title: 'Milestone Not Found', 
        status: 404 
      });
    }

    const updates: string[] = [];
    const params: any[] = [];
    
    if (data.name !== undefined) { 
      updates.push('name = ?'); 
      params.push(data.name); 
    }
    if (data.status !== undefined) { 
      updates.push('status = ?'); 
      params.push(data.status); 
    }
    if (data.description !== undefined) { 
      updates.push('description = ?'); 
      params.push(data.description); 
    }

    if (updates.length === 0) {
      return reply.status(400).send({ 
        type: 'https://api.example.com/errors/validation-error', 
        title: 'No updates provided', 
        status: 400 
      });
    }

    updates.push('updated_at = datetime("now")');
    params.push(parseInt(id), parseInt(projectId));

    db.run(
      `UPDATE milestones SET ${updates.join(', ')} WHERE id = ? AND project_id = ?`, 
      params
    );
    saveDb(db);
    
    const result = db.exec('SELECT * FROM milestones WHERE id = ?', [parseInt(id)]);
    const cols = result[0].columns;
    const row = result[0].values[0];
    const updated: any = {};
    cols.forEach((col, idx) => { updated[col] = row[idx]; });
    
    return updated;
  });

  // Delete milestone
  (fastify as any).delete('/projects/:projectId/milestones/:id', async (request: any, reply: any) => {
    const { projectId, id } = request.params as any;
    const db = await getDb();
    
    const existingResult = db.exec(
      'SELECT id FROM milestones WHERE id = ? AND project_id = ?', 
      [parseInt(id), parseInt(projectId)]
    );
    if (!existingResult[0] || existingResult[0].values.length === 0) {
      return reply.status(404).send({ 
        type: 'https://api.example.com/errors/not-found', 
        title: 'Milestone Not Found', 
        status: 404 
      });
    }

    db.run('DELETE FROM milestones WHERE id = ?', [parseInt(id)]);
    saveDb(db);
    
    return reply.status(204).send();
  });
}
