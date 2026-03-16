import React, { useRef, useState, useEffect, useCallback } from 'react';
import { View, StyleSheet, useColorScheme } from 'react-native';
import Canvas from '../../components/Canvas';
import InputBar from '../../components/InputBar';
import { MorphBridge } from '../../lib/bridge';
import { useConnection } from '../../lib/ConnectionContext';
import { ComponentStore } from '../../lib/store';
import { wrapUserMessage, buildSketchMessage, buildImageMessage, buildFileMessage } from '../../lib/prompt';
import { type SessionMessage } from '../../lib/protocol';

export default function CanvasScreen() {
  const colorScheme = useColorScheme();
  const bridgeRef = useRef<MorphBridge | null>(null);
  const storeRef = useRef(new ComponentStore());

  const {
    connected,
    sessionId,
    sendMessage: rawSendMessage,
    sendInterrupt,
    onSessionMessage,
  } = useConnection();

  const [isProcessing, setIsProcessing] = useState(false);

  // Initialize component store and load adopted components
  useEffect(() => {
    const init = async () => {
      await storeRef.current.init();
      const components = await storeRef.current.loadAllComponents();
      if (components.length > 0) {
        const checkBridge = setInterval(() => {
          if (bridgeRef.current) {
            bridgeRef.current.loadComponents(components);
            clearInterval(checkBridge);
          }
        }, 100);
        setTimeout(() => clearInterval(checkBridge), 5000);
      }
    };
    init();
  }, []);

  // Listen to session messages from shared connection
  useEffect(() => {
    return onSessionMessage((msg: SessionMessage) => {
      if (!bridgeRef.current) return;

      switch (msg.content.type) {
        case 'text': {
          const text = msg.content.text;
          const componentRegex = /```morph-component:(\S+)\n([\s\S]*?)```/g;
          let match;

          while ((match = componentRegex.exec(text)) !== null) {
            const compId = match[1];
            const compHtml = match[2].trim();
            bridgeRef.current.addComponent(compId, compHtml, 'draft');
          }

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
          setIsProcessing(false);
          bridgeRef.current.sendEvent('turn_end', msg.content);
          break;
      }
    });
  }, [onSessionMessage]);

  // Send message to CC via shared connection
  const handleSend = useCallback((text: string) => {
    if (!connected) return;
    const manifest = storeRef.current.getManifest();
    const wrappedText = wrapUserMessage(text, manifest);
    setIsProcessing(true);
    rawSendMessage(wrappedText);
  }, [connected, rawSendMessage]);

  // Stop / interrupt CC
  const handleStop = useCallback(() => {
    if (!connected) return;
    sendInterrupt();
    setIsProcessing(false);
  }, [connected, sendInterrupt]);

  // Adopt a component
  const handleAdopt = useCallback(async (_componentId: string) => {
    // TODO: persist component HTML when bridge supports getHtml
  }, []);

  // Dismiss a component
  const handleDismiss = useCallback(async (componentId: string) => {
    await storeRef.current.removeComponent(componentId);
  }, []);

  // Handle sketch image
  const handleSketch = useCallback((imageDataUrl: string) => {
    if (!connected) return;
    const manifest = storeRef.current.getManifest();
    const sketchText = buildSketchMessage(imageDataUrl);
    rawSendMessage(wrapUserMessage(sketchText, manifest));
  }, [connected, rawSendMessage]);

  // Handle photo/image
  const handleImage = useCallback((imageDataUrl: string) => {
    if (!connected) return;
    const manifest = storeRef.current.getManifest();
    const imageText = buildImageMessage(imageDataUrl);
    rawSendMessage(wrapUserMessage(imageText, manifest));
  }, [connected, rawSendMessage]);

  // Handle file
  const handleFile = useCallback((file: { name: string; mime: string; base64: string; size: number }) => {
    if (!connected) return;
    const manifest = storeRef.current.getManifest();
    const fileText = buildFileMessage(file);
    rawSendMessage(wrapUserMessage(fileText, manifest));
  }, [connected, rawSendMessage]);

  // Open sketch mode
  const handleOpenSketch = useCallback(() => {
    bridgeRef.current?.openSketch();
  }, []);

  return (
    <View style={[styles.container, { backgroundColor: '#0a0a0a' }]}>
      <Canvas
        onSendMessage={handleSend}
        onAdopt={handleAdopt}
        onDismiss={handleDismiss}
        onSketch={handleSketch}
        bridgeRef={bridgeRef}
      />
      <InputBar
        onSend={handleSend}
        onStop={handleStop}
        onSketch={handleOpenSketch}
        onImage={handleImage}
        onFile={handleFile}
        connected={connected}
        isProcessing={isProcessing}
        forceDark
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
});
