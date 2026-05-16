// dashboardApi.ts — read-only client for nerve/dashboard_api.py (3005)
// Polls /api/snapshot every POLL_MS. No SSE (MVP).

export interface KpiCard {
  id: string;
  description?: string | null;
  target?: number | null;
  current?: number | null;
  unit?: string | null;
  goal?: string | null;
  deadline?: string | null;
  last_changed?: string | null;
  delta?: number | null;
}

export interface BoardRow {
  id: string;
  status?: string | null;
  priority?: number | null;
  health?: string | null;
  phase?: string | null;
  next_action?: string | null;
  goal?: string | null;
  last_activity_at?: string | null;
}

export interface RedditFarmData {
  registered_total: number | null;
  registered_by_status: Record<string, number>;
  registered_error?: string;
  roster_total: number | null;
  roster_by_phase: Record<string, number>;
  alive_count: number | null;
  dead_count?: number | null;
  health_checked_at?: string | null;
  alive_rate_pct?: number;
  oldmac_heartbeat?: Record<string, unknown>;
}

export interface WorkerPane {
  pane_id?: string | number;
  [key: string]: unknown;
}

export interface Snapshot {
  updated_at: string;
  board: {
    rows: BoardRow[];
    kpis: Record<string, KpiCard>;
    board_updated_at?: string;
    _error?: string;
  };
  reddit_farm: RedditFarmData;
  workers: {
    panes: WorkerPane[];
    updated_at?: string;
    _note?: string;
  };
}

const DEFAULT_BASE = 'http://127.0.0.1:3005';

function apiBase(): string {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  return (meta.env && meta.env.VITE_DASHBOARD_API) || DEFAULT_BASE;
}

export async function fetchSnapshot(signal?: AbortSignal): Promise<Snapshot> {
  const res = await fetch(`${apiBase()}/api/snapshot`, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  return res.json();
}

export interface Ask {
  id: string;
  ts_created: string;
  title: string;
  detail?: string;
  tag?: string;
  status: 'pending' | 'done' | string;
  ts_resolved?: string | null;
  response?: string | null;
}

export async function fetchAsks(signal?: AbortSignal): Promise<Ask[]> {
  const res = await fetch(`${apiBase()}/api/asks`, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`asks ${res.status}`);
  const data = await res.json();
  return Array.isArray(data.asks) ? data.asks : [];
}

export async function resolveAsk(id: string, response: string): Promise<{ ok: boolean; error?: string | null }> {
  const res = await fetch(`${apiBase()}/api/asks/resolve`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, response }),
  });
  const data = await res.json().catch(() => ({ ok: false, error: `http ${res.status}` }));
  return { ok: !!data.ok, error: data.error };
}

export const POLL_MS = 5000;
