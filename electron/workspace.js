// 工作区：受控的文件系统访问（仅允许访问已打开的工作区目录）
// 多 sandbox：左侧每个工作区是一个 sandbox（文件夹 + 名称 + 绑定的会话）
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

let root = null
const MAX_FILE_SIZE = 200 * 1024 // 单文件读取上限 200KB

// ---- 多 sandbox 工作区存储（data/sandboxes.json：{active, list:[{id,name,root,sessionId}]}） ----
let sandboxFile = null
let sbState = { active: null, list: [] }

function initSandboxes(userDataDir) {
  sandboxFile = path.join(userDataDir, 'sandboxes.json')
  if (fs.existsSync(sandboxFile)) {
    try {
      const d = JSON.parse(fs.readFileSync(sandboxFile, 'utf8'))
      if (Array.isArray(d)) {
        // 兼容旧格式：纯数组 → 迁移为 {active, list}
        sbState = { active: d.length ? d[0].id : null, list: d }
      } else if (d && Array.isArray(d.list)) {
        sbState = d
      }
    } catch {
      sbState = { active: null, list: [] }
    }
  }
}

function saveSandboxes() {
  if (!sandboxFile) return
  fs.mkdirSync(path.dirname(sandboxFile), { recursive: true })
  fs.writeFileSync(sandboxFile, JSON.stringify(sbState, null, 2), 'utf8')
}

function listSandboxes() {
  return {
    active: sbState.active,
    list: sbState.list.map((s) => ({
      id: s.id, name: s.name, root: s.root, sessionId: s.sessionId || null,
      memoryArch: s.memoryArch || null, boundAt: s.boundAt || null, lastArchMtime: s.lastArchMtime || null,
      chatModel: s.chatModel || '', chatType: s.chatType || '', chatTarget: s.chatTarget || ''
    }))
  }
}

function getSandbox(id) {
  return sbState.list.find((s) => s.id === id) || null
}

function createSandbox(rootDir) {
  const abs = path.resolve(rootDir)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error('工作区路径无效: ' + abs)
  }
  const sb = {
    id: crypto.randomUUID(),
    name: path.basename(abs) || '工作区',
    root: abs,
    sessionId: null,
    createdAt: Date.now()
  }
  sbState.list.push(sb)
  sbState.active = sb.id
  saveSandboxes()
  setRoot(abs)
  return { ...sb }
}

function selectSandbox(id) {
  const sb = getSandbox(id)
  if (!sb) throw new Error('工作区不存在: ' + id)
  sbState.active = id
  saveSandboxes()
  setRoot(sb.root)
  return { ...sb }
}

function deleteSandbox(id) {
  const idx = sbState.list.findIndex((s) => s.id === id)
  if (idx < 0) return { ok: false, error: '工作区不存在' }
  sbState.list.splice(idx, 1)
  if (sbState.active === id) {
    sbState.active = sbState.list.length ? sbState.list[0].id : null
    if (sbState.active) setRoot(getSandbox(sbState.active).root)
    else setRoot(null)
  }
  saveSandboxes()
  return { ok: true, active: sbState.active, list: listSandboxes() }
}

function setSandboxSession(id, sessionId) {
  const sb = getSandbox(id)
  if (!sb) throw new Error('工作区不存在: ' + id)
  sb.sessionId = sessionId || null
  saveSandboxes()
  return { ...sb }
}

// 记忆架构绑定：工作区绑定后其会话默认继承该记忆（会话级绑定优先）
function setSandboxMemoryArch(id, archName, mtime) {
  const sb = getSandbox(id)
  if (!sb) throw new Error('工作区不存在: ' + id)
  sb.memoryArch = archName || null
  sb.boundAt = archName ? Date.now() : null
  sb.lastArchMtime = archName ? mtime || null : null
  saveSandboxes()
  return { ...sb }
}

// 只更新记忆版本游标（"更新先整理"完成后记录），不重置绑定信息
function touchSandboxMemory(id, mtime) {
  const sb = getSandbox(id)
  if (!sb) return null
  sb.lastArchMtime = mtime || null
  saveSandboxes()
  return { ...sb }
}

// 工作区对话栏状态持久化：模型/目标类型/目标 切走再回来保持一致
function setSandboxChat(id, patch) {
  const sb = getSandbox(id)
  if (!sb) throw new Error('工作区不存在: ' + id)
  const p = patch || {}
  if ('model' in p) sb.chatModel = String(p.model || '')
  if ('type' in p) sb.chatType = String(p.type || '')
  if ('target' in p) sb.chatTarget = String(p.target || '')
  saveSandboxes()
  return { ...sb }
}

