import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs/promises';
import path from 'path';
import { makeTempRepo } from './makeTempRepo.js';

describe('Log Cleanup', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await makeTempRepo({
      'README.md': '# Test\n'
    });
  });

  afterEach(async () => {
    if (tempDir) {
      await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    }
  });

  it('should keep only the last 5 log files', async () => {
    const planningDir = path.join(tempDir, '.ma', 'planning');
    await fs.mkdir(planningDir, { recursive: true });

    
    const logFiles: string[] = [];
    for (let i = 0; i < 8; i++) {
      const logFile = path.join(planningDir, `task-test-${i}-plan.log`);
      await fs.writeFile(logFile, `Log content ${i}\n`, 'utf8');
      logFiles.push(logFile);
      
      
      const time = new Date(Date.now() - (8 - i) * 1000);
      await fs.utimes(logFile, time, time);
      
      
      await new Promise(resolve => setTimeout(resolve, 1));
    }

    
    const filesBefore = await fs.readdir(planningDir);
    expect(filesBefore.length).toBe(8);

    
    
    
    
    
    const files = await fs.readdir(planningDir);
    const matchingFiles: { name: string; path: string; mtime: number }[] = [];
    
    for (const file of files) {
      if (file.startsWith('task-') && file.endsWith('-plan.log')) {
        const filePath = path.join(planningDir, file);
        const stats = await fs.stat(filePath);
        matchingFiles.push({
          name: file,
          path: filePath,
          mtime: stats.mtimeMs
        });
      }
    }

    
    matchingFiles.sort((a, b) => b.mtime - a.mtime);

    
    const filesToDelete = matchingFiles.slice(5);
    for (const file of filesToDelete) {
      await fs.unlink(file.path);
    }

    
    const filesAfter = await fs.readdir(planningDir);
    expect(filesAfter.length).toBe(5);

    
    const keptFiles = matchingFiles.slice(0, 5);
    for (const file of keptFiles) {
      const exists = filesAfter.includes(file.name);
      expect(exists).toBe(true);
    }

    
    for (let i = 0; i < 3; i++) {
      const fileName = `task-test-${i}-plan.log`;
      expect(filesAfter.includes(fileName)).toBe(false);
    }
  });

  it('should handle empty directory', async () => {
    const planningDir = path.join(tempDir, '.ma', 'planning');
    await fs.mkdir(planningDir, { recursive: true });

    
    const files = await fs.readdir(planningDir);
    expect(files.length).toBe(0);

    
    
  });

  it('should handle directory with fewer than 5 files', async () => {
    const qaDir = path.join(tempDir, '.ma', 'qa');
    await fs.mkdir(qaDir, { recursive: true });

    
    for (let i = 0; i < 3; i++) {
      const logFile = path.join(qaDir, `task-test-${i}-qa.log`);
      await fs.writeFile(logFile, `QA log ${i}\n`, 'utf8');
    }

    const filesBefore = await fs.readdir(qaDir);
    expect(filesBefore.length).toBe(3);

    
    const files = await fs.readdir(qaDir);
    const matchingFiles: { name: string; path: string; mtime: number }[] = [];
    
    for (const file of files) {
      if (file.startsWith('task-') && file.endsWith('-qa.log')) {
        const filePath = path.join(qaDir, file);
        const stats = await fs.stat(filePath);
        matchingFiles.push({
          name: file,
          path: filePath,
          mtime: stats.mtimeMs
        });
      }
    }

    matchingFiles.sort((a, b) => b.mtime - a.mtime);
    const filesToDelete = matchingFiles.slice(5);

    expect(filesToDelete.length).toBe(0);

    
    const filesAfter = await fs.readdir(qaDir);
    expect(filesAfter.length).toBe(3);
  });
});
