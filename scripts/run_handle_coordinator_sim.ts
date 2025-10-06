import path from 'path';
import fs from 'fs/promises';

// Harness: run the coordinator fallback parse/apply path directly using the
// saved lead preview. Avoid monkey-patching ESM module namespaces.
async function main() {
  const repoRoot = process.cwd();
  const previewPath = path.join(repoRoot, 'scripts', 'lead_preview_current.txt');
  const preview = (await fs.readFile(previewPath, 'utf8'));

  try {
    console.log('Invoking coordinator fallback parse/apply directly using saved preview');
    const fallback = await import('../src/fileops.js');
    const parsed = (fallback as any).parseUnifiedDiffToEditSpec(preview);
    console.log('Parsed ops count:', Array.isArray(parsed?.ops) ? parsed.ops.length : 0);
    if (parsed && Array.isArray(parsed.ops) && parsed.ops.length) {
      const res = await (fallback as any).applyEditOps(JSON.stringify(parsed), { repoRoot, branchName: 'handleCoordinator-sim', commitMessage: 'sim: handleCoordinator apply' });
      console.log('Direct apply result:', res);
    } else {
      console.log('No ops parsed from preview; nothing to apply');
    }
  } catch (err) {
    console.error('Fallback parse/apply failed:', err);
  }
}

main().catch(e => { console.error('Run harness failed:', e); process.exit(2); });
