import { defineConfig } from 'vite';
import { resolve } from 'path';

export default defineConfig({
  root: 'src',
  publicDir: resolve(__dirname, 'public'),
  base: '/',
  define: {
    // import.meta.env isn't usable in the iife build (see telemetry.ts) —
    // inject the version as a plain build-time constant instead.
    __PROOF_APP_VERSION__: JSON.stringify(process.env.VITE_APP_VERSION ?? 'dev'),
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // IIFE keeps the bundle easy to embed in external hosts.
    modulePreload: false,
    rollupOptions: {
      input: {
        editor: resolve(__dirname, 'src/index.html'),
      },
      output: {
        // Keep filenames predictable for external embedding
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name].js',
        assetFileNames: 'assets/[name].[ext]',
        // Use IIFE format for broad runtime compatibility
        format: 'iife',
        // Ensure window.proof is accessible globally
        name: 'ProofEditor',
        inlineDynamicImports: true
      }
    },
  },
  server: {
    port: 3000,
    strictPort: true,  // Fail if port in use instead of auto-incrementing
    open: false,
    host: 'localhost',
    proxy: {
      '/assets': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/d': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/new': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/get-started': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/agent-docs': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/open': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/logout': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/proof.SKILL.md': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/snapshots': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
      '/ws': {
        target: 'ws://localhost:8787',
        ws: true,
      },
    },
  },
});
