import { describe, it, expect } from 'vitest';
import { interpretPersonaStatus } from '../src/agents/persona.js';

describe('interpretPersonaStatus - robust status parsing', () => {
  describe('nested output field handling (LM Studio wrapper)', () => {
    it('should extract status from nested output field', () => {
      const response = JSON.stringify({
        output: '{ "status": "pass" }\n\nThe plan looks good.',
        model: 'qwen3-coder-30b',
        duration_ms: 10000
      });
      
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe('pass');
      expect(result.payload).toHaveProperty('status', 'pass');
    });
    
    it('should not be fooled by "fail" in explanatory text when status is pass', () => {
      const response = JSON.stringify({
        output: '{ "status": "pass" }\n\nThe proposed implementation plan is concrete, actionable, and appropriate. If the plan were to fail, we would need to revise it. However, this plan demonstrates good understanding.',
        model: 'qwen3-coder-30b'
      });
      
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe('pass');
    });
    
    it('should handle nested fail status correctly', () => {
      const response = JSON.stringify({
        output: '{ "status": "fail", "reason": "Plan missing critical details" }',
        model: 'qwen3-coder-30b'
      });
      
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe('fail');
    });
    
    it('should handle deeply nested JSON with output field', () => {
      const response = JSON.stringify({
        output: '```json\n{ "status": "pass" }\n```\n\nEvaluation complete.',
        model: 'qwen3-coder-30b'
      });
      
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe('pass');
    });
  });

  describe('direct JSON status handling', () => {
    it('should handle simple JSON with status', () => {
      const response = '{ "status": "pass" }';
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe('pass');
    });
    
    it('should handle JSON with status and details', () => {
      const response = '{ "status": "fail", "details": "Missing requirements" }';
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe('fail');
    });
  });

  describe('keyword priority (pass over fail)', () => {
    it('should prioritize pass when both keywords present', () => {
      const response = 'The tests pass successfully. Previously they would fail, but now they are fixed.';
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe('pass');
    });
    
    it('should find pass in JSON-like declarations first', () => {
      const response = `
        Some explanation about how the plan could potentially fail in edge cases.
        
        {"status": "pass"}
        
        The plan addresses all concerns.
      `;
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe('pass');
    });
  });

  describe('edge cases', () => {
    it('should handle empty string', () => {
      const result = interpretPersonaStatus('');
      expect(result.status).toBe('unknown');
    });
    
    it('should handle undefined', () => {
      const result = interpretPersonaStatus(undefined);
      expect(result.status).toBe('unknown');
    });
    
    it('should handle malformed JSON', () => {
      const response = '{ status: pass }'; // Invalid JSON
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe('pass'); // Should still find keyword
    });
    
    it('should handle text with no status indicators', () => {
      const response = 'This is a neutral statement with no status.';
      const result = interpretPersonaStatus(response);
      expect(result.status).toBe('unknown');
    });
  });

  describe('real-world LLM response patterns', () => {
    it('should handle verbose LLM response with status in JSON', () => {
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
      expect(result.status).toBe('pass');
    });
    
    it('should handle LM Studio wrapper with verbose explanation', () => {
      const realResponse = JSON.stringify({
        output: '{ "status": "pass" }\n\nThe proposed implementation plan is concrete, actionable, and appropriate for the task.\n\nHere\'s why:\n\n1.  **Clear Steps**: The plan outlines specific steps to be taken, including implementing `src/ingest/fileIngest.ts` and ensuring the UI can render log summaries.\n2.  **Specific Files to Modify**: The plan identifies the primary focus of the current task as `fileIngest.ts`, which is responsible for reading and processing JSON log files.\n3.  **Realistic Acceptance Criteria**: The acceptance criteria are well-defined, including "The UI can render log summaries" and "The UI is visually appealing and user-friendly."\n4.  **Addressing Previous Evaluation Feedback**: Although no previous evaluation feedback is provided in the given context, the plan appears to be self-contained and does not require any additional information from previous evaluations.\n5.  **Focus on Planning Quality**: The plan focuses on planning quality rather than QA results, which aligns with the requirements.\n\nOverall, the proposed implementation plan is well-structured, clear, and actionable, making it an effective approach for completing the task.',
        model: 'qwen3-coder-30b',
        duration_ms: 13956
      });
      
      const result = interpretPersonaStatus(realResponse);
      expect(result.status).toBe('pass');
    });
  });

  describe('various status keywords', () => {
    it('should recognize "success" as pass', () => {
      const result = interpretPersonaStatus('{ "status": "success" }');
      expect(result.status).toBe('pass');
    });
    
    it('should recognize "approved" as pass', () => {
      const result = interpretPersonaStatus('{ "status": "approved" }');
      expect(result.status).toBe('pass');
    });
    
    it('should recognize "rejected" as fail', () => {
      const result = interpretPersonaStatus('{ "status": "rejected" }');
      expect(result.status).toBe('fail');
    });
    
    it('should recognize "error" as fail', () => {
      const result = interpretPersonaStatus('{ "status": "error" }');
      expect(result.status).toBe('fail');
    });
  });
});
