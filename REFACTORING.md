# webui 重构 / 维护性改造 接力文档

> **作者**：Mavis（Mavis 0.5.bx 系列负责轮）
> **日期**：2026-08-21
> **目标读者**：接手的强 LLM（被 Ponkan 叫来"打补丁"的）
> **当前分支**：`refactor/modularization`（已 commit 到 `d2db672`，HEAD clean）
> **当前状态**：批次 1（unit test）完成 18/18 + chat.test.js 留 TODO，剩余 3 批未做
> **重要**：所有路径**都是 `C:\Users\mjc39\.minimax-code\webui\`**（**带 `.`**，很容易写错成 `minimax-code` 没点）

---

## 0. TL;DR — 你接手时要知道的最少必要信息

**项目**：mcode 桌面端 CLI 的 web UI 包装（Node.js HTTP server + 浏览器 SPA），用 SSE 推流，给 mcode acp 0.1.5 套一个手机/浏览器能用的界面。

**核心代码结构**：
- `server.js`（约 600 行）— HTTP + SSE 主入口
- `server/lib/`（17 个 ESM 文件，每个 200~500 行）— 后端模块（config、state-bus、mavis-usage、mcode-*、settings、sessions 等）
- `server/routes/`（10 个 handler 文件）— HTTP endpoint，每个按域拆分
- `public/app/main.js`（**4410 行 monolith**）— 前端 SPA，零依赖、零 build、ESM `<script>`
- `public/index.html`、`public/styles/main.css`（~2400 行）

**用户 Ponkan 风格**：
- 不喜欢问问题但会主动承认"什么都没学"
- 喜欢"口播稿"风格
- 中文为主
- 不要主动 push 到 GitHub（**硬规则**：见下方 §6）
- 偏好"分批"做（一波 commit = 一次 review）

**Mavis 跟 Ponkan 协作的硬规矩**（**别违反**）：
1. `webui/server` 端任何文件改动 → commit 后**必须告诉用户"server 需要重启才能生效"** + 立刻重启 server
2. `public/app/*.js` 跟 `public/styles/*.css` 已有 no-cache（v0.5.bx-35/36），用户**不需要 hard refresh**
3. 改 webui CSS 前**必须先看 HTML 父子结构**（v0.5.bx-37 改 #5 教训）
4. 派前台 `task` 之前 preamble **必须显式说**"我在等子 agent 结果，先别发新消息"（否则会被插话打断）
5. 默认派 `task` 走后台 `run_in_background: true`，父 session 立刻释放

---

## 1. 项目布局（关键文件清单）

```
C:\Users\mjc39\.minimax-code\webui\
├── package.json              ← Zero deps, "type": "module", node 22+
├── server.js                 ← HTTP+SSE 入口
├── server/
│   ├── lib/
│   │   ├── config.js         ← 配置常量（MAVIS_DB_PATH、SQLITE3_BIN、PORT=8080）
│   │   ├── state-bus.js      ← per-cid client state + pushStateFor (SSE 广播)
│   │   ├── mavis-usage.js    ← 从 mavis 桌面端 sqlite 读真实 token usage
│   │   ├── mcode-acp.js      ← ACP 协议（mcode 0.1.5 不返 r.usage → 走 mavis db）
│   │   ├── mcode-exec.js     ← exec 逃生（MCODE_USE_ACP=0 切回）
│   │   ├── mcode-rpc.js      ← session/cancel RPC
│   │   ├── acp-client.js     ← mcode session list / getMcodeSessionsCacheSync
│   │   ├── sessions.js       ← webui session store (load/save/resetContext/persistCurrentChat)
│   │   ├── settings.js       ← LAN 广播开关
│   │   ├── models.js         ← 从 mcode cli.js bundle 提取 model 列表
│   │   ├── db.js             ← better-sqlite3 lazy require (lazy init)
│   │   ├── slash.js          ← /usage /clear /goal 等本地 slash 命令
│   │   ├── static.js         ← 静态文件服务（v0.5.bx-35/36 加 no-cache）
│   │   ├── lan.js, upload.js, usage.js, workspace.js
│   └── routes/               ← 10 个 HTTP handler (chat / sessions / state / model / debug 等)
├── public/
│   ├── index.html
│   ├── app/main.js           ← 4410 行 SPA monolith
│   ├── styles/main.css       ← 2400 行
│   └── brand-*.png
└── test/                     ← 批次 1 新建
    ├── _setup.js             ← mock 框架（核心抽象，详见 §3）
    ├── mavis-usage.test.js   ← 10/10 通过 ✅
    ├── state-bus.test.js     ← 4/4 通过 ✅
    ├── sessions.test.js      ← 4/4 通过 ✅
    ├── chat.test.js.todo     ← 0/3，import 阶段卡死（详见 §4.4）
    ├── fixtures/
    │   ├── v2/sqlite/runtime-state.sqlite  ← 16KB fixture db
    │   └── create-test-db.mjs ← 重建脚本
    └── *.disabled            ← 调试期临时文件，可删
```

**外部依赖**：
- mcode CLI：`C:\Users\mjc39\.minimax-code\mcode.cmd` (acp 0.1.5)
- mavis desktop db：`C:\Users\mjc39\.minimax\v2\sqlite\runtime-state.sqlite`（**别去动它**，670MB；测试用 `test/fixtures/v2/sqlite/runtime-state.sqlite`）
- sqlite3 binary：`C:\Users\mjc39\anaconda3\Library\bin\sqlite3.exe`（绝对路径，不在 PATH）

---

## 2. 已完成的工作（commit 历史 + 描述）

### 2.1 已有 commit（HEAD = `d2db672`）

```
d2db672 feat(webui v0.5.bx-34..39): 顶栏 BETA + Force reload + 8080 + sun/moon icon + usage popover 修复
9c3660e fix(webui v0.5.ca): 隐藏侧栏 r-branch/r-tree (跟 v0.5.bz 模型按钮同一种假 UI)
bd9698e fix(webui v0.5.bx-30+31+32+33): typo + sidebar 整套 + 删清理孤儿按钮
0f7bf53 fix(webui v0.5.bx-29): context usage 跨设备同步 — SSE hydrate + 同 session broadcast
06ef25f fix(webui): debug log 面板默认收起 + 报错自动弹出 + close 按钮
4f31de7 docs(v0.5.bx): 全面重写所有文档 + 加 SKILL.md / plugin.json
```

### 2.2 本轮（批次 1）已完成（**还没 commit**）

**新建 / 修改**：
- `test/_setup.js`（约 200 行）— mock 框架，详见 §3
- `test/mavis-usage.test.js`（10 tests）— 覆盖 v0.5.bx-30 typo 教训
- `test/state-bus.test.js`（4 tests）— 覆盖 v0.5.bx-31 SSE broadcast + dedup
- `test/sessions.test.js`（4 tests）— 覆盖 v0.5.bx-32 切 session 不写 lastUsedWorkspace
- `test/chat.test.js.todo`（0 tests）— TODO，没跑通
- `test/fixtures/create-test-db.mjs` — 真 sqlite3 fixture db 重建脚本
- `test/fixtures/v2/sqlite/runtime-state.sqlite` — 16KB，**已 commit 状态可加**

**测试运行**：
```bash
node --experimental-test-module-mocks --test test/mavis-usage.test.js test/state-bus.test.js test/sessions.test.js
# 18/18 通过，~300ms
```

---

## 3. 测试基础设施（**最重要的一节**）

### 3.1 `_setup.js` 的设计

文件：`test/_setup.js`

**关键 API**：
```js
import { test, before } from 'node:test'
import { setupMocks, absPath, registerAcpMock, registerSessionsStore } from './_setup.js'

before(async (t) => {
  await setupMocks(t, {
    acp: { /* partial overrides for acp-client.js */ },
    sessions: { initial: [...], save: (arr) => { /* custom */ } },
    mavis: { applyMavisUsageToCs: async () => {} },
    lanBroadcast: true,
  })
  const mod = await import(absPath('routes/something.js'))
})

