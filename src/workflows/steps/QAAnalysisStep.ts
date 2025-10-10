import { WorkflowStep, StepResult, ValidationResult, WorkflowStepConfig } from '../engine/WorkflowStep.js';
import { WorkflowContext } from '../engine/WorkflowContext.js';
import { logger } from '../../logger.js';

interface QAAnalysisConfig {
  /**
   * Source of QA results to analyze
   */
  qaResultsSource?: 'context' | 'input';
  
  /**
   * Whether to perform automated failure categorization
   */
  categorizeFailures?: boolean;
  
  /**
   * Whether to suggest fixes for common failure patterns
   */
  suggestFixes?: boolean;
  
  /**
   * Whether to analyze test coverage implications
   */
  analyzeCoverage?: boolean;
  
  /**
   * Whether to track failure patterns over time
   */
  trackPatterns?: boolean;
  
  /**
   * Custom failure categories to recognize
   */
  customCategories?: Array<{
    name: string;
    patterns: string[];
    severity: 'low' | 'medium' | 'high';
    description: string;
  }>;
  
  /**
   * Maximum number of failure details to analyze
   */
  maxFailuresToAnalyze?: number;
  
  /**
   * Whether to perform root cause analysis
   */
  performRootCauseAnalysis?: boolean;
}

interface QAResults {
  status: 'passed' | 'failed' | 'skipped';
  totalTests: number;
  passedTests: number;
  failedTests: number;
  skippedTests: number;
  coverage?: {
    statements: number;
    branches: number;
    functions: number;
    lines: number;
  };
  failures: Array<{
    testName: string;
    error: string;
    stackTrace?: string;
    file?: string;
    line?: number;
  }>;
  executionTime: number;
  output?: string;
}

interface FailureCategory {
  name: string;
  severity: 'low' | 'medium' | 'high';
  description: string;
  pattern: string;
  count: number;
  examples: string[];
}

interface FailureAnalysis {
  category: string;
  severity: 'low' | 'medium' | 'high';
  rootCause: string;
  suggestedFix: string;
  confidence: number; // 0-1
  pattern: string;
  relatedFailures: string[];
}

interface QAAnalysisResult {
  overallAssessment: {
    status: 'critical' | 'concerning' | 'manageable' | 'good';
    confidence: number;
    summary: string;
  };
  failureCategories: FailureCategory[];
  failureAnalyses: FailureAnalysis[];
  coverageAnalysis?: {
    status: 'excellent' | 'good' | 'adequate' | 'poor';
    recommendations: string[];
    criticalGaps: string[];
  };
  patterns: {
    recurring: string[];
    emerging: string[];
    resolved: string[];
  };
  recommendations: Array<{
    priority: 'high' | 'medium' | 'low';
    action: string;
    rationale: string;
    estimatedEffort: string;
  }>;
  nextActions: string[];
}

export class QAAnalysisStep extends WorkflowStep {
  private static readonly BUILT_IN_CATEGORIES = [
    {
      name: 'Syntax Error',
      patterns: ['SyntaxError', 'syntax error', 'unexpected token', 'missing semicolon'],
      severity: 'high' as const,
      description: 'Code compilation or parsing failures'
    },
    {
      name: 'Type Error',
      patterns: ['TypeError', 'type error', 'undefined is not a function', 'cannot read property'],
      severity: 'high' as const,
      description: 'Runtime type-related errors'
    },
    {
      name: 'Reference Error',
      patterns: ['ReferenceError', 'is not defined', 'undefined variable'],
      severity: 'high' as const,
      description: 'Missing or incorrectly referenced variables/functions'
    },
    {
      name: 'Assertion Failure',
      patterns: ['AssertionError', 'Expected', 'toBe', 'toEqual', 'assert'],
      severity: 'medium' as const,
      description: 'Test expectations not met'
    },
    {
      name: 'Timeout',
      patterns: ['timeout', 'exceeded', 'async', 'promise'],
      severity: 'medium' as const,
      description: 'Tests taking too long to complete'
    },
    {
      name: 'Network Error',
      patterns: ['network', 'connection', 'fetch', 'http', 'ECONNREFUSED'],
      severity: 'low' as const,
      description: 'Network connectivity or API issues'
    },
    {
      name: 'File System Error',
      patterns: ['ENOENT', 'file not found', 'permission denied', 'EACCES'],
      severity: 'medium' as const,
      description: 'File system access or permission issues'
    }
  ];

  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as QAAnalysisConfig;
    const startTime = Date.now();
    
