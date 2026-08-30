import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProjectSettingsDialog } from '../project-settings-dialog';

const mocks = vi.hoisted(() => ({ manifest: {
  schema_version: 1,
  project: { display_name: 'Keystone', use_beads: true, summary: 'A workbench' },
  git: { completed_work_branch: 'ours', agents_may_merge_completed_work: true, protected_branches: ['main'] },
  beads: { issue_id_prefix: 'key', work_areas: ['interface'] },
  verification: { visual_proof_for_ui_changes: true, commands: [{ name: 'UI', command: 'npm test', paths: ['src/'] }] },
  review: { external_review: 'never' as const, evidence_requirements: 'Show the changed screen' },
  development: { setup_command: 'npm install', start_command: 'npm run dev', build_command: 'npm run build' },
  deployment: { command: 'deploy atelier', requires_confirmation: true },
  cross_project: { delivery_projects: ['website'] },
}, updateSettings: vi.fn() }));
mocks.updateSettings.mockResolvedValue({ manifest: mocks.manifest, storage: 'personal' });
vi.mock('@/lib/api', () => ({
  projects: {
    settings: vi.fn().mockResolvedValue({ manifest: mocks.manifest, storage: 'personal', path: '/data/project.toml' }),
    updateSettings: mocks.updateSettings,
    moveSettings: vi.fn(),
  },
  git: { branches: vi.fn().mockResolvedValue({ current: 'ours', branches: [{ name: 'ours' }, { name: 'main' }] }) },
}));
vi.mock('@/lib/db', () => ({ updateProject: vi.fn().mockResolvedValue({}) }));

describe('project settings', () => {
  it('shows and saves the policy values that drive the project', async () => {
    render(<ProjectSettingsDialog open onOpenChange={vi.fn()} projectId="p1" projectName="Keystone"
      projectPath="/dev/keystone" onUpdated={vi.fn()} />);

    expect(await screen.findByDisplayValue('A workbench')).toBeVisible();
    expect(screen.getByLabelText('Use task tracking for project work')).toBeChecked();
    expect(screen.getByRole('combobox', { name: 'External review' })).toHaveTextContent('Never');
    expect(screen.getByDisplayValue('deploy atelier')).toBeVisible();
    expect(screen.getByDisplayValue('UI | npm test | src/')).toBeVisible();

    fireEvent.change(screen.getByDisplayValue('A workbench'), { target: { value: 'Updated summary' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith('p1', expect.objectContaining({
      project: expect.objectContaining({ summary: 'Updated summary' }),
    })));
  });
});
