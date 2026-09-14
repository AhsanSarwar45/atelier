import { beforeEach, describe, expect, it } from 'vitest';

import { projectTitle, rememberProjectName } from '@/lib/project-title';

describe('project browser titles', () => {
  beforeEach(() => window.localStorage.clear());

  it('keeps the project name while its record is read again', () => {
    rememberProjectName('project-1', 'Aspen');

    expect(projectTitle('project-1')).toBe('Aspen | Atelier');
  });

  it('lets the fetched display name replace a remembered name', () => {
    rememberProjectName('project-1', 'Old name');

    expect(projectTitle('project-1', 'New name')).toBe('New name | Atelier');
    expect(projectTitle('project-1')).toBe('New name | Atelier');
  });

  it('uses the product name when there is no project identity', () => {
    expect(projectTitle(null)).toBe('Atelier');
    expect(projectTitle('never-seen')).toBe('Atelier');
  });
});
