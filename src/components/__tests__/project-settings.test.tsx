import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { ProjectSettingsScreen } from '../project-settings-screen';

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
vi.mock('next/navigation', () => ({
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), back: vi.fn() }),
  useSearchParams: () => new URLSearchParams(),
}));

describe('project settings', () => {
  it('shows and saves the policy values that drive the project', async () => {
    const shared = { projectId: 'p1', projectName: 'Keystone', projectPath: '/dev/keystone', tab: null, onOpen: vi.fn(), onTab: vi.fn(), backHref: '/', onUpdated: vi.fn() };
    const { rerender } = render(<ProjectSettingsScreen {...shared} section="workflow" />);

    expect(await screen.findByDisplayValue('A workbench')).toBeVisible();
    expect(screen.getByLabelText('Use task tracking for project work')).toBeChecked();

    rerender(<ProjectSettingsScreen {...shared} section="review" />);
    expect(screen.getByRole('combobox', { name: 'External review' })).toHaveTextContent('Never');
    expect(screen.getByDisplayValue('UI | npm test | src/')).toBeVisible();

    rerender(<ProjectSettingsScreen {...shared} section="development" />);
    expect(screen.getByDisplayValue('deploy atelier')).toBeVisible();

    rerender(<ProjectSettingsScreen {...shared} section="workflow" />);
    fireEvent.change(screen.getByDisplayValue('A workbench'), { target: { value: 'Updated summary' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(mocks.updateSettings).toHaveBeenCalledWith('p1', expect.objectContaining({
      project: expect.objectContaining({ summary: 'Updated summary' }),
    })));
  });
});
