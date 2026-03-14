# Morph — 自进化 AI 编程画布

## 一句话

一个手机端的空白画布，连接电脑上的 Claude Code。App 本身只有设置页和一个输入框 — 其他所有 UI 都由 Claude Code 动态生成和控制。

---

## 问题

HappyCoder 手机端的问题：
1. **闭源 App** — 更新慢，bug 修不了，想加功能加不了
2. **固定 UI** — 所有人看到的界面一样，不能根据个人需求定制
3. **扩展性差** — 想改什么都得等官方更新

核心矛盾：我是 power user，用的是通用工具。

---

## 解法

**保留 HappyCoder 的电脑端和通信协议，只替换手机端。**

App 分两个区域：

### 设置区（人工配的，固定 UI）
- 连接配置：怎么连 Claude Code（扫码配对、服务器地址）
- 网络设置：Wi-Fi/蜂窝、代理、VPN
- 外接设备：键盘、显示器投屏等
- 这些是基础设施，不需要 AI 生成

### 画布区（AI 控的，动态 UI）
- 打开就是空白画布 + 底部一个输入框
- 输入框发文字给 Claude Code — 这是唯一的固定 UI
- **其他所有 UI 都由 Claude Code 生成、修改、删除**
- Claude Code 决定画布上出现什么、长什么样、怎么排列
- 用户只负责：输入指令 + 决定是否采纳

画布上的每个功能都是 CC 生成的。随着使用，画布越来越趁手。每个人的 Morph 都不一样。

---

## 架构

```
┌───────────────────────────────────────┐
│  Morph App (手机)                      │
│                                        │
│  ┌──────────────────────────────────┐ │
│  │  设置区 (固定 UI, 原生)            │ │
│  │  ┌──────────┬──────────┬───────┐ │ │
│  │  │ CC 连接   │ 网络设置  │ 设备  │ │ │
│  │  └──────────┴──────────┴───────┘ │ │
│  └──────────────────────────────────┘ │
│                                        │
│  ┌──────────────────────────────────┐ │
│  │  画布区 (AI 控制, WebView)         │ │
│  │                                    │ │
│  │  ┌─ CC 生成的组件 ──────────────┐ │ │
│  │  │  [deploy btn] [git status]   │ │ │
│  │  │  [file tree]  [log viewer]   │ │ │
│  │  │  [...]                       │ │ │
│  │  └──────────────────────────────┘ │ │
│  │                                    │ │
│  │  ┌──────────────────────────────┐ │ │
│  │  │  📝 输入框 (唯一固定 UI)      │ │ │
│  │  └──────────────────────────────┘ │ │
│  └──────────────────────────────────┘ │
│                                        │
│  ┌──────────────────────────────────┐ │
│  │  连接层 (happy-wire 协议)          │ │
│  │  Socket.IO + E2E 加密              │ │
│  └───────────────┬──────────────────┘ │
└──────────────────┬────────────────────┘
                   │
          Happy Server (中继)
          api.cluster-fluster.com
                   │
┌──────────────────▼────────────────────┐
│  电脑端 (不改)                          │
│  HappyCoder CLI / Claude Code          │
│  本地文件系统                           │
└───────────────────────────────────────┘
```

### 三层分离

| 层 | 职责 | UI 由谁控制 | 改动量 |
|----|------|------------|--------|
| **连接层** | 与 Happy Server 通信、E2E 加密 | N/A（无 UI） | Fork happy-wire，不改 |
| **设置层** | CC 连接、网络、设备配置 | 人工写死（原生 UI） | 新写，一次性 |
| **画布层** | 渲染 AI 生成的一切 | **Claude Code 完全控制** | 核心创新 |

关键原则：**设置层是人配的，画布层是 AI 画的。App 代码只负责这两件事。**

---

## 设置层设计

### 连接设置

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| 服务器地址 | Happy Server URL | `api.cluster-fluster.com` |
| 配对状态 | 已配对的机器列表 | 扫码配对 |
| 当前 Session | 活跃的 CC session | 自动选最新 |
| 自动重连 | 断线后自动重连 | 开 |

### 网络设置

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| 连接方式 | Wi-Fi / 蜂窝 / 自动 | 自动 |
| 代理 | HTTP/SOCKS 代理地址 | 无 |
| VPN 检测 | 是否检测 VPN 状态 | 开 |
| 数据压缩 | 压缩传输数据 | 开 |

### 外接设备

| 设置项 | 说明 | 默认值 |
|--------|------|--------|
| 外接键盘 | 快捷键映射 | 系统默认 |
| 投屏模式 | AirPlay/有线投屏布局 | 跟随手机 |

### 设置页 UI

