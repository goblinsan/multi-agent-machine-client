import { readFileSync } from "fs";
import { resolve } from "path";
import { execFile, spawn } from "child_process";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

const ENV_PATH = resolve(process.cwd(), ".env");
const LMS_BASE_URL_FALLBACK = "http://127.0.0.1:1234";
const LOAD_POLL_INTERVAL_MS = 3000;
const LOAD_TIMEOUT_MS = 10 * 60 * 1000;
const SERVER_START_TIMEOUT_MS = 60 * 1000;
const DEFAULT_CONTEXT_LENGTH = 16384;

function parseEnv(content: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx === -1) continue;
    const key = trimmed.slice(0, eqIdx).trim();
    let val = trimmed.slice(eqIdx + 1).trim();
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    result[key] = val;
  }
  return result;
}

function requiredModels(env: Record<string, string>): Set<string> {
  const raw = env["PERSONA_MODELS_JSON"];
  if (!raw) return new Set();
  try {
    const map: Record<string, string> = JSON.parse(raw);
    return new Set(Object.values(map));
  } catch {
    return new Set();
  }
}

async function fetchModels(baseUrl: string): Promise<{ id: string; state: string }[]> {
  const url = `${baseUrl.replace(/\/$/, "")}/api/v0/models`;
  const res = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const data: any = await res.json();
  return (data?.data ?? data ?? []).map((m: any) => ({ id: m.id as string, state: (m.state ?? "not-loaded") as string }));
}

async function fetchLoadedModels(baseUrl: string): Promise<string[]> {
  const all = await fetchModels(baseUrl);
  return all.filter((m) => m.state === "loaded").map((m) => m.id);
}

async function fetchAvailableModels(baseUrl: string): Promise<string[]> {
  const all = await fetchModels(baseUrl);
  return all.map((m) => m.id);
}

async function loadModel(baseUrl: string, identifier: string, contextLength: number): Promise<void> {
  await execFileAsync("lms", ["load", identifier, "--gpu", "max", "-c", String(contextLength)], { timeout: 30000 });
}

async function unloadModel(_baseUrl: string, identifier: string): Promise<void> {
  await execFileAsync("lms", ["unload", identifier], { timeout: 15000 });
}

function modelMatch(required: string, candidates: string[]): string | undefined {
  const r = required.toLowerCase();
  return candidates.find((c) => {
    const cl = c.toLowerCase();
    return cl.includes(r) || r.includes(cl);
  });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function isServerReachable(baseUrl: string): Promise<boolean> {
  try {
    const res = await fetch(`${baseUrl.replace(/\/$/, "")}/api/v0/models`, {
      signal: AbortSignal.timeout(3000),
    });
    return res.ok;
  } catch {
    return false;
  }
}

async function ensureServerRunning(baseUrl: string): Promise<void> {
  if (await isServerReachable(baseUrl)) return;

  console.log("LM Studio server is not running. Attempting to start it...\n");

  // Try the lms CLI first (starts server without opening the full GUI)
  let usedCli = false;
  try {
    await execFileAsync("lms", ["server", "start"], { timeout: 15000 });
    console.log("  \u2713  lms CLI: server start issued");
    usedCli = true;
  } catch (cliErr: any) {
    if (cliErr.code === "ENOENT" || /not found/i.test(cliErr.message ?? "")) {
      console.log("  \u26A0\uFE0F  lms CLI not found — launching LM Studio app instead...");
      spawn("open", ["-a", "LM Studio"], { detached: true, stdio: "ignore" }).unref();
    } else {
      // lms exists but returned an error (e.g. already starting) — still poll
      console.log(`  \u26A0\uFE0F  lms server start: ${cliErr.message?.trim() ?? cliErr.code}`);
      usedCli = true;
    }
  }

  if (!usedCli) {
    console.log("  The app is opening — please start the local server from the LM Studio UI if it");
    console.log("  doesn't start automatically.\n");
  }

  process.stdout.write(`\n  Waiting for server at ${baseUrl}`);
  const deadline = Date.now() + SERVER_START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(3000);
    process.stdout.write(".");
    if (await isServerReachable(baseUrl)) {
      process.stdout.write(" \u2705\n\n");
      return;
    }
  }
  process.stdout.write(" \u274C\n\n");
  console.error(`Server did not become reachable within ${SERVER_START_TIMEOUT_MS / 1000}s.`);
  console.error("Start LM Studio manually and ensure the local server is enabled, then retry.\n");
  process.exit(1);
}

async function waitUntilLoaded(
  baseUrl: string,
  identifier: string,
  label: string,
): Promise<boolean> {
  const deadline = Date.now() + LOAD_TIMEOUT_MS;
  process.stdout.write(`  \u23F3  Waiting for "${label}" to load`);
  while (Date.now() < deadline) {
    await sleep(LOAD_POLL_INTERVAL_MS);
    process.stdout.write(".");
    try {
      const loaded = await fetchLoadedModels(baseUrl);
      if (modelMatch(label, loaded)) {
        process.stdout.write(" \u2705\n");
        return true;
      }
    } catch {
      // server briefly unavailable during model swap — keep polling
    }
  }
  process.stdout.write(" \u274C timed out\n");
  return false;
}

