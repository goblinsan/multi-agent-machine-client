import type { FastifyInstance } from "fastify";
import { getDb } from "../db/connection";

const startTime = Date.now();

interface Metrics {
  requestCount: number;
  errorCount: number;
  taskCreatedCount: number;
  taskUpdatedCount: number;
  dbQueryCount: number;
}

const metrics: Metrics = {
  requestCount: 0,
  errorCount: 0,
  taskCreatedCount: 0,
  taskUpdatedCount: 0,
  dbQueryCount: 0,
};

export function incrementMetric(metric: keyof Metrics, value: number = 1) {
  metrics[metric] += value;
}

export function registerHealthRoutes(fastify: FastifyInstance) {
  fastify.get("/health", async (request: any, reply: any) => {
    const uptime = Date.now() - startTime;

    return reply.status(200).send({
      status: "ok",
      timestamp: new Date().toISOString(),
      uptime,
      service: "dashboard-backend",
      version: process.env.npm_package_version || "1.0.0",
    });
  });

  fastify.get("/health/db", async (request: any, reply: any) => {
    try {
      const db = await getDb();

      const result = db.exec("SELECT 1 as health_check");

      if (result.length > 0) {
        return reply.status(200).send({
          status: "ok",
          database: "connected",
          timestamp: new Date().toISOString(),
        });
      } else {
        return reply.status(503).send({
          status: "error",
          database: "disconnected",
          error: "Database query returned no results",
          timestamp: new Date().toISOString(),
        });
      }
    } catch (error: any) {
      request.log.error("Database health check failed", error);

      return reply.status(503).send({
        status: "error",
        database: "disconnected",
        error: error.message || "Database connection failed",
        timestamp: new Date().toISOString(),
      });
    }
  });

  fastify.get("/health/ready", async (request: any, reply: any) => {
    try {
      const db = await getDb();
      db.exec("SELECT 1");

      return reply.status(200).send({
        status: "ready",
        timestamp: new Date().toISOString(),
      });
    } catch (error: any) {
      return reply.status(503).send({
        status: "not_ready",
        error: error.message,
        timestamp: new Date().toISOString(),
      });
    }
  });

  fastify.get("/health/live", async (request: any, reply: any) => {
    return reply.status(200).send({
      status: "alive",
      timestamp: new Date().toISOString(),
    });
  });

  fastify.get("/metrics", async (request: any, reply: any) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

    const prometheusMetrics = `
# HELP http_requests_total Total HTTP requests
# TYPE http_requests_total counter
http_requests_total{service="dashboard-backend"} ${metrics.requestCount}

# HELP http_errors_total Total HTTP errors
# TYPE http_errors_total counter
http_errors_total{service="dashboard-backend"} ${metrics.errorCount}

# HELP tasks_created_total Total tasks created
# TYPE tasks_created_total counter
tasks_created_total{service="dashboard-backend"} ${metrics.taskCreatedCount}

# HELP tasks_updated_total Total tasks updated
# TYPE tasks_updated_total counter
tasks_updated_total{service="dashboard-backend"} ${metrics.taskUpdatedCount}

# HELP db_queries_total Total database queries executed
# TYPE db_queries_total counter
db_queries_total{service="dashboard-backend"} ${metrics.dbQueryCount}

# HELP uptime_seconds Service uptime in seconds
# TYPE uptime_seconds gauge
uptime_seconds{service="dashboard-backend"} ${uptimeSeconds}

# HELP process_start_time_seconds Process start time as Unix timestamp
# TYPE process_start_time_seconds gauge
process_start_time_seconds{service="dashboard-backend"} ${Math.floor(startTime / 1000)}
`.trim();

    return reply
      .header("Content-Type", "text/plain; version=0.0.4")
      .send(prometheusMetrics);
  });

  fastify.get("/metrics/json", async (request: any, reply: any) => {
    const uptimeSeconds = Math.floor((Date.now() - startTime) / 1000);

    return reply.status(200).send({
      service: "dashboard-backend",
      timestamp: new Date().toISOString(),
      uptime_seconds: uptimeSeconds,
      metrics: {
        http_requests_total: metrics.requestCount,
        http_errors_total: metrics.errorCount,
        tasks_created_total: metrics.taskCreatedCount,
        tasks_updated_total: metrics.taskUpdatedCount,
        db_queries_total: metrics.dbQueryCount,
      },
    });
  });
}

export function getMetrics(): Readonly<Metrics> {
  return { ...metrics };
}

export function resetMetrics() {
  metrics.requestCount = 0;
  metrics.errorCount = 0;
  metrics.taskCreatedCount = 0;
  metrics.taskUpdatedCount = 0;
  metrics.dbQueryCount = 0;
}
