/**
 * CanvasWeb — iframe-based Canvas for web platform.
 * Same bridge protocol as native WebView Canvas, but uses iframe + postMessage.
 */

import React, { useRef, useState, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { MorphBridge, BridgeHandlers } from '../lib/bridge-web';

interface CanvasWebProps {
  onSendMessage: (message: string) => void;
  onAdopt: (componentId: string) => void;
  onDismiss: (componentId: string) => void;
  onSketch?: (imageDataUrl: string, width?: number, height?: number, viewportWidth?: number, viewportHeight?: number, strokes?: any[]) => void;
  bridgeRef: React.MutableRefObject<MorphBridge | null>;
}

export default function CanvasWeb({ onSendMessage, onAdopt, onDismiss, onSketch, bridgeRef }: CanvasWebProps) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const [sketchActive, setSketchActive] = useState(false);

  useEffect(() => {
    const handlers: BridgeHandlers = {
      onSend: onSendMessage,
      onAdopt: onAdopt,
      onDismiss: onDismiss,
      onStoreSet: () => {},
      onSketch: (img: string, w?: number, h?: number, vw?: number, vh?: number, strokes?: any[]) => {
        setSketchActive(false);
        onSketch?.(img, w, h, vw, vh, strokes);
      },
      onSketchOpen: () => setSketchActive(true),
      onSketchClose: () => setSketchActive(false),
    };

    const bridge = new MorphBridge(iframeRef, handlers);
    bridgeRef.current = bridge;

    return () => {
      bridge.destroy();
      bridgeRef.current = null;
    };
  }, [onSendMessage, onAdopt, onDismiss, onSketch]);

  return (
    <View style={styles.container}>
      <iframe
        ref={iframeRef as any}
        src="/canvas.html"
        style={{
          width: '100%',
          height: '100%',
          border: 'none',
          backgroundColor: '#0a0a0a',
        }}
        sandbox="allow-scripts allow-same-origin"
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0a0a0a',
  },
});
