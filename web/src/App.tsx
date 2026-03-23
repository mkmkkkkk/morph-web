import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useMotionValue } from 'framer-motion';
import { connect, send, interrupt, interruptSession, clearSession, setCurrentTab, fetchSessions, onMessage, onState, onCompact, getState, sendToSession, resumeSession, isSessionAlive, loadHistory, subscribe, subscribeSessionMessages, unsubscribeSessionMessages, addRelay, registerSession, approvePermission, denyPermission, stopSession, type Message, type RelayConfig } from './lib/connection';
import Sketch from './components/Sketch';

// Cache-bust canvas.html per build (not per page load) — allows HTTP caching across reloads
declare const __BUILD_TIME__: string;
const BUILD_TS = typeof __BUILD_TIME__ !== 'undefined' ? __BUILD_TIME__ : Date.now().toString(36);

// Module-level constant — avoids array allocation on every render
const IDLE_WORDS = ['thinking...', 'pondering...', 'wondering...', 'reasoning...', 'considering...', 'analyzing...', 'processing...'];

// ─── Remote debug logger — sends to relay /v2/debug/log, read via /v2/debug/logs ───
const _dbgQueue: string[] = [];
function dbg(msg: string) {
  const ts = new Date().toLocaleTimeString('en', { hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit', fractionalSecondDigits: 3 } as any);
  _dbgQueue.push(`${ts} ${msg}`);
}
// Flush every 2s
setInterval(() => {
  if (_dbgQueue.length === 0) return;
  const batch = _dbgQueue.splice(0);
  const relay = localStorage.getItem('morph-relay-url') || '';
  const token = localStorage.getItem('morph-auth') || '';
  fetch(`${relay}/v2/debug/log`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ lines: batch }),
  }).catch(() => {});
}, 2000);

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
      <div style={{ color: '#fff', fontSize: 48, fontFamily: "'CloisterBlack', serif", opacity: 0.8 }}>M</div>
      <div style={{ color: '#888', fontSize: 14, marginTop: -8 }}>Morph</div>
      <input type="password" value={pass}
        onChange={e => { setPass(e.target.value); setError(''); }}
        onKeyDown={e => { if (e.key === 'Enter') handleSubmit(); }}
        placeholder="Password"
        style={{ width: '100%', maxWidth: 300, padding: '12px 16px', borderRadius: 12, border: '1px solid rgba(255,255,255,0.1)', backgroundColor: '#1c1c1e', color: '#fff', fontSize: 16, outline: 'none', textAlign: 'center' }}
      />
      {error && <div style={{ color: '#ff453a', fontSize: 14 }}>{error}</div>}
      <button onClick={handleSubmit} style={{ padding: '10px 32px', borderRadius: 12, border: 'none', backgroundColor: '#333', color: '#fff', fontSize: 16, cursor: 'pointer' }}>Enter</button>
    </div>
  );
}