test('...', () => { ... })
```

**核心设计原则**：所有 webui 自家模块的 mock namedExports **必须是 stable function reference**，内部 dispatch 到 mutable 的 `_acpMock` 对象（不能 spread snapshot，否则后续 registerAcpMock 不会生效）：

```js
// 正确：stable wrapper, dispatch at call time
t.mock.module(absPath('lib/acp-client.js'), {
  namedExports: {
    getMcodeSessionsForWorkspace: (...a) => _acpMock.getMcodeSessionsForWorkspace(...a),
    // ...
  }
})

// 错误：snapshot at setupMocks() time, 后续 registerAcpMock 失效
const acpImpls = { ..._acpMock, ...acpOverrides }
t.mock.module(absPath('lib/acp-client.js'), { namedExports: acpImpls })
```

### 3.2 ⚠️ Node 24.14 mock.module 的 5 个**致命坑**（每个都吃过亏）

#### 坑 1：`mock.module` 必须在 `before((t) => {})` 钩子里调，**不能在模块顶层**

```js
// 错误：module top-level, 不生效
mock.module('node:fs', { ... })  // ← 这里调了但不影响后续 import
import { existsSync } from 'node:fs'  // ← 拿到真 existsSync

// 正确：inside before() hook with t context
before(async (t) => {
  await setupMocks(t)  // ← 这里面用 t.mock.module
  // 然后才 dynamic import SUT
  const { foo } = await import(absPath('lib/foo.js'))
})
```

#### 坑 2：mock `node:fs` **会替换整个 namespace**，所有没列出的 export 变 undefined

```js
// 这样 mock 后 readFileSync 变 undefined!
t.mock.module('node:fs', { namedExports: { existsSync: () => true } })

