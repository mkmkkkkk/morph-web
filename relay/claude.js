/**
 * claude.js — Direct Claude Code spawner (v2 API)
 *
 * Replaces Happy daemon for remote Claude interaction.
 * Spawns claude -p with stream-json I/O, pipes to Socket.IO.
 *
 * Protocol:
 *   Phone → POST /v2/claude/send     → relay spawns/reuses claude process
 *   Phone → POST /v2/claude/interrupt → sends interrupt to claude stdin
 *   Phone → GET  /v2/claude/sessions  → list resumable sessions
 *   Relay → Socket.IO "claude-output" → phone receives streaming output
 */

import { spawn, execSync } from 'child_process';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync, openSync, readSync, closeSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

// Active Claude processes: sessionId → { process, cwd, claudeSessionId }
const active = new Map();
const MAX_CONCURRENT_SESSIONS = 6;

// Cache for listClaudeSessions — avoids re-scanning filesystem on every request
let _sessionsCache = null;
let _sessionsCacheTs = 0;
const SESSIONS_CACHE_TTL = 30000; // 30s — matches client-side envSessionsCache TTL

// ─── Live session detection ───
// Returns set of session IDs that have open .jsonl file handles.
// Strategy: broad lsof scan for .claude/**/*.jsonl (process-agnostic).
// Fallback: sessions modified within last 4 hours.
function getLiveSessionIds(allSessions) {
  const live = new Set();
  // lsof on macOS scans all kernel FDs — can take 3-10s even with timeout (SIGTERM doesn't interrupt kernel calls)
  // Skip on darwin; 24hr fallback below is sufficient
  if (process.platform !== 'darwin') {
    try {
      // Scan ALL processes — catches both native `claude` binary and node-launched variants
      const out = execSync("lsof 2>/dev/null | grep -E '\\.claude.*\\.jsonl'", { encoding: 'utf-8', timeout: 500, shell: true });
      for (const line of out.split('\n')) {
        const m = line.match(/([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl/i);
        if (m) live.add(m[1]);
      }
    } catch {}
  }

  // Always include recently-modified sessions (< 24hr) — lsof only catches open file handles
  if (allSessions && allSessions.length > 0) {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    for (const s of allSessions) {
      if (s.updatedAt > cutoff) live.add(s.id);
    }
  }

  return live;
}

/**
 * Spawn a Claude process with stream-json I/O.
 * Returns { sessionId, process }.
 */
const ALLOWED_MODELS = new Set([
  'claude-opus-4-6',
  'claude-sonnet-4-6',
  'claude-haiku-4-5-20251001',
]);
const WORK_DIR = process.env.DEFAULT_CWD || '/workspace';

function spawnClaude({ sessionId, resumeFrom, model }) {
  const args = [
    '-p',
    '--verbose',
    '--output-format', 'stream-json',
    '--input-format', 'stream-json',
    '--include-partial-messages',
  ];

  let isResume = false;
  if (resumeFrom) {
    args.push('--resume', resumeFrom);
    isResume = true;
  } else {
    // Check if session file exists — if so, resume instead of creating new
    const projectId = resolve(WORK_DIR).replace(/[\\\/.:]/g, '-');
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const sessionFile = join(claudeDir, 'projects', projectId, `${sessionId}.jsonl`);
    try {
      const stat = statSync(sessionFile);
      if (stat.size > 0) {
        args.push('--resume', sessionId);
        isResume = true;
      } else {
        args.push('--session-id', sessionId);
      }
    } catch {
      args.push('--session-id', sessionId);
    }
  }

  // Whitelist model — reject unknown values
  if (model && ALLOWED_MODELS.has(model)) args.push('--model', model);

  // Inject Morph-specific system prompt from MORPH.md + dynamic context
  // New sessions: inject full MORPH.md + dynamic (establishes Morph persona)
  // Resumed sessions: inject dynamic only — MORPH.md is already baked into session history
  const morphMdPath = join(WORK_DIR, 'morph/web/MORPH.md');
  try {
    const morphCtx = readFileSync(morphMdPath, 'utf-8');

    // Dynamic context — always fresh (current date, env, recent commits)
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10); // YYYY-MM-DD
    const envId = process.env.RELAY_ENV_ID || (WORK_DIR.toLowerCase().includes('tensor') ? 'tensor-revive' : 'workspace');
    const dynamic = [
      `\n# Session Context`,
      `- **Date:** ${dateStr}`,
      `- **Environment:** ${envId} (${WORK_DIR})`,
      `- **Device:** iPhone — keep responses extra concise`,
    ].join('\n');

    // New session: full MORPH.md + dynamic; resumed: dynamic only (no duplicate MORPH.md)
    args.push('--append-system-prompt', isResume ? dynamic : morphCtx + dynamic);
  } catch {}

  // Always bypassPermissions — phone user is the machine owner
  args.push('--permission-mode', 'bypassPermissions');

  const proc = spawn('claude', args, {
    cwd: WORK_DIR,
    env: { ...process.env },
    stdio: ['pipe', 'pipe', 'pipe'],
  });

  return proc;
}

/**
 * Parse stdout JSONL lines and emit to Socket.IO room.
 * Returns a Promise that resolves when the first stdout data arrives (Claude is ready).
 */
function pipeOutput(proc, sessionId, io) {
  let buffer = '';
  let readyResolve;
  proc._ready = new Promise(r => { readyResolve = r; });

  proc.stdout.on('data', (chunk) => {
    if (readyResolve) { readyResolve(); readyResolve = null; }
    buffer += chunk.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop(); // keep incomplete line

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const parsed = JSON.parse(line);
        // Log non-assistant events for debugging (compaction, system, etc.)
        if (parsed.type && parsed.type !== 'assistant' && parsed.type !== 'stream_event') {
          console.log(`[claude:${sessionId.slice(0,8)}] event: ${parsed.type}${parsed.subtype ? '/' + parsed.subtype : ''}`);
        }
        io.to(`direct:${sessionId}`).emit('claude-output', {
          sessionId,
          data: parsed,
        });
      } catch {
        io.to(`direct:${sessionId}`).emit('claude-output', {
          sessionId,
          data: { type: 'raw', text: line },
        });
      }
    }
  });

  proc.stderr.on('data', (chunk) => {
    const text = chunk.toString().trim();
    if (!text) return;
    io.to(`direct:${sessionId}`).emit('claude-error', { sessionId, text });
  });

  proc.on('exit', (code, signal) => {
    // Flush remaining buffer
    if (buffer.trim()) {
      try {
        const parsed = JSON.parse(buffer);
        io.to(`direct:${sessionId}`).emit('claude-output', { sessionId, data: parsed });
      } catch { /* ignore */ }
    }
    io.to(`direct:${sessionId}`).emit('claude-exit', { sessionId, code, signal });
    active.delete(sessionId);
  });

  proc.on('error', (err) => {
    io.to(`direct:${sessionId}`).emit('claude-error', {
      sessionId,
      text: `Process error: ${err.message}`,
    });
    active.delete(sessionId);
  });
}

