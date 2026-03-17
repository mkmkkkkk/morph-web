import React, { useRef, useState, useEffect } from 'react';
import { StyleSheet, View } from 'react-native';
import { WebView } from 'react-native-webview';
import { MorphBridge, BridgeHandlers } from '../lib/bridge';

const CANVAS_HTML = require('../assets/canvas.html');

interface CanvasProps {
  onSendMessage: (message: string) => void;
  onAdopt: (componentId: string) => void;
  onDismiss: (componentId: string) => void;
  onSketch?: (imageDataUrl: string, width?: number, height?: number, viewportWidth?: number, viewportHeight?: number) => void;
  bridgeRef: React.MutableRefObject<MorphBridge | null>;
}

export default function Canvas({ onSendMessage, onAdopt, onDismiss, onSketch, bridgeRef }: CanvasProps) {
  const webViewRef = useRef<WebView>(null);
  const [sketchActive, setSketchActive] = useState(false);

  useEffect(() => {
    const handlers: BridgeHandlers = {
      onSend: onSendMessage,
      onAdopt: onAdopt,
      onDismiss: onDismiss,
      onStoreSet: () => {},
      onSketch: (img: string, w?: number, h?: number, vw?: number, vh?: number) => {
        setSketchActive(false);
        onSketch?.(img, w, h, vw, vh);
      },
      onSketchOpen: () => setSketchActive(true),
      onSketchClose: () => setSketchActive(false),
    };
    bridgeRef.current = new MorphBridge(webViewRef, handlers);
  }, [onSendMessage, onAdopt, onDismiss, onSketch, bridgeRef]);

  return (
    <View style={styles.container}>
      <WebView
        ref={webViewRef}
        source={CANVAS_HTML}
        style={styles.webview}
        originWhitelist={['*']}
        javaScriptEnabled={true}
        domStorageEnabled={true}
        onMessage={(event) => bridgeRef.current?.handleMessage(event)}
        scrollEnabled={!sketchActive}
        bounces={false}
        overScrollMode="never"
        showsVerticalScrollIndicator={false}
        onShouldStartLoadWithRequest={() => true}
      />
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1 },
  webview: { flex: 1, backgroundColor: '#0a0a0a' },
});
