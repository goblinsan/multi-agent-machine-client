import type { DiffBlock } from "../DiffParser.js";
import { calculateSimilarity } from "../utils/StringUtils.js";

export function extractDiffBlocks(text: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];

  const fencedBlocks = extractFencedDiffBlocks(text);
  blocks.push(...fencedBlocks);

  const rawDiffBlocks = extractRawDiffBlocks(text);
  blocks.push(...rawDiffBlocks);

  return blocks.filter((block, index, array) => {
    if (!block.content.trim()) return false;

    return !array
      .slice(0, index)
      .some(
        (existing) =>
          calculateSimilarity(existing.content, block.content) > 0.9,
      );
  });
}

export function extractFencedDiffBlocks(text: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];

  const fencePattern = /```(?:diff)?\s*\n([\s\S]*?)```/g;
  let match;

  while ((match = fencePattern.exec(text)) !== null) {
    const content = match[1];

    if (looksLikeDiff(content)) {
      blocks.push({
        content,
        type: "unified",
        startMarker: match[0].split("\n")[0],
        endMarker: "```",
      });
    }
  }

  return blocks;
}

export function extractRawDiffBlocks(text: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  const lines = text.split("\n");
  let currentBlock: string[] = [];
  let inDiff = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git") || line.match(/^--- a\//)) {
      if (currentBlock.length > 0) {
        blocks.push({
          content: currentBlock.join("\n"),
          type: "unified",
        });
      }
      currentBlock = [line];
      inDiff = true;
    } else if (inDiff) {
      if (
        line.match(/^[+\-@\s\\]/) ||
        line.startsWith("+++") ||
        line.startsWith("---")
      ) {
        currentBlock.push(line);
      } else if (
        line.trim() === "" &&
        i < lines.length - 1 &&
        lines[i + 1].match(/^[+\-@]/)
      ) {
        currentBlock.push(line);
      } else {
        if (currentBlock.length > 0) {
          blocks.push({
            content: currentBlock.join("\n"),
            type: "unified",
          });
        }
        currentBlock = [];
        inDiff = false;
      }
    }
  }

  if (currentBlock.length > 0) {
    blocks.push({
      content: currentBlock.join("\n"),
      type: "unified",
    });
  }

  return blocks;
}

export function looksLikeDiff(content: string): boolean {
  const diffIndicators = [
    /^diff --git/m,
    /^--- /m,
    /^\+\+\+ /m,
    /^@@ /m,
    /^[+-]/m,
  ];

  return diffIndicators.some((pattern) => pattern.test(content));
}
