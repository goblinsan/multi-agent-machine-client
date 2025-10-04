import { createClient } from "redis";
import { cfg } from "./config.js";
import { logger } from "./logger.js";

const ERROR_LOG_THROTTLE_MS = 30_000;
let lastRedisErrorLog = 0;

export async function makeRedis() {
  const client = createClient({ url: cfg.redisUrl, password: cfg.redisPassword });
  client.on("error", (e) => {
    const now = Date.now();
    if (now - lastRedisErrorLog >= ERROR_LOG_THROTTLE_MS) {
      lastRedisErrorLog = now;
      logger.error("redis client error", { error: e });
    } else {
      logger.debug("redis client error (suppressed)", { error: e?.message, code: (e as any)?.code });
    }
  });
  await client.connect();
  return client;
}
