import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { h, fmtTime } from '../lib/harness.js'
import CategoryModal from './CategoryModal.jsx'

// 技能管理：技能 = 一个「技能目录」（文档 + 组件，多为 Python/JS）。
// 列表页（技能卡片）→ 打开工作台：左文件树 / 中编辑器（Ctrl+S 保存）/ 右信息面板。
// 主组件 main.skill.js / main.skill.py 不可删；其余文档（README.md）与辅助组件自由增删。
export default function SkillPanel({ skills, onToast, onChanged }) {
  const [selected, setSelected] = useState(new Set())
  const [cats, setCats] = useState({ list: [], map: {} })
  const [catModal, setCatModal] = useState(null) // null | {targetSkillId?: string}
  const [q, setQ] = useState('')
  const [wb, setWb] = useState(null) // null | {id, skill}
  const [cardMenu, setCardMenu] = useState(null) // {skill, x, y}

  const refresh = useCallback(async () => {
    onChanged && (await onChanged())
  }, [onChanged])

  useEffect(() => {
    h.skills.categories().then(setCats).catch(() => {})
  }, [])

  const saveNewCategory = async (name) => {
    const c = await h.skills.addCategory(name)
    setCats(c)
    if (catModal && catModal.targetSkillId) {
      await h.skills.setCategory(catModal.targetSkillId, name)
      setCats(await h.skills.categories())
      await refresh()
    }
    if (onToast) onToast(`分类「${name}」已创建`, 'success')
  }

  const changeCategory = async (skill, name) => {
    try {
      await h.skills.setCategory(skill.id, name)
      setCats(await h.skills.categories())
      await refresh()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const deleteCategory = async (cat) => {
    if (!confirm(`删除分类文件夹「${cat}」？\n归到该分类的技能会移回「未分类」，技能本身不会被删除。`)) return
    try {
      setCats(await h.skills.removeCategory(cat))
      await refresh()
      if (onToast) onToast(`分类「${cat}」已删除`, 'success')
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const doCreate = async (type) => {
    try {
      const r = await h.skills.create(type || 'js')
      await refresh()
      setWb({ id: r.id, skill: r.skills?.find((s) => s.id === r.id) || { id: r.id, name: r.id } })
      onToast?.(type === 'py' ? '已创建 Python 技能' : '已创建 JS 技能', 'success')
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const doDelete = async (s) => {
    if (!confirm(`删除技能「${s.name}」？\n将删除整个技能目录（文档 + 组件）。\n引用该技能的智能体节点将失效。`)) return
    try {
      await h.skills.delete(s.id)
      await refresh()
      onToast?.(`技能「${s.name}」已删除`, 'success')
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const batchDelete = async () => {
    const ids = [...selected]
    if (!ids.length) return
    if (!confirm(`删除选中的 ${ids.length} 个技能？\n内置技能删除后重启应用会恢复。`)) return
    try {
      await h.skills.deleteMany(ids)
      await refresh()
      setSelected(new Set())
      onToast?.(`已删除 ${ids.length} 个技能`, 'success')
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const toggle = (id) => {
    setSelected((prev) => {
      const s = new Set(prev)
      if (s.has(id)) s.delete(id)
      else s.add(id)
      return s
    })
  }
  const allSelected = skills.length > 0 && skills.every((a) => selected.has(a.id))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(skills.map((a) => a.id)))

  const kw = q.trim().toLowerCase()
  const groups = useMemo(() => {
    const filtered = skills.filter((a) => !kw ||
      `${a.name} ${a.id} ${a.description || ''} ${a.category || ''}`.toLowerCase().includes(kw))
    const map = new Map()
    for (const a of filtered) {
      const cat = a.category || '未分类'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat).push(a)
    }
    for (const c of cats.list) if (!map.has(c)) map.set(c, [])
    return [...map.entries()].map(([cat, list]) => ({ cat, list }))
  }, [skills, cats, kw])

  if (wb) {
    return <SkillWorkbench key={wb.id} id={wb.id} skill={wb.skill} onBack={() => { setWb(null); refresh() }} onToast={onToast} />
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h2>技能</h2>
          <p className="panel-sub">
            技能 = 一个<strong>技能目录</strong>（文档 + 组件，多为 Python/JS）：主组件 <code>main.skill.js/.py</code> +
            文档 <code>README.md</code> 与辅助组件。点卡片进入工作台自由新建 / 删除 / 编辑文件
          </p>
        </div>
        <div className="panel-actions">
          <button className="btn" onClick={() => doCreate('js')} title="创建 JS 技能">＋ 新建 (JS)</button>
          <button className="btn" onClick={() => doCreate('py')} title="创建 Python 技能">＋ 新建 (Python)</button>
          <button className="btn" onClick={() => setCatModal({ targetSkillId: null })} title="创建分类文件夹，把技能归类">📁 新建分类</button>
          <button className="btn ghost" onClick={refresh}>↻ 刷新</button>
          {selected.size > 0 && <button className="btn danger" onClick={batchDelete}>🗑 删除选中 ({selected.size})</button>}
        </div>
      </div>

      {skills.length > 0 && (
        <div className="bulk-bar">
          <input className="input search-input" placeholder="🔍 搜索技能（名称 / 描述 / 分类）…" value={q} onChange={(e) => setQ(e.target.value)} />
          <label className="bulk-all"><input type="checkbox" checked={allSelected} onChange={toggleAll} />全选</label>
          <span className="bulk-count">{selected.size} / {skills.length} 已选中</span>
          {selected.size > 0 && <button className="bulk-clear" onClick={() => setSelected(new Set())}>取消选择</button>}
        </div>
      )}

      {skills.length === 0 && (
        <div className="workspace-empty">
          <div className="empty-icon">🧩</div>
          <p>还没有技能</p>
          <button className="btn" onClick={() => doCreate('js')}>创建第一个技能</button>
        </div>
      )}

      {groups.map(({ cat, list }) => (
        <div key={cat} className="agent-group">
          <div className="agent-group-title">
            <span className="agent-group-name">{cat}</span>
            <span className="agent-group-count">{list.length}</span>
            {cat !== '未分类' && (
              <button className="mini-btn danger cat-del" title="删除该分类文件夹（技能移回未分类）" onClick={() => deleteCategory(cat)}>🗑</button>
            )}
          </div>
          <div className="skill-list">
            {list.map((a) => (
              <div
                key={a.id}
                className={`skill-card mem-card${selected.has(a.id) ? ' selected' : ''}`}
                onClick={() => setWb({ id: a.id, skill: a })}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCardMenu({ skill: a, x: e.clientX, y: e.clientY }) }}
                title="点击打开技能工作台（右键管理）"
              >
                <div className="skill-card-head">
                  <span className="skill-card-title">
                    <span className="agent-avatar">{a.avatar}</span> {a.name}
                  </span>
                  <div className="session-actions">
                    <select
                      className="skill-cat-select" title="技能分类文件夹"
                      value={a.category || '未分类'}
                      onChange={(e) => { const v = e.target.value; if (v === '__new__') setCatModal({ targetSkillId: a.id }); else changeCategory(a, v) }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {['未分类', ...cats.list.filter((c) => c !== '未分类')].map((c) => <option key={c} value={c}>{c}</option>)}
                      <option value="__new__">＋ 新建分类…</option>
                    </select>
                    <button className="mini-btn danger" title="删除" onClick={(e) => { e.stopPropagation(); doDelete(a) }}>🗑</button>
                  </div>
                </div>
                <div className="skill-card-meta">
                  <code>{a.id}</code> · {a.kind === 'py' ? '🐍 Python' : 'JS'} · 更新于 {fmtTime(a.updatedAt)}
                </div>
                <div className="skill-card-desc">{a.description}</div>
                <div className="skill-card-path" title="点击进入工作台，自由编辑文档与组件">📁 文档 + 组件 · 点击卡片进入工作台 ✎</div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* 技能卡片右键菜单 */}
      {cardMenu && (
        <div className="mem-ctx-overlay" onClick={() => setCardMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCardMenu(null) }}>
          <div className="mem-ctx" style={{ left: cardMenu.x, top: cardMenu.y }}>
            <div className="mem-ctx-title">🧩 {cardMenu.skill.name}</div>
            <button className="mem-ctx-item" onClick={() => { const s = cardMenu.skill; setCardMenu(null); setWb({ id: s.id, skill: s }) }}>📂 打开工作台</button>
            <button className="mem-ctx-item danger" onClick={() => { const s = cardMenu.skill; setCardMenu(null); doDelete(s) }}>🗑 删除技能</button>
            <button className="mem-ctx-item" onClick={() => setCardMenu(null)}>取消</button>
          </div>
        </div>
      )}

      <CategoryModal open={!!catModal} onCreate={saveNewCategory} onClose={() => setCatModal(null)} />
    </div>
  )
}

// ---------------- 技能工作台（文件管理：文档 + 组件，无画板） ----------------
function SkillWorkbench({ id, skill, onBack, onToast }) {
  const [files, setFiles] = useState([])
  const [activeRel, setActiveRel] = useState(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(true)
  const [noteName, setNoteName] = useState('')
  const [noteBox, setNoteBox] = useState(false)
  const [ctx, setCtx] = useState(null) // 文件树右键 {f, x, y}
  const [runOut, setRunOut] = useState(null) // Python 运行结果 {file, ok, exitCode, stdout, stderr}

  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  const loadFiles = useCallback(async () => {
    const fs_ = await h.skills.files(id)
    setFiles(fs_ || [])
    return fs_ || []
  }, [id])

  useEffect(() => {
    ;(async () => {
      setLoading(true)
      try {
        const fs_ = await loadFiles()
        // 优先打开主组件，其次 README
        const first = fs_.find((f) => f.main) || fs_.find((f) => f.rel.toLowerCase() === 'readme.md') || fs_[0]
        if (first) {
          setActiveRel(first.rel)
          setDraft(await h.skills.readFile(id, first.rel))
          setDirty(false)
        }
      } catch (e) {
        onToast?.(e.message || String(e), 'error')
      } finally {
        setLoading(false)
      }
    })()
  }, [id, loadFiles, onToast])

  const openFile = async (rel) => {
    if (rel === activeRel) return
    if (dirtyRef.current && !confirm('当前文件有未保存的修改，切换将丢失。继续？')) return
    setLoading(true)
    try {
      const c = await h.skills.readFile(id, rel)
      setActiveRel(rel)
      setDraft(c)
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
      await h.skills.writeFile(id, activeRel, draft)
      setDirty(false)
      onToast?.(`已保存 ${activeRel}`, 'success')
      loadFiles().catch(() => {})
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
      const r = await h.skills.createFile(id, rel)
      onToast?.(`已创建 ${r.rel}`, 'success')
      setNoteBox(false)
      setNoteName('')
      setActiveRel(r.rel)
      setDraft(await h.skills.readFile(id, r.rel))
      setDirty(false)
      await loadFiles()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const deleteFile = async (f) => {
    if (!f) return
    if (f.main || f.protected) { onToast?.('主组件文件不可删除', 'error'); return }
    if (!confirm(`删除 ${f.rel}？`)) return
    try {
      await h.skills.deleteFile(id, f.rel)
      onToast?.(`已删除 ${f.rel}`, 'success')
      if (activeRel === f.rel) { setActiveRel(null); setDraft(''); setDirty(false) }
      await loadFiles()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  // 切换文件可读性：readable=false 时该文件对 LLM 不可读（仅管理标记，不影响文件内容）
  const toggleReadable = async (f) => {
    if (!f) return
    if (f.main) { onToast?.('主组件文件始终可读', 'error'); return }
    const next = !(f.readable !== false)
    try {
      await h.skills.setFileReadable(id, f.rel, next)
      onToast?.(`${f.rel} 已${next ? '设为可读' : '设为不可读'}`, 'success')
      await loadFiles()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const fileIcon = (f) => (f.kind === 'py' ? '🐍' : f.kind === 'js' ? '⚡' : f.kind === 'json' ? '⚙' : '📄')

  // 运行技能内的 Python 文件（嵌入式/系统 Python，回显输出）
  const runFile = async (f) => {
    try {
      const r = await h.skills.run(id, f.rel)
      setRunOut({ file: f.rel, ...r })
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  return (
    <div className="panel mem-wb">
      <div className="mem-wb-topbar">
        <button className="btn ghost" onClick={onBack}>← 返回</button>
        <span className="mem-wb-title">🧩 {skill.name || id}</span>
        <span className="mem-wb-sub"><code>{id}</code></span>
        <div className="mem-wb-actions">
          <button className="btn" onClick={() => setNoteBox(true)} title="像文件管理器一样自由添加文件（自由命名，可带子目录，无扩展名默认 .md）">＋ 文件</button>
        </div>
      </div>

      <div className="mem-wb-body">
        <div className="mem-wb-tree">
          <div className="mem-wb-tree-title">文件</div>
          <div className="mem-wb-tree-scroll" onContextMenu={(e) => {
            // 目录空白处右键 → 新建文件
            if (!e.target.closest('.mem-tree-item')) {
              e.preventDefault(); e.stopPropagation(); setCtx(null); setNoteBox(true)
            }
          }}>
            {files.length === 0 && <div className="mem-tree-empty">暂无文件（右键空白处或点「＋ 新建文件」创建）</div>}
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
                  {!f.main && f.readable === false && <span className="mem-tree-ro off" title="不可读（LLM 不读取此文件）">禁</span>}
                </button>
                {f.kind === 'py' && (
                  <button className="mem-tree-run" title="用 Python 运行此文件" onClick={() => runFile(f)}>▶</button>
                )}
                <button
                  className="mem-tree-del"
                  disabled={f.main || f.protected}
                  title={f.main ? '主组件文件不可删除' : '删除文件'}
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
              <textarea
                className="mem-file-editor"
                value={draft}
                spellCheck={false}
                autoCapitalize="off" autoComplete="off" autoCorrect="off"
                placeholder="文件内容…（Ctrl+S 保存）"
                onChange={(e) => { setDraft(e.target.value); setDirty(true) }}
              />
            ) : (
              <div className="mem-wb-empty">选择左侧文件开始编辑，或点「＋ 文件」新建</div>
            )}
          </div>
        </div>

        <div className="mem-wb-props">
          <div className="mem-wb-props-title">信息</div>
          <div className="mem-props-item"><span className="mem-props-label">名称</span><code>{skill.name || id}</code></div>
          <div className="mem-props-item"><span className="mem-props-label">ID</span><code>{id}</code></div>
          <div className="mem-props-item"><span className="mem-props-label">文件数</span><span className="mem-props-val">{files.length}</span></div>
          <div className="mem-props-hint">
            技能就是一组文件：<b>main.skill.js/py</b> 是组件主文件（不可删，保存后自动重载），
            <code>README.md</code> 是文档，可自由新建辅助 <code>*.py</code> / <code>*.md</code> / <code>*.json</code> 组件。
          </div>
        </div>
      </div>

      {noteBox && (
        <div className="modal-overlay" onClick={() => setNoteBox(false)}>
          <div className="modal small" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>新建技能文件</h2>
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

      {ctx && (
        <div className="mem-ctx-overlay" onClick={() => setCtx(null)} onContextMenu={(e) => { e.preventDefault(); setCtx(null) }}>
          <div className="mem-ctx" style={{ left: ctx.x, top: ctx.y }}>
            <div className="mem-ctx-title">📄 {ctx.f.rel} <span className={ctx.f.readable === false ? 'ctx-state off' : 'ctx-state'}>{ctx.f.readable === false ? '不可读' : '可读'}</span></div>
            <button className="mem-ctx-item" onClick={() => { const f = ctx.f; setCtx(null); toggleReadable(f) }} disabled={ctx.f.main} title={ctx.f.main ? '主组件文件始终可读' : '切换 LLM 是否可读此文件'}>{ctx.f.readable === false ? '🔓 设为可读' : '🔒 设为不可读'}</button>
            <button className="mem-ctx-item danger" onClick={() => { const f = ctx.f; setCtx(null); deleteFile(f) }} disabled={ctx.f.main || ctx.f.protected} title={ctx.f.main ? '主组件不可删除' : '删除此文件'}>🗑 删除文件</button>
            <button className="mem-ctx-item" onClick={() => setCtx(null)}>取消</button>
          </div>
        </div>
      )}

      {runOut && (
        <div className="modal-overlay" onClick={() => setRunOut(null)}>
          <div className="modal run-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>▶ 运行结果 · {runOut.file}</h2>
              <button className="icon-btn" onClick={() => setRunOut(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className={'run-status ' + (runOut.ok ? 'ok' : 'err')}>
                {runOut.ok ? '✓ 运行成功' : `✕ 运行失败（退出码 ${runOut.exitCode}）`}
              </div>
              {runOut.stdout ? <pre className="run-stdout">{runOut.stdout}</pre> : null}
              {runOut.stderr ? <pre className="run-stderr">{runOut.stderr}</pre> : null}
              {!runOut.stdout && !runOut.stderr && <div className="mem-wb-empty">（无输出）</div>}
            </div>
            <div className="modal-footer">
              <button className="btn primary" onClick={() => setRunOut(null)}>关闭</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
