// 智能体（Agent）：可视化编排多个 skill 协作完成复杂任务
// 节点类型：input(输入) / skill(能力单元) / tool(工具/MCP)
//          / subagent(子智能体) / memory(记忆) / bus(通信总线) / output(输出)
// 连线语义：from 节点的输出 → to 节点的输入（从左到右）
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const chat = require('./chat')
const skills = require('./skills')
const memory = require('./memory')


// 数据目录（与 main.js 一致）：绝不写 C 盘；内联工具临时脚本放 data/runs
const DATA_DIR = process.env.AI_HARNESS_DATA || path.join('D:', path.sep, 'Project', 'Harness', 'data')
const RUNS_DIR = path.join(DATA_DIR, 'runs')

// 运行内联 Python（工具节点）：把 def run(input_text) 写入临时 .py，stdin 传输入，stdout 取结果
function runInlinePy(code, inputText) {
  const { checkPython } = require('./python-engine')
  const py = checkPython()
  if (!py.available) return Promise.resolve({ ok: false, error: '未检测到 Python，无法运行内联工具' })
  return new Promise((resolve) => {
    try {
      fs.mkdirSync(RUNS_DIR, { recursive: true })
      const tmp = path.join(RUNS_DIR, `inline_${crypto.randomUUID().slice(0, 8)}.py`)
      const full = `${String(code || '')}\n\nif __name__ == '__main__':\n    import sys\n    _in = sys.stdin.read()\n    _r = run(_in)\n    sys.stdout.write(str(_r))\n`
      fs.writeFileSync(tmp, full, 'utf8')
      const child = spawn(py.bin, [tmp], { windowsHide: true })
      let stdout = ''
      let stderr = ''
      child.stdout.on('data', (d) => { stdout += String(d) })
      child.stderr.on('data', (d) => { stderr += String(d) })
      child.stdin.write(String(inputText || ''))
      child.stdin.end()
      const timer = setTimeout(() => { try { child.kill() } catch { /* 超时强杀 */ } }, 15000)
      child.on('error', (err) => { clearTimeout(timer); try { fs.unlinkSync(tmp) } catch { /* 忽略 */ }; resolve({ ok: false, error: err.message || '执行失败', stdout, stderr }) })
      child.on('close', (code) => {
        clearTimeout(timer)
        try { fs.unlinkSync(tmp) } catch { /* 清理失败不阻塞 */ }
        resolve({ ok: code === 0, error: code === 0 ? '' : `退出码 ${code}`, stdout, stderr })
      })
    } catch (e) {
      resolve({ ok: false, error: e.message || String(e) })
    }
  })
}

// 运行自包含智能体（data/agent-defs/<id>/agent.py）：独立子进程，
// stdin 传 JSON 载荷 {"input":..., "inject":{...}}，stdout 按 NDJSON 上报进度
// （type: status/output/result/error，由共享运行时 harness_rt.py 引导产出）。
// py-agent 自己调 LLM、自己执行工具，宿主只负责转传事件与收集最终结果。
function runAgentPy(opts) {
  const file = String(opts.agentPy || '')
  const onEvent = opts.onEvent || (() => {})
  const doRun = (py) => new Promise((resolve) => {
    let child
    let settled = false
    let buf = ''
    let stderr = ''
    let result = null
    const errors = []
    const cleanup = () => {
      clearTimeout(timer)
      if (opts.signal) { try { opts.signal.removeEventListener('abort', onAbort) } catch { /* 忽略 */ } }
    }
    const settle = (r) => {
      if (settled) return
      settled = true
      cleanup()
      resolve(r)
    }
    const killChild = () => { try { child && child.kill() } catch { /* 忽略 */ } }
    const timer = setTimeout(killChild, opts.timeoutMs || 15 * 60 * 1000)
    const onAbort = () => killChild()
    try {
      child = spawn(py.bin, ['-X', 'utf8', '-u', file], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        env: { ...process.env, PYTHONIOENCODING: 'utf8', AI_HARNESS_DATA: opts.dataDir || DATA_DIR }
      })
    } catch (e) {
      cleanup()
      resolve({ ok: false, error: 'Python 启动失败: ' + (e.message || e) })
      return
    }
    if (opts.signal) {
      if (opts.signal.aborted) killChild()
      else { try { opts.signal.addEventListener('abort', onAbort) } catch { /* 忽略 */ } }
    }
    child.on('error', (e) => settle({ ok: false, error: 'Python 启动失败: ' + (e.message || e) }))
    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      buf += chunk
      let idx
      while ((idx = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, idx).trim()
        buf = buf.slice(idx + 1)
        if (!line) continue
        let ev = null
        try { ev = JSON.parse(line) } catch { /* 非 JSON 行忽略 */ }
        if (!ev || !ev.type) continue
        if (ev.type === 'result') { result = ev.text == null ? '' : String(ev.text); continue }
        if (ev.type === 'error') { errors.push(String(ev.error || '未知错误')); continue }
        onEvent(ev)
        if (ev.type === 'output' && typeof opts.onOutput === 'function') opts.onOutput(String(ev.text || ''))
        if (ev.type === 'status' && typeof opts.onStatus === 'function') opts.onStatus(ev)
      }
    })
    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (d) => {
      stderr += d
      if (stderr.length > 20000) stderr = stderr.slice(-20000)
    })
    try {
      child.stdin.write(JSON.stringify({ input: String(opts.inputText == null ? '' : opts.inputText), inject: opts.inject || null }) + '\n')
      child.stdin.end()
    } catch { /* 管道写入失败留给 close 处理 */ }
    child.on('close', (code) => {
      if (opts.signal && opts.signal.aborted) settle({ ok: false, aborted: true, error: '已中止' })
      else if (errors.length) settle({ ok: false, error: errors.join('\n'), stderr })
      else if (result !== null) settle({ ok: true, result })
      else settle({ ok: code === 0, error: code === 0 ? '智能体无输出' : `退出码 ${code}`, stderr })
    })
  })
  try {
    if (!file || !fs.existsSync(file)) return Promise.resolve({ ok: false, error: `智能体文件不存在: ${file}` })
    const { checkPython } = require('./python-engine')
    const py = checkPython()
    if (!py.available) return Promise.resolve({ ok: false, error: '未检测到 Python，无法运行自包含智能体' })
    return doRun(py)
  } catch (e) {
    return Promise.resolve({ ok: false, error: e.message || String(e) })
  }
}

// ---------------- 存储 ----------------
// 数据修复：节点/连线 id 去重并修正引用。
// 旧版本 id 为自增数字（n1/n2…），应用重启后计数器重置会产生重复 id，
// 导致前端 key 冲突、连线选中/删除错乱。加载时自动重写并持久化。
function sanitizeAgent(agent) {
  if (!agent || typeof agent !== 'object') return agent
  const used = new Set()
  const idMap = new Map()
  const uuid = () => 'ag_' + crypto.randomUUID().slice(0, 8)
  const nodes = (agent.nodes || []).map((n) => {
    if (!n) return n
    let id = n.id
    while (!id || used.has(id)) id = uuid()
    used.add(id)
    if (id !== n.id) idMap.set(n.id, id)
    return { ...n, id }
  })
  const edges = (agent.edges || []).map((e) => {
    if (!e) return e
    let id = e.id
    while (!id || used.has(id)) id = uuid()
    used.add(id)
    return { ...e, id, from: idMap.get(e.from) || e.from, to: idMap.get(e.to) || e.to }
  })
  return { ...agent, nodes, edges }
}

