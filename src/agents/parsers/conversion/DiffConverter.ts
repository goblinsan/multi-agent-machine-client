import type { EditSpec, UpsertOp, DeleteOp } from '../../../fileops.js';
import type { DiffBlock } from '../DiffParser.js';
import { extractFileContentFromDiff } from '../extraction/ContentExtractor.js';

/**
 * DiffConverter - Converts diff blocks to edit specifications
 * 
 * Responsibilities:
 * - Convert diff blocks to EditSpec format
 * - Parse individual diff blocks
 * - Extract filenames from diff headers
 * - Handle file deletions and additions
 */

/**
 * Convert diff blocks to edit specification
 */
export function convertDiffBlocksToEditSpec(blocks: DiffBlock[]): EditSpec | null {
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

/**
 * Parse a single diff block into edit operations
 */
export function parseDiffBlock(block: DiffBlock): Array<UpsertOp | DeleteOp> {
  const ops: Array<UpsertOp | DeleteOp> = [];
  const lines = block.content.split('\n');
  
  let currentFile: string | null = null;
  let isDeletedFile = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Extract filename from diff headers
    const fileMatch = line.match(/^diff --git a\/(.+) b\/(.+)/) ||
                     line.match(/^\+\+\+ b\/(.+)/) ||
                     line.match(/^--- a\/(.+)/);
    
    if (fileMatch) {
      currentFile = fileMatch[1];
      continue;
    }
    
    // Skip new file mode indicator (we process all files the same way)
    if (line.includes('new file mode')) {
      continue;
    }
    
    if (line.includes('deleted file mode')) {
      isDeletedFile = true;
      continue;
    }
    
    // Handle file deletion
    if (isDeletedFile && currentFile) {
      ops.push({
        action: 'delete',
        path: currentFile
      });
      isDeletedFile = false;
      currentFile = null;
      continue;
    }
    
    // Process hunk headers and content
    if (line.startsWith('@@') && currentFile) {
      // Parse the rest of the file content
      const fileContent = extractFileContentFromDiff(lines, i + 1, currentFile);
      
      if (fileContent !== null) {
        ops.push({
          action: 'upsert',
          path: currentFile,
          content: fileContent
        });
      }
      
      // Skip to end of this file's diff
      while (i < lines.length && !lines[i + 1]?.startsWith('diff --git')) {
        i++;
      }
      
      currentFile = null;
    }
  }
  
  return ops;
}
