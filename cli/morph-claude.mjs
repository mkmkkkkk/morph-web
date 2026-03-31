#!/usr/bin/env node
/**
 * morph-claude — Dual-mode wrapper (Happy Coder loop pattern).
 *
 * LOCAL MODE:  spawn claude with stdio:'inherit' — identical to normal `claude`.
 * REMOTE MODE: spawn claude -p --resume --stream-json → TUI → auto-return to local.
 *
 * The main loop alternates: local → (remote-message) → remote → (done/space) → local → …
 *
 * Usage: morph-claude [--cwd /path/to/project] [claude args...]
 */

import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { readdirSync, statSync, appendFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { homedir } from 'node:os';

// ── Debug logging ──
const LOG_FILE = '/tmp/morph-wrapper.log';
function dbg(msg) {
  const ts = new Date().toISOString().slice(11, 23);
  try { appendFileSync(LOG_FILE, `[${ts}] ${msg}\n`); } catch {}
}

// ── Parse --cwd from args ──
const rawArgs = process.argv.slice(2);
let CWD = process.cwd();
const cwdIdx = rawArgs.indexOf('--cwd');
if (cwdIdx !== -1 && rawArgs[cwdIdx + 1]) {
  CWD = resolve(rawArgs[cwdIdx + 1]);
  rawArgs.splice(cwdIdx, 2);
}
const userArgs = rawArgs;

// ── Config ──
const RELAY_URL = process.env.MORPH_RELAY_URL || '';
const TOKEN = process.env.MORPH_TOKEN || '';
const PROJECT_ID = resolve(CWD).replace(/[\\\/.:]/g, '-');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude');

// ── Proxy handling ──
// Save proxy vars from environment (set by shell's claude_proxy_env).
// Then clear from process.env so Socket.IO connects DIRECTLY to relay (Cloudflare).
// Child claude processes get proxy restored via cleanEnv().
const PROXY_KEYS = ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy'];
const _savedProxy = {};
for (const k of PROXY_KEYS) {
  if (process.env[k]) _savedProxy[k] = process.env[k];
  delete process.env[k];
}
if (Object.keys(_savedProxy).length) {
  dbg(`proxy: saved ${JSON.stringify(_savedProxy)} — cleared from process.env for direct Socket.IO`);
} else {
  dbg('proxy: none inherited');
}

// ── Socket.IO ──
const require = createRequire(import.meta.url);
let ioModule;
try { ioModule = require('socket.io-client'); } catch {
  try { ioModule = require(join(resolve(import.meta.url.replace('file://', ''), '..', '..', 'relay', 'node_modules', 'socket.io-client'))); } catch {
    console.error('[morph] socket.io-client not found');
    process.exit(1);
  }
}
const { io } = ioModule;

function cleanEnv() {
  const env = { ...process.env, ..._savedProxy };
  delete env.CLAUDECODE;
  return env;
}

// ── State ──
let sessionId = null;
let socket = null;
let _localProc = null;  // current local-mode child process (for remote interrupt)

// Message queue: relay pushes here, loop consumes.
// Event-driven: push() wakes waiters immediately (no polling delay).
let _msgWaiter = null;
let _msgQueue = [];

function pushMessage(msg) {
  _msgQueue.push(msg);
  if (_msgWaiter) {
    const w = _msgWaiter;
    _msgWaiter = null;
    w();
  }
}

function hasMessage() { return _msgQueue.length > 0; }

/** Returns a Promise that resolves when a message arrives. */
function onMessageArrived() {
  if (_msgQueue.length > 0) return Promise.resolve();
  return new Promise(resolve => {
    _msgWaiter = resolve;
  });
}

// ── SIGINT handler — delegated per-mode ──
let _sigintHandler = null;

// ── Session discovery ──
function discoverSessionId() {
  const projectDir = join(CLAUDE_DIR, 'projects', PROJECT_ID);
  try {
    const files = readdirSync(projectDir)
      .filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'))
      .map(f => {
        const st = statSync(join(projectDir, f));
        return { id: f.replace('.jsonl', ''), mtime: st.mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    return files[0]?.id || null;
  } catch { return null; }
}

function startSessionScanner() {
  const check = () => {
    const found = discoverSessionId();
    if (found && found !== sessionId) {
      sessionId = found;
      dbg(`session discovered: ${sessionId.slice(0,8)}`);
      registerWithRelay();
    }
  };
  const fast = setInterval(() => {
    check();
    if (sessionId) { clearInterval(fast); setInterval(check, 10000); }
  }, 1000);
}

// ── Relay ──
function connectRelay() {
  socket = io(RELAY_URL, {
    path: '/v1/updates',
    auth: { token: TOKEN },
    transports: ['websocket'],
    reconnection: true,
    reconnectionDelay: 2000,
  });

  socket.on('connect', () => {
    dbg(`socket connected id=${socket.id}`);
    if (sessionId) registerWithRelay();
  });

  socket.on('remote-message', (data) => {
    dbg(`remote-message: ${JSON.stringify(data.message).slice(0,100)}`);
    if (data.message) pushMessage(data.message);
  });

  socket.on('terminal-stop', (data) => {
    dbg(`[socket] terminal-stop received`);
    cleanupTUI();
    if (socket) socket.disconnect();
    process.exit(0);
  });

  socket.on('terminal-interrupt', (data) => {
    dbg(`[socket] terminal-interrupt received`);
    // In local mode, send SIGINT to the child process so claude handles it
    // like a normal Ctrl-C. In remote mode, _sigintHandler is set and will
    // take care of it.
    if (_localProc && !_localProc.killed) {
      dbg('[socket] sending SIGINT to local child');
      _localProc.kill('SIGINT');
    } else if (_sigintHandler) {
      dbg('[socket] delegating to _sigintHandler');
      _sigintHandler();
    }
  });
}

function registerWithRelay() {
  if (!socket || !sessionId) return;
  dbg(`register sessionId=${sessionId.slice(0,8)} cwd=${CWD} connected=${socket.connected}`);
  socket.emit('terminal-register', {
    sessionId, projectId: PROJECT_ID, cwd: CWD, pid: process.pid,
  });
}

// ── TUI rendering ──
// Orange theme — 256-color (works in Terminal.app + iTerm2)
const O = '\x1b[38;5;208m';          // orange
const OB = '\x1b[1;38;5;208m';       // orange bold
const OD = '\x1b[38;5;172m';         // dim amber
const DIM = '\x1b[38;5;240m';        // gray (structural)
const W = '\x1b[37m';                // white (content)
const RST = '\x1b[0m';

function getWidth() { return process.stdout.columns || 80; }
function getRows() { return process.stdout.rows || 24; }
function visLen(s) { return s.replace(/\x1b\[[0-9;]*m/g, '').length; }

// Full-width horizontal rule
function hRule(w, left, fill, right) {
  return `${O}${left}${fill.repeat(w - 2)}${right}${RST}`;
}

function renderRemoteTUI(phoneMsg) {
  const w = getWidth();
  const rows = getRows();

  // ── Clear + hide cursor ──
  process.stdout.write('\x1b[?25l\x1b[2J\x1b[H');

  // ── Top bar: thin accent line ──
  process.stdout.write(hRule(w, '─', '─', '─') + '\n');

  // ── Header: compact, left-aligned ──
  const tag = `${OB} REMOTE ${RST}`;
  const msgPreview = phoneMsg.length > w - 20
    ? phoneMsg.slice(0, w - 23) + '...'
    : phoneMsg;
  process.stdout.write(`${tag} ${O}${msgPreview}${RST}\n`);

  // ── Thin separator ──
  process.stdout.write(`${DIM}${'─'.repeat(w)}${RST}\n`);

  // ── Content area starts at row 4 ──
  const contentStart = 4;

  // ── Footer: pinned to bottom ──
  const footerRow = rows - 1;
  process.stdout.write(`\x1b[${footerRow};1H`);
  process.stdout.write(`${DIM}${'─'.repeat(w)}${RST}\n`);
  const hint = `${OD}  ␣␣ double-space → local  ${DIM}│${OD}  ^C → exit${RST}`;
  const pad = Math.max(0, w - visLen(hint));
  process.stdout.write(`${hint}${' '.repeat(pad)}`);

  // ── Scroll region: between header and footer ──
  const contentEnd = footerRow - 1;
  process.stdout.write(`\x1b[${contentStart};${contentEnd}r`);
  process.stdout.write(`\x1b[${contentStart};1H`);
}

function appendTUI(text) {
  process.stdout.write(text);
}

function showStats(startTime) {
  const duration = Date.now() - startTime;
  process.stdout.write(`\n${DIM}──${RST} ${O}done ${OD}${(duration / 1000).toFixed(1)}s${RST}\n`);
}

function cleanupTUI() {
  process.stdout.write('\x1b[r');         // reset scroll region
  process.stdout.write('\x1b[2J\x1b[H'); // clear screen + cursor home
  process.stdout.write('\x1b[?25h');      // show cursor
}

// ── Local Mode ──
// Returns Promise<"switch"|"exit">
// IMPORTANT: waits for child process to fully exit before resolving,
// so stdin is clean for the next mode.
function runLocal(args) {
  return new Promise((resolve) => {
    dbg(`[local] start args=${JSON.stringify(args)}`);

    // If there's already a pending message, don't even start claude
    if (hasMessage()) {
      dbg('[local] pending message, skip to remote');
      resolve('switch');
      return;
    }

    const proc = spawn('claude', args, {
      cwd: CWD,
      stdio: 'inherit',
      env: cleanEnv(),
    });
    _localProc = proc;

    // In local mode, SIGINT should go to the child (local claude handles Ctrl-C
    // as "interrupt current operation"). Wrapper must NOT exit.
    _sigintHandler = () => { dbg('[local] SIGINT ignored — child handles it'); };

    let switchRequested = false;
    let resolved = false;

    function finish(reason) {
      if (resolved) return;
      resolved = true;
      _sigintHandler = null;
      _localProc = null;
      resolve(reason);
    }

    // Event-driven: wait for message arrival, then kill child
    const msgPromise = onMessageArrived();
    msgPromise.then(() => {
      if (resolved) return;
      dbg('[local] message arrived, killing local claude');
      switchRequested = true;
      proc.kill('SIGTERM');
      // Don't resolve yet — wait for child to actually exit
    });

    proc.on('exit', () => {
      if (switchRequested) {
        dbg('[local] child exited after switch request');
        finish('switch');
      } else {
        finish('exit');
      }
    });

    proc.on('error', (err) => {
      dbg(`[local] error: ${err.message}`);
      if (switchRequested) finish('switch');
      else finish('exit');
    });
  });
}

// ── Remote Mode ──
// Returns Promise<"done"|"switch"|"exit">
//   "done"   — claude finished naturally (auto-return, keep draining queue)
//   "switch" — user pressed space/ctrl-c (break to local immediately)
function runRemote(message) {
  return new Promise((resolve) => {
    dbg(`[remote] start msg=${message.slice(0,80)}`);
    const startTime = Date.now();
    let resolved = false;
    let autoReturnTimer = null;

    function finish(reason) {
      if (resolved) return;
      resolved = true;
      if (autoReturnTimer) { clearTimeout(autoReturnTimer); autoReturnTimer = null; }
      cleanupTUI();
      removeKeyHandler();
      resolve(reason);
    }

    if (!sessionId) {
      dbg('[remote] no session');
      finish('done');
      return;
    }

    renderRemoteTUI(message);

    // ── Key handler (raw mode) ──
    let keyHandler = null;

    function handleCtrlC() {
      dbg('[remote] ctrl-c → switch');
      if (proc && !proc.killed) proc.kill('SIGINT');
      finish('switch');
    }

    _sigintHandler = handleCtrlC;

    if (process.stdin.isTTY) {
      process.stdin.setRawMode(true);
      process.stdin.resume();
      let lastSpaceTs = 0;
      const DOUBLE_TAP_MS = 400;
      keyHandler = (data) => {
        const ch = data.toString();
        if (ch === ' ') {
          const now = Date.now();
          if (now - lastSpaceTs < DOUBLE_TAP_MS) {
            dbg('[remote] double-space → switch');
            if (proc && !proc.killed) proc.kill('SIGTERM');
            finish('switch');
            return;
          }
          lastSpaceTs = now;
        } else if (ch === '\x03') {
          handleCtrlC();
        }
      };
      process.stdin.on('data', keyHandler);
    }

    function removeKeyHandler() {
      _sigintHandler = null;
      if (keyHandler) {
        process.stdin.removeListener('data', keyHandler);
        keyHandler = null;
      }
      if (process.stdin.isTTY) {
        try { process.stdin.setRawMode(false); } catch {}
        process.stdin.pause();
      }
    }

    // ── Spawn remote Claude ──
    const args = [
      '-p',
      '--resume', sessionId,
      '--input-format', 'stream-json',
      '--output-format', 'stream-json',
      '--verbose',
      '--include-partial-messages',
    ];
    if (userArgs.includes('--dangerously-skip-permissions') || userArgs.includes('-d')) {
      args.push('--permission-mode', 'bypassPermissions');
    }

    const proc = spawn('claude', args, {
      cwd: CWD,
      stdio: ['pipe', 'pipe', 'pipe'],
      env: cleanEnv(),
    });
    dbg(`[remote] spawned pid=${proc.pid}`);

    // Send message to Claude
    const jsonl = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: message },
    });
    proc.stdin.write(jsonl + '\n');
    proc.stdin.end();

    // Parse stdout JSONL
    let buf = '';
    proc.stdout.on('data', (chunk) => {
      buf += chunk.toString();
      const lines = buf.split('\n');
      buf = lines.pop();
      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const evt = JSON.parse(line);

          if (evt.type === 'stream_event') {
            const delta = evt.event?.delta?.text;
            if (delta) appendTUI(delta);
          }

          if (evt.type === 'assistant') {
            const tools = evt.message?.content?.filter(c => c.type === 'tool_use') || [];
            for (const t of tools) {
              appendTUI(`\n${OD}▸ ${t.name}${RST}\n`);
            }
          }

          if (evt.type === 'result') {
            showStats(startTime);
          }

          // Forward to phone via relay
          if (socket?.connected && sessionId) {
            socket.emit('terminal-output', { sessionId, data: evt, ts: Date.now() });
          }
        } catch (e) {
          dbg(`[remote] parse error: ${e.message}`);
        }
      }
    });

    proc.stderr.on('data', (chunk) => {
      const text = chunk.toString().trim();
      dbg(`[remote] stderr: ${text.slice(0, 300)}`);
      if (text) appendTUI(`\n\x1b[38;5;196m${text}${RST}\n`);
    });

    proc.on('exit', (code) => {
      dbg(`[remote] exit code=${code}`);
      // If more messages queued, skip delay and process immediately
      if (hasMessage()) {
        dbg('[remote] more messages queued, returning immediately');
        finish('done');
        return;
      }
      // Brief pause for user to read output, then auto-return
      autoReturnTimer = setTimeout(() => finish('done'), 500);
    });
  });
}

