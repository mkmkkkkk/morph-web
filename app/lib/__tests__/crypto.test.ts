import {
  toBase64,
  fromBase64,
  toBase64Url,
  fromBase64Url,
  utf8Encode,
  utf8Decode,
  encryptLegacy,
  decryptLegacy,
  encryptWithDataKey,
  decryptWithDataKey,
  encrypt,
  decrypt,
  encryptJson,
  decryptJson,
  boxEncrypt,
  boxDecrypt,
} from '../crypto';
import nacl from 'tweetnacl';

// ---------------------------------------------------------------------------
// Base64
// ---------------------------------------------------------------------------

describe('Base64', () => {
  it('round-trips empty buffer', () => {
    const data = new Uint8Array(0);
    expect(fromBase64(toBase64(data))).toEqual(data);
  });

  it('round-trips "Hello, World!"', () => {
    const data = utf8Encode('Hello, World!');
    const b64 = toBase64(data);
    expect(b64).toBe('SGVsbG8sIFdvcmxkIQ==');
    expect(utf8Decode(fromBase64(b64))).toBe('Hello, World!');
  });

  it('round-trips binary data (32 random bytes)', () => {
    const data = nacl.randomBytes(32);
    expect(fromBase64(toBase64(data))).toEqual(data);
  });

  it('handles all padding lengths (0, 1, 2)', () => {
    for (const len of [3, 4, 5]) {
      const data = nacl.randomBytes(len);
      const decoded = fromBase64(toBase64(data));
      expect(decoded).toEqual(data);
    }
  });
});

describe('Base64Url', () => {
  it('round-trips data with +/ characters', () => {
    // A known byte sequence that produces + and / in standard base64
    const data = new Uint8Array([0xfb, 0xef, 0xbe, 0xfb, 0xef, 0xbe]);
    const url = toBase64Url(data);
    expect(url).not.toContain('+');
    expect(url).not.toContain('/');
    expect(url).not.toContain('=');
    expect(fromBase64Url(url)).toEqual(data);
  });
});

// ---------------------------------------------------------------------------
// Legacy encryption (TweetNaCl secretbox)
// ---------------------------------------------------------------------------

