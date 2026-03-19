import { useEffect, useRef, useState, useCallback } from 'react';
import { connect, send, interrupt, onMessage, onState, getState, type Message } from './lib/connection';

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
      <div style={{ color: '#fff', fontSize: 24, fontWeight: 600 }}>Morph</div>
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
    <div style={{ marginBottom: 2 }}>
      <div onClick={() => setOpen(!open)} style={{ cursor: 'pointer', color, fontSize: 12, fontFamily: 'Menlo, monospace', lineHeight: '18px' }}>
        {open ? '▾' : '▸'} {label}{!open && preview ? `: ${preview}` : ''}
      </div>
      {open && <pre style={{ color: '#888', fontSize: 12, fontFamily: 'Menlo, monospace', lineHeight: '17px', marginLeft: 16, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{content}</pre>}
    </div>
  );
}

// ─── Message Row ───
function MessageRow({ msg }: { msg: Message }) {
  const mono = { fontFamily: 'Menlo, monospace', fontSize: 12, lineHeight: '18px' } as const;
  switch (msg.type) {
    case 'text':
      return msg.role === 'user'
        ? <div style={{ ...mono, color: '#30d158', marginBottom: 3 }}>&gt; {msg.content}</div>
        : <div style={{ ...mono, color: '#e0e0e0', marginBottom: 3, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{msg.content}</div>;
    case 'thinking':
      return <Collapsible label="thinking" preview={msg.content.slice(0, 60)} content={msg.content} color="#8e8e93" />;
    case 'tool':
      return <Collapsible label={msg.name || 'tool'} preview={msg.content.slice(0, 80).replace(/\n/g, ' ')} content={msg.content} color="#bf5af2" />;
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
      height: '50vh', overflowY: 'auto', padding: '8px 12px',
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
function InputBar({ onSend, onStop, isProcessing, connected, terminalVisible, onToggleTerminal, hasNew, onAttach }: {
  onSend: (text: string) => void; onStop: () => void; isProcessing: boolean; connected: boolean;
  terminalVisible: boolean; onToggleTerminal: () => void; hasNew: boolean;
  onAttach: () => void;
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
    <div style={{ borderTop: '1px solid rgba(255,255,255,0.06)', padding: '8px 10px', display: 'flex', alignItems: 'flex-end', gap: 6 }}>
      {/* Connection dot */}
      <div style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: dotColor, flexShrink: 0 }} />

      {/* Terminal toggle (first — closer to edge) */}
      <button tabIndex={-1} onClick={onToggleTerminal} style={{
        width: 34, height: 34, borderRadius: 17, border: 'none', cursor: 'pointer', flexShrink: 0,
        backgroundColor: 'rgba(255,255,255,0.08)',
        color: hasNew ? '#30d158' : '#666', fontSize: 22, lineHeight: '22px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        animation: isProcessing ? 'pulse 0.8s infinite' : undefined,
      }}>{terminalVisible ? '⌄' : '›'}</button>

      {/* Attach button */}
      <button tabIndex={-1} onClick={onAttach} style={{
        width: 34, height: 34, borderRadius: 17, border: 'none', cursor: 'pointer', flexShrink: 0,
        backgroundColor: 'rgba(255,255,255,0.08)', color: '#666', fontSize: 22, lineHeight: '22px',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
      }}>+</button>

      {/* Text input — textarea with auto-grow, Enter=send, Shift+Enter=newline */}
      <textarea ref={ref} value={text}
        onChange={e => {
          setText(e.target.value);
          // Auto-grow: reset then expand
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

      {/* Send / Stop */}
      {isProcessing ? (
        <button tabIndex={-1} onClick={onStop} style={{ width: 36, height: 36, borderRadius: 18, border: 'none', backgroundColor: '#ff3b30', cursor: 'pointer', display: 'flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 }}>
          <div style={{ width: 12, height: 12, borderRadius: 2, backgroundColor: '#fff' }} />
        </button>
      ) : (
        <button tabIndex={-1} onClick={handleSend} disabled={!text.trim()} style={{
          width: 36, height: 36, borderRadius: 18, border: 'none', flexShrink: 0,
          backgroundColor: text.trim() ? '#333' : '#1c1c1e', cursor: text.trim() ? 'pointer' : 'default',
          color: text.trim() ? '#fff' : '#444', fontSize: 18, fontWeight: 'bold',
        }}>↑</button>
      )}
    </div>
  );
}

// ─── Canvas Tab (iframe canvas + terminal overlay + input bar) ───
function CanvasTab({ messages, isProcessing, connected, onSend, onStop }: {
  messages: Message[]; isProcessing: boolean; connected: boolean;
  onSend: (text: string) => void; onStop: () => void;
}) {
  const [terminalVisible, setTerminalVisible] = useState(false); // default: show Canvas, terminal hidden
  const [hasNew, setHasNew] = useState(false);
  const prevCount = useRef(0);

  useEffect(() => {
    if (messages.length > prevCount.current && !terminalVisible) setHasNew(true);
    prevCount.current = messages.length;
  }, [messages.length, terminalVisible]);

  const toggleTerminal = () => {
    setTerminalVisible(v => !v);
    setHasNew(false);
  };

  const handleAttach = () => {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = 'image/*,.pdf,.txt,.md,.json,.csv';
    input.onchange = async (e: any) => {
      const file = e.target?.files?.[0];
      if (!file) return;

      // Read as base64
      const b64: string = await new Promise((resolve) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1]);
        reader.readAsDataURL(file);
      });

      // Upload to relay → saves to ~/Downloads/
      try {
        const token = localStorage.getItem('morph-auth') || '';
        const res = await fetch('/v2/claude/upload', {
          method: 'POST',
          headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ filename: file.name, base64: b64, mime: file.type }),
        });
        const data = await res.json();
        if (data.path) {
          // Tell Claude to read the uploaded file
          if (file.type.startsWith('image/')) {
            onSend(`Look at this image: ${data.path}`);
          } else {
            onSend(`Read this file: ${data.path}`);
          }
        } else {
          onSend(`[Upload failed: ${data.error || 'unknown'}]`);
        }
      } catch (err: any) {
        onSend(`[Upload error: ${err.message}]`);
      }
    };
    input.click();
  };

  return (
    <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
      {/* Canvas area (iframe) — hidden when terminal is open on mobile */}
      <div style={{ flex: 1, position: 'relative', display: terminalVisible ? 'none' : 'flex' }}>
        <iframe src="/canvas.html" style={{ width: '100%', height: '100%', border: 'none', backgroundColor: '#0a0a0a' }} sandbox="allow-scripts allow-same-origin" />
      </div>

      {/* Terminal overlay — auto-expand on send per design doc */}
      {terminalVisible && (
        <div style={{ flex: 1, display: 'flex', flexDirection: 'column' }}>
          <TerminalOverlay messages={messages} visible={true} />
        </div>
      )}

      <InputBar
        onSend={onSend} onStop={onStop}
        isProcessing={isProcessing} connected={connected}
        terminalVisible={terminalVisible} onToggleTerminal={toggleTerminal}
        hasNew={hasNew} onAttach={handleAttach}
      />
    </div>
  );
}

// ─── Config Tab ───
function ConfigTab({ connState }: { connState: string }) {
  const [sessions, setSessions] = useState<any[]>([]);
  const [activeSessions, setActiveSessions] = useState<any[]>([]);
  const token = () => localStorage.getItem('morph-auth') || '';
  const headers = () => ({ 'Authorization': `Bearer ${token()}` });

  const loadActive = async () => {
    try { const r = await fetch('/v2/claude/active', { headers: headers() }); const d = await r.json(); setActiveSessions(d.sessions || []); } catch {}
  };
  const loadHistory = async () => {
    try { const r = await fetch('/v2/claude/sessions', { headers: headers() }); const d = await r.json(); setSessions((d.sessions || []).slice(0, 20)); } catch {}
  };

  useEffect(() => { loadActive(); }, []);

  return (
    <div style={{ flex: 1, overflowY: 'auto', padding: 16, WebkitOverflowScrolling: 'touch' as any }}>
      <div style={{ fontSize: 20, fontWeight: 600, marginBottom: 16 }}>Config</div>

      <Section title="Connection">
        <Row label="Status" value={connState} valueColor={connState === 'connected' ? '#30d158' : '#ff453a'} />
        <Row label="Server" value={window.location.origin} />
      </Section>

      <Section title="Quick Actions">
        {[
          { label: 'Status Check', prompt: 'Give me a brief status update on current work.' },
          { label: 'Git Status', prompt: 'Run git status and summarize.' },
          { label: 'Build Dashboard', prompt: 'Build me a live dashboard component.' },
        ].map(a => (
          <button key={a.label} onClick={() => send(a.prompt)} style={{
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

      <Section title="Session History">
        <button onClick={loadHistory} style={{ padding: '8px', border: 'none', borderRadius: 8, cursor: 'pointer', fontSize: 13, width: '100%', backgroundColor: 'rgba(255,255,255,0.06)', color: '#aaa', marginBottom: 8 }}>Load History</button>
        {sessions.map((s: any) => (
          <div key={s.id} style={{ fontFamily: 'Menlo, monospace', fontSize: 12, color: '#666', padding: '4px 0' }}>
            {s.id.slice(0, 8)}... {s.size ? `${(s.size / 1024).toFixed(0)}KB` : ''}
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
    <div style={{ display: 'flex', borderTop: '1px solid rgba(255,255,255,0.06)', paddingBottom: 'max(4px, env(safe-area-inset-bottom))' }}>
      {[{ id: 'canvas', icon: '◇', label: 'Canvas' }, { id: 'config', icon: '⚙', label: 'Config' }].map(t => (
        <button key={t.id} tabIndex={-1} onClick={() => onTab(t.id)} style={{
          flex: 1, padding: '8px 0 4px', border: 'none', cursor: 'pointer', backgroundColor: 'transparent',
          color: tab === t.id ? '#fff' : '#636366', display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2,
        }}>
          <span style={{ fontSize: 20 }}>{t.icon}</span>
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
  const idleTimer = useRef<ReturnType<typeof setTimeout>>();

  useEffect(() => {
    if (!authed) return;
    const unsub1 = onMessage((msg) => {
      setMessages(prev => [...prev, msg]);
      if (msg.role === 'agent') setIsProcessing(true);
      if (msg.type === 'status' || msg.type === 'error') setIsProcessing(false);
      clearTimeout(idleTimer.current);
      idleTimer.current = setTimeout(() => setIsProcessing(false), 3000);
    });
    const unsub2 = onState(setConnState);
    connect();
    return () => { unsub1(); unsub2(); };
  }, [authed]);

  if (!authed) return <PasswordGate onAuth={() => setAuthed(true)} />;

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', maxWidth: 600, margin: '0 auto', width: '100%' }}>
      {tab === 'canvas' ? (
        <CanvasTab messages={messages} isProcessing={isProcessing} connected={connState === 'connected'} onSend={send} onStop={interrupt} />
      ) : (
        <ConfigTab connState={connState} />
      )}
      <TabBar tab={tab} onTab={setTab} />
    </div>
  );
}
