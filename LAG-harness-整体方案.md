# LAG harness 整体方案（v0.2）

> 依据：`开发文档.txt`、`记忆管理-开发文档.txt`、`MCP.txt`、`学习与适应.txt`、`半图形化智能体架构设计方案.md`
> 状态：**持续实施中**。本文同时记录「已落地能力」与「规划中路线」，评审/排期以此为基线。

---

## 一、产品定位

**LAG harness = 大型 Agent 生成器（Large Agent Generator）**

把可视化工作流"编译"成一个**自包含的大型 Agent（LA）包**，可导出为本地运行程序（最终形态：exe，双击即用、自带极简交互界面），供非程序员"动动鼠标"接入其它软件 / 网页 / Agent 生态。

核心链路：

```
工作区/会话 配置(工作流/智能体) → 聊天窗口输入需求 → 智能体/工作流执行 → 导出为 LA 包(exe)
```

**已实施的两条主线**：
1. **画布工作流（半图形化）**：通信总线 + 技能/记忆/工具/控制流节点 + 边连接（数据/消息/广播/回调），代码为主、图形双向回读；
2. **记忆管理与场景落地**：记忆卡片（架构=文件空间）+ SQLite 经验库 + 目录路由 + 滑动窗口压缩，并落地「电机 PID 调参」真实场景（串口协议 + 技能 + 三层记忆 + when-to-use 接口描述）。

---

## 二、目标流程

| # | 需求 | 现状 | 差距 |
|---|------|------|------|
| 1 | 工作流可导出为 **.exe 本地程序**，自带极简交互界面 | ✅ 已实现导出 Python 包（`manifest.json` + executor + transports + web 控制台 + 内嵌 runtime + `start.bat`），跑通链路 | ⚠️ 目前是"Python 包 + 启动脚本"，不是单个 exe；需增加 exe 包装（PyInstaller 一键打包或 NSIS 封装） |
| 2 | **工作区可对话**：工作区→配置工作流/智能体→聊天窗口输入需求→进入执行 | ✅ 已实现（工作区底部对话栏：选智能体/工作流 → 发消息 → 流式回复） | — |
| 3 | 接入 LLM 需用户提供 API key；harness 内可同步已保存 key；**导出后必须手动输入** | ✅ 全局设置保存 baseUrl/key；导出物 manifest 用 `env:` 占位符 | 补充：导出物首个对话前弹 API key 配置页，并持久化到本地（M2-⑤） |
| 4 | **会话可自由选择智能体 / 工作流（大型智能体）**，配置可保存 | ✅ 会话级目标选择（智能体/工作流）已实现，保存到会话元数据；会话支持一键新建 | — |
| 5 | **导出必须附带记忆空间** | ✅ 记忆架构可导出（memory/ 目录随 LA 包烘焙） | — |
| 6 | 会话展示**可展开的思考痕迹** | ✅ 已实现（assistant 消息带 trace，`<details>` 折叠展示工具/节点明细） | — |
| 7 | **模型选择要正常**（如 deepseek v4 pro/flash） | ✅ 全局默认模型 + 会话/智能体级覆盖；预置 `deepseek-v4-pro` / `deepseek-v4-flash` | — |
| 8 | **画布工作流可视化编排多智能体** | ✅ P1-P3 已实施（详见第五节）：通信总线、技能/记忆/工具/控制流节点、4 种连线、回调回环、图↔代码互转、模板库、自定义模块 | — |
| 9 | **半图形化：代码为主、图形为辅，双向回读** | ✅ 节点卡片图形属性 + 代码（元注释回读）；内联 Python 工具 | — |
| 10 | **记忆管理完整落地** | ✅ 记忆卡片（policy/facts/episodes/skills/ledger）+ SQLite 经验库 + 目录路由 + 滑动窗口去重（详见第四节） | — |
| 11 | **外部 AI 可调用 harness 能力（MCP Server）** | ✅ 内置 MCP Server（SSE，37800 端口），暴露 9 个工具（含 run_agent/call_mcp_tool/memory_*） | — |

---

## 三、架构分层（大分层：会话 / 工作区）

> 分层原则（用户定调）：顶层只分 **会话** 与 **工作区** 两大块；除聊天窗口外，功能模块分类为 **智能体 / 工具 / MCP / 工作流（画布，半图形化）/ 记忆管理 / MCP 设计**；智能体学习不纳入本架构。

```
┌──────────────────────────────────────────────────┐
│ LAG harness（大型 Agent 生成器）                        │
│  ┌────────────┐        ┌───────────────────────┐   │
│  │  会话        │        │ 工作区                 │   │
│  │  ─ 聊天窗口   │        │  ├ 智能体              │   │
│  │  ─ 思考痕迹   │        │  ├ 工具（内置工作区工具） │   │
│  │  ─ 模型选择   │        │  ├ MCP（工具包管理）     │   │
│  │  ─ 目标选择   │        │  ├ 工作流（画布，半图形化）│   │
│  │    (智能体/LA)│        │  ├ 记忆管理（记忆卡片）   │   │
│  │  ─ 新建会话   │        │  └ MCP 设计（统一工具接入）│   │
│  └────────────┘        └───────────────────────┘   │
│                                                    │
│  MCP Server（SSE）：把 harness 能力暴露给外部 AI      │
└──────────────────────────────────────────────────┘
          │ 编译期烘焙（导出器 = 编译器）
┌──────────────────────────────────────────────────┐
│ 导出物 LA 包：manifest + executor + transports      │
│   + 内嵌 runtime + web 控制台 + 记忆空间              │
└──────────────────────────────────────────────────┘
```

模块职责（含新增/演进）：

