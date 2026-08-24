// 模型预置（全局共享）：设置页与会话顶栏共用的唯一数据源
// deepseek 官方 API（api.deepseek.com）当前模型名为 v4 两档：deepseek-v4-pro / deepseek-v4-flash

export const PRESET_MODELS = [
  'deepseek-v4-pro', 'deepseek-v4-flash',
  'gpt-4o', 'gpt-4o-mini', 'gpt-4.1',
  'qwen-max', 'qwen-plus', 'qwen-turbo',
  'moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k',
  'glm-4-plus', 'glm-4-flash',
  'claude-3-7-sonnet-20250219', 'claude-3-5-sonnet-20241022'
]

// 快速选择服务商：点击后自动填充 baseUrl + 默认模型
export const COMMON_PROVIDERS = [
  { name: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-v4-pro' },
  { name: '通义千问 (DashScope)', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1', model: 'qwen-plus' },
  { name: 'Moonshot Kimi', baseUrl: 'https://api.moonshot.cn/v1', model: 'moonshot-v1-8k' },
  { name: '智谱 GLM', baseUrl: 'https://open.bigmodel.cn/api/paas/v4', model: 'glm-4-flash' },
  { name: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: 'gpt-4o-mini' }
]
