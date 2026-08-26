// 记忆仓库：记忆架构 = 一个"记忆空间"目录（md 文件优先，人可读、可审计）
// 存储：<userData>/memory/<架构名>/
//   policy.md    场景策略：什么时候读写、何时遗忘（可编辑，默认模板）
//   ledger.md    原始账本：只追加，每次写操作自动留痕（溯源）
//   facts.md     陈述性事实（偏好 / 配置 / 结论，随时覆写）
//   episodes.md  情景记忆（一次性事件，双时态）
//   skills.md    程序性技能（试错修复后的可复用步骤）
// 工作流智能体/输入/输出节点可链接记忆架构，运行时获得
// memory_read / memory_write / memory_append / memory_search / memory_forget 工具
// （绑定该架构目录），记忆跨运行保留；导出时随 LA 包整体复制到 memory/<架构名>/。
const fs = require('fs')
const path = require('path')
const { PythonEngine } = require('./python-engine')

let dir = null
let catsFile = null
let catList = []   // 分类名列表
let catMap = {}    // 记忆 name -> 分类

// 记忆空间内的文件（key -> 文件名）；views 派生视图暂以 ledger/facts 可读 + search 替代
const SCOPE_KEYS = ['policy', 'facts', 'episodes', 'skills', 'ledger']
const FILE_NAMES = {
  policy: 'policy.md',
  ledger: 'ledger.md',
  facts: 'facts.md',
  episodes: 'episodes.md',
  skills: 'skills.md'
}
const FILE_LABELS = {
  policy: '策略 policy',
  facts: '事实 facts',
  episodes: '情景 episodes',
  skills: '技能 skills',
  ledger: '账本 ledger（只读）'
}

function init(userDataDir) {
  dir = path.join(userDataDir, 'memory')
  fs.mkdirSync(dir, { recursive: true })
  catsFile = path.join(dir, 'categories.json')
  loadCats()
  migrateLegacy()
  loadMemScripts()
}

// ---------------- 记忆脚本引擎（.mem.py） ----------------
// 记忆体系内的程序性记忆脚本：放在记忆架构目录下（如 pid-tuning/pid_memory.mem.py），
// 由 Python 引擎加载，暴露 mem_* 工具。与工具包（.tool.py）不同：这些工具属于「记忆」，
// 绑定该记忆架构的智能体自动获得（archBinding 并入），工具包面板不显示。
let memEngine = null           // PythonEngine 单例
let memScripts = []            // [{arch, name, file, tools: [{name, description, parameters}]}]
let memScriptError = null
let memLoaded = false

function scanMemScriptFiles() {
  const out = []
  if (!dir || !fs.existsSync(dir)) return out
  for (const arch of fs.readdirSync(dir)) {
    const archDir = path.join(dir, arch)
    let st
    try { st = fs.statSync(archDir) } catch { continue }
    if (!st.isDirectory()) continue
    for (const f of fs.readdirSync(archDir)) {
      if (!f.endsWith('.mem.py')) continue
      out.push({ arch, name: f.replace(/\.mem\.py$/, ''), file: path.join(archDir, f) })
    }
  }
  return out
}

// 加载全部记忆脚本（记忆架构目录下 *.mem.py），启动 Python 引擎
function loadMemScripts() {
  memScripts = []
  memScriptError = null
  const files = scanMemScriptFiles()
  if (!files.length) { if (memEngine) { try { memEngine.stop() } catch {} memEngine = null }; memLoaded = true; return }
  if (memEngine) { try { memEngine.stop() } catch {} }
  memEngine = new PythonEngine(files.map((f) => f.file))
  ;(async () => {
    try {
      const modules = await memEngine.listTools()
      for (const m of modules || []) {
        const src = files.find((f) => f.file === m.file) || files.find((f) => f.name === (m.id || m.name)) || {}
        memScripts.push({
          arch: src.arch || '',
          name: src.name || m.id || m.name,
          file: m.file,
          tools: Array.isArray(m.tools) ? m.tools.map((t) => ({ name: t.name, description: t.description || '', parameters: t.parameters || null })) : []
        })
      }
      memLoaded = true
    } catch (e) {
      memScriptError = e.message
      memLoaded = true
      console.warn('[memory] 记忆脚本加载失败:', e.message)
    }
  })()
}

// 某记忆架构启用的记忆脚本工具名列表（archBinding 并入绑定工具集）
function memScriptToolsFor(arch) {
  return memScripts
    .filter((s) => s.arch === arch)
    .flatMap((s) => s.tools.map((t) => t.name))
}