| 模块 | 归属 | 职责 |
|------|------|------|
| 会话 | 大分层一 | 聊天窗口为核心：自由选择目标（智能体 / 工作流 LA）、可展开思考痕迹、模型选择、会话配置保存、一键新建会话 |
| 工作区 | 大分层二 | 任务配置与资源管理区，承载下方全部功能模块 |
| 智能体 | 工作区 | agent 文件（.agent.js/.agent.py）的管理、分类、简介、编辑；画布编排（多技能协作） |
| 工具 | 工作区 | 内置工作区工具（list_dir / read_file / write_file 等）；MCP 工具包（.mcp.js/.mcp.py）；Python/JS 双引擎 |
| MCP | 工作区 | 工具包管理；外部 MCP Server（SSE 暴露 run_agent/call_mcp_tool/memory_* 等 9 工具） |
| 工作流（画布） | 工作区 | **半图形化可视化流水线**：通信总线 + 技能/记忆/工具/子智能体/控制流节点 + 4 种连线 + 图↔代码互转 + 模板库 + 自定义模块；编译导出为 LA 包 |
| 记忆管理 | 工作区 | **记忆卡片**（架构=文件空间，policy/facts/episodes/skills/ledger/bus）+ 技能可放入记忆卡片；场景经验库（SQLite）+ 目录路由 + 滑动窗口压缩 |
| MCP 设计 | 工作区 | 横切设计：所有工具统一"name/description/parameters/handler"契约；**接口描述带 when-to-use（何时用），供 LLM 判断调用时机** |

保持现有边界：生成器=编译器（编译期固化 I/O 契约/智能体/图），运行期薄；LA 黑盒内外分离；多目标输出（当前先只做 Python 目标，未来可加 JS）。

---

## 四、记忆管理（已落地 + 规划）

### 4.1 核心原则（来自笔记）

1. **记忆放 md 文件**，可读可改，绝不做成黑盒（记忆卡片 = 记忆空间目录）。
2. **场景化策略**：不同语境用不同管理模式（电商客服 vs 电机调参，策略可配置/可插拔）。
3. 精确调用与状态覆写：精确查字段；旧数据确认无用后删除或打时间戳。
4. 记忆最小可调用闭包——**系统三件套**：`policy`（控制策略）/ `ledger`（原始账本，只追加）/ `views`（派生视图）。
5. 双时态：区分 `valid time` 与 `transaction time`，检索带时间切片。
6. 从陈述性事实 → 程序性技能：试错修复成功的轨迹去废话化，压缩成一键宏指令。
7. **滑动窗口压缩**：记忆达上限（经验 500 条 / 宏 100 条）自动去重合并同类踩坑，新解法覆盖旧解法。

### 4.2 已落地实现（三层记忆 + 目录路由）

**载体 A：记忆卡片（记忆架构）** — 每个卡片 = `data/memory/<架构名>/` 目录：

```
memory/<架构名>/
├── policy.md     # 场景策略：读写时机/遗忘规则/检索规则（人可编辑）
├── ledger.md     # 原始账本：只追加，留痕溯源
├── facts.md      # 陈述性事实（随时覆写）
├── episodes.md   # 情景记忆（一次性事件，双时态）
├── skills.md     # 程序性技能（宏指令模板）
├── bus.md        # 通信总线（画布记忆节点可用）
└── *.skill.py    # 可选：技能本体放入记忆卡片（技能面板从记忆目录加载）
```

**载体 B：场景经验库（SQLite）** — `data/pid-memory/`（lessons.db + session.json），由 `pid_memory.mcp.py` 工具包读写：

| 层 | 工具 | 内容 |
|---|---|---|
| 短期记忆 | `mem_get_session` / `mem_update_session` | 本次调参目标 + 当前参数 + 最近 12 轮（滑动窗口） |
| 长期经验 | `mem_record_lesson` / `mem_query_lessons` | 成功/失败经验「目的-方案-结果-痛点 + 标签」，SQL 查询 |
| 程序性宏 | `mem_make_recipe` / `mem_apply_recipe` | 成功路径提炼宏（触发条件 + 动作序列），自动命中执行，记复用次数 |
| 目录路由 | `mem_catalog` / `mem_route` | 看经验目录 → 大模型输出路由标签 → **程序直接路由到对应经验组成 prompt** |
| 维护 | `mem_consolidate` | 滑动窗口压缩：同类踩坑去重合并，新解法覆盖旧解法（超限自动 + 手动） |

**接口描述规范**：所有工具 description 带 **when to use（何时用）**，供 LLM 判断调用时机（如 `motor_connect`：调参前必须首先调用；`mem_route`：得到路由标签后、决策前调用）。

### 4.3 规划（未做）

- **M5 MCP 设计深化**：内置工具/工作流/记忆统一走"虚拟 MCP"适配层（外部 SSE 已先行）。
- **双时态完整检索**：md 文件内 `[[valid:…]]` / `[[txn:…]]` 头部按时间切片过滤（部分约定已写入 policy，检索实现待做）。
- **dream 模式**：夜间定时复盘，同主题去重合并（当前为手动 `mem_consolidate`，定时化待做）。

---

## 五、画布与半图形化工作流（P1-P3 已实施）

> 核心理念：**图即架构、码即血肉**。节点卡片=图形属性+代码，代码为主、图形双向回读（元注释回写）。

### 5.1 节点与布局

| 节点 | 说明 |
|---|---|
| 通信总线 | 非常长长方形（默认 480×96），卡片只含连接点（可增删、横向排布、等间隔重排）；技能/记忆节点通过拖线挂接连接点，连线方向"总线圆点 → 节点输入端" |
| 记忆节点 | 非常大的正方形（默认 360×360），连接记忆架构（policy/facts/episodes/skills/ledger/bus） |
| 技能节点 | 搜索技能（下拉弹层走 portal 修复，画布 transform 下正常弹出） |
| 工具节点 | 选择 MCP 工具包或内联 Python（`def run(input_text)`，引擎 spawn 执行） |
| 子智能体节点 | 嵌套画布，递归执行（循环引用检测） |
| 控制流节点 | merge / branch / loop（含 maxLoops） |
| 自定义模块 | `data/custom-nodes.json`，可复用代码模块 |

