// 大型 Agent 生成器（LAG）：把智能体导出为自包含的 Python Agent 包
// 导出物 = 一个目录（zip 可分发），内含：
//   manifest.json      I/O 契约 + 元数据 + 模型配置（生成时固化）
//   la_main.py         统一入口（--serve / --message）
//   executor/          执行引擎（Python：图编排 + zone 总线 + LLM 循环 + 工具）
//   transports/        传输层（http_server + cli）
//   web/index.html     自带聊天控制台
//   tools/             引用的 .tool.py 工具（复制）
//   runtime/           内嵌 Python 运行时（复用 Harness runtime/python）
//   start.bat/.sh      一键启动
//   data/              运行期数据（会话/记忆，首次启动创建）
//
// 显式开发：导出产物的 Python 代码 / 控制台 / 脚本 / 记忆骨架全部放在
// electron/export-template/ 目录（真实 .py/.html/.md 文件，可独立编辑、py_compile 单测），
// 导出时拷贝模板目录 + 渲染 __NAME__/__DESC__/__PORT__/__TOKEN__/__OUTDIR__ 占位符。
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const { execFile, execFileSync } = require('child_process')
const skills = require('./skills')
const toolPacks = require('./tool-packs')
const memory = require('./memory')
const agent = require('./agent')

// 当前工程内置的 Python 运行时目录（导出时整体复制）
function runtimeSource() {
  return path.join(__dirname, '..', 'runtime', 'python')
}

// 导出模板工程目录（显式文件，可见可改可单测）
function templateDir() {
  return path.join(__dirname, 'export-template')
}

// 渲染占位符：把 text 中所有 __KEY__ 替换为 vars[KEY]（原全局替换语义保持一致）
function renderVars(text, vars) {
  let s = String(text)
  for (const k of Object.keys(vars || {})) s = s.split(k).join(String(vars[k]))
  return s
}

// 拷贝模板工程到导出物（跳过 docs/ 片段；target==='api' 时跳过 la/ 库接口）
function copyTemplate(outDir, target) {
  const src = templateDir()
  const written = []
  const walk = (rel) => {
    const abs = path.join(src, rel)
    const dest = path.join(outDir, rel)
    if (fs.statSync(abs).isDirectory()) {
      fs.mkdirSync(dest, { recursive: true })
      for (const name of fs.readdirSync(abs)) walk(path.join(rel, name))
    } else {
      fs.copyFileSync(abs, dest)
      written.push(rel.replace(/\\/g, '/'))
    }
  }
  for (const name of fs.readdirSync(src)) {
    if (name === 'docs') continue
    if (name === 'la' && target === 'api') continue
    walk(name)
  }
  return written
}

// 按导出形式组装「接入说明.md」：api/all 带 HTTP 段，py/all 带 Python 库段
function buildReadme(target) {
  const docs = path.join(templateDir(), 'docs')
  let s = fs.readFileSync(path.join(docs, 'README.head.md'), 'utf8')
  if (target !== 'py') s += fs.readFileSync(path.join(docs, 'README.api.md'), 'utf8')
  if (target !== 'api') s += fs.readFileSync(path.join(docs, 'README.py.md'), 'utf8')
  s += fs.readFileSync(path.join(docs, 'README.tail.md'), 'utf8')
  return s
}

// ---------------- 导出逻辑 ----------------

