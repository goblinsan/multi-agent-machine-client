import { EditSpec, UpsertOp, DeleteOp } from '../../fileops.js';

/**
 * Extracted diff block from persona response
 */
export interface DiffBlock {
  filename?: string;
  content: string;
  type: 'unified' | 'context' | 'raw';
  startMarker?: string;
  endMarker?: string;
}

/**
 * Result of diff parsing
 */
export interface DiffParseResult {
  success: boolean;
  editSpec?: EditSpec;
  diffBlocks: DiffBlock[];
  errors: string[];
  warnings: string[];
}

/**
 * Enhanced diff parser to reliably extract and convert diffs from persona responses
 */
export class DiffParser {
  private static readonly DIFF_MARKERS = [
    '```diff',
    '```',
    '<diff>',
    '</diff>',
    '<pre>',
    '</pre>',
    'diff --git',
    '--- a/',
    '+++ b/',
    '@@'
  ];

  private static readonly FILE_PATTERNS = [
    /diff --git a\/(.+) b\/(.+)/,
    /--- a\/(.+)/,
    /\+\+\+ b\/(.+)/,
    /Index: (.+)/,
    /^--- (.+)\s+/,
    /^\+\+\+ (.+)\s+/
  ];

  /**
   * Parse persona response and extract diff blocks
   */
  static parsePersonaResponse(response: string): DiffParseResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let diffBlocks: DiffBlock[] = [];

