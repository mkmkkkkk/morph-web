/**
 * Direct connection to morph-relay v2 Claude API.
 *
 * No Happy daemon, no encryption, no QR pairing.
 * Just: relay spawns Claude → stdout streams via Socket.IO → phone renders.
 */

import React, { createContext, useContext, useRef, useState, useCallback, useEffect } from 'react';
import { io, Socket } from 'socket.io-client';
import { getSetting } from './settings';
import type { SessionMessage, MessageContent } from './protocol';

// Re-export ConnectionContextValue interface (same shape as Happy version)
export interface ConnectionContextValue {
  connectionState: 'disconnected' | 'connecting' | 'connected' | 'error';
  connected: boolean;
  sessionId: string | null;
  credentials: null;
  lastError: string | null;
  connect: () => Promise<void>;
  disconnect: () => void;
  sendMessage: (text: string) => void;
  sendInterrupt: () => void;
  onSessionMessage: (handler: (msg: SessionMessage) => void) => () => void;
  connectionRef: React.MutableRefObject<any>;
  // v2-only
  sessions: { id: string; size: number; updatedAt: number }[];
  refreshSessions: () => Promise<void>;
  resumeSession: (sessionId: string) => Promise<void>;
}

const DirectConnectionContext = createContext<ConnectionContextValue | null>(null);

export function useConnection() {
  const ctx = useContext(DirectConnectionContext);
  if (!ctx) throw new Error('useConnection must be used within DirectConnectionProvider');
  return ctx;
}

// ─── Parse Claude stream-json output into SessionMessage ───

function parseClaudeOutput(data: any): SessionMessage | null {
  const msg = data?.data;
  if (!msg) return null;

  const id = msg.message?.id || msg.session_id || `msg_${Date.now()}_${Math.random()}`;
  const ts = Date.now();

  // Claude stream-json types: init, system, assistant, user, result, error, raw
  switch (msg.type) {
    case 'assistant': {
      // Extract text from content blocks
      const content = msg.message?.content || [];
      const textBlocks = content.filter((c: any) => c.type === 'text');
      const thinkingBlocks = content.filter((c: any) => c.type === 'thinking');

      // Emit thinking blocks
      if (thinkingBlocks.length > 0) {
        const thinkText = thinkingBlocks.map((c: any) => c.thinking || c.text || '').join('');
        if (thinkText) {
          return {
            id: id + '_think',
            timestamp: ts,
            role: 'agent',
            content: { type: 'text', text: thinkText, thinking: true },
          };
        }
      }

      // Emit text blocks
      const text = textBlocks.map((c: any) => c.text || '').join('');
      if (text) {
        return {
          id,
          timestamp: ts,
          role: 'agent',
          content: { type: 'text', text },
        };
      }

      // Tool use blocks
      const toolBlocks = content.filter((c: any) => c.type === 'tool_use');
      if (toolBlocks.length > 0) {
        const tool = toolBlocks[0];
        return {
          id: tool.id || id,
          timestamp: ts,
          role: 'agent',
          content: { type: 'tool_call_start', name: tool.name, params: tool.input },
        };
      }

      // Tool result blocks
      const resultBlocks = content.filter((c: any) => c.type === 'tool_result');
      if (resultBlocks.length > 0) {
        const result = resultBlocks[0];
        return {
          id: result.tool_use_id || id,
          timestamp: ts,
          role: 'agent',
          content: { type: 'tool_call_end', name: '', result: result.content },
        };
      }

      return null;
    }

    case 'result': {
      return {
        id: `result_${ts}`,
        timestamp: ts,
        role: 'system',
        content: { type: 'turn_end', status: 'completed' },
      };
    }

    case 'error': {
      return {
        id: `err_${ts}`,
        timestamp: ts,
        role: 'system',
        content: { type: 'service_message', text: `Error: ${msg.error || msg.message || 'Unknown'}` },
      };
    }

    case 'raw': {
      return {
        id: `raw_${ts}`,
        timestamp: ts,
        role: 'agent',
        content: { type: 'text', text: msg.text || '' },
      };
    }

    default:
      return null;
  }
}

// ─── Provider ───

