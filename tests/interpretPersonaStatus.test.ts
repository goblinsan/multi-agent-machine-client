import { describe, it, expect } from "vitest";
import {
  interpretPersonaStatus,
  extractJsonPayloadFromText,
} from "../src/agents/persona.js";

describe("extractJsonPayloadFromText - robust JSON extraction", () => {
  it("should extract JSON from code fence", () => {
    const text = '```json\n{"status": "pass"}\n```';
    const result = extractJsonPayloadFromText(text);
    expect(result).toEqual({ status: "pass" });
  });

  it("should extract first complete JSON when prose follows with braces", () => {
    const text =
      '{"status": "pass"}\n\nHandles {edge cases} and {scenarios}.';
    const result = extractJsonPayloadFromText(text);
    expect(result).toEqual({ status: "pass" });
  });

  it("should extract JSON with nested objects correctly", () => {
    const text =
      '{"status": "fail", "details": {"count": 3, "items": [1,2]}}\nMore text.';
    const result = extractJsonPayloadFromText(text);
    expect(result).toEqual({
      status: "fail",
      details: { count: 3, items: [1, 2] },
    });
  });

  it("should return null for truncated JSON", () => {
    const text = '{"status":"fail","test_re';
    const result = extractJsonPayloadFromText(text);
    expect(result).toBeNull();
  });

  it("should handle JSON with escaped quotes in strings", () => {
    const text = '{"message": "He said \\"hello\\"", "status": "pass"}';
    const result = extractJsonPayloadFromText(text);
    expect(result).toEqual({
      message: 'He said "hello"',
      status: "pass",
    });
  });

  it("should strip think tags before extracting", () => {
    const text =
      '<think>Some thinking with {"inner": true}</think>{"status": "pass"}';
    const result = extractJsonPayloadFromText(text);
    expect(result).toEqual({ status: "pass" });
  });

  it("should return null for empty input", () => {
    expect(extractJsonPayloadFromText("")).toBeNull();
    expect(extractJsonPayloadFromText(undefined)).toBeNull();
  });

  it("should fall back to first-to-last brace when depth tracking fails", () => {
    const text = "prefix {invalid json but}\nmore text {\"valid\": true} suffix";
    const result = extractJsonPayloadFromText(text);
    expect(result).toEqual({ valid: true });
  });
});

