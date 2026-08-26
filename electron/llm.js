// OpenAI 兼容 LLM 客户端：流式 chat/completions + 工具调用
const { execTool } = require('./tools')
const toolPacks = require('./tool-packs')
const externalMcps = require('./mcp-client')
// 用 Electron 网络栈请求 LLM：自动走系统代理（直连 fetch 在代理环境下会连接超时）
const { net } = require('electron')

function normalizeBaseUrl(baseUrl) {
  let u = (baseUrl || '').trim().replace(/\/+$/, '')
  if (!u) throw new Error('未配置 API Base URL，请先在设置中填写')
  if (!/^https?:\/\//i.test(u)) u = 'https://' + u
  return u
}

// 解析 SSE 数据行
function parseSSE(line) {
  if (!line || !line.startsWith('data:')) return null
  const payload = line.slice(5).trim()
  if (payload === '[DONE]') return null
  try {
    return JSON.parse(payload)
  } catch {
    return null
  }
}

/**
 * 流式调用 chat/completions
 * @param {object} opts { baseUrl, apiKey, model, messages, temperature, maxTokens, tools, signal }
 * @yields {type:'token'|'tool_calls'|'usage', ...}
 */
async function* streamChat(opts) {
  const baseUrl = normalizeBaseUrl(opts.baseUrl)
  const endpoint = baseUrl + '/chat/completions'

  const body = {
    model: opts.model,
    messages: opts.messages,
    stream: true,
    temperature: opts.temperature ?? 0.7
  }
  if (opts.maxTokens) body.max_tokens = opts.maxTokens
  if (opts.tools && opts.tools.length) body.tools = opts.tools

  const res = await net.fetch(endpoint, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${opts.apiKey || ''}`
    },
    body: JSON.stringify(body),
    signal: opts.signal
  })

  if (!res.ok) {
    let detail = ''
    try { detail = await res.text() } catch { /* 忽略 */ }
    throw new Error(`LLM 请求失败 [${res.status}]: ${detail.slice(0, 500)}`)
  }

  if (!res.body) throw new Error('响应无内容')

  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let content = ''
  let toolCalls = []
  let usage = null

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split('\n')
    buffer = lines.pop()

    for (const line of lines) {
      const data = parseSSE(line)
      if (!data) continue
      const delta = data.choices && data.choices[0] && data.choices[0].delta
      if (!delta) continue
      if (data.usage) usage = data.usage
      if (delta.content) {
        content += delta.content
        yield { type: 'token', content: delta.content }
      }
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const idx = tc.index ?? 0
          toolCalls[idx] = toolCalls[idx] || { id: tc.id || `call_${idx}`, name: '', arguments: '' }
          if (tc.id) toolCalls[idx].id = tc.id
          if (tc.function) {
            if (tc.function.name) toolCalls[idx].name += tc.function.name
            if (tc.function.arguments) toolCalls[idx].arguments += tc.function.arguments
          }
        }
      }
    }
  }

  // 完成回调：如果是工具调用，返回给调用方
  if (toolCalls.length) {
    yield {
      type: 'tool_calls',
      tool_calls: toolCalls
        .filter((t) => t && t.name)
        .map((t) => ({ id: t.id, name: t.name, arguments: t.arguments }))
    }
  } else {
    yield { type: 'done', content, usage }
  }
}

// 定义工作区工具 schema（供智能体选择）
const TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: '列出工作区指定目录下的文件与子目录（一层）。传入相对路径，如 "." 或 "src"。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根目录的路径，默认 "."' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: '读取工作区内文本文件的内容（上限 200KB）。传入相对路径。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根目录的文件路径，如 "src/main.js"' }
        },
        required: ['path']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: '在工作区内创建或覆盖写入一个文本文件。路径的父目录会自动创建。',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: '相对工作区根目录的文件路径' },
          content: { type: 'string', description: '文件完整内容' }
        },
        required: ['path', 'content']
      }
    }
  }
]

// 运行智能体工具：需在 skill tools 中显式加入 'run_agent' 才启用
const RUN_AGENT_SCHEMA = {
  type: 'function',
  function: {
    name: 'run_agent',
    description: '运行一个已保存的智能体（多 skill 编排流水线），返回其最终输出文本。适合把复杂任务交给智能体编排完成。',
    parameters: {
      type: 'object',
      properties: {
        agentId: { type: 'string', description: '智能体 ID（"智能体"面板中可查看）' },
        agentName: { type: 'string', description: '智能体名称（按名称匹配，二选一）' },
        inputs: { type: 'object', description: '输入节点内容，键为节点 ID（如 n-input），值为字符串' }
      }
    }
  }
}

// 记忆工具：工作流节点链接了"记忆架构"时注入（tools 列表含任一 memory_ 工具名即启用）
// 每个记忆架构 = 一个记忆空间目录（policy 策略 / facts 事实 / episodes 情景 / skills 技能 / ledger 账本）
// 执行时经 toolContext.memoryFiles 绑定到节点所选记忆架构目录（见 tools.js memoryTool）
// 写入自动带 [[txn:…]] 时间戳、自动记 ledger；检索/遗忘遵循 policy.md 场景策略
const MEMORY_TOOL_SCHEMAS = [
  {
    type: 'function',
    function: {
      name: 'memory_read',
      description: '读取你绑定的长期记忆内容。记忆架构含 policy(策略)/facts(事实)/episodes(情景)/skills(技能)/ledger(账本) 五个文件；不传 scope 时读取全部。',
      parameters: {
        type: 'object',
        properties: {
          memory: { type: 'string', description: '记忆架构名称（可选，默认第一个绑定架构）' },
          scope: { type: 'string', enum: ['policy', 'facts', 'episodes', 'skills', 'ledger'], description: '只读取该文件（可选）' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_write',
      description: '覆写记忆中的指定文件（默认 facts 事实，如用户偏好/结论/配置）。内容结构化、简洁；自动带 [[txn:…]] 时间戳并记入账本。',
      parameters: {
        type: 'object',
        properties: {
          memory: { type: 'string', description: '记忆架构名称（可选，默认第一个绑定架构）' },
          scope: { type: 'string', enum: ['facts', 'episodes', 'skills'], description: '写入目标文件，默认 facts' },
          content: { type: 'string', description: '新内容（覆写）' }
        },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_append',
      description: '向记忆的指定文件追加一段内容（默认 episodes 情景记忆，记录一次性事件）。自动带 [[txn:…]] 时间戳并记入账本。',
      parameters: {
        type: 'object',
        properties: {
          memory: { type: 'string', description: '记忆架构名称（可选，默认第一个绑定架构）' },
          scope: { type: 'string', enum: ['facts', 'episodes', 'skills'], description: '追加目标文件，默认 episodes' },
          content: { type: 'string', description: '要追加的内容' }
        },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description: '在绑定的记忆空间中全文检索（不区分大小写），返回命中文件与行号。适合"记没记过 / 找某条结论"。',
      parameters: {
        type: 'object',
        properties: {
          memory: { type: 'string', description: '记忆架构名称（可选，默认第一个绑定架构）' },
          query: { type: 'string', description: '检索关键词' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_forget',
      description: '遗忘/删除记忆：删除指定文件中包含 query 的条目行（默认 facts）；query 为空则清空该文件（保留标题）。会记入账本。',
      parameters: {
        type: 'object',
        properties: {
          memory: { type: 'string', description: '记忆架构名称（可选，默认第一个绑定架构）' },
          scope: { type: 'string', enum: ['facts', 'episodes', 'skills'], description: '目标文件，默认 facts' },
          query: { type: 'string', description: '要遗忘的条目关键词（可选，空=清空）' }
        }
      }
    }
  }
]

function getToolSchemas(agent) {
  const allowed = agent.tools && agent.tools.length ? agent.tools : TOOL_SCHEMAS.map((s) => s.function.name)
  const builtin = TOOL_SCHEMAS.filter((s) => allowed.includes(s.function.name))
  if (allowed.includes('run_agent')) builtin.push(RUN_AGENT_SCHEMA)
  if (allowed.some((n) => n.startsWith('memory_'))) builtin.push(...MEMORY_TOOL_SCHEMAS)
  // 合并工具包工具：智能体 tools 中引用 'tool:工具名'（兼容旧名 'mcp:工具名'）启用
  const mcpNames = toolPacks.enabledToolNames(allowed)
  const mcpSchemas = toolPacks.allTools()
    .filter((t) => mcpNames.has(t.name))
    .map((t) => ({
      type: 'function',
      function: {
        name: `tool_${t.name}`,
        description: t.description,
        parameters: t.parameters
      }
    }))
  // 合并外部 MCP 工具（标准 MCP 协议）：全部启用，函数名 ext_ 前缀
  const extSchemas = externalMcps.allTools()
    .map((t) => ({
      type: 'function',
      function: {
        name: `ext_${t.name}`,
        description: t.description,
        parameters: t.parameters
      }
    }))
  return [...builtin, ...mcpSchemas, ...extSchemas]
}

module.exports = { streamChat, TOOL_SCHEMAS, RUN_AGENT_SCHEMA, MEMORY_TOOL_SCHEMAS, getToolSchemas, execTool }
