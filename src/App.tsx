/**
 * App.tsx — Morph Web 主界面（spatial grid + session view）
 *
 * ⚠️  ARCHITECTURE LOCKED (2026-04-05) — 能不改就不要改 ⚠️
 * TTY pane 打开流程：getPreloadedMessages → subscribeTTY → live updates
 * 预加载是消除延迟的关键，不要删掉或绕过。
 */
import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useMotionValue } from 'framer-motion';
import { connect, send, interrupt, interruptSession, clearSession, setCurrentTab, fetchSessions, onMessage, onState, onCompact, getState, sendToSession, resumeSession, isSessionAlive, loadHistory, subscribe, subscribeSessionMessages, unsubscribeSessionMessages, addRelay, registerSession, approvePermission, denyPermission, stopSession, sendToTTY, sendRawKeyToTTY, subscribeTTY, isTTYId, parseTTYId, onLayoutUpdate, getPreloadedMessages, type Message, type PtySection, type RelayConfig } from './lib/connection';
import Sketch from './components/Sketch';

// Cache-bust canvas.html per build (not per page load) — allows HTTP caching across reloads
declare const __BUILD_TIME__: string;
const BUILD_TS = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : Date.now().toString(36);

// Strip ANSI/terminal escapes for phone rendering
function stripTermEscapesForRender(s: string): string {
  // Step 0: find the last full screen redraw and start from there
  // Claude TUI redraws with \x1b[H (cursor home) or \x1b[?1049h (alternate screen)
  // This discards old animation frames and only keeps the current screen
  const lastAltScreen = s.lastIndexOf('\x1b[?1049h');
  const lastCursorHome = s.lastIndexOf('\x1b[H\x1b[2J'); // home + clear screen
  const lastRedraw = Math.max(lastAltScreen, lastCursorHome);
  if (lastRedraw > 0 && lastRedraw < s.length - 50) {
    s = s.slice(lastRedraw);
  }

  // Step 1: strip ANSI escape sequences (comprehensive)
  let cleaned = s
    .replace(/\x1b\[[\x20-\x3f]*[\x40-\x7e]/g, '') // ALL CSI sequences (includes ?/>/= prefixed)
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences (BEL or ST terminated)
    .replace(/\x1b[()][AB012]/g, '')               // charset selection
    .replace(/\x1b[\x20-\x2f]*[\x40-\x7e]/g, '') // other ESC sequences
    // Remove control chars EXCEPT \r (0x0d) and \n (0x0a) — \r is needed for overwrite processing
    .replace(/[\x00-\x09\x0b\x0c\x0e-\x1f]/g, '');

  // Step 2: normalize \r\n → \n, then process standalone \r as "overwrite from column 0"
  cleaned = cleaned.replace(/\r\n/g, '\n');
  cleaned = cleaned.split('\n').map(line => {
    if (!line.includes('\r')) return line;
    // Simulate carriage return: \r moves cursor to column 0, subsequent chars overwrite
    const chars: string[] = [];
    let col = 0;
    for (const ch of line) {
      if (ch === '\r') {
        col = 0;
      } else {
        if (col < chars.length) {
          chars[col] = ch;
        } else {
          while (chars.length < col) chars.push(' ');
          chars.push(ch);
        }
        col++;
      }
    }
    return chars.join('');
  }).join('\n');

  // Step 3: strip TUI chrome and noise
  cleaned = cleaned
    .replace(/\??\d{2,}[hl]/g, '')               // leftover mode params
    .replace(/>[0-9]+[uq]/g, '')                   // leftover CSI params (>1u, >0q)
    .replace(/<[0-9]+u/g, '')                      // leftover CSI params (<1u)
    .replace(/^.*⏵⏵.*$/gm, '')                    // bypass permissions line
    .replace(/^.*(?:shift\+tab|esc to interrupt|to cycle|auto mode).*$/gim, '') // TUI tips
    .replace(/^\s*[─━]{3,}\s*$/gm, '')            // horizontal rules
    .replace(/^\s*[\u2800-\u28FF]+\s*$/gm, '')    // braille loading blocks
    // Spinner lines: ✢✳✶✻✽ followed by any spinner word
    .replace(/^[·✢✳✶✻✽●]+.*….*$/gim, '')
    // Claude header: ▐▛███▜▌ClaudeCode...
    .replace(/^.*[▐▛███▜▌]+.*ClaudeCode.*$/gm, '')
    // "Tip:" lines (with possible leading whitespace)
    .replace(/^\s*Tip:.*$/gm, '')
    // "Claude Code has switched..." lines
    .replace(/^\s*Claude\s*Code\s*has\s*switched.*$/gim, '')
    // Garbled TUI: "steerClaudeinreal-time" etc
    .replace(/^.*steer\s*Claude.*$/gim, '')
    // "(thinking with ...)" status lines
    .replace(/^\s*\(thinking\s+with\s+.*\)$/gm, '')
    // control+v tips
    .replace(/^\s*control\+v.*$/gim, '')
    // Generic spinner: single capitalized word ending with … (Flambéing…, Channelling…, etc.)
    .replace(/^\s*[A-Z][a-zé]+…(\s*\(thinking.*\))?\s*$/gm, '');

  return cleaned.replace(/\n{3,}/g, '\n\n').trim();
}

// ── PTY segment parser: same visual as JSONL rendering, different data source ──
interface PtySegment { type: 'user' | 'text' | 'tool'; content: string; name?: string }
const PTY_TOOL_RE = /^⏺\s*(Bash|Read|Edit|Write|Glob|Grep|Agent|Skill|ToolSearch|WebFetch|WebSearch|NotebookEdit|Task\w+|Enter\w+|Exit\w+|AskUser\w+)/;

function parsePtySegments(cleaned: string): PtySegment[] {
  const lines = cleaned.split('\n');
  const segments: PtySegment[] = [];
  let cur: PtySegment | null = null;

  const flush = () => {
    if (!cur) return;
    cur.content = cur.content.trim();
    if (cur.content || cur.type === 'user') segments.push(cur);
    cur = null;
  };

  for (const line of lines) {
    const trimmed = line.trim();

    // Skip chrome: header block chars, tips, version notifications, spinner lines
    if (/^[▜▝▘▌█▛▞▚░▒▓▐]+/.test(trimmed)) continue;
    if (/^[·✢✳✶✻✽●]+/.test(trimmed)) continue;
    // Claude TUI chrome: tips, version, status, spinner words
    if (/^Tip:/i.test(trimmed)) continue;
    if (/^Claude\s*Code\s*has/i.test(trimmed)) continue;
    if (/^\(thinking\b/.test(trimmed)) continue;
    if (/^control\+v/i.test(trimmed)) continue;
    // Generic spinner: single capitalized word ending with … (Flambéing…, Channelling…, etc.)
    if (/^[A-Z][a-zéè]+…/.test(trimmed)) continue;
    // Skip spinner fragments: very short lines (≤4 chars) that aren't meaningful markers
    if (trimmed.length <= 4 && !/^[❯⏺⎿>]/.test(trimmed)) continue;
    // Skip garbled TUI chrome (no spaces = cursor-addressed concatenation)
    if (trimmed.length > 10 && !trimmed.includes(' ') && /[a-z]{3,}[A-Z]/.test(trimmed)) continue;
    // Skip garbled TUI text containing "steer" or "real-time" (mangled tip)
    if (/steer\w*Claude|real-time/i.test(trimmed) && !trimmed.startsWith('❯')) continue;
    if (!trimmed) { if (cur) cur.content += '\n'; continue; }

    // User prompt: ❯
    if (trimmed.startsWith('❯')) {
      flush();
      const text = trimmed.slice(1).trim();
      if (text) { segments.push({ type: 'user', content: text }); }
      continue;
    }

    // Tool call: ⏺ + known tool name
    const toolMatch = trimmed.match(PTY_TOOL_RE);
    if (toolMatch) {
      flush();
      const after = trimmed.slice(trimmed.indexOf(toolMatch[1]) + toolMatch[1].length).replace(/^\s*\(?/, '').replace(/\)?\s*$/, '');
      cur = { type: 'tool', name: toolMatch[1], content: after };
      continue;
    }

    // Claude text: ⏺ + non-tool text
    if (trimmed.startsWith('⏺')) {
      flush();
      cur = { type: 'text', content: trimmed.slice(1).trim() };
      continue;
    }

    // ⎿ continuation — append to current segment
    if (trimmed.startsWith('⎿')) {
      const inner = trimmed.slice(1).trim();
      if (cur) { cur.content += '\n' + inner; }
      continue;
    }

    // Indented line — belongs to current block
    if (cur && (line.startsWith(' ') || line.startsWith('\t'))) {
      cur.content += '\n' + line;
      continue;
    }

    // Standalone line — start new text segment
    flush();
    cur = { type: 'text', content: trimmed };
  }
  flush();

  // Post-process: strip TUI chrome lines from within segment content
  const TUI_CHROME_RE = /^\s*(Tip:|Claude\s*Code\s*has|control\+v|\(thinking\s+with|[A-Z][a-zéè]+…)/;
  for (const seg of segments) {
    if (seg.type === 'text') {
      seg.content = seg.content.split('\n').filter(l => !TUI_CHROME_RE.test(l.trim())).join('\n').trim();
    }
  }
  return segments.filter(s => s.content.trim());
}

// Module-level constant — avoids array allocation on every render
const IDLE_WORDS =['thinking...', 'pondering...', 'wondering...', 'reasoning...', 'considering...', 'analyzing...', 'processing...'];

// ─── Theme ───
type Theme = 'dark' | 'light' | 'sunny' | 'brutalist' | 'onyx' | 'clay' | 'terminal' | 'noir' | 'stone' | 'rust';
const THEME_META: Record<Theme, string> = { dark: '#0a0a0a', light: '#f5f0eb', sunny: '#f4ede1', brutalist: '#e8e4e0', onyx: '#28241e', clay: '#d8d0c8', terminal: '#000000', noir: '#0a0a0a', stone: '#c8c0b4', rust: '#120e0a' };
function getTheme(): Theme { const t = localStorage.getItem('morph-theme'); return (t && t in THEME_META) ? t as Theme : 'dark'; }
function setThemeGlobal(t: Theme) {
  localStorage.setItem('morph-theme', t);
  document.documentElement.setAttribute('data-theme', t);
  const meta = document.getElementById('meta-theme-color') as HTMLMetaElement | null;
  if (meta) meta.content = THEME_META[t];
  // Notify canvas iframe
  document.querySelectorAll('iframe').forEach(f => {
    try { f.contentWindow?.postMessage({ action: 'theme.set', theme: t }, '*'); } catch {}
  });
}

// ─── Remote debug logger — sends to relay /v2/debug/log, read via /v2/debug/logs ───
const _dbgQueue: string[] = [];
let _dbgTimer: ReturnType<typeof setTimeout> | null = null;
function dbg(msg: string) {
  if (localStorage.getItem('morph-debug-enabled') !== 'true') return; // skip entirely when disabled
  const ts = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 } as any);
  _dbgQueue.push(`${ts} ${msg}`);
  // Lazy flush: only schedule when there's data, no polling when idle
  if (!_dbgTimer) {
    _dbgTimer = setTimeout(() => {
      _dbgTimer = null;
      if (_dbgQueue.length === 0) return;
      const batch = _dbgQueue.splice(0);
      const relay = localStorage.getItem('morph-relay-url') || '';
      const token = localStorage.getItem('morph-auth') || '';
      fetch(`${relay}/v2/debug/log`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
        body: JSON.stringify({ lines: batch }),
      }).catch(() => {});
    }, 2000);
  }
}

// ─── Shared send flow: attachments + fire-and-forget upload ───
function useSendFlow(sendFn: (msg: string) => void, relayConfig?: { relayUrl?: string; relayToken?: string }) {
  const [pendingSketch, setPendingSketch] = useState<{ dataUrl: string; bounds: { x: number; y: number; w: number; h: number } } | null>(null);
  const [pendingFile, setPendingFile] = useState<{ path: string; isImage: boolean } | null>(null);
  const [attachMenu, setAttachMenu] = useState(false);
  const [sketchOpen, setSketchOpen] = useState(false);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [isUploading, setIsUploading] = useState(false);

  // Refs so async handlers always use current relay config without stale closure
  const relayUrlRef = useRef(relayConfig?.relayUrl);
  const relayTokenRef = useRef(relayConfig?.relayToken);
  relayUrlRef.current = relayConfig?.relayUrl;
  relayTokenRef.current = relayConfig?.relayToken;

  const handleSend = useCallback((text: string) => {
    // Pass /clear through to sendFn — session onSend handles it; main handleSend catches it before reaching here
    const sketch = pendingSketch;
    const file = pendingFile;
    setPendingSketch(null);
    setPendingFile(null);

    if (text === '/clear') { sendFn(text); return; }

    (async () => {
      let prefix = '';
      if (sketch) {
        const b64 = sketch.dataUrl.split(',')[1];
        const { x, y, w, h } = sketch.bounds;
        try {
          const token = relayTokenRef.current || localStorage.getItem('morph-auth') || '';
          const base = relayUrlRef.current || '';
          const res = await fetch(`${base}/v2/claude/upload`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename: `sketch-${Date.now()}.png`, base64: b64, mime: 'image/png' }),
          });
          const data = await res.json();
          if (data.path) prefix += `[Sketch annotation at screen position: x=${Math.round(x)}%, y=${Math.round(y)}%, w=${Math.round(w)}%, h=${Math.round(h)}%]\nImage: ${data.path}\n`;
        } catch {}
      }
      if (file) {
        prefix += file.isImage ? `Look at this image: ${file.path}\n` : `Read this file: ${file.path}\n`;
      }
      sendFn(prefix ? (prefix + (text ? `\n${text}` : '')).trim() : text);
    })();
  }, [sendFn, pendingSketch, pendingFile]);

  // Persistent hidden file input — created once on mount, never re-created.
  // iOS PWA is unreliable with dynamically-created inputs; a persistent DOM element is required.
  const photoInputRef = useRef<HTMLInputElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const setPendingFileRef = useRef(setPendingFile);
  setPendingFileRef.current = setPendingFile;
  const setUploadErrorRef = useRef(setUploadError);
  setUploadErrorRef.current = setUploadError;
  const setIsUploadingRef = useRef(setIsUploading);
  setIsUploadingRef.current = setIsUploading;

  useEffect(() => {
    const makeInput = (accept: string) => {
      const input = document.createElement('input');
      input.type = 'file';
      input.accept = accept;
      input.style.cssText = 'position:fixed;top:-9999px;left:-9999px;width:1px;height:1px;opacity:0';
      document.body.appendChild(input);
      return input;
    };

    const photoInput = makeInput('image/*');
    const fileInput = makeInput('.pdf,.md,.txt,.csv,.json,.py,.js,.ts,.jsx,.tsx');
    photoInputRef.current = photoInput;
    fileInputRef.current = fileInput;

    const handleChange = (input: HTMLInputElement) => async () => {
      const f = input.files?.[0];
      input.value = ''; // reset so same file can be re-selected
      if (!f) return;
      setIsUploadingRef.current(true);
      const b64: string = await new Promise(r => {
        const rd = new FileReader();
        rd.onload = () => r((rd.result as string).split(',')[1]);
        rd.readAsDataURL(f);
      });
      try {
        const token = relayTokenRef.current || localStorage.getItem('morph-auth') || '';
        const base = relayUrlRef.current || '';
        const res = await fetch(`${base}/v2/claude/upload`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: f.name, base64: b64, mime: f.type }),
        });
        if (!res.ok) {
          const errText = await res.text().catch(() => '');
          const msg = errText ? errText.slice(0, 100) : `HTTP ${res.status}`;
          console.error('[upload]', res.status, msg);
          setUploadErrorRef.current(msg);
          return;
        }
        const data = await res.json();
        if (data.path) {
          setPendingFileRef.current({ path: data.path, isImage: f.type.startsWith('image/') });
        } else {
          const msg = data.error || 'no path returned';
          console.error('[upload] no path:', msg);
          setUploadErrorRef.current(msg);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[upload]', msg);
        setUploadErrorRef.current(msg);
      } finally {
        setIsUploadingRef.current(false);
      }
    };

    const photoHandler = handleChange(photoInput);
    const fileHandler = handleChange(fileInput);
    photoInput.addEventListener('change', photoHandler);
    fileInput.addEventListener('change', fileHandler);
    return () => {
      photoInput.removeEventListener('change', photoHandler);
      fileInput.removeEventListener('change', fileHandler);
      document.body.removeChild(photoInput);
      document.body.removeChild(fileInput);
    };
  }, []);

  const uploadFile = useCallback((accept: string) => {
    // Use pre-configured inputs — no accept mutation at click time (eliminates iOS delay)
    const input = accept === 'image/*' ? photoInputRef.current : fileInputRef.current;
    if (!input) return;
    input.click(); // click synchronously in user gesture — MUST be before any state update
    setAttachMenu(false);
  }, []);

  const handleSketchInsert = useCallback((dataUrl: string, bounds: { x: number; y: number; w: number; h: number }) => {
    setSketchOpen(false);
    setPendingSketch({ dataUrl, bounds });
  }, []);

  const clearPending = useCallback(() => { setPendingSketch(null); setPendingFile(null); }, []);
  const toggleAttach = useCallback(() => setAttachMenu(v => !v), []);

  return {
    pendingSketch, pendingFile, attachMenu, sketchOpen,
    setSketchOpen, setAttachMenu,
    handleSend, uploadFile, handleSketchInsert, clearPending, toggleAttach,
    uploadError, clearUploadError: () => setUploadError(null), isUploading,
  };
}

// ─── Password Gate ───
const PASS_KEY = 'morph-auth';

function PasswordGate({ onAuth }: { onAuth: () => void }) {
  const [pass, setPass] = useState('');
  const [error, setError] = useState('');
  const handleSubmit = async () => {
    try {
      const res = await fetch('/v2/claude/active', { headers: { 'Authorization': `Bearer ${pass}` } });
      if (res.ok) { localStorage.setItem(PASS_KEY, pass); onAuth(); }
      else setError('Wrong password');
    } catch { setError('Connection failed'); }
  };
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', height: '100%', gap: 16, padding: 20 }}>
      <div style={{ color: 'var(--text-primary)', fontSize: 48, fontFamily: "'CloisterBlack', serif", opacity: 0.8 }}>M</div>
      <div style={{ color: 'var(--text-secondary)', fontSize: 14, marginTop: -8 }}>Morph</div>
      <input type="password" value={pass}
        onChange={e => { setPass(e.target.value); setError(''); }}
        onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }}
        placeholder="Password"
        style={{ width: '100%', maxWidth: 300, padding: '12px 16px', borderRadius: 12, border: '1px solid var(--border-input)', backgroundColor: 'var(--bg-card)', color: 'var(--text-primary)', fontSize: 16, outline: 'none', textAlign: 'center' }}
      />
      {error && <div style={{ color: 'var(--danger)', fontSize: 14 }}>{error}</div>}
      <button onClick={handleSubmit} style={{ padding: '10px 32px', borderRadius: 12, border: 'none', backgroundColor: 'var(--bg-input)', color: 'var(--text-primary)', fontSize: 16, cursor: 'pointer' }}>Enter</button>
    </div>
  );
}

