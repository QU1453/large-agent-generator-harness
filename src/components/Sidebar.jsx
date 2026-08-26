import { useState } from 'react'
import { fmtTime } from '../lib/harness.js'
import logo from '../assets/logo.png'

// 轻量 SVG 图标集
const Icons = {
  chat: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z" />
    </svg>
  ),
  agents: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="4" y="4" width="16" height="16" rx="3.5" />
      <circle cx="9" cy="10" r="2" />
      <circle cx="15" cy="9" r="1.4" />
      <path d="M7.5 17c.8-2 2.4-3 4.5-3s3.7 1 4.5 3" />
    </svg>
  ),
  workspace: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z" />
    </svg>
  ),
  mcp: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M9.5 3v6M5.5 5v8a2 2 0 0 0 2 2h4" />
      <path d="M9.5 13V21M13.5 8h5l2 2v2" />
      <path d="M20.5 17a2 2 0 1 1-3.7 1 2 2 0 0 1 3.7-1z" />
    </svg>
  ),
  skills: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2 9.5 9.5 2 12l7.5 2.5L12 22l2.5-7.5L22 12l-7.5-2.5z" />
      <path d="M19 3v4M17 5h4" />
    </svg>
  ),
  memory: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <ellipse cx="12" cy="5.5" rx="7.5" ry="2.8" />
      <path d="M4.5 5.5v5.5c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8V5.5" />
      <path d="M4.5 11v5.5c0 1.55 3.36 2.8 7.5 2.8s7.5-1.25 7.5-2.8V11" />
      <path d="M10 3.2v3M14 3.2v3" />
    </svg>
  ),
  protocol: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 2.5 4.5 5.5v6c0 4.5 3.2 8 7.5 10 4.3-2 7.5-5.5 7.5-10v-6z" />
      <path d="M9 12l2.2 2.2L15.5 9.5" />
    </svg>
  ),
  flow: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="7" height="6" rx="1.5" />
      <rect x="14" y="4" width="7" height="6" rx="1.5" />
      <rect x="8.5" y="15" width="7" height="6" rx="1.5" />
      <path d="M6.5 10v2.5h11V10M12 14v1" />
    </svg>
  ),
  team: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="9" cy="8" r="3.2" />
      <circle cx="17" cy="9.5" r="2.4" />
      <path d="M3.5 19c.9-3.2 3-4.8 5.5-4.8s4.6 1.6 5.5 4.8" />
      <path d="M14.6 14.6c2.2.3 4.2 1.6 5.1 4.2" />
    </svg>
  ),
  terminal: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="4" width="18" height="16" rx="2.5" />
      <path d="M7 9l3 3-3 3M12.5 15H17" />
    </svg>
  ),
  settings: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
    </svg>
  ),
  plus: (
    <svg viewBox="0 0 24 24" fill="none" strokeWidth="2" strokeLinecap="round">
      <path d="M12 5v14M5 12h14" />
    </svg>
  )
}

const NAV = [
  { key: 'chat', label: '会话', icon: Icons.chat },
  { key: 'agents', label: '智能体', icon: Icons.flow },
  { key: 'protocols', label: '协议', icon: Icons.protocol },
  { key: 'skills', label: '技能', icon: Icons.skills },
  { key: 'memory', label: '记忆', icon: Icons.memory },
  { key: 'mcp', label: '工具/MCP', icon: Icons.mcp },
  { key: 'terminal', label: '终端', icon: Icons.terminal },
  { key: 'team', label: '团队', icon: Icons.team },
  { key: 'workspace', label: '工作区', icon: Icons.workspace }
]

