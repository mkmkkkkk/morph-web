import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

export default defineConfig({
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
  ],
  server: {
    host: '0.0.0.0',
    allowedHosts: ['morph.mkyang.ai'],
    proxy: {
      '/v1': { target: 'http://127.0.0.1:3001', ws: true, changeOrigin: true },
      '/v2': { target: 'http://127.0.0.1:3001', changeOrigin: true },
    },
  },
});
