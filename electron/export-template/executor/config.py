# 运行期配置：首次运行的 LLM 配置页保存到 data/config.json（可被 env / manifest 覆盖）
import json
import os
import sys

def data_root():
    # 可写数据目录：exe 模式=exe 所在目录；脚本模式=导出包根目录
    if getattr(sys, 'frozen', False):
        return os.path.dirname(sys.executable)
    return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

def bundle_root():
    # 只读资源目录：exe 模式=PyInstaller 解包目录；脚本模式=导出包根目录
    if getattr(sys, 'frozen', False):
        return sys._MEIPASS
    return os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))

def config_path(root):
    return os.path.join(root, 'data', 'config.json')

def load_file_config(root):
    fp = config_path(root)
    if os.path.exists(fp):
        try:
            with open(fp, encoding='utf-8') as f:
                data = json.load(f)
            if isinstance(data, dict):
                return data
        except Exception:
            pass
    return {}

def save_file_config(root, cfg):
    fp = config_path(root)
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, 'w', encoding='utf-8') as f:
        json.dump(cfg, f, ensure_ascii=False, indent=2)

def merge_llm_config(manifest, file_cfg):
    model = manifest.get('model') or {}
    def pick(env_name, fallback, file_val):
        # 配置页保存的值 > 环境变量 > manifest（env: 占位符未设时置空以便引导配置）
        if file_val:
            return file_val
        val = os.environ.get(env_name)
        if val:
            return val
        val = fallback or ''
        if isinstance(val, str) and val.startswith('env:'):
            return ''
        return val
    cfg = {
        'base_url': pick('LLM_BASE_URL', model.get('baseUrl'), file_cfg.get('base_url')),
        'api_key': pick('LLM_API_KEY', model.get('apiKey'), file_cfg.get('api_key')),
        'model': pick('LLM_MODEL', model.get('default'), file_cfg.get('model')),
        'max_tokens': model.get('maxTokens'),
        'temperature': model.get('temperature', 0.7),
    }
    # 每智能体注入配置（导出后通过 /api/config 给全局 / 某个智能体传输 url/api）
    agents = file_cfg.get('agents')
    if isinstance(agents, dict) and agents:
        cfg['_node_models'] = {k: v for k, v in agents.items() if isinstance(v, dict)}
    return cfg

def save_injected_config(root, base_cfg, agents_map):
    # 保存全局 + 每智能体配置（/api/config 注入接口）
    data = {}
    if base_cfg and isinstance(base_cfg, dict):
        for k in ('base_url', 'api_key', 'model'):
            v = base_cfg.get(k)
            if v:
                data[k] = v
    if agents_map and isinstance(agents_map, dict):
        clean = {}
        for k, v in agents_map.items():
            if not isinstance(v, dict):
                continue
            entry = {}
            for f in ('base_url', 'api_key', 'model'):
                val = v.get(f)
                if val:
                    entry[f] = val
            if entry:
                clean[k] = entry
        if clean:
            data['agents'] = clean
    fp = config_path(root)
    os.makedirs(os.path.dirname(fp), exist_ok=True)
    with open(fp, 'w', encoding='utf-8') as f:
        json.dump(data, f, ensure_ascii=False, indent=2)

def is_ready(cfg):
    return bool(cfg.get('base_url') and cfg.get('api_key'))
