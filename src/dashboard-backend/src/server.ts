import Fastify from 'fastify';
import { runMigrations } from './db/migrations';
import { getDb } from './db/connection';
import { registerTaskRoutes } from './routes/tasks';

export function build() {
  const fastify = Fastify({ logger: true });

  // Register routes
  registerTaskRoutes(fastify);

  return fastify;
}

if (require.main === module) {
  const app = build();
  // Run migrations before starting
  try {
    runMigrations(getDb());
  } catch (err) {
    console.error('Failed to run migrations', err);
    process.exit(1);
  }

  const port = process.env.PORT ? parseInt(process.env.PORT) : 3000;
  app.listen({ port, host: '0.0.0.0' }).then(() => {
    console.log(`Dashboard backend running on http://localhost:${port}`);
  }).catch((err: any) => {
    console.error(err);
    process.exit(1);
  });
}
