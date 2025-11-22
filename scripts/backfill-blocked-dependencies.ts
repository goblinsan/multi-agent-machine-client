import { TaskAPI } from "../src/dashboard/TaskAPI.js";

function parseArgs() {
  const args = process.argv.slice(2);
  const options: Record<string, string> = {};
  const positional: string[] = [];

  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, value = ""] = arg.slice(2).split("=");
      options[key] = value;
    } else {
      positional.push(arg);
    }
  }

  const projectId =
    process.env.PROJECT_ID ||
    options.project ||
    options.p ||
    positional[0] ||
    "";
  const parentTaskId =
    process.env.PARENT_TASK_ID ||
    options.task ||
    options.t ||
    positional[1] ||
    "";
  const dependencyList =
    process.env.DEPENDENCY_IDS || options.deps || options.d || positional[2] || "";

  return { projectId, parentTaskId, dependencyList };
}

function normalizeIds(raw: string | string[] | null | undefined): string[] {
  if (!raw) return [];
  if (Array.isArray(raw)) {
    return raw
      .map((entry) => (entry === null || entry === undefined ? "" : String(entry)))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0);
  }

  return raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function main() {
  const { projectId, parentTaskId, dependencyList } = parseArgs();

  if (!projectId || !parentTaskId || !dependencyList) {
    console.error(
      "Usage: tsx scripts/backfill-blocked-dependencies.ts --project <projectId> --task <taskId> --deps <id1,id2>",
    );
    process.exit(1);
  }

  const dependencies = normalizeIds(dependencyList);
  if (dependencies.length === 0) {
    console.error("No dependency ids provided");
    process.exit(1);
  }

  const api = new TaskAPI();
  const parent = await api.fetchTask(parentTaskId, projectId);

  if (!parent) {
    console.error("Unable to load parent task", { projectId, parentTaskId });
    process.exit(1);
  }

  const existingRaw =
    parent.blocked_dependencies ||
    parent.metadata?.blocked_dependencies ||
    [];

  const existing = normalizeIds(existingRaw);
  const merged = [...existing];

  for (const candidate of dependencies) {
    if (!merged.includes(candidate)) {
      merged.push(candidate);
    }
  }

  if (merged.length === existing.length) {
    console.log("Blocked task already lists provided dependencies", {
      projectId,
      parentTaskId,
      dependencyCount: merged.length,
    });
    return;
  }

  await api.updateBlockedDependencies(parentTaskId, projectId, merged);

  console.log("Blocked task updated", {
    projectId,
    parentTaskId,
    dependencyCount: merged.length,
    added: merged.length - existing.length,
  });
}

main().catch((error) => {
  console.error("Failed to backfill blocked dependencies", error);
  process.exit(1);
});
