# 传输层：HTTP 服务（REST + CORS + Token 鉴权 + 自带聊天控制台）
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from executor.engine import run_la

# 只读资源根目录（本文件位于 <root>/transports/ 下；exe 模式下为解包目录）
ROOT = sys._MEIPASS if getattr(sys, 'frozen', False) else os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))

def check_auth(handler, manifest):
    token = manifest.get('auth', {}).get('token') or ''
    if not token:
        return True
    hdr = handler.headers.get('Authorization') or ''
    return hdr == 'Bearer ' + token

def handle_chat(manifest, config, body):
    message = str((body or {}).get('message') or '').strip()
    if not message:
        return 400, {'error': 'message 不能为空'}
    result = run_la(manifest, config, message, body.get('sessionId'), config.get('_sessions'))
    return 200, result

def agent_nodes(manifest):
    # 导出物里可被单独注入模型的"智能体"节点（顶层图的 skill / bus / subagent / 自定义模型节点）
    nodes = (manifest.get('agent') or {}).get('nodes') or []
    out = []
    for n in nodes:
        if not n or not n.get('id'):
            continue
        t = n.get('type')
        if t in ('skill', 'bus', 'subagent') or n.get('model'):
            out.append({
                'id': n.get('id'),
                'label': n.get('label') or t,
                'type': t,
                'custom': bool(n.get('model') and n.get('model', {}).get('inherit') is False),
            })
    return out

def make_handler(manifest, config):
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, fmt, *args):
            pass

        def _send(self, code, payload):
            data = json.dumps(payload, ensure_ascii=False).encode('utf-8')
            self.send_response(code)
            self.send_header('Content-Type', 'application/json; charset=utf-8')
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
            self.send_header('Content-Length', str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_OPTIONS(self):
            self.send_response(204)
            self.send_header('Access-Control-Allow-Origin', '*')
            self.send_header('Access-Control-Allow-Methods', 'GET,POST,OPTIONS')
            self.send_header('Access-Control-Allow-Headers', 'Content-Type, Authorization')
            self.end_headers()

        def do_GET(self):
            if self.path == '/v1/health' or self.path == '/api/health':
                return self._send(200, {'ok': True, 'name': manifest.get('name')})
            if self.path in ('/v1/config', '/api/config'):
                # 配置状态（不回传已保存的 api_key，只给 hasKey）+ 可注入的智能体节点清单
                return self._send(200, {
                    'configured': bool(config.get('base_url') and config.get('api_key')),
                    'baseUrl': config.get('base_url') or '',
                    'model': config.get('model') or '',
                    'hasKey': bool(config.get('api_key')),
                    'agents': agent_nodes(manifest),
                })
            if self.path in ('/', '/index.html'):
                fp = os.path.join(ROOT, 'web', 'index.html')
                if os.path.exists(fp):
                    data = open(fp, 'rb').read()
                    self.send_response(200)
                    self.send_header('Content-Type', 'text/html; charset=utf-8')
                    self.send_header('Content-Length', str(len(data)))
                    self.end_headers()
                    self.wfile.write(data)
                    return
                return self._send(404, {'error': '控制台页面缺失'})
            return self._send(404, {'error': '接口不存在: ' + self.path})

        def do_POST(self):
            # 首次配置页无需鉴权（本地首次设置）；其余接口需令牌
            if self.path in ('/v1/config', '/api/config'):
                return self._save_config()
            if not check_auth(self, manifest):
                return self._send(401, {'error': '未授权：请携带 Authorization: Bearer <token>'})
            length = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(length) if length else b''
            try:
                body = json.loads(raw.decode('utf-8') or '{}')
            except Exception:
                return self._send(400, {'error': '请求体不是合法 JSON'})
            if self.path == '/v1/chat':
                try:
                    code, payload = handle_chat(manifest, config, body)
                    return self._send(code, payload)
                except Exception as e:
                    return self._send(500, {'error': str(e)})
            return self._send(404, {'error': '接口不存在: ' + self.path})

        def _save_config(self):
            length = int(self.headers.get('Content-Length') or 0)
            raw = self.rfile.read(length) if length else b''
            try:
                body = json.loads(raw.decode('utf-8') or '{}')
            except Exception:
                return self._send(400, {'error': '请求体不是合法 JSON'})
            base_url = str(body.get('base_url') or body.get('baseUrl') or '').strip()
            api_key = str(body.get('api_key') or body.get('apiKey') or '').strip()
            model = str(body.get('model') or '').strip()
            if base_url or api_key:
                if not base_url:
                    return self._send(400, {'error': 'Base URL 不能为空'})
                if not api_key:
                    return self._send(400, {'error': 'API Key 不能为空'})
            # 每智能体注入：agents: { nodeId: { base_url?, api_key?, model? } }
            agents_map = body.get('agents')
            if agents_map is not None and not isinstance(agents_map, dict):
                return self._send(400, {'error': 'agents 必须是 { 节点ID: {base_url, api_key, model} } 对象'})
            from executor import config as cfgmod
            data_root = config.get('_data_root') or cfgmod.data_root()
            old_cfg = cfgmod.load_file_config(data_root)
            # 合并旧配置：保留未提交的全局字段与每智能体配置
            base_cfg = dict(old_cfg)
            if base_url:
                base_cfg['base_url'] = base_url
            if api_key:
                base_cfg['api_key'] = api_key
            if model:
                base_cfg['model'] = model
            old_agents = old_cfg.get('agents') if isinstance(old_cfg.get('agents'), dict) else {}
            merged_agents = dict(old_agents)
            if agents_map is not None:
                for k, v in agents_map.items():
                    if v is None:
                        merged_agents.pop(k, None)
                    else:
                        merged_agents[k] = v
            cfgmod.save_injected_config(data_root, base_cfg, merged_agents)
            # 更新内存配置
            if base_url:
                config['base_url'] = base_url
            if api_key:
                config['api_key'] = api_key
            if model:
                config['model'] = model
            config['_node_models'] = merged_agents
            return self._send(200, {'ok': True, 'agents': agent_nodes(manifest)})

    return Handler

def serve(manifest, config, port):
    from executor import config as cfgmod
    data_root = config.get('_data_root') or cfgmod.data_root()
    config['_sessions'] = __import__('executor.state', fromlist=['SessionStore']).SessionStore(os.path.join(data_root, 'data'))
    server = ThreadingHTTPServer(('0.0.0.0', port), make_handler(manifest, config))
    print('LA「%s」已启动: http://localhost:%d' % (manifest.get('name'), port))
    token = manifest.get('auth', {}).get('token')
    if token:
        print('访问令牌: %s' % token)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
