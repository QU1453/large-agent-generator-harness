// 内置终端：给智能体/工作流/工作区安装 Python 依赖（pip install 供 import）
// 作用域：
//   python    全局 Python（runtime/python 或系统 python），cwd=工作区根目录（若存在）否则项目根，PATH 前置 python 目录
//   workspace 工作区根目录 shell（cwd=沙箱根目录）
// 安全：危险命令黑名单拦截（rm -rf / format / shutdown / diskpart 等），流式输出回调。
const { spawn } = require('child_process')
const path = require('path')

let proc = null
let scope = 'python'
let startCwd = null
let onOutput = null

// 危险命令黑名单（正则，命中即拦截并提示）
const DANGEROUS = [
  /^\s*(rm|del|rmdir|rd)\s+.*(-rf|-recurse|\/s|\/q)/i,
  /^\s*format\b/i,
  /^\s*(shutdown|reboot|restart-computer|stop-computer)\b/i,
  /^\s*diskpart\b/i,
  /^\s*cipher\b/i,
  /^\s*reg\s+delete\b/i,
  /^\s*Remove-Item\b/i,
  /^\s*del\s+\/f/i,
  /^\s*format\s+[a-zA-Z]:/i
]

function pythonCandidates() {
  const out = []
  if (process.resourcesPath) out.push(path.join(process.resourcesPath, 'python-runtime', 'python.exe'))
  try {
    const { app } = require('electron')
    out.push(path.join(app.getAppPath(), '..', 'runtime', 'python', 'python.exe'))
  } catch { /* 非 Electron 环境 */ }
  out.push(path.join(__dirname, '..', 'runtime', 'python', 'python.exe'))
  return out
}

function resolvePython() {
  const bins = process.env.AIH_PYTHON ? [process.env.AIH_PYTHON] : [...pythonCandidates(), 'python', 'python3']
  for (const b of bins) {
    try {
      require('child_process').execFileSync(b, ['-c', 'import sys; print(sys.version.split()[0])'], { timeout: 8000, stdio: 'ignore', windowsHide: true })
      return b
    } catch { /* 下一个 */ }
  }
  return null
}

function emit(text) {
  if (onOutput) {
    try { onOutput(String(text)) } catch { /* 忽略 */ }
  }
}

function start(opts = {}) {
  if (proc) return { ok: false, error: '终端已在运行（可先停止）', running: true }
  scope = opts.scope === 'workspace' ? 'workspace' : 'python'
  startCwd = opts.cwd || null
  const env = { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' }
  let cwd = null

  if (scope === 'workspace') {
    cwd = startCwd && require('fs').existsSync(startCwd) ? startCwd : process.cwd()
  } else {
    // python 作用域：找 python 目录前置到 PATH（pip/python 可直接用）
    const py = resolvePython()
    if (!py) return { ok: false, error: '未检测到 Python（runtime/python 或 PATH 中无 python）' }
    const pyDir = path.dirname(py)
    env.PATH = pyDir + path.delimiter + (env.PATH || '')
    // cwd：工作区根目录优先，其次项目根
    const root = startCwd && require('fs').existsSync(startCwd) ? startCwd : process.cwd()
    cwd = root
    emit(`[终端] 全局 Python 模式 · ${py}\n[终端] cwd: ${cwd}（pip install 安装到该解释器）\n`)
  }

  try {
    // Windows: cmd.exe；其他平台: /bin/sh
    const shell = process.platform === 'win32' ? 'cmd.exe' : '/bin/sh'
    const shellArgs = process.platform === 'win32' ? [] : ['-i']
    proc = spawn(shell, shellArgs, {
      cwd,
      env,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe']
    })
  } catch (e) {
    proc = null
    return { ok: false, error: `启动失败: ${e.message}` }
  }

  proc.stdout.setEncoding('utf8')
  proc.stderr.setEncoding('utf8')
  proc.stdout.on('data', (d) => emit(d))
  proc.stderr.on('data', (d) => emit(d))
  proc.on('exit', (code) => {
    emit(`\n[终端] 进程已退出（code=${code}）\n`)
    proc = null
  })
  proc.on('error', (e) => {
    emit(`\n[终端] 错误: ${e.message}\n`)
    proc = null
  })
  if (process.platform === 'win32') {
    // 让 cmd 输出 UTF-8，避免中文乱码
    try { proc.stdin.write('chcp 65001 >nul\r\n') } catch { /* 忽略 */ }
  }
  emit(`[终端] ${scope === 'workspace' ? '工作区' : 'Python'} 终端已启动（输入 exit 退出）\n`)
  return { ok: true, scope, cwd }
}

function send(text) {
  if (!proc) return { ok: false, error: '终端未运行，请先启动' }
  const cmd = String(text || '').trim()
  if (!cmd) return { ok: true }
  for (const re of DANGEROUS) {
    if (re.test(cmd)) {
      emit(`\n⚠️ 已拦截危险命令（黑名单）: ${cmd}\n`)
      return { ok: false, blocked: true, reason: re.toString() }
    }
  }
  try {
    proc.stdin.write(cmd + '\r\n')
    return { ok: true }
  } catch (e) {
    return { ok: false, error: e.message }
  }
}

function stop() {
  if (!proc) return { ok: false, error: '终端未运行' }
  try {
    proc.stdin.write('exit\r\n')
    setTimeout(() => { try { if (proc) proc.kill() } catch { /* 忽略 */ } }, 300)
  } catch (e) {
    try { proc.kill() } catch { /* 忽略 */ }
  }
  proc = null
  emit('\n[终端] 已停止\n')
  return { ok: true }
}

function status() {
  return { running: !!proc, scope, cwd: startCwd }
}

function setOnOutput(fn) {
  onOutput = fn
}

module.exports = { start, send, stop, status, setOnOutput }
