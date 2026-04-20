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

export async function fetchSnapshot(signal?: AbortSignal): Promise<Snapshot> {
  const meta = import.meta as unknown as { env?: Record<string, string | undefined> };
  const base = (meta.env && meta.env.VITE_DASHBOARD_API) || DEFAULT_BASE;
  const res = await fetch(`${base}/api/snapshot`, { signal, cache: 'no-store' });
  if (!res.ok) throw new Error(`snapshot ${res.status}`);
  return res.json();
}

export const POLL_MS = 5000;
