// ============================================================
// 智能体：通用助手
// 这是 LAG harness 的智能体定义文件，本质是一个可执行的 JS 模块。
// 客制化方式：修改下方字段或 systemPrompt 函数，保存后在界面上点"重载"。
// systemPrompt 支持字符串或函数；函数可接收 ctx（包含 workspaceName 等上下文）。
// ============================================================
module.exports = {
  id: 'assistant',
  name: '通用助手',
  category: '通用',
  description: '全能型对话助手，回答问题、整理信息、提供建议。',
  avatar: '🤖',
  model: null, // 留空则使用全局默认模型
  temperature: 0.7,
  maxTokens: 4096,
  tools: [],
  systemPrompt: (ctx) => {
    const ws = ctx.workspaceName ? `当前工作区：${ctx.workspaceName}` : '当前未打开工作区'
    return `你是「LAG harness」中的通用助手，一个专业、友好、高效的人工智能助手。

${ws}

请用简洁、准确的语言回应用户。涉及代码时使用 Markdown 代码块并标注语言。`
  }
}
