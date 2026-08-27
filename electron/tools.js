// 工具执行器：内置工作区工具 + 记忆工具 + 智能体工具 + 工具包工具
// LLM 函数名规则：内置工具用原名（list_dir/read_file/write_file/run_agent/memory_*），
// 工具包工具用 `tool_<toolName>`（LLM 对函数名只允许字母数字下划线；兼容旧名 `mcp_<toolName>`）
const fs = require('fs')
const path = require('path')
const workspace = require('./workspace')
const toolPacks = require('./tool-packs')
const mcpClient = require('./mcp-client')
const memory = require('./memory')

// 智能体运行时（由 main.js 注入：agentStore + settings）
let runtime = { agentStore: null, getSettings: () => ({}) }
function registerAgentRuntime(r) {
  runtime = { ...runtime, ...r }
}

// ---------------- 工具执行管道（P4-1）：注册式中间件 ----------------
// pre-execute:  async (info) => ({ allow: false, reason }) 拒绝执行；返回其他/undefined 放行
//              可原地修改 info.args 做参数规范；异常视为拒绝（fail-closed）
// post-execute: async (info) => 返回字符串则替换/丰富 info.result（如注入摘要、脱敏）
// info = { name, args, ctx, result, ok, error, durationMs }
const HOOKS = { 'pre-execute': [], 'post-execute': [] }

// 注册中间件，返回注销函数（注册即 Effect：可逆）
function hook(name, fn) {
  if (!HOOKS[name]) throw new Error('未知工具钩子: ' + name)
  HOOKS[name].push(fn)
  return () => {
    const i = HOOKS[name].indexOf(fn)
    if (i >= 0) HOOKS[name].splice(i, 1)
  }
}

// 审计消费者（main.js 启动时安装）：所有工具调用统一写 data/audit/tools.jsonl
let auditDir = null
function installAudit(dir) {
  auditDir = dir || null
  return hook('post-execute', (info) => {
    if (!auditDir) return
    try {
      fs.mkdirSync(auditDir, { recursive: true })
      const ctx = info.ctx || {}
      const record = {
        ts: Date.now(),
        name: info.name,
        args: String(JSON.stringify(info.args || {})).slice(0, 500),
        ok: info.ok,
        error: info.error || undefined,
        result: info.ok ? String(info.result || '').slice(0, 500) : undefined,
        durationMs: info.durationMs,
        sessionId: ctx.sessionId || undefined,
        agentId: ctx.agentId || undefined,
        nodeId: ctx.nodeId || undefined,
        skillId: ctx.skillId || undefined
      }
      fs.appendFileSync(path.join(auditDir, 'tools.jsonl'), JSON.stringify(record) + '\n', 'utf8')
    } catch { /* 审计失败不阻塞工具执行 */ }
  })
}

// 记忆消费者（默认安装）：节点绑定了记忆架构时，工具调用自动记入该记忆空间的 ledger 账本（溯源）
// 跳过 memory_* 工具（它们自身已写账本），避免重复记录
hook('post-execute', (info) => {
  const files = (info.ctx && info.ctx.memoryFiles) || []
  if (!files.length || String(info.name).startsWith('memory_')) return
  try {
    const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
    for (const f of files) {
      const cfg = memory.loadConfigAt(f.dir)
      if (cfg.ledger === false) continue
      const lp = path.join(f.dir, memory.FILE_NAMES.ledger)
      fs.mkdirSync(path.dirname(lp), { recursive: true })
      const cur = fs.existsSync(lp) ? fs.readFileSync(lp, 'utf8') : ''
      const summary = info.ok
        ? String(info.result || '').replace(/\s+/g, ' ').slice(0, 40)
        : (info.error || '').slice(0, 40)
      const line = `| ${ts} | tool | ${info.name} | ${summary} |`
      fs.writeFileSync(lp, (cur ? cur.replace(/\s*$/, '') + '\n' : '') + line + '\n', 'utf8')
    }
  } catch { /* 记忆记录失败不阻塞工具执行 */ }
})

