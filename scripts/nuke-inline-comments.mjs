#!/usr/bin/env node

/**
 * Nuclear option: Delete all inline comments from TypeScript files
 * "Code is the source of truth. Comments lie."
 */

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

function nukeInlineComments(filePath) {
  const content = readFileSync(filePath, 'utf-8');
  const lines = content.split('\n');
  let changed = false;
  let removedCount = 0;

  const processedLines = lines.map(line => {
    const trimmed = line.trim();
    if (trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*')) {
      return line;
    }

    // Find // that's not inside a string
    let inString = false;
    let stringChar = null;
    let commentStart = -1;
    let escaped = false;

    for (let i = 0; i < line.length - 1; i++) {
      const char = line[i];
      const nextChar = line[i + 1];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if ((char === '"' || char === "'" || char === '`') && !inString) {
        inString = true;
        stringChar = char;
      } else if (char === stringChar && inString) {
        inString = false;
        stringChar = null;
      }

      if (!inString && char === '/' && nextChar === '/') {
        commentStart = i;
        break;
      }
    }

    if (commentStart > 0) {
      const codePart = line.substring(0, commentStart).replace(/\s+$/, '');
      if (codePart.trim().length > 0) {
        changed = true;
        removedCount++;
        return codePart;
      }
    }

    return line;
  });

  if (changed) {
    writeFileSync(filePath, processedLines.join('\n'), 'utf-8');
    console.log(`💣 ${filePath.replace(process.cwd(), '.')}: Nuked ${removedCount} inline comments`);
    return removedCount;
  }

  return 0;
}

function findTsFiles(dir, files = []) {
  const ignoreList = ['node_modules', 'dist', 'coverage', 'outputs', 'projects', 'true', '.git'];
  
  try {
    const entries = readdirSync(dir);
    
    for (const entry of entries) {
      if (ignoreList.includes(entry)) continue;
      
      const fullPath = join(dir, entry);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        findTsFiles(fullPath, files);
      } else if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
        files.push(fullPath);
      }
    }
  } catch (err) {
    // Skip directories we can't read
  }
  
  return files;
}

const files = findTsFiles(process.cwd());

console.log(`🚀 Found ${files.length} TypeScript files`);
console.log('💣 Nuking inline comments...\n');

let totalRemoved = 0;
let filesChanged = 0;

for (const file of files) {
  const removed = nukeInlineComments(file);
  if (removed > 0) {
    filesChanged++;
    totalRemoved += removed;
  }
}

console.log(`\n✨ Complete!`);
console.log(`📁 Files changed: ${filesChanged}`);
console.log(`💥 Total inline comments nuked: ${totalRemoved}`);
console.log('\n"Code is the source of truth. Comments lie." 🔥');
