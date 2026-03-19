import { io, Socket } from 'socket.io-client';

const RELAY_URL = window.location.origin; // same origin (morph.mkyang.ai)
function getToken() { return localStorage.getItem('morph-auth') || ''; }

export interface Message {
  id: string;
  role: 'user' | 'agent' | 'system';
  type: 'text' | 'thinking' | 'tool' | 'tool_result' | 'status' | 'error';
  content: string;
  name?: string; // tool name
  collapsed?: boolean;
  ts: number;
}

type Listener = (msg: Message) => void;
type StateListener = (state: 'disconnected' | 'connecting' | 'connected' | 'error') => void;

let socket: Socket | null = null;
let sessionId: string | null = null;
let state: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';

const msgListeners = new Set<Listener>();
const stateListeners = new Set<StateListener>();

function setState(s: typeof state) {
  state = s;
  stateListeners.forEach(fn => fn(s));
}

function emit(msg: Message) {
  msgListeners.forEach(fn => fn(msg));
}

function uid() {
  return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

// Parse Claude stream-json output into Message
function parseOutput(data: any): Message[] {
  const d = data?.data;
  if (!d) return [];
  const msgs: Message[] = [];

  if (d.type === 'assistant') {
    const content = d.message?.content || [];
    for (const block of content) {
      if (block.type === 'thinking' && block.thinking) {
        msgs.push({ id: uid(), role: 'agent', type: 'thinking', content: block.thinking, ts: Date.now(), collapsed: true });
      } else if (block.type === 'text' && block.text) {
        msgs.push({ id: uid(), role: 'agent', type: 'text', content: block.text, ts: Date.now() });
      } else if (block.type === 'tool_use') {
        const params = typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2);
        msgs.push({ id: block.id || uid(), role: 'agent', type: 'tool', content: params, name: block.name, ts: Date.now(), collapsed: true });
      } else if (block.type === 'tool_result') {
        const result = typeof block.content === 'string' ? block.content : JSON.stringify(block.content);
        msgs.push({ id: uid(), role: 'agent', type: 'tool_result', content: result, ts: Date.now(), collapsed: true });
      }
    }
  } else if (d.type === 'result') {
    msgs.push({ id: uid(), role: 'system', type: 'status', content: d.subtype === 'success' ? '--- done ---' : `--- ${d.subtype} ---`, ts: Date.now() });
  } else if (d.type === 'error') {
    msgs.push({ id: uid(), role: 'system', type: 'error', content: d.error || d.message || 'Unknown error', ts: Date.now() });
  }
  return msgs;
}

function connectSocket(): void {
  if (socket) { socket.close(); socket = null; }
  socket = io(RELAY_URL, {
    path: '/v1/updates',
    transports: ['websocket'],
    auth: { token: getToken(), clientType: 'session-scoped', sessionId: 'direct' },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });
  socket.on('connect', () => { socket!.emit('direct-subscribe', { sessionId }); setState('connected'); });
  socket.on('disconnect', () => setState('disconnected'));
  socket.on('connect_error', () => setState('error'));
  socket.on('claude-output', (data: any) => { parseOutput(data).forEach(emit); });
  socket.on('claude-error', (data: any) => { emit({ id: uid(), role: 'system', type: 'error', content: data.text || 'Error', ts: Date.now() }); });
  socket.on('claude-exit', (data: any) => { emit({ id: uid(), role: 'system', type: 'status', content: `--- exit ${data.code} ---`, ts: Date.now() }); });
}

export async function connect(): Promise<void> {
  setState('connecting');
  try {
    // Try to reuse existing session from localStorage
    const savedSession = sessionStorage.getItem('morph-session');
    if (savedSession) {
      // Check if it's still alive
      const checkRes = await fetch(`${RELAY_URL}/v2/claude/active`, { headers: { 'Authorization': `Bearer ${getToken()}` } });
      const checkData = await checkRes.json();
      const alive = (checkData.sessions || []).find((s: any) => s.id === savedSession && s.alive);
      if (alive) {
        sessionId = savedSession;
        // Skip spawning, just reconnect Socket.IO
        connectSocket();
        return;
      }
    }

    // No saved session or it's dead — spawn new one
    const res = await fetch(`${RELAY_URL}/v2/claude/send`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Connected from Morph Web. Ready.', cwd: '/workspace' }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    sessionId = data.sessionId;
    sessionStorage.setItem('morph-session', sessionId);
    connectSocket();
  } catch (err: any) {
    setState('error');
    emit({ id: uid(), role: 'system', type: 'error', content: err.message, ts: Date.now() });
  }
}

export function send(text: string) {
  if (!sessionId) return;
  // Show user message immediately
  emit({ id: uid(), role: 'user', type: 'text', content: text, ts: Date.now() });

  fetch(`${RELAY_URL}/v2/claude/send`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: text, sessionId }),
  }).catch(() => {
    socket?.emit('direct-send', { sessionId, message: text });
  });
}

export function interrupt() {
  if (!sessionId) return;
  fetch(`${RELAY_URL}/v2/claude/interrupt`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  }).catch(() => {});
}

export function stop() {
  if (!sessionId) return;
  fetch(`${RELAY_URL}/v2/claude/stop`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId }),
  }).catch(() => {});
  socket?.close();
  socket = null;
  sessionId = null;
  setState('disconnected');
}

export function onMessage(fn: Listener) { msgListeners.add(fn); return () => { msgListeners.delete(fn); }; }
export function onState(fn: StateListener) { stateListeners.add(fn); return () => { stateListeners.delete(fn); }; }
export function getState() { return state; }
export function getSessionId() { return sessionId; }