// 校验智能体可导出性，返回 { ok, warnings, errors }
async function checkAgent(ag, skillList, mcpKindMap, agentStore) {
  const warnings = []
  const errors = []
  const skillsByTools = new Map() // tool name -> source kind
  for (const t of toolPacks.allTools()) {
    const kind = mcpKindMap[t.packId] || 'js'
    skillsByTools.set(t.name, kind)
  }
  const usedSkills = new Map()
  const checkToolRefs = (refs, who) => {
    for (const ref of refs || []) {
      if (ref.startsWith('tool:') || ref.startsWith('mcp:')) {
        const name = ref.slice(ref.indexOf(':') + 1)
        const kind = skillsByTools.get(name)
        if (kind === 'py') continue
        if (kind === 'js') {
          warnings.push(`${who}引用的工具 ${name} 是 JS 实现（.tool.js），导出物无法直接运行，调用将返回"工具不存在"`)
        } else {
          warnings.push(`${who}引用的工具 ${name} 未找到`)
        }
      } else if (['list_dir', 'read_file', 'write_file'].includes(ref)) {
        warnings.push(`${who}使用了工作区工具 ${ref}，导出物没有"工作区"概念，该工具不可用`)
      } else if (ref === 'run_agent') {
        warnings.push(`${who}使用 run_agent，导出物不支持嵌套智能体，该工具不可用`)
      }
    }
  }
  // 递归遍历节点（含子智能体节点引用的子智能体）
  const seen = new Set()
  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.type === 'subagent') {
        const subId = node.subagentId
        if (!subId) {
          errors.push(`子智能体节点「${node.label || node.id}」未选择智能体`)
          continue
        }
        if (!agentStore) {
          errors.push(`子智能体节点「${node.label || node.id}」：导出时未提供智能体存储`)
          continue
        }
        const sub = agentStore.get(subId)
        // 工作流中没有 → 智能体定义（data/agent-defs，单智能体转最小图）
        const subDef = !sub && typeof agentStore.getDef === 'function' ? agentStore.getDef(subId) : null
        if (!sub && !subDef) {
          errors.push(`子智能体节点「${node.label || node.id}」引用的智能体不存在: ${subId}`)
          continue
        }
        const walkSub = sub || (subDef && agent.defToGraph(subDef))
        if (seen.has(subId)) continue
        seen.add(subId)
        walk(walkSub.nodes || [])
        continue
      }
      if (node.type === 'input' || node.type === 'output') {
        // 自定义输入/输出：链接了工具时校验引用
        if ((node.tools || []).length) {
          checkToolRefs(node.tools, `智能体节点「${node.label || node.id}」`)
        }
        for (const mname of node.memories || []) {
          if (!memory.get(mname)) warnings.push(`智能体节点「${node.label || node.id}」链接的记忆架构「${mname}」不存在，运行时会动态创建空记忆`)
        }
        continue
      }
      if (node.type === 'memory') {
        // 记忆节点：校验读取/写入接口指向的记忆架构是否存在
        const checkMemIfArch = (kind, iface) => {
          const arch = (iface && iface.arch) || node.memoryArch || ''
          if (arch && !memory.get(arch)) {
            warnings.push(`记忆节点「${node.label || node.id}」的${kind}接口「${(iface && iface.label) || ''}」指向的记忆「${arch}」不存在，运行时会动态创建空记忆`)
          }
        }
        for (const r of node.reads || []) checkMemIfArch('读取', r)
        for (const w of node.writes || []) checkMemIfArch('写入', w)
        continue
      }
      if (node.type !== 'skill' || !node.skillId) continue
      const skill = skillList.find((a) => a.id === node.skillId)
      if (!skill) {
        errors.push(`技能不存在: ${node.skillId}`)
        continue
      }
      usedSkills.set(skill.id, skill)
      checkToolRefs(skill.tools, `技能「${skill.name}」`)
      checkToolRefs(node.tools, `智能体节点「${node.label || node.id}」`)
      for (const mname of node.memories || []) {
        if (!memory.get(mname)) warnings.push(`智能体节点「${node.label || node.id}」链接的记忆架构「${mname}」不存在，运行时会动态创建空记忆`)
      }
      // A2A 安全协议校验：访问控制名单引用不存在的技能 → 警告
      const proto = node.protocol
      if (proto && proto.enabled !== false) {
        const peerIds = new Set([
          ...(proto.access && Array.isArray(proto.access.allowedPeers) ? proto.access.allowedPeers : []),
          ...(proto.access && Array.isArray(proto.access.deniedPeers) ? proto.access.deniedPeers : [])
        ])
        for (const pid of peerIds) {
          if (!pid) continue
          const isSkill = skillList.some((a) => a.id === pid)
          const isNode = (ag.nodes || []).some((n) => n.id === pid || (n.type === 'skill' && n.skillId === pid))
          if (!isSkill && !isNode) {
            warnings.push(`智能体节点「${node.label || node.id}」的 A2A 协议访问名单引用了不存在的技能/节点: ${pid}（运行时该来源将被拦截）`)
          }
        }
      }
    }
  }
  walk(ag.nodes || [])
  return { ok: errors.length === 0, warnings, errors, usedSkills }
}

