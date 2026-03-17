/**
 * REST API client for HappyCoder server.
 *
 * Base URL: https://api.cluster-fluster.com
 *
 * Endpoints (from types-CgkAW-7c.mjs):
 *   POST /v1/sessions    — create or load session by tag
 *   POST /v1/machines     — register or update machine
 *   POST /v1/auth/request — authentication / pairing
 *
 * All encrypted payloads are base64-encoded. Decryption uses the session
 * or machine encryption key + variant.
 */

import {
  toBase64,
  fromBase64,
  encryptJson,
  decryptJson,
  boxEncrypt,
} from './crypto';
import { randomBytes } from '@noble/ciphers/utils.js';

const API_BASE = 'https://api.cluster-fluster.com';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface Session {
  id: string;
  tag: string;
  seq: number;
  createdAt: number;
  updatedAt: number;
  metadata: any;
  metadataVersion: number;
  agentState: any;
  agentStateVersion: number;
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
}

export interface Machine {
  id: string;
  encryptionKey: Uint8Array;
  encryptionVariant: 'legacy' | 'dataKey';
  metadata: any;
  metadataVersion: number;
  daemonState: any;
  daemonStateVersion: number;
}

export interface SessionListItem {
  id: string;
  tag: string;
  seq: number;
  createdAt: number;
  updatedAt: number;
}

// ---------------------------------------------------------------------------
// API Client
// ---------------------------------------------------------------------------

export class HappyApi {
  private baseUrl: string;

  constructor(
    private token: string,
    baseUrl: string = API_BASE,
  ) {
    this.baseUrl = baseUrl;
  }

  private headers(): Record<string, string> {
    return {
      Authorization: `Bearer ${this.token}`,
      'Content-Type': 'application/json',
    };
  }

  // -----------------------------------------------------------------------
  // Sessions
  // -----------------------------------------------------------------------

