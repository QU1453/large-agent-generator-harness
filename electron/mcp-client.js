// 外部 MCP 客户端：Harness 作为标准 MCP 客户端接入外部 MCP Server
// 支持两种传输：
//   stdio —— 本地命令启动（command [args]），JSON-RPC 走子进程 stdin/stdout
//   http  —— Streamable HTTP（POST JSON-RPC 到 URL；兼容 SSE 响应流）
// 配置存 data/external-mcps.json；启动时连接 enabled 的 server，工具并入智能体工具列表
// （内部工具包是自研声明格式；外部 MCP 走标准 MCP 协议，二者并存）
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')

const DATA_DIR = process.env.AI_HARNESS_DATA || path.join('D:', path.sep, 'Project', 'Harness', 'data')
const CONFIG_PATH = path.join(DATA_DIR, 'external-mcps.json')
const PROTOCOL_VERSION = '2025-03-26'
const REQ_TIMEOUT = 15000

// ---------------- 配置存储 ----------------
let servers = [] // { id, name, type, command, args[], url, headers?, enabled, conn, status, error, tools }
const byId = new Map()

function loadConfig() {
  try {
    if (!fs.existsSync(CONFIG_PATH)) return []
    const d = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'))
    return Array.isArray(d) ? d : []
  } catch { return [] }
}

function saveConfig() {
  const plain = servers.map(({ id, name, type, command, args, url, headers, enabled, category }) => ({ id, name, type, command, args, url, headers, enabled, category }))
  fs.mkdirSync(path.dirname(CONFIG_PATH), { recursive: true })
  fs.writeFileSync(CONFIG_PATH, JSON.stringify(plain, null, 2), 'utf8')
}

// ---------------- 单连接 ----------------
class MCPConnection {
  constructor(cfg) {
    this.cfg = cfg
    this.id = cfg.id
    this.proc = null
    this.buf = ''
    this.pending = new Map()
    this.nextId = 1
    this.ready = false
    this.tools = []
    this.error = null
  }