// 从智能体推导 I/O 契约（MVP：聊天式契约）
function deriveContract(ag) {
  const inputs = {}
  const outputs = {}
  for (const n of ag.nodes || []) {
    if (n.type === 'input') inputs[n.id] = { type: 'string', description: n.label || '输入' }
    if (n.type === 'output') outputs[n.id] = { type: 'string', description: n.label || '输出' }
  }
  return { input: inputs, output: outputs }
}

// 导出密钥清洗：节点级模型配置绝不含真实 url/api（用户铁律：导出后不能带 api 和 url）。
// baseUrl/apiKey 一律替换为 env: 占位符（运行时经配置注入接口提供）；模型名非密钥，原样保留。
function sanitizeNodeModels(nodes) {
  return (nodes || []).map((n) => {
    if (!n) return n
    const m = n.model
    if (!m || m.inherit !== false) return { ...n, model: undefined }
    const s = { inherit: false }
    if (m.model) s.model = m.model
    if (m.baseUrl) s.baseUrl = 'env:LLM_BASE_URL'
    if (m.apiKey) s.apiKey = 'env:LLM_API_KEY'
    return { ...n, model: s }
  })
}

// 生成 manifest（固化技能：动态 systemPrompt 在空上下文求值为静态文本）
async function buildManifest(ag, skillList, opts) {
  const used = new Map()
  // 递归收集技能（含子智能体内的技能节点）
  const collectSkills = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === 'subagent') continue // 子智能体节点本身不直接带技能，递归展开其引用
      if (n.type === 'skill' && n.skillId) {
        const a = skillList.find((x) => x.id === n.skillId)
        if (a) used.set(a.id, a)
      }
      // 自定义输入/输出：链接了工具/记忆的节点由默认技能 assistant 处理，需一并固化
      if ((n.type === 'input' || n.type === 'output') && ((n.tools || []).length || (n.memories || []).length)) {
        const a = skillList.find((x) => x.id === 'assistant')
        if (a) used.set(a.id, a)
      }
    }
  }
  collectSkills(ag.nodes || [])
  // 递归收集子智能体（含嵌套）
  const subAgents = {}
  const collectSubs = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === 'subagent' && n.subagentId) {
        let sub = opts.store && opts.store.get(n.subagentId)
        // 工作流中没有 → 智能体定义（data/agent-defs，单智能体转最小图）
        if (!sub && opts.store && typeof opts.store.getDef === 'function') {
          const def = opts.store.getDef(n.subagentId)
          if (def) sub = agent.defToGraph(def)
        }
        if (sub) {
          subAgents[n.subagentId] = { id: sub.id, name: sub.name, nodes: sub.nodes || [], edges: sub.edges || [] }
          collectSkills(sub.nodes || [])
          collectSubs(sub.nodes || [])
        }
      }
    }
  }
  collectSubs(ag.nodes || [])
  const skillsOut = []
  for (const a of used.values()) {
    let sp = ''
    try {
      sp = await skills.resolveSystemPrompt(a, {})
    } catch { sp = String(a.systemPrompt || '') }
    skillsOut.push({
      id: a.id,
      name: a.name,
      category: a.category || '未分类',
      description: a.description || '',
      model: a.model || null,
      temperature: a.temperature ?? 0.7,
      maxTokens: a.maxTokens || null,
      tools: a.tools || [],
      systemPrompt: String(sp || '')
    })
  }
  const contract = deriveContract(ag)
  return {
    id: opts.agentId || ('la_' + (ag.id || crypto.randomUUID()).slice(0, 8)),
    name: opts.name || ag.name || '大型 Agent',
    description: opts.description || '',
    version: '1.0.0',
    contract,
    model: { baseUrl: 'env:LLM_BASE_URL', apiKey: 'env:LLM_API_KEY', default: 'env:LLM_MODEL' },
    auth: { token: crypto.randomBytes(16).toString('hex') },
    skills: skillsOut,
    tools: [...new Set(skillsOut.flatMap((a) => (a.tools || []).filter((t) => t.startsWith('tool:') || t.startsWith('mcp:')).map((t) => t.slice(t.indexOf(':') + 1))))],
    agent: { nodes: sanitizeNodeModels(ag.nodes), edges: ag.edges },
    subAgents: Object.fromEntries(Object.entries(subAgents).map(([k, sub]) => [k, { ...sub, nodes: sanitizeNodeModels(sub.nodes) }])),
    createdAt: Date.now()
  }
}

