import fs from 'fs';
import path from 'path';

export const sent: any[] = [];

export function isCaptureEnabled(): boolean {
  const v = String(process.env.TEST_CAPTURE_PROMPTS || '').toLowerCase();
  return v === '1' || v === 'true';
}

export function suppressConsoleDuringCapture(): () => void {
  if (!isCaptureEnabled()) return () => {};
  const _orig = {
    log: console.log,
    info: console.info,
    warn: console.warn,
    error: console.error,
    debug: (console as any).debug,
  } as any;
  
  (console as any).log = () => {};
  (console as any).info = () => {};
  (console as any).warn = () => {};
  (console as any).error = () => {};
  (console as any).debug = () => {};
  return () => {
    try {
      console.log = _orig.log;
      console.info = _orig.info;
      console.warn = _orig.warn;
      console.error = _orig.error;
      (console as any).debug = _orig.debug;
    } catch (e) {
      console.error('Failed to restore console:', e);
    }
  };
}

export function annotateCaptured(s: any[]) {
  const stepRole: Record<string, string> = {
    '1-context': 'Hydrate project context',
    '2-plan': 'Implementation planning (planner)',
    '2-implementation': 'Lead implementation (engineer)',
    '3-qa': 'QA test run',
    'qa-created-tasks': 'QA follow-up - created tasks (after summarizer/create)',
    '4-implementation-plan': 'Implementation planning for QA follow-ups'
  };
  return s.map((req) => {
    return {
      step: req.step || 'unknown',
      role: stepRole[req.step] || 'Workflow step',
      toPersona: req.toPersona || req.to || 'unknown',
      corrId: req.corrId,
      payload: req.payload ?? req,
    };
  });
}

export function writeCapturedOutputs(kind: 'default' | 'coordinator' = 'default', extraAnnotate?: (s: any[]) => any[]) {
  if (!isCaptureEnabled()) return;
  const outDir = path.resolve(process.cwd(), 'tests', 'outputs');
  try { fs.mkdirSync(outDir, { recursive: true }); } catch (_e) { void 0; }

  const jsonPath = path.join(outDir, kind === 'coordinator' ? 'last_run_prompts_coordinator.json' : 'last_run_prompts.json');
  try {
    const toWrite = extraAnnotate ? extraAnnotate(sent) : sent;
    fs.writeFileSync(jsonPath, JSON.stringify({ generatedAt: new Date().toISOString(), requests: toWrite }, null, 2));
  } catch (_e) {
    void 0;
  }

  if (kind === 'default') {
    const txtPath = path.join(outDir, 'last_run_prompts.txt');
    const lines: string[] = [];
    lines.push(`Prompts captured: ${new Date().toISOString()}`);
    lines.push('Each entry below is the raw request object captured for inspection.');
    lines.push('');
    for (const req of (extraAnnotate ? extraAnnotate(sent) : sent)) {
      lines.push('---');
      lines.push(`Phase: ${req.role || req.step || 'unknown'} (${req.step || 'unknown'})`);
      lines.push(`Persona: ${req.toPersona || 'unknown'}`);
      lines.push(`CorrId: ${req.corrId || 'n/a'}`);
      lines.push('Payload:');
      try {
        lines.push(JSON.stringify(req.payload ?? req, null, 2));
      } catch (e) {
        lines.push('[unserializable payload]');
      }
      lines.push('');
    }
    try { fs.writeFileSync(txtPath, lines.join('\n')); } catch (_e) { void 0; }
  }
}
