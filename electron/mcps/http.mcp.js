// ============================================================
// MCP：HTTP 工具
// 提供网络请求能力。示例：http_get / http_post。
// 注意：工具运行在本地主进程，请自行评估访问外部网络的风险。
// ============================================================
const { net } = require('electron') // 走 Chromium 网络栈：自动使用系统代理
const MAX_BODY = 8000

async function safeFetch(url, opts) {
  if (!/^https?:\/\//i.test(url)) throw new Error('仅支持 http/https 协议')
  const res = await net.fetch(url, { ...opts, redirect: 'follow', signal: AbortSignal.timeout(15000) })
  const text = await res.text()
  const body = text.length > MAX_BODY ? text.slice(0, MAX_BODY) + `\n…(已截断，共 ${text.length} 字符)` : text
  const ctype = res.headers.get('content-type') || ''
  return JSON.stringify({
    status: res.status,
    ok: res.ok,
    contentType: ctype,
    bodyLength: text.length,
    body: ctype.includes('json') ? tryJson(body) : body
  }, null, 2)
}

function tryJson(s) {
  try { return JSON.parse(s) } catch { return s }
}

module.exports = {
  id: 'http',
  name: 'HTTP 工具',
  description: '提供 HTTP GET / POST 请求能力，可访问网页或调用 API。',
  tools: [
    {
      name: 'http_get',
      description: '发送 HTTP GET 请求并返回响应（JSON 会解析，超长内容自动截断）。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标 URL，如 https://api.example.com/data' }
        },
        required: ['url']
      },
      handler: async (args) => {
        if (!args.url) throw new Error('缺少 url 参数')
        return await safeFetch(args.url)
      }
    },
    {
      name: 'http_post',
      description: '发送 HTTP POST 请求（JSON body）并返回响应。',
      parameters: {
        type: 'object',
        properties: {
          url: { type: 'string', description: '目标 URL' },
          json: { type: 'object', description: '要发送的 JSON 数据' },
          headers: { type: 'object', description: '额外的请求头（可选）' }
        },
        required: ['url']
      },
      handler: async (args) => {
        if (!args.url) throw new Error('缺少 url 参数')
        return await safeFetch(args.url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', ...(args.headers || {}) },
          body: args.json !== undefined ? JSON.stringify(args.json) : undefined
        })
      }
    }
  ]
}
