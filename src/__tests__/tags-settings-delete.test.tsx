import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TagsSettings } from '@/components/settings/tags-settings';

const { getTags, deleteTag, createTag } = vi.hoisted(() => ({ getTags: vi.fn(), deleteTag: vi.fn(), createTag: vi.fn() }));
vi.mock('@/lib/db', () => ({ getTags, deleteTag, createTag }));

const tag = { id: 't1', name: 'urgent', color: '#ff0000' };

describe('Deleting a tag', () => {
  beforeEach(() => {
    getTags.mockReset(); deleteTag.mockReset(); createTag.mockReset();
    getTags.mockResolvedValue([tag]);
    deleteTag.mockResolvedValue(undefined);
  });

  it('asks first, and keeps the tag when the answer is Cancel', async () => {
    render(<TagsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete tag urgent' }));
    expect(await screen.findByRole('alertdialog', { name: 'Delete urgent?' })).toBeInTheDocument();
    expect(deleteTag).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deleteTag).not.toHaveBeenCalled();
    expect(screen.getByText('urgent')).toBeInTheDocument();
  });

  it('deletes only once confirmed, and shows a failure in the dialog', async () => {
    deleteTag.mockRejectedValueOnce(new Error('Tag is locked'));
    render(<TagsSettings />);
    fireEvent.click(await screen.findByRole('button', { name: 'Delete tag urgent' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete tag' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tag is locked');
    fireEvent.click(screen.getByRole('button', { name: 'Delete tag' }));
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
    expect(deleteTag).toHaveBeenCalledWith('t1');
    expect(screen.queryByText('urgent')).toBeNull();
  });
});
