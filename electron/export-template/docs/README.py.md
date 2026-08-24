## 调用方式二：作为 Python 库 import（外部软件直接调用）

无需启动任何服务，外部 Python 工程把本目录加入 sys.path 后直接调用：

```python
import sys
sys.path.insert(0, r"__OUTDIR__")   # 改为本目录的绝对路径
import la

agent = la.La()                      # 首次运行会读取 data/config.json 的 LLM 配置（或环境变量）
print(agent.run("你好"))             # 返回最终输出文本
```

也可以在实例化时直接传入配置（覆盖 manifest 默认值）：
```python
import la
agent = la.La(config={"baseUrl": "https://api.deepseek.com/v1", "apiKey": "sk-...", "model": "deepseek-v4-flash"})
print(agent.run("写一首关于春天的诗"))
```

单文件 exe 版请用 `la.La(data_root=...)` 指定数据目录。
