// 新建分类弹窗：Electron 不支持 window.prompt，统一用应用内输入框
import { useEffect, useRef, useState } from 'react'

export default function CategoryModal({ open, title = '新建分类文件夹', placeholder = '如：记忆管理 / 编码 / 数学', onCreate, onClose }) {
  const [name, setName] = useState('')
  const inputRef = useRef(null)

  useEffect(() => {
    if (open) {
      setName('')
      setTimeout(() => inputRef.current && inputRef.current.focus(), 30)
    }
  }, [open])

  if (!open) return null

  const submit = async () => {
    const n = name.trim()
    if (!n) return
    try {
      await onCreate(n)
      setName('')
      onClose()
    } catch (e) {
      alert(e.message || String(e))
    }
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal export-modal" onClick={(e) => e.stopPropagation()}>
        <div className="modal-header">
          <div className="editor-title"><span>📁 {title}</span></div>
          <button className="icon-btn" onClick={onClose}>✕</button>
        </div>
        <div className="export-body">
          <label className="export-field">
            <span>分类名称</span>
            <input
              ref={inputRef}
              className="input"
              value={name}
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') submit() }}
              placeholder={placeholder}
            />
          </label>
        </div>
        <div className="modal-footer">
          <button className="btn ghost" onClick={onClose}>取消</button>
          <button className="btn primary" onClick={submit} disabled={!name.trim()}>创建</button>
        </div>
      </div>
    </div>
  )
}
