import { computeRender } from './render-engine';

self.onmessage = (event: MessageEvent) => {
  try {
    const frames = computeRender(event.data.model, event.data.parameters);
    self.postMessage({ frames }, { transfer: frames.flat().map(data => data.buffer) });
  } catch (error) {
    self.postMessage({ error: error instanceof Error ? error.message : 'Rendering failed.' });
  }
};
