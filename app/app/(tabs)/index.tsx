import React, { useRef, useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView, Platform } from 'react-native';
import Constants from 'expo-constants';
import { useActiveTab } from '../../lib/TabContext';

// Safe-load heavy modules — catch import errors instead of crashing
let Canvas: any = null;
let ChatPanel: any = null;
let MorphBridge: any = null;
let _useConnection: any = null;
let ComponentStore: any = null;
let promptLib: any = null;
let _tabLoadError: string | null = null;

const isWeb = Platform.OS === 'web';

// Web direct mode: skip Canvas/Bridge entirely — chat only
if (!isWeb) {
  try {
    Canvas = require('../../components/Canvas').default;
  } catch (e: any) {
    _tabLoadError = (_tabLoadError || '') + '\nCanvas: ' + e?.message;
  }
  try {
    MorphBridge = require('../../lib/bridge').MorphBridge;
  } catch (e: any) {
    _tabLoadError = (_tabLoadError || '') + '\nBridge: ' + e?.message;
  }
}
try {
  ChatPanel = require('../../components/ChatPanel').default;
} catch (e: any) {
  _tabLoadError = (_tabLoadError || '') + '\nChatPanel: ' + e?.message;
}
try {
  _useConnection = require('../../lib/useConnection').useConnection;
} catch (e: any) {
  _tabLoadError = (_tabLoadError || '') + '\nConnectionContext: ' + e?.message;
}
if (!isWeb) {
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

const useConnection = _useConnection || useNoopConnection;

export default function CanvasScreen() {
  const bridgeRef = useRef(null);
  const storeRef = useRef(!isWeb && ComponentStore ? new ComponentStore() : null);
  const componentHtmlCache = useRef(new Map<string, string>());
  const { activeTab } = useActiveTab();

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
  const [pendingSketch, setPendingSketch] = useState<any>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMessagesRef = useRef<{ localId: string; wrappedText: string }[]>([]);

  // Initialize component store (native only)
  useEffect(() => {
    if (isWeb || !storeRef.current) return;
    const init = async () => {
      try {
        await storeRef.current.init();
        const components = await storeRef.current.loadAllComponents();
        for (const comp of components) {
          componentHtmlCache.current.set(comp.id, comp.html);
        }
        if (components.length > 0 && bridgeRef.current) {
          (bridgeRef.current as any).loadComponents(components);
        }
      } catch {}
    };
    init().catch(() => {});
  }, []);

  // Listen to session messages
  useEffect(() => {
    return onSessionMessage((msg: any) => {
      try {
        setMessages(prev => [...prev, msg]);

        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
        idleTimerRef.current = setTimeout(() => setIsProcessing(false), 3000);

        // Web direct mode: no bridge dispatch, just collect messages
        if (isWeb || !bridgeRef.current) return;

        const bridge = bridgeRef.current as any;
        switch (msg.content.type) {
          case 'text': {
            const text = msg.content.text;
            const componentRegex = /```morph-component:(\S+)\n([\s\S]*?)```/g;
            let match;
            while ((match = componentRegex.exec(text)) !== null) {
              const compId = match[1];
              const compHtml = match[2].trim();
              const prevHtml = componentHtmlCache.current.get(compId);
              componentHtmlCache.current.set(compId, compHtml);
              bridge.addComponent(compId, compHtml, 'draft');
              if (storeRef.current && compHtml !== prevHtml) {
                storeRef.current.saveComponent(compId, compHtml).catch(() => {});
              }
            }
            const cleanText = text.replace(componentRegex, '').trim();
            if (cleanText) bridge.sendEvent('message', { role: msg.role, text: cleanText });
            break;
          }
          case 'tool_call_start':
          case 'tool_call_end':
            bridge.sendEvent('tool_call', msg.content);
            break;
          case 'turn_end':
            if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
            setIsProcessing(false);
            bridge.sendEvent('turn_end', msg.content);
            break;
        }
      } catch {}
    });
  }, [onSessionMessage]);

  // Flush pending messages on connect
  useEffect(() => {
    if (connected && pendingMessagesRef.current.length > 0) {
      const queue = [...pendingMessagesRef.current];
      const sentIds = new Set(queue.map(q => q.localId));
      pendingMessagesRef.current = [];
      setMessages(prev => prev.map(msg =>
        sentIds.has(msg.id) ? { ...msg, pending: false } : msg
      ));
      for (const item of queue) rawSendMessage(item.wrappedText);
      setIsProcessing(true);
    }
  }, [connected, rawSendMessage]);

  const handleSend = useCallback((text: string) => {
    const localId = `local_${Date.now()}`;
    let fullText = text;

    // Native: sketch + prompt wrapping
    if (!isWeb && pendingSketch && promptLib) {
      const sketchMsg = promptLib.buildSketchMessage(
        pendingSketch.imageDataUrl, pendingSketch.dimensions, pendingSketch.strokes,
      );
      fullText = sketchMsg + (text ? '\n\n' + text : '');
      setPendingSketch(null);
    }

    // Native: wrap with canvas manifest
    const wrappedText = (!isWeb && promptLib)
      ? promptLib.wrapUserMessage(fullText, storeRef.current?.getManifest() || { components: [], order: [] }, activeTab)
      : fullText;

    const displayText = text || '[Sketch]';

    if (connected) {
      // Web direct mode: DirectConnectionContext shows user message optimistically
      // Native: show it here
      if (!isWeb) {
        setMessages(prev => [...prev, {
          id: localId, timestamp: Date.now(), role: 'user',
          content: { type: 'text', text: displayText },
        }]);
      }
      setIsProcessing(true);
      rawSendMessage(wrappedText);
    } else {
      setMessages(prev => [...prev, {
        id: localId, timestamp: Date.now(), role: 'user',
        content: { type: 'text', text: displayText }, pending: true,
      }]);
      pendingMessagesRef.current.push({ localId, wrappedText });
    }
  }, [connected, rawSendMessage, activeTab, pendingSketch]);

  const handleStop = useCallback(() => {
    if (!connected) return;
    sendInterrupt();
    setIsProcessing(false);
  }, [connected, sendInterrupt]);

  const handleAdopt = useCallback(async (componentId: string) => {
    if (!storeRef.current) return;
    const html = componentHtmlCache.current.get(componentId);
    if (html) await storeRef.current.saveComponent(componentId, html);
  }, []);

  const handleDismiss = useCallback(async (componentId: string) => {
    await storeRef.current?.removeComponent(componentId);
  }, []);

  const handleSketch = useCallback((imageDataUrl: string, width?: number, height?: number, viewportWidth?: number, viewportHeight?: number, strokes?: any[]) => {
    const dimensions = (viewportWidth && viewportHeight && width && height)
      ? { width, height, viewportWidth, viewportHeight } : undefined;
    setPendingSketch({ imageDataUrl, dimensions, strokes });
  }, []);

  const handleImage = useCallback((imageDataUrl: string) => {
    if (!connected) return;
    if (!isWeb && promptLib) {
      const manifest = storeRef.current?.getManifest() || { components: [], order: [] };
      rawSendMessage(promptLib.wrapUserMessage(promptLib.buildImageMessage(imageDataUrl), manifest, activeTab));
    } else {
      rawSendMessage(`[Image attached: ${imageDataUrl.slice(0, 30)}...]`);
    }
  }, [connected, rawSendMessage, activeTab]);

  const handleFile = useCallback((file: { name: string; mime: string; base64: string; size: number }) => {
    if (!connected) return;
    if (!isWeb && promptLib) {
      const manifest = storeRef.current?.getManifest() || { components: [], order: [] };
      rawSendMessage(promptLib.wrapUserMessage(promptLib.buildFileMessage(file), manifest, activeTab));
    } else {
      rawSendMessage(`[File: ${file.name} (${file.mime}, ${file.size} bytes)]\n\nBase64 content:\n${file.base64.slice(0, 200)}...`);
    }
  }, [connected, rawSendMessage, activeTab]);

  const handleOpenSketch = useCallback(() => {
    (bridgeRef.current as any)?.openSketch();
  }, []);

  if (_tabLoadError && !ChatPanel) {
    return (
      <View style={{ flex: 1, backgroundColor: '#0a0a0a', padding: 20, paddingTop: Constants.statusBarHeight + 20 }}>
        <Text selectable style={{ color: '#ff4444', fontSize: 16, fontWeight: 'bold', marginBottom: 12 }}>Module load error</Text>
        <ScrollView>
          <Text selectable style={{ color: '#aaa', fontSize: 13, fontFamily: 'Menlo' }}>{_tabLoadError}</Text>
        </ScrollView>
      </View>
    );
  }

  return (
    <View style={[styles.container, { backgroundColor: '#0a0a0a', paddingTop: Constants.statusBarHeight }]}>
      {/* Native only: Canvas WebView */}
      {!isWeb && Canvas && (
        <Canvas
          onSendMessage={handleSend}
          onAdopt={handleAdopt}
          onDismiss={handleDismiss}
          onSketch={handleSketch}
          bridgeRef={bridgeRef}
        />
      )}
      {ChatPanel && (
        <View style={isWeb ? styles.webFullScreen : undefined}>
          <ChatPanel
            messages={messages}
            onSend={handleSend}
            onStop={handleStop}
            onSketch={isWeb ? undefined : handleOpenSketch}
            onImage={handleImage}
            onFile={handleFile}
            connected={connected}
            connectionState={connectionState}
            isProcessing={isProcessing}
            pendingSketch={!isWeb && pendingSketch ? { strokeCount: pendingSketch.strokes?.length || 0 } : null}
            onClearSketch={() => setPendingSketch(null)}
            defaultTerminalOpen={isWeb}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webFullScreen: { flex: 1 },
});
