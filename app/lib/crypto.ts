/**
 * Crypto module for HappyCoder protocol compatibility.
 *
 * Two encryption modes:
 * - Legacy: tweetnacl.secretbox (XSalsa20-Poly1305) with 24-byte nonce
 * - DataKey: AES-256-GCM via @noble/ciphers with 12-byte nonce, version-byte prefix
 *
 * Public-key encryption (pairing): tweetnacl.box (X25519-XSalsa20-Poly1305)
 *
 * No Node.js Buffer — everything is Uint8Array + manual base64.
 */

import nacl from 'tweetnacl';
import { gcm } from '@noble/ciphers/aes.js';
import { randomBytes } from '@noble/ciphers/utils.js';

// ---------------------------------------------------------------------------
// Base64 (standard + URL-safe) — no atob/btoa, no Buffer
// ---------------------------------------------------------------------------

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

const B64_LOOKUP = new Uint8Array(256);
for (let i = 0; i < B64_CHARS.length; i++) {
  B64_LOOKUP[B64_CHARS.charCodeAt(i)] = i;
}

export function toBase64(data: Uint8Array): string {
  let result = '';
  const len = data.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = data[i];
    const b1 = i + 1 < len ? data[i + 1] : 0;
    const b2 = i + 2 < len ? data[i + 2] : 0;
    result += B64_CHARS[(b0 >> 2) & 0x3f];
    result += B64_CHARS[((b0 << 4) | (b1 >> 4)) & 0x3f];
    result += i + 1 < len ? B64_CHARS[((b1 << 2) | (b2 >> 6)) & 0x3f] : '=';
    result += i + 2 < len ? B64_CHARS[b2 & 0x3f] : '=';
  }
  return result;
}

export function fromBase64(str: string): Uint8Array {
  // Strip padding
  let s = str.replace(/=+$/, '');
  const out = new Uint8Array(Math.floor((s.length * 3) / 4));
  let j = 0;
  for (let i = 0; i < s.length; i += 4) {
    const a = B64_LOOKUP[s.charCodeAt(i)];
    const b = B64_LOOKUP[s.charCodeAt(i + 1)] || 0;
    const c = B64_LOOKUP[s.charCodeAt(i + 2)] || 0;
    const d = B64_LOOKUP[s.charCodeAt(i + 3)] || 0;
    out[j++] = (a << 2) | (b >> 4);
    if (i + 2 < s.length) out[j++] = ((b << 4) | (c >> 2)) & 0xff;
    if (i + 3 < s.length) out[j++] = ((c << 6) | d) & 0xff;
  }
  return out.slice(0, j);
}

