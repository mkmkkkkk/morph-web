import React, { useRef, useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
import Constants from 'expo-constants';

// Safe-load heavy modules — catch import errors instead of crashing
let Canvas: any = null;
let ChatPanel: any = null;
let MorphBridge: any = null;
let _useConnection: any = null;
let ComponentStore: any = null;
let promptLib: any = null;
let _tabLoadError: string | null = null;

try {
  Canvas = require('../../components/Canvas').default;
} catch (e: any) {
  _tabLoadError = (_tabLoadError || '') + '\nCanvas: ' + e?.message;
}
try {
  ChatPanel = require('../../components/ChatPanel').default;
} catch (e: any) {
  _tabLoadError = (_tabLoadError || '') + '\nChatPanel: ' + e?.message;
}
try {
  MorphBridge = require('../../lib/bridge').MorphBridge;
} catch (e: any) {
  _tabLoadError = (_tabLoadError || '') + '\nBridge: ' + e?.message;
}
try {
  _useConnection = require('../../lib/ConnectionContext').useConnection;
} catch (e: any) {
  _tabLoadError = (_tabLoadError || '') + '\nConnectionContext: ' + e?.message;
}
try {
  ComponentStore = require('../../lib/store').ComponentStore;
} catch (e: any) {
  _tabLoadError = (_tabLoadError || '') + '\nStore: ' + e?.message;
}
try {
  promptLib = require('../../lib/prompt');
} catch (e: any) {
  _tabLoadError = (_tabLoadError || '') + '\nPrompt: ' + e?.message;
}

// Fallback hook that returns a noop connection
function useNoopConnection() {
  return {
    connected: false,
    connectionState: 'error' as const,
    lastError: 'ConnectionContext failed to load',
    sessionId: null,
    sendMessage: () => {},
    sendInterrupt: () => {},
    onSessionMessage: () => () => {},
  };
}

// Choose connection hook at module level (must be stable for Rules of Hooks)
const useConnection = _useConnection || useNoopConnection;

console.log('[CanvasScreen] module loaded, Canvas=', !!Canvas, 'ChatPanel=', !!ChatPanel, 'errors=', _tabLoadError);

export default function CanvasScreen() {
  console.log('[CanvasScreen] render START');
  // ALL hooks must be called unconditionally (Rules of Hooks)
  const bridgeRef = useRef(null);
  const storeRef = useRef(ComponentStore ? new ComponentStore() : null);

  const {
    connected,
    connectionState,
    lastError,
    sendMessage: rawSendMessage,
    sendInterrupt,
    onSessionMessage,
  } = useConnection();

  console.log('[CanvasScreen] connection state:', connectionState, 'connected:', connected, 'lastError:', lastError);

  const [isProcessing, setIsProcessing] = useState(false);
  const [messages, setMessages] = useState<any[]>([]);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Initialize component store
  useEffect(() => {
    console.log('[CanvasScreen] mount: storeRef=', !!storeRef.current, 'Canvas=', !!Canvas, 'ChatPanel=', !!ChatPanel);
    if (!storeRef.current) return;
    const init = async () => {
      try {
        await storeRef.current.init();
        const components = await storeRef.current.loadAllComponents();
        console.log('[CanvasScreen] store init OK, components=', components.length);
        if (components.length > 0 && bridgeRef.current) {
          (bridgeRef.current as any).loadComponents(components);
        }
      } catch (err: any) {
        console.error('[CanvasScreen] store init FAILED:', err?.message);
      }
    };
    init().catch(() => {});
  }, []);

  // Listen to session messages
  useEffect(() => {
    console.log('[CanvasScreen] subscribing to onSessionMessage');
    return onSessionMessage((msg: any) => {
      try {
        console.log('[CanvasScreen] onSessionMessage: type=', msg?.content?.type, 'role=', msg?.role, 'id=', msg?.id);
        setMessages(prev => [...prev, msg]);

        // Reset idle timer — after 3s of no messages, assume turn ended
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
        idleTimerRef.current = setTimeout(() => {
          setIsProcessing(false);
        }, 3000);

        if (!bridgeRef.current) {
          console.log('[CanvasScreen] no bridgeRef, skipping bridge dispatch');
          return;
        }
        const bridge = bridgeRef.current as any;

        switch (msg.content.type) {
          case 'text': {
            const text = msg.content.text;
            console.log('[CanvasScreen] text message, length=', text?.length, 'preview=', text?.slice(0, 80));
            const componentRegex = /```morph-component:(\S+)\n([\s\S]*?)```/g;
            let match;

            while ((match = componentRegex.exec(text)) !== null) {
              console.log('[CanvasScreen] found morph-component:', match[1]);
              bridge.addComponent(match[1], match[2].trim(), 'draft');
            }

            const cleanText = text.replace(componentRegex, '').trim();
            if (cleanText) {
              bridge.sendEvent('message', { role: msg.role, text: cleanText });
            }
            break;
          }

          case 'tool_call_start':
          case 'tool_call_end':
            console.log('[CanvasScreen] tool_call:', msg.content.type, msg.content.name);
            bridge.sendEvent('tool_call', msg.content);
            break;

          case 'turn_end':
            console.log('[CanvasScreen] turn_end, status=', msg.content.status);
            if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
            setIsProcessing(false);
            bridge.sendEvent('turn_end', msg.content);
            break;

          case 'service_message':
            break;

          default:
            break;
        }
      } catch (err: any) {
        console.error('[CanvasScreen] onSessionMessage THREW:', err?.message, err?.stack);
      }
    });
  }, [onSessionMessage]);

  const handleSend = useCallback((text: string) => {
    console.log('[CanvasScreen] handleSend: connected=', connected, 'text=', JSON.stringify(text).slice(0, 100));
    if (!connected) {
      console.warn('[CanvasScreen] handleSend: NOT connected, ignoring');
      return;
    }
    try {
      setMessages(prev => [...prev, {
        id: `local_${Date.now()}`,
        timestamp: Date.now(),
        role: 'user',
        content: { type: 'text', text },
      }]);
      console.log('[CanvasScreen] local message added');
      const manifest = storeRef.current?.getManifest() || { components: [], order: [] };
      const wrappedText = promptLib?.wrapUserMessage(text, manifest) || text;
      console.log('[CanvasScreen] wrappedText length=', wrappedText.length);
      setIsProcessing(true);
      rawSendMessage(wrappedText);
      console.log('[CanvasScreen] rawSendMessage called OK');
    } catch (err: any) {
      console.error('[CanvasScreen] handleSend THREW:', err?.message, err?.stack);
    }
  }, [connected, rawSendMessage]);

  const handleStop = useCallback(() => {
    if (!connected) return;
    sendInterrupt();
    setIsProcessing(false);
  }, [connected, sendInterrupt]);

  const handleAdopt = useCallback(async (_componentId: string) => {}, []);

  const handleDismiss = useCallback(async (componentId: string) => {
    await storeRef.current?.removeComponent(componentId);
  }, []);

  const handleSketch = useCallback((imageDataUrl: string) => {
    if (!connected || !promptLib) return;
    const manifest = storeRef.current?.getManifest() || { components: [], order: [] };
    rawSendMessage(promptLib.wrapUserMessage(promptLib.buildSketchMessage(imageDataUrl), manifest));
  }, [connected, rawSendMessage]);

  const handleImage = useCallback((imageDataUrl: string) => {
    if (!connected || !promptLib) return;
    const manifest = storeRef.current?.getManifest() || { components: [], order: [] };
    rawSendMessage(promptLib.wrapUserMessage(promptLib.buildImageMessage(imageDataUrl), manifest));
  }, [connected, rawSendMessage]);

  const handleFile = useCallback((file: { name: string; mime: string; base64: string; size: number }) => {
    if (!connected || !promptLib) return;
    const manifest = storeRef.current?.getManifest() || { components: [], order: [] };
    rawSendMessage(promptLib.wrapUserMessage(promptLib.buildFileMessage(file), manifest));
  }, [connected, rawSendMessage]);

  const handleOpenSketch = useCallback(() => {
    (bridgeRef.current as any)?.openSketch();
  }, []);

  // If critical modules failed, show error AFTER hooks
  if (_tabLoadError && (!Canvas || !ChatPanel)) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0a0a0a', padding: 20, paddingTop: Constants.statusBarHeight + 20 }}>
        <Text selectable style={{ color: '#ff4444', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }}>
          Module load error
        </Text>
        <ScrollView>
          <Text selectable style={{ color: '#aaa', fontSize: 13, fontFamily: 'Menlo' }}>
            {_tabLoadError}
          </Text>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: '#0a0a0a', paddingTop: Constants.statusBarHeight }]}>
      {!connected && (
        <View style={{ backgroundColor: '#1a1a1a', padding: 8, paddingHorizontal: 12 }}>
          <Text selectable style={{ color: connectionState === 'connecting' ? '#ffaa00' : '#ff4444', fontSize: 13 }}>
            {connectionState}{lastError ? `\n${lastError}` : ''}
          </Text>
        </View>
      )}
      {Canvas && (
        <Canvas
          onSendMessage={handleSend}
          onAdopt={handleAdopt}
          onDismiss={handleDismiss}
          onSketch={handleSketch}
          bridgeRef={bridgeRef}
        />
      )}
      {ChatPanel && (
        <ChatPanel
          messages={messages}
          onSend={handleSend}
          onStop={handleStop}
          onSketch={handleOpenSketch}
          onImage={handleImage}
          onFile={handleFile}
          connected={connected}
          isProcessing={isProcessing}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
