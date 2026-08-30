import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AddProjectDialog } from '../add-project-dialog';

const mocks = vi.hoisted(() => ({ manifest: {
  schema_version: 1,
  project: { display_name: 'Keystone', use_beads: true, summary: '' },
  git: { completed_work_branch: 'ours', agents_may_merge_completed_work: true, protected_branches: ['main'] },
  beads: { issue_id_prefix: 'key', work_areas: ['interface'] },
  verification: { visual_proof_for_ui_changes: true, commands: [{ name: 'Tests', command: 'npm test', paths: ['src/'] }] },
  review: { external_review: 'agent_decides' as const, evidence_requirements: '' },
  development: { setup_command: 'npm install', start_command: 'npm run dev', build_command: 'npm run build' },
  deployment: { command: '', requires_confirmation: true },
  cross_project: { delivery_projects: [] },
}, initialize: vi.fn().mockResolvedValue({ id: 'p1' }) }));
vi.mock('@/lib/api', () => ({
  projects: { probe: vi.fn().mockResolvedValue({ manifest: mocks.manifest, existing: false, storage: null }), initialize: mocks.initialize },
  git: { branches: vi.fn().mockResolvedValue({ current: 'ours', branches: [{ name: 'ours' }, { name: 'main' }] }) },
  dolt: { databases: vi.fn().mockResolvedValue({ databases: [] }), servers: vi.fn().mockResolvedValue({ servers: [] }) },
}));

describe('project onboarding', () => {
  it('reviews the inferred essentials and saves the chosen manifest', async () => {
    render(<AddProjectDialog open onOpenChange={vi.fn()} onInitialized={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Project Path'), { target: { value: '/dev/keystone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByLabelText('Project Name')).toHaveValue('Keystone');
    expect(screen.getByLabelText('Use task tracking for project work')).toBeChecked();
    expect(screen.getByLabelText('Issue ID prefix')).toHaveValue('key');
    expect(screen.getByLabelText('Completed-work branch')).toHaveValue('ours');
    expect(screen.getByText('1 verification command(s) inferred')).toBeVisible();

    fireEvent.click(screen.getByRole('button', { name: 'Add Project' }));
    await waitFor(() => expect(mocks.initialize).toHaveBeenCalledWith('/dev/keystone', 'personal', mocks.manifest));
  });
});
