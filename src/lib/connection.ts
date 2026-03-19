import { io, Socket } from 'socket.io-client';

const RELAY_URL = window.location.origin; // same origin (morph.mkyang.ai)
const FIXED_SESSION = 'a0a0a0a0-0e00-4000-a000-000000000002';
function getToken() { return localStorage.getItem('morph-auth') || ''; }

export interface Message {
  id: string;
  role: 'user' | 'agent' | 'system';
  type: 'text' | 'thinking' | 'tool' | 'tool_result' | 'status' | 'error';
  content: string;
  name?: string; // tool name
  collapsed?: boolean;
  pending?: boolean; // true = not yet confirmed by server
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

  // Skip partial/streaming and user echo events
  if (d.type === 'stream_event' || d.type === 'user') return [];

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
  } else if (d.type === 'system') {
    // System events: compacting, permission requests, etc.
    const text = typeof d.message === 'string' ? d.message : (d.subtype || d.event || JSON.stringify(d));
    msgs.push({ id: uid(), role: 'system', type: 'status', content: text, ts: Date.now() });
  } else if (d.type) {
    // Catch-all for unknown event types — surface them so nothing is silently lost
    const detail = typeof d.message === 'string' ? d.message : (d.subtype || '');
    msgs.push({ id: uid(), role: 'system', type: 'status', content: `[${d.type}] ${detail}`.trim(), ts: Date.now() });
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
      let resolved = false;
      const done = () => { if (resolved) return; resolved = true; socket?.off('connect', done); clearTimeout(t); resolve(); };
      socket?.on('connect', done);
      const t = setTimeout(done, 3000); // timeout fallback
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
      body: JSON.stringify({
        message: `This is Morph Web — a mobile terminal for the CEO to interact with Claude Code remotely.
You are a CTO-level AI assistant. Working directory: /workspace. You have full access to the codebase.
The CEO may also be running a separate Claude Code session on the desktop terminal — they share the same /workspace files.
Be concise. Follow CLAUDE.md instructions. Ready for tasks.`,
        sessionId: FIXED_SESSION,
        cwd: '/workspace',
      }),
    });
    const data = await res.json();
    if (data.error) throw new Error(data.error);
    // Re-subscribe after spawn — the pre-spawn subscribe was dropped because session wasn't active yet
    socket?.emit('direct-subscribe', { sessionId: FIXED_SESSION });
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
  // Show user message immediately as pending
  const msgId = uid();
  emit({ id: msgId, role: 'user', type: 'text', content: text, ts: Date.now(), pending: true });

  // Inject page context so Claude knows where the user is
  const ctx = _currentTab === 'config'
    ? '[User is on the Config page (settings, sessions, quick actions). They may be asking about configuration or system management.]\n\n'
    : '';
  const fullText = ctx + text;

  fetch(`${RELAY_URL}/v2/claude/send`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ message: fullText, sessionId }),
  }).then(res => {
    // Confirm message delivery
    emit({ id: msgId, role: 'user', type: 'text', content: text, ts: Date.now(), pending: false });
    if (!res.ok) emit({ id: uid(), role: 'system', type: 'error', content: `Send failed (${res.status})`, ts: Date.now() });
  }).catch(() => {
    socket?.emit('direct-send', { sessionId, message: fullText });
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

export async function switchSession(newSessionId: string, opts?: { resume?: boolean; message?: string }) {
  // Clear current messages — caller should handle UI reset
  sessionId = newSessionId;

  // Subscribe socket to new session
  if (socket?.connected) {
    socket.emit('direct-subscribe', { sessionId: newSessionId });
  }

  // Check if session is already active
  try {
    const checkRes = await fetch(`${RELAY_URL}/v2/claude/active`, { headers: { 'Authorization': `Bearer ${getToken()}` } });
    const checkData = await checkRes.json();
    const alive = (checkData.sessions || []).find((s: any) => s.id === newSessionId && s.alive);

    // Load history
    try {
      const histRes = await fetch(`${RELAY_URL}/v2/claude/history/${newSessionId}?limit=30`, { headers: { 'Authorization': `Bearer ${getToken()}` } });
      const histData = await histRes.json();
      for (const msg of (histData.messages || [])) {
        emit({ id: uid(), role: msg.role, type: msg.type, content: msg.content, name: msg.name, ts: msg.ts ? new Date(msg.ts).getTime() : Date.now() });
      }
    } catch {}

    if (alive) return; // Already running

    if (opts?.resume) {
      // Resume existing session
      const res = await fetch(`${RELAY_URL}/v2/claude/resume`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ resumeFrom: newSessionId, message: opts.message, cwd: '/workspace' }),
      });
      const data = await res.json();
      if (data.sessionId) {
        sessionId = data.sessionId;
        socket?.emit('direct-subscribe', { sessionId: data.sessionId });
      }
    } else {
      // Start fresh with this session ID
      const res = await fetch(`${RELAY_URL}/v2/claude/send`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: opts?.message || 'Continue from where you left off.', sessionId: newSessionId, cwd: '/workspace' }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
    }
  } catch (err: any) {
    emit({ id: uid(), role: 'system', type: 'error', content: err.message, ts: Date.now() });
  }
}

export async function fetchSessions(): Promise<any[]> {
  try {
    const res = await fetch(`${RELAY_URL}/v2/claude/sessions?limit=20`, { headers: { 'Authorization': `Bearer ${getToken()}` } });
    const data = await res.json();
    return data.sessions || [];
  } catch { return []; }
}

export function onMessage(fn: Listener) { msgListeners.add(fn); return () => { msgListeners.delete(fn); }; }
export function onState(fn: StateListener) { stateListeners.add(fn); return () => { stateListeners.delete(fn); }; }
export function getState() { return state; }
export function getSessionId() { return sessionId; }