// 复制被引用的 .tool.py 工具到导出包（兼容旧 .mcp.py）
async function copyPyTools(manifest, ag, outToolsDir) {
  const needed = new Set()
  const isPackRef = (ref) => ref.startsWith('tool:') || ref.startsWith('mcp:')
  const packNameOf = (ref) => ref.slice(ref.indexOf(':') + 1)
  // 收集节点级工具引用（含子智能体节点内的节点）
  const collectRefs = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === 'subagent') {
        const sub = (manifest.subAgents || {})[n.subagentId]
        if (sub) collectRefs(sub.nodes || [])
        continue
      }
      if (n.type === 'input' || n.type === 'output') {
        // 自定义输入/输出节点的节点级工具链接
        for (const ref of n.tools || []) {
          if (isPackRef(ref)) needed.add(packNameOf(ref))
        }
        continue
      }
      if (n.type !== 'skill' || !n.skillId) continue
      const skill = (manifest.skills || []).find((a) => a.id === n.skillId)
      for (const ref of skill?.tools || []) {
        if (isPackRef(ref)) needed.add(packNameOf(ref))
      }
      // 节点级工具链接
      for (const ref of n.tools || []) {
        if (isPackRef(ref)) needed.add(packNameOf(ref))
      }
    }
  }
  collectRefs(ag.nodes || [])
  const all = toolPacks.allTools()
  const copied = []
  for (const name of needed) {
    const t = all.find((x) => x.name === name)
    if (!t) continue
    const packId = t.packId
    const file = toolPacks.getSourceFile(packId)
    const list = await toolPacks.list()
    const meta = list.toolPacks.find((m) => m.id === packId)
    if (file && meta && meta.kind === 'py' && /\.(tool|mcp)\.py$/.test(file)) {
      fs.copyFileSync(file, path.join(outToolsDir, path.basename(file)))
      copied.push(path.basename(file))
    }
  }
  return copied
}

/**
 * 导出智能体为大型 Agent 包
 * @param {object} opts { agent, name, description, outDir, store, port, target }
 * @returns {Promise<{ok, dir, warnings, errors, files}>}
 */
