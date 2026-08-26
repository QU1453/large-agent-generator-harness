// Skill 加载器（Python + JS 双引擎）
// Skill = 一个「技能目录」，由「文档 + 组件（多为 Python/JS）」构成：
//   <userDir>/<skillId>/
//     main.skill.js 或 main.skill.py   —— 组件主文件（SKILL_* / module.exports 元数据 + system_prompt）
//     README.md / 其他 .py / .md / .json 等 —— 文档与辅助组件（工作台可自由增删）
// 内置 skill 首次启动以目录形式复制到用户数据目录，可自由修改源码客制化。
// .skill.py 通过常驻 Python 引擎加载，支持动态 system_prompt 函数。
const fs = require('fs')
const path = require('path')
const { PythonEngine } = require('./python-engine')

let builtinDir = null
let userDir = null
let jsSkills = []       // JS skill
let pySkills = []       // Python skill
let pyEngine = null
let pyLoadPromise = null
let pyLoadError = null

// ---- 分类管理（data/skills/categories.json：分类名列表 + skill→分类 + 工具→分类） ----
// 界面上的「分类文件夹」存这里，不修改 skill/工具代码文件；
// skill 代码里的 category / SKILL_CATEGORY 作为默认值，界面覆盖优先。
// removed：已删除分类黑名单——代码默认 category 在删除后不得复活（删除以界面为准）。
let categoriesFile = null
let categoryList = []
let categoryMap = {}   // skillId -> 分类
let mcpCategoryMap = {} // 工具包分类（toolPackId -> 分类；变量保留旧名避免大规模改名）
let removedCats = []   // 已删除分类黑名单

function loadCategories() {
  categoryList = []
  categoryMap = {}
  mcpCategoryMap = {}
  removedCats = []
  if (!categoriesFile || !fs.existsSync(categoriesFile)) return
  try {
    const d = JSON.parse(fs.readFileSync(categoriesFile, 'utf8'))
    categoryList = Array.isArray(d.list) ? d.list.filter(Boolean) : []
    if (d.map && typeof d.map === 'object') categoryMap = d.map
    if (d.mcpMap && typeof d.mcpMap === 'object') mcpCategoryMap = d.mcpMap
    if (d.removed && Array.isArray(d.removed)) removedCats = d.removed.filter(Boolean)
  } catch { /* 忽略 */ }
}

function saveCategories() {
  if (!categoriesFile) return
  try {
    fs.mkdirSync(path.dirname(categoriesFile), { recursive: true })
    fs.writeFileSync(categoriesFile, JSON.stringify({ list: categoryList, map: categoryMap, mcpMap: mcpCategoryMap, removed: removedCats }, null, 2), 'utf8')
  } catch { /* 忽略 */ }
}

function addCategory(name) {
  const n = String(name || '').trim()
  if (!n) throw new Error('分类名不能为空')
  if (!categoryList.includes(n)) categoryList.push(n)
  saveCategories()
  return listCategories()
}

function setCategory(id, name) {
  const n = String(name || '').trim()
  if (!n) throw new Error('分类名不能为空')
  if (!categoryList.includes(n)) categoryList.push(n)
  if (n === '未分类') delete categoryMap[id]
  else categoryMap[id] = n
  saveCategories()
  return listCategories()
}

function setMcpCategory(id, name) {
  const n = String(name || '').trim()
  if (!n) throw new Error('分类名不能为空')
  if (!categoryList.includes(n)) categoryList.push(n)
  if (n === '未分类') delete mcpCategoryMap[id]
  else mcpCategoryMap[id] = n
  saveCategories()
  return listCategories()
}

// 删除分类：从列表移除，并把归到该分类的 skill/工具移回「未分类」（代码文件不动）
function removeCategory(name) {
  const n = String(name || '').trim()
  if (!n) throw new Error('分类名不能为空')
  if (n === '未分类') throw new Error('「未分类」是默认分组，不能删除')
  categoryList = categoryList.filter((c) => c !== n)
  for (const k of Object.keys(categoryMap)) if (categoryMap[k] === n) delete categoryMap[k]
  for (const k of Object.keys(mcpCategoryMap)) if (mcpCategoryMap[k] === n) delete mcpCategoryMap[k]
  for (const s of jsSkills) if (s.category === n) delete s.category
  for (const p of pySkills) if (p.category === n) delete p.category
  if (!removedCats.includes(n)) removedCats.push(n)
  saveCategories()
  return listCategories()
}

function listCategories() {
  const used = new Set(Object.values(categoryMap))
  for (const s of jsSkills) if (s.category && !removedCats.includes(s.category)) used.add(s.category)
  for (const p of pySkills) if (p.category && !removedCats.includes(p.category)) used.add(p.category)
  for (const m of Object.values(mcpCategoryMap)) used.add(m)
  const merged = [...categoryList]
  for (const u of used) if (!merged.includes(u)) merged.push(u)
  return { list: merged, map: { ...categoryMap }, mcpMap: { ...mcpCategoryMap } }
}

