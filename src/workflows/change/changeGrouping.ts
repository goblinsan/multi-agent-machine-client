import {
  changeBranchName,
  fileBranchName,
  toBranchSegment,
} from "../../git/branchNaming.js";

export const CHANGE_LABEL_PREFIX = "change:";
export const FILE_LABEL_PREFIX = "file:";
export const CHANGE_TASK_TYPES = [
  "change_setup",
  "change_file",
  "change_converge",
] as const;
export type ChangeTaskType = (typeof CHANGE_TASK_TYPES)[number];

export interface ChangeFileSpec {
  path: string;
  contract: string;
  dependsOn?: string[];
}

export interface ChangeSpec {
  slug: string;
  title: string;
  files: ChangeFileSpec[];
}

export interface ChangeTaskPayload {
  title: string;
  description: string;
  status: "open";
  priority_score: number;
  external_id: string;
  labels: string[];
}

export interface BuiltChange {
  slug: string;
  tasks: ChangeTaskPayload[];
  dependencies: Record<string, string[]>;
}

function fileExternalId(slug: string, path: string): string {
  return `change-${slug}-file-${toBranchSegment(path)}`;
}

export function buildChangeTasks(spec: ChangeSpec): BuiltChange {
  const slug = toBranchSegment(spec.slug);
  if (!slug) {
    throw new Error("buildChangeTasks: change slug produced an empty segment");
  }
  if (!spec.files || spec.files.length === 0) {
    throw new Error("buildChangeTasks: a change needs at least one file");
  }

  const setupId = `change-${slug}-setup`;
  const convergeId = `change-${slug}-converge`;
  const changeLabel = `${CHANGE_LABEL_PREFIX}${slug}`;

  const tasks: ChangeTaskPayload[] = [];
  const dependencies: Record<string, string[]> = {};

  tasks.push({
    title: `Set up change branch for ${spec.title}`,
    description: `Create and publish the change branch change/${slug}.`,
    status: "open",
    priority_score: 300,
    external_id: setupId,
    labels: ["change_setup", changeLabel],
  });

  const fileIds: string[] = [];
  for (const file of spec.files) {
    const extId = fileExternalId(slug, file.path);
    fileIds.push(extId);
    dependencies[extId] = [
      setupId,
      ...(file.dependsOn || []).map((p) => fileExternalId(slug, p)),
    ];
    tasks.push({
      title: `${spec.title}: ${file.path}`,
      description: file.contract,
      status: "open",
      priority_score: 200,
      external_id: extId,
      labels: ["change_file", changeLabel, `${FILE_LABEL_PREFIX}${file.path}`],
    });
  }

  dependencies[convergeId] = [...fileIds];
  tasks.push({
    title: `Converge and merge ${spec.title}`,
    description: `Validate the assembled change/${slug} and merge it to main.`,
    status: "open",
    priority_score: 100,
    external_id: convergeId,
    labels: ["change_converge", changeLabel],
  });

  return { slug, tasks, dependencies };
}

export function resolveChangeDependencies(
  idByExternalId: Record<string, string | number>,
  dependencies: Record<string, string[]>,
): Array<{ taskId: string | number; blocked_dependencies: string[] }> {
  const patches: Array<{
    taskId: string | number;
    blocked_dependencies: string[];
  }> = [];
  for (const [externalId, deps] of Object.entries(dependencies)) {
    const taskId = idByExternalId[externalId];
    if (taskId === undefined) continue;
    const depIds = deps
      .map((d) => idByExternalId[d])
      .filter((v) => v !== undefined)
      .map((v) => String(v));
    if (depIds.length > 0) {
      patches.push({ taskId, blocked_dependencies: depIds });
    }
  }
  return patches;
}

function labelsOf(task: any): string[] {
  const raw = task?.labels;
  if (Array.isArray(raw)) return raw.map((l) => String(l));
  if (typeof raw === "string") {
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed.map((l) => String(l)) : [];
    } catch {
      return raw.trim() ? [raw] : [];
    }
  }
  return [];
}

export function changeTaskTypeFromLabels(task: any): ChangeTaskType | null {
  const labels = labelsOf(task);
  for (const type of CHANGE_TASK_TYPES) {
    if (labels.includes(type)) return type;
  }
  return null;
}

export interface ChangeVariables {
  changeSlug: string;
  changeBranch: string;
  fileBranch?: string;
}

export function resolveChangeVariables(task: any): ChangeVariables | null {
  const labels = labelsOf(task);
  const changeLabel = labels.find((l) => l.startsWith(CHANGE_LABEL_PREFIX));
  if (!changeLabel) return null;
  const slug = changeLabel.slice(CHANGE_LABEL_PREFIX.length);
  if (!slug) return null;

  const vars: ChangeVariables = {
    changeSlug: slug,
    changeBranch: changeBranchName(slug),
  };

  const fileLabel = labels.find((l) => l.startsWith(FILE_LABEL_PREFIX));
  if (fileLabel) {
    const filePath = fileLabel.slice(FILE_LABEL_PREFIX.length);
    if (filePath) vars.fileBranch = fileBranchName(slug, filePath);
  }
  return vars;
}
