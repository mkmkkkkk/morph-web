import Fastify from 'fastify';
import cors from '@fastify/cors';
import rateLimit from '@fastify/rate-limit';
import { authMiddleware, generateToken, verifyToken, newAccountId } from './auth.js';
import {
  createAuthRequest, getAuthRequest, approveAuthRequest,
  createOrGetSession, listSessions, getSession, addSessionMessage,
  upsertMachine, listMachines,
  setVendorToken, getVendorToken,
  setSessionMachine,
} from './store.js';

export function buildServer(socketIO) {
  const app = Fastify({ logger: false });

  app.register(cors, { origin: '*', credentials: true });
  app.register(rateLimit, { max: 60, timeWindow: '1 minute' });

  // Health check (no auth)
  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  // ─── Auth ───

  app.post('/v1/auth/request', async (request, reply) => {
    const { publicKey, supportsV2 } = request.body || {};
    if (!publicKey) return reply.code(400).send({ error: 'publicKey required' });

    const existing = getAuthRequest(publicKey);
    if (existing && existing.state === 'authorized') {
      return { state: 'authorized', token: existing.token, response: existing.response };
    }

    if (!existing) {
      createAuthRequest(publicKey);
    }

    // If static token is configured, auto-approve immediately
    if (process.env.STATIC_TOKEN) {
      const token = process.env.STATIC_TOKEN;
      approveAuthRequest(publicKey, token, null);
      return { state: 'authorized', token, response: null };
    }

    return { state: 'pending' };
  });

  // Approve auth request (called by daemon side)
  app.post('/v1/auth/approve', { preHandler: authMiddleware }, async (request, reply) => {
    const { publicKey, response } = request.body || {};
    if (!publicKey) return reply.code(400).send({ error: 'publicKey required' });

    const token = generateToken(newAccountId());
    approveAuthRequest(publicKey, token, response || null);
    return { ok: true };
  });

  // ─── Sessions ───

  app.post('/v1/sessions', { preHandler: authMiddleware }, async (request) => {
    const { tag, metadata, agentState, dataEncryptionKey } = request.body || {};
    const { session } = createOrGetSession(tag, metadata, agentState, dataEncryptionKey, request.accountId);
    return { session };
  });

  app.get('/v1/sessions', { preHandler: authMiddleware }, async (request) => {
    const limit = parseInt(request.query.limit) || 100;
    const sessions = listSessions(request.accountId, limit);
    return { sessions };
  });

  app.get('/v1/sessions/:id', { preHandler: authMiddleware }, async (request, reply) => {
    const session = getSession(request.params.id);
    if (!session) return reply.code(404).send({ error: 'Session not found' });
    return { session };
  });

  app.post('/v1/sessions/:id/messages', { preHandler: authMiddleware }, async (request) => {
    const sessionId = request.params.id;
    const { messages } = request.body || {};
    if (!messages || !Array.isArray(messages)) return { ok: true };

    for (const msg of messages) {
      const { id: msgId, seq } = addSessionMessage(sessionId, msg);

      // Push via Socket.IO to session subscribers
      if (socketIO) {
        socketIO.to(`session:${sessionId}`).emit('update', {
          id: msgId,
          seq,
          body: {
            t: 'new-message',
            sid: sessionId,
            message: { id: msgId, seq, content: { t: 'encrypted', c: msg } },
          },
          createdAt: Date.now(),
        });
      }
    }
    return { ok: true };
  });

  // ─── Machines ───

  app.post('/v1/machines', { preHandler: authMiddleware }, async (request) => {
    const { id, metadata, daemonState, dataEncryptionKey } = request.body || {};
    const machine = upsertMachine(id, metadata, daemonState, dataEncryptionKey, request.accountId);
    return { machine };
  });

  app.get('/v1/machines', { preHandler: authMiddleware }, async (request) => {
    const machines = listMachines(request.accountId);
    return { machines };
  });

  // ─── Vendor Tokens (optional) ───

  app.post('/v1/connect/:vendor/register', { preHandler: authMiddleware }, async (request) => {
    const { vendor } = request.params;
    const { token } = request.body || {};
    setVendorToken(request.accountId, vendor, token);
    return { ok: true };
  });

  app.get('/v1/connect/:vendor/token', { preHandler: authMiddleware }, async (request) => {
    const token = getVendorToken(request.accountId, request.params.vendor);
    return { token };
  });

  // ─── Push Tokens (stub) ───

  app.get('/v1/push-tokens', { preHandler: authMiddleware }, async () => {
    return { tokens: [] };
  });

  // ─── Session-Machine binding ───
  // When daemon creates a session, it should also bind it to its machine
  app.post('/v1/sessions/:id/machine', { preHandler: authMiddleware }, async (request) => {
    const { machineId } = request.body || {};
    if (!machineId) return { error: 'machineId required' };
    setSessionMachine(request.params.id, machineId);
    return { ok: true };
  });

  return app;
}
