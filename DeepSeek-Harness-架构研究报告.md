# DeepSeek Harness 架构研究报告

> 本报告基于对 DeepSeek Harness 源码仓库的深度分析，系统梳理其架构设计、核心包结构、插件/能力系统、构建流程与测试体系，旨在为自建 Agent Harness 提供参考蓝图。
>
> 生成日期：2026-08-25

---

## 目录

1. [项目概览](#1-项目概览)
2. [核心设计哲学](#2-核心设计哲学)
3. [Cordis 插件框架](#3-cordis-插件框架)
4. [能力缝（Capability Seam）模式](#4-能力缝capability-seam模式)
5. [核心包结构](#5-核心包结构)
6. [会话与代理循环](#6-会话与代理循环)
7. [工具系统](#7-工具系统)
8. [Profile 与 Bundle 组合系统](#8-profile-与-bundle-组合系统)
9. [插件开发完整指南](#9-插件开发完整指南)
10. [构建系统](#10-构建系统)
11. [测试体系](#11-测试体系)
12. [质量门禁体系](#12-质量门禁体系)
13. [Python SDK](#13-python-sdk)
14. [自建 Harness 的架构建议](#14-自建-harness-的架构建议)

---

## 1. 项目概览

DeepSeek Harness（`dsh`）是 DeepSeek AI 开源的智能体框架，基于 Cordis 插件框架构建。当前处于 developer preview 阶段。

### 仓库布局

```
deepseek-harness-master/
├── vendor/       # Vendored Cordis 框架源码（pinned source copies）
├── packages/     # @deepseek-ai/dsh-* 工作区包（按能力分组）
│   ├── core/       # 产品 API 脊柱：session, agent, tools, system-prompt, agent-loop
│   ├── llm/        # LLM 能力：Service Definition + DeepSeek 适配器
│   ├── shell/      # Shell 能力：executor seam + local/sandbox providers
│   ├── fs/         # 文件系统能力
│   ├── web/        # Web 能力：搜索/抓取
│   ├── subagent/   # 子代理能力
│   ├── boot/       # 启动引导
│   ├── bundle/     # 可安装的 patch-layer bundles
│   ├── session/    # 持久化会话数据
│   ├── sdk/        # JSON-RPC 协议与 TS 客户端
│   ├── acp/        # Agent Client Protocol 服务器
│   └── ...         # 更多能力包（共 28+ 分组）
├── native/       # Landlock 启动器原生构建
├── python/       # Python SDK 与运行时
├── examples/     # 可运行的 cordis.yml 示例
├── scripts/      # 构建脚本与质量门禁
├── website/      # VitePress 文档站点
└── apps/         # 产品应用（CLI, Web）
```

### 技术栈

| 项目 | 版本/工具 |
|---|---|
| 运行时 | Node.js `^22.19` 或 `>=24` |
| 包管理器 | pnpm 11.7.0（通过 Corepack） |
| 模块系统 | ESM only（`"type": "module"`） |
| 语言 | TypeScript（`strict: true`, `noImplicitAny`） |
| 构建工具 | tsc + tsdown |
| 测试框架 | Vitest |
| Lint | Oxlint |
| 文档 | VitePress |

---

## 2. 核心设计哲学

DeepSeek Harness 的架构建立在几个核心原则之上：

### 2.1 一切皆插件

> "DeepSeek Harness is a plugin-based agent harness on vendored Cordis: **everything is a plugin**."

没有特权核心可以打补丁。扩展 dsh 的方式是在其他插件旁边挂载一个插件，所有注册都是可逆的 effect，在插件卸载时自动回退。

### 2.2 注册即 Effect

每个贡献（prompt section、tool schema、adapter、provider、listener）都通过 `ctx.effect()` 或 `ctx.on()` 安装，确保重载和拆卸时可预测地回退。

### 2.3 模型可见即已记录

> "Model-visible ⟺ logged: anything that reaches a model request must be reconstructable from the session log."

任何到达模型请求的内容都必须能从会话日志重建。新的模型可见输入需要新的会话事件。

### 2.4 插件而非循环修改

新行为通过文档化的扩展点实现；修改 `agent-loop` 需要更新 `docs/architecture.md`。

### 2.5 显式优于隐式（包边界处）

默认值是拥有实现中的显式 `resolve(request): Spec` 步骤，绝不是 `run()` 内部的隐藏 `?? default`。

### 2.6 误导配置立即失败

在加载时能自检测的错误立即失败；否则在最早可解析点失败；从不静默跳过缺失的引用。

---

## 3. Cordis 插件框架

Cordis 是 DeepSeek Harness 底层的依赖注入和插件生命周期运行时，源码 vendored 在 `vendor/cordis/`。

### 3.1 Context（ctx）— 依赖容器

`Context` 是根依赖容器，实现为代理（proxy）：普通属性读取经过 service resolver，而 `extend()`、`isolate()`、`intercept()` 创建不修改父级的子上下文。

**核心 ctx API：**

| 方法 | 用途 |
|---|---|
| `ctx.get(name, strict?)` | 按名称读取服务 |
| `ctx.provide(name, value)` | 注册当前 fiber 拥有的服务实现 |
| `ctx.plugin(plugin, ...args)` | 在当前上下文加载插件 |
| `ctx.inject(deps, callback)` | 等待所需服务可用后执行回调 |
| `ctx.on(event, listener)` | 监听事件 |
| `ctx.emit(event, ...args)` | 触发事件 |
| `ctx.effect(disposer)` | 注册可清理的 effect |
| `ctx.isolate(name, label?)` | 创建独立服务 scope 的子上下文 |
| `ctx.intercept(name, config)` | 为下级插件添加服务拦截配置 |

### 3.2 Fiber — 插件运行时实例

每个插件运行在一个 `Fiber` 内。Fiber 管理 effect 生命周期、追踪 disposer，确保插件卸载时清理。

```typescript
// Effect 可以是同步或异步的
type Effect<T = any> =
  | Disposable<T>                    // 同步 disposer
  | Iterable<Disposable<T>>          // 同步迭代器
  | Promise<Disposable<T>>           // 异步 disposer
  | AsyncIterable<Disposable<T>>     // 异步迭代器
```

Disposer 按注册逆序执行，卸载会等待它们完成。

### 3.3 插件入口形态

Cordis 支持三种插件形态：

```typescript
// 1. 函数插件
export function apply(ctx: Context, config: Config): void { ... }

// 2. 对象插件
export default { apply(ctx: Context, config: Config) { ... } }

// 3. 类插件（继承 Service）
export class MyService extends Service {
  constructor(ctx: Context) { super(ctx, 'myService') }
}
```

每个插件可声明：
- `name` — 诊断用的显示名称
- `Config` — standard-schema 配置验证器
- `inject` — 依赖的服务列表
- `provide` — 提供的服务名

### 3.4 事件分发模式

Cordis 提供四种事件分发模式：

| 模式 | 是否 await | 顺序 | 返回值 | 用途 |
|---|---|---|---|---|
| `emit` | 否 | 注册序 | 无 | 通知观察者 |
| `waterfall` | 否 | 注册序 | 是 | 中间件链（需调用 `next()`） |
| `parallel` | 是 | 并行 | 无 | 扇出 |
| `serial` | 是 | 注册序 | 是 | 有序串行 |

**Waterfall 语义**（关键）：监听器收到 `(...args, next)`。调用 `next()` 委托给下一个服务；不调用 `next()` 直接返回则短路链。值通过 `next()` 的返回值传播。

```typescript
// Waterfall 示例：tools/pre-execute
ctx.on('tools/pre-execute', async (exec, next) => {
  // 可以拒绝、允许、或询问
  const decision = await next()  // 委托给下一个监听器
  return decision
})
```

### 3.5 服务注册与发现

服务通过 `ctx.provide()` 注册，通过 `ctx.get()` 或 `ctx.<name>` 发现。服务的生命周期绑定到注册它的 Fiber。

```typescript
// 注册服务
ctx.provide('myService', { doSomething: () => 'hello' })

// 发现服务（通过 inject 等待）
export const inject = ['myService']
export function apply(ctx: Context) {
  const myService = ctx.get('myService')
  myService.doSomething()
}
```

### 3.6 上下文隔离与拦截

```typescript
// 隔离：创建独立服务 scope 的子上下文
const childCtx = ctx.isolate('llm', Symbol('agent-1'))
// 在 childCtx 下注册的 llm 服务不影响父上下文

// 拦截：为下级插件合并配置
const childCtx = ctx.intercept('llm', { provider: 'deepseek-official' })
// 在 childCtx 下加载的插件看到合并后的 llm 配置
```

---

## 4. 能力缝（Capability Seam）模式

能力缝是 DeepSeek Harness 最核心的架构模式。

### 4.1 定义

> "A **seam** is a swappable capability with three roles: a **Service Definition** declaring the interface, a **Service Provider** implementing it, and a **Consumer** using it, commonly a model-facing tool."

一个能力缝包含三个角色：

| 角色 | 职责 | 示例 |
|---|---|---|
| **Service Definition** | 声明接口和 `ctx.<key>`，是抽象类或注册表 | `dsh-shell`（ShellExecutor） |
| **Service Provider** | 实现服务定义 | `dsh-bash-local`、`dsh-bash-sandbox` |
| **Consumer** | 通过 inject 使用服务，通常是模型可见的工具 | `dsh-tool-bash` |

### 4.2 为什么用能力缝

> "Seams are why one provider swap changes the whole product. Filesystem and subprocess providers share one execution world, so pointing them at a remote sandbox moves Bash, PTY, and LSP with them, with no provider forks."

切换一个 provider（如从本地 bash 切到沙箱 bash）可以改变整个产品行为，而不需要 fork 任何 provider。

### 4.3 已有能力缝清单

| ctx key | Service Definition | Providers | Consumers |
|---|---|---|---|
| `ctx.llm` | `dsh-llm` | `llm-deepseek`, `llm-pi-ai`, `llm-replay` | `agent-loop`, `compaction-basic` |
| `ctx.fs` | `dsh-fs` | `fs-local`, `fs-sandbox`, `fs-e2b` | `tool-fs` |
| `ctx.shell` | `dsh-shell` | `bash-local`, `bash-sandbox`, `pwsh-local` | `tool-bash`, `tool-pwsh`, hooks |
| `ctx.web` | `dsh-web` | `web-search-exa`, `web-search-perplexity`, `web-fetch-http` | `tool-web` |
| `ctx.subagents` | `dsh-subagent` | spawn-in-process, fork-in-process, ACP, Codex, Claude Code, DSH SDK | `tool-subagent`, `tool-ralph` |

### 4.4 能力缝的包级规则

> "Extension plugins depend on Service Definitions, never concrete providers."

扩展插件依赖 Service Definition，从不依赖具体 provider。这确保了 provider 可替换性。

### 4.5 LLM 能力缝详解（示例）

**Service Definition** (`packages/llm/llm/src/types.ts`)：

```typescript
export interface Message {
  role: 'user' | 'assistant' | 'tool' | 'system'
  content: ContentBlock[]
  source: MessageSource
}

export interface GenerateOptions {
  provider: string
  model: string
  messages: Message[]
  system?: string
  tools?: ToolSchema[]
  temperature?: number
  maxTokens?: number
  signal?: AbortSignal
  sessionId?: Branded<'SessionId'>
}

export interface ToolSchema {
  name: string
  description: string
  parameters: Record<string, unknown>
}
```

**Provider** (`packages/llm/llm-deepseek/`)：注册 DeepSeek API 适配器路由。

**Consumer** (`packages/core/agent-loop/`)：通过 `ctx.llm` 发起模型请求。

---

## 5. 核心包结构

`packages/core/` 包含 9 个包，构成应用的产品 API 脊柱。

### 5.1 包清单

| 包 | npm 名 | ctx key | 职责 |
|---|---|---|---|
| `scope` | `dsh-scope` | — | scope 原语：scoped 注册与事件路由 |
| `session` | `dsh-session` | `ctx.sessions` | 追加式事件日志与会话存储 |
| `agent` | `dsh-agent` | `ctx.agents` | Agent 接口、注册表与生命周期事件 |
| `agent-loop` | `dsh-agent-loop` | `ctx.agentLoop` | 默认 Agent 驱动循环 |
| `tools` | `dsh-tools` | `ctx.tools` | 工具注册表与执行管道 |
| `system-prompt` | `dsh-system-prompt` | `ctx.systemPrompt` | 系统提示词组装 |
| `agent-default-model` | `dsh-agent-default-model` | — | 默认 provider/model 解析 |
| `agent-tool-presentation` | `dsh-agent-tool-presentation` | — | Agent 工具呈现配置 |

### 5.2 包依赖关系

```
scope (零依赖，仅 Cordis)
  ↑
session ──── depends on ──→ scope, llm, brand, typert-protocol
  ↑
agent ────── depends on ──→ scope, llm, session, typert-protocol
  ↑
agent-loop ─ depends on ──→ agent, llm, session, session-persistence,
                            system-prompt, tools, scope, schemastery, settings
  ↑
tools ────── depends on ──→ scope, llm, session, code-runtime
  ↑
system-prompt depends on ─→ scope, llm, schemastery
```

### 5.3 Scope 包（`dsh-scope`）

提供继承感知的 scope 系统。注册层向下继承 scope 链，事件准入向上扩展。

**核心概念：**
- `ScopeKey` — 不透明的身份比较键
- `Scoped<T>` — 仅路由的事件接收器 brand
- 全局注册 vs scoped 注册（most-specific-wins 影子覆盖）
- 一个活跃 agent 是它自己 scope 的 key

### 5.4 Session 包（`dsh-session`）

维护追加式事件日志、内存会话存储和派生的 LLM 消息历史。

**关键类型：**
- `SessionStore` — 持有活跃会话的服务
- `SessionId` — branded 会话标识符
- `Session` — 活跃会话对象（id, events, surface, header）
- `SESSION_FORMAT_VERSION = 0` — 磁盘格式版本（无兼容承诺）

**会话事件：**
- `session/created`
- `session/disposed`
- `session/event`
- `session/flush`

### 5.5 Agent 包（`dsh-agent`）

定义 Agent 合约、管理注册表、提供 scoped 事件发射。

**Agent 生命周期事件：**
- `agent/created` / `agent/disposed`
- `agent/status`（idle | running）
- `agent/inbox/inserted` / `agent/inbox/claimed` / `agent/inbox/discarded`
- `agent/session-start`
- `agent/pre-step` / `agent/request` / `agent/request-error`
- `agent/turn-stopping` / `agent/error`

### 5.6 Agent-Loop 包（`dsh-agent-loop`）

默认的 Agent 驱动循环，创建 scoped `ReactLoopAgent` 实例。

**配置：**
```typescript
export interface AgentLoopConfig {
  agents: ConfiguredAgent[]    // 声明式配置的 agent
  sessionId?: string           // 指定会话 ID
  resumeSessionId?: string     // 恢复已有会话
  cwd?: string                 // 工作目录
  provider?: string            // LLM provider
  model?: string               // 模型 ID
  maxTokens?: number           // 最大 token 数
}
```

### 5.7 Tools 包（`dsh-tools`）

维护分层 scoped 工具注册表，将工具 schema 投射到系统提示词，支持原生模式和 Code Mode。

**关键接口：**
- `ToolRuntime` — 工具注册表与执行管道服务
- `ToolDefinition` — schema、执行、超时、终结和呈现回调
- `ToolExecution` — 执行记录
- `ToolRestriction` — allow/deny 全局工具掩码

### 5.8 System-Prompt 包（`dsh-system-prompt`）

从有序 sections、动态 contexts、工具 schemas 和变量插值组装系统提示词。

**关键接口：**
- `SystemPrompt` — 注册表，管理有序 sections、动态 context、工具 schemas 和提示词变量
- `PromptAssembly` — 组装后的模型输入
- `renderPrompt()` — 渲染 sections 带变量插值

### 5.9 启动序列

启动入口在 `packages/boot/app-boot/`：

1. 解析 profile 目录
2. 写入 profile 根配置
3. 组合层：bundle layers → profile patches → home patches → `--patch` overlays
4. 调用 `boot(NAME, rootConfig, allPatches, ...)`
5. 提供启动环境和命令行信息到上下文
6. 安装 fail-loud 守卫
7. 可选启动用户 patch watcher

---

## 6. 会话与代理循环

### 6.1 核心概念

> "A **step** is one model request plus the tools it calls. A **turn** is zero or more steps: it opens before its first input is claimed and closes once nothing is owed."

### 6.2 Turn 流程

```
turn/start
  │
  ├─ claim 下一步输入 + 一条排队消息
  ├─ 组装 prompt sections + tool schemas
  │
  ├─→ agent/pre-step (waterfall)
  │     ├─ reject → 关闭 turn（无 step）
  │     └─ enter → step/start
  │
  │  step/start
  │    ├─ 追加 entered messages 作为 user/message
  │    ├─ 从日志派生模型历史
  │    │
  │    ├─→ agent/request (waterfall)
  │    │    └─→ llm/stream
  │    │         ├─ assistant/chunk* (流式响应)
  │    │         └─ assistant/message
  │    │
  │    ├─ tool/call*
  │    │    ├─→ tools/pre-execute (waterfall)
  │    │    ├─→ tools/execute (waterfall)
  │    │    ├─→ tools/post-execute (waterfall)
  │    │    └─ tool/result*
  │    │
  │    └─ step/end
  │
  ├─ tools 欠另一个请求，或下一步输入到达 → claim → 下一个 step
  │
  ├─→ agent/turn-stopping (serial, 无 next())
  │
  └─ turn/end
```

### 6.3 事件分类

| 类别 | 事件 | 持久化 |
|---|---|---|
| 会话事件 | `turn/*`, `step/*`, `user/message`, `assistant/*`, `tool/*` | 是（SessionEventMap） |
| 实时扩展点 | `agent/pre-step`, `agent/request`, `llm/stream`, `tools/*` | 否 |

### 6.4 Session Log

会话日志是模型所见上下文的唯一来源。`deriveMessages()` 从日志投射模型历史，原始 `assistant/chunk` 事件保留回放和 UI 保真度。

### 6.5 Agent Scope

- **全局注册**：对所有 agent 可见
- **Scoped 注册**：由一个 scope key 独占拥有
- **影子覆盖**：most-specific-wins 名称解析，scoped tool/section/variable 替换同名的全局 twin

---

## 7. 工具系统

### 7.1 工具定义

工具通过 `defineTool()` 定义，位于 `packages/core/tools/src/schema.ts`：

```typescript
export function defineTool<S, O>(options: DefineToolOptions<S, O>): ToolDefinition

interface DefineToolOptions<S, O> {
  readonly name: string
  readonly description: string
  readonly parameters: S                    // 类型安全的参数 schema DSL
  readonly output: {
    readonly schema: O                     // 输出 schema
    render(args, value): ContentBlock[]    // 渲染为模型可见内容
    presentationMeta?(args, value): JsonValue
  }
  readonly timeoutMs?: number
  isConcurrencySafe?(args): boolean
  execute(args, exec: ToolRunContext): Promise<InferValue<O>>
  finalizeContent?(exec, result): ContentBlock[] | undefined
  presentCall?(args): ToolCallView | undefined
  presentResult?(args, result): ToolResultView | undefined
}
```

### 7.2 参数 Schema DSL

使用类型安全的 schema DSL 而非原始 JSON Schema：

```typescript
const myTool = defineTool({
  name: 'my-tool',
  description: 'A custom tool',
  parameters: {
    message: {
      type: 'string',
      description: 'The message to process',
      required: true,
    },
    count: {
      type: 'integer',
      description: 'How many times',
    },
  },
  output: {
    schema: { type: 'string' },
    render(args, value) {
      return [{ type: 'text', text: String(value) }]
    },
  },
  async execute(args, exec) {
    return args.message
  },
})
```

DSL 通过 `parameterSchemaSpecToJsonSchema()` 编译为 JSON Schema 供模型消费。

### 7.3 工具执行管道

工具经过 waterfall 事件管道执行：

| 事件 | 用途 | 模式 |
|---|---|---|
| `tools/pre-execute` | 允许、拒绝或询问 | waterfall |
| `tools/execute` | around-dispatch 包装（超时、重试、指标） | waterfall |
| `tools/post-execute` | 接受、替换、丰富或阻止结果 | waterfall |
| `tools/result` | 观察冻结的最终结果 | emit |

**执行流程：**
1. 模型提出 tool call
2. 参数规范化
3. `tools/pre-execute`：允许或拒绝
4. `tools/execute`：运行实际工具体（可能有超时/重试包装）
5. `tools/post-execute`：接受、替换、丰富或阻止结果
6. `tools/result`：观察最终结果
7. 内容返回给模型

### 7.4 Code Mode

Code Mode 是核心执行能力。`run_code` 运行一个模型编写的程序，访问 host 提供的 async bindings。运行时后端通过 `ctx.codeRuntime` 配置。

> "`run_code` is the only tool you can call directly — a tool call naming any other tool fails. Reach every tool the SDK declares below from inside the program."

### 7.5 工具呈现

工具的 UI 渲染意图是设计的一部分，需提前决定：

- `generic` — 通用呈现
- `terminal` — 终端输出呈现
- `diff` — 差异呈现
- `locations` — 文件位置呈现

呈现方法是 `args` 的纯函数。

---

## 8. Profile 与 Bundle 组合系统

### 8.1 Profile

> "A **profile** is a named composition stored in the Harness home. It lists the bundles it stacks, holds any out-of-tree plugins it installs, and keeps the user's own `cordis.patch.yml`."

Profile 是 `$DSH_HOME/profiles/<name>` 下的目录，包含：
- `package.json` — 依赖与 `dsh.profile` manifest（有序 `bundles` 列表）
- `cordis.patch.yml` — 用户自己的 patch 层

### 8.2 Bundle

> "A **bundle** is a distribution format for Cordis config rows and the code they mount, so whatever it inserts stays patchable by the layers above it."

Bundle 的 `package.json` 声明：
```json
{
  "dsh": {
    "bundle": {
      "patch": "./cordis.patch.yml"
    }
  }
}
```

### 8.3 组合顺序

```
1. 每个 bundle 按 profile 列出的顺序
2. Profile 的 cordis.patch.yml
3. Home 级 cordis.patch.yml
4. 任何 --patch overlay
```

### 8.4 dsh-base（基础 bundle）

`dsh-base` 是每个 profile 的第一层，注入共享核心服务：

```yaml
# packages/bundle/base/cordis.patch.yml
- insert:
    - id: llm
      name: '@deepseek-ai/dsh-llm'
    - id: session
      name: '@deepseek-ai/dsh-session'
    - id: agent
      name: '@deepseek-ai/dsh-agent'
    - id: agent-default-model
      name: '@deepseek-ai/dsh-agent-default-model'
    - id: subprocess
      name: '@deepseek-ai/dsh-subprocess-local'
    - id: sandbox
      name: '@deepseek-ai/dsh-sandbox-local'
    - id: fs-sandbox
      name: '@deepseek-ai/dsh-fs-sandbox'
    - id: llm-deepseek
      name: '@deepseek-ai/dsh-llm-deepseek'
    - id: tools
      name: '@deepseek-ai/dsh-tools'
    - id: agent-loop
      name: '@deepseek-ai/dsh-agent-loop'
```

### 8.5 Headless Bundle 示例

```yaml
# packages/bundle/headless/cordis.patch.yml
- id: system-prompt
  config:
    persona: >-
      You are a coding agent powered by the {{model}} model.

- id: hmr
  disabled: true

- insert:
    - id: code-runtime
      name: '@deepseek-ai/dsh-code-runtime-worker-thread'
    - id: headless-startup
      name: '@deepseek-ai/dsh-headless/startup'
    - id: headless-runner
      name: '@deepseek-ai/dsh-headless'
      inject: [headlessStartup]
      config:
        task: !!js ctx.headlessStartup.task
```

### 8.6 完整 cordis.yml 示例（Headless Agent）

```yaml
- id: settings
  name: '@deepseek-ai/dsh-settings-file'

- id: credentials
  name: '@deepseek-ai/dsh-credentials-local'

- id: llm-deepseek
  name: '@deepseek-ai/dsh-llm-deepseek'
  config:
    thinking: enabled
    reasoningEffort: max
    models:
      - id: deepseek-v4-pro
        contextWindow: 128000

- id: bash
  name: '@deepseek-ai/dsh-bash-local'
  config:
    timeoutMs: 60000

- id: agent-spine
  name: '@deepseek-ai/dsh-agent-spine-demo'
  config:
    agents:
      - id: main
        provider: deepseek-official
        model: deepseek-v4-flash
        cwd: !!js process.cwd()

- id: persistence
  name: '@deepseek-ai/dsh-session-persistence-jsonl'
  config:
    root: './.sessions'

- id: tool-fs
  name: '@deepseek-ai/dsh-tool-fs'
```

---

## 9. 插件开发完整指南

### 9.1 选择插件形态

**函数插件（最常见）：**
```typescript
import type { Context } from '@deepseek-ai/cordis'

export const name = 'my-plugin'

export interface Config {
  greeting: string
}

export function apply(ctx: Context, config: Config): void {
  ctx.logger('my-plugin').info(config.greeting)
}
```

**类插件（提供 Service）：**
```typescript
import { Service } from '@deepseek-ai/cordis'

export class MyService extends Service {
  constructor(ctx: Context) {
    super(ctx, 'myService')
  }

  doSomething(input: string): string {
    return `processed: ${input}`
  }
}
```

### 9.2 声明依赖

```typescript
// 数组形式
export const inject = ['agents', 'sessions', 'llm']

// 带拦截配置的对象形式
export const inject = {
  llm: {
    provider: 'deepseek-official',
    model: 'deepseek-v4-flash',
  },
}
```

### 9.3 注册服务

```typescript
export function apply(ctx: Context, config: Config): void {
  // 方式 1：通过 ctx.provide()
  ctx.provide('myService', {
    value: config.name,
    now: Date.now(),
  })

  // 方式 2：通过 Service 子类（自动注册）
  // （见 9.1 类插件示例）
}
```

### 9.4 注册事件监听

```typescript
export function apply(ctx: Context): void {
  // emit 事件
  ctx.on('session/created', (session) => {
    ctx.logger('my-plugin').info('Session created', session.id)
  })

  // waterfall 事件（必须调用 next()）
  ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.toolName === 'dangerous-tool') {
      return { kind: 'deny', reason: 'Blocked by policy' }
    }
    return next()
  })
}
```

### 9.5 注册 Effect（可清理）

```typescript
export function apply(ctx: Context): void {
  const interval = setInterval(() => {
    ctx.emit('my-plugin/tick', Date.now())
  }, 1000)

  ctx.effect(() => clearInterval(interval))
}
```

### 9.6 定义和注册工具

```typescript
import { defineTool } from '@deepseek-ai/dsh-tools'

const myTool = defineTool({
  name: 'my-tool',
  description: 'Process a message',
  parameters: {
    message: {
      type: 'string',
      description: 'The message to process',
      required: true,
    },
  },
  output: {
    schema: { type: 'string' },
    render(args, value) {
      return [{ type: 'text', text: String(value) }]
    },
  },
  async execute(args, exec) {
    return `Processed: ${args.message}`
  },
})

export function apply(ctx: Context): void {
  ctx.tools.register(myTool)
}
```

### 9.7 添加 cordis.yml 条目

```yaml
- id: my-plugin
  name: '@deepseek-ai/dsh-my-plugin'
  config:
    greeting: Hello World
```

### 9.8 插件包结构

```
packages/my-group/my-plugin/
├── package.json
├── tsconfig.json
├── src/
│   ├── index.ts        # 主入口
│   ├── invariant.ts    # 运行时不变量
│   └── types.ts        # 类型定义（可选）
└── tests/
    └── *.spec.ts       # 单元测试
```

**package.json 模板：**
```json
{
  "name": "@deepseek-ai/dsh-my-plugin",
  "type": "module",
  "main": "lib/index.js",
  "types": "lib/types/index.d.ts",
  "peerDependencies": {
    "@deepseek-ai/cordis": "workspace:^"
  },
  "devDependencies": {
    "@deepseek-ai/cordis": "workspace:^"
  }
}
```

### 9.9 invariant.ts（每个包必须有）

每个包必须导出一个 `./invariant` 子路径，注册 manifest name 并检查事件/数据关系：

```typescript
// src/invariant.ts
export const name = 'my-plugin'
// 如果没有运行时不变量：
// export const noRuntimeInvariant = 'No runtime invariant: stateless plugin'
```

---

## 10. 构建系统

### 10.1 pnpm Workspace

```yaml
# pnpm-workspace.yaml
packages:
  - vendor/*
  - packages/*/*
  - native/landlock-run
  - native/landlock-run/packages/*
  - apps/*
  - website
  - examples
  - python/sdk-runtime
```

特性：
- `linkWorkspacePackages: true` — 本地包通过 workspace 链接解析
- `overrides` — 别名 vendored 框架包到 workspace 链接
- `allowBuilds` — 显式控制哪些包可运行 build 脚本

### 10.2 TypeScript 双聚合系统

项目使用 **TypeScript Project References** 的双聚合系统：Host 和 Client。

**为什么分两个聚合：**
> "Host and Client stay two aggregate programs because both sides declaration-merge the cordis `Context` interface under the same keys with different services; one program seeing both merges reports a collision."

**配置文件层次：**

| 文件 | 角色 | 是否形成 program |
|---|---|---|
| `tsconfig.json` | Solution root：`extends` base, `files: []`, references 两个聚合 | 否 |
| `tsconfig.base.json` | 共享 compilerOptions + 源码级 `paths` map | 否 |
| `tsconfig.base.client.json` | 浏览器 compiler 设置 | 否 |
| `tsconfig.host.json` | Host 聚合 | 是 |
| `tsconfig.client.json` | Client 聚合 | 是 |

**tsconfig.base.json 关键设置：**
```json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noImplicitOverride": true,
    "composite": true,
    "incremental": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true
  }
}
```

**paths map 的关键设计：** paths 解析到 `src` 目录而非构建后的 `lib/`，确保测试和脚本在 clean tree 上从源码工作。

### 10.3 构建流程

完整构建顺序：

```bash
# 1. Host 构建 Emit
tsc -b tsconfig.host.json        # 生成 lib/types 声明和 JS

# 2. Host tsdown 打包
tsdown --env.DSH_BUILD_FACE host # 打包运行时 + 运行 Typert

# 3. Client 构建 Emit
tsc -b tsconfig.client.json

# 4. Client tsdown 打包
tsdown --env.DSH_BUILD_FACE client  # entry: '' 不重复 Host 工作

# 5. Web UI 构建
pnpm --filter @deepseek-ai/dsh-web-frontend run build
```

**tsdown 配置（根级）：**
```typescript
export default defineConfig(({ env }) => {
  const client = isBuildFaceClient(env?.DSH_BUILD_FACE)
  return {
    workspace: ['vendor/*', 'packages/*/*', 'apps/cli'],
    entry: client ? '' : ['lib/types/{index,invariant,startup}.js'],
    outDir: 'lib',
    format: ['esm'],
    platform: 'node',
    target: 'es2024',
    dts: false,           // 声明由 tsc 生成
    clean: false,
    plugins: client ? [] : [typertPlugin({ mode: 'workspace', faces: ['host'] })],
  }
})
```

### 10.4 CLI 入口

```json
// apps/cli/package.json
{
  "name": "@deepseek-ai/dsh",
  "bin": { "dsh": "lib/bin.js" },
  "files": ["lib/*.js", "config"]
}
```

开发模式：
```json
"dsh": "node --import tsx/esm apps/cli/src/bin.ts"
```

CLI 模式分发：
```typescript
switch (invocation.mode) {
  case 'profile':    // 主运行时路径
  case 'plugin':     // 插件模式
  case 'dump-config': // 配置导出
}
```

### 10.5 关键命令汇总

| 命令 | 用途 |
|---|---|
| `pnpm install` | 安装依赖 + 配置 Lefthook |
| `pnpm run build` | 完整构建（Host + Client + Web） |
| `pnpm run typecheck` | 类型检查 |
| `pnpm run lint` | Oxlint 检查 |
| `pnpm run test` | Vitest 单元测试 |
| `pnpm run test:coverage` | 100% 覆盖率门禁 |
| `pnpm run test:e2e` | 真实 API 测试 |
| `pnpm run test:snapshot` | 无密钥快照回放 |
| `pnpm run hygiene` | knip + publint + 约束检查 |
| `pnpm run doc-sync` | 文档同步门禁 |
| `pnpm run check:all` | 完整本地检查 |
| `pnpm run clean` | 清理构建输出 |

---

## 11. 测试体系

### 11.1 测试层次

| 层次 | 命令 | 特点 |
|---|---|---|
| 单元测试 | `pnpm run test` | Vitest，forks pool |
| 覆盖率门禁 | `pnpm run test:coverage` | **每文件 100%** 覆盖率 |
| E2E 测试 | `pnpm run test:e2e` | 真实 API，需 DEEPSEEK_API_KEY |
| 快照测试 | `pnpm run test:snapshot` | 无密钥回放 vs 预期输出 |
| Web 测试 | `pnpm run test:web` | Web UI 测试 |

### 11.2 覆盖率门禁

```typescript
// vitest.config.ts
coverage: {
  provider: 'v8',
  include: ['packages/*/*/src/**/*.{ts,tsx}'],
  thresholds: {
    perFile: true,
    statements: 100,
    branches: 100,
    functions: 100,
    lines: 100,
  },
}
```

**这是 CI 覆盖率门禁**，不是普通 `test`。每个源文件必须达到 100% 覆盖率。

### 11.3 快照测试

三种模式：
- `DSH_SNAPSHOT=replay` — 无密钥默认，回放已记录的 fixture
- `DSH_SNAPSHOT=record` — 调用真实 API，更新 fixture
- `DSH_SNAPSHOT=refresh` — 回放脚本，更新当前预期输出

### 11.4 E2E 测试

```typescript
// vitest.e2e.config.ts
testTimeout: 120_000
hookTimeout: 30_000
retry: 2
maxWorkers: 4
```

每个 suite 在缺少 provider credential 时自动跳过，确保无密钥 CI 保持绿色。

### 11.5 测试策略要点

> "Every non-trivial model- or product-user-visible behavior change adds or updates a keyless snapshot through a real runnable example in the same PR."

- 测试描述行为，不描述正确性
- 改变过时的行为时同时改变其测试
- Fixture 必须在 macOS/Linux 上回放
- 修复 fixture，不修复 normalizer

---

## 12. 质量门禁体系

### 12.1 门禁聚合

`scripts/run-gates.ts` 定义了命名门禁聚合：

| 聚合 | 包含 |
|---|---|
| `ci-primary` | static, Typert contracts, typecheck, lint, duplication, coverage, snapshots, docs, knip, build, publint |
| `check-all` | 完整本地检查 |
| `doc-sync` | cordis catalog, export JSDoc, tool catalog, config catalog, markdown checks |
| `ci-coverage` | 插桩覆盖率 + exempt-heavy suite |
| `ci-snapshot` | build + snapshot |
| `ci-artifacts` | build, publint, NodeNext, built package invariants, built-bin smoke |

门禁调度器特性：
- 验证门禁 ID 和依赖
- 检查依赖环
- 并发运行（配置 worker 数量）
- 依赖失败时跳过下游
- 报告 pass/fail/skipped + 耗时

### 12.2 Lint 配置

使用 **Oxlint**（非 ESLint）：

```json
// .oxlintrc.json
{
  "options": {
    "reportUnusedDisableDirectives": "warn",
    "typeAware": true
  },
  "rules": {
    "no-var": "error",
    "prefer-const": "error",
    "typescript/await-thenable": "error",
    "typescript/no-floating-promises": "error",
    "typescript/no-misused-promises": "error"
  }
}
```

### 12.3 代码重复检测

```json
"duplication": "jscpd --config .jscpd.json packages scripts"
```

### 12.4 文档同步

`doc-sync` 聚合包含：
- cordis catalog 生成/验证
- export JSDoc 验证
- tool catalog 生成/验证
- config catalog 生成/验证
- persistence catalog
- markdown 检查
- 文档站点检查
- 包 README 检查

### 12.5 Hygiene 检查

`hygiene` 聚合包含：
- vendor rescope 检查
- knip（未使用导出检测）
- publint（发布 lint）
- workspace 约束
- 许可证检查
- 包不变量
- 构建不变量
- cordis config 验证
- NodeNext 类型检查
- 运行时闭包
- vendored 链接

---

## 13. Python SDK

Python SDK 位于 `python/` 目录，包含两个包：

### 13.1 deepseek-harness-sdk

```toml
[project]
name = "deepseek-harness-sdk"
requires-python = ">=3.10"
dependencies = [
  "pydantic>=2.12,<3",
  "deepseek-harness-runtime-bin==0.0.0.dev0",
]
```

源码结构：
```
python/sdk/src/deepseek_harness/
├── __init__.py    # 导出 DeepSeekHarness, RunResult, Session 等
├── api.py         # 高层 API
├── client.py      # 底层客户端
├── errors.py      # 错误类型
└── models.py      # 数据模型
```

### 13.2 deepseek-harness-runtime-bin

打包注入的可执行文件和默认运行时配置：

```toml
[tool.hatch.build]
artifacts = ["src/deepseek_harness_runtime/runtime/dsh-jsonrpc-agent-*"]
exclude = ["src/deepseek_harness_runtime/runtime/node"]
```

Python SDK 通过 JSON-RPC 协议与 Node.js 运行时通信。

---

## 14. 自建 Harness 的架构建议

基于对 DeepSeek Harness 的深度分析，以下是自建 Agent Harness 的架构建议：

### 14.1 核心架构选择

| 决策 | 建议 | 理由 |
|---|---|---|
| 插件框架 | 使用 Cordis 或类似 DI 框架 | 避免手写插件生命周期管理 |
| 模块系统 | ESM only | 现代化，避免 CJS 兼容性问题 |
| 语言 | TypeScript strict | 类型安全是大型项目的基石 |
| 包管理 | pnpm workspace | 高效的 monorepo 管理 |
| 构建 | tsc + tsdown | 类型检查 + 运行时打包分离 |

### 14.2 最小可行架构

自建 Harness 至少需要以下核心组件：

```
你的-harness/
├── core/
│   ├── plugin-runtime/     # 插件运行时（Cordis 或自建）
│   ├── session/            # 会话事件日志
│   ├── agent/              # Agent 接口与注册表
│   ├── agent-loop/         # Agent 驱动循环
│   ├── tools/              # 工具注册表与执行管道
│   └── system-prompt/      # 系统提示词组装
├── llm/
│   ├── llm/                # LLM 能力缝（Service Definition）
│   └── llm-provider/       # 具体模型适配器
├── capabilities/
│   ├── shell/              # Shell 执行能力
│   ├── fs/                 # 文件系统能力
│   └── web/                # Web 搜索/抓取能力
├── boot/                   # 启动引导
├── bundle/                 # Bundle 组合
└── apps/
    ├── cli/                # CLI 入口
    └── web/                # Web UI（可选）
```

### 14.3 关键设计原则

1. **一切皆插件** — 没有特权核心，所有功能通过插件组合
2. **能力缝三角色** — 每个能力都有 Service Definition / Provider / Consumer
3. **模型可见即记录** — 所有到达模型的内容都记入会话日志
4. **注册即 Effect** — 所有注册可逆，插件卸载时自动清理
5. **显式优于隐式** — 包边界处不使用隐藏默认值
6. **误导配置立即失败** — 不静默跳过缺失的引用

### 14.4 最小实现步骤

**第一步：搭建插件运行时**
- 集成 Cordis 或实现自己的 Context/Fiber/Registry
- 实现 `ctx.plugin()`, `ctx.provide()`, `ctx.inject()`, `ctx.effect()`
- 实现事件系统（emit + waterfall）

**第二步：实现核心包**
- `session` — 追加式事件日志，`SessionStore`，`deriveMessages()`
- `system-prompt` — 有序 sections、变量插值、工具 schema 投射
- `tools` — `defineTool()`，`ToolRuntime`，执行管道（pre-execute → execute → post-execute）
- `agent` — `Agent` 接口，`AgentRegistry`，生命周期事件
- `agent-loop` — Turn/Step 循环，模型请求 → 工具调用 → 结果反馈

**第三步：实现 LLM 能力缝**
- `llm` — Service Definition（Message, GenerateOptions, ToolSchema 类型）
- `llm-provider` — 具体模型适配器（OpenAI / DeepSeek / Anthropic 等）

**第四步：实现基础能力**
- `shell` — 命令执行（先做 local provider）
- `fs` — 文件读写（先做 local provider）
- 对应的 tool consumer（`tool-bash`, `tool-fs`）

**第五步：实现启动与组合**
- `boot` — Profile 解析、Bundle 组合、Cordis context 启动
- `bundle/base` — 基础服务注入
- `apps/cli` — CLI 入口

**第六步：实现持久化**
- 会话持久化（JSONL 或 SQLite）
- 会话恢复

**第七步：扩展能力**
- 子代理能力
- Web 搜索能力
- 沙箱/安全策略
- 审批/交互能力

### 14.5 TypeScript 配置建议

```json
// tsconfig.base.json
{
  "compilerOptions": {
    "target": "es2024",
    "module": "esnext",
    "moduleResolution": "bundler",
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "composite": true,
    "incremental": true,
    "declaration": true,
    "sourceMap": true,
    "allowImportingTsExtensions": true,
    "rewriteRelativeImportExtensions": true
  }
}
```

### 14.6 包命名约定

```
@your-org/your-harness         # CLI 包
@your-org/yh-core              # 核心包
@your-org/yh-llm               # LLM Service Definition
@your-org/yh-llm-openai        # LLM Provider
@your-org/yh-shell             # Shell Service Definition
@your-org/yh-shell-local       # Shell Provider
@your-org/yh-tool-bash         # Shell Consumer (Tool)
```

### 14.7 测试策略建议

1. **单元测试** — 每个包独立测试
2. **快照测试** — 通过可运行示例记录模型交互预期输出
3. **E2E 测试** — 真实 API 测试，缺密钥自动跳过
4. **覆盖率** — 从一开始就设高门禁（80%+，逐步提升到 100%）
5. **集成测试** — 多插件组合的真实场景测试

### 14.8 值得借鉴的模式

| 模式 | 来源 | 价值 |
|---|---|---|
| 能力缝三角色 | dsh | provider 可替换性 |
| 模型可见即记录 | dsh | 可回放、可分叉 |
| Waterfall 事件 | Cordis | 中间件链式处理 |
| Profile/Bundle 组合 | dsh | 灵活的部署配置 |
| 双聚合 TypeScript | dsh | 避免 Context 声明合并冲突 |
| 源码级 paths facade | dsh | 测试从源码工作，不依赖构建 |
| tsc-first + tsdown | dsh | 类型检查与打包分离 |
| 无密钥快照测试 | dsh | CI 不需要 API key |

### 14.9 需要注意的陷阱

1. **不要在 `run()` 内部隐藏默认值** — 默认值应该是显式的 `resolve(request): Spec` 步骤
2. **不要硬编码可调参数** — 部署可变的选择应该是验证过的 `Config` 字段
3. **空 catch 必须说明** — 命名吞掉了什么以及为什么没有其他东西能到达
4. **异步状态不是同步状态** — 不要把 `agent/status` 或 `whenIdle()` 当作一次 follow-up 的结果
5. **Dispose 必须达到静止** — 返回前确保工作已停止，不只是请求停止
6. **不要给不可信输出环境变量** — 生成的命令使用清洗过的 env

---

## 附录 A：防御性模式清单

来自 `docs/defensive-patterns.md`：

1. **独立报告正交结果** — 每个独立事实（`timedOut`, `signal`, `exitCode`）独立呈现
2. **双侧遵守公共合约** — 返回前规范化
3. **异步状态不是同步状态** — 自动化调用者必须显式定义间隔
4. **Dispose 必须达到静止** — 先关闭监听器/注册表，再 kill
5. **在 dispatcher 中包含回调异常** — try/catch 包裹 dispatch 循环
6. **不给不可信输出环境变量** — 清洗 env，私有临时目录
7. **unlink 链接形路径** — 用 `lstatSync().isSymbolicLink()` + `unlinkSync`，不用递归 `rmSync`

## 附录 B：事件分发速查

| 模式 | await | 顺序 | 返回值 | next()? | 用途 |
|---|---|---|---|---|---|
| `emit` | 否 | 注册序 | 无 | 无 | 通知观察者 |
| `waterfall` | 否 | 注册序 | 是 | 必须 | 中间件链 |
| `parallel` | 是 | 并行 | 无 | 无 | 扇出 |
| `serial` | 是 | 注册序 | 是 | 无 | 有序串行 |

## 附录 C：关键文件索引

| 文件 | 用途 |
|---|---|
| `AGENTS.md` | 项目级架构约定与规则 |
| `docs/architecture.md` | 主架构文档 |
| `docs/cordis-primer.md` | Cordis 框架入门 |
| `docs/glossary.md` | 术语表 |
| `docs/development.md` | 开发布局与 TypeScript 配置 |
| `docs/defensive-patterns.md` | 防御性模式 |
| `docs/testing.md` | 测试策略 |
| `docs/capability-seams.md` | 能力缝目录 |
| `packages/README.md` | 包分组概览 |
| `packages/AGENTS.md` | 包级规则 |
| `vendor/cordis/` | Cordis 框架源码 |
| `scripts/run-gates.ts` | 质量门禁调度器 |

---

*本报告基于 DeepSeek Harness 源码仓库（版本 0.1.0-rc.5）的深度分析生成。*
