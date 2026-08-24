import { useEffect, useRef, useState } from 'react'
import Markdown from './Markdown.jsx'
import SearchSelect from './SearchSelect.jsx'
import InputGrip from './InputGrip.jsx'
import { fmtTime } from '../lib/harness.js'
import { PRESET_MODELS } from '../lib/models.js'

// 思考痕迹：工具调用 / 工作流节点进度
export function TraceBlock({ trace }) {
  if (!trace || !trace.length) return null
  return (
    <details className="trace">
      <summary>🧠 思考痕迹 · {trace.length} 步</summary>
      <div className="trace-list">
        {trace.map((t, i) => (
          <div className="trace-item" key={i}>
            {t.type === 'tool' ? (
              <>
                <div className="trace-head">
                  <span className="trace-tag">工具</span>
                  <code>{t.name}</code>
                </div>
                {t.args ? <pre className="trace-args">{t.args}</pre> : null}
                {t.result ? <div className="trace-result">{t.result}</div> : null}
              </>
            ) : (
              <div className="trace-head">
                <span className="trace-tag">节点</span>
                <code>{t.nodeId}</code>
                <span className={`trace-status ${t.status || ''}`}>{t.status || ''}</span>
                {t.error ? <span className="trace-error">{t.error}</span> : null}
              </div>
            )}
          </div>
        ))}
      </div>
    </details>
  )
}

