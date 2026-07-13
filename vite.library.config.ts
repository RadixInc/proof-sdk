import { defineConfig } from 'vite';
import { resolve } from 'path';

// Separate build config for the /library page (issue #15 follow-up: the
// Proof Library redesign). Kept out of vite.config.ts because that config
// pins build.rollupOptions.output.inlineDynamicImports: true for the
// single-chunk embeddable editor bundle — Rollup rejects
// inlineDynamicImports combined with multiple entry points, so this page
// gets its own independent build (default ESM output; it has no
// external-embedding requirement) writing into the same dist/ directory.
export default defineConfig({
  root: 'src',
  base: '/',
  build: {
    outDir: '../dist',
    emptyOutDir: false,
    rollupOptions: {
      input: {
        library: resolve(__dirname, 'src/library.html'),
      },
      output: {
        entryFileNames: 'assets/[name].js',
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name].[ext]',
      },
    },
  },
});
