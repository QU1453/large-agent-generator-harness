// Python 引擎：常驻 Python 子进程，通过 NDJSON(stdin/stdout) 提供 MCP 工具
// 一个进程加载全部 .py MCP 文件，支持工具注册、调用、心跳、优雅关闭
const { spawn, execFile } = require('child_process')
const path = require('path')

// Python 侧引导代码：加载模块、注册工具、循环处理请求
const BOOTSTRAP = `
import json, sys, os, importlib.util, traceback

def load_module(fpath):
    name = os.path.splitext(os.path.basename(fpath))[0]
    spec = importlib.util.spec_from_file_location(name, fpath)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

def main():
    files = [f for f in (sys.argv[1].split(os.pathsep) if len(sys.argv) > 1 else []) if f]
    modules = []
    toolmap = {}
    mods = {}
    for f in files:
        try:
            mod = load_module(f)
            modname = os.path.splitext(os.path.basename(f))[0]
            mods[modname] = mod
            mid = getattr(mod, 'MCP_ID', None) or getattr(mod, 'id', None) or modname
            mname = getattr(mod, 'MCP_NAME', None) or getattr(mod, 'name', None) or mid
            mdesc = getattr(mod, 'MCP_DESC', None) or getattr(mod, 'description', None) or ''
            mtools = []
            for t in getattr(mod, 'TOOLS', []):
                hname = t.get('handler') or t['name']
                fn = getattr(mod, hname, None)
                if fn is None:
                    fn = (getattr(mod, 'handlers', {}) or {}).get(hname)
                if fn is None:
                    raise ValueError('handler not found: ' + hname)
                t = dict(t)
                t.pop('handler', None)
                mtools.append(t)
                toolmap[t['name']] = (mod, fn)
            def collect_meta(m):
                meta = {}
                for k in dir(m):
                    if k.isupper():
                        v = getattr(m, k)
                        if v is None or isinstance(v, (str, int, float, bool, list, dict)):
                            meta[k] = v
                return meta
            modules.append({'id': mid, 'name': mname, 'description': mdesc, 'file': f, 'tools': mtools, 'meta': collect_meta(mod), 'module': modname})
        except Exception as e:
            sys.stderr.write('LOAD_ERROR %s: %s\\n' % (f, traceback.format_exc()))
            sys.stderr.flush()
    def emit(obj):
        sys.stdout.write(json.dumps(obj, ensure_ascii=False, default=str) + '\\n')
        sys.stdout.flush()
    emit({'type': 'ready', 'modules': modules})
    for line in sys.stdin:
        try:
            req = json.loads(line)
            t = req.get('type')
            if t == 'ping':
                emit({'type': 'pong'})
            elif t == 'exec':
                rid = req.get('id')
                name = req.get('tool')
                mod, fn = toolmap.get(name, (None, None))
                if fn is None:
                    emit({'type': 'result', 'id': rid, 'ok': False, 'error': 'tool not found: ' + str(name)})
                else:
                    res = fn(req.get('args') or {})
                    if not isinstance(res, str):
                        res = json.dumps(res, ensure_ascii=False, default=str)
                    emit({'type': 'result', 'id': rid, 'ok': True, 'value': res})
            elif t == 'call':
                rid = req.get('id')
                modname = req.get('module')
                fnname = req.get('fn')
                mod = mods.get(modname)
                if mod is None:
                    emit({'type': 'result', 'id': rid, 'ok': False, 'error': 'module not found: ' + str(modname)})
                else:
                    fn = getattr(mod, fnname, None)
                    if fn is None:
                        emit({'type': 'result', 'id': rid, 'ok': False, 'error': 'fn not found: ' + str(fnname)})
                    else:
                        try:
                            a = req.get('args') or {}
                            res = fn(a) if isinstance(a, dict) else fn()
                            if not isinstance(res, str):
                                res = json.dumps(res, ensure_ascii=False, default=str)
                            emit({'type': 'result', 'id': rid, 'ok': True, 'value': res})
                        except Exception:
                            emit({'type': 'result', 'id': rid, 'ok': False, 'error': traceback.format_exc()})
            elif t == 'shutdown':
                break
        except Exception:
            emit({'type': 'result', 'id': req.get('id'), 'ok': False, 'error': traceback.format_exc()})

main()
`

// 优先使用项目绑定的嵌入式 Python（runtime/python），其次 AIH_PYTHON 环境变量，最后系统 Python
function embeddedPythonPath() {
  const candidates = []
  // 打包后：resources/python-runtime/python.exe
  if (process.resourcesPath) {
    candidates.push(path.join(process.resourcesPath, 'python-runtime', 'python.exe'))
  }
  // 开发时：<项目根>/runtime/python/python.exe
  try {
    const { app } = require('electron')
    candidates.push(path.join(app.getAppPath(), '..', 'runtime', 'python', 'python.exe'))
  } catch { /* 非 Electron 环境 */ }
  candidates.push(path.join(__dirname, '..', 'runtime', 'python', 'python.exe'))
  return candidates
}