/**
 * Send a user message to an active Claude process via stdin.
 */
function sendMessage(sessionId, message) {
  const session = active.get(sessionId);
  if (!session || !session.process || session.process.killed) {
    return { error: 'no_active_session' };
  }

  const jsonl = JSON.stringify({
    type: 'user',
    message: { role: 'user', content: message },
  });

  const ok = session.process.stdin.write(jsonl + '\n');
  if (!ok) {
    // Backpressure — wait for drain before accepting more
    session.process.stdin.once('drain', () => {});
  }
  return { ok: true };
}

/**
 * Send interrupt (ctrl-c equivalent) to Claude.
 */
function sendInterrupt(sessionId) {
  const session = active.get(sessionId);
  if (!session || !session.process || session.process.killed) {
    return { error: 'no_active_session' };
  }

  // SIGINT only — the JSON escape character corrupts Claude's stdin parser
  try { session.process.kill('SIGINT'); } catch {}
  return { ok: true };
}

/**
 * List Claude sessions from filesystem.
 * Reads ~/.claude/projects/<project_id>/*.jsonl
 * Results cached for SESSIONS_CACHE_TTL ms to avoid repeated filesystem scans.
 */
function listClaudeSessions(cwd) {
  const now = Date.now();
  if (_sessionsCache && (now - _sessionsCacheTs) < SESSIONS_CACHE_TTL) return _sessionsCache;

  const projectId = resolve(cwd || '/workspace').replace(/[\\\/.:]/g, '-');
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const projectDir = join(claudeDir, 'projects', projectId);

  // Build display name index — tail-read last 64KB of history.jsonl (avoids reading multi-MB file)
  const displayMap = new Map();
  try {
    const historyPath = join(claudeDir, 'history.jsonl');
    const stat = statSync(historyPath);
    const TAIL = 65536;
    const start = Math.max(0, stat.size - TAIL);
    const fd = openSync(historyPath, 'r');
    const buf = Buffer.alloc(Math.min(TAIL, stat.size));
    readSync(fd, buf, 0, buf.length, start);
    closeSync(fd);
    const lines = buf.toString('utf-8').split('\n').filter(l => l.trim());
    for (const line of lines) {
      try {
        const entry = JSON.parse(line);
        if (entry.sessionId && entry.display) {
          displayMap.set(entry.sessionId, {
            display: entry.display,
            project: entry.project,
            timestamp: entry.timestamp,
          });
        }
      } catch {}
    }
  } catch {}

  try {
    const files = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const id = f.replace('.jsonl', '');
        const stat = statSync(join(projectDir, f));
        const meta = displayMap.get(id) || {};
        return {
          id,
          size: stat.size,
          updatedAt: stat.mtimeMs,
          display: meta.display || null,
          project: meta.project || cwd,
        };
      })
      .filter(s => s.size > 0)
      .sort((a, b) => b.updatedAt - a.updatedAt);

    _sessionsCache = files;
    _sessionsCacheTs = Date.now();
    return files;
  } catch {
    return [];
  }
}

