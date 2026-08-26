// AI Harness 主进程
const { app, BrowserWindow, ipcMain, dialog, shell, screen } = require('electron')
const path = require('path')
const fs = require('fs')
const store = require('./store')
const skills = require('./skills')
const toolPacks = require('./tool-packs')
const externalMcps = require('./mcp-client')
const workspace = require('./workspace')
const chat = require('./chat')
const agent = require('./agent')
const tools = require('./tools')
const apiServer = require('./api-server')
const exporter = require('./exporter')
const protocols = require('./protocols')
const memory = require('./memory')
const team = require('./team')
const terminal = require('./terminal')

// ---- 用户数据目录重定向到 D 盘工程目录（避免写入 C 盘） ----
// 目标目录：默认 D:\Project\Harness\data，可用环境变量 AI_HARNESS_DATA 覆盖
const DATA_DIR = process.env.AI_HARNESS_DATA || path.join('D:', path.sep, 'Project', 'Harness', 'data')

// 必须在 app ready / requestSingleInstanceLock 之前重定向，否则单例锁和所有存储仍会落到 C 盘
const legacyUserData = app.getPath('userData') // Electron 默认的 C:\...\AppData\Roaming\AI Harness
try {
  app.setPath('userData', DATA_DIR)
  app.setPath('crashDumps', path.join(DATA_DIR, 'crashDumps'))
} catch (e) {
  console.warn('[data] 设置数据目录失败:', e.message)
}

// 首次启动：把旧 C 盘数据整体复制迁移到新目录（仅当新目录为空时执行，旧目录保留作备份）
try {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const newEmpty = fs.readdirSync(DATA_DIR).length === 0
  if (newEmpty && fs.existsSync(legacyUserData) && legacyUserData !== DATA_DIR && fs.readdirSync(legacyUserData).length > 0) {
    fs.cpSync(legacyUserData, DATA_DIR, { recursive: true })
    console.log('[data] 已从', legacyUserData, '迁移到', DATA_DIR)
  }
} catch (e) {
  console.warn('[data] 数据迁移失败:', e.message)
}

let mainWindow = null
let settings = null
let settingsStore = null
let agentStore = null
let defStore = null // 智能体定义存储（data/agent-defs）
const activeChats = new Map() // sessionId -> AbortController
const activeWorkflowRuns = new Map() // runId -> AbortController

const isDev = !app.isPackaged

// 运行 Python 文件（技能/记忆/协议通用）：嵌入式或系统 Python，15s 超时，回显 stdout/stderr
// （模块级定义：registerIpc 与 MCP server 都要用）
const runPythonFile = (file) => {
  const { checkPython } = require('./python-engine')
  const py = checkPython()
  if (!py.available) throw new Error('未检测到 Python，无法运行（请安装 Python 或运行嵌入式运行时安装脚本）')
  const { execFile } = require('child_process')
  return new Promise((resolve) => {
    execFile(py.bin, [file], { timeout: 15000, windowsHide: true }, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        exitCode: err ? (err.code || 1) : 0,
        stdout: String(stdout || ''),
        stderr: String(stderr || '')
      })
    })
  })
}

function builtinSkillsDir() {
  return isDev
    ? path.join(__dirname, 'skills')
    : path.join(process.resourcesPath, 'builtin-skills')
}

function builtinToolPacksDir() {
  return isDev
    ? path.join(__dirname, 'tool-packs')
    : path.join(process.resourcesPath, 'builtin-tool-packs')
}

