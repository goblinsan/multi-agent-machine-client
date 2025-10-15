import { describe, it, expect } from 'vitest'
import { getContextualPrompt, CONTEXT_SPECIFIC_PROMPTS } from '../src/personas.context'

describe('Contextual Persona Prompts', () => {
  describe('getContextualPrompt', () => {
    it('returns planning context prompt for plan-evaluator', () => {
      const prompt = getContextualPrompt('plan-evaluator', 'planning')
      
      expect(prompt).toBeDefined()
      expect(prompt).toContain('implementation plan')
      expect(prompt?.toLowerCase()).toContain('planning quality')
      // Should avoid focusing on QA (but may mention it in context of "not QA")
      expect(prompt?.toLowerCase()).not.toMatch(/\bqa\s+(feedback|test|failure)/i)
    })

    it('returns QA-specific prompt for plan-evaluator in qa-plan context', () => {
      const prompt = getContextualPrompt('plan-evaluator', 'qa-plan')
      
      expect(prompt).toBeDefined()
      expect(prompt).toContain('QA test failures')
      expect(prompt).toContain('QA feedback')
      expect(prompt).not.toContain('planning quality')
    })

    it('returns more lenient revision prompt after multiple iterations', () => {
      const prompt = getContextualPrompt('plan-evaluator', 'revision')
      
      expect(prompt).toBeDefined()
      expect(prompt).toContain('revised multiple times')
      expect(prompt).toContain('more lenient')
    })

    it('returns null for persona without contextual prompts', () => {
      const prompt = getContextualPrompt('unknown-persona', 'planning')
      
      expect(prompt).toBeNull()
    })

    it('falls back to default context if specific context not found', () => {
      const prompt = getContextualPrompt('implementation-planner', 'nonexistent-context')
      
      expect(prompt).toBeDefined()
      expect(prompt).toContain('Plan engineering work')
    })

    it('returns null if persona has no default and context not found', () => {
      // Add a test persona without a default
      const originalPrompts = { ...CONTEXT_SPECIFIC_PROMPTS }
      CONTEXT_SPECIFIC_PROMPTS['test-persona'] = {
        'specific': 'Specific prompt'
      }
      
      const prompt = getContextualPrompt('test-persona', 'nonexistent')
      expect(prompt).toBeNull()
      
      // Restore
      Object.assign(CONTEXT_SPECIFIC_PROMPTS, originalPrompts)
    })
  })

  describe('Prompt content validation', () => {
    it('all plan-evaluator prompts avoid confusion between planning and QA', () => {
      const planningPrompt = CONTEXT_SPECIFIC_PROMPTS['plan-evaluator']['planning']
      const qaPrompt = CONTEXT_SPECIFIC_PROMPTS['plan-evaluator']['qa-plan']
      
      // Planning prompt should not mention QA test results
      expect(planningPrompt.toLowerCase()).not.toContain('qa test')
      expect(planningPrompt.toLowerCase()).not.toContain('test failures')
      
      // QA prompt should explicitly mention QA
      expect(qaPrompt.toLowerCase()).toContain('qa')
      expect(qaPrompt.toLowerCase()).toContain('test')
    })

    it('all prompts include expected JSON response format', () => {
      const evaluatorPrompts = CONTEXT_SPECIFIC_PROMPTS['plan-evaluator']
      
      for (const [context, prompt] of Object.entries(evaluatorPrompts)) {
        expect(prompt).toContain('status')
        expect(prompt).toContain('pass')
        expect(prompt).toContain('fail')
      }
    })

    it('revision prompt is genuinely more lenient', () => {
      const planningPrompt = CONTEXT_SPECIFIC_PROMPTS['plan-evaluator']['planning']
      const revisionPrompt = CONTEXT_SPECIFIC_PROMPTS['plan-evaluator']['revision']
      
      expect(revisionPrompt.toLowerCase()).toContain('lenient')
      expect(revisionPrompt.toLowerCase()).toContain('minimal')
    })
  })

  describe('Implementation-planner contexts', () => {
    it('qa-fix context is more focused than default', () => {
      const defaultPrompt = CONTEXT_SPECIFIC_PROMPTS['implementation-planner']['default']
      const qaFixPrompt = CONTEXT_SPECIFIC_PROMPTS['implementation-planner']['qa-fix']
      
      expect(qaFixPrompt).toContain('QA test failures')
      expect(qaFixPrompt).toContain('ONLY')
      expect(qaFixPrompt.toLowerCase()).toContain('minimal')
      expect(qaFixPrompt.toLowerCase()).toContain('surgical')
      
      // Default should be more general
      expect(defaultPrompt).not.toContain('QA test')
      expect(defaultPrompt).toContain('engineering work')
    })
  })
})
