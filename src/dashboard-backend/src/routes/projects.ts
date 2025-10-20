import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, saveDb } from '../db/connection';

const projectCreateSchema = z.object({
  name: z.string().min(1),
  slug: z.string().min(1).regex(/^[a-z0-9-]+$/),
  description: z.string().optional()
});

const projectUpdateSchema = z.object({
  name: z.string().min(1).optional(),
  description: z.string().optional()
});

export function registerProjectRoutes(fastify: FastifyInstance) {
  // List all projects
  fastify.get('/projects', async (request: any, reply: any) => {
    const db = await getDb();
    
    const result = db.exec('SELECT id, name, slug, description, created_at, updated_at FROM projects ORDER BY created_at DESC LIMIT 100');
    const projects = result[0] ? result[0].values.map((row: any) => {
      const [id, name, slug, description, created_at, updated_at] = row;
      return { id, name, slug, description, created_at, updated_at };
    }) : [];
    
    return { data: projects };
  });

  // Get single project
  fastify.get('/projects/:id', async (request: any, reply: any) => {
    const id = parseInt((request.params as any).id);
    const db = await getDb();
    
    const result = db.exec('SELECT * FROM projects WHERE id = ?', [id]);
    if (!result[0] || result[0].values.length === 0) {
      return reply.status(404).send({ 
        type: 'https://api.example.com/errors/not-found', 
        title: 'Project Not Found', 
        status: 404 
      });
    }
    
    const cols = result[0].columns;
    const row = result[0].values[0];
    const project: any = {};
    cols.forEach((col, idx) => { project[col] = row[idx]; });
    
    return project;
  });

  // Create project
  fastify.post('/projects', async (request: any, reply: any) => {
    const parse = projectCreateSchema.safeParse(request.body);
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
    
    // Check if slug already exists
    const existingResult = db.exec('SELECT id FROM projects WHERE slug = ?', [data.slug]);
    if (existingResult[0] && existingResult[0].values.length > 0) {
      return reply.status(409).send({ 
        type: 'https://api.example.com/errors/conflict', 
        title: 'Project Already Exists', 
        status: 409, 
        detail: `Project with slug '${data.slug}' already exists` 
      });
    }

    db.run(
      'INSERT INTO projects (name, slug, description) VALUES (?, ?, ?)',
      [data.name, data.slug, data.description || null]
    );
    
    const result = db.exec('SELECT * FROM projects WHERE id = last_insert_rowid()');
    saveDb(db);
    
    const cols = result[0].columns;
    const row = result[0].values[0];
    const created: any = {};
    cols.forEach((col, idx) => { created[col] = row[idx]; });
    
    return reply.status(201).send(created);
  });

  // Update project
  fastify.patch('/projects/:id', async (request: any, reply: any) => {
    const id = parseInt((request.params as any).id);
    const parse = projectUpdateSchema.safeParse(request.body);
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
    
    // Check if project exists
    const existingResult = db.exec('SELECT id FROM projects WHERE id = ?', [id]);
    if (!existingResult[0] || existingResult[0].values.length === 0) {
      return reply.status(404).send({ 
        type: 'https://api.example.com/errors/not-found', 
        title: 'Project Not Found', 
        status: 404 
      });
    }

    const updates: string[] = [];
    const params: any[] = [];
    
    if (data.name !== undefined) { 
      updates.push('name = ?'); 
      params.push(data.name); 
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
    params.push(id);

    db.run(`UPDATE projects SET ${updates.join(', ')} WHERE id = ?`, params);
    saveDb(db);
    
    const result = db.exec('SELECT * FROM projects WHERE id = ?', [id]);
    const cols = result[0].columns;
    const row = result[0].values[0];
    const updated: any = {};
    cols.forEach((col, idx) => { updated[col] = row[idx]; });
    
    return updated;
  });

  // Get project status with repository information
  fastify.get('/projects/:id/status', async (request: any, reply: any) => {
    const id = parseInt((request.params as any).id);
    const db = await getDb();
    
    // Get project
    const projectResult = db.exec('SELECT * FROM projects WHERE id = ?', [id]);
    if (!projectResult[0] || projectResult[0].values.length === 0) {
      return reply.status(404).send({ error: 'Project not found' });
    }
    
    const projectCols = projectResult[0].columns;
    const projectRow = projectResult[0].values[0];
    const project: any = {};
    projectCols.forEach((col, idx) => { project[col] = projectRow[idx]; });
    
    // Get repositories
    const repoResult = db.exec(
      'SELECT id, url, default_branch, created_at, updated_at FROM repositories WHERE project_id = ?',
      [id]
    );
    
    const repositories = repoResult[0] ? repoResult[0].values.map((row: any) => ({
      id: row[0],
      url: row[1],
      default_branch: row[2],
      created_at: row[3],
      updated_at: row[4]
    })) : [];
    
    // Get milestones
    const milestoneResult = db.exec(
      'SELECT id, name, slug, status, total_tasks, completed_tasks FROM milestones WHERE project_id = ?',
      [id]
    );
    
    const milestones = milestoneResult[0] ? milestoneResult[0].values.map((row: any) => ({
      id: row[0],
      name: row[1],
      slug: row[2],
      status: row[3],
      total_tasks: row[4] || 0,
      completed_tasks: row[5] || 0
    })) : [];
    
    // Return project with nested data, using repository structure expected by WorkflowCoordinator
    const response: any = {
      ...project,
      milestones,
      repositories
    };
    
    // Add repository in the format expected by extractRepoRemote
    if (repositories.length > 0) {
      response.repository = {
        url: repositories[0].url,
        clone_url: repositories[0].url,
        remote: repositories[0].url,
        default_branch: repositories[0].default_branch
      };
    }
    
    return response;
  });

  // Delete project
  (fastify as any).delete('/projects/:id', async (request: any, reply: any) => {
    const id = parseInt((request.params as any).id);
    const db = await getDb();
    
    const existingResult = db.exec('SELECT id FROM projects WHERE id = ?', [id]);
    if (!existingResult[0] || existingResult[0].values.length === 0) {
      return reply.status(404).send({ 
        type: 'https://api.example.com/errors/not-found', 
        title: 'Project Not Found', 
        status: 404 
      });
    }

    db.run('DELETE FROM projects WHERE id = ?', [id]);
    saveDb(db);
    
    return reply.status(204).send();
  });
}
