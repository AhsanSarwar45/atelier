import { describe, expect, it } from 'vitest';
import { canonicalArtifact, visualArtifact } from '../visual-artifacts';

const fixtures = {
  mermaid: { version: 1, kind: 'mermaid', title: 'Request', source: 'sequenceDiagram\nA->>B: hello' },
  flow: { version: 1, kind: 'flow', title: 'Pipeline', nodes: [{ id: 'a', label: 'Input' }, { id: 'b', label: 'Output' }], edges: [{ id: 'ab', from: 'a', to: 'b', animated: true }] },
  scene: { version: 1, kind: 'scene', title: 'Orbit', viewBox: [0, 0, 400, 240], elements: [{ id: 'dot', type: 'circle', cx: 40, cy: 120, r: 12, fill: '#38bdf8' }], states: [{ id: 'start', label: 'Start', changes: [{ element: 'dot', x: 0 }] }, { id: 'finish', label: 'Finish', changes: [{ element: 'dot', x: 300, scale: 1.5 }] }] },
  mockup: { version: 1, kind: 'mockup', title: 'Checkout', initialScreen: 'cart', screens: [{ id: 'cart', title: 'Cart', components: [{ id: 'next', type: 'button', text: 'Pay', action: { type: 'navigate', screen: 'paid' } }] }, { id: 'paid', title: 'Done', components: [{ id: 'message', type: 'heading', text: 'Paid' }] }] },
} as const;

describe('visual artifact contract', () => {
  it.each(Object.entries(fixtures))('accepts a valid %s artifact', (_kind, value) => expect(visualArtifact(value)).toEqual(value));
  it('canonicalizes objects independently of input field order', () => {
    expect(canonicalArtifact(fixtures.mermaid)).toBe('{"kind":"mermaid","source":"sequenceDiagram\\nA->>B: hello","title":"Request","version":1}\n');
  });
  it('refuses executable fields, broken references, and unsafe element types', () => {
    expect(visualArtifact({ ...fixtures.mermaid, script: 'alert(1)' })).toBeNull();
    expect(visualArtifact({ ...fixtures.flow, edges: [{ id: 'x', from: 'a', to: 'missing' }] })).toBeNull();
    expect(visualArtifact({ ...fixtures.scene, elements: [{ id: 'x', type: 'script', text: 'bad' }] })).toBeNull();
    expect(visualArtifact({ ...fixtures.mockup, screens: [{ id: 'cart', title: 'Cart', components: [{ id: 'x', type: 'button', action: { type: 'navigate', screen: 'missing' } }] }] })).toBeNull();
  });
});
