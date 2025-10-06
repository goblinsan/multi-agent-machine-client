import { describe, it, expect } from 'vitest';
import fs from 'fs';
import path from 'path';

// These are contract tests for the proposed API. They don't make network calls.
// They validate that our OpenAPI proposal includes endpoints and enums
// needed by the coordinator. Skipped by default unless DASHBOARD_CONTRACT_TESTS=1.

const RUN = process.env.DASHBOARD_CONTRACT_TESTS === '1';

(RUN ? describe : describe.skip)('Dashboard API contracts (proposal)', () => {
  const specPath = path.resolve(__dirname, '../../projects/openapi-proposal-external-id.yml');
  it('includes upsert, resolve, status-by-id, status-by-external, batch, and milestone upsert', () => {
    const text = fs.readFileSync(specPath, 'utf8');
    const mustHave = [
      '/v1/tasks:upsert:',
      '/v1/tasks/resolve:',
      '/v1/tasks/{task_id}/status:',
      '/v1/tasks/by-external/{external_id}/status:',
      '/v1/tasks/status:batch:',
      '/v1/projects/{project_id}/milestones:upsert:'
    ];
    for (const seg of mustHave) {
      expect(text).toContain(seg);
    }
  });

  it('normalizes statuses to done/in_progress/on_hold', () => {
    const text = fs.readFileSync(specPath, 'utf8');
    expect(text).toMatch(/enum: \[done, in_progress, on_hold\]/);
  });

  it('TaskRead has external_id and lock_version', () => {
    const text = fs.readFileSync(specPath, 'utf8');
    expect(text).toContain('TaskRead:');
    expect(text).toContain('external_id');
    expect(text).toContain('lock_version');
  });
});
