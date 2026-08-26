// 外部 API 服务：供 Trae 等外部工具通过 HTTP 调用本 Harness
// 支持：列出智能体 / 会话管理 / 流式对话（SSE）
// 认证：可选 Bearer Token（设置中配置）
const http = require('http')
const { URL } = require('url')
const crypto = require('crypto')
const fs = require('fs')
const path = require('path')
const chat = require('./chat')
const skills = require('./skills')
const workspace = require('./workspace')
const mcpServer = require('./mcp-server')

let server = null
let settingsGetter = null
let team = null
let agentStore = null
let userDataDir = null

function json(res, code, data) {
  const body = JSON.stringify(data)
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(body)
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let raw = ''
    req.on('data', (c) => {
      raw += c
      if (raw.length > 2 * 1024 * 1024) {
        reject(new Error('请求体过大'))
        req.destroy()
      }
    })
    req.on('end', () => {
      try {
        resolve(raw ? JSON.parse(raw) : {})
      } catch {
        reject(new Error('请求体不是合法 JSON'))
      }
    })
    req.on('error', reject)
  })
}

function authed(req, res) {
  const token = settingsGetter().apiToken
  if (!token) return true
  if (req.headers.authorization === `Bearer ${token}`) return true
  json(res, 401, { error: '未授权：请携带 Authorization: Bearer <token>' })
  return false
}

