// ============================================================
// MCP Server（Model Context Protocol，SSE 传输）
// 让 Trae / Claude / Cursor 等外部 AI 通过标准 MCP 协议调用本 Harness：
//   列出/运行智能体、运行技能、调用内置工具（如电机 PID 串口）、读写记忆
// 接入方式（在外部 AI 的 MCP 配置里添加 HTTP Server）：
//   URL: http://127.0.0.1:37800/mcp/sse   （启用 API 服务后）
//   若设置里配置了 API Token，则需带 Authorization: Bearer <token>
// ============================================================
const crypto = require('crypto')
const path = require('path')
const fs = require('fs')

let deps = null // { getSettings, agentStore, agent, skills, toolPacks, memory, runPythonFile }
const sessions = new Map() // sessionId -> SSE response（保持的连接）

const SERVER_INFO = { name: 'LAG harness MCP', version: '0.1.0' }
const PROTOCOL_VERSION = '2025-03-26'

// ---------------- MCP 工具定义（描述供外部 AI 理解调用） ----------------

function tool(name, description, properties, required = []) {
  return {
    name,
    description,
    inputSchema: { type: 'object', properties, required }
  }
}

const MCP_TOOLS = [
  tool('get_health', '查看 Harness 是否在线、工作区根目录、智能体/技能数量。任何 AI 接入后应先调用本工具确认服务可用。', {
    // 无参数
  }),
  tool('list_agents', '列出所有智能体（画布工作流）：id、名称、节点数。拿到 id 后可调用 run_agent。', {}),
  tool('run_agent', '运行一个智能体（画布工作流）：把输入文本灌入其输入节点，返回智能体最终输出。适合让 Harness 画布执行多节点协作任务。',
    {
      agentId: { type: 'string', description: '智能体 id（来自 list_agents）' },
      input: { type: 'string', description: '要交给智能体的输入文本' },
      model: { type: 'string', description: '可选，覆盖模型名' }
    },
    ['agentId', 'input']
  ),
  tool('list_skills', '列出所有技能（LLM 技能包）：id、名称、描述。', {}),
  tool('run_skill', '运行一个 Python 技能文件的 main 入口，返回其输出。适合执行纯计算/工具型技能。',
    {
      skillId: { type: 'string', description: '技能 id（来自 list_skills）' },
      rel: { type: 'string', description: '可选，技能内相对文件路径；默认运行 main 入口' }
    },
    ['skillId']
  ),
  tool('list_mcp_tools', '列出 Harness 内置的全部工具包及其工具（含「电机 PID 串口」等）：工具名 + 用途描述。调用前先看这里。', {}),
  tool('call_mcp_tool', '调用一个内置工具（如电机串口 motor_connect / motor_set_pid / motor_read_samples）。参数按 list_mcp_tools 给出的 schema。',
    {
      name: { type: 'string', description: '工具名，如 motor_connect、motor_set_pid、motor_command' },
      args: { type: 'object', description: '工具参数对象，如 {"port":"COM3"}' }
    },
    ['name']
  ),
  tool('memory_read', '读取记忆架构的某个作用域内容（如 facts / episodes）。',
    {
      arch: { type: 'string', description: '记忆架构名（目录名）' },
      scope: { type: 'string', description: '作用域文件，默认 facts' }
    },
    ['arch']
  ),
  tool('memory_write', '向记忆架构的某个作用域追加内容（用于沉淀经验/调参历史）。',
    {
      arch: { type: 'string', description: '记忆架构名' },
      scope: { type: 'string', description: '作用域文件，默认 episodes' },
      content: { type: 'string', description: '要追加的内容' }
    },
    ['arch', 'content']
  )
]

// ---------------- 工具执行 ----------------

