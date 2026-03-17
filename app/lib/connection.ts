/**
 * Socket.IO connection manager for HappyCoder protocol.
 *
 * Two client scopes (matches server expectations):
 * - "session-scoped": auth.sessionId — for watching a single session
 * - "machine-scoped": auth.machineId — for daemon/machine-level updates
 *
 * Socket.IO config extracted from HappyCoder source (types-CgkAW-7c.mjs):
 * - path: '/v1/updates'
 * - transports: ['websocket']
 * - reconnection with exponential backoff (1s–5s)
 * - withCredentials: true (session-scoped)
 * - autoConnect: false (we call connect() explicitly)
 */

import { io, Socket } from 'socket.io-client';

export const DEFAULT_SERVER = 'https://api.cluster-fluster.com';

export type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

export type UpdateCallback = (data: any) => void;
export type StateCallback = (state: ConnectionState) => void;

export class HappyConnection {
  private socket: Socket | null = null;
  private state: ConnectionState = 'disconnected';
  private updateListeners = new Set<UpdateCallback>();
  private stateListeners = new Set<StateCallback>();

  // ------------------------------------------------------------------
  // Connect
  // ------------------------------------------------------------------

  /**
   * Open a Socket.IO connection to the Happy server.
   *
   * @param serverUrl  - e.g. "https://api.cluster-fluster.com"
   * @param token      - auth bearer token from pairing
   * @param clientType - "session-scoped" | "machine-scoped"
   * @param scopeId    - sessionId (session-scoped) or machineId (machine-scoped)
   */
  connect(
    serverUrl: string,
    token: string,
    clientType: 'session-scoped' | 'machine-scoped',
    scopeId: string,
  ): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }

    this.setState('connecting');

    const authPayload: Record<string, string> = {
      token,
      clientType,
    };

    if (clientType === 'session-scoped') {
      authPayload.sessionId = scopeId;
    } else {
      authPayload.machineId = scopeId;
    }

    this.socket = io(serverUrl, {
      auth: authPayload,
      path: '/v1/updates',
      transports: ['websocket'],
      reconnection: true,
      reconnectionAttempts: Infinity,
      reconnectionDelay: 1000,
      reconnectionDelayMax: 5000,
      withCredentials: clientType === 'session-scoped',
      autoConnect: false,
    });

    // --- Socket events ---

    this.socket.on('connect', () => {
      console.log('[HappyConn] socket connected, id:', this.socket?.id);
      this.setState('connected');
    });

    this.socket.on('disconnect', (reason: string) => {
      console.log('[HappyConn] socket disconnected:', reason);
      this.setState('disconnected');
    });

    this.socket.on('connect_error', (error: Error) => {
      console.log('[HappyConn] connect_error:', error.message);
      this.setState('error');
    });

    this.socket.on('update', (data: any) => {
      console.log('[HappyConn] received "update" event');
      for (const cb of this.updateListeners) {
        try {
          cb(data);
        } catch {
          // don't let one bad listener break the loop
        }
      }
    });

    this.socket.on('error', (error: Error) => {
      console.log('[HappyConn] socket error:', error.message);
      this.setState('error');
    });

    this.socket.connect();
  }

  // ------------------------------------------------------------------
  // Disconnect
  // ------------------------------------------------------------------

  disconnect(): void {
    if (this.socket) {
      this.socket.close();
      this.socket = null;
    }
    this.setState('disconnected');
  }

  // ------------------------------------------------------------------
  // Send message
  // ------------------------------------------------------------------

  /**
   * Emit an encrypted message to a session.
   *
   * The `encryptedContent` should already be base64-encoded ciphertext
   * (caller is responsible for encrypt + toBase64).
   */
  async sendMessage(sessionId: string, encryptedContent: string): Promise<void> {
    if (!this.socket?.connected) {
      throw new Error('Socket not connected');
    }
    this.socket.emit('message', {
      sid: sessionId,
      message: encryptedContent,
    });
  }

  // ------------------------------------------------------------------
  // Session keep-alive & end (mirrors ApiSessionClient)
  // ------------------------------------------------------------------

  sendKeepAlive(sessionId: string, thinking: boolean, mode: string): void {
    this.socket?.volatile.emit('session-alive', {
      sid: sessionId,
      time: Date.now(),
      thinking,
      mode,
    });
  }

  sendSessionEnd(sessionId: string): void {
    this.socket?.emit('session-end', {
      sid: sessionId,
      time: Date.now(),
    });
  }

  /**
   * Send interrupt/abort to stop the current CC turn.
   * Sends session-end which signals the server to abort the running turn.
   */
  sendInterrupt(sessionId: string): void {
    this.socket?.emit('session-end', {
      sid: sessionId,
      time: Date.now(),
    });
  }

  // ------------------------------------------------------------------
  // Machine keep-alive (mirrors ApiMachineClient, 20s interval)
  // ------------------------------------------------------------------

  sendMachineAlive(machineId: string): void {
    this.socket?.emit('machine-alive', {
      machineId,
      time: Date.now(),
    });
  }

  // ------------------------------------------------------------------
  // Metadata & state updates (emitWithAck)
  // ------------------------------------------------------------------

  async updateMetadata(
    sessionId: string,
    metadata: string,
    expectedVersion: number,
  ): Promise<any> {
    if (!this.socket?.connected) {
      throw new Error('Socket not connected');
    }
    return this.socket.emitWithAck('update-metadata', {
      sid: sessionId,
      expectedVersion,
      metadata,
    });
  }

  async updateState(
    sessionId: string,
    agentState: string | null,
    expectedVersion: number,
  ): Promise<any> {
    if (!this.socket?.connected) {
      throw new Error('Socket not connected');
    }
    return this.socket.emitWithAck('update-state', {
      sid: sessionId,
      expectedVersion,
      agentState,
    });
  }

  // ------------------------------------------------------------------
  // RPC (for future use — machine-scoped handlers)
  // ------------------------------------------------------------------

  registerRpc(method: string): void {
    this.socket?.emit('rpc-register', { method });
  }

  onRpcRequest(handler: (data: any) => Promise<string>): () => void {
    const cb = async (data: any, callback: (response: string) => void) => {
      const response = await handler(data);
      callback(response);
    };
    this.socket?.on('rpc-request', cb);
    return () => {
      this.socket?.off('rpc-request', cb);
    };
  }

  // ------------------------------------------------------------------
  // Subscriptions
  // ------------------------------------------------------------------

  /**
   * Subscribe to decrypted update events. Returns unsubscribe function.
   */
  onUpdate(callback: UpdateCallback): () => void {
    this.updateListeners.add(callback);
    return () => {
      this.updateListeners.delete(callback);
    };
  }

  /**
   * Subscribe to connection state changes. Returns unsubscribe function.
   */
  onStateChange(callback: StateCallback): () => void {
    this.stateListeners.add(callback);
    return () => {
      this.stateListeners.delete(callback);
    };
  }

  getState(): ConnectionState {
    return this.state;
  }

  isConnected(): boolean {
    return this.state === 'connected' && !!this.socket?.connected;
  }

  // ------------------------------------------------------------------
  // Internal
  // ------------------------------------------------------------------

  private setState(state: ConnectionState): void {
    if (this.state === state) return;
    this.state = state;
    for (const cb of this.stateListeners) {
      try {
        cb(state);
      } catch {
        // swallow
      }
    }
  }
}
