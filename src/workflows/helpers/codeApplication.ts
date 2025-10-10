import { applyEditOps as applyEditOpsType } from "../../fileops.js";
import { commitAndPushPaths as commitAndPushPathsType } from "../../gitUtils.js";

type LoggerLike = {
  info: (message: string, meta?: Record<string, any>) => void;
  warn: (message: string, meta?: Record<string, any>) => void;
  debug?: (message: string, meta?: Record<string, any>) => void;
};

export type ApplyAgentCodeChangesOptions = {
  workflowId: string;
  phase: string;
  repoRoot: string;
  branchName: string;
  baseBranch: string;
  agentResult: any;
  taskDescriptor?: { id?: string | null; external_id?: string | null } | null;
  taskName?: string | null;
  commitMessage?: string;
  messages: {
    noOps: string;
    noChanges: string;
    commitFailed: string;
  };
  parseAgentEditsFromResponse: (result: any, opts: { parseDiff: (txt: string) => Promise<any>; maxDiffCandidates: number }) => Promise<any>;
  parseUnifiedDiffToEditSpec: (txt: string) => Promise<any>;
  applyEditOps: typeof applyEditOpsType;
  ensureBranchPublished: (repoRoot: string, branch: string) => Promise<void>;
  commitAndPushPaths: typeof commitAndPushPathsType;
  recordDiagnostic: (file: string, payload: any) => Promise<void>;
  verifyCommitState: (phase: string, extras?: Record<string, any>) => Promise<any>;
  logger: LoggerLike;
};

export type ApplyAgentCodeChangesResult = {
  applied: boolean;
  upstreamApplied: boolean;
  changedFiles: string[];
};

const toPhaseKey = (phase: string) => phase.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'phase';

export async function applyAgentCodeChanges(options: ApplyAgentCodeChangesOptions): Promise<ApplyAgentCodeChangesResult> {
  const {
    workflowId,
    phase,
    repoRoot,
    branchName,
    agentResult,
    taskDescriptor,
    taskName,
    messages,
    parseAgentEditsFromResponse,
    parseUnifiedDiffToEditSpec,
    applyEditOps,
    ensureBranchPublished,
    commitAndPushPaths,
    recordDiagnostic,
    verifyCommitState,
    logger,
  } = options;

  const phaseKey = toPhaseKey(phase);

  if (!agentResult) {
    throw new Error(messages.noOps);
  }

  const upstreamApplied = (agentResult?.applied_edits || agentResult?.appliedEdits);
  if (upstreamApplied && upstreamApplied.applied && upstreamApplied.commit && upstreamApplied.commit.committed && upstreamApplied.commit.pushed) {
    await verifyCommitState(`${phase}-upstream-applied`, { upstreamApplied, taskId: taskDescriptor?.id || null });
    return { applied: true, upstreamApplied: true, changedFiles: Array.isArray(upstreamApplied.paths) ? upstreamApplied.paths : [] };
  }

  const parseOutcome = await parseAgentEditsFromResponse(agentResult, {
    parseDiff: (txt: string) => parseUnifiedDiffToEditSpec(txt),
    maxDiffCandidates: 6,
  });
  const editSpecCandidate = parseOutcome.editSpec && typeof parseOutcome.editSpec === 'object' ? parseOutcome.editSpec : null;
  const editOps = Array.isArray((editSpecCandidate as any)?.ops) ? (editSpecCandidate as any).ops : [];
  if (!editOps.length) {
    await recordDiagnostic(`coordinator-${phaseKey}-no-ops.json`, {
      workflowId,
      taskId: taskDescriptor?.id || null,
      parseOutcome,
      agentResult: typeof agentResult === 'string' ? agentResult : { ...agentResult, preview: undefined },
    });
    throw new Error(messages.noOps);
  }

  const specToApply = editSpecCandidate || { ops: editOps };
  const opPreview = editOps.slice(0, 5).map((op: any) => (op && typeof op === 'object' ? ((op as any).path || (op as any).target || (op as any).dest || 'unknown') : 'unknown'));
  logger.info('coordinator: applying edit ops', {
    workflowId,
    taskId: taskDescriptor?.id || null,
    branchName,
    opCount: editOps.length,
    opPreview,
  });

  const editResult = await applyEditOps(JSON.stringify(specToApply), { repoRoot, branchName });
  if (!editResult.changed.length) {
    await recordDiagnostic(`coordinator-${phaseKey}-apply-no-changes.json`, {
      workflowId,
      taskId: taskDescriptor?.id || null,
      parseOutcome,
      specPreview: JSON.stringify(specToApply).slice(0, 2000),
    });
    throw new Error(messages.noChanges);
  }

  try { await ensureBranchPublished(repoRoot, branchName); } catch {}

  const commitResult = await commitAndPushPaths({ repoRoot, branch: branchName, message: options.commitMessage ?? `feat: ${taskName}`, paths: editResult.changed });
  if (!commitResult || !commitResult.committed || !commitResult.pushed) {
    await recordDiagnostic(`coordinator-${phaseKey}-commit-failure.json`, {
      workflowId,
      taskId: taskDescriptor?.id || null,
      parseOutcome,
      commitResult,
      changed: editResult.changed,
    });
    throw new Error(messages.commitFailed);
  }

  await verifyCommitState(`${phase}-commit`, {
    commitResult,
    changed: editResult.changed,
    parseOutcome,
    taskId: taskDescriptor?.id || null,
  });

  return { applied: true, upstreamApplied: false, changedFiles: editResult.changed };
}
