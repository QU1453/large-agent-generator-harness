// 共享 A2A 安全协议编辑器（工作流智能体节点 / 记忆画布智能体节点共用）
// props: { open, title, draft, onChange(patch), onPeers(key, csvText), onSave, onCancel }
export default function A2AEditor({ open, title, draft, onChange, onPeers, onSave, onCancel }) {
  if (!open || !draft) return null
  return (
    <div className="modal-overlay" onClick={onCancel}>
      <div className="modal wf-proto-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="editor-title">
            <span>{title || '🔐 A2A 安全协议'}</span>
            {draft.enabled && <span className="proto-on-badge">已启用</span>}
          </div>
          <button className="icon-btn" onClick={onCancel}>✕</button>
        </div>
        <div className="modal-body wf-proto-body">
          <div className="skill-card-desc">
            智能体间通信按 A2A 协议：先校验来源（访问控制）→ 消息封装为 <code>[[A2A …]]</code> 信封 → 交 LLM 处理 → 审计留痕。
            协议配置保存在节点卡片上，随画布持久化、随导出固化；可自定义版本/身份/端点/凭证/白名单。
          </div>
          <label className="field switch-row">
            <span className="field-label">启用协议</span>
            <input type="checkbox" checked={draft.enabled} onChange={(e) => onChange({ enabled: e.target.checked })} />
          </label>
          <label className="field">
            <span className="field-label">协议版本</span>
            <input className="input" value={draft.version} onChange={(e) => onChange({ version: e.target.value })} placeholder="A2A/1.0" />
          </label>
          <label className="field">
            <span className="field-label">身份声明 identity</span>
            <input className="input" value={draft.identity} onChange={(e) => onChange({ identity: e.target.value })} placeholder="本技能在协议中的身份（默认 skillId）" />
          </label>
          <label className="field">
            <span className="field-label">对外端点 endpoint（agent card 声明，可留空）</span>
            <input className="input" value={draft.endpoint} onChange={(e) => onChange({ endpoint: e.target.value })} placeholder="https://… 或留空" />
          </label>
          <div className="field">
            <span className="field-label">凭证 auth（共享密钥，仅留痕，不用于网络握手）</span>
            <div className="wf-proto-auth">
              <select
                className="input"
                value={draft.auth.type}
                onChange={(e) => onChange({ auth: { ...draft.auth, type: e.target.value } })}
              >
                <option value="none">无</option>
                <option value="token">token 令牌</option>
                <option value="hmac">hmac 签名</option>
              </select>
              {draft.auth.type !== 'none' && (
                <input
                  className="input"
                  placeholder="secret / token"
                  value={draft.auth.secret}
                  onChange={(e) => onChange({ auth: { ...draft.auth, secret: e.target.value } })}
                />
              )}
            </div>
          </div>
          <label className="field">
            <span className="field-label">允许来源 allowedPeers（留空=不限制；填 skillId，逗号分隔）</span>
            <input className="input" value={(draft.access.allowedPeers || []).join(', ')} onChange={(e) => onPeers('allowedPeers', e.target.value)} placeholder="如: researcher, writer" />
          </label>
          <label className="field">
            <span className="field-label">拒绝来源 deniedPeers（skillId，逗号分隔）</span>
            <input className="input" value={(draft.access.deniedPeers || []).join(', ')} onChange={(e) => onPeers('deniedPeers', e.target.value)} placeholder="如: malicious_agent" />
          </label>
          <label className="field">
            <span className="field-label">允许工具 allowedTools（留空=不限制；工具名，逗号分隔，P4-1 工具管道 pre-execute 拦截）</span>
            <input className="input" value={(draft.access.allowedTools || []).join(', ')} onChange={(e) => onPeers('allowedTools', e.target.value)} placeholder="如: read_file, list_dir" />
          </label>
          <label className="field">
            <span className="field-label">拒绝工具 deniedTools（工具名，逗号分隔，命中即拦截）</span>
            <input className="input" value={(draft.access.deniedTools || []).join(', ')} onChange={(e) => onPeers('deniedTools', e.target.value)} placeholder="如: write_file" />
          </label>
          <label className="field switch-row">
            <span className="field-label">审计日志（写入 data/audit/&lt;画布&gt;.jsonl）</span>
            <input type="checkbox" checked={draft.audit} onChange={(e) => onChange({ audit: e.target.checked })} />
          </label>
        </div>
        <div className="modal-footer">
          <button className="btn ghost" onClick={onCancel}>取消</button>
          <button className="btn primary" onClick={onSave}>💾 保存协议</button>
        </div>
      </div>
    </div>
  )
}
