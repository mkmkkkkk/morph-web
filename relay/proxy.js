/**
 * relay/proxy.js — transparent HTTP + WebSocket proxy for secondary relay environments
 *
 * Intercepts /relay-proxy/:envId/* requests and forwards them to the target relay.
 * Auth token is replaced with the target relay's token server-side.
 * Browser never sees any URL other than morph.mkyang.ai.
 */

import { request as httpsRequest } from 'https';
import { request as httpRequest } from 'http';

/**
 * Rewrite ?token=X to the env's token in a target path.
 * This allows proxy to swap auth token in WebSocket upgrade URL query params.
 */
function rewriteToken(targetPath, token) {
  const qIdx = targetPath.indexOf('?');
  if (qIdx < 0) return targetPath;
  const path = targetPath.slice(0, qIdx);
  const params = new URLSearchParams(targetPath.slice(qIdx + 1));
  if (params.has('token')) params.set('token', token);
  return path + '?' + params.toString();
}

/**
 * Parse /relay-proxy/:envId/...rest?query from a request URL.
 * Returns { env, targetPath } or null if no match.
 */
function parseProxy(reqUrl, proxyEnvs) {
  const qIdx = reqUrl.indexOf('?');
  const pathPart = qIdx >= 0 ? reqUrl.slice(0, qIdx) : reqUrl;
  const query = qIdx >= 0 ? reqUrl.slice(qIdx) : '';
  const m = pathPart.match(/^\/relay-proxy\/([^/]+)(\/.*)?$/);
  if (!m) return null;
  const env = proxyEnvs.get(m[1]);
  if (!env) return null;
  return { env, targetPath: (m[2] || '/') + query };
}

/**
 * Build a proxyEnvs Map from RELAY_ENVS env var.
 */
export function buildProxyEnvs() {
  const map = new Map();
  try {
    const envs = JSON.parse(process.env.RELAY_ENVS || '[]');
    for (const e of envs) {
      if (e.id && e.relayUrl) map.set(e.id, { relayUrl: e.relayUrl, token: e.token || '' });
    }
  } catch {}
  return map;
}

/**
 * Returns { handleRequest, handleUpgrade } for use in index.js.
 */
export function createProxy(proxyEnvs) {
  function makeReqOptions(env, method, targetPath, headers) {
    const target = new URL(env.relayUrl);
    return {
      fn: target.protocol === 'https:' ? httpsRequest : httpRequest,
      opts: {
        hostname: target.hostname,
        port: target.port || (target.protocol === 'https:' ? 443 : 80),
        path: targetPath,
        method,
        headers: {
          ...headers,
          host: target.hostname,
          authorization: `Bearer ${env.token}`,
        },
      },
    };
  }

  return {
    /** Call in httpServer 'request' handler. Returns true if handled. */
    handleRequest(req, res) {
      const p = parseProxy(req.url, proxyEnvs);
      if (!p) return false;
      const { fn, opts } = makeReqOptions(p.env, req.method, rewriteToken(p.targetPath, p.env.token), req.headers);
      const proxyReq = fn(opts, proxyRes => {
        res.writeHead(proxyRes.statusCode, proxyRes.headers);
        proxyRes.pipe(res);
      });
      proxyReq.on('error', () => { try { res.writeHead(502); res.end('proxy error'); } catch {} });
      req.pipe(proxyReq);
      return true;
    },

    /** Call in httpServer 'upgrade' handler. Returns true if handled. */
    handleUpgrade(req, socket, head) {
      const p = parseProxy(req.url, proxyEnvs);
      if (!p) return false;
      const { fn, opts } = makeReqOptions(p.env, 'GET', rewriteToken(p.targetPath, p.env.token), req.headers);
      const proxyReq = fn(opts);
      proxyReq.on('upgrade', (proxyRes, proxySocket) => {
        const statusLine = 'HTTP/1.1 101 Switching Protocols';
        const headers = Object.entries(proxyRes.headers).map(([k, v]) => `${k}: ${v}`).join('\r\n');
        socket.write(`${statusLine}\r\n${headers}\r\n\r\n`);
        proxySocket.pipe(socket);
        socket.pipe(proxySocket);
        socket.on('error', () => proxySocket.destroy());
        proxySocket.on('error', () => socket.destroy());
      });
      proxyReq.on('error', () => socket.destroy());
      proxyReq.end();
      return true;
    },
  };
}