async function execTool(name, args) {
  args = args || {}
  switch (name) {
    case 'get_health': {
      const s = deps.getSettings()
      let skills = []
      let agents = []
      try { skills = await deps.skills.list() } catch {}
      try { agents = deps.agentStore ? deps.agentStore.list() : [] } catch {}
      return `在线。工作区根: ${s.workspace || '(未打开)'}；技能 ${skills.length} 个，智能体 ${agents.length} 个。API Token 已${s.apiToken ? '配置' : '未配置'}。`
    }
    case 'list_agents': {
      const list = deps.agentStore ? deps.agentStore.list() : []
      if (!list.length) return '暂无智能体。'
      return list.map((a) => `- ${a.name} | id=${a.id} | ${(a.nodes || []).length} 节点`).join('\n')
    }
    case 'run_agent': {
      const agentId = String(args.agentId || '')
      const ag = deps.agentStore ? deps.agentStore.get(agentId) : null
      if (!ag) throw new Error('智能体不存在: ' + agentId)
      const inputs = {}
      for (const n of ag.nodes || []) if (n.type === 'input') inputs[n.id] = String(args.input || '')
      const controller = new AbortController()
      const res = await deps.agent.runAgent({
        agent: ag,
        agentStore: deps.agentStore,
        settings: deps.getSettings(),
        model: args.model || undefined,
        inputs,
        signal: controller.signal,
        auditDir: deps.auditDir,
        onToken: () => {},
        onStatus: () => {},
        onOutput: () => {}
      })
      return String(res.result == null ? '' : res.result)
    }
    case 'list_skills': {
      const list = await deps.skills.list()
      if (!list.length) return '暂无技能。'
      return list.map((s) => `- ${s.name} | id=${s.id} | ${(s.description || '').slice(0, 80)}`).join('\n')
    }
    case 'run_skill': {
      const id = String(args.skillId || '')
      const file = args.rel ? deps.skills.resolveInSkill(id, args.rel) : deps.skills.getSourceFile(id)
      if (!file || !fs.existsSync(file)) throw new Error('技能文件不存在: ' + id)
      if (!String(file).endsWith('.py')) return '仅支持运行 Python 技能文件。'
      return await deps.runPythonFile(file)
    }
    case 'list_mcp_tools': {
      const r = await deps.toolPacks.list()
      const packs = r.toolPacks || []
      if (!packs.length) return '暂无内置工具包。'
      const lines = []
      for (const p of packs) {
        lines.push(`【${p.name}】${p.description || ''}`)
        for (const t of p.tools || []) {
          lines.push(`  - ${t.name}: ${t.description || ''}`)
        }
      }
      return lines.join('\n')
    }
    case 'call_mcp_tool': {
      const value = await deps.toolPacks.execTool(String(args.name || ''), args.args || {})
      return String(value == null ? '' : value)
    }
    case 'memory_read': {
      const arch = String(args.arch || '')
      const scope = String(args.scope || 'facts')
      const p = deps.memory.resolveInArch(arch, scope)
      if (!p || !fs.existsSync(p)) return `记忆 ${arch}/${scope} 无内容`
      return fs.readFileSync(p, 'utf8')
    }
    case 'memory_write': {
      const arch = String(args.arch || '')
      const scope = String(args.scope || 'episodes')
      const p = deps.memory.resolveInArch(arch, scope)
      if (!p) throw new Error('记忆架构不存在: ' + arch)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
      fs.writeFileSync(p, (cur ? cur.replace(/\s*$/, '') + '\n' : '') + String(args.content || '') + '\n', 'utf8')
      return `已写入 ${arch}/${scope}`
    }
    default:
      throw new Error('未知 MCP 工具: ' + name)
  }
}

// ---------------- JSON-RPC 处理 ----------------

async function handleRpc(msg, sessionId) {
  const method = msg && msg.method
  const id = msg && msg.id
  const respond = (result, isError) => {
    const payload = { jsonrpc: '2.0', id }
    if (isError) {
      payload.error = { code: -32000, message: String(result && (result.message || result)) }
    } else {
      payload.result = result
    }
    sendEvent(sessionId, payload)
  }

  try {
    if (method === 'initialize') {
      return respond({
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: SERVER_INFO
      })
    }
    if (method === 'notifications/initialized') return
    if (method === 'tools/list') {
      return respond({ tools: MCP_TOOLS })
    }
    if (method === 'tools/call') {
      const params = msg.params || {}
      const t = MCP_TOOLS.find((x) => x.name === params.name)
      if (!t) throw new Error('工具不存在: ' + params.name)
      const text = await execTool(t.name, params.arguments || {})
      return respond({ content: [{ type: 'text', text: String(text) }] })
    }
    if (method === 'ping') return respond({})
    throw new Error('未知方法: ' + method)
  } catch (e) {
    respond(e, true)
  }
}

function sendEvent(sessionId, payload) {
  const res = sessions.get(sessionId)
  if (!res || res.writableEnded) return
  res.write(`event: message\ndata: ${JSON.stringify(payload)}\n\n`)
}

// ---------------- HTTP 接入（由 api-server 调用） ----------------

function onSse(req, res) {
  const sessionId = crypto.randomBytes(12).toString('hex')
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })
  res.write(`event: endpoint\ndata: /mcp/messages?sessionId=${sessionId}\n\n`)
  sessions.set(sessionId, res)
  res.on('close', () => sessions.delete(sessionId))
  res.on('error', () => sessions.delete(sessionId))
}

async function onMessage(req, res, url) {
  const sessionId = url.searchParams.get('sessionId')
  if (!sessionId || !sessions.has(sessionId)) {
    res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' })
    return res.end(JSON.stringify({ jsonrpc: '2.0', error: { code: -32002, message: '无效的 sessionId，请先连接 /mcp/sse' } }))
  }
  let raw = ''
  req.on('data', (c) => {
    raw += c
    if (raw.length > 1024 * 1024) req.destroy()
  })
  req.on('end', () => {
    res.writeHead(202, { 'Content-Type': 'application/json; charset=utf-8' })
    res.end('{}')
    let msg = null
    try { msg = JSON.parse(raw) } catch {}
    if (msg) handleRpc(msg, sessionId)
  })
  req.on('error', () => {})
}

function init({ getSettings, agentStore, agent, skills, toolPacks, memory, runPythonFile, auditDir }) {
  deps = { getSettings, agentStore, agent, skills, toolPacks, memory, runPythonFile, auditDir }
}

module.exports = { init, onSse, onMessage, MCP_TOOLS }