// 某记忆架构启用的记忆脚本完整工具定义（供 LLM schema 合并）
function memScriptToolDefsFor(arch) {
  return memScripts
    .filter((s) => s.arch === arch)
    .flatMap((s) => s.tools)
}

// 全部记忆脚本工具定义（LLM schema 合并时按 allowed 过滤）
function allMemScriptToolDefs() {
  return memScripts.flatMap((s) => s.tools)
}

// 执行记忆脚本工具：由 tools.js 分发（LLM 函数名 mem_xxx）
async function execMemScriptTool(name, args) {
  if (!memEngine) throw new Error('记忆脚本引擎不可用')
  return await memEngine.execTool(name, args || {})
}

// 重载记忆脚本（记忆工作台保存 .mem.py 后调用）
function reloadMemScripts() {
  loadMemScripts()
  return true
}

// ---------------- 分类（像智能体/协议一样管理，存 memory/categories.json） ----------------
function loadCats() {
  catList = []
  catMap = {}
  if (!catsFile || !fs.existsSync(catsFile)) return
  try {
    const d = JSON.parse(fs.readFileSync(catsFile, 'utf8'))
    catList = Array.isArray(d.list) ? d.list.filter(Boolean) : []
    if (d.map && typeof d.map === 'object') catMap = d.map
  } catch { /* 忽略 */ }
}

function saveCats() {
  if (!catsFile) return
  try {
    fs.mkdirSync(path.dirname(catsFile), { recursive: true })
    fs.writeFileSync(catsFile, JSON.stringify({ list: catList, map: catMap }, null, 2), 'utf8')
  } catch { /* 忽略 */ }
}

function addCategory(name) {
  const n = String(name || '').trim()
  if (!n) throw new Error('分类名不能为空')
  if (!catList.includes(n)) catList.push(n)
  saveCats()
  return listCategories()
}

function setCategory(memName, name) {
  const n = String(name || '').trim()
  if (!n) throw new Error('分类名不能为空')
  if (!catList.includes(n)) catList.push(n)
  if (n === '未分类') delete catMap[memName]
  else catMap[memName] = n
  saveCats()
  return listCategories()
}

function removeCategory(name) {
  const n = String(name || '').trim()
  if (!n) throw new Error('分类名不能为空')
  if (n === '未分类') throw new Error('「未分类」是默认分组，不能删除')
  catList = catList.filter((c) => c !== n)
  for (const k of Object.keys(catMap)) if (catMap[k] === n) delete catMap[k]
  saveCats()
  return listCategories()
}

function listCategories() {
  const used = new Set(Object.values(catMap))
  const merged = [...catList]
  for (const u of used) if (!merged.includes(u)) merged.push(u)
  return { list: merged, map: { ...catMap } }
}

// 旧版单文件记忆（memory/<name>.md）迁移为目录空间：内容入 facts.md，其余文件用默认模板
function migrateLegacy() {
  if (!fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) {
    const p = path.join(dir, f)
    let isDir = false
    try {
      isDir = fs.statSync(p).isDirectory()
    } catch {
      continue
    }
    if (!isDir && f.endsWith('.md')) {
      const name = path.basename(f, '.md')
      const d = path.join(dir, name)
      if (!fs.existsSync(d)) {
        fs.mkdirSync(d, { recursive: true })
        const content = fs.readFileSync(p, 'utf8')
        fs.writeFileSync(path.join(d, FILE_NAMES.facts), content, 'utf8')
        for (const key of ['policy', 'episodes', 'skills', 'ledger']) {
          fs.writeFileSync(path.join(d, FILE_NAMES[key]), defaultFile(key, name), 'utf8')
        }
      }
      try {
        fs.rmSync(p, { force: true })
      } catch {}
    }
  }
}

function safeName(name) {
  return String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_')
}

// 默认策略模板：场景化可编辑（读写时机 / 遗忘规则 / 检索规则 / 双时态）
function defaultPolicy(title) {
  return `# ${title}（记忆策略）

## 读写时机
- 用户主动要求记住 / 遗忘时，必须执行写入 / 删除；
- 事实类信息（偏好、配置、结论）写入 facts；
- 一次性事件（某次任务经过）写入 episodes；
- 试错后修复成功的步骤，去废话化后写入 skills（可复用为宏指令）。

## 遗忘规则
- 与最新记录冲突的旧记录，确认无用后删除或打 [[valid:...]] 时间戳归档；
- facts 中超过 90 天未被引用的条目，可打 [stale] 标记或删除。

## 检索规则
- 优先精确匹配主题名；无精确命中再全文搜索（memory_search）；
- 检索结果按更新时间倒序返回。

## 双时态
- 每条记忆带 [[valid:YYYY-MM-DD]]（现实生效时间）与 [[txn:YYYY-MM-DD]]（写入时间）。
`
}

