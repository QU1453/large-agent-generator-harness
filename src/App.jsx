import { Component, useCallback, useEffect, useRef, useState } from 'react'
import Sidebar from './components/Sidebar.jsx'
import ChatView from './components/ChatView.jsx'
import SkillPanel from './components/SkillPanel.jsx'
import ToolPacksPanel from './components/ToolPacksPanel.jsx'
import AgentPanel from './components/AgentPanel.jsx'
import AgentAdmin from './components/AgentAdmin.jsx'
import WorkspacePanel from './components/WorkspacePanel.jsx'
import MemoryPanel from './components/MemoryPanel.jsx'
import TeamPanel from './components/TeamPanel.jsx'
import TerminalPanel from './components/TerminalPanel.jsx'
import SettingsModal from './components/SettingsModal.jsx'
import CodeEditor from './components/CodeEditor.jsx'
import { h } from './lib/harness.js'

// 错误边界：渲染出错时显示错误信息而不是整屏黑屏
class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { err: null }
  }
  static getDerivedStateFromError(err) {
    return { err }
  }
  render() {
    if (this.state.err) {
      return (
        <div className="fatal-error">
          <div className="fatal-error-box">
            <h3>界面渲染出错</h3>
            <pre>{String((this.state.err && (this.state.err.message || this.state.err)) || '未知错误')}</pre>
            <button className="btn primary" onClick={() => location.reload()}>重新加载</button>
          </div>
        </div>
      )
    }
    return this.props.children
  }
}