// ── Main loop (Happy Coder pattern) ──
// while(true) { local → (message) → remote → (done) → local → … }
async function loop() {
  let mode = 'local';

  while (true) {
    if (mode === 'local') {
      dbg(`[loop] entering local mode`);

      const localArgs = [...userArgs];
      if (sessionId) {
        const resumeIdx = localArgs.indexOf('--resume');
        if (resumeIdx !== -1) {
          localArgs[resumeIdx + 1] = sessionId;
        } else {
          const sidIdx = localArgs.indexOf('--session-id');
          if (sidIdx !== -1) localArgs.splice(sidIdx, 2);
          localArgs.push('--resume', sessionId);
        }
      }

      const reason = await runLocal(localArgs);
      dbg(`[loop] local returned: ${reason}`);

      if (reason === 'exit') return;
      mode = 'remote';
      continue;
    }

    if (mode === 'remote') {
      // Drain all queued messages
      while (hasMessage()) {
        const msg = _msgQueue.shift();
        dbg(`[loop] entering remote mode msg=${msg.slice(0,60)}`);
        const reason = await runRemote(msg);
        dbg(`[loop] remote returned: ${reason}`);

        if (reason === 'exit') return;
        if (reason === 'switch') break;  // user pressed space/ctrl-c → local NOW
        // reason === 'done' → continue draining queue
      }

      mode = 'local';
      continue;
    }
  }
}

// ── Entry point ──
(async () => {
  dbg(`started: CWD=${CWD} PROJECT_ID=${PROJECT_ID}`);
  connectRelay();
  startSessionScanner();
  await loop();
  if (socket) socket.disconnect();
  process.exit(0);
})();

process.on('SIGTERM', () => {
  cleanupTUI();
  if (socket) socket.disconnect();
  process.exit(0);
});

// Catch SIGINT — delegates to per-mode handler
process.on('SIGINT', () => {
  dbg('[SIGINT] caught');
  if (_sigintHandler) {
    _sigintHandler();
  } else {
    cleanupTUI();
    if (socket) socket.disconnect();
    process.exit(0);
  }
});