交互：所有节点可拖动缩放；节点字体随框缩放（`√((w/210)*(h/150))`，上限 3.2 倍）；输入/输出内容框随节点缩放；画布滚轮缩放 30%~250%。

### 5.2 连线类型（多智能体协同）

| 类型 | 语义 |
|---|---|
| data | 数据流：上游输出 → 下游输入（拓扑序执行） |
| message | 消息：节点间任务/对话 |
| broadcast | 广播：一个技能分发到多个下游并行处理（主管-工人） |
| callback | 回调：不参与拓扑，触发上游重跑（评审回环，最多 2 轮） |
| when | 边分支条件（always / length>N / contains 关键词） |

### 5.3 模板库与自定义

- 内置 4 模板：主管-工人 / 评审回环 / RAG 管道 / 流水线（一键生成画布）。
- 自定义模块管理（列表 + 编辑器），画布 `custom` 节点引用。
- 技能工作台：文件树空白处右键新建文件、文件右键切换可读/删除（`.skill-file-perms.json` 记录）。

### 5.4 导出

画布编译为 LA 包（Python 引擎 `engine.py` 与前端调度语义一致：拓扑排序 + 回调回环 + 控制流 + 内联 Python + 自定义模块 + 记忆工具）。

---

## 六、电机 PID 调参场景（真实落地）

```
记忆路由(mem_catalog→mem_route) → motor_connect → motor_command(step_test)
→ motor_read_samples(算指标) → PID 决策(参考注入经验) → motor_set_pid
→ 收敛 → motor_command(stop) → mem_record_lesson / mem_make_recipe → mem_consolidate
```

| 组件 | 说明 |
|---|---|
| `motor_pid.mcp.py` | 串口工具（MCU 经 WiFi 透传），7 个工具 + PID 安全限幅；帧协议：`AA 55 | TYPE | LEN | JSON | 校验 | 0D 0A`，类型含 STATUS/SET_PID/CMD/SAMPLE 等 |
| `pid_memory.mcp.py` | 三层记忆工具（见 4.2） |
| `pid_tuner.skill.py` | **放入记忆卡片 `pid-tuning`**（技能面板从记忆目录加载），系统提示词含状态记忆（角色固定）+ 路由指令 + 记忆规则 + when to use |
| 记忆卡片 pid-tuning | policy/facts/episodes/skills/ledger/bus + pid_tuner.skill.py（整个调参系统收在卡片内） |
| 仿真驱动 | `motor_sim_driver.py`（零第三方依赖），真机骨架 `motor_real_driver.py`（需 pyserial） |

**记忆分工**：记忆卡片=人可读规则（md）；SQLite 经验库=机器查询（mem_query_lessons/mem_route）；策略说明在卡片 policy.md 中注明。

---

## 七、MCP Server（外部 AI 接入，已实施）

程序启动后内置 MCP Server（SSE，默认端口 37800，设置可关/换端口/Token）：

```
类型：HTTP Server (SSE)
URL：http://127.0.0.1:37800/mcp/sse
```

暴露 9 个工具给外部 AI：`get_health` / `list_agents` / `run_agent` / `list_skills` / `run_skill` / `list_mcp_tools` / `call_mcp_tool`（含 motor_* / mem_*）/ `memory_read` / `memory_write`。
即：Trae / Claude Desktop / Cursor 等任何 MCP 客户端可把 harness（含电机硬件链路）当工具调用。

---

## 八、实施路线

