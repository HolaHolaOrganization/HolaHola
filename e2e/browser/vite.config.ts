import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

const repo = path.resolve(import.meta.dirname, '..', '..');

// Builds only the browser harness, with the app's own aliases, into dist-e2e/.
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(repo, 'client', 'src'),
      '@shared': path.resolve(repo, 'shared'),
      '@assets': path.resolve(repo, 'attached_assets'),
    },
  },
  root: path.resolve(import.meta.dirname, 'harness'),
  build: {
    outDir: path.resolve(repo, 'dist-e2e'),
    emptyOutDir: true,
    target: 'es2020',
  },
  logLevel: 'warn',
});
