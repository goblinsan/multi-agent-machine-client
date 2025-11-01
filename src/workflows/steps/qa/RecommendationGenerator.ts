import type { FailureCategory } from './FailureCategorizer';
import type { FailureAnalysis } from './FailureAnalyzer';
import type { CoverageAnalysisResult } from './CoverageAnalyzer';

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

interface QAAnalysisResult {
  overallAssessment: {
    status: 'critical' | 'concerning' | 'manageable' | 'good';
    confidence: number;
    summary: string;
  };
  failureCategories: FailureCategory[];
  failureAnalyses: FailureAnalysis[];
  coverageAnalysis?: CoverageAnalysisResult;
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


export class RecommendationGenerator {
  
  generateRecommendations(qaResults: QAResults, analysis: QAAnalysisResult): QAAnalysisResult['recommendations'] {
    const recommendations: QAAnalysisResult['recommendations'] = [];

    
    const criticalFailures = analysis.failureAnalyses.filter(f => f.severity === 'high');
    if (criticalFailures.length > 0) {
      recommendations.push({
        priority: 'high',
        action: 'Fix critical syntax and type errors immediately',
        rationale: `${criticalFailures.length} critical errors are blocking basic functionality`,
        estimatedEffort: '1-2 hours'
      });
    }

    
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

    
    if (analysis.coverageAnalysis?.status === 'poor') {
      recommendations.push({
        priority: 'medium',
        action: 'Improve test coverage significantly',
        rationale: 'Low coverage increases risk of undetected bugs',
        estimatedEffort: '8-16 hours'
      });
    }

    
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

  
  generateNextActions(qaResults: QAResults, analysis: QAAnalysisResult): string[] {
    const actions: string[] = [];

    if (qaResults.status === 'failed') {
      
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

      
      if (analysis.coverageAnalysis?.criticalGaps.length) {
        actions.push('Add tests for critical uncovered code paths');
      }

      
      const topCategory = analysis.failureCategories[0];
      if (topCategory && topCategory.count > 1) {
        actions.push(`Focus on ${topCategory.name} issues (${topCategory.count} occurrences)`);
      }
    } else {
      actions.push('All tests passing - consider expanding test coverage or adding edge cases');
    }

    return actions;
  }

  
  assessOverallStatus(qaResults: QAResults): QAAnalysisResult['overallAssessment'] {
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
}