export function DirectConnectionProvider({ children }: { children: React.ReactNode }) {
  const socketRef = useRef<Socket | null>(null);
  const messageHandlersRef = useRef(new Set<(msg: SessionMessage) => void>());

  const [connectionState, setConnectionState] = useState<'disconnected' | 'connecting' | 'connected' | 'error'>('disconnected');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);
  const [sessions, setSessions] = useState<{ id: string; size: number; updatedAt: number }[]>([]);

  const connected = connectionState === 'connected';

  const getRelayUrl = () => {
    const url = getSetting('serverUrl');
    // In direct mode, default to relay.mkyang.ai (not cluster-fluster)
    if (!url || url.includes('cluster-fluster')) return 'https://morph.mkyang.ai';
    return url;
  };
  const getToken = () => 'morph-relay-static-token-2026'; // TODO: make configurable

  // Dispatch message to all handlers
  const dispatchMessage = useCallback((msg: SessionMessage) => {
    for (const handler of messageHandlersRef.current) {
      try { handler(msg); } catch {}
    }
  }, []);

  const onSessionMessage = useCallback((handler: (msg: SessionMessage) => void) => {
    messageHandlersRef.current.add(handler);
    return () => { messageHandlersRef.current.delete(handler); };
  }, []);

  // Connect Socket.IO to relay
  const connectSocket = useCallback((sid: string) => {
    if (socketRef.current) {
      socketRef.current.close();
    }

    const relayUrl = getRelayUrl();
    const token = getToken();

    const socket = io(relayUrl, {
      path: '/v1/updates',
      transports: ['websocket'],
      auth: { token, clientType: 'session-scoped', sessionId: 'direct' },
      reconnection: true,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      autoConnect: false,
    });

    socket.on('connect', () => {
      console.log('[Direct] WS connected');
      socket.emit('direct-subscribe', { sessionId: sid });
      setConnectionState('connected');
    });

    socket.on('disconnect', () => {
      console.log('[Direct] WS disconnected');
      setConnectionState('disconnected');
    });

    socket.on('connect_error', (err) => {
      console.log('[Direct] WS error:', err.message);
      setLastError(err.message);
      setConnectionState('error');
    });

    // Claude streaming output
    socket.on('claude-output', (data: any) => {
      const msg = parseClaudeOutput(data);
      if (msg) dispatchMessage(msg);
    });

    socket.on('claude-error', (data: any) => {
      dispatchMessage({
        id: `stderr_${Date.now()}`,
        timestamp: Date.now(),
        role: 'system',
        content: { type: 'service_message', text: data.text || 'Error' },
      });
    });

    socket.on('claude-exit', (data: any) => {
      console.log('[Direct] Claude exited, code:', data.code);
      dispatchMessage({
        id: `exit_${Date.now()}`,
        timestamp: Date.now(),
        role: 'system',
        content: { type: 'turn_end', status: data.code === 0 ? 'completed' : 'failed' },
      });
    });

    socketRef.current = socket;
    socket.connect();
  }, [dispatchMessage]);

  // Start a new session
  const doConnect = useCallback(async () => {
    setLastError(null);
    setConnectionState('connecting');

    try {
      const relayUrl = getRelayUrl();
      const token = getToken();

      // Send first message to spawn Claude
      const res = await fetch(`${relayUrl}/v2/claude/send`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          message: 'Hello. I am connecting from Morph mobile. Briefly acknowledge.',
          cwd: '/workspace',
        }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);
      if (!data.sessionId) throw new Error('No sessionId returned');

      console.log('[Direct] Session started:', data.sessionId);
      setSessionId(data.sessionId);
      connectSocket(data.sessionId);
    } catch (err: any) {
      setLastError(err?.message || 'Connection failed');
      setConnectionState('error');
      throw err;
    }
  }, [connectSocket]);

  // Resume an existing session
  const resumeSession = useCallback(async (resumeId: string) => {
    setLastError(null);
    setConnectionState('connecting');

    try {
      const relayUrl = getRelayUrl();
      const token = getToken();

      const res = await fetch(`${relayUrl}/v2/claude/resume`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ resumeFrom: resumeId, cwd: '/workspace' }),
      });

      const data = await res.json();
      if (data.error) throw new Error(data.error);

      console.log('[Direct] Resumed:', data.sessionId, 'from', resumeId);
      setSessionId(data.sessionId);
      connectSocket(data.sessionId);
    } catch (err: any) {
      setLastError(err?.message || 'Resume failed');
      setConnectionState('error');
      throw err;
    }
  }, [connectSocket]);

  // Send message
  const sendMessage = useCallback((text: string) => {
    if (!sessionId || !connected) return;

    const relayUrl = getRelayUrl();
    const token = getToken();

    // Use REST for reliability (Socket.IO as backup)
    fetch(`${relayUrl}/v2/claude/send`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ message: text, sessionId }),
    }).catch(err => {
      console.error('[Direct] Send failed:', err.message);
      // Fallback to Socket.IO
      socketRef.current?.emit('direct-send', { sessionId, message: text });
    });

    // Optimistic: show user message immediately
    dispatchMessage({
      id: `user_${Date.now()}`,
      timestamp: Date.now(),
      role: 'user',
      content: { type: 'text', text },
    });
  }, [sessionId, connected, dispatchMessage]);

  // Interrupt
  const sendInterrupt = useCallback(() => {
    if (!sessionId) return;
    const relayUrl = getRelayUrl();
    const token = getToken();

    fetch(`${relayUrl}/v2/claude/interrupt`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {
      socketRef.current?.emit('direct-interrupt', { sessionId });
    });
  }, [sessionId]);

  // Disconnect
  const doDisconnect = useCallback(() => {
    if (sessionId) {
      const relayUrl = getRelayUrl();
      const token = getToken();
      fetch(`${relayUrl}/v2/claude/stop`, {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${token}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({ sessionId }),
      }).catch(() => {});
    }
    socketRef.current?.close();
    socketRef.current = null;
    setSessionId(null);
    setConnectionState('disconnected');
  }, [sessionId]);

  // Refresh session list
  const refreshSessions = useCallback(async () => {
    try {
      const relayUrl = getRelayUrl();
      const token = getToken();
      const res = await fetch(`${relayUrl}/v2/claude/sessions`, {
        headers: { 'Authorization': `Bearer ${token}` },
      });
      const data = await res.json();
      setSessions(data.sessions || []);
    } catch {}
  }, []);

  // Auto-connect on mount
  useEffect(() => {
    const timer = setTimeout(() => {
      doConnect().catch((err) => {
        console.warn('[Direct] auto-connect failed:', err?.message);
      });
    }, 500);
    return () => {
      clearTimeout(timer);
      socketRef.current?.close();
    };
  }, []);

  return (
    <DirectConnectionContext.Provider
      value={{
        connectionState,
        connected,
        sessionId,
        credentials: null,
        lastError,
        connect: doConnect,
        disconnect: doDisconnect,
        sendMessage,
        sendInterrupt,
        onSessionMessage,
        connectionRef: socketRef as any,
        sessions,
        refreshSessions,
        resumeSession,
      }}
    >
      {children}
    </DirectConnectionContext.Provider>
  );
}
