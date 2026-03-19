import React, { useEffect, useRef, useState, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { motion, AnimatePresence, useMotionValue } from 'framer-motion';
import { connect, send, interrupt, clearSession, setCurrentTab, switchSession, fetchSessions, onMessage, onState, getState, sendToSession, resumeSession, subscribeSessionMessages, unsubscribeSessionMessages, type Message } from './lib/connection';
import Sketch from './components/Sketch';

// Cache-bust canvas.html on each page load (not per render)
const BUILD_TS = Date.now().toString(36);

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
      <div onClick={() => setOpen(!open)} style={{ cursor: 'pointer', color, fontSize: 13, fontFamily: 'Menlo, monospace', lineHeight: '20px', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {open ? '▾' : '▸'} {label}{!open && preview ? `: ${preview}` : ''}
      </div>
      {open && <pre style={{ color, opacity: 0.7, fontSize: 13, fontFamily: 'Menlo, monospace', lineHeight: '20px', whiteSpace: 'pre-wrap', wordBreak: 'break-all', overflow: 'hidden', maxWidth: '100%', margin: 0, marginLeft: 16 }}>{content}</pre>}
    </div>
  );
}

// ─── Message Row ───
const MessageRow = React.memo(function MessageRow({ msg }: { msg: Message }) {
  const mono = { fontFamily: 'Menlo, monospace', fontSize: 14, lineHeight: '20px', overflow: 'hidden' as const, maxWidth: '100%', userSelect: 'text' as const, WebkitUserSelect: 'text' as any } as const;
  switch (msg.type) {
    case 'text':
      return msg.role === 'user'
        ? <div style={{ ...mono, color: '#30d158', marginBottom: 3, opacity: msg.pending ? 0.5 : 1 }}>&gt; {msg.content}</div>
        : <div style={{ ...mono, color: '#e0e0e0', marginBottom: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.content}</div>;
    case 'thinking':
      return <Collapsible label="thinking" preview={msg.content.slice(0, 60)} content={msg.content} color="#636366" />;
    case 'tool':
      return <Collapsible label={msg.name || 'tool'} preview={msg.content.slice(0, 80).replace(/\n/g, ' ')} content={msg.content} color="#636366" />;
    case 'tool_result':
      return <Collapsible label="result" preview={msg.content.slice(0, 80).replace(/\n/g, ' ')} content={msg.content.length > 2000 ? msg.content.slice(0, 2000) + '\n...' : msg.content} color="#48484a" />;
    case 'status':
      return msg.content.length > 120
        ? <Collapsible label="status" preview={msg.content.slice(0, 80).replace(/\n/g, ' ')} content={msg.content} color="#555" />
        : <div style={{ ...mono, color: '#777', textAlign: 'center', marginTop: 4, marginBottom: 4 }}>{msg.content}</div>;
    case 'error':
      return msg.content.length > 120
        ? <Collapsible label="error" preview={msg.content.slice(0, 80).replace(/\n/g, ' ')} content={msg.content} color="#ff453a" />
        : <div style={{ ...mono, color: '#ff453a', marginBottom: 3 }}>{msg.content}</div>;
    default: return null;
  }
});

// ─── Terminal Overlay (toggle-able, sits above input bar) ───
function TerminalOverlay({ messages, visible }: { messages: Message[]; visible: boolean }) {
  if (!visible) return null;
  return (
    <div style={{
      flex: '1 1 0', minHeight: 0, overflowY: 'scroll', overflowX: 'hidden',
      display: 'flex', flexDirection: 'column-reverse',
      borderTop: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#0a0a0a',
      WebkitOverflowScrolling: 'touch' as any,
      userSelect: 'text', WebkitUserSelect: 'text' as any,
    }}>
      {/* column-reverse: browser natively anchors scroll to bottom. Inner div keeps message order correct. */}
      <div style={{ padding: '8px 12px' }}>
        {messages.length === 0
          ? <div style={{ color: '#4a4a4a', fontSize: 13, textAlign: 'center', padding: 16, fontFamily: 'Menlo, monospace' }}>waiting for session...</div>
          : messages.map(msg => <MessageRow key={msg.id} msg={msg} />)
        }
      </div>
    </div>
  );
}

// ─── Input Bar (matches native: dot + attach + terminal toggle + input + send/stop) ───
function InputBar({ onSend, onStop, isProcessing, connected, terminalVisible, onToggleTerminal, hasNew, onAttach, onSketch, pendingSketch, pendingFile, onClearPending, tint, keyboardOpen }: {
  onSend: (text: string) => void; onStop: () => void; isProcessing: boolean; connected: boolean;
  terminalVisible?: boolean; onToggleTerminal?: () => void; hasNew?: boolean;
  onAttach: () => void;
  onSketch: () => void;
  pendingSketch: string | null;
  pendingFile: 'image' | 'file' | null;
  onClearPending: () => void;
  tint?: 'blue'; // session terminal color
  keyboardOpen?: boolean;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const canSend = !!(text.trim() || pendingSketch || pendingFile);
  const handleSend = useCallback(() => {
    const t = text.trim();
    if (!t && !pendingSketch && !pendingFile) return;
    onSend(t || '');
    setText('');
    if (ref.current) ref.current.style.height = '36px';
  }, [text, onSend, pendingSketch, pendingFile]);

  const isBlue = tint === 'blue';
  const accent = isBlue ? '#6e8ef7' : '#30d158';
  const dotColor = connected ? accent : '#636366';
  const inputBg = isBlue ? '#1a1a2e' : '#1c1c1e';
  const sendBg = isBlue ? '#4a6cf7' : '#333';
  const borderTint = isBlue ? 'rgba(100,140,255,0.15)' : 'rgba(255,255,255,0.10)';

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
      <button tabIndex={-1} onClick={(pendingSketch || pendingFile) ? onClearPending : onAttach}
        style={{
          width: 34, height: 34, borderRadius: 17, border: 'none', cursor: 'pointer', flexShrink: 0,
          backgroundColor: (pendingSketch || pendingFile) ? 'rgba(48,209,88,0.2)' : 'rgba(255,255,255,0.08)',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          transition: 'transform 0.15s cubic-bezier(0.34, 1.56, 0.64, 1)',
        }}
        onTouchStart={e => (e.currentTarget.style.transform = 'scale(1.3)')}
        onTouchEnd={e => (e.currentTarget.style.transform = 'scale(1)')}>
        {pendingSketch
          ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#30d158" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>
          : pendingFile === 'image'
            ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#30d158" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
            : pendingFile === 'file'
              ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#30d158" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>
              : <span style={{ color: '#888', fontSize: 22, lineHeight: '22px' }}>+</span>}
      </button>

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
        placeholder={isBlue ? "Message this session..." : "Message Claude Code..."}
        rows={1}
        enterKeyHint="send"
        autoComplete="off"
        style={{
          flex: 1, minHeight: 36, maxHeight: 120, resize: 'none',
          borderRadius: 18, border: isBlue ? `1px solid ${borderTint}` : 'none', outline: 'none',
          padding: '8px 16px', fontSize: 16, lineHeight: '20px',
          fontFamily: '-apple-system, system-ui, sans-serif', backgroundColor: inputBg, color: '#fff',
          WebkitAppearance: 'none' as any,
        }}
      />

      {/* Send button */}
      <button tabIndex={-1} onClick={handleSend} disabled={!canSend} style={{
        width: 36, height: 36, borderRadius: 18, border: 'none', flexShrink: 0,
        backgroundColor: canSend ? sendBg : inputBg, cursor: canSend ? 'pointer' : 'default',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={canSend ? '#fff' : '#666'} strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M12 19V5M5 12l7-7 7 7"/></svg></button>
    </div>
  );
}

// ─── Session Cards (Canvas overlay) ───
const FIXED_SESSION_ID = 'a0a0a0a0-0e00-4000-a000-000000000002';
const VIEWED_KEY = 'morph-viewed-sessions';

function getViewed(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(VIEWED_KEY) || '[]')); } catch { return new Set(); }
}
function markViewed(id: string) {
  const s = getViewed(); s.add(id); localStorage.setItem(VIEWED_KEY, JSON.stringify([...s]));
}

function SessionCards({ onSelect }: { onSelect: (sessionId: string, display?: string) => void }) {
  const [sessions, setSessions] = useState<any[]>([]);
  const [viewed, setViewed] = useState<Set<string>>(getViewed);
  const [expanded, setExpanded] = useState(true);

  useEffect(() => {
    fetchSessions().then(all => {
      // Filter out fixed session, limit to 7
      const filtered = all.filter(s => s.id !== FIXED_SESSION_ID).slice(0, 7);
      setSessions(filtered);
    });
  }, []);

  const timeAgo = (ms: number) => {
    const diff = Date.now() - ms;
    if (diff < 60000) return 'now';
    if (diff < 3600000) return `${Math.floor(diff / 60000)}m`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)}h`;
    return `${Math.floor(diff / 86400000)}d`;
  };

  // Color: green=active, yellow=unviewed+inactive, gray=viewed+inactive
  const dotColor = (s: any) => {
    if (s.active) return '#30d158';
    if (!viewed.has(s.id)) return '#ffcc00';
    return '#555';
  };
  const borderColor = (s: any) => {
    if (s.active) return 'rgba(48,209,88,0.25)';
    if (!viewed.has(s.id)) return 'rgba(255,204,0,0.2)';
    return 'rgba(255,255,255,0.08)';
  };

  const handleSelect = (id: string) => {
    markViewed(id);
    setViewed(getViewed());
    const s = sessions.find(x => x.id === id);
    onSelect(id, s?.display);
  };

  if (sessions.length === 0) return null;

  const activeCount = sessions.filter(s => s.active).length;
  const unviewedCount = sessions.filter(s => !s.active && !viewed.has(s.id)).length;

  return (
    <div style={{ position: 'absolute', top: 200, left: 0, right: 0, zIndex: 2, padding: '0 12px', pointerEvents: 'none' }}>
      {/* Header — tap to toggle */}
      <div
        onClick={() => setExpanded(v => !v)}
        style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: expanded ? 6 : 0, cursor: 'pointer', pointerEvents: 'auto' }}
      >
        <span style={{ color: '#777', fontSize: 11, fontWeight: 600, textTransform: 'uppercase' as const, letterSpacing: 0.5 }}>
          Sessions ({sessions.length})
        </span>
        {activeCount > 0 && <span style={{ fontSize: 9, color: '#30d158' }}>{activeCount} active</span>}
        {unviewedCount > 0 && <span style={{ fontSize: 9, color: '#ffcc00' }}>{unviewedCount} new</span>}
        <span style={{ color: '#888', fontSize: 10 }}>{expanded ? '▾' : '▸'}</span>
      </div>

      {/* Session rows */}
      <AnimatePresence>
        {expanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2 }}
            style={{ overflow: 'hidden', pointerEvents: 'auto' }}
          >
            {sessions.map(s => (
              <motion.div
                key={s.id}
                whileTap={{ scale: 0.98 }}
                onClick={() => handleSelect(s.id)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 8,
                  padding: '8px 10px', marginBottom: 3,
                  backgroundColor: 'rgba(28,28,30,0.85)', backdropFilter: 'blur(20px)', WebkitBackdropFilter: 'blur(20px)',
                  borderRadius: 10, cursor: 'pointer',
                  border: `1px solid ${borderColor(s)}`,
                }}
              >
                <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: dotColor(s), flexShrink: 0 }} />
                <span style={{ color: '#ddd', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                  {s.display || s.id.slice(0, 8)}
                </span>
                <span style={{ color: '#777', fontSize: 11, flexShrink: 0 }}>{timeAgo(s.updatedAt)}</span>
              </motion.div>
            ))}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ─── Config Tab ───
function ConfigTab({ connState, onQuickAction }: { connState: string; onQuickAction: (prompt: string) => void }) {
  const [sessions, setSessions] = useState<any[]>([]);
  const [activeSessions, setActiveSessions] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);
  const token = () => localStorage.getItem('morph-auth') || '';
  const headers = () => ({ 'Authorization': `Bearer ${token()}` });

  const loadSessions = async () => {
    setLoading(true);
    try {
      const [sessRes, actRes] = await Promise.all([
        fetch('/v2/claude/sessions?limit=30', { headers: headers() }),
        fetch('/v2/claude/active', { headers: headers() }),
      ]);
      const sessData = await sessRes.json();
      const actData = await actRes.json();
      setSessions(sessData.sessions || []);
      setActiveSessions(actData.sessions || []);
    } catch {}
    setLoading(false);
  };

  useEffect(() => { loadSessions(); }, []);

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

        {/* Active sessions first */}
        {activeSessions.map((s: any) => (
          <div key={s.id} style={{ padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: '#30d158', flexShrink: 0 }} />
              <span style={{ color: '#fff', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                {s.id.slice(0, 8)} — {s.cwd}
              </span>
              <span style={{ color: '#30d158', fontSize: 11 }}>active</span>
            </div>
          </div>
        ))}

        {/* Recent sessions */}
        {sessions.map((s: any) => (
          <div key={s.id} style={{ padding: '10px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
              <div style={{ width: 6, height: 6, borderRadius: 3, backgroundColor: s.active ? '#30d158' : '#555', flexShrink: 0 }} />
              <span style={{ color: '#e0e0e0', fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
                {s.display || s.id.slice(0, 8)}
              </span>
              <span style={{ color: '#888', fontSize: 11, flexShrink: 0 }}>{timeAgo(s.updatedAt)}</span>
            </div>
            <div style={{ fontSize: 11, color: '#777', fontFamily: 'Menlo, monospace', marginTop: 2, marginLeft: 12 }}>
              {s.id.slice(0, 8)}
            </div>
          </div>
        ))}
      </Section>

      <Section title="Account">
        <button onClick={() => { localStorage.removeItem('morph-auth'); location.reload(); }} style={{
          padding: '10px 0', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 14, width: '100%', textAlign: 'center',
          backgroundColor: 'rgba(255,59,48,0.15)', color: '#ff453a',
        }}>Logout</button>
      </Section>
    </div>
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
function SessionTerminal({ session, messages, onBack, onSend, keyboardOpen }: {
  session: { id: string; display: string };
  messages: Message[];
  onBack: () => void;
  onSend: (text: string) => void;
  keyboardOpen?: boolean;
}) {
  const dragX = useMotionValue(0);
  const swipeStart = useRef<{ x: number } | null>(null);

  // Allow left-edge swipe when session terminal is open
  useEffect(() => {
    (window as any).__allowLeftSwipe = true;
    return () => { (window as any).__allowLeftSwipe = false; };
  }, []);
  const [sessionSketch, setSessionSketch] = useState<{ dataUrl: string; bounds: { x: number; y: number; w: number; h: number } } | null>(null);
  const [sessionFile, setSessionFile] = useState<{ path: string; isImage: boolean } | null>(null);
  const [sessionSketchOpen, setSessionSketchOpen] = useState(false);
  const [sessionAttachMenu, setSessionAttachMenu] = useState(false);

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

  const handleSessionSend = async (text: string) => {
    let prefix = '';
    if (sessionSketch) {
      const b64 = sessionSketch.dataUrl.split(',')[1];
      const { x, y, w, h } = sessionSketch.bounds;
      try {
        const token = localStorage.getItem('morph-auth') || '';
        const res = await fetch('/v2/claude/upload', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: `sketch-${Date.now()}.png`, base64: b64, mime: 'image/png' }),
        });
        const data = await res.json();
        if (data.path) prefix += `[Sketch annotation at screen position: x=${Math.round(x)}%, y=${Math.round(y)}%, w=${Math.round(w)}%, h=${Math.round(h)}%]\nImage: ${data.path}\n`;
      } catch {}
      setSessionSketch(null);
    }
    if (sessionFile) {
      prefix += sessionFile.isImage ? `Look at this image: ${sessionFile.path}\n` : `Read this file: ${sessionFile.path}\n`;
      setSessionFile(null);
    }
    onSend(prefix ? (prefix + (text ? `\n${text}` : '')).trim() : text);
  };

  const uploadSessionFile = (accept: string) => {
    setSessionAttachMenu(false);
    const input = document.createElement('input');
    input.type = 'file'; input.accept = accept;
    input.onchange = async (e: any) => {
      const file = e.target?.files?.[0]; if (!file) return;
      const b64: string = await new Promise(r => { const rd = new FileReader(); rd.onload = () => r((rd.result as string).split(',')[1]); rd.readAsDataURL(file); });
      try {
        const token = localStorage.getItem('morph-auth') || '';
        const res = await fetch('/v2/claude/upload', { method: 'POST', headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ filename: file.name, base64: b64, mime: file.type }) });
        const data = await res.json();
        if (data.path) setSessionFile({ path: data.path, isImage: file.type.startsWith('image/') });
      } catch {}
    };
    input.click();
  };

  return (
    <motion.div
      key="session-terminal"
      initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }}
      transition={{ type: 'spring', stiffness: 300, damping: 30 }}
      style={{ x: dragX, position: 'fixed', top: 0, left: 0, right: 0, bottom: 0,
        backgroundColor: '#0a0a0a', zIndex: 50, display: 'flex', flexDirection: 'column' }}
      onTouchStart={onTouchStart} onTouchMove={onTouchMove} onTouchEnd={onTouchEnd}
    >
      {/* Header */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 12px 8px', paddingTop: 'max(12px, env(safe-area-inset-top))',
        borderBottom: '1px solid rgba(100,140,255,0.15)', flexShrink: 0,
      }}>
        <motion.button whileTap={{ scale: 0.9 }} onClick={onBack}
          style={{ background: 'none', border: 'none', cursor: 'pointer', padding: '4px 8px',
            color: '#6e8ef7', fontSize: 14, display: 'flex', alignItems: 'center', gap: 4 }}>
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M19 12H5M12 19l-7-7 7-7"/></svg>
          Back
        </motion.button>
        <span style={{ color: '#ddd', fontSize: 14, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' as const }}>
          {session.display}
        </span>
        <span style={{ color: '#777', fontSize: 11, fontFamily: 'Menlo, monospace' }}>{session.id.slice(0, 8)}</span>
      </div>

      {/* Messages */}
      <TerminalOverlay messages={messages} visible={true} />

      {/* Shared InputBar — blue tint, no terminal toggle (header has Back) */}
      <InputBar
        onSend={handleSessionSend} onStop={() => {}}
        isProcessing={false} connected={true}
        onAttach={() => setSessionAttachMenu(v => !v)}
        onSketch={() => setSessionSketchOpen(true)}
        pendingSketch={sessionSketch ? sessionSketch.dataUrl : null}
        pendingFile={sessionFile ? (sessionFile.isImage ? 'image' : 'file') : null}
        onClearPending={() => { setSessionSketch(null); setSessionFile(null); }}
        tint="blue"
        keyboardOpen={keyboardOpen}
      />
      {/* Disabled TabBar — same height as main, keeps InputBar aligned */}
      {!keyboardOpen && <TabBar tab="canvas" onTab={() => {}} disabled />}

      {/* Session attach menu */}
      <AnimatePresence>
        {sessionAttachMenu && (<>
          <motion.div key="s-backdrop" initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }} onClick={() => setSessionAttachMenu(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 998 }} />
          <motion.div key="s-menu" initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.3, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 25 }}
            style={{ position: 'absolute', bottom: 60, left: 12, zIndex: 999,
              backgroundColor: 'rgba(30,30,50,0.9)', backdropFilter: 'blur(40px)', WebkitBackdropFilter: 'blur(40px)',
              borderRadius: 14, padding: '4px 0', minWidth: 200,
              boxShadow: '0 8px 40px rgba(0,0,0,0.6)', border: '1px solid rgba(100,140,255,0.15)',
              transformOrigin: 'bottom left' }}>
            {[
              { label: 'Attach File', icon: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>), action: () => uploadSessionFile('image/*,.pdf,.md,.txt,.csv,.json,.py,.js,.ts,.jsx,.tsx') },
              { label: 'Sketch', icon: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>), action: () => { setSessionAttachMenu(false); setSessionSketchOpen(true); } },
            ].map((item, i) => (
              <div key={item.label}>
                {i > 0 && <div style={{ height: 1, backgroundColor: 'rgba(100,140,255,0.10)', margin: '0 12px' }} />}
                <button tabIndex={-1} onClick={item.action} style={{
                  display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                  padding: '11px 16px', border: 'none', cursor: 'pointer',
                  backgroundColor: 'transparent', color: '#e0e0e0',
                  fontSize: 15, textAlign: 'left', fontFamily: '-apple-system, system-ui, sans-serif',
                }}><span style={{ color: '#6e8ef7', display: 'flex' }}>{item.icon}</span> {item.label}</button>
              </div>
            ))}
          </motion.div>
        </>)}
      </AnimatePresence>

      {/* Session sketch overlay */}
      {sessionSketchOpen && createPortal(
        <Sketch onInsert={(dataUrl, bounds) => { setSessionSketchOpen(false); setSessionSketch({ dataUrl, bounds }); }} onClose={() => setSessionSketchOpen(false)} />,
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
  const [sketchOpen, setSketchOpen] = useState(false);
  const [canvasLoaded, setCanvasLoaded] = useState(false);
  const [pendingSketch, setPendingSketch] = useState<{ dataUrl: string; bounds: { x: number; y: number; w: number; h: number } } | null>(null);
  const [pendingFile, setPendingFile] = useState<{ path: string; isImage: boolean } | null>(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState<{ id: string; display: string } | null>(null);
  const [sessionMessages, setSessionMessages] = useState<Message[]>([]);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const inputBarRef = useRef<HTMLDivElement>(null);

  // Detect iOS keyboard via visualViewport resize
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const onResize = () => {
      const ratio = vv.height / window.screen.height;
      setKeyboardOpen(ratio < 0.75);
    };
    vv.addEventListener('resize', onResize);
    return () => vv.removeEventListener('resize', onResize);
  }, []);

  // Load history + subscribe to live updates when a session is selected
  useEffect(() => {
    if (!selectedSession) return;
    const token = localStorage.getItem('morph-auth') || '';
    fetch(`/v2/claude/history/${selectedSession.id}?limit=50`, { headers: { 'Authorization': `Bearer ${token}` } })
      .then(r => r.json())
      .then(d => {
        const uid = () => `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        setSessionMessages((d.messages || []).map((m: any) => ({
          id: uid(), role: m.role, type: m.type, content: m.content, name: m.name,
          ts: m.ts ? new Date(m.ts).getTime() : Date.now(),
        })));
      })
      .catch(() => {});
    // Subscribe socket to this session for live updates
    subscribeSessionMessages(selectedSession.id, (msg) => {
      setSessionMessages(prev => [...prev, msg]);
    });
    return () => { unsubscribeSessionMessages(); };
  }, [selectedSession?.id]);

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
        const next = [...prev, msg];
        return next.length > MAX_MESSAGES ? next.slice(-MAX_MESSAGES) : next;
      });
      if (msg.role === 'agent' || msg.type === 'tool' || msg.type === 'thinking') setIsProcessing(true);
      // Only stop processing on explicit done/exit signals
      if (msg.type === 'status' && msg.content.includes('done')) setIsProcessing(false);
      if (msg.type === 'status' && msg.content.includes('exit')) setIsProcessing(false);
      if (msg.type === 'error') setIsProcessing(false);
      // Fallback: 30s idle timeout
      clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setIsProcessing(false), 30000);
    });
    const unsub2 = onState(setConnState);
    connect();
    return () => { unsub1(); unsub2(); clearTimeout(idleTimer.current); };
  }, [authed]);

  const [terminalVisible, setTerminalVisible] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(40); // percentage
  const [hasNew, setHasNew] = useState(false);
  const prevCount = useRef(0);
  const dragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartH = useRef(40);

  useEffect(() => {
    if (messages.length > prevCount.current && !terminalVisible && isProcessing) setHasNew(true);
    prevCount.current = messages.length;
  }, [messages.length, terminalVisible, isProcessing]);

  useEffect(() => { if (!isProcessing) setHasNew(false); }, [isProcessing]);

  const toggleTerminal = () => { setTerminalVisible(v => !v); setHasNew(false); };

  const handleTab = (t: string) => { setTab(t); setCurrentTab(t); if (t === 'config') setTerminalVisible(false); };

  const handleSend = async (text: string) => {
    if (text === '/clear') { setMessages([]); setIsProcessing(false); clearSession(); setPendingSketch(null); setPendingFile(null); return; }

    let prefix = '';

    // Pending sketch → upload and prepend
    if (pendingSketch) {
      const b64 = pendingSketch.dataUrl.split(',')[1];
      const { x, y, w, h } = pendingSketch.bounds;
      try {
        const token = localStorage.getItem('morph-auth') || '';
        const res = await fetch('/v2/claude/upload', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: `sketch-${Date.now()}.png`, base64: b64, mime: 'image/png' }),
        });
        const data = await res.json();
        if (data.path) {
          prefix += `[Sketch annotation at screen position: x=${Math.round(x)}%, y=${Math.round(y)}%, w=${Math.round(w)}%, h=${Math.round(h)}%]\nImage: ${data.path}\n`;
        }
      } catch {}
      setPendingSketch(null);
    }

    // Pending file → prepend
    if (pendingFile) {
      prefix += pendingFile.isImage ? `Look at this image: ${pendingFile.path}\n` : `Read this file: ${pendingFile.path}\n`;
      setPendingFile(null);
    }

    send(prefix ? (prefix + (text ? `\n${text}` : '')).trim() : text);
  };

  const [attachMenu, setAttachMenu] = useState(false);

  const handleAttach = () => setAttachMenu(v => !v);

  const uploadFile = (accept: string) => {
    setAttachMenu(false);
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = accept;
    input.onchange = async (e: any) => {
      const file = e.target?.files?.[0];
      if (!file) return;
      const b64: string = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
      });
      try {
        const token = localStorage.getItem('morph-auth') || '';
        const res = await fetch('/v2/claude/upload', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, base64: b64, mime: file.type }),
        });
        const data = await res.json();
        if (data.path) {
          // Store as pending — user types prompt before sending
          setPendingFile({ path: data.path, isImage: file.type.startsWith('image/') });
        }
      } catch {}
    };
    input.click();
  };

  const handleSketchInsert = (dataUrl: string, bounds: { x: number; y: number; w: number; h: number }) => {
    setSketchOpen(false);
    // Insert as pending attachment — user can add text prompt before sending
    setPendingSketch({ dataUrl, bounds });
  };

  if (!authed) return <PasswordGate onAuth={() => setAuthed(true)} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', maxWidth: 600, margin: '0 auto', width: '100%' }}>
      {/* Content area — tab-specific, always full height */}
      <div style={{ flex: 1, display: 'flex', flexDirection: 'column', overflow: 'hidden', position: 'relative' }}>
        {/* Canvas view */}
        <div style={{ flex: 1, display: tab === 'canvas' ? 'flex' : 'none', position: 'relative' }}>
          {/* Session cards — floating overlay */}
          <SessionCards onSelect={(sid, display) => {
            setSessionMessages([]);
            setSelectedSession({ id: sid, display: display || sid.slice(0, 8) });
          }} />
          {/* Canvas iframe — fills full area */}
          <div style={{ flex: 1, position: 'relative' }}>
            {!canvasLoaded && (
              <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0a0a0a', zIndex: 1 }}>
                <div style={{ width: 120, height: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                  <div style={{ width: '40%', height: '100%', backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 1, animation: 'canvasLoad 1.2s ease-in-out infinite' }} />
                </div>
                <style>{`@keyframes canvasLoad { 0% { transform: translateX(-120%); } 100% { transform: translateX(300%); } }`}</style>
              </div>
            )}
            <iframe src={`/canvas.html?v=${BUILD_TS}`} onLoad={() => setCanvasLoaded(true)} style={{ width: '100%', height: '100%', border: 'none', backgroundColor: '#0a0a0a' }} sandbox="allow-scripts allow-same-origin" />
          </div>
        </div>

        {/* Config content */}
        <div style={{ flex: 1, display: tab === 'config' ? 'flex' : 'none', overflow: 'hidden', flexDirection: 'column' }}>
          <ConfigTab connState={connState} onQuickAction={(prompt) => {
            send(prompt);
            setTab('canvas'); setCurrentTab('canvas');
            setTerminalVisible(true);
          }} />
        </div>

        {/* Origin Terminal — always on top of Canvas UI */}
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 0, zIndex: 10,
          height: `${terminalHeight}%`,
          transform: terminalVisible ? 'translateY(0)' : 'translateY(100%)',
          transition: dragging.current ? 'none' : 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)',
          display: 'flex', flexDirection: 'column',
          backgroundColor: '#0a0a0a',
          borderTopLeftRadius: 12, borderTopRightRadius: 12,
          boxShadow: terminalVisible ? '0 -4px 20px rgba(0,0,0,0.5)' : 'none',
        }}>
          {/* Drag handle bar — drag to resize, tap to collapse */}
          <div
            onClick={(e) => { if (!dragging.current) toggleTerminal(); }}
            onTouchStart={(e) => {
              dragging.current = true;
              dragStartY.current = e.touches[0].clientY;
              dragStartH.current = terminalHeight;
            }}
            onTouchMove={(e) => {
              if (!dragging.current) return;
              const containerH = (e.currentTarget.parentElement?.parentElement?.getBoundingClientRect().height || 600);
              const dy = dragStartY.current - e.touches[0].clientY;
              const newH = dragStartH.current + (dy / containerH * 100);
              setTerminalHeight(Math.max(20, Math.min(95, newH)));
            }}
            onTouchEnd={() => {
              if (terminalHeight < 25) { setTerminalVisible(false); setTerminalHeight(40); }
              dragging.current = false;
            }}
            style={{
              display: 'flex', justifyContent: 'center', alignItems: 'center',
              padding: '10px 0 6px', cursor: 'grab', flexShrink: 0, touchAction: 'none',
            }}
          >
            <div style={{ width: 36, height: 4, borderRadius: 2, backgroundColor: 'rgba(255,255,255,0.25)' }} />
          </div>
          <TerminalOverlay messages={messages} visible={true} />
          {/* ESC button — bottom-right of terminal, only when open */}
          <div style={{ padding: '4px 12px 6px', display: 'flex', alignItems: 'center', justifyContent: 'flex-end' }}>
            <span style={{ marginRight: 8, color: '#888', fontSize: 11, fontFamily: 'Menlo, monospace' }}>
              {isProcessing ? (() => {
                const words = ['thinking...', 'pondering...', 'wondering...', 'reasoning...', 'considering...', 'analyzing...', 'processing...', 'compacting...'];
                return words[Math.floor(Date.now() / 4000) % words.length];
              })() : 'idle'}
            </span>
            <button tabIndex={-1} onClick={interrupt} style={{
              padding: '3px 10px', borderRadius: 5, cursor: 'pointer', flexShrink: 0,
              border: isProcessing ? '1px solid rgba(255,59,48,0.4)' : '1px solid rgba(255,255,255,0.1)',
              backgroundColor: isProcessing ? 'rgba(255,59,48,0.15)' : 'transparent',
              color: isProcessing ? '#ff453a' : '#555', fontSize: 11, fontFamily: 'Menlo, monospace',
            }}>ESC</button>
          </div>
        </div>
      </div>

      {/* Shared InputBar — always visible */}
      <div ref={inputBarRef}>
        <InputBar
          onSend={handleSend} onStop={interrupt}
          isProcessing={isProcessing} connected={connState === 'connected'}
          terminalVisible={terminalVisible} onToggleTerminal={toggleTerminal}
          hasNew={hasNew} onAttach={handleAttach} onSketch={() => setSketchOpen(true)}
          pendingSketch={pendingSketch ? pendingSketch.dataUrl : null}
          pendingFile={pendingFile ? (pendingFile.isImage ? 'image' : 'file') : null}
          onClearPending={() => { setPendingSketch(null); setPendingFile(null); }}
          keyboardOpen={keyboardOpen}
        />
      </div>
      {!keyboardOpen && <TabBar tab={tab} onTab={handleTab} />}
      {/* Attach menu — frosted glass popup with Framer Motion */}
      <AnimatePresence>
        {attachMenu && (<>
          <motion.div
            key="attach-backdrop"
            initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            onClick={() => setAttachMenu(false)}
            style={{ position: 'fixed', inset: 0, zIndex: 998 }}
          />
          <motion.div
            key="attach-menu"
            initial={{ scale: 0.3, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: 0.3, opacity: 0 }}
            transition={{ type: 'spring', stiffness: 500, damping: 25 }}
            style={{
              position: 'absolute',
              bottom: (inputBarRef.current ? inputBarRef.current.getBoundingClientRect().height + (keyboardOpen ? 8 : 36) : 84),
              left: 12, zIndex: 999,
              backgroundColor: 'rgba(30,30,30,0.85)', backdropFilter: 'blur(40px)', WebkitBackdropFilter: 'blur(40px)',
              borderRadius: 14, padding: '4px 0', minWidth: 200,
              boxShadow: '0 8px 40px rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.08)',
              transformOrigin: 'bottom left',
            }}
          >
            {[
              { label: 'Attach File', icon: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>), action: () => uploadFile('image/*,.pdf,.md,.txt,.csv,.json,.py,.js,.ts,.jsx,.tsx') },
              { label: 'Sketch', icon: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.85 0 114 4L7.5 20.5 2 22l1.5-5.5Z"/></svg>), action: () => { setAttachMenu(false); setSketchOpen(true); } },
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
      {sketchOpen && createPortal(
        <Sketch onInsert={handleSketchInsert} onClose={() => setSketchOpen(false)} />,
        document.body
      )}

      {/* Session Terminal — slides in from right, swipe back to dismiss */}
      <AnimatePresence>
        {selectedSession && (
          <SessionTerminal
            session={selectedSession}
            messages={sessionMessages}
            onBack={() => setSelectedSession(null)}
            onSend={async (text) => {
              // Show user message immediately
              const msgId = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
              setSessionMessages(prev => [...prev, { id: msgId, role: 'user', type: 'text', content: text, ts: Date.now(), pending: true }]);
              try {
                // Check if session is alive
                const token = localStorage.getItem('morph-auth') || '';
                const checkRes = await fetch('/v2/claude/active', { headers: { 'Authorization': `Bearer ${token}` } });
                const checkData = await checkRes.json();
                const alive = (checkData.sessions || []).find((s: any) => s.id === selectedSession.id && s.alive);
                if (alive) {
                  await sendToSession(selectedSession.id, text);
                } else {
                  const newSid = await resumeSession(selectedSession.id, text);
                  // Update subscription if session ID changed
                  if (newSid !== selectedSession.id) {
                    subscribeSessionMessages(newSid, (msg) => {
                      setSessionMessages(prev => [...prev, msg]);
                    });
                  }
                }
                // Confirm sent
                setSessionMessages(prev => prev.map(m => m.id === msgId ? { ...m, pending: false } : m));
              } catch (err: any) {
                setSessionMessages(prev => [...prev, { id: `${Date.now()}`, role: 'system', type: 'error', content: err.message || 'Send failed', ts: Date.now() }]);
              }
            }}
            keyboardOpen={keyboardOpen}
          />
        )}
      </AnimatePresence>
    </div>
  );
}
