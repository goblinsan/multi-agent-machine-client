import { createClient } from "redis";
import { cfg } from "../src/config.js";

const VERBOSE =
  process.argv.includes("--verbose") || process.argv.includes("-v");
const MONITOR_MODE =
  process.argv[2] && !process.argv[2].startsWith("-")
    ? process.argv[2]
    : "both";

const colors = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  gray: "\x1b[90m",
  red: "\x1b[31m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  blue: "\x1b[34m",
  magenta: "\x1b[35m",
  cyan: "\x1b[36m",
};

const c = (color: keyof typeof colors, text: string | number) =>
  `${colors[color]}${text}${colors.reset}`;

interface MonitorStats {
  requests: number;
  events: number;
  errors: number;
  startTime: number;
}

const stats: MonitorStats = {
  requests: 0,
  events: 0,
  errors: 0,
  startTime: Date.now(),
};

function formatTimestamp(ts?: string): string {
  const date = ts ? new Date(ts) : new Date();
  return c("gray", date.toISOString().split("T")[1].replace("Z", ""));
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60000).toFixed(1)}m`;
}

function formatRequest(id: string, msg: Record<string, string>): void {
  stats.requests++;

  const timestamp = formatTimestamp();
  const workflowId = c("cyan", msg.workflow_id?.slice(-8) || "unknown");
  const from = c("yellow", msg.from || "unknown");
  const to = c("green", msg.to_persona || "unknown");
  const intent = c("bold", msg.intent || "unknown");
  const step = msg.step ? c("magenta", `[${msg.step}]`) : "";
  const corrId = msg.corr_id ? c("gray", `corr:${msg.corr_id.slice(-6)}`) : "";

  console.log(
    `${timestamp} ${c("blue", "REQ")} ${workflowId} ${from} → ${to} ${step} ${intent} ${corrId}`,
  );

  if (VERBOSE) {
    console.log(c("gray", `  ID: ${id}`));
    if (msg.payload) {
      const payload =
        msg.payload.length > 200
          ? msg.payload.slice(0, 200) + "..."
          : msg.payload;
      console.log(c("gray", `  Payload: ${payload}`));
    }
    if (msg.repo) console.log(c("gray", `  Repo: ${msg.repo}`));
    if (msg.branch) console.log(c("gray", `  Branch: ${msg.branch}`));
    if (msg.deadline_s)
      console.log(c("gray", `  Deadline: ${msg.deadline_s}s`));
  }
}

function formatEvent(id: string, msg: Record<string, string>): void {
  stats.events++;

  const timestamp = formatTimestamp(msg.ts);
  const workflowId = c("cyan", msg.workflow_id?.slice(-8) || "unknown");
  const from = c("green", msg.from_persona || "unknown");
  const step = msg.step ? c("magenta", `[${msg.step}]`) : "";
  const corrId = msg.corr_id ? c("gray", `corr:${msg.corr_id.slice(-6)}`) : "";

  let statusIcon = "";
  let statusColorKey: keyof typeof colors = "reset";

  switch (msg.status) {
    case "done":
      statusIcon = "✓";
      statusColorKey = "green";
      break;
    case "progress":
      statusIcon = "⋯";
      statusColorKey = "blue";
      break;
    case "error":
      statusIcon = "✗";
      statusColorKey = "red";
      stats.errors++;
      break;
    case "blocked":
      statusIcon = "⊗";
      statusColorKey = "yellow";
      break;
    default:
      statusIcon = "?";
  }

  const status = c(
    statusColorKey,
    `${statusIcon} ${msg.status?.toUpperCase() || "UNKNOWN"}`,
  );

  console.log(
    `${timestamp} ${c("magenta", "EVT")} ${workflowId} ${from} ${step} ${status} ${corrId}`,
  );

  if (VERBOSE || msg.status === "error") {
    console.log(c("gray", `  ID: ${id}`));
    if (msg.result) {
      const result =
        msg.result.length > 200 ? msg.result.slice(0, 200) + "..." : msg.result;
      console.log(c("gray", `  Result: ${result}`));
    }
    if (msg.error) {
      console.log(c("red", `  Error: ${msg.error}`));
    }
  }
}

function printStats(): void {
  const uptime = formatDuration(Date.now() - stats.startTime);
  console.log(c("gray", "\n" + "─".repeat(80)));
  console.log(c("bold", "Statistics:"));
  console.log(`  Requests: ${c("blue", stats.requests)}`);
  console.log(`  Events:   ${c("magenta", stats.events)}`);
  console.log(`  Errors:   ${c("red", stats.errors)}`);
  console.log(`  Uptime:   ${uptime}`);
  console.log(c("gray", "─".repeat(80) + "\n"));
}

async function monitorStream(
  client: any,
  streamKey: string,
  lastId: string,
  formatter: (id: string, msg: Record<string, string>) => void,
): Promise<string> {
  try {
    const result = await client.xRead(
      { key: streamKey, id: lastId },
      { BLOCK: 1000, COUNT: 10 },
    );

    if (result) {
      for (const stream of result) {
        for (const message of stream.messages) {
          try {
            formatter(message.id, message.message as Record<string, string>);
            lastId = message.id;
          } catch (err: any) {
            console.error(c("red", `Failed to format message: ${err.message}`));
          }
        }
      }
    }
  } catch (err: any) {
    if (!err.message?.includes("ETIMEDOUT")) {
      console.error(
        c("red", `Error reading stream ${streamKey}: ${err.message}`),
      );
    }
  }

  return lastId;
}

async function main() {
  console.log(c("bold", "\n🔍 Redis Stream Monitor\n"));
  console.log(`Redis URL: ${cfg.redisUrl.replace(/:[^:@]+@/, ":***@")}`);
  console.log(`Request Stream: ${c("blue", cfg.requestStream)}`);
  console.log(`Event Stream: ${c("magenta", cfg.eventStream)}`);
  console.log(
    `Mode: ${c("yellow", MONITOR_MODE)} ${VERBOSE ? c("gray", "(verbose)") : ""}`,
  );
  console.log(c("gray", "─".repeat(80) + "\n"));

  const client = createClient({
    url: cfg.redisUrl,
    password: cfg.redisPassword,
  });

  client.on("error", (err) => {
    console.error(c("red", "Redis Client Error:"), err);
  });

  await client.connect();
  console.log(c("green", "✓ Connected to Redis\n"));

  let requestLastId = "$";
  let eventLastId = "$";

  const shouldMonitorRequests =
    MONITOR_MODE === "both" ||
    MONITOR_MODE === "requests" ||
    MONITOR_MODE === "req";
  const shouldMonitorEvents =
    MONITOR_MODE === "both" ||
    MONITOR_MODE === "events" ||
    MONITOR_MODE === "evt";

  const statsInterval = setInterval(printStats, 30000);

  process.on("SIGINT", async () => {
    console.log(c("yellow", "\n\nShutting down..."));
    clearInterval(statsInterval);
    printStats();
    await client.quit();
    process.exit(0);
  });

  console.log(c("gray", "Monitoring... (Press Ctrl+C to stop)\n"));

  while (true) {
    if (shouldMonitorRequests) {
      requestLastId = await monitorStream(
        client,
        cfg.requestStream,
        requestLastId,
        formatRequest,
      );
    }

    if (shouldMonitorEvents) {
      eventLastId = await monitorStream(
        client,
        cfg.eventStream,
        eventLastId,
        formatEvent,
      );
    }

    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

main().catch((err) => {
  console.error(c("red", "\nFatal error:"), err);
  process.exit(1);
});
