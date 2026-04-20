import React from 'react';
import type { RedditFarmData } from '../../lib/dashboardApi';

const STATUS_COLOR: Record<string, string> = {
  registered: '#4ade80',
  code_timeout: '#fbbf24',
  code_timeout_manual: '#fbbf24',
  registered_but_404: '#f87171',
  error: '#ef4444',
  field_error: '#ef4444',
  pending: '#60a5fa',
  captcha_timeout: '#f59e0b',
  unclear: '#94a3b8',
  other: '#94a3b8',
  unknown: '#94a3b8',
};

function StatusBar({ breakdown, total }: { breakdown: Record<string, number>; total: number }) {
  const entries = Object.entries(breakdown).sort((a, b) => b[1] - a[1]);
  if (total <= 0) return null;
  return (
    <div>
      <div style={{ display: 'flex', height: 24, borderRadius: 4, overflow: 'hidden', background: '#0d1117' }}>
        {entries.map(([s, n]) => (
          <div
            key={s}
            title={`${s}: ${n}`}
            style={{ width: `${(n / total) * 100}%`, background: STATUS_COLOR[s] || '#94a3b8' }}
          />
        ))}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(160px,1fr))', gap: 6, marginTop: 8 }}>
        {entries.map(([s, n]) => (
          <div key={s} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: '#8b949e' }}>
            <span style={{ width: 8, height: 8, borderRadius: 2, background: STATUS_COLOR[s] || '#94a3b8' }} />
            <span style={{ color: '#e6edf3' }}>{s}</span>
            <span style={{ marginLeft: 'auto' }}>{n}</span>
            <span style={{ color: '#6e7681' }}>({((n / total) * 100).toFixed(1)}%)</span>
          </div>
        ))}
      </div>
    </div>
  );
}

export default function RedditFarmPanel({ data }: { data: RedditFarmData }) {
  const total = data.registered_total ?? 0;
  const alive = data.alive_count;
  const aliveRate = data.alive_rate_pct;
  return (
    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 16 }}>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginBottom: 12 }}>
        <h2 style={{ margin: 0, fontSize: 14, color: '#e6edf3', letterSpacing: 0.5 }}>REDDIT FARM</h2>
        <span style={{ fontSize: 11, color: '#6e7681' }}>
          health check: {data.health_checked_at ? new Date(data.health_checked_at).toLocaleString() : '—'}
        </span>
      </div>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(140px,1fr))', gap: 12, marginBottom: 16 }}>
        <Stat label="registered" value={total} />
        <Stat label="alive" value={alive ?? '—'} tint="#4ade80" />
        <Stat label="alive rate" value={aliveRate != null ? `${aliveRate}%` : '—'} tint="#60a5fa" />
        <Stat label="roster" value={data.roster_total ?? '—'} />
      </div>

      <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 6 }}>registered_total breakdown ({total})</div>
      <StatusBar breakdown={data.registered_by_status || {}} total={total} />

      {data.roster_by_phase && Object.keys(data.roster_by_phase).length > 0 && (
        <div style={{ marginTop: 16 }}>
          <div style={{ fontSize: 11, color: '#8b949e', marginBottom: 6 }}>roster by phase</div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
            {Object.entries(data.roster_by_phase).map(([phase, n]) => (
              <span key={phase} style={{ fontSize: 11, padding: '3px 8px', background: '#0d1117', borderRadius: 12, color: '#e6edf3' }}>
                {phase}: {n}
              </span>
            ))}
          </div>
        </div>
      )}

      {data.registered_error && (
        <div style={{ marginTop: 12, fontSize: 11, color: '#f87171' }}>registered.json error: {data.registered_error}</div>
      )}
    </div>
  );
}

function Stat({ label, value, tint }: { label: string; value: React.ReactNode; tint?: string }) {
  return (
    <div>
      <div style={{ fontSize: 10, color: '#6e7681', textTransform: 'uppercase', letterSpacing: 0.5 }}>{label}</div>
      <div style={{ fontSize: 22, fontWeight: 600, color: tint || '#e6edf3' }}>{value}</div>
    </div>
  );
}