// 切换/重设某个工作区的根目录（不新建条目，避免重复堆积）
function setSandboxRoot(id, rootDir) {
  const sb = getSandbox(id)
  if (!sb) throw new Error('工作区不存在: ' + id)
  const abs = path.resolve(rootDir)
  if (!fs.existsSync(abs) || !fs.statSync(abs).isDirectory()) {
    throw new Error('工作区路径无效: ' + abs)
  }
  sb.root = abs
  sb.name = path.basename(abs) || '工作区'
  saveSandboxes()
  if (sbState.active === id) setRoot(abs)
  return { ...sb }
}

function setRoot(dir) {
  if (dir) {
    root = path.resolve(dir)
    if (!fs.existsSync(root) || !fs.statSync(root).isDirectory()) {
      throw new Error('工作区路径无效: ' + dir)
    }
  } else {
    root = null
  }
  return root
}

function getRoot() {
  return root
}

function safeResolve(rel) {
  if (!root) throw new Error('未打开工作区')
  if (typeof rel !== 'string' || !rel) throw new Error('路径不能为空')
  const abs = path.resolve(root, rel)
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new Error('路径越界，禁止访问工作区之外: ' + rel)
  }
  return abs
}

function ignoreDir(name) {
  return (
    name === 'node_modules' ||
    name === '.git' ||
    name === '.idea' ||
    name === '.vscode' ||
    name === 'dist' ||
    name === 'release' ||
    name === '.next' ||
    name === '__pycache__' ||
    name.startsWith('.') && name !== '.env'
  )
}

// 构建目录树
function tree(dir = root, depth = 0, maxDepth = 4) {
  if (!dir) return []
  if (depth > maxDepth) return []
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true }).sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
  } catch {
    return []
  }
  const result = []
  for (const e of entries) {
    if (e.isDirectory() && ignoreDir(e.name)) continue
    const full = path.join(dir, e.name)
    const rel = path.relative(root, full).split(path.sep).join('/')
    if (e.isDirectory()) {
      result.push({ name: e.name, path: rel, type: 'dir', children: tree(full, depth + 1, maxDepth) })
    } else {
      let size = 0
      try { size = fs.statSync(full).size } catch { /* 忽略 */ }
      result.push({ name: e.name, path: rel, type: 'file', size })
    }
  }
  return result
}

function listDir(rel = '') {
  const abs = safeResolve(rel)
  return tree(abs, 0, 2).map((e) => ({ name: e.name, path: e.path, type: e.type }))
}

function readFile(rel) {
  const abs = safeResolve(rel)
  const stat = fs.statSync(abs)
  if (stat.isDirectory()) throw new Error('这是一个目录: ' + rel)
  if (stat.size > MAX_FILE_SIZE) {
    throw new Error(`文件过大（${(stat.size / 1024).toFixed(0)}KB），超过 ${MAX_FILE_SIZE / 1024}KB 限制: ${rel}`)
  }
  return fs.readFileSync(abs, 'utf8')
}

function writeFile(rel, content) {
  const abs = safeResolve(rel)
  fs.mkdirSync(path.dirname(abs), { recursive: true })
  fs.writeFileSync(abs, content, 'utf8')
  return { ok: true, path: rel }
}

function mkdir(rel) {
  const abs = safeResolve(rel)
  fs.mkdirSync(abs, { recursive: true })
  return { ok: true, path: rel }
}

function rename(oldRel, newRel) {
  const absOld = safeResolve(oldRel)
  const absNew = safeResolve(newRel)
  if (absOld === absNew) return { ok: true, path: newRel }
  fs.mkdirSync(path.dirname(absNew), { recursive: true })
  fs.renameSync(absOld, absNew)
  return { ok: true, path: newRel }
}

function removeFile(rel) {
  const abs = safeResolve(rel)
  fs.rmSync(abs, { recursive: true, force: true })
  return { ok: true, path: rel }
}

function info() {
  if (!root) return null
  return {
    root,
    name: path.basename(root),
    tree: tree(root)
  }
}

module.exports = {
  setRoot, getRoot, tree, listDir, readFile, writeFile, mkdir, rename, removeFile, info,
  initSandboxes, listSandboxes, getSandbox, createSandbox, selectSandbox, deleteSandbox, setSandboxSession, setSandboxRoot,
  setSandboxMemoryArch, touchSandboxMemory, setSandboxChat
}
