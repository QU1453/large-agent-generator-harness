import { useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js'
import { fmtSize } from '../lib/harness.js'
import { Message, StreamBlock } from './ChatView.jsx'
import SearchSelect from './SearchSelect.jsx'
import InputGrip from './InputGrip.jsx'
import { PRESET_MODELS } from '../lib/models.js'

const joinRel = (dir, name) => (dir ? dir + '/' + name : name).replace(/\/+$/, '')
const parentOf = (p) => {
  const i = p.lastIndexOf('/')
  return i < 0 ? '' : p.slice(0, i)
}

// 按扩展名选择高亮语言
function langOf(p) {
  const e = String(p || '').split('.').pop().toLowerCase()
  const map = {
    py: 'python', python: 'python', js: 'javascript', jsx: 'javascript', ts: 'javascript',
    tsx: 'javascript', mjs: 'javascript', cjs: 'javascript', json: 'json', md: 'markdown',
    markdown: 'markdown', css: 'css', html: 'xml', htm: 'xml', xml: 'xml', svg: 'xml',
    yml: 'yaml', yaml: 'yaml', sh: 'bash', bash: 'bash', c: 'c', h: 'c', cpp: 'cpp',
    cc: 'cpp', hpp: 'cpp', java: 'java', go: 'go', rs: 'rust', sql: 'sql'
  }
  return map[e] || 'plaintext'
}

function FileNode({ node, depth, expanded, onToggle, onOpen, onNewFile, onNewDir, onRename, onDelete }) {
  const padding = { paddingLeft: depth * 14 + 8 }
  const isOpen = expanded.has(node.path)

  if (node.type === 'dir') {
    return (
      <div>
        <div
          className="tree-node dir"
          style={padding}
          onClick={() => onToggle(node.path)}
        >
          <span className="tree-caret">{isOpen ? '▾' : '▸'}</span>
          <span className="tree-icon">📁</span>
          <span className="tree-name">{node.name}</span>
          <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
            <button className="tree-act" title="新建文件" onClick={() => onNewFile(node.path)}>📄+</button>
            <button className="tree-act" title="新建文件夹" onClick={() => onNewDir(node.path)}>📁+</button>
            <button className="tree-act" title="重命名" onClick={() => onRename(node)}>✎</button>
            <button className="tree-act danger" title="删除" onClick={() => onDelete(node)}>🗑</button>
          </span>
        </div>
        {isOpen && node.children.map((c) => (
          <FileNode
            key={c.path}
            node={c}
            depth={depth + 1}
            expanded={expanded}
            onToggle={onToggle}
            onOpen={onOpen}
            onNewFile={onNewFile}
            onNewDir={onNewDir}
            onRename={onRename}
            onDelete={onDelete}
          />
        ))}
      </div>
    )
  }
  return (
    <div
      className="tree-node file"
      style={padding}
      onClick={() => onOpen(node.path)}
      title={node.path}
    >
      <span className="tree-caret" />
      <span className="tree-icon">📄</span>
      <span className="tree-name">{node.name}</span>
      <span className="tree-size">{node.size ? fmtSize(node.size) : ''}</span>
      <span className="tree-actions" onClick={(e) => e.stopPropagation()}>
        <button className="tree-act" title="重命名" onClick={() => onRename(node)}>✎</button>
        <button className="tree-act danger" title="删除" onClick={() => onDelete(node)}>🗑</button>
      </span>
    </div>
  )
}

export default function WorkspacePanel({ workspace, sandbox, sandboxes, memories, onOpen, onSwitchRoot, onSelect, onDelete, onRefresh, onToast }) {
  const [skills, setSkills] = useState([])
  const [agents, setAgents] = useState([])
  const [preview, setPreview] = useState(null) // {path, error}
  const [draft, setDraft] = useState('') // 当前可编辑内容
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [loading, setLoading] = useState(false)
  const [expanded, setExpanded] = useState(() => new Set())
  // 命名弹窗：{mode:'file'|'dir'|'rename', dirRel, node}
  const [nameBox, setNameBox] = useState(null)
  const [nameVal, setNameVal] = useState('')

  // ---- 底部工作区对话 ----
  const [chatCollapsed, setChatCollapsed] = useState(false)
  const [chatType, setChatType] = useState('skill')
  const [chatTarget, setChatTarget] = useState('')
  const [chatModel, setChatModel] = useState('')
  const [chatMemory, setChatMemory] = useState('')
  const [chatMessages, setChatMessages] = useState([])
  const [chatStreaming, setChatStreaming] = useState(null)
  const [chatInput, setChatInput] = useState('')
  const [chatSessionId, setChatSessionId] = useState('')
  const chatSessionIdRef = useRef('')
  const chatScrollRef = useRef(null)
  const chatStreamingRef = useRef(null)
  chatStreamingRef.current = chatStreaming

  const setWsSession = (id) => {
    setChatSessionId(id)
    chatSessionIdRef.current = id
  }

  // 默认展开根目录
  useEffect(() => {
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const n of (workspace?.tree || [])) {
        if (n.type === 'dir') next.add(n.path)
      }
      return next
    })
  }, [workspace?.root])

  // 工作区对话：拉取最新智能体/工作流列表 + 恢复当前 sandbox 的会话 + 订阅流式事件（挂载一次）
  useEffect(() => {
    window.harness.skills.list().then(setSkills).catch(() => {})
    window.harness.agents.list().then(setAgents).catch(() => {})
    const unToken = window.harness.chat.onToken(({ sessionId, content }) => {
      if (sessionId !== chatSessionIdRef.current) return
      setChatStreaming((s) => {
        if (s && s.sessionId === sessionId) return { ...s, content: s.content + content }
        return { sessionId, content, status: '正在思考…' }
      })
    })
    const unStatus = window.harness.chat.onStatus(({ sessionId, status }) => {
      if (sessionId !== chatSessionIdRef.current) return
      setChatStreaming((s) => (s && s.sessionId === sessionId ? { ...s, status } : s))
    })
    const unTool = window.harness.chat.onTool(({ sessionId, name, args }) => {
      if (sessionId !== chatSessionIdRef.current) return
      setChatStreaming((s) => (s && s.sessionId === sessionId ? { ...s, tool: { name, args } } : s))
    })
    const unDone = window.harness.chat.onDone(({ sessionId, content, trace }) => {
      if (sessionId !== chatSessionIdRef.current) return
      setChatStreaming((s) => (s && s.sessionId === sessionId ? null : s))
      if (content) {
        setChatMessages((ms) => [...ms, { role: 'assistant', content, ts: Date.now(), trace }])
      }
    })
    const unErr = window.harness.chat.onError(({ sessionId, error }) => {
      if (sessionId !== chatSessionIdRef.current) return
      setChatStreaming((s) => (s && s.sessionId === sessionId ? null : s))
      setChatMessages((ms) => [...ms, { role: 'error', content: error, ts: Date.now() }])
    })
    return () => { unToken(); unStatus(); unTool(); unDone(); unErr() }
  }, [])

  // 默认选中第一个目标
  useEffect(() => {
    if (!chatTarget) {
      if (chatType === 'agent' && agents.length) setChatTarget(agents[0].id)
      else if (chatType === 'skill' && skills.length) setChatTarget(skills[0].id)
    }
  }, [chatType, skills, agents, chatTarget])

  // 切换 sandbox：加载该工作区绑定的会话（每个 sandbox 独立聊天记录）
  // 有会话 → 以会话为准；无会话 → 恢复 sandbox 上持久化的模型/目标/记忆绑定（切走再回来保持一致）
  // 注意：sandbox prop 可能是旧快照，这里始终重新拉取最新 sandbox 记录（含 chatModel/memoryArch）
  useEffect(() => {
    const sid0 = sandbox && sandbox.id
    let cancelled = false
    if (!sid0) {
      setWsSession('')
      setChatStreaming(null)
      setChatMessages([])
      setChatModel('')
      return () => { cancelled = true }
    }
    ;(async () => {
      let sb = sandbox
      try {
        const all = await window.harness.workspace.sandboxes()
        const fresh = all.list.find((x) => x.id === sid0)
        if (fresh) sb = fresh
      } catch { /* 用 prop 兜底 */ }
      let s = null
      if (sb.sessionId) {
        try { s = await window.harness.sessions.get(sb.sessionId) } catch { s = null }
      }
      if (cancelled) return
      setWsSession(s ? s.id : '')
      setChatStreaming(null)
      setChatMessages(s ? (s.messages || []) : [])
      setChatType(s ? (s.targetType === 'agent' ? 'agent' : 'skill') : (sb.chatType || 'skill'))
      setChatTarget(s ? (s.targetType === 'agent' ? (s.targetId || '') : (s.skillId || '')) : (sb.chatTarget || ''))
      setChatModel(s ? (s.model || '') : (sb.chatModel || ''))
      setChatMemory(s ? (s.memoryArch || '') : (sb.memoryArch || ''))
    })()
    return () => { cancelled = true }
  }, [sandbox?.id])

  // ---- 工作区对话栏：会话级选择（智能体/记忆/模型）在「会话」页管理，此处只保留对话本身 ----

  // 对话滚动到底
  useEffect(() => {
    const el = chatScrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [chatMessages, chatStreaming?.content])

  const toggle = (path) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }

  const afterChange = async (parentPath) => {
    await onRefresh()
    if (parentPath != null) {
      setExpanded((prev) => { const next = new Set(prev); next.add(parentPath); return next })
    }
  }

  const openNameBox = (mode, dirRel, node = null) => {
    setNameVal(node ? node.name : '')
    setNameBox({ mode, dirRel, node })
  }

  const submitName = async () => {
    if (!nameBox) return
    const name = nameVal.trim()
    if (!name) { setNameBox(null); return }
    try {
      if (nameBox.mode === 'file') {
        await window.harness.workspace.write(joinRel(nameBox.dirRel, name), '')
        await afterChange(nameBox.dirRel)
        setNameBox(null)
      } else if (nameBox.mode === 'dir') {
        await window.harness.workspace.mkdir(joinRel(nameBox.dirRel, name))
        await afterChange(nameBox.dirRel)
        setNameBox(null)
      } else if (nameBox.mode === 'rename' && nameBox.node) {
        const newPath = joinRel(parentOf(nameBox.node.path), name)
        if (newPath !== nameBox.node.path) {
          await window.harness.workspace.rename(nameBox.node.path, newPath)
          setPreview((p) => (p && p.path === nameBox.node.path ? { ...p, path: newPath } : p))
          await afterChange(parentOf(newPath))
        }
        setNameBox(null)
      }
    } catch (e) {
      onToast?.('操作失败: ' + e.message, 'error')
    }
  }

  const removeNode = async (node) => {
    if (!confirm(`删除${node.type === 'dir' ? '文件夹' : '文件'}「${node.name}」？${node.type === 'dir' ? '\n（包含其下所有内容）' : ''}`)) return
    try {
      await window.harness.workspace.delete(node.path)
      setPreview((p) => (p && p.path === node.path ? null : p))
      setDirty(false)
      await afterChange(parentOf(node.path))
    } catch (e) {
      onToast?.('删除失败: ' + e.message, 'error')
    }
  }

  // ---- 内嵌编辑器 ----
  const openFile = async (rel) => {
    if (dirty && !confirm('当前文件有未保存的修改，切换将丢失。继续？')) return
    setLoading(true)
    try {
      const r = await window.harness.workspace.read(rel)
      setPreview({ path: rel, error: null })
      setDraft(r.content)
      setDirty(false)
    } catch (e) {
      setPreview({ path: rel, error: e.message })
      setDraft('')
      setDirty(false)
    } finally {
      setLoading(false)
    }
  }

  const handleEdit = (e) => {
    if (e.nativeEvent.isComposing) return
    setDraft(e.target.value)
    setDirty(true)
  }
  const handleCompositionEnd = (e) => {
    setDraft(e.target.value)
    setDirty(true)
  }

  const saveFile = async () => {
    if (!preview || !dirty || saving) return
    setSaving(true)
    try {
      const r = await window.harness.workspace.write(preview.path, draft)
      if (!r.ok) throw new Error('写入失败')
      setDirty(false)
      onToast?.('已保存 ' + preview.path, 'success')
      await onRefresh()
    } catch (e) {
      onToast?.('保存失败: ' + e.message, 'error')
    } finally {
      setSaving(false)
    }
  }

  const deletePreview = async () => {
    if (!preview || preview.error) return
    if (!confirm(`删除文件「${preview.path}」？`)) return
    try {
      await window.harness.workspace.delete(preview.path)
      setPreview(null)
      setDirty(false)
      await afterChange(parentOf(preview.path))
      onToast?.('已删除 ' + preview.path, 'success')
    } catch (e) {
      onToast?.('删除失败: ' + e.message, 'error')
    }
  }

  // 全局统一快捷键：Ctrl/Cmd+S 保存当前文件、Delete/Backspace 删除当前文件（输入框中不触发删除）
  const saveRef = useRef(saveFile)
  saveRef.current = saveFile
  const delRef = useRef(deletePreview)
  delRef.current = deletePreview
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        saveRef.current()
        return
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        const tag = (e.target && e.target.tagName || '').toLowerCase()
        if (tag === 'input' || tag === 'textarea' || tag === 'select') return
        e.preventDefault()
        delRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const lang = preview && !preview.error ? langOf(preview.path) : 'plaintext'
  const highlighted = useMemo(() => {
    const escapeHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    try {
      return hljs.highlight(draft, { language: lang }).value
    } catch {
      return escapeHtml(draft)
    }
  }, [draft, lang])

  // ---- 底部对话发送 ----
  // 会话级选择（工作流/智能体/记忆/模型）持久化到 sandbox，切走再回来保持一致
  const persistChat = async (patch) => {
    if (sandbox && sandbox.id) {
      try { await window.harness.workspace.sandboxSetChat(sandbox.id, patch) } catch { /* 忽略 */ }
    }
  }
  const changeChatType = (t) => {
    setChatType(t)
    const first = t === 'agent' ? (agents[0]?.id || '') : (skills[0]?.id || '')
    setChatTarget(first)
    persistChat({ type: t, target: first })
  }
  const changeChatTarget = (id) => {
    setChatTarget(id)
    persistChat({ target: id })
  }
  const changeChatModel = (m) => {
    setChatModel(m)
    persistChat({ model: m })
  }
  const changeChatMemory = async (name) => {
    setChatMemory(name || '')
    if (sandbox && sandbox.id) {
      try { await window.harness.workspace.sandboxSetMemoryArch(sandbox.id, name || '') } catch { /* 忽略 */ }
    }
    if (name) onToast?.(`已绑定记忆「${name}」`, 'success')
  }

  const targetItems = (chatType === 'agent' ? agents : skills).map((x) =>
    chatType === 'agent'
      ? { id: x.id, label: x.name, desc: '智能体 · 多技能编排', icon: '🌀', keywords: `智能体 编排 ${x.id}` }
      : { id: x.id, label: x.name, desc: x.description || x.id, icon: x.avatar || '🤖', keywords: `技能 ${x.id}` }
  )
  const memItems = [
    { id: '', label: '未绑定记忆', desc: '不绑定记忆架构', icon: '🧠' },
    ...(memories || []).map((m) => ({ id: m.name, label: m.title || m.name, desc: m.desc || m.name, icon: '🧠', keywords: `记忆 ${m.name}` }))
  ]

  const ensureWsSession = async () => {
    if (chatSessionIdRef.current) {
      const s = await window.harness.sessions.get(chatSessionIdRef.current)
      if (s) return s
    }
    const tt = chatType === 'agent' ? 'agent' : 'skill'
    const s = await window.harness.sessions.create({
      title: sandbox ? `工作区·${sandbox.name}` : '工作区对话',
      skillId: skills[0]?.id || 'assistant',
      targetType: tt,
      targetId: tt === 'agent' ? (chatTarget || null) : (chatTarget || skills[0]?.id || null),
      model: chatModel || ''
    })
    if (chatMemory) {
      try { await window.harness.sessions.setMemoryArch(s.id, chatMemory) } catch { /* 忽略 */ }
    }
    setWsSession(s.id)
    // 绑定到当前 sandbox：该工作区的聊天记录独立持久化
    if (sandbox && sandbox.id) {
      try { await window.harness.workspace.sandboxSetSession(sandbox.id, s.id) } catch { /* 忽略绑定失败 */ }
    }
    return s
  }

  const wsSend = async () => {
    const text = chatInput.trim()
    if (!text || chatStreamingRef.current) return
    const tt = chatType === 'agent' ? 'agent' : 'skill'
    const tid = tt === 'agent' ? chatTarget : (chatTarget || skills[0]?.id || '')
    if (!tid) {
      onToast?.(tt === 'agent' ? '请先选择智能体' : '请先选择技能', 'error')
      return
    }
    const sess = await ensureWsSession()
    const sid = sess.id
    if (sess.targetType !== tt || sess.targetId !== tid) {
      await window.harness.sessions.setTarget(sid, tt, tid)
    }
    if (chatModel && chatModel !== (sess.model || '')) {
      await window.harness.sessions.setModel(sid, chatModel)
    }
    if ((chatMemory || '') !== (sess.memoryArch || '')) {
      await window.harness.sessions.setMemoryArch(sid, chatMemory || '')
    }
    setChatMessages((ms) => [...ms, { role: 'user', content: text, ts: Date.now() }])
    setChatInput('')
    setChatStreaming({ sessionId: sid, content: '', status: '正在思考…' })
    try {
      await window.harness.chat.send({
        skillId: sess.skillId || skills[0]?.id,
        sessionId: sid,
        message: text,
        targetType: tt,
        targetId: tt === 'agent' ? tid : (sess.skillId || tid)
      })
    } catch (e) {
      setChatStreaming((s) => (s && s.sessionId === sid ? null : s))
      onToast?.('发送失败: ' + e.message, 'error')
    }
  }

  const isStreaming = !!chatStreaming

  return (
    <div className="panel workspace-panel">
      <div className="panel-header">
        <div>
          <h2>工作区</h2>
          <p className="panel-sub">
            {workspace ? `当前：${sandbox?.name || workspace.name}（${workspace.root}）` : '打开一个文件夹，智能体即可读写其中的文件'}
          </p>
        </div>
        <div className="panel-actions">
          {sandboxes && sandboxes.length > 1 && (
            <SearchSelect
              className="ws-switch-select"
              items={sandboxes.map((s) => ({ id: s.id, label: s.name, desc: s.root, icon: '📁', keywords: `工作区 ${s.id} ${s.root}` }))}
              value={sandbox?.id || ''}
              onChange={(id) => onSelect && onSelect(id)}
              placeholder="🔍 搜索工作区…"
              empty="无匹配工作区"
            />
          )}
          {workspace ? (
            <>
              <button className="btn" onClick={onOpen} title="再新建一个工作区">＋ 新建</button>
              <button className="btn" onClick={onSwitchRoot} title="把当前工作区切换到其他文件夹">切换文件夹</button>
              <button className="btn danger" onClick={() => onDelete && sandbox && onDelete(sandbox.id)} title="删除当前工作区（不影响文件夹）">🗑 删除</button>
            </>
          ) : (
            <button className="btn" onClick={onOpen}>打开文件夹</button>
          )}
          {workspace && <button className="btn ghost" onClick={onRefresh} title="刷新文件树">↻</button>}
        </div>
      </div>

      {!workspace ? (
        <div className="workspace-empty">
          <div className="empty-icon">📁</div>
          <p>尚未打开工作区</p>
          <button className="btn" onClick={onOpen}>选择文件夹</button>
        </div>
      ) : (
        <div className="workspace-body">
          <div className="file-tree">
            <div className="file-tree-title">{workspace.name}/</div>
            <div className="file-tree-scroll">
              {workspace.tree.map((n) => (
                <FileNode
                  key={n.path}
                  node={n}
                  depth={0}
                  expanded={expanded}
                  onToggle={toggle}
                  onOpen={openFile}
                  onNewFile={(dir) => openNameBox('file', dir)}
                  onNewDir={(dir) => openNameBox('dir', dir)}
                  onRename={(node) => openNameBox('rename', parentOf(node.path), node)}
                  onDelete={removeNode}
                />
              ))}
            </div>
          </div>
          <div className="file-preview">
            {preview ? (
              <>
                <div className="preview-header">
                  <div className="preview-title">
                    <code>{preview.path}</code>
                    {dirty && <span className="editor-dirty">● 未保存</span>}
                  </div>
                  <div className="preview-actions">
                    <button
                      className="btn small ghost"
                      title="用系统默认程序打开"
                      onClick={() => window.harness.workspace.openFile(preview.path)}
                    >外部打开</button>
                    <button
                      className={`btn small primary ${dirty ? '' : 'disabled'}`}
                      onClick={saveFile}
                      disabled={!dirty || saving}
                    >{saving ? '保存中…' : '💾 保存'}</button>
                  </div>
                </div>
                {preview.error ? (
                  <div className="preview-error">⚠️ {preview.error}</div>
                ) : (
                  <div className="editor-wrap ws-editor-wrap">
                    <div className="code-editor native">
                      <pre
                        className="code-highlight"
                        aria-hidden="true"
                        dangerouslySetInnerHTML={{ __html: highlighted + '\n' }}
                      />
                      <textarea
                        className="code-input"
                        value={draft}
                        onChange={handleEdit}
                        onCompositionEnd={handleCompositionEnd}
                        spellCheck={false}
                        autoCapitalize="off"
                        autoComplete="off"
                        autoCorrect="off"
                        data-gramm={false}
                        placeholder="文件内容…（Ctrl+S 保存 · Delete 删除）"
                      />
                    </div>
                  </div>
                )}
              </>
            ) : (
              <div className="preview-empty">点击左侧文件查看 / 编辑内容</div>
            )}
            {loading && <div className="preview-loading">加载中…</div>}
          </div>
        </div>
      )}

      {/* 底部工作区对话：输入在下方、对话竖栏在上的聊天窗 */}
      <div className={`ws-chat${chatCollapsed ? ' collapsed' : ''}`}>
        <div className="ws-chat-header">
          <button
            className="ws-chat-toggle"
            title={chatCollapsed ? '展开对话' : '收起对话'}
            onClick={() => setChatCollapsed(!chatCollapsed)}
          >{chatCollapsed ? '▴' : '▾'}</button>
          <span className="ws-chat-title">💬 工作区对话</span>
          <div className="ws-chat-sel-row">
            <div className="ws-chat-type-toggle">
              <button
                className={`mini-btn${chatType === 'skill' ? ' on' : ''}`}
                title="与技能对话"
                onClick={() => changeChatType('skill')}
              >🤖 技能</button>
              <button
                className={`mini-btn${chatType === 'agent' ? ' on' : ''}`}
                title="与智能体（编排）对话"
                onClick={() => changeChatType('agent')}
              >🌀 智能体</button>
            </div>
            <SearchSelect
              className="ws-chat-target"
              items={targetItems}
              value={chatTarget}
              onChange={changeChatTarget}
              placeholder={chatType === 'agent' ? '🔍 智能体…' : '🔍 技能…'}
              empty="无匹配项"
            />
            <SearchSelect
              className="ws-chat-select"
              items={memItems}
              value={chatMemory}
              onChange={changeChatMemory}
              placeholder="🧠 记忆"
              empty="无匹配记忆"
            />
            <input
              className="input ws-chat-model"
              list="preset-models-ws"
              placeholder="模型·默认"
              title="本会话模型覆盖，留空跟随默认"
              value={chatModel}
              onChange={(e) => setChatModel(e.target.value)}
              onBlur={(e) => changeChatModel(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
            />
            <datalist id="preset-models-ws">
              {PRESET_MODELS.map((m) => <option key={m} value={m} />)}
            </datalist>
          </div>
          <span className="ws-chat-state">{isStreaming ? '● 生成中' : `${chatMessages.length} 条消息`}</span>
        </div>
        {!chatCollapsed && (
          <>
            <div className="ws-chat-messages" ref={chatScrollRef}>
              {chatMessages.length === 0 && !isStreaming && (
                <div className="ws-chat-empty">
                  选择左上角目标后输入内容，与技能 / 智能体对话
                  <br />对话可读写工作区文件，AI 结果即时回显在此栏
                </div>
              )}
              {chatMessages.map((m, i) => <Message key={i} m={m} />)}
              {isStreaming && <StreamBlock streaming={chatStreaming} />}
            </div>
            <div className="ws-chat-input-row">
              <div className="ws-chat-input-col">
                <InputGrip maxH={240} />
                <textarea
                  className="ws-chat-input"
                  placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
                  value={chatInput}
                  rows={Math.min(4, Math.max(1, chatInput.split('\n').length))}
                  onChange={(e) => setChatInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault()
                      wsSend()
                    }
                  }}
                />
              </div>
              <button
                className={`btn primary ${isStreaming ? 'disabled' : ''}`}
                onClick={wsSend}
                disabled={isStreaming}
              >{isStreaming ? '生成中…' : '发送'}</button>
            </div>
          </>
        )}
      </div>

      {/* 新建/重命名 命名弹窗 */}
      {nameBox && (
        <div className="modal-overlay" onClick={() => setNameBox(null)}>
          <div className="modal small" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>
                {nameBox.mode === 'file' ? '新建文件' : nameBox.mode === 'dir' ? '新建文件夹' : '重命名'}
              </h2>
              <button className="icon-btn" onClick={() => setNameBox(null)}>✕</button>
            </div>
            <div className="modal-body">
              <label className="field">
                <span className="field-label">名称</span>
                <input
                  className="input"
                  autoFocus
                  value={nameVal}
                  placeholder={nameBox.mode === 'dir' ? '文件夹名' : nameBox.mode === 'file' ? '文件名' : '新名称'}
                  onChange={(e) => setNameVal(e.target.value)}
                  onKeyDown={(e) => { if (e.key === 'Enter') submitName() }}
                />
              </label>
            </div>
            <div className="modal-footer">
              <button className="btn ghost" onClick={() => setNameBox(null)}>取消</button>
              <button className="btn primary" onClick={submitName}>确定</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