export default function App() {
  const [settings, setSettings] = useState({})
  const [skills, setSkills] = useState([])
  const [toolPacks, setToolPacks] = useState([])
  const [agents, setAgents] = useState([])
  const [memories, setMemories] = useState([])
  const [pyStatus, setPyStatus] = useState(null)
  const [sessions, setSessions] = useState([])
  const [sessionMap, setSessionMap] = useState({}) // id -> 完整会话
  const [activeId, setActiveId] = useState(null)
  const [view, setView] = useState('chat')
  const [workspace, setWorkspace] = useState(null)
  const [sandboxes, setSandboxes] = useState([]) // 多工作区 sandbox 列表
  const [activeSandbox, setActiveSandbox] = useState(null) // 当前 sandbox
  const [apiStatus, setApiStatus] = useState({ running: false })
  const [showSettings, setShowSettings] = useState(false)
  const [editor, setEditor] = useState(null) // {kind:'skill'|'toolPack', id, file?}
  const [streaming, setStreaming] = useState(null) // {sessionId, content, status, tool}
  const [toast, setToast] = useState(null)
  // 侧栏宽度（可拖拽边框调整，localStorage 持久化）
  const [sidebarW, setSidebarW] = useState(() => {
    try { const v = Number(localStorage.getItem('app-sidebar-w')); return v >= 180 && v <= 420 ? v : 256 } catch { return 256 }
  })

  const startSidebarDrag = (e) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = sidebarW
    let w = startW
    const el = e.currentTarget
    el.classList.add('dragging')
    const move = (ev) => {
      w = Math.min(420, Math.max(180, startW + (ev.clientX - startX)))
      setSidebarW(w)
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
      el.classList.remove('dragging')
      try { localStorage.setItem('app-sidebar-w', String(w)) } catch { /* 忽略 */ }
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }

  const sessionMapRef = useRef(sessionMap)
  sessionMapRef.current = sessionMap
  const toastTimer = useRef(null)

  const showToast = useCallback((msg, type = 'info') => {
    setToast({ msg, type })
    clearTimeout(toastTimer.current)
    toastTimer.current = setTimeout(() => setToast(null), 2600)
  }, [])

  // 更新某个会话（避免闭包过期）
  const mergeIntoSession = useCallback((sessionId, updater) => {
    setSessionMap((prev) => {
      const s = prev[sessionId]
      if (!s) return prev
      return { ...prev, [sessionId]: updater(s) }
    })
  }, [])

  // 初始化
  useEffect(() => {
    ;(async () => {
      try {
        const [st, sk, ss, ws, api, mp, ag, sbx, mem] = await Promise.all([
          h.settings.get(),
          h.skills.list(),
          h.sessions.list(),
          h.workspace.get(),
          h.api.status(),
          h.toolPacks.list(),
          h.agents.list(),
          h.workspace.sandboxes(),
          h.memory.list()
        ])
        setSettings(st)
        setSkills(sk)
        setToolPacks(mp.toolPacks)
        setAgents(ag)
        setMemories(mem)
        setPyStatus(mp.python)
        setSessions(ss)
        setWorkspace(ws)
        setSandboxes(sbx.list || [])
        setActiveSandbox(sbx.active ? (sbx.list || []).find((s) => s.id === sbx.active) || null : null)
        setApiStatus(api)
        if (ss.length) {
          setActiveId(ss[0].id)
          const full = await h.sessions.get(ss[0].id)
          setSessionMap((p) => ({ ...p, [ss[0].id]: full }))
        }
      } catch (e) {
        showToast('初始化失败: ' + e.message, 'error')
      }
    })()
    // 流式事件订阅
    const unToken = h.chat.onToken(({ sessionId, content }) => {
      setStreaming((s) => (s && s.sessionId === sessionId ? { ...s, content: s.content + content } : s))
    })
    const unStatus = h.chat.onStatus(({ sessionId, status }) => {
      setStreaming((s) => (s && s.sessionId === sessionId ? { ...s, status } : s))
    })
    const unTool = h.chat.onTool(({ sessionId, name, args }) => {
      setStreaming((s) => (s && s.sessionId === sessionId ? { ...s, tool: { name, args } } : s))
    })
    const unDone = h.chat.onDone(({ sessionId, content, aborted, trace }) => {
      setStreaming((s) => (s && s.sessionId === sessionId ? null : s))
      if (content) {
        mergeIntoSession(sessionId, (s) => ({
          ...s,
          messages: [...s.messages, { role: 'assistant', content, ts: Date.now(), trace }]
        }))
      }
    })
    const unErr = h.chat.onError(({ sessionId, error }) => {
      setStreaming((s) => (s && s.sessionId === sessionId ? null : s))
      mergeIntoSession(sessionId, (s) => ({
        ...s,
        messages: [
          ...s.messages,
          { role: 'error', content: error, ts: Date.now() }
        ]
      }))
      showToast(error, 'error')
    })
    return () => {
      unToken(); unStatus(); unTool(); unDone(); unErr()
    }
  }, [showToast, mergeIntoSession])

  const refreshSessions = useCallback(async () => {
    setSessions(await h.sessions.list())
  }, [])

  // 进入记忆页时刷新记忆列表（绑定选择器 / 侧栏计数用最新数据）
  useEffect(() => {
    if (view === 'memory') h.memory.list().then(setMemories).catch(() => {})
  }, [view])

  const selectSession = useCallback(async (id) => {
    setActiveId(id)
    if (!sessionMapRef.current[id]) {
      const full = await h.sessions.get(id)
      setSessionMap((p) => ({ ...p, [id]: full }))
    }
    setView('chat')
  }, [])

  const createSession = useCallback(async (targetType, targetId) => {
    const tt = targetType === 'agent' ? 'agent' : 'skill'
    const skillId = skills[0]?.id || 'assistant'
    const s = await h.sessions.create({
      skillId: tt === 'skill' ? (targetId || skillId) : skillId,
      targetType: tt,
      targetId: tt === 'skill' ? (targetId || skillId) : (targetId || null)
    })
    setSessionMap((p) => ({ ...p, [s.id]: s }))
    setActiveId(s.id)
    setView('chat')
    await refreshSessions()
  }, [skills, refreshSessions])

  const deleteSession = useCallback(async (id) => {
    await h.sessions.delete(id)
    await refreshSessions()
    if (activeId === id) {
      const list = sessions.filter((s) => s.id !== id)
      if (list.length) {
        const next = list[0].id
        setActiveId(next)
        const full = await h.sessions.get(next)
        setSessionMap((p) => ({ ...p, [next]: full }))
      } else {
        setActiveId(null)
      }
    }
  }, [activeId, sessions, refreshSessions])

  const renameSession = useCallback(async (id, title) => {
    const s = await h.sessions.rename(id, title)
    if (s) {
      mergeIntoSession(id, (cur) => ({ ...cur, title }))
      await refreshSessions()
    }
  }, [refreshSessions, mergeIntoSession])

  const changeTarget = useCallback(async (id, targetType, targetId) => {
    const s = await h.sessions.setTarget(id, targetType, targetId)
    if (s) {
      mergeIntoSession(id, (cur) => ({ ...cur, targetType: s.targetType, targetId: s.targetId }))
      await refreshSessions()
    }
  }, [refreshSessions, mergeIntoSession])

  const changeModel = useCallback(async (id, model) => {
    const s = await h.sessions.setModel(id, model)
    if (s) {
      mergeIntoSession(id, (cur) => ({ ...cur, model: s.model }))
      await refreshSessions()
    }
  }, [refreshSessions, mergeIntoSession])

  const changeSandbox = useCallback(async (id, sandboxId) => {
    const s = await h.sessions.setSandbox(id, sandboxId)
    if (s) {
      mergeIntoSession(id, (cur) => ({ ...cur, sandboxId: s.sandboxId }))
      await refreshSessions()
    }
  }, [refreshSessions, mergeIntoSession])

  const changeMemoryArch = useCallback(async (id, archName) => {
    const s = await h.sessions.setMemoryArch(id, archName || '')
    if (s) {
      mergeIntoSession(id, (cur) => ({ ...cur, memoryArch: s.memoryArch, boundAt: s.boundAt, lastArchMtime: s.lastArchMtime }))
      await refreshSessions()
      showToast(archName ? `已绑定记忆「${archName}」（锁定）` : '已解除记忆绑定', 'success')
    }
  }, [refreshSessions, mergeIntoSession, showToast])

  const sendMessage = useCallback(
    async (text) => {
      const msg = String(text || '').trim()
      if (!msg) return
      let session = sessionMapRef.current[activeId]
      if (!session) {
        const skillId = skills[0]?.id || 'assistant'
        session = await h.sessions.create({ title: msg.slice(0, 24), skillId, targetType: 'skill', targetId: skillId })
        setSessionMap((p) => ({ ...p, [session.id]: session }))
        setActiveId(session.id)
        await refreshSessions()
      }
      const sid = session.id
      const targetType = session.targetType === 'agent' ? 'agent' : 'skill'
      mergeIntoSession(sid, (s) => ({
        ...s,
        messages: [...s.messages, { role: 'user', content: msg, ts: Date.now() }]
      }))
      setStreaming({ sessionId: sid, content: '', status: '正在思考…' })
      try {
        await h.chat.send({
          skillId: session.skillId,
          sessionId: sid,
          message: msg,
          targetType,
          targetId: targetType === 'agent' ? (session.targetId || null) : session.skillId
        })
      } catch (e) {
        showToast(e.message, 'error')
      }
    },
    [activeId, skills, mergeIntoSession, refreshSessions, showToast]
  )

  const stopChat = useCallback(() => {
    if (streaming) h.chat.stop(streaming.sessionId)
  }, [streaming])

  const openWorkspace = useCallback(async () => {
    const r = await h.workspace.sandboxCreate()
    if (!r || !r.ok) return null
    setActiveSandbox(r.sandbox)
    setSandboxes((await h.workspace.sandboxes()).list)
    setWorkspace(await h.workspace.get())
    setView('workspace')
    return r.sandbox
  }, [])

  const selectSandbox = useCallback(async (id) => {
    const r = await h.workspace.sandboxSelect(id)
    if (r.ok) {
      setActiveSandbox(r.sandbox)
      setSandboxes((await h.workspace.sandboxes()).list)
      setWorkspace(await h.workspace.get())
      setView('workspace')
    }
  }, [])

  const deleteSandbox = useCallback(async (id) => {
    if (!confirm('删除该工作区？文件夹本身不会被删除，仅移除列表记录。')) return
    const r = await h.workspace.sandboxDelete(id)
    if (r.ok) {
      setSandboxes(r.list.list)
      setActiveSandbox(r.list.list.find((s) => s.id === r.list.active) || null)
      setWorkspace(await h.workspace.get())
      setView('workspace')
    }
  }, [])

  // 切换当前工作区的根目录（不新建条目）
  const switchSandboxRoot = useCallback(async () => {
    if (!activeSandbox) return null
    const r = await h.workspace.sandboxSetRoot(activeSandbox.id)
    if (!r || !r.ok) return null
    setActiveSandbox(r.sandbox)
    setSandboxes((await h.workspace.sandboxes()).list)
    setWorkspace(await h.workspace.get())
    showToast(`已切换到 ${r.sandbox.name}`, 'success')
    return r.sandbox
  }, [activeSandbox, showToast])

  const saveSettings = useCallback(async (patch) => {
    const next = await h.settings.set(patch)
    setSettings(next)
    setApiStatus(await h.api.status())
    setShowSettings(false)
    showToast('设置已保存', 'success')
  }, [showToast])

  const toggleApi = useCallback(async () => {
    const st = await h.api.toggle()
    setApiStatus(st)
  }, [])

  // 团队启停后刷新侧栏运行指示（团队服务 = API 服务绑定 0.0.0.0）
  const refreshApiStatus = useCallback(async () => {
    try {
      setApiStatus(await h.api.status())
    } catch { /* 忽略 */ }
  }, [])

  const activeSession = activeId ? sessionMap[activeId] || null : null

  // 智能体运行状态（全局）：切页不停止运行，侧栏/面板显示转圈；运行期节点状态也全局保存，
  // 切到别处再回来时 AgentPanel 能恢复"运行中"与各节点状态
  const [agRunning, setAgRunning] = useState(false)
  const [agRunStates, setAgRunStates] = useState({})
  const [agNodeOutputs, setAgNodeOutputs] = useState({})
  useEffect(() => {
    const unStatus = h.agents.onStatus((p) => {
      if (p && p.nodeId) {
        setAgRunStates((s) => ({ ...s, [p.nodeId]: { status: p.status, error: p.error } }))
      }
      setAgRunning(true)
    })
    const unOutput = h.agents.onOutput((p) => {
      if (p && p.nodeId != null) {
        setAgNodeOutputs((s) => ({ ...s, [p.nodeId]: p.output }))
      }
      setAgRunning(true)
    })
    const unDone = h.agents.onDone(() => setAgRunning(false))
    return () => { unStatus(); unOutput(); unDone() }
  }, [])

  // 壁纸：应用到整个应用底层，内容区（聊天/画布）半透明透出
  const wp = settings.wallpaper
  const hasWallpaper = !!(wp && wp.type !== 'none' && wp.value)
  let wallpaperStyle = null
  if (wp && wp.type === 'image' && wp.value) {
    const url = 'file:///' + String(wp.value).replace(/\\/g, '/')
    wallpaperStyle = { backgroundImage: `url("${url}")`, backgroundSize: 'cover', backgroundPosition: 'center', backgroundAttachment: 'fixed' }
  } else if (hasWallpaper) {
    wallpaperStyle = { background: wp.value }
  }

  return (
    <ErrorBoundary>
      <div className={`app${hasWallpaper ? ' has-wallpaper' : ''}`} style={{ ...wallpaperStyle, '--sidebar-w': `${sidebarW}px` }}>
      <Sidebar
        view={view}
        setView={setView}
        sessions={sessions}
        activeId={activeId}
        skills={skills}
        agents={agents}
        toolPacks={toolPacks}
        workspace={workspace}
        sandboxes={sandboxes}
        activeSandbox={activeSandbox}
        agRunning={agRunning}
        apiStatus={apiStatus}
        memoryCount={memories.length}
        onSelectSession={selectSession}
        onCreateSession={createSession}
        onDeleteSession={deleteSession}
        onRenameSession={renameSession}
        onSelectSandbox={selectSandbox}
        onCreateSandbox={openWorkspace}
        onDeleteSandbox={deleteSandbox}
        onOpenSettings={() => setShowSettings(true)}
      />
      <div className="sidebar-splitter" title="拖动调整侧栏宽度" onMouseDown={startSidebarDrag} />

      <main className="main">
        {view === 'chat' && (
          <ChatView
              session={activeSession}
              skills={skills}
              agents={agents}
              memories={memories}
              sandboxes={sandboxes}
              streaming={streaming}
              workspace={workspace}
              onSend={sendMessage}
              onStop={stopChat}
              onChangeTarget={changeTarget}
              onChangeModel={changeModel}
              onChangeSandbox={changeSandbox}
              onChangeMemoryArch={changeMemoryArch}
              onOpenWorkspace={openWorkspace}
              onCreateSession={createSession}
            />
        )}
        {view === 'skills' && (
          <SkillPanel
            skills={skills}
            onToast={showToast}
            onChanged={async () => setSkills(await h.skills.list())}
          />
        )}
        {view === 'memory' && (
          <MemoryPanel onToast={showToast} />
        )}
        {view === 'team' && (
          <TeamPanel
              onToast={showToast}
              skillCount={skills.length}
              agentCount={agents.length}
              memoryCount={memories.length}
              mcpCount={toolPacks.length}
              onStatusChange={refreshApiStatus}
              onNavigate={setView}
            />
        )}
        {view === 'toolPacks' && (
          <ToolPacksPanel
            toolPacks={toolPacks}
            python={pyStatus}
            onReload={async () => {
              const r = await h.toolPacks.reload()
              setToolPacks(r.toolPacks)
              setPyStatus(r.python)
              showToast('工具已重载', 'success')
            }}
            onToast={showToast}
            onCreate={async (type) => {
              const r = await h.toolPacks.create(type)
              setToolPacks(r.toolPacks)
              setEditor({ kind: 'toolPack', id: r.id, file: r.file })
              showToast(type === 'py' ? '已创建 Python 工具' : '已创建 JS 工具', 'success')
            }}
            onEdit={(id) => setEditor({ kind: 'toolPack', id })}
            onDelete={async (id) => {
              try {
                const r = await h.toolPacks.delete(id)
                setToolPacks(r.toolPacks)
                showToast('工具已删除', 'success')
              } catch (e) {
                showToast(e.message, 'error')
              }
            }}
            onDeleteMany={async (ids) => {
              try {
                const r = await h.toolPacks.deleteMany(ids)
                setToolPacks(r.toolPacks)
                showToast(`已删除 ${ids.length} 个工具`, 'success')
              } catch (e) {
                showToast(e.message, 'error')
              }
            }}
          />
        )}
        {view === 'workflows' && (
          <AgentPanel
            skills={skills}
            agRunning={agRunning}
            agRunStates={agRunStates}
            agNodeOutputs={agNodeOutputs}
            onRunStart={() => { setAgRunning(true); setAgRunStates({}); setAgNodeOutputs({}) }}
            onToast={showToast}
            onEditSkill={(id) => setEditor({ kind: 'skill', id })}
            onEditMcp={(id) => setEditor({ kind: 'toolPack', id })}
          />
        )}
        {view === 'agents' && (
          <AgentAdmin
            skills={skills}
            onToast={showToast}
          />
        )}
        {view === 'workspace' && (
          <WorkspacePanel
              workspace={workspace}
              sandbox={activeSandbox}
              sandboxes={sandboxes}
              memories={memories}
              onToast={showToast}
              onOpen={openWorkspace}
              onSwitchRoot={switchSandboxRoot}
              onSelect={selectSandbox}
              onDelete={deleteSandbox}
              onRefresh={async () => setWorkspace(await h.workspace.get())}
            />
        )}
        {view === 'terminal' && (
          <TerminalPanel
            workspace={workspace}
            onToast={showToast}
          />
        )}
      </main>

      {editor && (
        <CodeEditor
          kind={editor.kind}
          id={editor.id}
          file={editor.file}
          onClose={() => setEditor(null)}
          onSaved={() => {
            if (editor.kind === 'skill') {
              h.skills.list().then(setSkills)
            } else {
              h.toolPacks.list().then(setToolPacks)
            }
            const label = editor.kind === 'skill' ? '技能' : '工具'
            showToast(`${label}已保存并重载`, 'success')
          }}
        />
      )}

      {showSettings && (
        <SettingsModal
          settings={settings}
          apiStatus={apiStatus}
          onSave={saveSettings}
          onToggleApi={toggleApi}
          onClose={() => setShowSettings(false)}
        />
      )}

      {toast && <div className={`toast toast-${toast.type}`}>{toast.msg}</div>}
      </div>
    </ErrorBoundary>
  )
}