    try {
      // Clean up the response
      const cleanedResponse = this.cleanResponse(response);
      
      // Extract diff blocks
      diffBlocks = this.extractDiffBlocks(cleanedResponse);
      
      if (diffBlocks.length === 0) {
        warnings.push('No diff blocks found in response');
        return {
          success: false,
          diffBlocks: [],
          errors: ['No diff blocks detected in persona response'],
          warnings
        };
      }

      // Convert diff blocks to edit spec
      const editSpec = this.convertDiffBlocksToEditSpec(diffBlocks);
      
      if (!editSpec || editSpec.ops.length === 0) {
        errors.push('Failed to convert diff blocks to edit operations');
        return {
          success: false,
          diffBlocks,
          errors,
          warnings
        };
      }

      // Validate edit spec
      const validation = this.validateEditSpec(editSpec);
      if (!validation.valid) {
        errors.push(...validation.errors);
        warnings.push(...validation.warnings);
      }

      return {
        success: validation.valid,
        editSpec,
        diffBlocks,
        errors,
        warnings
      };

    } catch (error) {
      errors.push(`Diff parsing failed: ${error}`);
      return {
        success: false,
        diffBlocks,
        errors,
        warnings
      };
    }
  }

  /**
   * Clean up response text for better parsing
   */
  private static cleanResponse(response: string): string {
    // Remove extra whitespace and normalize line endings
    let cleaned = response.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
    
    // Remove markdown formatting that might interfere
    cleaned = cleaned.replace(/^\s*`{3,}[a-zA-Z]*\s*$/gm, '```');
    
    // Remove HTML tags that might wrap diffs
    cleaned = cleaned.replace(/<\/?pre[^>]*>/gi, '');
    cleaned = cleaned.replace(/<\/?code[^>]*>/gi, '');
    
    return cleaned;
  }

  /**
   * Extract diff blocks from cleaned response
   */
  private static extractDiffBlocks(text: string): DiffBlock[] {
    const blocks: DiffBlock[] = [];
    
    // Look for fenced code blocks with diff content
    const fencedBlocks = this.extractFencedDiffBlocks(text);
    blocks.push(...fencedBlocks);
    
    // Look for raw diff content (git diff format)
    const rawDiffBlocks = this.extractRawDiffBlocks(text);
    blocks.push(...rawDiffBlocks);
    
    // Remove duplicates and empty blocks
    return blocks.filter((block, index, array) => {
      if (!block.content.trim()) return false;
      
      // Simple deduplication based on content similarity
      return !array.slice(0, index).some(existing => 
        this.calculateSimilarity(existing.content, block.content) > 0.9
      );
    });
  }

  /**
   * Extract diff blocks from fenced code blocks
   */
  private static extractFencedDiffBlocks(text: string): DiffBlock[] {
    const blocks: DiffBlock[] = [];
    
    // Match ```diff ... ``` or ``` ... ``` blocks that contain diff content
    const fencePattern = /```(?:diff)?\s*\n([\s\S]*?)```/g;
    let match;
    
    while ((match = fencePattern.exec(text)) !== null) {
      const content = match[1];
      
      // Check if content looks like a diff
      if (this.looksLikeDiff(content)) {
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
   * Extract raw diff blocks from text
   */
  private static extractRawDiffBlocks(text: string): DiffBlock[] {
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
   * Check if content looks like a diff
   */
  private static looksLikeDiff(content: string): boolean {
    const diffIndicators = [
      /^diff --git/m,
      /^--- /m,
      /^\+\+\+ /m,
      /^@@ /m,
      /^[+-]/m
    ];
    
    return diffIndicators.some(pattern => pattern.test(content));
  }

  /**
   * Convert diff blocks to edit specification
   */
  private static convertDiffBlocksToEditSpec(blocks: DiffBlock[]): EditSpec | null {
    const ops: Array<UpsertOp | DeleteOp> = [];
    
    for (const block of blocks) {
      try {
        const blockOps = this.parseDiffBlock(block);
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
  private static parseDiffBlock(block: DiffBlock): Array<UpsertOp | DeleteOp> {
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
        const fileContent = this.extractFileContentFromDiff(lines, i + 1, currentFile);
        
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

  /**
   * Extract file content from diff lines
   */
  private static extractFileContentFromDiff(lines: string[], startIndex: number, filename: string): string | null {
    const contentLines: string[] = [];
    
    for (let i = startIndex; i < lines.length; i++) {
      const line = lines[i];
      
      // Stop at next file or end
      if (line.startsWith('diff --git') || line.startsWith('--- a/')) {
        break;
      }
      
      // Process diff line
      if (line.startsWith('+')) {
        // Added line
        contentLines.push(line.substring(1));
      } else if (line.startsWith(' ')) {
        // Context line
        contentLines.push(line.substring(1));
      }
      // Skip deleted lines (start with '-')
    }
    
    return contentLines.length > 0 ? contentLines.join('\n') : null;
  }

  /**
   * Validate edit specification
   */
  static validateEditSpec(spec: EditSpec): { valid: boolean; errors: string[]; warnings: string[] } {
    const errors: string[] = [];
    const warnings: string[] = [];
    
    if (!spec || !spec.ops || !Array.isArray(spec.ops)) {
      errors.push('Edit spec must have ops array');
      return { valid: false, errors, warnings };
    }
    
    if (spec.ops.length === 0) {
      warnings.push('Edit spec has no operations');
    }
    
    for (let i = 0; i < spec.ops.length; i++) {
      const op = spec.ops[i];
      
      if (!op || typeof op !== 'object') {
        errors.push(`Operation ${i} is not an object`);
        continue;
      }
      
      if (!op.action || typeof op.action !== 'string') {
        errors.push(`Operation ${i} missing or invalid action`);
        continue;
      }
      
      if (!op.path || typeof op.path !== 'string') {
        errors.push(`Operation ${i} missing or invalid path`);
        continue;
      }
      
      if (op.action === 'upsert') {
        const upsertOp = op as UpsertOp;
        if (!upsertOp.content && !upsertOp.hunks) {
          errors.push(`Upsert operation ${i} missing content or hunks`);
        }
      } else if (op.action !== 'delete') {
        errors.push(`Operation ${i} has unknown action: ${(op as any).action}`);
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  /**
   * Calculate similarity between two strings (0-1)
   */
  private static calculateSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) {
      return 1.0;
    }
    
    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  /**
   * Calculate Levenshtein distance between two strings
   */
  private static levenshteinDistance(str1: string, str2: string): number {
    const matrix = Array(str2.length + 1).fill(null).map(() => Array(str1.length + 1).fill(null));
    
    for (let i = 0; i <= str1.length; i++) {
      matrix[0][i] = i;
    }
    
    for (let j = 0; j <= str2.length; j++) {
      matrix[j][0] = j;
    }
    
    for (let j = 1; j <= str2.length; j++) {
      for (let i = 1; i <= str1.length; i++) {
        const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
        matrix[j][i] = Math.min(
          matrix[j][i - 1] + 1,     // deletion
          matrix[j - 1][i] + 1,     // insertion
          matrix[j - 1][i - 1] + indicator // substitution
        );
      }
    }
    
    return matrix[str2.length][str1.length];
  }
}