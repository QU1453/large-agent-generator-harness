# 执行引擎：智能体图编排（拓扑排序 + [[zone]] 数据总线 + LLM 工具循环）
import json
import os
import re
import time

from . import llm
from . import tools

MAX_ROUNDS = 8

_ZONE_RE = re.compile(r'\[\[(\w[\w.-]*)\]\]([\s\S]*?)\[\[/\1\]\]')

def parse_zones(text):
    zones = {}
    plain_parts = []
    last = 0
    s = str(text or '')
    for m in _ZONE_RE.finditer(s):
        if m.start() > last:
            plain_parts.append(s[last:m.start()])
        zones[m.group(1)] = (zones.get(m.group(1)) or '') + m.group(2)
        last = m.end()
    if last < len(s):
        plain_parts.append(s[last:])
    return {'zones': zones, 'plain': ''.join(plain_parts)}

def to_zone_list(v):
    if not v:
        return []
    if isinstance(v, list):
        return [x for x in v if x]
    return [x for x in re.split(r'[,\s]+', str(v)) if x]

def filter_read_zones(text, read_zones):
    if not text:
        return ''
    parsed = parse_zones(text)
    if not parsed['zones']:
        return parsed['plain']
    allowed = set(read_zones)
    parts = []
    if parsed['plain'].strip():
        parts.append(parsed['plain'])
    for name, val in parsed['zones'].items():
        if name in allowed:
            parts.append('[[%s]]%s[[/%s]]' % (name, val, name))
    return '\n\n'.join(parts)

def filter_write_zones(text, write_zones):
    if not text or not write_zones:
        return text
    parsed = parse_zones(text)
    if not parsed['zones']:
        return parsed['plain']
    allowed = set(write_zones)
    parts = []
    if parsed['plain'].strip():
        parts.append(parsed['plain'])
    for name, val in parsed['zones'].items():
        if name in allowed:
            parts.append('[[%s]]%s[[/%s]]' % (name, val, name))
    return '\n\n'.join(parts)

# 分支条件求值（边 when 表达式）：always / length > N / contains 关键词 / not contains；未知条件默认放行
def eval_cond(cond, text):
    c = str(cond or '').strip()
    s = str(text or '')
    if not c or c in ('always', 'true'):
        return True
    m = re.match(r'^length\s*([<>=!]+)\s*(\d+)$', c)
    if m:
        op, n = m.group(1), int(m.group(2))
        ln = len(s)
        return {'>': ln > n, '<': ln < n, '>=': ln >= n, '<=': ln <= n, '==': ln == n, '!=': ln != n}.get(op, True)
    m = re.match(r'^contains\s+(.+)$', c)
    if m:
        return m.group(1).strip() in s
    m = re.match(r'^not\s+contains\s+(.+)$', c)
    if m:
        return m.group(1).strip() not in s
    return True

def topo_sort(nodes, edges):
    by_id = {n['id']: n for n in nodes}
    incoming = {n['id']: [] for n in nodes}
    for e in edges:
        if e.get('from') in by_id and e.get('to') in by_id:
            incoming[e['to']].append(e['from'])
    indegree = {nid: len(ins) for nid, ins in incoming.items()}
    queue = [nid for nid, deg in indegree.items() if deg == 0]
    order = []
    while queue:
        nid = queue.pop(0)
        order.append(nid)
        for e in edges:
            if e.get('from') == nid:
                nxt = e['to']
                if nxt in indegree:
                    indegree[nxt] -= 1
                    if indegree[nxt] == 0:
                        queue.append(nxt)
    if len(order) != len(nodes):
        raise RuntimeError('智能体存在循环依赖，请检查连线')
    return order

def find_skill(skill_list, skill_id):
    for a in skill_list:
        if a.get('id') == skill_id:
            return a
    return None

