## 命令行

```
runtime\python\python.exe la_main.py --message "你好"
```

## 模型配置

首次打开聊天控制台时会弹出 **LLM 配置页**（Base URL / API Key / 模型），保存后写入本机
`data/config.json`（不会外传）。也可通过环境变量 `LLM_BASE_URL`、`LLM_API_KEY`、`LLM_MODEL`
提供；控制台右上角 ⚙ 可随时修改配置。

## 目录结构

- `manifest.json` — I/O 契约 + 智能体定义 + 工作流图
- `la/` — **Python 库接口**（`import la; la.La().run("...")`）
- `executor/` — 执行引擎（编排 + LLM 循环 + 工具）
- `transports/` — HTTP/CLI 入口
- `web/` — 自带聊天控制台
- `tools/` — 引用的 Python 工具包
- `runtime/` — 内嵌 Python 运行时
- `data/` — 会话（运行期生成）
- `memory/` — **记忆空间**：policy.md（策略）+ ledger.md（账本）+ facts/episodes/skills/views（见 memory/README.md）