function parseArgs(rawArgs) {
  let args = {}
  if (rawArgs) {
    try {
      args = typeof rawArgs === 'string' ? JSON.parse(rawArgs) : rawArgs
    } catch {
      return { __parse_error__: String(rawArgs).slice(0, 200) }
    }
  }
  return args
}

// 工具分发（管道 execute 阶段）：工具包工具 + 外部 MCP 工具 + 内置工具 + 记忆工具
function _dispatch(name, args, ctx) {
  // 外部 MCP 工具分发（LLM 函数名带 ext_ 前缀）
  if (name.startsWith('ext_')) {
    const toolName = name.slice(4)
    return mcpClient.execTool(toolName, args)
  }
  // 记忆脚本工具分发（mem_*，如 pid 调参三层记忆）：由记忆引擎执行
  if (name.startsWith('mem_')) {
    return memory.execMemScriptTool(name, args)
  }
  // 工具包工具分发（LLM 函数名带 tool_ 前缀；兼容旧名 mcp_）
  if (name.startsWith('tool_') || name.startsWith('mcp_')) {
    const toolName = name.slice(name.indexOf('_') + 1)
    if (!toolPacks.findTool(toolName)) {
      return Promise.resolve(JSON.stringify({ error: `工具包工具不存在: ${toolName}` }))
    }
    return toolPacks.execTool(toolName, args)
  }
  // 内置工作区工具
  switch (name) {
    case 'list_dir': {
      const list = workspace.listDir(args.path || '.')
      return Promise.resolve(JSON.stringify(list, null, 2).slice(0, 8000))
    }
    case 'read_file': {
      if (!args.path) throw new Error('缺少 path 参数')
      return Promise.resolve(workspace.readFile(args.path))
    }
    case 'write_file': {
      if (!args.path || typeof args.content !== 'string') throw new Error('缺少 path/content 参数')
      workspace.writeFile(args.path, args.content)
      return Promise.resolve(JSON.stringify({ ok: true, path: args.path, message: '文件已写入' }))
    }
    case 'run_agent': {
      return runAgentTool(args)
    }
    case 'memory_read':
    case 'memory_write':
    case 'memory_append':
    case 'memory_search':
    case 'memory_forget': {
      return Promise.resolve(memoryTool(name, args, ctx))
    }
    default:
      return Promise.resolve(JSON.stringify({ error: '未知工具: ' + name }))
  }
}

async function execTool(name, rawArgs, ctx) {
  const args = parseArgs(rawArgs)
  if (args.__parse_error__) {
    return JSON.stringify({ error: '参数解析失败: ' + args.__parse_error__ })
  }
  const started = Date.now()
  // pre-execute 管道：允许/拒绝（fail-closed：钩子抛异常视为拒绝）
  try {
    for (const h of [...HOOKS['pre-execute']]) {
      const d = await h({ name, args, ctx })
      if (d && d.allow === false) {
        return JSON.stringify({ error: d.reason || `工具 ${name} 被拒绝` })
      }
    }
  } catch (e) {
    return JSON.stringify({ error: `工具 ${name} 被拦截（pre-execute 异常）: ${e.message || e}` })
  }
  // execute
  let result = ''
  let ok = false
  let error = ''
  try {
    result = await _dispatch(name, args, ctx)
    ok = true
  } catch (e) {
    error = e.message || String(e)
    result = JSON.stringify({ error })
  }
  // post-execute 管道：替换/丰富/记录
  const info = { name, args, ctx, result, ok, error, durationMs: Date.now() - started }
  try {
    for (const h of [...HOOKS['post-execute']]) {
      const r = await h(info)
      if (typeof r === 'string') info.result = r
    }
  } catch { /* 后置钩子异常不吞掉工具结果 */ }
  return info.result
}

