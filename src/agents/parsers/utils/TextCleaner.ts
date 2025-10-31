/**
 * TextCleaner - Preprocesses persona responses for diff parsing
 * 
 * Responsibilities:
 * - Normalize line endings
 * - Remove markdown formatting
 * - Clean up HTML tags
 */

/**
 * Clean up response text for better parsing
 */
export function cleanResponse(response: string): string {
  // Remove extra whitespace and normalize line endings
  let cleaned = response.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  
  // Remove markdown formatting that might interfere
  cleaned = cleaned.replace(/^\s*`{3,}[a-zA-Z]*\s*$/gm, '```');
  
  // Remove HTML tags that might wrap diffs
  cleaned = cleaned.replace(/<\/?pre[^>]*>/gi, '');
  cleaned = cleaned.replace(/<\/?code[^>]*>/gi, '');
  
  return cleaned;
}
