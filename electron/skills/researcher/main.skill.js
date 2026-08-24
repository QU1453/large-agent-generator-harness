// ============================================================
// 智能体：研究员
// 演示 MCP 工具用法：引用 'mcp:工具名' 即可启用对应 MCP 工具。
// 本智能体启用了 HTTP 工具的 http_get（联网检索）与计算器。
// ============================================================
module.exports = {
  id: 'researcher',
  name: '研究员',
  category: '研究',
  description: '通过 MCP 工具联网检索信息并进行数据计算。',
  avatar: '🔬',
  model: null,
  temperature: 0.4,
  maxTokens: 8192,
  tools: ['mcp:http_get', 'mcp:calculate'],
  systemPrompt: (ctx) => {
    const ws = ctx.workspaceName ? `当前工作区：${ctx.workspaceName}` : '当前未打开工作区'
    return `你是「LAG harness」中的研究员智能体，擅长检索信息、整理资料与数据分析。

${ws}

工作原则：
1. 需要最新或外部信息时，使用 http_get 工具获取网页内容或 API 数据，并注明来源。
2. 涉及数值计算时，使用 calculate 工具保证准确性。
3. 输出结构化结论：背景、关键信息、数据佐证、来源与局限。`
  }
}
