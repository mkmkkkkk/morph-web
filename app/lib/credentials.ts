/**
 * Credential storage using expo-secure-store.
 *
 * Stores the HappyCoder pairing credentials (token + encryption keys)
 * in hardware-backed secure storage (Keychain on iOS, Keystore on Android).
 *
 * Two credential formats (matching ~/.happy/credentials.json):
 * - Legacy: { token, secret } → encryption via tweetnacl secretbox
 * - Modern: { token, encryption: { publicKey, machineKey } } → AES-256-GCM
 */

import { Platform } from 'react-native';
import { fromBase64, toBase64 } from './crypto';

const CRED_KEY = 'happy_credentials';

// expo-secure-store is not available on web — use localStorage fallback
const SecureStore = Platform.OS === 'web'
  ? {
      setItemAsync: async (key: string, value: string) => { localStorage.setItem(key, value); },
      getItemAsync: async (key: string) => localStorage.getItem(key),
      deleteItemAsync: async (key: string) => { localStorage.removeItem(key); },
    }
  : require('expo-secure-store');

export type EncryptionVariant = 'legacy' | 'dataKey';

export interface HappyCredentials {
  token: string;
  encryption: {
    type: EncryptionVariant;
    key: Uint8Array;        // 32-byte secret (legacy) or derived key
    publicKey?: Uint8Array; // Only for dataKey variant
    machineKey?: Uint8Array;
  };
  serverUrl?: string;
  machineId?: string;
}

/** Raw JSON shape stored in SecureStore */
interface StoredCredentials {
  token: string;
  variant: EncryptionVariant;
  key: string;          // base64
  publicKey?: string;   // base64
  machineKey?: string;  // base64
  serverUrl?: string;
  machineId?: string;
}

/**
 * Save credentials to secure storage.
 */
export async function saveCredentials(creds: HappyCredentials): Promise<void> {
  const stored: StoredCredentials = {
    token: creds.token,
    variant: creds.encryption.type,
    key: toBase64(creds.encryption.key),
  };
  if (creds.encryption.publicKey) {
    stored.publicKey = toBase64(creds.encryption.publicKey);
  }
  if (creds.encryption.machineKey) {
    stored.machineKey = toBase64(creds.encryption.machineKey);
  }
  if (creds.serverUrl) {
    stored.serverUrl = creds.serverUrl;
  }
  if (creds.machineId) {
    stored.machineId = creds.machineId;
  }
  await SecureStore.setItemAsync(CRED_KEY, JSON.stringify(stored));
}

/**
 * Load credentials from secure storage. Returns null if not paired.
 */
export async function loadCredentials(): Promise<HappyCredentials | null> {
  const raw = await SecureStore.getItemAsync(CRED_KEY);
  if (!raw) return null;

  try {
    const stored: StoredCredentials = JSON.parse(raw);
    return {
      token: stored.token,
      encryption: {
        type: stored.variant,
        key: fromBase64(stored.key),
        publicKey: stored.publicKey ? fromBase64(stored.publicKey) : undefined,
        machineKey: stored.machineKey ? fromBase64(stored.machineKey) : undefined,
      },
      serverUrl: stored.serverUrl,
      machineId: stored.machineId,
    };
  } catch {
    return null;
  }
}

/**
 * Delete stored credentials (unpair).
 */
export async function deleteCredentials(): Promise<void> {
  await SecureStore.deleteItemAsync(CRED_KEY);
}

/**
 * Check if device is paired (has credentials).
 */
export async function isPaired(): Promise<boolean> {
  const raw = await SecureStore.getItemAsync(CRED_KEY);
  return raw !== null;
}

/** Alias for isPaired — matches spec interface */
export const hasCredentials = isPaired;

/**
 * Parse credentials from HappyCoder's ~/.happy/credentials.json format
 * (used when importing via QR code or manual entry).
 */
export function parseHappyCredentialsJson(json: string): HappyCredentials | null {
  try {
    const raw = JSON.parse(json);
    if (!raw.token) return null;

    // Legacy format: { token, secret }
    if (raw.secret && !raw.encryption) {
      return {
        token: raw.token,
        encryption: {
          type: 'legacy',
          key: fromBase64(raw.secret),
        },
      };
    }

    // Modern format: { token, encryption: { publicKey, machineKey } }
    if (raw.encryption?.publicKey && raw.encryption?.machineKey) {
      return {
        token: raw.token,
        encryption: {
          type: 'dataKey',
          key: fromBase64(raw.encryption.machineKey), // machineKey is the encryption key
          publicKey: fromBase64(raw.encryption.publicKey),
          machineKey: fromBase64(raw.encryption.machineKey),
        },
      };
    }

    return null;
  } catch {
    return null;
  }
}