export function toBase64Url(data: Uint8Array): string {
  return toBase64(data)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

export function fromBase64Url(str: string): Uint8Array {
  let s = str.replace(/-/g, '+').replace(/_/g, '/');
  // Restore padding
  const pad = (4 - (s.length % 4)) % 4;
  s += '='.repeat(pad);
  return fromBase64(s);
}

// ---------------------------------------------------------------------------
// UTF-8 encode/decode
// ---------------------------------------------------------------------------

const textEncoder = new TextEncoder();
const textDecoder = new TextDecoder();

export function utf8Encode(str: string): Uint8Array {
  return textEncoder.encode(str);
}

export function utf8Decode(data: Uint8Array): string {
  return textDecoder.decode(data);
}

// ---------------------------------------------------------------------------
// Random bytes helper
// ---------------------------------------------------------------------------

function getRandomBytes(size: number): Uint8Array {
  return randomBytes(size);
}

// ---------------------------------------------------------------------------
// Legacy encryption: tweetnacl.secretbox (XSalsa20-Poly1305)
//
// Wire format: [nonce (24 bytes)] [ciphertext]
// Plaintext is JSON.stringify(data) encoded as UTF-8
// ---------------------------------------------------------------------------

export function encryptLegacy(data: Uint8Array, secret: Uint8Array): Uint8Array {
  const nonce = getRandomBytes(nacl.secretbox.nonceLength); // 24
  const encrypted = nacl.secretbox(data, nonce, secret);
  const result = new Uint8Array(nonce.length + encrypted.length);
  result.set(nonce);
  result.set(encrypted, nonce.length);
  return result;
}

export function decryptLegacy(data: Uint8Array, secret: Uint8Array): Uint8Array | null {
  if (data.length < nacl.secretbox.nonceLength) return null;
  const nonce = data.slice(0, nacl.secretbox.nonceLength);
  const ciphertext = data.slice(nacl.secretbox.nonceLength);
  const decrypted = nacl.secretbox.open(ciphertext, nonce, secret);
  return decrypted ? new Uint8Array(decrypted) : null;
}

// ---------------------------------------------------------------------------
// DataKey encryption: AES-256-GCM via @noble/ciphers
//
// Wire format: [version (1 byte, must be 0x00)] [nonce (12 bytes)] [ciphertext] [authTag (16 bytes)]
//
// @noble/ciphers gcm().encrypt() returns ciphertext||tag concatenated,
// matching the HappyCoder server format.
// ---------------------------------------------------------------------------

export function encryptWithDataKey(data: Uint8Array, key: Uint8Array): Uint8Array {
  const nonce = getRandomBytes(12);
  const cipher = gcm(key, nonce);
  const sealed = cipher.encrypt(data); // ciphertext || authTag (16)

  // Bundle: version(1) + nonce(12) + sealed(ciphertext+tag)
  const bundle = new Uint8Array(1 + 12 + sealed.length);
  bundle[0] = 0x00; // version byte
  bundle.set(nonce, 1);
  bundle.set(sealed, 13);
  return bundle;
}

export function decryptWithDataKey(data: Uint8Array, key: Uint8Array): Uint8Array | null {
  if (data.length < 1 + 12 + 16) return null; // version + nonce + min authTag
  if (data[0] !== 0x00) return null; // version check
  const nonce = data.slice(1, 13);
  const sealed = data.slice(13); // ciphertext || authTag
  try {
    const cipher = gcm(key, nonce);
    return new Uint8Array(cipher.decrypt(sealed));
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Unified encrypt/decrypt — matches HappyCoder API
// ---------------------------------------------------------------------------

export function encrypt(
  key: Uint8Array,
  variant: 'legacy' | 'dataKey',
  data: Uint8Array,
): Uint8Array {
  if (variant === 'legacy') {
    return encryptLegacy(data, key);
  }
  return encryptWithDataKey(data, key);
}

export function decrypt(
  key: Uint8Array,
  variant: 'legacy' | 'dataKey',
  data: Uint8Array,
): Uint8Array | null {
  if (variant === 'legacy') {
    return decryptLegacy(data, key);
  }
  return decryptWithDataKey(data, key);
}

// ---------------------------------------------------------------------------
// Public-key encryption: tweetnacl.box (X25519-XSalsa20-Poly1305)
// Used for pairing key exchange
//
// Wire format: [ephemeralPubKey (32)] [nonce (24)] [ciphertext]
// ---------------------------------------------------------------------------

export function boxEncrypt(
  data: Uint8Array,
  recipientPublicKey: Uint8Array,
): Uint8Array {
  const ephemeral = nacl.box.keyPair();
  const nonce = getRandomBytes(nacl.box.nonceLength); // 24
  const encrypted = nacl.box(data, nonce, recipientPublicKey, ephemeral.secretKey);
  const result = new Uint8Array(32 + nonce.length + encrypted.length);
  result.set(ephemeral.publicKey, 0);
  result.set(nonce, 32);
  result.set(encrypted, 32 + nonce.length);
  return result;
}

export function boxDecrypt(
  data: Uint8Array,
  recipientSecretKey: Uint8Array,
): Uint8Array | null {
  if (data.length < 32 + nacl.box.nonceLength) return null;
  const ephemeralPublicKey = data.slice(0, 32);
  const nonce = data.slice(32, 32 + nacl.box.nonceLength);
  const ciphertext = data.slice(32 + nacl.box.nonceLength);
  const decrypted = nacl.box.open(ciphertext, nonce, ephemeralPublicKey, recipientSecretKey);
  return decrypted ? new Uint8Array(decrypted) : null;
}

// ---------------------------------------------------------------------------
// JSON helpers — HappyCoder encrypt/decrypt work on JSON objects over the wire
// ---------------------------------------------------------------------------

export function encryptJson(
  key: Uint8Array,
  variant: 'legacy' | 'dataKey',
  obj: unknown,
): Uint8Array {
  try {
    const json = JSON.stringify(obj);
    __DEV__ && console.log('[Crypto] encryptJson: variant=', variant, 'jsonLen=', json.length);
    const plaintext = utf8Encode(json);
    const result = encrypt(key, variant, plaintext);
    __DEV__ && console.log('[Crypto] encryptJson OK, outputLen=', result.length);
    return result;
  } catch (err: any) {
    __DEV__ && console.error('[Crypto] encryptJson THREW:', err?.message, err?.stack);
    throw err;
  }
}

export function decryptJson<T = unknown>(
  key: Uint8Array,
  variant: 'legacy' | 'dataKey',
  data: Uint8Array,
): T | null {
  try {
    __DEV__ && console.log('[Crypto] decryptJson: variant=', variant, 'dataLen=', data.length);
    const decrypted = decrypt(key, variant, data);
    if (!decrypted) {
      __DEV__ && console.warn('[Crypto] decryptJson: decrypt returned null');
      return null;
    }
    __DEV__ && console.log('[Crypto] decryptJson: decrypted OK, len=', decrypted.length);
    const text = utf8Decode(decrypted);
    const parsed = JSON.parse(text) as T;
    __DEV__ && console.log('[Crypto] decryptJson: parsed OK');
    return parsed;
  } catch (err: any) {
    __DEV__ && console.error('[Crypto] decryptJson THREW:', err?.message);
    return null;
  }
}
