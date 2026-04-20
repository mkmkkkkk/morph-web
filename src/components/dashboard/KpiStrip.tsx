import React from 'react';
import type { KpiCard } from '../../lib/dashboardApi';

const GOAL_COLOR: Record<string, string> = {
  fame: '#ff6b9d',
  wealth: '#4ade80',
  xp: '#60a5fa',
  meta: '#94a3b8',
};

function fmt(n: number | null | undefined, unit?: string | null): string {
  if (n === null || n === undefined) return '—';
  const rounded = typeof n === 'number' ? (Math.abs(n) >= 100 ? Math.round(n) : Math.round(n * 10) / 10) : n;
  return unit ? `${rounded}${unit === '%' ? '%' : ` ${unit}`}` : String(rounded);
}

export default function KpiStrip({ kpis }: { kpis: Record<string, KpiCard> }) {
  const list = Object.values(kpis);
  if (list.length === 0) return null;
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(220px,1fr))', gap: 12 }}>
      {list.map((k) => {
        const color = GOAL_COLOR[k.goal || 'meta'] || '#94a3b8';
        const pct = k.target && k.current != null ? Math.min(100, Math.max(0, (Number(k.current) / Number(k.target)) * 100)) : null;
        const delta = k.delta;
        return (
          <div key={k.id} style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline' }}>
              <span style={{ fontSize: 11, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 0.5 }}>{k.id}</span>
              <span style={{ fontSize: 10, color }}>{k.goal || '—'}</span>
            </div>
            <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, marginTop: 6 }}>
              <span style={{ fontSize: 24, fontWeight: 600, color: '#e6edf3' }}>{fmt(k.current, k.unit)}</span>
              <span style={{ fontSize: 12, color: '#6e7681' }}>/ {fmt(k.target, k.unit)}</span>
              {typeof delta === 'number' && delta !== 0 && (
                <span style={{ fontSize: 11, color: delta > 0 ? '#4ade80' : '#f87171' }}>
                  {delta > 0 ? '▲' : '▼'}{Math.abs(delta).toFixed(delta % 1 === 0 ? 0 : 1)}
                </span>
              )}
            </div>
            {pct !== null && (
              <div style={{ marginTop: 8, height: 4, background: '#0d1117', borderRadius: 2, overflow: 'hidden' }}>
                <div style={{ width: `${pct}%`, height: '100%', background: color, transition: 'width 300ms' }} />
              </div>
            )}
            <div style={{ fontSize: 10, color: '#6e7681', marginTop: 6 }}>{k.description}</div>
          </div>
        );
      })}
    </div>
  );
}
