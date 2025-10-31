/**
 * DiffParser - Main facade for diff parsing operations
 * 
 * This module serves as the facade for diff parsing functionality.
 * It exports the primary entry points and types used throughout the application:
 * - parsePersonaResponse: Parse persona responses and extract diffs
 * - validateEditSpec: Validate edit specifications
 * - DiffBlock, DiffParseResult: Type definitions
 * 
 * All diff parsing logic has been extracted into focused modules:
 * - utils/TextCleaner: Text preprocessing
 * - utils/StringUtils: String similarity and Levenshtein distance
 * - extraction/BlockExtractor: Extract diff blocks from text
 * - extraction/ContentExtractor: Extract file content from diffs
 * - conversion/DiffConverter: Convert diffs to edit operations
 * - validation/EditSpecValidator: Validate edit specifications
 */

import type { EditSpec } from '../../fileops.js';
import { cleanResponse } from './utils/TextCleaner.js';
import { extractDiffBlocks } from './extraction/BlockExtractor.js';
import { convertDiffBlocksToEditSpec } from './conversion/DiffConverter.js';
import { validateEditSpec as validateEditSpecImpl } from './validation/EditSpecValidator.js';

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
  /**
   * Parse persona response and extract diff blocks
   */
  static parsePersonaResponse(response: string): DiffParseResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let diffBlocks: DiffBlock[] = [];

    try {
      // Clean up the response
      const cleanedResponse = cleanResponse(response);
      
      // Extract diff blocks
      diffBlocks = extractDiffBlocks(cleanedResponse);
      
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
      const editSpec = convertDiffBlocksToEditSpec(diffBlocks);
      
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
      const validation = validateEditSpecImpl(editSpec);
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
   * Validate edit specification
   */
  static validateEditSpec(spec: EditSpec): { valid: boolean; errors: string[]; warnings: string[] } {
    return validateEditSpecImpl(spec);
  }
}