describe("interpretPersonaStatus - robust status parsing", () => {
  describe("nested output field handling (LM Studio wrapper)", () => {
    it("should extract status from nested output field", () => {
      const response = JSON.stringify({
        output: '{ "status": "pass" }\n\nThe plan looks good.',
        model: "qwen3-coder-30b",
        duration_ms: 10000,
      });

      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
      expect(result.payload).toHaveProperty("status", "pass");
    });

    it('should not be fooled by "fail" in explanatory text when status is pass', () => {
      const response = JSON.stringify({
        output:
          '{ "status": "pass" }\n\nThe proposed implementation plan is concrete, actionable, and appropriate. If the plan were to fail, we would need to revise it. However, this plan demonstrates good understanding.',
        model: "qwen3-coder-30b",
      });

      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });

    it("should handle nested fail status correctly", () => {
      const response = JSON.stringify({
        output:
          '{ "status": "fail", "reason": "Plan missing critical details" }',
        model: "qwen3-coder-30b",
      });

      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("fail");
    });

    it("should handle deeply nested JSON with output field", () => {
      const response = JSON.stringify({
        output: '```json\n{ "status": "pass" }\n```\n\nEvaluation complete.',
        model: "qwen3-coder-30b",
      });

      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });
  });

  describe("direct JSON status handling", () => {
    it("should handle simple JSON with status", () => {
      const response = '{ "status": "pass" }';
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });

    it("should handle JSON with status and details", () => {
      const response =
        '{ "status": "fail", "details": "Missing requirements" }';
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("fail");
    });
  });

  describe("keyword priority (pass over fail)", () => {
    it("should require explicit JSON status, not just keywords in text", () => {
      const response =
        "The tests pass successfully. Previously they would fail, but now they are fixed.";
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("unknown");
    });

    it("should find pass in JSON-like declarations first", () => {
      const response = `
        Some explanation about how the plan could potentially fail in edge cases.
        
        {"status": "pass"}
        
        The plan addresses all concerns.
      `;
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });
  });

  describe("edge cases", () => {
    it("should handle empty string", () => {
      const result = interpretPersonaStatus("");
      expect(result.status).toBe("unknown");
    });

    it("should handle undefined", () => {
      const result = interpretPersonaStatus(undefined);
      expect(result.status).toBe("unknown");
    });

    it("should handle malformed JSON with explicit status pattern", () => {
      const response = "{ status: pass }";
      const result = interpretPersonaStatus(response);

      expect(result.status).toBe("pass");
    });

    it("should handle text with no status indicators", () => {
      const response = "This is a neutral statement with no status.";
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("unknown");
    });
  });

  describe("prose evaluation sentiment detection", () => {
    it("should detect pass from 'plan is acceptable' prose", () => {
      const response =
        "The proposed implementation plan is concrete, actionable, and appropriate for the task.\n\n**Clear Steps:** The plan has clear steps.\n\nOverall, the plan is acceptable, and it can proceed with minor adjustments.";
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });

    it("should detect pass from 'well-structured and provides' prose", () => {
      const response =
        "Overall, the plan is well-structured and provides a clear roadmap for implementing a vitest harness.";
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });

    it("should detect pass from 'can proceed' prose", () => {
      const response =
        "The plan addresses all concerns and can proceed as described.";
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });

    it("should detect fail from 'needs revision' prose", () => {
      const response =
        "The plan needs revision before it can be implemented. Several critical details are missing.";
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("fail");
    });

    it("should detect fail from 'not acceptable' prose", () => {
      const response =
        "The plan is not acceptable in its current form. It must be reworked to address the missing tests.";
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("fail");
    });

    it("should still return unknown for truly neutral prose", () => {
      const response = "This is a neutral statement with no evaluation indicators.";
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("unknown");
    });

    it("should prefer fail phrases over pass phrases", () => {
      const response =
        "The plan is acceptable overall, but it needs revision in several critical areas.";
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("fail");
    });
  });

  describe("real-world LLM response patterns", () => {
    it("should handle verbose LLM response with status in JSON", () => {
      const response = `
        { "status": "pass" }
        
        The proposed implementation plan is concrete, actionable, and appropriate for the task.
        
        Here's why:
        
        1. **Clear Steps**: The plan outlines specific steps to be taken.
        2. **Specific Files to Modify**: The plan identifies files to modify.
        3. **Realistic Acceptance Criteria**: The acceptance criteria are realistic.
        
        If the plan were to fail, we would see missing details or unclear requirements.
        However, this plan demonstrates good understanding of the requirements.
      `;

      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });

    it("should handle LM Studio wrapper with verbose explanation", () => {
      const realResponse = JSON.stringify({
        output:
          '{ "status": "pass" }\n\nThe proposed implementation plan is concrete, actionable, and appropriate for the task.\n\nHere\'s why:\n\n1.  **Clear Steps**: The plan outlines specific steps to be taken, including implementing `src/ingest/fileIngest.ts` and ensuring the UI can render log summaries.\n2.  **Specific Files to Modify**: The plan identifies the primary focus of the current task as `fileIngest.ts`, which is responsible for reading and processing JSON log files.\n3.  **Realistic Acceptance Criteria**: The acceptance criteria are well-defined, including "The UI can render log summaries" and "The UI is visually appealing and user-friendly."\n4.  **Addressing Previous Evaluation Feedback**: Although no previous evaluation feedback is provided in the given context, the plan appears to be self-contained and does not require any additional information from previous evaluations.\n5.  **Focus on Planning Quality**: The plan focuses on planning quality rather than QA results, which aligns with the requirements.\n\nOverall, the proposed implementation plan is well-structured, clear, and actionable, making it an effective approach for completing the task.',
        model: "qwen3-coder-30b",
        duration_ms: 13956,
      });

      const result = interpretPersonaStatus(realResponse);
      expect(result.status).toBe("pass");
    });
  });

  describe("various status keywords", () => {
    it('should recognize "success" as pass', () => {
      const result = interpretPersonaStatus('{ "status": "success" }');
      expect(result.status).toBe("pass");
    });

    it('should recognize "approved" as pass', () => {
      const result = interpretPersonaStatus('{ "status": "approved" }');
      expect(result.status).toBe("pass");
    });

    it('should recognize "rejected" as fail', () => {
      const result = interpretPersonaStatus('{ "status": "rejected" }');
      expect(result.status).toBe("fail");
    });

    it('should recognize "error" as fail', () => {
      const result = interpretPersonaStatus('{ "status": "error" }');
      expect(result.status).toBe("fail");
    });
  });

  describe("status optional personas", () => {
    it("should default to pass when status is optional and content is present", () => {
      const result = interpretPersonaStatus("Context analysis completed", {
        persona: "context",
        statusRequired: false,
      });
      expect(result.status).toBe("pass");
    });

    it("should default to unknown when optional status and response empty", () => {
      const result = interpretPersonaStatus("", {
        persona: "context",
        statusRequired: false,
      });
      expect(result.status).toBe("unknown");
    });

    it("should return fail when optional persona payload includes error field", () => {
      const result = interpretPersonaStatus(
        '{ "error": "Unable to gather context" }',
        { persona: "context", statusRequired: false },
      );
      expect(result.status).toBe("fail");
    });

    it("should honor success boolean in optional payloads", () => {
      const result = interpretPersonaStatus(
        '{ "success": false, "details": "git fetch failed" }',
        { persona: "coordination", statusRequired: false },
      );
      expect(result.status).toBe("fail");
    });
  });

  describe("<think> tag handling (Qwen3.5 models)", () => {
    it("should strip <think> tags and extract JSON status", () => {
      const response =
        '<think>Let me evaluate this plan carefully...</think>{ "status": "pass" }';
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });

    it("should handle <think> tags with braces inside thinking", () => {
      const response =
        '<think>The user wants { "type": "review" } but I need to check</think>{ "status": "fail", "details": "Missing tests" }';
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("fail");
    });

    it("should handle <think> tags with multiline content", () => {
      const response = [
        "<think>",
        "Let me analyze this code carefully.",
        "The implementation looks solid.",
        "</think>",
        '{ "status": "pass", "details": "Code looks good" }',
      ].join("\n");
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });

    it("should handle <think> tags wrapping JSON in code fence", () => {
      const response = [
        "<think>Thinking about this...</think>",
        "```json",
        '{ "status": "pass" }',
        "```",
      ].join("\n");
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });

    it("should extract fail from truncated inner JSON in output wrapper", () => {
      const truncatedLlmOutput = [
        "<think>The vitest harness file appears to have syntax errors.</think>",
        "",
        '{"status":"fail","test_execution_results":{"framework":"vitest","passed":0,"failed":10},"failed_tests":[{"name":"test1","error":"SyntaxError',
      ].join("\n");
      const response = JSON.stringify({
        output: truncatedLlmOutput,
        duration_ms: 35619,
      });
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("fail");
    });
  });

  describe("prose status patterns (non-JSON responses)", () => {
    it("should detect **Evaluation Status:** pass in markdown", () => {
      const response =
        "**Evaluation Status:** pass\n\nThe plan is well-structured.";
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });

    it("should detect Evaluation Status: fail", () => {
      const response =
        "Evaluation Status: fail\n\nThe plan has critical gaps.";
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("fail");
    });

    it("should detect **Status:** pass with markdown bold", () => {
      const response = "**Status:** pass\n\nAll checks satisfied.";
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });

    it("should detect Evaluation status: approved (case-insensitive)", () => {
      const response =
        "Evaluation status: approved\n\nThe implementation meets requirements.";
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });
  });

  describe("truncated and malformed JSON in output wrappers", () => {
    it("should extract fail from security review wrapper with truncated inner JSON", () => {
      const response = JSON.stringify({
        output:
          '{"status":"fail","summary":"Insufficient information","findings":{"severe":[],"high":[],"medium":[{"category":"insecure dependencies","file":"package.json',
        duration_ms: 6327,
      });
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("fail");
    });

    it("should extract pass from wrapper where inner JSON has trailing prose with braces", () => {
      const response = JSON.stringify({
        output:
          '{"status": "pass"}\n\nThe implementation handles all cases including {edge cases} properly.',
        duration_ms: 5000,
      });
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
      expect(result.payload).toHaveProperty("status", "pass");
    });

    it("should extract status when inner JSON is severely truncated mid-key", () => {
      const response = JSON.stringify({
        output: '{"status":"fail","test_re',
        duration_ms: 1000,
      });
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("fail");
    });

    it("should extract status when LLM returns only a status fragment in wrapper", () => {
      const response = JSON.stringify({
        output: '"status": "pass"',
        duration_ms: 500,
      });
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });

    it("should handle wrapper where inner content is pure prose with status keyword", () => {
      const response = JSON.stringify({
        output:
          "**Status:** fail\n\nThe code has critical issues that need to be resolved.",
        duration_ms: 8000,
      });
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("fail");
    });

    it("should handle wrapper with think tags AND truncated JSON", () => {
      const response = JSON.stringify({
        output:
          '<think>Analyzing the code for security vulnerabilities...</think>\n\n{"status":"fail","findings":{"severe":[{"category":"SQL injection","file":"src/db.ts"',
        duration_ms: 12000,
      });
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("fail");
    });
  });

  describe("brace-depth JSON extraction robustness", () => {
    it("should extract first complete JSON when prose follows with braces", () => {
      const response =
        '{"status": "pass"}\n\nThe implementation handles {edge cases} and other {scenarios} well.';
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
      expect(result.payload).toHaveProperty("status", "pass");
    });

    it("should handle JSON with nested objects followed by prose braces", () => {
      const response =
        '{"status": "fail", "details": {"count": 3}}\n\nThe {reviewer} found {issues}.';
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("fail");
    });

    it("should handle response with multiple JSON objects", () => {
      const response =
        '{"status": "pass"}\n\n{"extra": "data", "status": "fail"}';
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe("pass");
    });
  });
});
