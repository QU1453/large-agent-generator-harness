import React, { useCallback, useEffect, useState } from 'react'
import { h, fmtTime } from '../lib/harness.js'
import CategoryModal from './CategoryModal.jsx'

// 智能体栏：单智能体管理 = 模型配置（继承/自定义）+ 提示词 + 技能列表
// 与「工作流」的区别：智能体是独立可复用的个体，工作流是画布编排多个智能体/技能协作。
// 工作流里的「子智能体」节点可直接引用这里的智能体（运行时自动转最小图执行）。
export default function AgentAdmin({ skills = [], onToast }) {
  const [defs, setDefs] = useState([])
  const [cats, setCats] = useState({ list: [], map: {} })
  const [q, setQ] = useState('')
  const [cardMenu, setCardMenu] = useState(null)
  const [catModal, setCatModal] = useState(false)
  const [edit, setEdit] = useState(null) // 编辑弹窗草稿
  const [skQ, setSkQ] = useState('') // 技能多选搜索

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
    setEdit(d)
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

  const openEdit = async (d) => {
    const full = await h.agdefs.get(d.id)
    if (!full) return
    setEdit({
      ...full,
      model: full.model && full.model.inherit === false
        ? { inherit: false, baseUrl: full.model.baseUrl || '', apiKey: full.model.apiKey || '', model: full.model.model || '' }
        : { inherit: true, baseUrl: '', apiKey: '', model: '' },
      skills: Array.isArray(full.skills) ? full.skills : []
    })
    setSkQ('')
  }

  const patchEdit = (patch) => setEdit((prev) => prev && { ...prev, ...patch })
  const patchModel = (patch) => setEdit((prev) => prev && { ...prev, model: { ...(prev.model || {}), ...patch } })

  const toggleSkill = (id) => {
    setEdit((prev) => {
      if (!prev) return prev
      const has = (prev.skills || []).includes(id)
      return { ...prev, skills: has ? prev.skills.filter((s) => s !== id) : [...(prev.skills || []), id] }
    })
  }

  const saveDef = async () => {
    if (!edit) return
    const name = (edit.name || '').trim()
    if (!name) {
      onToast?.('名称不能为空', 'error')
      return
    }
    const m = edit.model || {}
    const model = m.inherit !== false
      ? { inherit: true }
      : {
          inherit: false,
          baseUrl: (m.baseUrl || '').trim(),
          apiKey: (m.apiKey || '').trim(),
          model: (m.model || '').trim()
        }
    const r = await h.agdefs.save({ ...edit, name, model })
    setDefs(r.list)
    setEdit(null)
    onToast?.(`智能体「${name}」已保存`, 'success')
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

  const skKw = skQ.trim().toLowerCase()
  const skillOptions = skills.filter((s) => !skKw || `${s.name || ''} ${s.id || ''} ${s.description || ''}`.toLowerCase().includes(skKw))

  return (
    <div className="panel">
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
                onClick={() => openEdit(d)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCardMenu({ d, x: e.clientX, y: e.clientY }) }}
                title="点击编辑模型 / 提示词 / 技能（右键管理）"
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
            <button className="mem-ctx-item" onClick={() => { const d = cardMenu.d; setCardMenu(null); openEdit(d) }}>✏ 编辑模型 / 提示词 / 技能</button>
            <button className="mem-ctx-item danger" onClick={() => { const d = cardMenu.d; setCardMenu(null); doDelete(d) }}>🗑 删除智能体</button>
            <button className="mem-ctx-item" onClick={() => setCardMenu(null)}>取消</button>
          </div>
        </div>
      )}

      {/* 编辑弹窗：模型（继承/自定义）+ 提示词 + 技能 */}
      {edit && (
        <div className="modal-overlay" onClick={() => setEdit(null)}>
          <div className="modal agdef-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>🤖 {edit.id ? '编辑智能体' : '新建智能体'}</h2>
              <button className="icon-btn" onClick={() => setEdit(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="agdef-row">
                <span className="agdef-label">名称</span>
                <input className="input" style={{ flex: 1 }} placeholder="如：客服助手" value={edit.name || ''} onChange={(e) => patchEdit({ name: e.target.value })} />
              </div>
              <div className="agdef-row">
                <span className="agdef-label">描述</span>
                <input className="input" style={{ flex: 1 }} placeholder="用途说明（便于搜索与子智能体节点识别）" value={edit.description || ''} onChange={(e) => patchEdit({ description: e.target.value })} />
              </div>

              <div className="agdef-section-title">模型配置（URL + API）</div>
              <label className="model-inherit-row">
                <input
                  type="checkbox"
                  checked={edit.model.inherit !== false}
                  onChange={(e) => patchModel({ inherit: e.target.checked })}
                />
                继承上游智能体 / 全局设置的模型
              </label>
              {edit.model.inherit === false && (
                <div className="model-fields">
                  <div className="model-field">
                    <span className="model-field-label">Base URL</span>
                    <input className="wf-edge-when" style={{ margin: 0 }} placeholder="https://api.deepseek.com/v1" value={edit.model.baseUrl || ''} onChange={(e) => patchModel({ baseUrl: e.target.value })} />
                  </div>
                  <div className="model-field">
                    <span className="model-field-label">API Key</span>
                    <input className="wf-edge-when" style={{ margin: 0 }} type="password" placeholder="sk-..." value={edit.model.apiKey || ''} onChange={(e) => patchModel({ apiKey: e.target.value })} />
                  </div>
                  <div className="model-field">
                    <span className="model-field-label">模型名</span>
                    <input className="wf-edge-when" style={{ margin: 0 }} placeholder="deepseek-chat" value={edit.model.model || ''} onChange={(e) => patchModel({ model: e.target.value })} />
                  </div>
                  <div className="code-modal-hint">导出后不含密钥，运行前通过配置接口注入；字段留空回落上游</div>
                </div>
              )}

              <div className="agdef-section-title">提示词（system prompt）</div>
              <textarea
                className="agdef-prompt"
                placeholder="这个智能体的角色、职责、行为准则……"
                value={edit.systemPrompt || ''}
                onChange={(e) => patchEdit({ systemPrompt: e.target.value })}
                spellCheck={false}
              />

              <div className="agdef-section-title">技能（运行时会按序组装处理输入）</div>
              <input className="input search-input agdef-skq" placeholder="🔍 搜索技能…" value={skQ} onChange={(e) => setSkQ(e.target.value)} />
              <div className="agdef-skills">
                {skillOptions.map((s) => {
                  const on = (edit.skills || []).includes(s.id)
                  return (
                    <label key={s.id} className={'agdef-skill' + (on ? ' on' : '')} title={s.description || s.id}>
                      <input type="checkbox" checked={on} onChange={() => toggleSkill(s.id)} />
                      <span className="agdef-skill-name">{s.avatar || '🤖'} {s.name || s.id}</span>
                      <span className="agdef-skill-desc">{(s.description || s.id).slice(0, 40)}</span>
                    </label>
                  )
                })}
                {skillOptions.length === 0 && <div className="mem-wb-empty">无匹配技能（未选时默认使用内置 assistant 技能）</div>}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setEdit(null)}>取消</button>
              <button className="btn primary" onClick={saveDef}>保存智能体</button>
            </div>
          </div>
        </div>
      )}

      <CategoryModal
        open={catModal}
        title="新建分类文件夹"
        placeholder="如：客服 / 数据分析"
        onCreate={async (name) => { await saveNewCategory(name); setCatModal(false) }}
        onClose={() => setCatModal(false)}
      />
    </div>
  )
}