async function exportAgent(opts) {
  const ag = opts.agent
  if (!ag || !ag.nodes) throw new Error('智能体数据无效')

  const skillList = await skills.list()
  const mcpList = await toolPacks.list()
  const mcpKindMap = Object.fromEntries(mcpList.toolPacks.map((m) => [m.id, m.kind]))

  const check = await checkAgent(ag, skillList, mcpKindMap, opts.store)
  if (!check.ok) {
    return { ok: false, dir: null, warnings: check.warnings, errors: check.errors }
  }

  const outDir = opts.outDir
  fs.mkdirSync(outDir, { recursive: true })

  const manifest = await buildManifest(ag, skillList, opts)
  const port = opts.port || 37800
  const name = manifest.name
  // 导出形式：'all'（默认，Python 库 + API 服务）/ 'py'（仅 Python 库）/ 'api'（仅 API 服务）
  const target = opts.target || 'all'

  // 1. 拷贝模板工程（显式 .py/.html/.md 文件；api 目标跳过 la/ 库接口）
  const written = copyTemplate(outDir, target)

  // 2. 写入 manifest.json
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')
  written.push('manifest.json')

  // 3. 渲染占位符（web 控制台 + 启动脚本）
  const vars = {
    __NAME__: name,
    __DESC__: manifest.description || '大型 Agent',
    __TOKEN__: manifest.auth.token,
    __PORT__: String(port)
  }
  for (const rel of ['web/index.html', 'start.bat', 'start.sh']) {
    const fp = path.join(outDir, rel)
    if (fs.existsSync(fp)) fs.writeFileSync(fp, renderVars(fs.readFileSync(fp, 'utf8'), vars), 'utf8')
  }

  // 4. 工具复制
  const toolsDir = path.join(outDir, 'tools')
  fs.mkdirSync(toolsDir, { recursive: true })
  const copiedTools = await copyPyTools(manifest, ag, toolsDir)
  if (copiedTools.length) written.push('tools/')

  // 5. 内嵌 Python 运行时（复用 Harness 运行时）
  const src = runtimeSource()
  if (fs.existsSync(src)) {
    fs.cpSync(src, path.join(outDir, 'runtime', 'python'), { recursive: true })
  } else {
    check.warnings.push('未找到内嵌 Python 运行时（runtime/python），导出物将需要目标机器安装 Python 3.12')
  }

  // 6. 接入说明（按导出形式从模板片段组装）
  const readme = buildReadme(target)
  fs.writeFileSync(
    path.join(outDir, '接入说明.md'),
    renderVars(readme, { ...vars, __OUTDIR__: outDir.replace(/\\/g, '/') }),
    'utf8'
  )
  written.push('接入说明.md')

  // 7. 记忆空间骨架：模板已拷贝 policy/ledger/README，这里补齐 facts/episodes/skills/views 子目录
  const memoryDir = path.join(outDir, 'memory')
  for (const sub of ['facts', 'episodes', 'skills', 'views']) {
    fs.mkdirSync(path.join(memoryDir, sub), { recursive: true })
  }

  // 8. 记忆复制（记忆节点引用的架构，含子智能体）：整体复制目录到导出包 memory/<架构名>/
  const memoryNames = new Set()
  const collectMemory = (nodes) => {
    for (const n of nodes || []) {
      if (n.type === 'subagent') {
        const sub = (manifest.subAgents || {})[n.subagentId]
        if (sub) collectMemory(sub.nodes || [])
        continue
      }
      if (n.type === 'memory') {
        if (n.memoryArch) memoryNames.add(n.memoryArch)
        for (const r of n.reads || []) if (r.arch) memoryNames.add(r.arch)
        for (const w of n.writes || []) if (w.arch) memoryNames.add(w.arch)
      }
      for (const mname of n.memories || []) memoryNames.add(mname)
    }
  }
  collectMemory(ag.nodes || [])
  if (memoryNames.size) {
    for (const name of memoryNames) {
      const src = memory.dirPath(name)
      if (src && fs.existsSync(src)) {
        fs.cpSync(src, path.join(memoryDir, memory.safeName(name)), { recursive: true })
      }
    }
    written.push('memory/<架构>/')
  }

  manifest.memory = { dir: 'memory', policy: 'policy.md', ledger: 'ledger.md' }
  fs.writeFileSync(path.join(outDir, 'manifest.json'), JSON.stringify(manifest, null, 2), 'utf8')

  return { ok: true, dir: outDir, name, port, token: manifest.auth.token, warnings: check.warnings, errors: [], files: written }
}

// ---------------- M2-⑥ 单文件 exe 打包（PyInstaller） ----------------

// 打包工具根目录：固定在 D 盘（不往 C 盘写任何东西），可用环境变量 LAG_TOOLS 覆盖
function buildToolsRoot() {
  return process.env.LAG_TOOLS || 'D:\\Project\\Harness\\build-tools'
}

// 构造打包进程环境：PyInstaller 缓存、临时文件全部重定向到 D 盘
function buildToolsEnv() {
  const root = buildToolsRoot()
  const site = path.join(root, 'py312-user', 'site-packages')
  const cache = path.join(root, 'pyinstaller-cache')
  const tmp = path.join(root, 'tmp')
  for (const d of [site, cache, tmp]) fs.mkdirSync(d, { recursive: true })
  return {
    PYINSTALLER_CONFIG_DIR: cache,
    TMP: tmp,
    TEMP: tmp,
    PYTHONDONTWRITEBYTECODE: '1'
  }
}

