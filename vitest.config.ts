import { resolve } from 'path';

import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [react()],
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