function defaultFile(key, name, initialFacts) {
  switch (key) {
    case 'policy':
      return defaultPolicy(name)
    case 'facts':
      return `# ${name}（事实）\n\n${String(initialFacts || '').replace(/^\s+|\s+$/g, '')}\n`
    case 'episodes':
      return `# ${name}（情景记忆）\n\n`
    case 'skills':
      return `# ${name}（程序性技能）\n\n`
    case 'ledger':
      return `# 记忆账本（只追加）\n\n| txn | 操作 | 文件 | 摘要 |\n|---|---|---|---|\n`
    default:
      return ''
  }
}

function archDir(name) {
  const n = safeName(name)
  if (!n) return null
  return path.join(dir, n)
}

function archExists(name) {
  const d = archDir(name)
  return d && fs.existsSync(d)
}

function fileOf(name, key) {
  const d = archDir(name)
  if (!d) return null
  return path.join(d, FILE_NAMES[key] || 'facts.md')
}

function parseMeta(d) {
  const name = path.basename(d)
  const policyFile = path.join(d, 'policy.md')
  let policy = ''
  try {
    policy = fs.readFileSync(policyFile, 'utf8')
  } catch {
    return null
  }
  const titleMatch = policy.match(/^#\s+(.+)\s*$/m)
  const title = titleMatch ? titleMatch[1].trim() : name
  const body = policy.replace(/^#\s+.+\s*$/m, '').trim()
  const desc = body.split(/\n/)[0]?.slice(0, 120) || ''
  let stat = null
  try {
    stat = fs.statSync(d)
  } catch {
    return null
  }
  return { name, title, desc, updatedAt: stat.mtimeMs, path: d }
}

function list() {
  if (!dir) return []
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f !== '_sessions') // 会话私有记忆副本（迷你沙盒）不出现在架构列表
    .filter((f) => fs.statSync(path.join(dir, f)).isDirectory())
    .map((f) => {
      const meta = parseMeta(path.join(dir, f))
      if (!meta) return null
      return { ...meta, category: catMap[meta.name] || '未分类' }
    })
    .filter(Boolean)
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

function get(name) {
  const d = archDir(name)
  if (!d || !fs.existsSync(d)) return null
  const files = SCOPE_KEYS.map((key) => {
    let content = ''
    try {
      content = fs.readFileSync(path.join(d, FILE_NAMES[key]), 'utf8')
    } catch {
      content = defaultFile(key, name)
    }
    return {
      key,
      label: FILE_LABELS[key],
      file: FILE_NAMES[key],
      content,
      readOnly: key === 'ledger' // 账本只追加，禁止界面编辑
    }
  })
  return { name, path: d, meta: parseMeta(d), files }
}

function create(name, initialFacts) {
  const n = safeName(name)
  if (!n) throw new Error('记忆名不能为空')
  const d = path.join(dir, n)
  if (fs.existsSync(d)) throw new Error(`记忆「${n}」已存在`)
  fs.mkdirSync(d, { recursive: true })
  for (const key of SCOPE_KEYS) {
    fs.writeFileSync(path.join(d, FILE_NAMES[key]), defaultFile(key, n, initialFacts), 'utf8')
  }
  // 通信总线默认开启：bus.md（可关闭，见 config.json bus=false）
  fs.writeFileSync(path.join(d, 'bus.md'), '# 通信总线（区域语法 [[区域]]…[[/区域]]）\n\n', 'utf8')
  return get(n)
}

// 保存指定文件（key ∈ policy/facts/episodes/skills；ledger 由工具自动追加，禁止界面写）
function save(name, key, content) {
  const n = safeName(name)
  if (!n) throw new Error('记忆名不能为空')
  if (key === 'ledger') throw new Error('账本 ledger 只允许追加（由记忆工具自动记录），请直接编辑其他文件')
  const fp = fileOf(name, key)
  if (!fp) throw new Error('记忆名不能为空')
  const d = archDir(name)
  if (!fs.existsSync(d)) throw new Error(`记忆「${n}」不存在`)
  fs.mkdirSync(d, { recursive: true })
  fs.writeFileSync(fp, String(content ?? ''), 'utf8')
  return get(n)
}

function remove(name) {
  const d = archDir(name)
  if (!d) return { ok: false, error: '记忆名不能为空' }
  if (!fs.existsSync(d)) return { ok: false, error: `记忆「${safeName(name)}」不存在` }
  fs.rmSync(d, { recursive: true, force: true })
  delete catMap[safeName(name)]
  saveCats()
  return { ok: true }
}

// 引擎绑定用：返回某记忆架构的目录绝对路径（不存在也返回，运行时可创建）
function dirPath(name) {
  return archDir(name)
}

// 引擎侧文件访问（tools.js / exporter 用）
function scopeFile(name, key) {
  return fileOf(name, key)
}

// ---------------- 工作台/配置（阶段 A） ----------------

const DEFAULT_CFG = {
  defaults: { writeScope: 'facts', appendScope: 'episodes' },
  ledger: true,
  txn: true,
  policy: 'policy.md',
  helpers: [],
  organizeAgent: '',
  engine: '',
  // 记忆工作区绑定（像工作区一样可增删）：链接的 skill / 工具 / 通信总线
  skills: [],
  tools: [],
  bus: true,
  // 受保护文件（相对路径）：protected 为 null 表示未显式设置 → 内置 5 核心默认保护
  protected: null
}

const ARRAY_KEYS = ['helpers', 'skills', 'tools']

function isCfgKey(k) {
  return ['defaults', 'ledger', 'txn', 'policy', 'helpers', 'organizeAgent', 'engine', 'skills', 'tools', 'bus', 'protected'].includes(k)
}

// 读架构差异化配置（config.json，缺失字段用默认值）
function loadConfig(name) {
  const d = archDir(name)
  if (!d) return { ...DEFAULT_CFG, defaults: { ...DEFAULT_CFG.defaults } }
  const fp = path.join(d, 'config.json')
  const cfg = { ...DEFAULT_CFG, defaults: { ...DEFAULT_CFG.defaults } }
  if (fs.existsSync(fp)) {
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf8'))
      for (const k of Object.keys(cfg)) {
        if (!isCfgKey(k)) continue
        if (k === 'defaults' && raw.defaults && typeof raw.defaults === 'object') {
          cfg.defaults = { ...cfg.defaults, ...raw.defaults }
        } else if (k in raw) {
          cfg[k] = raw[k]
        }
      }
    } catch {}
  }
  return cfg
}

// 写架构差异化配置（只覆盖传入的合法字段，保留其余）
function saveConfig(name, patch) {
  const d = archDir(name)
  if (!d) throw new Error('记忆名不能为空')
  const fp = path.join(d, 'config.json')
  const cur = loadConfig(name)
  if (patch && typeof patch === 'object') {
    if (patch.defaults && typeof patch.defaults === 'object') {
      cur.defaults = { ...cur.defaults, ...patch.defaults }
    }
    for (const k of ['ledger', 'txn', 'policy', 'organizeAgent', 'engine', 'bus']) {
      if (k in patch) cur[k] = patch[k]
    }
    for (const k of ARRAY_KEYS) {
      if (k in patch) cur[k] = Array.isArray(patch[k]) ? patch[k].filter(Boolean) : []
    }
    if ('protected' in patch) {
      cur.protected = Array.isArray(patch.protected) ? [...new Set(patch.protected.filter(Boolean))] : null
    }
  }
  fs.writeFileSync(fp, JSON.stringify(cur, null, 2), 'utf8')
  // 启用通信总线时自动创建 bus.md（空文件，可编辑）
  if (cur.bus !== false && !fs.existsSync(path.join(d, 'bus.md'))) {
    try { fs.writeFileSync(path.join(d, 'bus.md'), '# 通信总线（区域语法 [[区域]]…[[/区域]]）\n\n', 'utf8') } catch {}
  }
  return cur
}

// 从任意目录读架构差异化配置（用于会话私有记忆副本；dir 不一定是 archDir(name)）
function loadConfigAt(dirPath) {
  const cfg = { ...DEFAULT_CFG, defaults: { ...DEFAULT_CFG.defaults } }
  if (!dirPath) return cfg
  const fp = path.join(dirPath, 'config.json')
  if (fs.existsSync(fp)) {
    try {
      const raw = JSON.parse(fs.readFileSync(fp, 'utf8'))
      for (const k of Object.keys(cfg)) {
        if (!isCfgKey(k)) continue
        if (k === 'defaults' && raw.defaults && typeof raw.defaults === 'object') {
          cfg.defaults = { ...cfg.defaults, ...raw.defaults }
        } else if (k in raw) {
          cfg[k] = raw[k]
        }
      }
    } catch {}
  }
  return cfg
}

// 架构目录 mtime（版本检测：编辑保存后变化）
function archMtime(name) {
  const d = archDir(name)
  if (!d || !fs.existsSync(d)) return 0
  try {
    return fs.statSync(d).mtimeMs
  } catch {
    return 0
  }
}

// 架构内文件安全解析（防越界）：相对架构目录
function resolveInArch(name, rel) {
  const d = archDir(name)
  if (!d) return null
  const p = path.resolve(d, String(rel || '').replace(/^[/\\]+/, ''))
  const root = d.endsWith(path.sep) ? d : d + path.sep
  if (!(p === d || p.startsWith(root))) return null
  return p
}

// 相对任意目录安全解析（防越界）：用于会话私有记忆副本（dir 不一定是 archDir(name)）
function resolveInDir(dirPath, rel) {
  if (!dirPath) return null
  const p = path.resolve(dirPath, String(rel || '').replace(/^[/\\]+/, ''))
  const root = dirPath.endsWith(path.sep) ? dirPath : dirPath + path.sep
  if (!(p === dirPath || p.startsWith(root))) return null
  return p
}

// 文件树：内置 5 文件 + 其余全部文件（notes/*、bus.md、engine.py、config.json、任意自定义文件）
// 每项带 protected：受保护的文件删除按钮禁用（灰色）；config.protected 未设置时内置 5 核心默认保护
function listFiles(name) {
  const d = archDir(name)
  if (!d || !fs.existsSync(d)) return []
  const cfg = loadConfig(name)
  const protList = cfg && Array.isArray(cfg.protected) ? cfg.protected : null
  const protOf = (rel, builtin) => (protList ? protList.includes(rel) : !!builtin)
  const builtin = SCOPE_KEYS.map((key) => ({
    rel: FILE_NAMES[key],
    label: FILE_LABELS[key],
    kind: key === 'ledger' ? 'ledger' : 'md',
    builtin: true,
    protected: protOf(FILE_NAMES[key], true)
  }))
  const extra = []
  const kindOf = (r) => {
    const e = String(r).split('.').pop().toLowerCase()
    if (e === 'py') return 'py'
    if (e === 'json') return 'json'
    return 'md'
  }
  const walk = (cur, rel) => {
    let entries = []
    try { entries = fs.readdirSync(cur) } catch { return }
    for (const f of entries.sort()) {
      const p = path.join(cur, f)
      const r = rel ? `${rel}/${f}` : f
      let isDir = false
      try { isDir = fs.statSync(p).isDirectory() } catch { continue }
      if (isDir) { walk(p, r); continue }
      if (Object.values(FILE_NAMES).includes(r)) continue // 内置核心文件已在 builtin 列表
      if (r === 'canvas.json') continue // 画布布局文件（内部数据，不进文件树）
      extra.push({ rel: r, label: r, kind: kindOf(r), builtin: false, protected: protOf(r, false) })
    }
  }
  walk(d, '')
  return [...builtin, ...extra]
}

// 切换文件保护：受保护的文件删除按钮禁用（灰色）；默认内置 5 核心受保护
function setProtected(name, rel, on) {
  const d = archDir(name)
  if (!d) throw new Error('记忆名不能为空')
  const p = resolveInArch(name, rel)
  if (!p) throw new Error('路径越界')
  const relNorm = path.relative(d, p).replace(/\\/g, '/')
  const cfg = loadConfig(name)
  // 首次切换时，若未显式设置过 protected，先初始化为"内置 5 核心默认保护"
  let prot = Array.isArray(cfg.protected) ? [...cfg.protected] : Object.values(FILE_NAMES)
  prot = on ? [...new Set([...prot, relNorm])] : prot.filter((x) => x !== relNorm)
  saveConfig(name, { protected: prot })
  return { ok: true, protected: prot }
}

// 读架构内任意文件（工作台编辑器）
function readFileAny(name, rel) {
  const p = resolveInArch(name, rel)
  if (!p) throw new Error('路径越界')
  if (!fs.existsSync(p)) throw new Error(`文件不存在: ${rel}`)
  return fs.readFileSync(p, 'utf8')
}

// 写架构内任意文件（工作台保存；ledger 仍只读）
function writeFileAny(name, rel, content) {
  const p = resolveInArch(name, rel)
  if (!p) throw new Error('路径越界')
  if (path.basename(p) === 'ledger.md') throw new Error('账本 ledger 只允许追加（由记忆工具自动记录）')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, String(content ?? ''), 'utf8')
  return { rel: rel.replace(/\\/g, '/'), ok: true }
}

