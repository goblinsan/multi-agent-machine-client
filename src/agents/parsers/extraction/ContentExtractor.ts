/**
 * ContentExtractor - Extracts file content from diff hunks
 * 
 * Responsibilities:
 * - Parse diff lines to extract new file content
 * - Handle added lines (+)
 * - Handle context lines (space)
 * - Skip deleted lines (-)
 */

/**
 * Extract file content from diff lines starting at a given index
 * Reconstructs the new file content from diff hunks
 */
export function extractFileContentFromDiff(lines: string[], startIndex: number, _filename: string): string | null {
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