// 如果 SUT 顶部 import { existsSync, readFileSync } from 'node:fs',
// readFileSync 是 undefined → SUT 任何用到 readFileSync 的 IIFE 立刻抛
// 经典场景: config.js 的 DEFAULT_WORKSPACE IIFE 调 detectTuiCwd() 读 cwd.json,
//   mock 后 detectTuiCwd 抛 TypeError → config.js 加载 hang → import 卡死
```

**解决方案**：**完全不 mock `node:fs`**，用真的。fixture db 真的存在，真 existsSync 也能返 true。

#### 坑 3：mock `node:child_process.spawn` **不生效**（Node 24.14 已知 bug）

```js
// 这样 mock 看起来 work (toString 看得到 mock function body)
// 但 SUT 实际调真 spawn!
t.mock.module('node:child_process', {
  namedExports: { spawn: (cmd, args, opts) => { /* fake child */ } }
})
```

症状：mock 闭包内的 console.log 永不执行，spawn 真去启动 binary。

**解决方案**：**完全不 mock `node:child_process`**，测 child-process 路径用**真 sqlite3 + 真 fixture db**（`test/fixtures/v2/sqlite/runtime-state.sqlite`）。

**影响范围**：
- mavis-usage.js 的 happy path：测得了（用真 sqlite3 读 fixture db）
- mavis-usage.js 的 spawn 错误路径（exit non-zero / < 13 cols / child error）：**测不了**，已用 `describe.skip` 注释掉

#### 坑 4：mock 一个模块时，**必须导出 SUT 实际 import 的所有 named export**，否则 ESM import 抛错

```js
// sessions.js 实际 import { loadSessions, saveSessions, resetContext, persistCurrentChat, ... }
// mock 只导 loadSessions/saveSessions → 加载 hang 抛 "does not provide an export named 'resetContext'"
```

**解决方案**：在 `_setup.js` 的 `setupMocks` 里**穷举真实 lib 的所有 export**（已包含在 `lib/sessions.js` mock 里，见 _setup.js L108-131）。

#### 坑 5：`mavis-usage.js` 在默认 mock 列表里**会替换 SUT 自己**（self-mock bug）

```js
// 默认 mock mavis-usage.js → mavis-usage.test.js 测的是 mock, 不是真 SUT
// 必须: setupMocks(t) 不默认 mock mavis-usage.js
// 需要 mock 的 test (chat.test.js / sessions.test.js) 显式 overrides.mavis = { ... }
```

**当前 _setup.js 已经修好**：mavis-usage.js 只在 `overrides.mavis` 给出时才 mock。

### 3.3 `absPath(rel)` 的实现

```js
import { fileURLToPath, pathToFileURL } from 'node:url'
import { dirname, resolve } from 'node:path'

