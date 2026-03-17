/**
 * HappyCoder session protocol message types and parsing.
 *
 * The server sends Socket.IO "update" events with this shape:
 *   { body: { t: "new-message", message: { content: { t: "encrypted", c: "<base64>" } } } }
 *   { body: { t: "update-session", metadata?: ..., agentState?: ... } }
 *   { body: { t: "update-machine", ... } }
 *
 * After decryption the inner payload is a MessageEnvelope:
 *   { role: "user"|"agent", content: { type: "text"|"output"|"codex"|"event"|... , ... }, meta?: { sentFrom, ... } }
 *
 * The Claude JSONL wire format (RawJSONLinesSchema) has these top-level types:
 *   user, assistant, summary, system
 *
 * Agent output.data follows Claude Code's streaming events (the 9 event types listed below).
 */

import {
  toBase64,
  fromBase64,
  decryptJson,
  encryptJson,
  utf8Encode,
} from './crypto';

// ---------------------------------------------------------------------------
// Message content types — the 9 event categories from Claude Code
// ---------------------------------------------------------------------------

export type MessageContent =
  | { type: 'text'; text: string; thinking?: boolean }
  | { type: 'tool_call_start'; name: string; params: any }
  | { type: 'tool_call_end'; name: string; result: any }
  | { type: 'turn_start' }
  | { type: 'turn_end'; status: 'completed' | 'failed' | 'cancelled' }
  | { type: 'file'; name: string; size: number }
  | { type: 'service_message'; text: string }
  | { type: 'session_start' }
  | { type: 'session_stop' };

// ---------------------------------------------------------------------------
// Parsed session message
// ---------------------------------------------------------------------------

export interface SessionMessage {
  id: string;
  timestamp: number;
  role: 'user' | 'agent' | 'system';
  turnId?: string;
  subagentId?: string;
  content: MessageContent;
}

// ---------------------------------------------------------------------------
// Wire types (from HappyCoder source)
// ---------------------------------------------------------------------------

/** Decrypted message envelope */
export interface MessageEnvelope {
  role: 'user' | 'agent';
  content: {
    type: string;
    text?: string;
    data?: any;
    id?: string;
    [key: string]: any;
  };
  localKey?: string;
  meta?: MessageMeta;
}

export interface MessageMeta {
  sentFrom?: string;
  permissionMode?: string;
  model?: string | null;
  fallbackModel?: string | null;
  customSystemPrompt?: string | null;
  appendSystemPrompt?: string | null;
  allowedTools?: string[] | null;
  disallowedTools?: string[] | null;
}

/** Socket "update" event body */
export interface UpdateBody {
  t: 'new-message' | 'update-session' | 'update-machine';
  message?: {
    content: { t: 'encrypted'; c: string };
  };
  metadata?: { value: string; version: number };
  agentState?: { value: string | null; version: number };
  machineId?: string;
}

// ---------------------------------------------------------------------------
// Claude JSONL types (what agent wraps in content.data)
// ---------------------------------------------------------------------------

export interface ClaudeUserMessage {
  type: 'user';
  uuid: string;
  isSidechain?: boolean;
  isMeta?: boolean;
  message: {
    content: string | any;
  };
}

export interface ClaudeAssistantMessage {
  type: 'assistant';
  uuid: string;
  message?: {
    content?: any[];
    usage?: {
      input_tokens: number;
      output_tokens: number;
      cache_creation_input_tokens?: number;
      cache_read_input_tokens?: number;
    };
  };
}

export interface ClaudeSummaryMessage {
  type: 'summary';
  summary: string;
  leafUuid: string;
}

// ---------------------------------------------------------------------------
// Parse a raw Socket.IO "update" event into a SessionMessage (or null)
// ---------------------------------------------------------------------------

let messageCounter = 0;

export function parseUpdate(
  data: { body?: UpdateBody },
  encKey: Uint8Array,
  variant: 'legacy' | 'dataKey',
): SessionMessage | null {
  if (!data?.body) {
    console.log('[Protocol] parseUpdate: no body');
    return null;
  }
  const body = data.body;

  // Only handle new-message updates for now
  if (body.t !== 'new-message') {
    console.log('[Protocol] parseUpdate: skipping t=', body.t);
    return null;
  }
  if (!body.message?.content || body.message.content.t !== 'encrypted') {
    console.log('[Protocol] parseUpdate: not encrypted, content.t=', body.message?.content?.t);
    return null;
  }

  try {
    const cipherB64 = body.message.content.c;
    console.log('[Protocol] parseUpdate: decrypting, ciphertext b64 length=', cipherB64?.length);
    const ciphertext = fromBase64(cipherB64);
    const envelope = decryptJson<MessageEnvelope>(encKey, variant, ciphertext);
    if (!envelope) {
      console.warn('[Protocol] parseUpdate: decryptJson returned null');
      return null;
    }
    console.log('[Protocol] parseUpdate: decrypted envelope role=', envelope.role, 'content.type=', envelope.content?.type);
    const result = envelopeToSessionMessage(envelope);
    console.log('[Protocol] parseUpdate: result type=', result?.content?.type, 'id=', result?.id);
    return result;
  } catch (err: any) {
    console.error('[Protocol] parseUpdate THREW:', err?.message, err?.stack);
    return null;
  }
}

/**
 * Parse an update-session event to get metadata/agentState changes.
 */