| 里程碑 | 内容 | 状态 |
|--------|------|------|
| **M1 体验闭环** | ① 会话选择智能体/工作流且配置可保存；② 工作区对话窗口；③ 可展开思考痕迹；④ 模型选择 | ✅ 已完成 |
| **M2 导出增强** | ⑤ 导出物 API key 首次配置页；⑥ 导出为单个 exe；⑦ 导出物内置记忆空间骨架 | ✅ 已完成（exe 包装为 Python 包+启动脚本，单 exe 待做） |
| **M3 记忆 MVP** | ⑧ `memory_*` 工具 + md 存储 + 三件套 + 场景策略 | ✅ 已实施（记忆卡片 + SQLite 经验库 + 路由 + 滑动窗口） |
| **M4 记忆进阶** | ⑨ dream 模式；⑩ 双时态完整检索；⑪ 程序性技能压缩宏 | 🔶 部分：⑪ 已完成（mem_make_recipe/apply_recipe）；⑨ 手动版已完成（mem_consolidate），定时待做；⑩ 待做 |
| **M5 MCP 设计** | ⑫ 统一"虚拟 MCP"适配层；⑬ 真实 MCP Server 接入 | 🔶 部分：⑬ 已完成（SSE，9 工具）；⑫ 待深化 |
| **P1 多智能体协同** | 通信总线挂接 + 4 种连线 + 回调回环 + 命名统一 | ✅ 已完成 |
| **P2 半图形化** | 控制流节点 + 边分支条件 + 内联 Python + 图↔代码互转 | ✅ 已完成 |
| **P3 自定义化** | 模板库 + 自定义模块 | ✅ 已完成 |
| **N1 模型体系** | 画布节点模型配置（继承上游/自定义 URL+API+模型名）+ 侧栏拆分「工作流/智能体」（智能体=单智能体：模型/提示词/技能）+ 导出配置注入接口（/api/config，导出绝不含密钥） | ✅ 已完成 |
| **N2 工具包命名** | 内部工具包去 MCP 化：`mcp:`→`tool:`、`mcp_`→`tool_`、`.mcp.*`→`.tool.*`、目录 mcps→tool-packs、面板「工具/MCP」→「工具包」；标准 MCP Server（对外）保留原名；读取兼容旧名、启动时一次性迁移旧数据 | ✅ 已完成 |
| **N3 外部 MCP** | Harness 作为 MCP 客户端接入外部 MCP Server（stdio 本地命令 / http Streamable），工具以 `ext_` 前缀并入 LLM 与画布工具节点；工具包面板「🌐 外部 MCP」管理（增删改/连接状态） | ✅ 已完成 |
| **N6 外部 MCP 分类** | 外部 MCP 从写死独立分组改为参与分类文件夹体系（按 category 归类，默认「外部 MCP」分组，可建新分类/移动分类） | ✅ 已完成 |
| **N7 接口创建调参体系** | MCP Server 新增管理类工具（create_category/create_skill/create_agent/save_workflow/list_workflows/list_agent_defs）；通过真实 SSE 接口创建「电流环→速度环→位置环」三技能+三智能体+画布工作流，各栏位建「电机调参」分类文件夹 | ✅ 已完成 |
| **N4 文件重命名** | 技能文件树 / 记忆文件树右键「✏ 重命名」（主组件/受保护文件不可改名，可读性记录迁移，无扩展名补 .md） | ✅ 已完成 |
| **N5 语法高亮** | VS Code Dark+ 风格 hljs token 配色（关键字/字符串/注释/数字/函数等分色）；按扩展名推断语言（py/c/cpp/js/ts/json…）；画布逻辑代码弹窗同享高亮 | ✅ 已完成 |
| **P4-1 工具管道** | 工具执行中间件（pre/post-execute）+ 审计统一落盘 + 工具调用自动入记忆账本 + A2A 工具级访问控制 | ✅ 已完成 |
| **P4-2 模型可见即记录** | LLM 请求审计日志（llm.jsonl，可重建模型所见） | ⬜ 未开始 |
| **P4-3 运行前预检** | checkAgent 预检复用到画布「运行」前（错误阻止+警告提示） | ⬜ 未开始 |
| **P4-4 导出加强** | 固化真实记忆 + 导出包运行日志 + web 控制台升级 + zip 一键分发 | ⬜ 未开始 |
| **P4-5 LLM Provider** | llm.js 抽象 provider（openai-compatible / anthropic / ollama） | ⬜ 未开始 |
| **P4-6 快照测试** | keyless 快照回归（scripts/check.mjs 一键门禁） | ⬜ 未开始 |
| **P4-7 工具呈现** | 工具结果渲染类型（text/diff/table/json） | ⬜ 未开始 |
| **PID 场景** | 串口协议 + 电机工具 + 三层记忆 + 技能入记忆卡片 + when-to-use 接口描述 | ✅ 已完成（仿真闭环可跑，真机需 pyserial + 改 MODE） |
| **W1 工作区基础** | ⑭ 内嵌编辑器 ✅；⑮ 全局搜索；⑯ `.harnessignore`；⑰ 面包屑/双击打开 | 🔶 部分：⑭ 已完成 |
| **W2 工作区编辑器** | ⑱ 多标签页；⑲ Diff 视图；⑳ 图片/Markdown 预览；㉑ 文件复制/粘贴/移动 | ⬜ 未开始 |
| **W3 智能协作** | ㉒ Git 集成；㉓ 代码索引；㉔ 项目级规则/记忆；㉕ Remote SSH | ⬜ 未开始 |
| **T1 团队基础** | ㉖ 账号/项目邀请；㉗ Git 工作台；㉘ AI 提交信息 | ⬜ 未开始 |
| **T2 资产共享** | ㉙ 资产导出导入包；㉚ 云端资产库 | ⬜ 未开始 |
| **T3 实时协同** | ㉛ 在线共享会话；㉜ 文件实时同步（CRDT/OT）；㉝ 任务分派 | ⬜ 未开始 |

> 智能体学习不在路线内（用户定调：属后续智能体设计内容，保留笔记备查，不排期）。
> W 系列 / T 系列详见「十、工作区完善清单」与「十一、团队开发方案」。

---

## 九、待评审决策点

1. 导出 exe 方式：PyInstaller 把 Python 包打成单 exe（体积大、解包慢） vs 保持"目录 + start.bat"再包 NSIS（轻快）——倾向后者。
2. 记忆检索索引：sqlite FTS5 vs 纯文件扫描 vs 引入向量库——倾向 sqlite FTS5（轻量、可审计）。
3. 记忆策略是否与"智能体分类"绑定（分类 = 策略分组）——倾向绑定，复用现有分类体系。
4. dream 模式先手动触发，还是直接定时（需常驻进程）——倾向先手动 + 会话内触发。
5. 记忆工具（pid_memory 的 SQLite 经验库）是否并入 harness 记忆节点（reads/writes 作用域）——PID 场景先行，通用化待定。
6. 外部 MCP Server 是否默认开启（暴露硬件工具风险）——默认本机监听 + 可选 Token。

---

## 十、工作区完善清单（参照 TraeWork，P0→P1→P2 全做）

> 参照对象：TraeWork 的 Work 模式 / TraeCode 的 Code 模式工作环境能力。

**现状盘点**：已有 打开/切换文件夹（重启自动恢复）、文件树（新建/重命名/删除/文件夹）、内嵌编辑器（语法高亮/保存/Ctrl+S/脏标记）、外部编辑器打开、底部工作区对话栏、AI 读写工具（list_dir/read_file/write_file）。

### P0 · 基础补全（W1）

| # | 功能 | 技术要点 |
|---|------|---------|
| 1 | **工作区内直接编辑** | 只读预览改为内嵌编辑器（✅ 已完成），复用 CodeEditor |
| 2 | **全局搜索** | 主进程加 `workspace:search(query, mode)`，文件名+内容扫描（200KB 上限），尊重忽略规则 |
| 3 | **忽略文件** | `.harnessignore`（类 .gitignore 简化版）；约束文件树显示与 AI 工具读写范围 |
| 4 | **面包屑 / 双击打开** | 树顶当前路径点击跳转；双击进编辑器 |