原生 React Native 页面，标准 iOS/Android 设置风格。不走 WebView，不需要 AI 生成。一次写好，偶尔维护。

---

## 画布层设计（核心创新）

### 核心理念

**App 不做任何前端设计决策。** 所有 UI 设计、布局、交互都由 Claude Code 决定。

App 只提供：
1. 一个 WebView 容器（画布）
2. 一个文字输入框（发消息给 CC）
3. 一个 Bridge API（让 CC 生成的组件能跟 App 通信）

### 画布工作流

```
用户打开 App
  ↓
画布加载已采纳的组件（如果有）
  ↓
用户在输入框输入: "加一个部署按钮"
  ↓
消息发给 Claude Code
  ↓
Claude Code 生成组件 HTML → 通过协议推回手机
  ↓
组件渲染在画布上（draft 状态）
  ↓
用户看到新按钮出现 → 长按可「采纳」或「丢弃」
  ↓
采纳 → 持久化，下次自动加载
```

### 组件模型

每个「功能」是一个自包含的 HTML 文件：

```
morph-data/
  components/
    deploy-button.html      # 一键部署按钮
    git-status-card.html    # Git 状态卡片
    file-tree.html          # 文件树浏览器
    quick-commands.html     # 常用命令快捷面板
  manifest.json             # 组件列表、布局、顺序
```

### 组件格式

```html
<!-- morph-component: deploy-button -->
<!-- description: 一键部署到 Vercel -->
<div class="morph-component" id="deploy-button">
  <style>
    /* 组件样式，scoped */
  </style>
  <button onclick="morph.send('deploy to vercel')">
    Deploy
  </button>
  <script>
    // morph.send(msg) — 发消息给 Claude Code
    // morph.on('message', cb) — 监听 CC 回复
    // morph.store.get/set — 组件本地存储
    // morph.canvas.update(id, html) — CC 更新组件
  </script>
</div>
```

### Morph Bridge API

WebView 里的全局 API，CC 生成的组件通过它跟 App 通信：

```typescript
interface MorphBridge {
  // === 消息 ===
  send(message: string): void                    // 发消息给 CC
  on(event: 'message' | 'tool_call' | 'turn_end', cb: Function): void

  // === 画布控制（CC 调用） ===
  canvas: {
    add(id: string, html: string): void          // CC 添加新组件
    update(id: string, html: string): void       // CC 更新现有组件
    remove(id: string): void                     // CC 删除组件
    reorder(ids: string[]): void                 // CC 调整布局
    getAll(): ComponentMeta[]                    // CC 查看当前画布状态
  }

  // === 组件管理（用户操作） ===
  adopt(componentId: string): void               // 采纳 draft
  dismiss(componentId: string): void             // 丢弃 draft

  // === 存储 ===
  store: {
    get(key: string): any
    set(key: string, value: any): void
  }
}
```

**关键：** `canvas.add/update/remove` 是给 CC 调用的 — CC 完全控制画布上有什么。用户只控制采纳/丢弃。

### CC 端的 Morph Prompt

当用户发消息时，App 自动附加上下文给 CC：

```
[Morph Context]
你正在控制一个手机端画布 App。用户的消息来自手机。
当前画布上的组件: [manifest.json 内容]

你可以：
1. 回复文字消息（正常对话）
2. 生成/修改画布组件（返回 morph-component HTML）
3. 执行命令并把结果推送到画布上

组件规范：
- 自包含 HTML（含 style + script）
- 用 morph.send() 跟你通信
- 用 morph.canvas.update() 更新自己
- 保持移动端友好（触摸、响应式）
```

---

## 通信协议（复用 HappyCoder）

直接用 HappyCoder 的协议栈，不造轮子：

### 认证
- TweetNaCl Ed25519 签名
- QR 扫码配对（`handy://${secretBase64Url}`）
- Challenge-response → JWT token

### 实时通信
- Socket.IO WebSocket，路径 `/v1/updates`
- 心跳：45s timeout, 15s interval
- 重连：1s 初始，5s 最大，无限重试

### 消息加密
- E2E 加密，服务器零知识
- AES-256-GCM 对称加密（新）/ XSalsa20-Poly1305（旧兼容）
- libsodium crypto_box 密钥交换

### Session Protocol（9 种事件）
- Text events（含 thinking metadata）
- Tool call events（start/end）
- File events
- Turn markers（start/end）
- Session control（start/stop）
- Service messages

### REST API
- `POST /v1/auth` — 认证
- `POST /v1/sessions` — 创建 session
- `GET /v3/sessions/:id/messages` — 获取消息
- `POST /v3/sessions/:id/messages` — 发送消息
- `GET /v1/machines` — 列出机器

