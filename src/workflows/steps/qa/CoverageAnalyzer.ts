interface CoverageMetrics {
  statements: number;
  branches: number;
  functions: number;
  lines: number;
}

export interface CoverageAnalysisResult {
  status: 'excellent' | 'good' | 'adequate' | 'poor';
  recommendations: string[];
  criticalGaps: string[];
}

/**
 * Analyzes test coverage metrics and provides recommendations
 */
export class CoverageAnalyzer {
  /**
   * Analyze coverage metrics and generate recommendations
   */
  analyzeCoverage(coverage: CoverageMetrics | undefined): CoverageAnalysisResult {
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

    // Overall coverage assessment
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

    if (coverage.statements < 85) {
      recommendations.push('Increase statement coverage by testing more execution paths');
    }

    if (coverage.lines < 85) {
      recommendations.push('Add tests for uncovered lines of code');
    }

    return { status, recommendations, criticalGaps };
  }
}
