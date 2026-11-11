import { describe, expect, it } from 'vitest';
import taa from '../../../tests/fixtures/render-taa.json';
import filtering from '../../../tests/fixtures/render-filter.json';
import { computeRender, displayRender, renderPixel } from '../render-engine';
import { renderArtifact } from '../render-model';

const model = renderArtifact(taa)!;
function pixel(frames: ReturnType<typeof computeRender>, frame: number, buffer: string, x = 4, y = 8) {
  const index = model.buffers.findIndex(b => b.id === buffer);
  return renderPixel(frames[frame]![index]!, model, index, x, y);
}

describe('computed rendering', () => {
  it('detects a disoccluded background pixel and rejects stale foreground numerically', () => {
    expect(model).not.toBeNull();
    const frames = computeRender(model);
    expect(pixel(frames, 0, 'color')[0]).toBeCloseTo(.9);
    expect(pixel(frames, 1, 'color')[0]).toBeCloseTo(.08);
    expect(pixel(frames, 1, 'valid')).toEqual([0]);
    expect(pixel(frames, 1, 'naive')[0]).toBeCloseTo(.9 * .85 + .08 * .15);
    expect(pixel(frames, 1, 'resolved')[0]).toBeCloseTo(.08);
    expect(pixel(frames, 1, 'motion', 10)).toEqual([1, 0]);
    expect(pixel(frames, 1, 'valid', 10)).toEqual([1]);
    expect(pixel(frames, 1, 'history', 10)[0]).toBeCloseTo(.9);
  });
  it('recomputes the entire history when parameters change', () => {
    const unchecked = computeRender(model, { threshold: 1 });
    expect(pixel(unchecked, 1, 'valid')).toEqual([1]);
    expect(pixel(unchecked, 1, 'resolved')[0]).toBeCloseTo(pixel(unchecked, 1, 'naive')[0]!);
    const noHistory = computeRender(model, { weight: 0 });
    expect(pixel(noHistory, 5, 'resolved')).toEqual(pixel(noHistory, 5, 'color'));
    const still = computeRender(model, { speed: 0 });
    expect(pixel(still, 5, 'resolved')).toEqual(pixel(still, 0, 'resolved'));
    expect(() => computeRender(model, { weight: 10 })).toThrow('out of range');
    expect(() => computeRender(model, { unknown: 0 })).toThrow('Unknown parameter');
  });
  it('keeps sharpening overshoot in raw buffers, while clipping only the display', () => {
    const filter = renderArtifact(filtering)!;
    const frames = computeRender(filter);
    const sharp = frames[0]![3]!;
    expect(renderPixel(sharp, filter, 3, 11, 8)[0]).toBeCloseTo(.8 + (.8 - (.1 + .8 + .8) / 3));
    expect(renderPixel(sharp, filter, 3, 10, 8)[0]).toBeLessThan(0);
    const display = displayRender(sharp, 1, filter.views[2]!);
    expect(display[(8 * 32 + 11) * 4]).toBe(255);
    expect(display[(8 * 32 + 10) * 4]).toBe(0);
  });
  it('samples prior frames from initial values and clamps nearest-neighbor coordinates', () => {
    const small = { ...filtering, width: 2, height: 1, frames: 3, buffers: [{ id: 'source', label: 'Source', channels: ['V'], initial: [2], values: [['add', ['sample', 'source', 0, -99, 99, 'previous'], 1]] }], views: filtering.views.slice(0, 2).map(v => ({ ...v, buffer: 'source' })) };
    const frames = computeRender(small);
    expect(Array.from(frames[0]![0]!)).toEqual([3, 3]);
    expect(Array.from(frames[2]![0]!)).toEqual([5, 5]);
  });
  it('reports undefined arithmetic and does not evaluate an unused conditional branch', () => {
    const bad = structuredClone(renderArtifact(filtering)!);
    bad.buffers[0]!.values = [['div', 1, 0]];
    expect(() => computeRender(bad)).toThrow('Invalid numerical result');
    bad.buffers[0]!.values = [['if', 1, .5, ['div', 1, 0]]];
    expect(computeRender(bad)[0]![0]![0]).toBe(.5);
  });
  it('converts linear RGB only for display and leaves the source intact', () => {
    const raw = new Float32Array([.0031308, .18, 1]);
    const view = model.views[0]!;
    expect(Array.from(displayRender(raw, 3, view))).toEqual([10, 118, 255, 255]);
    expect(raw[1]).toBeCloseTo(.18);
  });
});
