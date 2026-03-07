import type { EditSpec, UpsertOp, DeleteOp } from "../../../fileops.js";
import type { DiffBlock } from "../DiffParser.js";
import { extractFileContentFromDiff, extractHunksFromDiff } from "../extraction/ContentExtractor.js";

export function convertDiffBlocksToEditSpec(
  blocks: DiffBlock[],
): EditSpec | null {
  const ops: Array<UpsertOp | DeleteOp> = [];

  for (const block of blocks) {
    try {
      const blockOps = parseDiffBlock(block);
      ops.push(...blockOps);
    } catch (error) {
      console.warn(`Failed to parse diff block: ${error}`);
      continue;
    }
  }

  if (ops.length === 0) {
    return null;
  }

  return { ops };
}

export function parseDiffBlock(block: DiffBlock): Array<UpsertOp | DeleteOp> {
  const ops: Array<UpsertOp | DeleteOp> = [];
  const lines = block.content.split("\n");

  let currentFile: string | null = null;
  let isDeletedFile = false;
  let isNewFile = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const gitDiffMatch = line.match(/^diff --git a\/(.+) b\/(.+)/);
    if (gitDiffMatch) {
      currentFile = gitDiffMatch[2];
      isDeletedFile = false;
      isNewFile = false;
      continue;
    }

    const bMatch = line.match(/^\+\+\+ b\/(.+)/);
    if (bMatch) {
      currentFile = bMatch[1];
      continue;
    }

    const aMatch = line.match(/^--- a\/(.+)/);
    if (aMatch && !currentFile) {
      currentFile = aMatch[1];
      continue;
    }

    if (line.includes("new file mode")) {
      isNewFile = true;
      continue;
    }

    if (line.includes("deleted file mode")) {
      isDeletedFile = true;
      continue;
    }

    if (isDeletedFile && currentFile) {
      ops.push({
        action: "delete",
        path: currentFile,
      });
      isDeletedFile = false;
      currentFile = null;
      continue;
    }

    if (line.startsWith("@@") && currentFile) {
      const hunks = extractHunksFromDiff(lines, i);
      const isAllNewContent = isNewFile || hunks.every(h => h.oldCount === 0);

      if (isAllNewContent) {
        const fileContent = extractFileContentFromDiff(lines, i + 1, currentFile);
        if (fileContent !== null) {
          ops.push({
            action: "upsert",
            path: currentFile,
            content: fileContent,
          });
        }
      } else if (hunks.length > 0) {
        ops.push({
          action: "upsert",
          path: currentFile,
          hunks,
        });
      } else {
        const fileContent = extractFileContentFromDiff(lines, i + 1, currentFile);
        if (fileContent !== null) {
          ops.push({
            action: "upsert",
            path: currentFile,
            content: fileContent,
          });
        }
      }

      while (i < lines.length - 1 && !lines[i + 1]?.startsWith("diff --git")) {
        i++;
      }

      currentFile = null;
      isNewFile = false;
    }
  }

  return ops;
}
