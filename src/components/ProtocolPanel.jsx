// 协议管理页：A2A 安全协议 = Python 代码文件（.protocol.py），像智能体一样管理
// 列表 / 新建 / 分类文件夹 / 文字搜索 / 删除 / 双击编辑源码（应用内代码编辑器）
import { useEffect, useMemo, useState } from 'react'
import { h, fmtTime } from '../lib/harness.js'
import CategoryModal from './CategoryModal.jsx'

export default function ProtocolPanel({ protocols, onReload, onToast, onCreate, onEdit, onDelete }) {
  const [creator, setCreator] = useState(null) // {name} 新建名弹窗
  const [cats, setCats] = useState({ list: [], map: {} })
  const [q, setQ] = useState('') // 文字搜索
  const [saving, setSaving] = useState(false)
  const [catModal, setCatModal] = useState(false)
  const [cardMenu, setCardMenu] = useState(null) // {p, x, y}

  // 加载分类列表
  useEffect(() => {
    h.protocols.categories().then(setCats).catch(() => {})
  }, [])

  const doCreate = async () => {
    if (!creator || saving) return
    const name = (creator.name || '').trim()
    if (!name) { onToast?.('协议名不能为空', 'error'); return }
    setSaving(true)
    try {
      await onCreate(name)
      setCreator(null)
      onToast?.(`协议「${name}」已创建，正在打开源码编辑器`, 'success')
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    } finally {
      setSaving(false)
    }
  }

  const doDelete = async (p) => {
    if (!confirm(`删除协议「${p.name}」？\n引用该协议的画布协议节点将失效。`)) return
    await onDelete(p.name)
  }

  const saveNewCategory = async (name) => {
    setCats(await h.protocols.addCategory(name))
    onToast?.(`分类「${name}」已创建`, 'success')
  }

  const deleteCategory = async (cat) => {
    if (!confirm(`删除分类文件夹「${cat}」？\n归到该分类的协议会移回「未分类」，协议本身不会被删除。`)) return
    try {
      setCats(await h.protocols.removeCategory(cat))
      onReload?.()
      onToast?.(`分类「${cat}」已删除`, 'success')
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const setProtoCategory = async (p, name) => {
    try {
      setCats(await h.protocols.setCategory(p.name, name))
      onReload?.()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  // 按分类分组 + 文字搜索过滤
  const kw = q.trim().toLowerCase()
  const groups = useMemo(() => {
    const filtered = protocols.filter((p) => !kw ||
      `${p.name} ${p.identity || ''} ${p.version || ''} ${p.desc || ''}`.toLowerCase().includes(kw))
    const map = new Map()
    for (const p of filtered) {
      const cat = (cats.map && cats.map[p.name]) || p.category || '未分类'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat).push(p)
    }
    for (const c of cats.list) {
      if (!map.has(c)) map.set(c, [])
    }
    return [...map.entries()].map(([cat, list]) => ({ cat, list }))
  }, [protocols, cats, kw])

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h2>协议</h2>
          <p className="panel-sub">
            协议是<strong>Python 代码文件</strong>（<code>.protocol.py</code>），像智能体一样<strong>双击编辑源码</strong>即可客制化。
            画布右键新建<strong>协议节点</strong>引用它，运行时作为智能体间通信网关：访问控制 → <code>[[A2A …]]</code> 信封 → 审计。
          </p>
        </div>
        <div className="panel-actions">
          <button className="btn" onClick={() => setCreator({ name: '' })}>＋ 新建协议</button>
          <button className="btn" onClick={() => setCatModal(true)} title="创建分类文件夹，把协议归类">📁 新建分类</button>
          <button className="btn ghost" onClick={onReload}>↻ 刷新</button>
        </div>
      </div>

      <div className="bulk-bar">
        <input
          className="input search-input"
          placeholder="🔍 搜索协议（名称 / 身份 / 版本）…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
        />
        <span className="bulk-count">{protocols.length} 个协议</span>
      </div>

      {protocols.length === 0 && (
        <div className="workspace-empty">
          <div className="empty-icon">🔐</div>
          <p>还没有协议</p>
          <button className="btn" onClick={() => setCreator({ name: '' })}>创建第一个协议</button>
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
                title="删除该分类文件夹（协议移回未分类）"
                onClick={() => deleteCategory(cat)}
              >🗑</button>
            )}
          </div>
          <div className="skill-list">
            {list.map((p) => (
              <div
                key={p.name}
                className="skill-card"
                onClick={() => onEdit(p.name)}
                onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCardMenu({ p, x: e.clientX, y: e.clientY }) }}
                title="点击编辑源码（右键管理）"
              >
                <div className="skill-card-head">
                  <span className="skill-card-title">🔐 {p.enabled === false ? '⏸ ' : ''}{p.name}</span>
                  <div className="session-actions">
                    <select
                      className="skill-cat-select"
                      title="协议分类文件夹"
                      value={(cats.map && cats.map[p.name]) || p.category || '未分类'}
                      onChange={(e) => {
                        const v = e.target.value
                        if (v === '__new__') { setCatModal(true) } else { setProtoCategory(p, v) }
                      }}
                      onClick={(e) => e.stopPropagation()}
                    >
                      {['未分类', ...cats.list.filter((c) => c !== '未分类')].map((c) => (
                        <option key={c} value={c}>{c}</option>
                      ))}
                      <option value="__new__">＋ 新建分类…</option>
                    </select>
                    <button className="mini-btn" title="编辑源码" onClick={(e) => { e.stopPropagation(); onEdit(p.name) }}>✎</button>
                    <button className="mini-btn danger" title="删除" onClick={(e) => { e.stopPropagation(); doDelete(p) }}>🗑</button>
                  </div>
                </div>
                <div className="skill-card-meta">
                  <code>{p.version || 'A2A/1.0'}</code> · 身份 <code>{p.identity || p.name}</code> · 更新于 {fmtTime(p.updatedAt)}
                </div>
                <div className="skill-card-desc" title={p.desc}>
                  {p.enabled === false ? '已停用 · ' : '运行中 · '}
                  允许 {Array.isArray(p.access?.allowedPeers) && p.access.allowedPeers.length ? `${p.access.allowedPeers.length} 个来源` : '不限制'} ·
                  拒绝 {Array.isArray(p.access?.deniedPeers) && p.access.deniedPeers.length ? `${p.access.deniedPeers.length} 个来源` : '无'} ·
                  审计 {p.audit === false ? '关' : '开'}
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* 新建协议：先取名字，创建后直接进源码编辑器 */}
      {creator && (
        <div className="modal-overlay" onClick={() => setCreator(null)}>
          <div className="modal small" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>🔐 新建协议</h2>
              <button className="icon-btn" onClick={() => setCreator(null)}>✕</button>
            </div>
            <div className="modal-body">
              <label className="field">
                <span className="field-label">协议名（也作为默认身份声明）</span>
                <input
                  className="input" autoFocus
                  placeholder="如: 内网协作协议"
                  value={creator.name}
                  onChange={(e) => setCreator((s) => ({ ...s, name: e.target.value }))}
                  onKeyDown={(e) => { if (e.key === 'Enter') doCreate() }}
                />
              </label>
              <div className="skill-card-desc">创建后自动打开源码编辑器（.protocol.py），可编辑身份 / 凭证 / 允许·拒绝来源 / 审计。</div>
            </div>
            <div className="modal-footer">
              <button className="btn ghost" onClick={() => setCreator(null)}>取消</button>
              <button className="btn primary" disabled={saving} onClick={doCreate}>{saving ? '创建中…' : '创建并编辑'}</button>
            </div>
          </div>
        </div>
      )}

      {/* 协议卡片右键菜单 */}
      {cardMenu && (
        <div className="mem-ctx-overlay" onClick={() => setCardMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCardMenu(null) }}>
          <div className="mem-ctx" style={{ left: cardMenu.x, top: cardMenu.y }}>
            <div className="mem-ctx-title">🔐 {cardMenu.p.name}</div>
            <button className="mem-ctx-item" onClick={() => { const p = cardMenu.p; setCardMenu(null); onEdit(p.name) }}>✎ 编辑源码</button>
            <button className="mem-ctx-item danger" onClick={() => { const p = cardMenu.p; setCardMenu(null); doDelete(p) }}>🗑 删除协议</button>
            <button className="mem-ctx-item" onClick={() => setCardMenu(null)}>取消</button>
          </div>
        </div>
      )}

      <CategoryModal
        open={catModal}
        title="新建分类文件夹"
        placeholder="如：通信协议 / 安全策略"
        onCreate={async (name) => { await saveNewCategory(name); setCatModal(false) }}
        onClose={() => setCatModal(false)}
      />
    </div>
  )
}
