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
  commitMessage: string;
  forceCommit?: boolean;
}) {
  const {
    repoRoot,
    artifacts,
    apply,
    commitMessage,
    forceCommit = false,
  } = options;
  const folder = ".ma/context";
  const files = [
    {
      rel: `${folder}/snapshot.json`,
      content: JSON.stringify(artifacts.snapshot, null, 2) + "\n",
    },
    { rel: `${folder}/files.ndjson`, content: artifacts.filesNdjson },
    {
      rel: `${folder}/summary.md`,
      content: artifacts.summaryMd || "# Context Summary\n\n(placeholder)\n",
    },
  ];

  const shouldCommit = apply || forceCommit;

  if (shouldCommit) {
    const commitOps = [files[0], files[2]];
    const editSpec = {
      ops: commitOps.map((f) => ({
        action: "upsert",
        path: f.rel,
        content: f.content,
      })),
    };
    const res = await applyEditOps(JSON.stringify(editSpec), {
      repoRoot,
      branchName: "feat/agent-edit",
      commitMessage,
    });
    const ndPath = path.resolve(repoRoot, files[1].rel);
    await fs.mkdir(path.dirname(ndPath), { recursive: true });
    await fs.writeFile(ndPath, files[1].content, "utf8");
    return { applied: res, paths: [files[0].rel, files[2].rel, files[1].rel] };
  } else {
    for (const f of files) {
      const full = path.resolve(repoRoot, f.rel);
      await fs.mkdir(path.dirname(full), { recursive: true });
      await fs.writeFile(full, f.content, "utf8");
    }
    return { applied: null, paths: files.map((f) => f.rel) };
  }
}
