import fs from "fs/promises";
import path from "path";

import {
  StepResult,
  ValidationResult,
  WorkflowStep,
} from "../engine/WorkflowStep.js";
import { WorkflowContext } from "../engine/WorkflowContext.js";

type Severity = "severe" | "high" | "medium" | "low";

interface ReviewRule {
  id: string;
  enabled?: boolean;
  severity?: Severity;
  warn_severity?: Severity;
  max_lines?: number;
  warn_lines?: number;
  min_lines?: number;
  include?: string[];
  exclude?: string[];
}

interface ReviewFinding {
  rule_id: string;
  file: string;
  line: number | null;
  issue: string;
  recommendation: string;
}

interface ReviewConfig {
  review_type?: string;
  output_prefix?: string;
  changed_files?: string[];
  rules?: ReviewRule[];
  block_on?: Severity[];
}

const SOURCE_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);

export class DeterministicReviewStep extends WorkflowStep {
  async execute(context: WorkflowContext): Promise<StepResult> {
    const config = (this.config.config || {}) as ReviewConfig;
    const outputPrefix = config.output_prefix || this.config.name || "review";
    const blockOn = new Set<Severity>(config.block_on || ["severe", "high"]);
    const files = this.resolveChangedFiles(config, context);
    const findings = this.emptyFindings();

    for (const rule of config.rules || []) {
      if (rule.enabled === false) continue;
      switch (rule.id) {
        case "file_size":
          await this.runFileSizeRule(context.repoRoot, files, rule, findings);
          break;
        case "method_size":
          await this.runMethodSizeRule(context.repoRoot, files, rule, findings);
          break;
        case "duplicate_code":
          await this.runDuplicateCodeRule(context.repoRoot, files, rule, findings);
          break;
        case "forbidden_comments":
          await this.runForbiddenCommentsRule(context.repoRoot, files, rule, findings);
          break;
        case "conflict_markers":
          await this.runConflictMarkersRule(context.repoRoot, files, rule, findings);
          break;
        case "secret_scan":
          await this.runSecretScanRule(context.repoRoot, files, rule, findings);
          break;
        default:
          findings.low.push({
            rule_id: "unknown_rule",
            file: "",
            line: null,
            issue: `Unknown deterministic review rule '${rule.id}' was ignored.`,
            recommendation: "Remove or implement this review rule.",
          });
      }
    }

    const status = this.hasBlockingFindings(findings, blockOn) ? "fail" : "pass";
    const result = {
      status,
      summary: this.buildSummary(status, findings),
      review_type: config.review_type || "deterministic_review",
      deterministic: true,
      reviewed_files: files,
      findings,
    };

    context.setVariable(`${outputPrefix}_result`, result);
    context.setVariable(`${outputPrefix}_status`, status);

    context.logger.info("Deterministic review completed", {
      stepName: this.config.name,
      outputPrefix,
      status,
      reviewedFiles: files.length,
      findingCount: this.countFindings(findings),
    });

    return {
      status: "success",
      data: result,
      outputs: {
        [`${outputPrefix}_result`]: result,
        [`${outputPrefix}_status`]: status,
        result,
        status,
      },
    } satisfies StepResult;
  }

  protected async validateConfig(
    _context: WorkflowContext,
  ): Promise<ValidationResult> {
    const config = (this.config.config || {}) as ReviewConfig;
    const errors: string[] = [];
    if (config.rules !== undefined && !Array.isArray(config.rules)) {
      errors.push("DeterministicReviewStep: rules must be an array");
    }
    return { valid: errors.length === 0, errors, warnings: [] };
  }

  private resolveChangedFiles(
    config: ReviewConfig,
    context: WorkflowContext,
  ): string[] {
    return Array.from(
      new Set(
        (config.changed_files || context.getVariable("review_diff_files") || [])
          .map((file: any) => String(file || "").trim().replace(/\\/g, "/"))
          .filter((file: string) => file && !file.startsWith(".ma/")),
      ),
    );
  }

  private async runFileSizeRule(
    repoRoot: string,
    files: string[],
    rule: ReviewRule,
    findings: Record<Severity, ReviewFinding[]>,
  ): Promise<void> {
    const maxLines = rule.max_lines ?? 600;
    const warnLines = rule.warn_lines ?? 400;
    for (const file of this.filterSourceFiles(files, rule)) {
      const lines = await this.readLines(repoRoot, file);
      if (!lines) continue;
      if (lines.length >= maxLines) {
        this.addFinding(findings, rule.severity || "high", {
          rule_id: "file_size",
          file,
          line: null,
          issue: `${file} has ${lines.length} lines, exceeding the configured limit of ${maxLines}.`,
          recommendation: "Split this file or move focused behavior into smaller modules.",
        });
      } else if (lines.length >= warnLines) {
        this.addFinding(findings, rule.warn_severity || "medium", {
          rule_id: "file_size",
          file,
          line: null,
          issue: `${file} has ${lines.length} lines, exceeding the configured warning threshold of ${warnLines}.`,
          recommendation: "Plan a follow-up refactor before this file becomes a blocking size violation.",
        });
      }
    }
  }

