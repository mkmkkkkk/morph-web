/**
 * Web-compatible MorphBridge — uses iframe postMessage instead of WebView.
 * Same API as bridge.ts so components can use either interchangeably.
 */

import { RefObject } from 'react';

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
  private iframeRef: RefObject<HTMLIFrameElement | null>;
  private handlers: BridgeHandlers;
  private messageHandler: ((event: MessageEvent) => void) | null = null;

  constructor(iframeRef: RefObject<HTMLIFrameElement | null>, handlers: BridgeHandlers) {
    this.iframeRef = iframeRef;
    this.handlers = handlers;

    // Listen for postMessage from iframe
    this.messageHandler = (event: MessageEvent) => {
      // Only accept messages from our iframe
      if (typeof event.data !== 'string') return;
      this.handleMessage(event.data);
    };
    window.addEventListener('message', this.messageHandler);
  }

  destroy(): void {
    if (this.messageHandler) {
      window.removeEventListener('message', this.messageHandler);
      this.messageHandler = null;
    }
  }

  /** Handle messages from iframe */
  handleMessage(raw: string): void {
    let msg: BridgeMessage;
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
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
        break;
    }
  }

  /** Send commands to iframe */
  injectCommand(action: string, payload: Record<string, any>): void {
    const message = JSON.stringify({ action, ...payload });
    const iframe = this.iframeRef.current;
    if (iframe?.contentWindow) {
      // Use postMessage to send to iframe
      iframe.contentWindow.postMessage(message, '*');
    }
  }

  addComponent(id: string, html: string, status: 'draft' | 'adopted' = 'draft'): void {
    this.injectCommand('canvas.add', { id, html, status });
  }

  updateComponent(id: string, html: string): void {
    this.injectCommand('canvas.update', { id, html });
  }

  removeComponent(id: string): void {
    this.injectCommand('canvas.remove', { id });
  }

  loadComponents(components: Array<{ id: string; html: string }>): void {
    this.injectCommand('canvas.load', { components });
  }

  openSketch(): void {
    this.injectCommand('sketch.open', {});
  }

  sendEvent(event: string, data: any): void {
    this.injectCommand(event, { data });
  }
}
