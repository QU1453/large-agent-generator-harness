import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { h, fmtTime } from '../lib/harness.js'
import CategoryModal from './CategoryModal.jsx'

// 记忆管理：记忆架构 = 一个「记忆空间」目录（md 文件优先，人可读可改，不做黑盒、不做画板）
// 列表页（架构卡片）→ 打开工作台：左文件树 / 中编辑器（Ctrl+S 保存）/ 右信息面板
// 架构内自由新建 / 删除文件（policy/facts/episodes/skills/ledger 五个核心文件默认保护，其余任意）
export default function MemoryPanel({ onToast }) {
  const [memories, setMemories] = useState([])
  const [wb, setWb] = useState(null) // null | {name, meta}
  const [creator, setCreator] = useState(null)
  const [saving, setSaving] = useState(false)
  const [cardMenu, setCardMenu] = useState(null) // 记忆卡片右键菜单 {m, x, y}
  const [q, setQ] = useState('') // 文字搜索
  const [cats, setCats] = useState({ list: [], map: {} }) // 分类文件夹
  const [catModal, setCatModal] = useState(false)

  const refresh = useCallback(async () => {
    setMemories(await h.memory.list())
  }, [])
  useEffect(() => {
    refresh().catch(() => {})
    h.memory.categories().then(setCats).catch(() => {})
  }, [refresh])

  const doCreate = async () => {
    if (!creator || saving) return
    const name = (creator.name || '').trim()
    if (!name) { onToast?.('记忆名不能为空', 'error'); return }
    setSaving(true)
    try {
      await h.memory.create(name, creator.content || '')
      onToast?.(`记忆「${name}」已创建`, 'success')
      setCreator(null)
      await refresh()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const doDelete = async (m) => {
    if (!confirm(`删除记忆架构「${m.title || m.name}」？\n将删除整个记忆空间目录（policy/ledger/facts/episodes/skills 及其余文件）。\n已绑定该记忆的会话/工作区/工作流节点将失去记忆读写能力。`)) return
    try {
      await h.memory.delete(m.name)
      onToast?.(`记忆「${m.title || m.name}」已删除`, 'success')
      await refresh()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  // 分类文件夹（memory/categories.json）
  const saveNewCategory = async (name) => {
    setCats(await h.memory.addCategory(name))
    onToast?.(`分类「${name}」已创建`, 'success')
  }

  const deleteCategory = async (cat) => {
    if (!confirm(`删除分类文件夹「${cat}」？\n归到该分类的记忆会移回「未分类」，记忆本身不会被删除。`)) return
    try {
      setCats(await h.memory.removeCategory(cat))
      await refresh()
      onToast?.(`分类「${cat}」已删除`, 'success')
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const setMemCategory = async (m, name) => {
    try {
      setCats(await h.memory.setCategory(m.name, name))
      await refresh()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  // 按分类分组 + 文字搜索过滤（空分类也显示出来）
  const kw = q.trim().toLowerCase()
  const groups = useMemo(() => {
    const filtered = memories.filter((m) => !kw ||
      `${m.title || ''} ${m.name} ${m.desc || ''} ${m.category || ''}`.toLowerCase().includes(kw))
    const map = new Map()
    for (const m of filtered) {
      const cat = m.category || (cats.map && cats.map[m.name]) || '未分类'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat).push(m)
    }
    for (const c of cats.list) {
      if (!map.has(c)) map.set(c, [])
    }
    return [...map.entries()].map(([cat, list]) => ({ cat, list }))
  }, [memories, cats, kw])

  if (wb) {
    return (
      <MemoryWorkbench
        key={wb.name}
        name={wb.name}
        meta={wb.meta}
        onBack={() => { setWb(null); refresh() }}
        onToast={onToast}
      />
    )
  }

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h2>记忆</h2>
          <p className="panel-sub">
            记忆架构 = 一个<strong>记忆空间目录</strong>（md 文件优先，人可读可改，绝不做成黑盒）：
            <code>policy.md</code> 策略 · <code>ledger.md</code> 账本（只追加）· <code>facts.md</code> 事实 ·
            <code>episodes.md</code> 情景 · <code>skills.md</code> 技能 ·
            以及任意自定义文件（<code>*.py</code> / <code>*.md</code> / <code>*.json</code> 等）。
            点卡片进入工作台自由新建 / 删除 / 编辑文件；会话/工作区可绑定一个架构，绑定后自动获得记忆读写工具
          </p>
        </div>
        <div className="panel-actions">
          <button className="btn" onClick={() => setCreator({ name: '', content: '' })}>＋ 新建记忆</button>
          <button className="btn" onClick={() => setCatModal(true)} title="创建分类文件夹，把记忆架构归类">📁 新建分类</button>
          <button className="btn ghost" onClick={refresh}>↻ 刷新</button>
        </div>
      </div>

      {memories.length > 0 && (
        <div className="bulk-bar">
          <input
            className="input search-input"
            placeholder="🔍 搜索记忆（名称 / 描述）…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <span className="bulk-count">{memories.length} 个记忆架构</span>
        </div>
      )}

      {memories.length === 0 && (
        <div className="workspace-empty">
          <div className="empty-icon">🧠</div>
          <p>还没有记忆架构</p>
          <button className="btn" onClick={() => setCreator({ name: '', content: '' })}>创建第一个记忆</button>
        </div>
      )}

      {groups.map(({ cat, list }) => (
        <div key={cat} className="agent-group">
          <div className="agent-group-title">
            <span className="agent-group-name">{cat}</span>
            <span className="agent-group-count">{list.length}</span>
            {cat !== '未分类' && (
              <button
                className="mini-btn danger cat-del"
                title="删除该分类文件夹（记忆移回未分类）"
                onClick={() => deleteCategory(cat)}
              >🗑</button>
            )}
          </div>
          <div className="skill-list">
            {list.map((m) => (
              <div
                key={m.name}
                className="skill-card mem-card"
                onClick={() => setWb({ name: m.name, meta: m })}
                onDoubleClick={() => setWb({ name: m.name, meta: m })}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCardMenu({ m, x: e.clientX, y: e.clientY }) }}
                title="双击/点击打开记忆工作台（右键删除/管理）"
              >
                <div className="skill-card-head">
                  <span className="skill-card-title">🧠 {m.title}</span>
                  <div className="session-actions">
                    <select
                      className="skill-cat-select"
                      title="记忆分类文件夹"
                      value={m.category || (cats.map && cats.map[m.name]) || '未分类'}
                      onChange={(e) => {
                        const v = e.target.value
                        if (v === '__new__') { setCatModal(true) } else { setMemCategory(m, v) }
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {['未分类', ...cats.list.filter((c) => c !== '未分类')].map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                      <option value="__new__">＋ 新建分类…</option>
                    </select>
                    <button
                      className="mini-btn danger"
                      title="删除"
                      onClick={(e) => { e.stopPropagation(); doDelete(m) }}
                    >🗑</button>
                  </div>
                </div>
                <div className="skill-card-meta">
                  <code>{m.name}</code> · 更新于 {fmtTime(m.updatedAt)}
                </div>
                <div className="skill-card-desc" title={m.path}>{m.desc}</div>
                <div className="skill-card-path" title="点击进入工作台，自由新建/删除/编辑记忆文件">📁 {m.path} · 点击卡片进入工作台 ✎</div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* 记忆卡片右键菜单：打开工作台 / 删除 */}
      {cardMenu && (
        <div
          className="mem-ctx-overlay"
          onClick={() => setCardMenu(null)}
          onContextMenu={(e) => { e.preventDefault(); setCardMenu(null) }}
        >
          <div className="mem-ctx" style={{ left: cardMenu.x, top: cardMenu.y }}>
            <div className="mem-ctx-title">🧠 {cardMenu.m.title || cardMenu.m.name}</div>
            <button
              className="mem-ctx-item"
              onClick={() => { const m = cardMenu.m; setCardMenu(null); setWb({ name: m.name, meta: m }) }}
            >
              📂 打开工作台
            </button>
            <button className="mem-ctx-item danger" onClick={() => { const m = cardMenu.m; setCardMenu(null); doDelete(m) }}>🗑 删除记忆</button>
            <button className="mem-ctx-item" onClick={() => setCardMenu(null)}>取消</button>
          </div>
        </div>
      )}

      {/* 新建弹窗 */}
      {creator && (
        <div className="modal-overlay" onClick={() => setCreator(null)}>
          <div className="modal skill-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="editor-title"><span>🧠 新建记忆</span></div>
              <button className="icon-btn" onClick={() => setCreator(null)}>✕</button>
            </div>
            <div className="modal-body skill-edit-body">
              <label className="field">
                <span className="field-label">记忆名</span>
                <input
                  className="input" autoFocus
                  placeholder="如: 项目知识库 / 用户偏好"
                  value={creator.name}
                  onChange={(e) => setCreator((s) => ({ ...s, name: e.target.value }))}
                />
              </label>
              <label className="field">
                <span className="field-label">初始事实（facts.md 内容，可留空）</span>
                <textarea
                  className="wf-textarea skill-content" spellCheck={false}
                  placeholder={'# 记忆名（事实）\n- 关键结论/约定…'}
                  value={creator.content}
                  onChange={(e) => setCreator((s) => ({ ...s, content: e.target.value }))}
                />
              </label>
              <div className="skill-card-desc">创建后自动生成 policy / ledger / facts / episodes / skills 五个文件，可进入工作台自由新建、删除与编辑</div>
            </div>
            <div className="modal-footer">
              <button className="btn ghost" onClick={() => setCreator(null)}>取消</button>
              <button className="btn primary" disabled={saving} onClick={doCreate}>{saving ? '创建中…' : '创建'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 新建分类弹窗 */}
      <CategoryModal
        open={catModal}
        title="新建分类文件夹"
        placeholder="如：知识库 / 用户偏好"
        onCreate={async (name) => { await saveNewCategory(name); setCatModal(false) }}
        onClose={() => setCatModal(false)}
      />
    </div>
  )
}

// ---------------- 记忆工作台（文件管理，无画板） ----------------
function MemoryWorkbench({ name, meta, onBack, onToast }) {
  const [files, setFiles] = useState([])
  const [activeRel, setActiveRel] = useState(null)
  const [draft, setDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [organizing, setOrganizing] = useState(false)
  const [loading, setLoading] = useState(true)
  const [noteName, setNoteName] = useState('')
  const [noteBox, setNoteBox] = useState(false)
  const [renameBox, setRenameBox] = useState(null) // 文件重命名弹窗 {f, value}
  const [ctx, setCtx] = useState(null) // 文件树右键菜单 {f, x, y}
  const [extractBox, setExtractBox] = useState(false)
  const [extractText, setExtractText] = useState('')
  const [extracting, setExtracting] = useState(false)
  const [runOut, setRunOut] = useState(null) // Python 运行结果 {file, ok, exitCode, stdout, stderr}

  const dirtyRef = useRef(false)
  dirtyRef.current = dirty

  // 运行记忆架构内的 Python 文件（嵌入式/系统 Python，回显输出）
  const runFile = async (f) => {
    try {
      const r = await h.memory.run(name, f.rel)
      setRunOut({ file: f.rel, ...r })
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const loadFiles = useCallback(async () => {
    const fs_ = await h.memory.files(name)
    setFiles(fs_ || [])
    return fs_ || []
  }, [name])

  // 打开工作台：加载文件树，自动打开第一个文件（policy）
  useEffect(() => {
    ;(async () => {
      setLoading(true)
      try {
        const fs_ = await loadFiles()
        if (fs_.length) {
          setActiveRel(fs_[0].rel)
          setDraft(await h.memory.readFile(name, fs_[0].rel))
          setDirty(false)
        }
      } catch (e) {
        onToast?.(e.message || String(e), 'error')
      } finally {
        setLoading(false)
      }
    })()
    return () => {}
  }, [name, loadFiles, onToast])

  const activeFile = files.find((f) => f.rel === activeRel) || null
  const readOnly = !!(activeFile && activeFile.kind === 'ledger')

  const openFile = async (rel) => {
    if (rel === activeRel) return
    if (dirtyRef.current && !confirm('当前文件有未保存的修改，切换将丢失。继续？')) return
    setLoading(true)
    try {
      const c = await h.memory.readFile(name, rel)
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
    if (!activeRel || !dirty || saving || readOnly) return
    setSaving(true)
    try {
      await h.memory.writeFile(name, activeRel, draft)
      setDirty(false)
      onToast?.(`已保存 ${activeRel}`, 'success')
      loadFiles().catch(() => {})
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  // 全局 Ctrl+S 保存当前文件
  const saveRef = useRef(doSave)
  saveRef.current = doSave
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const createNote = async () => {
    const n = noteName.trim()
    if (!n) { onToast?.('文件名不能为空', 'error'); return }
    // 像文件管理器一样自由命名：带扩展名用原名，不带则默认 .md
    const base = n.split('/').pop()
    const rel = /\.\w+$/.test(base) ? n : `${n}.md`
    try {
      const r = await h.memory.createFile(name, rel)
      onToast?.(`已创建 ${r.rel}`, 'success')
      setNoteBox(false)
      setNoteName('')
      const fs_ = await loadFiles()
      setActiveRel(r.rel)
      setDraft(await h.memory.readFile(name, r.rel))
      setDirty(false)
      setFiles(fs_)
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const deleteFile = async (f) => {
    if (!f) return
    if (f.protected) { onToast?.('该文件处于保护状态，不能删除（右键可取消保护）', 'error'); return }
    if (!confirm(`删除 ${f.rel}？`)) return
    try {
      await h.memory.deleteFile(name, f.rel)
      onToast?.(`已删除 ${f.rel}`, 'success')
      if (activeRel === f.rel) { setActiveRel(null); setDraft(''); setDirty(false) }
      await loadFiles()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  // 切换文件保护：受保护的文件删除按钮禁用（灰色）；默认内置 5 核心受保护
  const toggleProtected = async (f) => {
    if (!f) return
    try {
      await h.memory.setProtected(name, f.rel, !f.protected)
      await loadFiles()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  // 重命名文件：受保护文件不可改名；无扩展名自动补 .md；改名后若正打开则跟随
  const doRename = async () => {
    if (!renameBox) return
    const f = renameBox.f
    const nv = (renameBox.value || '').trim()
    if (!nv) { onToast?.('新文件名不能为空', 'error'); return }
    try {
      const r = await h.memory.renameFile(name, f.rel, nv)
      onToast?.(`已重命名 ${f.rel} → ${r.rel}`, 'success')
      setRenameBox(null)
      if (activeRel === f.rel) {
        setActiveRel(r.rel)
        setDraft(await h.memory.readFile(name, r.rel))
      }
      await loadFiles()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  // 右键菜单：确认删除
  const doCtxDelete = async () => {
    if (!ctx) return
    const f = ctx.f
    setCtx(null)
    if (f.protected) { onToast?.('该文件处于保护状态，不能删除（可在此菜单取消保护）', 'error'); return }
    if (!confirm(`删除 ${f.rel}？`)) return
    try {
      await h.memory.deleteFile(name, f.rel)
      onToast?.(`已删除 ${f.rel}`, 'success')
      if (activeRel === f.rel) { setActiveRel(null); setDraft(''); setDirty(false) }
      await loadFiles()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const doOrganize = async () => {
    if (organizing) return
    setOrganizing(true)
    onToast?.('正在整理记忆…', 'info')
    try {
      const r = await h.memory.organize(name)
      const note = (r && r.note) || '整理完成'
      const preview = r && r.result ? String(r.result).slice(0, 200) : ''
      onToast?.(preview ? `${note}\n${preview}` : note, 'success')
      loadFiles().catch(() => {})
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    } finally {
      setOrganizing(false)
    }
  }

  const doSwitchPolicy = async () => {
    if (!confirm(`更替「${meta.title || name}」的记忆策略？\n将清空账本（数据库式留痕），仅保留文档形式的记忆（policy/facts/episodes/skills/bus）。`)) return
    try {
      const r = await h.memory.resetLedger(name)
      onToast?.(r.note || '策略已更替', 'success')
      loadFiles().catch(() => {})
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const doExtract = async () => {
    const t = extractText.trim()
    if (!t) { onToast?.('请先粘贴要提取的内容', 'error'); return }
    setExtracting(true)
    onToast?.('正在提取记忆…', 'info')
    try {
      const r = await h.memory.extract(name, t)
      const note = (r && r.note) || '提取完成'
      const preview = r && r.result ? String(r.result).slice(0, 120) : ''
      onToast?.(preview ? `${note}\n${preview}` : note, 'success')
      setExtractBox(false)
      setExtractText('')
      loadFiles().catch(() => {})
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    } finally {
      setExtracting(false)
    }
  }

  const fileIcon = (f) => (f.kind === 'py' ? '🐍' : f.kind === 'json' ? '⚙' : f.kind === 'ledger' ? '📒' : '📄')

  return (
    <div className="panel mem-wb">
      <div className="mem-wb-topbar">
        <button className="btn ghost" onClick={onBack}>← 返回</button>
        <span className="mem-wb-title">🧠 {meta.title || name}</span>
        <span className="mem-wb-sub"><code>{name}</code></span>
        <div className="mem-wb-actions">
          <button className="btn" disabled={organizing} onClick={doOrganize} title="读全部记忆 → 管家整理去重分类 → 写回">{organizing ? '整理中…' : '🧹 整理'}</button>
          <button className="btn" onClick={doSwitchPolicy} title="更替记忆策略：清空账本（数据库留痕），仅保留文档形式的记忆（policy/facts/episodes/skills/bus）">🔄 策略更替</button>
          <button className="btn" disabled={extracting} onClick={() => setExtractBox(true)} title="把对话/长文蒸馏成记忆写回">📥 提取</button>
          <button className="btn" onClick={() => setNoteBox(true)} title="像文件管理器一样自由添加文件（自由命名，可带子目录，无扩展名默认 .md）">＋ 文件</button>
        </div>
      </div>

      <div className="mem-wb-body">
        {/* 左：文件树（自由新建 / 删除 / 保护） */}
        <div className="mem-wb-tree">
          <div className="mem-wb-tree-title">文件</div>
          <div className="mem-wb-tree-scroll">
            {files.length === 0 && <div className="mem-tree-empty">暂无文件</div>}
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
                  {f.kind === 'ledger' && <span className="mem-tree-ro">RO</span>}
                </button>
                {f.kind === 'py' && (
                  <button className="mem-tree-run" title="用 Python 运行此文件" onClick={() => runFile(f)}>▶</button>
                )}
                <button
                  className="mem-tree-del"
                  disabled={f.protected}
                  title={f.protected ? '受保护（右键可取消保护）' : '删除文件'}
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

        {/* 中：编辑器（Ctrl+S 保存） */}
        <div className="mem-wb-editor">
          <div className="mem-wb-editor-head">
            <code className="mem-editor-file">{activeRel || '未选择文件'}</code>
            {readOnly && <span className="mem-ro-tag">只读（账本）</span>}
            {dirty && <span className="editor-dirty">● 未保存</span>}
            {loading && <span className="mem-loading">加载中…</span>}
          </div>
          <div className="mem-wb-editor-wrap">
            {activeRel ? (
              <textarea
                className="mem-file-editor"
                value={draft}
                readOnly={readOnly}
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

        {/* 右：信息面板 */}
        <div className="mem-wb-props">
          <div className="mem-wb-props-title">信息</div>
          <div className="mem-props-item">
            <span className="mem-props-label">名称</span>
            <code>{meta.title || name}</code>
          </div>
          <div className="mem-props-item">
            <span className="mem-props-label">目录</span>
            <code title={meta.path}>{name}</code>
          </div>
          <div className="mem-props-item">
            <span className="mem-props-label">文件数</span>
            <span className="mem-props-val">{files.length}</span>
          </div>
          <div className="mem-props-hint">
            记忆架构就是一组文件：<b>左侧</b>自由新建 / 删除 / 编辑（Ctrl+S 保存）。
            核心五文件（policy/facts/episodes/skills/ledger）默认保护，可右键取消保护后删除；
            <code>*.py</code> / <code>*.md</code> / <code>*.json</code> 等自定义文件自由增删。
          </div>
        </div>
      </div>

      {/* ＋ 文件弹窗（文件管理器式：自由命名，创建即打开编辑） */}
      {noteBox && (
        <div className="modal-overlay" onClick={() => setNoteBox(false)}>
          <div className="modal small" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>新建记忆文件</h2>
              <button className="icon-btn" onClick={() => setNoteBox(false)}>✕</button>
            </div>
            <div className="modal-body">
              <label className="field">
                <span className="field-label">文件名（自由命名，可带子目录；无扩展名默认 .md）</span>
                <input className="input" autoFocus value={noteName} placeholder="如: notes/待办清单 或 engine.py 或 灵感集.md" onChange={(e) => setNoteName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') createNote() }} />
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn ghost" onClick={() => setNoteBox(false)}>取消</button>
              <button className="btn primary" onClick={createNote}>创建</button>
            </div>
          </div>
        </div>
      )}

      {/* 📥 提取记忆管家弹窗 */}
      {extractBox && (
        <div className="modal-overlay" onClick={() => setExtractBox(false)}>
          <div className="modal skill-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="editor-title"><span>📥 提取记忆「{meta.title || name}」</span></div>
              <button className="icon-btn" onClick={() => setExtractBox(false)}>✕</button>
            </div>
            <div className="modal-body skill-edit-body">
              <div className="skill-card-desc">
                粘贴对话记录 / 长文 / 会议纪要，记忆管家（assistant + memory_* 工具）会按 policy 蒸馏：偏好/结论写 facts、事件写 episodes、可复用步骤写 skills，账本留痕。
              </div>
              <textarea
                className="wf-textarea skill-content"
                spellCheck={false}
                placeholder={'把要记住的内容粘贴到这里…\n\n例如一段对话：\n用户：我喜欢简洁的代码风格\n助手：好的，已记录'}
                value={extractText}
                onChange={(e) => setExtractText(e.target.value)}
              />
            </div>
            <div className="modal-footer">
              <button className="btn ghost" onClick={() => setExtractBox(false)}>取消</button>
              <button className="btn primary" disabled={extracting} onClick={doExtract}>{extracting ? '提取中…' : '📥 提取并写入记忆'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 文件树右键菜单：保护 / 删除 */}
      {ctx && (
        <div
          className="mem-ctx-overlay"
          onClick={() => setCtx(null)}
          onContextMenu={(e) => { e.preventDefault(); setCtx(null) }}
        >
          <div className="mem-ctx" style={{ left: ctx.x, top: ctx.y }}>
            <div className="mem-ctx-title">📄 {ctx.f.rel}</div>
            <button
              className="mem-ctx-item"
              onClick={() => { const f = ctx.f; setCtx(null); toggleProtected(f) }}
              title={ctx.f.protected ? '取消保护后即可删除' : '加入保护后删除按钮禁用'}
            >
              {ctx.f.protected ? '🔓 取消保护' : '🛡 加入保护'}
            </button>
            <button
              className="mem-ctx-item"
              onClick={() => { const f = ctx.f; setCtx(null); setRenameBox({ f, value: f.rel }) }}
              disabled={ctx.f.protected}
              title={ctx.f.protected ? '受保护，先取消保护才能重命名' : '重命名此文件'}
            >
              ✏ 重命名
            </button>
            <button
              className="mem-ctx-item danger"
              onClick={doCtxDelete}
              disabled={ctx.f.protected}
              title={ctx.f.protected ? '受保护，先取消保护才能删除' : '删除此文件'}
            >
              🗑 删除文件
            </button>
            <button className="mem-ctx-item" onClick={() => setCtx(null)}>取消</button>
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
                <span className="field-label">新文件名（无扩展名默认 .md）</span>
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
