// ============================================================
// MCP：计算器
// MCP = Model Context Protocol 工具包。每个 .mcp.js 文件是一个
// MCP 服务，提供一组可被智能体调用的工具。
// tools 数组中每个工具：name(唯一)、description、parameters(JSON Schema)、
// handler(args) 返回结果字符串。
// ============================================================
function safeEval(expr) {
  const s = String(expr).trim()
  if (!s) return ''
  if (s.length > 500) throw new Error('表达式过长')
  // 白名单校验：只允许数字、运算符、括号、小数点、空格
  if (!/^[0-9+\-*/().%\s]+$/.test(s)) throw new Error('表达式包含非法字符（仅支持四则运算与括号）')
  // eslint-disable-next-line no-new-func
  const val = new Function('return (' + s + ');')()
  if (typeof val !== 'number' || !isFinite(val)) throw new Error('无法计算该表达式')
  return String(Math.round(val * 1e10) / 1e10)
}

module.exports = {
  id: 'calculator',
  name: '计算器',
  description: '提供安全的数学计算工具，支持四则运算、括号、取模与百分比。',
  tools: [
    {
      name: 'calculate',
      description: '计算一个数学表达式并返回结果，例如 "(12 + 8) * 3 / 2"。',
      parameters: {
        type: 'object',
        properties: {
          expr: { type: 'string', description: '数学表达式，如 (12+8)*3/2' }
        },
        required: ['expr']
      },
      handler: (args) => safeEval(args.expr)
    }
  ]
}
