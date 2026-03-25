# Morph Web — Handover Document

> For the Claude Code instance on TR Mac taking over governance of Morph Web.
> Source of truth: `https://github.com/mkmkkkkk/morph` (private, branch `master`)

---

## 1. Architecture Overview

```
iPhone (morph.mkyang.ai)
  --> Cloudflare Tunnel --> Docker host (workspace relay, port 3001)
  --> React SPA loads, authenticates with STATIC_TOKEN
  --> Socket.IO WebSocket to relay (/v1/updates)
  --> REST API calls to relay (/v2/claude/*)
  --> Relay spawns `claude -p --output-format stream-json` child processes
  --> stdout JSONL parsed, piped to Socket.IO rooms --> phone renders

Multi-env:
  Workspace relay (Docker, morph.mkyang.ai) --> spawns claude in /workspace
  TR relay (Mac, tr.mkyang.ai)              --> spawns claude in ~/Documents/Tensor_revive
  Web client fetches GET /v2/claude/environments --> gets relay URLs + tokens
  Direct socket connection to each relay (no proxy for external URLs)
```

**Stack:**
- **Web SPA:** React 19 + Vite + Framer Motion. Single-file `App.tsx` (~108KB, ~3000 lines). No router, no SSR.
- **Relay:** Node.js + Fastify + Socket.IO. Stateful — spawns and manages claude CLI processes.
- **Auth:** JWT + static token. `STATIC_TOKEN` is the primary auth method (personal use).
- **Proxy:** `relay/proxy.js` forwards `/relay-proxy/:envId/*` to secondary relays. Only used when relay URL is relative (internal). External URLs bypass proxy entirely.

---

## 2. Repository & Git Protocol

**Two repos, EVERY push goes to both:**

| Repo | Remote | Branch | Visibility |
|------|--------|--------|-----------|
| `mkmkkkkk/morph` | `origin` | `master` | Private (full code) |
| `mkmkkkkk/morph-web` | `morph-web` | `main` | Public (sanitized, no secrets) |

```bash
# Standard push (from /workspace/morph or ~/Documents/morph)
git push origin master
git push morph-web master:main   # note: master-->main branch mapping
```

**Critical rules:**
- Morph changes MUST be committed from the morph repo root, NOT from a parent workspace. The parent (`Tensor_revive` or `/workspace`) has its own git — committing morph files from there pushes to the wrong repo.
- Never commit `.env` files (already in `.gitignore`).
- `morph-web` must be sanitized — no API keys, no personal tokens, no `relay/.env`.
- After pushing, update the morph submodule pointer in the parent workspace if applicable.

---

## 3. Key Files Map

### Web (`web/`)
| File | Purpose |
|------|---------|
| `src/App.tsx` | Entire UI — PasswordGate, Canvas (WebView), ChatPanel, Config, Sessions, InputBar. Single monolithic component. |
| `src/lib/connection.ts` | All relay communication — Socket.IO connect, REST helpers, multi-relay management, message parsing, session subscribe/send/resume |
| `src/components/Sketch.tsx` | Sketch annotation overlay (draw on screen, attach to message) |
| `src/main.tsx` | React entry point |
| `index.html` | SPA shell |
| `vite.config.ts` | Vite config — proxy to relay in dev, `__BUILD_TIME__` define |
| `public/canvas.html` | WebView canvas page (Claude Code web UI embed) — has built-in cache-bust |
| `public/manifest.json` | PWA manifest (iOS home screen app) |
| `public/sw.js` | Service worker |
| `MORPH.md` | System prompt injected into every new Morph Web claude session |
| `dist/` | Built output — committed to repo, served by relay as static files |

