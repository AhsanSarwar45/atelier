/**
 * A file dropped anywhere over the conversation is attached.
 *
 * The gesture people actually make is aimed at the big target — the transcript —
 * and not at the one line CodeMirror answers for, and a drop nobody catches is
 * a drop the browser answers by leaving the app and opening the file
 * (bw-p4r3.1).
 */
import { fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { FileDropTarget, carriesFiles } from '@/workbench/file-drop';

/** A drag the browser says is carrying files, and the files it hands over. */
function dragging(files: File[], types = ['Files']) {
  return { dataTransfer: { types, files, dropEffect: 'none' } };
}

const A_FILE = new File(['hello'], 'notes.txt', { type: 'text/plain' });

describe('a pane that takes a dropped file', () => {
  it('knows a drag carrying files from one carrying text', () => {
    expect(carriesFiles({ types: ['Files'] } as unknown as DataTransfer)).toBe(true);
    expect(carriesFiles({ types: ['text/plain'] } as unknown as DataTransfer)).toBe(false);
    expect(carriesFiles(null)).toBe(false);
  });

  it('hands over what was dropped on it, wherever inside it that was', () => {
    const took = vi.fn();
    render(
      <FileDropTarget onFiles={took}>
        <p data-testid="transcript">the conversation</p>
      </FileDropTarget>,
    );

    fireEvent.drop(screen.getByTestId('transcript'), dragging([A_FILE]));
    expect(took).toHaveBeenCalledTimes(1);
    expect(took.mock.calls[0][0]).toEqual([A_FILE]);
  });

  it('says it will take the file while the file is over it', () => {
    render(<FileDropTarget onFiles={vi.fn()}><p>rows</p></FileDropTarget>);
    const pane = screen.getByTestId('file-drop');

    expect(screen.queryByTestId('file-drop-veil')).toBeNull();
    fireEvent.dragEnter(pane, dragging([A_FILE]));
    expect(screen.getByTestId('file-drop-veil')).toBeTruthy();
    fireEvent.dragLeave(pane, dragging([A_FILE]));
    expect(screen.queryByTestId('file-drop-veil')).toBeNull();
  });

  it('keeps saying so while the file crosses the rows inside it', () => {
    render(
      <FileDropTarget onFiles={vi.fn()}>
        <p data-testid="row">a row</p>
      </FileDropTarget>,
    );
    const pane = screen.getByTestId('file-drop');
    const row = screen.getByTestId('row');

    // The enter for the row arrives before the leave for the pane's own edge,
    // which is why the veil is counted rather than switched.
    fireEvent.dragEnter(pane, dragging([A_FILE]));
    fireEvent.dragEnter(row, dragging([A_FILE]));
    fireEvent.dragLeave(pane, dragging([A_FILE]));
    expect(screen.getByTestId('file-drop-veil')).toBeTruthy();

    fireEvent.drop(row, dragging([A_FILE]));
    expect(screen.queryByTestId('file-drop-veil')).toBeNull();
  });

  it('lets the browser have a drag that carries no files', () => {
    const took = vi.fn();
    render(<FileDropTarget onFiles={took}><p>rows</p></FileDropTarget>);
    const pane = screen.getByTestId('file-drop');

    fireEvent.dragEnter(pane, dragging([], ['text/plain']));
    expect(screen.queryByTestId('file-drop-veil')).toBeNull();
    fireEvent.drop(pane, dragging([], ['text/plain']));
    expect(took).not.toHaveBeenCalled();
  });

  it('leaves alone a drop the writing box already took', () => {
    const took = vi.fn();
    render(
      <FileDropTarget onFiles={took}>
        {/* Stands in for CodeMirror, which answers the drop on its own content
            and prevents the default before the event reaches the pane. */}
        <p data-testid="box" onDrop={(event) => event.preventDefault()}>the box</p>
      </FileDropTarget>,
    );

    fireEvent.drop(screen.getByTestId('box'), dragging([A_FILE]));
    expect(took).not.toHaveBeenCalled();
  });

  it('takes nothing while another program holds the chat', () => {
    const took = vi.fn();
    render(
      <FileDropTarget onFiles={took} disabled>
        <p data-testid="held">held elsewhere</p>
      </FileDropTarget>,
    );

    fireEvent.drop(screen.getByTestId('held'), dragging([A_FILE]));
    expect(took).not.toHaveBeenCalled();
    expect(screen.queryByTestId('file-drop')).toBeNull();
  });
});
