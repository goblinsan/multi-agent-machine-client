import { describe, it, expect, beforeEach } from 'vitest';
import { templateLoader } from '../src/workflows/engine/TemplateLoader.js';

describe('TemplateLoader', () => {
  beforeEach(() => {
    templateLoader.load();
  });

  it('loads templates from YAML file', () => {
    expect(templateLoader.hasTemplate('context_analysis')).toBe(true);
    expect(templateLoader.hasTemplate('implementation')).toBe(true);
    expect(templateLoader.hasTemplate('qa_review')).toBe(true);
    expect(templateLoader.hasTemplate('code_review')).toBe(true);
    expect(templateLoader.hasTemplate('security_review')).toBe(true);
    expect(templateLoader.hasTemplate('devops_review')).toBe(true);
  });

  it('expands template with correct structure', () => {
    const expanded = templateLoader.expandTemplate('code_review', 'test_code_review');
    
    expect(expanded.name).toBe('test_code_review');
    expect(expanded.type).toBe('PersonaRequestStep');
    expect(expanded.config!.persona).toBe('code-reviewer');
    expect(expanded.config!.intent).toBe('code_review');
    expect(expanded.config!.payload.task).toBe('${task}');
  });

  it('merges overrides correctly', () => {
    const expanded = templateLoader.expandTemplate('code_review', 'test_code_review', {
      config: {
        payload: {
          resume_review: true
        }
      }
    });
    
    expect(expanded.config!.payload.resume_review).toBe(true);
    expect(expanded.config!.payload.task).toBe('${task}');
  });

  it('throws error for non-existent template', () => {
    expect(() => templateLoader.expandTemplate('nonexistent', 'test')).toThrow('Template not found: nonexistent');
  });

  it('ensures task is passed without quotes', () => {
    const templates = ['context_analysis', 'implementation', 'qa_review', 'code_review', 'security_review', 'devops_review'];
    
    for (const templateName of templates) {
      const template = templateLoader.getTemplate(templateName);
      expect(template).toBeDefined();
      expect(template!.config.payload.task).toBe('${task}');
      expect(template!.config.payload.task).not.toContain('"');
    }
  });
});
