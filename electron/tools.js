// 工具执行器：内置工作区工具 + 记忆工具 + 智能体工具 + MCP 工具
// LLM 函数名规则：内置工具用原名（list_dir/read_file/write_file/run_agent/memory_*），
// MCP 工具用 `mcp_<toolName>`（LLM 对函数名只允许字母数字下划线）
const fs = require('fs')
const path = require('path')
const workspace = require('./workspace')
const mcp = require('./mcp')
const memory = require('./memory')

// 智能体运行时（由 main.js 注入：agentStore + settings）
let runtime = { agentStore: null, getSettings: () => ({}) }
function registerAgentRuntime(r) {
  runtime = { ...runtime, ...r }
}

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

async function execTool(name, rawArgs, ctx) {
  const args = parseArgs(rawArgs)
  if (args.__parse_error__) {
    return JSON.stringify({ error: '参数解析失败: ' + args.__parse_error__ })
  }
  try {
    // MCP 工具分发
    if (name.startsWith('mcp_')) {
      const toolName = name.slice(4)
      if (!mcp.findTool(toolName)) {
        return JSON.stringify({ error: `MCP 工具不存在: ${toolName}` })
      }
      return await mcp.execTool(toolName, args)
    }
    // 内置工作区工具
    switch (name) {
      case 'list_dir': {
        const list = workspace.listDir(args.path || '.')
        return JSON.stringify(list, null, 2).slice(0, 8000)
      }
      case 'read_file': {
        if (!args.path) throw new Error('缺少 path 参数')
        return workspace.readFile(args.path)
      }
      case 'write_file': {
        if (!args.path || typeof args.content !== 'string') throw new Error('缺少 path/content 参数')
        workspace.writeFile(args.path, args.content)
        return JSON.stringify({ ok: true, path: args.path, message: '文件已写入' })
      }
      case 'run_agent': {
        return await runAgentTool(args)
      }
      case 'memory_read':
      case 'memory_write':
      case 'memory_append':
      case 'memory_search':
      case 'memory_forget': {
        return memoryTool(name, args, ctx)
      }
      default:
        return JSON.stringify({ error: '未知工具: ' + name })
    }
  } catch (e) {
    return JSON.stringify({ error: e.message || String(e) })
  }
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

module.exports = { execTool, registerAgentRuntime, runAgentTool }