// 新建架构内任意文件：可带子目录（如 notes/待办.md / bus.md / ideas），
// 无扩展名自动补 .md；默认内容 md 为标题模板、其余为空。禁止与内置核心文件重名。
function createFile(name, rel, content) {
  const d = archDir(name)
  if (!d) throw new Error('记忆名不能为空')
  if (!fs.existsSync(d)) throw new Error(`记忆「${safeName(name)}」不存在`)
  let r = String(rel || '').trim().replace(/\\/g, '/')
  if (!r) throw new Error('文件路径不能为空')
  const base = r.split('/').pop()
  if (/\.\w+$/.test(base)) {
    if (Object.values(FILE_NAMES).includes(r)) throw new Error(`「${r}」是内置核心文件，不能新建同名文件`)
  } else {
    r = `${r}.md`
  }
  const p = resolveInArch(name, r)
  if (!p) throw new Error('路径越界')
  if (fs.existsSync(p)) throw new Error(`文件已存在: ${r}`)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const isMd = r.endsWith('.md')
  const body = content != null ? String(content) : (isMd ? `# ${path.basename(p, '.md')}\n\n` : '')
  fs.writeFileSync(p, body, 'utf8')
  return { rel: r, ok: true }
}

// 删除架构内任意文件：内置核心文件（policy/facts/episodes/skills/ledger）禁止删除，其余可删
function deleteFile(name, rel) {
  const d = archDir(name)
  if (!d) throw new Error('记忆名不能为空')
  const p = resolveInArch(name, rel)
  if (!p) throw new Error('路径越界')
  const relNorm = path.relative(d, p).replace(/\\/g, '/')
  // 受保护文件不可删（默认内置 5 核心受保护；取消保护后即可删）
  const cfg = loadConfig(name)
  const protList = cfg && Array.isArray(cfg.protected) ? cfg.protected : Object.values(FILE_NAMES)
  if (protList.includes(relNorm)) {
    throw new Error(`「${relNorm}」处于保护状态，不能删除（右键该文件可取消保护）`)
  }
  if (!fs.existsSync(p)) throw new Error('文件不存在')
  if (fs.statSync(p).isDirectory()) throw new Error('不能删除目录，请先删除目录中的文件')
  fs.rmSync(p)
  // 清理可能变空的 notes 目录
  try {
    const nd = path.join(d, 'notes')
    if (fs.existsSync(nd) && fs.readdirSync(nd).length === 0) fs.rmdirSync(nd)
  } catch {}
  return { ok: true }
}

