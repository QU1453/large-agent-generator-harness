// 通用搜索选择器（Trae 式）：输入文字即时过滤，点击选中。
// items: [{id, label, desc?, icon?}]；value: id；onChange(id)
// 弹层用 createPortal 挂到 body：画布/节点等 transform 容器内 position:fixed 会失效，导致弹层错位打不开
import { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

export default function SearchSelect({ items = [], value, onChange, placeholder = '搜索选择…', empty = '无匹配项', className = '', popClass = '' }) {
  const [open, setOpen] = useState(false)
  const [q, setQ] = useState('')
  const [pos, setPos] = useState(null) // 弹层 fixed 坐标（在 overflow 容器内也能弹出）
  const btnRef = useRef(null)
  const popRef = useRef(null)

  useEffect(() => {
    const close = (e) => {
      const inBtn = btnRef.current && btnRef.current.contains(e.target)
      const inPop = popRef.current && popRef.current.contains(e.target)
      if (!inBtn && !inPop) setOpen(false)
    }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [])

  const toggle = () => {
    const next = !open
    setOpen(next)
    setQ('')
    if (next && btnRef.current) {
      const r = btnRef.current.getBoundingClientRect()
      const popW = Math.min(340, Math.max(240, r.width))
      let left = r.left
      if (left + popW > window.innerWidth - 12) left = Math.max(8, window.innerWidth - popW - 12)
      setPos({ left, top: r.bottom + 6 })
    }
  }

  const kw = q.trim().toLowerCase()
  const filtered = items.filter((it) => {
    if (!kw) return true
    const hay = `${it.label || ''} ${it.desc || ''} ${it.keywords || ''}`.toLowerCase()
    return hay.includes(kw)
  })

  const current = items.find((it) => it.id === value)

  return (
    <div className={`search-select${className ? ' ' + className : ''}`}>
      <button
        ref={btnRef}
        className="search-select-cur"
        onClick={toggle}
        title={current ? current.desc || current.label : placeholder}
      >
        <span className="search-select-cur-label">{current ? `${current.icon ? current.icon + ' ' : ''}${current.label}` : placeholder}</span>
        <span className="search-select-caret">▾</span>
      </button>
      {open && pos && createPortal(
        <div
          ref={popRef}
          className={`search-select-pop${popClass ? ' ' + popClass : ''}`}
          style={{ left: pos.left, top: pos.top }}
        >
          <input
            className="input search-select-input"
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="输入关键字搜索…"
            onKeyDown={(e) => {
              if (e.key === 'Enter' && filtered.length === 1) { onChange(filtered[0].id); setOpen(false) }
              if (e.key === 'Escape') setOpen(false)
            }}
          />
          <div className="search-select-list">
            {filtered.length === 0 && <div className="search-select-empty">{empty}</div>}
            {filtered.map((it) => (
              <button
                key={it.id}
                className={`search-select-item${it.id === value ? ' active' : ''}`}
                onClick={() => { onChange(it.id); setOpen(false) }}
              >
                <span className="search-select-item-label">{it.icon ? `${it.icon} ` : ''}{it.label}</span>
                {it.desc && <span className="search-select-item-desc">{it.desc}</span>}
              </button>
            ))}
          </div>
        </div>,
        document.body
      )}
    </div>
  )
}