def run_agent(agent, config, user_message, registry, session=None):
    messages = [{'role': 'system', 'content': agent.get('systemPrompt') or ''}]
    if session and session.get('messages'):
        messages.extend(session['messages'][-10:])
    messages.append({'role': 'user', 'content': user_message})
    schemas = tools.build_tool_schemas(agent, registry)
    for _ in range(MAX_ROUNDS):
        resp = llm.chat(config, messages, schemas or None)
        calls = resp.get('tool_calls')
        if not calls:
            return resp.get('content') or ''
        messages.append({
            'role': 'assistant',
            'content': None,
            'tool_calls': [
                {'id': c['id'], 'type': 'function',
                 'function': {'name': c['name'], 'arguments': c['arguments']}}
                for c in calls
            ],
        })
        for c in calls:
            try:
                args = json.loads(c.get('arguments') or '{}')
            except Exception:
                args = {}
            result = tools.exec_tool(registry, c['name'], args)
            messages.append({'role': 'tool', 'tool_call_id': c['id'], 'content': result})
    return '(已达到工具调用轮数上限)'

def _node_tool_agent(manifest, node, config, registry, message):
    # 自定义输入/输出节点：链接了工具时，由默认技能 assistant 加工消息内容
    agent = find_skill(manifest.get('skills') or [], 'assistant')
    if not agent:
        raise RuntimeError('节点配置了工具，但默认技能 assistant 不存在')
    eff_agent = dict(agent)
    node_tools = [t for t in (node.get('tools') or []) if t]
    if node_tools:
        eff_agent['tools'] = list(dict.fromkeys(list(agent.get('tools') or []) + node_tools))
    return run_agent(eff_agent, config, message, registry, None)

