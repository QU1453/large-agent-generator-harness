# 工具注册与执行：动态加载 tools/ 目录下的 .tool.py 工具包（兼容旧 .mcp.py）
import importlib.util
import json
import os

def load_tools(tools_dir):
    registry = {}
    if not os.path.isdir(tools_dir):
        return registry
    for name in sorted(os.listdir(tools_dir)):
        if not (name.endswith('.tool.py') or name.endswith('.mcp.py')):
            continue
        mod_path = os.path.join(tools_dir, name)
        try:
            spec = importlib.util.spec_from_file_location(name[:-3], mod_path)
            mod = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(mod)
        except Exception as e:
            registry.setdefault('_load_errors', []).append('%s: %s' % (name, e))
            continue
        for t in getattr(mod, 'TOOLS', []):
            handler = getattr(mod, t.get('handler') or '', None)
            if handler is None:
                continue
            registry[t['name']] = {'schema': t, 'handler': handler, 'source': name}
    return registry

def build_tool_schemas(agent, registry):
    names = set(agent.get('tools') or [])
    out = []
    for n, item in registry.items():
        if n.startswith('_'):
            continue
        if names and n not in names and ('tool:' + n) not in names and ('mcp:' + n) not in names:
            continue
        schema = item['schema']
        out.append({
            'type': 'function',
            'function': {
                'name': n,
                'description': schema.get('description') or '',
                'parameters': schema.get('parameters') or {'type': 'object', 'properties': {}},
            },
        })
    return out

def exec_tool(registry, name, args):
    item = registry.get(name)
    if not item:
        return json.dumps({'error': '工具不存在: ' + name}, ensure_ascii=False)
    try:
        result = item['handler'](args or {})
    except Exception as e:
        return json.dumps({'error': str(e)}, ensure_ascii=False)
    if isinstance(result, str):
        return result
    return json.dumps(result, ensure_ascii=False, default=str)
