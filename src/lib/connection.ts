import { io, Socket } from 'socket.io-client';

const RELAY_URL = window.location.origin; // same origin (morph.mkyang.ai)
const FIXED_SESSION = 'ba99d3d6-b59a-4cc6-910f-610663a10e69';
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

  // Skip partial/streaming events — only render complete messages
  if (d.type === 'stream_event') return [];

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
    sessionId = FIXED_SESSION;

    // Connect Socket.IO FIRST and subscribe — so we catch replay messages
    connectSocket();
    // Wait for socket to actually connect
    await new Promise<void>((resolve) => {
      if (socket?.connected) { resolve(); return; }
      const onConnect = () => { socket?.off('connect', onConnect); resolve(); };
      socket?.on('connect', onConnect);
      setTimeout(resolve, 3000); // timeout fallback
    });

    // Check if fixed session is already alive
    const checkRes = await fetch(`${RELAY_URL}/v2/claude/active`, { headers: { 'Authorization': `Bearer ${getToken()}` } });
    const checkData = await checkRes.json();
    const alive = (checkData.sessions || []).find((s: any) => s.id === FIXED_SESSION && s.alive);

    // Load history from session JSONL
    try {
      const histRes = await fetch(`${RELAY_URL}/v2/claude/history/${FIXED_SESSION}?limit=30`, { headers: { 'Authorization': `Bearer ${getToken()}` } });
      const histData = await histRes.json();
      for (const msg of (histData.messages || [])) {
        emit({ id: uid(), role: msg.role, type: msg.type, content: msg.content, name: msg.name, ts: msg.ts ? new Date(msg.ts).getTime() : Date.now() });
      }
    } catch {}

    if (alive) {
      // Already running — socket is connected, history loaded
      return;
    }

    // Spawn new Claude with fixed session ID (socket already listening)
    const res = await fetch(`${RELAY_URL}/v2/claude/send`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: 'Connected from Morph Web. Ready.', sessionId: FIXED_SESSION, cwd: '/workspace' }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
  } catch (err: any) {
    setState('error');
    emit({ id: uid(), role: 'system', type: 'error', content: err.message, ts: Date.now() });
  }
}

export function clearSession() {
  // Kill current process + start fresh
  if (sessionId) {
    fetch(`${RELAY_URL}/v2/claude/stop`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ sessionId }),
    }).catch(() => {});
  }
  socket?.close();
  socket = null;
  sessionId = null;
  setState('disconnected');
  // Reconnect with fresh process
  setTimeout(() => connect(), 500);
}

let _currentTab = 'canvas';
export function setCurrentTab(tab: string) { _currentTab = tab; }

export function send(text: string) {
  if (!sessionId) return;
  // Show user message immediately (display without context prefix)
  emit({ id: uid(), role: 'user', type: 'text', content: text, ts: Date.now() });

  // Inject page context so Claude knows where the user is
  const ctx = _currentTab === 'config'
    ? '[User is on the Config page (settings, sessions, quick actions). They may be asking about configuration or system management.]\n\n'
    : '';
  text = ctx + text;

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