// 生成 PyInstaller 启动器（注入 D 盘 site-packages；runtime python 忽略 PYTHONPATH，必须用 launcher）
function ensureLauncher(root) {
  const fp = path.join(root, 'launcher.py')
  const site = path.join(root, 'py312-user', 'site-packages')
  const code =
    '# 由 LAG harness 生成：把 PyInstaller 包目录注入 sys.path 后转发参数\n' +
    'import os, sys\n' +
    "sys.path.insert(0, r'" + site.replace(/'/g, "\\'") + "')\n" +
    "if len(sys.argv) > 1 and sys.argv[1] == '__probe__':\n" +
    '    import PyInstaller\n' +
    '    sys.exit(0)\n' +
    'from PyInstaller.__main__ import run\n' +
    'run(sys.argv[1:])\n'
  fs.writeFileSync(fp, code, 'utf8')
  return fp
}

// exe 文件名不能含 Windows 非法字符
function safeExeName(name) {
  const base = String(name || 'LA').replace(/[\\/:*?"<>|]/g, '_').trim()
  return base || 'LA'
}

// 探路 Python（优先内嵌运行时 runtime/python）并确认 PyInstaller 可用
function locatePython() {
  const root = buildToolsRoot()
  const env = buildToolsEnv()
  const launcher = ensureLauncher(root)
  const candidates = []
  const embedded = path.join(runtimeSource(), 'python.exe')
  if (fs.existsSync(embedded)) candidates.push(embedded)
  if (process.env.PYTHON && fs.existsSync(process.env.PYTHON)) candidates.push(process.env.PYTHON)
  candidates.push('python')
  for (const py of candidates) {
    try {
      execFileSync(py, [launcher, '__probe__'], { timeout: 15000, env: { ...process.env, ...env }, stdio: 'ignore' })
      return { python: py, env, launcher }
    } catch {
      /* 换下一个候选 */
    }
  }
  return null
}

// 运行时实际用到的 stdlib 模块（runtime python 的 stdlib 在 python312.zip 内，PyInstaller 收集不全，显式声明）
const HIDDEN_IMPORTS = [
  'uuid', 'webbrowser', 'argparse', 'http.server', 'socketserver',
  'urllib.request', 'urllib.error', 'urllib.parse', 'importlib.util',
  'threading', 'ssl', 'contextlib', 'email', 'mimetypes', 'base64'
]

// 在导出包目录上运行 PyInstaller，生成单文件 exe
async function buildExe(opts) {
  const outDir = opts.outDir
  if (!outDir || !fs.existsSync(path.join(outDir, 'la_main.py'))) {
    throw new Error('请先导出 LA 包，再执行打包（outDir 下缺少 la_main.py）')
  }
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, 'manifest.json'), 'utf8'))
  const name = safeExeName(opts.name || manifest.name)

  const found = locatePython()
  if (!found) {
    throw new Error(`未找到可用的 Python + PyInstaller（打包工具应位于 ${buildToolsRoot()}\\py312-user\\site-packages）`)
  }
  const { python, env, launcher } = found

  const work = path.join(outDir, '.pyinstaller-work')
  const dist = path.join(outDir, 'dist')
  const sep = path.delimiter // Windows: ';'，Linux: ':'
  const addData = [
    ['executor', 'executor'],
    ['transports', 'transports'],
    ['web', 'web'],
    ['tools', 'tools'],
    ['memory', 'memory'],
    ['manifest.json', '.']
  ].map(([src, dst]) => path.join(outDir, src) + sep + dst)

  const args = [
    '--noconfirm', '--onefile',
    '--name', name,
    '--distpath', dist,
    '--workpath', work,
    '--specpath', work,
    '--paths', outDir
  ]
  for (const ad of addData) args.push('--add-data', ad)
  for (const hi of HIDDEN_IMPORTS) args.push('--hidden-import', hi)
  args.push(path.join(outDir, 'la_main.py'))

  const stdout = await new Promise((resolve, reject) => {
    const child = execFile(python, [launcher, ...args], { timeout: 20 * 60 * 1000, maxBuffer: 8 * 1024 * 1024, env: { ...process.env, ...env } }, (err, so, se) => {
      if (err) {
        const brief = String(se || so || '').split(/\r?\n/).filter((l) => /error|fatal|异常/i.test(l)).slice(-12).join('\n')
        reject(new Error(brief || err.message))
      } else {
        resolve(String(so) + String(se))
      }
    })
    child.stderr?.on('data', () => {}) // 防止管道阻塞
  })

  const exePath = path.join(dist, name + (process.platform === 'win32' ? '.exe' : ''))
  if (!fs.existsSync(exePath)) {
    throw new Error('PyInstaller 执行完成但未找到产物 exe（查看控制台输出定位问题）')
  }
  const size = fs.statSync(exePath).size
  return { ok: true, exePath, name, size, log: stdout }
}

module.exports = { exportAgent, buildExe }
