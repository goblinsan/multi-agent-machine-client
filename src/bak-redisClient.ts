import { createClient } from "redis";
import { cfg } from "./config.js";

export async function makeRedis() {
  const client = createClient({ url: cfg.redisUrl, password: cfg.redisPassword });
  client.on("error", (e) => console.error("[redis] error", e));
  await client.connect();
  return client;
}
