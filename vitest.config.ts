import { resolve } from 'path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

import { display } from './scripts/product-name.js';

export default defineConfig({
  plugins: [react()],
  // The screens read the product's name from the build rather than typing it.
  // The real build hands it over in `next.config.js`; the tests hand over the
  // same value, read from the same file, so a test never sees an empty name.
  define: {
    'process.env.NEXT_PUBLIC_PRODUCT_NAME': JSON.stringify(display),
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    // A separate copy of the work carries its own tests and its own node_modules;
    // sweeping one in reports hundreds of failures in files nobody is working on.
    // Both spellings, because copies are cut under `worktrees/` here.
    exclude: ['**/node_modules/**', 'tests/**', '**/.worktrees/**', '**/worktrees/**'],
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