const TEST_DIR = dirname(fileURLToPath(import.meta.url))
export const absPath = (rel) => pathToFileURL(resolve(SERVER_DIR, rel)).href
```

**为什么用 pathToFileURL**：Windows 上 `mock.module` 对绝对路径需要 `file://` URL，否则报 `ERR_UNSUPPORTED_ESM_URL_SCHEME`。

### 3.4 fixture db 的设计

**位置**：`test/fixtures/v2/sqlite/runtime-state.sqlite`

**为什么是这个路径**：跟真 mavis 路径结构一致（`MAVIS_DATA_DIR/v2/sqlite/runtime-state.sqlite`）。设 `process.env.MAVIS_DATA_DIR = 'C:\Users\mjc39\.minimax-code\webui\test\fixtures'`，config.js 解析后 `MAVIS_DB_PATH` 直接指向 fixture，**不需要 symlink**。

**3 个 session ID**（**必须只含 [a-f0-9] 字符**，见 §5.4）：
- `mvs_feeddead0000000000000000000aaaa` — 3 行（happy path + per-turn）
- `mvs_d0de0000000000000000000000abcdef` — 1 行全 0（cache hit rate = 0）
- `mvs_facefacefacefacefacefacefaceface` — 1 行 reasoning NULL（默认 0 路径）

**重建**：`node test/fixtures/create-test-db.mjs`

### 3.5 `node --experimental-test-module-mocks` flag 必加

`mock.module` 是实验性 API，必须加这个 flag，否则 `mock` 是空对象，调用就报 `mock.module is not a function`。

---

## 4. 4 个 test 文件状态

### 4.1 mavis-usage.test.js ✅ 10/10

**覆盖**：
- 输入校验（empty / null / SQL 注入 / 短 ID / **非 hex 字符**）5 个
- 0 rows 返 null
- **v0.5.bx-30 REGRESSION test**（`lastTurnContextTokens` 字段名一致）
- 完整 happy path（cumulative + per-turn + cache hit rate 数学验证）
- 0 字段 cache hit rate = 0
- NULL reasoning → 0

**用真 sqlite3**（因为 mock spawn 不 work）。性能：~200ms 跑完 10 tests。

### 4.2 state-bus.test.js ✅ 4/4

**覆盖**：
- `pushStateFor(cid, { mcodeSessions })` opts 优先
- `pushStateFor(cid)` cache 命中路径
- `pushStateFor(cid)` cache miss 返 `[]`（不阻塞，等 fetch 完成再 broadcast）
- `pushStateFor('__broadcast__')` 遍历所有 SSE

**需要**：`registerAcpMock` 跟 `registerSessionsStore` 暴露在 `_setup.js`（已加）。

### 4.3 sessions.test.js ✅ 4/4

**覆盖 v0.5.bx-32**：
- 切到不同 workspace **不**写 lastUsedWorkspace
- 切到同 workspace **不**改 lastUsedWorkspace
- 切 session 更新 sessionId/title/chat
- `handleNewSession` 创建新 session

