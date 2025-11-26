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
    process.env.PROJECT_ID || options.project || options.p || positional[0] || "";
  const taskId =
    process.env.RESET_TASK_ID || options.task || options.t || positional[1] || "";
  const status =
    process.env.RESET_TASK_STATUS || options.status || options.s || positional[2] || "in_progress";
  const depsRaw =
    process.env.RESET_TASK_DEPENDENCIES || options.deps || options.d || positional[3] || "";

  return { projectId, taskId, status, depsRaw };
}

function normalizeDependencies(raw: string): string[] {
  if (!raw) {
    return [];
  }
  return raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
}

async function main() {
  const { projectId, taskId, status, depsRaw } = parseArgs();

  if (!projectId || !taskId) {
    console.error(
      "Usage: tsx scripts/reset-task-state.ts --project <projectId> --task <taskId> [--status in_progress] [--deps id1,id2]",
    );
    process.exit(1);
  }

  const dependencies = normalizeDependencies(depsRaw);
  const api = new TaskAPI();

  await api.updateTaskStatus(taskId, status, projectId);
  await api.updateBlockedDependencies(taskId, projectId, dependencies);

  console.log("Task state reset", {
    projectId,
    taskId,
    status,
    dependencyCount: dependencies.length,
  });
}

main().catch((error) => {
  console.error("Failed to reset task state", error);
  process.exit(1);
});
