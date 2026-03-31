# Morph

Phone-to-terminal sync for Claude Code, built on the [Happy Coder](https://github.com/mkmkkkkk/morph) dual-mode architecture.

## Architecture

```
┌─────────────┐         ┌─────────────────┐         ┌──────────────────┐
│  Phone Web  │ ──────► │  Morph Relay    │ ──────► │  Terminal (Mac)  │
│  (web/)     │ ◄────── │  (relay/)       │ ◄────── │  morph-claude    │
│             │  HTTP/WS │  Fastify + S.IO │  S.IO   │  (cli/)          │
└─────────────┘         └─────────────────┘         └──────────────────┘
```

**Dual-mode loop** (Happy Coder pattern):
```
while(true) {
  LOCAL  → user works in terminal normally
  ↓ phone sends message via relay
  REMOTE → claude executes phone's prompt, streams output to TUI
  ↓ done / double-space
  LOCAL  → back to normal terminal
}
```

## Components

| Directory | Description |
|-----------|-------------|
| `cli/` | `morph-claude.mjs` — dual-mode wrapper, orange TUI, Socket.IO client |
| `relay/` | Fastify + Socket.IO relay server, terminal routing, session management |
| `web/` | React SPA — phone interface, session cards, grouped by project |
| `app/` | Expo/React Native app (legacy, replaced by `web/` for daily use) |

## Terminal Routing

Phone messages route through the relay with priority:

1. **Exact match** — terminal registered with the requested session ID
2. **Fallback** — any connected terminal wrapper
3. **Relay-managed** — relay spawns its own Claude process

## Key Features

- **Phone → Terminal takeover**: send prompts from phone, execute on Mac terminal
- **Session dedup**: same display+project keeps only the most recent session
- **Auto-grouping**: sessions grouped by project path in the phone UI
- **TUI**: 256-color orange theme, double-space to switch modes, edge-to-edge layout
- **Stop/Interrupt**: phone can stop or interrupt the terminal's Claude process

## Setup

```bash
# Relay
cd relay && npm install && node index.js

# CLI wrapper (on Mac terminal)
cd cli && npm install
MORPH_RELAY_URL=https://morph.mkyang.ai MORPH_TOKEN=<token> ./morph-claude.mjs

# Web (dev)
cd web && npm install && npm run dev
```

## Infrastructure

- **Relay**: PM2 process `tr-relay` on local Mac, port 3001
- **Tunnel**: Cloudflare Tunnel `tr-relay` → `morph.mkyang.ai` / `tr.mkyang.ai`
- **Auth**: Bearer token via `STATIC_TOKEN` env var

## Credits

Architecture inspired by Happy Coder's dual-mode loop pattern — local/remote alternation with seamless handoff between phone and terminal sessions.
