import { RefObject } from 'react';
import WebView from 'react-native-webview';

export type BridgeMessage = {
  action: string;
  [key: string]: any;
};

export type SendMessageHandler = (message: string) => void;
export type AdoptHandler = (componentId: string) => void;
export type DismissHandler = (componentId: string) => void;
export type StoreSetHandler = (key: string, value: any) => void;
export type SketchStroke = {
  color: string;
  bbox: { x: number; y: number; w: number; h: number };
  points: Array<{ x: number; y: number }>;
};
export type SketchHandler = (imageDataUrl: string, width?: number, height?: number, viewportWidth?: number, viewportHeight?: number, strokes?: SketchStroke[]) => void;

export interface BridgeHandlers {
  onSend: SendMessageHandler;
  onAdopt: AdoptHandler;
  onDismiss: DismissHandler;
  onStoreSet: StoreSetHandler;
  onSketch?: SketchHandler;
  onSketchOpen?: () => void;
  onSketchClose?: () => void;
}

export class MorphBridge {
  private webViewRef: RefObject<WebView | null>;
  private handlers: BridgeHandlers;

  constructor(webViewRef: RefObject<WebView | null>, handlers: BridgeHandlers) {
    this.webViewRef = webViewRef;
    this.handlers = handlers;
  }

  /** Handle messages from WebView */
  handleMessage(event: { nativeEvent: { data: string } }): void {
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(event.nativeEvent.data);
    } catch {
      return; // Ignore malformed messages
    }

    switch (msg.action) {
      case 'send':
        this.handlers.onSend(msg.message);
        break;
      case 'adopt':
        this.handlers.onAdopt(msg.componentId);
        break;
      case 'dismiss':
        this.handlers.onDismiss(msg.componentId);
        break;
      case 'store.set':
        this.handlers.onStoreSet(msg.key, msg.value);
        break;
      case 'sketch':
        this.handlers.onSketch?.(msg.image, msg.width, msg.height, msg.viewportWidth, msg.viewportHeight, msg.strokes);
        break;
      case 'sketch.opened':
        this.handlers.onSketchOpen?.();
        break;
      case 'sketch.closed':
        this.handlers.onSketchClose?.();
        break;
      case 'canvas.ready':
        // Canvas loaded and ready — no-op on native side for now
        break;
    }
  }

  /** Send commands to WebView */
  injectCommand(action: string, payload: Record<string, any>): void {
    const message = JSON.stringify({ action, ...payload });
    const js = `window._morphReceive(${message});true;`;
    this.webViewRef.current?.injectJavaScript(js);
  }

  /** Add a component to the canvas */
  addComponent(id: string, html: string, status: 'draft' | 'adopted' = 'draft'): void {
    this.injectCommand('canvas.add', { id, html, status });
  }

  /** Update an existing component's HTML */
  updateComponent(id: string, html: string): void {
    this.injectCommand('canvas.update', { id, html });
  }

  /** Remove a component from the canvas */
  removeComponent(id: string): void {
    this.injectCommand('canvas.remove', { id });
  }

  /** Load multiple adopted components at once (startup) */
  loadComponents(components: Array<{ id: string; html: string }>): void {
    this.injectCommand('canvas.load', { components });
  }

  /** Open sketch mode in the WebView */
  openSketch(): void {
    this.injectCommand('sketch.open', {});
  }

  /** Send an event to the WebView (message, tool_call, turn_end) */
  sendEvent(event: string, data: any): void {
    this.injectCommand(event, { data });
  }
}
