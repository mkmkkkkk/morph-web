import React, { useRef, useState, useEffect, useCallback } from 'react';
import { View, Text, StyleSheet, ScrollView } from 'react-native';
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

__DEV__ && console.log('[CanvasScreen] module loaded, Canvas=', !!Canvas, 'ChatPanel=', !!ChatPanel, 'errors=', _tabLoadError);

export default function CanvasScreen() {
  __DEV__ && console.log('[CanvasScreen] render START');
  // ALL hooks must be called unconditionally (Rules of Hooks)
  const bridgeRef = useRef(null);
  const storeRef = useRef(ComponentStore ? new ComponentStore() : null);
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

  __DEV__ && console.log('[CanvasScreen] connection state:', connectionState, 'connected:', connected, 'lastError:', lastError);

  const [isProcessing, setIsProcessing] = useState(false);
  const [messages, setMessages] = useState<any[]>([]);
  const [pendingSketch, setPendingSketch] = useState<{
    imageDataUrl: string;
    dimensions?: { width: number; height: number; viewportWidth: number; viewportHeight: number };
    strokes?: any[];
  } | null>(null);
  const idleTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingMessagesRef = useRef<{ localId: string; wrappedText: string }[]>([]);

  // Initialize component store
  useEffect(() => {
    __DEV__ && console.log('[CanvasScreen] mount: storeRef=', !!storeRef.current, 'Canvas=', !!Canvas, 'ChatPanel=', !!ChatPanel);
    if (!storeRef.current) return;
    const init = async () => {
      try {
        await storeRef.current.init();
        const components = await storeRef.current.loadAllComponents();
        __DEV__ && console.log('[CanvasScreen] store init OK, components=', components.length);
        // Populate HTML cache so draft-persist dedup works after refresh
        for (const comp of components) {
          componentHtmlCache.current.set(comp.id, comp.html);
        }
        if (components.length > 0 && bridgeRef.current) {
          (bridgeRef.current as any).loadComponents(components);
        }
      } catch (err: any) {
        __DEV__ && console.error('[CanvasScreen] store init FAILED:', err?.message);
      }
    };
    init().catch(() => {});
  }, []);

  // Listen to session messages
  useEffect(() => {
    __DEV__ && console.log('[CanvasScreen] subscribing to onSessionMessage');
    return onSessionMessage((msg: any) => {
      try {
        __DEV__ && console.log('[CanvasScreen] onSessionMessage: type=', msg?.content?.type, 'role=', msg?.role, 'id=', msg?.id);
        setMessages(prev => [...prev, msg]);

        // Reset idle timer — after 3s of no messages, assume turn ended
        if (idleTimerRef.current) clearTimeout(idleTimerRef.current);
        idleTimerRef.current = setTimeout(() => {
          setIsProcessing(false);
        }, 3000);

        if (!bridgeRef.current) {
          __DEV__ && console.log('[CanvasScreen] no bridgeRef, skipping bridge dispatch');
          return;
        }
        const bridge = bridgeRef.current as any;

        switch (msg.content.type) {
          case 'text': {
            const text = msg.content.text;
            __DEV__ && console.log('[CanvasScreen] text message, length=', text?.length, 'preview=', text?.slice(0, 80));
            const componentRegex = /```morph-component:(\S+)\n([\s\S]*?)```/g;
            let match;

            while ((match = componentRegex.exec(text)) !== null) {
              const compId = match[1];
              const compHtml = match[2].trim();
              __DEV__ && console.log('[CanvasScreen] found morph-component:', compId);
              const prevHtml = componentHtmlCache.current.get(compId);
              componentHtmlCache.current.set(compId, compHtml);
              bridge.addComponent(compId, compHtml, 'draft');
              // Auto-persist draft so it survives app refresh
              if (storeRef.current && compHtml !== prevHtml) {
                storeRef.current.saveComponent(compId, compHtml).catch((e: any) =>
                  __DEV__ && console.warn('[CanvasScreen] draft persist failed:', compId, e?.message)
                );
              }
            }

            const cleanText = text.replace(componentRegex, '').trim();
            if (cleanText) {
              bridge.sendEvent('message', { role: msg.role, text: cleanText });
            }
            break;
          }

          case 'tool_call_start':
          case 'tool_call_end':
            __DEV__ && console.log('[CanvasScreen] tool_call:', msg.content.type, msg.content.name);
            bridge.sendEvent('tool_call', msg.content);
            break;

          case 'turn_end':
            __DEV__ && console.log('[CanvasScreen] turn_end, status=', msg.content.status);
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
        __DEV__ && console.error('[CanvasScreen] onSessionMessage THREW:', err?.message, err?.stack);
      }
    });
  }, [onSessionMessage]);

  // Flush pending message queue when connection is established
  useEffect(() => {
    if (connected && pendingMessagesRef.current.length > 0) {
      __DEV__ && console.log('[CanvasScreen] connected — flushing', pendingMessagesRef.current.length, 'pending messages');
      const queue = [...pendingMessagesRef.current];
      const sentIds = new Set(queue.map(q => q.localId));
      pendingMessagesRef.current = [];

      // Clear pending flag on queued messages
      setMessages(prev => prev.map(msg =>
        sentIds.has(msg.id) ? { ...msg, pending: false } : msg
      ));

      // Send each queued message in order
      for (const item of queue) {
        rawSendMessage(item.wrappedText);
        __DEV__ && console.log('[CanvasScreen] sent queued message:', item.localId);
      }
      setIsProcessing(true);
    }
  }, [connected, rawSendMessage]);

  const handleSend = useCallback((text: string) => {
    __DEV__ && console.log('[CanvasScreen] handleSend: connected=', connected, 'text=', JSON.stringify(text).slice(0, 100));
    try {
      const localId = `local_${Date.now()}`;
      const manifest = storeRef.current?.getManifest() || { components: [], order: [] };

      // If there's a pending sketch, combine it with the user text
      let fullText = text;
      if (pendingSketch && promptLib) {
        const sketchMsg = promptLib.buildSketchMessage(
          pendingSketch.imageDataUrl,
          pendingSketch.dimensions,
          pendingSketch.strokes,
        );
        fullText = sketchMsg + (text ? '\n\n' + text : '');
        setPendingSketch(null);
      }

      const wrappedText = promptLib?.wrapUserMessage(fullText, manifest, activeTab) || fullText;
      // Display label: show user text or "Sketch" if sketch-only
      const displayText = text || '[Sketch]';

      if (connected) {
        setMessages(prev => [...prev, {
          id: localId,
          timestamp: Date.now(),
          role: 'user',
          content: { type: 'text', text: displayText },
        }]);
        __DEV__ && console.log('[CanvasScreen] wrappedText length=', wrappedText.length);
        setIsProcessing(true);
        rawSendMessage(wrappedText);
      } else {
        setMessages(prev => [...prev, {
          id: localId,
          timestamp: Date.now(),
          role: 'user',
          content: { type: 'text', text: displayText },
          pending: true,
        }]);
        pendingMessagesRef.current.push({ localId, wrappedText });
        __DEV__ && console.log('[CanvasScreen] message queued, queue size=', pendingMessagesRef.current.length);
      }
    } catch (err: any) {
      __DEV__ && console.error('[CanvasScreen] handleSend THREW:', err?.message, err?.stack);
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
    if (!html) {
      __DEV__ && console.warn('[CanvasScreen] handleAdopt: no cached HTML for', componentId);
      return;
    }
    await storeRef.current.saveComponent(componentId, html);
    __DEV__ && console.log('[CanvasScreen] adopted component:', componentId);
  }, []);

  const handleDismiss = useCallback(async (componentId: string) => {
    await storeRef.current?.removeComponent(componentId);
  }, []);

  const handleSketch = useCallback((imageDataUrl: string, width?: number, height?: number, viewportWidth?: number, viewportHeight?: number, strokes?: any[]) => {
    const dimensions = (viewportWidth && viewportHeight && width && height)
      ? { width, height, viewportWidth, viewportHeight }
      : undefined;
    setPendingSketch({ imageDataUrl, dimensions, strokes });
  }, []);

  const handleImage = useCallback((imageDataUrl: string) => {
    if (!connected || !promptLib) return;
    const manifest = storeRef.current?.getManifest() || { components: [], order: [] };
    rawSendMessage(promptLib.wrapUserMessage(promptLib.buildImageMessage(imageDataUrl), manifest, activeTab));
  }, [connected, rawSendMessage, activeTab]);

  const handleFile = useCallback((file: { name: string; mime: string; base64: string; size: number }) => {
    if (!connected || !promptLib) return;
    const manifest = storeRef.current?.getManifest() || { components: [], order: [] };
    rawSendMessage(promptLib.wrapUserMessage(promptLib.buildFileMessage(file), manifest, activeTab));
  }, [connected, rawSendMessage, activeTab]);

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
          connectionState={connectionState}
          isProcessing={isProcessing}
          pendingSketch={pendingSketch ? { strokeCount: pendingSketch.strokes?.length || 0 } : null}
          onClearSketch={() => setPendingSketch(null)}
        />
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