/**
 * List all projects that have Claude sessions.
 */
function listAllProjects() {
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const projectsDir = join(claudeDir, 'projects');
  try {
    return readdirSync(projectsDir)
      .filter(d => {
        try { return statSync(join(projectsDir, d)).isDirectory(); } catch { return false; }
      })
      .map(d => {
        // Convert project ID back to path: -workspace → /workspace
        const path = d.replace(/^-/, '/').replace(/-/g, '/');
        const sessionCount = readdirSync(join(projectsDir, d))
          .filter(f => f.endsWith('.jsonl')).length;
        return { id: d, path, sessionCount };
      })
      .filter(p => p.sessionCount > 0);
  } catch {
    return [];
  }
}

/**
 * Register v2 REST routes and Socket.IO events.
 */
export function registerClaudeAPI(app, io, authMiddleware) {

  // ─── REST: List configured relay environments (server-defined, no per-device config needed) ───
  // Set RELAY_ENVS env var as JSON: [{"id":"tr","label":"TR Machine","relayUrl":"https://...","token":"...","maxSessions":6}]

  app.get('/v2/claude/environments', { preHandler: authMiddleware }, async () => {
    const envs = [];
    try {
      const raw = process.env.RELAY_ENVS;
      if (raw) {
        for (const e of JSON.parse(raw)) {
          if (!e.id || !e.relayUrl) continue;
          // If relayUrl is absolute (external host), expose directly — client connects via CORS.
          // If relative/internal, use proxy path to avoid exposing internal URLs.
          const direct = e.relayUrl.startsWith('http');
          envs.push({
            id: e.id,
            label: e.label || e.id,
            maxSessions: e.maxSessions || 6,
            relayUrl: direct ? e.relayUrl : `/relay-proxy/${e.id}`,
            socketPath: direct ? '/v1/updates' : `/relay-proxy/${e.id}/v1/updates`,
            token: direct ? e.token : undefined,
          });
        }
      }
    } catch {}
    return { environments: envs };
  });

  // ─── REST: Start or send message ───

  app.post('/v2/claude/send', { preHandler: authMiddleware }, async (request) => {
    const { message, sessionId: existingId, model } = request.body || {};
    if (!message) return { error: 'message required' };

    // If session exists and process is alive, send to stdin
    if (existingId && active.has(existingId)) {
      const result = sendMessage(existingId, message);
      return { sessionId: existingId, ...result };
    }

    // Otherwise, spawn new Claude process
    // Pinned session (Morph Web fixed session) bypasses the concurrency cap
    const PINNED_SESSION = 'a0a0a0a0-0e00-4000-a000-000000000002';
    const isPinned = existingId === PINNED_SESSION;
    if (!isPinned && active.size >= MAX_CONCURRENT_SESSIONS) {
      return { error: `Too many concurrent sessions (max ${MAX_CONCURRENT_SESSIONS}). Stop an existing session first.` };
    }
    const sessionId = existingId || randomUUID();

    const proc = spawnClaude({ sessionId, model });
    active.set(sessionId, { process: proc, cwd: WORK_DIR, startedAt: Date.now() });
    pipeOutput(proc, sessionId, io);

    // Wait for Claude to be ready (first stdout), then send
    const timeout = new Promise(r => setTimeout(r, 2000));
    Promise.race([proc._ready, timeout]).then(() => sendMessage(sessionId, message));

    return { sessionId, cwd: WORK_DIR, status: 'started' };
  });

  // ─── REST: Resume a session ───

  app.post('/v2/claude/resume', { preHandler: authMiddleware }, async (request) => {
    const { resumeFrom, message, model } = request.body || {};
    if (!resumeFrom) return { error: 'resumeFrom (session ID) required' };

    const sessionId = randomUUID(); // new process ID

    const proc = spawnClaude({ sessionId, resumeFrom, model });
    active.set(sessionId, { process: proc, cwd: WORK_DIR, resumedFrom: resumeFrom, startedAt: Date.now() });
    pipeOutput(proc, sessionId, io);

    // Optionally send a follow-up message — wait for ready
    if (message) {
      const timeout = new Promise(r => setTimeout(r, 2000));
      Promise.race([proc._ready, timeout]).then(() => sendMessage(sessionId, message));
    }

    return { sessionId, resumedFrom: resumeFrom, cwd: WORK_DIR, status: 'resumed' };
  });

  // ─── REST: Interrupt ───

  app.post('/v2/claude/interrupt', { preHandler: authMiddleware }, async (request) => {
    const { sessionId } = request.body || {};
    if (!sessionId) return { error: 'sessionId required' };
    return sendInterrupt(sessionId);
  });

  // ─── REST: Upload file (saves to Downloads, returns path for Claude to read) ───

  app.post('/v2/claude/upload', { preHandler: authMiddleware }, async (request) => {
    const { filename, base64, mime } = request.body || {};
    if (!filename || !base64) return { error: 'filename and base64 required' };

    // Limit to 10 MB (base64 inflates by ~33%, so 13.6 MB base64 ≈ 10 MB binary)
    const MAX_UPLOAD_BYTES = 10 * 1024 * 1024;
    const buffer = Buffer.from(base64, 'base64');
    if (buffer.length > MAX_UPLOAD_BYTES) {
      return { error: `File too large (max 10 MB, got ${(buffer.length / 1024 / 1024).toFixed(1)} MB)` };
    }

    const uploadDir = join(homedir(), 'Downloads');
    mkdirSync(uploadDir, { recursive: true });

    const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_');
    const filePath = join(uploadDir, safeName);
    writeFileSync(filePath, buffer);

    return { path: filePath, size: buffer.length };
  });

  // ─── REST: Stop session ───

  app.post('/v2/claude/stop', { preHandler: authMiddleware }, async (request) => {
    const { sessionId } = request.body || {};
    if (!sessionId) return { error: 'sessionId required' };

    const session = active.get(sessionId);
    if (!session) return { error: 'no_active_session' };

    session.process.kill('SIGTERM');
    active.delete(sessionId);
    return { ok: true };
  });

  // ─── REST: Session history (last N messages from JSONL) ───

  app.get('/v2/claude/history/:sessionId', { preHandler: authMiddleware }, async (request) => {
    const sid = request.params.sessionId;
    const limit = Math.min(parseInt(request.query.limit) || 50, 100); // cap at 100
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const projectsDir = join(claudeDir, 'projects');

    // Tail-read: only load last TAIL_BYTES of file — avoids loading entire 20MB+ session into RAM
    const TAIL_BYTES = 512 * 1024; // 512 KB — enough for ~100+ messages
    function tailRead(filePath) {
      const stat = statSync(filePath);
      if (stat.size === 0) return null;
      const fd = openSync(filePath, 'r');
      const start = Math.max(0, stat.size - TAIL_BYTES);
      const buf = Buffer.allocUnsafe(stat.size - start);
      readSync(fd, buf, 0, buf.length, start);
      closeSync(fd);
      return buf.toString('utf-8');
    }

    // Find session file: try client-supplied cwd first, then default, then search all project dirs
    let raw = null;
    const cwds = [];
    if (request.query.cwd) cwds.push(request.query.cwd);
    cwds.push(process.env.DEFAULT_CWD || '/workspace');
    for (const cwd of cwds) {
      const pid = resolve(cwd).replace(/[\\\/.:]/g, '-');
      try { raw = tailRead(join(projectsDir, pid, `${sid}.jsonl`)); break; } catch {}
    }
    if (!raw) {
      try {
        for (const dir of readdirSync(projectsDir)) {
          try { raw = tailRead(join(projectsDir, dir, `${sid}.jsonl`)); break; } catch {}
        }
      } catch {}
    }

    try {
      // Drop first line (may be partial due to tail offset), then parse
      const allLines = raw.split('\n');
      const lines = (allLines.length > 1 ? allLines.slice(1) : allLines).filter(l => l.trim());

      // Parse and extract displayable messages (last N)
      const messages = [];
      for (const line of lines) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'user' && obj.message?.content) {
            const text = typeof obj.message.content === 'string'
              ? obj.message.content
              : obj.message.content.map(c => c.text || '').join('');
            if (text) messages.push({ role: 'user', type: 'text', content: text.slice(0, 500), ts: obj.timestamp });
          } else if (obj.type === 'assistant' && obj.message?.content) {
            for (const block of obj.message.content) {
              if (block.type === 'text' && block.text) {
                messages.push({ role: 'agent', type: 'text', content: block.text.slice(0, 500), ts: obj.timestamp });
              } else if (block.type === 'thinking' && block.thinking) {
                messages.push({ role: 'agent', type: 'thinking', content: block.thinking.slice(0, 200), ts: obj.timestamp });
              } else if (block.type === 'tool_use') {
                messages.push({ role: 'agent', type: 'tool', content: JSON.stringify(block.input).slice(0, 200), name: block.name, ts: obj.timestamp });
              }
            }
          }
        } catch {}
      }

      // Return last N
      return { messages: messages.slice(-limit) };
    } catch {
      return { messages: [] };
    }
  });

  // ─── REST: List sessions (from filesystem) ───

  app.get('/v2/claude/sessions', { preHandler: authMiddleware }, async (request) => {
    const cwd = request.query.cwd || process.env.DEFAULT_CWD || '/workspace';
    const limit = parseInt(request.query.limit) || 20;
    const allSessions = listClaudeSessions(cwd);
    const osLive = getLiveSessionIds(allSessions);
    // Merge relay-managed active sessions
    for (const id of active.keys()) osLive.add(id);

    const sessions = allSessions
      .filter(s => osLive.has(s.id))
      .slice(0, limit);

    for (const s of sessions) {
      s.active = active.has(s.id);
    }
    return { sessions };
  });

  // ─── DEBUG: Show raw ps output for claude processes ───
  app.get('/v2/claude/debug-ps', { preHandler: authMiddleware }, async (request) => {
    try {
      const cwd = request.query.cwd || process.env.DEFAULT_CWD || '/workspace';
      let lsofOut = '';
      try { lsofOut = execSync("lsof 2>/dev/null | grep -E '\\.claude.*\\.jsonl'", { encoding: 'utf-8', timeout: 10000, shell: true }); } catch {}
      const allSessions = listClaudeSessions(cwd);
      const liveIds = [...getLiveSessionIds(allSessions)];
      const cutoff = Date.now() - 4 * 60 * 60 * 1000;
      const recentSessions = allSessions.filter(s => s.updatedAt > cutoff).map(s => s.id);
      return {
        lsofLines: lsofOut.split('\n').filter(Boolean),
        liveIds,
        totalSessions: allSessions.length,
        recentSessions,
        cwd,
      };
    } catch (e) { return { error: e.message }; }
  });

  // ─── REST: List all projects ───

  app.get('/v2/claude/projects', { preHandler: authMiddleware }, async () => {
    return { projects: listAllProjects() };
  });

  // ─── REST: List active sessions (in-memory) ───

  app.get('/v2/claude/active', { preHandler: authMiddleware }, async (request) => {
    const sessions = [];
    for (const [id, s] of active) {
      sessions.push({
        id,
        cwd: s.cwd,
        resumedFrom: s.resumedFrom,
        startedAt: s.startedAt,
        alive: !s.process.killed,
      });
    }
    return { sessions };
  });

  // ─── REST: Generate session title via Haiku ───

  app.post('/v2/claude/title', { preHandler: authMiddleware }, async (request) => {
    const { sessionId } = request.body || {};
    if (!sessionId) return { error: 'sessionId required' };

    // Read last 10 messages from session history
    const projectId = resolve('/workspace').replace(/[\\\/.:]/g, '-');
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const sessionFile = join(claudeDir, 'projects', projectId, `${sessionId}.jsonl`);

    let snippet = '';
    try {
      const raw = readFileSync(sessionFile, 'utf-8');
      const lines = raw.split('\n').filter(l => l.trim());
      const recent = lines.slice(-20);
      for (const line of recent) {
        try {
          const obj = JSON.parse(line);
          if (obj.type === 'user' && obj.message?.content) {
            const text = typeof obj.message.content === 'string'
              ? obj.message.content : obj.message.content.map(c => c.text || '').join('');
            if (text) snippet += `User: ${text.slice(0, 100)}\n`;
          } else if (obj.type === 'assistant' && obj.message?.content) {
            for (const block of obj.message.content) {
              if (block.type === 'text' && block.text) {
                snippet += `Assistant: ${block.text.slice(0, 100)}\n`;
              }
            }
          }
        } catch {}
      }
    } catch {
      return { error: 'session_not_found' };
    }

    if (!snippet.trim()) return { title: sessionId.slice(0, 8) };

    // Call Haiku for a short title
    try {
      const apiKey = process.env.ANTHROPIC_API_KEY;
      if (!apiKey) {
        const userLine = snippet.split('\n').find(l => l.startsWith('User: '));
        return { title: userLine?.replace('User: ', '').slice(0, 30) || sessionId.slice(0, 8) };
      }

      const resp = await fetch('https://api.anthropic.com/v1/messages', {
        method: 'POST',
        headers: {
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: 'claude-3-haiku-20240307',
          max_tokens: 20,
          messages: [{ role: 'user', content: `Give this coding session a 2-5 word title. No quotes, no punctuation. Just the title.\n\n${snippet.slice(0, 500)}` }],
        }),
      });

      if (!resp.ok) return { title: snippet.split('\n')[0]?.replace('User: ', '').slice(0, 30) || sessionId.slice(0, 8) };
      const data = await resp.json();
      const title = data.content?.[0]?.text?.trim() || sessionId.slice(0, 8);
      return { title };
    } catch {
      return { title: snippet.split('\n')[0]?.replace('User: ', '').slice(0, 30) || sessionId.slice(0, 8) };
    }
  });

  // ─── REST: Claude usage (session + weekly utilization) ───

  app.get('/v2/claude/usage', { preHandler: authMiddleware }, async () => {
    try {
      const credsPath = join(homedir(), '.claude', '.credentials.json');
      const creds = JSON.parse(readFileSync(credsPath, 'utf-8'));
      const oauth = creds.claudeAiOauth;
      if (!oauth?.accessToken) return { error: 'no_token' };

      const resp = await fetch('https://api.anthropic.com/api/oauth/usage', {
        headers: {
          'Authorization': `Bearer ${oauth.accessToken}`,
          'Content-Type': 'application/json',
          'User-Agent': 'claude-code/2.1.38',
          'anthropic-beta': 'oauth-2025-04-20',
        },
      });

      if (!resp.ok) return { error: `http_${resp.status}` };
      const data = await resp.json();

      const parseUtil = (v) => {
        if (typeof v === 'number') return v;
        if (typeof v === 'string') return parseFloat(v.replace('%', '')) || 0;
        return 0;
      };

      return {
        session: {
          pct: parseUtil(data.five_hour?.utilization),
          resetsAt: data.five_hour?.resets_at || null,
        },
        weekly: {
          pct: parseUtil(data.seven_day?.utilization),
          resetsAt: data.seven_day?.resets_at || null,
        },
      };
    } catch (e) {
      return { error: e.message };
    }
  });

  // ─── Socket.IO: direct mode events ───

  io.on('connection', (socket) => {
    // Track which sessions this socket has subscribed to
    const subscribedSessions = new Set();

    // Join direct session room — allow pre-subscription for cold start
    socket.on('direct-subscribe', (data) => {
      if (data.sessionId) {
        socket.join(`direct:${data.sessionId}`);
        subscribedSessions.add(data.sessionId);
      }
    });

    // Send message via Socket.IO — only to sessions this socket owns
    socket.on('direct-send', (data) => {
      const { sessionId, message } = data;
      if (sessionId && message && subscribedSessions.has(sessionId)) {
        sendMessage(sessionId, message);
      }
    });

    // Interrupt via Socket.IO — only owned sessions
    socket.on('direct-interrupt', (data) => {
      if (data.sessionId && subscribedSessions.has(data.sessionId)) {
        sendInterrupt(data.sessionId);
      }
    });
  });
}
