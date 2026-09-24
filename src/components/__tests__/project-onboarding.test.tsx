import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { AddProjectDialog } from '../add-project-dialog';

const mocks = vi.hoisted(() => ({ manifest: {
  schema_version: 1,
  project: { display_name: 'Keystone', use_beads: true, summary: '' },
  git: { completed_work_branch: 'ours', agents_may_merge_completed_work: true, protected_branches: ['main'] },
  beads: { issue_id_prefix: 'key', work_areas: ['interface'] },
  verification: { commands: [{ name: 'Tests', command: 'npm test', paths: ['src/'] }] },
  review: { external_review: 'agent_decides' as const },
  cross_project: { delivery_projects: [] },
}, initialize: vi.fn().mockResolvedValue({ id: 'p1' }), toast: vi.fn() }));
vi.mock('@/lib/api', () => ({
  projects: { probe: vi.fn().mockResolvedValue({ manifest: mocks.manifest, instructions: 'Start command: npm run dev', existing: false, storage: null }), initialize: mocks.initialize },
  git: { branches: vi.fn().mockResolvedValue({ current: 'ours', branches: [{ name: 'ours' }, { name: 'main' }] }) },
  dolt: { databases: vi.fn().mockResolvedValue({ databases: [] }), servers: vi.fn().mockResolvedValue({ servers: [] }) },
}));
vi.mock('@/hooks/use-toast', () => ({ useToast: () => ({ toast: mocks.toast }) }));

describe('project onboarding', () => {
  it('reviews the inferred essentials and saves the chosen manifest', async () => {
    render(<AddProjectDialog open onOpenChange={vi.fn()} onInitialized={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/dev/keystone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));

    expect(await screen.findByLabelText('Project name')).toHaveValue('Keystone');
    expect(screen.getByLabelText('Use task tracking for project work')).toBeChecked();
    expect(screen.getByLabelText('Card ID prefix')).toHaveValue('key');
    expect(screen.getByRole('combobox', { name: 'Finished work lands on' })).toHaveTextContent('ours');

    fireEvent.click(screen.getByRole('button', { name: 'Add Project' }));
    // The instructions the probe inferred are added with the project, not
    // dropped on the way through the dialog (bw-a9ln.4).
    await waitFor(() => expect(mocks.initialize).toHaveBeenCalledWith('/dev/keystone', 'personal', mocks.manifest, 'Start command: npm run dev'));
  });

  /**
   * A folder already on the home screen is refused deliberately, and the
   * reader is told which project already holds it — not shown the app's own
   * `API error: 409` nor anything SQLite said (bw-uk0k.2).
   */
  it('says which project already holds a folder that is added twice', async () => {
    mocks.toast.mockClear();
    mocks.initialize.mockRejectedValueOnce(
      new Error('API error: 409 Keystone is already on the home screen'),
    );
    render(<AddProjectDialog open onOpenChange={vi.fn()} onInitialized={vi.fn()} />);
    fireEvent.change(screen.getByLabelText('Folder'), { target: { value: '/dev/keystone' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    expect(await screen.findByLabelText('Project name')).toHaveValue('Keystone');

    fireEvent.click(screen.getByRole('button', { name: 'Add Project' }));

    await waitFor(() => expect(mocks.toast).toHaveBeenCalledWith(expect.objectContaining({
      title: 'Couldn’t add project',
      description: 'Keystone is already on the home screen',
      variant: 'destructive',
    })));
  });
});
