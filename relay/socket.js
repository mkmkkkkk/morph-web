import { Server } from 'socket.io';
import { randomUUID } from 'crypto';
import { verifyToken } from './auth.js';
import {
  updateSessionMetadata, updateSessionState,
  updateMachineMetadata, updateMachineState,
  getSessionMachine, getSessionsForMachine,
  setSessionMachine, addSessionMessage,
} from './store.js';

// In-memory state for alive tracking
const sessionAlive = new Map();   // sid → { time, thinking, mode }
const machineAlive = new Map();   // machineId → { time }

// RPC handler registry: method → socket
const rpcHandlers = new Map();

export function setupSocketIO(httpServer) {
  const io = new Server(httpServer, {
    path: '/v1/updates',
    transports: ['websocket'],
    pingTimeout: 45000,
    pingInterval: 15000,
    cors: { origin: ['https://morph.mkyang.ai', 'http://localhost:5173', 'http://localhost:4173'], credentials: true },
  });

  // ─── Auth middleware ───
  io.use((socket, next) => {
    const { clientType, sessionId, machineId } = socket.handshake.auth;
    // Accept token from query params first (allows proxy to rewrite it in the upgrade URL)
    // then fall back to socket.io auth packet
    const token = socket.handshake.query?.token || socket.handshake.auth.token;

    const result = verifyToken(token);
    if (!result) return next(new Error('Unauthorized'));

    socket.data.accountId = result.accountId;
    socket.data.clientType = clientType;
    socket.data.sessionId = sessionId;
    socket.data.machineId = machineId;

    // Join appropriate rooms
    if (clientType === 'session-scoped' && sessionId) {
      socket.join(`session:${sessionId}`);
    }
    if (clientType === 'machine-scoped' && machineId) {
      socket.join(`machine:${machineId}`);
      // Also join all session rooms that belong to this machine
      const sessionIds = getSessionsForMachine(machineId);
      for (const sid of sessionIds) {
        socket.join(`session:${sid}`);
      }
    }

    next();
  });

  io.on('connection', (socket) => {
    const { clientType, machineId, sessionId } = socket.data;
    console.log(`[relay] ${clientType} connected: ${machineId || sessionId || 'unknown'}`);

    // ─── Message relay (session-scoped → machine-scoped) ───
    socket.on('message', (data) => {
      const sid = data.sid;
      const msgId = randomUUID();
      const update = {
        id: msgId,
        seq: Date.now(), // monotonic enough for personal use
        body: {
          t: 'new-message',
          sid,
          message: {
            id: msgId,
            seq: Date.now(),
            content: { t: 'encrypted', c: data.message },
          },
        },
        createdAt: Date.now(),
      };

      // Broadcast to all in session room (except sender)
      socket.to(`session:${sid}`).emit('update', update);

      // Also forward to the machine that owns this session
      const mid = getSessionMachine(sid);
      if (mid) {
        io.to(`machine:${mid}`).emit('update', update);
      }
    });

    // ─── Update relay (machine-scoped → session-scoped) ───
    socket.on('update', (data) => {
      if (data.body?.sid) {
        socket.to(`session:${data.body.sid}`).emit('update', data);
      }
    });

    // ─── Session metadata update (with ack) ───
    socket.on('update-metadata', async (data, callback) => {
      const { sid, expectedVersion, metadata } = data;
      const result = updateSessionMetadata(sid, expectedVersion, metadata);

      if (result.versionMismatch) {
        if (typeof callback === 'function') {
          callback({ result: 'version-mismatch', metadata: result.currentMetadata, version: result.currentVersion });
        }
        return;
      }

      if (typeof callback === 'function') {
        callback({ result: 'success', metadata, version: result.newVersion });
      }

      // Broadcast to session subscribers
      socket.to(`session:${sid}`).emit('update', {
        id: randomUUID(),
        body: {
          t: 'update-session',
          sid,
          metadata: { value: metadata, version: result.newVersion },
        },
        createdAt: Date.now(),
      });
    });

    // ─── Session state update (with ack) ───
    socket.on('update-state', async (data, callback) => {
      const { sid, expectedVersion, agentState } = data;
      const result = updateSessionState(sid, expectedVersion, agentState);

      if (result.versionMismatch) {
        if (typeof callback === 'function') {
          callback({ result: 'version-mismatch', agentState: result.currentState, version: result.currentVersion });
        }
        return;
      }

      if (typeof callback === 'function') {
        callback({ result: 'success', agentState, version: result.newVersion });
      }

      socket.to(`session:${sid}`).emit('update', {
        id: randomUUID(),
        body: {
          t: 'update-session',
          sid,
          agentState: { value: agentState, version: result.newVersion },
        },
        createdAt: Date.now(),
      });
    });

    // ─── Machine metadata update (with ack) ───
    socket.on('machine-update-metadata', async (data, callback) => {
      const { machineId: mid, metadata, expectedVersion } = data;
      const result = updateMachineMetadata(mid, expectedVersion, metadata);

      if (result.versionMismatch) {
        if (typeof callback === 'function') {
          callback({ result: 'version-mismatch', metadata: result.currentMetadata, version: result.currentVersion });
        }
        return;
      }

      if (typeof callback === 'function') {
        callback({ result: 'success', metadata, version: result.newVersion });
      }

      io.to(`machine:${mid}`).emit('update', {
        id: randomUUID(),
        body: { t: 'update-machine', machineId: mid, metadata: { value: metadata, version: result.newVersion } },
        createdAt: Date.now(),
      });
    });

    // ─── Machine state update (with ack) ───
    socket.on('machine-update-state', async (data, callback) => {
      const { machineId: mid, daemonState, expectedVersion } = data;
      const result = updateMachineState(mid, expectedVersion, daemonState);

      if (result.versionMismatch) {
        if (typeof callback === 'function') {
          callback({ result: 'version-mismatch', daemonState: result.currentState, version: result.currentVersion });
        }
        return;
      }

      if (typeof callback === 'function') {
        callback({ result: 'success', daemonState, version: result.newVersion });
      }

      io.to(`machine:${mid}`).emit('update', {
        id: randomUUID(),
        body: { t: 'update-machine', machineId: mid, daemonState: { value: daemonState, version: result.newVersion } },
        createdAt: Date.now(),
      });
    });

    // ─── Keep-alive ───
    socket.on('session-alive', (data) => {
      sessionAlive.set(data.sid, { time: data.time, thinking: data.thinking, mode: data.mode });
      socket.to(`session:${data.sid}`).emit('session-alive', data);
    });

    socket.on('machine-alive', (data) => {
      machineAlive.set(data.machineId, { time: data.time });
    });

    socket.on('session-end', (data) => {
      io.to(`session:${data.sid}`).emit('session-end', data);
      sessionAlive.delete(data.sid);
    });

    // ─── RPC system ───
    socket.on('rpc-register', (data) => {
      const method = `${socket.data.accountId}:${data.method}`;
      rpcHandlers.set(method, socket);
      console.log(`[relay] RPC registered: ${method}`);
    });

    socket.on('rpc-request', (data, callback) => {
      const method = `${socket.data.accountId}:${data.method}`;
      const handler = rpcHandlers.get(method);
      if (handler && handler.connected) {
        handler.emit('rpc-request', data, callback);
      } else if (typeof callback === 'function') {
        callback(JSON.stringify({ error: 'No handler registered for ' + data.method }));
      }
    });

    // ─── Ping ───
    socket.on('ping', (callback) => {
      if (typeof callback === 'function') callback();
    });

    // ─── Subscribe to session (dynamic room join) ───
    socket.on('subscribe', (data) => {
      if (data.sid) {
        socket.join(`session:${data.sid}`);
        // Bind session to machine if this is a machine-scoped client
        if (socket.data.clientType === 'machine-scoped' && socket.data.machineId) {
          setSessionMachine(data.sid, socket.data.machineId);
        }
      }
    });

    // ─── Cleanup on disconnect ───
    socket.on('disconnect', () => {
      console.log(`[relay] ${clientType} disconnected: ${machineId || sessionId || 'unknown'}`);
      // Clean up RPC handlers registered by this socket
      for (const [key, handler] of rpcHandlers) {
        if (handler === socket) rpcHandlers.delete(key);
      }
    });
  });

  return io;
}
