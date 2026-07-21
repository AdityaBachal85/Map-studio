import { defineConfig } from 'vite';
import { viteSingleFile } from 'vite-plugin-singlefile';

/**
 * Vite config for DBOT Map Studio.
 *
 * - Root `index.html` is the app entry. During migration (Phases 4–5) it is the
 *   v4.96 single-file app, progressively converted to ES-module imports; the
 *   untouched original is preserved in `legacy/` as the rollback.
 * - `viteSingleFile()` inlines the bundled JS (the export engine + pptxgenjs +
 *   jszip) into one self-contained `dist/index.html`, so the built app keeps the
 *   "just open the HTML file" workflow and also deploys as a single file to
 *   Cloudflare Pages / GitHub Pages. External CDN libs (Leaflet, html2canvas)
 *   stay as network `<script>`s, exactly as before.
 * - `base: './'` keeps asset URLs relative for any hosting path.
 */
export default defineConfig({
  base: './',
  plugins: [viteSingleFile()],
  build: {
    outDir: 'dist',
    target: 'es2020',
    sourcemap: false,
  },
  server: {
    port: 5173,
    open: false,
  },
});
