import { io, Socket } from 'socket.io-client';

const RELAY_URL = window.location.origin;
const FIXED_SESSION = 'a0a0a0a0-0e00-4000-a000-000000000002';
function getToken() { return localStorage.getItem('morph-auth') || ''; }

export interface Message {
  id: string;
  role: 'user' | 'agent' | 'system';
  type: 'text' | 'thinking' | 'tool' | 'tool_result' | 'status' | 'error';
  content: string;
  name?: string;
  collapsed?: boolean;
  pending?: boolean;
  ts: number;
}

type Listener = (msg: Message) => void;
type StateListener = (state: 'disconnected' | 'connecting' | 'connected' | 'error') => void;

let socket: Socket | null = null;
let state: 'disconnected' | 'connecting' | 'connected' | 'error' = 'disconnected';

const stateListeners = new Set<StateListener>();
function setState(s: typeof state) { state = s; stateListeners.forEach(fn => fn(s)); }
function uid() { return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

// ─── Message routing: sessionId → Set<Listener> ───
// Every terminal (main + session) registers its own listener keyed by session ID.
// Socket delivers messages to the correct terminal based on the sessionId in the event.
const sessionListeners = new Map<string, Set<Listener>>();

function routeMessage(sessionId: string, msg: Message) {
  const listeners = sessionListeners.get(sessionId);
  if (listeners) listeners.forEach(fn => fn(msg));
}

/** Subscribe a listener to a specific session's messages */
export function subscribe(sessionId: string, fn: Listener): () => void {
  if (!sessionListeners.has(sessionId)) sessionListeners.set(sessionId, new Set());
  sessionListeners.get(sessionId)!.add(fn);
  // Tell relay to forward this session's output to our socket
  if (socket?.connected) socket.emit('direct-subscribe', { sessionId });
  return () => {
    sessionListeners.get(sessionId)?.delete(fn);
    if (sessionListeners.get(sessionId)?.size === 0) sessionListeners.delete(sessionId);
  };
}

// ─── Parse Claude stream-json ───
function parseOutput(data: any): Message[] {
  const d = data?.data;
  if (!d) return [];
  const msgs: Message[] = [];
  if (d.type === 'stream_event' || d.type === 'user') return [];

  if (d.type === 'assistant') {
    for (const block of (d.message?.content || [])) {
      if (block.type === 'thinking' && block.thinking)
        msgs.push({ id: uid(), role: 'agent', type: 'thinking', content: block.thinking, ts: Date.now(), collapsed: true });
      else if (block.type === 'text' && block.text)
        msgs.push({ id: uid(), role: 'agent', type: 'text', content: block.text, ts: Date.now() });
      else if (block.type === 'tool_use')
        msgs.push({ id: block.id || uid(), role: 'agent', type: 'tool', content: typeof block.input === 'string' ? block.input : JSON.stringify(block.input, null, 2), name: block.name, ts: Date.now(), collapsed: true });
      else if (block.type === 'tool_result')
        msgs.push({ id: uid(), role: 'agent', type: 'tool_result', content: typeof block.content === 'string' ? block.content : JSON.stringify(block.content), ts: Date.now(), collapsed: true });
    }
  } else if (d.type === 'result') {
    msgs.push({ id: uid(), role: 'system', type: 'status', content: d.subtype === 'success' ? '--- done ---' : `--- ${d.subtype} ---`, ts: Date.now() });
  } else if (d.type === 'error') {
    msgs.push({ id: uid(), role: 'system', type: 'error', content: d.error || d.message || 'Unknown error', ts: Date.now() });
  } else if (d.type === 'system') {
    const text = typeof d.message === 'string' ? d.message : (d.subtype || d.event || JSON.stringify(d));
    msgs.push({ id: uid(), role: 'system', type: 'status', content: text, ts: Date.now() });
  } else if (d.type) {
    const detail = typeof d.message === 'string' ? d.message : (d.subtype || '');
    msgs.push({ id: uid(), role: 'system', type: 'status', content: `[${d.type}] ${detail}`.trim(), ts: Date.now() });
  }
  return msgs;
}

// ─── Socket connection (singleton, multiplexed) ───
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

  socket.on('connect', () => {
    // Re-subscribe all active session listeners on reconnect
    for (const sid of sessionListeners.keys()) {
      socket!.emit('direct-subscribe', { sessionId: sid });
    }
    setState('connected');
  });
  socket.on('disconnect', () => setState('disconnected'));
  socket.on('connect_error', () => setState('error'));

  // Route messages by sessionId — supports multiple terminals simultaneously
  socket.on('claude-output', (data: any) => {
    const sid = data?.sessionId;
    const msgs = parseOutput(data);
    if (sid) msgs.forEach(m => routeMessage(sid, m));
  });
  socket.on('claude-error', (data: any) => {
    const sid = data?.sessionId;
    const msg: Message = { id: uid(), role: 'system', type: 'error', content: data.text || 'Error', ts: Date.now() };
    if (sid) routeMessage(sid, msg);
  });
  socket.on('claude-exit', (data: any) => {
    const sid = data?.sessionId;
    const msg: Message = { id: uid(), role: 'system', type: 'status', content: `--- exit ${data.code} ---`, ts: Date.now() };
    if (sid) routeMessage(sid, msg);
  });
}