  /**
   * Create a new session or load existing by tag.
   *
   * For dataKey variant: generates a random per-session AES key,
   * encrypts it with the account public key, and sends it as dataEncryptionKey.
   *
   * For legacy variant: uses the shared secret directly.
   */
  async createSession(
    tag: string,
    metadata: any,
    state: any | null,
    encKey: Uint8Array,
    variant: 'legacy' | 'dataKey',
    accountPublicKey?: Uint8Array,
  ): Promise<Session> {
    let sessionEncKey: Uint8Array;
    let dataEncryptionKey: string | null = null;

    if (variant === 'dataKey') {
      // Generate random per-session AES-256 key
      sessionEncKey = randomBytes(32);

      // Encrypt the session key for the account public key using box
      if (!accountPublicKey) {
        throw new Error('accountPublicKey required for dataKey variant');
      }
      const encryptedKey = boxEncrypt(sessionEncKey, accountPublicKey);
      // Prepend version byte
      const bundle = new Uint8Array(1 + encryptedKey.length);
      bundle[0] = 0x00;
      bundle.set(encryptedKey, 1);
      dataEncryptionKey = toBase64(bundle);
    } else {
      sessionEncKey = encKey;
    }

    const body: Record<string, any> = {
      tag,
      metadata: toBase64(encryptJson(sessionEncKey, variant, metadata)),
      agentState: state ? toBase64(encryptJson(sessionEncKey, variant, state)) : null,
    };

    if (dataEncryptionKey) {
      body.dataEncryptionKey = dataEncryptionKey;
    }

    const response = await fetch(`${this.baseUrl}/v1/sessions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Failed to create session: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const raw = data.session;

    return {
      id: raw.id,
      tag: raw.tag || tag,
      seq: raw.seq,
      createdAt: raw.createdAt,
      updatedAt: raw.updatedAt,
      metadata: decryptJson(sessionEncKey, variant, fromBase64(raw.metadata)),
      metadataVersion: raw.metadataVersion,
      agentState: raw.agentState
        ? decryptJson(sessionEncKey, variant, fromBase64(raw.agentState))
        : null,
      agentStateVersion: raw.agentStateVersion,
      encryptionKey: sessionEncKey,
      encryptionVariant: variant,
    };
  }

  /**
   * List sessions from the API.
   */
  async listSessions(limit?: number): Promise<SessionListItem[]> {
    const url = new URL(`${this.baseUrl}/v1/sessions`);
    if (limit) url.searchParams.set('limit', String(limit));

    const response = await fetch(url.toString(), {
      method: 'GET',
      headers: this.headers(),
    });

    if (!response.ok) {
      throw new Error(`Failed to list sessions: ${response.status}`);
    }

    const data = await response.json();
    return data.sessions || [];
  }

  /**
   * Fetch a session's dataEncryptionKey from the session list.
   * The server returns dataEncryptionKey for each session — this is the
   * session key encrypted with the account's publicKey via X25519 box.
   */
  async getSessionDataEncryptionKey(sessionId: string): Promise<string | null> {
    const response = await fetch(`${this.baseUrl}/v1/sessions`, {
      method: 'GET',
      headers: this.headers(),
    });

    if (!response.ok) return null;

    const data = await response.json();
    const sessions = data.sessions || [];
    const session = sessions.find((s: any) => s.id === sessionId);
    return session?.dataEncryptionKey || null;
  }

  /**
   * Send messages to a session.
   * Messages are pre-encrypted + base64-encoded by the caller.
   */
  async sendMessage(sessionId: string, messages: string[]): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/sessions/${sessionId}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ messages }),
    });

    if (!response.ok) {
      throw new Error(`Failed to send message: ${response.status}`);
    }
  }

  // -----------------------------------------------------------------------
  // Machines
  // -----------------------------------------------------------------------

  /**
   * Register or update a machine with the server.
   */
  async registerMachine(
    machineId: string,
    metadata: any,
    encKey: Uint8Array,
    variant: 'legacy' | 'dataKey',
    accountPublicKey?: Uint8Array,
    daemonState?: any,
  ): Promise<Machine> {
    let dataEncryptionKey: string | undefined;

    if (variant === 'dataKey' && accountPublicKey) {
      const encryptedKey = boxEncrypt(encKey, accountPublicKey);
      const bundle = new Uint8Array(1 + encryptedKey.length);
      bundle[0] = 0x00;
      bundle.set(encryptedKey, 1);
      dataEncryptionKey = toBase64(bundle);
    }

    const body: Record<string, any> = {
      id: machineId,
      metadata: toBase64(encryptJson(encKey, variant, metadata)),
    };

    if (daemonState) {
      body.daemonState = toBase64(encryptJson(encKey, variant, daemonState));
    }
    if (dataEncryptionKey) {
      body.dataEncryptionKey = dataEncryptionKey;
    }

    const response = await fetch(`${this.baseUrl}/v1/machines`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      throw new Error(`Failed to register machine: ${response.status} ${response.statusText}`);
    }

    const data = await response.json();
    const raw = data.machine;

    return {
      id: raw.id,
      encryptionKey: encKey,
      encryptionVariant: variant,
      metadata: raw.metadata ? decryptJson(encKey, variant, fromBase64(raw.metadata)) : null,
      metadataVersion: raw.metadataVersion || 0,
      daemonState: raw.daemonState ? decryptJson(encKey, variant, fromBase64(raw.daemonState)) : null,
      daemonStateVersion: raw.daemonStateVersion || 0,
    };
  }

  /**
   * List machines associated with this account.
   */
  async listMachines(): Promise<any[]> {
    const response = await fetch(`${this.baseUrl}/v1/machines`, {
      method: 'GET',
      headers: this.headers(),
    });

    if (!response.ok) {
      throw new Error(`Failed to list machines: ${response.status}`);
    }

    const data = await response.json();
    return data.machines || [];
  }

  // -----------------------------------------------------------------------
  // Vendor tokens (connect)
  // -----------------------------------------------------------------------

  async registerVendorToken(vendor: string, apiKey: any): Promise<void> {
    const response = await fetch(`${this.baseUrl}/v1/connect/${vendor}/register`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify({ token: JSON.stringify(apiKey) }),
    });

    if (!response.ok) {
      throw new Error(`Failed to register vendor token: ${response.status}`);
    }
  }

  async getVendorToken(vendor: string): Promise<any | null> {
    const response = await fetch(`${this.baseUrl}/v1/connect/${vendor}/token`, {
      method: 'GET',
      headers: this.headers(),
    });

    if (response.status === 404) return null;
    if (!response.ok) return null;

    const data = await response.json();
    if (!data?.token) return null;

    if (typeof data.token === 'string') {
      try {
        return JSON.parse(data.token);
      } catch {
        return data.token;
      }
    }

    return data.token;
  }
}