// 记忆工具：操作当前节点绑定的记忆架构目录（toolContext.memoryFiles）
// 每个架构 = 记忆空间目录（policy/facts/episodes/skills/ledger 五个 md + bus.md 等任意文件）：
//   memory_read     读（默认全部；scope 可指定某文件，含任意路径如 bus.md / notes/xxx.md）
//   memory_write    覆写（默认 facts；自动带 [[txn:…]] 时间戳）
//   memory_append   追加（默认 episodes；自动带 [[txn:…]] 时间戳）
//   memory_search   全文检索（大小写不敏感，返回命中文件与行号）
//   memory_forget   遗忘（删除匹配 query 的条目行；query 空=清空该文件，保留标题）
// 所有写操作自动追加 ledger 账本（只追加，溯源）
const MEMORY_SCOPES = ['policy', 'facts', 'episodes', 'skills', 'ledger']
function memoryTool(name, args, ctx) {
  const files = (ctx && ctx.memoryFiles) || []
  if (!files.length) return JSON.stringify({ error: '未绑定记忆（工作流节点未链接记忆架构）' })
  const memName = args.memory || files[0].name
  const f = files.find((x) => x.name === memName)
  if (!f) return JSON.stringify({ error: `记忆「${memName}」不在本节点绑定范围` })
  const dir = f.dir
  fs.mkdirSync(dir, { recursive: true })
  // 架构差异化配置：默认写入/追加文件、ledger/txn 开关（支持会话私有副本：从 dir 读 config.json）
  const cfg = memory.loadConfigAt(f.dir)
  const scopeFile = (sc) => {
    if (MEMORY_SCOPES.includes(sc)) return path.join(dir, memory.FILE_NAMES[sc])
    // 自定义路径（bus.md / notes/xxx.md 等）：仅允许架构目录内（会话副本则相对其 dir）
    const p = memory.resolveInDir(dir, sc)
    if (!p) throw new Error('路径越界')
    return p
  }
  const readSafe = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
  const txn = new Date().toISOString().slice(0, 10)
  const ts = new Date().toISOString().slice(0, 16).replace('T', ' ')
  const pickScope = (def) => {
    if (args.scope) {
      const sc = String(args.scope)
      if (MEMORY_SCOPES.includes(sc)) return sc
      // 自定义路径（如 bus.md）→ 原样返回，scopeFile 会做越界校验
      if (/\.md$/.test(sc) || sc.includes('/')) return sc
      return sc
    }
    const cfgKey = def === 'facts' ? 'writeScope' : def === 'episodes' ? 'appendScope' : null
    return (cfgKey && cfg.defaults && cfg.defaults[cfgKey]) || def
  }
  const logLedger = (op, sc, summary) => {
    if (cfg.ledger === false) return // 架构配置关闭账本
    const lp = scopeFile('ledger')
    const cur = readSafe(lp)
    const fname = memory.FILE_NAMES[sc] || sc
    const line = `| ${ts} | ${op} | ${fname} | ${String(summary || '').slice(0, 40)} |`
    fs.writeFileSync(lp, (cur ? cur.replace(/\s*$/, '') + '\n' : '') + line + '\n', 'utf8')
  }
  const withTxn = (content) => (cfg.txn === false || content.includes('[[txn:') ? content : `[[txn:${txn}]]\n${content}`)
  const isLedger = (sc) => sc === 'ledger' || sc === 'ledger.md'

  switch (name) {
    case 'memory_read': {
      const keys = args.scope && String(args.scope) ? [String(args.scope)] : MEMORY_SCOPES
      const parts = keys.map((sc) => {
        const fp = scopeFile(sc)
        const label = memory.FILE_NAMES[sc] || sc
        return `==== ${label} ====\n${readSafe(fp) || '（空）'}`
      })
      return parts.join('\n\n').slice(0, 20000)
    }
    case 'memory_write': {
      if (typeof args.content !== 'string') throw new Error('缺少 content 参数')
      const sc = pickScope('facts')
      if (isLedger(sc)) return JSON.stringify({ error: 'ledger 只追加，不能覆写' })
      const fp = scopeFile(sc)
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      fs.writeFileSync(fp, withTxn(args.content), 'utf8')
      logLedger('write', sc, args.content)
      return JSON.stringify({ ok: true, message: `记忆「${memName}」${memory.FILE_NAMES[sc] || sc} 已写入` })
    }
    case 'memory_append': {
      if (typeof args.content !== 'string') throw new Error('缺少 content 参数')
      const sc = pickScope('episodes')
      if (isLedger(sc)) return JSON.stringify({ error: 'ledger 由工具自动追加，不能手动写' })
      const fp = scopeFile(sc)
      fs.mkdirSync(path.dirname(fp), { recursive: true })
      const cur = readSafe(fp)
      const piece = `\n${withTxn(args.content)}`
      fs.writeFileSync(fp, (cur ? cur.replace(/\s*$/, '') + '\n' : '') + piece + '\n', 'utf8')
      logLedger('append', sc, args.content)
      return JSON.stringify({ ok: true, message: `已追加到记忆「${memName}」${memory.FILE_NAMES[sc] || sc}` })
    }
    case 'memory_search': {
      const q = String(args.query || '').trim()
      if (!q) return JSON.stringify({ error: '缺少 query 参数' })
      const hits = []
      for (const sc of MEMORY_SCOPES) {
        readSafe(scopeFile(sc)).split('\n').forEach((ln, i) => {
          if (ln.toLowerCase().includes(q.toLowerCase())) {
            hits.push({ file: memory.FILE_NAMES[sc], line: i + 1, text: ln.trim().slice(0, 120) })
          }
        })
      }
      if (!hits.length) return JSON.stringify({ ok: true, hits: [], count: 0, note: `未找到「${q}」` })
      return JSON.stringify({ ok: true, hits: hits.slice(0, 30), count: hits.length })
    }
    case 'memory_forget': {
      const sc = pickScope('facts')
      if (isLedger(sc)) return JSON.stringify({ error: '账本 ledger 不可删除' })
      const q = String(args.query || '').trim()
      const fp = scopeFile(sc)
      const lines = readSafe(fp).split('\n')
      if (!q) {
        fs.writeFileSync(fp, (lines[0] || `# ${memName}`) + '\n\n', 'utf8')
        logLedger('forget(清空)', sc, '全部')
        return JSON.stringify({ ok: true, message: `已清空记忆「${memName}」${memory.FILE_NAMES[sc] || sc}` })
      }
      const kept = lines.filter((ln) => !ln.toLowerCase().includes(q.toLowerCase()))
      const removed = lines.length - kept.length
      if (!removed) return JSON.stringify({ ok: true, removed: 0, note: `未找到匹配「${q}」的条目` })
      fs.writeFileSync(fp, kept.join('\n'), 'utf8')
      logLedger('forget', sc, `删除 ${removed} 条匹配「${q}」`)
      return JSON.stringify({ ok: true, removed, message: `已从记忆「${memName}」删除 ${removed} 条匹配「${q}」` })
    }
    default:
      return JSON.stringify({ error: '未知记忆工具: ' + name })
  }
}

