import path from 'path';
import fs from 'fs/promises';

async function main() {
  const repoRoot = process.cwd();
  const previewPath = path.join(repoRoot, 'scripts', 'lead_preview_current.txt');
  const preview = (await fs.readFile(previewPath, 'utf8'));

  
  const r = {} as any;
  const msg = { workflow_id: 'sim-wf', project_id: 'sim-proj' } as any;
  const payloadObj: any = { repo: repoRoot, branch: 'milestone/override-sim' };

  
  const coord = await import('../src/workflows/coordinator.js');

  
  
  const overrides: any = {
    fetchProjectStatus: async (projectId: string) => ({ id: projectId, name: 'sim' }),
    fetchProjectStatusDetails: async () => ({}),
    fetchProjectNextAction: async () => ({}),
    resolveRepoFromPayload: async (p: any) => ({ repoRoot, remote: '', branch: p.branch || 'main' }),
    getRepoMetadata: async (_root: string) => ({ currentBranch: 'main', remoteSlug: null, remoteUrl: '' }),
    checkoutBranchFromBase: async () => {  },
    ensureBranchPublished: async () => {  },
    commitAndPushPaths: async (_opts: any) => ({ ok: true }),
    updateTaskStatus: async () => ({ ok: true }),
    selectNextMilestone: () => ({ id: 'm-sim', name: 'sim milestone', branch: 'milestone/override-sim' }),
    selectNextTask: () => ({ id: 't-sim', name: 'sim task' }),
  runLeadCycle: async () => ({ success: true, result: preview }),
    parseUnifiedDiffToEditSpec: async (txt: string) => {
      console.log('override parser wrapper: candidate length', txt ? txt.length : 0, 'preview head:', String(txt || '').slice(0,200));
      const real = await import('../src/fileops.js');
      try {
        const parsed = (real as any).parseUnifiedDiffToEditSpec(txt);
        console.log('override parser wrapper: parsed.ops.length=', Array.isArray(parsed?.ops) ? parsed.ops.length : 0, 'firstOpPath=', parsed?.ops?.[0]?.path);
        return parsed;
      } catch (e) {
        console.error('parser wrapper: real parser threw', e);
        throw e;
      }
    },
    applyEditOps: async (jsonText: string, opts: any) => {
      console.log('override applyEditOps: called with opts', { branchName: opts?.branchName || opts?.branchName });
      const real = await import('../src/fileops.js');
      try {
        const res = await (real as any).applyEditOps(jsonText, { repoRoot: process.cwd(), branchName: opts?.branchName || opts?.branch || 'override-apply' });
        console.log('override applyEditOps: result', res);
        return res;
      } catch (e) {
        console.error('override applyEditOps: real apply threw', e);
        throw e;
      }
    },
    persona: {
      sendPersonaRequest: async () => ({ ok: true }),
      waitForPersonaCompletion: async () => ({ fields: { result: {} }, id: 'evt-sim' }),
      parseEventResult: (_r: any) => _r,
      interpretPersonaStatus: (_r: any) => ({ status: 'pass' })
    }
  };

  console.log('Calling handleCoordinator with overrides...');
  try {
    await (coord as any).handleCoordinator(r, msg, payloadObj, overrides);
    console.log('handleCoordinator completed');
  } catch (err) {
    console.error('handleCoordinator threw:', err);
  }
}

main().catch(e => { console.error('harness failed:', e); process.exit(2); });