### P1 · 编辑器与浏览增强（W2）

| # | 功能 | 技术要点 |
|---|------|---------|
| 5 | **多标签页** | 顶部标签栏、脏状态圆点、关闭确认、Ctrl+Tab |
| 6 | **Diff 视图** | 文件与暂存/历史版本对比，行级增删高亮 |
| 7 | **图片 / Markdown 预览** | 图片 file:// 渲染，.md 用现有 Markdown 组件 |
| 8 | **复制 / 粘贴 / 移动** | 文件树右键补齐：复制路径、剪切、粘贴、移动到、多选批量 |

### P2 · 智能与协作（W3）

| # | 功能 | 技术要点 |
|---|------|---------|
| 9 | **Git 集成** | 初始化/clone；status/diff/stage/commit/push/pull；冲突可视化；AI 一键提交信息 |
| 10 | **工作区代码索引** | 增量扫描倒排索引（文件名+标识符+摘要），#Code 语义引用 |
| 11 | **项目级规则 / 记忆** | 工作区 `RULES.md` 注入 AI 上下文；项目记忆接入现有记忆方案 |
| 12 | **Remote SSH 远程开发** | 连接远程主机，轻量服务端，本地界面操作远程文件 |

---

## 十一、团队开发方案（联网）

> 用户决策：先写方案文档再动工；落地模式倾向 Git 底座起步 + 资产共享并行 + 实时协同进阶。

### 11.1 目标

多成员共享同一工作区 / 智能体 / 工作流，在线协作开发；AI 会话与产物跨设备、跨成员同步；API Key 等敏感配置永不共享。

### 11.2 架构（三阶段递进）

```
阶段一（T1）Git 底座           阶段二（T2）资产共享         阶段三（T3）实时协同
┌──────────────┐    ┌────────────────────┐    ┌──────────────────────┐
│ 工作区 = Git 仓库 │    │ 智能体/工作流/MCP      │    │ 在线共享会话（多人同看   │
│ 内置 Git 工作台   │    │ 导出为 JSON 资产包       │    │ AI 流/光标/文件同步     │
│ (clone/status/ │    │ 云端资产库，成员一键导入  │    │ CRDT/OT 实时同步       │
│ diff/commit/  │    └────────────────────┘    └──────────────────────┘
│ push/pull)    │
└──────────────┘
```

### 11.3 分阶段内容

**T1 · 团队基础（Git 底座）**：账号/项目邀请（GitHub/Gitee/自建 Git）；内置 Git 工作台；AI 一键提交信息；前置 W3。

**T2 · 资产共享（与 T1 并行）**：智能体/工作流/MCP 统一导出为 JSON 资产包（不含 API Key）；云端资产库上传/搜索/一键导入；复用 LAG 导出器序列化契约。

**T3 · 实时协同（进阶）**：自建轻量服务（Node+WebSocket）文件 CRDT/OT 同步、在线状态与光标；在线共享会话；任务分派；需服务器部署、鉴权、存储审计。

### 11.4 安全底线

1. **API Key 永不进仓库 / 资产包 / 云端**——只存本地 `data/settings.json`（`data/` 已入 `.gitignore`，上传 GitHub 前做三重扫描：settings.json / 测试脚本 key / 占位符）；
2. 成员鉴权：Git 用远端凭证；资产库与实时服务用令牌；
3. 操作审计：Git 历史即审计；
4. `.harnessignore` 与 `.gitignore` 双保险：敏感目录（data、密钥）默认忽略。

### 11.5 依赖与衔接

- W3（Git 集成/代码索引）是 T1 前置；T2 依赖 LAG 导出器序列化契约；
- 记忆（第四节）作为项目级能力随工作区共享；
- 实时协同（T3）工作量最大，放最后。

---

## 十二、P4 深化规划（借鉴 DeepSeek Harness）

> 依据：`DeepSeek-Harness-架构研究报告.md`（2026-08-25 版）。只借鉴**能直接落到现有代码**的模式；完整插件框架 / 覆盖率门禁 / Profile yaml / JSON-RPC SDK / 双聚合 TS 明确不照搬（见 12.8）。
> 决策记录：P4-4 原方案「JSON 场景包」经评审改为**只加强 Python 导出**（部署走现有「导出为 Agent」Python 包，T2 资产共享已覆盖 JSON 资产包，不再做 JSON 场景包）。

### 12.1 P4-1 工具执行管道（中间件链）— 高价值 · 低中成本

**借鉴**：DS 工具走 `tools/pre-execute → tools/execute → tools/post-execute` 三段 waterfall，可拦截/包装/富化。

**现状**：`electron/tools.js` 的 `execTool` 是直接 switch 分发，无任何钩子。

**做法**：
- `execTool` 加注册式中间件：`tools.hook('pre-execute', fn)` / `tools.hook('post-execute', fn)`（注册即 Effect，返回注销函数）；
- 三个内置消费者已落地：**审计**（main.js 启动时 `tools.installAudit()`，所有工具调用写 `data/audit/tools.jsonl`，含 sessionId/agentId/nodeId/skillId/耗时）；**记忆**（节点绑定记忆架构时，工具调用自动记入该记忆空间 ledger 账本溯源，跳过自记账本的 memory_* 工具）；**A2A**（协议新增 `allowedTools`/`deniedTools`，pre-execute 拒绝，节点卡片 A2A 编辑器可配）。
- 管道路径：`chat.js → llm.execTool → tools.execTool`（LLM 驱动的工具调用唯一入口；MCP Server 直调能力属设计内，不走管道）。

**收益**：权限控制、审计、调用记录全部收口到一条管道；后续"调用前询问确认"类交互也在管道上加。

### 12.2 P4-2 模型可见即记录 — 高价值 · 低成本