function createAgentStore(userDataDir) {
  const dir = path.join(userDataDir, 'agents')
  fs.mkdirSync(dir, { recursive: true })
  const fileOf = (id) => path.join(dir, `${id}.json`)

  // ---- 分类管理（data/agents/categories.json）----
  const catsFile = path.join(dir, 'categories.json')
  let catList = []
  let catMap = {}
  const loadCats = () => {
    catList = []; catMap = {}
    if (!fs.existsSync(catsFile)) return
    try {
      const d = JSON.parse(fs.readFileSync(catsFile, 'utf8'))
      catList = Array.isArray(d.list) ? d.list.filter(Boolean) : []
      if (d.map && typeof d.map === 'object') catMap = d.map
    } catch { /* 忽略 */ }
  }
  const saveCats = () => {
    try { fs.writeFileSync(catsFile, JSON.stringify({ list: catList, map: catMap }, null, 2), 'utf8') } catch { /* 忽略 */ }
  }
  const catResult = () => {
    const used = new Set(Object.values(catMap))
    const merged = [...catList]
    for (const u of used) if (!merged.includes(u)) merged.push(u)
    return { list: merged, map: { ...catMap } }
  }
  loadCats()

  const list = () => {
    const items = []
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name === 'categories.json') continue
      try {
        const a = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
        items.push({ id: a.id, name: a.name, category: catMap[a.id] || '未分类', updatedAt: a.updatedAt || 0, nodeCount: (a.nodes || []).length })
      } catch { /* 忽略 */ }
    }
    return items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  return {
    list,
    get(id) {
      try {
        const raw = JSON.parse(fs.readFileSync(fileOf(id), 'utf8'))
        const agent = sanitizeAgent(raw)
        // 若发生修复则写回，一次性修正旧数据
        if (JSON.stringify(agent) !== JSON.stringify(raw)) {
          try { this.save(agent) } catch { /* 忽略 */ }
        }
        return agent
      } catch { return null }
    },
    create() {
      const now = Date.now()
      const agent = {
        id: crypto.randomUUID(),
        name: '新智能体',
        createdAt: now,
        updatedAt: now,
        nodes: [
          { id: 'n-input', type: 'input', label: '输入', text: '', x: 80, y: 160 },
          { id: 'n-output', type: 'output', label: '输出', x: 680, y: 160 }
        ],
        edges: []
      }
      this.save(agent)
      return agent
    },
    save(agent) {
      agent.updatedAt = Date.now()
      fs.writeFileSync(fileOf(agent.id), JSON.stringify(agent, null, 2), 'utf8')
      return agent
    },
    remove(id) {
      try { fs.unlinkSync(fileOf(id)) } catch { /* 忽略 */ }
    },
    listCategories: catResult,
    addCategory(name) {
      const n = String(name || '').trim()
      if (!n) throw new Error('分类名不能为空')
      if (!catList.includes(n)) catList.push(n)
      saveCats()
      return catResult()
    },
    setCategory(id, name) {
      const n = String(name || '').trim()
      if (!n) throw new Error('分类名不能为空')
      if (!catList.includes(n)) catList.push(n)
      if (n === '未分类') delete catMap[id]
      else catMap[id] = n
      saveCats()
      return catResult()
    },
    removeCategory(name) {
      const n = String(name || '').trim()
      if (!n) throw new Error('分类名不能为空')
      if (n === '未分类') throw new Error('「未分类」是默认分组，不能删除')
      catList = catList.filter((c) => c !== n)
      for (const k of Object.keys(catMap)) if (catMap[k] === n) delete catMap[k]
      saveCats()
      return catResult()
    }
  }
}

// ---------------- 智能体定义（data/agent-defs，自包含 agent.py 形态）----------------
// 「智能体」栏：单智能体 = 一个 .py 文件。agent.py 是唯一真源：
//   - 头部 AGENT_* 大写常量 = 元数据（id/名称/提示词/技能/工具/记忆/模型），由宿主静态解析；
//   - run(input_text, ctx) = 自包含主循环，自己调 LLM、自己执行工具，
//     经共享运行时 data/agent-defs/_runtime/harness_rt.py 引导，可脱离宿主直接运行：
//       echo 任务 | python agent.py
// 目录内仍允许自由辅助文件；旧版 agent.json 主定义在装载时自动迁移为 agent.py
// （原始内容更名为 agent.legacy.json 保留）。画布的子智能体节点引用时：
//   agent.py 形态 → 子进程运行该文件；兼容期残留 agent.json → 转最小图执行（见 defToGraph）。

// agent.py 元数据区标记：save 只重写两标记之间，用户的自定义代码零侵入
const AGENT_PY_MARK = {
  begin: '# ===== LAG AGENT HEADER BEGIN =====',
  end: '# ===== LAG AGENT HEADER END ====='
}

// Python 字面量跳过空白/注释
function pySkipWs(src, i) {
  while (i < src.length) {
    const c = src[i]
    if (c === ' ' || c === '\t' || c === '\r' || c === '\n') { i++; continue }
    if (c === '#') { while (i < src.length && src[i] !== '\n') i++; continue }
    break
  }
  return i
}

// Python 字符串字面量 → JS 字符串（' ''' 三种引号 + 常用转义）
function parsePyString(src, i) {
  const three = src.slice(i, i + 3)
  const multi = three === `"""` || three === `'''`
  const q = multi ? three : src[i]
  i += q.length
  let out = ''
  while (i < src.length) {
    if (multi && src.startsWith(q, i)) return [out, i + q.length]
    if (!multi && src[i] === q) return [out, i + 1]
    if (src[i] === '\\') {
      const n = src[i + 1]
      const map = { n: '\n', t: '\t', r: '\r' }
      if (n === '\n') { i += 2; continue }
      if (n === "'" || n === '"' || n === '\\') { out += n; i += 2; continue }
      if (n in map) { out += map[n]; i += 2; continue }
      out += src[i]; i++; continue
    }
    out += src[i]; i++
  }
  return [out, i]
}

// Python 值字面量 → JS 值（str/list/dict/数字/True/False/None，支持嵌套与注释）
function parsePyValue(src, i) {
  i = pySkipWs(src, i)
  const c = src[i]
  if (c === '"' || c === `'`) return parsePyString(src, i)
  if (src.startsWith('True', i)) return [true, i + 4]
  if (src.startsWith('False', i)) return [false, i + 5]
  if (src.startsWith('None', i)) return [null, i + 4]
  if (c === '[' || c === '{') {
    const close = c === '[' ? ']' : '}'
    const isDict = c === '{'
    i++
    const arr = []
    const obj = {}
    for (;;) {
      i = pySkipWs(src, i)
      if (src[i] === close) return [isDict ? obj : arr, i + 1]
      if (src[i] === ',') { i++; continue }
      if (i >= src.length) throw new Error('py value 未闭合')
      let key
      if (isDict) {
        if (src[i] === '"' || src[i] === `'`) { const r = parsePyString(src, i); key = r[0]; i = r[1] }
        else {
          let j = i
          while (j < src.length && src[j] !== ':' && src[j] !== '\n' && src[j] !== ',' && src[j] !== '}') j++
          key = src.slice(i, j).trim()
          i = j
        }
        i = pySkipWs(src, i)
        if (src[i] === ':') i++
      }
      const r = parsePyValue(src, i)
      i = r[1]
      if (isDict) obj[key] = r[0]
      else arr.push(r[0])
      i = pySkipWs(src, i)
      if (src[i] === ',') { i++; continue }
      if (src[i] === close) return [isDict ? obj : arr, i + 1]
      if (i >= src.length) throw new Error('py value 未闭合')
      i++ // 容忍异常字符
    }
  }
  const m = /^-?\d+(\.\d+)?/.exec(src.slice(i, i + 64))
  if (m) return [parseFloat(m[0]), i + m[0].length]
  const bad = new Error(`无法解析 Python 字面量 @${i}`)
  throw bad
}

// 解析 agent.py 的 AGENT_* 元数据区（仅在标记间扫描，正文中的同名常量不受影响）
function parseAgentHeader(source) {
  const s = String(source || '')
  const b = s.indexOf(AGENT_PY_MARK.begin)
  const e = s.indexOf(AGENT_PY_MARK.end)
  const block = b >= 0 && e > b ? s.slice(b + AGENT_PY_MARK.begin.length, e) : s
  const meta = {}
  const re = /^\s*(AGENT_[A-Z0-9_]+)\s*=\s*/gm
  let m
  while ((m = re.exec(block))) {
    try {
      const r = parsePyValue(block, re.lastIndex)
      meta[m[1]] = r[0]
      re.lastIndex = r[1]
    } catch { /* 单项解析失败不影响其余 */ }
  }
  return meta
}

// JS 值 → Python 字面量文本
function pyVal(v) {
  if (v === true) return 'True'
  if (v === false) return 'False'
  if (v === null || v === undefined) return 'None'
  if (typeof v === 'number') return String(v)
  if (typeof v === 'string') return /\n/.test(v) ? pyTripleQuote(v) : JSON.stringify(v)
  if (Array.isArray(v)) return '[\n' + v.map((x) => '    ' + pyVal(x) + ',').join('\n') + '\n]'
  if (typeof v === 'object') {
    return '{\n' + Object.entries(v).map(([k, x]) => `    ${JSON.stringify(k)}: ${pyVal(x)},`).join('\n') + '\n}'
  }
  return 'None'
}

// 多行字符串：优先 """，内部出现 """ 时换用 '''，再冲突退化为 JSON 风格单行长串
function pyTripleQuote(text) {
  const t = String(text == null ? '' : text)
  if (!t.includes('"""')) return `"""${t}"""`
  if (!t.includes("'''")) return `'''${t}'''`
  return JSON.stringify(t)
}