// ─── Collapsible Block ───
function Collapsible({ label, preview, content, color }: { label: string; preview?: string; content: string; color: string }) {
  const [open, setOpen] = useState(false);
  return (
    <div style={{ marginBottom: 2, overflow: 'hidden', maxWidth: '100%' }}>
      <div style={{ color, fontSize: 13, fontFamily: 'Menlo, monospace', lineHeight: '20px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', userSelect: 'none', WebkitUserSelect: 'none' as any, padding: '0 12px', display: 'flex', alignItems: 'center' }}>
        <span onPointerDown={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setOpen(!open);
        }} style={{ cursor: 'pointer', padding: '4px 8px 4px 0', flexShrink: 0, touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' as any }}>{open ? '▾' : '▸'}</span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{label}{!open && preview ? `: ${preview}` : ''}</span>
      </div>
      {open && <pre style={{ color, opacity: 0.7, fontSize: 13, fontFamily: 'Menlo, monospace', lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', overflow: 'hidden', maxWidth: '100%', margin: 0, padding: '0 12px 0 28px', userSelect: 'none', WebkitUserSelect: 'none' as any }}>{
        content.split('\n').map((line, i, arr) => (
          <React.Fragment key={i}><span data-sel style={{ userSelect: 'text', WebkitUserSelect: 'text' } as any}>{line}</span>{i < arr.length - 1 && '\n'}</React.Fragment>
        ))
      }</pre>}
    </div>
  );
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
        ? <div style={{ ...monoOuter, color: '#30d158', marginBottom: 3, opacity: msg.pending ? 0.5 : 1 }}><span style={sel} data-sel>&gt; {msg.content}</span></div>
        : <div style={{ ...monoOuter, color: '#e0e0e0', marginBottom: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{
            msg.content.split('\n').map((line, i) => (
              <React.Fragment key={i}>
                {line === ''
                  ? <div style={{ height: '10px', userSelect: 'none', WebkitUserSelect: 'none' } as any} />
                  : <span style={sel} data-sel>{line}</span>
                }
              </React.Fragment>
            ))
          }</div>;
    case 'thinking':
      return <Collapsible label="thinking" preview={msg.content.slice(0, 60)} content={msg.content} color="#636366" />;
    case 'tool':
      return <Collapsible label={msg.name || 'tool'} preview={msg.content.slice(0, 80).replace(/\n/g, ' ')} content={msg.content} color="#636366" />;
    case 'tool_result':
      return <Collapsible label="result" preview={msg.content.slice(0, 80).replace(/\n/g, ' ')} content={msg.content.length > 2000 ? msg.content.slice(0, 2000) + '\n...' : msg.content} color="#48484a" />;
    case 'status':
      return msg.content.length > 120
        ? <Collapsible label="status" preview={msg.content.slice(0, 80).replace(/\n/g, ' ')} content={msg.content} color="#555" />
        : <div style={{ ...monoOuter, color: '#777', textAlign: 'center', marginTop: 4, marginBottom: 4 }}><span style={sel} data-sel>{msg.content}</span></div>;
    case 'error':
      return msg.content.length > 120
        ? <Collapsible label="error" preview={msg.content.slice(0, 80).replace(/\n/g, ' ')} content={msg.content} color="#ff453a" />
        : <div style={{ ...monoOuter, color: '#ff453a', marginBottom: 3 }}><span style={sel} data-sel>{msg.content}</span></div>;
    case 'permission' as any:
      return <div style={{ ...monoOuter, color: '#e0a030', marginBottom: 3, fontSize: 12 }}>
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
      backgroundColor: 'rgba(20,20,20,0.97)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
      borderBottom: '1px solid rgba(255,180,48,0.3)',
    }}>
      <div style={{ flex: 1, overflow: 'hidden', minWidth: 0 }}>
        <div style={{ color: '#e0a030', fontSize: 13, fontWeight: 600, fontFamily: 'Menlo, monospace' }}>
          {toolName}
        </div>
        {preview && <div style={{ color: '#888', fontSize: 11, fontFamily: 'Menlo, monospace', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', marginTop: 2 }}>
          {preview}
        </div>}
      </div>
      <button onPointerDown={handleDeny} style={{
        padding: '8px 16px', borderRadius: 8, cursor: 'pointer', flexShrink: 0,
        border: '1px solid rgba(255,59,48,0.4)', backgroundColor: 'rgba(255,59,48,0.12)',
        color: '#ff453a', fontSize: 14, fontWeight: 700,
        fontFamily: '-apple-system, system-ui, sans-serif',
        touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent',
      }}>Deny</button>
      <button onPointerDown={handleApprove} style={{
        padding: '8px 20px', borderRadius: 8, cursor: 'pointer', flexShrink: 0,
        border: '1px solid rgba(48,209,88,0.4)', backgroundColor: 'rgba(48,209,88,0.12)',
        color: '#30d158', fontSize: 14, fontWeight: 700,
        fontFamily: '-apple-system, system-ui, sans-serif',
        touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent',
      }}>Approve</button>
    </div>
  );
}

// ─── Terminal Overlay (toggle-able, sits above input bar) ───
function TerminalOverlay({ messages, visible }: { messages: Message[]; visible: boolean }) {
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
      borderTop: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#111',
      WebkitOverflowScrolling: 'touch' as any,
      userSelect: 'none', WebkitUserSelect: 'none' as any,
      WebkitTouchCallout: 'none' as any,
      WebkitTapHighlightColor: 'transparent',
    }}>
      {/* Spacer pushes content to bottom when messages don't fill the container */}
      <div style={{ flex: '1 1 0' }} />
      <div style={{ padding: '8px 0' }}>
        {messages.length === 0
          ? <div style={{ color: '#4a4a4a', fontSize: 13, textAlign: 'center', padding: 16, fontFamily: 'Menlo, monospace' }}>waiting for session...</div>
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
  const accent = isSession ? '#e0a030' : '#30d158';
  const dotColor = connected ? '#30d158' : '#636366'; // always green for online
  const inputBg = isSession ? '#1e1c14' : '#1c1c1e';
  const sendBg = isSession ? '#b8860b' : '#333';
  const borderTint = isSession ? 'rgba(224,160,48,0.15)' : 'rgba(255,255,255,0.10)';

  return (
    <div style={{ borderTop: `1px solid ${borderTint}`, padding: keyboardOpen ? '8px 10px 2px' : '6px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
      {/* Connection dot */}
      <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor, flexShrink: 0 }} />

      {/* Terminal toggle — only on main bar */}
      {onToggleTerminal && (
        <button tabIndex={-1} onClick={onToggleTerminal} style={{
          width: 34, height: 34, borderRadius: 17, border: 'none', cursor: 'pointer', flexShrink: 0,
          backgroundColor: 'rgba(255,255,255,0.08)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
          <div style={{
            width: 0, height: 0,
            borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
            ...(terminalVisible
              ? { borderTop: `10px solid ${isProcessing ? accent : hasNew ? '#999' : '#888'}` }
              : { borderBottom: `10px solid ${isProcessing ? accent : hasNew ? '#999' : '#888'}` }),
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
          backgroundColor: (pendingSketch || pendingFile) ? 'rgba(48,209,88,0.2)' : isUploading ? 'rgba(48,209,88,0.12)' : 'rgba(255,255,255,0.08)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
        {isUploading
          ? <span style={{ color: '#30d158', fontSize: 16, lineHeight: '16px' }}>↑</span>
          : pendingSketch
            ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#30d158" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
            : pendingFile === 'image'
              ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#30d158" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
              : pendingFile === 'file'
                ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#30d158" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
                : <span style={{ color: '#888', fontSize: 22, lineHeight: '22px' }}>+</span>}
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
          fontFamily: '-apple-system, system-ui, sans-serif', backgroundColor: inputBg, color: '#fff',
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
        }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={canSend ? '#fff' : '#666'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
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

// Reusable environment group — renders session cards for one environment
function EnvironmentGroup({ env, onSelect, onNewSession, maxVisible, initialExpanded = true }: { env: EnvConfig; onSelect: (sessionId: string, display?: string, relayUrl?: string, relayToken?: string, project?: string, envId?: string) => void; onNewSession?: (envId: string, relayUrl?: string, relayToken?: string) => void; maxVisible?: number; initialExpanded?: boolean }) {
  const [sessions, setSessions] = useState<any[]>([]);
  const [viewed, setViewed] = useState<Set<string>>(getViewed);
  const [pinned, setPinned] = useState<Set<string>>(() => getPinned(env.id));
  const [expanded, setExpanded] = useState(initialExpanded);
  const [visKey, setVisKey] = useState(_visResumeCount);
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
      const filtered = all.filter((s: any) => s.id !== FIXED_SESSION_ID);
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
    if (s.active) return '#30d158';
    if (hasUnread(s)) return '#ffcc00';
    return '#555';
  };
  const borderColor = (s: any) => {
    if (s.active) return 'rgba(48,209,88,0.25)';
    if (hasUnread(s)) return 'rgba(255,204,0,0.2)';
    return 'rgba(255,255,255,0.08)';
  };

  const handleSelect = (id: string) => {
    markViewed(id);
    setViewed(getViewed());
    const s = sessions.find(x => x.id === id);
    // Map session to its relay so socket.io events are routed correctly
    if (env.id !== 'workspace') registerSession(id, env.id);
    onSelect(id, s?.display, env.relayUrl, env.token, s?.project, env.id);
  };

  const activeCount = sessions.filter(s => s.active).length;
  const unviewedCount = sessions.filter(s => !s.active && !viewed.has(s.id)).length;

  return (
    <div style={{ marginBottom: 12, pointerEvents: 'none', userSelect: 'none' }}>
      <div
        onClick={() => setExpanded(v => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: expanded ? 6 : 0, cursor: 'pointer', pointerEvents: 'auto' }}
      >
        <span style={{ color: '#777', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
          {env.label} ({sessions.length})
        </span>
        {activeCount > 0 && <span style={{ fontSize: 9, color: '#30d158' }}>{activeCount} active</span>}
        {unviewedCount > 0 && <span style={{ fontSize: 9, color: '#ffcc00' }}>{unviewedCount} new</span>}
        <span style={{ color: '#888', fontSize: 10 }}>{expanded ? '▾' : '▸'}</span>
        <span
          onClick={(e) => { e.stopPropagation(); if (window.confirm('Create a new session?')) onNewSession?.(env.id, env.relayUrl, env.token); }}
          style={{ marginLeft: 'auto', color: '#636AFF', fontSize: 20, lineHeight: 1, padding: '6px 10px', margin: '-6px -10px', cursor: 'pointer', userSelect: 'none', pointerEvents: 'auto', WebkitTapHighlightColor: 'transparent' }}
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
              <div style={{ color: '#555', fontSize: 12, padding: '8px 4px' }}>No sessions</div>
            )}
            {sessions.map(s => (
              <motion.div
                key={s.id}
                whileTap={{ scale: 0.98 }}
                onClick={() => handleSelect(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '12px 10px', marginBottom: 4,
                  backgroundColor: 'rgba(28,28,30,0.92)',
                  borderRadius: 10, cursor: 'pointer',
                  border: `1px solid ${borderColor(s)}`,
                }}
              >
                <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotColor(s), flexShrink: 0 }} />
                {pinned.has(s.id) && <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" style={{ flexShrink: 0 }}><path d="M12 17v5M9 2h6l1 7h2l-1 4H7L6 9h2z"/></svg>}
                <span style={{ color: '#ddd', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                  {s.display || s.id.slice(0, 8)}
                </span>
                <span style={{ color: '#777', fontSize: 11, flexShrink: 0 }}>{timeAgo(s.updatedAt)}</span>
                <span onClick={(e) => { e.stopPropagation(); setPinned(togglePin(env.id, s.id)); }} style={{ cursor: 'pointer', padding: '8px 10px', margin: '-8px -10px -8px 0', flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
                  <svg width="14" height="14" viewBox="0 0 24 24" fill={pinned.has(s.id) ? '#888' : 'none'} stroke={pinned.has(s.id) ? '#888' : '#444'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01z"/></svg>
                </span>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
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
  const barColor = '#555';
  const trackColor = 'rgba(255,255,255,0.06)';

  return (
    <div style={{ position: 'absolute', top: 68, right: 12, zIndex: 3, pointerEvents: 'auto' }}>
      <div style={{
        backgroundColor: 'rgba(28,28,30,0.85)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
        borderRadius: 6, padding: '4px 8px', border: '1px solid rgba(255,255,255,0.06)',
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
        {countdown && <div style={{ fontSize: 7, color: '#444', textAlign: 'center' as const, marginTop: 2 }}>{countdown}</div>}
      </div>
    </div>
  );
}

// Canvas overlay — renders all environment groups
function SessionCards({ onSelect, onNewSession }: { onSelect: (sessionId: string, display?: string, relayUrl?: string, relayToken?: string, project?: string, envId?: string) => void; onNewSession?: (envId: string, relayUrl?: string, relayToken?: string) => void }) {
  const [envs, setEnvs] = useState<EnvConfig[]>(getEnvironments);
  useEffect(() => {
    const onStorage = () => setEnvs(getEnvironments());
    window.addEventListener('storage', onStorage);
    // Also poll for same-tab changes (localStorage events don't fire in same tab)
    // Only update state when value actually changed to avoid re-rendering all EnvironmentGroups
    const interval = setInterval(() => {
      const next = getEnvironments();
      setEnvs(prev => JSON.stringify(prev) === JSON.stringify(next) ? prev : next);
    }, 5000);
    return () => { window.removeEventListener('storage', onStorage); clearInterval(interval); };
  }, []);
  return (
    <div style={{ position: 'absolute', top: 90, left: 0, right: 0, bottom: 0, zIndex: 2, padding: '0 8px', overflowY: 'auto', WebkitOverflowScrolling: 'touch' } as React.CSSProperties}>
      {envs.map(env => (
        <EnvironmentGroup key={env.id} env={env} onSelect={onSelect} onNewSession={onNewSession} />
      ))}
    </div>
  );
}

// ─── Config Tab ───
function ConfigTab({ connState, onQuickAction, onRefresh }: { connState: string; onQuickAction: (prompt: string) => void; onRefresh?: () => void }) {
  const [sessions, setSessions] = useState<any[]>([]);
  const [activeSessions, setActiveSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const token = () => localStorage.getItem('morph-auth') || '';
  const headers = () => ({ 'Authorization': `Bearer ${token()}` });

  const loadSessions = async () => {
    setLoading(true);
    try {
      const envs = getEnvironments();
      const mainToken = token();
      // Fetch sessions + active from all environments in parallel
      const results = await Promise.all(envs.map(async (env) => {
        const base = env.relayUrl || '';
        const t = env.token || mainToken;
        const hdrs = { 'Authorization': `Bearer ${t}` };
        try {
          const [sessRes, actRes] = await Promise.all([
            fetch(`${base}/v2/claude/sessions?limit=30`, { headers: hdrs }),
            fetch(`${base}/v2/claude/active`, { headers: hdrs }).catch(() => null),
          ]);
          const sessData = await sessRes.json();
          const actData = actRes ? await actRes.json() : { sessions: [] };
          return {
            env,
            sessions: (sessData.sessions || []).filter((s: any) => s.id !== FIXED_SESSION_ID),
            active: actData.sessions || [],
          };
        } catch { return { env, sessions: [], active: [] }; }
      }));
      // Merge all, tagging with env label
      const allSessions: any[] = [];
      const allActive: any[] = [];
      for (const r of results) {
        for (const s of r.sessions) allSessions.push({ ...s, _envLabel: r.env.label, _envId: r.env.id, _relayUrl: r.env.relayUrl });
        for (const s of r.active) allActive.push({ ...s, _envLabel: r.env.label, _envId: r.env.id, _relayUrl: r.env.relayUrl });
      }
      setSessions(allSessions);
      setActiveSessions(allActive);
    } catch {}
    setLoading(false);
  };

  useEffect(() => {
    loadSessions();
    let iv = setInterval(loadSessions, 30_000);
    // Pause polling while hidden, resume immediately on visible
    const onVis = () => {
      if (document.visibilityState === 'hidden') { clearInterval(iv); }
      else { loadSessions(); iv = setInterval(loadSessions, 30_000); }
    };
    document.addEventListener('visibilitychange', onVis);
    return () => { clearInterval(iv); document.removeEventListener('visibilitychange', onVis); };
  }, []);

  const timeAgo = (ms: number) => {
    const diff = Date.now() - ms;
    if (diff < 60000) return 'just now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
    return `${Math.floor(diff / 86400000)}d ago`;
  };

  return (
    <div style={{ flex: 1, overflowY: 'scroll', padding: 16, paddingTop: 56, minHeight: 0, WebkitOverflowScrolling: 'touch' as any }}>

      <Section title="Connection">
        <Row label="Status" value={connState} valueColor={connState === 'connected' ? '#30d158' : '#ff453a'} />
        <Row label="Server" value={window.location.origin} />
        <button onClick={() => { loadSessions(); if (onRefresh) onRefresh(); }} style={{
          marginTop: 8, padding: '8px 0', border: 'none', borderRadius: 8, cursor: 'pointer',
          fontSize: 13, width: '100%', backgroundColor: 'rgba(99,106,255,0.15)', color: '#636AFF',
        }}>{loading ? '...' : '↻ Refresh'}</button>
      </Section>

      <Section title="Quick Actions">
        {[
          { label: 'Status Check', prompt: 'Give me a brief status update on current work.' },
          { label: 'Git Status', prompt: 'Run git status and summarize.' },
          { label: 'Run Heartbeat', prompt: 'Run heartbeat check and report any overdue jobs.' },
        ].map(a => (
          <button key={a.label} onClick={() => onQuickAction(a.prompt)} style={{
            padding: '10px 0', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, width: '100%', textAlign: 'center',
            backgroundColor: 'rgba(255,255,255,0.10)', color: '#fff', marginBottom: 4,
          }}>{a.label}</button>
        ))}
      </Section>

      <Section title={<span>Sessions <span style={{ color: '#888', fontWeight: 400, fontSize: 11 }}>{loading ? '...' : `${sessions.length}`}</span></span>}>
        <button onClick={loadSessions} style={{ padding: '6px', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 12, width: '100%', backgroundColor: 'rgba(255,255,255,0.08)', color: '#888', marginBottom: 8 }}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
        <div style={{ maxHeight: 320, overflowY: 'auto', WebkitOverflowScrolling: 'touch' as any }}>

        {/* Active sessions first */}
        {activeSessions.map((s: any) => (
          <div key={`${s._envId}-${s.id}`} onClick={() => { if (window.confirm(`Kill session ${s.id.slice(0, 8)}?`)) { if (s._envId && s._envId !== 'workspace') registerSession(s.id, s._envId); stopSession(s.id); setTimeout(loadSessions, 500); } }} style={{ padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#30d158', flexShrink: 0 }} />
              <span style={{ color: '#fff', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                {s.id.slice(0, 8)} — {s.cwd}
              </span>
              <span style={{ color: '#30d158', fontSize: 11 }}>active</span>
              {s._envLabel && <span style={{ color: '#636AFF', fontSize: 10, flexShrink: 0 }}>{s._envLabel}</span>}
            </div>
          </div>
        ))}

        {/* Recent sessions — hide dead sessions (not active + no update in 24h) */}
        {sessions.filter((s: any) => {
          const activeIds = new Set(activeSessions.map((a: any) => a.id));
          if (activeIds.has(s.id)) return true; // still running
          if (s.active) return true;
          // Keep if updated within 24h
          return s.updatedAt && (Date.now() - s.updatedAt < 86400000);
        }).map((s: any) => (
          <div key={`${s._envId}-${s.id}`} onClick={() => { if (window.confirm(`Kill session ${(s.display || s.id).slice(0, 12)}?`)) { if (s._envId && s._envId !== 'workspace') registerSession(s.id, s._envId); stopSession(s.id); setTimeout(loadSessions, 500); } }} style={{ padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.08)', cursor: 'pointer' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: s.active ? '#30d158' : '#555', flexShrink: 0 }} />
              <span style={{ color: '#e0e0e0', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                {s.display || s.id.slice(0, 8)}
              </span>
              {s._envLabel && <span style={{ color: '#636AFF', fontSize: 10, flexShrink: 0 }}>{s._envLabel}</span>}
              <span style={{ color: '#888', fontSize: 11, flexShrink: 0 }}>{timeAgo(s.updatedAt)}</span>
            </div>
          </div>
        ))}
        </div>
      </Section>

      <EnvManagerSection />

      <Section title="Account">
        <button onClick={() => { localStorage.removeItem('morph-auth'); location.reload(); }} style={{
          padding: '10px 0', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, width: '100%', textAlign: 'center',
          backgroundColor: 'rgba(255,59,48,0.15)', color: '#ff453a',
        }}>Logout</button>
      </Section>
    </div>
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
    width: '100%', padding: '8px 10px', borderRadius: 8, border: '1px solid rgba(255,255,255,0.12)',
    backgroundColor: 'rgba(255,255,255,0.06)', color: '#fff', fontSize: 13, boxSizing: 'border-box' as const,
    marginBottom: 6, fontFamily: 'Menlo, monospace',
  };

  return (
    <Section title="Environments">
      {envs.map(e => (
        <div key={e.id} style={{ display: 'flex', alignItems: 'center', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
          <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: e.id === 'workspace' ? '#30d158' : '#636AFF', marginRight: 8, flexShrink: 0 }} />
          <span style={{ flex: 1, color: '#e0e0e0', fontSize: 13, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>{e.label}</span>
          {e.id !== 'workspace' && (
            <button onClick={() => handleRemove(e.id)} style={{ border: 'none', background: 'none', color: '#ff453a', fontSize: 18, cursor: 'pointer', padding: '0 4px', lineHeight: 1 }}>×</button>
          )}
        </div>
      ))}

      {adding ? (
        <div style={{ marginTop: 10 }}>
          <input placeholder="Label (e.g. TR Machine)" value={form.label} onChange={e => setForm(f => ({...f, label: e.target.value}))} style={inputStyle} />
          <input placeholder="Relay URL" value={form.relayUrl} onChange={e => setForm(f => ({...f, relayUrl: e.target.value}))} style={inputStyle} />
          <input placeholder="Auth Token" type="password" value={form.token} onChange={e => setForm(f => ({...f, token: e.target.value}))} style={inputStyle} />
          <div style={{ display: 'flex', gap: 6, marginTop: 2 }}>
            <button onClick={() => { setAdding(false); setForm({ label: '', relayUrl: '', token: '' }); }} style={{ flex: 1, padding: '8px 0', border: 'none', borderRadius: 8, cursor: 'pointer', backgroundColor: 'rgba(255,255,255,0.06)', color: '#888', fontSize: 13 }}>Cancel</button>
            <button onClick={handleAdd} style={{ flex: 1, padding: '8px 0', border: 'none', borderRadius: 8, cursor: 'pointer', backgroundColor: '#636AFF', color: '#fff', fontSize: 13, fontWeight: 600 }}>Add</button>
          </div>
        </div>
      ) : (
        <button onClick={() => setAdding(true)} style={{ marginTop: 8, width: '100%', padding: '8px 0', border: 'none', borderRadius: 8, cursor: 'pointer', backgroundColor: 'rgba(99,106,255,0.15)', color: '#636AFF', fontSize: 13 }}>+ Add Environment</button>
      )}
    </Section>
  );
}

function Section({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ color: '#8e8e93', fontSize: 13, fontWeight: 600, textTransform: 'uppercase', marginBottom: 8, letterSpacing: 0.5 }}>{title}</div>
      <div style={{ backgroundColor: '#1c1c1e', borderRadius: 12, padding: 12 }}>{children}</div>
    </div>
  );
}

function Row({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '4px 0' }}>
      <span style={{ color: '#aaa', fontSize: 14 }}>{label}</span>
      <span style={{ color: valueColor || '#fff', fontSize: 14, fontFamily: 'Menlo, monospace' }}>{value}</span>
    </div>
  );
}

// ─── Tab Bar ───
const tabs = [{ id: 'canvas', label: 'Canvas' }, { id: 'config', label: 'Config' }];
function TabBar({ tab, onTab, disabled }: { tab: string; onTab: (t: string) => void; disabled?: boolean }) {
  return (
    <div style={{ display: 'flex', borderTop: '1px solid rgba(255,255,255,0.10)', paddingBottom: 'max(4px, env(safe-area-inset-bottom))', flexShrink: 0, position: 'relative', backgroundColor: '#0a0a0a', opacity: disabled ? 0.3 : 1, pointerEvents: disabled ? 'none' : 'auto' }}>
      {/* Sliding indicator */}
      {!disabled && <motion.div
        layoutId="tab-indicator"
        style={{
          position: 'absolute', top: 0, height: 2, width: '50%', backgroundColor: '#fff', borderRadius: 1,
        }}
        animate={{ x: tab === 'canvas' ? 0 : '100%' }}
        transition={{ type: 'spring', stiffness: 500, damping: 35 }}
      />}
      {tabs.map(t => (
        <motion.button key={t.id} tabIndex={-1} onClick={() => onTab(t.id)}
          whileTap={disabled ? undefined : { scale: 0.92 }}
          style={{
            flex: 1, padding: '8px 0 4px', border: 'none', cursor: disabled ? 'default' : 'pointer', backgroundColor: 'transparent',
            color: disabled ? '#333' : (tab === t.id ? '#fff' : '#636366'), display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
            transition: 'color 0.2s',
          }}>
          <span style={{ display: 'flex' }}>
            {t.id === 'canvas' ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 3v18"/></svg>
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
function SessionTerminal({ session, messages, onBack, onSend, onInterrupt, keyboardOpen, isProcessing = false, isCompacting = false }: {
  session: { id: string; display: string; relayUrl?: string; relayToken?: string };
  messages: Message[];
  onBack: () => void;
  onSend: (text: string) => void;
  onInterrupt: () => void;
  keyboardOpen?: boolean;
  isProcessing?: boolean;
  isCompacting?: boolean;
}) {
  const dragX = useMotionValue(0);
  const swipeStart = useRef<{ x: number } | null>(null);

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
        backgroundColor: '#0a0a0a', zIndex: 50, display: 'flex', flexDirection: 'column' }}
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
            color: '#e0a030', fontSize: 14, display: 'flex', alignItems: 'center', gap: 4 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          Back
        </motion.button>
        <span style={{ color: '#ddd', fontSize: 14, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
          {session.display}
        </span>
        <span style={{ color: '#777', fontSize: 11, fontFamily: 'Menlo, monospace' }}>{session.id.slice(0, 8)}</span>
      </div>

      {/* Messages + Permission banner + ESC overlay */}
      <div style={{ flex: 1, minHeight: 0, position: 'relative', display: 'flex', flexDirection: 'column' }}>
        <TerminalOverlay messages={messages} visible={true} />
        <PermissionBanner messages={messages} sessionId={session.id} />
        {(() => { const w = isCompacting ? 'compacting...' : isProcessing ? IDLE_WORDS[Math.floor(Date.now() / 4000) % IDLE_WORDS.length] : 'idle'; return (
        <div style={{ position: 'absolute', bottom: 4, right: 8, display: 'flex', alignItems: 'center', gap: 6, pointerEvents: 'none' }}>
          <span style={{ color: isCompacting ? '#3a8eff' : '#444', fontSize: 11, fontFamily: 'Menlo, monospace' }}>
            {w}
          </span>
          <button tabIndex={-1} onPointerDown={(e) => { e.preventDefault(); onInterrupt(); }} style={{
            padding: '3px 10px', borderRadius: 5, cursor: 'pointer', flexShrink: 0,
            border: isProcessing ? '1px solid rgba(255,59,48,0.4)' : '1px solid rgba(255,255,255,0.08)',
            backgroundColor: isProcessing ? 'rgba(255,59,48,0.15)' : 'rgba(17,17,17,0.7)',
            color: isProcessing ? '#ff453a' : '#444', fontSize: 11, fontFamily: 'Menlo, monospace',
            pointerEvents: 'auto', touchAction: 'manipulation', WebkitTapHighlightColor: 'transparent' as any,
          }}>ESC</button>
        </div>
        ); })()}
      </div>

      {/* Upload error banner — tap to dismiss */}
      {flow.uploadError && (
        <div onClick={flow.clearUploadError} style={{
          padding: '8px 14px', backgroundColor: 'rgba(255,59,48,0.85)',
          color: '#fff', fontSize: 13, fontFamily: '-apple-system, system-ui, sans-serif',
          flexShrink: 0, cursor: 'pointer',
        }}>
          Upload failed: {flow.uploadError}
        </div>
      )}
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
              backgroundColor: 'rgba(30,30,50,0.95)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
              borderRadius: 14, padding: '4px 0', minWidth: 200,
              boxShadow: '0 8px 40px rgba(0,0,0,0.6)', border: '1px solid rgba(224,160,48,0.15)',
              transformOrigin: 'bottom left' }}>
            {[
              { label: 'Add Photo', icon: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M23 19a2 2 0 01-2 2H3a2 2 0 01-2-2V8a2 2 0 012-2h4l2-3h6l2 3h4a2 2 0 012 2z"/><circle cx="12" cy="13" r="4"/></svg>), action: () => flow.uploadFile('image/*') },
              { label: 'Attach File', icon: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>), action: () => flow.uploadFile('.pdf,.md,.txt,.csv,.json,.py,.js,.ts,.jsx,.tsx') },
              { label: 'Sketch', icon: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>), action: () => { flow.setAttachMenu(false); flow.setSketchOpen(true); } },
            ].map((item, i) => (
              <div key={item.label}>
                {i > 0 && <div style={{ height: 1, backgroundColor: 'rgba(224,160,48,0.10)', margin: '0 12px' }} />}
                <button tabIndex={-1} onClick={item.action} style={{
                  display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                  padding: '11px 16px', border: 'none', cursor: 'pointer',
                  backgroundColor: 'transparent', color: '#e0e0e0',
                  fontSize: 15, textAlign: 'left', fontFamily: '-apple-system, system-ui, sans-serif',
                }}><span style={{ color: '#e0a030', display: 'flex' }}>{item.icon}</span> {item.label}</button>
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
  const [selectedSession, setSelectedSession] = useState<{ id: string; display: string; relayUrl?: string; relayToken?: string; project?: string; envId?: string } | null>(() => {
    try { const s = sessionStorage.getItem('morph-selected-session'); return s ? JSON.parse(s) : null; } catch { return null; }
  });
  const [sessionMessages, setSessionMessages] = useState<Message[]>([]);
  const [hasVisitedConfig, setHasVisitedConfig] = useState(false);
  const liveSessionIdRef = useRef<string | null>(null); // tracks active process ID after resume
  const sessionAliveCache = useRef<Map<string, { alive: boolean; ts: number }>>(new Map());
  const sessionSendQueue = useRef<Array<() => Promise<void>>>([]);
  const sessionSendBusy = useRef(false);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [sessionIsProcessing, setSessionIsProcessing] = useState(false);
  const sessionIdleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const [sessionIsCompacting, setSessionIsCompacting] = useState(false);
  const sessionCompactTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputBarRef = useRef<HTMLDivElement>(null);

  // Detect iOS keyboard via visualViewport resize
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    let t: ReturnType<typeof setTimeout>;
    const onResize = () => {
      if (document.visibilityState === 'hidden') return;
      clearTimeout(t);
      t = setTimeout(() => {
        const ratio = vv.height / window.screen.height;
        const isOpen = ratio < 0.75;
        dbg(`keyboard: ratio=${ratio.toFixed(2)} vvh=${Math.round(vv.height)} screenH=${window.screen.height} open=${isOpen}`);
        setKeyboardOpen(isOpen);
      }, 80);
    };
    vv.addEventListener('resize', onResize);
    return () => { vv.removeEventListener('resize', onResize); clearTimeout(t); };
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
  useEffect(() => {
    if (!authed) return;
    const mainToken = localStorage.getItem('morph-auth') || '';
    const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const MORPH_SESSION = 'a0a0a0a0-0e00-4000-a000-000000000002';

    function preloadEnv(base: string, token: string, startDelay: number) {
      setTimeout(() => {
        fetch(`${base}/v2/claude/sessions?limit=30`, { headers: { 'Authorization': `Bearer ${token}` } })
          .then(r => r.json())
          .then(d => {
            const sessions = (d.sessions || []).filter((s: any) => s.id !== MORPH_SESSION);
            sessions.forEach((s: any, i: number) => {
              setTimeout(() => {
                fetch(`${base}/v2/claude/history/${s.id}?limit=50`, { headers: { 'Authorization': `Bearer ${token}` } })
                  .then(r => r.json())
                  .then(d => {
                    const msgs = (d.messages || []).map((m: any) => ({
                      id: uid(), role: m.role, type: m.type, content: m.content, name: m.name,
                      ts: m.ts ? new Date(m.ts).getTime() : Date.now(),
                    }));
                    sessionCache.current.set(s.id, msgs);
                    sessionCacheTs.current.set(s.id, Date.now());
                  })
                  .catch(() => {});
              }, i * 200);
            });
          })
          .catch(() => {});
      }, startDelay);
    }

    // Workspace (local relay) — start at 1.5s
    preloadEnv('', mainToken, 1500);
    // All other envs (e.g. tensor-revive via proxy) — start at 4s to not compete with workspace
    const otherEnvs = getEnvironments().filter(e => e.relayUrl);
    otherEnvs.forEach((env, i) => {
      preloadEnv(env.relayUrl, env.token || mainToken, 4000 + i * 1000);
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
        if (!current.find(e => e.relayUrl === cfg.relayUrl)) {
          saveEnvironments([...current, { id: `env_${Date.now()}`, label: cfg.label || cfg.relayUrl, relayUrl: cfg.relayUrl, token: cfg.token || undefined, maxSessions: 6 }]);
        }
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
        const token = localStorage.getItem('morph-auth') || '';
        fetch('/v2/claude/title', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
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
    const unsub3 = onCompact(() => {
      setIsCompacting(true);
      if (compactTimer.current) clearTimeout(compactTimer.current);
      compactTimer.current = setTimeout(() => setIsCompacting(false), 8000);
    });
    connect();
    return () => { unsub1(); unsub2(); unsub3(); clearTimeout(idleTimer.current); if (compactTimer.current) clearTimeout(compactTimer.current); };
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
      {/* Reconnecting indicator */}
      {connState !== 'connected' && (
        <div style={{
          position: 'fixed', top: 'max(8px, env(safe-area-inset-top))', right: 12, zIndex: 99999,
          color: '#f5a623', fontSize: 11, fontFamily: 'Menlo, monospace',
          pointerEvents: 'none',
        }}>
          reconnecting...
        </div>
      )}
      {/* Content area — tab-specific, always full height */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
        {/* Canvas view */}
        <div style={{ flex: 1, display: tab === 'canvas' ? 'flex' : 'none', position: 'relative' }}>
          {/* Usage widget — top right */}
          <UsageWidget />
          {/* Session cards — floating overlay */}
          <SessionCards
            onSelect={(sid, display, relayUrl, relayToken, project, envId) => {
              setSessionMessages(sessionCache.current.get(sid) || []);
              sessionSendQueue.current = [];
              sessionSendBusy.current = false;
              setSelectedSession({ id: sid, display: display || sid.slice(0, 8), relayUrl, relayToken, project, envId });
            }}
            onNewSession={(envId, relayUrl, relayToken) => {
              const sid = crypto.randomUUID();
              if (envId !== 'workspace') registerSession(sid, envId);
              setSessionMessages([]);
              liveSessionIdRef.current = null;
              sessionSendQueue.current = [];
              sessionSendBusy.current = false;
              setSelectedSession({ id: sid, display: 'New Session', relayUrl, relayToken, envId });
            }}
          />
          {/* Canvas iframe — fills full area */}
          <div style={{ flex: 1, position: 'relative', backgroundColor: '#0a0a0a' }}>
            {!canvasLoaded && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0a0a0a', zIndex: 1 }}>
                <div style={{ width: 120, height: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                  <div style={{ width: '40%', height: '100%', backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 1, animation: 'canvasLoad 1.2s ease-in-out infinite' }} />
                </div>
                <style>{`@keyframes canvasLoad { 0% { transform: translateX(-120%); } 100% { transform: translateX(300%); } }`}</style>
              </div>
            )}
            <iframe src={`/canvas.html?v=${BUILD_TS}`} onLoad={() => setCanvasLoaded(true)} style={{ width: '100%', height: '100%', border: 'none', backgroundColor: '#0a0a0a', willChange: 'transform' }} sandbox="allow-scripts allow-same-origin" />
          </div>
        </div>

        {/* Config content — lazy-mounted: only rendered after first visit */}
        {hasVisitedConfig && <div style={{ flex: 1, display: tab === 'config' ? 'flex' : 'none', overflow: 'hidden', flexDirection: 'column' }}>
          <ConfigTab connState={connState} onQuickAction={(prompt) => {
            send(prompt);
            setTab('canvas'); setCurrentTab('canvas');
            setTerminalVisible(true);
          }} onRefresh={() => { if (connState !== 'connected') connect(); }} />
        </div>}

        {/* Origin Terminal — always on top of Canvas UI */}
        <div ref={terminalDivRef} style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 10,
          height: `${terminalHeight}%`,
          transform: terminalVisible ? 'translateY(0)' : 'translateY(100%)',
          transition: dragging.current ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          willChange: 'transform',
          display: 'flex', flexDirection: 'column',
          backgroundColor: '#111',
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
              backgroundColor: 'rgba(255,255,255,0.06)', borderBottom: '1px solid rgba(255,255,255,0.08)',
            }}
          >
            <div style={{ width: 40, height: 5, borderRadius: 3, backgroundColor: 'rgba(255,255,255,0.45)' }} />
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
              <span style={{ color: isCompacting ? '#3a8eff' : '#444', fontSize: 11, fontFamily: 'Menlo, monospace' }}>
                {w}
              </span>
              <button tabIndex={-1} onPointerDown={(e) => { e.preventDefault(); interrupt(); }} style={{
                padding: '3px 10px', borderRadius: 5, cursor: 'pointer', flexShrink: 0,
                border: isProcessing ? '1px solid rgba(255,59,48,0.4)' : '1px solid rgba(255,255,255,0.08)',
                backgroundColor: isProcessing ? 'rgba(255,59,48,0.15)' : 'rgba(17,17,17,0.7)',
                color: isProcessing ? '#ff453a' : '#444', fontSize: 11, fontFamily: 'Menlo, monospace',
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
              backgroundColor: 'rgba(30,30,30,0.95)', backdropFilter: 'blur(12px)', WebkitBackdropFilter: 'blur(12px)',
              borderRadius: 14, padding: '4px 0', minWidth: 200,
              boxShadow: '0 8px 40px rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.08)',
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
                {i > 0 && <div style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.10)', margin: '0 12px' }} />}
                <button tabIndex={-1} onClick={item.action} style={{
                  display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                  padding: '11px 16px', border: 'none', cursor: 'pointer', borderRadius: 0,
                  backgroundColor: 'transparent', color: '#e0e0e0',
                  fontSize: 15, textAlign: 'left', fontFamily: '-apple-system, system-ui, sans-serif',
                }}><span style={{ color: '#999', display: 'flex' }}>{item.icon}</span> {item.label}</button>
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
            onBack={() => setSelectedSession(null)}
            onInterrupt={() => interruptSession(liveSessionIdRef.current || selectedSession.id)}
            onSend={async (text) => {
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
                try {
                  // Use live session ID (updated after resume) to avoid spawning new process on every send
                  const liveId = liveSessionIdRef.current || snapSession.id;
                  const token = snapSession.relayToken || localStorage.getItem('morph-auth') || '';
                  const base = snapSession.relayUrl || '';
                  // Use pre-fetched alive status (5s TTL) to skip the blocking check on first send
                  const ALIVE_TTL = 5_000;
                  const cachedAlive = sessionAliveCache.current.get(liveId);
                  const aliveFast = cachedAlive && Date.now() - cachedAlive.ts < ALIVE_TTL && cachedAlive.alive;
                  if (aliveFast) {
                    await sendToSession(liveId, text);
                  } else {
                    const checkRes = await fetch(`${base}/v2/claude/active`, { headers: { 'Authorization': `Bearer ${token}` } });
                    const checkData = await checkRes.json();
                    const alive = (checkData.sessions || []).find((s: any) => s.id === liveId && s.alive);
                    if (alive) {
                      sessionAliveCache.current.set(liveId, { alive: true, ts: Date.now() });
                      await sendToSession(liveId, text);
                    } else {
                      const newSid = await resumeSession(snapSession.id, text);
                      liveSessionIdRef.current = newSid; // track resumed process ID for subsequent sends
                      sessionAliveCache.current.set(newSid, { alive: true, ts: Date.now() });
                      // Update subscription if session ID changed (subscribeSessionMessages auto-cleans old)
                      if (newSid !== snapSession.id) {
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
                  // Confirm sent
                  setSessionMessages(prev => prev.map(m => m.id === msgId ? { ...m, pending: false } : m));
                } catch (err: any) {
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
            background: 'rgba(20,20,22,0.97)', backdropFilter: 'blur(12px)',
            borderTop: '1px solid rgba(255,255,255,0.10)',
            padding: '14px 16px', paddingBottom: 'max(14px, env(safe-area-inset-bottom))',
            display: 'flex', alignItems: 'flex-start', gap: 12,
          }}>
            <div style={{ flex: 1 }}>
              <div style={{ color: '#fff', fontSize: 14, fontWeight: 600, marginBottom: 3 }}>Add Morph to Home Screen</div>
              <div style={{ color: '#888', fontSize: 12, lineHeight: '16px' }}>
                Tap <svg style={{ display: 'inline', verticalAlign: 'middle', margin: '0 2px' }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#888" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M12 2v13M7 7l5-5 5 5"/><path d="M3 17v3a1 1 0 001 1h16a1 1 0 001-1v-3"/></svg> Share, then "Add to Home Screen" for a better experience.
              </div>
            </div>
            <button onClick={() => { localStorage.setItem('morph-a2hs-dismissed', '1'); window.location.reload(); }} style={{
              background: 'none', border: 'none', color: '#555', fontSize: 20, cursor: 'pointer',
              padding: '0 4px', lineHeight: 1, flexShrink: 0,
            }}>×</button>
          </div>
        );
      })()}
    </div>
  );
}