async function handleChat(req, res) {
  const body = await readBody(req)
  const skillId = body.skillId || body.agentId || 'assistant'
  const message = String(body.message || body.content || '').trim()
  if (!message) return json(res, 400, { error: 'message 不能为空' })

  const sessionStore = chat.getSessionStore()
  let session = null
  if (body.sessionId) {
    session = sessionStore.get(body.sessionId)
    if (!session) return json(res, 404, { error: '会话不存在' })
  } else {
    session = sessionStore.create({ skillId })
  }

  session.messages.push({ role: 'user', content: message, ts: Date.now() })

  // SSE 响应头
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  })

  const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`)
  const abort = new AbortController()
  res.on('close', () => { abort.abort(); sessionStore.save(session) })

  try {
    send({ type: 'session', sessionId: session.id })
    const result = await chat.runChat({
      skillId,
      settings: settingsGetter(),
      userMessage: message,
      historyMessages: session.messages.slice(0, -1),
      session,
      signal: abort.signal,
      onToken: ({ content }) => send({ type: 'token', content }),
      onTool: ({ name, args, result }) => send({ type: 'tool', name, args, result }),
      onStatus: ({ status }) => send({ type: 'status', status })
    })
    session.messages.push({ role: 'assistant', content: result.content, ts: Date.now() })
    sessionStore.save(session)
    send({ type: 'done', sessionId: session.id, content: result.content, toolRounds: result.toolRounds })
  } catch (e) {
    if (!res.writableEnded) send({ type: 'error', error: e.message || String(e) })
  } finally {
    res.end()
  }
}

// ---------------- 团队路由（WiFi 团队开发，局域网放开，不校验 token） ----------------
async function teamAssets() {
  let skills_ = []
  let agents_ = []
  let memories_ = []
  let mcps_ = []
  try { skills_ = await skills.list() } catch { skills_ = [] }
  try { memories_ = require('./memory').list() } catch { memories_ = [] }
  try { agents_ = agentStore ? agentStore.list() : [] } catch { agents_ = [] }
  try { mcps_ = (await require('./mcp').list()).mcps || [] } catch { mcps_ = [] }
  // 成员归属：上传记录（assets 段）优先，否则归「主机」；skill/mcp 上传记录带扩展名，列表按 id 后缀匹配
  const owners = team ? team.assetOwners() : {}
  const own = (kind, name) => {
    if (owners[kind + '|' + name]) return owners[kind + '|' + name]
    for (const [k, o] of Object.entries(owners)) {
      if (k.startsWith(kind + '|')) {
        const kname = k.slice(kind.length + 1).replace(/\.(skill|mcp)\.(js|py)$/, '')
        if (kname === name) return o
      }
    }
    return '主机'
  }
  return {
    skills: skills_.map((s) => ({ id: s.id, name: s.name, avatar: s.avatar, description: (s.description || '').slice(0, 80), owner: own('skill', s.id) })),
    agents: agents_.map((a) => ({ id: a.id, name: a.name, nodes: (a.nodes || []).length, owner: own('agent', a.id) })),
    memories: memories_.map((m) => ({ name: m.name, title: m.title, desc: (m.desc || '').slice(0, 80), owner: own('memory', m.name) })),
    mcps: mcps_.map((t) => ({ id: t.name, name: t.name, description: (t.description || '').slice(0, 80), owner: own('toolPack', t.name) }))
  }
}

// 资产文件名白名单：只允许合法后缀，防路径穿越（兼容旧 .mcp.* 资产名）
function safeAssetName(kind, fileName) {
  const base = path.basename(String(fileName || ''))
  const ok =
    (kind === 'skill' && /^[\w\u4e00-\u9fa5-]+\.skill\.(js|py)$/.test(base)) ||
    (kind === 'toolPack' && /^[\w\u4e00-\u9fa5-]+\.(tool|mcp)\.(js|py)$/.test(base)) ||
    (kind === 'agent' && base.endsWith('.json'))
  return ok ? base : null
}

// 上传资产到主机（成员 → 主机）：校验 → 保存 → 记录归属 → 广播
async function teamUpload(body) {
  const kind = String(body.kind || '')
  const fileName = safeAssetName(kind, body.fileName)
  if (!fileName) return { ok: false, error: '文件类型/文件名不合法（需要 .skill.js/.skill.py/.tool.js/.tool.py/.json）' }
  const content = String(body.content == null ? '' : body.content)
  if (!content || content.length > 1024 * 1024) return { ok: false, error: '内容为空或超过 1MB' }
  const uploader = (team && team.getState().members[body.memberId] && team.getState().members[body.memberId].name) || '成员'

  if (kind === 'agent') {
    let ag
    try { ag = JSON.parse(content) } catch { return { ok: false, error: '智能体 JSON 解析失败' } }
    if (!ag || !ag.id || !ag.name) return { ok: false, error: '智能体缺少 id/name 字段' }
    if (ag.id && /[\\/:*?"<>|]/.test(ag.id)) return { ok: false, error: '智能体 id 含非法字符' }
    if (!Array.isArray(ag.nodes) || !Array.isArray(ag.edges)) return { ok: false, error: '智能体缺少 nodes/edges' }
    agentStore.save(ag)
    if (team) team.addAsset('agent', ag.id, uploader)
    return { ok: true, savedAs: `${ag.name}（${ag.id}）`, kind, title: ag.name }
  }
  if (kind === 'skill' || kind === 'toolPack') {
    const dir = path.join(userDataDir, kind === 'skill' ? 'skills' : 'tool-packs')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, fileName), content, 'utf8')
    if (kind === 'skill') await skills.reload()
    else await require('./tool-packs').reload()
    if (team) team.addAsset(kind, fileName, uploader)
    return { ok: true, savedAs: fileName, kind, title: fileName }
  }
  return { ok: false, error: '未知类型: ' + kind }
}

// 下载资产到成员（主机 → 成员）：返回原始文件内容
function teamDownload(kind, name) {
  const clean = String(name || '').replace(/[\\/:*?"<>|]/g, '_')
  if (kind === 'agent') {
    const ag = agentStore.get(clean)
    return ag ? JSON.stringify(ag, null, 2) : null
  }
  if (kind === 'skill' || kind === 'toolPack') {
    const dir = path.join(userDataDir, kind === 'skill' ? 'skills' : 'tool-packs')
    // name 可能是 id（assistant / py_eval）或完整文件名（上传记录存 fileName）
    let file = path.join(dir, clean)
    if (!fs.existsSync(file)) {
      const ext = kind === 'skill' ? 'skill' : '(tool|mcp)'
      file = [path.join(dir, `${clean}.${ext}.js`), path.join(dir, `${clean}.${ext}.py`)].find((c) => fs.existsSync(c)) || file
    }
    if (!fs.existsSync(file)) return null
    return fs.readFileSync(file, 'utf8')
  }
  return null
}

async function handleTeam(p, m, req, res) {
  if (p === '/api/team/join' && m === 'POST') {
    const body = await readBody(req)
    const r = team.join(body.name)
    return json(res, 200, { ...r, state: team.getState() })
  }
  if (p === '/api/team/state' && m === 'GET') {
    const url = new URL(req.url, 'http://localhost')
    const since = url.searchParams.get('since') || 0
    const memberId = url.searchParams.get('memberId') || ''
    if (memberId) team.touch(memberId)
    const d = team.sinceChannel(since)
    if (!Number(since)) Object.assign(d, await teamAssets()) // 首拉（since=0/空）附带资产列表
    return json(res, 200, d)
  }
  if (p === '/api/team/post' && m === 'POST') {
    const body = await readBody(req)
    const text = String(body.text || '').trim()
    if (!text) return json(res, 400, { error: '消息不能为空' })
    const mem = team.getState().members[body.memberId]
    const name = mem ? mem.name : '成员'
    team.touch(body.memberId)
    const msg = team.postText(text, name)
    if (/^@ai\s/i.test(text)) {
      // 异步托管给主机 assistant，回复写回频道（不阻塞本次响应）
      team.runAi(text, { settings: settingsGetter() }).catch(() => {})
    }
    return json(res, 200, { ok: true, msg })
  }
  if (p === '/api/team/upload' && m === 'POST') {
    const body = await readBody(req)
    const r = await teamUpload(body)
    if (r.ok) {
      team.touch(body.memberId)
      team.postText(`📤 上传了资产「${r.title}」`, team.getState().members[body.memberId] ? team.getState().members[body.memberId].name : '成员')
      return json(res, 200, r)
    }
    return json(res, 400, r)
  }
  if (p === '/api/team/download' && m === 'GET') {
    const url = new URL(req.url, 'http://localhost')
    const kind = url.searchParams.get('kind')
    const name = url.searchParams.get('name')
    const content = teamDownload(kind, name)
    if (content == null) return json(res, 404, { error: '资产不存在' })
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Disposition': 'attachment; filename="team-asset.txt"' })
    return res.end(content)
  }
  if (p === '/api/team/leave' && m === 'POST') {
    const body = await readBody(req)
    team.leave(body.memberId)
    return json(res, 200, { ok: true })
  }
  return json(res, 404, { error: '接口不存在: ' + p })
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost')
  const p = url.pathname
  const m = req.method

  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,DELETE,OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization')
  if (m === 'OPTIONS') {
    res.writeHead(204)
    return res.end()
  }

  try {
    // 团队控制台页面（浏览器成员入口，局域网放开）
    if (p === '/team' && m === 'GET') {
      const html = fs.readFileSync(path.join(__dirname, 'team-web.html'), 'utf8')
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      return res.end(html)
    }
    if (p.startsWith('/api/team/')) return handleTeam(p, m, req, res)

    if (!authed(req, res)) return

    // MCP Server（SSE 传输）：供 Trae / Claude 等外部 AI 调用
    if (p === '/mcp/sse' && m === 'GET') return mcpServer.onSse(req, res)
    if (p === '/mcp/messages' && m === 'POST') return mcpServer.onMessage(req, res, url)

    if (p === '/api/health' && m === 'GET') {
      return json(res, 200, { ok: true, app: 'LAG harness', workspace: workspace.getRoot() })
    }
    if (p === '/api/skills' && m === 'GET') {
      return json(res, 200, { skills: await skills.list() })
    }
    if (p === '/api/agents' && m === 'GET') {
      return json(res, 200, { agents: agentStore ? agentStore.list() : [] })
    }
    if (p === '/api/sessions' && m === 'GET') {
      return json(res, 200, { sessions: chat.getSessionStore().list() })
    }
    if (p === '/api/sessions' && m === 'POST') {
      const body = await readBody(req)
      const s = chat.getSessionStore().create({ title: body.title, skillId: body.skillId || body.agentId })
      return json(res, 201, { session: s })
    }
    if (p === '/api/sessions' && m === 'DELETE') {
      const body = await readBody(req)
      if (body.sessionId) chat.getSessionStore().remove(body.sessionId)
      return json(res, 200, { ok: true })
    }
    if (p === '/api/workspace' && m === 'GET') {
      return json(res, 200, { workspace: workspace.info() })
    }
    if (p === '/api/chat' && m === 'POST') {
      return handleChat(req, res)
    }
    return json(res, 404, { error: '接口不存在: ' + p })
  } catch (e) {
    if (!res.headersSent) return json(res, 500, { error: e.message || String(e) })
    res.end()
  }
}

function start({ getSettings, team: teamMod, agentStore: agStore, userDataDir: udd, agent, defStore, toolPacks, memory, runPythonFile, auditDir }) {
  settingsGetter = getSettings
  team = teamMod || null
  agentStore = agStore || null
  userDataDir = udd || null
  mcpServer.init({ getSettings, agentStore, agent, defStore, skills, toolPacks, memory, runPythonFile, auditDir, userDataDir })
  if (server) stop()
  const port = Number(settingsGetter().apiPort) || 37800
  // 团队模式（WiFi 团队开发）监听 0.0.0.0 供局域网访问；否则仅本机
  const host = settingsGetter().teamEnabled ? '0.0.0.0' : '127.0.0.1'
  server = http.createServer(handle)
  return new Promise((resolve, reject) => {
    server.once('error', (e) => {
      server = null
      reject(new Error(`API 服务启动失败（端口 ${port} 可能被占用）: ${e.message}`))
    })
    server.listen(port, host, () => {
      resolve({ port, host })
    })
  })
}

function stop() {
  if (server) {
    server.close()
    server = null
  }
}

function status() {
  if (!server) return { running: false }
  const port = Number(settingsGetter().apiPort) || 37800
  return { running: true, port, host: settingsGetter().teamEnabled ? '0.0.0.0' : '127.0.0.1' }
}

module.exports = { start, stop, status, teamAssets, teamDownload }
