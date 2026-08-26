// 对话编排：消息组装 → 流式调用 → 工具循环 → 会话持久化
// 同时服务于桌面 IPC 与外部 HTTP API
const llm = require('./llm')
const skills = require('./skills')
const workspace = require('./workspace')
const store = require('./store')

let sessionStore = null

function initSessionStore(userDataDir) {
  sessionStore = store.createSessionStore(userDataDir)
}

const MAX_ROUNDS = 8 // 工具调用最大轮数

function buildSystemPrompt(skill) {
  return skills.resolveSystemPrompt(skill, {
    workspaceName: workspace.getRoot() ? require('path').basename(workspace.getRoot()) : null,
    workspaceRoot: workspace.getRoot() || null
  })
}

// 将历史消息转成 API 格式（剥离内部字段）
function toApiMessages(messages) {
  return messages
    .filter((m) => m.role === 'user' || m.role === 'assistant' || m.role === 'tool')
    .map((m) => {
      if (m.role === 'tool') {
        return { role: 'tool', tool_call_id: m.tool_call_id, content: m.content }
      }
      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length) {
        return {
          role: 'assistant',
          content: m.content || null,
          tool_calls: m.tool_calls.map((tc) => ({
            id: tc.id,
            type: 'function',
            function: { name: tc.name, arguments: tc.arguments }
          }))
        }
      }
      return { role: m.role, content: m.content }
    })
}

/**
 * 执行一次对话
 * @param {object} opts
 *   skillId, settings, userMessage, historyMessages, session, signal,
 *   onToken({sessionId, content}), onTool({sessionId, name, args}), onStatus({sessionId, status})
 * @returns {Promise<{content, toolRounds}>}
 */
async function runChat(opts) {
  // 支持调用方传入覆盖后的 skill 定义（如 agent 节点的工具/记忆链接），否则按 skillId 加载
  const skill = opts.skillOverride || (await skills.get(opts.skillId))
  if (!skill) throw new Error(`skill 不存在: ${opts.skillId}`)

  const settings = opts.settings
  // 节点/智能体级模型配置（resolveNodeModel 结果）：baseUrl/apiKey/model 可覆盖全局设置
  // opts.model 兼容两种形态：对象 {baseUrl,apiKey,model}（新节点配置）或字符串（旧版会话模型名）
  const m = opts.model
  const baseUrl = (m && typeof m === 'object' && m.baseUrl ? String(m.baseUrl).trim() : '') || settings.baseUrl
  const apiKey = (m && typeof m === 'object' && m.apiKey ? String(m.apiKey).trim() : '') || settings.apiKey
  const model = (typeof m === 'string' ? m : (m && typeof m === 'object' && m.model ? String(m.model).trim() : '')) || skill.model || settings.model || ''
  if (!baseUrl) throw new Error('未配置 API Base URL，请先在设置中填写')
  if (!apiKey) throw new Error('未配置 API Key，请先在设置中填写')
  if (!model) throw new Error('未配置默认模型，请先在设置中填写，或为该 skill 指定模型')

  const messages = [
    { role: 'system', content: await buildSystemPrompt(skill) },
    ...toApiMessages(opts.historyMessages || []),
    { role: 'user', content: opts.userMessage }
  ]

  const tools = llm.getToolSchemas(skill)
  const session = opts.session
  let content = ''
  let toolRounds = 0

  for (let round = 0; round < MAX_ROUNDS; round++) {
    const gen = llm.streamChat({
      baseUrl,
      apiKey,
      model,
      messages,
      temperature: skill.temperature ?? 0.7,
      maxTokens: skill.maxTokens,
      tools: tools.length ? tools : undefined,
      signal: opts.signal
    })

    let toolCalls = null
    for await (const chunk of gen) {
      if (chunk.type === 'token') {
        content += chunk.content
        opts.onToken && opts.onToken({ sessionId: session.id, content: chunk.content })
      } else if (chunk.type === 'tool_calls') {
        toolCalls = chunk.tool_calls
      }
      // 注意：done 分块携带的是累计全文，token 已逐个累加，这里不能再加，否则内容翻倍
    }

    if (!toolCalls || !toolCalls.length) {
      return { content, toolRounds }
    }

    // 执行工具调用
    toolRounds++
    messages.push({
      role: 'assistant',
      content: null,
      tool_calls: toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.arguments }
      }))
    })
    for (const tc of toolCalls) {
      opts.onStatus && opts.onStatus({ sessionId: session.id, status: `正在执行工具 ${tc.name}...` })
      const result = await llm.execTool(tc.name, tc.arguments, opts.toolContext)
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result })
      opts.onTool && opts.onTool({ sessionId: session.id, name: tc.name, args: tc.arguments, result })
    }
  }

  return { content, toolRounds }
}

// 保存会话（合并流式内容与工具记录）
function finalizeSession(session, { content, toolRounds, toolLog }) {
  if (content) session.messages.push({ role: 'assistant', content, ts: Date.now() })
  sessionStore.save(session)
}

module.exports = { initSessionStore, runChat, finalizeSession, getSessionStore: () => sessionStore }
