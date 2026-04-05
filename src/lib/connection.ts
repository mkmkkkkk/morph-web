import { io, Socket } from 'socket.io-client';

const FIXED_SESSION = 'a0a0a0a0-0e00-4000-a000-000000000002';
const PRIMARY = 'primary';
function uid() { return `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`; }

// ─── Phase 2: Offline message queue (localStorage-backed) ───
interface QueuedMessage { id: string; sessionId: string; text: string; ts: number; }
const QUEUE_KEY = 'morph-offline-queue';
function loadQueue(): QueuedMessage[] { try { return JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]'); } catch { return []; } }
function saveQueue(q: QueuedMessage[]) { localStorage.setItem(QUEUE_KEY, JSON.stringify(q)); }
let _draining = false;

async function drainQueue() {
  if (_draining) return;
  _draining = true;
  const q = loadQueue();
  const failed: QueuedMessage[] = [];
  for (const item of q) {
    try {
      const relayId = resolveRelayId(item.sessionId);
      const data = await relayPost(relayId, '/v2/claude/send', { message: item.text, sessionId: item.sessionId, cwd: '/workspace' });
      if (data.error) throw new Error(data.error);
      clog('queue-sent', `${item.sessionId.slice(0,8)} queued@${item.ts}`);
    } catch {
      failed.push(item);
    }
  }
  saveQueue(failed);
  _draining = false;
  queueListeners.forEach(fn => fn(failed.length));
}

type QueueListener = (size: number) => void;
const queueListeners = new Set<QueueListener>();
export function onQueueChange(fn: QueueListener) { queueListeners.add(fn); return () => { queueListeners.delete(fn); }; }
export function getQueueSize() { return loadQueue().length; }

// ─── Phase 3: Local message cache (localStorage, last 50 msgs/session) ───
const CACHE_PREFIX = 'morph-cache-';
const CACHE_MAX = 50;

function cacheMessage(sessionId: string, msg: Message) {
  const key = CACHE_PREFIX + sessionId;
  try {
    const arr: Message[] = JSON.parse(localStorage.getItem(key) || '[]');
    // Dedup by id
    if (arr.some(m => m.id === msg.id)) return;
    arr.push({ id: msg.id, role: msg.role, type: msg.type, content: msg.content?.slice(0, 2000), name: msg.name, ts: msg.ts, pending: msg.pending });
    if (arr.length > CACHE_MAX) arr.splice(0, arr.length - CACHE_MAX);
    localStorage.setItem(key, JSON.stringify(arr));
  } catch { /* quota exceeded — ignore */ }
}

export function getCachedMessages(sessionId: string): Message[] {
  try { return JSON.parse(localStorage.getItem(CACHE_PREFIX + sessionId) || '[]'); } catch { return []; }
}

// ─── Connection debug log (ring buffer, last 100 entries) ───
const _connLog: { ts: number; event: string; detail?: string }[] = [];
function clog(event: string, detail?: string) {
  const entry = { ts: Date.now(), event, detail };
  _connLog.push(entry);
  if (_connLog.length > 100) _connLog.shift();
  if (typeof console !== 'undefined') console.debug(`[conn] ${event}`, detail || '');
}
// Expose for debugging: window.__connLog()
if (typeof window !== 'undefined') {
  (window as any).__connLog = () => _connLog.map(e => `${new Date(e.ts).toISOString().slice(11,23)} ${e.event} ${e.detail || ''}`).join('\n');
  (window as any).__connLogRaw = () => [..._connLog];
}

export interface PtySection { type: 'text' | 'tool'; name?: string; content: string; }
export interface Message {
  id: string;
  role: 'user' | 'agent' | 'system';
  type: 'text' | 'thinking' | 'tool' | 'tool_result' | 'status' | 'error' | 'permission' | 'pty';
  content: string;
  name?: string;
  collapsed?: boolean;
  pending?: boolean;
  ts: number;
  sections?: PtySection[];
}

export interface RelayConfig {
  id: string;        // unique key (e.g. 'primary', 'remote-1')
  url: string;       // relay base URL (may be relative, e.g. /relay-proxy/tensor-revive)
  token: string;     // bearer token
  label?: string;    // display name
  socketPath?: string; // custom socket.io path (for proxy connections)
}

type Listener = (msg: Message) => void;
type StateListener = (state: ConnectionState) => void;
type ConnectionState = 'disconnected' | 'connecting' | 'connected' | 'error';

// ─── Per-relay state ───
interface RelayConn {
  config: RelayConfig;
  socket: Socket | null;
  state: ConnectionState;
}

const relayConns = new Map<string, RelayConn>();
const sessionRelayMap = new Map<string, string>(); // sessionId → relayId
const sessionListeners = new Map<string, Set<Listener>>();
// Track last seen event timestamp per session for replay dedup
const lastSeenTs = new Map<string, number>();
const stateListeners = new Set<StateListener>(); // global (tracks primary relay)
const compactListeners = new Set<() => void>();
type LayoutListener = (data: any) => void;
const layoutListeners = new Set<LayoutListener>();
type PermissionListener = (sessionId: string, tools: any[]) => void;
const permissionListeners = new Set<PermissionListener>();

// ─── Relay accessors ───
function primaryToken() { return localStorage.getItem('morph-auth') || ''; }

function ensurePrimary(): RelayConn {
  if (!relayConns.has(PRIMARY)) {
    relayConns.set(PRIMARY, {
      config: { id: PRIMARY, url: window.location.origin, token: primaryToken() },
      socket: null,
      state: 'disconnected',
    });
  }
  // Always refresh primary token from localStorage
  relayConns.get(PRIMARY)!.config.token = primaryToken();
  return relayConns.get(PRIMARY)!;
}

/** Resolve relay ID — only FIXED_SESSION may fall back to PRIMARY silently. */
function resolveRelayId(sessionId: string): string {
  if (sessionId === FIXED_SESSION) return PRIMARY;
  const relayId = sessionRelayMap.get(sessionId);
  if (relayId) return relayId;
  // Unknown session — warn but don't throw (caller may handle)
  console.warn(`[conn] no relay mapping for session ${sessionId.slice(0,8)}, falling back to PRIMARY`);
  return PRIMARY;
}

function relayFor(sessionId: string): RelayConn {
  const id = resolveRelayId(sessionId);
  return relayConns.get(id) ?? ensurePrimary();
}

// ─── Message routing: sessionId → listeners + cache ───
function routeMessage(sessionId: string, msg: Message) {
  sessionListeners.get(sessionId)?.forEach(fn => fn(msg));
  // Phase 3: cache non-pending messages for offline access
  if (!msg.pending) cacheMessage(sessionId, msg);
}

export function subscribe(sessionId: string, fn: Listener): () => void {
  if (!sessionListeners.has(sessionId)) sessionListeners.set(sessionId, new Set());
  sessionListeners.get(sessionId)!.add(fn);
  const relay = relayFor(sessionId);
  if (relay.socket?.connected) relay.socket.emit('direct-subscribe', { sessionId, sinceTs: lastSeenTs.get(sessionId) || 0 });
  return () => {
    sessionListeners.get(sessionId)?.delete(fn);
    if (sessionListeners.get(sessionId)?.size === 0) sessionListeners.delete(sessionId);
  };
}

// ─── Strip ANSI/terminal escape sequences for display ───
function stripTermEscapes(s: string): string {
  return s
    .replace(/\x1b\[\?[0-9;]*[hl]/g, '')           // DEC private mode (before CSI)
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')         // CSI sequences
    .replace(/\x1b\][^\x07]*\x07/g, '')            // OSC sequences
    .replace(/\x1b[()][AB012]/g, '')                // charset
    .replace(/\x1b[\x20-\x2f]*[\x40-\x7e]/g, '')   // other escapes
    .replace(/[\x00-\x09\x0b-\x1f]/g, '')          // control chars except \n
    .replace(/\??\d{2,}[hl]/g, '')                   // residual DEC mode numbers
    // Claude TUI chrome (safety net — wrapper should strip these too)
    .replace(/^.*⏵⏵.*$/gm, '')                      // status bar
    .replace(/^.*(?:shift\+tab|esc to interrupt|to cycle).*$/gim, '') // UI hints
    .replace(/^\s*[─━]{3,}\s*$/gm, '')             // horizontal rules
    .replace(/^\s*[\u2800-\u28FF]+\s*$/gm, '')     // spinner-only lines
    .replace(/^(\s*)⎿\s*/gm, '$1')                 // ⎿ response marker
    .replace(/^(\s*)│\s?/gm, '$1  ')               // │ side border → indent
    .replace(/\n{3,}/g, '\n\n')                     // collapse excessive newlines
    .trim();
}

// ─── Parse Claude stream-json ───
function parseOutput(data: any): Message[] {
  // JSONL structured messages from wrapper (clean, authoritative source)
  if (data?.type === 'jsonl' && data?.messages?.length) {
    const ts = data.ts || Date.now();
    return (data.messages as any[]).map((m: any) => {
      const role = m.role === 'user' ? 'user' as const : 'agent' as const;
      if (m.type === 'tool') {
        return { id: m.toolId || uid(), role, type: 'tool' as const, content: m.content || '', name: m.name, ts, collapsed: true };
      }
      if (m.type === 'tool_result') {
        return { id: uid(), role, type: 'tool_result' as const, content: m.content || '', ts, collapsed: true };
      }
      return { id: uid(), role, type: 'text' as const, content: m.content || '', ts };
    });
  }
  // PTY structured sections from wrapper (collapsible tools + clean text)
  if (data?.type === 'pty' && data?.sections?.length) {
    const ts = data.ts || Date.now();
    const sections: PtySection[] = data.sections;
    const fallback = sections.map(s => s.content).join('\n');
    return [{ id: uid(), role: 'agent', type: 'pty', content: fallback, sections, ts }];
  }
  // PTY screen snapshot — single replacing frame (not appending)
  // AX text is already clean (no ANSI), don't strip or it destroys TUI content
  if (data?.type === 'pty' && data?.text) {
    const text = data.text.trim();
    if (!text) return [];
    return [{ id: uid(), role: 'agent', type: 'pty', content: text, ts: data.ts || Date.now() }];
  }
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

// ─── Per-relay socket ───
function connectRelaySocket(relayId: string): void {
  const conn = relayConns.get(relayId);
  if (!conn) return;
  if (conn.socket) { conn.socket.close(); conn.socket = null; }

  const setConnState = (s: ConnectionState) => {
    conn.state = s;
    if (relayId === PRIMARY) stateListeners.forEach(fn => fn(s));
  };

  // For proxy relays (relative URLs like /relay-proxy/...), use current origin as socket host
  const socketUrl = conn.config.url.startsWith('/') ? window.location.origin : conn.config.url;
  const socketPath = conn.config.socketPath || '/v1/updates';
  const token = conn.config.token || primaryToken();

  conn.socket = io(socketUrl, {
    path: socketPath,
    transports: ['websocket'],
    auth: { token, clientType: 'session-scoped', sessionId: 'direct' },
    // Also pass token as query param so proxy can rewrite it in the upgrade URL
    query: { token },
    reconnection: true,
    reconnectionDelay: 1000,
    reconnectionDelayMax: 5000,
  });

  clog('socket-init', `relay=${relayId} url=${socketUrl} path=${socketPath}`);
  conn.socket.on('connect', () => {
    clog('connected', `relay=${relayId} id=${conn.socket!.id}`);
    // Re-subscribe all sessions belonging to this relay
    for (const [sid, rid] of sessionRelayMap.entries()) {
      if (rid === relayId) conn.socket!.emit('direct-subscribe', { sessionId: sid, sinceTs: lastSeenTs.get(sid) || 0 });
    }
    // Re-subscribe active listener sessions mapped to this relay (or unmapped → PRIMARY)
    for (const sid of sessionListeners.keys()) {
      const mapped = sessionRelayMap.get(sid);
      if (mapped === relayId || (!mapped && relayId === PRIMARY)) {
        conn.socket!.emit('direct-subscribe', { sessionId: sid, sinceTs: lastSeenTs.get(sid) || 0 });
      }
    }
    // Re-subscribe active TTY rooms (spatial grid)
    if (relayId === PRIMARY) {
      for (const tty of ttyListeners.keys()) {
        conn.socket!.emit('subscribe-tty', { tty });
        clog('tty-resubscribe', `tty=${tty}`);
      }
    }
    setConnState('connected');
    // Phase 2: drain offline queue on reconnect
    if (relayId === PRIMARY) drainQueue();
  });
  conn.socket.on('disconnect', (reason) => { clog('disconnected', `relay=${relayId} reason=${reason}`); setConnState('disconnected'); });
  conn.socket.on('connect_error', (err) => { clog('connect_error', `relay=${relayId} err=${err.message}`); setConnState('error'); });
  conn.socket.io.on('reconnect_attempt', (n: number) => clog('reconnect_attempt', `relay=${relayId} attempt=${n}`));
  conn.socket.io.on('reconnect', () => clog('reconnect_ok', `relay=${relayId}`));
  conn.socket.on('claude-compact', (data: any) => {
    const sid = data?.sessionId;
    const ts = data?.ts;
    if (sid && ts) lastSeenTs.set(sid, ts);
    compactListeners.forEach(fn => fn());
  });

  conn.socket.on('claude-output', (data: any) => {
    const sid = data?.sessionId;
    const tty = data?.tty;
    const ts = data?.ts || data?.data?.ts;
    if (sid && ts) lastSeenTs.set(sid, ts);
    const msgs = parseOutput(data);
    // Route to session listeners
    if (sid) msgs.forEach(m => routeMessage(sid, m));
    // Route to TTY listeners (spatial grid mode)
    if (tty && ttyListeners.has(tty)) {
      ttyListeners.get(tty)!.forEach(fn => msgs.forEach(m => fn(m)));
    }
  });
  conn.socket.on('claude-permission', (data: any) => {
    const sid = data?.sessionId;
    if (sid) {
      const tools = data.tools || [];
      const label = tools.map((t: any) => t.tool).join(', ');
      const preview = tools[0]?.input?.command || tools[0]?.input?.file_path || '';
      const msg: Message = {
        id: uid(), role: 'system', type: 'permission' as Message['type'],
        content: JSON.stringify(tools),
        name: label,
        pending: true,
        ts: Date.now(),
      };
      routeMessage(sid, msg);
      permissionListeners.forEach(fn => fn(sid, tools));
    }
  });
  conn.socket.on('claude-error', (data: any) => {
    const sid = data?.sessionId;
    const ts = data?.ts;
    if (sid && ts) lastSeenTs.set(sid, ts);
    const msg: Message = { id: uid(), role: 'system', type: 'error', content: data.text || 'Error', ts: Date.now() };
    if (sid) routeMessage(sid, msg);
  });
  conn.socket.on('claude-exit', (data: any) => {
    const sid = data?.sessionId;
    const ts = data?.ts;
    if (sid && ts) lastSeenTs.set(sid, ts);
    const msg: Message = { id: uid(), role: 'system', type: 'status', content: `--- exit ${data.code} ---`, ts: Date.now() };
    if (sid) routeMessage(sid, msg);
  });
  // Layout push — relay sends only when pane arrangement changes
  if (relayId === PRIMARY) {
    conn.socket.on('layout-update', (data: any) => {
      layoutListeners.forEach(fn => fn(data));
    });
    // TTY came online (wrapper registered) — force layout refresh
    conn.socket.on('tty-online', () => {
      clog('tty-online', 'forcing layout refresh');
      relayGet(relayId, '/v2/claude/layout').then(data => {
        layoutListeners.forEach(fn => fn(data));
      }).catch(() => {});
    });
  }
}

// ─── API helpers ───
async function relayPost(relayId: string, path: string, body: any) {
  const conn = relayConns.get(relayId) ?? ensurePrimary();
  const res = await fetch(`${conn.config.url}${path}`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${conn.config.token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return res.json();
}

async function relayGet(relayId: string, path: string) {
  const conn = relayConns.get(relayId) ?? ensurePrimary();
  const res = await fetch(`${conn.config.url}${path}`, {
    headers: { 'Authorization': `Bearer ${conn.config.token}` },
  });
  return res.json();
}

// Legacy shims (always hit primary)
async function apiPost(path: string, body: any) { return relayPost(PRIMARY, path, body); }
async function apiGet(path: string) { return relayGet(PRIMARY, path); }

// ─── Multi-relay management ───

function loadSavedRelays(): void {
  try {
    const saved = JSON.parse(localStorage.getItem('morph-secondary-relays') || '[]') as RelayConfig[];
    // Drop stale proxy entries (url starts with /relay-proxy/) — server will re-push direct URLs
    const valid = saved.filter(cfg => !cfg.url.startsWith('/relay-proxy/'));
    if (valid.length !== saved.length) localStorage.setItem('morph-secondary-relays', JSON.stringify(valid));
    valid.forEach(cfg => {
      if (!relayConns.has(cfg.id)) {
        relayConns.set(cfg.id, { config: cfg, socket: null, state: 'disconnected' });
      }
      connectRelaySocket(cfg.id);
    });
  } catch { /* ignore */ }
}

function saveRelayConfigs(): void {
  const secondary = Array.from(relayConns.values())
    .filter(c => c.config.id !== PRIMARY)
    .map(c => c.config);
  localStorage.setItem('morph-secondary-relays', JSON.stringify(secondary));
}

/** Add and connect a secondary relay. Call from Config UI. */
export function addRelay(config: RelayConfig): void {
  if (relayConns.has(config.id)) {
    // Update token/label if relay already exists
    relayConns.get(config.id)!.config = config;
  } else {
    relayConns.set(config.id, { config, socket: null, state: 'disconnected' });
  }
  connectRelaySocket(config.id);
  saveRelayConfigs();
}

/** Disconnect and remove a secondary relay. */
export function removeRelay(id: string): void {
  if (id === PRIMARY) return;
  const conn = relayConns.get(id);
  if (conn?.socket) conn.socket.close();
  relayConns.delete(id);
  for (const [sid, rid] of sessionRelayMap.entries()) {
    if (rid === id) sessionRelayMap.delete(sid);
  }
  saveRelayConfigs();
}

/** Get all relay configs (primary + secondary). */
export function getRelayConfigs(): RelayConfig[] {
  return Array.from(relayConns.values()).map(c => c.config);
}

/** Get connection state for a specific relay. */
export function getRelayState(id: string): ConnectionState {
  return relayConns.get(id)?.state ?? 'disconnected';
}

/** Map a session to its relay without going through fetchAllSessions. */
export function registerSession(sessionId: string, relayId: string): void {
  sessionRelayMap.set(sessionId, relayId);
  const conn = relayConns.get(relayId);
  if (conn?.socket?.connected) conn.socket.emit('direct-subscribe', { sessionId, sinceTs: lastSeenTs.get(sessionId) || 0 });
}

// ─── Session operations (relay-aware) ───

export async function sendToSession(sid: string, text: string): Promise<void> {
  try {
    const relayId = resolveRelayId(sid);
    const data = await relayPost(relayId, '/v2/claude/send', { message: text, sessionId: sid, cwd: '/workspace' });
    if (data.error) throw new Error(data.error);
  } catch (err) {
    // Phase 2: queue for retry on reconnect
    const q = loadQueue();
    q.push({ id: uid(), sessionId: sid, text, ts: Date.now() });
    saveQueue(q);
    clog('queue-add', `${sid.slice(0,8)} queued (total=${q.length})`);
    queueListeners.forEach(fn => fn(q.length));
    throw err; // still throw so caller knows it failed
  }
}

export async function resumeSession(sid: string, text: string): Promise<string> {
  const relayId = resolveRelayId(sid);
  const data = await relayPost(relayId, '/v2/claude/resume', { resumeFrom: sid, message: text, cwd: '/workspace' });
  const newSid = data.sessionId || sid;
  const conn = relayConns.get(relayId);
  if (conn?.socket?.connected) conn.socket.emit('direct-subscribe', { sessionId: newSid, sinceTs: lastSeenTs.get(newSid) || 0 });
  // Track new session → same relay (no listener migration — caller re-subscribes)
  if (newSid !== sid) sessionRelayMap.set(newSid, relayId);
  return newSid;
}

export function interruptSession(sid: string) {
  const relayId = resolveRelayId(sid);
  relayPost(relayId, '/v2/claude/interrupt', { sessionId: sid }).catch(() => {});
}

export function stopSession(sid: string) {
  const relayId = resolveRelayId(sid);
  relayPost(relayId, '/v2/claude/stop', { sessionId: sid }).catch(() => {});
}

/** Approve tool execution — resume SIGSTOP'd process */
export function approvePermission(sid: string) {
  const relayId = resolveRelayId(sid);
  const conn = relayConns.get(relayId);
  if (conn?.socket) conn.socket.emit('direct-approve', { sessionId: sid });
}

/** Deny tool execution — resume then interrupt */
export function denyPermission(sid: string) {
  const relayId = resolveRelayId(sid);
  const conn = relayConns.get(relayId);
  if (conn?.socket) conn.socket.emit('direct-deny', { sessionId: sid });
}

/** Listen for permission requests across all relays */
export function onPermission(cb: PermissionListener): () => void {
  permissionListeners.add(cb);
  return () => { permissionListeners.delete(cb); };
}

export async function isSessionAlive(sid: string): Promise<boolean> {
  const relayId = resolveRelayId(sid);
  const data = await relayGet(relayId, '/v2/claude/active');
  return (data.sessions || []).some((s: any) => s.id === sid && s.alive);
}

export async function loadHistory(sid: string, limit = 50): Promise<Message[]> {
  const relayId = resolveRelayId(sid);
  const data = await relayGet(relayId, `/v2/claude/history/${sid}?limit=${limit}`);
  return (data.messages || []).map((m: any) => ({
    id: uid(), role: m.role, type: m.type, content: m.content, name: m.name,
    ts: m.ts ? new Date(m.ts).getTime() : Date.now(),
  }));
}

/** Fetch sessions from primary relay only (legacy compat). */
export async function fetchSessions(): Promise<any[]> {
  const data = await apiGet('/v2/claude/sessions?limit=20');
  return data.sessions || [];
}

/** Fetch sessions from ALL relays, tagged with relayId + relayLabel. */
export async function fetchAllSessions(): Promise<any[]> {
  const relayIds = Array.from(relayConns.keys());
  const results = await Promise.allSettled(
    relayIds.map(async (relayId) => {
      const conn = relayConns.get(relayId)!;
      const data = await relayGet(relayId, '/v2/claude/sessions?limit=30');
      const sessions = data.sessions || [];
      sessions.forEach((s: any) => {
        s.relayId = relayId;
        s.relayLabel = relayId === PRIMARY ? null : (conn.config.label || relayId);
        sessionRelayMap.set(s.id, relayId);
        // Auto-subscribe if we have active listeners for this session
        if (sessionListeners.has(s.id) && conn.socket?.connected) {
          conn.socket.emit('direct-subscribe', { sessionId: s.id, sinceTs: lastSeenTs.get(s.id) || 0 });
        }
      });
      return sessions;
    })
  );
  return results.flatMap(r => r.status === 'fulfilled' ? r.value : []);
}

// ─── Main terminal (wraps primary + FIXED_SESSION) ───

let _currentTab = 'canvas';
export function setCurrentTab(tab: string) { _currentTab = tab; }

export async function connect(): Promise<void> {
  const primary = ensurePrimary();
  primary.state = 'connecting';
  stateListeners.forEach(fn => fn('connecting'));

  try {
    connectRelaySocket(PRIMARY);
    await new Promise<void>((resolve) => {
      if (primary.socket?.connected) { resolve(); return; }
      let resolved = false;
      const done = () => { if (resolved) return; resolved = true; primary.socket?.off('connect', done); clearTimeout(t); resolve(); };
      primary.socket?.on('connect', done);
      const t = setTimeout(done, 3000);
    });

    const [history, alive] = await Promise.all([
      loadHistory(FIXED_SESSION, 30),
      isSessionAlive(FIXED_SESSION),
    ]);
    history.forEach(msg => routeMessage(FIXED_SESSION, msg));

    if (!alive) {
      await apiPost('/v2/claude/send', {
        message: `This is Morph Web — a mobile terminal for the CEO to interact with Claude Code remotely.\nYou are a CTO-level AI assistant. Working directory: /workspace. You have full access to the codebase.\nThe CEO may also be running a separate Claude Code session on the desktop terminal — they share the same /workspace files.\nBe concise. Follow CLAUDE.md instructions. Ready for tasks.`,
        sessionId: FIXED_SESSION,
        cwd: '/workspace',
      });
    }

    // Always ensure FIXED_SESSION is subscribed (covers alive=true case too)
    if (primary.socket?.connected) primary.socket.emit('direct-subscribe', { sessionId: FIXED_SESSION, sinceTs: lastSeenTs.get(FIXED_SESSION) || 0 });

    // Connect secondary relays saved from previous session
    loadSavedRelays();
  } catch (err: any) {
    primary.state = 'error';
    stateListeners.forEach(fn => fn('error'));
    routeMessage(FIXED_SESSION, { id: uid(), role: 'system', type: 'error', content: err.message, ts: Date.now() });
  }
}

export function send(text: string) {
  const msgId = uid();
  routeMessage(FIXED_SESSION, { id: msgId, role: 'user', type: 'text', content: text, ts: Date.now(), pending: true });

  const ctx = _currentTab === 'config'
    ? '[User is on the Config page (settings, sessions, quick actions). They may be asking about configuration or system management.]\n\n'
    : '';
  sendToSession(FIXED_SESSION, ctx + text)
    .then(() => routeMessage(FIXED_SESSION, { id: msgId, role: 'user', type: 'text', content: text, ts: Date.now(), pending: false }))
    .catch(() => {
      // Message was queued by sendToSession — show "queued" status
      routeMessage(FIXED_SESSION, { id: uid(), role: 'system', type: 'status', content: 'Message queued — will send when reconnected', ts: Date.now() });
    });
}

export function interrupt() { interruptSession(FIXED_SESSION); }

export function clearSession() {
  stopSession(FIXED_SESSION);
  const primary = ensurePrimary();
  if (primary.socket) { primary.socket.close(); primary.socket = null; }
  primary.state = 'disconnected';
  stateListeners.forEach(fn => fn('disconnected'));
  setTimeout(() => connect(), 500);
}

// ─── Legacy compat ───
export function onMessage(fn: Listener) { return subscribe(FIXED_SESSION, fn); }
export function onState(fn: StateListener) { stateListeners.add(fn); return () => { stateListeners.delete(fn); }; }
export function onCompact(fn: () => void) { compactListeners.add(fn); return () => { compactListeners.delete(fn); }; }
export function onLayoutUpdate(fn: LayoutListener) { layoutListeners.add(fn); return () => { layoutListeners.delete(fn); }; }
export function getState(): ConnectionState { return ensurePrimary().state; }
export function getSessionId() { return FIXED_SESSION; }

let _sessionUnsub: (() => void) | null = null;
export function subscribeSessionMessages(sid: string, cb: Listener) {
  if (_sessionUnsub) { _sessionUnsub(); _sessionUnsub = null; }
  _sessionUnsub = subscribe(sid, cb);
  return _sessionUnsub;
}
export function unsubscribeSessionMessages() {
  if (_sessionUnsub) { _sessionUnsub(); _sessionUnsub = null; }
}

// ─── TTY-based routing (spatial grid) ───

const ttyListeners = new Map<string, Set<Listener>>();

/** Send a message to a specific TTY via Socket.IO direct-send. */
export function sendToTTY(tty: string, text: string): void {
  const primary = ensurePrimary();
  if (!primary.socket?.connected) {
    clog('tty-send-fail', `not connected, tty=${tty}`);
    return;
  }
  clog('tty-send', `tty=${tty} msg=${text.slice(0, 40)}`);
  primary.socket.emit('direct-send', { tty, message: text });
}

/** Send a raw key sequence to a specific TTY (arrow keys, Esc, Ctrl, etc.) */
export function sendRawKeyToTTY(tty: string, key: string): void {
  const primary = ensurePrimary();
  if (!primary.socket?.connected) return;
  primary.socket.emit('direct-send', { tty, message: key, raw: true });
}

/** Subscribe to output from a specific TTY room. Returns unsubscribe function. */
export function subscribeTTY(tty: string, cb: Listener): () => void {
  if (!ttyListeners.has(tty)) ttyListeners.set(tty, new Set());
  ttyListeners.get(tty)!.add(cb);

  // Emit now if connected; also registered in connect handler for reconnect/late-connect
  const primary = ensurePrimary();
  if (primary.socket?.connected) {
    primary.socket.emit('subscribe-tty', { tty });
    clog('tty-subscribe', `tty=${tty}`);
  } else {
    // Socket not yet connected — will be sent via tty-resubscribe on connect
    clog('tty-subscribe-queued', `tty=${tty} (socket not connected)`);
  }

  return () => {
    ttyListeners.get(tty)?.delete(cb);
    if (ttyListeners.get(tty)?.size === 0) ttyListeners.delete(tty);
  };
}

/** Check if an ID is a TTY-prefixed ID (from spatial grid). */
export function isTTYId(id: string): boolean { return id.startsWith('tty:'); }
/** Extract TTY name from a tty:XXX prefixed ID. */
export function parseTTYId(id: string): string { return id.replace('tty:', ''); }

// Instant reconnect when page comes back to foreground
// Socket.IO's built-in reconnection uses exponential backoff — up to 5s delay.
// Force-disconnect then immediately reconnect to skip the wait.
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    clog('visibility', document.visibilityState);
    if (document.visibilityState !== 'visible') return;
    for (const [relayId, conn] of relayConns) {
      if (!conn.socket) continue;
      if (conn.socket.connected) { clog('resume-skip', `relay=${relayId} already connected`); continue; }
      clog('resume-reconnect', `relay=${relayId} forcing disconnect+connect`);
      conn.socket.disconnect();
      conn.socket.connect();
    }
  });
}
