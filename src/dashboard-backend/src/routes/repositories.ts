/**
 * Repository Routes
 * 
 * CRUD endpoints for Git repositories associated with projects
 */

import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getDb, saveDb } from '../db/connection';

// Validation schemas
const repositoryCreateSchema = z.object({
  url: z.string().min(1).url('Invalid repository URL'),
  default_branch: z.string().min(1).default('main')
});

const repositoryUpdateSchema = z.object({
  url: z.string().min(1).url('Invalid repository URL').optional(),
  default_branch: z.string().min(1).optional()
}).refine(data => Object.keys(data).length > 0, {
  message: 'At least one field must be provided for update'
});

type RepositoryCreate = z.infer<typeof repositoryCreateSchema>;
type RepositoryUpdate = z.infer<typeof repositoryUpdateSchema>;

export function registerRepositoryRoutes(fastify: FastifyInstance) {
  /**
   * GET /projects/:projectId/repositories
   * List all repositories for a project
   */
  fastify.get('/projects/:projectId/repositories', async (request: any, reply: any) => {
    const { projectId } = request.params;
    const db = await getDb();

    // Check if project exists
    const projectCheck = db.exec(
      'SELECT id FROM projects WHERE id = ?',
      [parseInt(projectId, 10)]
    );

    if (!projectCheck.length || !projectCheck[0].values.length) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    const result = db.exec(
      `SELECT id, project_id, url, default_branch, created_at, updated_at
       FROM repositories
       WHERE project_id = ?
       ORDER BY created_at ASC`,
      [parseInt(projectId, 10)]
    );

    if (!result.length) {
      return reply.send([]);
    }

    const repos = result[0].values.map(row => ({
      id: row[0],
      project_id: row[1],
      url: row[2],
      default_branch: row[3],
      created_at: row[4],
      updated_at: row[5]
    }));

    return reply.send(repos);
  });

  /**
   * GET /projects/:projectId/repositories/:id
   * Get a single repository
   */
  fastify.get('/projects/:projectId/repositories/:id', async (request: any, reply: any) => {
    const { projectId, id } = request.params;
    const db = await getDb();

    const result = db.exec(
      `SELECT id, project_id, url, default_branch, created_at, updated_at
       FROM repositories
       WHERE id = ? AND project_id = ?`,
      [parseInt(id, 10), parseInt(projectId, 10)]
    );

    if (!result.length || !result[0].values.length) {
      return reply.code(404).send({ error: 'Repository not found' });
    }

    const row = result[0].values[0];
    const repo = {
      id: row[0],
      project_id: row[1],
      url: row[2],
      default_branch: row[3],
      created_at: row[4],
      updated_at: row[5]
    };

    return reply.send(repo);
  });

  /**
   * POST /projects/:projectId/repositories
   * Create a new repository for a project
   */
  fastify.post('/projects/:projectId/repositories', async (request: any, reply: any) => {
    const { projectId } = request.params;
    const db = await getDb();
    const validation = repositoryCreateSchema.safeParse(request.body);

    if (!validation.success) {
      return reply.code(400).send({ error: validation.error.issues });
    }

    const { url, default_branch } = validation.data;

    // Check if project exists
    const projectCheck = db.exec(
      'SELECT id FROM projects WHERE id = ?',
      [parseInt(projectId, 10)]
    );

    if (!projectCheck.length || !projectCheck[0].values.length) {
      return reply.code(404).send({ error: 'Project not found' });
    }

    // Check if repository already exists for this project
    const existingCheck = db.exec(
      'SELECT id FROM repositories WHERE project_id = ? AND url = ?',
      [parseInt(projectId, 10), url]
    );

    if (existingCheck.length && existingCheck[0].values.length) {
      return reply.code(409).send({ error: 'Repository URL already exists for this project' });
    }

    try {
      db.run(
        `INSERT INTO repositories (project_id, url, default_branch)
         VALUES (?, ?, ?)`,
        [parseInt(projectId, 10), url, default_branch]
      );

      const newId = db.exec('SELECT last_insert_rowid()')[0].values[0][0] as number;

      // Save database
      await saveDb(db);

      const result = db.exec(
        `SELECT id, project_id, url, default_branch, created_at, updated_at
         FROM repositories WHERE id = ?`,
        [newId]
      );

      const row = result[0].values[0];
      const repo = {
        id: row[0],
        project_id: row[1],
        url: row[2],
        default_branch: row[3],
        created_at: row[4],
        updated_at: row[5]
      };

      return reply.code(201).send(repo);
    } catch (error: any) {
      return reply.code(500).send({ error: error.message });
    }
  });

  /**
   * PATCH /projects/:projectId/repositories/:id
   * Update a repository
   */
  fastify.patch('/projects/:projectId/repositories/:id', async (request: any, reply: any) => {
    const { projectId, id } = request.params;
    const db = await getDb();
    const validation = repositoryUpdateSchema.safeParse(request.body);

    if (!validation.success) {
      return reply.code(400).send({ error: validation.error.issues });
    }

    const updates = validation.data;

    // Check if repository exists
    const existingCheck = db.exec(
      'SELECT id FROM repositories WHERE id = ? AND project_id = ?',
      [parseInt(id, 10), parseInt(projectId, 10)]
    );

    if (!existingCheck.length || !existingCheck[0].values.length) {
      return reply.code(404).send({ error: 'Repository not found' });
    }

    try {
      const setClauses: string[] = [];
      const values: any[] = [];

      if (updates.url !== undefined) {
        setClauses.push('url = ?');
        values.push(updates.url);
      }
      if (updates.default_branch !== undefined) {
        setClauses.push('default_branch = ?');
        values.push(updates.default_branch);
      }

      setClauses.push("updated_at = datetime('now')");
      values.push(parseInt(id, 10), parseInt(projectId, 10));

      db.run(
        `UPDATE repositories
         SET ${setClauses.join(', ')}
         WHERE id = ? AND project_id = ?`,
        values
      );

      // Save database
      await saveDb(db);

      const result = db.exec(
        `SELECT id, project_id, url, default_branch, created_at, updated_at
         FROM repositories WHERE id = ?`,
        [parseInt(id, 10)]
      );

      const row = result[0].values[0];
      const repo = {
        id: row[0],
        project_id: row[1],
        url: row[2],
        default_branch: row[3],
        created_at: row[4],
        updated_at: row[5]
      };

      return reply.send(repo);
    } catch (error: any) {
      return reply.code(500).send({ error: error.message });
    }
  });

  /**
   * DELETE /projects/:projectId/repositories/:id
   * Delete a repository
   */
  (fastify as any).delete('/projects/:projectId/repositories/:id', async (request: any, reply: any) => {
    const { projectId, id } = request.params;
    const db = await getDb();

    try {
      // Check if repository exists
      const existingCheck = db.exec(
        'SELECT id FROM repositories WHERE id = ? AND project_id = ?',
        [parseInt(id, 10), parseInt(projectId, 10)]
      );

      if (!existingCheck[0] || existingCheck[0].values.length === 0) {
        return reply.code(404).send({ error: 'Repository not found' });
      }

      db.run('DELETE FROM repositories WHERE id = ? AND project_id = ?', [
        parseInt(id, 10),
        parseInt(projectId, 10)
      ]);

      // Save database
      await saveDb(db);

      return reply.code(204).send();
    } catch (error: any) {
      return reply.code(500).send({ error: error.message });
    }
  });
}