// ─── Collapsible Block ───
function Collapsible({ label, preview, content, color }: { label: string; preview?: string; content: string; color: string }) {
  const [open, setOpen] = useState(false);
  const touchY = useRef<number | null>(null);
  const toggle = () => setOpen(o => !o);
  return (
    <div style={{ marginBottom: 2, overflow: 'hidden', maxWidth: '100%' }}>
      <div style={{ color, fontSize: 13, fontFamily: 'Menlo, monospace', lineHeight: '20px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'none', WebkitUserSelect: 'none' as any, padding: '0 12px' }}>
        <span
          onTouchStart={(e) => { touchY.current = e.touches[0].clientY; }}
          onTouchEnd={(e) => { e.preventDefault(); if (touchY.current !== null && Math.abs((e.changedTouches[0]?.clientY ?? touchY.current) - touchY.current) < 10) toggle(); touchY.current = null; }}
          onPointerDown={(e) => { if (e.pointerType === 'mouse') { e.preventDefault(); toggle(); } }}
          style={{ cursor: 'pointer', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' as any, padding: '8px 16px 8px 0', margin: '-8px -16px -8px 0', display: 'inline-block' }}
        >{open ? '▾' : '▸'} {label}</span>{!open && preview ? `: ${preview}` : ''}
      </div>
      {open && <pre style={{ color, opacity: 0.7, fontSize: 13, fontFamily: 'Menlo, monospace', lineHeight: '16px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', overflow: 'hidden', maxWidth: '100%', margin: 0, padding: '0 12px 0 28px', userSelect: 'none', WebkitUserSelect: 'none' as any }}>{
        content.split('\n').map((line, i, arr) => (
          <React.Fragment key={i}><span data-sel style={{ userSelect: 'text', WebkitUserSelect: 'text' } as any}>{renderInlineMd(line)}</span>{i < arr.length - 1 && '\n'}</React.Fragment>
        ))
      }</pre>}
    </div>
  );
}

// ─── Inline Markdown ───
// Renders **bold**, *italic*, `code`, ~~strike~~ as React elements. No block-level markdown.
function renderInlineMd(text: string): React.ReactNode {
  // Split by inline patterns, preserving delimiters
  const parts: React.ReactNode[] = [];
  // Regex: **bold** | *italic* | `code` | ~~strike~~
  const re = /(\*\*(.+?)\*\*|\*(.+?)\*|`([^`]+)`|~~(.+?)~~)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let key = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    if (m[2] != null) parts.push(<strong key={key++}>{m[2]}</strong>);
    else if (m[3] != null) parts.push(<em key={key++}>{m[3]}</em>);
    else if (m[4] != null) parts.push(<code key={key++} style={{ background: 'rgba(255,255,255,0.08)', borderRadius: 3, padding: '1px 4px', fontSize: '0.9em' }}>{m[4]}</code>);
    else if (m[5] != null) parts.push(<s key={key++}>{m[5]}</s>);
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts.length === 1 && typeof parts[0] === 'string' ? parts[0] : <>{parts}</>;
}

// ─── Message Row ───
const MessageRow = React.memo(function MessageRow({ msg }: { msg: Message }) {
  // Outer div is non-selectable block; only inner <span> is selectable.
  // Prevents iOS from selecting entire block when touch lands on left padding.
  const monoOuter = { fontFamily: 'Menlo, monospace', fontSize: 14, lineHeight: '20px', overflow: 'hidden' as const, maxWidth: '100%', userSelect: 'none' as const, WebkitUserSelect: 'none' as any } as const;
  const sel = { userSelect: 'text' as const, WebkitUserSelect: 'text' as any, display: 'block' as const, padding: '0 12px' } as const;
  switch (msg.type) {
    case 'text':
      return msg.role === 'user'
        ? <div style={{ ...monoOuter, color: 'var(--success)', marginBottom: 3, opacity: msg.pending ? 0.5 : 1 }}><span style={sel} data-sel>&gt; {msg.content}</span></div>
        : <div style={{ ...monoOuter, color: 'var(--text-primary)', marginBottom: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{
            msg.content.split('\n').map((line, i) => (
              <React.Fragment key={i}>
                {line === ''
                  ? <div style={{ height: '10px', userSelect: 'none', WebkitUserSelect: 'none' } as any} />
                  : <span style={sel} data-sel>{renderInlineMd(line)}</span>
                }
              </React.Fragment>
            ))
          }</div>;
    case 'pty': {
      const cleaned = stripTermEscapesForRender(msg.content);
      const segments = parsePtySegments(cleaned);
      if (segments.length === 0) return null;
      return <>{segments.map((seg, i) => {
        switch (seg.type) {
          case 'user':
            return <div key={i} style={{ ...monoOuter, color: 'var(--success)', marginBottom: 3 }}>
              <span style={sel} data-sel>&gt; {seg.content}</span>
            </div>;
          case 'tool':
            return <Collapsible key={i} label={seg.name || 'tool'} preview={seg.content.slice(0, 80).replace(/\n/g, ' ')} content={seg.content} color="var(--text-tertiary)" />;
          case 'text':
            return <div key={i} style={{ ...monoOuter, color: 'var(--text-primary)', marginBottom: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{
              seg.content.split('\n').map((line, j) => (
                <React.Fragment key={j}>
                  {line.trim() === '' ? <div style={{ height: '10px' }} /> : <span style={sel} data-sel>{renderInlineMd(line)}</span>}
                </React.Fragment>
              ))
            }</div>;
          default: return null;
        }
      })}</>;
    }
    case 'thinking':
      return <Collapsible label="thinking" preview={msg.content.slice(0, 60)} content={msg.content} color="var(--text-tertiary)" />;
    case 'tool':
      return <Collapsible label={msg.name || 'tool'} preview={msg.content.slice(0, 80).replace(/\n/g, ' ')} content={msg.content} color="var(--text-tertiary)" />;
    case 'tool_result':
      return <Collapsible label="result" preview={msg.content.slice(0, 80).replace(/\n/g, ' ')} content={msg.content.length > 2000 ? msg.content.slice(0, 2000) + '\n...' : msg.content} color="var(--text-tertiary)" />;
    case 'status':
      return msg.content.length > 120
        ? <Collapsible label="status" preview={msg.content.slice(0, 80).replace(/\n/g, ' ')} content={msg.content} color="var(--text-tertiary)" />
        : <div style={{ ...monoOuter, color: 'var(--text-tertiary)', textAlign: 'center', marginTop: 4, marginBottom: 4 }}><span style={sel} data-sel>{msg.content}</span></div>;
    case 'error':
      return msg.content.length > 120
        ? <Collapsible label="error" preview={msg.content.slice(0, 80).replace(/\n/g, ' ')} content={msg.content} color="var(--danger)" />
        : <div style={{ ...monoOuter, color: 'var(--danger)', marginBottom: 3 }}><span style={sel} data-sel>{msg.content}</span></div>;
    case 'permission' as any:
      return <div style={{ ...monoOuter, color: 'var(--warning)', marginBottom: 3, fontSize: 12 }}>
        <span style={sel} data-sel>{msg.pending !== false ? '-- awaiting approval --' : '-- approved --'}</span>
      </div>;
    default: return null;
  }
});

// ─── Permission Banner — approve/deny tool execution ───
function PermissionBanner({ messages, sessionId }: { messages: Message[]; sessionId: string }) {
  const [handled, setHandled] = useState<Set<string>>(new Set());

  // Find the latest pending permission message that hasn't been handled
  const perm = [...messages].reverse().find(m => m.type === ('permission' as any) && !handled.has(m.id));
  if (!perm) return null;

  let tools: { tool: string; input: any }[] = [];
  try { tools = JSON.parse(perm.content); } catch {}
  const toolName = tools[0]?.tool || 'Tool';
  const preview = tools[0]?.input?.command?.slice(0, 80)
    || tools[0]?.input?.file_path?.split('/').pop()
    || tools[0]?.input?.pattern?.slice(0, 60)
    || '';

  const handleApprove = (e: React.PointerEvent) => {
    e.preventDefault();
    setHandled(prev => new Set(prev).add(perm.id));
    approvePermission(sessionId);
  };
  const handleDeny = (e: React.PointerEvent) => {
    e.preventDefault();
    setHandled(prev => new Set(prev).add(perm.id));
    denyPermission(sessionId);
  };

  return (
    <div style={{
      position: 'absolute', top: 0, left: 0, right: 0, zIndex: 20,
      padding: '12px 14px', display: 'flex', alignItems: 'center', gap: 10,
      backgroundColor: 'var(--bg-elevated)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
      borderBottom: '1px solid rgba(255,180,48,0.3)',
    }}>
      <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
        <div style={{ color: 'var(--warning)', fontSize: 13, fontWeight: 600, fontFamily: 'Menlo, monospace' }}>
          {toolName}
        </div>
        {preview && <div style={{ color: 'var(--text-secondary)', fontSize: 11, fontFamily: 'Menlo, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>
          {preview}
        </div>}
      </div>
      <button onPointerDown={handleDeny} style={{
        padding: '8px 16px', borderRadius: 8, cursor: 'pointer', flexShrink: 0,
        border: '1px solid var(--danger-border)', backgroundColor: 'var(--danger-bg)',
        color: 'var(--danger)', fontSize: 14, fontWeight: 700,
        fontFamily: '-apple-system, system-ui, sans-serif',
        touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent',
      }}>Deny</button>
      <button onPointerDown={handleApprove} style={{
        padding: '8px 20px', borderRadius: 8, cursor: 'pointer', flexShrink: 0,
        border: '1px solid var(--success-border)', backgroundColor: 'var(--success-bg)',
        color: 'var(--success)', fontSize: 14, fontWeight: 700,
        fontFamily: '-apple-system, system-ui, sans-serif',
        touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent',
      }}>Approve</button>
    </div>
  );
}

// ─── Terminal Overlay (toggle-able, sits above input bar) ───
function TerminalOverlay({ messages, visible, sessionId }: { messages: Message[]; visible: boolean; sessionId?: string }) {
  const scrollRef = React.useRef<HTMLDivElement>(null);
  const stickRef = React.useRef(true); // auto-scroll when near bottom

  // Auto-scroll to bottom on new messages (if user hasn't scrolled up)
  React.useEffect(() => {
    const el = scrollRef.current;
    if (el && stickRef.current) {
      el.scrollTop = el.scrollHeight;
    }
  }, [messages.length]);

  // iOS Safari: when selection handle escapes a [data-sel] span into a parent
  // non-selectable div, clear the runaway selection immediately.
  React.useEffect(() => {
    let clearing = false;
    function guard() {
      if (clearing) return;
      const sel = document.getSelection();
      if (!sel || sel.rangeCount === 0 || sel.isCollapsed) return;
      const r = sel.getRangeAt(0);
      const sEl = r.startContainer.nodeType === Node.TEXT_NODE ? (r.startContainer as Text).parentElement : r.startContainer as Element;
      const eEl = r.endContainer.nodeType === Node.TEXT_NODE ? (r.endContainer as Text).parentElement : r.endContainer as Element;
      const sIn = sEl?.closest?.('[data-sel]');
      const eIn = eEl?.closest?.('[data-sel]');
      // Only act when anchor escaped span but is still inside terminal container
      const container = scrollRef.current;
      if ((!sIn || !eIn) && container && container.contains(r.startContainer)) {
        dbg(`SEL-GUARD: escaped → clear (startSel=${!!sIn} endSel=${!!eIn} len=${sel.toString().length})`);
        clearing = true;
        sel.removeAllRanges();
        setTimeout(() => { clearing = false; }, 50);
      }
    }
    document.addEventListener('selectionchange', guard);
    return () => document.removeEventListener('selectionchange', guard);
  }, []);

  const onScroll = React.useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    // Stick if within 60px of bottom
    stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  }, []);

  if (!visible) return null;
  return (
    <div ref={scrollRef} onScroll={onScroll} style={{
      flex: '1 1 0', minHeight: 0, overflowY: 'scroll', overflowX: 'hidden',
      display: 'flex', flexDirection: 'column',
      borderTop: '1px solid var(--border)', backgroundColor: 'var(--bg-secondary)',
      WebkitOverflowScrolling: 'touch' as any,
      userSelect: 'none', WebkitUserSelect: 'none' as any,
      WebkitTouchCallout: 'none' as any,
      WebkitTapHighlightColor: 'transparent',
    }}>
      {/* Spacer pushes content to bottom when messages don't fill the container */}
      <div style={{ flex: '1 1 0' }} />
      <div style={{ padding: '8px 0' }}>
        {messages.length === 0
          ? (sessionId && isTTYId(sessionId)
            ? <div style={{ color: 'var(--text-tertiary)', fontSize: 12, textAlign: 'center', padding: 16, fontFamily: 'Menlo, monospace', opacity: 0.6 }}>{parseTTYId(sessionId)}</div>
            : <div style={{ color: 'var(--text-tertiary)', fontSize: 13, textAlign: 'center', padding: 16, fontFamily: 'Menlo, monospace' }}>waiting for session...</div>)
          : messages.map(msg => <MessageRow key={msg.id} msg={msg} />)
        }
      </div>
    </div>
  );
}

// ─── Input Bar (matches native: dot + attach + terminal toggle + input + send/stop) ───
function InputBar({ onSend, onStop, isProcessing, connected, terminalVisible, onToggleTerminal, hasNew, onAttach, onSketch, pendingSketch, pendingFile, onClearPending, tint, keyboardOpen, isUploading, storageKey }: {
  onSend: (text: string) => void; onStop: () => void; isProcessing: boolean; connected: boolean;
  terminalVisible?: boolean; onToggleTerminal?: () => void; hasNew?: boolean;
  onAttach: () => void;
  onSketch: () => void;
  pendingSketch: string | null;
  pendingFile: 'image' | 'file' | null;
  onClearPending: () => void;
  tint?: 'amber'; // session terminal color
  keyboardOpen?: boolean;
  isUploading?: boolean;
  storageKey?: string; // localStorage key to persist draft text across refresh
}) {
  const [text, setText] = useState(() => (storageKey ? localStorage.getItem(storageKey) || '' : ''));
  const ref = useRef<HTMLTextAreaElement>(null);

  // Persist draft to localStorage on change
  useEffect(() => {
    if (!storageKey) return;
    if (text) localStorage.setItem(storageKey, text);
    else localStorage.removeItem(storageKey);
  }, [text, storageKey]);

  const canSend = !!(text.trim() || pendingSketch || pendingFile);
  const handleSend = useCallback(() => {
    const t = text.trim();
    if (!t && !pendingSketch && !pendingFile) return;
    onSend(t || '');
    setText('');
    if (storageKey) localStorage.removeItem(storageKey);
    if (ref.current) ref.current.style.height = '36px';
  }, [text, onSend, pendingSketch, pendingFile, storageKey]);

  const isSession = tint === 'amber';
  const accent = isSession ? 'var(--warning)' : 'var(--success)';
  const dotColor = connected ? 'var(--success)' : 'var(--text-tertiary)';
  const inputBg = 'var(--bg-card)';
  const sendBg = isSession ? 'var(--warning)' : 'var(--bg-input)';
  const borderTint = isSession ? 'var(--border-strong)' : 'var(--border-strong)';

  return (
    <div style={{ borderTop: `1px solid ${borderTint}`, padding: keyboardOpen ? '8px 10px 2px' : '6px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
      {/* Connection dot */}
      <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor, flexShrink: 0 }} />

      {/* Terminal toggle — only on main bar */}
      {onToggleTerminal && (
        <button tabIndex={-1} onClick={onToggleTerminal} style={{
          width: 34, height: 34, borderRadius: 17, border: 'none', cursor: 'pointer', flexShrink: 0,
          backgroundColor: 'var(--bg-input)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            width: 0, height: 0,
            borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
            ...(terminalVisible
              ? { borderTop: `10px solid ${isProcessing ? accent : hasNew ? 'var(--text-secondary)' : 'var(--text-tertiary)'}` }
              : { borderBottom: `10px solid ${isProcessing ? accent : hasNew ? 'var(--text-secondary)' : 'var(--text-tertiary)'}` }),
          }} />
        </button>
      )}

      {/* Attach menu button — tap when pending = clear, otherwise open menu */}
      <motion.button tabIndex={-1} onClick={(pendingSketch || pendingFile) ? onClearPending : onAttach}
        whileTap={{ scale: 1.3 }}
        animate={isUploading ? { opacity: [0.35, 1, 0.35] } : {}}
        transition={isUploading ? { repeat: Infinity, duration: 0.75, ease: 'easeInOut' } : { type: 'spring', stiffness: 500, damping: 20 }}
        style={{
          width: 34, height: 34, borderRadius: 17, border: 'none', cursor: 'pointer', flexShrink: 0,
          backgroundColor: (pendingSketch || pendingFile) ? 'var(--success-bg)' : isUploading ? 'var(--success-bg)' : 'var(--bg-input)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
        {isUploading
          ? <span style={{ color: 'var(--success)', fontSize: 16, lineHeight: '16px' }}>↑</span>
          : pendingSketch
            ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
            : pendingFile === 'image'
              ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
              : pendingFile === 'file'
                ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--success)" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                : <span style={{ color: 'var(--text-secondary)', fontSize: 22, lineHeight: '22px' }}>+</span>}
      </motion.button>

      {/* Text input — textarea with auto-grow, Enter=send, Shift+Enter=newline */}
      <textarea ref={ref} value={text}
        onChange={e => {
          setText(e.target.value);
          const el = e.target;
          el.style.height = '36px';
          el.style.height = Math.min(el.scrollHeight, 120) + 'px';
        }}
        onKeyDown={e => {
          if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); handleSend(); }
        }}
        placeholder={isSession ? "Message this session..." : "Message Claude Code..."}
        rows={1}
        enterKeyHint="send"
        autoComplete="off"
        style={{
          flex: 1, minHeight: 36, maxHeight: 120, resize: 'none',
          borderRadius: 18, border: isSession ? `1px solid ${borderTint}` : 'none', outline: 'none',
          padding: '8px 16px', fontSize: 16, lineHeight: '20px',
          fontFamily: '-apple-system, system-ui, sans-serif', backgroundColor: inputBg, color: 'var(--text-primary)',
          WebkitAppearance: 'none' as any,
        }}
      />

      {/* Send button */}
      <button tabIndex={-1}
        onPointerDown={(e) => { e.preventDefault(); if (canSend) handleSend(); }}
        style={{
          width: 36, height: 36, borderRadius: 18, border: 'none', flexShrink: 0,
          backgroundColor: canSend ? sendBg : inputBg, cursor: canSend ? 'pointer' : 'default',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' as any,
        }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={canSend ? 'var(--text-primary)' : 'var(--text-tertiary)'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
    </div>
  );
}

// ─── Session Cards (Canvas overlay) ───
const FIXED_SESSION_ID = 'a0a0a0a0-0e00-4000-a000-000000000002';
const VIEWED_KEY = 'morph-viewed-sessions';
const VIEWED_TS_KEY = 'morph-viewed-ts'; // Map<sessionId, lastViewedTimestamp>

function getViewed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(VIEWED_KEY) || '[]')); } catch { return new Set(); }
}
function getViewedTs(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(VIEWED_TS_KEY) || '{}'); } catch { return {}; }
}
function markViewed(id: string) {
  const s = getViewed(); s.add(id); localStorage.setItem(VIEWED_KEY, JSON.stringify([...s]));
  const ts = getViewedTs(); ts[id] = Date.now(); localStorage.setItem(VIEWED_TS_KEY, JSON.stringify(ts));
}
function hasUnread(s: any): boolean {
  const ts = getViewedTs();
  const lastViewed = ts[s.id] || 0;
  // If never viewed → unread. If viewed but session updated after → unread.
  if (!lastViewed) return true;
  return (s.updatedAt || 0) > lastViewed;
}

// ─── Multi-environment session system ───
// Pin persistence (per-environment)
function getPinned(envId: string): Set<string> { try { return new Set(JSON.parse(localStorage.getItem(`morph-pinned-${envId}`) || '[]')); } catch { return new Set(); } }
function togglePin(envId: string, id: string) { const p = getPinned(envId); if (p.has(id)) p.delete(id); else p.add(id); localStorage.setItem(`morph-pinned-${envId}`, JSON.stringify([...p])); return p; }

// Environment config — stored in localStorage, add more via Config tab
type EnvConfig = { id: string; label: string; relayUrl: string; token?: string; maxSessions: number };
const DEFAULT_ENV: EnvConfig = { id: 'workspace', label: '/workspace', relayUrl: '', maxSessions: 4 };
function getEnvironments(): EnvConfig[] {
  try { const stored = JSON.parse(localStorage.getItem('morph-environments') || 'null'); return stored || [DEFAULT_ENV]; }
  catch { return [DEFAULT_ENV]; }
}
function saveEnvironments(envs: EnvConfig[]) { localStorage.setItem('morph-environments', JSON.stringify(envs)); }

const timeAgo = (ms: number) => {
  const diff = Date.now() - ms;
  if (diff < 60000) return 'now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
  return `${Math.floor(diff / 86400000)}d`;
};

// Module-level session list cache per environment (30 s TTL) — avoids redundant fetches on every mount
const envSessionsCache = new Map<string, { data: any; ts: number }>();
const STALE_TTL = 30_000;  // fresh — skip fetch entirely
const MAX_TTL = 300_000;   // stale-while-revalidate window (5 min)

// Global visibility-resume counter — bumped when app returns to foreground
let _visResumeCount = 0;
if (typeof document !== 'undefined') {
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') _visResumeCount++;
  });
}

// Kill confirmation modal — red warning style
function KillConfirmModal({ sessionLabel, onConfirm, onCancel }: { sessionLabel: string; onConfirm: () => void; onCancel: () => void }) {
  return createPortal(
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        transition={{ duration: 0.18 }}
        onClick={onCancel}
        style={{ position: 'fixed', inset: 0, zIndex: 99999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 40, backgroundColor: 'var(--bg-overlay)', WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)' }}
      >
        <motion.div
          initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }}
          transition={{ type: 'spring', damping: 28, stiffness: 350 }}
          onClick={(e) => e.stopPropagation()}
          style={{ width: 'calc(100% - 32px)', maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 8 }}
        >
          <div style={{ backgroundColor: 'var(--bg-elevated)', borderRadius: 14, overflow: 'hidden' }}>
            <div style={{ padding: '18px 16px 14px', textAlign: 'center' }}>
              <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                Kill <span style={{ color: 'var(--text-primary)', fontFamily: 'Menlo, monospace', fontSize: 12 }}>{sessionLabel}</span> ?
              </div>
            </div>
            <div style={{ borderTop: '1px solid var(--border)' }}>
              <button onClick={onConfirm} style={{ width: '100%', padding: '16px 0', border: 'none', cursor: 'pointer', fontSize: 17, fontWeight: 600, color: 'var(--danger)', backgroundColor: 'transparent', fontFamily: 'inherit' }}>Kill Session</button>
            </div>
          </div>
          <button onClick={onCancel} style={{ width: '100%', padding: '16px 0', border: 'none', cursor: 'pointer', fontSize: 17, fontWeight: 600, color: 'var(--accent)', backgroundColor: 'var(--bg-elevated)', borderRadius: 14, fontFamily: 'inherit' }}>Cancel</button>
        </motion.div>
      </motion.div>
    </AnimatePresence>,
    document.body
  );
}

// Reusable environment group — renders session cards for one environment
function EnvironmentGroup({ env, onSelect, onNewSession, maxVisible, initialExpanded = true }: { env: EnvConfig; onSelect: (sessionId: string, display?: string, relayUrl?: string, relayToken?: string, project?: string, envId?: string) => void; onNewSession?: (envId: string, relayUrl?: string, relayToken?: string) => void; maxVisible?: number; initialExpanded?: boolean }) {
  const [sessions, setSessions] = useState<any[]>([]);
  const [viewed, setViewed] = useState<Set<string>>(getViewed);
  const [pinned, setPinned] = useState<Set<string>>(() => getPinned(env.id));
  const [expanded, setExpanded] = useState(initialExpanded);
  const [visKey, setVisKey] = useState(_visResumeCount);
  const [killTarget, setKillTarget] = useState<any>(null);
  const [newSessionConfirm, setNewSessionConfirm] = useState(false);
  const killedRef = useRef<Set<string>>(null);
  if (!killedRef.current) {
    try { killedRef.current = new Set(JSON.parse(localStorage.getItem('morph-killed') || '[]')); } catch { killedRef.current = new Set(); }
  }
  const limit = maxVisible ?? env.maxSessions;

  // Listen for visibility resume to trigger refetch
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') setVisKey(_visResumeCount); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  useEffect(() => {
    if (!expanded) return; // skip fetch while collapsed — will run on first expand
    const base = env.relayUrl || '';
    const token = env.token || localStorage.getItem('morph-auth') || '';
    const cacheKey = `${env.id}:${env.relayUrl}:${limit}`;
    const applyRaw = (d: any) => {
      const all = d.sessions || [];
      const pins = getPinned(env.id);
      const killed = killedRef.current!;
      const filtered = all.filter((s: any) => s.id !== FIXED_SESSION_ID && !killed.has(s.id));
      const pinnedSessions = filtered.filter((s: any) => pins.has(s.id));
      const unpinned = filtered.filter((s: any) => !pins.has(s.id)).slice(0, limit - pinnedSessions.length);
      setSessions([...pinnedSessions, ...unpinned]);
    };
    const cached = envSessionsCache.get(cacheKey);
    const age = cached ? Date.now() - cached.ts : Infinity;
    // Fresh cache — use directly, no fetch
    if (cached && age < STALE_TTL) {
      applyRaw(cached.data);
      return;
    }
    // Stale cache — show immediately, then revalidate in background
    if (cached && age < MAX_TTL) {
      applyRaw(cached.data);
    }
    // Fetch (either revalidate or cold)
    fetch(`${base}/v2/claude/sessions?limit=${env.maxSessions || 30}`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        envSessionsCache.set(cacheKey, { data: d, ts: Date.now() });
        applyRaw(d);
      })
      .catch(() => {});  // on error, keep showing stale data
  }, [env.id, env.relayUrl, limit, expanded, visKey]);

  const dotColor = (s: any) => {
    if (hasUnread(s)) return 'var(--warning)';
    return 'var(--text-tertiary)';
  };
  const borderColor = (s: any) => {
    if (hasUnread(s)) return 'var(--border-strong)';
    return 'var(--bg-input)';
  };

  const handleSelect = (id: string) => {
    markViewed(id);
    setViewed(getViewed());
    const s = sessions.find(x => x.id === id);
    // Map session to its relay so socket.io events are routed correctly
    if (env.id !== 'workspace') registerSession(id, env.id);
    onSelect(id, s?.display, env.relayUrl, env.token, s?.project, env.id);
  };

  // Long-press to kill: 800ms hold → show kill modal. Suppresses tap-to-open after firing.
  const sessionLongPress = (s: any) => {
    let timer: any = null;
    let fired = false;
    const showKill = () => {
      fired = true;
      dbg(`[longpress] fired for ${(s.display || s.id).slice(0, 12)} env=${env.id}`);
      setKillTarget(s);
    };
    return {
      onTouchStart: () => { fired = false; timer = setTimeout(showKill, 800); },
      onTouchEnd: () => { clearTimeout(timer); },
      onTouchMove: () => { clearTimeout(timer); },
      onMouseDown: () => { fired = false; timer = setTimeout(showKill, 800); },
      onMouseUp: () => { clearTimeout(timer); },
      onMouseLeave: () => { clearTimeout(timer); },
      onContextMenu: (e: any) => e.preventDefault(),
      onClick: (e: any) => { if (fired) { e.stopPropagation(); fired = false; } else { handleSelect(s.id); } },
    };
  };

  const confirmKill = () => {
    if (!killTarget) return;
    const sid = killTarget.id;
    dbg(`[kill] confirmed ${(killTarget.display || sid).slice(0, 12)} env=${env.id}`);
    if (env.id !== 'workspace') registerSession(sid, env.id);
    stopSession(sid);
    // Add to killed blacklist — prevents zombie reappearance from heuristic session detection
    killedRef.current!.add(sid);
    try { localStorage.setItem('morph-killed', JSON.stringify([...killedRef.current!])); } catch {}
    // Optimistically remove from UI immediately
    setSessions(prev => prev.filter(s => s.id !== sid));
    const cacheKey = `${env.id}:${env.relayUrl}:${limit}`;
    envSessionsCache.delete(cacheKey);
    setKillTarget(null);
  };

  const unviewedCount = sessions.filter(s => !viewed.has(s.id)).length;

  return (
    <div style={{ marginBottom: 12, pointerEvents: 'none', userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none' }}>
      <div
        onClick={() => setExpanded(v => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: expanded ? 6 : 0, cursor: 'pointer', pointerEvents: 'auto' }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: env.id === 'workspace' ? 'var(--accent)' : 'var(--warning)', flexShrink: 0 }} />
        <span style={{ color: 'var(--text-secondary)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
          {env.label} ({sessions.length})
        </span>
        {unviewedCount > 0 && <span style={{ fontSize: 9, color: 'var(--warning)' }}>{unviewedCount} new</span>}
        <span style={{ color: 'var(--text-secondary)', fontSize: 10 }}>{expanded ? '▾' : '▸'}</span>
        <span
          onClick={(e) => { e.stopPropagation(); setNewSessionConfirm(true); }}
          style={{ marginLeft: 'auto', color: 'var(--text-primary)', fontSize: 20, lineHeight: 1, padding: '6px 10px', margin: '-6px -10px', cursor: 'pointer', userSelect: 'none', pointerEvents: 'auto', WebkitTapHighlightColor: 'transparent' }}
        >+</span>
      </div>
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: 'hidden', pointerEvents: 'auto' }}
          >
            {sessions.length === 0 && (
              <div style={{ color: 'var(--text-tertiary)', fontSize: 12, padding: '8px 4px' }}>No sessions</div>
            )}
            {sessions.map(s => (
              <motion.div
                key={s.id}
                whileTap={{ scale: 0.98 }}
                {...sessionLongPress(s)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '12px 10px', marginBottom: 4,
                  backgroundColor: 'var(--bg-elevated)',
                  borderRadius: 10, cursor: 'pointer',
                  border: `1px solid ${borderColor(s)}`,
                  userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
                }}
              >
                <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotColor(s), flexShrink: 0 }} />
                {pinned.has(s.id) && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 17v5M9 2h6l1 7h2l-1 4H7L6 9h2z"/></svg>}
                <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
                  <div style={{ color: 'var(--text-primary)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                    {s.display || s.id.slice(0, 8)}
                  </div>
                  {s.lastError && <div style={{ color: 'var(--danger)', fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const, marginTop: 2 }}>{s.lastError}</div>}
                </div>
                <span style={{ color: 'var(--text-tertiary)', fontSize: 11, flexShrink: 0 }}>{timeAgo(s.updatedAt)}</span>
                <span onClick={(e) => { e.stopPropagation(); setPinned(togglePin(env.id, s.id)); }} style={{ cursor: 'pointer', padding: '8px 10px', margin: '-8px -10px -8px 0', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill={pinned.has(s.id) ? 'var(--text-secondary)' : 'none'} stroke={pinned.has(s.id) ? 'var(--text-secondary)' : 'var(--text-tertiary)'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>
                </span>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
      {killTarget && <KillConfirmModal sessionLabel={(killTarget.display || killTarget.id).slice(0, 16)} onConfirm={confirmKill} onCancel={() => setKillTarget(null)} />}
      {newSessionConfirm && createPortal(
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => setNewSessionConfirm(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 99999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 40, backgroundColor: 'var(--bg-overlay)', WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)' }}
          >
            <motion.div
              initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }}
              transition={{ type: 'spring', damping: 28, stiffness: 350 }}
              onClick={(e) => e.stopPropagation()}
              style={{ width: 'calc(100% - 32px)', maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <div style={{ backgroundColor: 'var(--bg-elevated)', borderRadius: 14, overflow: 'hidden' }}>
                <div style={{ padding: '18px 16px 14px', textAlign: 'center' }}>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    Create a new session?
                  </div>
                </div>
                <div style={{ borderTop: '1px solid var(--border)' }}>
                  <button onClick={() => { setNewSessionConfirm(false); onNewSession?.(env.id, env.relayUrl, env.token); }} style={{ width: '100%', padding: '16px 0', border: 'none', cursor: 'pointer', fontSize: 17, fontWeight: 600, color: 'var(--accent)', backgroundColor: 'transparent', fontFamily: 'inherit' }}>New Session</button>
                </div>
              </div>
              <button onClick={() => setNewSessionConfirm(false)} style={{ width: '100%', padding: '16px 0', border: 'none', cursor: 'pointer', fontSize: 17, fontWeight: 600, color: 'var(--text-secondary)', backgroundColor: 'var(--bg-elevated)', borderRadius: 14, fontFamily: 'inherit' }}>Cancel</button>
            </motion.div>
          </motion.div>
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}

// ─── Usage Bar Widget (top-right) ───
function UsageWidget() {
  const [usage, setUsage] = useState<{ session: { pct: number; resetsAt: string | null }; weekly: { pct: number; resetsAt: string | null } } | null>(() => {
    try { return JSON.parse(localStorage.getItem('morph-usage-cache') || 'null'); } catch { return null; }
  });
  const [countdown, setCountdown] = useState('');

  useEffect(() => {
    const token = localStorage.getItem('morph-auth') || '';
    const load = () => {
      fetch('/v2/claude/usage', { headers: { 'Authorization': `Bearer ${token}` } })
        .then(r => r.json())
        .then(d => { if (d.session) { setUsage(d); localStorage.setItem('morph-usage-cache', JSON.stringify(d)); } })
        .catch(() => {});
    };
    // Delay first load by 3s to avoid 429 on page reload, then every 5 min
    const t = setTimeout(load, 3000);
    const iv = setInterval(load, 300000);
    return () => { clearTimeout(t); clearInterval(iv); };
  }, []);

  useEffect(() => {
    if (!usage?.session?.resetsAt) return;
    const tick = () => {
      const diff = new Date(usage.session.resetsAt!).getTime() - Date.now();
      if (diff <= 0) { setCountdown('now'); return; }
      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      setCountdown(h > 0 ? `${h}h${m}m` : `${m}m`);
    };
    tick();
    const iv = setInterval(tick, 30000);
    return () => clearInterval(iv);
  }, [usage?.session?.resetsAt]);

  if (!usage) return null;

  const barW = 56;
  const barH = 4;
  const barColor = 'var(--bar-fill)';
  const trackColor = 'var(--bar-track)';

  return (
    <div style={{ position: 'absolute', top: 68, right: 12, zIndex: 3, pointerEvents: 'auto' }}>
      <div style={{
        backgroundColor: 'var(--bg-elevated)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderRadius: 6, padding: '4px 8px', border: '1px solid var(--border)',
      }}>
        {/* Session bar (5h) */}
        <div style={{ marginBottom: 3 }}>
          <div style={{ width: barW, height: barH, borderRadius: 2, backgroundColor: trackColor, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(usage.session.pct, 100)}%`, height: '100%', borderRadius: 2, backgroundColor: barColor, transition: 'width 0.5s' }} />
          </div>
        </div>
        {/* Weekly bar (7d) */}
        <div>
          <div style={{ width: barW, height: barH, borderRadius: 2, backgroundColor: trackColor, overflow: 'hidden' }}>
            <div style={{ width: `${Math.min(usage.weekly.pct, 100)}%`, height: '100%', borderRadius: 2, backgroundColor: barColor, transition: 'width 0.5s' }} />
          </div>
        </div>
        {/* Reset countdown */}
        {countdown && <div style={{ fontSize: 7, color: 'var(--text-tertiary)', textAlign: 'center' as const, marginTop: 2 }}>{countdown}</div>}
      </div>
    </div>
  );
}