def run_graph(manifest, nodes, edges, config, user_message, registry, stack):
    # 单次图执行：返回 {'outputs': {...}, 'finals': [...]}；子智能体节点递归调用
    # 捕获输出节点 id（带工具的输出节点会临时伪装成 skill，不能用 type 判断）
    output_ids = set(n['id'] for n in nodes if n.get('type') == 'output')
    by_id = {n['id']: n for n in nodes}
    # 前向边（数据/消息/广播）：参与拓扑与文本传递；挂接边（pointId）只表达挂接关系；回调边（callback）不参与拓扑（回环重跑仅桌面端 JS 引擎支持，导出端按单向传递）
    forward = [e for e in edges if not e.get('pointId') and e.get('type') != 'callback']
    bus_attached = set(e.get('from') for e in edges if e.get('pointId'))
    order = topo_sort(nodes, forward)
    outputs = {}
    for node_id in order:
        node = by_id.get(node_id)
        if not node:
            continue
        if node_id in bus_attached:
            outputs[node_id] = ''
            continue
        upstream = []
        for e in edges:
            if e.get('to') == node_id and not e.get('pointId') and e.get('type') != 'callback' and eval_cond(e.get('when'), outputs.get(e.get('from'))):
                v = outputs.get(e.get('from'))
                if v is not None and v != '':
                    upstream.append(v)
        if node.get('type') == 'input':
            val = user_message if user_message else str(node.get('text') or '')
            if not (node.get('tools') or []):
                outputs[node_id] = val
            else:
                # 自定义输入：链接了工具 → 由默认技能 assistant 加工处理
                outputs[node_id] = _node_tool_agent(manifest, node, config, registry, val)
        elif node.get('type') == 'output':
            msg = '\n\n'.join(upstream)
            if not (node.get('tools') or []):
                outputs[node_id] = msg
            else:
                # 自定义输出：链接了工具 → 由默认技能 assistant 加工上游结果
                outputs[node_id] = _node_tool_agent(manifest, node, config, registry, msg)
        elif node.get('type') == 'subagent':
            sub_id = node.get('subagentId') or ''
            if not sub_id:
                outputs[node_id] = '（子智能体节点未选择智能体）'
                continue
            if sub_id in stack:
                outputs[node_id] = '（检测到智能体循环引用: %s）' % sub_id
                continue
            sub = (manifest.get('subAgents') or {}).get(sub_id)
            if not sub:
                outputs[node_id] = '（子智能体不存在: %s）' % sub_id
                continue
            stack.add(sub_id)
            try:
                sub_res = run_graph(manifest, sub.get('nodes') or [], sub.get('edges') or [], config, '\n\n'.join(upstream), registry, stack)
            finally:
                stack.discard(sub_id)
            outputs[node_id] = '\n\n---\n\n'.join(sub_res['finals'])
        elif node.get('type') == 'flow':
            # 控制流：汇聚（合并上游）/ 分支（透传，分流由下游边 when 条件过滤）/ 循环（输入重复 N 次）
            ft = node.get('flowType') or 'merge'
            input_txt = '\n\n'.join(upstream)
            if ft == 'loop':
                n = max(1, int(node.get('maxLoops') or 3))
                outputs[node_id] = ('\n\n'.join([input_txt] * n)) if input_txt else ''
            else:
                outputs[node_id] = input_txt
        elif node.get('type') == 'custom':
            # 自定义模块节点：执行用户定义的 Python 代码（def run(input_text)）
            _ns = {}
            try:
                exec(node.get('code') or '', _ns)
                fn = _ns.get('run')
                outputs[node_id] = str(fn('\n\n'.join(upstream))) if fn else ('[自定义模块未定义 run]')
            except Exception as ex:
                outputs[node_id] = '[自定义模块执行失败] %s' % ex
        elif node.get('type') == 'tool':
            # 工具节点：内联 Python（直接执行 def run）或登记能力标记
            if node.get('mode') == 'inline' and node.get('code'):
                _ns = {}
                try:
                    exec(node.get('code') or '', _ns)
                    fn = _ns.get('run')
                    outputs[node_id] = str(fn('\n\n'.join(upstream))) if fn else ('[内联工具未定义 run]')
                except Exception as ex:
                    outputs[node_id] = '[内联工具执行失败] %s' % ex
            else:
                outputs[node_id] = '[工具能力] %s' % (node.get('toolId') or '')
        elif node.get('type') == 'memory':
            # 记忆节点：读取接口把记忆内容读出作为输出；写入接口把上游内容追加写入记忆
            mem_arch = node.get('memoryArch') or ''
            mem_root = os.path.join(config.get('_bundle_root') or '.', 'memory')
            def _mem_file(arch, sc):
                if not arch:
                    return None
                safe = re.sub(r'[\\/:*?"<>|]', '_', str(arch))
                fname_map = {'policy': 'policy.md', 'facts': 'facts.md', 'episodes': 'episodes.md', 'skills': 'skills.md', 'ledger': 'ledger.md'}
                if str(sc) in fname_map:
                    return os.path.join(mem_root, safe, fname_map[str(sc)])
                rel = str(sc or '').lstrip('/\\')
                p = os.path.normpath(os.path.join(mem_root, safe, rel))
                root = os.path.normpath(os.path.join(mem_root, safe)) + os.sep
                if not p.startswith(root):
                    return None
                return p
            input_txt = '\n\n'.join(upstream)
            for w in (node.get('writes') or []):
                arch = w.get('arch') or mem_arch
                sc = str(w.get('scope') or 'episodes')
                if sc in ('ledger', 'ledger.md'):
                    continue
                fp = _mem_file(arch, sc)
                if not fp:
                    continue
                try:
                    os.makedirs(os.path.dirname(fp), exist_ok=True)
                    cur = ''
                    if os.path.exists(fp):
                        with open(fp, encoding='utf-8') as f:
                            cur = f.read()
                    with open(fp, 'w', encoding='utf-8') as f:
                        f.write((cur.rstrip() + '\n' if cur else '') + input_txt + '\n')
                except Exception:
                    pass
            out_parts = []
            for r in (node.get('reads') or []):
                arch = r.get('arch') or mem_arch
                sc = str(r.get('scope') or 'facts')
                fp = _mem_file(arch, sc)
                if not fp:
                    continue
                content = ''
                try:
                    if os.path.exists(fp):
                        with open(fp, encoding='utf-8') as f:
                            content = f.read()
                except Exception:
                    content = ''
                out_parts.append('==== %s / %s ====\n%s' % (arch, sc, content))
            outputs[node_id] = '\n\n'.join(out_parts)
        elif node.get('type') == 'bus':
            # 通信总线（外部挂接式）：数据从左到右，外部节点（技能/记忆）拖线挂到连接点（points）上按序处理
            points = sorted((node.get('points') or []), key=lambda a: float(a.get('x') or 0))
            if not points:
                # 无连接点：按总线自身区域权限透传（兼容旧行为）
                read_zones = to_zone_list(node.get('readZones'))
                write_zones = to_zone_list(node.get('writeZones'))
                filtered = [filter_read_zones(u, read_zones) for u in upstream]
                filtered = [f for f in filtered if f and f.strip()]
                outputs[node_id] = filter_write_zones('\n\n'.join(filtered), write_zones)
            else:
                # 总线入口数据：仅普通数据流上游（挂接连线不作为文本输入）
                flow_up = [outputs.get(e.get('from')) for e in edges if e.get('to') == node_id and not e.get('pointId') and e.get('type') != 'callback']
                cur = '\n\n'.join([u for u in flow_up if u and str(u).strip()])
                mem_root = os.path.join(config.get('_bundle_root') or '.', 'memory')
                for pt in points:
                    att_nodes = [by_id.get(e.get('from')) for e in edges if e.get('to') == node_id and e.get('pointId') == pt.get('id')]
                    att_nodes = [n for n in att_nodes if n]
                    if not att_nodes:
                        cur = (cur + '\n\n' if cur else '') + '（连接点未挂接节点）'
                        continue
                    read_zones = to_zone_list(pt.get('readZones'))
                    write_zones = to_zone_list(pt.get('writeZones'))
                    for att_node in att_nodes:
                        input_txt = filter_read_zones(cur, read_zones)
                        if att_node.get('type') == 'skill':
                            skill_id = str(att_node.get('skillId') or '')
                            agent = find_skill(manifest.get('skills') or [], skill_id)
                            if not agent:
                                cur = (cur + '\n\n' if cur else '') + ('（连接点挂接技能不存在: %s）' % (skill_id or '(空)'))
                                continue
                            parts = []
                            prompt = str(att_node.get('prompt') or '').strip()
                            if prompt:
                                parts.append(prompt)
                            if read_zones:
                                parts.append('你被授权的可读区域：%s。输出时可用 [[区域名]] ... [[/区域名]] 标记内容，供下游按权限读取。' % '、'.join(read_zones))
                            if input_txt and input_txt.strip():
                                parts.append(input_txt)
                            if not parts:
                                parts.append('（无上游输入，请补充输入或连线）')
                            out = run_agent(dict(agent), config, '\n\n'.join(parts), registry, None)
                            cur = filter_write_zones(out, write_zones)
                        elif att_node.get('type') == 'memory':
                            # 记忆节点挂接：写接口把总线内容写入记忆；读接口把记忆内容读出写回总线
                            mem_arch = str(att_node.get('memoryArch') or '')
                            def _mem_file(arch, sc):
                                if not arch:
                                    return None
                                safe = re.sub(r'[\\/:*?"<>|]', '_', str(arch))
                                fname_map = {'policy': 'policy.md', 'facts': 'facts.md', 'episodes': 'episodes.md', 'skills': 'skills.md', 'ledger': 'ledger.md'}
                                if str(sc) in fname_map:
                                    return os.path.join(mem_root, safe, fname_map[str(sc)])
                                rel = str(sc or '').lstrip('/\\')
                                p = os.path.normpath(os.path.join(mem_root, safe, rel))
                                root = os.path.normpath(os.path.join(mem_root, safe)) + os.sep
                                if not p.startswith(root):
                                    return None
                                return p
                            for w in (att_node.get('writes') or []):
                                arch = w.get('arch') or mem_arch
                                sc = str(w.get('scope') or 'episodes')
                                if sc in ('ledger', 'ledger.md'):
                                    continue
                                fp = _mem_file(arch, sc)
                                if not fp:
                                    continue
                                try:
                                    os.makedirs(os.path.dirname(fp), exist_ok=True)
                                    cur_txt = ''
                                    if os.path.exists(fp):
                                        with open(fp, encoding='utf-8') as f:
                                            cur_txt = f.read()
                                    with open(fp, 'w', encoding='utf-8') as f:
                                        f.write((cur_txt.rstrip() + '\n' if cur_txt else '') + input_txt + '\n')
                                except Exception:
                                    pass
                            out_parts = []
                            for r in (att_node.get('reads') or []):
                                arch = r.get('arch') or mem_arch
                                sc = str(r.get('scope') or 'facts')
                                fp = _mem_file(arch, sc)
                                if not fp:
                                    continue
                                content = ''
                                try:
                                    if os.path.exists(fp):
                                        with open(fp, encoding='utf-8') as f:
                                            content = f.read()
                                except Exception:
                                    content = ''
                                out_parts.append('==== %s / %s ====\n%s' % (arch, sc, content))
                            cur = filter_write_zones('\n\n'.join(out_parts) if out_parts else input_txt, write_zones)
                        else:
                            cur = (cur + '\n\n' if cur else '') + ('（连接点不支持挂接 %s 节点）' % att_node.get('type'))
                outputs[node_id] = cur
        elif node.get('type') == 'skill':
            agent = find_skill(manifest.get('skills') or [], node.get('skillId'))
            if not agent:
                raise RuntimeError('技能不存在: %s' % node.get('skillId'))
            # 节点级工具链接：与技能自带工具取并集
            eff_agent = dict(agent)
            node_tools = [t for t in (node.get('tools') or []) if t]
            if node_tools:
                eff_agent['tools'] = list(dict.fromkeys(list(agent.get('tools') or []) + node_tools))
            read_zones = to_zone_list(node.get('readZones'))
            write_zones = to_zone_list(node.get('writeZones'))
            parts = []
            prompt = (node.get('prompt') or '').strip()
            if prompt:
                parts.append(prompt)
            if read_zones:
                parts.append('你被授权的可读区域：%s。输出时可用 [[区域名]] ... [[/区域名]] 标记内容，供下游按权限读取。' % '、'.join(read_zones))
            filtered = [filter_read_zones(u, read_zones) for u in upstream]
            filtered = [f for f in filtered if f and f.strip()]
            parts.extend(filtered)
            if not parts:
                parts.append('（无上游输入，请补充输入或连线）')
            content = run_agent(eff_agent, config, '\n\n'.join(parts), registry, None)
            outputs[node_id] = filter_write_zones(content, write_zones)
    finals = []
    for n in nodes:
        if n.get('id') in output_ids and outputs.get(n.get('id')):
            finals.append(outputs[n['id']])
    return {'outputs': outputs, 'finals': finals}

def run_la(manifest, config, user_message, session_id=None, session_store=None):
    wf = manifest.get('agent') or {}
    registry = config.get('_tools', {})
    session = None
    if session_store:
        session = session_store.get(session_id) if session_id else None
        if session is None:
            session = session_store.create(manifest.get('id'))
    if session is not None:
        session['messages'].append({'role': 'user', 'content': user_message})
    result = run_graph(manifest, wf.get('nodes') or [], wf.get('edges') or [], config, user_message, registry, set())
    if session is not None:
        session['messages'].append({'role': 'assistant', 'content': result['finals'][0] if result['finals'] else ''})
        session_store.save(session)
    return {'content': '\n\n---\n\n'.join(result['finals']), 'sessionId': session['id'] if session else None}
