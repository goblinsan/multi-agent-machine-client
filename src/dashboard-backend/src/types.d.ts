declare module 'fastify' {
  import { Server, IncomingMessage, ServerResponse } from 'http';
  export interface FastifyInstance {
    get(path: string, handler: any): void;
    post(path: string, handler: any): void;
    patch(path: string, handler: any): void;
    listen(opts: any): Promise<void>;
  }
  const fastify: (opts?: any) => FastifyInstance;
  export default fastify;
}

// Allow importing JSON schema file paths
declare module '*.sql';
