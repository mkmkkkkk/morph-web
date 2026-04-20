import React, { useEffect, useRef, useState } from 'react';
import { fetchSnapshot, POLL_MS, type Snapshot } from '../lib/dashboardApi';
import KpiStrip from './dashboard/KpiStrip';
import RedditFarmPanel from './dashboard/RedditFarmPanel';
import BoardTable from './dashboard/BoardTable';
import WorkerFleet from './dashboard/WorkerFleet';

export default function Dashboard() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [lastOk, setLastOk] = useState<number | null>(null);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  useEffect(() => {
    let cancelled = false;
    const run = async () => {
      try {
        const data = await fetchSnapshot();
        if (cancelled) return;
        setSnap(data);
        setErr(null);
        setLastOk(Date.now());
      } catch (e) {
        if (cancelled) return;
        setErr(e instanceof Error ? e.message : String(e));
      }
    };
    run();
    timerRef.current = setInterval(run, POLL_MS);
    return () => {
      cancelled = true;
      if (timerRef.current) clearInterval(timerRef.current);
    };
  }, []);

  return (
    <div style={{ minHeight: '100vh', background: '#0d1117', color: '#e6edf3', padding: 20, fontFamily: 'ui-monospace, "SF Mono", Menlo, monospace' }}>
      <header style={{ display: 'flex', alignItems: 'baseline', gap: 12, marginBottom: 20, borderBottom: '1px solid #30363d', paddingBottom: 12 }}>
        <h1 style={{ margin: 0, fontSize: 20, letterSpacing: 1 }}>NERVE DASHBOARD</h1>
        <span style={{ fontSize: 11, color: '#6e7681' }}>
          {lastOk ? `last update ${Math.max(0, Math.round((Date.now() - lastOk) / 1000))}s ago` : 'loading…'}
        </span>
        {err && <span style={{ fontSize: 11, color: '#f87171' }}>api error: {err}</span>}
        <span style={{ marginLeft: 'auto', fontSize: 11, color: '#6e7681' }}>
          <a href="/" style={{ color: '#60a5fa' }}>← back to main</a>
        </span>
      </header>

      {!snap ? (
        <div style={{ color: '#6e7681', padding: 40, textAlign: 'center' }}>
          waiting for first snapshot… (API at http://127.0.0.1:3005/api/snapshot)
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <section>
            <h2 style={{ fontSize: 11, color: '#8b949e', textTransform: 'uppercase', letterSpacing: 1, marginBottom: 8 }}>KPIs</h2>
            <KpiStrip kpis={snap.board.kpis} />
          </section>

          <RedditFarmPanel data={snap.reddit_farm} />

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(360px,1fr))', gap: 16 }}>
            <BoardTable rows={snap.board.rows} />
            <WorkerFleet panes={snap.workers.panes} note={snap.workers._note} />
          </div>
        </div>
      )}
    </div>
  );
}