### Relay (`relay/`)
| File | Purpose |
|------|---------|
| `index.js` | Entry point — creates HTTP server, attaches Socket.IO, Fastify, proxy. Boots everything. |
| `claude.js` | Core engine (1115 lines) — spawns claude CLI, manages active map, session detection, history reading, output buffering, all v2 REST endpoints |
| `socket.js` | Socket.IO setup — v1 protocol (session/machine rooms, RPC, keep-alive). Legacy Happy Coder compat. |
| `server.js` | Fastify routes — v1 REST API (auth, sessions, machines). Legacy Happy Coder compat. |
| `proxy.js` | Transparent HTTP + WebSocket proxy for secondary relay environments |
| `auth.js` | JWT + static token auth — `verifyToken()`, `authMiddleware` |
| `store.js` | SQLite storage — sessions, machines, messages, auth requests (v1 data) |
| `start.sh` | Workspace launcher — sources `.env`, execs `node index.js` |
| `deploy-tr.sh` | TR Mac one-click deploy — npm install, cloudflared tunnel, PM2 ecosystem, health check |
| `.env` | Environment config (PORT, JWT_SECRET, STATIC_TOKEN, DB_PATH, RELAY_ENVS) |
| `data/relay.db` | SQLite database (v1 session data) |

### Root
| File | Purpose |
|------|---------|
| `MORPH-CC-CONTEXT.md` | Claude Code context doc |
| `DESIGN.md` | Design document |
| `CHANGELOG.md` | Version history |
| `.gitignore` | Ignores `relay/.env`, `relay/data/`, `*/node_modules/` |
| `app/` | Expo React Native app (mobile native — separate from web) |

---

## 4. Build & Deploy

### Web
```bash
cd /path/to/morph/web
npm run build          # outputs to dist/
git add dist/ -f       # dist is committed (relay serves it as static)
git commit && git push origin master && git push morph-web master:main
```
No separate deploy step — relay serves `dist/` as static files via Fastify.

### Workspace Relay (Docker)
```bash
cd /workspace/morph/relay
bash start.sh          # sources .env, runs node index.js
# Runs on port 3001, Cloudflare tunnel maps morph.mkyang.ai
```
After code changes: kill the old node process, run `start.sh` again. Or restart the Docker container.

### TR Relay (Mac)
```bash
cd ~/Documents/morph/relay   # or wherever morph is cloned on TR Mac
bash deploy-tr.sh            # npm install, cloudflared tunnel setup, PM2 start
# PM2 manages: tr-relay (node) + tr-tunnel (cloudflared)
# Public URL: https://tr.mkyang.ai
```
After code changes: `pm2 restart tr-relay`

