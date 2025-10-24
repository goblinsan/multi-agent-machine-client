interface QAFailure {
  testName: string;
  error: string;
  stackTrace?: string;
  file?: string;
  line?: number;
}

interface CategoryDefinition {
  name: string;
  patterns: string[];
  severity: 'low' | 'medium' | 'high';
  description: string;
}

export interface FailureCategory {
  name: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  pattern: string;
  count: number;
  examples: string[];
}

/**
 * Categorizes test failures based on error patterns
 */
export class FailureCategorizer {
  private static readonly BUILT_IN_CATEGORIES: CategoryDefinition[] = [
    {
      name: 'Syntax Error',
      patterns: ['SyntaxError', 'syntax error', 'unexpected token', 'missing semicolon'],
      severity: 'high',
      description: 'Code compilation or parsing failures'
    },
    {
      name: 'Type Error',
      patterns: ['TypeError', 'type error', 'undefined is not a function', 'cannot read property'],
      severity: 'high',
      description: 'Runtime type-related errors'
    },
    {
      name: 'Reference Error',
      patterns: ['ReferenceError', 'is not defined', 'undefined variable'],
      severity: 'high',
      description: 'Missing or incorrectly referenced variables/functions'
    },
    {
      name: 'Assertion Failure',
      patterns: ['AssertionError', 'Expected', 'toBe', 'toEqual', 'assert'],
      severity: 'medium',
      description: 'Test expectations not met'
    },
    {
      name: 'Timeout',
      patterns: ['timeout', 'exceeded', 'async', 'promise'],
      severity: 'medium',
      description: 'Tests taking too long to complete'
    },
    {
      name: 'Network Error',
      patterns: ['ECONNREFUSED', 'ETIMEDOUT', 'network', 'fetch failed', 'connection'],
      severity: 'medium',
      description: 'Network connectivity or API issues'
    },
    {
      name: 'Mock Error',
      patterns: ['mock', 'stub', 'spy', 'not called', 'called with'],
      severity: 'low',
      description: 'Test mocking or stubbing issues'
    }
  ];

  /**
   * Categorize failures based on error patterns
   */
  categorizeFailures(failures: QAFailure[], customCategories?: CategoryDefinition[]): FailureCategory[] {
    const categories = new Map<string, FailureCategory>();
    
    // Initialize with built-in categories
    const allCategories = [
      ...FailureCategorizer.BUILT_IN_CATEGORIES,
      ...(customCategories || [])
    ];

    for (const failure of failures) {
      const errorText = `${failure.error} ${failure.stackTrace || ''}`.toLowerCase();
      let categorized = false;

      for (const categoryDef of allCategories) {
        const matchesPattern = categoryDef.patterns.some(pattern =>
          errorText.includes(pattern.toLowerCase())
        );

        if (matchesPattern) {
          const categoryName = categoryDef.name;
          if (!categories.has(categoryName)) {
            categories.set(categoryName, {
              name: categoryName,
              severity: categoryDef.severity,
              description: categoryDef.description,
              pattern: categoryDef.patterns[0],
              count: 0,
              examples: []
            });
          }

          const category = categories.get(categoryName)!;
          category.count++;
          if (category.examples.length < 3) {
            category.examples.push(failure.testName);
          }
          categorized = true;
          break;
        }
      }

      // Create "Other" category for uncategorized failures
      if (!categorized) {
        if (!categories.has('Other')) {
          categories.set('Other', {
            name: 'Other',
            severity: 'medium',
            description: 'Failures that don\'t match known patterns',
            pattern: 'unknown',
            count: 0,
            examples: []
          });
        }
        const otherCategory = categories.get('Other')!;
        otherCategory.count++;
        if (otherCategory.examples.length < 3) {
          otherCategory.examples.push(failure.testName);
        }
      }
    }

    return Array.from(categories.values()).sort((a, b) => b.count - a.count);
  }

  /**
   * Get built-in category definitions
   */
  static getBuiltInCategories(): CategoryDefinition[] {
    return [...FailureCategorizer.BUILT_IN_CATEGORIES];
  }
}
