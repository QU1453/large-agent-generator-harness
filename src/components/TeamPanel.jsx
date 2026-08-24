import { useCallback, useEffect, useRef, useState } from 'react'
import { fmtTime } from '../lib/harness.js'
import InputGrip from './InputGrip.jsx'

// 团队（WiFi 团队开发）：一键启动局域网协作服务 + 内置频道（@ai 托管）
export default function TeamPanel({ onToast, skillCount = 0, agentCount = 0, memoryCount = 0, mcpCount = 0, onStatusChange, onNavigate }) {
  const [status, setStatus] = useState({ running: false, lanIps: [], teamName: '我的团队', teamEnabled: false })
  const [state, setState] = useState({ name: '我的团队', members: {}, channel: [] })
  const [assets, setAssets] = useState(null) // {agents, mcps, workflows, memories, skills}（各带 owner）
  const [openGroup, setOpenGroup] = useState('agents') // 当前展开的资产组
  const [now, setNow] = useState(Date.now())
  const [text, setText] = useState('')
  const [teamName, setTeamName] = useState('')
  const [busy, setBusy] = useState(false)
  const scRef = useRef(null)
  const sinceRef = useRef(0)
  const nameSavedRef = useRef('')
  const nameTimer = useRef(null)

  const saveNameNow = async (clean) => {
    try {
      await window.harness.team.setName(clean)
      nameSavedRef.current = clean
      setState((s) => ({ ...s, name: clean }))
      onToast(`团队名已改为「${clean}」`, 'success')
    } catch (e) {
      onToast('保存失败：' + e.message, 'error')
    }
  }

  // 输入即保存（防抖 400ms，blur 兜底），保证切走再回来一致
  const onNameChange = (e) => {
    const v = e.target.value
    setTeamName(v)
    clearTimeout(nameTimer.current)
    nameTimer.current = setTimeout(() => {
      const clean = v.trim()
      if (clean && clean !== nameSavedRef.current) saveNameNow(clean)
    }, 400)
  }
  const saveName = () => {
    clearTimeout(nameTimer.current)
    const clean = (teamName || '').trim()
    if (clean && clean !== nameSavedRef.current) saveNameNow(clean)
  }

  const refreshStatus = useCallback(async () => {
    try { setStatus(await window.harness.team.status()) } catch (e) { console.warn('[team]', e) }
  }, [])

  const refreshAssets = useCallback(async () => {
    try { setAssets(await window.harness.team.assets()) } catch (e) { console.warn('[team]', e) }
  }, [])

  const refreshState = useCallback(async (fresh) => {
    try {
      const d = await window.harness.team.state()
      sinceRef.current = (d.channel[d.channel.length - 1] || {}).ts || 0
      setState(d)
      setNow(Date.now())
      if (fresh || !nameSavedRef.current) {
        setTeamName(d.name)
        nameSavedRef.current = d.name
      }
    } catch (e) { console.warn('[team]', e) }
  }, [])

  useEffect(() => {
    refreshStatus()
    refreshState(true)
    refreshAssets()
    const t = setInterval(() => {
      refreshStatus()
      refreshState()
      refreshAssets()
    }, 3000)
    return () => { clearInterval(t); clearTimeout(nameTimer.current) }
  }, [refreshStatus, refreshState, refreshAssets])

  // 新消息自动滚到底
  useEffect(() => {
    const el = scRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [state.channel.length])

  const start = async () => {
    setBusy(true)
    try {
      const r = await window.harness.team.start()
      setStatus((s) => ({ ...s, ...r, teamEnabled: true }))
      onToast(r.running ? `团队服务已启动（${r.port}）` : `启动失败：${r.error || '未知错误'}`, r.running ? 'success' : 'error')
      if (r.running) refreshState(true)
      if (onStatusChange) onStatusChange()
    } catch (e) {
      onToast('启动失败：' + e.message, 'error')
    } finally { setBusy(false) }
  }

  const stop = async () => {
    setBusy(true)
    try {
      const r = await window.harness.team.stop()
      setStatus((s) => ({ ...s, ...r, teamEnabled: false }))
      onToast('团队服务已停止', 'success')
      if (onStatusChange) onStatusChange()
    } catch (e) {
      onToast('停止失败：' + e.message, 'error')
    } finally { setBusy(false) }
  }

  const send = async () => {
    const t = text.trim()
    if (!t) return
    setText('')
    try {
      const r = await window.harness.team.post(t)
      if (r.ok) {
        // 立即刷新频道（发消息/或 AI 异步回复稍后轮询拉到）
        setTimeout(() => refreshState(true), 300)
      } else {
        onToast(r.error || '发送失败', 'error')
      }
    } catch (e) {
      onToast('发送失败：' + e.message, 'error')
    }
  }

  const copyUrl = async () => {
    const url = addr()
    if (!url) return onToast('尚未启动团队服务', 'error')
    try {
      await navigator.clipboard.writeText(url)
      onToast('地址已复制', 'success')
    } catch {
      onToast('复制失败，请手动复制：' + url, 'error')
    }
  }

  // 下载共享资产：主进程读内容 → 前端 Blob 触发浏览器下载
  const downloadAsset = async (kind, name, title) => {
    try {
      const r = await window.harness.team.download(kind, name)
      if (!r || !r.ok) return onToast((r && r.error) || '下载失败', 'error')
      const blob = new Blob([r.content], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = r.name || 'asset.txt'
      document.body.appendChild(a)
      a.click()
      a.remove()
      setTimeout(() => URL.revokeObjectURL(url), 2000)
      onToast(`已下载 ${title || r.name}`, 'success')
    } catch (e) {
      onToast('下载失败：' + e.message, 'error')
    }
  }

  const addr = () => {
    if (!status.running) return null
    const ip = status.lanIps && status.lanIps[0]
    return ip ? `http://${ip}:${status.port}/team` : null
  }

  const members = Object.keys(state.members || {}).map((id) => ({ id, ...state.members[id] }))
    .sort((a, b) => (b.lastSeen || 0) - (a.lastSeen || 0))
  const online = members.filter((m) => now - (m.lastSeen || 0) <= 8000)

  const msgs = state.channel || []

  return (
    <div className="panel team-panel">
      <div className="panel-header">
        <div>
          <h2>👥 团队</h2>
          <div className="panel-sub">同一 WiFi 内的成员用浏览器打开团队控制台加入协作，频道内 <strong>@ai</strong> 可托管给智能体回复</div>
        </div>
        <div className="panel-actions">
          {!status.teamEnabled ? (
            <button className="btn primary" disabled={busy} onClick={start}>▶ 启动团队服务</button>
          ) : (
            <button className="btn" disabled={busy} onClick={stop}>⏹ 停止</button>
          )}
        </div>
      </div>

      {/* 地址行 */}
      <div className="team-addr">
        <div className="team-addr-main">
          <span className={`dot ${status.running ? 'on' : 'off'}`} />
          <span className="team-addr-text">{addr() || '未启动'}</span>
        </div>
        <button className="mini-btn" disabled={!addr()} onClick={copyUrl} title="复制地址">📋 复制</button>
      </div>

      {/* 团队名 */}
      <div className="team-name-row">
        <span>团队名</span>
        <input
          className="input team-name-input"
          value={teamName}
          onChange={onNameChange}
          onBlur={saveName}
          onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
          maxLength={20}
          placeholder="我的团队"
        />
      </div>

      {/* 成员区 */}
      <div className="team-members">
        <div className="team-sec-title">
          成员 <span className="team-count">{online.length} 在线 / {members.length}</span>
        </div>
        <div className="team-member-list">
          {members.length === 0 && <div className="session-empty">暂无成员，启动服务后让队友用浏览器打开上方地址</div>}
          {members.map((m) => {
            const on = now - (m.lastSeen || 0) <= 8000
            return (
              <span key={m.id} className={`team-member${on ? '' : ' off'}`}>
                {m.isHost ? '⭐' : '🙋'} {m.name} {on ? '' : '（离线）'}
              </span>
            )
          })}
        </div>
      </div>

      {/* 频道 */}
      <div className="team-chat">
        <div className="team-sec-title">团队频道<span className="team-count">（@ai 开头将交给智能体回复）</span></div>
        <div className="team-scroll" ref={scRef}>
          {msgs.length === 0 && <div className="session-empty">暂无消息，说点什么吧</div>}
          {msgs.map((m) => (
            <div key={m.id} className={`team-msg team-msg-${m.type}`}>
              <span className="team-msg-name">{m.name}</span>
              <span className="team-msg-text">{m.text}</span>
              <span className="team-msg-time">{fmtTime(m.ts)}</span>
            </div>
          ))}
        </div>
        <div className="team-input-row">
          <div className="team-input-col">
            <InputGrip maxH={180} minH={36} />
            <textarea
              className="input team-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send() } }}
              placeholder="@ai 帮我… 或 直接输入频道消息"
            />
          </div>
          <button className="btn primary" disabled={!text.trim()} onClick={send}>发送</button>
        </div>
      </div>

      {/* 共享资产（可展开列表：每项显示归属成员 + 下载按钮） */}
      <div className="team-assets">
        <div className="team-sec-title">共享资产<span className="team-count">（点击分组展开；👤 归属成员，📥 下载到本机）</span></div>
        {[
          { key: 'skills', kind: 'skill', icon: '🎯', label: '技能' },
          { key: 'agents', kind: 'agent', icon: '🌀', label: '智能体' },
          { key: 'mcps', kind: 'mcp', icon: '🔧', label: '工具' },
          { key: 'memories', kind: 'memory', icon: '🧠', label: '记忆' }
        ].map((g) => {
          const list = (assets && assets[g.key]) || []
          const open = openGroup === g.key
          return (
            <div key={g.key} className="team-asset-group">
              <button
                className="team-asset-head"
                onClick={() => setOpenGroup(open ? '' : g.key)}
              >
                <span>{g.icon} {g.label}</span>
                <span className="team-count">{list.length} 个 {open ? '▾' : '▸'}</span>
              </button>
              {open && (
                <div className="team-asset-list">
                  {list.length === 0 && <div className="team-asset-empty">（空）</div>}
                  {list.map((it) => (
                    <div key={it.id || it.name} className="team-asset-item">
                      <div className="team-asset-info">
                        <span className="team-asset-name" title={it.description || it.desc || ''}>{it.avatar ? it.avatar + ' ' : ''}{it.title || it.name}</span>
                        <span className="team-asset-owner">👤 {it.owner || '主机'}</span>
                      </div>
                      {g.key === 'memories' ? (
                        <button
                          className="mini-btn"
                          title="打开记忆页"
                          onClick={() => onNavigate && onNavigate('memory')}
                        >打开</button>
                      ) : (
                        <button
                          className="mini-btn"
                          title="下载到本机"
                          onClick={() => downloadAsset(g.kind, it.id || it.name, it.title || it.name)}
                        >📥</button>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>
    </div>
  )
}
