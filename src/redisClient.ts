import { createClient } from "redis";
import { cfg } from "./config.js";
import { logger } from "./logger.js";

export async function makeRedis() {
  const client = createClient({ url: cfg.redisUrl, password: cfg.redisPassword });
  client.on("error", (e) => logger.error("redis client error", { error: e }));
  await client.connect();
  return client;
}
