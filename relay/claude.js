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

import { spawn } from 'child_process';
import { readdirSync, readFileSync, statSync, writeFileSync, mkdirSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';
import { randomUUID } from 'crypto';

// Active Claude processes: sessionId → { process, cwd, claudeSessionId }
const active = new Map();
const MAX_CONCURRENT_SESSIONS = 6;

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

  if (resumeFrom) {
    args.push('--resume', resumeFrom);
  } else {
    // Check if session file exists — if so, resume instead of creating new
    const projectId = resolve(WORK_DIR).replace(/[\\\/.:]/g, '-');
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    const sessionFile = join(claudeDir, 'projects', projectId, `${sessionId}.jsonl`);
    try {
      const stat = statSync(sessionFile);
      if (stat.size > 0) {
        args.push('--resume', sessionId);
      } else {
        args.push('--session-id', sessionId);
      }
    } catch {
      args.push('--session-id', sessionId);
    }
  }

  // Whitelist model — reject unknown values
  if (model && ALLOWED_MODELS.has(model)) args.push('--model', model);

  // Inject Morph-specific system prompt from MORPH.md
  const morphMdPath = join(WORK_DIR, 'morph/web/MORPH.md');
  try {
    const morphCtx = readFileSync(morphMdPath, 'utf-8');
    args.push('--append-system-prompt', morphCtx);
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
 */
function listClaudeSessions(cwd) {
  const projectId = resolve(cwd || '/workspace').replace(/[\\\/.:]/g, '-');
  const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
  const projectDir = join(claudeDir, 'projects', projectId);

  // Build display name index from history.jsonl
  const displayMap = new Map();
  try {
    const historyPath = join(claudeDir, 'history.jsonl');
    const lines = readFileSync(historyPath, 'utf-8').split('\n').filter(l => l.trim());
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
    if (active.size >= MAX_CONCURRENT_SESSIONS) {
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

    // Search all project dirs — session could be in any project, not just /workspace
    let sessionFile = null;
    try {
      const projectsDir = join(claudeDir, 'projects');
      const dirs = readdirSync(projectsDir);
      for (const dir of dirs) {
        const candidate = join(projectsDir, dir, `${sid}.jsonl`);
        try { statSync(candidate); sessionFile = candidate; break; } catch {}
      }
    } catch {}
    if (!sessionFile) return { messages: [] };

    try {
      const raw = readFileSync(sessionFile, 'utf-8');
      const lines = raw.split('\n').filter(l => l.trim());

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
    const sessions = listClaudeSessions(cwd).slice(0, limit);

    // Mark which sessions are currently active
    for (const s of sessions) {
      s.active = active.has(s.id);
    }
    return { sessions };
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

    // Read last 10 messages from session history — search all project dirs
    const claudeDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');
    let sessionFile = null;
    try {
      const dirs = readdirSync(join(claudeDir, 'projects'));
      for (const dir of dirs) {
        const c = join(claudeDir, 'projects', dir, `${sessionId}.jsonl`);
        try { statSync(c); sessionFile = c; break; } catch {}
      }
    } catch {}
    if (!sessionFile) return { title: 'Untitled' };

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
