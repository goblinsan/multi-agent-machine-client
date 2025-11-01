

import type { EditSpec } from '../../fileops.js';
import { cleanResponse } from './utils/TextCleaner.js';
import { extractDiffBlocks } from './extraction/BlockExtractor.js';
import { convertDiffBlocksToEditSpec } from './conversion/DiffConverter.js';
import { validateEditSpec as validateEditSpecImpl } from './validation/EditSpecValidator.js';


export interface DiffBlock {
  filename?: string;
  content: string;
  type: 'unified' | 'context' | 'raw';
  startMarker?: string;
  endMarker?: string;
}


export interface DiffParseResult {
  success: boolean;
  editSpec?: EditSpec;
  diffBlocks: DiffBlock[];
  errors: string[];
  warnings: string[];
}


export class DiffParser {
  
  static parsePersonaResponse(response: string): DiffParseResult {
    const errors: string[] = [];
    const warnings: string[] = [];
    let diffBlocks: DiffBlock[] = [];

    try {
      
      const cleanedResponse = cleanResponse(response);
      
      
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

  
  static validateEditSpec(spec: EditSpec): { valid: boolean; errors: string[]; warnings: string[] } {
    return validateEditSpecImpl(spec);
  }
}