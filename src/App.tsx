import { useEffect, useRef, useState, useCallback } from 'react';
import { connect, send, interrupt, clearSession, setCurrentTab, onMessage, onState, getState, type Message } from './lib/connection';
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
      <div style={{ color: '#666', fontSize: 14, marginTop: -8 }}>Morph</div>
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
      {open && <pre style={{ color: '#888', fontSize: 12, fontFamily: 'Menlo, monospace', lineHeight: '17px', marginLeft: 16, whiteSpace: 'pre-wrap', wordBreak: 'break-all', overflow: 'hidden', maxWidth: '100%', margin: 0, marginLeft: 16 }}>{content}</pre>}
    </div>
  );
}

// ─── Message Row ───
function MessageRow({ msg }: { msg: Message }) {
  const mono = { fontFamily: 'Menlo, monospace', fontSize: 14, lineHeight: '20px', overflow: 'hidden' as const, maxWidth: '100%' } as const;
  switch (msg.type) {
    case 'text':
      return msg.role === 'user'
        ? <div style={{ ...mono, color: '#30d158', marginBottom: 3 }}>&gt; {msg.content}</div>
        : <div style={{ ...mono, color: '#e0e0e0', marginBottom: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.content}</div>;
    case 'thinking':
      return <Collapsible label="thinking" preview={msg.content.slice(0, 60)} content={msg.content} color="#8e8e93" />;
    case 'tool':
      return <Collapsible label={msg.name || 'tool'} preview={msg.content.slice(0, 80).replace(/\n/g, ' ')} content={msg.content} color="#8e8e93" />;
    case 'tool_result':
      return <Collapsible label="result" preview={msg.content.slice(0, 80).replace(/\n/g, ' ')} content={msg.content.length > 2000 ? msg.content.slice(0, 2000) + '\n...' : msg.content} color="#64d2ff" />;
    case 'status':
      return <div style={{ ...mono, color: '#555', textAlign: 'center', marginTop: 4, marginBottom: 4 }}>{msg.content}</div>;
    case 'error':
      return <div style={{ ...mono, color: '#ff453a', marginBottom: 3 }}>{msg.content}</div>;
    default: return null;
  }
}

// ─── Terminal Overlay (toggle-able, sits above input bar) ───
function TerminalOverlay({ messages, visible }: { messages: Message[]; visible: boolean }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length]);

  if (!visible) return null;
  return (
    <div ref={scrollRef} style={{
      flex: '1 1 0', minHeight: 0, overflowY: 'scroll', overflowX: 'hidden', padding: '8px 12px',
      borderTop: '1px solid rgba(255,255,255,0.08)', backgroundColor: '#0a0a0a',
      WebkitOverflowScrolling: 'touch' as any,
    }}>
      {messages.length === 0
        ? <div style={{ color: '#333', fontSize: 13, textAlign: 'center', padding: 16, fontFamily: 'Menlo, monospace' }}>waiting for session...</div>
        : messages.map(msg => <MessageRow key={msg.id} msg={msg} />)
      }
    </div>
  );
}