  async connect() {
    this.stop()
    this.pending = new Map()
    this.buf = ''
    this.error = null
    try {
      if (this.cfg.type === 'stdio') {
        await this._connectStdio()
      } else {
        await this._connectHttp()
      }
      // 握手：initialize → notifications/initialized → tools/list
      await this._request('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: { name: 'LAG harness', version: '0.1.0' }
      })
      this._notify('notifications/initialized', {})
      const r = await this._request('tools/list', {})
      this.tools = Array.isArray(r && r.tools) ? r.tools.map((t) => ({
        name: t.name,
        description: t.description || '',
        parameters: t.inputSchema || { type: 'object', properties: {} }
      })) : []
      this.ready = true
      this.error = null
    } catch (e) {
      this.ready = false
      this.error = e.message || String(e)
      this.tools = []
    }
    return this
  }

  _connectStdio() {
    return new Promise((resolve, reject) => {
      try {
        const args = Array.isArray(this.cfg.args) ? this.cfg.args : []
        this.proc = spawn(this.cfg.command, args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] })
        this.proc.stdout.setEncoding('utf8')
        this.proc.stdout.on('data', (d) => this._onData(d))
        this.proc.stderr.on('data', (d) => { /* 忽略或记日志 */ })
        this.proc.on('error', (e) => { this.error = e.message; reject(e) })
        this.proc.on('exit', () => { this.ready = false; this._failAll('外部 MCP 进程已退出') })
        setTimeout(resolve, 300) // 等待子进程就绪
      } catch (e) {
        reject(e)
      }
    })
  }

  async _connectHttp() {
    // 两种 http 传输：
    //   SSE：url 以 /mcp/sse 结尾 → GET 建立 SSE 会话拿 sessionId，后续 POST /mcp/messages?sessionId=
    //   Streamable HTTP：直接 POST JSON-RPC 到 url（响应 JSON 或 SSE 流）
    this.sseSessionId = null
    this.sseStream = null
    this.sseBuf = ''
    if (/\/mcp\/sse(\?|$)/.test(this.cfg.url || '')) {
      await this._connectSse()
    } else {
      // Streamable HTTP：先发 initialize（无鉴权试探），网络可达性由 _request 验证
      await new Promise((r) => setTimeout(r, 50))
    }
  }

  // SSE 传输：GET /mcp/sse 建立会话，服务端推 endpoint 事件带 sessionId；请求走 POST /mcp/messages?sessionId=
  _connectSse() {
    return new Promise((resolve, reject) => {
      const { net } = require('electron')
      const url = this.cfg.url
      net.fetch(url, {
        method: 'GET',
        headers: { Accept: 'text/event-stream', ...(this.cfg.headers || {}) }
      }).then(async (res) => {
        if (!res.ok) { reject(new Error(`MCP SSE ${res.status}`)); return }
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        this.sseStream = reader
        let buf = ''
        const timer = setTimeout(() => reject(new Error('SSE 会话建立超时')), 8000)
        const pump = async () => {
          try {
            const { done, value } = await reader.read()
            if (done) { this.ready = false; this._failAll('外部 MCP SSE 连接已关闭'); return }
            buf += decoder.decode(value, { stream: true })
            const lines = buf.split('\n')
            buf = lines.pop()
            let gotSession = false
            for (const line of lines) {
              const t = line.trim()
              if (!t.startsWith('data:')) continue
              const p = t.slice(5).trim()
              if (!p || p === '[DONE]') continue
              const m = p.match(/\/mcp\/messages\?sessionId=([0-9a-fA-F]+)/)
              if (m) {
                this.sseSessionId = m[1]
                gotSession = true
                continue
              }
              // 常规消息：路由到 pending（与 _onData 相同处理）
              try { this._handleMsg(JSON.parse(p)) } catch { /* 忽略 */ }
            }
            if (gotSession) {
              clearTimeout(timer)
              resolve()
            }
            pump()
          } catch (e) {
            clearTimeout(timer)
            reject(e)
          }
        }
        pump()
      }).catch(reject)
    })
  }

  // SSE 传输下：请求 POST 到 /mcp/messages?sessionId=xxx（见下方 _httpPost 开头分支）

  _onData(chunk) {
    this.buf += chunk
    const lines = this.buf.split('\n')
    this.buf = lines.pop()
    for (const line of lines) {
      const t = line.trim()
      if (!t) continue
      // SSE 行（event: / data:）或纯 JSON 行
      if (t.startsWith('event:') || t.startsWith(':')) continue
      if (t.startsWith('data:')) {
        const p = t.slice(5).trim()
        if (!p || p === '[DONE]') continue
        try { this._handleMsg(JSON.parse(p)) } catch { /* 忽略 */ }
        continue
      }
      try { this._handleMsg(JSON.parse(t)) } catch { /* 忽略非 JSON 行 */ }
    }
  }

  _handleMsg(msg) {
    if (msg && msg.id != null && this.pending.has(msg.id)) {
      const p = this.pending.get(msg.id)
      this.pending.delete(msg.id)
      if (msg.error) p.reject(new Error(msg.error.message || 'MCP 请求失败'))
      else p.resolve(msg.result)
    }
  }

  _failAll(err) {
    for (const [, p] of this.pending) p.reject(new Error(err))
    this.pending.clear()
  }

  _nextId() { return this.nextId++ }

  _notify(method, params) {
    const payload = { jsonrpc: '2.0', method, params }
    if (this.cfg.type === 'stdio' && this.proc) {
      this.proc.stdin.write(JSON.stringify(payload) + '\n')
    }
    // http 通知暂不发送（Streamable HTTP 通知需要 session，MVP 只做请求-响应）
  }

  async _request(method, params) {
    const id = this._nextId()
    const payload = { jsonrpc: '2.0', id, method, params }
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`MCP 请求超时: ${method}`))
      }, REQ_TIMEOUT)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })
    })
    if (this.cfg.type === 'stdio') {
      if (!this.proc) throw new Error('MCP 进程未启动')
      this.proc.stdin.write(JSON.stringify(payload) + '\n')
    } else {
      await this._httpPost(payload)
    }
    return p
  }

  async _httpPost(payload) {
    const { net } = require('electron')
    const url = this.cfg.url
    if (!url) throw new Error('缺少 MCP URL')
    // SSE 传输（url 以 /mcp/sse 结尾）：POST 到 messages 端点，结果经已建立的 SSE 流回
    if (this.sseSessionId) {
      const msgUrl = url.replace(/\/mcp\/sse(\?|$)/, '/mcp/messages?sessionId=' + this.sseSessionId)
      const res = await net.fetch(msgUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          ...(this.cfg.headers || {})
        },
        body: JSON.stringify(payload)
      })
      if (!res.ok) {
        let detail = ''
        try { detail = await res.text() } catch { /* 忽略 */ }
        throw new Error(`MCP HTTP ${res.status}: ${detail.slice(0, 300)}`)
      }
      // 202 + 空响应体：结果经 sseStream 的 _handleMsg 路由回 pending
      return
    }
    const res = await net.fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
        ...(this.cfg.headers || {})
      },
      body: JSON.stringify(payload)
    })
    if (!res.ok) {
      let detail = ''
      try { detail = await res.text() } catch { /* 忽略 */ }
      throw new Error(`MCP HTTP ${res.status}: ${detail.slice(0, 300)}`)
    }
    const ctype = (res.headers.get('content-type') || '').toLowerCase()
    if (ctype.includes('text/event-stream')) {
      // SSE：流式读 data: 行
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buf = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          const t = line.trim()
          if (!t.startsWith('data:')) continue
          const p = t.slice(5).trim()
          if (!p || p === '[DONE]') continue
          try { this._handleMsg(JSON.parse(p)) } catch { /* 忽略 */ }
        }
      }
    } else {
      const text = await res.text()
      try { this._handleMsg(JSON.parse(text)) } catch (e) { throw new Error('MCP 响应不是合法 JSON: ' + text.slice(0, 200)) }
    }
  }

  stop() {
    if (this.proc) {
      try { this.proc.kill() } catch { /* 忽略 */ }
      this.proc = null
    }
    this._failAll('外部 MCP 已断开')
    this.ready = false
  }

  async execTool(name, args) {
    const r = await this._request('tools/call', { name, arguments: args || {} })
    // 提取文本内容
    const content = Array.isArray(r && r.content) ? r.content
      .filter((c) => c && c.type === 'text')
      .map((c) => c.text)
      .join('\n') : ''
    return content || (r && r.error ? `MCP 错误: ${r.error}` : '（无输出）')
  }
}