**坑**：`handleSwitchSession` 的 `if (cs.mcodeSessionId) { applyMavisUsageToCs... }` 路径，mcodeSessionId=null 时跳过。测试用空 session.store + null mcodeSessionId 绕开。

### 4.4 chat.test.js.todo ❌ 0/3（import 阶段卡死）

**问题**：`await import(absPath('routes/chat.js'))` 在 `setupMocks` 之后挂起，永远不返回。

**疑似原因**：chat.js imports:
- `../lib/sessions.js` (mocked) ✓
- `../lib/state-bus.js` (real, 已加载) ✓
- `../lib/slash.js` (mocked, **但只 export 了 `handleLocalSlash`，缺 `handleCmdCommand`**) ⚠️
- `../lib/mcode-acp.js` (mocked, **只 export 了 `runMcodeAcp` 跟 `streamAcpPrompt`，够用**) ✓
- `../lib/mcode-exec.js` (mocked, **只 export 了 `runMcodeExec` 跟 `collectExecResult`，够用**) ✓
- `../lib/config.js` (real) ✓

**最可能原因**：mock `lib/sessions.js` 缺 `resetContext` 之类的 export。但我刚加过 resetContext/persistCurrentChat/streamUpdateLine/cleanupEmptyDefaultSessions，**应该**够。

**但**还可能：state-bus.js real 加载链里有 side effect。state-bus.js 顶部：
```js
import { loadSessions } from './sessions.js'  // 触发 mock
import { getMcodeSessionsForWorkspace, getMcodeSessionsCacheSync } from './acp-client.js'  // 触发 mock
import { getLanBroadcast } from './settings.js'  // 触发 mock
```
state-bus.js 已被 sessions.test.js 加载过（cache 命中），chat.test.js 里不需要重 load。但**同一 test 文件**里 `before` 钩子的顺序可能影响。

**接手建议**：
1. 先重命名 `chat.test.js.todo` → `chat.test.js`
2. 在 `before` 钩子里加 console.log trace，看 import 卡哪一步
3. 跟 sessions.test.js 比对差异：sessions.test.js 用 `mavis: { applyMavisUsageToCs: async () => {} }` override, chat.test.js 也用了

**或者更稳的修法**：在 `_setup.js` 的 `lib/sessions.js` mock 里**再多加几个**常见 helper export（如 `getSession`, `deleteSession`），并检查 `lib/state-bus.js` 顶部 import 有没有没满足的。

---

## 5. **踩过的关键 bug**（**做下一步前必看**）

### 5.1 ES6 shorthand typo 让 promise 永远 pending（v0.5.bx-30）

`server/lib/mavis-usage.js:69` 原本写：
```js
const lastContextTokens = lastIn + lastOut + lastReasoning
// ...
resolve({
  lastTurnContextTokens,  // shorthand for lastTurnContextTokens: lastTurnContextTokens — 引用未定义变量!
})
```

`child.on('exit', ...)` 抛 `ReferenceError: lastContextTokens is not defined`，resolve 永远不调，`applyMavisUsageToCs` 永远 await 返不了真值。**用户报告"context 显示估算"才被发现**。

**教训**：commit 前**必须**对 shorthand 变量名做 grep 验证（变量定义 / shorthand / reader 三处一致）。

### 5.2 `app/*.js` 跟 `styles/*.css` 默认 1h 缓存（v0.5.bx-35/36 修）

**症状**：改前端后用户必须 Ctrl+Shift+R hard refresh 才能拉到新文件。

**根因**：`server/lib/static.js:34` `Cache-Control: public, max-age=3600`，浏览器 1h 缓存。

**修法**（已在代码里）：
```js
const isAppJs = safe.startsWith('app/') && ext === '.js'
const isAppCss = safe.startsWith('styles/') && ext === '.css'
const noCache = isAppJs || isAppCss
res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': noCache ? 'no-cache' : 'public, max-age=3600' })
```

