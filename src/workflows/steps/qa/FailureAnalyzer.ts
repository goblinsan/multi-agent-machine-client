interface QAFailure {
  testName: string;
  error: string;
  stackTrace?: string;
  file?: string;
  line?: number;
}

export interface FailureAnalysis {
  category: string;
  severity: 'low' | 'medium' | 'high';
  rootCause: string;
  suggestedFix: string;
  confidence: number;
  pattern: string;
  relatedFailures: string[];
}

/**
 * Analyzes individual test failures to determine root cause and suggest fixes
 */
export class FailureAnalyzer {
  /**
   * Analyze a single failure to determine category, root cause, and suggested fix
   */
  analyzeFailure(failure: QAFailure, _performRootCauseAnalysis: boolean = true): FailureAnalysis {
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
    } else if (errorText.includes('referenceerror') || errorText.includes('is not defined')) {
      analysis.category = 'Reference Error';
      analysis.severity = 'high';
      analysis.rootCause = 'Undefined variable or function reference';
      analysis.suggestedFix = 'Ensure all variables and functions are properly defined before use';
      analysis.confidence = 0.88;
      analysis.pattern = 'reference';
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
    } else if (errorText.includes('econnrefused') || errorText.includes('network') || errorText.includes('fetch failed')) {
      analysis.category = 'Network Error';
      analysis.severity = 'medium';
      analysis.rootCause = 'Network connectivity or external service unavailable';
      analysis.suggestedFix = 'Check network connectivity, mock external services in tests';
      analysis.confidence = 0.82;
      analysis.pattern = 'network';
    } else if (errorText.includes('mock') || errorText.includes('stub') || errorText.includes('spy')) {
      analysis.category = 'Mock Error';
      analysis.severity = 'low';
      analysis.rootCause = 'Test mocking setup issue';
      analysis.suggestedFix = 'Review mock/stub configuration and expectations';
      analysis.confidence = 0.78;
      analysis.pattern = 'mock';
    }

    return analysis;
  }

  /**
   * Analyze multiple failures and find common patterns
   */
  analyzeFailures(failures: QAFailure[], maxFailures: number = 50): FailureAnalysis[] {
    const failuresToAnalyze = failures.slice(0, maxFailures);
    return failuresToAnalyze.map(failure => this.analyzeFailure(failure));
  }
}