// ---------------- 对外 API ----------------
function init() {
  servers = loadConfig().map((c) => {
    const cfg = { ...c, id: c.id || 'ext_' + crypto.randomUUID().slice(0, 8), category: c.category || '外部 MCP' }
    const conn = new MCPConnection(cfg)
    return { ...cfg, conn, status: 'idle', error: null, tools: [] }
  })
  byId.clear()
  for (const s of servers) byId.set(s.id, s)
  reload()
}

async function reload() {
  const results = await Promise.all(servers.map(async (s) => {
    if (!s.enabled) { s.status = 'disabled'; s.tools = []; s.error = null; return s }
    s.status = 'connecting'
    await s.conn.connect()
    s.status = s.conn.ready ? 'connected' : 'error'
    s.error = s.conn.error
    s.tools = s.conn.ready ? s.conn.tools : []
    return s
  }))
  return list()
}

function list() {
  return servers.map((s) => ({
    id: s.id,
    name: s.name,
    type: s.type,
    command: s.command || '',
    args: s.args || [],
    url: s.url || '',
    headers: s.headers || {},
    enabled: !!s.enabled,
    category: s.category || '外部 MCP',
    status: s.status || 'idle',
    error: s.error || null,
    tools: s.tools || []
  }))
}

function add(input) {
  const cfg = {
    id: 'ext_' + crypto.randomUUID().slice(0, 8),
    name: String(input.name || '外部 MCP').trim() || '外部 MCP',
    type: input.type === 'http' ? 'http' : 'stdio',
    command: String(input.command || '').trim(),
    args: Array.isArray(input.args) ? input.args : String(input.args || '').split(/\s+/).filter(Boolean),
    url: String(input.url || '').trim(),
    headers: input.headers || {},
    enabled: input.enabled !== false,
    category: String(input.category || '外部 MCP').trim() || '外部 MCP'
  }
  if (cfg.type === 'stdio' && !cfg.command) throw new Error('stdio 类型需要 command')
  if (cfg.type === 'http' && !cfg.url) throw new Error('http 类型需要 URL')
  servers.push({ ...cfg, conn: new MCPConnection(cfg), status: 'idle', error: null, tools: [] })
  byId.set(cfg.id, servers[servers.length - 1])
  saveConfig()
  reload()
  return list()
}

