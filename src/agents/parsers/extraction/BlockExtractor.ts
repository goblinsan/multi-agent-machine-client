import type { DiffBlock } from '../DiffParser.js';
import { calculateSimilarity } from '../utils/StringUtils.js';

/**
 * BlockExtractor - Extracts diff blocks from persona responses
 * 
 * Responsibilities:
 * - Extract fenced code blocks containing diffs
 * - Extract raw diff format blocks
 * - Deduplicate extracted blocks
 * - Validate diff content
 */

/**
 * Extract diff blocks from cleaned response text
 * Combines fenced and raw diff extraction with deduplication
 */
export function extractDiffBlocks(text: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  
  // Look for fenced code blocks with diff content
  const fencedBlocks = extractFencedDiffBlocks(text);
  blocks.push(...fencedBlocks);
  
  // Look for raw diff content (git diff format)
  const rawDiffBlocks = extractRawDiffBlocks(text);
  blocks.push(...rawDiffBlocks);
  
  // Remove duplicates and empty blocks
  return blocks.filter((block, index, array) => {
    if (!block.content.trim()) return false;
    
    // Simple deduplication based on content similarity
    return !array.slice(0, index).some(existing => 
      calculateSimilarity(existing.content, block.content) > 0.9
    );
  });
}

/**
 * Extract diff blocks from fenced code blocks (```diff ... ```)
 */
export function extractFencedDiffBlocks(text: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  
  // Match ```diff ... ``` or ``` ... ``` blocks that contain diff content
  const fencePattern = /```(?:diff)?\s*\n([\s\S]*?)```/g;
  let match;
  
  while ((match = fencePattern.exec(text)) !== null) {
    const content = match[1];
    
    // Check if content looks like a diff
    if (looksLikeDiff(content)) {
      blocks.push({
        content,
        type: 'unified',
        startMarker: match[0].split('\n')[0],
        endMarker: '```'
      });
    }
  }
  
  return blocks;
}

/**
 * Extract raw diff blocks from text (git diff format)
 */
export function extractRawDiffBlocks(text: string): DiffBlock[] {
  const blocks: DiffBlock[] = [];
  const lines = text.split('\n');
  let currentBlock: string[] = [];
  let inDiff = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    
    // Check if this line starts a diff
    if (line.startsWith('diff --git') || line.match(/^--- a\//)) {
      if (currentBlock.length > 0) {
        // Save previous block
        blocks.push({
          content: currentBlock.join('\n'),
          type: 'unified'
        });
      }
      currentBlock = [line];
      inDiff = true;
    } else if (inDiff) {
      // Continue collecting diff lines
      if (line.match(/^[+\-@\s\\]/) || line.startsWith('+++') || line.startsWith('---')) {
        currentBlock.push(line);
      } else if (line.trim() === '' && i < lines.length - 1 && lines[i + 1].match(/^[+\-@]/)) {
        // Empty line within diff
        currentBlock.push(line);
      } else {
        // End of diff
        if (currentBlock.length > 0) {
          blocks.push({
            content: currentBlock.join('\n'),
            type: 'unified'
          });
        }
        currentBlock = [];
        inDiff = false;
      }
    }
  }
  
  // Add final block if exists
  if (currentBlock.length > 0) {
    blocks.push({
      content: currentBlock.join('\n'),
      type: 'unified'
    });
  }
  
  return blocks;
}

/**
 * Check if content looks like a diff format
 */
export function looksLikeDiff(content: string): boolean {
  const diffIndicators = [
    /^diff --git/m,
    /^--- /m,
    /^\+\+\+ /m,
    /^@@ /m,
    /^[+-]/m
  ];
  
  return diffIndicators.some(pattern => pattern.test(content));
}