    try {
      logger.info('Starting QA analysis', { stepName: this.config.name });
      
      // Extract QA results
      const qaResults = this.extractQAResults(context, config);
      if (!qaResults) {
        return {
          status: 'failure',
          error: new Error('No QA results found for analysis'),
          metrics: { duration_ms: Date.now() - startTime }
        };
      }
      
      // Perform analysis
      const analysis = this.analyzeQAResults(qaResults, config);
      
      logger.info('QA analysis completed', {
        stepName: this.config.name,
        overallStatus: analysis.overallAssessment.status,
        failureCount: analysis.failureAnalyses.length,
        categoryCount: analysis.failureCategories.length
      });
      
      return {
        status: 'success',
        data: {
          qaResults,
          analysis
        },
        outputs: {
          overallStatus: analysis.overallAssessment.status,
          failureCount: analysis.failureAnalyses.length,
          criticalIssues: analysis.failureAnalyses.filter(f => f.severity === 'high').length,
          recommendations: analysis.recommendations,
          nextActions: analysis.nextActions,
          patterns: analysis.patterns
        },
        metrics: {
          duration_ms: Date.now() - startTime,
          operations_count: analysis.failureAnalyses.length + analysis.failureCategories.length
        }
      };
      
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      logger.error('QA analysis failed', {
        stepName: this.config.name,
        error: errorMessage
      });
      
      return {
        status: 'failure',
        error: new Error(`QA analysis failed: ${errorMessage}`),
        metrics: { duration_ms: Date.now() - startTime }
      };
    }
  }

  protected async validateConfig(context: WorkflowContext): Promise<ValidationResult> {
    const config = this.config.config as QAAnalysisConfig;
    const errors: string[] = [];
    const warnings: string[] = [];
    
    if (config.maxFailuresToAnalyze !== undefined && config.maxFailuresToAnalyze < 1) {
      errors.push('QAAnalysisStep: maxFailuresToAnalyze must be at least 1');
    }
    
    if (config.customCategories) {
      for (const category of config.customCategories) {
        if (!category.name || !category.description) {
          errors.push('QAAnalysisStep: Custom categories must have name and description');
        }
        if (!category.patterns || category.patterns.length === 0) {
          errors.push('QAAnalysisStep: Custom categories must have at least one pattern');
        }
      }
    }
    
    // Check if QA results are available in context
    if (config.qaResultsSource === 'context' || !config.qaResultsSource) {
      const hasQAResults = context.hasStepOutput('qa') || 
                          context.hasStepOutput('test') || 
                          context.hasStepOutput('testing');
      if (!hasQAResults) {
        warnings.push('QAAnalysisStep: No QA results found in context. Step may fail during execution.');
      }
    }
    
    return {
      valid: errors.length === 0,
      errors,
      warnings
    };
  }

  private extractQAResults(context: WorkflowContext, config: QAAnalysisConfig): QAResults | null {
    const source = config.qaResultsSource || 'context';
    
    if (source === 'context') {
      // Look for QA results in context from previous steps
      const stepNames = ['qa', 'test', 'testing', 'quality-assurance'];
      for (const stepName of stepNames) {
        const stepOutput = context.getStepOutput(stepName);
        if (stepOutput?.qaResults || stepOutput?.testResults || stepOutput?.results) {
          return stepOutput.qaResults || stepOutput.testResults || stepOutput.results;
        }
      }
      
      return null;
    } else {
      // For input source, would need additional context setup
      return null;
    }
  }

  private analyzeQAResults(qaResults: QAResults, config: QAAnalysisConfig): QAAnalysisResult {
    const analysis: QAAnalysisResult = {
      overallAssessment: this.assessOverallStatus(qaResults),
      failureCategories: [],
      failureAnalyses: [],
      patterns: { recurring: [], emerging: [], resolved: [] },
      recommendations: [],
      nextActions: []
    };

    // Categorize failures
    if (config.categorizeFailures !== false && qaResults.failures.length > 0) {
      analysis.failureCategories = this.categorizeFailures(qaResults.failures, config);
    }

    // Analyze individual failures
    if (qaResults.failures.length > 0) {
      const maxFailures = config.maxFailuresToAnalyze || 50;
      const failuresToAnalyze = qaResults.failures.slice(0, maxFailures);
      
      analysis.failureAnalyses = failuresToAnalyze.map(failure => 
        this.analyzeFailure(failure, config)
      );
    }

    // Analyze coverage if available
    if (config.analyzeCoverage !== false && qaResults.coverage) {
      analysis.coverageAnalysis = this.analyzeCoverage(qaResults.coverage);
    }

    // Generate recommendations
    analysis.recommendations = this.generateRecommendations(qaResults, analysis, config);
    analysis.nextActions = this.generateNextActions(qaResults, analysis, config);

    return analysis;
  }

  private assessOverallStatus(qaResults: QAResults): QAAnalysisResult['overallAssessment'] {
    const failureRate = qaResults.failedTests / qaResults.totalTests;
    const hasFailures = qaResults.failedTests > 0;
    
    let status: 'critical' | 'concerning' | 'manageable' | 'good';
    let confidence = 0.9;
    let summary: string;

    if (!hasFailures) {
      status = 'good';
      summary = 'All tests are passing successfully';
    } else if (failureRate > 0.5) {
      status = 'critical';
      summary = `High failure rate: ${(failureRate * 100).toFixed(1)}% of tests failing`;
    } else if (failureRate > 0.2) {
      status = 'concerning';
      summary = `Moderate failure rate: ${(failureRate * 100).toFixed(1)}% of tests failing`;
      confidence = 0.8;
    } else {
      status = 'manageable';
      summary = `Low failure rate: ${(failureRate * 100).toFixed(1)}% of tests failing`;
      confidence = 0.85;
    }

    return { status, confidence, summary };
  }

  private categorizeFailures(failures: QAResults['failures'], config: QAAnalysisConfig): FailureCategory[] {
    const categories = new Map<string, FailureCategory>();
    
    // Initialize with built-in categories
    const allCategories = [
      ...QAAnalysisStep.BUILT_IN_CATEGORIES,
      ...(config.customCategories || [])
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

  private analyzeFailure(failure: QAResults['failures'][0], config: QAAnalysisConfig): FailureAnalysis {
    const errorText = failure.error.toLowerCase();
    const analysis: FailureAnalysis = {
      category: 'Unknown',
      severity: 'medium',
      rootCause: 'Analysis needed',
      suggestedFix: 'Manual investigation required',
      confidence: 0.3,
      pattern: 'unknown',
      relatedFailures: []
    };

    // Match against known patterns for detailed analysis
    if (errorText.includes('syntaxerror') || errorText.includes('syntax error')) {
      analysis.category = 'Syntax Error';
      analysis.severity = 'high';
      analysis.rootCause = 'Code syntax is invalid and cannot be parsed';
      analysis.suggestedFix = 'Review code syntax, check for missing brackets, semicolons, or quotes';
      analysis.confidence = 0.9;
      analysis.pattern = 'syntax';
    } else if (errorText.includes('typeerror') || errorText.includes('undefined is not a function')) {
      analysis.category = 'Type Error';
      analysis.severity = 'high';
      analysis.rootCause = 'Attempting to use undefined variable or incorrect type operation';
      analysis.suggestedFix = 'Check variable definitions and type usage';
      analysis.confidence = 0.85;
      analysis.pattern = 'type';
    } else if (errorText.includes('assertionerror') || errorText.includes('expected')) {
      analysis.category = 'Assertion Failure';
      analysis.severity = 'medium';
      analysis.rootCause = 'Test expectation not met - logic or data issue';
      analysis.suggestedFix = 'Review test expectations and implementation logic';
      analysis.confidence = 0.8;
      analysis.pattern = 'assertion';
    } else if (errorText.includes('timeout')) {
      analysis.category = 'Timeout';
      analysis.severity = 'medium';
      analysis.rootCause = 'Operation taking longer than expected to complete';
      analysis.suggestedFix = 'Optimize performance or increase timeout limits';
      analysis.confidence = 0.75;
      analysis.pattern = 'timeout';
    }

    return analysis;
  }

  private analyzeCoverage(coverage: QAResults['coverage']): QAAnalysisResult['coverageAnalysis'] {
    if (!coverage) {
      return {
        status: 'poor',
        recommendations: ['No coverage data available - ensure test coverage reporting is enabled'],
        criticalGaps: ['Missing coverage data prevents quality assessment']
      };
    }

    const avgCoverage = (coverage.statements + coverage.branches + coverage.functions + coverage.lines) / 4;
    
    let status: 'excellent' | 'good' | 'adequate' | 'poor';
    const recommendations: string[] = [];
    const criticalGaps: string[] = [];

    if (avgCoverage >= 90) {
      status = 'excellent';
    } else if (avgCoverage >= 80) {
      status = 'good';
      recommendations.push('Consider increasing coverage to 90%+ for critical components');
    } else if (avgCoverage >= 70) {
      status = 'adequate';
      recommendations.push('Improve test coverage, especially for branches and edge cases');
    } else {
      status = 'poor';
      recommendations.push('Significantly increase test coverage across all metrics');
      criticalGaps.push('Low overall test coverage may hide critical bugs');
    }

    // Specific coverage analysis
    if (coverage.branches < 80) {
      recommendations.push('Add tests for conditional logic and error paths');
      if (coverage.branches < 60) {
        criticalGaps.push('Low branch coverage - many code paths untested');
      }
    }

    if (coverage.functions < 85) {
      recommendations.push('Ensure all functions have dedicated test cases');
    }

    return { status, recommendations, criticalGaps };
  }

  private generateRecommendations(qaResults: QAResults, analysis: QAAnalysisResult, config: QAAnalysisConfig): QAAnalysisResult['recommendations'] {
    const recommendations: QAAnalysisResult['recommendations'] = [];

    // High-priority recommendations based on critical issues
    const criticalFailures = analysis.failureAnalyses.filter(f => f.severity === 'high');
    if (criticalFailures.length > 0) {
      recommendations.push({
        priority: 'high',
        action: 'Fix critical syntax and type errors immediately',
        rationale: `${criticalFailures.length} critical errors are blocking basic functionality`,
        estimatedEffort: '1-2 hours'
      });
    }

    // Medium-priority recommendations
    const failureRate = qaResults.failedTests / qaResults.totalTests;
    if (failureRate > 0.2) {
      recommendations.push({
        priority: 'high',
        action: 'Investigate and fix high failure rate',
        rationale: `${(failureRate * 100).toFixed(1)}% failure rate indicates systematic issues`,
        estimatedEffort: '4-8 hours'
      });
    } else if (failureRate > 0.1) {
      recommendations.push({
        priority: 'medium',
        action: 'Address moderate test failure rate',
        rationale: 'Multiple test failures may indicate design or logic issues',
        estimatedEffort: '2-4 hours'
      });
    }

    // Coverage recommendations
    if (analysis.coverageAnalysis?.status === 'poor') {
      recommendations.push({
        priority: 'medium',
        action: 'Improve test coverage significantly',
        rationale: 'Low coverage increases risk of undetected bugs',
        estimatedEffort: '8-16 hours'
      });
    }

    // Pattern-based recommendations
    const timeoutFailures = analysis.failureAnalyses.filter(f => f.pattern === 'timeout');
    if (timeoutFailures.length > 2) {
      recommendations.push({
        priority: 'medium',
        action: 'Investigate performance bottlenecks',
        rationale: 'Multiple timeout failures suggest performance issues',
        estimatedEffort: '4-6 hours'
      });
    }

    return recommendations;
  }

  private generateNextActions(qaResults: QAResults, analysis: QAAnalysisResult, config: QAAnalysisConfig): string[] {
    const actions: string[] = [];

    if (qaResults.status === 'failed') {
      // Prioritize actions based on severity and count
      const criticalIssues = analysis.failureAnalyses.filter(f => f.severity === 'high').length;
      const mediumIssues = analysis.failureAnalyses.filter(f => f.severity === 'medium').length;

      if (criticalIssues > 0) {
        actions.push(`Fix ${criticalIssues} critical error(s) preventing basic functionality`);
      }

      if (mediumIssues > 5) {
        actions.push('Address systematic issues causing multiple medium-severity failures');
      } else if (mediumIssues > 0) {
        actions.push(`Review and fix ${mediumIssues} medium-severity issue(s)`);
      }

      // Coverage actions
      if (analysis.coverageAnalysis?.criticalGaps.length) {
        actions.push('Add tests for critical uncovered code paths');
      }

      // Pattern-specific actions
      const topCategory = analysis.failureCategories[0];
      if (topCategory && topCategory.count > 1) {
        actions.push(`Focus on ${topCategory.name} issues (${topCategory.count} occurrences)`);
      }
    } else {
      actions.push('All tests passing - consider expanding test coverage or adding edge cases');
    }

    return actions;
  }

  async cleanup(context: WorkflowContext): Promise<void> {
    // No cleanup needed for QA analysis
    logger.debug('QA analysis step cleanup completed', { stepName: this.config.name });
  }
}