**依赖包：** `@slopus/happy-wire`（协议定义，Zod schema）

---

## 技术选型

### 决策：Expo + WebView

| 层 | 技术 | 理由 |
|----|------|------|
| App 壳 | Expo SDK 54 (React Native) | 跟 HappyCoder 同栈，协议复用最简单 |
| 设置页 | React Native 原生组件 | 标准设置页，不需要 WebView |
| 画布 | react-native-webview | 渲染 AI 生成的 HTML 组件 |
| 加密 | @more-tech/react-native-libsodium | HappyCoder 同款 |
| 通信 | socket.io-client | HappyCoder 同款 |
| 存储 | expo-file-system（组件）+ MMKV（设置） | 分离关注点 |
| 构建 | EAS | iOS + Android |

理由：
1. 跟 HappyCoder 同栈，协议层直接 copy
2. 原生推送通知
3. 后台 WebSocket 保活稳定
4. TestFlight 安装，不需要上架 App Store

---

## MVP 范围（Phase 1）

### 做

| # | 功能 | 说明 |
|---|------|------|
| 1 | **设置：CC 连接** | 扫码配对、服务器地址、连接状态指示 |
| 2 | **设置：网络** | Wi-Fi/蜂窝切换、代理配置 |
| 3 | **画布：WebView 容器** | 空白画布，加载已采纳组件 |
| 4 | **画布：输入框** | 底部固定，发文字给 CC |
| 5 | **画布：组件渲染** | CC 推送 HTML → 渲染在画布上 |
| 6 | **画布：采纳/丢弃** | 长按组件，选择采纳或丢弃 |
| 7 | **Bridge API** | morph.send/on/canvas/store |
| 8 | **CC Prompt 注入** | 自动附加 Morph Context |

### 不做（Phase 1）

- 语音输入
- 多 session 管理
- 组件市场/分享
- 外接设备设置（Phase 2）
- 离线模式

### MVP 交付物

一个能装在手机上的 App（TestFlight），能：
1. 扫码配对电脑上的 CC
2. 在输入框发文字给 CC
3. CC 的回复显示在画布上
4. 跟 CC 说"加一个 XX 功能" → CC 生成组件 → 画布上出现
5. 采纳的组件下次打开自动加载

---

## 文件结构

```
morph/
  DESIGN.md                    # 本文件
  app/                         # Expo 项目
    app/                       # Expo Router 页面
      (tabs)/
        index.tsx              # 画布页（主页）
        settings.tsx           # 设置页
      connect.tsx              # 扫码配对页
    components/
      Canvas.tsx               # WebView 画布容器
      InputBar.tsx             # 底部输入框（唯一固定 UI）
      ComponentOverlay.tsx     # 长按菜单（采纳/丢弃）
    lib/
      connection.ts            # Socket.IO 连接管理
      crypto.ts                # E2E 加密（from happy-wire）
      protocol.ts              # 消息协议解析（from happy-wire）
      bridge.ts                # Morph Bridge API
      store.ts                 # 组件存储管理
      prompt.ts                # CC Prompt 注入（Morph Context）
    assets/
  morph-data/                  # 运行时数据（gitignore）
    components/                # 已采纳组件 HTML 文件
    manifest.json              # 组件清单 + 布局
```

---

## Phase 2（MVP 验证后）

- 外接设备设置（键盘映射、投屏）
- 组件间通信（组件 A 触发组件 B）
- CC 主动推送（CC 做完任务自动更新画布）
- 多 session 支持
- 语音输入
- 组件版本管理（回滚）

## Phase 3（如果做产品）

- 组件市场（用户分享组件）
- 多 AI 后端（不只 CC）
- 团队协作（共享画布）
- 自建 Happy Server

---

## 风险

| 风险 | 影响 | 缓解 |
|------|------|------|
| happy-wire 协议变更 | 连接中断 | Pin 版本，关注 happy repo |
| Happy Server 下线 | 完全不能用 | Phase 3 自建 server |
| WebView 性能 | 组件多了卡 | 懒加载，限制同时渲染数 |
| AI 生成组件质量差 | 体验差 | 迭代 Morph Context prompt |
| Expo 构建复杂 | 开发慢 | 先 Expo Go 开发 |
| CC 不理解 Morph 规范 | 组件格式错 | prompt 里放示例组件 |

---

## 与 HappyCoder 的关系

- **不竞争** — Morph 是个人工具，解决自己的痛点
- **复用协议** — 电脑端继续用 `happy` 命令，不改
- **只替换手机端** — Morph 替代 HappyCoder App
- **开源** — MIT

---

*设计日期：2026-03-14*
