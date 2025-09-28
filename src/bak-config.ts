import "dotenv/config";

export const cfg = {
  redisUrl: process.env.REDIS_URL || "redis://localhost:6379",
  redisPassword: process.env.REDIS_PASSWORD || undefined,
  requestStream: process.env.REQUEST_STREAM || "agent.requests",
  eventStream: process.env.EVENT_STREAM || "agent.events",
  groupPrefix: process.env.GROUP_PREFIX || "cg",
  consumerId: process.env.CONSUMER_ID || "worker-1",
  allowedPersonas: (process.env.ALLOWED_PERSONAS || "").split(",").map(s => s.trim()).filter(Boolean),
  lmsBaseUrl: process.env.LMS_BASE_URL || "http://127.0.0.1:1234",
  personaModels: JSON.parse(process.env.PERSONA_MODELS_JSON || "{}"),
  dashboardBaseUrl: process.env.DASHBOARD_BASE_URL || "http://localhost:8787",
  dashboardApiKey: process.env.DASHBOARD_API_KEY || "dev",
};
