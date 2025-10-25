import 'dotenv/config';

/**
 * DEPRECATED: This script uses old /v1/* API routes that no longer exist.
 * The dashboard backend now uses /projects/* routes.
 * 
 * To fix:
 * - /v1/projects/:id → /projects/:id
 * - /v1/tasks/:id → /projects/:projectId/tasks/:taskId
 * - /v1/milestones/:id → /projects/:projectId/milestones/:milestoneId
 * 
 * This script has NOT been updated yet. Use at your own risk.
 */

const DEFAULT_PROJECT_ID = '1808e304-fc52-49f6-9a42-71044b4cb4b5';
const DEFAULT_NEW_MILESTONE_ID = 'b85c21ff-5bd3-4aaf-a83a-899b86261eb9';
const DEFAULT_OLD_MILESTONE_ID = 'c9464afe-15dd-4c5f-b29c-c28cf391c136';

const base = (process.env.DASHBOARD_BASE_URL || 'http://localhost:8787').replace(/\/$/, '');
const apiKey = process.env.DASHBOARD_API_KEY || 'dev';

function hdrs() {
  return { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' };
}

function usage() {
  console.log('Usage: node scripts/fix-milestones.mjs [--apply] [projectId] [oldMilestoneId] [newMilestoneId]');
  console.log('Defaults are set to the project and milestone IDs you provided. By default the script will do a dry-run.');
}

const args = process.argv.slice(2);
if (args.includes('--help') || args.includes('-h')) { usage(); process.exit(0); }
const apply = args.includes('--apply');
const positional = args.filter(a => a !== '--apply');

const projectId = positional[0] || DEFAULT_PROJECT_ID;
const oldMilestoneId = positional[1] || DEFAULT_OLD_MILESTONE_ID;
const newMilestoneId = positional[2] || DEFAULT_NEW_MILESTONE_ID;

console.log(`Dashboard base: ${base}`);
console.log(`Project: ${projectId}`);
console.log(`Move tasks from milestone ${oldMilestoneId} -> ${newMilestoneId}`);
console.log(apply ? 'Running in APPLY mode (changes will be made)' : 'Dry-run mode (no changes). Use --apply to perform changes)');

async function fetchProject() {
  const res = await fetch(`${base}/v1/projects/${encodeURIComponent(projectId)}`, { headers: hdrs() });
  if (!res.ok) throw new Error(`fetch project failed: ${res.status}`);
  return await res.json();
}

async function fetchTask(taskId) {
  const res = await fetch(`${base}/v1/tasks/${encodeURIComponent(taskId)}`, { headers: hdrs() });
  if (!res.ok) throw new Error(`fetch task ${taskId} failed: ${res.status}`);
  return await res.json();
}

async function fetchProjectTasks() {
  try {
    const res = await fetch(`${base}/v1/projects/${encodeURIComponent(projectId)}/tasks`, { headers: hdrs() });
    if (!res.ok) return null;
    return await res.json();
  } catch (e) {
    return null;
  }
}

async function fetchTasksByQuery(params) {
  const qs = new URLSearchParams(params).toString();
  try {
    const res = await fetch(`${base}/v1/tasks?${qs}`, { headers: hdrs() });
    const text = await res.text();
    let body = null;
    try { body = text ? JSON.parse(text) : null; } catch { body = text; }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, body: null };
  }
}

