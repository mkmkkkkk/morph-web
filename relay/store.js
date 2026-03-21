import Database from 'better-sqlite3';
import { randomUUID } from 'crypto';
import { mkdirSync } from 'fs';
import { dirname } from 'path';

let db;

export function initStore(dbPath = './data/relay.db') {
  mkdirSync(dirname(dbPath), { recursive: true });
  db = new Database(dbPath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');

  db.exec(`
    CREATE TABLE IF NOT EXISTS auth_requests (
      public_key TEXT PRIMARY KEY,
      state TEXT DEFAULT 'pending',
      token TEXT,
      response TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      tag TEXT UNIQUE,
      seq INTEGER,
      account_id TEXT,
      metadata TEXT,
      metadata_version INTEGER DEFAULT 1,
      agent_state TEXT,
      agent_state_version INTEGER DEFAULT 1,
      data_encryption_key TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS machines (
      id TEXT PRIMARY KEY,
      account_id TEXT,
      metadata TEXT,
      metadata_version INTEGER DEFAULT 1,
      daemon_state TEXT,
      daemon_state_version INTEGER DEFAULT 1,
      data_encryption_key TEXT,
      created_at INTEGER,
      updated_at INTEGER
    );

    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      content TEXT,
      seq INTEGER,
      created_at INTEGER,
      FOREIGN KEY (session_id) REFERENCES sessions(id)
    );

    CREATE TABLE IF NOT EXISTS vendor_tokens (
      account_id TEXT,
      vendor TEXT,
      token TEXT,
      PRIMARY KEY (account_id, vendor)
    );

    CREATE TABLE IF NOT EXISTS session_machines (
      session_id TEXT PRIMARY KEY,
      machine_id TEXT,
      FOREIGN KEY (session_id) REFERENCES sessions(id),
      FOREIGN KEY (machine_id) REFERENCES machines(id)
    );
  `);

  // Clean up stale auth requests (>5 min old, still pending)
  db.prepare(`DELETE FROM auth_requests WHERE state = 'pending' AND created_at < ?`)
    .run(Date.now() - 5 * 60 * 1000);

  return db;
}

// ─── Auth Requests ───

export function createAuthRequest(publicKey) {
  const now = Date.now();
  const existing = db.prepare('SELECT * FROM auth_requests WHERE public_key = ?').get(publicKey);
  if (existing) return existing;
  db.prepare('INSERT INTO auth_requests (public_key, state, created_at, updated_at) VALUES (?, ?, ?, ?)')
    .run(publicKey, 'pending', now, now);
  return { public_key: publicKey, state: 'pending', created_at: now };
}

export function getAuthRequest(publicKey) {
  return db.prepare('SELECT * FROM auth_requests WHERE public_key = ?').get(publicKey);
}

export function approveAuthRequest(publicKey, token, response) {
  const now = Date.now();
  db.prepare('UPDATE auth_requests SET state = ?, token = ?, response = ?, updated_at = ? WHERE public_key = ?')
    .run('authorized', token, response, now, publicKey);
}

// ─── Sessions ───

// Account-level seq counter (in-memory, resets on restart — fine for personal use)
const accountSeqs = new Map();
function nextSeq(accountId) {
  const current = accountSeqs.get(accountId) || 0;
  const next = current + 1;
  accountSeqs.set(accountId, next);
  return next;
}

export function createOrGetSession(tag, metadata, agentState, dataEncryptionKey, accountId) {
  // Check existing by tag
  const existing = db.prepare('SELECT * FROM sessions WHERE tag = ?').get(tag);
  if (existing) return { session: formatSession(existing), created: false };

  const now = Date.now();
  const id = randomUUID();
  const seq = nextSeq(accountId);

  db.prepare(`INSERT INTO sessions (id, tag, seq, account_id, metadata, metadata_version, agent_state, agent_state_version, data_encryption_key, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 1, ?, 1, ?, ?, ?)`).run(id, tag, seq, accountId, metadata, agentState, dataEncryptionKey, now, now);

  const session = db.prepare('SELECT * FROM sessions WHERE id = ?').get(id);
  return { session: formatSession(session), created: true };
}

export function listSessions(accountId, limit = 100) {
  return db.prepare('SELECT * FROM sessions WHERE account_id = ? ORDER BY updated_at DESC LIMIT ?')
    .all(accountId, limit).map(formatSession);
}

export function getSession(sessionId) {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId);
  return row ? formatSession(row) : null;
}

