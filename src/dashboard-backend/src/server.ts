import Fastify from 'fastify';
import { runMigrations } from './db/migrations';
import { getDb, saveDb } from './db/connection';
import { registerProjectRoutes } from './routes/projects';
import { registerRepositoryRoutes } from './routes/repositories';
import { registerMilestoneRoutes } from './routes/milestones';
import { registerTaskRoutes } from './routes/tasks';
import { registerHealthRoutes } from './routes/health';

export function build() {
  const fastify = Fastify({ logger: true });

  // Register health check routes first (no auth required)
  registerHealthRoutes(fastify);
  
  // Register project routes
  registerProjectRoutes(fastify);
  
  // Register repository routes
  registerRepositoryRoutes(fastify);
  
  // Register milestone routes
  registerMilestoneRoutes(fastify);
  
  // Register task routes
  registerTaskRoutes(fastify);

  return fastify;
}

if (require.main === module) {
  const app = build();
  
  // Run migrations before starting (async)
  getDb().then(async db => {
    runMigrations(db);
    await saveDb(db);  // Save migrations to disk
    console.log('Migrations applied and saved');
    
    const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
    app.listen({ port, host: '0.0.0.0' }).then(() => {
      console.log(`Dashboard backend running on http://localhost:${port}`);
      console.log(`Health check available at http://localhost:${port}/health`);
      console.log(`Metrics available at http://localhost:${port}/metrics`);
    }).catch((err: any) => {
      console.error(err);
      process.exit(1);
    });
    
    // Graceful shutdown on SIGTERM
    process.on('SIGTERM', async () => {
      console.log('SIGTERM received, shutting down gracefully...');
      try {
        await app.close();
        console.log('Server closed successfully');
        process.exit(0);
      } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
      }
    });
    
    // Graceful shutdown on SIGINT (Ctrl+C)
    process.on('SIGINT', async () => {
      console.log('SIGINT received, shutting down gracefully...');
      try {
        await app.close();
        console.log('Server closed successfully');
        process.exit(0);
      } catch (err) {
        console.error('Error during shutdown:', err);
        process.exit(1);
      }
    });
  }).catch(err => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
}