  private async runMethodSizeRule(
    repoRoot: string,
    files: string[],
    rule: ReviewRule,
    findings: Record<Severity, ReviewFinding[]>,
  ): Promise<void> {
    const maxLines = rule.max_lines ?? 100;
    for (const file of this.filterSourceFiles(files, rule)) {
      const lines = await this.readLines(repoRoot, file);
      if (!lines) continue;
      for (const fn of this.findFunctions(lines)) {
        if (fn.lineCount > maxLines) {
          this.addFinding(findings, rule.severity || "high", {
            rule_id: "method_size",
            file,
            line: fn.startLine,
            issue: `${fn.name} has ${fn.lineCount} lines, exceeding the configured limit of ${maxLines}.`,
            recommendation: "Extract smaller helper functions around distinct responsibilities.",
          });
        }
      }
    }
  }

  private async runDuplicateCodeRule(
    repoRoot: string,
    files: string[],
    rule: ReviewRule,
    findings: Record<Severity, ReviewFinding[]>,
  ): Promise<void> {
    const minLines = rule.min_lines ?? 8;
    const seen = new Map<string, Array<{ file: string; line: number }>>();

    for (const file of this.filterSourceFiles(files, rule)) {
      const lines = await this.readLines(repoRoot, file);
      if (!lines) continue;
      const normalized = lines
        .map((text, index) => ({ text: this.normalizeCodeLine(text), line: index + 1 }))
        .filter((entry) => this.isSignificantDuplicateLine(entry.text));
      for (let index = 0; index <= normalized.length - minLines; index++) {
        const window = normalized.slice(index, index + minLines);
        const key = window.map((entry) => entry.text).join("\n");
        if (!seen.has(key)) seen.set(key, []);
        seen.get(key)!.push({ file, line: window[0].line });
      }
    }

    for (const occurrences of seen.values()) {
      const distinct = this.distinctDuplicateOccurrences(occurrences, minLines);
      if (distinct.length < 2) continue;
      const first = distinct[0];
      const rest = distinct.slice(1, 4).map((o) => `${o.file}:${o.line}`).join(", ");
      this.addFinding(findings, rule.severity || "medium", {
        rule_id: "duplicate_code",
        file: first.file,
        line: first.line,
        issue: `Duplicate ${minLines}-line code block also appears at ${rest}.`,
        recommendation: "Extract the repeated logic or keep only one implementation.",
      });
      return;
    }
  }

  private async runForbiddenCommentsRule(
    repoRoot: string,
    files: string[],
    rule: ReviewRule,
    findings: Record<Severity, ReviewFinding[]>,
  ): Promise<void> {
    for (const file of this.filterSourceFiles(files, rule)) {
      const lines = await this.readLines(repoRoot, file);
      if (!lines) continue;
      const line = lines.findIndex((text) => /^\s*(\/\/|\/\*)/.test(text));
      if (line >= 0) {
        this.addFinding(findings, rule.severity || "medium", {
          rule_id: "forbidden_comments",
          file,
          line: line + 1,
          issue: "Comment text is present in a changed source file.",
          recommendation: "Remove the comment or encode the intent in names and structure.",
        });
      }
    }
  }

  private async runConflictMarkersRule(
    repoRoot: string,
    files: string[],
    rule: ReviewRule,
    findings: Record<Severity, ReviewFinding[]>,
  ): Promise<void> {
    for (const file of files) {
      const lines = await this.readLines(repoRoot, file);
      if (!lines) continue;
      const line = lines.findIndex((text) => /^(<<<<<<<|=======|>>>>>>>)/.test(text));
      if (line >= 0) {
        this.addFinding(findings, rule.severity || "severe", {
          rule_id: "conflict_markers",
          file,
          line: line + 1,
          issue: "Unresolved merge conflict marker found.",
          recommendation: "Resolve the conflict before review can pass.",
        });
      }
    }
  }

  private async runSecretScanRule(
    repoRoot: string,
    files: string[],
    rule: ReviewRule,
    findings: Record<Severity, ReviewFinding[]>,
  ): Promise<void> {
    const severity = rule.severity || "severe";
    for (const file of this.filterSourceFiles(files, rule)) {
      const lines = await this.readLines(repoRoot, file);
      if (!lines) continue;
      for (let i = 0; i < lines.length; i++) {
        const kind = this.detectSecret(lines[i]);
        if (kind) {
          this.addFinding(findings, severity, {
            rule_id: "secret_scan",
            file,
            line: i + 1,
            issue: `Possible hardcoded secret (${kind}).`,
            recommendation:
              "Move secrets to environment variables or a secret store; never commit them.",
          });
        }
      }
    }
  }