**借鉴**："到达模型的任何内容都必须能从会话日志重建"（Model-visible ⟺ logged）。

**做法**：`chat.js` 的 `runChat` 每次 LLM 请求写一条 `data/audit/llm.jsonl`：会话 id、节点/技能 id、**resolve 后的模型配置（含继承链路）**、messages 摘要、工具 schemas、返回内容。配合 N1 的节点模型继承/自定义，可精确复现"某个节点实际用了哪套 URL/API、模型看到了什么"。

### 12.3 P4-3 运行前预检（误导配置立即失败）— 中高价值 · 低成本

**借鉴**：加载时能自检的错误立即失败，从不静默跳过缺失引用。

**现状**：`exporter.js` 的 `checkAgent` 已有完整预检（技能/工具/子智能体/记忆引用），但只在导出时跑。

**做法**：预检提取为共享模块，画布「▶ 运行」前先跑：错误阻止运行并标红节点，警告 toast；节点模型配置了自定义 URL/API 但为空时运行前报错，而非运行中静默回落。

### 12.4 P4-4 导出加强（只加强 Python 导出）— 中高价值 · 中成本

在现有导出管线（`exporter.js` + `electron/export-template/`）上加强：

| # | 项 | 说明 |
|---|---|---|
| 1 | **固化真实记忆** | 现在导出只带记忆骨架；加强为把工作流引用的记忆架构真实内容（policy/facts/episodes + pid-memory lessons.db 经验）固化进包内 `memory/`，部署即带经验 |
| 2 | **导出包运行日志** | 导出物运行时把每次 LLM 请求 + 工具调用写 `data/audit/llm.jsonl`（P4-2 落地到 Python 端） |
| 3 | **web 控制台升级** | 加会话历史 / 工具调用日志 / 节点级输出查看（配合已有 /api/config 注入接口） |
| 4 | **zip 一键分发** | 导出成功后自动打成 zip 方便拷走 |

### 12.5 P4-5 LLM Provider 能力缝 — 中价值 · 中成本

**借鉴**：能力缝三角色（Service Definition / Provider / Consumer），provider 可替换。

**现状**：`llm.js` 的 `streamChat` 已是接口（baseUrl/apiKey/model 注入），但只支持 OpenAI 兼容格式。

**做法**：settings 与节点模型配置加 `provider` 字段：`openai-compatible`（现状）/ `anthropic` / `ollama`；llm.js 按 provider 组装请求格式。使节点级自定义模型能接任意厂商。

### 12.6 P4-6 无密钥快照测试 — 中价值 · 中成本

**借鉴**：keyless snapshot 回放（`DSH_SNAPSHOT=replay/record/refresh`），CI 无需 API key。

**做法**：把现有 `m-p*.mjs` / `e2e-*.mjs` 整理为 `scripts/check.mjs` 一键门禁，两类：
- **无 LLM 部分**（拓扑排序、区域权限、控制流、导出清洗、模型继承解析）：直接断言，零 key；
- **LLM 部分**：录一次真实请求/响应 fixture（脱敏），回放时 mock `llm.streamChat`。

### 12.7 P4-7 工具呈现 — 低价值 · 放最后

**借鉴**：工具结果渲染意图（generic / terminal / diff / locations）。

**做法**：画布节点输出按工具/技能结果的 `render` 类型渲染（diff 高亮、JSON 树、表格），纯视觉收益。

### 12.8 明确不照搬

| 项 | 理由 |
|---|---|
| Cordis 插件框架 / DI / Fiber | 单体规模，重排生命周期负收益；MCP 工具 + 自定义模块已覆盖插件诉求 |
| 100% 每文件覆盖率门禁 | 个人项目成本远大于收益 |
| Profile / cordis.patch.yml 组合层 | 用 P4-4 导出加强替代；团队共享走 T2 JSON 资产包 |
| JSON-RPC SDK + Python SDK | 已有 Python 导出引擎 + MCP Server，无需新协议 |
| 双聚合 TypeScript | JS/React 无 Context 声明合并问题 |
| Turn/Step 事件模型重构 | 现有 callback 回环 + MAX_ROUNDS 已覆盖 |

### 12.9 执行顺序

P4-1 → P4-2 → P4-3（骨架）→ P4-4 → P4-5 → P4-6 → P4-7。

---

## 十三、N3/N4/N5 开发文档（3 项新需求，代码已落地，剩验证+打包）

> 决策：内部工具包（N2 已改名，自研声明格式）与外部 MCP（标准 MCP 协议）**并存**——Harness 作为 MCP 客户端接入 GitHub 等外部 MCP Server；另补文件右键重命名与代码语法高亮。
>
> **状态**：三项功能**代码均已实现并入库**（未提交），剩余工作 = 语法检查 + 前端构建 + 打包 release exe + e2e 验证。

### 13.1 N3 外部 MCP 接入（Harness = MCP 客户端）

**目标**：在「工具包」面板接入外部 MCP Server（标准 MCP 协议），其工具导入后供智能体调用（例：GitHub MCP）。

**支持两种传输**：
| 类型 | 接入方式 | 例 |
|---|---|---|
| stdio | 本地命令启动（`command [args]`） | `npx @modelcontextprotocol/server-github` |
| http | 远程 URL（Streamable HTTP `/mcp` 或 SSE `/mcp/sse`） | `http://127.0.0.1:37800/mcp/sse`（连 Harness 自己也行） |

