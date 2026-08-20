import '@testing-library/jest-dom/vitest';

// jsdom has no layout, so it ships none of the browser's ways of hearing that
// something changed size. A screen that watches its own panes needs one to
// exist; nothing here has a size to report, so it reports nothing.
if (!('ResizeObserver' in globalThis)) {
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
  };
}
