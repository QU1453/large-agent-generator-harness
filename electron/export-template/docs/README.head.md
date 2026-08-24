# __NAME__（大型 Agent）

__DESC__

这是一个由 LAG harness 导出的自包含大型 Agent 包：**无需安装 Python**，解压即用。

## 快速开始

Windows：双击 `start.bat`，自动启动服务并打开聊天控制台。
macOS / Linux：执行 `bash start.sh`，然后访问 http://localhost:__PORT__ 。

## 访问令牌

本 Agent 的访问令牌：`__TOKEN__`

本地启动时控制台会自动打开，无需鉴权。跨机器访问或调用 API 时需携带：
`Authorization: Bearer __TOKEN__`
