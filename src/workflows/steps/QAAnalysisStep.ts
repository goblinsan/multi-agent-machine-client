import {
  WorkflowStep,
  StepResult,
  ValidationResult,
  WorkflowStepConfig,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";
import { logger } from "../../logger.js";
import { FailureCategorizer } from "./qa/FailureCategorizer.js";
import { FailureAnalyzer } from "./qa/FailureAnalyzer.js";
import { CoverageAnalyzer } from "./qa/CoverageAnalyzer.js";
import { RecommendationGenerator } from "./qa/RecommendationGenerator.js";
import type { FailureCategory } from "./qa/FailureCategorizer.js";
import type { FailureAnalysis } from "./qa/FailureAnalyzer.js";
import type { CoverageAnalysisResult } from "./qa/CoverageAnalyzer.js";

interface QAAnalysisConfig {
  qaResultsSource?: "context" | "input";

  categorizeFailures?: boolean;

  suggestFixes?: boolean;

  analyzeCoverage?: boolean;

  trackPatterns?: boolean;

  customCategories?: Array<{
    name: string;
    patterns: string[];
    severity: "low" | "medium" | "high";
    description: string;
  }>;

  maxFailuresToAnalyze?: number;

  performRootCauseAnalysis?: boolean;
}

interface QAResults {
  status: "passed" | "failed" | "skipped";
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
    status: "critical" | "concerning" | "manageable" | "good";
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
    priority: "high" | "medium" | "low";
    action: string;
    rationale: string;
    estimatedEffort: string;
  }>;
  nextActions: string[];
}

export class QAAnalysisStep extends WorkflowStep {
  private failureCategorizer: FailureCategorizer;
  private failureAnalyzer: FailureAnalyzer;
  private coverageAnalyzer: CoverageAnalyzer;
  private recommendationGenerator: RecommendationGenerator;

  constructor(config: WorkflowStepConfig) {
    super(config);
    this.failureCategorizer = new FailureCategorizer();
    this.failureAnalyzer = new FailureAnalyzer();
    this.coverageAnalyzer = new CoverageAnalyzer();
    this.recommendationGenerator = new RecommendationGenerator();
  }

  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = this.config.config as QAAnalysisConfig;
    const startTime = Date.now();

    try {
      logger.info("Starting QA analysis", { stepName: this.config.name });

      const qaResults = this.extractQAResults(context, config);
      if (!qaResults) {
        return {
          status: "failure",
          error: new Error("No QA results found for analysis"),
          metrics: { duration_ms: Date.now() - startTime },
        };
      }

      const analysis = this.analyzeQAResults(qaResults, config);

      logger.info("QA analysis completed", {
        stepName: this.config.name,
        overallStatus: analysis.overallAssessment.status,
        failureCount: analysis.failureAnalyses.length,
        categoryCount: analysis.failureCategories.length,
      });

      return {
        status: "success",
        data: {
          qaResults,
          analysis,
        },
        outputs: {
          overallStatus: analysis.overallAssessment.status,
          failureCount: analysis.failureAnalyses.length,
          criticalIssues: analysis.failureAnalyses.filter(
            (f) => f.severity === "high",
          ).length,
          recommendations: analysis.recommendations,
          nextActions: analysis.nextActions,
          patterns: analysis.patterns,
        },
        metrics: {
          duration_ms: Date.now() - startTime,
          operations_count:
            analysis.failureAnalyses.length + analysis.failureCategories.length,
        },
      };
    } catch (error) {
      const errorMessage =
        error instanceof Error ? error.message : "Unknown error";
      logger.error("QA analysis failed", {
        stepName: this.config.name,
        error: errorMessage,
      });

      return {
        status: "failure",
        error: new Error(`QA analysis failed: ${errorMessage}`),
        metrics: { duration_ms: Date.now() - startTime },
      };
    }
  }

  protected async validateConfig(
    context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = this.config.config as QAAnalysisConfig;
    const errors: string[] = [];
    const warnings: string[] = [];

    if (
      config.maxFailuresToAnalyze !== undefined &&
      config.maxFailuresToAnalyze < 1
    ) {
      errors.push("QAAnalysisStep: maxFailuresToAnalyze must be at least 1");
    }

    if (config.customCategories) {
      for (const category of config.customCategories) {
        if (!category.name || !category.description) {
          errors.push(
            "QAAnalysisStep: Custom categories must have name and description",
          );
        }
        if (!category.patterns || category.patterns.length === 0) {
          errors.push(
            "QAAnalysisStep: Custom categories must have at least one pattern",
          );
        }
      }
    }

    if (config.qaResultsSource === "context" || !config.qaResultsSource) {
      const hasQAResults =
        context.hasStepOutput("qa") ||
        context.hasStepOutput("test") ||
        context.hasStepOutput("testing");
      if (!hasQAResults) {
        warnings.push(
          "QAAnalysisStep: No QA results found in context. Step may fail during execution.",
        );
      }
    }

    return {
      valid: errors.length === 0,
      errors,
      warnings,
    };
  }

  private extractQAResults(
    context: WorkflowContext,
    config: QAAnalysisConfig,
  ): QAResults | null {
    const source = config.qaResultsSource || "context";

    if (source === "context") {
      const stepNames = ["qa", "test", "testing", "quality-assurance"];
      for (const stepName of stepNames) {
        const stepOutput = context.getStepOutput(stepName);
        if (
          stepOutput?.qaResults ||
          stepOutput?.testResults ||
          stepOutput?.results
        ) {
          return (
            stepOutput.qaResults || stepOutput.testResults || stepOutput.results
          );
        }
      }

      return null;
    } else {
      return null;
    }
  }

  private analyzeQAResults(
    qaResults: QAResults,
    config: QAAnalysisConfig,
  ): QAAnalysisResult {
    const analysis: QAAnalysisResult = {
      overallAssessment:
        this.recommendationGenerator.assessOverallStatus(qaResults),
      failureCategories: [],
      failureAnalyses: [],
      patterns: { recurring: [], emerging: [], resolved: [] },
      recommendations: [],
      nextActions: [],
    };

    if (config.categorizeFailures !== false && qaResults.failures.length > 0) {
      analysis.failureCategories = this.failureCategorizer.categorizeFailures(
        qaResults.failures,
        config.customCategories,
      );
    }

    if (qaResults.failures.length > 0) {
      const maxFailures = config.maxFailuresToAnalyze || 50;
      analysis.failureAnalyses = this.failureAnalyzer.analyzeFailures(
        qaResults.failures,
        maxFailures,
      );
    }

    if (config.analyzeCoverage !== false && qaResults.coverage) {
      analysis.coverageAnalysis = this.coverageAnalyzer.analyzeCoverage(
        qaResults.coverage,
      );
    }

    analysis.recommendations =
      this.recommendationGenerator.generateRecommendations(qaResults, analysis);
    analysis.nextActions = this.recommendationGenerator.generateNextActions(
      qaResults,
      analysis,
    );

    return analysis;
  }

  async cleanup(_context: WorkflowContext): Promise<void> {
    logger.debug("QA analysis step cleanup completed", {
      stepName: this.config.name,
    });
  }
}
