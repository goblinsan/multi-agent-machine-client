import Fastify from 'fastify';
import { runMigrations } from './db/migrations';
import { getDb, saveDb } from './db/connection';
import { registerTaskRoutes } from './routes/tasks';

export function build() {
  const fastify = Fastify({ logger: true });

  // Register routes
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
    }).catch((err: any) => {
      console.error(err);
      process.exit(1);
    });
  }).catch(err => {
    console.error('Failed to initialize database', err);
    process.exit(1);
  });
}
