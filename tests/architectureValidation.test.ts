import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';

/**
 * Architecture Validation Tests
 * 
 * These tests enforce architectural boundaries and prevent regression
 * to old patterns that have been refactored away.
 */

describe('Architecture Validation', () => {
  
  it('should not have src/redis/ directory (old architecture removed)', () => {
    const srcDir = join(process.cwd(), 'src');
    const entries = readdirSync(srcDir);
    
    expect(entries).not.toContain('redis');
  });

  it('should not import from redis/ subdirectory anywhere in src/', () => {
    const violations: string[] = [];
    
    function checkFile(filePath: string) {
      if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) return;
      
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      
      lines.forEach((line, index) => {
        // Check for imports from redis/ subdirectory
        if (line.match(/from\s+['"].*\/redis\//)) {
          violations.push(`${filePath}:${index + 1} - ${line.trim()}`);
        }
      });
    }
    
    function walkDir(dir: string) {
      const entries = readdirSync(dir);
      
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        
        if (stat.isDirectory()) {
          // Skip node_modules, dist, etc
          if (!['node_modules', 'dist', '.git'].includes(entry)) {
            walkDir(fullPath);
          }
        } else if (stat.isFile()) {
          checkFile(fullPath);
        }
      }
    }
    
    walkDir(join(process.cwd(), 'src'));
    
    if (violations.length > 0) {
      throw new Error(
        `Found imports from redis/ subdirectory (old architecture):\n${violations.join('\n')}\n\n` +
        `Use transport abstraction (LocalTransport/RedisTransport) instead.`
      );
    }
    
    expect(violations).toHaveLength(0);
  });

  it('should use transport abstraction, not direct redis helpers', () => {
    const violations: string[] = [];
    
    function checkFile(filePath: string) {
      if (!filePath.endsWith('.ts') && !filePath.endsWith('.tsx')) return;
      if (filePath.includes('test') || filePath.includes('Test')) return; // Skip test files
      
      const content = readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');
      
      lines.forEach((line, index) => {
        // Check for old redis helper function calls (not transport methods)
        const oldPatterns = [
          /\bpublishEvent\s*\(/,
          /\backnowledgeRequest\s*\(/,
          /\bgroupForPersona\s*\(/
        ];
        
        for (const pattern of oldPatterns) {
          if (line.match(pattern) && !line.includes('//') && !line.includes('*')) {
            violations.push(`${filePath}:${index + 1} - ${line.trim()}`);
          }
        }
      });
    }
    
    function walkDir(dir: string) {
      const entries = readdirSync(dir);
      
      for (const entry of entries) {
        const fullPath = join(dir, entry);
        const stat = statSync(fullPath);
        
        if (stat.isDirectory()) {
          if (!['node_modules', 'dist', '.git', 'tests'].includes(entry)) {
            walkDir(fullPath);
          }
        } else if (stat.isFile()) {
          checkFile(fullPath);
        }
      }
    }
    
    walkDir(join(process.cwd(), 'src'));
    
    if (violations.length > 0) {
      throw new Error(
        `Found usage of old redis helper functions:\n${violations.join('\n')}\n\n` +
        `Use transport.xAdd(), transport.xAck(), etc. instead.`
      );
    }
    
    expect(violations).toHaveLength(0);
  });

  it('should not have worker.ts (replaced by transport abstraction)', () => {
    const srcDir = join(process.cwd(), 'src');
    const entries = readdirSync(srcDir);
    
    expect(entries).not.toContain('worker.ts');
  });

  it('should have transport abstraction files', () => {
    const transportDir = join(process.cwd(), 'src', 'transport');
    const entries = readdirSync(transportDir);
    
    expect(entries).toContain('LocalTransport.ts');
    expect(entries).toContain('RedisTransport.ts');
    expect(entries).toContain('MessageTransport.ts');
  });

  it('should use run_coordinator.ts as main entry point', () => {
    const toolsDir = join(process.cwd(), 'src', 'tools');
    const entries = readdirSync(toolsDir);
    
    expect(entries).toContain('run_coordinator.ts');
  });
});
