# AI Harness

图形化 AI 智能体工作台（类 Trae 桌面工具）：自定义智能体、MCP 工具管理、可视化工作流、工作区读写、外部 HTTP API。基于 Electron + React，可打包为 `.exe`。

## 功能特性

- **自定义智能体**：每个智能体是一个代码文件（`.agent.js` / `.agent.py`），改源码即可客制化，界面点「重载」热生效
- **工具管理（原 MCP）**：`.mcp.js` / `.mcp.py` 工具包，智能体通过 `mcp:工具名` 引用；内置 Python 科学计算器（sympy）
- **可视化工作流**：Simulink 式拖拽连线（输入 → 智能体 → 输出），拓扑排序执行，支持通信总线
- **通信总线**：文本用 `[[区域名]]...[[/区域名]]` 标记分区，智能体节点可配置可读/可写区域，按权限过滤下传
- **工作区**：智能体可读写工作区文件（`list_dir` / `read_file` / `write_file`）
- **工作流 = 大型 Agent**：智能体 `tools` 加入 `run_workflow` 后可在对话中直接调用工作流；工作区面板也有「运行工作流」运行器
- **外部 HTTP API**：SSE 流式对话，供 Trae 等外部工具调用（默认端口 37800）
- **嵌入式 Python**：解释器随应用打包（`resources/python-runtime`），用户无需安装 Python

## 技术栈

- Electron 33 + Vite 5 + React 18（主进程加载 Agent/MCP 代码模块）
- Python 3.12.8 嵌入式运行时 + pip + sympy（常驻子进程 + NDJSON 协议）
- electron-builder 打包（nsis 安装版 + portable 便携版）

## 环境要求

- Node.js 18+（本机使用 npm）
- 无需系统 Python —— 项目内置嵌入式 Python（`runtime/python/`），开发时使用，打包后随应用分发

## 新环境快速搭建

在全新机器上把项目跑起来的步骤：

```powershell
# 1. 安装 Node 依赖
npm install
# 若 npm postinstall 被安全软件/沙箱阻止（electron 二进制未下载），手动执行：
node node_modules/electron/install.js

# 2. 准备嵌入式 Python 运行时（生成 runtime/python/，含 python.exe + pip + sympy）
powershell -ExecutionPolicy Bypass -File scripts\setup-python-runtime.ps1

# 3. 构建前端
npm run build

# 4. 启动应用
npm run start
```

> 说明：`runtime/` 是生成产物（已被 .gitignore 忽略），换环境后运行第 2 步脚本即可重建；`node_modules/` 用第 1 步重建。

## 常用命令

| 命令 | 作用 |
| --- | --- |
| `npm run dev` | 开发模式（Vite HMR，端口 5173；连接失败自动回退 dist） |
| `npm run build` | 构建前端到 `dist/` |
| `npm run start` | 以生产模式启动 Electron |
| `npm run start:prod` | `build` + `start` |
| `npm run dist` | 完整打包（vite build + electron-builder，输出到 `release/`） |
| `npm run icon` | 重新生成应用图标（`scripts/gen-icon.js`） |
| `npx electron . --screenshot` | 启动后自动截图保存到项目根 `screenshot.png` 并退出（调试用） |

## 打包说明

```powershell
npm run dist
```

- 输出目录：`release/`
- 若 `release/` 被系统锁定（如 app.asar 句柄未释放导致覆盖失败），改用临时目录：
  ```powershell
  npx electron-builder --win --config.directories.output=release_new
  ```
- 打包内容（`extraResources`）：`builtin-agents`、`builtin-mcps`、`python-runtime`
- 产物：`AI Harness Setup 0.1.0.exe`（安装版）、`AI Harness 0.1.0.exe`（便携版）、`win-unpacked/`（免安装目录）

## 目录结构

```
Harness/
├── electron/                # 主进程代码
│   ├── main.js              # 入口：窗口、IPC、生命周期
│   ├── agents.js            # 智能体加载器（.agent.js / .agent.py）
│   ├── mcp.js               # MCP 加载器（JS + Python 双引擎）
│   ├── python-engine.js     # Python 常驻子进程（NDJSON 协议）
│   ├── workflow.js          # 工作流存储 + 拓扑执行 + 通信总线过滤
│   ├── chat.js              # 对话编排（消息组装 → 流式 → 工具循环）
│   ├── llm.js               # OpenAI 兼容客户端 + 工具 schema
│   ├── tools.js             # 工具执行器（内置 + run_workflow + MCP）
│   ├── workspace.js         # 工作区文件工具
│   ├── api-server.js        # 外部 HTTP API（SSE）
│   ├── store.js             # 设置/会话持久化
│   ├── preload.js           # 渲染进程桥（window.harness）
│   ├── agents/              # 内置智能体（.agent.js / .agent.py）
│   └── mcps/                # 内置 MCP 工具包（.mcp.js / .mcp.py）
├── src/                     # 渲染进程（React）
│   ├── App.jsx              # 主界面 / 视图切换 / 代码编辑器
│   ├── components/          # Chat / Agent / MCP / Workflow / Workspace / Settings
│   └── styles.css
├── scripts/
│   ├── setup-python-runtime.ps1   # 下载并配置嵌入式 Python
│   └── gen-icon.js
├── runtime/python/          # 嵌入式 Python（生成产物，不提交）
├── release/ 或 release_new/ # 打包产物（不提交）
└── package.json
```

