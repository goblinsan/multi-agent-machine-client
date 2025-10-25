import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * API Contract Validation
 * 
 * Validates that API clients (TaskAPI, ProjectAPI) use routes that match
 * the actual dashboard backend routes.
 * 
 * This prevents mismatch errors where tests pass (with mocks) but real
 * API calls fail because the routes don't exist.
 */

describe('API Contract Validation', () => {
  
  it('should extract actual backend routes from dashboard-backend', () => {
    const backendPath = join(process.cwd(), 'src/dashboard-backend/src/routes');
    
    // Read all route files
    const projectsFile = readFileSync(join(backendPath, 'projects.ts'), 'utf-8');
    const tasksFile = readFileSync(join(backendPath, 'tasks.ts'), 'utf-8');
    const milestonesFile = readFileSync(join(backendPath, 'milestones.ts'), 'utf-8');
    
    // Extract routes using regex
    const routePattern = /fastify\.(get|post|patch|put|delete)\(['"](\/[^'"]+)['"]/g;
    
    const extractRoutes = (content: string): string[] => {
      const routes: string[] = [];
      let match;
      while ((match = routePattern.exec(content)) !== null) {
        routes.push(match[2]); // The route path
      }
      return routes;
    };
    
    const projectRoutes = extractRoutes(projectsFile);
    const taskRoutes = extractRoutes(tasksFile);
    const milestoneRoutes = extractRoutes(milestonesFile);
    
    // Validate expected routes exist
    expect(projectRoutes).toContain('/projects');
    expect(projectRoutes).toContain('/projects/:id');
    expect(projectRoutes).toContain('/projects/:id/status');
    
    expect(taskRoutes).toContain('/projects/:projectId/tasks');
    expect(taskRoutes).toContain('/projects/:projectId/tasks/:taskId');
    expect(taskRoutes).toContain('/projects/:projectId/tasks:bulk');
    
    expect(milestoneRoutes).toContain('/projects/:projectId/milestones');
    expect(milestoneRoutes).toContain('/projects/:projectId/milestones/:id');
    
    // Critical: ensure NO /v1 prefix routes exist
    const allRoutes = [...projectRoutes, ...taskRoutes, ...milestoneRoutes];
    const v1Routes = allRoutes.filter(r => r.startsWith('/v1/'));
    
    expect(v1Routes).toHaveLength(0);
  });

  it('should not have /v1 prefix in ProjectAPI routes', () => {
    const projectAPIFile = readFileSync(
      join(process.cwd(), 'src/dashboard/ProjectAPI.ts'),
      'utf-8'
    );
    
    // Check for /v1/projects patterns
    const v1Matches = projectAPIFile.match(/[`'"]\/v1\/projects/g);
    
    if (v1Matches) {
      throw new Error(
        `ProjectAPI contains ${v1Matches.length} references to /v1/projects routes which don't exist in dashboard backend.\n` +
        `Backend uses /projects (no /v1 prefix).\n` +
        `Found: ${v1Matches.join(', ')}`
      );
    }
    
    expect(v1Matches).toBeNull();
  });

  it('should not have /v1 prefix in TaskAPI routes', () => {
    const taskAPIFile = readFileSync(
      join(process.cwd(), 'src/dashboard/TaskAPI.ts'),
      'utf-8'
    );
    
    // Check for /v1/tasks or /v1/projects patterns
    const v1Matches = taskAPIFile.match(/[`'"]\/v1\/(tasks|projects)/g);
    
    if (v1Matches) {
      throw new Error(
        `TaskAPI contains ${v1Matches.length} references to /v1/* routes which don't exist in dashboard backend.\n` +
        `Backend uses /projects/:projectId/tasks (no /v1 prefix).\n` +
        `Found: ${v1Matches.join(', ')}`
      );
    }
    
    expect(v1Matches).toBeNull();
  });

  it('should use /projects/:projectId/tasks routes, not /v1/tasks', () => {
    const taskAPIFile = readFileSync(
      join(process.cwd(), 'src/dashboard/TaskAPI.ts'),
      'utf-8'
    );
    
    // Backend uses /projects/:projectId/tasks, not /v1/tasks
    const correctPattern = /\/projects\/.*\/tasks/;
    const wrongPattern = /\/v1\/tasks(?![:])/; // /v1/tasks but not /v1/tasks:
    
    const hasCorrectPattern = correctPattern.test(taskAPIFile);
    const hasWrongPattern = wrongPattern.test(taskAPIFile);
    
    if (hasWrongPattern) {
      throw new Error(
        'TaskAPI uses /v1/tasks routes which do not exist in dashboard backend.\n' +
        'Correct pattern: /projects/:projectId/tasks\n' +
        'Wrong pattern: /v1/tasks'
      );
    }
    
    expect(hasWrongPattern).toBe(false);
  });

  it('should not reference tasks:upsert endpoint (does not exist)', () => {
    const taskAPIFile = readFileSync(
      join(process.cwd(), 'src/dashboard/TaskAPI.ts'),
      'utf-8'
    );
    
    const upsertPattern = /tasks:upsert/;
    const hasUpsert = upsertPattern.test(taskAPIFile);
    
    if (hasUpsert) {
      throw new Error(
        'TaskAPI references tasks:upsert endpoint which does not exist in dashboard backend.\n' +
        'Backend uses: POST /projects/:projectId/tasks (with idempotency via external_id)\n' +
        'Backend also has: POST /projects/:projectId/tasks:bulk'
      );
    }
    
    expect(hasUpsert).toBe(false);
  });
});
