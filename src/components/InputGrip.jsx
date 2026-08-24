// 输入框上边沿拖拽手柄：按住往上拖，输入框向上扩张变高
// 使用：放在 <textarea> 正上方同一容器内，拖拽时调整该容器内第一个 textarea 的高度
export default function InputGrip({ minH = 36, maxH = 240 }) {
  const grab = (e) => {
    e.preventDefault()
    e.stopPropagation()
    const wrap = e.currentTarget.parentElement
    const ta = wrap ? wrap.querySelector('textarea') : null
    if (!ta) return
    const startH = ta.offsetHeight
    const startY = e.clientY
    const move = (ev) => {
      const next = Math.max(minH, Math.min(maxH, startH + (startY - ev.clientY)))
      ta.style.height = next + 'px'
    }
    const up = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', up)
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', up)
  }
  return <div className="input-grip" title="向上拖动扩张输入框" onMouseDown={grab} />
}
