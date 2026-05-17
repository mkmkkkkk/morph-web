import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
  define: {
    // Stable per-build hash for canvas.html cache-busting — prevents re-download on every page load
    __BUILD_TIME__: JSON.stringify(Date.now().toString(36)),
  },
  plugins: [
    react(),
    {
      name: 'no-cache-public',
      configureServer(server) {
        server.middlewares.use((req, res, next) => {
          if (req.url?.startsWith('/canvas.html')) {
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
          }
          next();
        });
      },
    },
    // Perf #2: inject <link rel="modulepreload"> for the hashed entry chunk
    // right after <title>. The <script type=module> at end-of-body already
    // triggers fetch when parsed, but a preload tag near top-of-head wins ~150ms
    // by starting the fetch before the rest of <head> parses.
    {
      name: 'inject-entry-modulepreload',
      enforce: 'post',
      transformIndexHtml: {
        order: 'post',
        handler(html, ctx) {
          const bundle = (ctx as any).bundle as Record<string, any> | undefined;
          if (!bundle) return html;
          const entry = Object.values(bundle).find((c: any) =>
            c.type === 'chunk' && c.isEntry && c.fileName?.startsWith('assets/'),
          ) as any;
          if (!entry) return html;
          const tag = `<link rel="modulepreload" crossorigin href="/${entry.fileName}">`;
          return html.replace('</title>', `</title>\n  ${tag}`);
        },
      },
    },
  ],
  server: {
    host: '0.0.0.0',
    allowedHosts: ['morph.mkyang.ai'],
    proxy: {
      // 2026-05-16 fix: port 3000 = Docker claude-sandbox (no HTTP service, just
      // `tail -f /dev/null`). All /v1 routes (auth/sessions/machines/drafts) live
      // in morph/relay/server.js on PM2 morph-relay port 3001.
      '/v1': { target: 'http://127.0.0.1:3001', ws: true, changeOrigin: true },
      '/v2': { target: 'http://127.0.0.1:3001', changeOrigin: true },
    },
  },
});