export function updateSessionMetadata(sessionId, expectedVersion, metadata) {
  const session = db.prepare('SELECT metadata, metadata_version FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return { error: 'not_found' };
  if (session.metadata_version !== expectedVersion) {
    return { versionMismatch: true, currentMetadata: session.metadata, currentVersion: session.metadata_version };
  }
  const newVersion = expectedVersion + 1;
  const now = Date.now();
  db.prepare('UPDATE sessions SET metadata = ?, metadata_version = ?, updated_at = ? WHERE id = ?')
    .run(metadata, newVersion, now, sessionId);
  return { newVersion };
}

export function updateSessionState(sessionId, expectedVersion, agentState) {
  const session = db.prepare('SELECT agent_state, agent_state_version FROM sessions WHERE id = ?').get(sessionId);
  if (!session) return { error: 'not_found' };
  if (session.agent_state_version !== expectedVersion) {
    return { versionMismatch: true, currentState: session.agent_state, currentVersion: session.agent_state_version };
  }
  const newVersion = expectedVersion + 1;
  const now = Date.now();
  db.prepare('UPDATE sessions SET agent_state = ?, agent_state_version = ?, updated_at = ? WHERE id = ?')
    .run(agentState, newVersion, now, sessionId);
  return { newVersion };
}

export function addSessionMessage(sessionId, content) {
  const id = randomUUID();
  const now = Date.now();
  // Get next message seq for this session
  const last = db.prepare('SELECT MAX(seq) as maxSeq FROM messages WHERE session_id = ?').get(sessionId);
  const seq = (last?.maxSeq || 0) + 1;
  db.prepare('INSERT INTO messages (id, session_id, content, seq, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, sessionId, content, seq, now);
  return { id, seq, createdAt: now };
}

// ─── Machines ───

export function upsertMachine(id, metadata, daemonState, dataEncryptionKey, accountId) {
  const existing = db.prepare('SELECT * FROM machines WHERE id = ?').get(id);
  const now = Date.now();

  if (existing) {
    const updates = [];
    const params = [];
    if (metadata !== undefined) { updates.push('metadata = ?', 'metadata_version = metadata_version + 1'); params.push(metadata); }
    if (daemonState !== undefined) { updates.push('daemon_state = ?', 'daemon_state_version = daemon_state_version + 1'); params.push(daemonState); }
    if (dataEncryptionKey !== undefined) { updates.push('data_encryption_key = ?'); params.push(dataEncryptionKey); }
    updates.push('updated_at = ?'); params.push(now);
    params.push(id);
    if (updates.length > 1) {
      db.prepare(`UPDATE machines SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    }
    return formatMachine(db.prepare('SELECT * FROM machines WHERE id = ?').get(id));
  }

  db.prepare(`INSERT INTO machines (id, account_id, metadata, metadata_version, daemon_state, daemon_state_version, data_encryption_key, created_at, updated_at)
    VALUES (?, ?, ?, 1, ?, 1, ?, ?, ?)`).run(id, accountId, metadata, daemonState, dataEncryptionKey, now, now);
  return formatMachine(db.prepare('SELECT * FROM machines WHERE id = ?').get(id));
}

export function listMachines(accountId) {
  return db.prepare('SELECT * FROM machines WHERE account_id = ? ORDER BY updated_at DESC')
    .all(accountId).map(formatMachine);
}

export function getMachine(machineId) {
  const row = db.prepare('SELECT * FROM machines WHERE id = ?').get(machineId);
  return row ? formatMachine(row) : null;
}

export function updateMachineMetadata(machineId, expectedVersion, metadata) {
  const machine = db.prepare('SELECT metadata, metadata_version FROM machines WHERE id = ?').get(machineId);
  if (!machine) return { error: 'not_found' };
  if (machine.metadata_version !== expectedVersion) {
    return { versionMismatch: true, currentMetadata: machine.metadata, currentVersion: machine.metadata_version };
  }
  const newVersion = expectedVersion + 1;
  db.prepare('UPDATE machines SET metadata = ?, metadata_version = ?, updated_at = ? WHERE id = ?')
    .run(metadata, newVersion, Date.now(), machineId);
  return { newVersion };
}

export function updateMachineState(machineId, expectedVersion, daemonState) {
  const machine = db.prepare('SELECT daemon_state, daemon_state_version FROM machines WHERE id = ?').get(machineId);
  if (!machine) return { error: 'not_found' };
  if (machine.daemon_state_version !== expectedVersion) {
    return { versionMismatch: true, currentState: machine.daemon_state, currentVersion: machine.daemon_state_version };
  }
  const newVersion = expectedVersion + 1;
  db.prepare('UPDATE machines SET daemon_state = ?, daemon_state_version = ?, updated_at = ? WHERE id = ?')
    .run(daemonState, newVersion, Date.now(), machineId);
  return { newVersion };
}

// ─── Session-Machine mapping ───

export function setSessionMachine(sessionId, machineId) {
  db.prepare('INSERT OR REPLACE INTO session_machines (session_id, machine_id) VALUES (?, ?)').run(sessionId, machineId);
}

export function getSessionMachine(sessionId) {
  const row = db.prepare('SELECT machine_id FROM session_machines WHERE session_id = ?').get(sessionId);
  return row?.machine_id || null;
}

export function getSessionsForMachine(machineId) {
  return db.prepare('SELECT session_id FROM session_machines WHERE machine_id = ?').all(machineId).map(r => r.session_id);
}

// ─── Vendor Tokens ───

export function setVendorToken(accountId, vendor, token) {
  db.prepare('INSERT OR REPLACE INTO vendor_tokens (account_id, vendor, token) VALUES (?, ?, ?)').run(accountId, vendor, token);
}

export function getVendorToken(accountId, vendor) {
  const row = db.prepare('SELECT token FROM vendor_tokens WHERE account_id = ? AND vendor = ?').get(accountId, vendor);
  return row?.token || null;
}

// ─── Helpers ───

function formatSession(row) {
  return {
    id: row.id,
    tag: row.tag,
    seq: row.seq,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    metadata: row.metadata,
    metadataVersion: row.metadata_version,
    agentState: row.agent_state,
    agentStateVersion: row.agent_state_version,
    dataEncryptionKey: row.data_encryption_key,
  };
}

function formatMachine(row) {
  return {
    id: row.id,
    metadata: row.metadata,
    metadataVersion: row.metadata_version,
    daemonState: row.daemon_state,
    daemonStateVersion: row.daemon_state_version,
    dataEncryptionKey: row.data_encryption_key,
  };
}
