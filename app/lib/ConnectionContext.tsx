/**
 * Shared connection context — provides HappyCoder connection state
 * across all tabs (Canvas, Config) and the Connect modal.
 *
 * One HappyConnection instance, one source of truth.
 */

import React, { createContext, useContext, useRef, useState, useCallback, useEffect } from 'react';
import { Alert } from 'react-native';
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
  lastError: string | null;

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

  // Track registered unsubscribe functions so we can clean up
  const cleanupRef = useRef<(() => void)[]>([]);

  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState<Uint8Array | null>(null);
  const [sessionVariant, setSessionVariant] = useState<'legacy' | 'dataKey'>('legacy');
  const [credentials, setCredentials] = useState<HappyCredentials | null>(null);
  const [lastError, setLastError] = useState<string | null>(null);

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
    setLastError(null);
    setConnectionState('connecting');

    const creds = await loadCredentials();
    if (!creds) throw new Error('No credentials found. Scan a QR code first.');
    setCredentials(creds);

    const serverUrl = getSetting('serverUrl');
    const api = new HappyApi(creds.token, serverUrl);

    let encKey = creds.encryption.key;
    let variant = creds.encryption.type;

    // Create a fresh session
    const session = await api.createSession(
      'morph-' + Date.now(),
      { title: 'Morph Canvas', device: 'mobile' },
      null,
      encKey,
      variant,
      creds.encryption.publicKey,
    );
    const sid = session.id;
    encKey = session.encryptionKey;
    variant = session.encryptionVariant;

    setSessionId(sid);
    setSessionKey(encKey);
    setSessionVariant(variant);
    setSetting('lastSessionId', sid);

    const conn = connectionRef.current;

    // Clean up ALL old listeners before adding new ones
    for (const unsub of cleanupRef.current) {
      try { unsub(); } catch { /* ignore */ }
    }
    cleanupRef.current = [];

    // Kill old socket
    conn.disconnect();

    // Wait for Socket.IO to actually connect (or fail)
    await new Promise<void>((resolve, reject) => {
      const timeout = setTimeout(() => {
        conn.disconnect();
        setConnectionState('error');
        reject(new Error('Connection timed out (10s)'));
      }, 10_000);

      let settled = false;

      // Register state listener — persists after promise settles
      const unsubState = conn.onStateChange((state: ConnectionState) => {
        setConnectionState(state);

        if (!settled) {
          if (state === 'connected') {
            settled = true;
            clearTimeout(timeout);
            resolve();
          } else if (state === 'error') {
            settled = true;
            clearTimeout(timeout);
            reject(new Error('Socket connection error'));
          }
        }
      });

      const unsubUpdate = conn.onUpdate((data: any) => {
        if (!encKey) return;
        const msg = parseUpdate(data, encKey, variant);
        if (msg) dispatchMessage(msg);
      });

      // Track for cleanup on next connect
      cleanupRef.current.push(unsubState, unsubUpdate);

      conn.connect(serverUrl, creds.token, 'session-scoped', sid);
    });

    // Keep-alive (only runs after successful connect)
    if (keepAliveRef.current) clearInterval(keepAliveRef.current);
    keepAliveRef.current = setInterval(() => {
      if (sid) conn.sendKeepAlive(sid, false, 'canvas');
    }, 20_000);
  }, [dispatchMessage]);

  // Wrapped connect with error capture
  const safeConnect = useCallback(async () => {
    try {
      await doConnect();
      setLastError(null);
    } catch (err: any) {
      const msg = err?.message || 'Unknown error';
      setLastError(msg);
      throw err; // Re-throw so callers can catch too
    }
  }, [doConnect]);

  // Disconnect
  const doDisconnect = useCallback(() => {
    if (keepAliveRef.current) {
      clearInterval(keepAliveRef.current);
      keepAliveRef.current = null;
    }
    // Clean up listeners
    for (const unsub of cleanupRef.current) {
      try { unsub(); } catch { /* ignore */ }
    }
    cleanupRef.current = [];
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

  // Auto-connect on mount (best-effort)
  useEffect(() => {
    safeConnect().catch(() => {});
    return () => doDisconnect();
  }, []);

  return (
    <ConnectionContext.Provider
      value={{
        connectionState,
        connected,
        sessionId,
        credentials,
        lastError,
        connect: safeConnect,
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
