/**
 * Text Normalization Utilities
 * 
 * Provides functions for normalizing and analyzing text for comparison purposes.
 * Used by duplicate detection, task matching, and similar text analysis features.
 */

/**
 * Normalize a title for comparison
 * Removes emojis, brackets, urgency markers, and normalizes whitespace
 * 
 * @param title - The title to normalize
 * @returns Normalized lowercase title
 * 
 * @example
 * normalizeTitle("🚨 URGENT [QA] Fix test failures")
 * // Returns: "fix test failures"
 */
export function normalizeTitle(title: string): string {
  if (!title) return '';
  
  return title
    .toLowerCase()
    .replace(/🚨|📋|⚠️|✅|❌|✓|⚡|🔥/g, '')  // Remove common emojis
    .replace(/\[.*?\]/g, '')                 // Remove [Code Review] etc
    .replace(/\(.*?\)/g, '')                 // Remove (parenthetical) notes
    .replace(/urgent/gi, '')                 // Remove urgent markers
    .replace(/\s+/g, ' ')                    // Normalize whitespace
    .trim();
}

/**
 * Extract key phrases (significant words) from text
 * Returns a set of words meeting the minimum length threshold
 * 
 * @param text - The text to analyze
 * @param minLength - Minimum word length (default: 5)
 * @returns Set of lowercase key phrases
 * 
 * @example
 * extractKeyPhrases("Fix the authentication module")
 * // Returns: Set(["authentication", "module"])
 */
export function extractKeyPhrases(text: string, minLength = 5): Set<string> {
  if (!text) return new Set();
  
  const regex = new RegExp(`\\b\\w{${minLength},}\\b`, 'g');
  const matches = text.toLowerCase().match(regex) || [];
  
  return new Set(matches);
}

/**
 * Calculate the percentage overlap between two sets of text phrases
 * Used for fuzzy matching and duplicate detection
 * 
 * @param text1 - First text to compare
 * @param text2 - Second text to compare
 * @param minLength - Minimum word length for phrase extraction (default: 5)
 * @returns Overlap percentage (0-100) based on phrase intersection
 * 
 * @example
 * calculateOverlapPercentage("Fix authentication bug", "Resolve authentication issue")
 * // Returns: 100 (both contain "authentication")
 */
export function calculateOverlapPercentage(
  text1: string,
  text2: string,
  minLength = 5
): number {
  const phrases1 = extractKeyPhrases(text1, minLength);
  const phrases2 = extractKeyPhrases(text2, minLength);
  
  if (phrases1.size === 0) return 0;
  
  let intersection = 0;
  phrases1.forEach(phrase => {
    if (phrases2.has(phrase)) intersection++;
  });
  
  return (intersection / phrases1.size) * 100;
}

/**
 * Remove common prefixes from titles for cleaner comparison
 * Removes patterns like "Fix:", "Update:", "Add:", etc.
 * 
 * @param title - The title to clean
 * @returns Title with common prefixes removed
 * 
 * @example
 * removeCommonPrefixes("Fix: Authentication bug")
 * // Returns: "Authentication bug"
 */
export function removeCommonPrefixes(title: string): string {
  if (!title) return '';
  
  return title
    .replace(/^(fix|update|add|remove|delete|create|implement|refactor|improve):\s*/i, '')
    .trim();
}

/**
 * Extract significant words from text (alias for extractKeyPhrases with minLength=3)
 * Less restrictive than extractKeyPhrases for broader matching
 * 
 * @param text - The text to analyze
 * @returns Set of lowercase significant words
 */
export function extractSignificantWords(text: string): Set<string> {
  return extractKeyPhrases(text, 3);
}
