#!/usr/bin/env node

import { readFileSync, writeFileSync, readdirSync, statSync } from 'fs';
import { join, extname } from 'path';

function stripComments(code) {
  let result = '';
  let i = 0;
  let inString = false;
  let stringChar = '';
  let inBlockComment = false;
  let inLineComment = false;
  let inTemplate = false;
  
  while (i < code.length) {
    const char = code[i];
    const next = code[i + 1];
    
    if (inTemplate) {
      result += char;
      if (char === '`' && code[i - 1] !== '\\') {
        inTemplate = false;
      }
      i++;
      continue;
    }
    
    if (inString) {
      result += char;
      if (char === stringChar && code[i - 1] !== '\\') {
        inString = false;
      }
      i++;
      continue;
    }
    
    if (inBlockComment) {
      if (char === '*' && next === '/') {
        inBlockComment = false;
        i += 2;
        continue;
      }
      i++;
      continue;
    }
    
    if (inLineComment) {
      if (char === '\n') {
        inLineComment = false;
        result += char;
      }
      i++;
      continue;
    }
    
    if (char === '"' || char === "'") {
      inString = true;
      stringChar = char;
      result += char;
      i++;
      continue;
    }
    
    if (char === '`') {
      inTemplate = true;
      result += char;
      i++;
      continue;
    }
    
    if (char === '/' && next === '*') {
      inBlockComment = true;
      i += 2;
      continue;
    }
    
    if (char === '/' && next === '/') {
      inLineComment = true;
      i += 2;
      continue;
    }
    
    result += char;
    i++;
  }
  
  return result;
}

function processFile(filePath) {
  try {
    const content = readFileSync(filePath, 'utf-8');
    const stripped = stripComments(content);
    
    if (content !== stripped) {
      writeFileSync(filePath, stripped, 'utf-8');
      console.log(`✓ Stripped comments from: ${filePath}`);
      return 1;
    }
    return 0;
  } catch (error) {
    console.error(`✗ Error processing ${filePath}:`, error.message);
    return 0;
  }
}

function processDirectory(dirPath, extensions = ['.ts', '.tsx', '.js', '.jsx']) {
  let count = 0;
  
  try {
    const items = readdirSync(dirPath);
    
    for (const item of items) {
      const fullPath = join(dirPath, item);
      const stat = statSync(fullPath);
      
      if (stat.isDirectory()) {
        if (!item.startsWith('.') && item !== 'node_modules' && item !== 'dist' && item !== 'outputs' && item !== 'coverage') {
          count += processDirectory(fullPath, extensions);
        }
      } else if (stat.isFile()) {
        const ext = extname(fullPath);
        if (extensions.includes(ext)) {
          count += processFile(fullPath);
        }
      }
    }
  } catch (error) {
    console.error(`Error reading directory ${dirPath}:`, error.message);
  }
  
  return count;
}

const rootDir = process.cwd();
console.log('Starting comment stripping...\n');
const filesModified = processDirectory(rootDir);
console.log(`\n✅ Complete! Modified ${filesModified} files`);