function update(id, patch) {
  const s = byId.get(id)
  if (!s) throw new Error('外部 MCP 不存在')
  if (patch.name != null) s.name = String(patch.name).trim() || s.name
  if (patch.type != null) s.type = patch.type === 'http' ? 'http' : 'stdio'
  if (patch.command != null) s.command = String(patch.command).trim()
  if (patch.args != null) s.args = Array.isArray(patch.args) ? patch.args : String(patch.args).split(/\s+/).filter(Boolean)
  if (patch.url != null) s.url = String(patch.url).trim()
  if (patch.headers != null) s.headers = patch.headers || {}
  if (patch.enabled != null) s.enabled = !!patch.enabled
  if (patch.category != null) s.category = String(patch.category).trim() || '外部 MCP'
  s.conn = new MCPConnection(s)
  saveConfig()
  reload()
  return list()
}

// 设置外部 MCP 的分类文件夹
function setCategory(id, category) {
  const s = byId.get(id)
  if (!s) throw new Error('外部 MCP 不存在')
  s.category = String(category || '外部 MCP').trim() || '外部 MCP'
  saveConfig()
  return list()
}

function remove(id) {
  const s = byId.get(id)
  if (!s) throw new Error('外部 MCP 不存在')
  if (s.conn) s.conn.stop()
  servers = servers.filter((x) => x.id !== id)
  byId.delete(id)
  saveConfig()
  return list()
}

// 全部可用外部工具（供 LLM schema 合并）
function allTools() {
  const out = []
  for (const s of servers) {
    if (!s.enabled || !s.conn || !s.conn.ready) continue
    for (const t of s.tools) out.push({ ...t, packId: `ext:${s.name}`, key: `ext:${t.name}` })
  }
  return out
}

async function execTool(name, args) {
  for (const s of servers) {
    if (!s.enabled || !s.conn || !s.conn.ready) continue
    if (s.tools.some((t) => t.name === name)) {
      try {
        const v = await s.conn.execTool(name, args || {})
        return typeof v === 'string' ? v : JSON.stringify(v, null, 2)
      } catch (e) {
        return JSON.stringify({ error: `外部 MCP「${s.name}」调用失败: ${e.message || e}` })
      }
    }
  }
  return JSON.stringify({ error: `外部 MCP 工具不存在: ${name}` })
}

function stopAll() {
  for (const s of servers) { try { s.conn && s.conn.stop() } catch { /* 忽略 */ } }
}

module.exports = { init, reload, list, add, update, setCategory, remove, allTools, execTool, stopAll }
