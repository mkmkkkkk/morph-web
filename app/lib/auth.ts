/**
 * Authentication and pairing flow for HappyCoder protocol.
 *
 * Pairing flow (from index-B3gQr6vs.mjs):
 * 1. Generate X25519 keypair via tweetnacl.box.keyPair
 * 2. POST /v1/auth/request with { publicKey: base64(pubKey), supportsV2: true }
 * 3. Display QR code with URL: happy://terminal?<base64url(pubKey)>
 * 4. Poll /v1/auth/request until state === "authorized"
 * 5. Decrypt response using tweetnacl.box.open (ephemeral key exchange)
 * 6. If decrypted payload is 32 bytes: legacy mode (shared secret)
 *    If first byte is 0x00: dataKey mode (bytes 1-32 = account public key)
 *
 * For Morph (mobile), we are the "terminal" side — we generate the keypair,
 * the desktop CLI scans our QR and sends the encrypted response.
 */

import nacl from 'tweetnacl';
import { randomBytes } from '@noble/ciphers/utils.js';
import { toBase64, toBase64Url, fromBase64, boxDecrypt } from './crypto';

const DEFAULT_SERVER = 'https://api.cluster-fluster.com';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface PairingResult {
  token: string;
  encryptionKey: Uint8Array;
  variant: 'legacy' | 'dataKey';
  machineId: string;
}

export interface PairingRequest {
  publicKey: Uint8Array;
  secretKey: Uint8Array;
  requestId: string; // same as base64(publicKey) — server indexes by this
}

// ---------------------------------------------------------------------------
// Step 1: Request pairing — generate keypair, register with server
// ---------------------------------------------------------------------------

export async function requestPairing(
  serverUrl: string = DEFAULT_SERVER,
): Promise<PairingRequest> {
  // Generate X25519 keypair
  const secret = randomBytes(32);
  const keypair = nacl.box.keyPair.fromSecretKey(secret);

  const publicKeyB64 = toBase64(keypair.publicKey);

  // Register the public key with the server
  const response = await fetch(`${serverUrl}/v1/auth/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: publicKeyB64,
      supportsV2: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Auth request failed: ${response.status} ${response.statusText}`);
  }

  return {
    publicKey: keypair.publicKey,
    secretKey: keypair.secretKey,
    requestId: publicKeyB64, // server uses publicKey as request identifier
  };
}

// ---------------------------------------------------------------------------
// Step 2: Poll for pairing completion
// ---------------------------------------------------------------------------

export async function pollPairingStatus(
  serverUrl: string = DEFAULT_SERVER,
  requestId: string,
  secretKey: Uint8Array,
): Promise<PairingResult | null> {
  // requestId is base64(publicKey), but we also need the publicKey for the POST
  const publicKeyB64 = requestId;

  const response = await fetch(`${serverUrl}/v1/auth/request`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      publicKey: publicKeyB64,
      supportsV2: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`Poll failed: ${response.status}`);
  }

  const data = await response.json();

  if (data.state !== 'authorized') {
    return null; // still waiting
  }

  // Decrypt the response using ephemeral key decryption
  const encryptedResponse = fromBase64(data.response);
  const decrypted = boxDecrypt(encryptedResponse, secretKey);

  if (!decrypted) {
    throw new Error('Failed to decrypt pairing response');
  }

  const token: string = data.token;

  // Generate a machine ID for this device
  const machineIdBytes = randomBytes(16);
  const machineId = Array.from(machineIdBytes)
    .map((b: number) => b.toString(16).padStart(2, '0'))
    .join('')
    .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');

  // Determine encryption mode from decrypted payload
  if (decrypted.length === 32) {
    // Legacy mode: decrypted is the shared secret
    return {
      token,
      encryptionKey: decrypted,
      variant: 'legacy',
      machineId,
    };
  }

  if (decrypted[0] === 0x00) {
    // DataKey mode: byte 0 = version, bytes 1-32 = account public key
    // For Morph, we generate a random machine key for AES-256-GCM
    const _accountPublicKey = decrypted.slice(1, 33);
    const machineKey = randomBytes(32);

    return {
      token,
      encryptionKey: machineKey,
      variant: 'dataKey',
      machineId,
    };
  }

  throw new Error('Unknown encryption mode in pairing response');
}

// ---------------------------------------------------------------------------
// Generate the QR code URL for pairing
//
// Format: happy://terminal?<base64url(publicKey)>
// This URL is scanned by the desktop HappyCoder CLI
// ---------------------------------------------------------------------------

export function generatePairingQR(publicKey: Uint8Array): string {
  return `happy://terminal?${toBase64Url(publicKey)}`;
}

// ---------------------------------------------------------------------------
// Full pairing helper — convenience wrapper
// ---------------------------------------------------------------------------

export async function startPairing(
  serverUrl: string = DEFAULT_SERVER,
  onQrReady?: (url: string) => void,
  pollIntervalMs: number = 1000,
  maxAttempts: number = 120,
): Promise<PairingResult> {
  const request = await requestPairing(serverUrl);

  const qrUrl = generatePairingQR(request.publicKey);
  onQrReady?.(qrUrl);

  for (let i = 0; i < maxAttempts; i++) {
    const result = await pollPairingStatus(serverUrl, request.requestId, request.secretKey);
    if (result) return result;

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error('Pairing timed out');
}

// ---------------------------------------------------------------------------
// Simple credential import (QR code contains credentials JSON)
// Used by connect.tsx for direct credential import without protocol handshake
// ---------------------------------------------------------------------------

export type PairResult =
  | { success: true; credentials: import('./credentials').HappyCredentials }
  | { success: false; error: string };

/**
 * Parse a QR code string into credentials and save them.
 * QR content can be raw JSON or base64-encoded JSON.
 */
export async function pairFromQR(qrData: string): Promise<PairResult> {
  const { parseHappyCredentialsJson, saveCredentials } = await import('./credentials');

  let jsonStr: string;

  if (qrData.startsWith('{')) {
    jsonStr = qrData;
  } else {
    try {
      const decoded = fromBase64(qrData);
      jsonStr = new TextDecoder().decode(decoded);
    } catch {
      return { success: false, error: 'Could not decode QR data' };
    }
  }

  return pairFromJson(jsonStr);
}

/**
 * Parse raw credentials JSON and save to secure storage.
 */
export async function pairFromJson(jsonStr: string): Promise<PairResult> {
  const { parseHappyCredentialsJson, saveCredentials } = await import('./credentials');

  const creds = parseHappyCredentialsJson(jsonStr);
  if (!creds) {
    return { success: false, error: 'Invalid credentials format' };
  }

  await saveCredentials(creds);
  return { success: true, credentials: creds };
}
