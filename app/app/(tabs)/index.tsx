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

export default function CanvasScreen() {
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

  const [isProcessing, setIsProcessing] = useState(false);
  const [messages, setMessages] = useState<any[]>([]);

  // Initialize component store
  useEffect(() => {
    if (!storeRef.current) return;
    const init = async () => {
      await storeRef.current.init();
      const components = await storeRef.current.loadAllComponents();
      if (components.length > 0 && bridgeRef.current) {
        (bridgeRef.current as any).loadComponents(components);
      }
    };
    init().catch(() => {});
  }, []);

  // Listen to session messages
  useEffect(() => {
    return onSessionMessage((msg: any) => {
      setMessages(prev => [...prev, msg]);

      if (!bridgeRef.current) return;
      const bridge = bridgeRef.current as any;

      switch (msg.content.type) {
        case 'text': {
          const text = msg.content.text;
          const componentRegex = /```morph-component:(\S+)\n([\s\S]*?)```/g;
          let match;

          while ((match = componentRegex.exec(text)) !== null) {
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
          bridge.sendEvent('tool_call', msg.content);
          break;

        case 'turn_end':
          setIsProcessing(false);
          bridge.sendEvent('turn_end', msg.content);
          break;
      }
    });
  }, [onSessionMessage]);

  const handleSend = useCallback((text: string) => {
    if (!connected) return;
    setMessages(prev => [...prev, {
      id: `local_${Date.now()}`,
      timestamp: Date.now(),
      role: 'user',
      content: { type: 'text', text },
    }]);
    const manifest = storeRef.current?.getManifest() || { components: [], order: [] };
    const wrappedText = promptLib?.wrapUserMessage(text, manifest) || text;
    setIsProcessing(true);
    rawSendMessage(wrappedText);
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