**改前端流程**：改完 commit → 告诉用户**不用 hard refresh**（CSS / main.js 自动 no-cache）。

### 5.3 `.left-panel { overflow: hidden }` 裁掉 popover（v0.5.bx-39）

`usage-popover` 是 `position: absolute` 算到 `btn-usage`，`width: 260px; left: calc(100% + 8px)` → 在 240px 宽的 left-panel 里**跨出 7px**，被 `.left-panel overflow: hidden` **裁掉**。click handler 触发了 `popover.hidden = false`，但视觉上"点不动"。

**修法**：`overflow: hidden` → `overflow: visible`（`.sessions-scroll` 已经有 `overflow-y: auto` 自己滚）。

**类似陷阱**（任何 webui/前端项目都适用）：
- `overflow: hidden/auto/scroll` 父元素 + 跨边界的 absolute 子元素 = 必被裁
- `overflow-x: visible` + `overflow-y: auto` 互斥，会被强制 both auto

### 5.4 mvsSessionId 必须只含 [a-f0-9]

`server/lib/mavis-usage.js:16` regex：`/^mvs_[a-f0-9]{16,}$/i`

**坑**：我之前写 fixture 用 `mvs_full1111...`，`full` 含 `l` 和 `u`，**不在 `[a-f0-9]` 里**，regex 拒了。SUT 走 early return 返 null，但 existsSync / SQL 都对，所以 0ms 返 null 看起来"应该 work 但不 work"——debug 浪费 1 小时。

**规则**：fixture 任何 mvsSessionId **必须**只含 `[a-f0-9]` 字符。

### 5.5 webui 改 server 端文件**必须**手动 kill+restart

webui server 启动时把 `server.js` + 所有 `server/lib/*.js` + `public/index.html` 全部 `readFileSync` 缓存到内存。改完 commit **不等于生效**——必须重启。

**kill 旧 + 启动新**（**必须按 PID 精准杀**，不按端口一刀切——可能误杀 mavis 桌面端）：
```powershell
# 1. 找 webui 进程 (注意: 启动 webui 的 node 进程的 CommandLine 含 webui/server.js)
Get-CimInstance Win32_Process -Filter "Name = 'node.exe'" |
  Where-Object { $_.CommandLine -like '*webui*server.js*' } |
  Select-Object ProcessId, StartTime

# 2. 杀 (按 PID, 不按端口)
Stop-Process -Id <webui_pid> -Force

# 3. 启动新 (PORT 是 v0.5.bx-38 默认 8080, HOST 默认 0.0.0.0)
cd C:\Users\mjc39\.minimax-code\webui
$env:PORT="8080"; $env:HOST="0.0.0.0"
Start-Process -FilePath "node" -ArgumentList "server.js" `
  -RedirectStandardOutput "$env:TEMP\webui-8080.out.log" `
  -RedirectStandardError "$env:TEMP\webui-8080.err.log" `
  -WorkingDirectory "C:\Users\mjc39\.minimax-code\webui" `
  -WindowStyle Hidden
```

**验证启动时间**：`Get-Process -Id <new_pid> | Select StartTime` — 必须是当前时间。

**只改前端**（`public/app/main.js` / `public/styles/main.css`）→ **不需要重启 server**（v0.5.bx-35/36 加 no-cache + `readFileSync` 缓存 vs 浏览器 fetch 路径不同——CSS 跟 main.js 是浏览器 fetch，server 缓存的是 `public/index.html`）。

**改 `public/index.html`** → **必须重启 server**（server 启动时 readFileSync 缓存整个 HTML 到内存）。

### 5.6 端口冲突历史（v0.5.bx-38 默认 8080）

之前 webui 默认 7890，**跟 mavis 桌面端 冲突**。所以改成 8080（用户手机/平板/局域网访问用 8080）。如需测试用 7890：`PORT=7890 node server.js`。