async function main() {
  const args = process.argv.slice(2);
  const autoLoad = args.includes("--load");
  const reload = args.includes("--reload");
  const unloadUnused = args.includes("--unload-unused");
  const unloadIdx = args.indexOf("--unload");
  const unloadTarget = unloadIdx !== -1 ? args[unloadIdx + 1] : undefined;

  let env: Record<string, string> = {};
  try {
    env = parseEnv(readFileSync(ENV_PATH, "utf8"));
  } catch {
    console.warn(`Warning: could not read .env at ${ENV_PATH}`);
  }

  const baseUrl = env["LMS_BASE_URL"] || LMS_BASE_URL_FALLBACK;
  const contextLength = Number(env["LMS_CONTEXT_LENGTH"]) || DEFAULT_CONTEXT_LENGTH;
  const needed = requiredModels(env);

  if (needed.size === 0) {
    console.log("No models found in PERSONA_MODELS_JSON — nothing to check.");
    process.exit(0);
  }

  console.log(`\nChecking LM Studio at ${baseUrl}...\n`);

  await ensureServerRunning(baseUrl);

  let loaded: string[] = [];
  try {
    loaded = await fetchLoadedModels(baseUrl);
  } catch (err: any) {
    console.error(`\u274C  Failed to list loaded models: ${err.message}\n`);
    process.exit(1);
  }

  console.log(`Loaded models (${loaded.length}):`);
  for (const m of loaded) console.log(`  \u2022 ${m}`);
  console.log();

  // --unload <id>: unload a specific model by (partial) name
  if (unloadTarget) {
    const match = modelMatch(unloadTarget, loaded);
    if (!match) {
      console.error(`\u274C  No loaded model matching "${unloadTarget}"`);
      process.exit(1);
    }
    process.stdout.write(`Unloading "${match}"...`);
    try {
      await unloadModel(baseUrl, match);
      process.stdout.write(" \u2705\n\n");
    } catch (err: any) {
      process.stdout.write(` \u274C  ${err.message}\n\n`);
      process.exit(1);
    }
    process.exit(0);
  }

  // --unload-unused: unload everything not needed by PERSONA_MODELS_JSON
  if (unloadUnused) {
    const extras = loaded.filter((l) => ![...needed].some((req) => l.toLowerCase().includes(req.toLowerCase())));
    if (extras.length === 0) {
      console.log("No unused models to unload.\n");
    } else {
      console.log(`Unloading ${extras.length} unused model(s):`);
      for (const m of extras) {
        process.stdout.write(`  \u25BC  ${m}...`);
        try {
          await unloadModel(baseUrl, m);
          process.stdout.write(" \u2705\n");
        } catch (err: any) {
          process.stdout.write(` \u274C  ${err.message}\n`);
        }
      }
      console.log();
      loaded = loaded.filter((l) => !extras.includes(l));
    }
  }

  const missing: string[] = [];
  console.log("Required models (from PERSONA_MODELS_JSON):");
  for (const req of [...needed].sort()) {
    const match = modelMatch(req, loaded);
    if (match) {
      console.log(`  \u2705  ${req}  \u2192  ${match}`);
    } else {
      console.log(`  \u274C  ${req}  (not loaded)`);
      missing.push(req);
    }
  }
  console.log();

  if (reload) {
    console.log(`Reloading ${needed.size} model(s) with context length ${contextLength}...\n`);
    let available: string[] = [];
    try {
      available = await fetchAvailableModels(baseUrl);
    } catch (err: any) {
      console.warn(`  Warning: could not list available models (${err.message})`);
    }
    const unique = [...new Set([...needed])];
    for (const req of unique) {
      const currentlyLoaded = modelMatch(req, loaded);
      if (currentlyLoaded) {
        process.stdout.write(`  \u25BC  Unloading "${currentlyLoaded}"...`);
        try {
          await unloadModel(baseUrl, currentlyLoaded);
          process.stdout.write(" \u2705\n");
        } catch (err: any) {
          process.stdout.write(` \u274C  ${err.message}\n`);
        }
      }
      const identifier = modelMatch(req, available) ?? req;
      process.stdout.write(`  \u25B6\uFE0F  Loading "${req}" (${identifier}) with context length ${contextLength}...`);
      try {
        await loadModel(baseUrl, identifier, contextLength);
        process.stdout.write(` \u2705\n`);
      } catch (err: any) {
        process.stdout.write(` \u274C  ${err.message}\n`);
      }
    }
    console.log("\nReload complete.\n");
    process.exit(0);
  }

  if (missing.length === 0) {
    console.log("All required models are loaded. Ready to run.\n");
    process.exit(0);
  }

  if (!autoLoad) {
    console.log(`Missing ${missing.length} model(s). Re-run with --load to attempt auto-loading:\n`);
    console.log(`  npm run check-models -- --load\n`);
    process.exit(1);
  }

  console.log("Fetching available (downloaded) models from LM Studio...\n");
  let available: string[] = [];
  try {
    available = await fetchAvailableModels(baseUrl);
  } catch (err: any) {
    console.warn(`  Warning: could not list available models (${err.message})`);
    console.warn("  LM Studio may not support the /api/v0/models endpoint on this version.\n");
  }

  const stillMissing: string[] = [];
  for (const req of missing) {
    const identifier = modelMatch(req, available);
    if (!identifier) {
      console.log(`  \u26A0\uFE0F  "${req}" — not found in downloaded models. Download it in LM Studio first.`);
      stillMissing.push(req);
      continue;
    }
    console.log(`  \u25B6\uFE0F  Loading "${req}" (${identifier}) with context length ${contextLength}...`);
    try {
      await loadModel(baseUrl, identifier, contextLength);
      console.log(`  \u2705  "${req}" loaded (context: ${contextLength})`);
    } catch (err: any) {
      console.log(`  \u274C  Load failed: ${err.message}`);
      stillMissing.push(req);
    }
  }

  console.log();
  if (stillMissing.length === 0) {
    console.log("All required models are now loaded. Ready to run.\n");
    process.exit(0);
  } else {
    console.log(`Still missing ${stillMissing.length} model(s) — load them manually in LM Studio:\n`);
    for (const m of stillMissing) console.log(`  \u2022 ${m}`);
    console.log();
    process.exit(1);
  }
}

main();