// Color palette for project groups — deterministic via hash
const PROJECT_COLORS = ['#636AFF', '#30d158', '#ff9f0a', '#bf5af2', '#ff6482'];
function projectColor(project: string): string {
  let hash = 0;
  for (let i = 0; i < project.length; i++) hash = ((hash << 5) - hash + project.charCodeAt(i)) | 0;
  return PROJECT_COLORS[Math.abs(hash) % PROJECT_COLORS.length];
}
function projectLabel(project: string): string {
  if (!project) return 'Unknown';
  const parts = project.replace(/\/+$/, '').split('/');
  return parts[parts.length - 1] || project;
}

// Strip residual DEC escape fragments from terminal text for display
function cleanTermText(s: string): string {
  // Strip ANSI escape sequences, control chars, and terminal noise
  let t = s
    .replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '')   // CSI sequences
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b[=><%()][^\x1b]*/g, '')     // Other ESC sequences
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '') // Control chars (keep \n \r \t)
    .replace(/\r\n?/g, '\n')
    .replace(/\n{2,}/g, '\n')
    .trim();
  // Take last meaningful line (most recent terminal output)
  const lines = t.split('\n').filter(l => l.trim().length > 2);
  return lines.length > 0 ? lines[lines.length - 1].trim().slice(0, 80) : '';
}

// Spatial grid — mirrors Ghostty pane layout
function SpatialGrid({ layout, onSelect }: { layout: any; onSelect: (id: string, display?: string, textPreview?: string) => void }) {
  if (!layout || !layout.windows || layout.windows.length === 0) return null;

  const handlePaneTap = (p: any) => {
    const selectId = p.tty ? `tty:${p.tty}` : null;
    const label = p.cwd?.split('/').pop() || p.tty || 'terminal';
    // All panes are tappable — routable ones show JSONL, non-routable open shell control
    // (sendToTTY falls back to AppleScript for panes without wrapper)
    if (selectId) onSelect(selectId, label, p.axText || p.textPreview || undefined);
  };

  return (
    <div style={{ padding: '0 4px' }}>
      {layout.windows.map((win: any, wi: number) => {
        const aspect = win.bounds.h / win.bounds.w;
        return (
          <div key={win.id || wi} style={{
            position: 'relative', width: '100%', aspectRatio: `${1 / aspect}`,
            marginBottom: layout.windows.length > 1 ? 12 : 0,
            borderRadius: 10, overflow: 'hidden',
            backgroundColor: 'var(--bg-card)',
            border: '1px solid var(--border)',
          }}>
            {win.panes.map((p: any, pi: number) => {
              const isRoutable = p.routable !== false;
              const hasTTY = !!p.tty;
              const isIdle = p.idle;
              return (
                <div
                  key={p.tty || pi}
                  role={hasTTY ? 'button' : undefined}
                  tabIndex={hasTTY ? 0 : undefined}
                  onClick={() => handlePaneTap(p)}
                  onPointerUp={(e) => { if (e.pointerType === 'touch') { e.preventDefault(); handlePaneTap(p); } }}
                  style={{
                    position: 'absolute',
                    left: `${p.x * 100}%`, top: `${p.y * 100}%`,
                    width: `${p.w * 100}%`, height: `${p.h * 100}%`,
                    boxSizing: 'border-box',
                    padding: 1,
                    touchAction: 'manipulation',
                    WebkitTapHighlightColor: 'transparent',
                    userSelect: 'none',
                    WebkitUserSelect: 'none',
                  } as React.CSSProperties}
                >
                  <div style={{
                    width: '100%', height: '100%',
                    borderRadius: 6,
                    backgroundColor: isRoutable ? 'var(--accent-bg)' : hasTTY ? 'var(--bg-card)' : 'var(--bg-input)',
                    border: `1px solid ${isRoutable ? 'var(--accent)' : hasTTY ? 'var(--text-tertiary)' : 'var(--border)'}`,
                    cursor: hasTTY ? 'pointer' : 'default',
                    opacity: isIdle ? 0.5 : 1,
                    display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'flex-start',
                    overflow: 'hidden', padding: '3px 5px',
                    pointerEvents: 'auto',
                  }}>
                    <span style={{
                      fontFamily: 'Menlo, monospace', fontSize: 9, fontWeight: 600,
                      color: isRoutable ? 'var(--accent)' : hasTTY ? 'var(--text-secondary)' : 'var(--text-tertiary)',
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
                      pointerEvents: 'none',
                    }}>
                      {isRoutable ? (p.tty || p.cwd?.split('/').pop() || 'claude') : p.tty}
                    </span>
                    {p.textPreview && (() => {
                      const cleaned = cleanTermText(p.textPreview);
                      return cleaned ? (
                        <span style={{
                          fontFamily: 'Menlo, monospace', fontSize: 8, lineHeight: '11px',
                          color: 'var(--text-secondary)', opacity: 0.5,
                          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                          pointerEvents: 'none', marginTop: 1, display: 'block',
                        }}>
                          {cleaned}
                        </span>
                      ) : null;
                    })()}
                  </div>
                </div>
              );
            })}
          </div>
        );
      })}
    </div>
  );
}