async function patchTask(taskId, body) {
  const res = await fetch(`${base}/v1/tasks/${encodeURIComponent(taskId)}`, {
    method: 'PATCH', headers: hdrs(), body: JSON.stringify(body)
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { ok: res.ok, status: res.status, body: parsed };
}

async function deleteMilestone(milestoneId) {
  const res = await fetch(`${base}/v1/milestones/${encodeURIComponent(milestoneId)}`, {
    method: 'DELETE', headers: hdrs()
  });
  const text = await res.text();
  let parsed = null;
  try { parsed = text ? JSON.parse(text) : null; } catch { parsed = text; }
  return { ok: res.ok, status: res.status, body: parsed };
}

try {
  const project = await fetchProject();
  // Collect tasks from likely fields
  const candidates = [];
  if (Array.isArray(project.tasks)) candidates.push(...project.tasks);
  if (Array.isArray(project.task_list)) candidates.push(...project.task_list);
  if (Array.isArray(project.items)) candidates.push(...project.items);
  // some servers nest under project.work_items etc.
  for (const k of ['work_items','issues','tickets','stories','tasks_list']) if (Array.isArray(project[k])) candidates.push(...project[k]);

  const unique = new Map();
  for (const t of candidates) {
    if (!t || !t.id) continue;
    unique.set(String(t.id), t);
  }

  const tasks = Array.from(unique.values()).filter(t => {
    // match by milestone id or name
    if (t.milestone_id && String(t.milestone_id) === String(oldMilestoneId)) return true;
    if (t.milestone && (String(t.milestone) === String(oldMilestoneId) || (t.milestone.id && String(t.milestone.id) === String(oldMilestoneId)))) return true;
    const mname = (t.milestone_name || t.milestone_title || (t.milestone && (t.milestone.name || t.milestone.title)) || '').toString().toLowerCase();
    if (mname && mname.includes('mvp') && mname.includes('ingestion') && mname.includes('ui')) return true;
    return false;
  });

  if (!tasks.length) {
    console.log('No tasks found for the old milestone in the project object. Attempting common task-list endpoints...');
    const probes = [];
    probes.push(await fetchTasksByQuery({ project_id: projectId }));
    probes.push(await fetchTasksByQuery({ milestone_id: oldMilestoneId }));
    probes.push(await fetchTasksByQuery({ milestone: oldMilestoneId }));

    for (const [i, p] of probes.entries()) {
      console.log(`Probe[${i}] ok=${p.ok} status=${p.status} bodyType=${Array.isArray(p.body)? 'array('+p.body.length+')' : typeof p.body}`);
      if (p.ok && Array.isArray(p.body)) {
        console.log('Found tasks from probe; listing candidates:');
        for (const t of p.body) console.log(` - ${t.id}: ${t.title || t.name || '(no title)'} (milestone_id=${t.milestone_id || t.milestone?.id || 'N/A'})`);
      }
    }

    // final diagnostics
    console.log('Project top-level keys:', Object.keys(project));
    console.log('Sample project JSON (truncated):', JSON.stringify(project, null, 2).slice(0, 2000));
    process.exit(0);
  }

  console.log(`Found ${tasks.length} candidate tasks:`);
  for (const t of tasks) console.log(` - ${t.id}: ${t.title || t.name || '(no title)'} (milestone_id=${t.milestone_id || t.milestone?.id || 'N/A'})`);

  if (!apply) {
    console.log('\nDry-run complete. To apply these changes run with --apply. Example:');
    console.log(`node scripts/fix-milestones.mjs --apply ${projectId} ${oldMilestoneId} ${newMilestoneId}`);
    process.exit(0);
  }

  // Apply changes
  for (const t of tasks) {
    try {
      const task = await fetchTask(t.id);
      const lock = task?.lock_version ?? task?.lockVersion ?? task?.LOCK_VERSION ?? undefined;
      const body = { milestone_id: newMilestoneId };
      if (lock !== undefined) body.lock_version = Number(lock);
      const resp = await patchTask(t.id, body);
      if (!resp.ok) console.error(`Failed to update task ${t.id}:`, resp.status, resp.body);
      else console.log(`Updated task ${t.id} -> milestone ${newMilestoneId}`);
    } catch (e) {
      console.error(`Error updating task ${t.id}:`, e);
    }
  }

  // Delete old milestone
  try {
    const del = await deleteMilestone(oldMilestoneId);
    if (!del.ok) {
      console.error('Failed to delete milestone:', del.status, del.body);
      process.exit(2);
    }
    console.log('Deleted old milestone', oldMilestoneId);
  } catch (e) {
    console.error('Error deleting milestone:', e);
    process.exit(2);
  }

  console.log('All done.');
  process.exit(0);
} catch (e) {
  console.error('Script failed:', e);
  process.exit(1);
}