// 运行智能体（作为 LLM 工具）：调用方需在 skill tools 中加入 'run_agent'
async function runAgentTool(args) {
  // 延迟 require 避免循环依赖（agent → chat → llm → tools）
  const agent = require('./agent')
  if (!runtime.agentStore) return JSON.stringify({ error: '智能体运行时未就绪' })
  const agId = args.agentId
  const agName = args.agentName
  let ag = agId ? runtime.agentStore.get(agId) : null
  if (!ag && agName) {
    ag = runtime.agentStore.list()
      .map((x) => runtime.agentStore.get(x.id))
      .find((w) => w && w.name === agName) || null
  }
  if (!ag) {
    const names = runtime.agentStore.list().map((x) => `${x.id}(${x.name})`).join('、')
    return JSON.stringify({ error: `智能体不存在，可用：${names || '（无）'}` })
  }
  const settings = runtime.getSettings()
  const res = await agent.runAgent({
    agent: ag,
    agentStore: runtime.agentStore,
    settings,
    inputs: args.inputs || {},
    onStatus: () => {},
    onOutput: () => {}
  })
  return JSON.stringify({ agentId: ag.id, agentName: ag.name, result: (res.result || '').slice(0, 8000) }, null, 2)
}

module.exports = { execTool, registerAgentRuntime, runAgentTool, hook, installAudit }