## 扩展机制

### 1. 自定义智能体

界面「智能体」→「＋ 新建 (JS/Python)」或手写文件到用户目录 `%APPDATA%\AI Harness\agents`（内置模板会在此复制）。

**`.agent.js`**（主进程 require + 缓存清除热重载）：

```js
module.exports = {
  id: 'my_agent',
  name: '我的智能体',
  description: '……',
  avatar: '✨',
  model: null,               // 留空用全局默认模型
  temperature: 0.7,
  maxTokens: 4096,
  // 内置工具：list_dir / read_file / write_file；MCP：'mcp:工具名'；工作流：'run_workflow'
  tools: ['list_dir', 'read_file', 'write_file', 'mcp:py_eval'],
  systemPrompt: (ctx) => {
    // ctx: { workspaceName, workspaceRoot }
    return '你是……'
  }
}
```

**`.agent.py`**（通过 Python 引擎加载，支持动态提示词）：

```python
AGENT_ID = "my_py_agent"
AGENT_NAME = "我的 Python 智能体"
AGENT_DESC = "……"
AGENT_AVATAR = "🐍"
AGENT_MODEL = None
AGENT_TEMPERATURE = 0.7
AGENT_MAX_TOKENS = 4096
AGENT_TOOLS = ['list_dir', 'read_file', 'write_file', 'mcp:py_eval']

# SYSTEM_PROMPT = "固定字符串" 或动态函数：
def system_prompt(ctx):
    return "你是……" + str(ctx.get("workspaceName"))
```

### 2. 自定义 MCP 工具包

界面「MCP」→「＋ 新建」，或手写 `.mcp.js` / `.mcp.py` 到 `%APPDATA%\AI Harness\mcps`。

**`.mcp.js`**：`module.exports = { id, name, description, tools: [{ name, description, parameters, handler }] }`

**`.mcp.py`**：

```python
MCP_ID = "my_pkg"
MCP_NAME = "我的工具包"
TOOLS = [{
    "name": "my_tool",
    "description": "……",
    "parameters": {"type": "object", "properties": {...}, "required": [...]},
    "handler": "my_tool"
}]

def my_tool(args):
    return "结果"
```

保存后在界面点「重载」生效。Python 工具可 `import sympy` 等已随运行时打包的库；如需更多库，先激活运行时 pip：`runtime\python\python.exe -m pip install <包名>`。

## 工作流与通信总线

- 节点类型：`输入`（⌨️，可写初始内容并标记区域）、`智能体`（🤖，选 agent + 附加指令 + 读写区域）、`输出`（📤，汇总显示）
- 连线：从节点右侧输出端口拖到下一节点左侧输入端口；**左键单击**连线选中（高亮），**右键**弹出菜单（删除连线 / 断开节点全部连线 / 属性待开发）
- 执行：Kahn 拓扑排序，从左到右依次执行；输入节点文本作为起点，智能体节点调 LLM（可带工具），输出节点合并上游
- **通信总线**：文本用 `[[区域名]] 内容 [[/区域名]]` 标记分区
  - 节点「可读区域」（readZones）：只把普通文本 + 被授权区域传给该智能体，其余区域剥离
  - 节点「可写区域」（writeZones）：智能体输出中不属于该区域的标记会被剥离；留空 = 不限制
  - 区域片段以原始标记继续下传，供后续节点按权限读取

## 配置与外部 API

- **LLM 设置**：界面「设置」填 API Base URL / Key / 默认模型（默认 `https://api.deepseek.com/v1` / `deepseek-chat`）
- **外部 API**（设置中可开关，默认开，端口 37800，可选 Bearer Token）：
  - `GET /api/health`、`GET /api/agents`、`GET /api/sessions`、`POST /api/sessions`、`DELETE /api/sessions`
  - `POST /api/chat`：SSE 流式对话，body 含 `agentId / message / sessionId`
- **用户数据目录**：`%APPDATA%\AI Harness\`（agents / mcps / workflows / sessions / settings.json），首次启动会把内置模板复制到这里，可直接编辑

## 常见问题

| 问题 | 解决 |
| --- | --- |
| 打包报 `app.asar ... used by another process` | 结束残留的 `AI Harness.exe` / `electron` 进程；若仍锁（Defender/句柄），用 `--config.directories.output=release_new` 换输出目录 |
| 启动提示 Python 不可用 | 运行 `scripts\setup-python-runtime.ps1` 重建 `runtime/python/`，或在环境变量 `AIH_PYTHON` 指定解释器 |
| `npm install` 后 electron 无法启动 | 手动执行 `node node_modules/electron/install.js`（postinstall 可能被安全软件拦截） |
| 多个实例互相抢锁 | 应用有单例锁，重复启动会聚焦已有窗口；被异常残留占用时结束进程 |
| 端口 37800 被占用 | 界面设置里改 API 端口后重启应用 |
| 改代码不生效 | Agent/MCP 保存后点「重载」；主进程代码改动需重启应用 |

## 版本

当前版本 0.1.0（Windows x64）。开发用 `npm run dev`，交付用 `npm run dist` 打包。