URL：`http://192.168.31.95:8080/`

### 5.7 Git 默认不自动 push（**用户硬规则**）

`git push` / `gh pr create` / `website_deploy` **默认拒绝**。只有用户某次明确说"这次推"/"帮我 push" 才打破默认。

光说"我以后要 push"或"我要 push 到 GitHub" **不算授权**——是告知，需每次单独说"这次推"。

---

## 6. 后续批次（**你接手要做的**）

### 批次 1（**当前在做**）— 单元测试

**已完成 18/18**（mavis-usage + state-bus + sessions）。剩 chat.test.js 待修。

**接受标准**：
- 4 个 test 文件全部跑通
- `node --experimental-test-module-mocks --test test/*.test.js` 22+/22+ 通过
- 一波 commit 包含：`_setup.js` + 4 个 test + fixture + package.json `"test": "node --test test/"`（**还没改 package.json！**）+ REFACTORING.md（本文档）

### 批次 2 — ESLint + Prettier

**目标**：拦 v0.5.bx-30 这种 typo / 风格不一致

**改的东西**：
- `package.json` 加 devDependency（注意 **不能破坏"Zero deps" production tree** —— 装 `eslint` + `eslint-config-standard` + `prettier` 都放 devDependencies）
- 新建 `.eslintrc.json` (`extends: ["eslint:recommended"]`)
- 新建 `.prettierrc` (空对象 + 默认风格)
- 加 scripts: `"lint": "eslint server/ test/"`, `"format": "prettier --write server/ test/"`
- 可能要 lint 现有 server/ 跟 test/，但**只 lint，不修代码**（避免一次性大批量 diff）

**注意**：webui 是 ESM (`"type": "module"`)，eslint config 要 `"sourceType": "module"`，rules 适配。

### 批次 3 — GitHub Actions CI

**目标**：跑 `node --check` + `npm run lint` + `npm test`，PR 必过

**改的东西**：
- `.github/workflows/ci.yml`：Node 22 + 24 matrix
- 触发：push 到 main, PR

### 批次 4 — main.js 拆 5 个 ESM 模块（**风险最大，放最后**）

**目标**：把 4410 行 monolith 拆成 5 个 ESM 文件

**计划**：
- `public/app/i18n.js` — I18N 常量 + t() / applyI18n()（约 1000 行）
- `public/app/state.js` — state 对象 + SSE 订阅（约 800 行）
- `public/app/render.js` — 所有 render*() 函数（最大，~1500 行）
- `public/app/events.js` — attachEvents + 事件 handler（~600 行）
- `public/app/util.js` — 工具函数（escapeHtml, formatResetTime 等，~300 行）
- `public/app/main.js` — bootstrap，import 上面 5 个 + 启动（< 200 行）

**改的 HTML**：`public/index.html` `<script src="main.js">` → `<script type="module" src="main.js">`

**风险**：
- 改 import 顺序错了某个 state 共享的变量会 undefined
- 事件绑定有 timing 问题（DOMContentLoaded / iframe load 等）
- i18n key 重复定义
- **必须先有 test 覆盖**（批次 1+2+3 落地后再做）

---

## 7. 你接手要立刻做的 3 件事

1. **看 chat.test.js.todo 跑通的方案**：重命名 → 跑测试 → 改 _setup.js mock 漏掉的 export → 跑通
2. **改 `package.json` 加 `"test": "node --experimental-test-module-mocks --test test/*.test.js"`**（保留现有 `start` 跟 `dev`）
3. **一波 commit**：
   - 消息: `test(webui v0.5.bx-test): unit test 覆盖 bx-30 / bx-31 / bx-32 回归 (22/22 通过)`
   - 包含: `_setup.js` + 4 个 test + fixture db + `test/fixtures/create-test-db.mjs` + `package.json` 改 + `REFACTORING.md`
   - **不 push**（按 §5.7）