// ─── Input Bar (matches native: dot + attach + terminal toggle + input + send/stop) ───
function InputBar({ onSend, onStop, isProcessing, connected, terminalVisible, onToggleTerminal, hasNew, onAttach, onSketch, pendingSketch }: {
  onSend: (text: string) => void; onStop: () => void; isProcessing: boolean; connected: boolean;
  terminalVisible: boolean; onToggleTerminal: () => void; hasNew: boolean;
  onAttach: () => void;
  onSketch: () => void;
  pendingSketch: string | null;
}) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLTextAreaElement>(null);

  const handleSend = useCallback(() => {
    const t = text.trim();
    if (!t) return;
    onSend(t);
    setText('');
    if (ref.current) ref.current.style.height = '36px';
  }, [text, onSend]);

  const dotColor = connected ? '#30d158' : '#636366';

  return (
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '8px 10px', display: 'flex', alignItems: 'center', gap: 6 }}>
      {/* Connection dot */}
      <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor, flexShrink: 0, marginBottom: 0 }} />

      {/* Terminal toggle — equilateral triangle (side=14px → height=12px) */}
      <button tabIndex={-1} onClick={onToggleTerminal} style={{
        width: 34, height: 34, borderRadius: 17, border: 'none', cursor: 'pointer', flexShrink: 0,
        backgroundColor: 'rgba(255,255,255,0.08)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>
        <div style={{
          width: 0, height: 0,
          borderLeft: '6px solid transparent', borderRight: '6px solid transparent',
          ...(terminalVisible
            ? { borderTop: `10px solid ${isProcessing ? '#30d158' : hasNew ? '#999' : '#666'}` }
            : { borderBottom: `10px solid ${isProcessing ? '#30d158' : hasNew ? '#999' : '#666'}` }),
        }} />
      </button>

      {/* Attach menu button */}
      <button tabIndex={-1} onClick={onAttach}
        style={{
          width: 34, height: 34, borderRadius: 17, border: 'none', cursor: 'pointer', flexShrink: 0,
          backgroundColor: pendingSketch ? 'rgba(48,209,88,0.2)' : 'rgba(255,255,255,0.08)',
          color: pendingSketch ? '#30d158' : '#666', fontSize: 22, lineHeight: '22px',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}>
        {pendingSketch ? '✓' : '+'}
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
        placeholder="Message Claude Code..."
        rows={1}
        enterKeyHint="send"
        autoComplete="off"
        style={{
          flex: 1, minHeight: 36, maxHeight: 120, resize: 'none',
          borderRadius: 18, border: 'none', outline: 'none',
          padding: '8px 16px', fontSize: 16, lineHeight: '20px',
          fontFamily: '-apple-system, system-ui, sans-serif', backgroundColor: '#1c1c1e', color: '#fff',
          WebkitAppearance: 'none' as any,
        }}
      />

      {/* Send button — always visible */}
      <button tabIndex={-1} onClick={handleSend} disabled={!text.trim()} style={{
        width: 36, height: 36, borderRadius: 18, border: 'none', flexShrink: 0,
        backgroundColor: text.trim() ? '#333' : '#1c1c1e', cursor: text.trim() ? 'pointer' : 'default',
        color: text.trim() ? '#fff' : '#444', fontSize: 18, fontWeight: 'bold',
      }}>↑</button>
    </div>
  );
}

// ─── Config Tab ───
function ConfigTab({ connState, onQuickAction }: { connState: string; onQuickAction: (prompt: string) => void }) {
  const [activeSessions, setActiveSessions] = useState<any[]>([]);
  const token = () => localStorage.getItem('morph-auth') || '';
  const headers = () => ({ 'Authorization': `Bearer ${token()}` });

  const loadActive = async () => {
    try { const r = await fetch('/v2/claude/active', { headers: headers() }); const d = await r.json(); setActiveSessions(d.sessions || []); } catch {}
  };

  useEffect(() => { loadActive(); }, []);

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
            backgroundColor: 'rgba(255,255,255,0.06)', color: '#fff', marginBottom: 4,
          }}>{a.label}</button>
        ))}
      </Section>

      <Section title={`Active Sessions (${activeSessions.length})`}>
        <button onClick={loadActive} style={{ padding: '8px', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, width: '100%', backgroundColor: 'rgba(255,255,255,0.06)', color: '#aaa', marginBottom: 8 }}>Refresh</button>
        {activeSessions.map((s: any) => (
          <div key={s.id} style={{ fontFamily: 'Menlo, monospace', fontSize: 12, color: '#aaa', padding: '6px 0', borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
            <span style={{ color: '#30d158' }}>{s.id.slice(0, 8)}</span> {s.cwd} {s.alive ? '●' : '○'}
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

function Section({ title, children }: { title: string; children: React.ReactNode }) {
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
function TabBar({ tab, onTab }: { tab: string; onTab: (t: string) => void }) {
  return (
    <div style={{ display: 'flex', borderTop: '1px solid rgba(255,255,255,0.06)', paddingBottom: 4, flexShrink: 0 }}>
      {[{ id: 'canvas', label: 'Canvas' }, { id: 'config', label: 'Config' }].map(t => (
        <button key={t.id} tabIndex={-1} onClick={() => onTab(t.id)} style={{
          flex: 1, padding: '8px 0 4px', border: 'none', cursor: 'pointer', backgroundColor: 'transparent',
          color: tab === t.id ? '#fff' : '#636366', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
        }}>
          <span style={{ display: 'flex' }}>
            {t.id === 'canvas' ? (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><rect x="3" y="3" width="18" height="18" rx="3"/><path d="M3 9h18M9 3v18"/></svg>
            ) : (
              <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5"><path d="M12.22 2h-.44a2 2 0 00-2 2v.18a2 2 0 01-1 1.73l-.43.25a2 2 0 01-2 0l-.15-.08a2 2 0 00-2.73.73l-.22.38a2 2 0 00.73 2.73l.15.1a2 2 0 011 1.72v.51a2 2 0 01-1 1.74l-.15.09a2 2 0 00-.73 2.73l.22.38a2 2 0 002.73.73l.15-.08a2 2 0 012 0l.43.25a2 2 0 011 1.73V20a2 2 0 002 2h.44a2 2 0 002-2v-.18a2 2 0 011-1.73l.43-.25a2 2 0 012 0l.15.08a2 2 0 002.73-.73l.22-.39a2 2 0 00-.73-2.73l-.15-.08a2 2 0 01-1-1.74v-.5a2 2 0 011-1.74l.15-.09a2 2 0 00.73-2.73l-.22-.38a2 2 0 00-2.73-.73l-.15.08a2 2 0 01-2 0l-.43-.25a2 2 0 01-1-1.73V4a2 2 0 00-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            )}
          </span>
          <span style={{ fontSize: 10 }}>{t.label}</span>
        </button>
      ))}
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
  const [sketchOpen, setSketchOpen] = useState(false);
  const [canvasLoaded, setCanvasLoaded] = useState(false);
  const [pendingSketch, setPendingSketch] = useState<{ dataUrl: string; bounds: { x: number; y: number; w: number; h: number } } | null>(null);
  const idleTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!authed) return;
    const unsub1 = onMessage((msg) => {
      setMessages(prev => [...prev, msg]);
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
    return () => { unsub1(); unsub2(); };
  }, [authed]);

  const [terminalVisible, setTerminalVisible] = useState(false);
  const [terminalHeight, setTerminalHeight] = useState(70); // percentage
  const [hasNew, setHasNew] = useState(false);
  const prevCount = useRef(0);
  const dragging = useRef(false);
  const dragStartY = useRef(0);
  const dragStartH = useRef(70);

  useEffect(() => {
    if (messages.length > prevCount.current && !terminalVisible && isProcessing) setHasNew(true);
    prevCount.current = messages.length;
  }, [messages.length, terminalVisible, isProcessing]);

  useEffect(() => { if (!isProcessing) setHasNew(false); }, [isProcessing]);

  const toggleTerminal = () => { setTerminalVisible(v => !v); setHasNew(false); };

  const handleTab = (t: string) => { setTab(t); setCurrentTab(t); if (t === 'config') setTerminalVisible(false); };

  const handleSend = async (text: string) => {
    if (text === '/clear') { setMessages([]); setIsProcessing(false); clearSession(); setPendingSketch(null); return; }

    // If there's a pending sketch, upload it first and prepend to message
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
          const sketchContext = `[Sketch annotation at screen position: x=${Math.round(x)}%, y=${Math.round(y)}%, w=${Math.round(w)}%, h=${Math.round(h)}%]\nImage: ${data.path}`;
          send(sketchContext + (text ? `\n\n${text}` : ''));
          setPendingSketch(null);
          return;
        }
      } catch {}
      setPendingSketch(null);
    }

    send(text);
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
          send(file.type.startsWith('image/') ? `Look at this image: ${data.path}` : `Read this file: ${data.path}`);
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
        {/* Canvas iframe */}
        <div style={{ flex: 1, display: tab === 'canvas' ? 'flex' : 'none', position: 'relative' }}>
          {!canvasLoaded && (
            <div style={{ position: 'absolute', inset: 0, display: 'flex', alignItems: 'center', justifyContent: 'center', backgroundColor: '#0a0a0a', zIndex: 1 }}>
              <div style={{ width: 120, height: 2, borderRadius: 1, backgroundColor: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
                <div style={{ width: '40%', height: '100%', backgroundColor: 'rgba(255,255,255,0.3)', borderRadius: 1, animation: 'canvasLoad 1.2s ease-in-out infinite' }} />
              </div>
              <style>{`@keyframes canvasLoad { 0% { transform: translateX(-120%); } 100% { transform: translateX(300%); } }`}</style>
            </div>
          )}
          <iframe key={BUILD_TS} src={`/canvas.html?v=${BUILD_TS}`} onLoad={() => setCanvasLoaded(true)} style={{ width: '100%', height: '100%', border: 'none', backgroundColor: '#0a0a0a' }} sandbox="allow-scripts allow-same-origin" />
        </div>

        {/* Config content */}
        <div style={{ flex: 1, display: tab === 'config' ? 'flex' : 'none', overflow: 'hidden', flexDirection: 'column' }}>
          <ConfigTab connState={connState} onQuickAction={(prompt) => {
            send(prompt);
            setTab('canvas'); setCurrentTab('canvas');
            setTerminalVisible(true);
          }} />
        </div>

        {/* Terminal sheet — slides up from bottom, draggable height */}
        <div style={{
          position: 'absolute', left: 0, right: 0, bottom: 0,
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
              if (terminalHeight < 25) { setTerminalVisible(false); setTerminalHeight(70); }
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
            <span style={{ marginRight: 8, color: '#444', fontSize: 11, fontFamily: 'Menlo, monospace' }}>
              {isProcessing ? (() => {
                const words = ['thinking...', 'pondering...', 'wondering...', 'reasoning...', 'considering...', 'analyzing...', 'processing...'];
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
      <InputBar
        onSend={handleSend} onStop={interrupt}
        isProcessing={isProcessing} connected={connState === 'connected'}
        terminalVisible={terminalVisible} onToggleTerminal={toggleTerminal}
        hasNew={hasNew} onAttach={handleAttach} onSketch={() => setSketchOpen(true)}
        pendingSketch={pendingSketch ? pendingSketch.dataUrl : null}
      />
      <TabBar tab={tab} onTab={handleTab} />
      {/* Attach menu — frosted glass popup */}
      {attachMenu && (<>
        <div onClick={() => setAttachMenu(false)} style={{ position: 'fixed', inset: 0, zIndex: 998 }} />
        <div style={{
          position: 'absolute', bottom: 100, left: 12, zIndex: 999,
          backgroundColor: 'rgba(30,30,30,0.85)', backdropFilter: 'blur(40px)', WebkitBackdropFilter: 'blur(40px)',
          borderRadius: 14, padding: '4px 0', minWidth: 200,
          boxShadow: '0 8px 40px rgba(0,0,0,0.6)', border: '1px solid rgba(255,255,255,0.08)',
        }}>
          {[
            { label: 'Attach File', icon: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M21.44 11.05l-9.19 9.19a6 6 0 01-8.49-8.49l9.19-9.19a4 4 0 015.66 5.66l-9.2 9.19a2 2 0 01-2.83-2.83l8.49-8.48"/></svg>), action: () => uploadFile('image/*,.pdf,.md,.txt,.csv,.json,.py,.js,.ts,.jsx,.tsx') },
            { label: 'Sketch', icon: (<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 19l7-7 3 3-7 7H12v-3z"/><path d="M18 13l-1.5-7.5L2 2l3.5 14.5L13 18l5-5z"/></svg>), action: () => { setAttachMenu(false); setSketchOpen(true); } },
          ].map((item, i) => (
            <div key={item.label}>
              {i > 0 && <div style={{ height: 1, backgroundColor: 'rgba(255,255,255,0.06)', margin: '0 12px' }} />}
              <button tabIndex={-1} onClick={item.action} style={{
                display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                padding: '11px 16px', border: 'none', cursor: 'pointer', borderRadius: 0,
                backgroundColor: 'transparent', color: '#e0e0e0',
                fontSize: 15, textAlign: 'left', fontFamily: '-apple-system, system-ui, sans-serif',
              }}><span style={{ color: '#999', display: 'flex' }}>{item.icon}</span> {item.label}</button>
            </div>
          ))}
        </div>
      </>)}
      {sketchOpen && <Sketch onInsert={handleSketchInsert} onClose={() => setSketchOpen(false)} />}
    </div>
  );
}