**已落地实现**：
- **`electron/mcp-client.js`（新）**：`MCPConnection` 类（`connect()` 初始化 stdio/http 传输 → `initialize` 能力协商（协议版本 `2025-03-26`）→ `notifications/initialized` → `tools/list` → 提取 `{name, description, parameters(inputSchema)}`；`_request()` JSON-RPC 请求、`_notify()`、`execTool()` 提取文本内容）。对外 API：`init / reload / list / add / update / remove / allTools / execTool / stopAll`。配置存 `data/external-mcps.json`：`{id, name, type, command, args[], url, headers?, enabled}`。超时 15s；http 走 `net.fetch`（自动走系统代理 127.0.0.1:7897）；工具名 `ext_` 前缀隔离。
- **`electron/tools.js`**：`execTool` 增加 `ext_` 前缀分发（`name.startsWith('ext_')` → `mcpClient.execTool(name.slice(4), args)`）。
- **`electron/llm.js`**：`getToolSchemas` 合并外部 MCP 工具（`allTools().map(→ name: 'ext_' + t.name)`），全部启用供 LLM 调用。
- **`electron/main.js`**：`externalMcps.init()`（启动连接 enabled 外部 MCP，失败不阻塞启动）；IPC `extmcps:list/add/update/delete/reload`；`before-quit` 调 `externalMcps.stopAll()`；`tools:list` 返回含 `external` 字段。
- **`electron/preload.js`**：暴露 `h.extMcps`（`list/add/update/delete/reload`）。
- **`src/components/ToolPacksPanel.jsx`**：「🌐 外部 MCP」按钮 + 新建/编辑弹窗（名称/类型 stdio|http/命令或 URL/启用开关/保存并连接）+ 外部 MCP 独立分组卡片（状态：已连接/连接失败/已停用，显示工具数）+ 右键菜单（编辑/重新连接/删除）。
- **`src/styles.css`**：`.mcp-card.ext` 外部 MCP 卡片样式。
- **`src/components/AgentPanel.jsx`**：`toolOptions` 合并外部工具 `ext:${t.name}`；`openToolSource` 对 `ext:` 提示"无本地源码"。

**安全底线**：外部 MCP 工具**不进导出包**（导出只含 `.tool.py` 内部工具）；工具名前缀 `ext_` 隔离避免与内部冲突。

### 13.2 N4 文件右键重命名

**目标**：所有文件树支持右键「重命名」。现状：工作区文件树已有（`workspace:rename`）；**技能文件树、记忆文件树补齐**。

**已落地实现**：
- **`electron/skills.js`**：`renameFile(id, oldRel, newRel)`——主组件 `main` 不可改名；路径越界校验；无扩展名自动补 `.md`；目标已存在报错；迁移 `.skill-file-perms.json` 可读性记录。
- **`electron/memory.js`**：`renameFile(name, oldRel, newRel)`——受保护文件不可改名；目标不得与内置核心文件重名；无扩展名补 `.md`。
- **`electron/main.js`**：IPC `skills:rename-file`、`memory:rename-file`。
- **`electron/preload.js`**：`h.skills.renameFile`、`h.memory.renameFile`。
- **`src/components/SkillPanel.jsx`**：文件树右键菜单「✏ 重命名」（`main` 禁用）+ 重命名弹窗（输入新文件名，Enter 确认）；改名后若正打开则跟随。
- **`src/components/MemoryPanel.jsx`**：同上（受保护文件禁用）。

### 13.3 N5 代码语法高亮（vscode 风格）

**目标**：代码文件（python/c/c++/js 等）编辑时对不同作用字符（变量/关键字/字符串/注释…）用不同颜色，观感接近 vscode。

**已落地实现**：
- **`src/styles.css`**：vscode-dark 风格 hljs token 配色（关键字 `#569cd6`、字符串 `#ce9178`、注释 `#6a9955` 斜体、数字 `#b5cea8`、函数标题 `#dcdcaa`、类型 `#4ec9b0` 等），作用于 `.code-editor.native .code-highlight .hljs-*` 并覆盖 `.markdown-body pre` 代码块；`.code-modal-editor` 样式。
- **`src/components/CodeEditor.jsx`**：`LANGS` 语言映射含 `python/c/cpp/javascript`；非技能文件按扩展名推断语言（`py/c/h/cpp/cc/cxx/hpp/js/mjs/jsx/cjs/…`）。
- **`src/components/AgentPanel.jsx` / `WorkspacePanel.jsx`**：画布「逻辑代码」弹窗复用 `.code-modal-editor` 高亮层（pre + 透明 textarea 叠加）。

### 13.4 实施顺序与验证计划

**顺序**：N5（配色，快）→ N4（重命名，中）→ N3（外部 MCP，大）——**均已实施**。

**剩余工作（本次动工）**：
1. `node --check` 全部改动的 electron 后端脚本
2. `npm run build` 前端构建（React 无编译错误）
3. e2e 验证：技能文件树/记忆文件树重命名；代码编辑高亮配色；外部 MCP（mock stdio server）add→connect→tools/list→execTool→update→delete
4. 停 LAG harness 进程 → 打包 release（`release\win-unpacked\LAG harness.exe`）→ 启动验证
5. 更新 GitHub 仓库（含 ignore 保护，不含任何 api key 文件）

---

## 十四、N6/N7 开发文档（工具包外部 MCP 分类 + 接口创建电机调参工作流）

> 状态：**已完成**。两个需求：① 工具包面板里要有「外部 MCP」分类（使用标准 MCP 协议的外部工具）；② 用 harness 对外接口（MCP Server）创建一套完整的电机 PID 调参工作流（电流环/速度环/位置环等，一个智能体负责一环），并在各功能栏位建好文件夹、创建相关工具/技能/智能体（记忆 pid-tuning 已建）。

### 14.1 N6 工具包面板「外部 MCP」分类（小）

**现状**：外部 MCP 在工具包面板底部是写死的独立分组（`🌐 外部 MCP`），不参与分类文件夹体系（`cats.list`），无法归类。