**之后**用户确认 OK，**再做批次 2（ESLint）**。

---

## 8. 给下一个 model 的元建议

- **别相信你之前对项目的"印象"**——项目持续在变（v0.5.bx-30 ~ bx-39 改了 12+ 文件），先 `git log --oneline -10` 跟 `git status` 看最新状态
- **先 `node --check public/app/main.js` 跟 `node --check server.js`**——这两个文件每次改都跑
- **改 webui server 端前**先把现在 server 的 PID 跟启动时间记下来（用 `Get-NetTCPConnection -LocalPort 8080 -State Listen` + `Get-Process`）
- **改 webui 前端**告诉用户"不用 hard refresh"（v0.5.bx-35/36 加了 no-cache）
- **任何 "用户报告点不动"** 先用内置浏览器 inspect 看 handler 是不是触发了（DOM hidden 属性 / class 切换），别直接改 listener（v0.5.bx-39 教训）
- **任何 "用户报 context 显示估算"** 直接看 `server/lib/mavis-usage.js` 的 ES6 shorthand 变量名三处一致性
- **任何 spawn-related 测试**：mock 不可靠，用真 sqlite3 + fixture
- **任何 mock.module('node:fs', ...)**：会 break IIFE 副作用代码，**不要 mock node:fs**

---

## 9. 已知未解决问题（不在批次 1-4 范围，但顺手提一下）

1. **mcode 0.1.5 acp 不返 `r.usage`**：永远 null，所以走 mavis db 估算分支——**等 mcode 上游加 usage 返回字段才能彻底解决**。
2. **webui frontend `public/app/main.js` 4410 行 monolith**：批次 4 处理。
3. **0 个集成测试**：批次 1-3 都是 unit test，**没有 E2E**（如 SSE 端到端）。要做的话用 `node:test` + 启真 server + 模拟 HTTP client，但比较花时间。
4. **mavis-usage.js 的 spawn 错误路径没法测**（mock 不可靠，真 spawn 测要 hack fixture SQL）——已用 `describe.skip` 标注。
5. **v0.5.bx-19 起 db.js 用了 `createRequire(import.meta.url)` lazy require better-sqlite3**：测 mavis session 删除（`deleteMcodeSessionFromDb`）时需要这个，能 mock 但暂时没测。
6. **chat.test.js.todo 还没跑通**——可能需要 _setup.js 的 sessions.js mock 再补几个 export。

---

## 10. 关键文件位置速查

| 用途 | 路径 |
|---|---|
| 测试入口脚本 | `node --experimental-test-module-mocks --test test/*.test.js` |
| Fixture db | `test/fixtures/v2/sqlite/runtime-state.sqlite`（16KB） |
| Fixture 重建 | `node test/fixtures/create-test-db.mjs` |
| Mock 框架 | `test/_setup.js`（200 行，核心抽象） |
| Server stderr/out | `$env:TEMP\webui-8080.{out,err}.log` |
| 真实 mavis db（**别动**） | `C:\Users\mjc39\.minimax\v2\sqlite\runtime-state.sqlite`（670MB） |
| 真实 sqlite3 binary | `C:\Users\mjc39\anaconda3\Library\bin\sqlite3.exe`（不在 PATH） |
| Webui URL | `http://192.168.31.95:8080/` |
| Lan IP | `192.168.31.95` |
| 项目根 | `C:\Users\mjc39\.minimax-code\webui\`（**带 `.`**） |
| 当前分支 | `refactor/modularization` |
| HEAD commit | `d2db672` |

---

**完。** 看到这个文档你应该能直接接批次 1 收尾 + 跑批次 2/3/4。

有疑问先 `git log --oneline -10` 跟 `git status` 验证仓库状态，再问。**别假设**你之前知道的 webui 还准确——v0.5.bx 系列改了很多。