**TR relay .env differs from workspace:**
- `STATIC_TOKEN=morph-tensor-2026` (different from workspace's `morph2026`)
- `DEFAULT_CWD=/Users/michaelyang/Documents/Tensor_revive`
- No `RELAY_ENVS` (TR relay is a leaf node, not a hub)
- No `ANTHROPIC_API_KEY` needed (CLI uses OAuth Max plan)

---

## 5. Session Management

### Lifecycle
1. **Spawn:** `POST /v2/claude/send` with `message` + optional `sessionId` --> relay spawns `claude -p --output-format stream-json --session-id <sid>`
2. **Send:** If session already active (in `active` map), writes to stdin via stream-json protocol
3. **Resume:** `POST /v2/claude/resume` with `resumeFrom` --> spawns new process with `--resume <old-sid>`
4. **Interrupt:** `POST /v2/claude/interrupt` --> `SIGINT` to process
5. **Stop:** `POST /v2/claude/stop` --> `SIGTERM`, adds to killed blacklist, removes from active map

### Fixed Session
`a0a0a0a0-0e00-4000-a000-000000000002` is the pinned Morph Web main terminal session. It bypasses the concurrency cap (MAX_CONCURRENT_SESSIONS = 6) and is auto-spawned on first connect.

### Session Detection (LOCKED -- do NOT change logic, only implementation)
The `GET /v2/claude/sessions` endpoint merges three sources:
1. **Active map** — relay-spawned processes currently in memory. Always shown.
2. **Terminal sessions** — detected via `ps` scanning for `claude` processes with PPID=0 (Docker) or PPID=bash/zsh/tmux (bare metal). Subagents (PPID=claude or PPID=node) excluded. Count N terminal processes, show N most recent `.jsonl` files (max 12h old).
3. **Recent resumable** — `.jsonl` files modified within 48h, not in active or terminal sets. Capped at 10.

Killed sessions are blacklisted (`/tmp/morph-killed.json`) and filtered out.

### Orphan Handling
On relay restart:
- `/tmp/morph-active.json` persists the active map (sid --> pid)
- `_collectOrphans()` reads this file, finds still-alive PIDs
- `_restoreWithResume()` kills orphans via SIGTERM, waits 2s, re-spawns with `--resume` to regain stdout pipes

### Buffer/Replay
Socket disconnections are handled by `outputBuffers` (per-session ring buffer, max 500 events, 60s TTL). On `direct-subscribe`, client sends `sinceTs` -- relay replays missed events.

---

## 6. Design Rules (CRITICAL)

These are CEO-approved and frozen. Violating them wastes hours of debugging.

1. **CEO-approved UI logic is immutable.** Only change engineering implementation (how), never the logic (what). If you think the logic is wrong, ask the CEO first.

2. **Session detection logic is LOCKED.** The active map + PPID=0 terminal detection + recent resumable approach went through 4 broken iterations. This is the only one that works. Fix bugs in the implementation, not the logic.

3. **SDK 54 locked.** The Expo native app uses SDK 54. Do NOT upgrade to SDK 55. This does not affect the web SPA (Vite/React), only the `app/` directory.

4. **ChatPanel: terminal style.** Not chat bubbles. Like Claude Code CLI terminal output. Auto-expand on send, manual collapse on tap. Keyboard-aware height.

5. **iOS safe area:** CSS viewport units don't include iOS safe areas. Use `window.screen.height` to set a JS variable for layout. This is already implemented.

6. **Canvas cache-bust:** `public/canvas.html` has built-in cache-busting via `__BUILD_TIME__`. After changes, just tell the user to refresh.

7. **Adding features = additive, not rewrite.** Never rewrite an existing component to add a feature. Add the new behavior on top of existing code. Previous rewrite of InputBar accidentally deleted attach button, image picker, sketch, etc.

8. **No emojis except checkmarks** in code comments and UI.

---

## 7. Known Issues & Current State

| Issue | Status | Detail |
|-------|--------|--------|
| Root process blocking port 3001 (Docker) | Recurring | Some process grabs port 3001 before relay starts. Needs container restart or `kill` as root. |
| Zombie claude processes | Recurring | Long-running sessions accumulate zombie/orphan processes in Docker. `_isProcessAlive()` filters zombies but doesn't clean them. |
| PPID=0 orphans counted as terminal | Acceptable | When a parent process dies, children get PPID=0. They look like terminal sessions. Not perfect but the CEO accepted this behavior. |
| TR API key in spawn env (FIXED) | Resolved | `delete env.ANTHROPIC_API_KEY` in `spawnClaude()` forces CLI to use OAuth instead of leaking the key. |
| Stale proxy URLs in localStorage | Resolved | `loadSavedRelays()` auto-filters `/relay-proxy/` entries on startup. Server pushes direct URLs. |
| iOS text selection | SHELVED | WebKit bug — dragging selection handle escapes to parent div. 10+ attempts failed. CEO abandoned. |
| `/tmp` paths not persistent | Known | `ACTIVE_FILE` and `KILLED_FILE` use `/tmp/` which is lost on reboot. Acceptable for now — relay re-detects sessions from filesystem. |

---

## 8. Credentials & Config

### relay/.env structure
```
PORT=3001
JWT_SECRET=<secret>
STATIC_TOKEN=<token>         # morph2026 (workspace) / morph-tensor-2026 (TR)
DB_PATH=./data/relay.db
ALLOWED_ACCOUNTS=<comma-separated>
ANTHROPIC_API_KEY=<key>      # Only in workspace .env. Stripped from spawned processes.
RELAY_ENVS='[...]'           # Only in workspace (hub). Lists all secondary relay URLs + tokens.
```

### Auth tokens
- `morph2026` — workspace relay (Docker)
- `morph-tensor-2026` — TR relay (Mac)
- No API key needed for spawned claude processes — they use OAuth (Max plan)

### RELAY_ENVS format (workspace only)
```json
[
  {"id":"workspace","label":"/Workspace","relayUrl":"https://morph.mkyang.ai","token":"morph2026","maxSessions":30},
  {"id":"tensor-revive","label":"/Tensor Revive","relayUrl":"https://tr.mkyang.ai","token":"morph-tensor-2026","maxSessions":30}
]
```

### URLs
- `morph.mkyang.ai` — workspace relay (Cloudflare Tunnel --> Docker host)
- `tr.mkyang.ai` — TR relay (Cloudflare Tunnel --> Mac PM2)

---

## 9. Common Operations Runbook

### Restart Relay (Workspace/Docker)
```bash
# Find and kill existing process
pgrep -f "node.*relay/index.js" | xargs kill 2>/dev/null
# Or if port is stuck:
lsof -ti:3001 | xargs kill 2>/dev/null
# Start
cd /workspace/morph/relay && bash start.sh
```

### Restart Relay (TR Mac)
```bash
pm2 restart tr-relay
# Or full redeploy:
cd ~/Documents/morph/relay && bash deploy-tr.sh
```

### Add a New Environment
1. Deploy a new relay instance (copy `relay/`, create `.env` with unique `STATIC_TOKEN` and `DEFAULT_CWD`)
2. Set up Cloudflare Tunnel to the new relay
3. Add entry to workspace relay's `RELAY_ENVS` in `.env`
4. Restart workspace relay — it will advertise the new env to web clients via `/v2/claude/environments`

### Debug Session Issues
```bash
# Check active sessions (in-memory)
curl -H "Authorization: Bearer <token>" https://<relay>/v2/claude/active

# Check all sessions (filesystem + terminal detection)
curl -H "Authorization: Bearer <token>" https://<relay>/v2/claude/sessions

# Debug process tree
curl -H "Authorization: Bearer <token>" https://<relay>/v2/claude/debug-ps

# Check errors
curl -H "Authorization: Bearer <token>" https://<relay>/v2/claude/errors

# Check diagnostics (claude version, path, node version)
curl -H "Authorization: Bearer <token>" https://<relay>/v2/claude/diag

# Client-side debug (in browser console)
window.__connLog()        # connection event log (last 100)
window.__connLogRaw()     # raw log objects
```

### Test Socket Connectivity
```bash
# From any machine with wscat installed:
wscat -c "wss://<relay>/v1/updates?token=<token>" --header "Authorization: Bearer <token>"
# Should connect. Send: {"type":"ping"} to verify.
```

### Check Remote Debug Logs (from phone)
```bash
# Phone sends debug lines to relay automatically (2s flush interval)
curl -H "Authorization: Bearer <token>" https://<relay>/v2/debug/logs
# Clear:
curl -X POST -H "Authorization: Bearer <token>" https://<relay>/v2/debug/clear
```

---

## Appendix: REST API Quick Reference

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | Health check (no auth) |
| GET | `/v2/claude/environments` | List configured relay environments |
| POST | `/v2/claude/send` | Send message (spawns if needed) |
| POST | `/v2/claude/resume` | Resume a session |
| POST | `/v2/claude/interrupt` | Send SIGINT |
| POST | `/v2/claude/stop` | Kill session + blacklist |
| POST | `/v2/claude/upload` | Upload file (base64, max 10MB) |
| GET | `/v2/claude/sessions` | List sessions (filesystem + terminal + active) |
| GET | `/v2/claude/active` | List active sessions (in-memory only) |
| GET | `/v2/claude/history/:sid` | Session message history (tail-read, last N) |
| POST | `/v2/claude/title` | Generate session title via Haiku |
| GET | `/v2/claude/usage` | Claude usage stats (OAuth) |
| GET | `/v2/claude/projects` | List all projects with sessions |
| GET | `/v2/claude/debug-ps` | Debug process tree |
| GET | `/v2/claude/diag` | System diagnostics |
| GET | `/v2/claude/errors` | Error ring buffer |
| POST | `/v2/debug/log` | Write remote debug lines |
| GET | `/v2/debug/logs` | Read remote debug lines |

### Socket.IO Events (path: `/v1/updates`)

| Direction | Event | Purpose |
|-----------|-------|---------|
| Client --> Server | `direct-subscribe` | Join session room + replay missed events |
| Client --> Server | `direct-send` | Send message via socket |
| Client --> Server | `direct-interrupt` | Interrupt session |
| Client --> Server | `direct-approve` | Approve tool execution (SIGCONT) |
| Client --> Server | `direct-deny` | Deny tool execution (SIGCONT + SIGINT) |
| Server --> Client | `claude-output` | Streaming JSONL output from claude |
| Server --> Client | `claude-error` | stderr output |
| Server --> Client | `claude-exit` | Process exited |
| Server --> Client | `claude-compact` | Context compaction event |
| Server --> Client | `claude-permission` | Tool approval request |
