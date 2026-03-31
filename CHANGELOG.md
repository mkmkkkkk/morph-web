# Morph — Changelog

## 2.0.0 — 2026-03-31 — Architecture Upgrade (Happy Coder Dual-Mode)

Phone-to-terminal sync via Happy Coder dual-mode loop pattern.

### CLI (`cli/morph-claude.mjs`) — NEW
- **Dual-mode wrapper** — `while(true) { local → remote → local }` loop, Happy Coder pattern
- **Orange TUI** — 256-color theme (`\x1b[38;5;208m`), edge-to-edge minimal layout
- **Double-space switch** — 400ms window prevents accidental mode triggers
- **Socket.IO client** — connects to relay, receives `remote-message`, sends `terminal-output`
- **Terminal stop/interrupt** — phone can kill or SIGINT the running Claude process

### Relay (`relay/`)
- **Terminal routing** — Priority 1 exact match → 1b fallback any terminal → 2 relay-managed
- **`terminal-register` / `terminal-output`** — Socket.IO events for CLI wrapper
- **Session dedup** — same display+project → keep most recent only
- **FIXED_SESSION** — phone always uses `a0a0a0a0-...0002`, maps to any connected terminal
- **Stop/interrupt forwarding** — `/v2/claude/stop`, `/v2/claude/interrupt` route to terminal

### Web (`web/`)
- **Session cards rewrite** — auto-grouped by `project` path, deterministic project colors
- **FIXED_SESSION** — new session button uses fixed ID for terminal routing
- **Alive cache** — 30s TTL for terminal sessions vs 5s for relay-managed
- **Static serving** — `@fastify/static` serves built SPA from relay

### Infrastructure
- **Cloudflare Tunnel** — `tr-relay` tunnel routes `morph.mkyang.ai` to local Mac relay
- **PM2** — `tr-relay` (relay) + `tr-tunnel` (cloudflared) managed processes

---

## Unreleased (working tree)
- **Terminal Chat** — 替代 Canvas WebView，terminal 风格聊天框 + 24px grid 背景
- **Prompt 跳转** — 输入框空时按上/下箭头跳到上/下一个用户 Prompt 位置
- **Shared ConnectionContext** — Canvas + Config 共用连接状态，消除重复逻辑
- **Web 兼容** — expo-file-system/expo-secure-store Platform guard，支持 Expo Web 测试

## 0.1.0 — 2026-03-14 ~ 03-15

### a11b67f — Phase 1 Foundation
- Canvas WebView + MorphBridge（JS↔RN 双向通信）
- Sketch 手绘功能（WebView 内 Canvas API）
- HappyCoder 加密协议（AES-256-GCM，legacy + dataKey 双模式）
- Socket.IO 连接 + keep-alive
- Component store（adopt/dismiss/persist）
- InputBar + 自动连接

### 2a7c83d — Image/Camera
- expo-image-picker 集成，拍照/相册 → base64 发送

### 3b98241 — File Transfer
- expo-document-picker，5MB 限制，base64 编码发送

### 4bb9b48 — Config Page
- Settings → Config 改名，canvas history、component library、system session

### 5e67ad3 — Scheduled Tasks
- UI 可配置 cron-like 自动 prompt

### 95b0bae — Stop Button
- 所有聊天框加 stop 按钮（红色方块），interrupt 正在处理的 turn

### 316ed80 — SDK 54 Fix
- expo-file-system import path 修正

### 0b5a983 — Config Refactor
- 目录结构整理 + 共享 InputBar 组件

### ac3c1ff — Connection Provider
- 共享 ConnectionContext（QR 配对 → 连接 → 聊天全链路）
- connect.tsx 配对流程

### 8667da0 — Connection Reliability
- crypto polyfill（react-native-get-random-values）
- Socket.IO 10s timeout + 错误传播

### d1f4e70 — InputBar Revert
- Revert Anthropic-style InputBar 改动，恢复 connected/disconnected 双态

---

## Architecture

```
morph/app/
├── app/(tabs)/index.tsx    — Canvas tab (TerminalChat)
├── app/(tabs)/config.tsx   — Config tab (settings + quick actions)
├── app/connect.tsx         — QR pairing flow
├── components/
│   ├── TerminalChat.tsx    — Terminal chat renderer + prompt jumping
│   └── InputBar.tsx        — Input bar (attach/send/stop)
├── lib/
│   ├── ConnectionContext.tsx — Shared connection provider
│   ├── protocol.ts         — SessionMessage types + encrypt/decrypt
│   ├── credentials.ts      — SecureStore/localStorage credential storage
│   ├── api.ts              — HappyCoder REST API
│   ├── connection.ts       — Socket.IO wrapper
│   ├── bridge.ts           — WebView bridge (legacy)
│   ├── store.ts            — Component persistence
│   └── settings.ts         — App settings
└── assets/canvas.html      — Original canvas WebView (legacy)
```

## Dev URLs
- **Web**: `morph.mkyang.ai` (Cloudflare tunnel → localhost:8081)
- **Expo Go**: `exps://morph.mkyang.ai`
