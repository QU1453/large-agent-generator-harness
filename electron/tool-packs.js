// 工具包加载器（双引擎）
// .js 工具包：主进程直接 require 加载（handler 为 JS 函数）
// .py 工具包：常驻 Python 子进程执行（handler 为 Python 函数）
// 内置工具包首次启动复制到用户数据目录，可修改源码客制化，保存后"重载"生效。
// 命名：内部工具包统一 `tool:` 前缀 / `tool_` 函数名 / `.tool.js|.tool.py` 后缀；
// 兼容旧名（历史遗留的 mcp: / mcp_ / .mcp.*）读取时一并识别，不迁移也不报错。
const fs = require('fs')
const path = require('path')
const { PythonEngine, checkPython } = require('./python-engine')

let builtinDir = null
let userDir = null
let jsPacks = []     // JS 定义的工具包
let pyPacks = []     // Python 定义的工具包（含 tools，来自引擎）
let pyLoadError = null
let engine = null    // PythonEngine 单例
let pyLoadPromise = null

// 后缀识别：新 .tool.* 与旧 .mcp.* 都认
const isPackFile = (name) => /\.(tool|mcp)\.(js|py)$/.test(name)
const packIdOf = (name) => path.basename(name).replace(/\.(tool|mcp)\.(js|py)$/, '')

function init({ builtin, user }) {
  builtinDir = builtin
  userDir = user
  fs.mkdirSync(userDir, { recursive: true })
  ensureUserPacks()
  return reload()
}

function ensureUserPacks() {
  if (!builtinDir || !fs.existsSync(builtinDir)) return
  for (const name of fs.readdirSync(builtinDir)) {
    if (!isPackFile(name)) continue
    const dest = path.join(userDir, name)
    if (!fs.existsSync(dest)) {
      try { fs.copyFileSync(path.join(builtinDir, name), dest) } catch { /* 忽略 */ }
    }
  }
}

// ---- JS 引擎 ----
function loadJsDir(dir) {
  const list = []
  if (!fs.existsSync(dir)) return list
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(tool|mcp)\.js$/.test(name)) continue
    const file = path.join(dir, name)
    try {
      delete require.cache[require.resolve(file)]
      const def = require(file)
      if (!def || typeof def !== 'object' || !def.id) continue
      const tools = Array.isArray(def.tools) ? def.tools.filter((t) => t && t.name && typeof t.handler === 'function') : []
      list.push({ ...def, tools, file, kind: 'js' })
    } catch (e) {
      console.warn(`[tool-packs] 加载失败 ${name}:`, e.message)
    }
  }
  return list
}

// ---- Python 引擎 ----
function scanPyFiles(dir) {
  const list = []
  if (!fs.existsSync(dir)) return list
  for (const name of fs.readdirSync(dir)) {
    if (!/\.(tool|mcp)\.py$/.test(name)) continue
    const file = path.join(dir, name)
    list.push({ id: packIdOf(name), file, name, kind: 'py' })
  }
  return list
}

async function loadPyTools() {
  pyPacks = []
  pyLoadError = null
  const pyFiles = scanPyFiles(userDir)
  if (!pyFiles.length) return
  if (engine) { engine.stop(); engine = null }
  engine = new PythonEngine(pyFiles.map((f) => f.file))
  try {
    const modules = await engine.listTools()
    pyPacks = modules
  } catch (e) {
    pyLoadError = e.message
    console.warn('[tool-packs] Python 引擎加载失败:', e.message)
  }
}

// ---- 对外 ----
function reload() {
  jsPacks = loadJsDir(userDir)
  pyLoadPromise = loadPyTools()
  return list()
}

async function list() {
  await pyLoadPromise
  const js = jsPacks.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    description: m.description || '',
    kind: 'js',
    tools: m.tools.map((t) => ({ name: t.name, description: t.description || '' })),
    file: m.file
  }))
  const py = pyPacks.map((m) => ({
    id: m.id,
    name: m.name || m.id,
    description: m.description || '',
    kind: 'py',
    tools: (m.tools || []).map((t) => ({ name: t.name, description: t.description || '' })),
    file: m.file
  }))
  return { toolPacks: [...js, ...py], python: checkPython(), pyLoadError }
}

// 全部可用工具（供 LLM schema 合并，同步）
function allTools() {
  const out = []
  for (const m of jsPacks) {
    for (const t of m.tools) out.push({ ...t, packId: m.id, key: `tool:${t.name}` })
  }
  for (const m of pyPacks) {
    for (const t of m.tools || []) out.push({ ...t, packId: m.id, key: `tool:${t.name}` })
  }
  return out
}

function enabledToolNames(agentTools = []) {
  const names = new Set()
  for (const ref of agentTools) {
    if (typeof ref === 'string' && (ref.startsWith('tool:') || ref.startsWith('mcp:'))) names.add(ref.slice(ref.indexOf(':') + 1))
  }
  return names
}

function findJsTool(name) {
  for (const m of jsPacks) {
    for (const t of m.tools) if (t.name === name) return t
  }
  return null
}

function findPyTool(name) {
  for (const m of pyPacks) {
    for (const t of m.tools || []) if (t.name === name) return t
  }
  return null
}

// 执行工具包工具（async）
async function execTool(name, args) {
  const jsTool = findJsTool(name)
  if (jsTool) {
    try {
      const r = await jsTool.handler(args || {})
      return typeof r === 'string' ? r : JSON.stringify(r, null, 2)
    } catch (e) {
      return JSON.stringify({ error: e.message || String(e) })
    }
  }
  if (findPyTool(name)) {
    try {
      if (!engine) await loadPyTools()
      return await engine.execTool(name, args || {})
    } catch (e) {
      return JSON.stringify({ error: e.message || String(e) })
    }
  }
  return JSON.stringify({ error: `工具包工具不存在: ${name}` })
}

function getSourceFile(id) {
  for (const m of jsPacks) if (m.id === id) return m.file
  for (const m of pyPacks) if (m.id === id) return m.file
  return null
}

module.exports = { init, reload, list, allTools, enabledToolNames, findTool: findJsTool, execTool, getSourceFile, checkPython }
