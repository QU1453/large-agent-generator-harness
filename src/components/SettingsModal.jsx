import { useState } from 'react'
import { COMMON_PROVIDERS, PRESET_MODELS } from '../lib/models.js'

// 内置渐变壁纸预设
const GRADIENTS = [
  { name: '极光紫', value: 'linear-gradient(135deg, #0f0c29, #302b63, #24243e)' },
  { name: '深海蓝', value: 'linear-gradient(135deg, #0f2027, #203a43, #2c5364)' },
  { name: '暮色橙', value: 'linear-gradient(135deg, #1a1a2e, #16213e, #0f3460)' },
  { name: '森林绿', value: 'linear-gradient(135deg, #0b3d2e, #14532d, #065f46)' },
  { name: '暗夜红', value: 'linear-gradient(135deg, #2d1b1b, #3d1d1d, #1a0e0e)' }
]

const SHORTCUTS = [
  ['Ctrl+S', '保存（代码编辑器 / 工作流画布）'],
  ['Enter', '会话发送消息'],
  ['Shift+Enter', '会话换行']
]

function Field({ label, hint, children }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  )
}

export default function SettingsModal({ settings, apiStatus, onSave, onToggleApi, onClose }) {
  const [form, setForm] = useState({
    baseUrl: settings.baseUrl || '',
    apiKey: settings.apiKey || '',
    model: settings.model || '',
    apiPort: settings.apiPort || 37800,
    apiToken: settings.apiToken || '',
    enableApiServer: settings.enableApiServer !== false,
    wallpaper: settings.wallpaper || { type: 'none', value: '' }
  })
  const [activeTab, setActiveTab] = useState('llm')

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))
  const setWallpaper = (patch) => setForm((f) => ({ ...f, wallpaper: { ...f.wallpaper, ...patch } }))

  const submit = () => {
    onSave({
      baseUrl: form.baseUrl.trim(),
      apiKey: form.apiKey.trim(),
      model: form.model.trim(),
      apiPort: Number(form.apiPort) || 37800,
      apiToken: form.apiToken.trim(),
      enableApiServer: form.enableApiServer,
      wallpaper: form.wallpaper
    })
  }

  const pickWallpaperImage = async () => {
    const p = await window.harness.settings.pickWallpaper()
    if (p) setWallpaper({ type: 'image', value: p })
  }

  const applyProvider = (p) => {
    setForm((f) => ({
      ...f,
      baseUrl: p.baseUrl,
      model: p.model
    }))
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <h2>设置</h2>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>

        <div className="modal-tabs">
          <button className={`tab ${activeTab === 'llm' ? 'active' : ''}`} onClick={() => setActiveTab('llm')}>
            模型接口
          </button>
          <button className={`tab ${activeTab === 'api' ? 'active' : ''}`} onClick={() => setActiveTab('api')}>
            外部 API
          </button>
          <button className={`tab ${activeTab === 'look' ? 'active' : ''}`} onClick={() => setActiveTab('look')}>
            外观
          </button>
        </div>

        <div className="modal-body">
          {activeTab === 'llm' && (
            <div className="settings-form">
              <div className="provider-row">
                <span className="field-label">快速选择服务商</span>
                <div className="provider-chips">
                  {COMMON_PROVIDERS.map((p) => (
                    <button key={p.name} className="chip" onClick={() => applyProvider(p)}>{p.name}</button>
                  ))}
                </div>
              </div>
              <Field label="API Base URL" hint="OpenAI 兼容接口地址，结尾不需要 /chat/completions">
                <input
                  className="input"
                  value={form.baseUrl}
                  placeholder="https://api.deepseek.com/v1"
                  onChange={(e) => set('baseUrl', e.target.value)}
                />
              </Field>
              <Field label="API Key">
                <input
                  className="input"
                  type="password"
                  value={form.apiKey}
                  placeholder="sk-..."
                  onChange={(e) => set('apiKey', e.target.value)}
                />
              </Field>
              <Field label="默认模型" hint="智能体未指定 model 时使用此模型（可从预置选择，也可手动输入）">
                <input
                  className="input"
                  list="preset-models-settings"
                  value={form.model}
                  placeholder="deepseek-v4-pro"
                  onChange={(e) => set('model', e.target.value)}
                />
                <datalist id="preset-models-settings">
                  {PRESET_MODELS.map((m) => <option key={m} value={m} />)}
                </datalist>
              </Field>
            </div>
          )}

          {activeTab === 'api' && (
            <div className="settings-form">
              <div className="toggle-row">
                <div>
                  <div className="toggle-title">启用外部 API 服务</div>
                  <div className="field-hint">允许 Trae 等外部工具通过 HTTP 调用本 Harness</div>
                </div>
                <button
                  className={`toggle ${form.enableApiServer ? 'on' : ''}`}
                  onClick={() => set('enableApiServer', !form.enableApiServer)}
                >
                  <span className="toggle-knob" />
                </button>
              </div>

              <Field label="监听端口">
                <input
                  className="input"
                  type="number"
                  value={form.apiPort}
                  onChange={(e) => set('apiPort', e.target.value)}
                />
              </Field>
              <Field label="访问令牌 (Token)" hint="留空则不鉴权。设置后外部调用需携带 Authorization: Bearer <token>">
                <input
                  className="input"
                  type="password"
                  value={form.apiToken}
                  placeholder="留空表示无需令牌"
                  onChange={(e) => set('apiToken', e.target.value)}
                />
              </Field>

              <div className="api-status-box">
                <div className="api-status-row">
                  <span className={`dot ${apiStatus.running ? 'on' : 'off'}`} />
                  <span>
                    {apiStatus.running
                      ? `API 服务运行中 · http://127.0.0.1:${apiStatus.port}`
                      : 'API 服务未运行'}
                  </span>
                </div>
                <pre className="api-example">
{`# 调用示例（SSE 流式）
curl -N http://127.0.0.1:${form.apiPort}/api/chat \\
  -H "Content-Type: application/json" \\
  -H "Authorization: Bearer ${form.apiToken || '<token>'}" \\
  -d '{"skillId":"coder","message":"帮我看看这个项目"}'`}
                </pre>
              </div>
            </div>
          )}

          {activeTab === 'look' && (
            <div className="settings-form">
              <div className="wallpaper-section">
                <span className="field-label">壁纸</span>
                <div className="provider-chips">
                  {[
                    ['none', '无'],
                    ['color', '纯色'],
                    ['gradient', '渐变'],
                    ['image', '图片']
                  ].map(([t, label]) => (
                    <button
                      key={t}
                      className={`chip ${form.wallpaper.type === t ? 'active' : ''}`}
                      onClick={() => setWallpaper({ type: t, value: t === 'gradient' ? GRADIENTS[0].value : '' })}
                    >{label}</button>
                  ))}
                </div>
                {form.wallpaper.type === 'color' && (
                  <div className="wallpaper-row">
                    <input
                      type="color"
                      className="color-input"
                      value={/^#[0-9a-f]{6}$/i.test(form.wallpaper.value) ? form.wallpaper.value : '#0d1017'}
                      onChange={(e) => setWallpaper({ value: e.target.value })}
                    />
                    <span className="field-hint">选择内容区底色</span>
                  </div>
                )}
                {form.wallpaper.type === 'gradient' && (
                  <div className="wallpaper-row wrap">
                    {GRADIENTS.map((g) => (
                      <button
                        key={g.name}
                        className={`chip ${form.wallpaper.value === g.value ? 'active' : ''}`}
                        style={{ background: g.value }}
                        onClick={() => setWallpaper({ value: g.value })}
                        title={g.name}
                      >
                        <span className="chip-on-dark">{g.name}</span>
                      </button>
                    ))}
                  </div>
                )}
                {form.wallpaper.type === 'image' && (
                  <div className="wallpaper-row">
                    <input
                      className="input"
                      value={form.wallpaper.value}
                      placeholder="选择一张本地图片作为壁纸"
                      readOnly
                    />
                    <button className="btn ghost" onClick={pickWallpaperImage}>选择图片…</button>
                  </div>
                )}
              </div>

              <div className="shortcut-section">
                <span className="field-label">快捷键</span>
                <div className="shortcut-list">
                  {SHORTCUTS.map(([k, d]) => (
                    <div className="shortcut-row" key={k}>
                      <kbd>{k}</kbd>
                      <span>{d}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <div className="modal-footer">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={submit}>保存设置</button>
        </div>
      </div>
    </div>
  )
}