// Canvas overlay — auto-groups sessions by project
function SessionCards({ onSelect, onNewSession }: { onSelect: (sessionId: string, display?: string, relayUrl?: string, relayToken?: string, project?: string, envId?: string, textPreview?: string) => void; onNewSession?: (envId: string, relayUrl?: string, relayToken?: string) => void }) {
  const [groups, setGroups] = useState<{ project: string; sessions: any[] }[]>([]);
  const [viewed, setViewed] = useState<Set<string>>(getViewed);
  const [pinned, setPinned] = useState<Set<string>>(() => getPinned('workspace'));
  const [expanded, setExpanded] = useState<Record<string, boolean>>({});
  const [visKey, setVisKey] = useState(_visResumeCount);
  const [killTarget, setKillTarget] = useState<any>(null);
  const [newSessionProject, setNewSessionProject] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'grid' | 'list'>(() => (localStorage.getItem('morph-session-view') as any) || 'grid');
  const [layout, setLayout] = useState<any>(null);
  const killedRef = useRef<Set<string>>(null);
  if (!killedRef.current) {
    try { killedRef.current = new Set(JSON.parse(localStorage.getItem('morph-killed') || '[]')); } catch { killedRef.current = new Set(); }
  }

  // Listen for visibility resume
  useEffect(() => {
    const onVis = () => { if (document.visibilityState === 'visible') setVisKey(_visResumeCount); };
    document.addEventListener('visibilitychange', onVis);
    return () => document.removeEventListener('visibilitychange', onVis);
  }, []);

  // Spatial layout — initial fetch + live socket push (replaces 30s polling)
  useEffect(() => {
    const token = localStorage.getItem('morph-auth') || '';
    fetch('/v2/claude/layout', { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => { if (d.windows && d.windows.length > 0) setLayout(d); })
      .catch(() => {});
    const unsub = onLayoutUpdate((d: any) => { if (d.windows && d.windows.length > 0) setLayout(d); });
    return unsub;
  }, [visKey]);

  // Fetch all sessions and group by project
  useEffect(() => {
    const token = localStorage.getItem('morph-auth') || '';
    const cacheKey = 'all-sessions';

    const apply = (d: any) => {
      const all: any[] = d.sessions || [];
      const killed = killedRef.current!;
      const filtered = all.filter((s: any) => s.id !== FIXED_SESSION_ID && !killed.has(s.id));

      // Group by project
      const map = new Map<string, any[]>();
      for (const s of filtered) {
        const proj = s.project || 'unknown';
        if (!map.has(proj)) map.set(proj, []);
        map.get(proj)!.push(s);
      }

      // Sort sessions within each group by updatedAt desc
      const grouped: { project: string; sessions: any[] }[] = [];
      for (const [proj, sess] of map) {
        sess.sort((a: any, b: any) => b.updatedAt - a.updatedAt);
        grouped.push({ project: proj, sessions: sess });
      }
      // Sort groups by most recent session first
      grouped.sort((a, b) => {
        const aMax = a.sessions[0]?.updatedAt || 0;
        const bMax = b.sessions[0]?.updatedAt || 0;
        return bMax - aMax;
      });
      setGroups(grouped);
    };

    const cached = envSessionsCache.get(cacheKey);
    const age = cached ? Date.now() - cached.ts : Infinity;
    if (cached && age < STALE_TTL) { apply(cached.data); return; }
    if (cached && age < MAX_TTL) { apply(cached.data); }

    fetch(`/v2/claude/sessions?limit=50`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        envSessionsCache.set(cacheKey, { data: d, ts: Date.now() });
        apply(d);
      })
      .catch(() => {});
  }, [visKey]);

  const isExpanded = (proj: string, idx: number) => expanded[proj] !== undefined ? expanded[proj] : idx < 3;
  const toggleExpanded = (proj: string) => setExpanded(prev => ({ ...prev, [proj]: !(prev[proj] !== undefined ? prev[proj] : true) }));

  const dotColor = (s: any) => hasUnread(s) ? 'var(--warning)' : 'var(--text-tertiary)';
  const borderColor = (s: any) => hasUnread(s) ? 'var(--border-strong)' : 'var(--bg-input)';

  const handleSelect = (id: string) => {
    markViewed(id);
    setViewed(getViewed());
    // Find which group this session belongs to
    let session: any = null;
    for (const g of groups) {
      session = g.sessions.find(x => x.id === id);
      if (session) break;
    }
    onSelect(id, session?.display, undefined, undefined, session?.project, 'workspace');
  };

  const sessionLongPress = (s: any) => {
    let timer: any = null;
    let fired = false;
    const showKill = () => {
      fired = true;
      dbg(`[longpress] fired for ${(s.display || s.id).slice(0, 12)}`);
      setKillTarget(s);
    };
    return {
      onTouchStart: () => { fired = false; timer = setTimeout(showKill, 800); },
      onTouchEnd: () => { clearTimeout(timer); },
      onTouchMove: () => { clearTimeout(timer); },
      onMouseDown: () => { fired = false; timer = setTimeout(showKill, 800); },
      onMouseUp: () => { clearTimeout(timer); },
      onMouseLeave: () => { clearTimeout(timer); },
      onContextMenu: (e: any) => e.preventDefault(),
      onClick: (e: any) => { if (fired) { e.stopPropagation(); fired = false; } else { handleSelect(s.id); } },
    };
  };

  const confirmKill = () => {
    if (!killTarget) return;
    const sid = killTarget.id;
    dbg(`[kill] confirmed ${(killTarget.display || sid).slice(0, 12)}`);
    stopSession(sid);
    killedRef.current!.add(sid);
    try { localStorage.setItem('morph-killed', JSON.stringify([...killedRef.current!])); } catch {}
    setGroups(prev => prev.map(g => ({ ...g, sessions: g.sessions.filter(s => s.id !== sid) })).filter(g => g.sessions.length > 0));
    envSessionsCache.delete('all-sessions');
    setKillTarget(null);
  };

  const toggleViewMode = () => {
    const next = viewMode === 'grid' ? 'list' : 'grid';
    setViewMode(next);
    localStorage.setItem('morph-session-view', next);
  };

  const handleGridSelect = (ttyId: string, display?: string, textPreview?: string) => {
    markViewed(ttyId);
    setViewed(getViewed());
    // Panel: pure TTY, no session/env/relay fields
    onSelect(ttyId, display, undefined, undefined, undefined, 'workspace', textPreview);
  };

  return (
    <div style={{ position: 'absolute', top: 128, left: 0, right: 0, bottom: 0, zIndex: 2, padding: '0 8px', overflowY: 'auto', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
      {/* Grid/List toggle */}
      {layout && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'flex-end', marginBottom: 8, gap: 6 }}>
          <span style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'Menlo, monospace' }}>
            {viewMode === 'grid' ? 'GRID' : 'LIST'}
          </span>
          <div
            onClick={toggleViewMode}
            style={{
              width: 32, height: 18, borderRadius: 9, cursor: 'pointer', position: 'relative',
              backgroundColor: viewMode === 'grid' ? 'var(--accent)' : 'var(--bg-hover)', transition: 'background-color 0.2s',
            }}
          >
            <div style={{
              position: 'absolute', top: 2, left: viewMode === 'grid' ? 16 : 2, width: 14, height: 14,
              borderRadius: 7, backgroundColor: '#fff', transition: 'left 0.2s',
              boxShadow: '0 1px 2px rgba(0,0,0,0.2)',
            }} />
          </div>
        </div>
      )}
      {/* Spatial grid view */}
      {viewMode === 'grid' && layout && (
        <SpatialGrid layout={layout} onSelect={handleGridSelect} />
      )}
      {/* List view — render layout panes as horizontal rows */}
      {viewMode === 'list' && layout && layout.windows && layout.windows.map((win: any, wi: number) => (
        <div key={win.id || wi} style={{ marginBottom: 8 }}>
          {layout.windows.length > 1 && (
            <div style={{ fontSize: 10, color: 'var(--text-tertiary)', fontFamily: 'Menlo, monospace', marginBottom: 4 }}>
              Window {wi + 1}
            </div>
          )}
          {win.panes.map((p: any, pi: number) => {
            const isRoutable = p.routable !== false;
            const hasTTY = !!p.tty;
            const isIdle = p.idle;
            const cleaned = p.textPreview ? cleanTermText(p.textPreview) : '';
            return (
              <motion.div
                key={p.tty || pi}
                whileTap={{ scale: 0.98 }}
                role={hasTTY ? 'button' : undefined}
                onClick={() => {
                  const selectId = p.tty ? `tty:${p.tty}` : null;
                  const label = p.cwd?.split('/').pop() || p.tty || 'terminal';
                  if (selectId) handleGridSelect(selectId, label, p.axText || p.textPreview || undefined);
                }}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '0 10px', height: 48, marginBottom: 4,
                  backgroundColor: isRoutable ? 'var(--accent-bg)' : 'var(--bg-elevated)',
                  borderRadius: 10, cursor: hasTTY ? 'pointer' : 'default',
                  border: `1px solid ${isRoutable ? 'var(--accent)' : hasTTY ? 'var(--text-tertiary)' : 'var(--border)'}`,
                  opacity: isIdle ? 0.5 : 1,
                  userSelect: 'none', WebkitUserSelect: 'none', WebkitTouchCallout: 'none',
                  pointerEvents: 'auto',
                }}
              >
                <div style={{
                  width: 6, height: 6, borderRadius: 3, flexShrink: 0,
                  backgroundColor: isRoutable ? 'var(--accent)' : hasTTY ? 'var(--text-tertiary)' : 'var(--border)',
                }} />
                <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
                  <div style={{
                    fontFamily: 'Menlo, monospace', fontSize: 12, fontWeight: 600,
                    color: isRoutable ? 'var(--accent)' : 'var(--text-primary)',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
                  }}>
                    {p.title || p.cwd?.split('/').pop() || p.tty || 'terminal'}
                  </div>
                  {cleaned && (
                    <div style={{
                      fontFamily: 'Menlo, monospace', fontSize: 10, lineHeight: '14px',
                      color: 'var(--text-secondary)', opacity: 0.6,
                      overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const,
                      marginTop: 2,
                    }}>
                      {cleaned}
                    </div>
                  )}
                </div>
                <span style={{
                  fontFamily: 'Menlo, monospace', fontSize: 9, color: 'var(--text-tertiary)', flexShrink: 0,
                }}>
                  {p.tty || ''}
                </span>
              </motion.div>
            );
          })}
        </div>
      ))}
      {killTarget && <KillConfirmModal sessionLabel={(killTarget.display || killTarget.id).slice(0, 16)} onConfirm={confirmKill} onCancel={() => setKillTarget(null)} />}
      {newSessionProject !== null && createPortal(
        <AnimatePresence>
          <motion.div
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={() => setNewSessionProject(null)}
            style={{ position: 'fixed', inset: 0, zIndex: 99999, display: 'flex', alignItems: 'flex-end', justifyContent: 'center', paddingBottom: 40, backgroundColor: 'var(--bg-overlay)', WebkitBackdropFilter: 'blur(8px)', backdropFilter: 'blur(8px)' }}
          >
            <motion.div
              initial={{ y: 30, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: 30, opacity: 0 }}
              transition={{ type: 'spring', damping: 28, stiffness: 350 }}
              onClick={(e) => e.stopPropagation()}
              style={{ width: 'calc(100% - 32px)', maxWidth: 320, display: 'flex', flexDirection: 'column', gap: 8 }}
            >
              <div style={{ backgroundColor: 'var(--bg-elevated)', borderRadius: 14, overflow: 'hidden' }}>
                <div style={{ padding: '18px 16px 14px', textAlign: 'center' }}>
                  <div style={{ fontSize: 13, color: 'var(--text-secondary)', lineHeight: 1.5 }}>
                    Create a new session?
                  </div>
                </div>
                <div style={{ borderTop: '1px solid var(--border)' }}>
                  <button onClick={() => { setNewSessionProject(null); onNewSession?.('workspace', undefined, undefined); }} style={{ width: '100%', padding: '16px 0', border: 'none', cursor: 'pointer', fontSize: 17, fontWeight: 600, color: 'var(--accent)', backgroundColor: 'transparent', fontFamily: 'inherit' }}>New Session</button>
                </div>
              </div>
              <button onClick={() => setNewSessionProject(null)} style={{ width: '100%', padding: '16px 0', border: 'none', cursor: 'pointer', fontSize: 17, fontWeight: 600, color: 'var(--text-secondary)', backgroundColor: 'var(--bg-elevated)', borderRadius: 14, fontFamily: 'inherit' }}>Cancel</button>
            </motion.div>
          </motion.div>
        </AnimatePresence>,
        document.body
      )}
    </div>
  );
}

// ─── Toggle Switch ───
function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div onClick={() => onChange(!value)} style={{
      width: 44, height: 26, borderRadius: 13, cursor: 'pointer', position: 'relative',
      backgroundColor: value ? 'var(--accent)' : 'var(--bg-hover)', transition: 'background-color 0.2s',
      flexShrink: 0,
    }}>
      <div style={{
        position: 'absolute', top: 2, left: value ? 20 : 2, width: 22, height: 22,
        borderRadius: 11, backgroundColor: '#fff', transition: 'left 0.2s',
        boxShadow: '0 1px 3px rgba(0,0,0,0.2)',
      }} />
    </div>
  );
}