function ModelInput({ session, onChangeModel }) {
  const [v, setV] = useState(session?.model || '')
  useEffect(() => { setV(session?.model || '') }, [session?.id, session?.model])
  const commit = () => {
    const next = v.trim()
    if (next !== (session?.model || '')) onChangeModel(session.id, next)
  }
  return (
    <>
      <input
        className="model-input"
        list="preset-models"
        placeholder="模型·默认"
        title="本会话模型覆盖，留空跟随默认模型"
        value={v}
        onChange={(e) => setV(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => { if (e.key === 'Enter') e.target.blur() }}
      />
      <datalist id="preset-models">
        {PRESET_MODELS.map((m) => <option key={m} value={m} />)}
      </datalist>
    </>
  )
}

function Message({ m }) {
  if (m.role === 'user') {
    return (
      <div className="msg msg-user">
        <div className="msg-body">
          <div className="msg-bubble user">{m.content}</div>
          <div className="msg-meta">{fmtTime(m.ts)} · 你</div>
        </div>
        <div className="msg-avatar user">🧑</div>
      </div>
    )
  }
  if (m.role === 'error') {
    return (
      <div className="msg">
        <div className="msg-avatar">⚠️</div>
        <div className="msg-body">
          <div className="msg-bubble error">{m.content}</div>
        </div>
      </div>
    )
  }
  return (
    <div className="msg">
      <div className="msg-avatar">🤖</div>
      <div className="msg-body">
        <div className="msg-bubble ai">
          <Markdown>{m.content}</Markdown>
        </div>
        <TraceBlock trace={m.trace} />
        <div className="msg-meta">{fmtTime(m.ts)} · LAG harness</div>
      </div>
    </div>
  )
}

// 工作区聊天等场景复用：消息气泡 / 流式输出块
export { Message, StreamBlock }

function StreamBlock({ streaming }) {
  const content = streaming?.content || ''
  const tool = streaming?.tool
  return (
    <div className="msg msg-ai">
      <div className="msg-avatar">🤖</div>
      <div className="msg-body">
        <div className="msg-bubble ai">
          {tool ? (
            <div className="tool-call">
              <span className="tool-icon">🔧</span>
              <span>{tool.name}</span>
              <code className="tool-args">{String(tool.args || '').slice(0, 120)}</code>
              <span className="tool-spin" />
            </div>
          ) : !content ? (
            <div className="stream-status">
              <span className="think-dots"><i /><i /><i /></span>
              <span>{streaming?.status || '正在思考…'}</span>
            </div>
          ) : null}
          {content && (
            <div className="stream-content">
              <Markdown>{content}</Markdown>
              <span className="cursor-blink" />
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export default function ChatView({
  session, agents, memories, sandboxes, streaming, workspace,
  onSend, onStop, onChangeTarget, onChangeModel, onChangeSandbox, onChangeMemoryArch, onOpenWorkspace, onCreateSession
}) {
  const [input, setInput] = useState('')
  const scrollRef = useRef(null)
  const isStreaming = streaming && session && streaming.sessionId === session.id

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [session?.messages, streaming?.content])

  const submit = () => {
    if (isStreaming) return
    if (!input.trim()) return
    onSend(input)
    setInput('')
  }

  const messages = session?.messages || []

  // 目标选择（Trae 式搜索）：只选智能体（agent，多技能编排），不提供单个技能/工具选项
  const targetItems = [
    ...(agents || []).map((w) => ({ id: `ag:${w.id}`, label: w.name, desc: w.description || '智能体 · 多技能编排', icon: w.avatar || '🌀', keywords: `智能体 编排 ${w.id}` }))
  ]
  const curTarget = session && session.targetType === 'agent' ? `ag:${session.targetId || ''}` : ''
  const pickTarget = (vid) => {
    if (!session) return
    const idx = vid.indexOf(':')
    if (idx <= 0 || vid.slice(0, idx) !== 'ag') return
    onChangeTarget(session.id, 'agent', vid.slice(idx + 1))
  }
  const memItems = [
    { id: '', label: '未绑定记忆', desc: '不绑定记忆架构', icon: '🧠' },
    ...(memories || []).map((m) => ({ id: m.name, label: m.title || m.name, desc: m.desc || m.name, icon: '🧠', keywords: `记忆 ${m.name}` }))
  ]
  const sandboxItems = [
    { id: '', label: '未绑定工作区', desc: '不绑定工作区（沙盒）', icon: '📁' },
    ...(sandboxes || []).map((s) => ({ id: s.id, label: s.name, desc: s.root || '', icon: '📁', keywords: `工作区 ${s.name}` }))
  ]

  return (
    <div className="chat-view">
      <div className="topbar">
        <div className="topbar-left">
          {session ? (
            <span className="topbar-title">{session.title}</span>
          ) : (
            <span className="topbar-title">新对话</span>
          )}
          {workspace ? (
            <span className="ws-tag" title={workspace.root}>📁 {workspace.name}</span>
          ) : (
            <button className="ws-tag link" onClick={onOpenWorkspace}>＋ 打开工作区</button>
          )}
        </div>
        {isStreaming && (
          <button className="btn stop" onClick={onStop}>⏹ 停止</button>
        )}
      </div>

      <div className="chat-scroll" ref={scrollRef}>
        {!session && (
          <div className="chat-empty">
            <div className="empty-logo">⚡</div>
            <h2>LAG harness</h2>
            <p>选择左侧会话，或选择智能体开始新对话</p>
            <div className="empty-agents">
              {agents.map((w) => (
                <button
                  key={w.id}
                  className="agent-chip wf"
                  onClick={() => onCreateSession('agent', w.id)}
                >
                  <span className="chip-avatar">{w.avatar || '🌀'}</span>
                  <span className="chip-name">{w.name}</span>
                </button>
              ))}
            </div>
            {agents.length === 0 && (
              <div className="chip-hint">暂无智能体，请到「智能体」页新建</div>
            )}
            <div className="chip-hint">点击快速开始 · 可在下方随时切换</div>
          </div>
        )}

        {messages.map((m, i) => (
          <Message key={i} m={m} />
        ))}

        {isStreaming && <StreamBlock streaming={streaming} />}
      </div>

      <div className="composer">
        <div className="composer-box">
          {session && (
            <div className="composer-sel">
              <SearchSelect
                className="composer-target"
                items={targetItems}
                value={curTarget}
                onChange={pickTarget}
                placeholder={targetItems.length ? '🔍 搜索智能体…' : '暂无智能体'}
                empty="无匹配智能体"
              />
              <SearchSelect
                className="composer-mem"
                items={memItems}
                value={session?.memoryArch || ''}
                onChange={(v) => onChangeMemoryArch?.(session.id, v)}
                placeholder="🧠 记忆"
                empty="无匹配记忆架构"
              />
              <SearchSelect
                className="composer-sandbox"
                items={sandboxItems}
                value={session?.sandboxId || ''}
                onChange={(v) => onChangeSandbox?.(session.id, v)}
                placeholder="📁 工作区"
                empty="无匹配工作区"
              />
              <ModelInput session={session} onChangeModel={onChangeModel} />
            </div>
          )}
          <InputGrip maxH={220} />
          <textarea
            className="composer-input"
            placeholder="输入消息…（Enter 发送，Shift+Enter 换行）"
            value={input}
            rows={Math.min(6, Math.max(2, input.split('\n').length + 1))}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                submit()
              }
            }}
          />
          <div className="composer-actions">
            <span className="composer-hint">
              {session ? `${session.messages.length} 条消息` : '新会话'}
              {isStreaming ? ' · 正在生成…' : ''}
              <span className="kbd">Enter</span> 发送
              <span className="kbd">Shift+Enter</span> 换行
            </span>
            <button
              className={`btn send ${isStreaming ? 'disabled' : ''}`}
              onClick={submit}
              disabled={isStreaming}
            >发送</button>
          </div>
        </div>
      </div>
    </div>
  )
}