export function parseSessionUpdate(
  data: { body?: UpdateBody },
  encKey: Uint8Array,
  variant: 'legacy' | 'dataKey',
): { metadata?: any; agentState?: any; metadataVersion?: number; agentStateVersion?: number } | null {
  if (!data?.body || data.body.t !== 'update-session') return null;
  const result: any = {};

  if (data.body.metadata) {
    const raw = fromBase64(data.body.metadata.value);
    result.metadata = decryptJson(encKey, variant, raw);
    result.metadataVersion = data.body.metadata.version;
  }
  if (data.body.agentState && data.body.agentState.value) {
    const raw = fromBase64(data.body.agentState.value);
    result.agentState = decryptJson(encKey, variant, raw);
    result.agentStateVersion = data.body.agentState.version;
  }

  return result;
}

// ---------------------------------------------------------------------------
// Convert decrypted envelope -> SessionMessage
// ---------------------------------------------------------------------------

function envelopeToSessionMessage(env: MessageEnvelope): SessionMessage | null {
  const id = env.content.id || `msg_${Date.now()}_${messageCounter++}`;
  const timestamp = Date.now();
  const role = env.role === 'user' ? 'user' : 'agent';

  console.log('[Protocol] envelopeToSessionMessage: role=', env.role, 'content.type=', env.content.type, 'hasData=', !!env.content.data);

  // User text message
  if (env.role === 'user' && env.content.type === 'text') {
    console.log('[Protocol] → user text, length=', env.content.text?.length);
    return {
      id,
      timestamp,
      role: 'user',
      content: { type: 'text', text: env.content.text || '' },
    };
  }

  // Agent output — wraps Claude JSONL
  if (env.role === 'agent' && env.content.type === 'output') {
    console.log('[Protocol] → agent output, data.type=', env.content.data?.type);
    return parseAgentOutput(env.content.data, id, timestamp);
  }

  // Agent codex message
  if (env.role === 'agent' && env.content.type === 'codex') {
    console.log('[Protocol] → agent codex, data.type=', env.content.data?.type);
    return parseAgentOutput(env.content.data, id, timestamp);
  }

  // Agent generic typed message (gemini, etc.)
  if (env.role === 'agent' && env.content.data) {
    console.log('[Protocol] → agent generic w/ data, data.type=', env.content.data?.type);
    return parseAgentOutput(env.content.data, id, timestamp);
  }

  // Agent event
  if (env.role === 'agent' && env.content.type === 'event') {
    console.log('[Protocol] → agent event');
    return {
      id,
      timestamp,
      role: 'system',
      content: { type: 'service_message', text: JSON.stringify(env.content.data) },
    };
  }

  // Fallback
  console.log('[Protocol] → FALLBACK, content keys=', Object.keys(env.content));
  return {
    id,
    timestamp,
    role,
    content: { type: 'service_message', text: JSON.stringify(env.content) },
  };
}

// ---------------------------------------------------------------------------
// Parse Claude JSONL data wrapped inside agent output
// ---------------------------------------------------------------------------

function parseAgentOutput(data: any, id: string, timestamp: number): SessionMessage | null {
  if (!data) {
    console.log('[Protocol] parseAgentOutput: data is null');
    return null;
  }

  console.log('[Protocol] parseAgentOutput: data.type=', data.type, 'keys=', Object.keys(data).join(','));
  const msg: Partial<SessionMessage> = { id, timestamp, role: 'agent' };

  switch (data.type) {
    case 'user':
      return {
        ...msg as any,
        role: 'user',
        content: {
          type: 'text',
          text: typeof data.message?.content === 'string'
            ? data.message.content
            : JSON.stringify(data.message?.content),
        },
      };

    case 'assistant': {
      // Extract text from assistant message content blocks
      const blocks = data.message?.content;
      let text = '';
      let isThinking = false;
      if (Array.isArray(blocks)) {
        for (const block of blocks) {
          if (block.type === 'text') {
            text += block.text || '';
          } else if (block.type === 'thinking') {
            text += block.thinking || '';
            isThinking = true;
          }
        }
      }
      return {
        ...msg as any,
        content: { type: 'text', text, thinking: isThinking || undefined },
      };
    }

    case 'summary':
      return {
        ...msg as any,
        role: 'system',
        content: { type: 'service_message', text: `Summary: ${data.summary}` },
      };

    case 'system':
      return {
        ...msg as any,
        role: 'system',
        content: { type: 'session_start' },
      };

    default:
      // Raw object — try to make sense of it
      if (typeof data === 'string') {
        return { ...msg as any, content: { type: 'text', text: data } };
      }
      return {
        ...msg as any,
        content: { type: 'service_message', text: JSON.stringify(data) },
      };
  }
}

// ---------------------------------------------------------------------------
// Build a user message for sending to a session
//
// Matches HappyCoder format:
//   { role: "user", content: { type: "text", text: "..." }, meta: { sentFrom: "morph" } }
// ---------------------------------------------------------------------------

export function buildUserMessage(text: string): MessageEnvelope {
  return {
    role: 'user',
    content: {
      type: 'text',
      text,
    },
    meta: {
      sentFrom: 'morph',
      permissionMode: 'bypassPermissions',
    },
  };
}

/**
 * Encrypt and base64-encode a user message for sending via socket.
 */
export function encryptUserMessage(
  text: string,
  encKey: Uint8Array,
  variant: 'legacy' | 'dataKey',
): string {
  console.log('[Protocol] encryptUserMessage: textLen=', text.length, 'keyLen=', encKey.length, 'variant=', variant);
  try {
    const msg = buildUserMessage(text);
    console.log('[Protocol] buildUserMessage OK, role=', msg.role, 'content.type=', msg.content.type);
    const encrypted = encryptJson(encKey, variant, msg);
    console.log('[Protocol] encryptJson OK, encrypted bytes=', encrypted.length);
    const b64 = toBase64(encrypted);
    console.log('[Protocol] toBase64 OK, b64 length=', b64.length);
    return b64;
  } catch (err: any) {
    console.error('[Protocol] encryptUserMessage THREW:', err?.message, err?.stack);
    throw err;
  }
}