describe('Legacy encryption', () => {
  const secret = nacl.randomBytes(32);

  it('encrypts and decrypts a message', () => {
    const plaintext = utf8Encode('test message');
    const ciphertext = encryptLegacy(plaintext, secret);
    const decrypted = decryptLegacy(ciphertext, secret);
    expect(decrypted).not.toBeNull();
    expect(utf8Decode(decrypted!)).toBe('test message');
  });

  it('ciphertext starts with 24-byte nonce', () => {
    const plaintext = utf8Encode('x');
    const ciphertext = encryptLegacy(plaintext, secret);
    // nonce (24) + encrypted (at least 1 + poly1305 tag 16)
    expect(ciphertext.length).toBeGreaterThanOrEqual(24 + 17);
  });

  it('different encryptions produce different ciphertexts (random nonce)', () => {
    const plaintext = utf8Encode('same message');
    const a = encryptLegacy(plaintext, secret);
    const b = encryptLegacy(plaintext, secret);
    expect(toBase64(a)).not.toBe(toBase64(b));
  });

  it('returns null for wrong key', () => {
    const plaintext = utf8Encode('secret');
    const ciphertext = encryptLegacy(plaintext, secret);
    const wrongKey = nacl.randomBytes(32);
    expect(decryptLegacy(ciphertext, wrongKey)).toBeNull();
  });

  it('returns null for truncated data', () => {
    expect(decryptLegacy(new Uint8Array(10), secret)).toBeNull();
  });

  it('returns null for tampered ciphertext', () => {
    const plaintext = utf8Encode('important');
    const ciphertext = encryptLegacy(plaintext, secret);
    ciphertext[30] ^= 0xff; // flip a byte in the ciphertext portion
    expect(decryptLegacy(ciphertext, secret)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// DataKey encryption (AES-256-GCM)
// ---------------------------------------------------------------------------

describe('DataKey encryption', () => {
  const key = nacl.randomBytes(32);

  it('encrypts and decrypts a message', () => {
    const plaintext = utf8Encode('test message');
    const ciphertext = encryptWithDataKey(plaintext, key);
    const decrypted = decryptWithDataKey(ciphertext, key);
    expect(decrypted).not.toBeNull();
    expect(utf8Decode(decrypted!)).toBe('test message');
  });

  it('bundle has version byte 0x00', () => {
    const ciphertext = encryptWithDataKey(utf8Encode('x'), key);
    expect(ciphertext[0]).toBe(0x00);
  });

  it('bundle is at least 29 bytes (version + nonce + authTag)', () => {
    const ciphertext = encryptWithDataKey(utf8Encode(''), key);
    expect(ciphertext.length).toBeGreaterThanOrEqual(29);
  });

  it('returns null for wrong key', () => {
    const ciphertext = encryptWithDataKey(utf8Encode('secret'), key);
    const wrongKey = nacl.randomBytes(32);
    expect(decryptWithDataKey(ciphertext, wrongKey)).toBeNull();
  });

  it('returns null for too-short data', () => {
    expect(decryptWithDataKey(new Uint8Array(28), key)).toBeNull();
  });

  it('returns null for wrong version byte', () => {
    const ciphertext = encryptWithDataKey(utf8Encode('x'), key);
    ciphertext[0] = 0x01;
    expect(decryptWithDataKey(ciphertext, key)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Unified encrypt/decrypt
// ---------------------------------------------------------------------------

describe('Unified encrypt/decrypt', () => {
  const key = nacl.randomBytes(32);

  for (const variant of ['legacy', 'dataKey'] as const) {
    it(`round-trips with variant=${variant}`, () => {
      const plaintext = utf8Encode(`hello ${variant}`);
      const ciphertext = encrypt(key, variant, plaintext);
      const decrypted = decrypt(key, variant, ciphertext);
      expect(decrypted).not.toBeNull();
      expect(utf8Decode(decrypted!)).toBe(`hello ${variant}`);
    });
  }
});

// ---------------------------------------------------------------------------
// JSON helpers
// ---------------------------------------------------------------------------

describe('JSON encrypt/decrypt', () => {
  const key = nacl.randomBytes(32);

  it('round-trips a JSON object (legacy)', () => {
    const obj = { role: 'user', content: { type: 'text', text: 'hello' } };
    const encrypted = encryptJson(key, 'legacy', obj);
    const decrypted = decryptJson(key, 'legacy', encrypted);
    expect(decrypted).toEqual(obj);
  });

  it('round-trips a JSON object (dataKey)', () => {
    const obj = { arr: [1, 2, 3], nested: { a: true } };
    const encrypted = encryptJson(key, 'dataKey', obj);
    const decrypted = decryptJson(key, 'dataKey', encrypted);
    expect(decrypted).toEqual(obj);
  });

  it('returns null for corrupted data', () => {
    const encrypted = encryptJson(key, 'legacy', { x: 1 });
    encrypted[30] ^= 0xff;
    expect(decryptJson(key, 'legacy', encrypted)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Public-key box encryption
// ---------------------------------------------------------------------------

describe('Box encryption', () => {
  it('encrypts and decrypts with keypair', () => {
    const recipient = nacl.box.keyPair();
    const plaintext = utf8Encode('pairing secret');
    const encrypted = boxEncrypt(plaintext, recipient.publicKey);
    const decrypted = boxDecrypt(encrypted, recipient.secretKey);
    expect(decrypted).not.toBeNull();
    expect(utf8Decode(decrypted!)).toBe('pairing secret');
  });

  it('returns null for wrong secret key', () => {
    const recipient = nacl.box.keyPair();
    const wrong = nacl.box.keyPair();
    const encrypted = boxEncrypt(utf8Encode('secret'), recipient.publicKey);
    expect(boxDecrypt(encrypted, wrong.secretKey)).toBeNull();
  });

  it('returns null for too-short data', () => {
    const kp = nacl.box.keyPair();
    expect(boxDecrypt(new Uint8Array(30), kp.secretKey)).toBeNull();
  });
});
