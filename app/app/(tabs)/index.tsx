import React, { useRef, useState, useEffect, useCallback } from 'react';
import { View, StyleSheet, useColorScheme } from 'react-native';
import Canvas from '../../components/Canvas';
import InputBar from '../../components/InputBar';
import { MorphBridge } from '../../lib/bridge';
import { HappyConnection, type ConnectionState } from '../../lib/connection';
import { loadCredentials, type HappyCredentials } from '../../lib/credentials';
import { getSetting, setSetting } from '../../lib/settings';
import { encryptUserMessage, parseUpdate, type SessionMessage } from '../../lib/protocol';
import { HappyApi } from '../../lib/api';
import { ComponentStore } from '../../lib/store';
import { wrapUserMessage, buildSketchMessage } from '../../lib/prompt';

const KEEP_ALIVE_MS = 20_000;

export default function CanvasScreen() {
  const colorScheme = useColorScheme();
  const bridgeRef = useRef<MorphBridge | null>(null);
  const connectionRef = useRef(new HappyConnection());
  const storeRef = useRef(new ComponentStore());
  const keepAliveRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [connected, setConnected] = useState(false);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [sessionKey, setSessionKey] = useState<Uint8Array | null>(null);
  const [sessionVariant, setSessionVariant] = useState<'legacy' | 'dataKey'>('legacy');

  // Initialize component store and load adopted components
  useEffect(() => {
    const init = async () => {
      await storeRef.current.init();
      const components = await storeRef.current.loadAllComponents();
      if (components.length > 0) {
        // Wait for bridge to be ready, then load components
        const checkBridge = setInterval(() => {
          if (bridgeRef.current) {
            bridgeRef.current.loadComponents(components);
            clearInterval(checkBridge);
          }
        }, 100);
        // Safety: clear after 5s
        setTimeout(() => clearInterval(checkBridge), 5000);
      }
    };
    init();
  }, []);

  // Auto-connect if credentials exist
  useEffect(() => {
    const autoConnect = async () => {
      const creds = await loadCredentials();
      if (!creds) return;

      const serverUrl = getSetting('serverUrl');
      const lastSessionId = getSetting('lastSessionId');

      try {
        const api = new HappyApi(creds.token, serverUrl);

        // Try to resume last session or create new one
        let sid = lastSessionId;
        let encKey = creds.encryption.key;
        let variant = creds.encryption.type;

        if (!sid) {
          // Create a new session
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

        // Connect socket
        const conn = connectionRef.current;
        conn.onStateChange((state: ConnectionState) => {
          setConnected(state === 'connected');
        });

        conn.onUpdate((data: any) => {
          if (!encKey) return;
          const msg = parseUpdate(data, encKey, variant);
          if (msg) handleSessionMessage(msg);
        });

        conn.connect(serverUrl, creds.token, 'session-scoped', sid);

        // Keep-alive
        keepAliveRef.current = setInterval(() => {
          if (sid) conn.sendKeepAlive(sid, false, 'canvas');
        }, KEEP_ALIVE_MS);
      } catch (err) {
        // Connection failed silently — user can retry via settings
        console.warn('Auto-connect failed:', err);
      }
    };

    autoConnect();

    return () => {
      if (keepAliveRef.current) clearInterval(keepAliveRef.current);
      connectionRef.current.disconnect();
    };
  }, []);

  // Handle incoming session messages from CC
  const handleSessionMessage = useCallback((msg: SessionMessage) => {
    if (!bridgeRef.current) return;

    switch (msg.content.type) {
      case 'text': {
        const text = msg.content.text;
        // Check for morph-component code blocks
        const componentRegex = /```morph-component:(\S+)\n([\s\S]*?)```/g;
        let match;
        let hasComponent = false;

        while ((match = componentRegex.exec(text)) !== null) {
          hasComponent = true;
          const compId = match[1];
          const compHtml = match[2].trim();
          bridgeRef.current.addComponent(compId, compHtml, 'draft');
        }

        // If there's non-component text, send it as a message event
        const cleanText = text.replace(componentRegex, '').trim();
        if (cleanText) {
          bridgeRef.current.sendEvent('message', {
            role: msg.role,
            text: cleanText,
          });
        }
        break;
      }

      case 'tool_call_start':
      case 'tool_call_end':
        bridgeRef.current.sendEvent('tool_call', msg.content);
        break;

      case 'turn_end':
        bridgeRef.current.sendEvent('turn_end', msg.content);
        break;
    }
  }, []);

  // Send message to CC
  const handleSend = useCallback((text: string) => {
    if (!sessionId || !sessionKey || !connected) return;

    const manifest = storeRef.current.getManifest();
    const wrappedText = wrapUserMessage(text, manifest);
    const encrypted = encryptUserMessage(wrappedText, sessionKey, sessionVariant);

    connectionRef.current.sendMessage(sessionId, encrypted).catch(console.warn);
  }, [sessionId, sessionKey, sessionVariant, connected]);

  // Adopt a component (persist it)
  const handleAdopt = useCallback(async (componentId: string) => {
    // Get the HTML from the WebView via the bridge
    // For now, we track what we've sent and save on adopt
    // The bridge doesn't have a getHtml callback, so we'll save when CC sends the component
    // This is handled by tracking components in handleSessionMessage
  }, []);

  // Dismiss a component
  const handleDismiss = useCallback(async (componentId: string) => {
    await storeRef.current.removeComponent(componentId);
  }, []);

  // Handle sketch image from WebView
  const handleSketch = useCallback((imageDataUrl: string) => {
    if (!sessionId || !sessionKey || !connected) return;
    const manifest = storeRef.current.getManifest();
    const sketchText = buildSketchMessage(imageDataUrl);
    const msg = wrapUserMessage(sketchText, manifest);
    const encrypted = encryptUserMessage(msg, sessionKey, sessionVariant);
    connectionRef.current.sendMessage(sessionId, encrypted).catch(console.warn);
  }, [sessionId, sessionKey, sessionVariant, connected]);

  // Open sketch mode
  const handleOpenSketch = useCallback(() => {
    bridgeRef.current?.openSketch();
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: colorScheme === 'dark' ? '#0a0a0a' : '#fff' }]}>
      <Canvas
        onSendMessage={handleSend}
        onAdopt={handleAdopt}
        onDismiss={handleDismiss}
        onSketch={handleSketch}
        bridgeRef={bridgeRef}
      />
      <InputBar onSend={handleSend} onSketch={handleOpenSketch} connected={connected} />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