export default function Sidebar({
  view, setView, sessions, activeId, skills, agents, mcps, workspace, apiStatus,
  sandboxes, activeSandbox, agRunning, memoryCount,
  onSelectSession, onCreateSession, onDeleteSession, onRenameSession,
  onSelectSandbox, onCreateSandbox, onDeleteSandbox, onOpenSettings
}) {
  const [editingId, setEditingId] = useState(null)
  const [editTitle, setEditTitle] = useState('')

  const startRename = (s) => {
    setEditingId(s.id)
    setEditTitle(s.title)
  }

  const commitRename = (s) => {
    const t = editTitle.trim()
    if (t && t !== s.title) onRenameSession(s.id, t)
    setEditingId(null)
  }

  const skillOf = (id) => skills.find((x) => x.id === id)
  const agentOf = (id) => agents.find((x) => x.id === id)

  return (
    <aside className="sidebar">
      <div className="sidebar-logo">
        <span className="logo-badge">
          <img src={logo} alt="LAG harness" className="logo-img" />
        </span>
        <span className="logo-text">
          <span className="logo-title">LAG harness</span>
          <span className="logo-sub">Agent Forge</span>
        </span>
      </div>

      <nav className="sidebar-nav">
        {NAV.map((n) => (
          <button
            key={n.key}
            className={`nav-item ${view === n.key ? 'active' : ''}`}
            onClick={() => setView(n.key)}
          >
            <span className="nav-icon">{n.icon}</span>
            <span>{n.label}</span>
            {n.key === 'agents' && <span className="nav-count">{agents.length}</span>}
            {n.key === 'mcp' && <span className="nav-count">{mcps.length}</span>}
            {n.key === 'skills' && <span className="nav-count">{skills.length}</span>}
            {n.key === 'memory' && <span className="nav-count">{memoryCount || 0}</span>}
            {n.key === 'agents' && agRunning && (
              <span className="nav-spinner" title="智能体正在运行（切换页面不会中断）" />
            )}
            {n.key === 'team' && apiStatus.host === '0.0.0.0' && (
              <span className="nav-dot on" title="团队服务运行中（局域网可访问）" />
            )}
          </button>
        ))}
      </nav>

      {/* 工作区（多 sandbox）：每一项是一个工作区，含独立聊天记录 */}
      <div className="sandbox-list">
        <div className="session-list-header">
          <span>工作区</span>
          {agRunning && <span className="nav-spinner small" title="智能体正在运行（切换页面不会中断）" />}
          <button className="mini-btn" title="新建工作区（选择文件夹）" onClick={onCreateSandbox}>{Icons.plus}</button>
        </div>
        <div className="session-items">
          {sandboxes.length === 0 && (
            <div className="session-empty">暂无工作区<br />点击 ＋ 选择一个文件夹</div>
          )}
          {sandboxes.map((s) => (
            <div
              key={s.id}
              className={`session-item ${activeSandbox && activeSandbox.id === s.id ? 'active' : ''}`}
              onClick={() => onSelectSandbox(s.id)}
              title={s.root}
            >
              <div className="session-main">
                <div className="session-title">📁 {s.name}</div>
                <div className="session-meta">{s.root}</div>
              </div>
              <div className="session-actions">
                <button
                  className="mini-btn danger"
                  title="移除工作区（不影响文件夹）"
                  onClick={(e) => { e.stopPropagation(); onDeleteSandbox(s.id) }}
                >🗑</button>
              </div>
            </div>
          ))}
        </div>
      </div>

      {view === 'chat' && (
        <div className="session-list">
          <div className="session-list-header">
            <span>会话历史</span>
          </div>
          <button
            className="session-new-btn"
            onClick={() => onCreateSession('agent', agents[0]?.id || undefined)}
            title="新建会话（默认选第一个智能体，可随时切换）"
          >＋ 新建会话</button>
          <div className="session-items">
            {sessions.length === 0 && (
              <div className="session-empty">
                暂无会话<br />点击上方 ＋ 新建一个
              </div>
            )}
            {sessions.map((s) => (
              <div
                key={s.id}
                className={`session-item ${s.id === activeId ? 'active' : ''}`}
                onClick={() => onSelectSession(s.id)}
              >
                {editingId === s.id ? (
                  <input
                    className="session-rename-input"
                    value={editTitle}
                    autoFocus
                    onChange={(e) => setEditTitle(e.target.value)}
                    onBlur={() => commitRename(s)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') commitRename(s)
                      if (e.key === 'Escape') setEditingId(null)
                    }}
                    onClick={(e) => e.stopPropagation()}
                  />
                ) : (
                  <>
                    <div className="session-main">
                      <div className="session-title">{s.title}</div>
                      <div className="session-meta">
                        {s.targetType === 'agent' ? (
                          <>🌀 {agentOf(s.targetId)?.name || '智能体'} · {fmtTime(s.updatedAt)}</>
                        ) : (
                          <>{skillOf(s.skillId)?.avatar || '🤖'} {skillOf(s.skillId)?.name || '未知技能'} · {fmtTime(s.updatedAt)}</>
                        )}
                      </div>
                    </div>
                    <div className="session-actions">
                      <button
                        className="mini-btn"
                        title="重命名"
                        onClick={(e) => { e.stopPropagation(); startRename(s) }}
                      >✎</button>
                      <button
                        className="mini-btn danger"
                        title="删除"
                        onClick={(e) => {
                          e.stopPropagation()
                          if (confirm('删除该会话？')) onDeleteSession(s.id)
                        }}
                      >🗑</button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      )}

      <div className="sidebar-footer">
        <button className="icon-btn settings-btn" title="设置" onClick={onOpenSettings}>{Icons.settings}</button>
        <div
          className="api-pill"
          title={apiStatus.running ? `API 服务运行中，端口 ${apiStatus.port}` : 'API 服务未运行，点击打开设置'}
          onClick={onOpenSettings}
        >
          <span className={`dot ${apiStatus.running ? 'on' : 'off'}`} />
          <span>API {apiStatus.running ? `:${apiStatus.port}` : '已关闭'}</span>
        </div>
        {workspace && (
          <div className="ws-pill" title={workspace.root}>
            📁 {workspace.name}
          </div>
        )}
      </div>
    </aside>
  )
}