// 元数据区公共生成器（compose 全量与 upsert 局部共用，保证格式一致）
function agentPyHeaderLines(def) {
  const rows = [
    `AGENT_ID = ${JSON.stringify(String(def.id || ''))}`,
    `AGENT_NAME = ${JSON.stringify(String(def.name || def.id || '未命名智能体'))}`,
    `AGENT_DESC = ${pyTripleQuote(def.description || '')}`,
    `AGENT_SYSTEM_PROMPT = ${pyTripleQuote(def.systemPrompt || '')}`,
    `AGENT_SKILLS = ${pyVal(Array.isArray(def.skills) ? def.skills : [])}`,
    `AGENT_TOOLS = ${pyVal(Array.isArray(def.tools) ? def.tools : [])}`,
    `AGENT_MEMORIES = ${pyVal(Array.isArray(def.memories) ? def.memories : [])}`
  ]
  if (def.model && def.model.inherit) {
    rows.push('AGENT_MODEL = None')
  } else {
    const mdl = {
      base_url: (def.model && def.model.baseUrl) || '',
      api_key: (def.model && def.model.apiKey) || '',
      model: (def.model && def.model.model) || ''
    }
    if (typeof def.temperature === 'number') mdl.temperature = def.temperature
    if (typeof def.maxTokens === 'number') mdl.max_tokens = def.maxTokens
    rows.push(`AGENT_MODEL = ${pyVal(mdl)}`)
  }
  if (typeof def.createdAt === 'number') rows.push(`AGENT_CREATED_AT = ${Math.round(def.createdAt)}`)
  return [AGENT_PY_MARK.begin, ...rows, AGENT_PY_MARK.end].join('\n')
}

// agent.py 全量模板（新建/迁移用）：导入引导 + 元数据区 + 默认主循环
function composeAgentPy(def) {
  const lines = [
    '# ============================================================',
    `# 智能体：${def.name || def.id}`,
    '# 自包含定义：头部 AGENT_* 元数据由宿主解析展示；run(input_text, ctx)',
    '# 是独立主循环（自己调 LLM、自己执行工具）。可脱离宿主直接运行：',
    '#   echo 任务 | python agent.py',
    '# 共享运行时：data/agent-defs/_runtime/harness_rt.py（纯标准库）',
    '# ============================================================',
    '',
    'import os',
    'import sys',
    '',
    'sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "_runtime"))',
    '',
    agentPyHeaderLines(def),
    '',
    '',
    '# ---------------- 自包含主循环 ----------------',
    '# 默认 run：ctx.agent_loop 按 AGENT_SYSTEM_PROMPT + 技能提示词驱动工具循环。',
    '# 需要定制流程时改写本函数，可用能力：',
    '#   ctx.llm(messages)          直接调用 LLM（自动携带已声明工具集）',
    '#   ctx.call_tool(name, args)  手动执行工具',
    '#   ctx.emit_output(text)      向宿主上报中间进度',
    '#   ctx.agent_loop(input, system_prompt=None, max_rounds=None)',
    'def run(input_text, ctx):',
    '    return ctx.agent_loop(input_text)',
    '',
    '',
    'if __name__ == "__main__":',
    '    from harness_rt import bootstrap',
    '    bootstrap(dict(globals()))',
    ''
  ]
  return lines.join('\n')
}

// 只替换元数据区（标记之间），其余正文原样保留；无标记的手写文件把区段追加到末尾
function upsertAgentPyHeader(existingSource, def) {
  const block = agentPyHeaderLines(def)
  const s = String(existingSource || '')
  const b = s.indexOf(AGENT_PY_MARK.begin)
  const e = s.indexOf(AGENT_PY_MARK.end)
  if (b >= 0 && e > b) {
    return s.slice(0, b) + block + s.slice(e + AGENT_PY_MARK.end.length)
  }
  return s.replace(/\s*$/, '') + '\n\n\n' + block + '\n'
}

// 导出清洗：元数据区中的真实 baseUrl/apiKey 替换为 env: 占位符（用户铁律：导出物绝不携带真实密钥）
function sanitizeAgentPySource(source) {
  const s = String(source || '')
  const b = s.indexOf(AGENT_PY_MARK.begin)
  const e = s.indexOf(AGENT_PY_MARK.end)
  if (b < 0 || e <= b) return s
  const def = agentPyToDef('__export__', s, {})
  if (!def.model || def.model.inherit !== false) return s
  return upsertAgentPyHeader(s, {
    ...def,
    model: { ...def.model, baseUrl: 'env:LLM_BASE_URL', apiKey: 'env:LLM_API_KEY' }
  })
}

// 解析后的元数据 → 统一定义对象（对外字段与旧版 agent.json 一致，便于全链路无感）
function agentPyToDef(dirId, source, extras) {
  const meta = parseAgentHeader(source)
  const str = (v, d) => (typeof v === 'string' && v.length ? v : d)
  const arr = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.trim()) : [])
  const rawModel = meta.AGENT_MODEL
  const mdict = (rawModel && typeof rawModel === 'object' && !Array.isArray(rawModel)) ? rawModel : null
  let model = { inherit: true }
  if (mdict) {
    const baseUrl = String(mdict.base_url || mdict.baseUrl || '').trim()
    const apiKey = String(mdict.api_key || mdict.apiKey || '').trim()
    const mdl = String(mdict.model || '').trim()
    if (baseUrl || apiKey || mdl) model = { inherit: false, baseUrl, apiKey, model: mdl }
  }
  const def = {
    id: str(meta.AGENT_ID, dirId),
    name: str(meta.AGENT_NAME, dirId),
    description: typeof meta.AGENT_DESC === 'string' ? meta.AGENT_DESC : str(meta.AGENT_DESCRIPTION, ''),
    systemPrompt: str(meta.AGENT_SYSTEM_PROMPT, ''),
    skills: arr(meta.AGENT_SKILLS),
    tools: arr(meta.AGENT_TOOLS),
    memories: arr(meta.AGENT_MEMORIES),
    model,
    // 温度/最大 token：独立变量优先，回落 AGENT_MODEL dict 内字段（生成端写 dict，两端须对称）
    temperature: typeof meta.AGENT_TEMPERATURE === 'number' ? meta.AGENT_TEMPERATURE
      : (mdict && typeof mdict.temperature === 'number' ? mdict.temperature : undefined),
    maxTokens: typeof meta.AGENT_MAX_TOKENS === 'number' ? meta.AGENT_MAX_TOKENS
      : (mdict && typeof mdict.max_tokens === 'number' ? mdict.max_tokens : undefined),
    maxRounds: typeof meta.AGENT_MAX_ROUNDS === 'number' ? meta.AGENT_MAX_ROUNDS : undefined,
    form: 'py',
    pyFile: extras.pyFile,
    dir: extras.dir || null,
    createdAt: typeof meta.AGENT_CREATED_AT === 'number' ? meta.AGENT_CREATED_AT : (extras.createdAt || extras.updatedAt || 0),
    updatedAt: extras.updatedAt || 0
  }
  return def
}

// 从 agent.py 直接保存表单字段时的白名单投影（丢弃运行态字段）
function sanitizeAgentPyInput(def) {
  const pick = ['id', 'name', 'description', 'systemPrompt', 'skills', 'tools', 'memories', 'model', 'temperature', 'maxTokens']
  const out = {}
  for (const k of pick) if (def[k] !== undefined) out[k] = def[k]
  if (typeof def.createdAt === 'number') out.createdAt = def.createdAt
  return out
}