// 记忆绑定给智能体：返回记忆工具列表 + system 提示（工作流节点 / 会话 / 工作区绑定共用）
// 绑定信息来自 config.json：链接的工具（并入工具集）、链接的技能（注入正文）、链接的智能体（提示协作）、通信总线（bus.md 区域语法）
function archBinding(name) {
  const m = get(name)
  const cfg = loadConfig(name)
  const policyBody = (m && m.meta && m.meta.desc) || ''
  const parts = []
  parts.push(`你绑定了可长期读写的记忆架构「${name}」${policyBody ? `（策略摘要：${policyBody}）` : ''}。每个架构是一个记忆空间（policy 策略 / facts 事实 / episodes 情景 / skills 技能 / ledger 账本 / bus 通信总线），可用工具：memory_read（读）、memory_write（覆写，默认 facts）、memory_append（追加，默认 episodes）、memory_search（全文检索）、memory_forget（遗忘）。规则：写入自动带 [[txn:日期]] 时间戳并记入账本；先遵循 policy 决定读写时机与遗忘规则；重要结论/约定/用户偏好写 facts，一次性事件写 episodes，修复成功步骤写 skills；记忆跨运行保留。`)
  // 记忆脚本工具（mem_*，如 pid 调参的三层记忆）：绑定该架构自动获得
  const memToolNames = memScriptToolsFor(name)
  if (memToolNames.length) {
    parts.push(`该架构还带有程序性记忆脚本，可用工具：${memToolNames.join('、')}。按脚本描述使用（如短期会话 mem_get_session / mem_update_session、长期经验 mem_record_lesson / mem_query_lessons、程序性宏 mem_make_recipe / mem_apply_recipe、目录路由 mem_catalog / mem_route）。`)
  }
  // 链接的 skill：协作提示
  const skNames = Array.isArray(cfg.skills) ? cfg.skills.filter(Boolean) : []
  if (skNames.length) parts.push(`该记忆架构与这些 skill 共享：${skNames.join('、')}。读取记忆时注意它们留下的记录，写入时保持条理。`)
  // 通信总线：bus.md 区域语法
  if (cfg.bus !== false) {
    try {
      const busFile = path.join(archDir(name), 'bus.md')
      if (!fs.existsSync(busFile)) fs.writeFileSync(busFile, '# 通信总线（区域语法 [[区域]]…[[/区域]]）\n\n', 'utf8')
    } catch {}
    parts.push(`该架构启用了通信总线（bus.md）：多个智能体可在同一文件里分区沟通。格式：[[区域名]]内容[[/区域名]]；读取用 memory_read（scope=bus.md），写入/追加用 memory_write / memory_append（scope=bus.md）。`)
  }
  return {
    tools: [...new Set(['memory_read', 'memory_write', 'memory_append', 'memory_search', 'memory_forget', ...(Array.isArray(cfg.tools) ? cfg.tools : []), ...memScriptToolsFor(name)])],
    prompt: parts.join('\n\n')
  }
}

