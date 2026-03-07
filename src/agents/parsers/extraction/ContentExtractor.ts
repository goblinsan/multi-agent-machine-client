import type { Hunk } from "../../../fileops.js";

export function extractFileContentFromDiff(
  lines: string[],
  startIndex: number,
  _filename: string,
): string | null {
  const contentLines: string[] = [];

  for (let i = startIndex; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("diff --git") || line.startsWith("--- a/")) {
      break;
    }

    if (line.startsWith("+")) {
      contentLines.push(line.substring(1));
    } else if (line.startsWith(" ")) {
      contentLines.push(line.substring(1));
    }
  }

  return contentLines.length > 0 ? contentLines.join("\n") : null;
}

export function extractHunksFromDiff(
  lines: string[],
  firstHunkIndex: number,
): Hunk[] {
  const hunks: Hunk[] = [];

  let i = firstHunkIndex;
  while (i < lines.length) {
    const line = lines[i];

    if (line.startsWith("diff --git")) {
      break;
    }

    const hunkHeader = /^@@\s+-?(\d+)(?:,(\d+))?\s+\+?(\d+)(?:,(\d+))?\s+@@/.exec(line);
    if (hunkHeader) {
      const oldStart = parseInt(hunkHeader[1], 10);
      const oldCount = hunkHeader[2] !== undefined ? parseInt(hunkHeader[2], 10) : 1;
      const newStart = parseInt(hunkHeader[3], 10);
      const newCount = hunkHeader[4] !== undefined ? parseInt(hunkHeader[4], 10) : 1;
      i += 1;

      const hunkLines: string[] = [];
      while (i < lines.length) {
        const hLine = lines[i];
        if (
          hLine.startsWith("diff --git") ||
          /^@@\s+/.test(hLine) ||
          hLine.startsWith("--- a/") ||
          hLine.startsWith("+++ b/")
        ) {
          break;
        }

        if (/^\\ No newline at end of file/.test(hLine)) {
          i += 1;
          continue;
        }

        if (
          hLine.startsWith("+") ||
          hLine.startsWith("-") ||
          hLine.startsWith(" ")
        ) {
          hunkLines.push(hLine);
        } else if (hLine === "") {
          hunkLines.push(" ");
        }
        i += 1;
      }

      if (hunkLines.length > 0) {
        hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
      }
      continue;
    }

    i += 1;
  }

  return hunks;
}
