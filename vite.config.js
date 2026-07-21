import { defineConfig } from 'vite';

/**
 * Vite config for DBOT Map Studio.
 *
 * - Root `index.html` is the app entry. During migration (Phases 4–5) it is the
 *   v4.9 single-file app, progressively converted to ES-module imports; the
 *   untouched original is preserved in `legacy/` as the rollback.
 * - `base: './'` produces relative asset URLs so the built site works when
 *   served from any path — including a Cloudflare Pages project subpath.
 * - The export engine (`js/export/*`) and its deps (pptxgenjs, jszip) are
 *   plain ES modules that Vite bundles for the browser with no extra config.
 */
export default defineConfig({
  base: './',
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: true,
    // Keep the legacy rollback out of the production build.
    rollupOptions: {},
  },
  server: {
    port: 5173,
    open: false,
  },
});