// 整理记忆：优先跑 config.organizeAgent（agent 引擎），否则用默认管家流程
// （assistant 读全部记忆 → 总结/去重/分类 → 用 memory_* 工具写回，账本留痕）
async function runOrganize(name, opts) {
  const cfg = loadConfig(name)
  const d = archDir(name)
  if (!d) throw new Error('记忆名不能为空')
  fs.mkdirSync(d, { recursive: true })
  const readSafe = (p) => (fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '')
  const dump = SCOPE_KEYS
    .filter((k) => k !== 'ledger')
    .map((k) => `==== ${FILE_NAMES[k]} ====\n${readSafe(path.join(d, FILE_NAMES[k]))}`)
    .join('\n\n')
  const settings = opts && opts.settings
  const signal = opts && opts.signal

  // ① 配置了整理智能体 → 复用 agent 引擎
  if (cfg.organizeAgent) {
    const agentStore = opts && opts.agentStore
    const ag = agentStore && agentStore.get(cfg.organizeAgent)
    if (ag) {
      const agent = require('./agent')
      const inputs = {}
      for (const n of ag.nodes || []) if (n.type === 'input') inputs[n.id] = dump
      const res = await agent.runAgent({
        agent: ag, agentStore, settings, inputs, signal
      })
      return { ok: true, note: `已按整理智能体「${ag.name}」完成整理`, result: res.result }
    }
  }

  // ② 默认管家流程：assistant 读全部记忆 → 去重/分类 → memory_* 写回
  const chat = require('./chat')
  const skills = require('./skills')
  const base = await skills.get('assistant')
  const bind = archBinding(name)
  const session = { id: `organize-${name}-${Date.now()}`, messages: [] }
  const result = await chat.runChat({
    skillId: 'assistant',
    skillOverride: base
      ? {
          ...base,
          tools: [...new Set([...(base.tools || []), ...bind.tools])],
          systemPrompt: `${base.systemPrompt || ''}\n\n你是「记忆管家」。下面会给出当前记忆空间的全部内容，请按 policy 规则进行整理：去重、合并重复条目、把信息分类归位（事实写 facts、一次性事件写 episodes、可复用步骤写 skills）。用 memory_* 工具把整理结果写回记忆（memory_write 覆写 / memory_append 追加 / memory_forget 清理），保持文件结构清晰、内容精炼；不要改动 policy 与 ledger。`
        }
      : undefined,
    settings,
    model: (settings && settings.model) || '',
    userMessage: `请整理以下记忆内容：\n\n${dump}`,
    historyMessages: [],
    session,
    signal,
    toolContext: { memoryFiles: [{ name, dir: d }] }
  })
  return { ok: true, note: '已按默认管家流程整理记忆', result: result.content }
}

