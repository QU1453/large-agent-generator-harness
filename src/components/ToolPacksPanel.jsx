import { useEffect, useMemo, useState } from 'react'
import { h } from '../lib/harness.js'
import CategoryModal from './CategoryModal.jsx'

// 工具包面板（内部工具，旧名 MCP）：每个 .tool.js / .tool.py 文件是一个工具包
export default function ToolPacksPanel({ toolPacks, python, onReload, onToast, onCreate, onEdit, onDelete, onDeleteMany }) {
  const [selected, setSelected] = useState(new Set())
  const [cats, setCats] = useState({ list: [], map: {}, toolPackMap: {} })
  const [catModal, setCatModal] = useState(null) // null | {targetPackId?: string}
  const [q, setQ] = useState('') // 文字搜索
  const [cardMenu, setCardMenu] = useState(null) // {m, x, y}
  const [exts, setExts] = useState([]) // 外部 MCP（标准 MCP 协议）列表
  const [extModal, setExtModal] = useState(null) // 外部 MCP 新建/编辑弹窗 {item?, ...draft}
  const [extLoading, setExtLoading] = useState(false)

  // 加载外部 MCP 列表
  useEffect(() => {
    h.extMcps.list().then(setExts).catch(() => {})
  }, [])

  const reloadExts = async () => {
    setExtLoading(true)
    try {
      setExts(await h.extMcps.reload())
      if (onToast) onToast('外部 MCP 已重新连接', 'success')
    } catch (e) {
      if (onToast) onToast(e.message || String(e), 'error')
    } finally {
      setExtLoading(false)
    }
  }

  const openExtModal = (item) => {
    setExtModal(item ? {
      id: item.id,
      name: item.name || '',
      type: item.type || 'stdio',
      command: item.command || '',
      args: Array.isArray(item.args) ? item.args.join(' ') : (item.args || ''),
      url: item.url || '',
      enabled: item.enabled !== false
    } : { id: null, name: '', type: 'stdio', command: '', args: '', url: '', enabled: true })
  }

  const saveExt = async () => {
    if (!extModal) return
    const name = (extModal.name || '').trim()
    if (!name) { if (onToast) onToast('名称不能为空', 'error'); return }
    try {
      const payload = {
        name,
        type: extModal.type,
        command: (extModal.command || '').trim(),
        args: (extModal.args || '').trim().split(/\s+/).filter(Boolean),
        url: (extModal.url || '').trim(),
        enabled: extModal.enabled !== false
      }
      if (extModal.id) await h.extMcps.update(extModal.id, payload)
      else await h.extMcps.add(payload)
      setExts(await h.extMcps.list())
      setExtModal(null)
      if (onToast) onToast(extModal.id ? '外部 MCP 已更新' : '外部 MCP 已添加', 'success')
    } catch (e) {
      if (onToast) onToast(e.message || String(e), 'error')
    }
  }

  const deleteExt = async (item) => {
    if (!confirm(`删除外部 MCP「${item.name}」？`)) return
    try {
      setExts(await h.extMcps.delete(item.id))
      if (onToast) onToast(`外部 MCP「${item.name}」已删除`, 'success')
    } catch (e) {
      if (onToast) onToast(e.message || String(e), 'error')
    }
  }

  // 加载分类列表
  useEffect(() => {
    h.toolPacks.categories().then(setCats).catch(() => {})
  }, [])

  // 按分类分组 + 文字搜索过滤（工具默认分类来自界面设置，未分类归「未分类」；空分类也显示出来）
  const kw = q.trim().toLowerCase()
  const groups = useMemo(() => {
    const filtered = toolPacks.filter((m) => !kw ||
      `${m.name} ${m.id} ${m.description || ''} ${m.tools.map((t) => t.name).join(' ')} ${m.tools.map((t) => t.description || '').join(' ')}`.toLowerCase().includes(kw))
    const map = new Map()
    for (const m of filtered) {
      const cat = (cats.toolPackMap && cats.toolPackMap[m.id]) || (cats.mcpMap && cats.mcpMap[m.id]) || '未分类'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat).push(m)
    }
    for (const c of cats.list) {
      if (!map.has(c)) map.set(c, [])
    }
    return [...map.entries()].map(([cat, list]) => ({ cat, list }))
  }, [toolPacks, cats, kw])

  const saveNewCategory = async (name) => {
    await h.toolPacks.addCategory(name)
    if (catModal && catModal.targetPackId) {
      await h.toolPacks.setCategory(catModal.targetPackId, name)
    }
    setCats(await h.toolPacks.categories())
    onReload()
    if (onToast) onToast(`分类「${name}」已创建`, 'success')
  }

  // 删除分类文件夹（归到该分类的工具移回「未分类」，工具本身不删）
  const deleteCategory = async (cat) => {
    if (!confirm(`删除分类文件夹「${cat}」？\n归到该分类的工具会移回「未分类」，工具本身不会被删除。`)) return
    try {
      setCats(await h.toolPacks.removeCategory(cat))
      onReload()
      if (onToast) onToast(`分类「${cat}」已删除`, 'success')
    } catch (e) {
      alert(e.message)
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

  const allSelected = toolPacks.length > 0 && toolPacks.every((m) => selected.has(m.id))
  const toggleAll = () => {
    setSelected(allSelected ? new Set() : new Set(toolPacks.map((m) => m.id)))
  }

  const batchDelete = async () => {
    const ids = [...selected]
    if (!ids.length) return
    if (!confirm(`删除选中的 ${ids.length} 个工具？\n内置工具删除后重启应用会恢复。`)) return
    await onDeleteMany(ids)
    setSelected(new Set())
  }

  // Delete/Backspace 删除选中的工具（输入框中不触发）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const tag = (e.target && e.target.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (selected.size) {
        e.preventDefault()
        batchDelete()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected])

  return (
    <div className="panel">
      <div className="panel-header">
        <div>
          <h2>工具包</h2>
          <p className="panel-sub">
            工具包由<strong>代码文件</strong>定义（.tool.js / .tool.py，兼容旧 .mcp.*），每个文件是一个工具包，内含可被智能体调用的工具
          </p>
        </div>
        <div className="panel-actions">
          <button className="btn" onClick={() => onCreate('py')}>＋ Python 工具</button>
          <button className="btn" onClick={() => onCreate('js')}>＋ JS 工具</button>
          <button className="btn" onClick={() => openExtModal(null)} title="接入外部 MCP Server（标准 MCP 协议，如 GitHub MCP）">🌐 外部 MCP</button>
          <button className="btn" onClick={() => setCatModal({ targetPackId: null })} title="创建分类文件夹，把工具归类">📁 新建分类</button>
          <button className="btn ghost" onClick={onReload}>↻ 重载</button>
          {selected.size > 0 && (
            <button className="btn danger" onClick={batchDelete}>🗑 删除选中 ({selected.size})</button>
          )}
        </div>
      </div>

      {python && (
        <div className={`python-banner ${python.available ? 'ok' : 'warn'}`}>
          {python.available
            ? `✓ Python 引擎可用 (${python.version})，.py 工具已加载`
            : '⚠ 未检测到 Python。.py 工具需要嵌入式运行时（scripts/setup-python-runtime.ps1），或安装 Python 并加入 PATH'}
        </div>
      )}

      {toolPacks.length > 0 && (
        <div className="bulk-bar">
          <input
            className="input search-input"
            placeholder="🔍 搜索工具（名称 / 描述 / 工具名）…"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
          <label className="bulk-all">
            <input
              type="checkbox"
              checked={allSelected}
              onChange={toggleAll}
            />
            全选
          </label>
          <span className="bulk-count">{selected.size} / {toolPacks.length} 已选中</span>
          {selected.size > 0 && (
            <button className="bulk-clear" onClick={() => setSelected(new Set())}>取消选择</button>
          )}
        </div>
      )}

      {toolPacks.length === 0 && (
        <div className="mcp-grid">
          <div className="mcp-empty">暂无工具包，点击上方按钮开始</div>
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
                title="删除该分类文件夹（成员移回未分类）"
                onClick={() => deleteCategory(cat)}
              >🗑</button>
            )}
          </div>
          <div className="mcp-grid">
            {list.map((m) => (
              <div key={m.id} className={`mcp-card${selected.has(m.id) ? ' selected' : ''}`} onClick={() => onEdit(m.id)} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCardMenu({ m, x: e.clientX, y: e.clientY }) }} title="点击编辑源码（右键管理）">
                <div className="mcp-card-check">
                  <input
                    type="checkbox"
                    checked={selected.has(m.id)}
                    onChange={() => toggle(m.id)}
                    onClick={(e) => e.stopPropagation()}
                    title="选中以批量删除"
                  />
                </div>
                <div className="mcp-card-head">
                  <span className="mcp-icon">{m.kind === 'py' ? '🐍' : '🔧'}</span>
                  <div className="mcp-id">
                    <span className="mcp-name">{m.name}</span>
                    <code className="mcp-code">{m.id}</code>
                  </div>
                  <span className={`mcp-count ${m.kind === 'py' ? 'py' : ''}`}>{m.tools.length} 工具</span>
                </div>
                <p className="mcp-desc">{m.description}</p>
                <div className="mcp-tools">
                  {m.tools.map((t) => (
                    <div key={t.name} className="mcp-tool" title={t.description}>
                      <span className="mcp-tool-dot" />
                      <code className="mcp-tool-name">{t.name}</code>
                      <span className="mcp-tool-desc">{t.description}</span>
                    </div>
                  ))}
                </div>
                <div className="mcp-cat-row">
                  <select
                    className="mcp-cat-select"
                    value={(cats.toolPackMap && cats.toolPackMap[m.id]) || (cats.mcpMap && cats.mcpMap[m.id]) || '未分类'}
                    onClick={(e) => e.stopPropagation()}
                    onChange={async (e) => {
                      const v = e.target.value
                      if (v === '__new__') setCatModal({ targetPackId: m.id })
                      else {
                        try {
                          await h.toolPacks.setCategory(m.id, v)
                          setCats(await h.toolPacks.categories())
                          onReload()
                        } catch (err) {
                          alert(err.message)
                        }
                      }
                    }}
                  >
                    {['未分类', ...cats.list.filter((c) => c !== '未分类')].map((c) => (
                      <option key={c} value={c}>{c}</option>
                    ))}
                    <option value="__new__">＋ 新建分类…</option>
                  </select>
                </div>
                <div className="mcp-card-actions">
                  <button className="btn small" onClick={() => onEdit(m.id)}>✎ 编辑源码</button>
                  <button
                    className="btn small danger"
                    title="删除该工具包（内置工具删除后重启会恢复）"
                    onClick={() => {
                      if (confirm(`删除工具包「${m.name}」？\n内置工具删除后重启应用会恢复。`)) onDelete(m.id)
                    }}
                  >🗑 删除</button>
                </div>
              </div>
            ))}
          </div>
        </div>
      ))}

      {/* 外部 MCP（标准 MCP 协议）：独立分组 */}
      {exts.length > 0 && (
        <div className="agent-group">
          <div className="agent-group-title">
            <span className="agent-group-name">🌐 外部 MCP</span>
            <span className="agent-group-count">{exts.length}</span>
            <button className="mini-btn cat-del" title="重新连接全部外部 MCP" onClick={reloadExts}>{extLoading ? '连接中…' : '🔄'}</button>
          </div>
          <div className="mcp-grid">
            {exts.map((m) => (
              <div key={m.id} className={`mcp-card ext${m.enabled ? '' : ' disabled'}`} onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCardMenu({ m, x: e.clientX, y: e.clientY, isExt: true }) }} title="右键管理">
                <div className="mcp-card-check" />
                <div className="mcp-card-head">
                  <span className="mcp-icon">🌐</span>
                  <div className="mcp-id">
                    <span className="mcp-name">{m.name}</span>
                    <code className="mcp-code">{m.type === 'stdio' ? (m.command || 'stdio') : (m.url || 'http')}</code>
                  </div>
                  <span className={`mcp-count ${m.status === 'connected' ? 'py' : ''}`}>{m.status === 'connected' ? `已连接 ${m.tools.length} 工具` : m.status === 'disabled' ? '已停用' : '连接失败'}</span>
                </div>
                <p className="mcp-desc">{m.status === 'connected' ? `标准 MCP 协议 · ${m.tools.map((t) => t.name).join('、')}` : (m.error || (m.enabled ? '未连接' : '已停用'))}</p>
                <div className="mcp-card-actions">
                  <button className="btn small" onClick={() => openExtModal(m)}>✎ 编辑</button>
                  <button className="btn small danger" onClick={() => deleteExt(m)}>🗑 删除</button>
                </div>
              </div>
            ))}
          </div>
          <div className="hint-box">
            <strong>外部 MCP 说明</strong>
            <ul>
              <li>走<strong>标准 MCP 协议</strong>（JSON-RPC + initialize/tools/list/tools/call），与内部工具包（.tool.*）不同，可从外部导入现成 MCP Server</li>
              <li><strong>stdio</strong>：本地命令启动，如 <code>npx @modelcontextprotocol/server-github</code></li>
              <li><strong>http</strong>：远程 URL（Streamable HTTP），如 <code>http://127.0.0.1:37800/mcp/sse</code> 或 GitHub MCP 的远程端点</li>
              <li>外部工具以 <code>ext_</code> 前缀进入 LLM 工具列表，画布工具节点也可直接选择</li>
            </ul>
          </div>
        </div>
      )}

      {/* 工具卡片右键菜单 */}
      {cardMenu && (
        <div className="mem-ctx-overlay" onClick={() => setCardMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCardMenu(null) }}>
          <div className="mem-ctx" style={{ left: cardMenu.x, top: cardMenu.y }}>
            <div className="mem-ctx-title">🔧 {cardMenu.m.name}</div>
            {cardMenu.isExt ? (
              <>
                <button className="mem-ctx-item" onClick={() => { const m = cardMenu.m; setCardMenu(null); openExtModal(m) }}>✎ 编辑外部 MCP</button>
                <button className="mem-ctx-item" onClick={() => { setCardMenu(null); reloadExts() }}>🔄 重新连接</button>
                <button className="mem-ctx-item danger" onClick={() => { const m = cardMenu.m; setCardMenu(null); deleteExt(m) }}>🗑 删除外部 MCP</button>
              </>
            ) : (
              <>
                <button className="mem-ctx-item" onClick={() => { const m = cardMenu.m; setCardMenu(null); onEdit(m.id) }}>✎ 编辑源码</button>
                <button className="mem-ctx-item danger" onClick={() => { const m = cardMenu.m; setCardMenu(null); if (confirm(`删除工具包「${m.name}」？\n内置工具删除后重启应用会恢复。`)) onDelete(m.id) }}>🗑 删除工具</button>
              </>
            )}
            <button className="mem-ctx-item" onClick={() => setCardMenu(null)}>取消</button>
          </div>
        </div>
      )}

      {/* 外部 MCP 新建/编辑弹窗 */}
      {extModal && (
        <div className="modal-overlay" onClick={() => setExtModal(null)}>
          <div className="modal extmcp-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>🌐 {extModal.id ? '编辑外部 MCP' : '添加外部 MCP'}</h2>
              <button className="icon-btn" onClick={() => setExtModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <div className="agdef-row">
                <span className="agdef-label">名称</span>
                <input className="input" style={{ flex: 1 }} placeholder="如：GitHub MCP" value={extModal.name} onChange={(e) => setExtModal((d) => ({ ...d, name: e.target.value }))} />
              </div>
              <div className="agdef-row">
                <span className="agdef-label">类型</span>
                <select className="input" style={{ flex: 1 }} value={extModal.type} onChange={(e) => setExtModal((d) => ({ ...d, type: e.target.value }))}>
                  <option value="stdio">stdio（本地命令）</option>
                  <option value="http">http（远程 URL）</option>
                </select>
              </div>
              {extModal.type === 'stdio' ? (
                <>
                  <div className="agdef-row">
                    <span className="agdef-label">命令</span>
                    <input className="input" style={{ flex: 1 }} placeholder="npx @modelcontextprotocol/server-github" value={extModal.command} onChange={(e) => setExtModal((d) => ({ ...d, command: e.target.value }))} />
                  </div>
                  <div className="agdef-row">
                    <span className="agdef-label">参数</span>
                    <input className="input" style={{ flex: 1 }} placeholder="空格分隔，如 --port 3000（可留空）" value={extModal.args} onChange={(e) => setExtModal((d) => ({ ...d, args: e.target.value }))} />
                  </div>
                </>
              ) : (
                <div className="agdef-row">
                  <span className="agdef-label">URL</span>
                  <input className="input" style={{ flex: 1 }} placeholder="https://…/mcp 或 …/mcp/sse" value={extModal.url} onChange={(e) => setExtModal((d) => ({ ...d, url: e.target.value }))} />
                </div>
              )}
              <label className="model-inherit-row">
                <input type="checkbox" checked={extModal.enabled !== false} onChange={(e) => setExtModal((d) => ({ ...d, enabled: e.target.checked }))} />
                启用（启动时自动连接）
              </label>
              <div className="code-modal-hint">外部 MCP 走标准 MCP 协议，工具以 <code>ext_</code> 前缀进入 LLM 工具列表；保存后自动连接。</div>
            </div>
            <div className="modal-footer">
              <button className="btn" onClick={() => setExtModal(null)}>取消</button>
              <button className="btn primary" onClick={saveExt}>保存并连接</button>
            </div>
          </div>
        </div>
      )}

      <CategoryModal
        open={!!catModal}
        onCreate={saveNewCategory}
        onClose={() => setCatModal(null)}
      />

      <div className="hint-box">
        <strong>如何给智能体提供工具</strong>
        <ul>
          <li>在智能体源码的 <code>tools</code> 数组中引用：<code>tools: ['tool:工具名']</code>（兼容旧名 <code>'mcp:工具名'</code>）</li>
          <li>例如启用科学计算器：<code>tools: ['tool:py_eval', 'tool:py_solve']</code></li>
          <li><strong>JS 工具</strong>：handler 为 JS 函数，适合胶水/API 调用；<strong>Python 工具</strong>：handler 为 Python 函数，适合科学计算/数据分析（常驻进程执行）</li>
          <li>点击「编辑源码」在应用内修改，保存后自动重载，无需重启</li>
          <li>勾选卡片左上角复选框可多选，配合顶部「删除选中」批量管理；内置工具删除后重启会恢复</li>
        </ul>
      </div>
    </div>
  )
}
