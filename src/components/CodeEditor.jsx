import { useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js'
import { h } from '../lib/harness.js'

const LANGS = {
  skill: 'javascript',
  toolPack: 'javascript'
}

const LABELS = {
  skill: { icon: '🤖', name: '技能' },
  toolPack: { icon: '🔧', name: '工具' }
}

// 内置代码编辑器：应用内直接编辑智能体 / 工具源码，保存后自动重载
// 支持两种定位方式：id（已加载列表中的智能体/工具）或 file（文件路径，用于新建后立即打开）
//
// 实现说明：使用原生 <textarea> + 高亮层（pre）叠加渲染，替代第三方编辑器组件。
// textarea 为「非受控」组件（不设 value prop，值经 ref 同步）——受控组件在 IME
// 组合输入期间会被 React 用旧值回写 DOM，导致中文无法输入/选区替换失效；非受控则
// 完全由浏览器管理选区与组合状态，任何位置的 IME 输入都正常。
export default function CodeEditor({ kind, id, file, onClose, onSaved }) {
  const [code, setCode] = useState('')
  const [filePath, setFilePath] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const taRef = useRef(null) // textarea 为非受控，文件加载后经 ref 一次性写入

  // 工具「运行 & 调试」：可逐个测试工具包内的工具
  const [running, setRunning] = useState(false)
  const [runOut, setRunOut] = useState(null) // {ok, ...} 运行输出
  const [testOpen, setTestOpen] = useState(false)
  const [mcpTools, setMcpTools] = useState([]) // 当前工具包的工具（含 parameters）
  const [selTool, setSelTool] = useState('')
  const [argsText, setArgsText] = useState('{}')

  // 加载文件：state 用于高亮层，textarea 本体经 ref 写入（非受控，不打断 IME）
  useEffect(() => {
    ;(async () => {
      try {
        const api = kind === 'skill' ? h.skills : h.toolPacks
        const data = file ? await api.readFile(file) : await api.read(id)
        if (!data) throw new Error('文件不存在')
        setCode(data.content)
        setFilePath(data.file)
        if (taRef.current) taRef.current.value = data.content
        setError(null)
      } catch (e) {
        setError(e.message)
      }
    })()
  }, [kind, id, file])

  // 语言推断：按扩展名识别 py/c/cpp/js/ts/json/md 等；无扩展名回落到 kind 映射
  const inferLang = (fp, k) => {
    const ext = (String(fp || '').toLowerCase().split('.').pop() || '')
    const map = {
      py: 'python', c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', cxx: 'cpp', hpp: 'cpp',
      js: 'javascript', mjs: 'javascript', jsx: 'javascript', cjs: 'javascript',
      ts: 'typescript', tsx: 'typescript',
      json: 'json', md: 'markdown', html: 'xml', htm: 'xml', css: 'css',
      sh: 'bash', bat: 'dos', ps1: 'powershell', yml: 'yaml', yaml: 'yaml',
      toml: 'ini', ini: 'ini', sql: 'sql', go: 'go', rs: 'rust', java: 'java',
      skill: 'javascript', tool: 'javascript'
    }
    if (map[ext]) return map[ext]
    if (/^[\w-]+$/.test(ext) && ext.length <= 12) return map[ext] || 'plaintext'
    return LANGS[k] || 'javascript'
  }
  const lang = inferLang(filePath, kind)

  // 高亮层：把代码渲染为带 <span class="hljs-*"> 的 HTML（与 textarea 透明文字叠加）
  const highlighted = useMemo(() => {
    const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    try {
      return hljs.highlight(code, { language: lang }).value
    } catch {
      return escapeHtml(code)
    }
  }, [code, lang])

  // 输入处理：无条件同步（含 IME 组合输入）。textarea 非受控，React 不会回写 DOM，
  // 因此组合输入、选区替换均按浏览器原生行为进行，state 只镜像 DOM 值供高亮层使用。
  const handleChange = (e) => {
    setCode(e.target.value)
    setDirty(true)
  }

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const api = kind === 'skill' ? h.skills : h.toolPacks
      const r = file ? await api.writeFile(file, code) : await api.write(id, code)
      if (!r || (r.ok === false)) throw new Error('保存失败')
      setDirty(false)
      onSaved && onSaved()
    } catch (e) {
      setError(e.message)
    } finally {
      setSaving(false)
    }
  }

  const onKeyDown = (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
      e.preventDefault()
      if (dirty) save()
    }
  }

  // ---- 工具「运行 & 调试」 ----
  const loadMcpTools = async () => {
    try {
      const t = await h.tools.list()
      const list = (t.toolPacks || []).filter((x) => x.packId === id)
      setMcpTools(list)
      if (list.length && !selTool) setSelTool(list[0].name)
      if (!list.length) setRunOut({ ok: false, error: '该工具包当前没有可测试的工具（保存重载后再试）' })
    } catch (e) {
      setRunOut({ ok: false, error: e.message || String(e) })
    }
  }

  const runTool = async () => {
    if (!selTool) { setRunOut({ ok: false, error: '请先选择一个工具' }); return }
    let args = {}
    try { args = JSON.parse(argsText || '{}') } catch { setRunOut({ ok: false, error: '参数 JSON 无效' }); return }
    setRunning(true); setRunOut(null)
    try {
      if (dirty) await save()
      setRunOut({ ok: true, value: await h.toolPacks.runTool(selTool, args) })
    } catch (e) {
      setRunOut({ ok: false, error: e.message || String(e) })
    } finally {
      setRunning(false)
    }
  }

  const formatRunOut = (r) => {
    if (!r) return ''
    if (r.ok === false) return `❌ 失败：${r.error || r.stderr || '未知错误'}`
    return `✅ 执行结果：\n${r.value ?? ''}`
  }

  const lineCount = code.split('\n').length
  const label = LABELS[kind] || LABELS.skill

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal editor-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="editor-title">
            <span className="editor-kind">{label.icon} {label.name}</span>
            <code className="editor-file">{filePath.split(/[\\/]/).pop()}</code>
            {dirty && <span className="editor-dirty">● 未保存</span>}
          </div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        {error ? (
          <div className="editor-error">⚠️ {error}</div>
        ) : (
          <div className="editor-wrap" onKeyDown={onKeyDown}>
            <div className="editor-gutter-lang">{LANGS[kind] || 'js'}</div>
            <div className="code-editor native">
              <pre
                className="code-highlight"
                aria-hidden="true"
                dangerouslySetInnerHTML={{ __html: highlighted + '\n' }}
              />
              <textarea
                id="code-editor-textarea"
                ref={taRef}
                className="code-input"
                defaultValue=""
                onChange={handleChange}
                spellCheck={false}
                autoCapitalize="off"
                autoComplete="off"
                autoCorrect="off"
                data-gramm={false}
                placeholder="输入代码…"
              />
            </div>
          </div>
        )}

        {kind === 'toolPack' && (
          <div className="editor-run">
            <div className="editor-run-bar">
              <button className="btn small" onClick={() => { const next = !testOpen; setTestOpen(next); if (next) loadMcpTools() }}>
                🧪 {testOpen ? '收起工具测试' : '测试工具'}
              </button>
            </div>

            {kind === 'toolPack' && testOpen && (
              <div className="editor-test">
                <select className="input editor-test-sel" value={selTool} onChange={(e) => setSelTool(e.target.value)}>
                  {mcpTools.length === 0 && <option value="">（无工具）</option>}
                  {mcpTools.map((t) => <option key={t.name} value={t.name}>{t.name}</option>)}
                </select>
                <textarea
                  className="input editor-test-args"
                  value={argsText}
                  onChange={(e) => setArgsText(e.target.value)}
                  placeholder='{"input": "hello"}'
                  spellCheck={false}
                />
                <button className="btn small primary" disabled={running} onClick={runTool}>
                  {running ? '执行中…' : '执行'}
                </button>
              </div>
            )}

            {runOut && <pre className="editor-run-out">{formatRunOut(runOut)}</pre>}
          </div>
        )}

        <div className="editor-footer">
          <span className="editor-info">
            {lineCount} 行 · Ctrl+S 保存
          </span>
          <div className="editor-actions">
            <button className="btn ghost" onClick={onClose}>取消</button>
            <button className={`btn primary ${dirty ? '' : 'disabled'}`} onClick={save} disabled={!dirty || saving}>
              {saving ? '保存中…' : '保存并重载'}
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}