function createAgentDefStore(userDataDir) {
  const dir = path.join(userDataDir, 'agent-defs')
  fs.mkdirSync(dir, { recursive: true })
  const MAIN = 'agent.py'
  const LEGACY_MAIN = 'agent.json'
  const LEGACY_KEEP = 'agent.legacy.json'
  const CATS_FILE = 'categories.json'

  // 迁移一：旧扁平单文件 data/agent-defs/<id>.json → data/agent-defs/<id>/agent.json
  const migrateFlatLegacy = () => {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name === CATS_FILE) continue
      const old = path.join(dir, name)
      let st
      try { st = fs.statSync(old) } catch { continue }
      if (!st.isFile()) continue
      const id = name.slice(0, -5)
      const sub = path.join(dir, id)
      const main = path.join(sub, LEGACY_MAIN)
      try {
        fs.mkdirSync(sub, { recursive: true })
        fs.copyFileSync(old, main)
        fs.unlinkSync(old)
      } catch { /* 迁移失败不阻塞 */ }
    }
  }
  // 迁移二：目录内 agent.json → 自动生成同义 agent.py（原始 JSON 更名保留，不再参与加载）
  const migrateJsonToPy = () => {
    for (const name of fs.readdirSync(dir)) {
      const sub = path.join(dir, name)
      let st
      try { st = fs.statSync(sub) } catch { continue }
      if (!st.isDirectory()) continue
      const legacy = path.join(sub, LEGACY_MAIN)
      if (!fs.existsSync(legacy)) continue
      const target = path.join(sub, MAIN)
      if (fs.existsSync(target)) continue
      let def = null
      try { def = JSON.parse(fs.readFileSync(legacy, 'utf8')) } catch { def = null }
      if (!def || typeof def !== 'object') def = { id: name, name }
      if (!def.id) def.id = name
      try {
        fs.writeFileSync(target, composeAgentPy(def), 'utf8')
        fs.renameSync(legacy, path.join(sub, LEGACY_KEEP))
      } catch { /* 迁移失败不阻塞，回退目录仍可用 */ }
    }
  }
  migrateFlatLegacy()
  migrateJsonToPy()

  const mainFile = (id) => path.join(dir, String(id || ''), MAIN)
  const defDir = (id) => path.join(dir, String(id || ''))
  const catsFile = path.join(dir, CATS_FILE)
  let catList = []
  let catMap = {}
  const loadCats = () => {
    catList = []; catMap = {}
    if (!fs.existsSync(catsFile)) return
    try {
      const d = JSON.parse(fs.readFileSync(catsFile, 'utf8'))
      catList = Array.isArray(d.list) ? d.list.filter(Boolean) : []
      if (d.map && typeof d.map === 'object') catMap = d.map
    } catch { /* 忽略 */ }
  }
  const saveCats = () => {
    try { fs.writeFileSync(catsFile, JSON.stringify({ list: catList, map: catMap }, null, 2), 'utf8') } catch { /* 忽略 */ }
  }
  const catResult = () => {
    const used = new Set(Object.values(catMap))
    const merged = [...catList]
    for (const u of used) if (!merged.includes(u)) merged.push(u)
    return { list: merged, map: { ...catMap } }
  }
  loadCats()
  // 读取单个智能体目录 → 定义对象：主源 agent.py，兼容期兜底 agent.legacy.json
  const readDefDir = (sub, dirName) => {
    const mainP = path.join(sub, MAIN)
    try {
      const st = fs.statSync(mainP)
      const src = fs.readFileSync(mainP, 'utf8')
      return agentPyToDef(dirName, src, {
        pyFile: MAIN,
        dir: sub,
        createdAt: st.birthtimeMs || 0,
        updatedAt: st.mtimeMs || 0
      })
    } catch { /* 主文件缺失或解析失败 → 尝试兜底 */ }
    try {
      const d = JSON.parse(fs.readFileSync(path.join(sub, LEGACY_KEEP), 'utf8'))
      if (d && typeof d === 'object' && d.id) return { ...d, form: 'legacy-json' }
    } catch { /* 忽略 */ }
    return null
  }
  const list = () => {
    const items = []
    for (const name of fs.readdirSync(dir)) {
      if (name === CATS_FILE || name.startsWith('_') || name.startsWith('.')) continue
      const sub = path.join(dir, name)
      let st
      try { st = fs.statSync(sub) } catch { continue }
      if (!st.isDirectory()) continue
      const d = readDefDir(sub, name)
      if (!d) continue
      items.push({
        id: d.id,
        name: d.name,
        description: d.description || '',
        category: catMap[d.id] || catMap[name] || '未分类',
        updatedAt: d.updatedAt || 0,
        skillCount: Array.isArray(d.skills) ? d.skills.length : 0,
        model: d.model || null,
        form: d.form || 'py'
      })
    }
    return items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }
  // 智能体目录内文件路径解析（防越界）
  const resolveIn = (id, rel) => {
    const d = defDir(id)
    if (!fs.existsSync(d)) return null
    const p = path.resolve(d, String(rel || '').replace(/^[/\\]+/, ''))
    const root = d.endsWith(path.sep) ? d : d + path.sep
    if (!(p === d || p.startsWith(root))) return null
    return p
  }
  const kindOf = (rel) => {
    const e = String(rel).split('.').pop().toLowerCase()
    if (e === 'py') return 'py'
    if (e === 'js') return 'js'
    if (e === 'json') return 'json'
    return 'md'
  }
  return {
    list,
    get(id) {
      if (!id) return null
      return readDefDir(defDir(id), String(id))
    },
    create() {
      const now = Date.now()
      const def = {
        id: crypto.randomUUID(),
        name: '新智能体',
        description: '',
        model: { inherit: true },
        systemPrompt: '',
        skills: [],
        tools: [],
        memories: [],
        createdAt: now
      }
      fs.mkdirSync(defDir(def.id), { recursive: true })
      fs.writeFileSync(mainFile(def.id), composeAgentPy(def), 'utf8')
      return this.get(def.id)
    },
    save(def) {
      if (!def || !def.id) throw new Error('智能体缺少 id')
      const p = mainFile(def.id)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      const input = sanitizeAgentPyInput(def)
      if (fs.existsSync(p)) {
        fs.writeFileSync(p, upsertAgentPyHeader(fs.readFileSync(p, 'utf8'), input), 'utf8')
      } else {
        fs.writeFileSync(p, composeAgentPy({ ...input, id: def.id }), 'utf8')
      }
      return this.get(def.id)
    },
    remove(id) {
      try { fs.rmSync(defDir(id), { recursive: true, force: true }) } catch { /* 忽略 */ }
    },
    // ---- 文件工作台（多文件编辑）：主文件 agent.py 不可改名/删除 ----
    listFiles(id) {
      const d = defDir(id)
      if (!d || !fs.existsSync(d)) return []
      const out = []
      const walk = (cur, rel) => {
        let entries = []
        try { entries = fs.readdirSync(cur) } catch { return }
        for (const f of entries.sort()) {
          const p = path.join(cur, f)
          const r = rel ? `${rel}/${f}` : f
          let isDir = false
          try { isDir = fs.statSync(p).isDirectory() } catch { continue }
          if (isDir) { walk(p, r); continue }
          out.push({ rel: r, kind: kindOf(r), main: r === MAIN })
        }
      }
      walk(d, '')
      return out
    },
    readFile(id, rel) {
      const p = resolveIn(id, rel)
      if (!p) throw new Error('路径越界')
      if (!fs.existsSync(p)) throw new Error(`文件不存在: ${rel}`)
      return fs.readFileSync(p, 'utf8')
    },
    writeFile(id, rel, content) {
      const p = resolveIn(id, rel)
      if (!p) throw new Error('路径越界')
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, String(content == null ? '' : content), 'utf8')
      // agent.py 保存即生效：元数据解析与 updatedAt（mtime）都在读取时动态完成，无需额外处理
      return { rel }
    },
    createFile(id, rel, content) {
      const p = resolveIn(id, rel)
      if (!p) throw new Error('路径越界')
      if (fs.existsSync(p)) throw new Error(`文件已存在: ${rel}`)
      fs.mkdirSync(path.dirname(p), { recursive: true })
      fs.writeFileSync(p, String(content == null ? '' : content), 'utf8')
      return { rel }
    },
    deleteFile(id, rel) {
      if (rel === MAIN) throw new Error('主定义文件 agent.py 不可删除')
      const p = resolveIn(id, rel)
      if (!p) throw new Error('路径越界')
      if (!fs.existsSync(p)) throw new Error(`文件不存在: ${rel}`)
      fs.rmSync(p, { force: true })
      return { ok: true }
    },
    renameFile(id, oldRel, newRel) {
      if (oldRel === MAIN) throw new Error('主定义文件 agent.py 不可重命名')
      const src = resolveIn(id, oldRel)
      if (!src) throw new Error('路径越界')
      if (!fs.existsSync(src)) throw new Error(`文件不存在: ${oldRel}`)
      if (fs.statSync(src).isDirectory()) throw new Error('不能重命名目录')
      let nr = String(newRel || '').trim().replace(/\\/g, '/')
      if (!nr) throw new Error('新文件名不能为空')
      const base = nr.split('/').pop()
      if (!/\.\w+$/.test(base)) nr = `${nr}.md`
      if (nr === String(oldRel).replace(/\\/g, '/')) return { rel: nr, ok: true }
      const dest = resolveIn(id, nr)
      if (!dest) throw new Error('路径越界')
      if (fs.existsSync(dest)) throw new Error(`目标已存在: ${nr}`)
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      fs.renameSync(src, dest)
      return { rel: nr, ok: true }
    },
    listCategories: catResult,
    addCategory(name) {
      const n = String(name || '').trim()
      if (!n) throw new Error('分类名不能为空')
      if (!catList.includes(n)) catList.push(n)
      saveCats()
      return catResult()
    },
    setCategory(id, name) {
      const n = String(name || '').trim()
      if (!n) throw new Error('分类名不能为空')
      if (!catList.includes(n)) catList.push(n)
      if (n === '未分类') delete catMap[id]
      else catMap[id] = n
      saveCats()
      return catResult()
    },
    removeCategory(name) {
      const n = String(name || '').trim()
      if (!n) throw new Error('分类名不能为空')
      if (n === '未分类') throw new Error('「未分类」是默认分组，不能删除')
      catList = catList.filter((c) => c !== n)
      for (const k of Object.keys(catMap)) if (catMap[k] === n) delete catMap[k]
      saveCats()
      return catResult()
    }
  }
}

