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

// The same gap, and the same answer: with no layout there is nothing to scroll
// and no scrolling to do it with. A screen that keeps the name of the column
// you are on in sight asks for this, and on a bench with no viewport the honest
// answer is to do nothing rather than to throw (bw-zkh4.11).
if (typeof Element !== 'undefined' && !Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = function scrollIntoView() {};
}

// The third gap of the same kind. CodeMirror measures where a line landed by
// asking a Range for its rectangles, and jsdom's Range answers only with
// `getBoundingClientRect`. Without this the editor's measure pass throws on
// every mount — caught by CodeMirror, so nothing fails, but each test prints a
// stack that is about jsdom rather than about the code under it (bw-g3o3.17).
if (typeof Range !== 'undefined' && !Range.prototype.getClientRects) {
  Range.prototype.getClientRects = function getClientRects() {
    return Object.assign([], { item: () => null }) as unknown as DOMRectList;
  };
}