// 提取记忆管家：把一段文本（对话记录/长文/会议纪要）蒸馏成结构化记忆写回
// （事实写 facts、一次性事件写 episodes、可复用步骤写 skills，账本留痕）
async function runExtract(name, text, opts) {
  const d = archDir(name)
  if (!d) throw new Error('记忆名不能为空')
  if (!fs.existsSync(d)) throw new Error(`记忆「${safeName(name)}」不存在`)
  fs.mkdirSync(d, { recursive: true })
  const body = String(text || '').trim()
  if (!body) throw new Error('没有可提取的内容')
  const settings = opts && opts.settings
  const signal = opts && opts.signal
  const chat = require('./chat')
  const skills = require('./skills')
  const base = await skills.get('assistant')
  const bind = archBinding(name)
  const session = { id: `extract-${name}-${Date.now()}`, messages: [] }
  const result = await chat.runChat({
    skillId: 'assistant',
    skillOverride: base
      ? {
          ...base,
          tools: [...new Set([...(base.tools || []), ...bind.tools])],
          systemPrompt: `${base.systemPrompt || ''}\n\n${bind.prompt}\n\n你现在担任「记忆提取管家」：从给定文本中提取值得长期保留的信息，并用 memory_* 工具写入记忆——用户偏好/关键结论/约定写 facts（memory_write），发生过的一次性事件写 episodes（memory_append），试错后成功的可复用步骤写 skills（memory_append scope=skills.md 或 memory_write scope=skills.md）。无关紧要的寒暄、重复信息不要写。写完用一句话汇报你写入了什么。`
        }
      : undefined,
    settings,
    model: (settings && settings.model) || '',
    userMessage: `请从下面这段内容中提取值得长期保留的记忆并写入架构「${name}」：\n\n${body.slice(0, 80000)}`,
    historyMessages: [],
    session,
    signal,
    toolContext: { memoryFiles: [{ name, dir: d }] }
  })
  return { ok: true, note: '已提取记忆（管家流程）', result: result.content }
}