// ─── API helpers (session-agnostic) ───
async function apiPost(path: string, body: any) {
  const res = await fetch(`${RELAY_URL}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${getToken()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function apiGet(path: string) {
  const res = await fetch(`${RELAY_URL}${path}`, { headers: { 'Authorization': `Bearer ${getToken()}` } });
  return res.json();
}

// ─── Terminal operations (all take explicit sessionId) ───

/** Send a message to any session */
export async function sendToSession(sid: string, text: string): Promise<void> {
  const data = await apiPost('/v2/claude/send', { message: text, sessionId: sid, cwd: '/workspace' });
  if (data.error) throw new Error(data.error);
}

/** Resume a session — returns the new process session ID */
export async function resumeSession(sid: string, text: string): Promise<string> {
  const data = await apiPost('/v2/claude/resume', { resumeFrom: sid, message: text, cwd: '/workspace' });
  const newSid = data.sessionId || sid;
  // Auto-subscribe to the new process so we get its output
  if (socket?.connected) socket.emit('direct-subscribe', { sessionId: newSid });
  // Migrate listeners from old sid to new sid if different
  if (newSid !== sid && sessionListeners.has(sid)) {
    const listeners = sessionListeners.get(sid)!;
    sessionListeners.set(newSid, listeners);
    sessionListeners.delete(sid);
  }
  return newSid;
}

/** Interrupt a session */
export function interruptSession(sid: string) {
  apiPost('/v2/claude/interrupt', { sessionId: sid }).catch(() => {});
}

/** Stop a session process */
export function stopSession(sid: string) {
  apiPost('/v2/claude/stop', { sessionId: sid }).catch(() => {});
}

/** Check if a session is alive */
export async function isSessionAlive(sid: string): Promise<boolean> {
  const data = await apiGet('/v2/claude/active');
  return (data.sessions || []).some((s: any) => s.id === sid && s.alive);
}

/** Load session history */
export async function loadHistory(sid: string, limit = 50): Promise<Message[]> {
  const data = await apiGet(`/v2/claude/history/${sid}?limit=${limit}`);
  return (data.messages || []).map((m: any) => ({
    id: uid(), role: m.role, type: m.type, content: m.content, name: m.name,
    ts: m.ts ? new Date(m.ts).getTime() : Date.now(),
  }));
}

/** List all sessions */
export async function fetchSessions(): Promise<any[]> {
  const data = await apiGet('/v2/claude/sessions?limit=20');
  return data.sessions || [];
}

// ─── Main terminal convenience (wraps generic functions for FIXED_SESSION) ───

let _currentTab = 'canvas';
export function setCurrentTab(tab: string) { _currentTab = tab; }

/** Connect main terminal — socket + history + spawn if needed */
export async function connect(): Promise<void> {
  setState('connecting');
  try {
    connectSocket();
    await new Promise<void>((resolve) => {
      if (socket?.connected) { resolve(); return; }
      let resolved = false;
      const done = () => { if (resolved) return; resolved = true; socket?.off('connect', done); clearTimeout(t); resolve(); };
      socket?.on('connect', done);
      const t = setTimeout(done, 3000);
    });

    // Load history and emit to main terminal listeners
    const history = await loadHistory(FIXED_SESSION, 30);
    history.forEach(msg => routeMessage(FIXED_SESSION, msg));

    // Spawn if not alive
    if (!(await isSessionAlive(FIXED_SESSION))) {
      await apiPost('/v2/claude/send', {
        message: `This is Morph Web — a mobile terminal for the CEO to interact with Claude Code remotely.
You are a CTO-level AI assistant. Working directory: /workspace. You have full access to the codebase.
The CEO may also be running a separate Claude Code session on the desktop terminal — they share the same /workspace files.
Be concise. Follow CLAUDE.md instructions. Ready for tasks.`,
        sessionId: FIXED_SESSION,
        cwd: '/workspace',
      });
      if (socket?.connected) socket.emit('direct-subscribe', { sessionId: FIXED_SESSION });
    }
  } catch (err: any) {
    setState('error');
    routeMessage(FIXED_SESSION, { id: uid(), role: 'system', type: 'error', content: err.message, ts: Date.now() });
  }
}

/** Send to main terminal */
export function send(text: string) {
  const msgId = uid();
  routeMessage(FIXED_SESSION, { id: msgId, role: 'user', type: 'text', content: text, ts: Date.now(), pending: true });

  const ctx = _currentTab === 'config'
    ? '[User is on the Config page (settings, sessions, quick actions). They may be asking about configuration or system management.]\n\n'
    : '';
  sendToSession(FIXED_SESSION, ctx + text)
    .then(() => routeMessage(FIXED_SESSION, { id: msgId, role: 'user', type: 'text', content: text, ts: Date.now(), pending: false }))
    .catch(() => socket?.emit('direct-send', { sessionId: FIXED_SESSION, message: ctx + text }));
}

/** Interrupt main terminal */
export function interrupt() { interruptSession(FIXED_SESSION); }

/** Clear main terminal — stop + respawn */
export function clearSession() {
  stopSession(FIXED_SESSION);
  socket?.close();
  socket = null;
  setState('disconnected');
  setTimeout(() => connect(), 500);
}

// ─── Legacy compat ───
export function onMessage(fn: Listener) { return subscribe(FIXED_SESSION, fn); }
export function onState(fn: StateListener) { stateListeners.add(fn); return () => { stateListeners.delete(fn); }; }
export function getState() { return state; }
export function getSessionId() { return FIXED_SESSION; }

// Re-export subscribe as subscribeSessionMessages for backward compat
export function subscribeSessionMessages(sid: string, cb: Listener) { return subscribe(sid, cb); }
export function unsubscribeSessionMessages() { /* no-op — cleanup handled by subscribe return */ }