// 一次性数据迁移（旧命名 → 新命名）：
//   workflows/*.json → agents/*.json（节点 agent→skill / workflow→subagent，run_workflow→run_agent）
//   agents/*.agent.js|py → skills/<id>/main.skill.js|py（目录式技能，AGENT_*→SKILL_*）
//   agents/categories.json → skills/categories.json
//   skills/*.md（旧 md 技能）→ skills/<name>/main.skill.py
//   平铺 skills/*.skill.js|py（旧 v2 产物）→ skills/<id>/main.skill.js|py
function migrateData(userDataDir) {
  // 0. 工具包改名迁移（MCP → tool）：独立标记，不受旧命名迁移完成状态影响
  const tpMark = path.join(userDataDir, '.migrated-toolpack-v1')
  if (!fs.existsSync(tpMark)) {
    try {
      // 0.1 用户工具包目录改名：mcps → tool-packs，文件 .mcp.* → .tool.*（覆盖式，保留用户可能改过的版本）
      const oldMcps = path.join(userDataDir, 'mcps')
      const newTp = path.join(userDataDir, 'tool-packs')
      if (fs.existsSync(oldMcps)) {
        fs.mkdirSync(newTp, { recursive: true })
        for (const name of fs.readdirSync(oldMcps)) {
          if (name === '__pycache__') { try { fs.rmSync(path.join(oldMcps, name), { recursive: true, force: true }) } catch {} ; continue }
          const dest = path.join(newTp, name.replace(/\.mcp\.(js|py)$/, '.tool.$1'))
          try { fs.copyFileSync(path.join(oldMcps, name), dest) } catch (e) { console.warn('[migrate] 工具包文件迁移失败:', name, e.message) }
        }
        try { fs.rmSync(oldMcps, { recursive: true, force: true }) } catch { /* 忽略 */ }
      }
      // 0.2 技能源码引用 mcp:xxx → tool:xxx（引号内精准替换；JS + Python 技能，含记忆卡片技能）
      const replaceRefs = (code) => code.replace(/(["'])(mcp:[A-Za-z0-9_]+)\1/g, (_m, q, v) => `${q}tool:${v.slice(4)}${q}`)
      const skillSrc = []
      const skDir2 = path.join(userDataDir, 'skills')
      if (fs.existsSync(skDir2)) {
        for (const id of fs.readdirSync(skDir2)) {
          for (const f of ['main.skill.js', 'main.skill.py']) {
            const fp = path.join(skDir2, id, f)
            if (fs.existsSync(fp)) skillSrc.push(fp)
          }
        }
      }
      const memRoot = path.join(userDataDir, 'memory')
      if (fs.existsSync(memRoot)) {
        for (const arch of fs.readdirSync(memRoot)) {
          const archDir = path.join(memRoot, arch)
          let st
          try { st = fs.statSync(archDir) } catch { continue }
          if (!st.isDirectory()) continue
          for (const f of fs.readdirSync(archDir)) {
            if (f.endsWith('.skill.py')) skillSrc.push(path.join(archDir, f))
          }
        }
      }
      for (const fp of skillSrc) {
        try {
          const code = fs.readFileSync(fp, 'utf8')
          const next = replaceRefs(code)
          if (next !== code) fs.writeFileSync(fp, next, 'utf8')
        } catch { /* 忽略 */ }
      }
      // 0.3 画布节点级工具链接 mcp:xxx → tool:xxx
      const agDir2 = path.join(userDataDir, 'agents')
      if (fs.existsSync(agDir2)) {
        for (const name of fs.readdirSync(agDir2)) {
          if (!name.endsWith('.json')) continue
          try {
            const fp = path.join(agDir2, name)
            const ag = JSON.parse(fs.readFileSync(fp, 'utf8'))
            let changed = false
            for (const n of ag.nodes || []) {
              if (n && Array.isArray(n.tools)) {
                const nt = n.tools.map((t) => (typeof t === 'string' && t.startsWith('mcp:') ? 'tool:' + t.slice(4) : t))
                if (JSON.stringify(nt) !== JSON.stringify(n.tools)) { n.tools = nt; changed = true }
              }
            }
            if (changed) fs.writeFileSync(fp, JSON.stringify(ag, null, 2), 'utf8')
          } catch (e) { console.warn('[migrate] 画布工具引用迁移失败:', name, e.message) }
        }
      }
      fs.writeFileSync(tpMark, JSON.stringify({ ts: Date.now() }), 'utf8')
      console.log('[migrate] 工具包改名迁移完成（mcps → tool-packs）')
    } catch (e) {
      console.warn('[migrate] 工具包改名迁移失败:', e.message)
    }
  }

  const mark = path.join(userDataDir, '.migrated-naming-v3')
  if (fs.existsSync(mark)) return
  const move = (src, dest) => {
    try {
      fs.mkdirSync(path.dirname(dest), { recursive: true })
      if (fs.existsSync(dest)) { try { fs.rmSync(src, { force: true }) } catch {} ; return }
      try { fs.renameSync(src, dest) } catch { fs.copyFileSync(src, dest); try { fs.rmSync(src, { force: true }) } catch {} }
    } catch (e) { console.warn('[migrate] move 失败:', src, e.message) }
  }
  try {
    const agDir = path.join(userDataDir, 'agents')
    const skDir = path.join(userDataDir, 'skills')

    // 1. 旧智能体代码 → skills/<id>/ 目录（main.skill.js / main.skill.py）
    if (fs.existsSync(agDir)) {
      fs.mkdirSync(skDir, { recursive: true })
      for (const name of fs.readdirSync(agDir)) {
        if (name.endsWith('.agent.js')) {
          const id = name.replace('.agent.js', '')
          const d = path.join(skDir, id)
          if (fs.existsSync(path.join(d, 'main.skill.js'))) { try { fs.rmSync(path.join(agDir, name), { force: true }) } catch {} ; continue }
          try {
            fs.mkdirSync(d, { recursive: true })
            fs.renameSync(path.join(agDir, name), path.join(d, 'main.skill.js'))
          } catch (e) { console.warn('[migrate] agent.js 迁移失败:', name, e.message) }
        } else if (name.endsWith('.agent.py')) {
          const id = name.replace('.agent.py', '')
          const d = path.join(skDir, id)
          if (fs.existsSync(path.join(d, 'main.skill.py'))) { try { fs.rmSync(path.join(agDir, name), { force: true }) } catch {} ; continue }
          try {
            let code = fs.readFileSync(path.join(agDir, name), 'utf8')
            code = code.replace(/\bAGENT_/g, 'SKILL_')
            fs.mkdirSync(d, { recursive: true })
            fs.writeFileSync(path.join(d, 'main.skill.py'), code, 'utf8')
            fs.rmSync(path.join(agDir, name), { force: true })
          } catch (e) { console.warn('[migrate] agent.py 迁移失败:', name, e.message) }
        } else if (name === 'categories.json') {
          move(path.join(agDir, name), path.join(skDir, 'categories.json'))
        }
      }
    }

    // 1.5 平铺 skills/*.skill.js|py（旧 v2 产物）→ skills/<id>/ 目录
    if (fs.existsSync(skDir)) {
      for (const name of fs.readdirSync(skDir)) {
        let ext = null
        if (name.endsWith('.skill.js')) ext = '.skill.js'
        else if (name.endsWith('.skill.py')) ext = '.skill.py'
        if (!ext) continue
        const id = name.replace(/\.skill\.(js|py)$/, '')
        const d = path.join(skDir, id)
        const dest = path.join(d, 'main' + ext)
        if (fs.existsSync(dest)) { try { fs.rmSync(path.join(skDir, name), { force: true }) } catch {} ; continue }
        try {
          fs.mkdirSync(d, { recursive: true })
          fs.renameSync(path.join(skDir, name), dest)
        } catch (e) { console.warn('[migrate] 平铺 skill 打包失败:', name, e.message) }
      }
    }

    // 2. 旧 md 技能 → skills/<name>/ 目录（main.skill.py）
    if (fs.existsSync(skDir)) {
      for (const name of fs.readdirSync(skDir)) {
        if (!name.endsWith('.md')) continue
        const base = path.basename(name, '.md')
        const d = path.join(skDir, base)
        const py = path.join(d, 'main.skill.py')
        if (fs.existsSync(py)) { try { fs.rmSync(path.join(skDir, name), { force: true }) } catch {} ; continue }
        try {
          const content = fs.readFileSync(path.join(skDir, name), 'utf8')
          const safe = content.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n')
          const code = `# 由旧版 Markdown 技能迁移而来\nSKILL_ID = "${base}"\nSKILL_NAME = "${base}"\nSKILL_DESC = "（由旧版技能迁移）"\nSKILL_AVATAR = "📄"\nSKILL_TOOLS = []\nSYSTEM_PROMPT = "${safe}"\n`
          fs.mkdirSync(d, { recursive: true })
          fs.writeFileSync(py, code, 'utf8')
          fs.rmSync(path.join(skDir, name), { force: true })
        } catch (e) { console.warn('[migrate] md 技能迁移失败:', name, e.message) }
      }
    }

    // 3. 旧工作流 → agents（节点 type/字段映射）
    const wfDir = path.join(userDataDir, 'workflows')
    if (fs.existsSync(wfDir)) {
      fs.mkdirSync(agDir, { recursive: true })
      for (const name of fs.readdirSync(wfDir)) {
        if (!name.endsWith('.json')) continue
        const dest = path.join(agDir, name)
        try {
          const wf = JSON.parse(fs.readFileSync(path.join(wfDir, name), 'utf8'))
          const remapTools = (arr) => (Array.isArray(arr) ? arr.map((t) => (t === 'run_workflow' ? 'run_agent' : t)) : arr)
          const nodes = (wf.nodes || []).map((n) => {
            if (!n) return n
            const { skills, ...rest } = n // 去掉旧 md 技能链接
            if (n.type === 'agent') {
              const { agentId, ...r } = rest
              return { ...r, type: 'skill', skillId: agentId || r.skillId, tools: remapTools(r.tools) }
            }
            if (n.type === 'workflow') {
              const { workflowId, ...r } = rest
              return { ...r, type: 'subagent', subagentId: workflowId || r.subagentId }
            }
            return { ...rest, tools: remapTools(rest.tools) }
          })
          const agent = { ...wf, nodes }
          if (!fs.existsSync(dest)) fs.writeFileSync(dest, JSON.stringify(agent, null, 2), 'utf8')
          fs.rmSync(path.join(wfDir, name), { force: true })
        } catch (e) { console.warn('[migrate] 工作流迁移失败:', name, e.message) }
      }
    }

    // 4. 旧会话 sessions/*.json：agentId→skillId，targetType workflow→agent / agent→skill
    const sessDir = path.join(userDataDir, 'sessions')
    if (fs.existsSync(sessDir)) {
      for (const name of fs.readdirSync(sessDir)) {
        if (!name.endsWith('.json')) continue
        const fp = path.join(sessDir, name)
        try {
          const s = JSON.parse(fs.readFileSync(fp, 'utf8'))
          let changed = false
          if (s.agentId != null && s.skillId == null) { s.skillId = s.agentId; delete s.agentId; changed = true }
          if (s.targetType === 'workflow') { s.targetType = 'agent'; changed = true }
          else if (s.targetType === 'agent') { s.targetType = 'skill'; changed = true }
          if (changed) fs.writeFileSync(fp, JSON.stringify(s, null, 2), 'utf8')
        } catch (e) { console.warn('[migrate] 会话迁移失败:', name, e.message) }
      }
    }

    // 5. 工具包改名迁移已前移到函数开头（独立标记 .migrated-toolpack-v1）

    fs.writeFileSync(mark, JSON.stringify({ ts: Date.now() }), 'utf8')
    console.log('[migrate] 命名迁移完成')
  } catch (e) {
    console.warn('[migrate] 迁移失败:', e.message)
  }
}

function createWindow() {
  // 高分屏（Windows 显示缩放 >100%）下 Electron 的窗口尺寸按物理像素生效，
  // 这里按当前显示器缩放系数放大，确保窗口 CSS 尺寸始终不低于 1100x700（内容不会被挤没）
  const dsf = screen.getPrimaryDisplay().scaleFactor || 1
  mainWindow = new BrowserWindow({
    width: Math.round(1280 * dsf),
    height: Math.round(820 * dsf),
    minWidth: Math.round(1100 * dsf),
    minHeight: Math.round(700 * dsf),
    backgroundColor: '#0d1117',
    title: 'LAG harness',
    autoHideMenuBar: true,
    icon: isDev ? undefined : path.join(process.resourcesPath, 'builtin-agents', '..', 'icon.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      backgroundThrottling: false
    }
  })

  if (isDev) {
    // 开发模式：优先连接 Vite dev server，不可达时回退到已构建产物
    mainWindow.loadURL('http://localhost:5173')
    mainWindow.webContents.once('did-fail-load', (_e, code, desc) => {
      if (code === -102 || String(desc).includes('ERR_CONNECTION_REFUSED')) {
        mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
      }
    })
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'))
  }
  mainWindow.on('closed', () => { mainWindow = null })
  mainWindow.webContents.on('render-process-gone', (_e, details) => {
    console.log('[crash] render-process-gone', JSON.stringify(details))
    try {
      require('fs').writeFileSync(path.join(DATA_DIR, 'renderer-errors.log'), JSON.stringify({ t: Date.now(), crash: details }, null, 2), 'utf8')
    } catch {}
  })
  // 渲染进程 console → D 盘日志（诊断画布交互异常，绝不写 C 盘）
  mainWindow.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    try {
      require('fs').appendFileSync(path.join(DATA_DIR, 'renderer-errors.log'), `[${new Date().toISOString()}] L${level} ${message}\n`)
    } catch {}
  })

  // 调试：--screenshot 启动后截图并退出，用于验证 UI 渲染
  if (process.argv.includes('--screenshot')) {
    console.log('[screenshot] argv =', JSON.stringify(process.argv))
    mainWindow.webContents.on('console-message', (_e, level, message) => {
      console.log('[renderer]', message)
    })
    mainWindow.webContents.once('did-finish-load', async () => {
      setTimeout(async () => {
        try {
          // 可选：--shot-view=agents 或 --shot-view agents 切换到指定视图再截图
          let shotViewName = null
          const eqArg = process.argv.find((a) => a.startsWith('--shot-view='))
          if (eqArg) shotViewName = eqArg.split('=')[1]
          else {
            const vi = process.argv.indexOf('--shot-view')
            if (vi >= 0) shotViewName = process.argv[vi + 1]
          }
          const views = ['chat', 'workflows', 'agents', 'protocols', 'skills', 'memory', 'toolPacks', 'terminal', 'team', 'workspace']
          const idx = views.indexOf(shotViewName)
          if (idx >= 0) {
              try { require('fs').writeFileSync(path.join(DATA_DIR, 'e2e-diag.json'), JSON.stringify({ step: 'before-nav-click', idx }, null, 2), 'utf8') } catch {}
              const clickDiag = await mainWindow.webContents.executeJavaScript(`(() => {
                const btns = document.querySelectorAll('.nav-item')
                const before = btns.length
                let activeBefore = null, activeAfter = null, afterDispatch = null
                const a = document.querySelector('.nav-item.active')
                if (a) activeBefore = a.textContent.trim().slice(0, 8)
                if (btns[${idx}]) {
                  btns[${idx}].click()
                  const a1 = document.querySelector('.nav-item.active')
                  if (a1) activeAfter = a1.textContent.trim().slice(0, 8)
                  btns[${idx}].dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }))
                  const a2 = document.querySelector('.nav-item.active')
                  if (a2) afterDispatch = a2.textContent.trim().slice(0, 8)
                }
                return { before, activeBefore, activeAfter, afterDispatch }
              })()`)
              console.log('[nav-click]', JSON.stringify(clickDiag))
              global.__NAVCLICK__ = clickDiag
              await new Promise((r) => setTimeout(r, 2000))
            }
          // 可选：--shot-edit 打开第一个智能体的代码编辑器后再截图
          if (process.argv.includes('--shot-edit')) {
            const fs = require('fs')
            const log = (step, data) => { try { fs.writeFileSync(path.join(DATA_DIR, 'e2e-diag.json'), JSON.stringify({ step, navClick: global.__NAVCLICK__ || null, data }, null, 2), 'utf8') } catch {} }
            mainWindow.show(); mainWindow.focus(); mainWindow.setAlwaysOnTop(true)
            await new Promise((r) => setTimeout(r, 500))
            // 安装全局错误捕获（写入 window.__ERR__ 供诊断）
            await mainWindow.webContents.executeJavaScript(`(() => {
              window.__ERR__ = []
              window.addEventListener('error', (e) => window.__ERR__.push('error: ' + (e.message || e.error)))
              window.addEventListener('unhandledrejection', (e) => window.__ERR__.push('rejection: ' + (e.reason && (e.reason.message || e.reason))))
              return true
            })()`)
            log('listeners', {})
            // 打开第一个智能体画布（卡片类名 skill-card）
            const opened = await mainWindow.webContents.executeJavaScript(`(() => {
              const card = document.querySelector('.skill-card')
              if (card) { card.click(); return 'clicked' }
              return 'no-card'
            })()`)
            log('open-canvas', { opened })
            await new Promise((r) => setTimeout(r, 1800))
            // 画布编辑器内诊断：节点数 / 搜索按钮 / 弹层打开 / 数据 IPC
            const diag = await mainWindow.webContents.executeJavaScript(`(async () => {
              const wait = (ms) => new Promise((r) => setTimeout(r, ms))
              const out = {
                errs: window.__ERR__ || [],
                wfPanel: !!document.querySelector('.workflow-panel'),
                wfNodes: document.querySelectorAll('.wf-node').length,
                bodyChildren: document.body.children.length,
                rootText: (document.getElementById('root') ? document.getElementById('root').textContent || '' : '').slice(0, 200)
              }
              try { out.skills = (await window.harness.skills.list()).length } catch (e) { out.skillsErr = String(e) }
              // 1) 画布顶部切换智能体搜索
              const topBtn = document.querySelector('.wf-switch-select .search-select-cur')
              if (topBtn) { topBtn.click(); await wait(350); out.topPop = !!document.querySelector('.search-select-pop'); topBtn.click(); await wait(200) }
              // 2) 右键画布 → 添加技能节点
              const canvas = document.querySelector('.wf-canvas')
              if (canvas) {
                const r = canvas.getBoundingClientRect()
                canvas.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: r.left + Math.min(420, r.width / 2), clientY: r.top + Math.min(240, r.height / 2) }))
                await wait(400)
                const items = [...document.querySelectorAll('.wf-ctxmenu-item')]
                out.ctxItems = items.length
                const skillBtn = items.find((b) => b.textContent.includes('技能') && !b.textContent.includes('节点') && !b.textContent.includes('模块'))
                if (skillBtn) { skillBtn.click(); await wait(400) }
                out.skillNodes = document.querySelectorAll('.wf-node[data-type="skill"]').length
                // 3) 点击技能节点头部展开面板
                const sn = document.querySelector('.wf-node[data-type="skill"]')
                if (sn) {
                  const h = sn.querySelector('.wf-node-head')
                  if (h) { const hr = h.getBoundingClientRect(); h.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, clientX: hr.left + 30, clientY: hr.top + 14 })) }
                  await wait(450)
                  out.nodeSearchBtns = sn.querySelectorAll('.search-select-cur').length
                  // 4) 点击节点内"搜索技能"并检查弹窗
                  const ss = sn.querySelector('.search-select-cur')
                  if (ss) { ss.click(); await wait(500); out.nodePop = !!document.querySelector('.search-select-pop'); out.nodePopItems = document.querySelectorAll('.search-select-item').length; out.nodePopInBody = !!document.querySelector('body > .search-select-pop') }
                }
              }
              return out
            })()`)
            console.log('[canvas-diag]', JSON.stringify(diag))
             try {
               require('fs').writeFileSync(path.join(DATA_DIR, 'e2e-diag.json'), JSON.stringify({ navClick: global.__NAVCLICK__ || null, diag }, null, 2), 'utf8')
             } catch {}
          }
          const img = await mainWindow.webContents.capturePage()
          console.log('[screenshot] img.isEmpty =', img.isEmpty(), 'size =', img.getSize())
          const fs = require('fs')
          const out = path.join(DATA_DIR, 'screenshot.png')
          fs.writeFileSync(out, img.toPNG())
          console.log('[screenshot] 已保存', out)
        } catch (e) {
          console.error('[screenshot] 失败:', e.message)
        }
        app.quit()
      }, 2500)
    })
  }
}

// ---------------- 对话 ----------------
// 解析会话的有效记忆绑定：会话级优先，未绑定时继承所在工作区的绑定
function effectiveMemoryArch(session) {
  if (session && session.memoryArch) return { arch: session.memoryArch, target: 'session' }
  if (session) {
    const sb = workspace.listSandboxes().list.find((s) => s.sessionId === session.id)
    if (sb && sb.memoryArch) return { arch: sb.memoryArch, target: 'sandbox' }
  }
  return null
}

// 对话/运行前的"更新先整理"：架构目录 mtime 与上次记录不同 → 先按新架构整理一遍再继续
// 整理失败不阻断对话（提示 + 仍以旧内容继续），版本游标不更新，下次对话再试
async function maybeOrganizeBefore(session, send) {
  // 迷你沙盒：会话绑定后使用私有记忆副本，无需按共享架构做"更新先整理"
  if (memory.hasSessionCopy(session.id)) return
  const eff = effectiveMemoryArch(session)
  if (!eff) return
  const mtime = memory.archMtime(eff.arch)
  let last = null
  if (eff.target === 'session') {
    last = session.lastArchMtime
  } else {
    const sb = workspace.listSandboxes().list.find((s) => s.sessionId === session.id)
    last = sb && sb.lastArchMtime
  }
  if (mtime && mtime === last) return
  send && send('chat:status', { sessionId: session.id, status: `正在整理记忆「${eff.arch}」…` })
  try {
    await memory.runOrganize(eff.arch, { settings, agentStore })
    // 整理可能写回记忆文件 → 目录 mtime 会再变；用整理完成后的 mtime 作为游标，避免每次对话都重跑整理
    const doneMtime = memory.archMtime(eff.arch) || mtime
    if (eff.target === 'session') {
      session.lastArchMtime = doneMtime
      chat.getSessionStore().save(session)
    } else {
      const sb = workspace.listSandboxes().list.find((s) => s.sessionId === session.id)
      if (sb) workspace.touchSandboxMemory(sb.id, doneMtime)
    }
  } catch (e) {
    console.warn('[memory] 更新先整理失败（不阻断对话）:', e.message)
  }
}

// 会话级记忆绑定 → skillOverride（记忆工具并入）+ toolContext.memoryFiles
async function buildMemoryBinding(skillId, session) {
  const eff = effectiveMemoryArch(session)
  if (!eff) return { skillOverride: null, memoryFiles: [] }
  // 会话私有副本优先（迷你沙盒）；未克隆则回退到共享架构目录
  const useCopy = memory.hasSessionCopy(session.id)
  const d = useCopy ? memory.sessionCopyDir(session.id) : memory.dirPath(eff.arch)
  if (!d) return { skillOverride: null, memoryFiles: [] }
  const bind = memory.archBinding(eff.arch)
  let base = null
  try { base = await skills.get(skillId) } catch { base = null }
  return {
    skillOverride: base
      ? {
          ...base,
          tools: [...new Set([...(base.tools || []), ...bind.tools])],
          systemPrompt: `${base.systemPrompt || ''}\n\n${bind.prompt}`
        }
      : null,
    memoryFiles: [{ name: eff.arch, dir: d }]
  }
}

async function runChatFor(skillId, sessionId, message) {
  const session = chat.getSessionStore().get(sessionId)
  if (!session) throw new Error('会话不存在')
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }
  await maybeOrganizeBefore(session, send)
  session.messages.push({ role: 'user', content: message, ts: Date.now() })
  chat.getSessionStore().save(session)
  send('chat:user', { sessionId, message })

  const controller = new AbortController()
  activeChats.set(sessionId, controller)

  // 会话绑定的记忆架构 → 记忆工具 + memoryFiles（toolContext）
  const memBind = await buildMemoryBinding(skillId, session)

  // 思考痕迹：本轮的工具调用记录，随回复消息持久化
  const trace = []

  try {
    const result = await chat.runChat({
      skillId,
      skillOverride: memBind.skillOverride,
      settings,
      model: session.model || undefined,
      userMessage: message,
      historyMessages: session.messages.slice(0, -1),
      session,
      signal: controller.signal,
      toolContext: { memoryFiles: memBind.memoryFiles, sessionId, skillId },
      onToken: ({ content }) => send('chat:token', { sessionId, content }),
      onTool: ({ name, args, result }) => {
        trace.push({ type: 'tool', name, args: typeof args === 'string' ? args : JSON.stringify(args), result: String(result).slice(0, 800) })
        send('chat:tool', { sessionId, name, args, result })
      },
      onStatus: ({ status }) => send('chat:status', { sessionId, status })
    })
    session.messages.push({ role: 'assistant', content: result.content, ts: Date.now(), trace })
    chat.getSessionStore().save(session)
    send('chat:done', { sessionId, content: result.content, toolRounds: result.toolRounds, trace })
    return { ok: true, sessionId }
  } catch (e) {
    if (e.name === 'AbortError' || controller.signal.aborted) {
      chat.getSessionStore().save(session)
      send('chat:done', { sessionId, content: '', aborted: true })
      return { ok: true, aborted: true }
    }
    send('chat:error', { sessionId, error: e.message || String(e) })
    throw e
  } finally {
    activeChats.delete(sessionId)
  }
}

