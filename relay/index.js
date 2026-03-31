import 'dotenv/config';
import { createServer } from 'http';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { initStore } from './store.js';
import { buildServer } from './server.js';
import { setupSocketIO } from './socket.js';
import { registerClaudeAPI } from './claude.js';
import { buildProxyEnvs, createProxy } from './proxy.js';
import { verifyToken } from './auth.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

const PORT = parseInt(process.env.PORT) || 3000;
const DB_PATH = process.env.DB_PATH || './data/relay.db';

// 1. Init SQLite
console.log(`[relay] Initializing database at ${DB_PATH}`);
initStore(DB_PATH);

// 2. Create HTTP server first (Socket.IO needs it)
const httpServer = createServer();

// 3. Attach Socket.IO to the HTTP server
const io = setupSocketIO(httpServer);

// 4. Build Fastify app once with io reference
const app = buildServer(io);

// 4b. Register v2 Claude direct API
const { authMiddleware } = await import('./auth.js');
registerClaudeAPI(app, io, authMiddleware);

// 4c. Serve web frontend static files (SPA fallback)
const webDistPath = resolve(__dirname, '../web/dist');
const fastifyStatic = await import('@fastify/static');
app.register(fastifyStatic.default, {
  root: webDistPath,
  prefix: '/',
  wildcard: true,
});
// SPA fallback: non-API routes → index.html
app.setNotFoundHandler((req, reply) => {
  if (req.url.startsWith('/v1/') || req.url.startsWith('/v2/')) {
    reply.code(404).send({ error: 'Not Found' });
  } else {
    reply.sendFile('index.html');
  }
});

await app.ready();

// 5. Set up transparent proxy for secondary relay environments
const proxyEnvs = buildProxyEnvs();
const proxy = createProxy(proxyEnvs);

if (proxyEnvs.size > 0) {
  console.log(`[relay] Proxy enabled for envs: ${[...proxyEnvs.keys()].join(', ')}`);

  // Must prepend so proxy intercepts upgrades before socket.io
  httpServer.prependListener('upgrade', (req, socket, _head) => {
    if (!req.url?.startsWith('/relay-proxy/')) return;
    // Auth: accept token from query param (proxy-rewritten) or Authorization header
    const qs = req.url.includes('?') ? req.url.split('?')[1] : '';
    const qToken = new URLSearchParams(qs).get('token') || '';
    const hToken = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (!verifyToken(qToken || hToken)) {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    proxy.handleUpgrade(req, socket, _head);
  });
}

// 6. Route HTTP requests — proxy first, then Fastify
httpServer.on('request', (req, res) => {
  if (proxyEnvs.size > 0 && req.url?.startsWith('/relay-proxy/')) {
    const token = (req.headers['authorization'] || '').replace(/^Bearer\s+/i, '');
    if (!verifyToken(token)) { res.writeHead(401); res.end('Unauthorized'); return; }
    if (proxy.handleRequest(req, res)) return;
  }
  app.routing(req, res);
});

// 6. Start
httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[relay] Morph Relay Server running on port ${PORT}`);
  console.log(`[relay] REST API v1: http://0.0.0.0:${PORT}/v1/ (Happy compat)`);
  console.log(`[relay] REST API v2: http://0.0.0.0:${PORT}/v2/claude/ (direct)`);
  console.log(`[relay] Socket.IO: ws://0.0.0.0:${PORT}/v1/updates`);
  if (process.env.STATIC_TOKEN) {
    console.log(`[relay] Static token auth enabled`);
  }
});
