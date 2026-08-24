// 协议仓库：A2A 安全协议 = Python 代码文件（.protocol.py），像智能体一样双击编辑源码
// 存储：<userData>/protocols/<name>.protocol.py
// 协议由 PROTOCOL_* 常量定义（enabled/version/identity/endpoint/auth/access/audit），
// 画布「协议节点」引用它，运行时作为智能体间通信网关做访问控制 + [[A2A]] 信封 + 审计。
const fs = require('fs')
const path = require('path')

let dir = null
let catsFile = null
let catList = []   // 分类名列表
let catMap = {}    // 协议 name -> 分类

function init(userDataDir) {
  dir = path.join(userDataDir, 'protocols')
  fs.mkdirSync(dir, { recursive: true })
  catsFile = path.join(dir, 'categories.json')
  loadCats()
  migrateLegacy()
}

function safeName(name) {
  return String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_')
}

// ---------------- 分类（像智能体一样管理） ----------------
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

function setCategory(protoName, name) {
  const n = String(name || '').trim()
  if (!n) throw new Error('分类名不能为空')
  if (!catList.includes(n)) catList.push(n)
  if (n === '未分类') delete catMap[protoName]
  else catMap[protoName] = n
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

// ---------------- 协议源码模板与解析 ----------------
function template(name) {
  return `# ============================================================
# 协议：${name}（A2A 安全协议）
# 像智能体一样：协议是 Python 代码文件，双击编辑源码即可客制化。
# 画布「协议节点」引用它，运行时作为智能体间通信网关：
#   访问控制（允许/拒绝来源）→ [[A2A]] 信封封装 → 审计留痕。
# ============================================================
PROTOCOL_ENABLED = True
PROTOCOL_VERSION = "A2A/1.0"
PROTOCOL_IDENTITY = "${name}"
PROTOCOL_ENDPOINT = ""
PROTOCOL_AUTH_TYPE = "none"
PROTOCOL_AUTH_SECRET = ""
PROTOCOL_ALLOWED_PEERS = []
PROTOCOL_DENIED_PEERS = []
PROTOCOL_AUDIT = True
`
}

// 解析 PROTOCOL_* 常量（bool / str / list[str]），缺失返回 undefined
function parseConst(content, key, type) {
  const re = new RegExp(`^${key}\\s*=\\s*(.+)$`, 'm')
  const m = String(content || '').match(re)
  if (!m) return undefined
  const raw = m[1].split('#')[0].trim()
  if (type === 'bool') return /^(True|1|true)$/.test(raw)
  if (type === 'str') {
    const s = raw.match(/^(['"])([\s\S]*)\1$/)
    return s ? s[2] : raw
  }
  if (type === 'list') {
    const inner = raw.match(/^\[([\s\S]*)\]$/)
    if (!inner) return []
    const items = []
    const re2 = /(['"])([\s\S]*?)\1/g
    let mm
    while ((mm = re2.exec(inner[1]))) items.push(mm[2])
    return items
  }
  return raw
}

// 从源码解析出协议元数据（供列表/画布节点/运行时使用）
function parseMeta(name, content) {
  const c = String(content || '')
  const desc = (c.match(/^#\s*协议：(.+)$/m) || [])[1] || ''
  return {
    name,
    desc: desc.trim(),
    enabled: parseConst(c, 'PROTOCOL_ENABLED', 'bool') !== false,
    version: parseConst(c, 'PROTOCOL_VERSION', 'str') || 'A2A/1.0',
    identity: parseConst(c, 'PROTOCOL_IDENTITY', 'str') || name,
    endpoint: parseConst(c, 'PROTOCOL_ENDPOINT', 'str') || '',
    auth: {
      type: parseConst(c, 'PROTOCOL_AUTH_TYPE', 'str') || 'none',
      secret: parseConst(c, 'PROTOCOL_AUTH_SECRET', 'str') || ''
    },
    access: {
      allowedPeers: parseConst(c, 'PROTOCOL_ALLOWED_PEERS', 'list') || [],
      deniedPeers: parseConst(c, 'PROTOCOL_DENIED_PEERS', 'list') || []
    },
    audit: parseConst(c, 'PROTOCOL_AUDIT', 'bool') !== false
  }
}

function fileOf(name) {
  const n = safeName(name)
  if (!n || !dir) return null
  return path.join(dir, `${n}.protocol.py`)
}

function list() {
  if (!dir || !fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .filter((f) => f.endsWith('.protocol.py'))
    .map((f) => {
      const name = path.basename(f, '.protocol.py')
      const fp = path.join(dir, f)
      try {
        const content = fs.readFileSync(fp, 'utf8')
        const meta = parseMeta(name, content)
        return {
          ...meta,
          category: catMap[name] || '未分类',
          file: fp,
          updatedAt: fs.statSync(fp).mtimeMs
        }
      } catch { return null }
    })
    .filter(Boolean)
    .sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
}

function get(name) {
  const n = safeName(name)
  const fp = fileOf(n)
  if (!fp || !fs.existsSync(fp)) return null
  try {
    const content = fs.readFileSync(fp, 'utf8')
    return {
      ...parseMeta(n, content),
      category: catMap[n] || '未分类',
      file: fp,
      content,
      updatedAt: fs.statSync(fp).mtimeMs
    }
  } catch { return null }
}

function create(name) {
  const n = safeName(name)
  if (!n) throw new Error('协议名不能为空')
  const fp = fileOf(n)
  if (!fp) throw new Error('协议名不能为空')
  if (fs.existsSync(fp)) throw new Error(`协议「${n}」已存在`)
  fs.writeFileSync(fp, template(n), 'utf8')
  return get(n)
}

// 保存源码（CodeEditor 编辑后写回）
function write(name, content) {
  const n = safeName(name)
  if (!n) throw new Error('协议名不能为空')
  const fp = fileOf(n)
  if (!fp) throw new Error('协议名不能为空')
  fs.writeFileSync(fp, String(content ?? ''), 'utf8')
  return get(n)
}

function remove(name) {
  const n = safeName(name)
  if (!n) return false
  const fp = fileOf(n)
  if (!fp || !fs.existsSync(fp)) return false
  fs.rmSync(fp, { force: true })
  delete catMap[n]
  saveCats()
  return true
}

// 旧版 JSON 协议迁移为 .protocol.py（只做一次，保留原配置）
function migrateLegacy() {
  if (!dir || !fs.existsSync(dir)) return
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.json')) continue
    if (f === 'categories.json') continue
    const name = path.basename(f, '.json')
    const fp = path.join(dir, f)
    try {
      const d = JSON.parse(fs.readFileSync(fp, 'utf8'))
      const access = d.access || {}
      const auth = d.auth || {}
      const py = `# ============================================================
# 协议：${name}（A2A 安全协议）
# 像智能体一样：协议是 Python 代码文件，双击编辑源码即可客制化。
# 画布「协议节点」引用它，运行时作为智能体间通信网关：
#   访问控制（允许/拒绝来源）→ [[A2A]] 信封封装 → 审计留痕。
# ============================================================
PROTOCOL_ENABLED = ${d.enabled === false ? 'False' : 'True'}
PROTOCOL_VERSION = ${JSON.stringify(d.version || 'A2A/1.0')}
PROTOCOL_IDENTITY = ${JSON.stringify(d.identity || name)}
PROTOCOL_ENDPOINT = ${JSON.stringify(d.endpoint || '')}
PROTOCOL_AUTH_TYPE = ${JSON.stringify((auth.type) || 'none')}
PROTOCOL_AUTH_SECRET = ${JSON.stringify((auth.secret) || '')}
PROTOCOL_ALLOWED_PEERS = ${JSON.stringify(Array.isArray(access.allowedPeers) ? access.allowedPeers : [])}
PROTOCOL_DENIED_PEERS = ${JSON.stringify(Array.isArray(access.deniedPeers) ? access.deniedPeers : [])}
PROTOCOL_AUDIT = ${d.audit === false ? 'False' : 'True'}
`
      const dest = path.join(dir, `${name}.protocol.py`)
      if (!fs.existsSync(dest)) fs.writeFileSync(dest, py, 'utf8')
      fs.rmSync(fp, { force: true })
    } catch { /* 忽略损坏文件 */ }
  }
}

module.exports = {
  init, list, get, create, write, remove,
  addCategory, setCategory, removeCategory, listCategories,
  parseMeta
}
