import fs from "fs/promises";
import path from "path";
import { applyEditOps } from "./fileops.js";

export type Artifacts = {
  snapshot: any;
  filesNdjson: string;
  summaryMd?: string;
};

export async function writeArtifacts(options: {
  repoRoot: string;
  artifacts: Artifacts;
  apply: boolean;
  branchName: string;
  commitMessage: string;
}) {
  const { repoRoot, artifacts, apply, branchName, commitMessage } = options;
  const folder = ".ma/context";
  const files = [
    { rel: `${folder}/snapshot.json`, content: JSON.stringify(artifacts.snapshot, null, 2) + "\n" },
    { rel: `${folder}/files.ndjson`,  content: artifacts.filesNdjson },
    { rel: `${folder}/summary.md`,    content: artifacts.summaryMd || "# Context Summary\n\n(placeholder)\n" }
  ];

  if (apply) {
    const editSpec = { ops: files.map(f => ({ action: "upsert", path: f.rel, content: f.content })) };
    const res = await applyEditOps(JSON.stringify(editSpec), {
      repoRoot,
      branchName,
      commitMessage
    });
    return { applied: res, paths: files.map(f => f.rel) };
  } else {
    for (const f of files) {
      const full = path.resolve(repoRoot, f.rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, f.content, "utf8");
    }
    return { applied: null, paths: files.map(f => f.rel) };
  }
}