**做法**：
- `electron/mcp-client.js`：`list()` 返回增加 `category` 字段（默认 `外部 MCP`）；新增 `setCategory(id, name)` 持久化到 `data/external-mcps.json`
- `electron/main.js`：IPC `extmcps:set-category`
- `electron/preload.js`：`h.extMcps.setCategory`
- `src/components/ToolPacksPanel.jsx`：外部 MCP 卡片并入分类分组渲染（按 `category` 归类，未设置归「外部 MCP」分组）；右键菜单加「移动分类」；分类下拉可选 `__new__` 建新分类
- 落点：`mcp-client.js`、`main.js`、`preload.js`、`ToolPacksPanel.jsx`

### 14.2 N7 用 harness 对外接口创建电机 PID 调参工作流

**现状**：harness 对外 MCP Server（SSE 37800）只暴露**读取/运行类** 9 工具（get_health/list_agents/run_agent/list_skills/run_skill/list_mcp_tools/call_mcp_tool/memory_read/memory_write），**没有任何创建/管理类工具**——外部 AI（或用户）无法通过接口创建智能体/技能/工作流/分类。本次要补上「管理接口」并用它实际创建调参体系。

#### 14.2.1 扩展对外 MCP Server：新增管理类工具（N7a）

在 `electron/mcp-server.js` 的 `MCP_TOOLS` 追加（**协议仍走标准 MCP**，纯 JSON-RPC 无改动）：

| 工具 | 作用 | 参数 |
|---|---|---|
| `create_category` | 在某栏位建分类文件夹 | `scope(skills/agents/tools/memory/workflows)` + `name` |
| `create_skill` | 创建技能（目录+main 文件） | `id`+`name`+`description`+`systemPrompt`(可选)+`category`(可选) |
| `create_agent` | 创建智能体定义 | `id`+`name`+`description`+`systemPrompt`+`skills[]`+`model{inherit}`+`category` |
| `save_workflow` | 保存画布工作流（含节点/连线） | `id`+`name`+`nodes[]`+`edges[]`+`category` |
| `list_workflows` | 列工作流 | — |
| `toolpacks_list` | 列出内置工具包 | —（已有 list_mcp_tools，保留） |

执行时复用现有 `skills.js` / `agent.createAgentDefStore` / `agent.createAgentStore` 的创建接口（`create` + `save` + `setCategory`），不新增底层存储。

#### 14.2.2 用接口创建「电机 PID 调参」体系（N7b，真实调用验证）

先在 harness 各栏位建好分类文件夹，再逐项创建（**全部通过 MCP 接口调用**，不是直接写文件）：

**① 分类文件夹**
| 栏位 | 分类 | 说明 |
|---|---|---|
| 技能 | `电机调参` | 三个环的调参技能 |
| 智能体 | `电机调参` | 三个环的调参智能体 |
| 工具 | `电机PID`（已有 motor_pid/pid_memory 归此） | — |
| 记忆 | `pid-tuning`（已建） | 记忆卡片 |

**② 技能**（`create_skill`，每个技能一个 when-to-use）：
| 技能 id | 名称 | 负责 |
|---|---|---|
| `current_loop` | 电流环调参 | 电流环 Kp/Ki/Kd 整定（最内环，最先调） |
| `speed_loop` | 速度环调参 | 速度环整定（内环稳定后调） |
| `position_loop` | 位置环调参 | 位置环整定（最外环） |

**③ 智能体**（`create_agent`，一个智能体一个环，model 全部 inherit 继承上游）：
| 智能体 | 技能 | systemPrompt 要点 |
|---|---|---|
| 电流环智能体 | current_loop | 角色=电流环调参工程师；when-to-use |
| 速度环智能体 | speed_loop | 角色=速度环调参工程师；依赖电流环已稳定 |
| 位置环智能体 | position_loop | 角色=位置环调参工程师；依赖速度环已稳定 |

**④ 工作流**（`save_workflow`）：画布编排「输入 → 电流环智能体 → 速度环智能体 → 位置环智能体 → 输出」，`data` 连线级联（整定顺序先内后外：电流环→速度环→位置环；前环结果经数据连线 + `pid-tuning` 记忆总线交接给后环，即 A2A 交接）；**显式挂接**：`pid-tuning` 记忆节点（reads policy/facts/episodes/skills）、电机工具节点（`tool:motor_connect`/`tool:motor_set_pid`/`tool:motor_read_samples`）、外部 MCP 工具节点（`ext:get_health`，标准 MCP 协议）；记忆工具（mem_*）不占画布工具节点——由绑定 `pid-tuning` 记忆自动注入各子智能体（子智能体分支已支持透传到子图技能节点）。

**⑤ 记忆**：已建 `pid-tuning` 卡片（policy/facts/episodes/skills/ledger/bus + pid_tuner.skill.py + **pid_memory.mem.py**）。三层记忆工具（mem_*）从工具包迁入记忆体系：记忆脚本 `pid_memory.mem.py` 由记忆引擎加载，绑定 `pid-tuning` 记忆的智能体自动获得 mem_* 工具（archBinding 并入 + LLM schema 合并），**工具包面板不再显示记忆工具**。

#### 14.2.3 验证（N7c）

1. 通过 `create_category/create_skill/create_agent/save_workflow` 依次调用，逐个断言返回成功
2. `list_agents/list_skills/list_workflows` 确认创建结果；harness 界面「智能体/技能/工作流」栏位出现对应卡片与分类
3. 运行工作流（无真机时用 motor_sim_driver 仿真）：输入一段调参任务 → 三个智能体依次执行 → 输出收敛的 PID 参数
4. 打包 release + 启动验证

#### 14.2.4 落点清单

`electron/mcp-server.js`（新增 6 个管理工具）、`electron/mcp-client.js`（N6 分类）、`electron/main.js`（IPC）、`electron/preload.js`、`src/components/ToolPacksPanel.jsx`（N6 前端）。数据资产由接口写入 `data/`。

### 14.3 实施顺序

N6（外部 MCP 分类，小）→ N7a（管理接口，中）→ N7b（接口创建调参体系，验证）→ N7c（工作流运行验证）→ 打包。

---


