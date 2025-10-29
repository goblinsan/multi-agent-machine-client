import { describe, it, expect } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';

describe('Workflow Conditional Context Optimization', () => {
  it('should have condition to skip context_request when context is reused', async () => {
    const workflowPath = path.join(process.cwd(), 'src', 'workflows', 'definitions', 'task-flow.yaml');
    const workflowContent = await fs.readFile(workflowPath, 'utf-8');

    // Find the context_request step
    const contextRequestMatch = workflowContent.match(/- name: context_request[\s\S]*?(?=\n {2}- name:|$)/);
    expect(contextRequestMatch).toBeDefined();
    
    const contextRequestStep = contextRequestMatch![0];

    // CRITICAL: Must have condition to skip when context is reused
    expect(contextRequestStep).toContain('condition:');
    expect(contextRequestStep).toMatch(/condition:.*context_scan\.reused_existing.*!=\s+true/);
    
    // CRITICAL: Should be PersonaRequestStep (LLM call)
    expect(contextRequestStep).toContain('type: PersonaRequestStep');
    expect(contextRequestStep).toContain('persona: "context"');
  });

  it('should document why context_request is conditional', async () => {
    const workflowPath = path.join(process.cwd(), 'src', 'workflows', 'definitions', 'task-flow.yaml');
    const workflowContent = await fs.readFile(workflowPath, 'utf-8');

    // Find the context_request step and its comments
    const contextRequestSection = workflowContent.match(/# Context analysis[\s\S]*?- name: context_request[\s\S]*?type: PersonaRequestStep/);
    expect(contextRequestSection).toBeDefined();

    // Should have comment explaining the optimization
    const section = contextRequestSection![0];
    expect(section).toMatch(/Skip.*LLM|reusing.*context|NOT.*reused/i);
  });

  it('should pass reused_existing flag to context persona payload', async () => {
    const workflowPath = path.join(process.cwd(), 'src', 'workflows', 'definitions', 'task-flow.yaml');
    const workflowContent = await fs.readFile(workflowPath, 'utf-8');

    // Find the context_request payload
    const payloadMatch = workflowContent.match(/- name: context_request[\s\S]*?payload:([\s\S]*?)(?=\n {2}- name:|$)/);
    expect(payloadMatch).toBeDefined();

    const payload = payloadMatch![0];
    
    // CRITICAL: Must pass reused_existing flag to persona
    expect(payload).toContain('reused_existing:');
    expect(payload).toMatch(/reused_existing:.*context_scan\.reused_existing/);
  });
});
