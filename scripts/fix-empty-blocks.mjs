#!/usr/bin/env node

import { readFileSync, writeFileSync } from 'fs';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const filesToFix = [
  'src/fileops.ts',
  'src/git/queries.ts',
  'src/git/resolution/RepoResolver.ts',
  'src/git/setup/RepoSetup.ts',
  'src/logger.ts',
  'src/scanRepo.ts',
  'src/tasks/taskManager.ts',
  'src/workflows/WorkflowCoordinator.ts',
  'src/workflows/helpers/workflowAbort.ts',
  'src/workflows/steps/GitArtifactStep.ts',
  'src/workflows/steps/PersonaRequestStep.ts',
  'src/workflows/steps/PMDecisionParserStep.ts',
  'src/workflows/steps/pm/DecisionParser.ts',
];

for (const file of filesToFix) {
  const fullPath = `/Users/jamescoghlan/code/multi-agent-machine-client/${file}`;
  let content = readFileSync(fullPath, 'utf-8');
  
  content = content.replace(
    /} catch \((\w+)\) {\s*\n\s*}/g,
    '} catch ($1) {\n    logger.warn(`Unexpected error in ${file}`, { error: String($1) });\n  }'
  );
  
  content = content.replace(
    /} catch {\s*\n\s*}/g,
    '} catch (e) {\n    logger.warn(`Unexpected error in ${file}`, { error: String(e) });\n  }'
  );
  
  writeFileSync(fullPath, content, 'utf-8');
  console.log(`✓ Fixed ${file}`);
}

console.log('\nDone! Now check if logger is imported in all files...');
