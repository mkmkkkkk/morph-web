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
import { fromBase64, boxDecrypt } from './crypto';

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

console.log('[ConnectionProvider] module loaded');

export function ConnectionProvider({ children }: { children: React.ReactNode }) {
  console.log('[ConnectionProvider] render');
  const connectionRef = useRef(new HappyConnection());
  const apiRef = useRef<HappyApi | null>(null);
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
    const count = messageHandlersRef.current.size;
    console.log('[ConnectionProvider] dispatchMessage: type=', msg.content.type, 'to', count, 'handlers');
    for (const handler of messageHandlersRef.current) {
      try {
        handler(msg);
      } catch (err: any) {
        console.error('[ConnectionProvider] handler THREW:', err?.message, err?.stack);
      }
    }
  }, []);

  // Connect to HappyCoder server
  //
  // Flow:
  // 1. Spawn CC worker via morph-bridge → daemon spawns CC
  // 2. CC creates its own session with a random encryption key
  // 3. CC encrypts the session key with our publicKey → stored as dataEncryptionKey on server
  // 4. We fetch dataEncryptionKey from the API
  // 5. We decrypt it with our secretKey → recover CC's session key
  // 6. We connect session-scoped to CC's session → same encryption key → messages flow
  const doConnect = useCallback(async () => {
    setLastError(null);
    setConnectionState('connecting');

    const creds = await loadCredentials();
    if (!creds) throw new Error('No credentials found. Scan a QR code first.');
    setCredentials(creds);
    console.log('[Morph] credentials loaded, variant:', creds.encryption.type);

    const serverUrl = getSetting('serverUrl');
    const api = new HappyApi(creds.token, serverUrl);
    apiRef.current = api;

    // Step 1: Spawn CC worker via morph-bridge
    const bridgeUrl = getSetting('bridgeUrl') || 'https://morph.mkyang.ai';
    console.log('[Morph] spawning CC worker...');
    const spawnRes = await fetch(`${bridgeUrl}/api/spawn`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ directory: '/workspace' }),
    });
    const spawnData = await spawnRes.json();
    console.log('[Morph] spawn result:', JSON.stringify(spawnData));

    if (!spawnData.success || !spawnData.sessionId) {
      throw new Error(`CC spawn failed: ${spawnData.error || 'no sessionId returned'}`);
    }

    const sid = spawnData.sessionId;
    console.log('[Morph] CC session ID:', sid);

    // Step 2: Fetch dataEncryptionKey via bridge (avoids 920KB payload on phone)
    let dataEncKeyB64: string | null = null;
    for (let attempt = 1; attempt <= 5; attempt++) {
      await new Promise(r => setTimeout(r, attempt === 1 ? 1500 : 2000));
      console.log('[Morph] fetching dataEncryptionKey via bridge, attempt', attempt);
      try {
        const keyRes = await fetch(
          `${bridgeUrl}/api/session-key?sid=${encodeURIComponent(sid)}&token=${encodeURIComponent(creds.token)}`
        );
        const keyData = await keyRes.json();
        if (keyData.dataEncryptionKey) {
          dataEncKeyB64 = keyData.dataEncryptionKey;
          break;
        }
      } catch (e: any) {
        console.log('[Morph] session-key fetch error:', e?.message);
      }
    }
    if (!dataEncKeyB64) {
      throw new Error('Could not retrieve dataEncryptionKey after 5 attempts');
    }
    console.log('[Morph] got dataEncryptionKey, length:', dataEncKeyB64.length);

    // Step 3: Decrypt dataEncryptionKey with our X25519 secretKey
    const secretKey = creds.encryption.secretKey;
    if (!secretKey) {
      throw new Error('No secretKey in credentials — cannot decrypt CC session key');
    }

    const dataEncKeyBundle = fromBase64(dataEncKeyB64);
    // First byte is version (0x00), rest is the box-encrypted session key
    if (dataEncKeyBundle[0] !== 0x00) {
      throw new Error(`Unexpected dataEncryptionKey version: ${dataEncKeyBundle[0]}`);
    }
    const boxedKey = dataEncKeyBundle.slice(1);
    const encKey = boxDecrypt(boxedKey, secretKey);
    if (!encKey) {
      throw new Error('Failed to decrypt CC session key — publicKey/secretKey mismatch?');
    }
    console.log('[Morph] decrypted CC session key, length:', encKey.length);

    const variant: 'legacy' | 'dataKey' = 'dataKey';

    setSessionId(sid);
    setSessionKey(encKey);
    setSessionVariant(variant);
    setSetting('lastSessionId', sid);

    // Step 4: Connect to CC's session
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

      const unsubState = conn.onStateChange((state: ConnectionState) => {
        console.log('[Morph] socket state:', state);
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
        try {
          const bodyT = data?.body?.t;
          console.log('[Morph] received update: t=', bodyT, 'preview=', JSON.stringify(data).slice(0, 300));
          if (!encKey) {
            console.warn('[Morph] onUpdate: encKey is null, cannot decrypt');
            return;
          }
          const msgs = parseUpdate(data, encKey, variant);
          console.log('[Morph] parsed', msgs.length, 'messages');
          for (const msg of msgs) {
            console.log('[Morph] dispatching:', msg.content.type, msg.role, msg.id);
            dispatchMessage(msg);
          }
        } catch (err: any) {
          console.error('[Morph] onUpdate THREW:', err?.message, err?.stack);
        }
      });

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
      setConnectionState('error');
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

  // Send message via Socket.IO
  const sendMessage = useCallback((text: string) => {
    console.log('[Morph] sendMessage called: sessionId=', sessionId, 'hasKey=', !!sessionKey, 'keyLen=', sessionKey?.length, 'connected=', connected, 'variant=', sessionVariant);
    if (!sessionId || !sessionKey || !connected) {
      console.warn('[Morph] sendMessage: precondition failed — sid=', !!sessionId, 'key=', !!sessionKey, 'conn=', connected);
      return;
    }
    try {
      console.log('[Morph] sendMessage: encrypting text, length=', text.length);
      const encrypted = encryptUserMessage(text, sessionKey, sessionVariant);
      console.log('[Morph] sendMessage: encrypted OK, b64 length=', encrypted.length);
      console.log('[Morph] sendMessage: emitting via socket...');
      connectionRef.current.sendMessage(sessionId, encrypted).then(() => {
        console.log('[Morph] sendMessage: socket emit resolved OK');
      }).catch((err) => {
        console.error('[Morph] sendMessage: socket emit REJECTED:', err?.message);
        Alert.alert('Send Error', String(err?.message || err));
      });
    } catch (err: any) {
      console.error('[Morph] sendMessage SYNC ERROR:', err?.message, '\nStack:', err?.stack);
      Alert.alert('Send Error (sync)', String(err?.message || err) + '\n' + (err?.stack || ''));
    }
  }, [sessionId, sessionKey, sessionVariant, connected]);

  // Send interrupt
  const sendInterrupt = useCallback(() => {
    console.log('[ConnectionProvider] sendInterrupt: sid=', sessionId, 'connected=', connected);
    if (!sessionId || !connected) return;
    connectionRef.current.sendInterrupt(sessionId);
  }, [sessionId, connected]);

  // Auto-connect on mount (best-effort, delayed to let app stabilize)
  useEffect(() => {
    console.log('[ConnectionProvider] MOUNT — scheduling auto-connect in 500ms');
    const timer = setTimeout(() => {
      console.log('[ConnectionProvider] auto-connect timer fired, calling safeConnect...');
      safeConnect().then(() => {
        console.log('[ConnectionProvider] auto-connect SUCCEEDED');
      }).catch((err) => {
        console.warn('[ConnectionProvider] auto-connect FAILED:', err?.message);
      });
    }, 500);
    return () => {
      console.log('[ConnectionProvider] UNMOUNT — clearing timer, disconnecting');
      clearTimeout(timer);
      doDisconnect();
    };
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