// 智能体定义 → 可运行最小图（input → 各技能 → merge → output）
// 供工作流子智能体节点引用；定义里的 systemPrompt 作为技能节点附加指令，model 配置透传到各技能节点
// tools/memories：定义级的工具与记忆绑定会传递到每个技能节点（工具并入节点工具、记忆并入节点记忆）
function defToGraph(def) {
  const skills = Array.isArray(def.skills) && def.skills.length ? def.skills : ['assistant']
  const defTools = Array.isArray(def.tools) ? def.tools : []
  const defMemories = Array.isArray(def.memories) ? def.memories : []
  const prefix = def.id
  const now = Date.now()
  const nodes = [
    { id: `${prefix}:in`, type: 'input', label: '输入', text: '', x: 60, y: 160, w: 180, h: 120 },
    ...skills.map((s, i) => ({
      id: `${prefix}:s${i}`,
      type: 'skill',
      label: '技能',
      skillId: s,
      prompt: def.systemPrompt ? String(def.systemPrompt) : '',
      tools: defTools.length ? [...defTools] : undefined,
      memories: defMemories.length ? [...defMemories] : undefined,
      x: 300 + i * 220,
      y: 80,
      w: 200,
      h: 200,
      model: def.model && def.model.inherit === false ? { ...def.model } : undefined
    })),
    { id: `${prefix}:out`, type: 'output', label: '输出', x: 620 + (skills.length - 1) * 220, y: 160, w: 180, h: 120 }
  ]
  const edges = [
    ...skills.map((s, i) => ({ id: `${prefix}:e${i}`, from: `${prefix}:in`, to: `${prefix}:s${i}`, type: 'data' })),
    ...skills.map((s, i) => ({ id: `${prefix}:e2${i}`, from: `${prefix}:s${i}`, to: `${prefix}:out`, type: 'data' }))
  ]
  return { id: def.id, name: def.name || '智能体', nodes, edges }
}

// ---------------- 通信总线 ----------------
// 文本标记语法：[[区域名]] ...内容... [[/区域名]]
// 节点可声明 readZones（可读区域）与 writeZones（可写区域）：
//   - 输入侧：只有普通文本 + readZones 命中的区域会被传递进节点
//   - 输出侧：不属于 writeZones 的区域标记会被剥离（writeZones 为空 = 不限制）
// 区域片段以原始标记形式继续下传，供后续节点按权限读取。

function parseZones(text) {
  const zones = {}
  const plainParts = []
  // \w 默认只匹配 ASCII，需显式纳入中文（Python 端 \w 默认支持 unicode，两端保持一致）
  const re = /\[\[([\w\u4e00-\u9fa5][\w.\-\u4e00-\u9fa5]*)\]\]([\s\S]*?)\[\[\/\1\]\]/g
  let last = 0
  let m
  const s = String(text || '')
  while ((m = re.exec(s))) {
    if (m.index > last) plainParts.push(s.slice(last, m.index))
    zones[m[1]] = (zones[m[1]] || '') + m[2]
    last = re.lastIndex
  }
  if (last < s.length) plainParts.push(s.slice(last))
  return { zones, plain: plainParts.join('') }
}

function toZoneList(v) {
  if (!v) return []
  if (Array.isArray(v)) return v.filter(Boolean)
  return String(v).split(/[,\s]+/).filter(Boolean)
}

// 读取过滤：保留普通文本 + 允许区域的原始片段（含标记），其余区域剥离
function filterReadZones(text, readZones) {
  if (!text) return ''
  const { zones, plain } = parseZones(text)
  if (!Object.keys(zones).length) return plain
  const allowed = new Set(readZones)
  const parts = []
  if (plain.trim()) parts.push(plain)
  for (const name of Object.keys(zones)) {
    if (allowed.has(name)) parts.push(`[[${name}]]${zones[name]}[[/${name}]]`)
  }
  return parts.join('\n\n')
}

// 写入过滤：保留普通文本 + writeZones 允许的区域，越权区域剥离
function filterWriteZones(text, writeZones) {
  if (!text || !writeZones.length) return text
  const { zones, plain } = parseZones(text)
  if (!Object.keys(zones).length) return plain
  const allowed = new Set(writeZones)
  const parts = []
  if (plain.trim()) parts.push(plain)
  for (const name of Object.keys(zones)) {
    if (allowed.has(name)) parts.push(`[[${name}]]${zones[name]}[[/${name}]]`)
  }
  return parts.join('\n\n')
}


// ---------------- 编排 ----------------
// 分支条件求值（边 when 表达式）：always / length > N / contains 关键词 / not contains；未知条件默认放行
function evalCond(cond, text) {
  const s = String(text || '')
  const c = String(cond || '').trim()
  if (!c || c === 'always' || c === 'true') return true
  let m = c.match(/^length\s*([<>=!]+)\s*(\d+)$/)
  if (m) {
    const len = s.length
    const n = Number(m[2])
    switch (m[1]) {
      case '>': return len > n
      case '<': return len < n
      case '>=': return len >= n
      case '<=': return len <= n
      case '==': return len === n
      case '!=': return len !== n
      default: return true
    }
  }
  m = c.match(/^contains\s+(.+)$/)
  if (m) return s.includes(m[1].trim())
  m = c.match(/^not\s+contains\s+(.+)$/)
  if (m) return !s.includes(m[1].trim())
  return true
}

// 解析节点级模型配置：节点 model.inherit=false 且有自定义值 → 用节点配置（缺字段回落上游）
// 否则返回 fallback（会话/全局模型配置）。保证导出后不含 key（导出侧做清洗）。
function resolveNodeModel(node, fallback) {
  const m = node && node.model
  if (m && m.inherit === false && (m.baseUrl || m.apiKey || m.model)) {
    const fb = fallback || {}
    return {
      baseUrl: (m.baseUrl || '').trim() || fb.baseUrl || undefined,
      apiKey: (m.apiKey || '').trim() || fb.apiKey || undefined,
      model: (m.model || '').trim() || fb.model || undefined
    }
  }
  return fallback
}

