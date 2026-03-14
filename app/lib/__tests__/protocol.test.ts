import {
  parseUpdate,
  parseSessionUpdate,
  buildUserMessage,
  encryptUserMessage,
  type MessageEnvelope,
  type SessionMessage,
} from '../protocol';
import {
  encryptJson,
  toBase64,
  fromBase64,
  decryptJson,
} from '../crypto';
import nacl from 'tweetnacl';

const key = nacl.randomBytes(32);
const variant = 'legacy' as const;

// Helper: wrap an envelope into a socket "update" event structure
function makeUpdateEvent(envelope: MessageEnvelope) {
  const encrypted = encryptJson(key, variant, envelope);
  return {
    body: {
      t: 'new-message' as const,
      message: {
        content: {
          t: 'encrypted' as const,
          c: toBase64(encrypted),
        },
      },
    },
  };
}

describe('parseUpdate', () => {
  it('parses a user text message', () => {
    const envelope: MessageEnvelope = {
      role: 'user',
      content: { type: 'text', text: 'hello from phone' },
      meta: { sentFrom: 'morph' },
    };

    const msg = parseUpdate(makeUpdateEvent(envelope), key, variant);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('user');
    expect(msg!.content.type).toBe('text');
    if (msg!.content.type === 'text') {
      expect(msg!.content.text).toBe('hello from phone');
    }
  });

  it('parses an agent assistant message', () => {
    const envelope: MessageEnvelope = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          uuid: 'test-uuid',
          message: {
            content: [{ type: 'text', text: 'I can help with that.' }],
          },
        },
      },
    };

    const msg = parseUpdate(makeUpdateEvent(envelope), key, variant);
    expect(msg).not.toBeNull();
    expect(msg!.role).toBe('agent');
    expect(msg!.content.type).toBe('text');
    if (msg!.content.type === 'text') {
      expect(msg!.content.text).toBe('I can help with that.');
    }
  });

  it('parses an agent thinking message', () => {
    const envelope: MessageEnvelope = {
      role: 'agent',
      content: {
        type: 'output',
        data: {
          type: 'assistant',
          uuid: 'think-uuid',
          message: {
            content: [{ type: 'thinking', thinking: 'Let me think...' }],
          },
        },
      },
    };

    const msg = parseUpdate(makeUpdateEvent(envelope), key, variant);
    expect(msg).not.toBeNull();
    expect(msg!.content.type).toBe('text');
    if (msg!.content.type === 'text') {
      expect(msg!.content.thinking).toBe(true);
    }
  });

  it('returns null for non-message updates', () => {
    const event = {
      body: { t: 'update-session' as const },
    };
    expect(parseUpdate(event, key, variant)).toBeNull();
  });

  it('returns null for missing body', () => {
    expect(parseUpdate({} as any, key, variant)).toBeNull();
  });

  it('returns null for wrong encryption key', () => {
    const envelope: MessageEnvelope = {
      role: 'user',
      content: { type: 'text', text: 'secret' },
    };
    const wrongKey = nacl.randomBytes(32);
    expect(parseUpdate(makeUpdateEvent(envelope), wrongKey, variant)).toBeNull();
  });
});

describe('parseSessionUpdate', () => {
  it('parses metadata update', () => {
    const metadata = { title: 'test session', cwd: '/home' };
    const encMetadata = toBase64(encryptJson(key, variant, metadata));

    const event = {
      body: {
        t: 'update-session' as const,
        metadata: { value: encMetadata, version: 3 },
      },
    };

    const result = parseSessionUpdate(event, key, variant);
    expect(result).not.toBeNull();
    expect(result!.metadata).toEqual(metadata);
    expect(result!.metadataVersion).toBe(3);
  });

  it('returns null for non-session updates', () => {
    const event = { body: { t: 'new-message' as const } };
    expect(parseSessionUpdate(event, key, variant)).toBeNull();
  });
});

describe('buildUserMessage', () => {
  it('creates a properly formatted envelope', () => {
    const msg = buildUserMessage('hello');
    expect(msg.role).toBe('user');
    expect(msg.content.type).toBe('text');
    expect(msg.content.text).toBe('hello');
    expect(msg.meta?.sentFrom).toBe('morph');
  });
});

describe('encryptUserMessage', () => {
  it('produces base64-encoded encrypted string', () => {
    const encrypted = encryptUserMessage('test', key, variant);
    expect(typeof encrypted).toBe('string');

    // Should be valid base64
    const bytes = fromBase64(encrypted);
    expect(bytes.length).toBeGreaterThan(0);

    // Should decrypt to a valid message envelope
    const decrypted = decryptJson<MessageEnvelope>(key, variant, bytes);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.role).toBe('user');
    expect(decrypted!.content.text).toBe('test');
  });

  it('works with dataKey variant too', () => {
    const dataKey = nacl.randomBytes(32);
    const encrypted = encryptUserMessage('hello', dataKey, 'dataKey');
    const bytes = fromBase64(encrypted);
    const decrypted = decryptJson<MessageEnvelope>(dataKey, 'dataKey', bytes);
    expect(decrypted).not.toBeNull();
    expect(decrypted!.content.text).toBe('hello');
  });
});