const PYTHON_BINS = process.env.AIH_PYTHON
  ? [process.env.AIH_PYTHON]
  : [...embeddedPythonPath(), 'python', 'python3']
let pythonBin = null
let pythonVersion = null

// 检测可用 Python 解释器（带版本缓存）
function checkPython() {
  if (pythonBin) return { available: true, bin: pythonBin, version: pythonVersion }
  for (const bin of PYTHON_BINS) {
    try {
      const out = execFileSyncSafe(bin, ['-c', 'import sys; print(sys.version.split()[0])'])
      if (out !== null) {
        pythonBin = bin
        pythonVersion = out.trim()
        return { available: true, bin, version: pythonVersion }
      }
    } catch { /* 尝试下一个 */ }
  }
  return { available: false }
}

function execFileSyncSafe(bin, args) {
  try {
    const { execFileSync } = require('child_process')
    return execFileSync(bin, args, { timeout: 8000, encoding: 'utf8', windowsHide: true })
  } catch {
    return null
  }
}

class PythonEngine {
  constructor(files) {
    this.files = files
    this.proc = null
    this.modules = []
    this.pending = new Map()
    this.ready = null // Promise
    this.dead = false
    this.nextId = 1
  }

  // 启动/复用进程
  ensure() {
    if (this.proc && this.proc.exitCode === null) return this.ready
    this.dead = false
    const bin = checkPython()
    if (!bin.available) {
      this.ready = Promise.reject(new Error('未检测到 Python，请先安装 Python 并加入 PATH'))
      return this.ready
    }
    this.pending = new Map()
    this.ready = new Promise((resolve, reject) => {
      let settled = false
      this._readyResolve = resolve
      this._readyReject = reject
      this.proc = spawn(bin.bin, ['-u', '-c', BOOTSTRAP, this.files.join(path.delimiter)], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
      this.proc.stdout.setEncoding('utf8')
      this.proc.on('error', (e) => {
        if (!settled) { settled = true; this.dead = true; reject(new Error('Python 启动失败: ' + e.message)) }
      })
      this.proc.on('exit', (code) => {
        this.dead = true
        this._failAll('Python 进程已退出 (code=' + code + ')')
        if (!settled) { settled = true; reject(new Error('Python 进程提前退出 (code=' + code + ')')) }
      })
      this.proc.stdout.on('data', (chunk) => this._onData(chunk))
      this.proc.stderr.on('data', (chunk) => {
        const s = String(chunk)
        if (s.includes('LOAD_ERROR')) process.stderr.write('[python] ' + s)
      })
    })
    return this.ready
  }

  _onData(chunk) {
    this._buf = (this._buf || '') + chunk
    const lines = this._buf.split('\n')
    this._buf = lines.pop()
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const msg = JSON.parse(line)
        if (msg.type === 'ready') {
          this.modules = msg.modules || []
          this._readyResolve && this._readyResolve(this.modules)
        } else if (msg.type === 'result') {
          const p = this.pending.get(msg.id)
          if (p) {
            this.pending.delete(msg.id)
            if (msg.ok) p.resolve(msg.value)
            else p.reject(new Error(msg.error || 'Python 工具执行失败'))
          }
        }
      } catch { /* 忽略非 JSON 行 */ }
    }
  }

  _failAll(err) {
    for (const [, p] of this.pending) p.reject(new Error(err))
    this.pending.clear()
  }

  _send(obj) {
    this.proc.stdin.write(JSON.stringify(obj) + '\n')
  }

  async listTools() {
    const modules = await this.ensure()
    return modules
  }

  async execTool(name, args) {
    await this.ensure()
    if (this.dead) throw new Error('Python 引擎不可用')
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Python 工具超时（>15s）: ${name}`))
      }, 15000)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })
      this._send({ type: 'exec', id, tool: name, args })
    })
  }

  // 调用已加载模块的任意函数（用于 Python 智能体的 system_prompt 等）
  async callModule(module, fn, args) {
    await this.ensure()
    if (this.dead) throw new Error('Python 引擎不可用')
    const id = this.nextId++
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`Python 调用超时（>30s）: ${module}.${fn}`))
      }, 30000)
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v) },
        reject: (e) => { clearTimeout(timer); reject(e) }
      })
      this._send({ type: 'call', id, module, fn, args: args || {} })
    })
  }

  stop() {
    if (this.proc && this.proc.exitCode === null) {
      try {
        this._send({ type: 'shutdown' })
        setTimeout(() => { try { this.proc.kill() } catch { /* 忽略 */ } }, 500)
      } catch { /* 忽略 */ }
    }
  }
}

module.exports = { PythonEngine, checkPython }