// Kahn 拓扑排序；返回有序节点 id 列表，若有环抛出错误
function topoSort(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]))
  const incoming = new Map(nodes.map((n) => [n.id, []]))
  for (const e of edges) {
    if (!byId.has(e.from) || !byId.has(e.to)) continue
    incoming.get(e.to).push(e.from)
  }
  // 入度 = 上游节点数
  const indegree = new Map()
  for (const n of nodes) indegree.set(n.id, incoming.get(n.id).length)
  const queue = nodes.filter((n) => indegree.get(n.id) === 0).map((n) => n.id)
  const order = []
  while (queue.length) {
    const id = queue.shift()
    order.push(id)
    for (const e of edges) {
      if (e.from !== id) continue
      const next = e.to
      indegree.set(next, indegree.get(next) - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  if (order.length !== nodes.length) throw new Error('智能体存在循环依赖，请检查连线')
  return order
}

/**
 * 执行智能体（Agent）
 * @param {object} opts { agent, agentStore, settings, inputs, signal, onStatus, onOutput, onDone }
 */
async function runAgent(opts) {
  const { agent, settings, inputs, signal } = opts
  const agentStore = opts.agentStore || null
  const onStatus = opts.onStatus || (() => {})
  const onOutput = opts.onOutput || (() => {})
  const onToken = opts.onToken || (() => {})
  const nodes = agent.nodes || []
  const edges = agent.edges || []

  // 递归保护：调用栈（父->子->…），子智能体结束后移除，允许菱形引用、禁止循环引用
  const stack = opts.stack || new Set()
  if (stack.has(agent.id)) {
    throw new Error('检测到智能体循环引用（子智能体互相调用）')
  }
  stack.add(agent.id)
  try {
    return await runAgentInner({ ...opts, stack, nodes, edges })
  } finally {
    stack.delete(agent.id)
  }
}

async function runAgentInner(opts) {
  const { agent, settings, inputs, signal } = opts
  const agentStore = opts.agentStore || null
  const stack = opts.stack
  const nodes = opts.nodes
  const edges = opts.edges
  const onStatus = opts.onStatus || (() => {})
  const onOutput = opts.onOutput || (() => {})
  const onToken = opts.onToken || (() => {})
  const byId = new Map(nodes.map((n) => [n.id, n]))
  // 捕获输出节点 id（带工具/技能的输出节点运行时会临时伪装成 skill，不能再用 type 判断）
  const outputIds = new Set(nodes.filter((n) => n.type === 'output').map((n) => n.id))

  // 前向边（数据/消息/广播）：参与拓扑与文本传递；挂接边（pointId）只表达挂接关系；回调边（callback）不参与拓扑，由回环阶段驱动
  const forward = edges.filter((e) => !e.pointId && e.type !== 'callback')
  const callbackEdges = edges.filter((e) => !e.pointId && e.type === 'callback')
  // 挂接在总线连接点上的节点：由总线分支统一调用，不独立执行
  const busAttached = new Set(edges.filter((e) => e.pointId).map((e) => e.from))
  const order = topoSort(nodes, forward)
  const flowEdges = forward // 总线入口数据流等复用前向边
  const outputs = new Map() // nodeId -> string
  const capabilities = {} // 工具节点 id -> toolId（下游 skill 经连线获得工具能力）
  const toolManuals = {} // 工具节点 id -> { prompt, manual }（额外描述 + 拉取的工具操作手册）

  const runId = crypto.randomUUID().slice(0, 8)

  // 单节点执行（主循环与回调回环共用）；extraInputs = 回调阶段注入的下游反馈
  const executeNodeAt = async (nodeId, extraInputs) => {
    const node = byId.get(nodeId)
    if (!node) return
    // 总线挂接节点：不由主循环执行（总线分支按连接点顺序调用）
    if (busAttached.has(nodeId)) {
      onStatus({ runId, nodeId, status: 'done' })
      return
    }
    // 节点级工具/记忆链接（技能已并入 skill，不再有独立技能链接）
    const nodeToolsRaw = Array.isArray(node.tools) ? node.tools : []
    const nodeMemoriesRaw = Array.isArray(node.memories) ? node.memories : []
    // 上游输出（连同来源节点）；回调边不参与普通上游；分支边按 when 条件过滤
    const upstreamNodes = edges.filter((e) => e.to === nodeId && !e.pointId && e.type !== 'callback' && evalCond(e.when, outputs.get(e.from)))
      .map((e) => ({ node: byId.get(e.from), text: outputs.get(e.from) }))
      .filter((u) => (u.node || u.feedback) && u.text != null && u.text !== '')
    if (extraInputs && extraInputs.length) {
      for (const t of extraInputs) upstreamNodes.push({ node: null, text: t, feedback: true })
    }
    const upstream = upstreamNodes.map((u) => u.text)

    if (node.type === 'input') {
      const val = (inputs && inputs[node.id]) ?? node.text ?? ''
      if (!nodeToolsRaw.length && !nodeMemoriesRaw.length) {
        // 纯文本输入：直接透传
        outputs.set(nodeId, String(val))
        onStatus({ runId, nodeId, status: 'done' })
        return
      }
      // 自定义输入：链接了工具/记忆 → 由默认 skill assistant 加工处理输入内容（复用下方 skill 分支）
      node.type = 'skill'
      node.skillId = 'assistant'
      node.prompt = String(val)
      // 落入 skill 分支执行
    }

    if (node.type === 'output') {
      if (!nodeToolsRaw.length && !nodeMemoriesRaw.length) {
        const out = upstream.join('\n\n')
        outputs.set(nodeId, out)
        onOutput({ runId, nodeId, output: out })
        onStatus({ runId, nodeId, status: 'done' })
        return
      }
      // 自定义输出：链接了工具/记忆 → 由默认 skill assistant 加工上游结果（复用下方 skill 分支）
      node.type = 'skill'
      node.skillId = 'assistant'
      node.prompt = upstream.join('\n\n')
      // 落入 skill 分支执行
    }

    // 子智能体节点：把上游输入灌入子智能体的输入节点，输出 = 子智能体最终结果
    if (node.type === 'subagent') {
      const subId = node.subagentId
      const fail = (msg) => {
        onStatus({ runId, nodeId, status: 'error', error: msg })
        outputs.set(nodeId, msg)
      }
      if (!subId) {
        fail('子智能体节点未选择智能体')
        return
      }
      if (!agentStore) {
        fail('运行时未提供智能体存储')
        return
      }
      if (stack.has(subId)) {
        fail(`检测到智能体循环引用: ${subId}`)
        return
      }
      let sub = agentStore.get(subId)
      // 工作流中没有 → 尝试智能体定义库：
      //   agent.py 自包含形态 → 子进程独立运行（自己调 LLM、自己执行工具）
      //   legacy JSON 残留    → 转最小图执行（defToGraph）
      if (!sub && typeof agentStore.getDef === 'function') {
        const def = agentStore.getDef(subId)
        if (def && def.form === 'py' && def.dir) {
          const inputUp = upstream.join('\n\n')
          const nTools = (Array.isArray(node.tools) ? node.tools : [])
            .concat(edges.filter((e) => e.to === nodeId).map((e) => e.from).filter((f) => capabilities[f]).map((f) => capabilities[f]))
            .filter(Boolean)
          const nMems = Array.isArray(node.memories) ? node.memories : []
          const nm = node.model
          const injectModel = nm && nm.inherit === false
            ? { baseUrl: nm.baseUrl || '', apiKey: nm.apiKey || '', model: nm.model || '' }
            : null
          onStatus({ runId, nodeId, status: 'running' })
          try {
            const r = await runAgentPy({
              agentPy: path.join(def.dir, def.pyFile || 'agent.py'),
              inputText: inputUp,
              inject: {
                tools: nTools,
                memories: nMems,
                model: injectModel,
                parentRunId: runId
              },
              signal,
              dataDir: opts.dataDir,
              onOutput: (text) => onOutput({ runId, nodeId, output: text }),
              onEvent: () => {}
            })
            if (r.ok) {
              outputs.set(nodeId, r.result)
              onOutput({ runId, nodeId, output: r.result })
              onStatus({ runId, nodeId, status: 'done' })
            } else if (r.aborted) {
              outputs.set(nodeId, '子智能体已中止')
              onStatus({ runId, nodeId, status: 'aborted' })
            } else {
              const msg = `子智能体运行失败: ${r.error || '未知错误'}`
              outputs.set(nodeId, msg)
              onStatus({ runId, nodeId, status: 'error', error: r.error || '未知错误' })
            }
          } catch (e) {
            if (signal && signal.aborted) onStatus({ runId, nodeId, status: 'aborted' })
            else onStatus({ runId, nodeId, status: 'error', error: e.message || String(e) })
          }
          return
        }
        if (def) sub = defToGraph(def)
      }
      if (!sub) {
        fail(`子智能体不存在: ${subId}`)
        return
      }
      // 节点级工具/记忆链接：工作流里工具节点/记忆节点连到本子智能体节点时注入到子图技能节点
      const nodeToolsRaw = Array.isArray(node.tools) ? node.tools : []
      const nodeMemoriesRaw = Array.isArray(node.memories) ? node.memories : []
      const inToolIds = edges.filter((e) => e.to === nodeId).map((e) => e.from).filter((f) => capabilities[f])
      const inheritedTools = [...new Set([...nodeToolsRaw, ...inToolIds.map((f) => capabilities[f])])]
      if (inheritedTools.length || nodeMemoriesRaw.length) {
        const g = { ...sub, nodes: (sub.nodes || []).map((sn) => {
          if (sn.type !== 'skill') return sn
          return {
            ...sn,
            tools: [...new Set([...(sn.tools || []), ...inheritedTools])],
            memories: [...new Set([...(sn.memories || []), ...nodeMemoriesRaw])]
          }
        }) }
        sub = g
      }
      const subInputs = {}
      for (const sn of sub.nodes || []) {
        if (sn.type === 'input') subInputs[sn.id] = upstream.join('\n\n')
      }
      onStatus({ runId, nodeId, status: 'running' })
      try {
        const subRes = await runAgent({
          agent: sub,
          agentStore,
          settings,
          model: resolveNodeModel(node, opts.model),
          inputs: subInputs,
          signal,
          stack,
          onStatus: () => {},
          onOutput: () => {},
          onToken: () => {}
        })
        outputs.set(nodeId, subRes.result)
        onOutput({ runId, nodeId, output: subRes.result })
        onStatus({ runId, nodeId, status: 'done' })
      } catch (e) {
        if (signal && signal.aborted) {
          onStatus({ runId, nodeId, status: 'aborted' })
        } else {
          onStatus({ runId, nodeId, status: 'error', error: e.message || String(e) })
        }
      }
      return
    }

    // 控制流节点：汇聚（合并上游）/ 分支（透传，分流由下游边 when 条件过滤）/ 循环（输入重复 N 次）
    if (node.type === 'flow') {
      const ft = node.flowType || 'merge'
      const input = upstream.join('\n\n')
      let out = input
      if (ft === 'loop') {
        const n = Math.max(1, parseInt(node.maxLoops, 10) || 1)
        out = Array(n).fill(input).join('\n\n')
      }
      outputs.set(nodeId, out)
      onOutput({ runId, nodeId, output: out })
      onStatus({ runId, nodeId, status: 'done' })
      return
    }

    // 记忆节点：较大矩形，提供多个读取/写入接口
    if (node.type === 'memory') {
      onStatus({ runId, nodeId, status: 'running' })
      try {
        const memArch = node.memoryArch || ''
        const resolveScope = (arch, sc) => {
          const d = memory.dirPath(arch)
          if (!d) return null
          const s = String(sc || '')
          if (memory.FILE_NAMES[s]) return path.join(d, memory.FILE_NAMES[s])
          return memory.resolveInArch(arch, s)
        }
        const input = upstream.join('\n\n')
        for (const w of Array.isArray(node.writes) ? node.writes : []) {
          const arch = w.arch || memArch
          if (!arch) continue
          const sc = String(w.scope || 'episodes')
          if (sc === 'ledger' || sc === 'ledger.md') continue // 账本只允许记忆工具自动追加
          const p = resolveScope(arch, sc)
          if (!p) continue
          fs.mkdirSync(path.dirname(p), { recursive: true })
          const cur = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
          fs.writeFileSync(p, (cur ? cur.replace(/\s*$/, '') + '\n' : '') + input + '\n', 'utf8')
        }
        const outParts = []
        for (const r of Array.isArray(node.reads) ? node.reads : []) {
          const arch = r.arch || memArch
          if (!arch) continue
          const sc = String(r.scope || 'facts')
          const p = resolveScope(arch, sc)
          if (!p) continue
          const content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
          outParts.push(`==== ${arch} / ${sc} ====\n${content}`)
        }
        const out = outParts.join('\n\n')
        outputs.set(nodeId, out)
        onOutput({ runId, nodeId, output: out })
        onStatus({ runId, nodeId, status: 'done' })
      } catch (e) {
        onStatus({ runId, nodeId, status: 'error', error: e.message || String(e) })
      }
      return
    }

    // 自定义模块节点（自定义节点类型）：执行用户定义的 Python 代码（def run(input_text)）
    if (node.type === 'custom') {
      onStatus({ runId, nodeId, status: 'running' })
      const input = upstream.join('\n\n')
      try {
        const r = await runInlinePy(node.code || '', input)
        if (!r.ok) {
          const msg = r.error || (r.stderr && r.stderr.trim()) || '自定义模块执行失败'
          onStatus({ runId, nodeId, status: 'error', error: msg })
          outputs.set(nodeId, `[自定义模块执行失败] ${msg}`)
        } else {
          const out = ((r.stderr && r.stderr.trim()) ? r.stderr.trim() + '\n' : '') + r.stdout
          outputs.set(nodeId, out)
          onOutput({ runId, nodeId, output: out })
          onStatus({ runId, nodeId, status: 'done' })
        }
      } catch (e) {
        const msg = e.message || String(e)
        onStatus({ runId, nodeId, status: 'error', error: msg })
        outputs.set(nodeId, `[自定义模块执行失败] ${msg}`)
      }
      return
    }

    // 工具节点：内联 Python（mode=inline 直接执行 def run）或登记工具能力（MCP/内置，下游 skill 经连线调用）
    if (node.type === 'tool') {
      if (node.mode === 'inline' && node.code) {
        onStatus({ runId, nodeId, status: 'running' })
        const input = upstream.join('\n\n')
        try {
          const r = await runInlinePy(node.code, input)
          if (!r.ok) {
            const msg = r.error || (r.stderr && r.stderr.trim()) || '内联工具执行失败'
            onStatus({ runId, nodeId, status: 'error', error: msg })
            outputs.set(nodeId, `[内联工具执行失败] ${msg}`)
          } else {
            const out = ((r.stderr && r.stderr.trim()) ? r.stderr.trim() + '\n' : '') + r.stdout
            outputs.set(nodeId, out)
            onOutput({ runId, nodeId, output: out })
            onStatus({ runId, nodeId, status: 'done' })
          }
        } catch (e) {
          const msg = e.message || String(e)
          onStatus({ runId, nodeId, status: 'error', error: msg })
          outputs.set(nodeId, `[内联工具执行失败] ${msg}`)
        }
        return
      }
      const toolId = node.toolId || ''
      if (!toolId) {
        onStatus({ runId, nodeId, status: 'error', error: '工具节点未选择工具' })
        outputs.set(nodeId, '[工具节点] 未选择工具')
        return
      }
      capabilities[nodeId] = toolId
      toolManuals[nodeId] = {
        prompt: (node.prompt && String(node.prompt).trim()) || '',
        manual: (node.manual && String(node.manual).trim()) || ''
      }
      outputs.set(nodeId, `[工具能力] ${toolId}`)
      onStatus({ runId, nodeId, status: 'done' })
      return
    }

    // 通信总线节点（外部挂接式）：数据从左到右，外部节点（技能/记忆）拖线挂到连接点（points）上按序处理
    if (node.type === 'bus') {
      const points = [...(node.points || [])].sort((a, b) => (a.x || 0) - (b.x || 0))
      if (!points.length) {
        // 无连接点：按总线自身区域权限透传（兼容旧行为）
        const readZones = toZoneList(node.readZones)
        const writeZones = toZoneList(node.writeZones)
        const filtered = upstreamNodes
          .map((u) => filterReadZones(u.text, readZones))
          .filter((v) => v && v.trim())
        outputs.set(nodeId, filterWriteZones(filtered.join('\n\n'), writeZones))
        onStatus({ runId, nodeId, status: 'done' })
        return
      }
      // 总线入口数据：仅普通数据流上游（挂接连线不作为文本输入）
      const flowUp = flowEdges
        .filter((e) => e.to === nodeId && evalCond(e.when, outputs.get(e.from)))
        .map((e) => outputs.get(e.from))
        .filter((v) => v != null && String(v).trim())
      let cur = flowUp.join('\n\n')
      for (const pt of points) {
        const attNodes = edges
          .filter((e) => e.to === nodeId && e.pointId === pt.id)
          .map((e) => byId.get(e.from))
          .filter(Boolean)
        if (!attNodes.length) {
          onStatus({ runId, nodeId, status: 'error', error: '连接点未挂接节点' })
          cur = (cur ? cur + '\n\n' : '') + '（连接点未挂接节点）'
          continue
        }
        const readZones = toZoneList(pt.readZones)
        const writeZones = toZoneList(pt.writeZones)
        for (const attNode of attNodes) {
          const input = filterReadZones(cur, readZones)
          if (attNode.type === 'skill') {
            const skillId = attNode.skillId || ''
            const busSkill = skillId ? await skills.get(skillId) : null
            if (!busSkill) {
              onStatus({ runId, nodeId, status: 'error', error: `挂接技能不存在: ${skillId || '(未选择)'}` })
              cur = (cur ? cur + '\n\n' : '') + `（连接点挂接技能不存在: ${skillId || '(空)'}）`
              continue
            }
            const parts = []
            const prompt = (attNode.prompt || '').trim()
            if (prompt) parts.push(prompt)
            if (readZones.length) {
              parts.push(`你被授权的可读区域：${readZones.join('、')}。输出时可用 [[区域名]] ... [[/区域名]] 标记内容，供下游按权限读取。`)
            }
            if (input.trim()) parts.push(input)
            if (!parts.length) parts.push('（无上游输入，请补充输入或连线）')
            onStatus({ runId, nodeId, status: 'running' })
            try {
              const session = { id: `ag-bus-${agent.id}-${nodeId}-${runId}-${pt.id}`, messages: [] }
              const result = await chat.runChat({
                skillId,
                skillOverride: { ...busSkill },
                settings,
                model: resolveNodeModel(attNode, opts.model),
                userMessage: parts.join('\n\n'),
                historyMessages: [],
                session,
                signal,
                onToken: (t) => onToken({ nodeId, ...t }),
                onTool: () => {},
                onStatus: () => {}
              })
              cur = filterWriteZones(result.content, writeZones)
            } catch (err) {
              onStatus({ runId, nodeId, status: 'error', error: String((err && err.message) || err) })
              cur = (cur ? cur + '\n\n' : '') + `（连接点技能执行失败: ${String((err && err.message) || err)}）`
            }
          } else if (attNode.type === 'memory') {
            // 记忆节点挂接：写接口把总线内容写入记忆；读接口把记忆内容读出写回总线
            const memArch = attNode.memoryArch || ''
            const resolveScope = (arch, sc) => {
              const d = memory.dirPath(arch)
              if (!d) return null
              const s = String(sc || '')
              if (memory.FILE_NAMES[s]) return path.join(d, memory.FILE_NAMES[s])
              return memory.resolveInArch(arch, s)
            }
            onStatus({ runId, nodeId, status: 'running' })
            try {
              for (const w of Array.isArray(attNode.writes) ? attNode.writes : []) {
                const arch = w.arch || memArch
                if (!arch) continue
                const sc = String(w.scope || 'episodes')
                if (sc === 'ledger' || sc === 'ledger.md') continue
                const p = resolveScope(arch, sc)
                if (!p) continue
                fs.mkdirSync(path.dirname(p), { recursive: true })
                const curTxt = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
                fs.writeFileSync(p, (curTxt ? curTxt.replace(/\s*$/, '') + '\n' : '') + input + '\n', 'utf8')
              }
              const outParts = []
              for (const r of Array.isArray(attNode.reads) ? attNode.reads : []) {
                const arch = r.arch || memArch
                if (!arch) continue
                const sc = String(r.scope || 'facts')
                const p = resolveScope(arch, sc)
                if (!p) continue
                const content = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : ''
                outParts.push(`==== ${arch} / ${sc} ====\n${content}`)
              }
              cur = filterWriteZones(outParts.length ? outParts.join('\n\n') : input, writeZones)
            } catch (err) {
              onStatus({ runId, nodeId, status: 'error', error: String((err && err.message) || err) })
              cur = (cur ? cur + '\n\n' : '') + `（连接点记忆节点执行失败: ${String((err && err.message) || err)}）`
            }
          } else {
            onStatus({ runId, nodeId, status: 'error', error: `连接点不支持挂接 ${attNode.type} 节点` })
            cur = (cur ? cur + '\n\n' : '') + `（连接点不支持挂接 ${attNode.type} 节点）`
          }
        }
      }
      outputs.set(nodeId, cur)
      onStatus({ runId, nodeId, status: 'done' })
      return
    }

    // skill 节点
    if (node.type === 'skill') {
      const skill = await skills.get(node.skillId)
      if (!skill) {
        onStatus({ runId, nodeId, status: 'error', error: `skill 不存在: ${node.skillId}` })
        return
      }
      // 节点级工具：内嵌（旧数据兼容）+ 连入的工具节点工具（工具节点化后主要来源）
      const inToolIds = edges.filter((e) => e.to === nodeId).map((e) => e.from).filter((f) => capabilities[f])
      const skillOverride = {
        ...skill,
        tools: [...new Set([...(skill.tools || []), ...(Array.isArray(node.tools) ? node.tools : []), ...inToolIds.map((f) => capabilities[f])])]
      }
      // 上游工具节点的「建议操作手册」：额外描述 + 拉取的工具操作手册，注入给本 skill
      const inToolManuals = inToolIds
        .map((f) => ({ toolId: capabilities[f], info: toolManuals[f] }))
        .filter((x) => x.info && (x.info.prompt || x.info.manual))
      if (inToolManuals.length) {
        const blocks = inToolManuals.map((x) => {
          const head = `【工具节点：${x.toolId}】`
          const body = [x.info.prompt, x.info.manual].filter(Boolean).join('\n\n')
          return `${head}\n${body}`
        })
        skillOverride.systemPrompt = `${skillOverride.systemPrompt || skill.systemPrompt || ''}\n\n以下工具节点向你提供了建议操作手册，调用这些工具前请先阅读：\n${blocks.join('\n\n')}`
      }
      // 节点级记忆链接：绑定记忆架构 → 合并 memory_* 工具 + 注入策略提示
      const nodeMemories = Array.isArray(node.memories) ? node.memories : []
      const memFiles = []
      for (const mname of nodeMemories) {
        try {
          const bind = memory.archBinding(mname)
          if (bind) {
            if (Array.isArray(bind.tools) && bind.tools.length) {
              skillOverride.tools = [...new Set([...skillOverride.tools, ...bind.tools])]
            }
            if (bind.prompt) {
              skillOverride.systemPrompt = `${skillOverride.systemPrompt || skill.systemPrompt || ''}\n\n${bind.prompt}`
            }
            const d = memory.dirPath(mname)
            if (d) memFiles.push({ name: mname, dir: d })
          }
        } catch { /* 缺失记忆架构忽略 */ }
      }
      if (memFiles.length) {
        skillOverride.memoryFiles = memFiles
      }
      // 通信总线：按节点权限过滤
      const readZones = toZoneList(node.readZones)
      const writeZones = toZoneList(node.writeZones)
      const prompt = (node.prompt || '').trim()
      const parts = []
      if (prompt) parts.push(prompt)
      if (readZones.length) {
        parts.push(`你被授权的可读区域：${readZones.join('、')}。输出时可用 [[区域名]] ... [[/区域名]] 标记内容，供下游按权限读取。`)
      }
      const filtered = upstreamNodes
        .map((u) => filterReadZones(u.text, readZones))
        .filter((v) => v && v.trim())
      parts.push(...filtered)
      if (!parts.length) parts.push('（无上游输入，请补充输入或连线）')
      const userMessage = parts.join('\n\n')

      onStatus({ runId, nodeId, status: 'running' })
      try {
        const session = { id: `ag-${agent.id}-${nodeId}-${runId}`, messages: [] }
        // 工具管道上下文：记忆绑定 + 审计溯源
        const pipeCtx = {}
        if (memFiles.length) pipeCtx.memoryFiles = memFiles
        pipeCtx.agentId = agent.id
        pipeCtx.nodeId = nodeId
        pipeCtx.skillId = node.skillId
        const result = await chat.runChat({
          skillId: node.skillId,
          skillOverride,
          settings,
          model: resolveNodeModel(node, opts.model),
          userMessage,
          historyMessages: [],
          session,
          signal,
          toolContext: Object.keys(pipeCtx).length ? pipeCtx : undefined,
          onToken: (t) => onToken({ nodeId, ...t }),
          onTool: () => {},
          onStatus: () => {}
        })
        const out = filterWriteZones(result.content, writeZones)
        outputs.set(nodeId, out)
        onOutput({ runId, nodeId, output: out })
        onStatus({ runId, nodeId, status: 'done' })
      } catch (e) {
        if (signal && signal.aborted) {
          onStatus({ runId, nodeId, status: 'aborted' })
        } else {
          onStatus({ runId, nodeId, status: 'error', error: e.message || String(e) })
        }
      }
    }
  }
  // ---- executeNodeAt 结束 ----

  // 主循环：按拓扑顺序执行（前向边）
  for (const nodeId of order) {
    await executeNodeAt(nodeId)
  }

  // 回调回环（边调度）：callback 边把下游输出回传上游重跑，并沿前向边传播，最多 MAX_ROUNDS 轮
  const MAX_ROUNDS = 2
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const redo = new Map()
    for (const cb of callbackEdges) {
      const fb = outputs.get(cb.from)
      if (fb == null || String(fb).trim() === '') continue
      const src = byId.get(cb.from)
      const label = (src && src.label) || cb.from
      if (!redo.has(cb.to)) redo.set(cb.to, [])
      redo.get(cb.to).push(`【${label} 反馈】\n${fb}`)
    }
    if (!redo.size) break
    const seen = new Set()
    const queue = [...redo.keys()]
    for (const nid of queue) seen.add(nid)
    while (queue.length) {
      const nid = queue.shift()
      await executeNodeAt(nid, redo.get(nid))
      for (const e of forward) {
        if (e.from === nid && !seen.has(e.to) && !busAttached.has(e.to)) {
          seen.add(e.to)
          queue.push(e.to)
        }
      }
    }
    // 输出节点兜底刷新：汇总最新结果
    for (const oid of outputIds) {
      if (!seen.has(oid)) await executeNodeAt(oid)
    }
  }

  // 最终输出 = 所有输出节点的输出（按运行前捕获的 id）
  const finals = nodes.filter((n) => outputIds.has(n.id)).map((n) => outputs.get(n.id) || '').filter(Boolean)
  return { runId, result: finals.join('\n\n---\n\n'), outputs: Object.fromEntries(outputs) }
}

module.exports = { createAgentStore, createAgentDefStore, defToGraph, runAgent, runAgentPy, sanitizeAgent, sanitizeAgentPySource }
