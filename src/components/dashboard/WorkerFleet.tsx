import React from 'react';
import type { WorkerPane } from '../../lib/dashboardApi';

export default function WorkerFleet({ panes, note }: { panes: WorkerPane[]; note?: string }) {
  return (
    <div style={{ background: '#161b22', border: '1px solid #30363d', borderRadius: 8, padding: 16 }}>
      <h2 style={{ margin: '0 0 12px', fontSize: 14, color: '#e6edf3', letterSpacing: 0.5 }}>WORKERS</h2>
      {panes.length === 0 ? (
        <div style={{ fontSize: 11, color: '#6e7681' }}>{note || 'no pane data (workers panel is placeholder for Phase 3)'}</div>
      ) : (
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(120px,1fr))', gap: 8 }}>
          {panes.map((p, i) => (
            <div key={String(p.pane_id ?? i)} style={{ padding: 8, background: '#0d1117', borderRadius: 4, fontSize: 11, color: '#e6edf3' }}>
              <div style={{ color: '#8b949e' }}>pane {String(p.pane_id ?? i)}</div>
              <div style={{ marginTop: 2 }}>{String(p.project ?? p.status ?? 'idle')}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
