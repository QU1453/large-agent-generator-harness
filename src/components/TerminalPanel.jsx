import { useCallback, useEffect, useRef, useState } from 'react'
import { h } from '../lib/harness.js'
import InputGrip from './InputGrip.jsx'

// 内置终端：给智能体/工作流/工作区安装 Python 依赖（pip install 供 import）
// 作用域切换：全局 Python（PATH 前置 runtime python）/ 工作区（沙箱根目录 shell）
// 危险命令黑名单在 main 进程拦截；输出流式回显
export default function TerminalPanel({ workspace, onToast }) {
  const [scope, setScope] = useState('python') // python | workspace
  const [running, setRunning] = useState(false)
  const [busy, setBusy] = useState(false)
  const [lines, setLines] = useState([])
  const [cmd, setCmd] = useState('')
  const outRef = useRef(null)
  const inputRef = useRef(null)

  // 输出流式追加（保留最近 4000 行）
  useEffect(() => {
    const un = h.terminal.onOutput(({ text }) => {
      setLines((ls) => {
        const next = [...ls, String(text || '')]
        return next.length > 4000 ? next.slice(next.length - 4000) : next
      })
    })
    h.terminal.status().then((s) => setRunning(!!s.running)).catch(() => {})
    return un
  }, [])

  // 自动滚到底
  useEffect(() => {
    const el = outRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [lines])

  const start = useCallback(async (s) => {
    if (busy) return
    setBusy(true)
    try {
      const r = await h.terminal.start({ scope: s || scope, cwd: workspace && workspace.root })
      if (r && r.ok) {
        setRunning(true)
        setLines((ls) => [...ls, `\n═══ ${r.scope === 'workspace' ? '工作区' : '全局 Python'} 终端启动（cwd: ${r.cwd}）═══\n`])
      } else {
        onToast?.((r && r.error) || '启动失败', 'error')
        setLines((ls) => [...ls, `\n❌ ${(r && r.error) || '启动失败'}\n`])
      }
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    } finally {
      setBusy(false)
      inputRef.current && inputRef.current.focus()
    }
  }, [busy, scope, workspace, onToast])

  const stop = useCallback(async () => {
    try {
      await h.terminal.stop()
      setRunning(false)
      setLines((ls) => [...ls, '\n═══ 终端已停止 ═══\n'])
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }, [onToast])

  const send = useCallback(async (text) => {
    const c = String(text || '').trim()
    if (!c || busy) return
    setLines((ls) => [...ls, `\n❯ ${c}\n`])
    setCmd('')
    setBusy(true)
    try {
      const r = await h.terminal.send(c)
      if (r && r.blocked) {
        setLines((ls) => [...ls, `⚠️ 已拦截危险命令（黑名单）\n`])
        onToast?.('危险命令已被拦截', 'error')
      } else if (r && r.error) {
        setLines((ls) => [...ls, `❌ ${r.error}\n`])
      }
    } catch (e) {
      setLines((ls) => [...ls, `❌ ${e.message}\n`])
    } finally {
      setBusy(false)
    }
  }, [busy, onToast])

  const quickPip = useCallback(async (pkg) => {
    if (!running) {
      const r = await h.terminal.start({ scope: 'python', cwd: workspace && workspace.root })
      if (!r || !r.ok) { onToast?.('请先启动 Python 终端', 'error'); return }
      setRunning(true)
    }
    await send(`python -m pip install ${pkg}`)
  }, [running, workspace, onToast, send])

  return (
    <div className="panel terminal-panel">
      <div className="panel-header">
        <div>
          <h2>终端</h2>
          <p className="panel-sub">
            给智能体 / 工作流 / 工作区安装 Python 依赖：<code>pip install 包名</code>（或 <code>python -m pip install 包名</code>）。
            危险命令（rm -rf / format / shutdown 等）会被黑名单拦截；支持任意 shell 命令。
          </p>
        </div>
        <div className="panel-actions terminal-actions">
          <div className="terminal-scopes">
            <button
              className={`btn small${scope === 'python' ? ' primary' : ' ghost'}`}
              title="PATH 前置 runtime python，pip 安装到该解释器"
              onClick={() => { setScope('python'); if (running) start('python') }}
            >🐍 全局 Python</button>
            <button
              className={`btn small${scope === 'workspace' ? ' primary' : ' ghost'}`}
              title="在工作区根目录打开 shell"
              onClick={() => { setScope('workspace'); if (running) start('workspace') }}
            >📁 工作区</button>
          </div>
          {running ? (
            <button className="btn danger" onClick={stop}>⏹ 停止</button>
          ) : (
            <button className="btn primary" disabled={busy} onClick={() => start()}>{busy ? '启动中…' : '▶ 启动'}</button>
          )}
          <button className="btn ghost" onClick={() => setLines([])} title="清空输出">🗑 清空</button>
        </div>
      </div>

      <div className="terminal-body">
        <div className="terminal-out" ref={outRef}>
          {lines.length === 0 && (
            <div className="terminal-empty">
              启动终端后即可输入命令。<br />
              常用：<code>pip install numpy</code> · <code>pip install requests</code> · <code>pip list</code> · <code>python -c "import numpy"</code>
            </div>
          )}
          <pre className="terminal-text">{lines.join('')}</pre>
        </div>

        <div className="terminal-quick">
          <span className="terminal-quick-label">快速安装：</span>
          {['numpy', 'requests', 'pandas', 'openai'].map((p) => (
            <button key={p} className="mini-btn" title={`pip install ${p}`} onClick={() => quickPip(p)}>{p}</button>
          ))}
        </div>

        <div className="terminal-input-row">
          <span className="terminal-prompt">{running ? '❯' : '○'}</span>
          <div className="terminal-input-col">
            <InputGrip maxH={160} minH={20} />
            <textarea
              ref={inputRef}
              className="terminal-input"
              placeholder={running ? '输入命令…（Enter 执行；pip install xxx 安装依赖）' : '先点击「▶ 启动」'}
              value={cmd}
              disabled={!running}
              spellCheck={false}
              rows={1}
              onChange={(e) => setCmd(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) send(cmd)
              }}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