// 会话以「智能体（Agent）」为目标：将用户消息灌入输入节点并流式回传
async function runAgentFor(sessionId, agentId, message) {
  const session = chat.getSessionStore().get(sessionId)
  if (!session) throw new Error('会话不存在')
  session.messages.push({ role: 'user', content: message, ts: Date.now() })
  chat.getSessionStore().save(session)
  mainWindow.webContents.send('chat:user', { sessionId, message })

  const ag = agentStore.get(agentId)
  if (!ag) throw new Error('智能体不存在')

  const controller = new AbortController()
  activeChats.set(sessionId, controller)
  const send = (channel, payload) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
  }
  // 会话/工作区绑定的记忆架构更新过 → 先整理再运行
  await maybeOrganizeBefore(session, send)

  // 所有 input 节点都注入用户消息作为输入
  const inputs = {}
  for (const n of ag.nodes || []) {
    if (n.type === 'input') inputs[n.id] = message
  }

  // 思考痕迹：节点执行进度
  const trace = []

  try {
    send('chat:status', { sessionId, status: `运行智能体「${ag.name}」…` })
    const res = await agent.runAgent({
      agent: ag,
      agentStore,
      settings,
      model: session.model || undefined,
      inputs,
      signal: controller.signal,
      auditDir: path.join(DATA_DIR, 'audit'),
      onToken: ({ content }) => send('chat:token', { sessionId, content }),
      onStatus: (p) => {
        if (p.nodeId) {
          trace.push({ type: 'node', nodeId: p.nodeId, status: p.status, error: p.error })
          send('chat:status', { sessionId, status: `节点 ${p.nodeId} · ${p.status === 'running' ? '执行中' : p.status === 'done' ? '完成' : p.status}` })
        }
      },
      onOutput: () => {}
    })
    session.messages.push({ role: 'assistant', content: res.result, ts: Date.now(), trace })
    chat.getSessionStore().save(session)
    send('chat:done', { sessionId, content: res.result, agent: true, trace })
    return { ok: true, sessionId }
  } catch (e) {
    if (e.name === 'AbortError' || controller.signal.aborted) {
      chat.getSessionStore().save(session)
      send('chat:done', { sessionId, content: '', aborted: true })
      return { ok: true, aborted: true }
    }
    send('chat:error', { sessionId, error: e.message || String(e) })
    throw e
  } finally {
    activeChats.delete(sessionId)
  }
}

