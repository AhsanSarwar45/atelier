import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { RenderView } from '../render-view';
import { renderArtifact } from '../render-model';
import fixture from '../../../tests/fixtures/render-filter.json';

class FakeWorker {
  static instances: FakeWorker[] = [];
  onmessage?: (event: { data: unknown }) => void;
  onerror?: () => void;
  postMessage = vi.fn();
  terminate = vi.fn();
  constructor() { FakeWorker.instances.push(this); }
}
beforeEach(() => { FakeWorker.instances = []; vi.stubGlobal('Worker', FakeWorker); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); vi.useRealTimers(); });
it('terminates superseded work and ignores late results, then recovers from an error', () => {
  const view = render(<RenderView artifact={renderArtifact(fixture)!} />);
  const first = FakeWorker.instances[0]!;
  fireEvent.change(screen.getByRole('slider', { name: 'Sharpening amount' }), { target: { value: '2' } });
  expect(first.terminate).toHaveBeenCalled();
  act(() => first.onmessage?.({ data: { error: 'Stale computation' } }));
  expect(screen.queryByText('Stale computation')).toBeNull();
  const second = FakeWorker.instances.at(-1)!;
  act(() => second.onmessage?.({ data: { error: 'Non-finite result' } }));
  expect(screen.getByRole('alert').textContent).toBe('Non-finite result');
  fireEvent.click(screen.getByRole('button', { name: 'Reset parameters' }));
  expect(screen.queryByRole('alert')).toBeNull();
  const last = FakeWorker.instances.at(-1)!;
  expect(last).not.toBe(second);
  view.unmount();
  expect(last.terminate).toHaveBeenCalled();
});
it('terminates timed-out work and ignores a queued late response', () => {
  vi.useFakeTimers();
  render(<RenderView artifact={renderArtifact(fixture)!} />);
  const worker = FakeWorker.instances[0]!;
  act(() => vi.advanceTimersByTime(10000));
  expect(worker.terminate).toHaveBeenCalled();
  expect(screen.getByRole('alert').textContent).toContain('timed out');
  act(() => worker.onmessage?.({ data: { error: 'Late response' } }));
  expect(screen.getByRole('alert').textContent).toContain('timed out');
});
