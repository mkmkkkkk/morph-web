/**
 * Shared connection context — provides HappyCoder connection state
 * across all tabs (Canvas, Config) and the Connect modal.
 *
 * One HappyConnection instance, one source of truth.
 */

import React, { createContext, useContext, useRef, useState, useCallback, useEffect } from 'react';
import { HappyConnection, type ConnectionState } from './connection';
import { HappyApi } from './api';
import { loadCredentials, type HappyCredentials } from './credentials';
import { getSetting, setSetting } from './settings';
import { parseUpdate, encryptUserMessage, type SessionMessage } from './protocol';

export interface ConnectionContextValue {
  // State
  connectionState: ConnectionState;
  connected: boolean;
  sessionId: string | null;
  credentials: HappyCredentials | null;

  // Actions
  connect: () => Promise<void>;
  disconnect: () => void;
  sendMessage: (text: string) => void;
  sendInterrupt: () => void;

  // Message handling
  onSessionMessage: (handler: (msg: SessionMessage) => void) => () => void;

  // Raw connection ref (for keep-alive, etc.)
  connectionRef: React.MutableRefObject<HappyConnection>;
}

const ConnectionContext = createContext<ConnectionContextValue | null>(null);

export function useConnection() {
  const ctx = useContext(ConnectionContext);
  if (!ctx) throw new Error('useConnection must be used within ConnectionProvider');
  return ctx;
}

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  const connectionRef = useRef(new HappyConnection());
  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const messageHandlersRef = useRef(new Set<(msg: SessionMessage) => void>());

  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState<Uint8Array | null>(null);
  const [sessionVariant, setSessionVariant] = useState<'legacy' | 'dataKey'>('legacy');
  const [credentials, setCredentials] = useState<HappyCredentials | null>(null);

  const connected = connectionState === 'connected';

  // Subscribe to session messages
  const onSessionMessage = useCallback((handler: (msg: SessionMessage) => void) => {
    messageHandlersRef.current.add(handler);
    return () => { messageHandlersRef.current.delete(handler); };
  }, []);

  // Dispatch message to all handlers
  const dispatchMessage = useCallback((msg: SessionMessage) => {
    for (const handler of messageHandlersRef.current) {
      try { handler(msg); } catch { /* swallow */ }
    }
  }, []);

  // Connect to HappyCoder server
  const doConnect = useCallback(async () => {
    const creds = await loadCredentials();
    if (!creds) return;
    setCredentials(creds);

    const serverUrl = getSetting('serverUrl');
    const lastSessionId = getSetting('lastSessionId');

    try {
      const api = new HappyApi(creds.token, serverUrl);

      let sid = lastSessionId;
      let encKey = creds.encryption.key;
      let variant = creds.encryption.type;

      if (!sid) {
        const session = await api.createSession(
          'morph-' + Date.now(),
          { title: 'Morph Canvas', device: 'mobile' },
          null,
          encKey,
          variant,
          creds.encryption.publicKey,
        );
        sid = session.id;
        encKey = session.encryptionKey;
        variant = session.encryptionVariant;
      }

      setSessionId(sid);
      setSessionKey(encKey);
      setSessionVariant(variant);
      setSetting('lastSessionId', sid);

      const conn = connectionRef.current;

      // Clear old listeners
      conn.disconnect();

      conn.onStateChange((state: ConnectionState) => {
        setConnectionState(state);
      });

      conn.onUpdate((data: any) => {
        if (!encKey) return;
        const msg = parseUpdate(data, encKey, variant);
        if (msg) dispatchMessage(msg);
      });

      conn.connect(serverUrl, creds.token, 'session-scoped', sid);

      // Keep-alive
      if (keepAliveRef.current) clearInterval(keepAliveRef.current);
      keepAliveRef.current = setInterval(() => {
        if (sid) conn.sendKeepAlive(sid, false, 'canvas');
      }, 20_000);
    } catch (err) {
      console.warn('Connection failed:', err);
    }
  }, [dispatchMessage]);

  // Disconnect
  const doDisconnect = useCallback(() => {
    if (keepAliveRef.current) {
      clearInterval(keepAliveRef.current);
      keepAliveRef.current = null;
    }
    connectionRef.current.disconnect();
    setConnectionState('disconnected');
  }, []);

  // Send message
  const sendMessage = useCallback((text: string) => {
    if (!sessionId || !sessionKey || !connected) return;
    const encrypted = encryptUserMessage(text, sessionKey, sessionVariant);
    connectionRef.current.sendMessage(sessionId, encrypted).catch(console.warn);
  }, [sessionId, sessionKey, sessionVariant, connected]);

  // Send interrupt
  const sendInterrupt = useCallback(() => {
    if (!sessionId || !connected) return;
    connectionRef.current.sendInterrupt(sessionId);
  }, [sessionId, connected]);

  // Auto-connect on mount
  useEffect(() => {
    doConnect();
    return () => doDisconnect();
  }, []);

  return (
    <ConnectionContext.Provider
      value={{
        connectionState,
        connected,
        sessionId,
        credentials,
        connect: doConnect,
        disconnect: doDisconnect,
        sendMessage,
        sendInterrupt,
        onSessionMessage,
        connectionRef,
      }}
    >
      {children}
    </ConnectionContext.Provider>
  );
}