// ─── Config Tab ───
function ConfigTab({ connState }: { connState: string }) {
  const relayUrl = () => localStorage.getItem('morph-relay-url') || '';
  const token = () => localStorage.getItem('morph-auth') || '';
  const headers = () => ({ 'Authorization': `Bearer ${token()}` });
  const [theme, setTheme] = useState<Theme>(getTheme);

  const [usage, setUsage] = useState<{ messagesToday: string; totalSessions: string; uptime: string }>({ messagesToday: '—', totalSessions: '—', uptime: '—' });
  const [sessions, setSessions] = useState<any[]>([]);
  const [debugEnabled, setDebugEnabled] = useState(() => localStorage.getItem('morph-debug-enabled') === 'true');
  const [debugLogs, setDebugLogs] = useState<string[]>([]);
  const [pushStatus, setPushStatus] = useState<'Enabled' | 'Disabled' | 'Not supported'>(() => {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return 'Not supported';
    return localStorage.getItem('morph-push-enabled') === 'true' ? 'Enabled' : 'Disabled';
  });
  const [pushError, setPushError] = useState('');
  const [wsState, setWsState] = useState('—');

  // Icon picker
  const [iconSrc, setIconSrc] = useState('/icon-512-v4.png');
  const [iconUploading, setIconUploading] = useState(false);
  const iconInputRef = useRef<HTMLInputElement>(null);

  const handleIconUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    setIconUploading(true);
    try {
      const buf = await file.arrayBuffer();
      const base64 = btoa(String.fromCharCode(...new Uint8Array(buf)));
      const res = await fetch(`${relayUrl()}/v2/icon`, {
        method: 'POST',
        headers: { ...headers(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ base64, mime: file.type }),
      });
      const data = await res.json();
      if (data.ok && data.src) {
        setIconSrc(data.src + '?t=' + Date.now());
      }
    } catch {}
    setIconUploading(false);
    if (iconInputRef.current) iconInputRef.current.value = '';
  };

  useEffect(() => {
    fetch(`${relayUrl()}/v2/usage`, { headers: headers() })
      .then(r => r.json())
      .then(d => setUsage({
        messagesToday: String(d.messagesToday ?? '—'),
        totalSessions: String(d.totalSessions ?? '—'),
        uptime: d.uptime ?? '—',
      }))
      .catch(() => {});

    // Fetch current icon
    fetch(`${relayUrl()}/v2/icon`, { headers: headers() })
      .then(r => r.json())
      .then(d => { if (d.src) setIconSrc(d.src + '?t=' + Date.now()); })
      .catch(() => {});

    fetchSessions()
      .then(s => setSessions(s))
      .catch(() => {});

    setWsState(getState() || connState);

    if (debugEnabled) {
      fetch(`${relayUrl()}/v2/debug/logs`, { headers: headers() })
        .then(r => r.json())
        .then(d => setDebugLogs(d.lines || []))
        .catch(() => {});
    }

    // Pre-register service worker so it's ready when user toggles push
    if ('serviceWorker' in navigator) {
      navigator.serviceWorker.register('/sw.js').catch(() => {});
    }
  }, []);

  const handleDebugToggle = (v: boolean) => {
    setDebugEnabled(v);
    localStorage.setItem('morph-debug-enabled', String(v));
    if (v) {
      fetch(`${relayUrl()}/v2/debug/logs`, { headers: headers() })
        .then(r => r.json())
        .then(d => setDebugLogs(d.lines || []))
        .catch(() => {});
    }
  };

  const handleClearLogs = () => {
    setDebugLogs([]);
    fetch(`${relayUrl()}/v2/debug/clear`, { method: 'POST', headers: headers() }).catch(() => {});
  };

  // base64url → Uint8Array (Safari requires proper padding)
  const urlBase64ToUint8Array = (base64String: string) => {
    const padding = '='.repeat((4 - base64String.length % 4) % 4);
    const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
    const raw = atob(base64);
    const arr = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i++) arr[i] = raw.charCodeAt(i);
    return arr;
  };

  const handlePushToggle = async (v: boolean) => {
    if (!('Notification' in window) || !('serviceWorker' in navigator)) return;
    setPushError('');
    const base = relayUrl();
    const auth = token();
    if (v) {
      try {
        // 1. Permission — check existing first, only prompt if 'default'
        let perm = Notification.permission;
        if (perm === 'default') {
          perm = await Notification.requestPermission();
        }
        if (perm === 'denied') { setPushError('Permission denied — enable in Settings'); setPushStatus('Disabled'); return; }
        if (perm !== 'granted') { setPushError('Permission not granted'); setPushStatus('Disabled'); return; }

        // 2. Service worker — use existing or register
        const reg = await navigator.serviceWorker.ready;

        // 3. Push subscription — reuse existing or create new
        let sub = await reg.pushManager.getSubscription();
        if (!sub) {
          const vapidRes = await fetch(`${base}/v2/push/vapid-public`, { headers: { 'Authorization': `Bearer ${auth}` } });
          if (!vapidRes.ok) throw new Error(`VAPID fetch failed: ${vapidRes.status}`);
          const { publicKey } = await vapidRes.json();
          if (!publicKey) throw new Error('Server returned no VAPID key');
          sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(publicKey),
          });
        }

        // 4. Register with relay
        const regRes = await fetch(`${base}/v2/push/subscribe`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${auth}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ subscription: sub.toJSON() }),
        });
        if (!regRes.ok) throw new Error(`Relay register failed: ${regRes.status}`);

        localStorage.setItem('morph-push-enabled', 'true');
        setPushStatus('Enabled');
      } catch (e: any) {
        console.error('[push] subscribe failed:', e);
        setPushError(e?.message || 'Subscribe failed');
        setPushStatus('Disabled');
      }
    } else {
      try {
        const reg = await navigator.serviceWorker.getRegistration();
        const sub = await reg?.pushManager?.getSubscription();
        if (sub) {
          await fetch(`${base}/v2/push/unsubscribe`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${auth}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({ endpoint: sub.endpoint }),
          }).catch(() => {});
          await sub.unsubscribe();
        }
      } catch {}
      localStorage.setItem('morph-push-enabled', 'false');
      setPushStatus('Disabled');
    }
  };

  const handlePushTest = () => {
    setPushError('');
    fetch(`${relayUrl()}/v2/push/test`, { method: 'POST', headers: headers() })
      .then(r => r.json())
      .then(d => { if (d.sent === 0) setPushError('No subscriptions on server'); })
      .catch(e => setPushError(`Test failed: ${e.message}`));
  };

  const sessionAge = (s: any) => {
    if (!s.created && !s.ts) return '';
    const ms = Date.now() - new Date(s.created || s.ts).getTime();
    if (ms < 60000) return 'just now';
    if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
    if (ms < 86400000) return `${Math.floor(ms / 3600000)}h ago`;
    return `${Math.floor(ms / 86400000)}d ago`;
  };

  return (
    <div style={{ flex: 1, overflowY: 'scroll', padding: 16, paddingTop: 56, minHeight: 0, WebkitOverflowScrolling: 'touch' as any }}>

      <Section title="Appearance">
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {(['dark', 'light', 'sunny', 'brutalist', 'onyx', 'clay', 'terminal', 'noir', 'stone', 'rust'] as Theme[]).map(t => (
            <button key={t} onClick={() => { setTheme(t); setThemeGlobal(t); }} style={{
              flex: '1 0 auto', minWidth: 60, padding: '10px 0', border: theme === t ? '2px solid var(--accent)' : '2px solid transparent',
              borderRadius: 10, cursor: 'pointer', fontSize: 12, fontWeight: theme === t ? 700 : 400,
              backgroundColor: theme === t ? 'var(--accent-bg)' : 'var(--bg-input)',
              color: theme === t ? 'var(--accent)' : 'var(--text-secondary)',
              textTransform: 'capitalize', transition: 'all 0.2s',
            }}>{{ dark: '● dark', light: '○ light', sunny: '☀ sunny', brutalist: '■ brutal', onyx: '◉ onyx', clay: '◎ clay', terminal: '> term', noir: '◑ noir', stone: '◻ stone', rust: '⚙ rust' }[t]}</button>
          ))}
        </div>
      </Section>

      <Section title="App Icon">
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <img
            src={iconSrc}
            alt="App Icon"
            style={{ width: 60, height: 60, borderRadius: 14, border: '1px solid var(--border)' }}
          />
          <div style={{ flex: 1 }}>
            <button
              onClick={() => iconInputRef.current?.click()}
              disabled={iconUploading}
              style={{
                padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
                backgroundColor: 'var(--accent-bg)', color: 'var(--accent)', fontSize: 13, fontWeight: 600,
                opacity: iconUploading ? 0.5 : 1,
              }}
            >
              {iconUploading ? 'Uploading...' : 'Change Icon'}
            </button>
            <input
              ref={iconInputRef}
              type="file"
              accept="image/png,image/jpeg,image/webp"
              style={{ display: 'none' }}
              onChange={handleIconUpload}
            />
            <div style={{ fontSize: 11, color: 'var(--text-tertiary)', marginTop: 4 }}>
              PNG/JPEG. Re-add PWA to update home screen.
            </div>
          </div>
        </div>
      </Section>

      <Section title="Connection">
        <Row label="Status" value={connState} valueColor={connState === 'connected' ? 'var(--success)' : 'var(--danger)'} />
        <Row label="Server" value={window.location.origin} />
      </Section>

      <Section title="Usage">
        <Row label="Messages Today" value={usage.messagesToday} />
        <Row label="Total Sessions" value={usage.totalSessions} />
        <Row label="Uptime" value={usage.uptime} />
      </Section>

      <Section title="Sessions">
        {sessions.length === 0 && (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 13, padding: '4px 0' }}>No active sessions</div>
        )}
        {sessions.map(s => (
          <div key={s.id} style={{ display: 'flex', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
            <div style={{
              width: 8, height: 8, borderRadius: 4, flexShrink: 0, marginRight: 8,
              backgroundColor: s.alive ? 'var(--success)' : 'var(--text-label)',
            }} />
            <span style={{ flex: 1, color: 'var(--text-primary)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
              {s.display || s.id?.slice(0, 12)}
            </span>
            <span style={{ color: 'var(--text-tertiary)', fontSize: 11, fontFamily: 'Menlo, monospace', marginLeft: 8 }}>
              {sessionAge(s)}
            </span>
          </div>
        ))}
      </Section>

      <Section title="Notifications">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
          <span style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Push Notifications</span>
          {pushStatus === 'Not supported' ? (
            <span style={{ color: 'var(--text-tertiary)', fontSize: 12, fontFamily: 'Menlo, monospace' }}>Not supported</span>
          ) : (
            <Toggle value={pushStatus === 'Enabled'} onChange={handlePushToggle} />
          )}
        </div>
        {pushError && (
          <div style={{ color: 'var(--danger)', fontSize: 11, paddingTop: 4 }}>{pushError}</div>
        )}
        <div style={{ color: 'var(--text-tertiary)', fontSize: 11, paddingTop: 4 }}>
          {pushStatus === 'Not supported'
            ? 'Push notifications are not available in this browser.'
            : pushStatus === 'Enabled'
              ? 'You will receive notifications when sessions need attention.'
              : 'Enable to get notified when sessions need attention.'}
        </div>
        {pushStatus === 'Enabled' && (
          <button onClick={handlePushTest} style={{
            marginTop: 8, width: '100%', padding: '8px 0', border: 'none', borderRadius: 8,
            cursor: 'pointer', backgroundColor: 'var(--accent-bg)', color: 'var(--accent)', fontSize: 12,
          }}>Send Test Notification</button>
        )}
      </Section>

      <HeartbeatSection />

      <Section title="Debug">
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
          <span style={{ color: 'var(--text-secondary)', fontSize: 14 }}>Remote Logging</span>
          <Toggle value={debugEnabled} onChange={handleDebugToggle} />
        </div>
        <Row label="WebSocket" value={wsState} valueColor={wsState === 'connected' ? 'var(--success)' : 'var(--text-tertiary)'} />
        {debugEnabled && (
          <>
            <div style={{
              marginTop: 8, maxHeight: 200, overflowY: 'auto', backgroundColor: 'var(--bg-primary)',
              borderRadius: 8, padding: 8, fontSize: 11, fontFamily: 'Menlo, monospace',
              color: 'var(--text-secondary)', lineHeight: 1.6,
              WebkitOverflowScrolling: 'touch' as any,
            }}>
              {debugLogs.length === 0 ? (
                <span style={{ color: 'var(--text-tertiary)' }}>No logs</span>
              ) : debugLogs.map((line, i) => (
                <div key={i} style={{ wordBreak: 'break-all' }}>{line}</div>
              ))}
            </div>
            <button onClick={handleClearLogs} style={{
              marginTop: 6, padding: '6px 0', border: 'none', borderRadius: 8, cursor: 'pointer',
              fontSize: 12, width: '100%', backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)',
            }}>Clear Logs</button>
          </>
        )}
      </Section>

      <EnvManagerSection />

      <Section title="Account">
        <button onClick={() => { localStorage.removeItem('morph-auth'); location.reload(); }} style={{
          padding: '10px 0', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, width: '100%', textAlign: 'center',
          backgroundColor: 'var(--danger-bg)', color: 'var(--danger)',
        }}>Logout</button>
      </Section>
    </div>
  );
}

// ─── Heartbeat Section (per-environment) ───
function HeartbeatSection() {
  const envs = getEnvironments();
  const mainToken = () => localStorage.getItem('morph-auth') || '';
  const [activeEnv, setActiveEnv] = useState(envs[0]?.id || 'workspace');

  const envConfig = envs.find(e => e.id === activeEnv) || envs[0];
  // First env = self (served by this relay) → same-origin; others → proxy through this relay
  const isSelf = envConfig === envs[0];
  const baseUrl = isSelf ? '' : `/relay-proxy/${activeEnv}`;
  const authToken = envConfig?.token || mainToken();
  const hdrs = () => ({ 'Authorization': `Bearer ${authToken}`, 'Content-Type': 'application/json' });

  // Cron interval
  const [hours, setHours] = useState('2');
  const [cronLoading, setCronLoading] = useState(true);
  const [cronSaving, setCronSaving] = useState(false);
  const [hbJob, setHbJob] = useState<any>(null);

  // HEARTBEAT.md
  const HB_FILE = 'HEARTBEAT.md';
  const [fileContent, setFileContent] = useState('');
  const [fileLoading, setFileLoading] = useState(true);
  const [fileEditing, setFileEditing] = useState(false);
  const [fileSaving, setFileSaving] = useState(false);
  const [fileError, setFileError] = useState('');

  // Load cron + file on mount / env change
  useEffect(() => {
    setCronLoading(true);
    setFileLoading(true);
    setFileEditing(false);
    setFileError('');

    const h = hdrs();

    // Fetch cron
    fetch(`${baseUrl}/v2/system/cron`, { headers: h })
      .then(r => { if (!r.ok) throw new Error(`${r.status}`); return r.json(); })
      .then(d => {
        const hb = (d.jobs || []).find((j: any) => j.id === 'heartbeat');
        setHbJob(hb || null);
        if (hb) setHours(String(hb.intervalMs / 3600000));
      })
      .catch(() => {})
      .finally(() => setCronLoading(false));

    // Fetch HEARTBEAT.md
    const fileUrl = `${baseUrl}/v2/files/read?path=${encodeURIComponent(HB_FILE)}`;
    fetch(fileUrl, { headers: h })
      .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status} from ${fileUrl}`); return r.json(); })
      .then(d => {
        if (d.error) { setFileError(`${d.error} (${fileUrl})`); setFileContent(''); }
        else setFileContent(d.content || '');
      })
      .catch(e => setFileError(e?.message || `Failed: ${fileUrl}`))
      .finally(() => setFileLoading(false));
  }, [activeEnv, baseUrl]);

  // Save interval
  const saveCron = async () => {
    const ms = Math.max(parseFloat(hours) || 2, 0.1) * 3600000;
    setCronSaving(true);
    try {
      const body = hbJob
        ? { ...hbJob, intervalMs: ms }
        : { id: 'heartbeat', message: '[HEARTBEAT] Run system health check', intervalMs: ms, enabled: true };
      const resp = await fetch(`${baseUrl}/v2/system/cron`, { method: 'POST', headers: hdrs(), body: JSON.stringify(body) });
      const d = await resp.json();
      if (d.ok && d.job) setHbJob(d.job);
    } catch {}
    setCronSaving(false);
  };

  // Save file
  const saveFile = async () => {
    setFileSaving(true);
    setFileError('');
    try {
      const resp = await fetch(`${baseUrl}/v2/files/write`, {
        method: 'POST', headers: hdrs(),
        body: JSON.stringify({ path: HB_FILE, content: fileContent }),
      });
      const d = await resp.json();
      if (d.error) setFileError(d.error);
      else setFileEditing(false);
    } catch (e: any) { setFileError(e.message); }
    setFileSaving(false);
  };

  const inputStyle = {
    width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-input)',
    backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' as const,
    fontFamily: 'Menlo, monospace',
  };

  return (
    <Section title="Heartbeat">
      {/* Multi-env selector */}
      {envs.length > 1 && (
        <div style={{ display: 'flex', gap: 4, marginBottom: 10, flexWrap: 'wrap' }}>
          {envs.map(e => (
            <button key={e.id} onClick={() => setActiveEnv(e.id)} style={{
              padding: '4px 10px', borderRadius: 6, border: activeEnv === e.id ? '1.5px solid var(--accent)' : '1.5px solid transparent',
              backgroundColor: activeEnv === e.id ? 'var(--accent-bg)' : 'var(--bg-hover)',
              color: activeEnv === e.id ? 'var(--accent)' : 'var(--text-tertiary)',
              fontSize: 11, cursor: 'pointer', fontWeight: activeEnv === e.id ? 600 : 400,
            }}>{e.label}</button>
          ))}
        </div>
      )}

      {/* ── Cron interval ── */}
      <div style={{ color: 'var(--text-tertiary)', fontSize: 11, marginBottom: 4 }}>Interval (hours)</div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
        <input type="number" step="0.5" min="0.1" value={hours} onChange={e => setHours(e.target.value)}
          style={{ ...inputStyle, flex: 1 }} placeholder="2" disabled={cronLoading} />
        <button onClick={saveCron} disabled={cronSaving || cronLoading} style={{
          padding: '8px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', flexShrink: 0,
          backgroundColor: 'var(--accent)', color: '#fff', fontSize: 12, fontWeight: 600,
          opacity: cronSaving ? 0.6 : 1,
        }}>{cronSaving ? '...' : 'Save'}</button>
      </div>
      {hbJob && (
        <div style={{ color: 'var(--text-tertiary)', fontSize: 11, marginTop: 4 }}>
          Current: {hbJob.intervalMs / 3600000}h {hbJob.enabled ? '' : '(paused)'}
        </div>
      )}

      {/* ── HEARTBEAT.md ── */}
      <div style={{ marginTop: 14, borderTop: '1px solid var(--border)', paddingTop: 10 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
          <span style={{ color: 'var(--text-label)', fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: 0.5 }}>HEARTBEAT.md</span>
          <div style={{ display: 'flex', gap: 6 }}>
            {!fileEditing ? (
              <button onClick={() => setFileEditing(true)} style={{ border: 'none', background: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer' }}>Edit</button>
            ) : (
              <>
                <button onClick={() => { setFileEditing(false); /* reload */ fetch(`${baseUrl}/v2/files/read?path=${encodeURIComponent(HB_FILE)}`, { headers: hdrs() }).then(r => r.json()).then(d => setFileContent(d.content || '')).catch(() => {}); }} style={{ border: 'none', background: 'none', color: 'var(--text-tertiary)', fontSize: 11, cursor: 'pointer' }}>Cancel</button>
                <button onClick={saveFile} disabled={fileSaving} style={{ border: 'none', background: 'none', color: 'var(--accent)', fontSize: 11, cursor: 'pointer', fontWeight: 600 }}>{fileSaving ? '...' : 'Save'}</button>
              </>
            )}
          </div>
        </div>
        {fileError && <div style={{ color: 'var(--danger)', fontSize: 11, marginBottom: 4 }}>{fileError}</div>}
        {fileLoading ? (
          <div style={{ color: 'var(--text-tertiary)', fontSize: 12, padding: 8 }}>Loading...</div>
        ) : fileEditing ? (
          <textarea value={fileContent} onChange={e => setFileContent(e.target.value)} style={{
            ...inputStyle, minHeight: 200, resize: 'vertical', lineHeight: 1.5,
          }} />
        ) : (
          <div style={{
            maxHeight: 400, overflowY: 'auto', backgroundColor: 'var(--bg-primary)',
            borderRadius: 8, padding: 10, fontSize: 12, fontFamily: 'Menlo, monospace',
            color: 'var(--text-secondary)', lineHeight: 1.6, whiteSpace: 'pre-wrap', wordBreak: 'break-word',
            WebkitOverflowScrolling: 'touch' as any,
          }}>{fileContent || '(empty)'}</div>
        )}
      </div>
    </Section>
  );
}

function EnvManagerSection() {
  const [envs, setEnvs] = useState<EnvConfig[]>(getEnvironments);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState({ label: '', relayUrl: '', token: '' });

  const save = (next: EnvConfig[]) => { saveEnvironments(next); setEnvs(next); };

  const handleAdd = () => {
    if (!form.relayUrl.trim()) return;
    const id = `env_${Date.now()}`;
    save([...envs, { id, label: form.label || form.relayUrl, relayUrl: form.relayUrl.trim(), token: form.token.trim() || undefined, maxSessions: 6 }]);
    setForm({ label: '', relayUrl: '', token: '' });
    setAdding(false);
  };

  const handleRemove = (id: string) => {
    if (id === 'workspace') return; // can't remove primary
    save(envs.filter(e => e.id !== id));
  };

  const inputStyle = {
    width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid var(--border-input)',
    backgroundColor: 'var(--bg-hover)', color: 'var(--text-primary)', fontSize: 13, boxSizing: 'border-box' as const,
    marginBottom: 6, fontFamily: 'Menlo, monospace',
  };

  return (
    <Section title="Environments">
      {envs.map(e => (
        <div key={e.id} style={{ display: 'flex', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
          <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: 'var(--success)', marginRight: 8, flexShrink: 0 }} />
          <span style={{ flex: 1, color: 'var(--text-primary)', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{e.label}</span>
          {e.id !== 'workspace' && (
            <button onClick={() => handleRemove(e.id)} style={{ border: 'none', background: 'none', color: 'var(--danger)', fontSize: 18, cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}>×</button>
          )}
        </div>
      ))}

      {adding ? (
        <div style={{ marginTop: 10 }}>
          <input placeholder="Label (e.g. TR Machine)" value={form.label} onChange={e => setForm(f => ({...f, label: e.target.value}))} style={inputStyle} />
          <input placeholder="Relay URL" value={form.relayUrl} onChange={e => setForm(f => ({...f, relayUrl: e.target.value}))} style={inputStyle} />
          <input placeholder="Auth Token" type="password" value={form.token} onChange={e => setForm(f => ({...f, token: e.target.value}))} style={inputStyle} />
          <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
            <button onClick={() => { setAdding(false); setForm({ label: '', relayUrl: '', token: '' }); }} style={{ flex: 1, padding: '8px 0', border: 'none', borderRadius: 8, cursor: 'pointer', backgroundColor: 'var(--bg-hover)', color: 'var(--text-secondary)', fontSize: 13 }}>Cancel</button>
            <button onClick={handleAdd} style={{ flex: 1, padding: '8px 0', border: 'none', borderRadius: 8, cursor: 'pointer', backgroundColor: 'var(--accent)', color: 'var(--text-primary)', fontSize: 13, fontWeight: 600 }}>Add</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ marginTop: 8, width: '100%', padding: '8px 0', border: 'none', borderRadius: 8, cursor: 'pointer', backgroundColor: 'var(--accent-bg)', color: 'var(--accent)', fontSize: 13 }}>+ Add Environment</button>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ color: 'var(--text-label)', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', marginBottom: 8, letterSpacing: 0.5 }}>{title}</div>
      <div style={{ backgroundColor: 'var(--bg-card)', borderRadius: 12, padding: 12 }}>{children}</div>
    </div>
  );
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
      <span style={{ color: 'var(--text-secondary)', fontSize: 14 }}>{label}</span>
      <span style={{ color: valueColor || 'var(--text-primary)', fontSize: 14, fontFamily: 'Menlo, monospace' }}>{value}</span>
    </div>
  );
}

// ─── Drafts Tab ───
function DraftsTab() {
  const [drafts, setDrafts] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [actionLoading, setActionLoading] = useState<string | null>(null);
  const token = () => localStorage.getItem('morph-auth') || '';

  const fetchDrafts = async () => {
    setLoading(true);
    try {
      const res = await fetch('/v1/drafts', { headers: { Authorization: `Bearer ${token()}` } });
      if (res.ok) { const d = await res.json(); setDrafts(d.drafts || []); }
    } catch {} finally { setLoading(false); }
  };

  useEffect(() => { fetchDrafts(); }, []);

  const handleAction = async (slug: string, action: 'approve' | 'reject') => {
    setActionLoading(slug);
    try {
      await fetch(`/v1/drafts/${encodeURIComponent(slug)}/${action}`, {
        method: 'POST', headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: '{}',
      });
    } catch (e) { console.warn('draft action failed:', e); }
    // Always remove from UI — if the API failed, refresh will bring it back
    setDrafts(ds => ds.filter(d => d.slug !== slug));
    setActionLoading(null);
  };

  const cardStyle: React.CSSProperties = {
    backgroundColor: 'var(--bg-card)', borderRadius: 12, padding: 16,
    border: '1px solid var(--border-input)', marginBottom: 12,
  };
  const btnBase: React.CSSProperties = {
    flex: 1, padding: '10px 0', border: 'none', borderRadius: 8,
    fontSize: 14, fontWeight: 600, cursor: 'pointer',
  };

  return (
    <div style={{ flex: 1, overflow: 'auto', padding: '16px 12px', paddingTop: 'max(48px, env(safe-area-inset-top, 48px))', WebkitOverflowScrolling: 'touch' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <span style={{ color: 'var(--text-primary)', fontSize: 18, fontWeight: 600 }}>Polished Drafts</span>
        <button onClick={fetchDrafts} style={{ background: 'none', border: 'none', color: 'var(--text-secondary)', cursor: 'pointer', fontSize: 13 }}>Refresh</button>
      </div>
      {loading ? (
        <div style={{ color: 'var(--text-tertiary)', textAlign: 'center', marginTop: 40 }}>Loading...</div>
      ) : drafts.length === 0 ? (
        <div style={{ color: 'var(--text-tertiary)', textAlign: 'center', marginTop: 40 }}>No polished drafts</div>
      ) : drafts.map(d => (
        <div key={d.slug} style={cardStyle}>
          <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, backgroundColor: 'rgba(99,102,241,0.15)', color: '#818cf8' }}>{d.format}</span>
            {d.goal && <span style={{ fontSize: 11, padding: '2px 8px', borderRadius: 4, backgroundColor: 'rgba(251,191,36,0.15)', color: '#fbbf24' }}>{d.goal}</span>}
          </div>
          <pre style={{ color: 'var(--text-primary)', fontSize: 14, lineHeight: 1.5, whiteSpace: 'pre-wrap', wordBreak: 'break-word', margin: '0 0 10px', fontFamily: '-apple-system, sans-serif' }}>{d.post}</pre>
          <div style={{ color: 'var(--text-tertiary)', fontSize: 11, marginBottom: 10 }}>
            {d.slug} {d.drafted_at ? `\u00b7 ${d.drafted_at}` : ''}
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => handleAction(d.slug, 'approve')} disabled={actionLoading === d.slug}
              style={{ ...btnBase, backgroundColor: 'rgba(34,197,94,0.15)', color: '#22c55e' }}>
              {actionLoading === d.slug ? '...' : 'Approve'}
            </button>
            <button onClick={() => handleAction(d.slug, 'reject')} disabled={actionLoading === d.slug}
              style={{ ...btnBase, backgroundColor: 'rgba(239,68,68,0.15)', color: '#ef4444' }}>
              {actionLoading === d.slug ? '...' : 'Reject'}
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ─── Tab Bar ───
const tabs = [{ id: 'canvas', label: 'Canvas' }, { id: 'drafts', label: 'Drafts' }, { id: 'config', label: 'Config' }];
function TabBar({ tab, onTab, disabled }: { tab: string; onTab: (t: string) => void; disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', borderTop: '1px solid var(--border-strong)', paddingBottom: 'max(4px, env(safe-area-inset-bottom))', flexShrink: 0, position: 'relative', backgroundColor: 'var(--bg-primary)', opacity: disabled ? 0.3 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
      {/* Sliding indicator */}
      {!disabled && <motion.div
        layoutId="tab-indicator"
        style={{
          position: 'absolute', top: 0, height: 2, width: `${100 / tabs.length}%`, backgroundColor: 'var(--text-primary)', borderRadius: 1,
        }}
        animate={{ x: `${tabs.findIndex(t => t.id === tab) * 100}%` }}
        transition={{ type: 'spring', stiffness: 500, damping: 35 }}
      />}
      {tabs.map(t => (
        <motion.button key={t.id} tabIndex={-1} onClick={() => onTab(t.id)}
          whileTap={disabled ? undefined : { scale: 0.92 }}
          style={{
            flex: 1, padding: '8px 0 4px', border: 'none', cursor: disabled ? 'default' : 'pointer', backgroundColor: 'transparent',
            color: disabled ? 'var(--text-tertiary)' : (tab === t.id ? 'var(--text-primary)' : 'var(--text-tertiary)'), display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            transition: 'color 0.2s',
          }}>
          <span style={{ display: 'flex' }}>
            {t.id === 'canvas' ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 3v18"/></svg>
            ) : t.id === 'drafts' ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M14 2H6a2 2 0 00-2 2v16a2 2 0 002 2h12a2 2 0 002-2V8z"/><path d="M14 2v6h6"/><path d="M16 13H8M16 17H8M10 9H8"/></svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            )}
          </span>
          <span style={{ fontSize: 10 }}>{t.label}</span>
        </motion.button>
      ))}
    </div>
  );
}

// ─── Session Terminal (slide-in from right, swipe to go back) ───
function SessionTerminal({ session, messages, onBack, onSend, onRawKey, onInterrupt, keyboardOpen, isProcessing = false, isCompacting = false }: {
  session: { id: string; display: string; relayUrl?: string; relayToken?: string };
  messages: Message[];
  onBack: () => void;
  onSend: (text: string) => void;
  onRawKey?: (key: string) => void;
  onInterrupt: () => void;
  keyboardOpen?: boolean;
  isProcessing?: boolean;
  isCompacting?: boolean;
}) {
  const dragX = useMotionValue(0);
  const swipeStart = useRef<{ x: number } | null>(null);
  const [resumeOpen, setResumeOpen] = useState(false);
  const [resumeSessions, setResumeSessions] = useState<{ id: string; slug: string | null; firstMessage: string | null; updatedAt: number }[]>([]);
  const arrowThrottle = useRef({ lastSent: 0, pending: null as string | null, timer: null as ReturnType<typeof setTimeout> | null });

  const loadResumeSessions = useCallback(async () => {
    const token = localStorage.getItem('morph-auth') || '';
    try {
      const res = await fetch('/v2/claude/resumable?limit=20', { headers: { 'Authorization': `Bearer ${token}` } });
      const data = await res.json();
      setResumeSessions(data.sessions || []);
      setResumeOpen(true);
    } catch {}
  }, []);

  // Swipe-back handled entirely by React touch handlers below.
  const flow = useSendFlow(onSend, { relayUrl: session.relayUrl, relayToken: session.relayToken });

  const onTouchStart = (e: React.TouchEvent) => {
    const x = e.touches[0].clientX;
    if (x < 40) swipeStart.current = { x };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    if (!swipeStart.current) return;
    const dx = e.touches[0].clientX - swipeStart.current.x;
    if (dx > 0) dragX.set(dx);
  };
  const onTouchEnd = () => {
    if (!swipeStart.current) return;
    if (dragX.get() > 120) onBack();
    else dragX.set(0);
    swipeStart.current = null;
  };


  return (
    <motion.div
      key="session-terminal"
      initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
      transition={{ type: 'tween', duration: 0.25, ease: 'easeInOut' }}
      style={{ x: dragX, position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: 'var(--bg-primary)', zIndex: 50, display: 'flex', flexDirection: 'column' }}
    >
      {/* Narrow left-edge zone for swipe-back — keeps touch handlers off the message area */}
      <div onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
        style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: 40, zIndex: 51 }} />
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 12px 8px', paddingTop: 'max(12px, env(safe-area-inset-top))',
        borderBottom: '1px solid rgba(224,160,48,0.15)', flexShrink: 0,
      }}>
        <motion.button whileTap={{ scale: 0.9 }} onClick={onBack}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px',
            color: 'var(--warning)', fontSize: 14, display: 'flex', alignItems: 'center', gap: 4 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          Back
        </motion.button>
        <span style={{ color: 'var(--text-primary)', fontSize: 14, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
          {session.display}
        </span>
        <span style={{ color: 'var(--text-tertiary)', fontSize: 11, fontFamily: 'Menlo, monospace' }}>{session.id.slice(0, 8)}</span>
        {onRawKey && (
          <motion.button whileTap={{ scale: 0.9 }} onClick={loadResumeSessions}
            style={{ background: 'none', border: '1px solid var(--border)', borderRadius: 6, cursor: 'pointer',
              padding: '3px 8px', color: 'var(--text-secondary)', fontSize: 11, fontFamily: 'Menlo, monospace' }}>
            resume
          </motion.button>
        )}
      </div>

      {/* Resume session picker modal */}
      {resumeOpen && (
        <div style={{ position: 'absolute', top: 0, left: 0, right: 0, bottom: 0, zIndex: 60,
          backgroundColor: 'rgba(0,0,0,0.7)', display: 'flex', flexDirection: 'column' }}
          onClick={() => setResumeOpen(false)}>
          <div onClick={e => e.stopPropagation()} style={{
            margin: 'auto 12px', maxHeight: '70vh', backgroundColor: 'var(--bg-primary)',
            borderRadius: 12, border: '1px solid var(--border)', overflow: 'hidden',
            display: 'flex', flexDirection: 'column',
          }}>
            <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', color: 'var(--text-primary)',
              fontSize: 14, fontWeight: 600 }}>
              Resume Session
            </div>
            <div style={{ overflow: 'auto', flex: 1 }}>
              {resumeSessions.map(s => (
                <button key={s.id} onClick={() => {
                  setResumeOpen(false);
                  onSend(`/resume ${s.id}`);
                }} style={{
                  display: 'block', width: '100%', textAlign: 'left', padding: '10px 16px',
                  border: 'none', borderBottom: '1px solid var(--border)', cursor: 'pointer',
                  backgroundColor: 'transparent', color: 'var(--text-primary)',
                }}>
                  <div style={{ fontSize: 13, fontFamily: 'Menlo, monospace', marginBottom: 2 }}>
                    {s.slug || s.id.slice(0, 8)}
                  </div>
                  <div style={{ fontSize: 11, color: 'var(--text-tertiary)', overflow: 'hidden',
                    textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                    {s.firstMessage || '(no message)'}
                  </div>
                  <div style={{ fontSize: 10, color: 'var(--text-tertiary)', marginTop: 2 }}>
                    {new Date(s.updatedAt).toLocaleString()}
                  </div>
                </button>
              ))}
            </div>
          </div>
        </div>
      )}

      {/* Messages + Permission banner + ESC overlay */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <TerminalOverlay messages={messages} visible={true} sessionId={session.id} />
        <PermissionBanner messages={messages} sessionId={session.id} />
        {(() => { const w = isCompacting ? 'compacting...' : isProcessing ? IDLE_WORDS[Math.floor(Date.now() / 4000) % IDLE_WORDS.length] : 'idle'; return (
        <div style={{ position: 'absolute', bottom: 4, right: 8, display: 'flex', alignItems: 'center', gap: 6, pointerEvents: 'none' }}>
          <span style={{ color: isCompacting ? 'var(--accent)' : 'var(--text-tertiary)', fontSize: 11, fontFamily: 'Menlo, monospace' }}>
            {w}
          </span>
          {onRawKey ? (
            <button tabIndex={-1} onPointerDown={(e) => { e.preventDefault(); onRawKey('\t'); }} style={{
              padding: '3px 10px', borderRadius: 5, cursor: 'pointer', flexShrink: 0,
              border: '1px solid var(--border)',
              backgroundColor: 'var(--bg-elevated)',
              color: 'var(--text-tertiary)', fontSize: 11, fontFamily: 'Menlo, monospace',
              pointerEvents: 'auto', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' as any,
            }}>Tab</button>
          ) : (
            <button tabIndex={-1} onPointerDown={(e) => { e.preventDefault(); onInterrupt(); }} style={{
              padding: '3px 10px', borderRadius: 5, cursor: 'pointer', flexShrink: 0,
              border: isProcessing ? '1px solid var(--danger-border)' : '1px solid var(--border)',
              backgroundColor: isProcessing ? 'var(--danger-bg)' : 'var(--bg-elevated)',
              color: isProcessing ? 'var(--danger)' : 'var(--text-tertiary)', fontSize: 11, fontFamily: 'Menlo, monospace',
              pointerEvents: 'auto', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' as any,
            }}>ESC</button>
          )}
        </div>
        ); })()}
      </div>

      {/* Upload error banner — tap to dismiss */}
      {flow.uploadError && (
        <div onClick={flow.clearUploadError} style={{
          padding: '8px 14px', backgroundColor: 'rgba(255,59,48,0.85)',
          color: 'var(--text-primary)', fontSize: 13, fontFamily: '-apple-system, system-ui, sans-serif',
          flexShrink: 0, cursor: 'pointer',
        }}>
          Upload failed: {flow.uploadError}
        </div>
      )}
      {/* Control keys + quick-send buttons — single row */}
      <div style={{
        display: 'flex', justifyContent: 'center', gap: 6, padding: '6px 12px',
        borderTop: '1px solid rgba(224,160,48,0.12)', flexShrink: 0,
      }}>
        {onRawKey && <>
          <button onPointerDown={(e) => { e.preventDefault(); onRawKey('\x1b'); }}
            style={{
              flex: 1, maxWidth: 56, padding: '8px 0', borderRadius: 6, cursor: 'pointer',
              border: isProcessing ? '1px solid var(--danger-border)' : '1px solid var(--border)',
              backgroundColor: isProcessing ? 'var(--danger-bg)' : 'var(--bg-elevated)',
              color: isProcessing ? 'var(--danger)' : 'var(--text-secondary)', fontSize: 13, fontFamily: 'Menlo, monospace',
              touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' as any,
            }}>ESC</button>
          {[
            { label: '\u2191', key: '\x1b[A' },
            { label: '\u2193', key: '\x1b[B' },
            { label: '\u21B5', key: '\r' },
          ].map(({ label, key }) => (
            <button key={label} onPointerDown={(e) => {
              e.preventDefault();
              if ((key === '\x1b[A' || key === '\x1b[B') && onRawKey) {
                // Throttle arrows: 2s cooldown, last direction wins
                const now = Date.now();
                const t = arrowThrottle.current;
                t.pending = key;
                if (now - t.lastSent >= 2000) {
                  t.lastSent = now; t.pending = null;
                  if (t.timer) { clearTimeout(t.timer); t.timer = null; }
                  onRawKey(key);
                } else if (!t.timer) {
                  const wait = 2000 - (now - t.lastSent);
                  t.timer = setTimeout(() => {
                    t.timer = null;
                    if (t.pending && onRawKey) {
                      t.lastSent = Date.now();
                      const k = t.pending; t.pending = null;
                      onRawKey(k);
                    }
                  }, wait);
                }
              } else if (onRawKey) {
                onRawKey(key);
              }
            }}
              style={{
                flex: 1, maxWidth: 56, padding: '8px 0', borderRadius: 6, cursor: 'pointer',
                border: '1px solid var(--border)', backgroundColor: 'var(--bg-elevated)',
                color: 'var(--text-secondary)', fontSize: 16, fontFamily: 'Menlo, monospace',
                touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' as any,
              }}>{label}</button>
          ))}
        </>}
        {['Continue', 'OK'].map((txt) => (
          <button key={txt} onPointerDown={(e) => { e.preventDefault(); flow.handleSend(txt.toLowerCase()); }}
            style={{
              flex: 1, maxWidth: 72, padding: '8px 0', borderRadius: 6, cursor: 'pointer',
              border: '1px solid var(--accent)',
              backgroundColor: 'var(--accent-bg)',
              color: 'var(--accent)', fontSize: 13, fontWeight: 600, fontFamily: 'Menlo, monospace',
              touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' as any,
            }}>{txt}</button>
        ))}
      </div>
      {/* Shared InputBar — amber tint, no terminal toggle (header has Back) */}
      <InputBar
        onSend={flow.handleSend} onStop={onInterrupt}
        isProcessing={isProcessing} connected={true}
        onAttach={flow.toggleAttach}
        onSketch={() => flow.setSketchOpen(true)}
        pendingSketch={flow.pendingSketch ? flow.pendingSketch.dataUrl : null}
        pendingFile={flow.pendingFile ? (flow.pendingFile.isImage ? 'image' : 'file') : null}
        onClearPending={flow.clearPending}
        tint="amber"
        keyboardOpen={keyboardOpen}
        isUploading={flow.isUploading}
        storageKey={`morph-draft-${session.id}`}
      />
      {/* Disabled TabBar — same height as main, keeps InputBar aligned */}
      {!keyboardOpen && <TabBar tab="canvas" onTab={() => {}} disabled />}

      {/* Session attach menu */}
      <AnimatePresence>
        {flow.attachMenu && (<>
          <motion.div key="s-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }} onClick={() => flow.setAttachMenu(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 998 }} />
          <motion.div key="s-menu" initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.3, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 25 }}
            style={{ position: 'absolute', bottom: 60, left: 12, zIndex: 999,
              backgroundColor: 'var(--bg-elevated)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
              borderRadius: 14, padding: '4px 0', minWidth: 200,
              boxShadow: '0 8px 40px rgba(0,0,0,0.6)', border: '1px solid rgba(224,160,48,0.15)',
              transformOrigin: 'bottom left' }}>
            {[
              { label: 'Add Photo', icon: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>), action: () => flow.uploadFile('image/*') },
              { label: 'Attach File', icon: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>), action: () => flow.uploadFile('.pdf,.md,.txt,.csv,.json,.py,.js,.ts,.jsx,.tsx') },
              { label: 'Sketch', icon: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>), action: () => { flow.setAttachMenu(false); flow.setSketchOpen(true); } },
            ].map((item, i) => (
              <div key={item.label}>
                {i > 0 && <div style={{ height: 1, backgroundColor: 'var(--border)', margin: '0 12px' }} />}
                <button tabIndex={-1} onClick={item.action} style={{
                  display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                  padding: '11px 16px', border: 'none', cursor: 'pointer',
                  backgroundColor: 'transparent', color: 'var(--text-primary)',
                  fontSize: 15, textAlign: 'left', fontFamily: '-apple-system, system-ui, sans-serif',
                }}><span style={{ color: 'var(--warning)', display: 'flex' }}>{item.icon}</span> {item.label}</button>
              </div>
            ))}
          </motion.div>
        </>)}
      </AnimatePresence>

      {/* Session sketch overlay */}
      {flow.sketchOpen && createPortal(
        <Sketch onInsert={flow.handleSketchInsert} onClose={() => flow.setSketchOpen(false)} />,
        document.body
      )}
    </motion.div>
  );
}

// ─── Offline banner: brief "reconnecting", then "Mac is offline" after 8s ───
function OfflineBanner() {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setElapsed(s => s + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const isOffline = elapsed >= 8;
  return (
    <div style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 99999,
      padding: `max(6px, env(safe-area-inset-top)) 16px 6px`,
      textAlign: 'center',
      fontSize: 12, fontFamily: 'Menlo, monospace',
      color: isOffline ? 'var(--danger)' : 'var(--warning)',
      backgroundColor: isOffline ? 'var(--danger-bg)' : 'transparent',
      transition: 'background-color 0.3s, color 0.3s',
      pointerEvents: 'none',
    }}>
      {isOffline ? 'Mac is offline' : 'reconnecting...'}
    </div>
  );
}

// ─── App ───
export default function App() {
  const [authed, setAuthed] = useState(() => !!localStorage.getItem(PASS_KEY));
  const [tab, setTab] = useState('canvas');
  const [messages, setMessages] = useState<Message[]>([]);
  const [connState, setConnState] = useState(getState());
  const [isProcessing, setIsProcessing] = useState(false);
  const [isCompacting, setIsCompacting] = useState(false);
  const compactTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [canvasLoaded, setCanvasLoaded] = useState(false);
  const mainFlow = useSendFlow(send);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState<{ id: string; display: string; relayUrl?: string; relayToken?: string; project?: string; envId?: string; isNew?: boolean; underlyingSessionId?: string; textPreview?: string } | null>(() => {
    try { const s = sessionStorage.getItem('morph-selected-session'); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [sessionMessages, setSessionMessages] = useState<Message[]>([]);
  const [hasVisitedConfig, setHasVisitedConfig] = useState(false);
  const liveSessionIdRef = useRef<string | null>(null); // tracks active process ID after resume
  const sessionAliveCache = useRef<Map<string, { alive: boolean; ts: number; terminal?: boolean }>>(new Map());
  const sessionSendQueue = useRef<Array<() => Promise<void>>>([]);
  const sessionSendBusy = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [sessionIsProcessing, setSessionIsProcessing] = useState(false);
  const sessionIdleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [sessionIsCompacting, setSessionIsCompacting] = useState(false);
  const sessionCompactTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputBarRef = useRef<HTMLDivElement>(null);

  // Detect iOS keyboard — instant on focus, visualViewport confirms
  useEffect(() => {
    const vv = window.visualViewport;
    // Instant: set keyboardOpen=true on textarea/input focus (before viewport resizes)
    const onFocusIn = (e: FocusEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === 'TEXTAREA' || tag === 'INPUT') setKeyboardOpen(true);
    };
    const onFocusOut = (e: FocusEvent) => {
      const related = e.relatedTarget as HTMLElement;
      if (!related || (related.tagName !== 'TEXTAREA' && related.tagName !== 'INPUT')) {
        // Delay blur slightly — iOS may refocus during keyboard dismiss animation
        setTimeout(() => {
          if (document.activeElement?.tagName !== 'TEXTAREA' && document.activeElement?.tagName !== 'INPUT') {
            setKeyboardOpen(false);
          }
        }, 50);
      }
    };
    document.addEventListener('focusin', onFocusIn, true);
    document.addEventListener('focusout', onFocusOut, true);
    // Backup: visualViewport resize (catches edge cases like external keyboard)
    let t: ReturnType<typeof setTimeout>;
    const onResize = () => {
      if (!vv || document.visibilityState === 'hidden') return;
      clearTimeout(t);
      t = setTimeout(() => {
        const ratio = vv.height / window.screen.height;
        const isOpen = ratio < 0.75;
        dbg(`keyboard: ratio=${ratio.toFixed(2)} vvh=${Math.round(vv.height)} screenH=${window.screen.height} open=${isOpen}`);
        setKeyboardOpen(isOpen);
      }, 80);
    };
    vv?.addEventListener('resize', onResize);
    return () => {
      document.removeEventListener('focusin', onFocusIn, true);
      document.removeEventListener('focusout', onFocusOut, true);
      vv?.removeEventListener('resize', onResize);
      clearTimeout(t);
    };
  }, []);

  // Debug: log focus/blur on any element
  useEffect(() => {
    function onFocus(e: FocusEvent) {
      const t = e.target as HTMLElement;
      dbg(`focus: ${t.tagName}${t.id ? '#'+t.id : ''} class=${(t.className||'').toString().slice(0,20)}`);
    }
    function onBlur(e: FocusEvent) {
      const t = e.target as HTMLElement;
      dbg(`blur: ${t.tagName}${t.id ? '#'+t.id : ''} → relatedTarget=${(e.relatedTarget as HTMLElement)?.tagName || 'null'}`);
    }
    document.addEventListener('focus', onFocus, true);
    document.addEventListener('blur', onBlur, true);
    return () => { document.removeEventListener('focus', onFocus, true); document.removeEventListener('blur', onBlur, true); };
  }, []);

  // Preload all session histories into cache — deferred so cold load is not competing
  const sessionCache = useRef<Map<string, Message[]>>(new Map());
  const sessionCacheTs = useRef<Map<string, number>>(new Map());
  // Session history is loaded on-demand when a pane is tapped — no preloading.

  // SAFETY: register all locally-stored envs as relays immediately on auth
  // Prevents cross-env leak when env was added via URL param or Config and page reloads
  useEffect(() => {
    if (!authed) return;
    const token = localStorage.getItem(PASS_KEY) || '';
    const envs = getEnvironments().filter(e => e.relayUrl && e.id !== 'workspace');
    envs.forEach(env => {
      addRelay({ id: env.id, url: env.relayUrl, token: env.token || token, label: env.label });
    });
  }, [authed]);

  // Pull server-defined environments from relay (runs once after auth)
  // Relay can push any env via RELAY_ENVS env var — no per-device config needed
  useEffect(() => {
    if (!authed) return;
    const token = localStorage.getItem(PASS_KEY) || '';
    fetch('/v2/claude/environments', { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then(data => {
        if (!Array.isArray(data.environments) || data.environments.length === 0) return;
        const current = getEnvironments();
        // Full-replace server-managed envs (by id) to avoid ghost accumulation
        const serverIds = new Set(data.environments.map((e: any) => e.id).filter(Boolean));
        const merged = current.filter(e => !serverIds.has(e.id));
        for (const env of data.environments) {
          if (!env.relayUrl) continue;
          merged.push({ id: env.id || `env_${Date.now()}`, label: env.label || env.relayUrl, relayUrl: env.relayUrl, token: env.token || undefined, maxSessions: env.maxSessions || 6 });
          const relayConfig: RelayConfig = {
            id: env.id,
            url: env.relayUrl,
            token: env.token || token,
            label: env.label,
            socketPath: env.socketPath,
          };
          addRelay(relayConfig);
        }
        saveEnvironments(merged);
      })
      .catch(() => {});
  }, [authed]);

  // Import env from URL param: ?addEnv=<base64-json>
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const raw = params.get('addEnv');
    if (!raw) return;
    try {
      const cfg = JSON.parse(atob(raw));
      if (cfg.relayUrl) {
        const current = getEnvironments();
        const envId = cfg.id || `env_${Date.now()}`;
        if (!current.find(e => e.relayUrl === cfg.relayUrl)) {
          saveEnvironments([...current, { id: envId, label: cfg.label || cfg.relayUrl, relayUrl: cfg.relayUrl, token: cfg.token || undefined, maxSessions: 6 }]);
        }
        // Also register as relay so relayConns has it — prevents cross-env fallback to PRIMARY
        const token = localStorage.getItem(PASS_KEY) || '';
        addRelay({ id: envId, url: cfg.relayUrl, token: cfg.token || token, label: cfg.label });
      }
    } catch {}
    const url = new URL(window.location.href);
    url.searchParams.delete('addEnv');
    window.history.replaceState({}, '', url.toString());
  }, []);

  // Persist selected session across page refreshes (same tab)
  useEffect(() => {
    if (selectedSession) sessionStorage.setItem('morph-selected-session', JSON.stringify(selectedSession));
    else sessionStorage.removeItem('morph-selected-session');
  }, [selectedSession?.id]);

  // When a session is selected, load from cache instantly, then subscribe for live updates
  useEffect(() => {
    if (!selectedSession) return;

    // ── Panel: pure PTY relay ── No session concept. Subscribe to TTY, show what terminal shows.
    if (isTTYId(selectedSession.id)) {
      const tty = parseTTYId(selectedSession.id);
      const ttyKey = selectedSession.id;
      let cancelled = false;
      liveSessionIdRef.current = ttyKey;
      setSessionIsProcessing(false);
      setSessionMessages([]);

      // Instant display from preload cache (relay pushed JSONL before tap)
      const preloaded = getPreloadedMessages(tty);
      if (preloaded.length) {
        setSessionMessages(preloaded);
      } else {
        // Fallback: show textPreview as placeholder while subscribe-tty delivers PTY buffer
        const initPreview = (selectedSession as any).textPreview;
        if (initPreview) {
          const uid = `init_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          setSessionMessages([{ id: uid, role: 'agent' as const, type: 'pty' as const, content: initPreview, ts: Date.now() }]);
        }
      }

      // Subscribe for live output
      // Flow: preload (instant) → subscribe-tty (dedup) → live PTY/JSONL (append)
      const hadPreload = preloaded.length > 0;
      const onPtyMsg = (msg: Message) => {
        if (cancelled || liveSessionIdRef.current !== ttyKey) return;
        if (msg.type === 'pty' && !msg.content.trim()) return;

        setSessionMessages(prev => {
          // Batch refresh: skip if preload already showing identical data
          if ((msg as any)._batch) {
            if (hadPreload && prev.length > 0) return prev;
            return [msg];
          }
          // JSONL message arrived: replace any PTY placeholder
          if (msg.type !== 'pty' && prev.some(m => m.type === 'pty')) {
            return [...prev.filter(m => m.type !== 'pty'), msg];
          }
          // Append PTY chunks to single terminal buffer message
          if (msg.type === 'pty') {
            const lastIdx = prev.length - 1;
            if (lastIdx >= 0 && prev[lastIdx].type === 'pty') {
              const next = [...prev];
              next[lastIdx] = { ...prev[lastIdx], content: prev[lastIdx].content + msg.content, ts: msg.ts };
              return next;
            }
          }
          return [...prev, msg];
        });
        if (msg.role === 'agent' || msg.type === 'tool' || msg.type === 'thinking') setSessionIsProcessing(true);
        if (msg.type === 'status' && (msg.content.includes('done') || msg.content.includes('exit'))) setSessionIsProcessing(false);
        clearTimeout(sessionIdleTimer.current);
        sessionIdleTimer.current = setTimeout(() => setSessionIsProcessing(false), 30000);
      };
      const unsub = subscribeTTY(tty, onPtyMsg);

      return () => { cancelled = true; unsub(); };
    }

    // CRITICAL: hydrate relay mapping before any network calls — prevents cross-env leak
    if (selectedSession.envId && selectedSession.envId !== 'workspace') {
      registerSession(selectedSession.id, selectedSession.envId);
    }
    liveSessionIdRef.current = selectedSession.id; // reset live ID on new session open
    setSessionIsProcessing(false);
    clearTimeout(sessionIdleTimer.current);
    // Instant load from cache, then always refetch for freshness
    const cached = sessionCache.current.get(selectedSession.id);
    if (cached) setSessionMessages(cached);
    const token = selectedSession.relayToken || localStorage.getItem('morph-auth') || '';
    const base = selectedSession.relayUrl || '';
    const cwdParam = selectedSession.project ? `&cwd=${encodeURIComponent(selectedSession.project)}` : '';
    const abortCtrl = new AbortController();
    // Stale-while-revalidate: fresh cache (< 60s) → defer fetch off critical path
    const HISTORY_TTL = 60_000;
    const cacheTs = sessionCacheTs.current.get(selectedSession.id);
    const freshCache = !!cacheTs && Date.now() - cacheTs < HISTORY_TTL;
    let idleCbHandle: number | ReturnType<typeof setTimeout> | null = null;
    const doFetch = () => {
      fetch(`${base}/v2/claude/history/${selectedSession.id}?limit=50${cwdParam}`, { headers: { 'Authorization': `Bearer ${token}` }, signal: abortCtrl.signal })
        .then(r => r.json())
        .then(d => {
          const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
          const msgs = (d.messages || []).map((m: any) => ({
            id: uid(), role: m.role, type: m.type, content: m.content, name: m.name,
            ts: m.ts ? new Date(m.ts).getTime() : Date.now(),
          }));
          setSessionMessages(prev => [...msgs, ...prev.filter(m => m.pending)]);
          sessionCache.current.set(selectedSession.id, msgs);
          sessionCacheTs.current.set(selectedSession.id, Date.now());
        })
        .catch(() => {});
    };
    if (freshCache) {
      idleCbHandle = typeof requestIdleCallback !== 'undefined'
        ? requestIdleCallback(doFetch, { timeout: 5000 })
        : setTimeout(doFetch, 100);
    } else {
      doFetch();
    }
    // Subscribe socket for live updates
    let displayRefreshed = false;
    const onSessionMsg = (msg: Message) => {
      setSessionMessages(prev => {
        // Streaming: update last agent text in-place
        if (msg.role === 'agent' && msg.type === 'text') {
          const lastIdx = prev.length - 1;
          if (lastIdx >= 0 && prev[lastIdx].role === 'agent' && prev[lastIdx].type === 'text') {
            const next = [...prev];
            next[lastIdx] = { ...next[lastIdx], content: msg.content };
            return next;
          }
        }
        return [...prev, msg];
      });
      // Track processing state for other sessions (mirrors main session logic)
      if (msg.role === 'agent' || msg.type === 'tool' || msg.type === 'thinking') setSessionIsProcessing(true);
      if (msg.type === 'status' && msg.content.includes('done')) setSessionIsProcessing(false);
      if (msg.type === 'status' && msg.content.includes('exit')) setSessionIsProcessing(false);
      if (msg.type === 'error') setSessionIsProcessing(false);
      // Detect compaction from status messages
      if (msg.type === 'status' && /compact/i.test(msg.content)) {
        setSessionIsCompacting(true);
        if (sessionCompactTimer.current) clearTimeout(sessionCompactTimer.current);
        sessionCompactTimer.current = setTimeout(() => setSessionIsCompacting(false), 8000);
      }
      clearTimeout(sessionIdleTimer.current);
      sessionIdleTimer.current = setTimeout(() => setSessionIsProcessing(false), 30000);
      // After first agent response, generate title via Haiku if missing
      if (!displayRefreshed && msg.role === 'agent' && msg.type === 'text') {
        displayRefreshed = true;
        const titleToken = selectedSession.relayToken || localStorage.getItem('morph-auth') || '';
        const titleBase = selectedSession.relayUrl || '';
        fetch(`${titleBase}/v2/claude/title`, {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${titleToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessionId: selectedSession.id }),
        })
          .then(r => r.json())
          .then(d => {
            if (d.title) setSelectedSession(prev => prev ? { ...prev, display: d.title } : prev);
          })
          .catch(() => {});
      }
    };
    subscribeSessionMessages(selectedSession.id, onSessionMsg);
    // Pre-fetch alive status; hydrate liveSessionIdRef from any existing resumed process
    fetch(`${base}/v2/claude/active`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        const sid = selectedSession.id;
        const sessions: any[] = d.sessions || [];
        // Find most recently started process that is (or was resumed from) this session
        const resumed = sessions
          .filter((s: any) => (s.resumedFrom === sid || s.id === sid) && s.alive)
          .sort((a: any, b: any) => b.startedAt - a.startedAt)[0];
        if (resumed) {
          liveSessionIdRef.current = resumed.id;
          sessionAliveCache.current.set(resumed.id, { alive: true, ts: Date.now() });
          // Register resumed process to the same relay — prevents cross-env leak
          if (resumed.id !== sid && selectedSession.envId && selectedSession.envId !== 'workspace') {
            registerSession(resumed.id, selectedSession.envId);
          }
          // Re-subscribe to the live process ID so we receive its output
          if (resumed.id !== sid) subscribeSessionMessages(resumed.id, onSessionMsg);
        } else {
          sessionAliveCache.current.set(sid, { alive: false, ts: Date.now() });
        }
      })
      .catch(() => {});
    return () => {
      abortCtrl.abort();
      if (idleCbHandle !== null) {
        typeof cancelIdleCallback !== 'undefined'
          ? cancelIdleCallback(idleCbHandle as number)
          : clearTimeout(idleCbHandle as ReturnType<typeof setTimeout>);
      }
      unsubscribeSessionMessages();
      clearTimeout(sessionIdleTimer.current);
      if (sessionCompactTimer.current) clearTimeout(sessionCompactTimer.current);
    };
  }, [selectedSession?.id]);

  // Keep sessionCache in sync so re-entry shows latest messages
  useEffect(() => {
    if (selectedSession && sessionMessages.length > 0) {
      sessionCache.current.set(selectedSession.id, sessionMessages);
      sessionCacheTs.current.set(selectedSession.id, Date.now());
    }
  }, [sessionMessages, selectedSession?.id]);

  useEffect(() => {
    if (!authed) return;
    const MAX_MESSAGES = 500;
    const unsub1 = onMessage((msg) => {
      setMessages(prev => {
        // If this is a confirmation of a pending message, update it in-place
        if (msg.role === 'user' && msg.pending === false) {
          const idx = prev.findIndex(m => m.id === msg.id && m.pending);
          if (idx !== -1) {
            const next = [...prev];
            next[idx] = { ...next[idx], pending: false };
            return next;
          }
          return prev; // already confirmed or not found
        }
        // Streaming: update last agent text message in-place (partial messages)
        if (msg.role === 'agent' && msg.type === 'text') {
          const lastIdx = prev.length - 1;
          if (lastIdx >= 0 && prev[lastIdx].role === 'agent' && prev[lastIdx].type === 'text') {
            const next = [...prev];
            next[lastIdx] = { ...next[lastIdx], content: msg.content };
            return next;
          }
        }
        const next = [...prev, msg];
        return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
      });
      if (msg.role === 'agent' || msg.type === 'tool' || msg.type === 'thinking') setIsProcessing(true);
      // Only stop processing on explicit done/exit signals
      if (msg.type === 'status' && msg.content.includes('done')) setIsProcessing(false);
      if (msg.type === 'status' && msg.content.includes('exit')) setIsProcessing(false);
      if (msg.type === 'error') setIsProcessing(false);
      // Detect compaction from status messages (belt-and-suspenders — relay also emits claude-compact)
      if (msg.type === 'status' && /compact/i.test(msg.content)) {
        setIsCompacting(true);
        if (compactTimer.current) clearTimeout(compactTimer.current);
        compactTimer.current = setTimeout(() => setIsCompacting(false), 8000);
      }
      // Fallback: 30s idle timeout
      clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setIsProcessing(false), 30000);
    });
    const unsub2 = onState(setConnState);
    // Offline notification: fire once when relay stays unreachable for 8s
    let offlineTimer: ReturnType<typeof setTimeout> | null = null;
    let wasOfflineNotified = false;
    const unsub2b = onState((s) => {
      if (s === 'connected') {
        if (offlineTimer) { clearTimeout(offlineTimer); offlineTimer = null; }
        wasOfflineNotified = false;
      } else if (!wasOfflineNotified) {
        if (!offlineTimer) {
          offlineTimer = setTimeout(() => {
            wasOfflineNotified = true;
            // Browser notification
            if (Notification.permission === 'granted') {
              new Notification('Morph', { body: 'Mac is offline', icon: '/icon-192-v4.png', tag: 'morph-offline' });
            }
          }, 8000);
        }
      }
    });
    const unsub3 = onCompact(() => {
      setIsCompacting(true);
      if (compactTimer.current) clearTimeout(compactTimer.current);
      compactTimer.current = setTimeout(() => setIsCompacting(false), 8000);
    });
    connect();
    return () => { unsub1(); unsub2(); unsub2b(); unsub3(); clearTimeout(idleTimer.current); if (compactTimer.current) clearTimeout(compactTimer.current); };
  }, [authed]);

  const [terminalVisible, setTerminalVisible] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(40); // percentage
  const [hasNew, setHasNew] = useState(false);
  const [inputBarHeight, setInputBarHeight] = useState(84);
  const prevCount = useRef(0);
  const dragging = useRef(false);
  const hasMoved = useRef(false);
  const latestClientY = useRef(0);
  const dragStartY = useRef(0);
  const dragStartH = useRef(40);
  const dragCurrentH = useRef(40);
  const rafPending = useRef(false);
  const terminalDivRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (messages.length > prevCount.current && !terminalVisible && isProcessing) setHasNew(true);
    prevCount.current = messages.length;
  }, [messages.length, terminalVisible, isProcessing]);

  useEffect(() => { if (!isProcessing) setHasNew(false); }, [isProcessing]);

  // Capture input bar height when attach menu opens — avoids getBoundingClientRect during render
  useEffect(() => {
    if (mainFlow.attachMenu && inputBarRef.current) {
      setInputBarHeight(inputBarRef.current.offsetHeight);
    }
  }, [mainFlow.attachMenu]);

  const toggleTerminal = () => { setTerminalVisible(v => !v); setHasNew(false); };

  const handleTab = (t: string) => { setTab(t); setCurrentTab(t); if (t === 'config') { setTerminalVisible(false); setHasVisitedConfig(true); } };

  const handleSend = useCallback((text: string) => {
    if (text === '/clear') { setMessages([]); setIsProcessing(false); clearSession(); mainFlow.clearPending(); return; }
    if (selectedSession) {
      const envId = selectedSession.envId || 'workspace';
      mainFlow.handleSend(`[ctx: ${selectedSession.display} · ${envId} · ${selectedSession.id.slice(0, 8)}]\n${text}`);
    } else {
      mainFlow.handleSend(text);
      setTerminalVisible(true); // auto-expand terminal so user sees the response
    }
  }, [selectedSession, mainFlow]);

  if (!authed) return <PasswordGate onAuth={() => setAuthed(true)} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', maxWidth: 600, margin: '0 auto', width: '100%' }}>
      {/* Offline / reconnecting banner */}
      {connState !== 'connected' && <OfflineBanner />}
      {/* Content area — tab-specific, always full height */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
        {/* Canvas view */}
        <div style={{ flex: 1, display: tab === 'canvas' ? 'flex' : 'none', position: 'relative' }}>
          {/* Usage widget — top right */}
          <UsageWidget />
          {/* Session cards — floating overlay */}
          <SessionCards
            onSelect={(sid, display, relayUrl, relayToken, project, envId, textPreview) => {
              setSessionMessages(sessionCache.current.get(sid) || []);
              sessionSendQueue.current = [];
              sessionSendBusy.current = false;
              setSelectedSession({ id: sid, display: display || sid.slice(0, 8), relayUrl, relayToken, project, envId, textPreview } as any);
            }}
            onNewSession={(envId, relayUrl, relayToken) => {
              // Use FIXED_SESSION_ID so phone always routes through terminal wrapper
              const sid = FIXED_SESSION_ID;
              if (envId !== 'workspace') registerSession(sid, envId);
              // Bust session cache so returning to canvas shows the new session immediately
              envSessionsCache.clear();
              setSessionMessages([]);
              liveSessionIdRef.current = null;
              sessionSendQueue.current = [];
              sessionSendBusy.current = false;
              setSelectedSession({ id: sid, display: 'Terminal', relayUrl, relayToken, envId, isNew: true });
            }}
          />
          {/* Canvas iframe — fills full area */}
          <div style={{ flex: 1, position: 'relative', backgroundColor: 'var(--bg-primary)' }}>
            {!canvasLoaded && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: 'var(--bg-primary)', zIndex: 1 }}>
                <div style={{ width: 120, height: 2, borderRadius: 1, backgroundColor: 'var(--bg-input)', overflow: 'hidden' }}>
                  <div style={{ width: '40%', height: '100%', backgroundColor: 'var(--bar-fill)', borderRadius: 1, animation: 'canvasLoad 1.2s ease-in-out infinite' }} />
                </div>
                <style>{`@keyframes canvasLoad { 0% { transform: translateX(-120%); } 100% { transform: translateX(300%); } }`}</style>
              </div>
            )}
            <iframe src={`/canvas.html?v=${BUILD_TS}`} onLoad={() => setCanvasLoaded(true)} style={{ width: '100%', height: '100%', border: 'none', backgroundColor: 'var(--bg-primary)', willChange: 'transform' }} sandbox="allow-scripts allow-same-origin" />
          </div>
        </div>

        {/* Drafts content */}
        <div style={{ flex: 1, display: tab === 'drafts' ? 'flex' : 'none', overflow: 'hidden', flexDirection: 'column' }}>
          <DraftsTab />
        </div>

        {/* Config content — lazy-mounted: only rendered after first visit */}
        {hasVisitedConfig && <div style={{ flex: 1, display: tab === 'config' ? 'flex' : 'none', overflow: 'hidden', flexDirection: 'column' }}>
          <ConfigTab connState={connState} />
        </div>}

        {/* Origin Terminal — always on top of Canvas UI */}
        <div ref={terminalDivRef} style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 10,
          height: `${terminalHeight}%`,
          transform: terminalVisible ? 'translateY(0)' : 'translateY(100%)',
          transition: dragging.current ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          willChange: 'transform',
          display: 'flex', flexDirection: 'column',
          backgroundColor: 'var(--bg-secondary)',
          borderTopLeftRadius: 12, borderTopRightRadius: 12,
          boxShadow: terminalVisible ? '0 -4px 20px rgba(0,0,0,0.5)' : 'none',
        }}>
          {/* Drag handle bar — drag to resize, tap to collapse */}
          <div
            onClick={(e) => { if (!hasMoved.current) toggleTerminal(); }}
            onTouchStart={(e) => {
              dragging.current = true;
              hasMoved.current = false;
              dragStartY.current = e.touches[0].clientY;
              latestClientY.current = e.touches[0].clientY;
              const domH = parseFloat(terminalDivRef.current?.style.height ?? '') || terminalHeight;
              dragStartH.current = domH;
              dragCurrentH.current = domH;
            }}
            onTouchMove={(e) => {
              if (!dragging.current) return;
              hasMoved.current = true;
              latestClientY.current = e.touches[0].clientY;
              if (rafPending.current) return;
              rafPending.current = true;
              requestAnimationFrame(() => {
                rafPending.current = false;
                const containerH = (window.innerHeight || document.documentElement.clientHeight || 600);
                const dy = dragStartY.current - latestClientY.current;
                const newH = Math.max(5, Math.min(95, dragStartH.current + (dy / containerH * 100)));
                dragCurrentH.current = newH;
                if (terminalDivRef.current) terminalDivRef.current.style.height = `${newH}%`;
              });
            }}
            onTouchEnd={() => {
              const h = dragCurrentH.current;
              if (hasMoved.current) {
                if (h < 8) { setTerminalVisible(false); }
                else { setTerminalHeight(h); }
              }
              dragging.current = false;
            }}
            style={{
              display: 'flex', justifyContent: 'center', alignItems: 'center',
              padding: '10px 0 6px', cursor: 'grab', flexShrink: 0, touchAction: 'none',
              backgroundColor: 'var(--bg-hover)', borderBottom: '1px solid var(--border)',
            }}
          >
            <div style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: 'var(--scrollbar-thumb)' }} />
          </div>
          <div style={{ flex: '1 1 0', minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
            <TerminalOverlay messages={messages} visible={true} />
            <PermissionBanner messages={messages} sessionId={FIXED_SESSION_ID} />
            {/* ESC — floating overlay at bottom-right of terminal */}
            {(() => { const w = isCompacting ? 'compacting...' : isProcessing ? IDLE_WORDS[Math.floor(Date.now() / 4000) % IDLE_WORDS.length] : 'idle'; return (
            <div style={{
              position: 'absolute', bottom: 4, right: 8,
              display: 'flex', alignItems: 'center', gap: 6,
              pointerEvents: 'none',
            }}>
              <span style={{ color: isCompacting ? 'var(--accent)' : 'var(--text-tertiary)', fontSize: 11, fontFamily: 'Menlo, monospace' }}>
                {w}
              </span>
              <button tabIndex={-1} onPointerDown={(e) => { e.preventDefault(); interrupt(); }} style={{
                padding: '3px 10px', borderRadius: 5, cursor: 'pointer', flexShrink: 0,
                border: isProcessing ? '1px solid var(--danger-border)' : '1px solid var(--border)',
                backgroundColor: isProcessing ? 'var(--danger-bg)' : 'var(--bg-elevated)',
                color: isProcessing ? 'var(--danger)' : 'var(--text-tertiary)', fontSize: 11, fontFamily: 'Menlo, monospace',
                pointerEvents: 'auto', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' as any,
              }}>ESC</button>
            </div>
            ); })()}
          </div>
        </div>
      </div>

      {/* Shared InputBar — keep mounted to preserve draft text; hidden when session terminal is open */}
      <div ref={inputBarRef} style={selectedSession ? { display: 'none' } : undefined}>
        <InputBar
          onSend={handleSend} onStop={interrupt}
          isProcessing={isProcessing} connected={connState === 'connected'}
          terminalVisible={terminalVisible} onToggleTerminal={toggleTerminal}
          hasNew={hasNew} onAttach={mainFlow.toggleAttach} onSketch={() => mainFlow.setSketchOpen(true)}
          pendingSketch={mainFlow.pendingSketch ? mainFlow.pendingSketch.dataUrl : null}
          pendingFile={mainFlow.pendingFile ? (mainFlow.pendingFile.isImage ? 'image' : 'file') : null}
          onClearPending={mainFlow.clearPending}
          keyboardOpen={keyboardOpen}
          isUploading={mainFlow.isUploading}
          storageKey="morph-draft-main"
        />
      </div>
      {!keyboardOpen && !selectedSession && <TabBar tab={tab} onTab={handleTab} />}
      {/* Attach menu — frosted glass popup with Framer Motion */}
      <AnimatePresence>
        {mainFlow.attachMenu && (<>
          <motion.div
            key="attach-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => mainFlow.setAttachMenu(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 998 }}
          />
          <motion.div
            key="attach-menu"
            initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.3, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 25 }}
            style={{
              position: 'absolute',
              bottom: inputBarHeight + (keyboardOpen ? 8 : 36),
              left: 12, zIndex: 999,
              backgroundColor: 'var(--bg-elevated)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
              borderRadius: 14, padding: '4px 0', minWidth: 200,
              boxShadow: '0 8px 40px rgba(0,0,0,0.6)', border: '1px solid var(--border)',
              transformOrigin: 'bottom left',
            }}
          >
            {[
              { label: 'Add Photo', icon: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>), action: () => mainFlow.uploadFile('image/*') },
              { label: 'Attach File', icon: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>), action: () => mainFlow.uploadFile('.pdf,.md,.txt,.csv,.json,.py,.js,.ts,.jsx,.tsx') },
              { label: 'Sketch', icon: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>), action: () => { mainFlow.setAttachMenu(false); mainFlow.setSketchOpen(true); } },
            ].map((item, i) => (
              <motion.div key={item.label}
                initial={{ opacity: 0, x: -10 }} animate={{ opacity: 1, x: 0 }}
                transition={{ delay: i * 0.06, type: 'spring', stiffness: 400, damping: 20 }}
              >
                {i > 0 && <div style={{ height: 1, backgroundColor: 'var(--bg-input)', margin: '0 12px' }} />}
                <button tabIndex={-1} onClick={item.action} style={{
                  display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                  padding: '11px 16px', border: 'none', cursor: 'pointer', borderRadius: 0,
                  backgroundColor: 'transparent', color: 'var(--text-primary)',
                  fontSize: 15, textAlign: 'left', fontFamily: '-apple-system, system-ui, sans-serif',
                }}><span style={{ color: 'var(--text-secondary)', display: 'flex' }}>{item.icon}</span> {item.label}</button>
              </motion.div>
            ))}
          </motion.div>
        </>)}
      </AnimatePresence>
      {mainFlow.sketchOpen && createPortal(
        <Sketch onInsert={mainFlow.handleSketchInsert} onClose={() => mainFlow.setSketchOpen(false)} />,
        document.body
      )}

      {/* Session Terminal — slides in from right, swipe back to dismiss */}
      <AnimatePresence>
        {selectedSession && (
          <SessionTerminal
            session={selectedSession}
            messages={sessionMessages}
            isProcessing={sessionIsProcessing}
            isCompacting={sessionIsCompacting || isCompacting}
            onBack={() => { envSessionsCache.clear(); setSelectedSession(null); }}
            onInterrupt={() => interruptSession(liveSessionIdRef.current || selectedSession.id)}
            onRawKey={isTTYId(selectedSession.id) ? (key: string) => sendRawKeyToTTY(parseTTYId(selectedSession.id), key) : undefined}
            onSend={async (text) => {
              // TTY-based session: send via direct-send { tty, message }
              // No local echo — PTY will echo the input naturally
              if (isTTYId(selectedSession.id)) {
                if (text === '/clear') {
                  // Clear local + forward to terminal
                  setSessionMessages([]);
                  sessionCache.current.delete(selectedSession.id);
                  setSessionIsProcessing(false);
                }
                const tty = parseTTYId(selectedSession.id);
                sendToTTY(tty, text);
                setSessionIsProcessing(true);
                return;
              }
              if (text === '/clear') {
                setSessionMessages([]);
                sessionCache.current.delete(selectedSession.id);
                setSessionIsProcessing(false);
                return;
              }
              // Show user message immediately
              const msgId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              setSessionMessages(prev => [...prev, { id: msgId, role: 'user', type: 'text', content: text, ts: Date.now(), pending: true }]);

              // Capture session snapshot for the queued closure
              const snapSession = selectedSession;

              const doSend = async () => {
                const _DEBUG_NEW_SESSION = false;
                const _log = (s: string) => { if (_DEBUG_NEW_SESSION) console.log(`[new-session] ${s}`); };
                try {
                  const liveId = liveSessionIdRef.current || snapSession.id;
                  const token = snapSession.relayToken || localStorage.getItem('morph-auth') || '';
                  const base = snapSession.relayUrl || '';

                  // SAFETY: ensure relay mapping exists before sending — prevents cross-env leak
                  if (snapSession.envId && snapSession.envId !== 'workspace') {
                    registerSession(liveId, snapSession.envId);
                    registerSession(snapSession.id, snapSession.envId);
                  }

                  _log(`doSend start | isNew=${snapSession.isNew} | liveId=${liveId} | snapId=${snapSession.id} | base=${base} | text=${text.slice(0,40)}`);

                  if (snapSession.isNew) {
                    _log(`NEW PATH → sendToSession(${snapSession.id})`);
                    await sendToSession(snapSession.id, text);
                    _log(`NEW PATH → sendToSession OK`);
                    liveSessionIdRef.current = snapSession.id;
                    sessionAliveCache.current.set(snapSession.id, { alive: true, ts: Date.now(), terminal: snapSession.id === FIXED_SESSION_ID });
                    setSelectedSession(prev => prev ? { ...prev, isNew: false } : prev);
                    _log(`NEW PATH → isNew cleared, liveId set`);
                  } else {
                  const ALIVE_TTL = 5_000;
                  const TERMINAL_ALIVE_TTL = 30_000; // terminal wrapper sessions are long-lived
                  const cachedAlive = sessionAliveCache.current.get(liveId);
                  const aliveFast = cachedAlive && Date.now() - cachedAlive.ts < (cachedAlive.terminal ? TERMINAL_ALIVE_TTL : ALIVE_TTL) && cachedAlive.alive;
                  _log(`EXISTING PATH | aliveFast=${!!aliveFast} | cachedAlive=${JSON.stringify(cachedAlive)}`);
                  if (aliveFast) {
                    _log(`ALIVE FAST → sendToSession(${liveId})`);
                    await sendToSession(liveId, text);
                  } else {
                    _log(`CHECKING /active for liveId=${liveId}`);
                    const checkRes = await fetch(`${base}/v2/claude/active`, { headers: { 'Authorization': `Bearer ${token}` } });
                    const checkData = await checkRes.json();
                    const alive = (checkData.sessions || []).find((s: any) => s.id === liveId && s.alive);
                    _log(`/active result: alive=${!!alive} terminal=${alive?.terminal} | sessions=${JSON.stringify(checkData.sessions?.map((s:any)=>s.id))}`);
                    if (alive) {
                      sessionAliveCache.current.set(liveId, { alive: true, ts: Date.now(), terminal: !!alive.terminal });
                      _log(`ALIVE → sendToSession(${liveId})`);
                      await sendToSession(liveId, text);
                    } else {
                      _log(`DEAD → resumeSession(${snapSession.id})`);
                      const newSid = await resumeSession(snapSession.id, text);
                      _log(`RESUMED → newSid=${newSid}`);
                      liveSessionIdRef.current = newSid;
                      sessionAliveCache.current.set(newSid, { alive: true, ts: Date.now() });
                      if (newSid !== snapSession.id) {
                        _log(`SID CHANGED → subscribing to ${newSid}`);
                        // Register new SID to same relay — prevents cross-env leak
                        if (snapSession.envId && snapSession.envId !== 'workspace') {
                          registerSession(newSid, snapSession.envId);
                        }
                        subscribeSessionMessages(newSid, (msg) => {
                          setSessionMessages(prev => {
                            if (msg.role === 'agent' && msg.type === 'text') {
                              const lastIdx = prev.length - 1;
                              if (lastIdx >= 0 && prev[lastIdx].role === 'agent' && prev[lastIdx].type === 'text') {
                                const next = [...prev];
                                next[lastIdx] = { ...next[lastIdx], content: msg.content };
                                return next;
                              }
                            }
                            return [...prev, msg];
                          });
                        });
                      }
                    }
                  }
                  } // end else (!isNew)
                  _log(`DONE → confirming sent`);
                  setSessionMessages(prev => prev.map(m => m.id === msgId ? { ...m, pending: false } : m));
                } catch (err: any) {
                  _log(`ERROR → ${(err as Error).message}`);
                  setSessionMessages(prev => [...prev, { id: `${Date.now()}`, role: 'system', type: 'error', content: (err as Error).message || 'Send failed', ts: Date.now() }]);
                }
              };

              // Serialize sends — prevents concurrent resume race when session is dead
              sessionSendQueue.current.push(doSend);
              if (!sessionSendBusy.current) {
                sessionSendBusy.current = true;
                while (sessionSendQueue.current.length > 0) {
                  const fn = sessionSendQueue.current.shift()!;
                  await fn();
                }
                sessionSendBusy.current = false;
              }
            }}
            keyboardOpen={keyboardOpen}
          />
        )}
      </AnimatePresence>

      {/* Add to Home Screen nudge — shown once in Safari browser (not standalone PWA) */}
      {(() => {
        const isSafari = /iphone|ipad/i.test(navigator.userAgent) && !(window.navigator as any).standalone;
        const dismissed = localStorage.getItem('morph-a2hs-dismissed');
        if (!isSafari || dismissed) return null;
        return (
          <div style={{
            position: 'fixed', bottom: 0, left: 0, right: 0, zIndex: 9999,
            background: 'var(--bg-elevated)', backdropFilter: 'blur(12px)',
            borderTop: '1px solid var(--border-strong)',
            padding: '14px 16px', paddingBottom: 'max(14px, env(safe-area-inset-bottom))',
            display: 'flex', alignItems: 'flex-start', gap: 12,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: 'var(--text-primary)', fontSize: 14, fontWeight: 600, marginBottom: 3 }}>Add Morph to Home Screen</div>
              <div style={{ color: 'var(--text-secondary)', fontSize: 12, lineHeight: '16px' }}>
                Tap <svg style={{ display: 'inline', verticalAlign: 'middle', margin: '0 2px' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v13M7 7l5-5 5 5"/><path d="M3 17v3a1 1 0 001 1h16a1 1 0 001-1v-3"/></svg> Share, then "Add to Home Screen" for a better experience.
              </div>
            </div>
            <button onClick={() => { localStorage.setItem('morph-a2hs-dismissed', '1'); window.location.reload(); }} style={{
              background: 'none', border: 'none', color: 'var(--text-tertiary)', fontSize: 20, cursor: 'pointer',
              padding: '0 4px', lineHeight: 1, flexShrink: 0,
            }}>×</button>
          </div>
        );
      })()}
    </div>
  );
}