// ---------------- IPC ----------------
function registerIpc() {
  ipcMain.handle('settings:get', () => settings)
  ipcMain.handle('settings:set', async (_e, patch) => {
    Object.assign(settings, patch)
    settingsStore.saveAll(settings)
    await restartApi()
    return settings
  })
  ipcMain.handle('settings:pick-wallpaper', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '选择壁纸图片',
      properties: ['openFile'],
      filters: [{ name: '图片', extensions: ['png', 'jpg', 'jpeg', 'webp', 'gif', 'bmp'] }]
    })
    if (r.canceled || !r.filePaths.length) return null
    return r.filePaths[0]
  })

  ipcMain.handle('skills:list', () => skills.list())
  ipcMain.handle('skills:run', async (_e, id, rel) => {
    const file = rel ? skills.resolveInSkill(id, rel) : skills.getSourceFile(id)
    if (!file || !fs.existsSync(file)) throw new Error('技能文件不存在')
    if (!String(file).endsWith('.py')) throw new Error('仅支持运行 Python 文件')
    return runPythonFile(file)
  })
  ipcMain.handle('skills:read', (_e, id) => {
    const file = skills.getSourceFile(id)
    if (!file) return null
    const fs = require('fs')
    return { content: fs.readFileSync(file, 'utf8'), file, kind: 'skill' }
  })
  ipcMain.handle('skills:write', async (_e, id, content) => {
    const file = skills.getSourceFile(id)
    if (!file) throw new Error('skill 文件不存在')
    require('fs').writeFileSync(file, content, 'utf8')
    await skills.reload()
    if (!skills.getSourceFile(id)) {
      throw new Error('代码已保存到磁盘，但存在语法错误导致无法加载。请修正代码后再次保存。')
    }
    return { ok: true }
  })

  // ---------------- 自定义模块（自定义节点类型，存 data/custom-nodes.json） ----------------
  const customNodesFile = path.join(DATA_DIR, 'custom-nodes.json')
  const loadCustomNodes = () => {
    try { return JSON.parse(fs.readFileSync(customNodesFile, 'utf8')) } catch { return [] }
  }
  const persistCustomNodes = (arr) => {
    fs.mkdirSync(DATA_DIR, { recursive: true })
    fs.writeFileSync(customNodesFile, JSON.stringify(arr, null, 2), 'utf8')
  }
  ipcMain.handle('custom-nodes:list', () => loadCustomNodes())
  ipcMain.handle('custom-nodes:save', (_e, item) => {
    const arr = loadCustomNodes()
    const i = arr.findIndex((x) => x.id === item.id)
    const rec = { id: item.id, name: item.name || '未命名模块', icon: item.icon || '🧩', code: item.code || '', desc: item.desc || '' }
    if (i >= 0) arr[i] = { ...arr[i], ...rec }
    else arr.push({ ...rec, createdAt: Date.now() })
    persistCustomNodes(arr)
    return arr
  })
  ipcMain.handle('custom-nodes:delete', (_e, id) => {
    const arr = loadCustomNodes().filter((x) => x.id !== id)
    persistCustomNodes(arr)
    return arr
  })

  // 分类文件夹管理（存 data/categories.json，不改 skill 代码文件）
  ipcMain.handle('skills:categories', () => skills.listCategories())
  ipcMain.handle('skills:add-category', (_e, name) => skills.addCategory(name))
  ipcMain.handle('skills:set-category', (_e, id, name) => skills.setCategory(id, name))
  ipcMain.handle('skills:remove-category', (_e, name) => skills.removeCategory(name))
  ipcMain.handle('toolpacks:remove-category', (_e, name) => skills.removeCategory(name))

  // ---------------- 工具包（内部工具，旧名 MCP） ----------------
  ipcMain.handle('toolpacks:list', () => toolPacks.list())
  ipcMain.handle('toolpacks:reload', () => toolPacks.reload())
  ipcMain.handle('toolpacks:read', (_e, id) => {
    const file = toolPacks.getSourceFile(id)
    if (!file) return null
    const fs = require('fs')
    return { content: fs.readFileSync(file, 'utf8'), file, kind: 'toolPack' }
  })
  ipcMain.handle('toolpacks:write', async (_e, id, content) => {
    const file = toolPacks.getSourceFile(id)
    if (!file) throw new Error('工具文件不存在')
    require('fs').writeFileSync(file, content, 'utf8')
    await toolPacks.reload()
    if (!toolPacks.getSourceFile(id)) {
      throw new Error('代码已保存到磁盘，但存在语法错误导致无法加载。请修正代码后再次保存。')
    }
    return { ok: true }
  })
  ipcMain.handle('toolpacks:create', async (_e, type) => {
    const fs = require('fs')
    const userDir = path.join(app.getPath('userData'), 'tool-packs')
    const isPy = type === 'py'
    const n = (await toolPacks.list()).toolPacks.length + 1
    const ext = isPy ? 'py' : 'js'
    const file = path.join(userDir, `custom${n}.tool.${ext}`)
    const template = isPy
      ? `# ============================================================
# 自定义 Python 工具包 ${n}
# 修改此文件即可客制化你的工具包，保存后在界面上点击"重载"生效。
# ============================================================
MCP_ID = "custom${n}"
MCP_NAME = "自定义 Python 工具包 ${n}"
MCP_DESC = "在这里描述这个工具包"

TOOLS = [
    {
        "name": "my_tool",
        "description": "在这里描述工具的作用",
        "parameters": {
            "type": "object",
            "properties": {
                "input": {"type": "string", "description": "参数说明"}
            },
            "required": ["input"]
        },
        "handler": "my_tool"
    }
]

def my_tool(args):
    # 在这里实现工具逻辑，返回字符串
    return "收到输入: " + str(args.get("input", ""))
`
      : `// ============================================================
// 自定义工具包 ${n}
// 修改此文件即可客制化你的工具包，保存后在界面上点击"重载"生效。
// ============================================================
module.exports = {
  id: 'custom${n}',
  name: '自定义工具包 ${n}',
  description: '在这里描述这个工具包',
  tools: [
    {
      name: 'my_tool',
      description: '在这里描述工具的作用',
      parameters: {
        type: 'object',
        properties: {
          input: { type: 'string', description: '参数说明' }
        },
        required: ['input']
      },
      handler: async (args) => {
        // 在这里实现工具逻辑，返回字符串或对象
        return '收到输入: ' + (args.input || '')
      }
    }
  ]
}
`
    fs.mkdirSync(userDir, { recursive: true })
    fs.writeFileSync(file, template, 'utf8')
    const r = await toolPacks.reload()
    return { ok: true, file, id: `custom${n}`, kind: isPy ? 'py' : 'js', toolPacks: r.toolPacks }
  })
  ipcMain.handle('toolpacks:delete', async (_e, id) => {
    const fs = require('fs')
    const file = toolPacks.getSourceFile(id)
    if (!file) throw new Error('工具文件不存在')
    fs.unlinkSync(file)
    const r = await toolPacks.reload()
    return { ok: true, toolPacks: r.toolPacks }
  })
  ipcMain.handle('toolpacks:delete-many', async (_e, ids) => {
    const fs = require('fs')
    for (const id of ids || []) {
      const file = toolPacks.getSourceFile(id)
      if (file) { try { fs.unlinkSync(file) } catch { /* 忽略 */ } }
    }
    const r = await toolPacks.reload()
    return { ok: true, toolPacks: r.toolPacks }
  })
  ipcMain.handle('toolpacks:read-file', (_e, file) => {
    const fs = require('fs')
    if (!file || !fs.existsSync(file)) return null
    return { content: fs.readFileSync(file, 'utf8'), file, kind: 'toolPack' }
  })
  // 工具分类（数据存 data/categories.json 的 toolPackMap 段，兼容旧 mcpMap）
  ipcMain.handle('toolpacks:categories', () => skills.listCategories())
  ipcMain.handle('toolpacks:add-category', (_e, name) => skills.addCategory(name))
  ipcMain.handle('toolpacks:set-category', (_e, id, name) => skills.setMcpCategory(id, name))
  ipcMain.handle('toolpacks:write-file', async (_e, file, content) => {
    const fs = require('fs')
    if (!file) throw new Error('文件路径无效')
    fs.writeFileSync(file, content, 'utf8')
    const r = await toolPacks.reload()
    if (!r.toolPacks.some((m) => m.file === file)) {
      throw new Error('代码已保存到磁盘，但存在语法错误导致无法加载。请修正代码后再次保存。')
    }
    return { ok: true, toolPacks: r.toolPacks }
  })
  // 工具「运行/调试」：执行某个已加载工具（按工具名），返回结果字符串
  ipcMain.handle('toolpacks:run-tool', async (_e, name, args) => {
    const value = await toolPacks.execTool(name, args || {})
    return { ok: true, value }
  })

  // ---------------- 外部 MCP（标准 MCP 协议，Harness 作为客户端接入） ----------------
  ipcMain.handle('extmcps:list', () => externalMcps.list())
  ipcMain.handle('extmcps:add', (_e, input) => externalMcps.add(input || {}))
  ipcMain.handle('extmcps:update', (_e, id, patch) => externalMcps.update(id, patch || {}))
  ipcMain.handle('extmcps:delete', (_e, id) => externalMcps.remove(id))
  ipcMain.handle('extmcps:reload', () => externalMcps.reload())
  ipcMain.handle('extmcps:set-category', (_e, id, category) => externalMcps.setCategory(id, category))
  ipcMain.handle('skills:create', async (_e, type) => {
    const fs = require('fs')
    const userDir = path.join(app.getPath('userData'), 'skills')
    const n = (await skills.list()).length + 1
    const isPy = type === 'py'
    const id = `custom${n}`
    const dir = path.join(userDir, id)
    const file = path.join(dir, `main.skill.${isPy ? 'py' : 'js'}`)
    const template = isPy
      ? `# ============================================================
# skill：自定义 Python skill ${n}
# 修改此文件即可客制化你的 skill，保存后在界面上点击"重载"生效。
# ============================================================
SKILL_ID = "custom${n}"
SKILL_NAME = "自定义 Python skill ${n}"
SKILL_DESC = "在这里描述你的 skill"
SKILL_AVATAR = "🐍"
SKILL_MODEL = None  # 留空使用全局默认模型
SKILL_TEMPERATURE = 0.7
SKILL_MAX_TOKENS = 4096

# 工具：内置 list_dir/read_file/write_file；工具包工具用 'tool:工具名' 引用（见"工具包"面板）
SKILL_TOOLS = ['list_dir', 'read_file', 'write_file']

# 提示词可以是固定字符串：
# SYSTEM_PROMPT = "你是 ..."

# 也可以是动态函数（推荐），ctx 含 workspaceName / workspaceRoot
def system_prompt(ctx):
    ws = ("当前工作区：" + ctx.get("workspaceName")) if ctx.get("workspaceName") else "当前未打开工作区"
    return "你是「LAG harness」中的一个 Python 自定义 skill。\\n\\n" + ws
`
      : `// ============================================================
// skill：自定义 skill ${n}
// 修改此文件即可客制化你的 skill，保存后在界面上点击"重载"生效。
// ============================================================
module.exports = {
  id: 'custom${n}',
  name: '自定义 skill ${n}',
  description: '在这里描述你的 skill',
  avatar: '✨',
  model: null, // 留空使用全局默认模型
  temperature: 0.7,
  maxTokens: 4096,
  // 工具：内置 list_dir/read_file/write_file；工具包工具用 'tool:工具名' 引用（见"工具包"面板）
  tools: ['list_dir', 'read_file', 'write_file'],
  systemPrompt: (ctx) => {
    const ws = ctx.workspaceName ? '当前工作区：' + ctx.workspaceName : '当前未打开工作区'
    return '你是「LAG harness」中的一个自定义 skill。\\n\\n' + ws
  }
}
`
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(file, template, 'utf8')
    fs.writeFileSync(path.join(dir, 'README.md'), `# ${id}\n\n在这里描述这个 skill 的用途与使用说明（文档）。\n`, 'utf8')
    await skills.reload()
    return { ok: true, dir, id, kind: isPy ? 'py' : 'js', skills: await skills.list() }
  })
  ipcMain.handle('skills:delete', async (_e, id) => {
    const fs = require('fs')
    const dir = skills.getSkillDir(id)
    if (!dir) throw new Error('skill 不存在')
    fs.rmSync(dir, { recursive: true, force: true })
    await skills.reload()
    return { ok: true, skills: await skills.list() }
  })
  ipcMain.handle('skills:delete-many', async (_e, ids) => {
    const fs = require('fs')
    for (const id of ids || []) {
      const dir = skills.getSkillDir(id)
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch { /* 忽略 */ } }
    }
    await skills.reload()
    return { ok: true, skills: await skills.list() }
  })
  // 技能目录文件管理（工作台：文档 + 组件多文件）
  ipcMain.handle('skills:files', (_e, id) => skills.listFiles(id))
  ipcMain.handle('skills:read-file', (_e, id, rel) => {
    return { content: skills.readFile(id, rel), file: rel, kind: 'skill' }
  })
  ipcMain.handle('skills:write-file', async (_e, id, rel, content) => {
    skills.writeFile(id, rel, content)
    const mainRel = String(rel || '').replace(/\\/g, '/')
    if (mainRel === 'main.skill.js' || mainRel === 'main.skill.py') {
      await skills.reload()
      if (!skills.getSourceFile(id)) {
        throw new Error('代码已保存到磁盘，但存在语法错误导致无法加载。请修正代码后再次保存。')
      }
    }
    return { ok: true, skills: await skills.list() }
  })
  ipcMain.handle('skills:create-file', (_e, id, rel, content) => skills.createFile(id, rel, content))
  ipcMain.handle('skills:delete-file', (_e, id, rel) => skills.deleteFile(id, rel))
  ipcMain.handle('skills:rename-file', (_e, id, oldRel, newRel) => skills.renameFile(id, oldRel, newRel))
  ipcMain.handle('skills:set-file-readable', (_e, id, rel, readable) => skills.setFileReadable(id, rel, !!readable))

  ipcMain.handle('sessions:list', () => chat.getSessionStore().list())
  ipcMain.handle('sessions:create', (_e, opts) => chat.getSessionStore().create(opts))
  ipcMain.handle('sessions:get', (_e, id) => chat.getSessionStore().get(id))
  ipcMain.handle('sessions:rename', (_e, id, title) => chat.getSessionStore().rename(id, title))
  ipcMain.handle('sessions:setTarget', (_e, id, targetType, targetId) => {
    return chat.getSessionStore().setTarget(id, targetType, targetId)
  })
  ipcMain.handle('sessions:setModel', (_e, id, model) => {
    return chat.getSessionStore().setModel(id, model)
  })
  // 会话绑定工作区（sandbox）：会话可自由选择使用哪个工作区
  ipcMain.handle('sessions:set-sandbox', (_e, id, sandboxId) => {
    return chat.getSessionStore().setSandbox(id, sandboxId)
  })
  // 会话级记忆绑定（优先于工作区绑定）；绑定即克隆独立记忆副本（迷你沙盒）
  ipcMain.handle('sessions:set-memory-arch', (_e, id, archName) => {
    const s = chat.getSessionStore().get(id)
    if (!s) return null
    s.memoryArch = archName || null
    s.boundAt = archName ? Date.now() : null
    s.lastArchMtime = archName ? memory.archMtime(archName) : null
    chat.getSessionStore().save(s)
    if (archName) {
      try { memory.cloneForSession(archName, id) } catch (e) { /* 克隆失败不阻断绑定 */ }
    } else {
      memory.removeSessionCopy(id)
    }
    return s
  })
  ipcMain.handle('sessions:delete', (_e, id) => {
    chat.getSessionStore().remove(id)
    memory.removeSessionCopy(id)
    return { ok: true }
  })

  ipcMain.handle('chat:send', (_e, { skillId, sessionId, message, targetType, targetId }) => {
    if (targetType === 'agent' && targetId) {
      return runAgentFor(sessionId, targetId, message)
    }
    return runChatFor(skillId, sessionId, message)
  })
  ipcMain.handle('chat:stop', (_e, sessionId) => {
    const c = activeChats.get(sessionId)
    if (c) c.abort()
    return { ok: true }
  })

  ipcMain.handle('workspace:get', () => workspace.info())
  ipcMain.handle('workspace:read', (_e, rel) => ({ content: workspace.readFile(rel) }))
  ipcMain.handle('workspace:write', (_e, rel, content) => workspace.writeFile(rel, content))
  ipcMain.handle('workspace:mkdir', (_e, rel) => workspace.mkdir(rel))
  ipcMain.handle('workspace:rename', (_e, oldRel, newRel) => workspace.rename(oldRel, newRel))
  ipcMain.handle('workspace:delete', (_e, rel) => workspace.removeFile(rel))
  ipcMain.handle('workspace:open-file', (_e, rel) => {
    shell.openPath(path.join(workspace.getRoot(), rel))
    return { ok: true }
  })
  // ---- 多 sandbox 工作区 ----
  ipcMain.handle('workspace:sandboxes', () => workspace.listSandboxes())
  ipcMain.handle('workspace:sandbox-create', async () => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '新建工作区（选择文件夹）',
      properties: ['openDirectory', 'createDirectory']
    })
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
    const sb = workspace.createSandbox(r.filePaths[0])
    return { ok: true, sandbox: sb }
  })
  ipcMain.handle('workspace:sandbox-select', (_e, id) => {
    const sb = workspace.selectSandbox(id)
    return { ok: true, sandbox: sb }
  })
  ipcMain.handle('workspace:sandbox-delete', (_e, id) => workspace.deleteSandbox(id))
  ipcMain.handle('workspace:sandbox-set-session', (_e, id, sessionId) => workspace.setSandboxSession(id, sessionId))
  ipcMain.handle('workspace:sandbox-set-memory-arch', (_e, id, archName) => {
    const m = archName ? memory.archMtime(archName) : null
    return workspace.setSandboxMemoryArch(id, archName, m)
  })
  // 工作区对话栏状态持久化：模型/目标类型/目标 切走再回来保持一致
  ipcMain.handle('workspace:sandbox-set-chat', (_e, id, patch) => workspace.setSandboxChat(id, patch))
  ipcMain.handle('workspace:sandbox-set-root', async (_e, id) => {
    const r = await dialog.showOpenDialog(mainWindow, {
      title: '切换当前工作区文件夹',
      properties: ['openDirectory', 'createDirectory']
    })
    if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
    const sb = workspace.setSandboxRoot(id, r.filePaths[0])
    return { ok: true, sandbox: sb }
  })

  // ---------------- 智能体（Agent） ----------------
  ipcMain.handle('agents:list', () => agentStore.list())
  ipcMain.handle('agents:create', () => agentStore.create())
  ipcMain.handle('agents:get', (_e, id) => agentStore.get(id))
  ipcMain.handle('agents:save', (_e, ag) => {
    const saved = agentStore.save(ag)
    return { ok: true, agents: agentStore.list(), agent: saved }
  })
  ipcMain.handle('agents:delete', (_e, id) => {
    agentStore.remove(id)
    return { ok: true }
  })
  ipcMain.handle('agents:categories', () => agentStore.listCategories())
  ipcMain.handle('agents:add-category', (_e, name) => agentStore.addCategory(name))
  ipcMain.handle('agents:set-category', (_e, id, name) => agentStore.setCategory(id, name))
  ipcMain.handle('agents:remove-category', (_e, name) => agentStore.removeCategory(name))

  // ---------------- 智能体定义（「智能体」栏：单智能体 = 模型/提示词/技能） ----------------
  ipcMain.handle('agdefs:list', () => defStore.list())
  ipcMain.handle('agdefs:create', () => defStore.create())
  ipcMain.handle('agdefs:get', (_e, id) => defStore.get(id))
  ipcMain.handle('agdefs:save', (_e, def) => {
    const saved = defStore.save(def)
    return { ok: true, list: defStore.list(), def: saved }
  })
  ipcMain.handle('agdefs:delete', (_e, id) => {
    defStore.remove(id)
    return { ok: true }
  })
  ipcMain.handle('agdefs:categories', () => defStore.listCategories())
  ipcMain.handle('agdefs:add-category', (_e, name) => defStore.addCategory(name))
  ipcMain.handle('agdefs:set-category', (_e, id, name) => defStore.setCategory(id, name))
  ipcMain.handle('agdefs:remove-category', (_e, name) => defStore.removeCategory(name))
  // 智能体文件工作台：agent.json 主定义 + 自由辅助文件（多文件编辑，与技能/记忆一致）
  ipcMain.handle('agdefs:files', (_e, id) => defStore.listFiles(id))
  ipcMain.handle('agdefs:read-file', (_e, id, rel) => {
    return { content: defStore.readFile(id, rel), file: rel, kind: 'agdef' }
  })
  ipcMain.handle('agdefs:write-file', (_e, id, rel, content) => defStore.writeFile(id, rel, content))
  ipcMain.handle('agdefs:create-file', (_e, id, rel, content) => defStore.createFile(id, rel, content))
  ipcMain.handle('agdefs:delete-file', (_e, id, rel) => defStore.deleteFile(id, rel))
  ipcMain.handle('agdefs:rename-file', (_e, id, oldRel, newRel) => defStore.renameFile(id, oldRel, newRel))
  ipcMain.handle('agent:run', (_e, id, inputs) => {
    const ag = agentStore.get(id)
    if (!ag) throw new Error('智能体不存在')
    const controller = new AbortController()
    const runId = 'ag-' + Date.now().toString(36)
    activeWorkflowRuns.set(runId, controller)
    const send = (channel, payload) => {
      if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send(channel, payload)
    }
    ;(async () => {
      try {
        const res = await agent.runAgent({
      agent: ag,
      agentStore,
      settings,
      inputs: inputs || {},
      signal: controller.signal,
      auditDir: path.join(DATA_DIR, 'audit'),
      onStatus: (p) => send('agent:status', p),
      onOutput: (p) => send('agent:output', p)
    })
        send('agent:done', { runId, ok: true, result: res.result, outputs: res.outputs })
      } catch (e) {
        send('agent:done', { runId, ok: false, error: e.message || String(e) })
      } finally {
        activeWorkflowRuns.delete(runId)
      }
    })()
    return { runId }
  })
  ipcMain.handle('agent:stop', (_e, runId) => {
    if (runId === '*') {
      for (const c of activeWorkflowRuns.values()) c.abort()
      activeWorkflowRuns.clear()
    } else {
      const c = activeWorkflowRuns.get(runId)
      if (c) c.abort()
    }
    return { ok: true }
  })

  // ---------------- 导出（大型 Agent 生成器 LAG） ----------------
  ipcMain.handle('exporter:run', async (_e, opts) => {
    const ag = agentStore.get(opts && (opts.agentId || opts.workflowId))
    if (!ag) throw new Error('智能体不存在')
    let outDir = opts.outDir
    if (!outDir) {
      const r = await dialog.showOpenDialog(mainWindow, {
        title: '选择导出目录（大型 Agent 包将生成到该目录的子文件夹）',
        buttonLabel: '选择目录',
        properties: ['openDirectory', 'createDirectory']
      })
      if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true }
      outDir = r.filePaths[0]
    }
    const result = await exporter.exportAgent({
      agent: ag,
      store: agentStore,
      name: (opts.name || '').trim() || ag.name,
      description: (opts.description || '').trim(),
      outDir,
      port: opts.port || 37800,
      target: opts.target || 'all'
    })
    return result
  })

  // 把已导出的 LA 包打包为单文件 exe（PyInstaller）
  ipcMain.handle('exporter:build-exe', async (_e, opts) => {
    if (!opts || !opts.outDir) throw new Error('缺少导出包目录')
    return await exporter.buildExe({ outDir: opts.outDir, name: opts.name })
  })

  // ---------------- 协议（智能体节点可链接协议） ----------------
  ipcMain.handle('protocols:list', () => protocols.list())
  ipcMain.handle('protocols:create', (_e, name) => protocols.create(name))
  ipcMain.handle('protocols:read', (_e, name) => protocols.get(name))
  ipcMain.handle('protocols:write', (_e, name, content) => protocols.write(name, content))
  ipcMain.handle('protocols:delete', (_e, name) => protocols.remove(name))
  ipcMain.handle('protocols:categories', () => protocols.listCategories())
  ipcMain.handle('protocols:add-category', (_e, name) => protocols.addCategory(name))
  ipcMain.handle('protocols:set-category', (_e, protoName, name) => protocols.setCategory(protoName, name))
  ipcMain.handle('protocols:remove-category', (_e, name) => protocols.removeCategory(name))
  // 协议「运行」：用 Python 执行 .protocol.py，验证语法并回传解析出的配置（调试用）
  ipcMain.handle('protocols:run', (_e, name) => {
    const p = protocols.get(name)
    if (!p || !p.file) throw new Error('协议文件不存在')
    const fs = require('fs')
    return runPythonFile(p.file).then((r) => ({ ...r, meta: protocols.parseMeta(name, fs.readFileSync(p.file, 'utf8')) }))
  })
  ipcMain.handle('memory:list', () => memory.list())
  ipcMain.handle('memory:create', (_e, name, content) => memory.create(name, content))
  ipcMain.handle('memory:delete', (_e, name) => memory.delete(name))
  ipcMain.handle('memory:categories', () => memory.listCategories())
  ipcMain.handle('memory:add-category', (_e, name) => memory.addCategory(name))
  ipcMain.handle('memory:set-category', (_e, memName, name) => memory.setCategory(memName, name))
  ipcMain.handle('memory:remove-category', (_e, name) => memory.removeCategory(name))
  // 记忆工作台：架构内文件自由编辑 + 手动整理
  ipcMain.handle('memory:run', async (_e, name, rel) => {
    const p = memory.resolveInArch(name, rel)
    if (!p || !fs.existsSync(p)) throw new Error('记忆文件不存在')
    if (!String(rel).endsWith('.py')) throw new Error('仅支持运行 Python 文件')
    return runPythonFile(p)
  })
  ipcMain.handle('memory:files', (_e, name) => memory.listFiles(name))
  ipcMain.handle('memory:read-file', (_e, name, rel) => memory.readFileAny(name, rel))
  ipcMain.handle('memory:write-file', (_e, name, rel, content) => memory.writeFileAny(name, rel, content))
  ipcMain.handle('memory:create-file', (_e, name, rel, content) => memory.createFile(name, rel, content))
  ipcMain.handle('memory:delete-file', (_e, name, rel) => memory.deleteFile(name, rel))
  ipcMain.handle('memory:rename-file', (_e, name, oldRel, newRel) => memory.renameFile(name, oldRel, newRel))
  ipcMain.handle('memory:set-protected', (_e, name, rel, on) => memory.setProtected(name, rel, on))
  ipcMain.handle('memory:organize', async (_e, name) => {
    return await memory.runOrganize(name, { settings, agentStore })
  })
  ipcMain.handle('memory:extract', async (_e, name, text) => {
    return await memory.runExtract(name, text, { settings })
  })
  ipcMain.handle('memory:reset-ledger', (_e, name) => memory.resetLedger(name))

  // ---------------- 内置终端（pip install 供智能体/工作流/工作区 import） ----------------
  // 作用域：'python'（全局 Python，PATH 前置 runtime python，pip 安装到该解释器）/'workspace'（沙箱根目录 shell）
  terminal.setOnOutput((text) => {
    if (mainWindow && !mainWindow.isDestroyed()) mainWindow.webContents.send('terminal:output', { text })
  })
  ipcMain.handle('terminal:start', (_e, opts) => {
    let cwd = opts && opts.cwd
    if (!cwd) {
      try {
        const wi = workspace.info()
        if (wi && wi.root) cwd = wi.root
      } catch { /* 忽略 */ }
    }
    return terminal.start({ scope: opts && opts.scope, cwd })
  })
  ipcMain.handle('terminal:send', (_e, text) => terminal.send(text))
  ipcMain.handle('terminal:stop', () => terminal.stop())
  ipcMain.handle('terminal:status', () => terminal.status())

  // 工具数据源：内置工具 + 全部 MCP 工具（供工作流节点"链接工具"选择）
  ipcMain.handle('tools:list', () => {
    const llm = require('./llm')
    const builtin = llm.TOOL_SCHEMAS.map((s) => ({ name: s.function.name, description: s.function.description, parameters: s.function.parameters || null }))
    builtin.push({
      name: 'run_agent',
      description: '运行一个已保存的智能体（多 skill 编排流水线），返回其最终输出文本。',
      parameters: llm.RUN_AGENT_SCHEMA && llm.RUN_AGENT_SCHEMA.function.parameters || null
    })
    return { builtin, toolPacks: toolPacks.allTools().map((t) => ({ name: t.name, description: t.description || '', packId: t.packId, parameters: t.parameters || null })), external: externalMcps.allTools().map((t) => ({ name: t.name, description: t.description || '', packId: t.packId, parameters: t.parameters || null })) }
  })

  ipcMain.handle('api:status', () => apiServer.status())
  ipcMain.handle('api:toggle', async () => {
    settings.enableApiServer = !settings.enableApiServer
    settingsStore.saveAll(settings)
    await restartApi()
    return apiServer.status()
  })

  // ---------------- 团队（WiFi 团队开发） ----------------
  ipcMain.handle('team:status', () => ({
    ...apiServer.status(),
    lanIps: team.lanIps(),
    teamName: team.getState().name,
    teamEnabled: !!settings.teamEnabled
  }))
  ipcMain.handle('team:start', async () => {
    settings.teamEnabled = true
    settingsStore.saveAll(settings)
    await restartApi()
    return { ...apiServer.status(), lanIps: team.lanIps() }
  })
  ipcMain.handle('team:stop', async () => {
    settings.teamEnabled = false
    settingsStore.saveAll(settings)
    await restartApi()
    return { ...apiServer.status(), lanIps: team.lanIps() }
  })
  ipcMain.handle('team:set-name', (e, name) => {
    const clean = team.setName(name)
    settings.teamName = clean
    settingsStore.saveAll(settings)
    return clean
  })
  ipcMain.handle('team:state', () => team.getState())
  ipcMain.handle('team:assets', async () => apiServer.teamAssets())
  ipcMain.handle('team:download', (_e, kind, name) => {
    const content = apiServer.teamDownload(kind, name)
    if (content == null) return { ok: false, error: '资产不存在' }
    const clean = String(name || '').replace(/[\\/:*?"<>|]/g, '_')
    return { ok: true, name: clean, content }
  })
  ipcMain.handle('team:post', async (e, text) => {
    const t = String(text || '').trim()
    if (!t) return { ok: false, error: '消息不能为空' }
    const name = settings.teamNickname || '主机'
    const msg = team.postText(t, name)
    if (/^@ai\s/i.test(t)) team.runAi(t, { settings }).catch(() => {})
    return { ok: true, msg }
  })
}

async function restartApi() {
  if (settings.enableApiServer === false) {
    apiServer.stop()
    return { running: false }
  }
  try {
    return await apiServer.start({ getSettings: () => settings, team, agentStore, userDataDir: app.getPath('userData'), agent, defStore, toolPacks, memory, runPythonFile, auditDir: path.join(DATA_DIR, 'audit') })
  } catch (e) {
    console.warn('[api]', e.message)
    return { running: false, error: e.message }
  }
}

// ---------------- 生命周期 ----------------
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  app.quit()
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })

  app.whenReady().then(async () => {
    settingsStore = store.createSettingsStore(app.getPath('userData'))
    settings = settingsStore.getAll()
    if (!settings.baseUrl) settings.baseUrl = 'https://api.deepseek.com/v1'
    if (!settings.model) settings.model = 'deepseek-v4-pro'
    if (!settings.enableApiServer) settings.enableApiServer = true
    if (settings.teamEnabled === undefined) settings.teamEnabled = false

    // 多 sandbox 工作区：恢复上次选中的工作区；旧版本 settings.workspaceRoot 迁移为第一个 sandbox
    workspace.initSandboxes(app.getPath('userData'))
    const sbx = workspace.listSandboxes()
    if (sbx.active) {
      try { workspace.selectSandbox(sbx.active) } catch (e) {
        console.warn('[workspace] 上次的工作区路径无效，已忽略:', e.message)
      }
    } else if (settings.workspaceRoot) {
      try { workspace.createSandbox(settings.workspaceRoot) } catch (e) {
        console.warn('[workspace] 上次的工作区路径无效，已忽略:', e.message)
      }
    }

    chat.initSessionStore(app.getPath('userData'))
    migrateData(app.getPath('userData'))
    agentStore = agent.createAgentStore(app.getPath('userData'))
    // 智能体定义（data/agent-defs）：「智能体」栏数据；挂到 agentStore 上供运行时子智能体节点回退解析
    defStore = agent.createAgentDefStore(app.getPath('userData'))
    agentStore.getDef = (id) => defStore.get(id)
    skills.init({
      builtin: builtinSkillsDir(),
      user: path.join(app.getPath('userData'), 'skills')
    })
    protocols.init(app.getPath('userData'))
    memory.init(app.getPath('userData'))
    team.init(app.getPath('userData'))
    if (settings.teamName) team.setName(settings.teamName)
    tools.registerAgentRuntime({ agentStore, getSettings: () => settings })
    // P4-1 工具执行管道：统一审计消费者（所有工具调用写 data/audit/tools.jsonl）
    tools.installAudit(path.join(DATA_DIR, 'audit'))
    toolPacks.init({
      builtin: builtinToolPacksDir(),
      user: path.join(app.getPath('userData'), 'tool-packs')
    })
    // 外部 MCP 客户端（标准 MCP 协议）：启动时连接已启用的外部 MCP Server
    externalMcps.init()

    // 启动诊断：把本实例实际加载的工具写到 data/diag-toolpacks.json（排查"工具缺失"用）
    setTimeout(async () => {
      try {
        const r = await toolPacks.list()
        fs.writeFileSync(path.join(DATA_DIR, 'diag-toolpacks.json'), JSON.stringify({
          ts: Date.now(),
          exe: process.execPath,
          userData: app.getPath('userData'),
          builtin: builtinToolPacksDir(),
          pyLoadError: r.pyLoadError || null,
          python: r.python,
          packs: r.toolPacks.map((m) => `${m.id}(${m.kind}:${(m.tools || []).length})`)
        }, null, 2), 'utf8')
      } catch { /* 诊断失败忽略 */ }
    }, 4000)

    registerIpc()
    createWindow()
    await restartApi()
    // 外部 MCP 自举连接（如指向本机 37800 端口）：等 API Server 就绪后重连一次
    try { await externalMcps.reload() } catch { /* 重连失败不阻塞 */ }

    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow()
    })
  })

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit()
  })

  app.on('before-quit', () => {
    apiServer.stop()
    externalMcps.stopAll()
  })
}
