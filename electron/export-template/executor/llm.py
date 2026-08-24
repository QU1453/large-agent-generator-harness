# LLM 客户端：OpenAI 兼容 chat/completions（非流式 + 工具调用）
import json
import urllib.request

def chat(config, messages, tools=None):
    base = str(config.get('base_url') or '').rstrip('/')
    if not base:
        raise RuntimeError('未配置 LLM Base URL（可用环境变量 LLM_BASE_URL）')
    url = base + '/chat/completions'
    body = {
        'model': config.get('model') or '',
        'messages': messages,
        'stream': False,
        'temperature': config.get('temperature', 0.7),
    }
    if config.get('max_tokens'):
        body['max_tokens'] = config['max_tokens']
    if tools:
        body['tools'] = tools
    req = urllib.request.Request(url, data=json.dumps(body).encode('utf-8'), method='POST')
    req.add_header('Content-Type', 'application/json')
    api_key = config.get('api_key') or ''
    if api_key:
        req.add_header('Authorization', 'Bearer ' + api_key)
    try:
        with urllib.request.urlopen(req, timeout=120) as resp:
            data = json.loads(resp.read().decode('utf-8'))
    except urllib.error.HTTPError as e:
        detail = e.read().decode('utf-8', errors='replace')[:500]
        raise RuntimeError('LLM 请求失败 [%s]: %s' % (e.code, detail))
    except Exception as e:
        raise RuntimeError('LLM 请求失败: %s' % e)
    choice = (data.get('choices') or [{}])[0]
    msg = choice.get('message') or {}
    out = {'content': msg.get('content') or ''}
    calls = msg.get('tool_calls') or []
    if calls:
        out['tool_calls'] = [
            {
                'id': c.get('id') or 'call_%d' % i,
                'name': ((c.get('function') or {}).get('name') or ''),
                'arguments': ((c.get('function') or {}).get('arguments') or ''),
            }
            for i, c in enumerate(calls)
            if c.get('function', {}).get('name')
        ]
    return out
