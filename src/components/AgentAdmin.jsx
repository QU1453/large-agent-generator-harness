import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js'
import { h, fmtTime } from '../lib/harness.js'
import CategoryModal from './CategoryModal.jsx'

// 按扩展名推断高亮语言（与技能/记忆工作台一致）
function langOf(p) {
  const e = String(p || '').toLowerCase().split('.').pop() || ''
  const map = {
    py: 'python', js: 'javascript', mjs: 'javascript', jsx: 'javascript', cjs: 'javascript',
    ts: 'typescript', tsx: 'typescript', json: 'json', md: 'markdown',
    c: 'c', h: 'c', cpp: 'cpp', cc: 'cpp', hpp: 'cpp',
    html: 'xml', htm: 'xml', css: 'css', sh: 'bash', bat: 'dos', ps1: 'powershell',
    yml: 'yaml', yaml: 'yaml', toml: 'ini', ini: 'ini', sql: 'sql', go: 'go', rs: 'rust', java: 'java'
  }
  return map[e] || 'plaintext'
}

// 智能体栏：单智能体管理 = 模型配置（继承/自定义）+ 提示词 + 技能列表
// 与「工作流」的区别：智能体是独立可复用的个体，工作流是画布编排多个智能体/技能协作。
// 工作流里的「子智能体」节点可直接引用这里的智能体（运行时自动转最小图执行）。
export default function AgentAdmin({ skills = [], onToast }) {
  const [defs, setDefs] = useState([])
  const [cats, setCats] = useState({ list: [], map: {} })
  const [q, setQ] = useState('')
  const [cardMenu, setCardMenu] = useState(null)
  const [catModal, setCatModal] = useState(false)
  const [wb, setWb] = useState(null) // 文件工作台 {id, name}

  const refresh = useCallback(async () => {
    setDefs(await h.agdefs.list())
  }, [])

  useEffect(() => {
    ;(async () => {
      const [l, c] = await Promise.all([h.agdefs.list(), h.agdefs.categories()])
      setDefs(l)
      setCats(c)
    })()
  }, [])

  const createNew = async () => {
    const d = await h.agdefs.create()
    await refresh()
    setWb({ id: d.id, name: d.name })
  }

  const saveNewCategory = async (name) => {
    setCats(await h.agdefs.addCategory(name))
    onToast?.(`分类「${name}」已创建`, 'success')
  }

  const changeCategory = async (d, name) => {
    try {
      setCats(await h.agdefs.setCategory(d.id, name))
      await refresh()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const deleteCategory = async (cat) => {
    if (!confirm(`删除分类文件夹「${cat}」？\n归到该分类的智能体会移回「未分类」，智能体本身不会被删除。`)) return
    try {
      setCats(await h.agdefs.removeCategory(cat))
      await refresh()
      onToast?.(`分类「${cat}」已删除`, 'success')
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const doDelete = async (d) => {
    if (!confirm(`删除智能体「${d.name}」？\n工作流中引用它的子智能体节点将失效。`)) return
    try {
      await h.agdefs.delete(d.id)
      await refresh()
      onToast?.(`智能体「${d.name}」已删除`, 'success')
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const openWb = (d) => {
    setWb({ id: d.id, name: d.name || d.id })
  }

  const kw = q.trim().toLowerCase()
  const filtered = defs.filter((d) => !kw || `${d.name || ''} ${d.id || ''} ${d.description || ''} ${d.category || ''}`.toLowerCase().includes(kw))
  const map = new Map()
  for (const d of filtered) {
    const cat = d.category || '未分类'
    if (!map.has(cat)) map.set(cat, [])
    map.get(cat).push(d)
  }
  for (const c of cats.list) if (!map.has(c)) map.set(c, [])
  const groups = [...map.entries()].map(([cat, list]) => ({ cat, list }))

  const modelLabel = (d) => (d.model && d.model.inherit === false ? '⚙ 自定义模型' : '◈ 继承上游')

  return (
    <div className="panel">
      {wb ? (
        <AgentWorkbench id={wb.id} name={wb.name} onToast={onToast} onBack={() => setWb(null)} onSaved={refresh} />
      ) : (
      <>
      <div className="panel-header">
        <div>
          <h2>智能体</h2>
          <p className="panel-sub">
            单个智能体 = 模型配置（继承上游或自定义）+ 提示词 + 技能列表。
            工作流画布里的「子智能体」节点可直接引用这里的智能体
          </p>
        </div>
        <div className="panel-actions">
          <button className="btn" onClick={createNew}>＋ 新建智能体</button>
          <button className="btn" onClick={() => setCatModal(true)} title="创建分类文件夹，把智能体归类">📁 新建分类</button>
          <button className="btn ghost" onClick={refresh}>↻ 刷新</button>
        </div>
      </div>

      {defs.length > 0 && (
        <div className="bulk-bar">
          <input className="input search-input" placeholder="🔍 搜索智能体（名称 / ID / 描述 / 分类）…" value={q} onChange={(e) => setQ(e.target.value)} />
          <span className="bulk-count">{defs.length} 个智能体</span>
        </div>
      )}

      {defs.length === 0 && (
        <div className="workspace-empty">
          <div className="empty-icon">🤖</div>
          <p>还没有智能体</p>
          <button className="btn" onClick={createNew}>创建第一个智能体</button>
        </div>
      )}

      {groups.map(({ cat, list }) => (
        <div key={cat} className="agent-group">
          <div className="agent-group-title">
            <span className="agent-group-name">{cat}</span>
            <span className="agent-group-count">{list.length}</span>
            {cat !== '未分类' && (
              <button className="mini-btn danger cat-del" title="删除该分类文件夹（智能体移回未分类）" onClick={() => deleteCategory(cat)}>🗑</button>
            )}
          </div>
          <div className="skill-list">
            {list.map((d) => (
              <div
                key={d.id}
                className="skill-card"
                onClick={() => openWb(d)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCardMenu({ d, x: e.clientX, y: e.clientY }) }}
                title="点击进入文件编辑（agent.json 主定义 + 辅助文件）"
              >
                <div className="skill-card-head">
                  <span className="skill-card-title">🤖 {d.name}</span>
                  <div className="session-actions">
                    <select
                      className="skill-cat-select"
                      title="智能体分类文件夹"
                      value={d.category || '未分类'}
                      onChange={(e) => { const v = e.target.value; if (v === '__new__') setCatModal(true); else changeCategory(d, v) }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {['未分类', ...cats.list.filter((c) => c !== '未分类')].map((c) => <option key={c} value={c}>{c}</option>)}
                      <option value="__new__">＋ 新建分类…</option>
                    </select>
                    <button className="mini-btn danger" title="删除" onClick={(e) => { e.stopPropagation(); doDelete(d) }}>🗑</button>
                  </div>
                </div>
                <div className="skill-card-meta">
                  <code>{d.id}</code> · {modelLabel(d)} · {d.skillCount || 0} 个技能 · 更新于 {fmtTime(d.updatedAt)}
                </div>
                {d.description && <div className="skill-card-path">{d.description}</div>}
              </div>
            ))}
          </div>
        </div>
      ))}

      {cardMenu && (
        <div className="mem-ctx-overlay" onClick={() => setCardMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCardMenu(null) }}>
          <div className="mem-ctx" style={{ left: cardMenu.x, top: cardMenu.y }}>
            <div className="mem-ctx-title">🤖 {cardMenu.d.name}</div>
            <button className="mem-ctx-item" onClick={() => { const d = cardMenu.d; setCardMenu(null); openWb(d) }}>✏ 进入文件编辑</button>
            <button className="mem-ctx-item danger" onClick={() => { const d = cardMenu.d; setCardMenu(null); doDelete(d) }}>🗑 删除智能体</button>
            <button className="mem-ctx-item" onClick={() => setCardMenu(null)}>取消</button>
          </div>
        </div>
      )}

      {/* 编辑弹窗：模型（继承/自定义）+ 提示词 + 技能（已被文件工作台取代） */}

      <CategoryModal
        open={catModal}
        title="新建分类文件夹"
        placeholder="如：客服 / 数据分析"
        onCreate={async (name) => { await saveNewCategory(name); setCatModal(false) }}
        onClose={() => setCatModal(false)}
      />
      </>
      )}
    </div>
  )
}

// ---------------- 智能体工作台（文件编辑：agent.json 主定义 + 辅助文件） ----------------
// 智能体本身是多文件结构：主定义文件 agent.json（模型/提示词/技能列表）+ 可自由添加辅助文件（说明文档/代码片段）。
// 卡片点开进入此工作台：左文件树 / 中编辑器（语法高亮）/ 右信息面板，与技能/记忆编辑方式一致。
function AgentWorkbench({ id, name, onBack, onToast, onSaved }) {
  const [files, setFiles] = useState([])
  const [activeRel, setActiveRel] = useState(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [noteName, setNoteName] = useState('')
  const [noteBox, setNoteBox] = useState(false)
  const [renameBox, setRenameBox] = useState(null) // 文件重命名弹窗 {f, value}
  const [ctx, setCtx] = useState(null) // 文件树右键 {f, x, y}

  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  const loadFiles = useCallback(async () => {
    const fs_ = await h.agdefs.files(id)
    setFiles(fs_ || [])
    return fs_ || []
  }, [id])

  // 打开工作台：加载文件树，自动打开主定义文件 agent.json
  useEffect(() => {
    ;(async () => {
      setLoading(true)
      try {
        const fs_ = await loadFiles()
        const main = fs_.find((f) => f.main) || fs_[0]
        if (main) {
          const d = await h.agdefs.readFile(id, main.rel)
          setActiveRel(main.rel)
          setDraft(d.content)
          setDirty(false)
        }
      } catch (e) {
        onToast?.(e.message || String(e), 'error')
      } finally {
        setLoading(false)
      }
    })()
    return () => {}
  }, [id, loadFiles, onToast])

  const openFile = async (rel) => {
    if (rel === activeRel) return
    if (dirtyRef.current && !confirm('当前文件有未保存的修改，切换将丢失。继续？')) return
    setLoading(true)
    try {
      const c = await h.agdefs.readFile(id, rel)
      setActiveRel(rel)
      setDraft(c.content)
      setDirty(false)
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    } finally {
      setLoading(false)
    }
  }

  const doSave = async () => {
    if (!activeRel || !dirty || saving) return
    setSaving(true)
    try {
      await h.agdefs.writeFile(id, activeRel, draft)
      setDirty(false)
      onToast?.(`已保存 ${activeRel}`, 'success')
      const fs_ = await loadFiles()
      const cur = fs_.find((f) => f.rel === activeRel)
      if (cur) onSaved && onSaved()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const saveRef = useRef(doSave)
  saveRef.current = doSave
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); saveRef.current() }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const createNote = async () => {
    const n = noteName.trim()
    if (!n) { onToast?.('文件名不能为空', 'error'); return }
    const base = n.split('/').pop()
    const rel = /\.\w+$/.test(base) ? n : `${n}.md`
    try {
      const r = await h.agdefs.createFile(id, rel)
      onToast?.(`已创建 ${r.rel}`, 'success')
      setNoteBox(false)
      setNoteName('')
      setActiveRel(r.rel)
      setDraft(await (await h.agdefs.readFile(id, r.rel)).content)
      setDirty(false)
      await loadFiles()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const deleteFile = async (f) => {
    if (!f) return
    if (f.main) { onToast?.('主定义文件 agent.json 不可删除', 'error'); return }
    if (!confirm(`删除 ${f.rel}？`)) return
    try {
      await h.agdefs.deleteFile(id, f.rel)
      onToast?.(`已删除 ${f.rel}`, 'success')
      if (activeRel === f.rel) { setActiveRel(null); setDraft(''); setDirty(false) }
      await loadFiles()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  // 重命名文件：主定义文件不可改名；无扩展名自动补 .md；改名后若正打开则跟随
  const doRename = async () => {
    if (!renameBox) return
    const f = renameBox.f
    const nv = (renameBox.value || '').trim()
    if (!nv) { onToast?.('新文件名不能为空', 'error'); return }
    try {
      const r = await h.agdefs.renameFile(id, f.rel, nv)
      onToast?.(`已重命名 ${f.rel} → ${r.rel}`, 'success')
      setRenameBox(null)
      if (activeRel === f.rel) {
        setActiveRel(r.rel)
        setDraft(await (await h.agdefs.readFile(id, r.rel)).content)
      }
      await loadFiles()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const fileIcon = (f) => (f.kind === 'py' ? '🐍' : f.kind === 'js' ? '⚡' : f.kind === 'json' ? '⚙' : '📄')

  // 语法高亮：按当前文件扩展名推断语言，渲染为 hljs span（与 textarea 透明文字叠加）
  const lang = langOf(activeRel)
  const highlighted = useMemo(() => {
    const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    try {
      return hljs.highlight(draft, { language: lang }).value
    } catch {
      return escapeHtml(draft)
    }
  }, [draft, lang])

  return (
    <div className="panel mem-wb">
      <div className="mem-wb-topbar">
        <button className="btn ghost" onClick={onBack}>← 返回</button>
        <span className="mem-wb-title">🤖 {name || id}</span>
        <span className="mem-wb-sub"><code>{id}</code></span>
        <div className="mem-wb-actions">
          <button className="btn" onClick={() => setNoteBox(true)} title="智能体是多文件结构：agent.json 主定义 + 可自由添加辅助文件">＋ 文件</button>
        </div>
      </div>

      <div className="mem-wb-body">
        <div className="mem-wb-tree">
          <div className="mem-wb-tree-title">文件</div>
          <div className="mem-wb-tree-scroll" onContextMenu={(e) => {
            if (!e.target.closest('.mem-tree-item')) {
              e.preventDefault(); e.stopPropagation(); setCtx(null); setNoteBox(true)
            }
          }}>
            {files.length === 0 && <div className="mem-tree-empty">暂无文件（右键空白处或点「＋ 文件」创建）</div>}
            {files.map((f) => (
              <div key={f.rel} className={`mem-tree-item${f.rel === activeRel ? ' active' : ''}`}>
                <button
                  className="mem-tree-btn"
                  onClick={() => openFile(f.rel)}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCtx({ f, x: e.clientX, y: e.clientY }) }}
                  title={f.rel}
                >
                  <span className="mem-tree-icon">{fileIcon(f)}</span>
                  <span className="mem-tree-name">{f.rel}</span>
                  {f.main && <span className="mem-tree-ro">主</span>}
                </button>
                <button
                  className="mem-tree-del"
                  disabled={f.main}
                  title={f.main ? '主定义文件 agent.json 不可删除' : '删除文件'}
                  onClick={() => deleteFile(f)}
                >🗑</button>
              </div>
            ))}
          </div>
          <div className="mem-wb-tree-foot">
            <button className="btn ghost" onClick={() => setNoteBox(true)}>＋ 新建文件</button>
          </div>
        </div>

        <div className="mem-wb-splitter" title="左侧为文件树，中间为编辑器" />

        <div className="mem-wb-editor">
          <div className="mem-wb-editor-head">
            <code className="mem-editor-file">{activeRel || '未选择文件'}</code>
            {dirty && <span className="editor-dirty">● 未保存</span>}
            {loading && <span className="mem-loading">加载中…</span>}
          </div>
          <div className="mem-wb-editor-wrap">
            {activeRel ? (
              <div className="code-editor native mem-code-editor">
                <pre
                  className="code-highlight"
                  aria-hidden="true"
                  dangerouslySetInnerHTML={{ __html: highlighted + '\n' }}
                />
                <textarea
                  className="code-input"
                  value={draft}
                  spellCheck={false}
                  autoCapitalize="off" autoComplete="off" autoCorrect="off"
                  placeholder="文件内容…（Ctrl+S 保存）"
                  onChange={(e) => { setDraft(e.target.value); setDirty(true) }}
                />
              </div>
            ) : (
              <div className="mem-wb-empty">选择左侧文件开始编辑，或点「＋ 文件」新建</div>
            )}
          </div>
        </div>

        <div className="mem-wb-props">
          <div className="mem-wb-props-title">信息</div>
          <div className="mem-props-item"><span className="mem-props-label">名称</span><code>{name || id}</code></div>
          <div className="mem-props-item"><span className="mem-props-label">ID</span><code>{id}</code></div>
          <div className="mem-props-item"><span className="mem-props-label">文件数</span><span className="mem-props-val">{files.length}</span></div>
          <div className="mem-props-hint">
            智能体是<b>多文件结构</b>：<code>agent.json</code> 是主定义文件
            （模型配置 / 提示词 / 技能列表），可自由新建辅助
            <code>*.md</code> / <code>*.py</code> / <code>*.js</code> / <code>*.json</code> 组件。
            保存 agent.json 后自动生效。
          </div>
        </div>
      </div>

      {noteBox && (
        <div className="modal-overlay" onClick={() => setNoteBox(false)}>
          <div className="modal small" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>新建智能体文件</h2>
              <button className="icon-btn" onClick={() => setNoteBox(false)}>✕</button>
            </div>
            <div className="modal-body">
              <label className="field">
                <span className="field-label">文件名（自由命名，可带子目录；无扩展名默认 .md）</span>
                <input className="input" autoFocus value={noteName} placeholder="如: notes/使用说明 或 helper.py" onChange={(e) => setNoteName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') createNote() }} />
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn ghost" onClick={() => setNoteBox(false)}>取消</button>
              <button className="btn primary" onClick={createNote}>创建</button>
            </div>
          </div>
        </div>
      )}

      {renameBox && (
        <div className="modal-overlay" onClick={() => setRenameBox(null)}>
          <div className="modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>✏ 重命名 · {renameBox.f.rel}</h2>
              <button className="icon-btn" onClick={() => setRenameBox(null)}>✕</button>
            </div>
            <div className="modal-body">
              <label className="field">
                <span className="field-label">新文件名</span>
                <input className="input" autoFocus value={renameBox.value} placeholder="如: notes/使用说明 或 helper.py" onChange={(e) => setRenameBox((r) => r && { ...r, value: e.target.value })} onKeyDown={(e) => { if (e.key === 'Enter') doRename() }} />
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn ghost" onClick={() => setRenameBox(null)}>取消</button>
              <button className="btn primary" onClick={doRename}>重命名</button>
            </div>
          </div>
        </div>
      )}

      {ctx && (
        <div
          className="mem-ctx-overlay"
          onClick={() => setCtx(null)}
          onContextMenu={(e) => { e.preventDefault(); setCtx(null) }}
        >
          <div className="mem-ctx" style={{ left: ctx.x, top: ctx.y }}>
            <div className="mem-ctx-title">📄 {ctx.f.rel}</div>
            <button className="mem-ctx-item" onClick={() => { const f = ctx.f; setCtx(null); setRenameBox({ f, value: f.rel }) }} disabled={ctx.f.main} title={ctx.f.main ? '主定义文件不可重命名' : '重命名此文件'}>✏ 重命名</button>
            <button className="mem-ctx-item danger" onClick={() => { const f = ctx.f; setCtx(null); deleteFile(f) }} disabled={ctx.f.main} title={ctx.f.main ? '主定义文件不可删除' : '删除此文件'}>🗑 删除</button>
            <button className="mem-ctx-item" onClick={() => setCtx(null)}>取消</button>
          </div>
        </div>
      )}
    </div>
  )
}