function init({ builtin, user }) {
  builtinDir = builtin
  userDir = user
  fs.mkdirSync(userDir, { recursive: true })
  categoriesFile = path.join(userDir, 'categories.json')
  loadCategories()
  ensureUserSkills()
  return reload()
}

function ensureUserSkills() {
  if (!builtinDir || !fs.existsSync(builtinDir)) return
  for (const name of fs.readdirSync(builtinDir)) {
    const src = path.join(builtinDir, name)
    let st
    try { st = fs.statSync(src) } catch { continue }
    if (!st.isDirectory()) continue
    const dest = path.join(userDir, name)
    if (!fs.existsSync(dest)) {
      try { fs.cpSync(src, dest, { recursive: true }) } catch { /* 忽略 */ }
    }
  }
}

function safeName(name) {
  return String(name || '').trim().replace(/[\\/:*?"<>|]/g, '_')
}

// ---- JS 引擎 ----
function loadDir(dir) {
  const list = []
  if (!fs.existsSync(dir)) return list
  for (const name of fs.readdirSync(dir)) {
    const skillDir = path.join(dir, name)
    let st
    try { st = fs.statSync(skillDir) } catch { continue }
    if (!st.isDirectory()) continue
    const file = path.join(skillDir, 'main.skill.js')
    if (!fs.existsSync(file)) continue
    try {
      // 清除 require 缓存以实现热重载
      delete require.cache[require.resolve(file)]
      const def = require(file)
      if (!def || typeof def !== 'object' || !def.id || !def.name) {
        console.warn(`[skills] 跳过无效 skill 目录: ${name}`)
        continue
      }
      list.push({ ...def, file, dir: skillDir, source: 'user', kind: 'js' })
    } catch (e) {
      console.warn(`[skills] 加载失败 ${name}:`, e.message)
    }
  }
  return list
}

// ---- Python 引擎 ----
function scanPyDir(dir) {
  const list = []
  if (!fs.existsSync(dir)) return list
  for (const name of fs.readdirSync(dir)) {
    const skillDir = path.join(dir, name)
    let st
    try { st = fs.statSync(skillDir) } catch { continue }
    if (!st.isDirectory()) continue
    const file = path.join(skillDir, 'main.skill.py')
    if (!fs.existsSync(file)) continue
    list.push({ id: name, file, dir: skillDir, name })
  }
  return list
}

// 记忆架构内的技能：<userData>/memory/<架构名>/*.skill.py
// 放在记忆卡片里的技能由记忆架构承载，技能面板同样显示，dir 指向记忆目录
function scanMemSkills() {
  const list = []
  const memRoot = path.join(path.dirname(userDir), 'memory')
  if (!fs.existsSync(memRoot)) return list
  for (const arch of fs.readdirSync(memRoot)) {
    const archDir = path.join(memRoot, arch)
    let st
    try { st = fs.statSync(archDir) } catch { continue }
    if (!st.isDirectory()) continue
    for (const f of fs.readdirSync(archDir)) {
      if (!f.endsWith('.skill.py')) continue
      const file = path.join(archDir, f)
      const id = f.replace(/\.skill\.py$/, '')
      list.push({ id, file, dir: archDir, name: f, memory: arch })
    }
  }
  return list
}

async function loadPySkills() {
  pySkills = []
  pyLoadError = null
  const pyFiles = [...scanPyDir(userDir), ...scanMemSkills()]
  if (!pyFiles.length) return
  if (pyEngine) { pyEngine.stop(); pyEngine = null }
  pyEngine = new PythonEngine(pyFiles.map((f) => f.file))
  try {
    const modules = await pyEngine.listTools()
    pySkills = modules.map((m) => {
      const meta = m.meta || {}
      const src = pyFiles.find((f) => f.id === (meta.SKILL_ID || m.id)) || pyFiles.find((f) => f.file === m.file) || {}
      return {
        id: meta.SKILL_ID || m.id,
        name: meta.SKILL_NAME || m.name || m.id,
        description: meta.SKILL_DESC || m.description || '',
        category: meta.SKILL_CATEGORY || '未分类',
        avatar: meta.SKILL_AVATAR || '🐍',
        model: meta.SKILL_MODEL || null,
        temperature: meta.SKILL_TEMPERATURE,
        maxTokens: meta.SKILL_MAX_TOKENS,
        tools: meta.SKILL_TOOLS || [],
        systemPrompt: meta.SYSTEM_PROMPT ?? null,            // 字符串形式
        systemPromptFn: meta.SYSTEM_PROMPT_FN || 'system_prompt', // 动态函数名
        file: m.file,
        dir: src.dir || path.dirname(m.file),
        source: src.memory ? 'memory' : 'user', // 来自记忆卡片（data/memory/<架构>）
        memory: src.memory || null,
        kind: 'py',
        _module: m.module || m.id // 引擎内模块键（文件名）
      }
    })
  } catch (e) {
    pyLoadError = e.message
    console.warn('[skills] Python skill 加载失败:', e.message)
  }
}

function reload() {
  const userList = loadDir(userDir)
  const map = new Map()
  for (const s of userList) map.set(s.id, s)
  jsSkills = [...map.values()]
  pyLoadPromise = loadPySkills()
  return list()
}

function toSummary(s) {
  return {
    id: s.id,
    name: s.name,
    description: s.description || '',
    category: categoryMap[s.id] || (s.category && !removedCats.includes(s.category) ? s.category : '未分类'),
    avatar: s.avatar || '🧩',
    model: s.model || null,
    temperature: s.temperature,
    maxTokens: s.maxTokens,
    tools: s.tools || [],
    file: s.file,
    dir: s.dir,
    kind: s.kind || 'js'
  }
}

async function list() {
  await pyLoadPromise
  return [...jsSkills.map(toSummary), ...pySkills.map(toSummary)]
}

async function get(id) {
  await pyLoadPromise
  return jsSkills.find((s) => s.id === id) || pySkills.find((s) => s.id === id) || null
}

// 解析 systemPrompt（JS：支持字符串或函数；Python：字符串或动态函数）
async function resolveSystemPrompt(skill, ctx = {}) {
  if (!skill) return ''
  if (skill.kind === 'py') {
    if (skill.systemPrompt != null) return String(skill.systemPrompt)
    if (pyEngine && skill._module) {
      try {
        const res = await pyEngine.callModule(skill._module, skill.systemPromptFn || 'system_prompt', { ctx })
        return typeof res === 'string' ? res : JSON.stringify(res, null, 2)
      } catch (e) {
        console.warn('[skills] Python system_prompt 执行失败:', e.message)
        return ''
      }
    }
    return ''
  }
  const sp = skill.systemPrompt
  if (typeof sp === 'function') {
    try {
      return String(sp(ctx) || '')
    } catch (e) {
      console.warn('[skills] systemPrompt 执行失败:', e.message)
      return ''
    }
  }
  return String(sp || '')
}

// 定位用户可编辑的 skill 主组件源码文件
function getSourceFile(id) {
  const s = jsSkills.find((x) => x.id === id) || pySkills.find((x) => x.id === id)
  return s && s.file ? s.file : null
}

// ---------------- 技能目录文件管理（工作台：文档 + 组件） ----------------
function getSkillDir(id) {
  const s = jsSkills.find((x) => x.id === id) || pySkills.find((x) => x.id === id)
  return s && s.dir ? s.dir : null
}

// 相对技能目录安全解析（防越界）
function resolveInSkill(id, rel) {
  const d = getSkillDir(id)
  if (!d) return null
  const p = path.resolve(d, String(rel || '').replace(/^[/\\]+/, ''))
  const root = d.endsWith(path.sep) ? d : d + path.sep
  if (!(p === d || p.startsWith(root))) return null
  return p
}

const MAIN_NAMES = ['main.skill.js', 'main.skill.py']
const PERMS_FILE = '.skill-file-perms.json'

function kindOfFile(rel) {
  const e = String(rel).split('.').pop().toLowerCase()
  if (e === 'py') return 'py'
  if (e === 'js') return 'js'
  if (e === 'json') return 'json'
  return 'md'
}

// 技能目录内文件可读性记录（.skill-file-perms.json）：{ rel: { readable: false } }
function loadFilePerms(id) {
  const d = getSkillDir(id)
  if (!d) return {}
  try {
    const p = path.join(d, PERMS_FILE)
    if (!fs.existsSync(p)) return {}
    return JSON.parse(fs.readFileSync(p, 'utf8')) || {}
  } catch { return {} }
}

function saveFilePerms(id, perms) {
  const d = getSkillDir(id)
  if (!d) return
  fs.writeFileSync(path.join(d, PERMS_FILE), JSON.stringify(perms, null, 2), 'utf8')
}

// 技能目录文件树（主文件不可删，其余自由增删；记忆卡片技能的主文件为 <id>.skill.py）
function listFiles(id) {
  const d = getSkillDir(id)
  if (!d || !fs.existsSync(d)) return []
  const perms = loadFilePerms(id)
  const out = []
  const walk = (cur, rel) => {
    let entries = []
    try { entries = fs.readdirSync(cur) } catch { return }
    for (const f of entries.sort()) {
      const p = path.join(cur, f)
      const r = rel ? `${rel}/${f}` : f
      if (f === PERMS_FILE) continue
      let isDir = false
      try { isDir = fs.statSync(p).isDirectory() } catch { continue }
      if (isDir) {
        // 跳过 Python 缓存目录（.pyc 二进制不应出现在文件树）
        if (f === '__pycache__') continue
        walk(p, r)
        continue
      }
      // 主文件判定：标准 main.skill.* 或记忆卡片技能的 <id>.skill.*
      const isMain = MAIN_NAMES.includes(f) || /\.skill\.(js|py)$/.test(f)
      out.push({ rel: r, kind: kindOfFile(r), main: isMain, protected: isMain, readable: perms[r] ? !!perms[r].readable : true })
    }
  }
  walk(d, '')
  return out
}

// 切换文件可读性：readable=false 时该文件对 LLM 不可读（仅在技能目录内记录，不影响文件本身）
function setFileReadable(id, rel, readable) {
  const p = resolveInSkill(id, rel)
  if (!p) throw new Error('路径越界')
  if (!fs.existsSync(p)) throw new Error(`文件不存在: ${rel}`)
  const perms = loadFilePerms(id)
  if (readable) delete perms[rel]
  else perms[rel] = { readable: false }
  saveFilePerms(id, perms)
  return { rel, readable: !!readable }
}

function readFile(id, rel) {
  const p = resolveInSkill(id, rel)
  if (!p) throw new Error('路径越界')
  if (!fs.existsSync(p)) throw new Error(`文件不存在: ${rel}`)
  return fs.readFileSync(p, 'utf8')
}

function writeFile(id, rel, content) {
  const p = resolveInSkill(id, rel)
  if (!p) throw new Error('路径越界')
  fs.mkdirSync(path.dirname(p), { recursive: true })
  fs.writeFileSync(p, String(content ?? ''), 'utf8')
  return { rel: rel.replace(/\\/g, '/'), ok: true }
}

function createFile(id, rel, content) {
  const d = getSkillDir(id)
  if (!d) throw new Error('技能不存在')
  let r = String(rel || '').trim().replace(/\\/g, '/')
  if (!r) throw new Error('文件路径不能为空')
  if (!/\.\w+$/.test(r.split('/').pop())) r = `${r}.md`
  const p = resolveInSkill(id, r)
  if (!p) throw new Error('路径越界')
  if (fs.existsSync(p)) throw new Error(`文件已存在: ${r}`)
  fs.mkdirSync(path.dirname(p), { recursive: true })
  const body = content != null ? String(content) : (r.endsWith('.md') ? `# ${path.basename(p, '.md')}\n\n` : '')
  fs.writeFileSync(p, body, 'utf8')
  return { rel: r, ok: true }
}

function deleteFile(id, rel) {
  const p = resolveInSkill(id, rel)
  if (!p) throw new Error('路径越界')
  if (MAIN_NAMES.includes(path.basename(p))) throw new Error('主组件文件不可删除')
  if (!fs.existsSync(p)) throw new Error('文件不存在')
  if (fs.statSync(p).isDirectory()) throw new Error('不能删除目录')
  fs.rmSync(p)
  return { ok: true }
}

// 重命名技能目录内文件（主组件不可改名；保留可读性记录；无扩展名自动补 .md 与新建一致）
function renameFile(id, oldRel, newRel) {
  const src = resolveInSkill(id, oldRel)
  if (!src) throw new Error('路径越界')
  if (MAIN_NAMES.includes(path.basename(src))) throw new Error('主组件文件不可重命名')
  if (!fs.existsSync(src)) throw new Error(`文件不存在: ${oldRel}`)
  if (fs.statSync(src).isDirectory()) throw new Error('不能重命名目录')
  let nr = String(newRel || '').trim().replace(/\\/g, '/')
  if (!nr) throw new Error('新文件名不能为空')
  if (!/\.\w+$/.test(nr.split('/').pop())) nr = `${nr}.md`
  const oldKey = String(oldRel).replace(/\\/g, '/')
  if (nr === oldKey) return { rel: nr, ok: true }
  const dest = resolveInSkill(id, nr)
  if (!dest) throw new Error('路径越界')
  if (fs.existsSync(dest)) throw new Error(`目标已存在: ${nr}`)
  fs.mkdirSync(path.dirname(dest), { recursive: true })
  fs.renameSync(src, dest)
  // 迁移可读性记录（.skill-file-perms.json）
  const perms = loadFilePerms(id)
  if (perms[oldKey] != null) {
    perms[nr] = perms[oldKey]
    delete perms[oldKey]
    saveFilePerms(id, perms)
  }
  return { rel: nr, ok: true }
}

module.exports = {
  init, reload, list, get, resolveSystemPrompt, getSourceFile, getPyLoadError: () => pyLoadError,
  addCategory, setCategory, setMcpCategory, removeCategory, listCategories,
  getSkillDir, listFiles, readFile, writeFile, createFile, deleteFile, renameFile, setFileReadable
}