// 记忆策略更替：只保留文档形式的记忆（policy/facts/episodes/skills/bus），清空账本（数据库式留痕）
function resetLedger(name) {
  const d = archDir(name)
  if (!d || !fs.existsSync(d)) throw new Error(`记忆「${safeName(name)}」不存在`)
  fs.writeFileSync(path.join(d, FILE_NAMES.ledger), defaultFile('ledger', name), 'utf8')
  return { ok: true, note: '已清空账本（数据库留痕），仅保留文档形式的记忆' }
}

// ---------------- 会话级独立记忆副本（迷你沙盒） ----------------
// 每一段会话都是一个迷你沙盒：绑定记忆架构时克隆一份到 <userData>/memory/_sessions/<sessionId>/，
// 会话内的记忆读写都作用于这份私有副本，互不影响；原架构保持共享模板。
function sessionCopyDir(sessionId) {
  if (!dir || !sessionId) return null
  return path.join(dir, '_sessions', safeName(sessionId))
}

// 从某记忆架构克隆一份到会话私有副本（独立沙盒；已存在则保留，不覆盖）
function cloneForSession(archName, sessionId) {
  const src = archDir(archName)
  const dest = sessionCopyDir(sessionId)
  if (!src || !dest) throw new Error('参数不合法')
  if (!fs.existsSync(src)) throw new Error(`记忆「${safeName(archName)}」不存在`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  if (fs.existsSync(dest)) return dest
  fs.cpSync(src, dest, { recursive: true })
  return dest
}

// 会话私有副本是否存在（用于区分「独立沙盒」与「共享架构」）
function hasSessionCopy(sessionId) {
  const d = sessionCopyDir(sessionId)
  return !!(d && fs.existsSync(d))
}

// 删除会话私有副本（会话删除时清理）
function removeSessionCopy(sessionId) {
  const d = sessionCopyDir(sessionId)
  if (d && fs.existsSync(d)) fs.rmSync(d, { recursive: true, force: true })
  return true
}

// 重命名架构内任意文件：受保护文件不可改名；目标不得与内置核心文件重名
function renameFile(name, oldRel, newRel) {
  const d = archDir(name)
  if (!d) throw new Error('记忆名不能为空')
  const src = resolveInArch(name, oldRel)
  if (!src) throw new Error('路径越界')
  if (!fs.existsSync(src)) throw new Error(`文件不存在: ${oldRel}`)
  if (fs.statSync(src).isDirectory()) throw new Error('不能重命名目录')
  const relNorm = path.relative(d, src).replace(/\\/g, '/')
  const cfg = loadConfig(name)
  const protList = cfg && Array.isArray(cfg.protected) ? cfg.protected : Object.values(FILE_NAMES)
  if (protList.includes(relNorm)) {
    throw new Error(`「${relNorm}」处于保护状态，不能重命名（右键该文件可取消保护）`)
  }
  let nr = String(newRel || '').trim().replace(/\\/g, '/')
  if (!nr) throw new Error('新文件名不能为空')
  const base = nr.split('/').pop()
  if (/\.\w+$/.test(base)) {
    if (Object.values(FILE_NAMES).includes(nr)) throw new Error(`「${nr}」是内置核心文件，不能重命名为该名称`)
  } else {
    nr = `${nr}.md`
  }
  if (nr === relNorm) return { rel: nr, ok: true }
  const dest = resolveInArch(name, nr)
  if (!dest) throw new Error('路径越界')
  if (fs.existsSync(dest)) throw new Error(`目标已存在: ${nr}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(src, dest)
  return { rel: nr, ok: true }
}

module.exports = {
  init, list, get, create, save, delete: remove,
  dirPath, scopeFile, safeName, SCOPE_KEYS, FILE_NAMES,
  loadConfig, saveConfig, archMtime, listFiles, readFileAny, writeFileAny, createFile, deleteFile, renameFile, setProtected,
  resolveInArch, resolveInDir, loadConfigAt,
  archBinding, runOrganize, runExtract, resetLedger,
  addCategory, setCategory, removeCategory, listCategories,
  cloneForSession, sessionCopyDir, hasSessionCopy, removeSessionCopy,
  memScriptToolsFor, memScriptToolDefsFor, allMemScriptToolDefs, execMemScriptTool, reloadMemScripts
}
