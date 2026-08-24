# 大型 Agent 库接口（Python 工程：import la 后直接调用，无需启动服务）
import json
import os
import sys

_BUNDLE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
if _BUNDLE not in sys.path:
    sys.path.insert(0, _BUNDLE)

from executor import config as cfgmod
from executor.tools import load_tools
from executor.engine import run_la

class La:
    """大型 Agent 客户端（自包含，脱离 harness 独立运行）。

    用法：
        import la
        agent = la.La()                  # 读取 data/config.json / 环境变量的 LLM 配置
        print(agent.run("你好"))
    """

    def __init__(self, config=None, data_root=None):
        self.manifest = self._load_manifest()
        self.config = cfgmod.merge_llm_config(self.manifest, cfgmod.load_file_config(data_root or cfgmod.data_root()))
        self.config['tools_dir'] = os.path.join(cfgmod.bundle_root(), 'tools')
        self.config['_bundle_root'] = cfgmod.bundle_root()
        self.config['_data_root'] = data_root or cfgmod.data_root()
        if config:
            self.config.update(config)
        self.config['_tools'] = load_tools(self.config['tools_dir'])

    def _load_manifest(self):
        with open(os.path.join(cfgmod.bundle_root(), 'manifest.json'), encoding='utf-8') as f:
            return json.load(f)

    def run(self, message, session_id=None):
        """运行一条消息，返回最终输出文本。"""
        result = run_la(self.manifest, self.config, str(message), session_id, None)
        return result['content']

__all__ = ['La']
