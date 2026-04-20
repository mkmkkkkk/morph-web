import React from 'react';
import type { BoardRow } from '../../lib/dashboardApi';

const HEALTH_COLOR: Record<string, string> = {
  green: '#4ade80',
  yellow: '#fbbf24',
  red: '#f87171',
};

export default function BoardTable({ rows }: { rows: BoardRow[] }) {
  const top = rows.slice(0, 10);
  return (
    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 16 }}>
      <h2 style={{ margin: '0 0 12px', fontSize: 14, color: '#e6edf3', letterSpacing: 0.5 }}>BOARD (TOP 10)</h2>
      <div style={{ display: 'grid', gridTemplateColumns: 'auto 60px 60px 1fr', gap: 8, fontSize: 11, color: '#8b949e', paddingBottom: 6, borderBottom: '1px solid #30363d' }}>
        <span>project</span>
        <span>H</span>
        <span>P</span>
        <span>next action</span>
      </div>
      {top.map((r) => (
        <div key={r.id} style={{ display: 'grid', gridTemplateColumns: 'auto 60px 60px 1fr', gap: 8, fontSize: 12, padding: '6px 0', borderBottom: '1px solid #21262d', alignItems: 'baseline' }}>
          <span style={{ color: '#e6edf3', fontWeight: 500 }}>{r.id}</span>
          <span style={{ color: HEALTH_COLOR[r.health || ''] || '#94a3b8' }}>● {r.health || '—'}</span>
          <span style={{ color: '#8b949e' }}>{r.priority ?? '—'}</span>
          <span style={{ color: '#c9d1d9', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={r.next_action || ''}>
            {r.next_action || '—'}
          </span>
        </div>
      ))}
    </div>
  );
}
