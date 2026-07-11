export { applyEditOps, writeDiagnostic } from "./fileops/applyEditOps.js";

export type Hunk = {
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: string[];
};
export type UpsertOp = {
  action: "upsert";
  path: string;
  content?: string;
  hunks?: Hunk[];
};
export type DeleteOp = { action: "delete"; path: string };
export type EditSpec = { ops: Array<UpsertOp | DeleteOp>; warnings?: string[] };

export type ApplyOptions = {
  repoRoot: string;
  maxBytes?: number;
  blockedExts?: string[];
  branchName?: string;
  commitMessage?: string;
  commit?: boolean;
};
