## 调用方式一：启动 API 服务（HTTP）

启动（Windows 双击 start.bat，或命令行）：
```bash
runtime\python\python.exe la_main.py --serve --port __PORT__
```

HTTP（一次性）：
```bash
curl -X POST http://localhost:__PORT__/v1/chat \
  -H "Content-Type: application/json" \
  -H "Authorization: Bearer __TOKEN__" \
  -d '{"message": "你好"}'
```

Python（HTTP 客户端）：
```python
import requests
r = requests.post("http://localhost:__PORT__/v1/chat",
    headers={"Authorization": "Bearer __TOKEN__"},
    json={"message": "你好"})
print(r.json()["content"])
```

## 模型配置注入接口（导出物不含任何 URL / API Key）

导出包**不含**任何真实的模型 URL / API Key（导出时已替换为 `env:` 占位符）。
运行前可用以下接口给**全局**或**某个智能体**单独传输 URL 和 API（保存到本机
`data/config.json`，重启后仍然生效；也可用环境变量 `LLM_BASE_URL / LLM_API_KEY / LLM_MODEL` 提供）。

### GET /api/config —— 查看配置状态与可注入的智能体清单
```bash
curl http://localhost:__PORT__/api/config
```
```json
{
  "configured": false,
  "baseUrl": "",
  "model": "",
  "hasKey": false,
  "agents": [
    { "id": "n1", "label": "客服技能", "type": "skill", "custom": true },
    { "id": "n2", "label": "子智能体", "type": "subagent", "custom": false }
  ]
}
```
> `agents` 里的 `id` 就是工作流里该智能体节点的 ID：注入时用它作 key，运行时该节点优先使用自己的配置。

### POST /api/config —— 注入全局 + 每智能体配置（也可只注入某一项）
```bash
curl -X POST http://localhost:__PORT__/api/config \
  -H "Content-Type: application/json" \
  -d '{
    "base_url": "https://api.deepseek.com/v1",
    "api_key": "sk-你的密钥",
    "model": "deepseek-chat",
    "agents": {
      "n1": { "base_url": "https://api.openai.com/v1", "api_key": "sk-其他", "model": "gpt-4o" },
      "n2": { "base_url": "https://api.deepseek.com/v1", "api_key": "sk-其他2" }
    }
  }'
```
响应：`{"ok": true, "agents": [...]}`。字段说明：

| 字段 | 含义 |
|---|---|
| `base_url` / `api_key` / `model`（顶层） | 全局配置，所有未单独注入的智能体跟随它 |
| `agents.<节点ID>` | 只给某个智能体配置，运行时优先级：**该智能体 > 全局** |
| `agents.<节点ID> = null` | 清除该智能体的注入，恢复跟随全局 |

> 优先级：运行时注入的每智能体配置 > 节点在画布上的自定义模型 > 全局配置 > 环境变量。
> `GET /api/config` 永不回传已保存的 API Key（只给 `hasKey`），`POST` 也不要求每次都重填。

