#!/usr/bin/env node
import { readFile, writeFile } from 'fs/promises';

const filePath = 'src/process.ts';
const content = await readFile(filePath, 'utf8');
const lines = content.split('\n');

// First occurrence around line 785
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('const iteration = payloadObj.iteration || payloadObj.planIteration')) {
    // Add branch variable after iteration
    lines.splice(i + 1, 0, '        const planBranch = payloadObj.branch || repoInfo.branch || "unknown";');
    break;
  }
}

// Update first log entry to include branch
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('`Workflow ID: ${msg.workflow_id}`') && !lines[i+1].includes('Branch:')) {
    lines.splice(i + 1, 0, '          `Branch: ${planBranch}`,');
    break;
  }
}

// Update first logger.info for planning results written
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('logger.info("Planning results written to log"') && !lines[i+2].includes('branch:')) {
    // Add branch to the log object
    const logObjStart = i + 1;
    // Find where "iteration," is
    for (let j = logObjStart; j < logObjStart + 10; j++) {
      if (lines[j].includes('planLogPath: pathMod.relative')) {
        lines.splice(j + 1, 0, '          branch: planBranch,');
        break;
      }
    }
    break;
  }
}

// Update first commitAndPushPaths to use payloadObj.branch
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('await commitAndPushPaths({') && lines[i+2].includes('branch: repoInfo.branch')) {
    lines[i+2] = '            branch: payloadObj.branch || repoInfo.branch || null,';
    break;
  }
}

// Update first logger.info for planning log committed
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('logger.info("Planning log committed and pushed"') && !lines[i+2].includes('branch:')) {
    const logObjStart = i + 1;
    for (let j = logObjStart; j < logObjStart + 10; j++) {
      if (lines[j].includes('planLogPath: planLogRel,')) {
        lines.splice(j + 1, 0, '            branch: planBranch,');
        break;
      }
    }
    break;
  }
}

// Now do the same for the second occurrence (in processPersona function)
let foundFirst = false;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('const iteration = payloadObj.iteration || payloadObj.planIteration')) {
    if (!foundFirst) {
      foundFirst = true;
      continue;
    }
    // Add branch variable after iteration
    lines.splice(i + 1, 0, '        const planBranch = payloadObj.branch || repoInfo.branch || "unknown";');
    break;
  }
}

// Update second log entry to include branch
foundFirst = false;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('`Workflow ID: ${msg.workflow_id}`')) {
    if (!foundFirst) {
      foundFirst = true;
      continue;
    }
    if (!lines[i+1].includes('Branch:')) {
      lines.splice(i + 1, 0, '          `Branch: ${planBranch}`,');
    }
    break;
  }
}

// Update second logger.info for planning results written
foundFirst = false;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('logger.info("Planning results written to log"')) {
    if (!foundFirst) {
      foundFirst = true;
      continue;
    }
    const logObjStart = i + 1;
    for (let j = logObjStart; j < logObjStart + 10; j++) {
      if (lines[j].includes('planLogPath: pathMod.relative') && !lines[j+1].includes('branch:')) {
        lines.splice(j + 1, 0, '          branch: planBranch,');
        break;
      }
    }
    break;
  }
}

// Update second commitAndPushPaths
foundFirst = false;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('await commitAndPushPaths({')) {
    if (!foundFirst) {
      foundFirst = true;
      continue;
    }
    if (lines[i+2].includes('branch: repoInfo.branch')) {
      lines[i+2] = '            branch: payloadObj.branch || repoInfo.branch || null,';
    }
    break;
  }
}

// Update second logger.info for planning log committed
foundFirst = false;
for (let i = 0; i < lines.length; i++) {
  if (lines[i].includes('logger.info("Planning log committed and pushed"')) {
    if (!foundFirst) {
      foundFirst = true;
      continue;
    }
    const logObjStart = i + 1;
    for (let j = logObjStart; j < logObjStart + 10; j++) {
      if (lines[j].includes('planLogPath: planLogRel,') && !lines[j+1].includes('branch:')) {
        lines.splice(j + 1, 0, '            branch: planBranch,');
        break;
      }
    }
    break;
  }
}

await writeFile(filePath, lines.join('\n'), 'utf8');
console.log('Successfully updated planning log code to include branch information');