  private detectSecret(line: string): string | null {
    const patterns: Array<[string, RegExp]> = [
      ["private-key", /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/],
      ["aws-access-key", /\bAKIA[0-9A-Z]{16}\b/],
      ["github-token", /\bghp_[0-9A-Za-z]{36}\b|\bgithub_pat_[0-9A-Za-z_]{22,}\b/],
      ["slack-token", /\bxox[baprs]-[0-9A-Za-z-]{10,}\b/],
      ["google-api-key", /\bAIza[0-9A-Za-z_-]{35}\b/],
    ];
    for (const [name, re] of patterns) {
      if (re.test(line)) return name;
    }
    const assign = line.match(
      /\b(?:password|passwd|pwd|secret|api[_-]?key|access[_-]?token|auth[_-]?token|client[_-]?secret)\b\s*[:=]\s*["'`]([^"'`]{8,})["'`]/i,
    );
    if (assign && !this.isPlaceholderSecret(assign[1])) {
      return "hardcoded-secret-assignment";
    }
    return null;
  }

  private isPlaceholderSecret(value: string): boolean {
    if (/\$\{|process\.env|import\.meta\.env|<[^>]+>/.test(value)) return true;
    const v = value.toLowerCase();
    const markers = [
      "changeme",
      "change-me",
      "your-",
      "your_",
      "example",
      "placeholder",
      "dummy",
      "fixture",
      "not_a_secret",
      "not-a-secret",
      "sample",
      "redacted",
      "todo",
      "fake",
      "xxxx",
    ];
    return markers.some((m) => v.includes(m));
  }

  private findFunctions(lines: string[]): Array<{ name: string; startLine: number; lineCount: number }> {
    const results: Array<{ name: string; startLine: number; lineCount: number }> = [];
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index];
      const match =
        line.match(/\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/) ||
        line.match(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/) ||
        line.match(/^\s*(?:async\s+)?([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/);
      if (!match || !line.includes("{")) continue;
      const start = index;
      let depth = 0;
      for (; index < lines.length; index++) {
        depth += this.braceDelta(lines[index]);
        if (depth <= 0 && index > start) break;
      }
      results.push({
        name: match[1],
        startLine: start + 1,
        lineCount: index - start + 1,
      });
    }
    return results;
  }

  private braceDelta(line: string): number {
    let delta = 0;
    for (const char of line) {
      if (char === "{") delta++;
      if (char === "}") delta--;
    }
    return delta;
  }

  private async readLines(repoRoot: string, file: string): Promise<string[] | null> {
    try {
      const fullPath = path.join(repoRoot, file);
      const stat = await fs.stat(fullPath);
      if (!stat.isFile()) return null;
      return (await fs.readFile(fullPath, "utf8")).split(/\r?\n/);
    } catch {
      return null;
    }
  }

  private filterSourceFiles(files: string[], rule: ReviewRule): string[] {
    return files.filter((file) => {
      if (!SOURCE_EXTENSIONS.has(path.extname(file))) return false;
      if (rule.include?.length && !rule.include.some((pattern) => file.includes(pattern))) {
        return false;
      }
      if (rule.exclude?.some((pattern) => file.includes(pattern))) {
        return false;
      }
      return true;
    });
  }

  private emptyFindings(): Record<Severity, ReviewFinding[]> {
    return { severe: [], high: [], medium: [], low: [] };
  }

  private addFinding(
    findings: Record<Severity, ReviewFinding[]>,
    severity: Severity,
    finding: ReviewFinding,
  ): void {
    findings[severity].push(finding);
  }

  private hasBlockingFindings(
    findings: Record<Severity, ReviewFinding[]>,
    blockOn: Set<Severity>,
  ): boolean {
    return Array.from(blockOn).some((severity) => findings[severity].length > 0);
  }

  private countFindings(findings: Record<Severity, ReviewFinding[]>): number {
    return Object.values(findings).reduce((sum, list) => sum + list.length, 0);
  }

  private buildSummary(
    status: "pass" | "fail",
    findings: Record<Severity, ReviewFinding[]>,
  ): string {
    const count = this.countFindings(findings);
    if (count === 0) return "Deterministic review passed with no findings.";
    return `Deterministic review ${status} with ${count} finding(s).`;
  }

  private normalizeCodeLine(line: string): string {
    return line.trim().replace(/\s+/g, " ");
  }

  private isSignificantDuplicateLine(line: string): boolean {
    return Boolean(
      line &&
        line !== "{" &&
        line !== "}" &&
        line !== ");" &&
        !line.startsWith("import ") &&
        !line.startsWith("export type "),
    );
  }

  private distinctDuplicateOccurrences(
    occurrences: Array<{ file: string; line: number }>,
    minLines: number,
  ): Array<{ file: string; line: number }> {
    const selected: Array<{ file: string; line: number }> = [];
    for (const occurrence of occurrences) {
      const overlaps = selected.some(
        (existing) =>
          existing.file === occurrence.file &&
          Math.abs(existing.line - occurrence.line) < minLines,
      );
      if (!overlaps) selected.push(occurrence);
    }
    return selected;
  }
}
