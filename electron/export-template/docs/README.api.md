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
