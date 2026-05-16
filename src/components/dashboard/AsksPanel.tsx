import React, { useEffect, useRef, useState } from 'react';
import { fetchAsks, resolveAsk, POLL_MS, type Ask } from '../../lib/dashboardApi';

const TAG_COLOR: Record<string, string> = {
  logdrop: '#a78bfa',
  nestry: '#34d399',
  'trump-bot': '#f97316',
  'douyin-bot': '#f472b6',
};

function tagColor(tag?: string): string {
  if (!tag) return '#94a3b8';
  return TAG_COLOR[tag] || '#60a5fa';
}

function fmtAge(iso?: string): string {
  if (!iso) return '';
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return '';
  const mins = Math.max(0, Math.round((Date.now() - t) / 60000));
  if (mins < 60) return `${mins}m`;
  const hrs = Math.round(mins / 60);
  if (hrs < 48) return `${hrs}h`;
  return `${Math.round(hrs / 24)}d`;
}

export default function AsksPanel() {
  const [asks, setAsks] = useState<Ask[] | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [submitting, setSubmitting] = useState<Record<string, boolean>>({});
  const [showDone, setShowDone] = useState(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const load = async () => {
    try {
      const data = await fetchAsks();
      setAsks(data);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    load();
    timerRef.current = setInterval(load, POLL_MS);
    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  const onResolve = async (id: string) => {
    const resp = (drafts[id] || '').trim();
    if (!resp) return;
    setSubmitting((s) => ({ ...s, [id]: true }));
    const r = await resolveAsk(id, resp);
    setSubmitting((s) => ({ ...s, [id]: false }));
    if (!r.ok) {
      setErr(r.error || 'resolve failed');
      return;
    }
    setDrafts((d) => {
      const { [id]: _omit, ...rest } = d;
      return rest;
    });
    await load();
  };

  const pending = (asks || []).filter((a) => a.status === 'pending');
  const done = (asks || []).filter((a) => a.status === 'done').slice(-20).reverse();

  return (
    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 14, color: '#e6edf3', letterSpacing: 0.5 }}>ASKS</h2>
        <span style={{ fontSize: 11, color: '#6e7681' }}>
          pending <span style={{ color: pending.length > 0 ? '#fbbf24' : '#6e7681' }}>{pending.length}</span>
          <span style={{ margin: '0 6px', color: '#30363d' }}>·</span>
          done {done.length}
        </span>
        {err && <span style={{ fontSize: 11, color: '#f87171' }}>err: {err}</span>}
      </div>

      {asks === null ? (
        <div style={{ color: '#6e7681', fontSize: 12 }}>loading…</div>
      ) : pending.length === 0 ? (
        <div style={{ color: '#6e7681', fontSize: 12, padding: '8px 0' }}>no pending asks</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
          {pending.map((a) => (
            <div
              key={a.id}
              style={{
                background: '#0d1117',
                border: '1px solid #3b3321',
                borderLeft: '3px solid #fbbf24',
                borderRadius: 6,
                padding: '10px 12px',
              }}
            >
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
                {a.tag && (
                  <span style={{ fontSize: 11, padding: '1px 7px', borderRadius: 3, background: '#0b0d10', color: tagColor(a.tag) }}>
                    {a.tag}
                  </span>
                )}
                <span style={{ fontWeight: 600, color: '#e6edf3', fontSize: 13 }}>{a.title}</span>
                <span style={{ fontSize: 10, color: '#6b7280', marginLeft: 'auto' }}>
                  {a.id.slice(0, 8)} · {fmtAge(a.ts_created)} ago
                </span>
              </div>
              {a.detail && (
                <div style={{ color: '#9ca3af', fontSize: 12, marginTop: 6, whiteSpace: 'pre-wrap' }}>{a.detail}</div>
              )}
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  onResolve(a.id);
                }}
                style={{ display: 'flex', gap: 6, marginTop: 8 }}
              >
                <input
                  value={drafts[a.id] || ''}
                  onChange={(e) => setDrafts((d) => ({ ...d, [a.id]: e.target.value }))}
                  placeholder="response / decision"
                  style={{
                    flex: 1,
                    background: '#0b0d10',
                    color: '#e5e7eb',
                    border: '1px solid #1f2937',
                    borderRadius: 4,
                    padding: '4px 8px',
                    fontSize: 12,
                    fontFamily: 'inherit',
                  }}
                />
                <button
                  type="submit"
                  disabled={!!submitting[a.id] || !(drafts[a.id] || '').trim()}
                  style={{
                    background: '#065f46',
                    color: '#fff',
                    border: 0,
                    padding: '4px 12px',
                    borderRadius: 4,
                    fontSize: 12,
                    cursor: submitting[a.id] ? 'wait' : 'pointer',
                    opacity: !(drafts[a.id] || '').trim() ? 0.5 : 1,
                  }}
                >
                  {submitting[a.id] ? '...' : 'resolve'}
                </button>
              </form>
            </div>
          ))}
        </div>
      )}

      {done.length > 0 && (
        <div style={{ marginTop: 14 }}>
          <button
            onClick={() => setShowDone((v) => !v)}
            style={{
              background: 'transparent',
              color: '#8b949e',
              border: 0,
              fontSize: 11,
              cursor: 'pointer',
              padding: 0,
              letterSpacing: 0.5,
              textTransform: 'uppercase',
            }}
          >
            {showDone ? '▼' : '▶'} done ({done.length})
          </button>
          {showDone && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, marginTop: 6 }}>
              {done.map((a) => (
                <div key={a.id} style={{ fontSize: 11, color: '#6b7280', padding: '3px 0', borderBottom: '1px dotted #1f2937' }}>
                  {a.tag && (
                    <span style={{ color: tagColor(a.tag), marginRight: 6 }}>[{a.tag}]</span>
                  )}
                  <span style={{ color: '#8b949e' }}>{a.title}</span>
                  {a.response && <span style={{ color: '#059669' }}> → {a.response}</span>}
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
