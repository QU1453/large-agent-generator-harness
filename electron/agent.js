// 智能体（Agent）：可视化编排多个 skill 协作完成复杂任务
// 节点类型：input(输入) / skill(能力单元) / tool(工具/MCP) / protocol(智能体间协议)
//          / subagent(子智能体) / memory(记忆) / bus(通信总线) / output(输出)
// 连线语义：from 节点的输出 → to 节点的输入（从左到右）
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { spawn } = require('child_process')
const chat = require('./chat')
const skills = require('./skills')
const memory = require('./memory')
const protocols = require('./protocols')

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

// ---------------- 智能体定义（data/agent-defs）----------------
// 「智能体」栏：单智能体 = 模型配置（继承/自定义）+ 提示词 + 技能列表 + 工具列表。
// 存储改为目录式：data/agent-defs/<id>/agent.json（主定义文件）+ 自由辅助文件（说明文档/代码片段等），
// 编辑方式与技能/记忆一致：卡片点开 → 文件工作台（左文件树 / 中编辑器 / 右信息）。
// 工作流（画布）里的子智能体节点可直接引用智能体定义，运行时把定义转成最小图执行。
function createAgentDefStore(userDataDir) {
  const dir = path.join(userDataDir, 'agent-defs')
  fs.mkdirSync(dir, { recursive: true })
  const MAIN = 'agent.json'
  const CATS_FILE = 'categories.json'

  // 迁移旧单文件：data/agent-defs/<id>.json → data/agent-defs/<id>/agent.json
  const migrateLegacy = () => {
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json') || name === CATS_FILE) continue
      const old = path.join(dir, name)
      let st
      try { st = fs.statSync(old) } catch { continue }
      if (!st.isFile()) continue
      const id = name.slice(0, -5)
      const sub = path.join(dir, id)
      const main = path.join(sub, MAIN)
      try {
        fs.mkdirSync(sub, { recursive: true })
        fs.copyFileSync(old, main)
        fs.unlinkSync(old)
      } catch { /* 迁移失败不阻塞 */ }
    }
  }
  migrateLegacy()

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
  const list = () => {
    const items = []
    for (const name of fs.readdirSync(dir)) {
      if (name === CATS_FILE) continue
      const sub = path.join(dir, name)
      let st
      try { st = fs.statSync(sub) } catch { continue }
      if (!st.isDirectory()) continue
      const main = path.join(sub, MAIN)
      if (!fs.existsSync(main)) continue
      try {
        const a = JSON.parse(fs.readFileSync(main, 'utf8'))
        items.push({
          id: a.id,
          name: a.name,
          description: a.description || '',
          category: catMap[a.id] || '未分类',
          updatedAt: a.updatedAt || 0,
          skillCount: Array.isArray(a.skills) ? a.skills.length : 0,
          model: a.model || null
        })
      } catch { /* 忽略 */ }
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
      try {
        const d = JSON.parse(fs.readFileSync(mainFile(id), 'utf8'))
        return d && typeof d === 'object' ? d : null
      } catch { return null }
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
        createdAt: now,
        updatedAt: now
      }
      fs.mkdirSync(defDir(def.id), { recursive: true })
      fs.writeFileSync(mainFile(def.id), JSON.stringify(def, null, 2), 'utf8')
      return def
    },
    save(def) {
      if (!def || !def.id) throw new Error('智能体缺少 id')
      def.updatedAt = Date.now()
      fs.mkdirSync(defDir(def.id), { recursive: true })
      fs.writeFileSync(mainFile(def.id), JSON.stringify(def, null, 2), 'utf8')
      return def
    },
    remove(id) {
      try { fs.rmSync(defDir(id), { recursive: true, force: true }) } catch { /* 忽略 */ }
    },
    // ---- 文件工作台（多文件编辑）：主文件 agent.json 不可改名/删除 ----
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
      // 写主文件后刷新 updatedAt
      if (rel === MAIN) {
        try {
          const def = JSON.parse(fs.readFileSync(p, 'utf8'))
          if (def && def.id) this.save(def)
        } catch { /* 内容可能是非法 JSON，暂不刷新 */ }
      }
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
      if (rel === MAIN) throw new Error('主定义文件 agent.json 不可删除')
      const p = resolveIn(id, rel)
      if (!p) throw new Error('路径越界')
      if (!fs.existsSync(p)) throw new Error(`文件不存在: ${rel}`)
      fs.rmSync(p, { force: true })
      return { ok: true }
    },
    renameFile(id, oldRel, newRel) {
      if (oldRel === MAIN) throw new Error('主定义文件 agent.json 不可重命名')
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

// ---------------- A2A 安全协议（skill 间通信） ----------------
// 每个 skill 节点可声明 protocol（在节点卡片上直接编辑）：
//   enabled     协议开关
//   version     协议版本（A2A/1.0）
//   identity    本 skill 身份声明（默认取 skillId）
//   endpoint    对外端点 URL（skill card 的 endpoint 字段，可留空）
//   auth        { type: 'none'|'token'|'hmac', secret }  凭证处理（共享密钥）
//   access      { allowedPeers: [], deniedPeers: [] }    访问控制（允许/拒绝的 skill id）
//                { allowedTools: [], deniedTools: [] }   工具级访问控制（P4-1：pre-execute 拦截）
//   audit       是否写审计日志（协议运行轨迹留痕）
// 运行时：上游消息按协议封装（envelope），先做访问控制校验，再交 LLM；
// 结果同样按协议输出。审计记录写到 <userData>/audit/<agentId>.jsonl。
function normalizeProtocol(node) {
  const p = (node && node.protocol) || {}
  if (p.enabled === false) return null
  const access = p.access || {}
  return {
    enabled: true,
    version: p.version || 'A2A/1.0',
    identity: String(p.identity || node.skillId || node.id || 'anonymous'),
    endpoint: String(p.endpoint || ''),
    auth: {
      type: p.auth && p.auth.type ? p.auth.type : 'none',
      secret: (p.auth && p.auth.secret) ? String(p.auth.secret) : ''
    },
    access: {
      allowedPeers: Array.isArray(access.allowedPeers) ? access.allowedPeers.map(String) : [],
      deniedPeers: Array.isArray(access.deniedPeers) ? access.deniedPeers.map(String) : [],
      allowedTools: Array.isArray(access.allowedTools) ? access.allowedTools.map(String) : [],
      deniedTools: Array.isArray(access.deniedTools) ? access.deniedTools.map(String) : []
    },
    audit: p.audit !== false
  }
}

// 节点身份（用于访问控制匹配）：skill=skillId，输入/输出/记忆/总线=节点类型:节点id
function nodeIdentity(node) {
  if (!node) return 'unknown'
  if (node.type === 'skill') return String(node.skillId || '')
  return `${node.type}:${node.id}`
}

// A2A 信封：把一条上游消息封装为协议消息（含 from / ver / ts）
function a2aEnvelope(proto, fromId, text) {
  const ts = new Date().toISOString()
  return `[[A2A ${proto.version} from=${fromId} to=${proto.identity} ts=${ts}]]\n${text}\n[[/A2A]]`
}

// 协议访问控制：返回 {ok, reason}；upstreamNodes = 直接上游节点（含其输出文本）
function checkA2AAccess(proto, upstreamNodes) {
  const allowed = proto.access.allowedPeers.filter(Boolean)
  const denied = proto.access.deniedPeers.filter(Boolean)
  for (const u of upstreamNodes) {
    const id = nodeIdentity(u.node)
    if (!id) continue
    if (denied.includes(id) || denied.includes(u.node && u.node.skillId)) {
      return { ok: false, reason: `上游 ${id} 被该 skill 的 A2A 协议拒绝（deniedPeers）` }
    }
    if (allowed.length && !allowed.includes(id) && !allowed.includes(u.node && u.node.skillId)) {
      return { ok: false, reason: `上游 ${id} 不在该 skill 的 A2A 协议允许名单（allowedPeers: ${allowed.join(',')}）` }
    }
  }
  return { ok: true }
}

// 审计：追加一条协议运行记录
function a2aAudit(auditDir, agentId, entry) {
  if (!auditDir || !entry) return
  try {
    fs.mkdirSync(auditDir, { recursive: true })
    const fp = path.join(auditDir, `${String(agentId || 'agent')}.jsonl`)
    fs.appendFileSync(fp, JSON.stringify({ ts: Date.now(), ...entry }) + '\n', 'utf8')
  } catch { /* 审计失败不阻塞运行 */ }
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
  const auditDir = opts.auditDir || null
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
    // 上游输出（连同来源节点，供 A2A 协议做访问控制）；回调边不参与普通上游；分支边按 when 条件过滤
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
      // 工作流中没有 → 尝试智能体定义（data/agent-defs，单智能体转最小图）
      if (!sub && typeof agentStore.getDef === 'function') {
        const def = agentStore.getDef(subId)
        if (def) sub = defToGraph(def)
      }
      if (!sub) {
        fail(`子智能体不存在: ${subId}`)
        return
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

    // 协议节点：skill 间通信网关——加载协议 → 访问控制 → [[A2A]] 信封 → 审计
    if (node.type === 'protocol') {
      if (!node.protocolId) {
        onStatus({ runId, nodeId, status: 'error', error: '协议节点未选择协议' })
        outputs.set(nodeId, '[协议节点] 未选择协议')
        return
      }
      const protoData = protocols.get(node.protocolId)
      if (!protoData) {
        onStatus({ runId, nodeId, status: 'error', error: `协议不存在: ${node.protocolId}` })
        outputs.set(nodeId, `[协议节点] 协议不存在: ${node.protocolId}`)
        return
      }
      const proto = normalizeProtocol({ ...node, protocol: protoData })
      if (!proto) {
        // 协议停用：透明放行
        outputs.set(nodeId, upstream.join('\n\n'))
        onStatus({ runId, nodeId, status: 'done' })
        return
      }
      const acc = checkA2AAccess(proto, upstreamNodes)
      if (!acc.ok) {
        a2aAudit(auditDir, agent.id, { event: 'access-denied', gateway: nodeId, protocol: node.protocolId, identity: proto.identity, version: proto.version, reason: acc.reason })
        onStatus({ runId, nodeId, status: 'error', error: acc.reason })
        outputs.set(nodeId, `[A2A 协议拦截] ${acc.reason}`)
        return
      }
      const envParts = upstreamNodes
        .map((u) => a2aEnvelope(proto, nodeIdentity(u.node), u.text))
        .filter((v) => v && v.trim())
      outputs.set(nodeId, envParts.join('\n\n'))
      onStatus({ runId, nodeId, status: 'done' })
      a2aAudit(auditDir, agent.id, { event: 'message', gateway: nodeId, protocol: node.protocolId, identity: proto.identity, version: proto.version, from: upstreamNodes.map((u) => nodeIdentity(u.node)) })
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
      // A2A 安全协议：访问控制 + 消息封装 + 审计
      const proto = normalizeProtocol(node)
      let protocolParts = []
      if (proto) {
        const acc = checkA2AAccess(proto, upstreamNodes)
        if (!acc.ok) {
          const err = `A2A 协议拦截（${node.label || node.id}）: ${acc.reason}`
          onStatus({ runId, nodeId, status: 'error', error: err })
          a2aAudit(auditDir, agent.id, {
            event: 'access-denied', nodeId, skill: node.skillId,
            identity: proto.identity, version: proto.version, reason: acc.reason
          })
          outputs.set(nodeId, `[A2A 协议拦截] ${acc.reason}`)
          return
        }
        // 协议已通过：向上游消息加 A2A 信封，并注入协议说明
        for (const u of upstreamNodes) {
          u.enveloped = a2aEnvelope(proto, nodeIdentity(u.node), u.text)
        }
        protocolParts.push(
          `你已接入 A2A 安全协议（${proto.version}）。本 skill 身份：${proto.identity}${proto.endpoint ? `，对外端点：${proto.endpoint}` : ''}。` +
          `上游消息按协议封装为 [[A2A ...]] 信封（含来源身份与时间戳），来源须在允许名单内（已校验通过）。` +
          `回复时如有需要可同样用 [[A2A ${proto.version} from=${proto.identity} to=下游 ts=时间]] 标记结构化回传。`
        )
        a2aAudit(auditDir, agent.id, {
          event: 'message', nodeId, skill: node.skillId,
          identity: proto.identity, version: proto.version,
          from: upstreamNodes.map((u) => nodeIdentity(u.node)), auth: proto.auth.type
        })
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
      parts.push(...protocolParts)
      const filtered = upstreamNodes
        .map((u) => (proto ? (u.enveloped || u.text) : filterReadZones(u.text, readZones)))
        .filter((v) => v && v.trim())
      parts.push(...filtered)
      if (!parts.length) parts.push('（无上游输入，请补充输入或连线）')
      const userMessage = parts.join('\n\n')

      onStatus({ runId, nodeId, status: 'running' })
      try {
        const session = { id: `ag-${agent.id}-${nodeId}-${runId}`, messages: [] }
        // P4-1 工具管道上下文：记忆绑定 + A2A 协议工具级访问控制（pre-execute 拦截）+ 审计溯源
        const pipeCtx = {}
        if (memFiles.length) pipeCtx.memoryFiles = memFiles
        if (proto) {
          pipeCtx.protocol = {
            identity: proto.identity,
            version: proto.version,
            allowedTools: proto.access.allowedTools,
            deniedTools: proto.access.deniedTools
          }
          pipeCtx.agentId = agent.id
          pipeCtx.nodeId = nodeId
          pipeCtx.skillId = node.skillId
        }
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
        if (proto) {
          a2aAudit(auditDir, agent.id, {
            event: 'response', nodeId, skill: node.skillId,
            identity: proto.identity, version: proto.version, bytes: out.length
          })
        }
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

module.exports = { createAgentStore, createAgentDefStore, defToGraph, runAgent, sanitizeAgent }
