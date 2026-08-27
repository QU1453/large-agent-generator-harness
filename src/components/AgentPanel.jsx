import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import hljs from 'highlight.js'
import { h, fmtTime } from '../lib/harness.js'
import SearchSelect from './SearchSelect.jsx'
import CategoryModal from './CategoryModal.jsx'

const NODE_W = 210
const PORT_Y = 34 // 端口位于节点头部中心

// 唯一 id：时间戳前缀防止应用重启后与已保存工作流的 id 冲突（曾导致删除错线）
let uid = 0
const nid = () => 'n' + Date.now().toString(36) + (++uid).toString(36)

const NODE_META = {
  input: { icon: '⌨️', name: '输入', color: 'rgba(110,168,255,0.14)' },
  skill: { icon: '🤖', name: '技能', color: 'rgba(139,124,246,0.14)' },
  tool: { icon: '🔧', name: '工具', color: 'rgba(63,208,201,0.14)' },
  subagent: { icon: '🔄', name: '子智能体', color: 'rgba(250,170,60,0.13)' },
  bus: { icon: '🚌', name: '通信总线', color: 'rgba(90,180,255,0.13)' },
  flow: { icon: '🔀', name: '控制流', color: 'rgba(255,196,90,0.15)' },
  custom: { icon: '🧩', name: '自定义', color: 'rgba(250,170,60,0.14)' },
  output: { icon: '📤', name: '输出', color: 'rgba(56,214,196,0.14)' },
  memory: { icon: '🧠', name: '记忆', color: 'rgba(124,198,90,0.15)' }
}

const portIn = (n) => ({ x: n.x, y: n.y + PORT_Y })
const portOut = (n) => ({ x: n.x + (n.w || NODE_W), y: n.y + PORT_Y })

// 连线类型（多智能体协同）：数据流 / 消息 / 广播 / 回调
const EDGE_TYPES = {
  data: { label: '数据', icon: '➤', hint: '数据流：上游输出 → 下游输入（流水线）' },
  message: { label: '消息', icon: '✉️', hint: '消息：智能体间发送任务/对话' },
  broadcast: { label: '广播', icon: '📢', hint: '广播：一个智能体分发多个下游并行处理' },
  callback: { label: '回调', icon: '↩', hint: '回调：下游处理完回传上游重跑（评审/回环）' }
}

// 模板库：一键生成多智能体画布（build(skills) → { nodes, edges }）
const WF_TEMPLATES = [
  {
    id: 'orchestrator', name: '主管-工人', icon: '👔',
    desc: '主管把任务广播给多个工人并行处理，再汇总输出',
    build: (s) => {
      const sid = s[0]?.id || 'assistant'
      const nodes = [
        { id: nid(), type: 'input', text: '把任务拆给两个工人处理', label: '输入', x: 40, y: 180, w: 200 },
        { id: nid(), type: 'skill', skillId: sid, prompt: '你是主管：把任务拆解后分发给工人，并汇总工人结果。', label: '主管', x: 280, y: 160, w: 210 },
        { id: nid(), type: 'skill', skillId: sid, prompt: '你是工人A：专注完成分配给你的子任务。', label: '工人A', x: 560, y: 40, w: 200 },
        { id: nid(), type: 'skill', skillId: sid, prompt: '你是工人B：专注完成分配给你的子任务。', label: '工人B', x: 560, y: 280, w: 200 },
        { id: nid(), type: 'output', label: '输出', x: 820, y: 180, w: 200 }
      ]
      const [inN, boss, w1, w2, out] = nodes
      return {
        nodes,
        edges: [
          { id: nid(), from: inN.id, to: boss.id, type: 'data' },
          { id: nid(), from: boss.id, to: w1.id, type: 'broadcast' },
          { id: nid(), from: boss.id, to: w2.id, type: 'broadcast' },
          { id: nid(), from: w1.id, to: out.id, type: 'data' },
          { id: nid(), from: w2.id, to: out.id, type: 'data' }
        ]
      }
    }
  },
  {
    id: 'review', name: '评审回环', icon: '🔄',
    desc: '生成 → 评审 → 意见回调生成反复打磨（最多 2 轮）',
    build: (s) => {
      const sid = s[0]?.id || 'assistant'
      const nodes = [
        { id: nid(), type: 'input', text: '写一段产品宣传文案', label: '输入', x: 40, y: 180, w: 200 },
        { id: nid(), type: 'skill', skillId: sid, prompt: '你是文案生成器：根据上游要求撰写内容。', label: '生成', x: 280, y: 160, w: 210 },
        { id: nid(), type: 'skill', skillId: sid, prompt: '你是评审官：严格审查上游内容，指出问题与改进建议，反馈给生成器。', label: '评审', x: 560, y: 160, w: 210 },
        { id: nid(), type: 'output', label: '输出', x: 820, y: 180, w: 200 }
      ]
      const [inN, gen, rev, out] = nodes
      return {
        nodes,
        edges: [
          { id: nid(), from: inN.id, to: gen.id, type: 'data' },
          { id: nid(), from: gen.id, to: rev.id, type: 'data' },
          { id: nid(), from: rev.id, to: out.id, type: 'data' },
          { id: nid(), from: rev.id, to: gen.id, type: 'callback' }
        ]
      }
    }
  },
  {
    id: 'rag', name: 'RAG 管道', icon: '📚',
    desc: '记忆检索 + 智能体回答（记忆节点读取架构内容）',
    build: (s) => {
      const sid = s[0]?.id || 'assistant'
      const nodes = [
        { id: nid(), type: 'input', text: '基于我的记忆回答：', label: '输入', x: 40, y: 140, w: 200 },
        { id: nid(), type: 'memory', memoryArch: '', reads: [{ arch: '', scope: 'facts' }], writes: [], label: '记忆', x: 40, y: 320, w: 360, h: 200 },
        { id: nid(), type: 'skill', skillId: sid, prompt: '你是知识助理：结合上游的记忆内容回答用户问题。', label: '技能', x: 460, y: 180, w: 210 },
        { id: nid(), type: 'output', label: '输出', x: 740, y: 180, w: 200 }
      ]
      const [inN, mem, ag, out] = nodes
      return {
        nodes,
        edges: [
          { id: nid(), from: inN.id, to: ag.id, type: 'data' },
          { id: nid(), from: mem.id, to: ag.id, type: 'data' },
          { id: nid(), from: ag.id, to: out.id, type: 'data' }
        ]
      }
    }
  },
  {
    id: 'pipeline', name: '流水线', icon: '🏭',
    desc: '多个智能体依次加工：上游输出成为下游输入',
    build: (s) => {
      const sid = s[0]?.id || 'assistant'
      const nodes = [
        { id: nid(), type: 'input', text: '输入原始数据', label: '输入', x: 40, y: 180, w: 200 },
        { id: nid(), type: 'skill', skillId: sid, prompt: '第一道工序：清洗/整理输入。', label: '技能1', x: 280, y: 160, w: 210 },
        { id: nid(), type: 'skill', skillId: sid, prompt: '第二道工序：基于上游结果做最终加工。', label: '技能2', x: 560, y: 160, w: 210 },
        { id: nid(), type: 'output', label: '输出', x: 820, y: 180, w: 200 }
      ]
      const [inN, a, b, out] = nodes
      return {
        nodes,
        edges: [
          { id: nid(), from: inN.id, to: a.id, type: 'data' },
          { id: nid(), from: a.id, to: b.id, type: 'data' },
          { id: nid(), from: b.id, to: out.id, type: 'data' }
        ]
      }
    }
  }
]

// 各节点类型的最小尺寸（缩放下限，保证形态语义：总线=长条、记忆=大正方形）
const MIN_SIZE = {
  bus: { w: 340, h: 72 },
  memory: { w: 280, h: 280 },
  default: { w: 170, h: 110 }
}

function makeNode(type, x, y, skills) {
  const base = {
    id: nid(),
    type,
    label: NODE_META[type].name,
    x, y,
    skillId: type === 'skill' ? (skills[0]?.id || 'assistant') : undefined,
    subagentId: type === 'subagent' ? '' : undefined,
    prompt: '',
    text: '',
    readZones: '',
    writeZones: '',
    tools: [],
    memories: []
  }
  if (type === 'memory') {
    // 记忆管理节点：非常大的正方形，提供多个读取/写入接口
    return { ...base, memoryArch: '', reads: [], writes: [], w: 360, h: 360 }
  }
  if (type === 'tool') {
    return { ...base, toolId: '', mode: 'mcp', code: '', prompt: '', manual: '', w: 210, h: 170 }
  }
  if (type === 'custom') {
    // 自定义模块节点：执行用户定义的 Python 代码（def run(input_text)）
    return { ...base, customId: '', code: '', w: 210, h: 140 }
  }
  if (type === 'bus') {
    // 通信总线节点：长条形主干道，外部节点（技能/记忆）拖线挂到连接点（points）上按序处理
    return { ...base, points: [], w: 480, h: 150 }
  }
  if (type === 'flow') {
    // 控制流节点：条件分流（branch）/ 循环（loop）/ 汇聚（merge），规则由下游边的 when 表达式决定
    return { ...base, flowType: 'merge', maxLoops: 3, w: 210, h: 110 }
  }
  return base
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v))

const MINI_W = 168
const MINI_H = 116

export default function AgentPanel({ skills, agRunning = false, agRunStates = {}, agNodeOutputs = {}, onRunStart, onToast, onEditSkill, onEditMcp }) {
  const [agents, setAgents] = useState([])
  const [defs, setDefs] = useState([]) // 智能体定义（「智能体」栏）：子智能体节点可选
  const [mode, setMode] = useState('list') // 'list' | 'canvas'
  const [cats, setCats] = useState({ list: [], map: {} })
  const [q, setQ] = useState('')
  const [cardMenu, setCardMenu] = useState(null) // {a, x, y}
  const [catModal, setCatModal] = useState(false)
  const [wf, setWf] = useState(null)
  const [running, setRunning] = useState(agRunning)
  // 跨页恢复：切到别的页面再回来时，从 App 全局状态恢复"运行中"与各节点状态
  const [runStates, setRunStates] = useState(agRunStates)
  const [nodeOutputs, setNodeOutputs] = useState(agNodeOutputs)
  const [selectedEdgeId, setSelectedEdgeId] = useState(null)
  const [ctxMenu, setCtxMenu] = useState(null) // {x, y, edgeId}
  const [view, setView] = useState({ x: 0, y: 0, zoom: 1 }) // 视口变换
  const [ex, setEx] = useState(null) // 导出弹窗 {name, desc, busy, result, exeBusy, exeResult}
  const [canvasSize, setCanvasSize] = useState({ w: 800, h: 600 }) // 画布可视尺寸（跟随窗口 resize）
  const [linkModal, setLinkModal] = useState(null) // 工具/技能链接弹窗 {nodeId, type:'tools'|'skills'}
  const [linkQ, setLinkQ] = useState('') // 链接弹窗搜索关键字
  const [toolCatalog, setToolCatalog] = useState(null) // {builtin, toolPacks} 工具数据源（懒加载）
  const [memoryList, setMemoryList] = useState([]) // 记忆架构列表（记忆节点用）
  // 记忆节点读取/写入接口弹窗
  const [memIfModal, setMemIfModal] = useState(null) // {nodeId, kind:'read'|'write'}
  const [memIfDraft, setMemIfDraft] = useState({ label: '', arch: '', scope: '' })
  // 画布配置尺寸（节点超出会自动扩展）+ 多选 + 框选
  const [canvasCfg, setCanvasCfg] = useState({ w: 1600, h: 1000 })
  const [selectedNodes, setSelectedNodes] = useState(() => new Set())
  const [marquee, setMarquee] = useState(null) // {x1,y1,x2,y2} 世界坐标框选矩形
  const viewRef = useRef(view)
  const dragRef = useRef(null) // {type, nodeId|fromNodeId, startX, startY, origX, origY}
  const canvasRef = useRef(null)
  const mmRef = useRef(null)

  const setViewSafe = useCallback((updater) => {
    setView((cur) => {
      const nv = typeof updater === 'function' ? updater(cur) : updater
      viewRef.current = nv
      return nv
    })
  }, [])

  // 画布尺寸跟踪：窗口缩放时，小地图视口矩形 / 点击定位才能同步更新
  // mode 依赖：画布渲染后 canvasRef 才存在，否则 observe 挂不上
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const ro = new ResizeObserver(() => {
      const r = el.getBoundingClientRect()
      setCanvasSize({ w: r.width, h: r.height })
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [mode])

  const refreshList = useCallback(async () => {
    setAgents(await h.agents.list())
  }, [])

  // ---- 分类文件夹（智能体管理页） ----
  const saveNewCategory = async (name) => {
    setCats(await h.agents.addCategory(name))
    onToast?.(`分类「${name}」已创建`, 'success')
  }

  const changeAgentCategory = async (a, name) => {
    try {
      setCats(await h.agents.setCategory(a.id, name))
      await refreshList()
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const deleteCategory = async (cat) => {
    if (!confirm(`删除分类文件夹「${cat}」？\n归到该分类的智能体会移回「未分类」，智能体本身不会被删除。`)) return
    try {
      setCats(await h.agents.removeCategory(cat))
      await refreshList()
      onToast?.(`分类「${cat}」已删除`, 'success')
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const doDeleteAgent = async (a) => {
    if (!confirm(`删除工作流「${a.name}」？\n引用它的子智能体节点将失效。`)) return
    try {
      await h.agents.delete(a.id)
      await refreshList()
      onToast?.(`智能体「${a.name}」已删除`, 'success')
    } catch (e) {
      onToast?.(e.message || String(e), 'error')
    }
  }

  const loadAgent = useCallback(async (id) => {
    const w = await h.agents.get(id)
    if (w) {
      setWf(w)
      setMode('canvas')
      setRunStates({})
      setNodeOutputs({})
      setSelectedNodes(new Set())
      setMarquee(null)
      // 恢复该智能体上次保存的画布视口位置（不用每次打开都移动窗口）
      try {
        const saved = localStorage.getItem(`wf-view:${id}`)
        if (saved) {
          const v = JSON.parse(saved)
          if (v && typeof v.x === 'number') setViewSafe(v)
        }
      } catch {}
    }
  }, [])

  // 视口持久化：随 view/智能体变化自动保存（切出再打开时恢复位置）
  useEffect(() => {
    if (!wf?.id) return
    try { localStorage.setItem(`wf-view:${wf.id}`, JSON.stringify(view)) } catch {}
  }, [view, wf?.id])

  // 初始化 + 运行事件
  useEffect(() => {
    ;(async () => {
      const list = await h.agents.list()
      setAgents(list)
      h.agents.categories().then(setCats).catch(() => {})
      h.agdefs.list().then(setDefs).catch(() => {})
    })()
    h.memory.list().then(setMemoryList).catch(() => {})
    h.tools.list().then(setToolCatalog).catch(() => {})
    h.customNodes.list().then(setCustomNodes).catch(() => {})
    const unStatus = h.agents.onStatus(({ nodeId, status, error }) => {
      setRunStates((s) => ({ ...s, [nodeId]: { status, error } }))
    })
    const unOutput = h.agents.onOutput(({ nodeId, output }) => {
      setNodeOutputs((s) => ({ ...s, [nodeId]: output }))
    })
    const unDone = h.agents.onDone(({ ok, error }) => {
      setRunning(false)
      if (ok) onToast('智能体执行完成', 'success')
      else onToast(error || '智能体执行失败', 'error')
    })
    return () => { unStatus(); unOutput(); unDone() }
  }, [loadAgent, refreshList, onToast])

  // 滚轮缩放（原生监听以支持 passive:false；mode 依赖：画布渲染后 canvasRef 才存在，否则监听挂不上）
  useEffect(() => {
    const el = canvasRef.current
    if (!el) return
    const onWheel = (e) => {
      // 输入控件内滚轮交给原生滚动，不缩放画布
      if (e.target.closest('textarea, input, select')) return
      e.preventDefault()
      const rect = el.getBoundingClientRect()
      const v = viewRef.current
      const mx = e.clientX - rect.left
      const my = e.clientY - rect.top
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12
      const newZoom = clamp(v.zoom * factor, 0.3, 2.5)
      const k = newZoom / v.zoom
      setViewSafe((cur) => ({ x: mx - (mx - cur.x) * k, y: my - (my - cur.y) * k, zoom: newZoom }))
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  }, [setViewSafe, mode])

  // 更新节点
  const updateNode = (id, patch) => {
    setWf((prev) => prev && {
      ...prev,
      nodes: prev.nodes.map((n) => (n.id === id ? { ...n, ...patch } : n))
    })
  }
  // 总线连接点：增删 / 字段更新（可读/可写区域）；技能/记忆节点经连线（edge.pointId）挂接到连接点上
  const patchPoint = (nodeId, ptId, patch) => {
    setWf((prev) => prev && ({
      ...prev,
      nodes: prev.nodes.map((n) => n.id === nodeId
        ? { ...n, points: (n.points || []).map((p) => (p.id === ptId ? { ...p, ...patch } : p)) }
        : n)
    }))
  }
  const addPoint = (nodeId) => {
    setWf((prev) => prev && ({
      ...prev,
      nodes: prev.nodes.map((n) => n.id === nodeId
        ? (() => {
            const pts = [...(n.points || []), { id: nid(), x: 0, readZones: '', writeZones: '' }]
            // 均分：第 i 个（共 n 个）连接点 x = (i + 0.5) / n，保证间隔一致
            return { ...n, points: pts.map((p, i) => ({ ...p, x: (i + 0.5) / pts.length })) }
          })()
        : n)
    }))
  }
  const removePoint = (nodeId, ptId) => {
    setWf((prev) => prev && (() => {
      const n = prev.nodes.find((x) => x.id === nodeId)
      const pts = (n ? n.points : []).filter((p) => p.id !== ptId)
      return {
        ...prev,
        nodes: prev.nodes.map((x) => x.id === nodeId
          ? { ...x, points: pts.map((p, i) => ({ ...p, x: pts.length ? (i + 0.5) / pts.length : 0 })) }
          : x),
        edges: prev.edges.filter((ed) => !(ed.to === nodeId && ed.pointId === ptId))
      }
    })())
  }
  // 挂接到某总线连接点的外部节点（经 edge.pointId）
  const attachedNodes = (busId, ptId) => {
    if (!wf) return []
    return wf.edges
      .filter((ed) => ed.to === busId && ed.pointId === ptId)
      .map((ed) => wf.nodes.find((n) => n.id === ed.from))
      .filter(Boolean)
  }

  // ---- 记忆节点：读取/写入接口 ----
  const openMemIf = (nodeId, kind) => {
    const node = wf?.nodes?.find((n) => n.id === nodeId)
    if (!node) return
    const arr = kind === 'read' ? node.reads || [] : node.writes || []
    const arch = node.memoryArch || (memoryList[0] && memoryList[0].name) || ''
    setMemIfDraft({
      label: `${kind === 'read' ? '读取' : '写入'}${arr.length + 1}`,
      arch,
      scope: kind === 'read' ? 'facts' : 'episodes'
    })
    setMemIfModal({ nodeId, kind })
  }
  const addMemIf = () => {
    if (!memIfModal) return
    const node = wf?.nodes?.find((n) => n.id === memIfModal.nodeId)
    if (!node) return
    const key = memIfModal.kind === 'read' ? 'reads' : 'writes'
    const cur = Array.isArray(node[key]) ? node[key] : []
    const iface = {
      id: nid(),
      label: (memIfDraft.label || '').trim() || (memIfModal.kind === 'read' ? '读取' : '写入'),
      arch: memIfDraft.arch,
      scope: (memIfDraft.scope || '').trim() || (memIfModal.kind === 'read' ? 'facts' : 'episodes')
    }
    updateNode(node.id, { [key]: [...cur, iface] })
    setMemIfModal(null)
  }
  const removeMemIf = (nodeId, kind, ifId) => {
    const node = wf?.nodes?.find((n) => n.id === nodeId)
    if (!node) return
    const key = kind === 'read' ? 'reads' : 'writes'
    updateNode(nodeId, { [key]: (node[key] || []).filter((x) => x.id !== ifId) })
  }

  // ---- 工具/技能链接 ----
  const openToolLink = () => {
    setLinkQ('')
    if (!toolCatalog) h.tools.list().then(setToolCatalog)
  }
  const toggleNodeTool = (nodeId, ref) => {
    const node = wf?.nodes?.find((n) => n.id === nodeId)
    if (!node) return
    const cur = Array.isArray(node.tools) ? node.tools : []
    const next = cur.includes(ref) ? cur.filter((t) => t !== ref) : [...cur, ref]
    updateNode(nodeId, { tools: next })
  }
  const toggleNodeMemory = (nodeId, name) => {
    const node = wf?.nodes?.find((n) => n.id === nodeId)
    if (!node) return
    const cur = Array.isArray(node.memories) ? node.memories : []
    const next = cur.includes(name) ? cur.filter((m) => m !== name) : [...cur, name]
    updateNode(nodeId, { memories: next })
  }

  // 工具节点 / 上端点：内置工具 + 工具包工具 + 外部 MCP 工具合并为统一工具列表
  const toolOptions = useMemo(() => {
    if (!toolCatalog) return []
    const out = []
    for (const t of toolCatalog.builtin || []) out.push({ id: t.name, label: t.name, desc: t.description, parameters: t.parameters || null })
    for (const t of toolCatalog.toolPacks || []) out.push({ id: `tool:${t.name}`, label: `tool:${t.name}`, desc: t.description, packId: t.packId, parameters: t.parameters || null })
    for (const t of toolCatalog.external || []) out.push({ id: `ext:${t.name}`, label: `ext:${t.name}`, desc: t.description, packId: t.packId, parameters: t.parameters || null })
    return out
  }, [toolCatalog])

  // 生成工具操作手册文本（名称 + 用途 + 参数 JSON Schema），作为给上游智能体的建议操作手册
  const buildToolManual = (t) => {
    if (!t) return ''
    const parts = [`工具名：${t.label}`]
    if (t.desc) parts.push(`用途：${t.desc}`)
    const p = t.parameters
    if (p && p.properties) {
      const props = Object.entries(p.properties).map(([k, v]) => {
        const req = Array.isArray(p.required) && p.required.includes(k) ? '（必填）' : ''
        const en = Array.isArray(v.enum) && v.enum.length ? '（可选值：' + v.enum.join('/') + '）' : ''
        return `  - ${k}${req}: ${v.type || 'string'}${v.description ? ' — ' + v.description : ''}${en}`
      })
      if (props.length) parts.push(`参数：\n${props.join('\n')}`)
    }
    return parts.join('\n')
  }
  const pullManual = (n) => {
    const t = toolOptions.find((x) => x.id === (n.toolId || ''))
    if (!t) { onToast('请先选择一个工具', 'error'); return }
    updateNode(n.id, { manual: buildToolManual(t) })
    onToast(`已拉取「${t.label}」操作手册`, 'success')
  }
  const openToolSource = (n) => {
    const id = n.toolId || ''
    if (!id) { onToast('请先选择一个工具', 'error'); return }
    if (id.startsWith('ext:')) {
      onToast(`外部 MCP 工具「${id.slice(4)}」无本地源码，请在「工具包」页管理`, 'info')
      return
    }
    if (id.startsWith('tool:') || id.startsWith('mcp:')) {
      const t = toolOptions.find((x) => x.id === id)
      const packId = t && t.packId
      if (packId && onEditMcp) onEditMcp(packId)
      else onToast('该工具包源码文件不存在', 'error')
    } else {
      onToast(`内置工具「${id}」无独立源码文件，请在节点内编辑操作手册`, 'info')
    }
  }

  // 节点内嵌工具/技能/记忆罗列（智能体/输入/输出节点共用：工具+技能+记忆并排）
  const renderNodeLinks = (n) => (
    <div className="wf-links-v">
      <div className="wf-link-group">
        <div className="wf-link-group-head">
          <span>🧠 记忆</span>
          <button
            className="wf-link-add"
            title="链接记忆架构：运行时获得 memory_* 工具（绑定该架构目录）"
            onClick={() => { setLinkQ(''); setLinkModal({ nodeId: n.id, type: 'memories' }) }}
          >＋</button>
        </div>
        {Array.isArray(n.memories) && n.memories.length ? (
          <div className="wf-link-items">
            {n.memories.map((m) => {
              const mm = memoryList.find((x) => x.name === m)
              return (
                <div key={m} className="wf-link-item-v">
                  <span className="wf-link-name" title="点击打开记忆列表">🧠 {mm?.title || m}</span>
                  <button className="wf-link-rm" title="移除" onClick={() => toggleNodeMemory(n.id, m)}>✕</button>
                </div>
              )
            })}
          </div>
        ) : (
          <div className="wf-link-empty-v">未链接记忆</div>
        )}
      </div>
    </div>
  )

  // ---- 屏幕/世界坐标 ----
  const screenToWorld = (clientX, clientY) => {
    const rect = canvasRef.current.getBoundingClientRect()
    const v = viewRef.current
    return {
      x: (clientX - rect.left - v.x) / v.zoom,
      y: (clientY - rect.top - v.y) / v.zoom
    }
  }

  const zoomBy = (factor) => {
    const rect = canvasRef.current?.getBoundingClientRect()
    if (!rect) return
    const v = viewRef.current
    const cx = rect.width / 2
    const cy = rect.height / 2
    const newZoom = clamp(v.zoom * factor, 0.3, 2.5)
    const k = newZoom / v.zoom
    setViewSafe((cur) => ({ x: cx - (cx - cur.x) * k, y: cy - (cy - cur.y) * k, zoom: newZoom }))
  }

  const resetView = () => setViewSafe({ x: 0, y: 0, zoom: 1 })

  // ---- 拖拽 / 平移 / 连线 / 框选 / 缩放 ----
  const onMouseDown = (e) => {
    setCtxMenu(null)
    // 中键：平移画布（常见画布交互）
    if (e.button === 1) {
      e.preventDefault()
      const v = viewRef.current
      dragRef.current = { type: 'pan', startX: e.clientX, startY: e.clientY, origX: v.x, origY: v.y }
      return
    }
    if (e.button !== 0) return
    const target = e.target.closest('[data-drag-node]')
    if (target) {
      const nodeId = target.dataset.dragNode
      const n = wf?.nodes.find((x) => x.id === nodeId)
      if (!n) return
      // 选择规则：shift=追加；未选中则单选。随后整组一起拖动
      const shift = !!e.shiftKey
      const already = selectedNodes.has(nodeId)
      const group = new Set(shift || already ? selectedNodes : [])
      if (!already) group.add(nodeId)
      setSelectedNodes(group)
      const orig = {}
      for (const id of group) {
        const nn = wf.nodes.find((x) => x.id === id)
        if (nn) orig[id] = { x: nn.x, y: nn.y }
      }
      dragRef.current = { type: 'node', nodeId, ids: [...group], orig, startX: e.clientX, startY: e.clientY }
      e.preventDefault()
      return
    }
    // 点击节点本体（非头部/控件）：仅选中
    const nodeEl = e.target.closest('[data-ctx-node]')
    if (nodeEl && !e.target.closest('textarea, input, select, button, .wf-port, .wf-resize, .wf-del')) {
      const nodeId = nodeEl.dataset.ctxNode
      setSelectedNodes((prev) => (e.shiftKey ? new Set(prev).add(nodeId) : new Set([nodeId])))
      e.preventDefault()
      return
    }
    // 输入控件 / 端口 / 缩放柄：不参与框选
    if (e.target.closest('textarea, input, select, button, .wf-port, .wf-resize')) return
    // 左键空白：拉框多选（框住的内容可整体拖动）
    const w = screenToWorld(e.clientX, e.clientY)
    dragRef.current = { type: 'marquee', startX: w.x, startY: w.y, curX: w.x, curY: w.y }
    setMarquee({ x1: w.x, y1: w.y, x2: w.x, y2: w.y })
  }

  const onResizeStart = (e, nodeId) => {
    e.stopPropagation()
    e.preventDefault()
    const n = wf?.nodes.find((x) => x.id === nodeId)
    if (!n) return
    const el = e.currentTarget.closest('.wf-node')
    dragRef.current = {
      type: 'resize', nodeId,
      startX: e.clientX, startY: e.clientY,
      origW: n.w || (el ? el.offsetWidth : NODE_W),
      origH: n.h || (el ? el.offsetHeight : 150)
    }
  }

  const onConnectStart = (e, fromNodeId, pointId, side) => {
    e.stopPropagation()
    e.preventDefault()
    const w = screenToWorld(e.clientX, e.clientY)
    dragRef.current = { type: 'connect', fromNodeId, startX: e.clientX, startY: e.clientY, ...(pointId ? { pointId, side } : {}) }
    setRunStates((s) => ({ ...s, _conn: { x: w.x, y: w.y } }))
  }

  const onMouseMove = (e) => {
    const d = dragRef.current
    if (!d) return
    if (d.type === 'node') {
      const z = viewRef.current.zoom
      const dx = (e.clientX - d.startX) / z
      const dy = (e.clientY - d.startY) / z
      setWf((prev) => prev && ({
        ...prev,
        nodes: prev.nodes.map((n) => d.orig[n.id] ? { ...n, x: Math.max(0, d.orig[n.id].x + dx), y: Math.max(0, d.orig[n.id].y + dy) } : n)
      }))
    } else if (d.type === 'marquee') {
      const w = screenToWorld(e.clientX, e.clientY)
      d.curX = w.x; d.curY = w.y
      setMarquee({ x1: d.startX, y1: d.startY, x2: w.x, y2: w.y })
    } else if (d.type === 'resize') {
      const z = viewRef.current.zoom
      const node = wf?.nodes.find((x) => x.id === d.nodeId)
      const min = (node && MIN_SIZE[node.type]) || MIN_SIZE.default
      const nw = Math.max(min.w, d.origW + (e.clientX - d.startX) / z)
      const nh = Math.max(min.h, d.origH + (e.clientY - d.startY) / z)
      updateNode(d.nodeId, { w: Math.round(nw), h: Math.round(nh) })
    } else if (d.type === 'connect') {
      const w = screenToWorld(e.clientX, e.clientY)
      setRunStates((s) => ({ ...s, _conn: { x: w.x, y: w.y } }))
    } else if (d.type === 'pan') {
      setViewSafe((cur) => ({ ...cur, x: d.origX + (e.clientX - d.startX), y: d.origY + (e.clientY - d.startY) }))
    }
  }

  const onMouseUp = (e) => {
    const d = dragRef.current
    dragRef.current = null
    setRunStates((s) => { const { _conn, ...rest } = s; return rest })
    if (!wf) return
    // 框选结束：把矩形命中的节点加入选择（shift 追加，否则替换）
    if (d && d.type === 'marquee') {
      const x1 = Math.min(d.startX, d.curX), x2 = Math.max(d.startX, d.curX)
      const y1 = Math.min(d.startY, d.curY), y2 = Math.max(d.startY, d.curY)
      const hit = new Set()
      for (const n of wf.nodes) {
        const cx = n.x + (n.w || NODE_W) / 2
        const cy = n.y + (n.h ? n.h / 2 : 60)
        if (cx >= x1 && cx <= x2 && cy >= y1 && cy <= y2) hit.add(n.id)
      }
      setSelectedNodes((prev) => (e.shiftKey && prev.size ? new Set([...prev, ...hit]) : hit))
      setMarquee(null)
      return
    }
    if (!d || d.type !== 'connect') return
    const w = screenToWorld(e.clientX, e.clientY)
    const z = viewRef.current.zoom
    // 从总线连接点拖出（起点在连接点圆点）：命中普通节点（任意位置）→ 生成挂接连线（方向统一为 节点→总线）
    if (d.pointId) {
      const target = wf.nodes.find((n) => {
        if (n.type === 'bus') return false
        const bw = n.w || NODE_W
        const bh = n.h || 150
        return w.x >= n.x && w.x <= n.x + bw && w.y >= n.y && w.y <= n.y + bh
      })
      if (target && target.id !== d.fromNodeId) {
        const dup = wf.edges.some((ed) => ed.from === target.id && ed.to === d.fromNodeId && ed.pointId === d.pointId)
        if (!dup) {
          setWf((prev) => ({
            ...prev,
            edges: [...prev.edges, { id: nid(), from: target.id, to: d.fromNodeId, pointId: d.pointId }]
          }))
        }
      }
      return
    }
    // 命中通信总线连接点（上下边缘圆点）→ 生成挂接连线（edge.pointId = 连接点 id）
    let busHit = null
    for (const bn of wf.nodes) {
      if (bn.type !== 'bus') continue
      const bw = bn.w || NODE_W
      const bh = bn.h || 150
      for (const pt of bn.points || []) {
        const px = bn.x + (pt.x || 0.5) * bw
        if (Math.hypot(w.x - px, w.y - bn.y) < 16 / z + 5 || Math.hypot(w.x - px, w.y - (bn.y + bh)) < 16 / z + 5) {
          busHit = { bus: bn, point: pt }
          break
        }
      }
      if (busHit) break
    }
    if (busHit) {
      if (busHit.bus.id !== d.fromNodeId) {
        const dup = wf.edges.some((ed) => ed.from === d.fromNodeId && ed.to === busHit.bus.id && ed.pointId === busHit.point.id)
        if (!dup) {
          setWf((prev) => ({
            ...prev,
            edges: [...prev.edges, { id: nid(), from: d.fromNodeId, to: busHit.bus.id, pointId: busHit.point.id }]
          }))
        }
      }
      return
    }
    const target = wf.nodes.find((n) => {
      const p = portIn(n)
      return Math.hypot(w.x - p.x, w.y - p.y) < 20 / z + 6
    })
    if (target && target.id !== d.fromNodeId) {
      const dup = wf.edges.some((ed) => ed.from === d.fromNodeId && ed.to === target.id)
      if (!dup) {
        setWf((prev) => ({
          ...prev,
          edges: [...prev.edges, { id: nid(), from: d.fromNodeId, to: target.id, type: 'data' }]
        }))
      }
    }
  }

  // 删除选中的多个节点（含相连连线）
  const deleteSelectedNodes = () => {
    if (!wf || !selectedNodes.size) return
    setWf((prev) => ({
      ...prev,
      nodes: prev.nodes.filter((n) => !selectedNodes.has(n.id)),
      edges: prev.edges.filter((ed) => !selectedNodes.has(ed.from) && !selectedNodes.has(ed.to))
    }))
    setSelectedNodes(new Set())
    setCtxMenu(null)
  }

  // Delete / Backspace 删除选中节点（输入框中不触发）
  useEffect(() => {
    const onKey = (e) => {
      if (e.key !== 'Delete' && e.key !== 'Backspace') return
      const tag = (e.target && e.target.tagName || '').toLowerCase()
      if (tag === 'input' || tag === 'textarea' || tag === 'select') return
      if (selectedNodes.size && wf) {
        e.preventDefault()
        deleteSelectedNodes()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedNodes, wf])

  // 右键空白：在点击的世界坐标处新建节点
  const addNodeAt = (type, wx, wy) => {
    if (!wf) return
    setWf((prev) => ({
      ...prev,
      nodes: [...prev.nodes, makeNode(type, Math.max(0, wx - NODE_W / 2), Math.max(0, wy - 42), agents)]
    }))
    setCtxMenu(null)
  }

  // 添加自定义模块节点（带模块定义：名称/图标/代码）
  const addCustomNode = (m, wx, wy) => {
    if (!wf) return
    const node = makeNode('custom', Math.max(0, wx - NODE_W / 2), Math.max(0, wy - 42), agents)
    node.customId = m.id
    node.label = m.name || '自定义模块'
    node.icon = m.icon || '🧩'
    node.code = m.code || ''
    setWf((prev) => ({ ...prev, nodes: [...prev.nodes, node] }))
    setCtxMenu(null)
  }

  const removeNode = (id) => {
    setWf((prev) => ({
      ...prev,
      nodes: prev.nodes.filter((n) => n.id !== id),
      edges: prev.edges.filter((e) => e.from !== id && e.to !== id)
    }))
    setSelectedNodes((prev) => { const n = new Set(prev); n.delete(id); return n })
    setSelectedEdgeId(null)
    setCtxMenu(null)
  }

  const removeEdge = (id) => {
    setWf((prev) => ({ ...prev, edges: prev.edges.filter((e) => e.id !== id) }))
    if (selectedEdgeId === id) setSelectedEdgeId(null)
    setCtxMenu(null)
  }

  // 删除与某节点相连的全部连线
  const removeNodeEdges = (nodeId) => {
    setWf((prev) => ({ ...prev, edges: prev.edges.filter((e) => e.from !== nodeId && e.to !== nodeId) }))
    setSelectedEdgeId(null)
    setCtxMenu(null)
  }

  const clearSelection = () => {
    setSelectedEdgeId(null)
    setCtxMenu(null)
  }

  const onEdgeClick = (e, id) => {
    e.stopPropagation()
    setCtxMenu(null)
    setSelectedEdgeId((cur) => (cur === id ? null : id))
  }

  // 修改连线类型（数据/消息/广播/回调）
  const setEdgeType = (edgeId, type) => {
    setWf((prev) => ({ ...prev, edges: prev.edges.map((ed) => (ed.id === edgeId ? { ...ed, type } : ed)) }))
    setCtxMenu(null)
  }
  // 修改连线分支条件（branch 分流：always / length > N / contains 关键词）
  const setEdgeWhen = (edgeId, when) => {
    setWf((prev) => ({ ...prev, edges: prev.edges.map((ed) => (ed.id === edgeId ? { ...ed, when } : ed)) }))
  }

  // ---- 节点模型配置弹窗（继承上游 / 自定义 baseUrl+apiKey+model）----
  const [modelModal, setModelModal] = useState(null) // { nodeId, draft }
  const openModelConfig = (n) => {
    const m = n.model || {}
    setModelModal({
      nodeId: n.id,
      draft: {
        inherit: m.inherit !== false, // 默认继承上游
        baseUrl: m.baseUrl || '',
        apiKey: m.apiKey || '',
        model: m.model || ''
      }
    })
  }
  const patchModelDraft = (patch) => {
    setModelModal((prev) => prev && { ...prev, draft: { ...prev.draft, ...patch } })
  }
  const saveModelConfig = (n) => {
    const d = modelModal.draft
    const inherit = d.inherit !== false
    // 继承时清空自定义字段；自定义时仅保留非空字段
    const model = inherit
      ? { inherit: true }
      : {
          inherit: false,
          baseUrl: (d.baseUrl || '').trim(),
          apiKey: (d.apiKey || '').trim(),
          model: (d.model || '').trim()
        }
    updateNode(n.id, { model })
    setModelModal(null)
  }

  // ---- 逻辑代码弹窗（图↔代码互转，代码为主、图形回读）----
  const [codeModal, setCodeModal] = useState(null) // { nodeId }
  const [codeText, setCodeText] = useState('')
  const fmtZones = (z) => (Array.isArray(z) ? z.join(', ') : (z || ''))
  const buildNodeCode = (n) => {
    const lines = [
      `# 节点: ${n.label || (NODE_META[n.type] || {}).name}（${n.type}）`,
      '# 代码为主：保存后按 # 开头的元注释回写到节点属性',
      ''
    ]
    if (n.type === 'skill') {
      lines.push(`# prompt: ${n.prompt || ''}`)
      lines.push(`# read-zones: ${fmtZones(n.readZones)}`)
      lines.push(`# write-zones: ${fmtZones(n.writeZones)}`)
    } else if (n.type === 'tool') {
      lines.push(`# tool-mode: ${n.mode || 'mcp'}`)
      if (n.mode === 'inline') lines.push('', n.code || 'def run(input_text):\n    return input_text')
    } else if (n.type === 'custom') {
      lines.push(`# custom-name: ${n.label || ''}`)
      lines.push(`# custom-icon: ${n.icon || '🧩'}`)
      lines.push('', n.code || 'def run(input_text):\n    return input_text')
    } else if (n.type === 'flow') {
      lines.push(`# flow-type: ${n.flowType || 'merge'}`)
      if (n.flowType === 'loop') lines.push(`# max-loops: ${n.maxLoops || 3}`)
    } else if (n.type === 'bus') {
      lines.push(`# read-zones: ${fmtZones(n.readZones)}`)
      lines.push(`# write-zones: ${fmtZones(n.writeZones)}`)
    } else {
      lines.push(`# 该节点类型暂无可回读的属性，可在此写备注`)
    }
    return lines.join('\n')
  }
  const openNodeCode = (n) => {
    setCodeText(buildNodeCode(n))
    setCodeModal({ nodeId: n.id })
  }
  const saveNodeCode = (n) => {
    const lines = String(codeText || '').split('\n')
    const meta = {}
    const body = []
    for (const ln of lines) {
      const m = ln.match(/^#\s*([a-z-]+):\s?(.*)$/)
      if (m) meta[m[1]] = m[2]
      else if (ln.trim()) body.push(ln)
    }
    const patch = {}
    if (n.type === 'skill') {
      if (meta.prompt !== undefined) patch.prompt = meta.prompt
      if (meta['read-zones'] !== undefined) patch.readZones = meta['read-zones']
      if (meta['write-zones'] !== undefined) patch.writeZones = meta['write-zones']
    }
    if (n.type === 'tool') {
      if (meta['tool-mode'] !== undefined) patch.mode = meta['tool-mode']
      const code = body.join('\n')
      if (code && n.mode === 'inline') patch.code = code
    }
    if (n.type === 'custom') {
      if (meta['custom-name'] !== undefined) patch.label = meta['custom-name']
      if (meta['custom-icon'] !== undefined) patch.icon = meta['custom-icon']
      const code = body.join('\n')
      if (code) patch.code = code
    }
    if (n.type === 'flow') {
      if (meta['flow-type'] !== undefined && ['merge', 'branch', 'loop'].includes(meta['flow-type'])) patch.flowType = meta['flow-type']
      if (meta['max-loops'] !== undefined) patch.maxLoops = parseInt(meta['max-loops'], 10) || 3
    }
    if (n.type === 'bus') {
      if (meta['read-zones'] !== undefined) patch.readZones = meta['read-zones']
      if (meta['write-zones'] !== undefined) patch.writeZones = meta['write-zones']
    }
    updateNode(n.id, patch)
    setCodeModal(null)
    onToast('已保存：元注释已回写到节点属性', 'success')
  }

  // 画布右键：按命中对象弹不同菜单（空白=新建节点 / 节点=节点操作 / 连线=连线操作）
  const onCanvasContextMenu = (e) => {
    // 输入控件内不拦截（保留默认粘贴菜单）
    if (e.target.closest('textarea, input, select')) return
    e.preventDefault()
    e.stopPropagation()
    const rect = canvasRef.current.getBoundingClientRect()
    const x = e.clientX - rect.left
    const y = e.clientY - rect.top
    const edgeG = e.target.closest('.wf-edge-g')
    if (edgeG) {
      const id = edgeG.dataset.edgeId
      if (id) {
        setSelectedEdgeId(id)
        setCtxMenu({ type: 'edge', x, y, edgeId: id })
      }
      return
    }
    const nodeEl = e.target.closest('[data-ctx-node]')
    if (nodeEl) {
      setCtxMenu({ type: 'node', x, y, nodeId: nodeEl.dataset.ctxNode })
      return
    }
    const w = screenToWorld(e.clientX, e.clientY)
    setCtxMenu({ type: 'node-create', x, y, wx: w.x, wy: w.y })
  }

  const save = async () => {
    if (!wf) return
    const r = await h.agents.save(wf)
    setWf(r.agent)
    setAgents(r.agents)
    onToast('智能体已保存', 'success')
  }

  // ---- 模板库：一键生成画布 ----
  const [templateModal, setTemplateModal] = useState(false)
  const applyTemplate = (t) => {
    const b = t.build(skills)
    setWf({ id: nid(), name: t.name, width: 1100, height: 460, nodes: b.nodes, edges: b.edges })
    setTemplateModal(false)
    onToast(`已应用模板：${t.name}（记得保存）`, 'success')
  }

  // ---- 自定义模块（自定义节点类型）管理 ----
  const [customNodes, setCustomNodes] = useState([])
  const [customModal, setCustomModal] = useState(false)
  const [customEdit, setCustomEdit] = useState(null) // { id, name, icon, code }
  const saveCustomModule = async () => {
    if (!customEdit || !(customEdit.name || '').trim()) { onToast('请输入模块名称', 'error'); return }
    const item = { ...customEdit, id: customEdit.id || ('cm_' + Math.random().toString(36).slice(2, 8)) }
    try {
      const arr = await h.customNodes.save(item)
      setCustomNodes(arr)
      setCustomEdit(null)
      onToast('自定义模块已保存', 'success')
    } catch (e) {
      onToast(e.message || String(e), 'error')
    }
  }
  const deleteCustomModule = async (id) => {
    try {
      const arr = await h.customNodes.delete(id)
      setCustomNodes(arr)
      if (customEdit && customEdit.id === id) setCustomEdit(null)
    } catch (e) {
      onToast(e.message || String(e), 'error')
    }
  }


  // Ctrl+S 保存当前工作流
  const saveRef = useRef(save)
  saveRef.current = save
  useEffect(() => {
    const onKey = (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault()
        saveRef.current()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const createNew = async () => {
    const w = await h.agents.create()
    setWf(w)
    setMode('canvas')
    setRunStates({})
    setNodeOutputs({})
    setSelectedNodes(new Set())
    setMarquee(null)
    setViewSafe({ x: 0, y: 0, zoom: 1 })
    await refreshList()
  }

  const removeCurrent = async () => {
    if (!wf || !confirm(`删除工作流「${wf.name}」？`)) return
    await h.agents.delete(wf.id)
    setWf(null)
    setMode('list')
    await refreshList()
  }

  const run = async () => {
    if (!wf || running) return
    const inputs = {}
    for (const n of wf.nodes) if (n.type === 'input') inputs[n.id] = n.text || ''
    setRunning(true)
    setRunStates({})
    setNodeOutputs({})
    if (onRunStart) onRunStart() // 立即让侧栏转圈并清空全局运行状态
    try {
      await h.agents.run(wf.id, inputs)
    } catch (e) {
      setRunning(false)
      onToast(e.message, 'error')
    }
  }

  const stop = () => h.agents.stop('*')

  // ---- 小地图 ----
  const mini = useMemo(() => {
    const nodes = wf?.nodes || []
    if (!nodes.length) return null
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
    for (const n of nodes) {
      minX = Math.min(minX, n.x); minY = Math.min(minY, n.y)
      maxX = Math.max(maxX, n.x + (n.w || NODE_W)); maxY = Math.max(maxY, n.y + (n.h || 150))
    }
    const pad = 30
    const w = Math.max(320, maxX - minX + pad * 2)
    const h = Math.max(200, maxY - minY + pad * 2)
    const s = Math.min(MINI_W / w, MINI_H / h)
    const ox = (MINI_W - w * s) / 2
    const oy = (MINI_H - h * s) / 2
    const toMm = (x, y) => ({ x: ox + (x - minX + pad) * s, y: oy + (y - minY + pad) * s })
    const toWorld = (px, py) => ({ x: (px - ox) / s + minX - pad, y: (py - oy) / s + minY - pad })
    // 当前视口（世界坐标）
    const rect = { width: canvasSize.w || 800, height: canvasSize.h || 600 }
    const v = viewRef.current
    const vx = -v.x / v.zoom, vy = -v.y / v.zoom
    const vw = rect.width / v.zoom, vh = rect.height / v.zoom
    const a = toMm(vx, vy)
    const b = toMm(vx + vw, vy + vh)
    return { nodes, toMm, toWorld, s, viewRect: { x: a.x, y: a.y, w: b.x - a.x, h: b.y - a.y }, worldMin: { x: minX - pad, y: minY - pad } }
  }, [wf, view, canvasSize])

  const miniMoveTo = (px, py) => {
    if (!mini) return
    const rect = { width: canvasSize.w || 800, height: canvasSize.h || 600 }
    const wp = mini.toWorld(px, py)
    setViewSafe((cur) => ({ ...cur, x: rect.width / 2 - wp.x * cur.zoom, y: rect.height / 2 - wp.y * cur.zoom }))
  }

  const onMiniDown = (e) => {
    e.stopPropagation()
    e.preventDefault()
    miniMoveTo(e.clientX - e.currentTarget.getBoundingClientRect().left, e.clientY - e.currentTarget.getBoundingClientRect().top)
    const onMove = (ev) => {
      ev.preventDefault()
      const mm = mmRef.current
      if (!mm) return
      const r = mm.getBoundingClientRect()
      miniMoveTo(ev.clientX - r.left, ev.clientY - r.top)
    }
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // ---- 渲染 ----
  const conn = runStates._conn
  const v = view
  const worldSize = useMemo(() => {
    const nodes = wf?.nodes || []
    let mw = canvasCfg.w, mh = canvasCfg.h
    for (const n of nodes) {
      mw = Math.max(mw, n.x + (n.w || NODE_W) + 160)
      mh = Math.max(mh, n.y + (n.h || 180))
    }
    return { w: mw, h: mh }
  }, [wf, canvasCfg])

  // ---- 列表页：卡片 + 分类文件夹 + 文字搜索 + 右键菜单（左键进入画布） ----
  if (mode === 'list') {
    const kw = q.trim().toLowerCase()
    const filtered = agents.filter((a) => !kw ||
      `${a.name || ''} ${a.id || ''} ${a.category || ''}`.toLowerCase().includes(kw))
    const map = new Map()
    for (const a of filtered) {
      const cat = a.category || '未分类'
      if (!map.has(cat)) map.set(cat, [])
      map.get(cat).push(a)
    }
    for (const c of cats.list) if (!map.has(c)) map.set(c, [])
    const groups = [...map.entries()].map(([cat, list]) => ({ cat, list }))

    return (
      <div className="panel">
        <div className="panel-header">
          <div>
            <h2>工作流</h2>
            <p className="panel-sub">
              工作流 = 可视化编排多个技能 / 工具 / 记忆 / 智能体 / 通信总线协作完成复杂任务。
              点卡片进入画布编排
            </p>
          </div>
          <div className="panel-actions">
            <button className="btn" onClick={createNew}>＋ 新建工作流</button>
            <button className="btn" onClick={() => setCatModal(true)} title="创建分类文件夹，把工作流归类">📁 新建分类</button>
            <button className="btn ghost" onClick={refreshList}>↻ 刷新</button>
          </div>
        </div>

        {agents.length > 0 && (
          <div className="bulk-bar">
            <input className="input search-input" placeholder="🔍 搜索工作流（名称 / ID / 分类）…" value={q} onChange={(e) => setQ(e.target.value)} />
            <span className="bulk-count">{agents.length} 个工作流</span>
          </div>
        )}

        {agents.length === 0 && (
          <div className="workspace-empty">
            <div className="empty-icon">🌀</div>
            <p>还没有工作流</p>
            <button className="btn" onClick={createNew}>创建第一个工作流</button>
          </div>
        )}

        {groups.map(({ cat, list }) => (
          <div key={cat} className="agent-group">
            <div className="agent-group-title">
              <span className="agent-group-name">{cat}</span>
              <span className="agent-group-count">{list.length}</span>
              {cat !== '未分类' && (
                <button className="mini-btn danger cat-del" title="删除该分类文件夹（智能体移回未分类）" onClick={() => deleteCategory(cat)}>🗑</button>
              )}
            </div>
            <div className="skill-list">
              {list.map((a) => (
                <div
                  key={a.id}
                  className="skill-card"
                  onClick={() => loadAgent(a.id)}
                  onContextMenu={(e) => { e.preventDefault(); e.stopPropagation(); setCardMenu({ a, x: e.clientX, y: e.clientY }) }}
                  title="点击进入画布（右键管理）"
                >
                  <div className="skill-card-head">
                    <span className="skill-card-title">🌀 {a.name}</span>
                    <div className="session-actions">
                      <select
                        className="skill-cat-select"
                        title="工作流分类文件夹"
                        value={a.category || '未分类'}
                        onChange={(e) => { const v = e.target.value; if (v === '__new__') setCatModal(true); else changeAgentCategory(a, v) }}
                        onClick={(e) => e.stopPropagation()}
                      >
                        {['未分类', ...cats.list.filter((c) => c !== '未分类')].map((c) => <option key={c} value={c}>{c}</option>)}
                        <option value="__new__">＋ 新建分类…</option>
                      </select>
                      <button className="mini-btn danger" title="删除" onClick={(e) => { e.stopPropagation(); doDeleteAgent(a) }}>🗑</button>
                    </div>
                  </div>
                  <div className="skill-card-meta">
                    <code>{a.id}</code> · {a.nodeCount || 0} 个节点 · 更新于 {fmtTime(a.updatedAt)}
                  </div>
                  <div className="skill-card-path" title="点击进入画布编排">🕸 点击卡片进入画布编排 ✎</div>
                </div>
              ))}
            </div>
          </div>
        ))}

        {/* 智能体卡片右键菜单：打开画布 / 删除 */}
        {cardMenu && (
          <div className="mem-ctx-overlay" onClick={() => setCardMenu(null)} onContextMenu={(e) => { e.preventDefault(); setCardMenu(null) }}>
            <div className="mem-ctx" style={{ left: cardMenu.x, top: cardMenu.y }}>
              <div className="mem-ctx-title">🌀 {cardMenu.a.name}</div>
              <button className="mem-ctx-item" onClick={() => { const a = cardMenu.a; setCardMenu(null); loadAgent(a.id) }}>🕸 打开画布</button>
              <button className="mem-ctx-item danger" onClick={() => { const a = cardMenu.a; setCardMenu(null); doDeleteAgent(a) }}>🗑 删除工作流</button>
              <button className="mem-ctx-item" onClick={() => setCardMenu(null)}>取消</button>
            </div>
          </div>
        )}

        <CategoryModal
          open={catModal}
          title="新建分类文件夹"
          placeholder="如：客服 / 数据分析"
          onCreate={async (name) => { await saveNewCategory(name); setCatModal(false) }}
          onClose={() => setCatModal(false)}
        />
      </div>
    )
  }

  return (
    <div className="panel workflow-panel">
      <div className="panel-header">
        <div className="wf-title-row">
          <input
            className="input wf-name-input"
            value={wf?.name || ''}
            onChange={(e) => setWf((prev) => prev && { ...prev, name: e.target.value })}
            placeholder="工作流名称"
          />
          <SearchSelect
            className="wf-switch-select"
            items={agents.map((w) => ({ id: w.id, label: w.name, desc: `${w.nodeCount || 0} 个节点`, icon: '🌀', keywords: `工作流 ${w.id}` }))}
            value={wf?.id || ''}
            onChange={loadAgent}
            placeholder="🔍 搜索工作流…"
            empty="无匹配工作流"
          />
        </div>
        <div className="panel-actions wf-actions">
          <button className="btn ghost" onClick={() => { setWf(null); setMode('list'); refreshList() }} title="返回工作流列表">← 返回</button>
          <button className="btn ghost" onClick={createNew} title="新建工作流">＋ 新建</button>
          <button className="btn ghost" onClick={() => setTemplateModal(true)} title="从模板生成多智能体画布">🧩 模板</button>
          <button className="btn ghost" onClick={save} title="保存">💾 保存</button>
          <button className="btn ghost danger" onClick={removeCurrent} title="删除">🗑</button>
          <button
            className="btn"
            onClick={() => setEx({ name: wf?.name || '', desc: '', target: 'all', busy: false, result: null })}
            title="把此工作流导出为大型 Agent 包（LAG）"
          >📦 导出为 Agent</button>
          <label className="wf-canvas-size" title="画布尺寸（宽 × 高，节点超出会自动扩展）">
            <span>画布</span>
            <input
              type="number" min="400" step="100"
              value={canvasCfg.w}
              onChange={(e) => setCanvasCfg((c) => ({ ...c, w: Math.max(400, Number(e.target.value) || 400) }))}
            />
            <span>×</span>
            <input
              type="number" min="300" step="100"
              value={canvasCfg.h}
              onChange={(e) => setCanvasCfg((c) => ({ ...c, h: Math.max(300, Number(e.target.value) || 300) }))}
            />
          </label>
          {running ? (
            <button className="btn stop" onClick={stop}>⏹ 停止</button>
          ) : (
            <button className="btn primary" onClick={run}>▶ 运行</button>
          )}
        </div>
      </div>

      <div
        className="wf-canvas"
        ref={canvasRef}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onClick={(e) => { if (e.target === canvasRef.current) clearSelection() }}
        onContextMenu={onCanvasContextMenu}
        onMouseLeave={() => { dragRef.current = null; setRunStates((s) => { const { _conn, ...r } = s; return r }) }}
      >
        <div
          className="wf-world"
          style={{
            width: worldSize.w,
            height: worldSize.h,
            transform: `translate(${v.x}px, ${v.y}px) scale(${v.zoom})`
          }}
        >
          <svg className="wf-edges">
            {wf?.edges.map((e) => {
              const from = wf.nodes.find((n) => n.id === e.from)
              const to = wf.nodes.find((n) => n.id === e.to)
              if (!from || !to) return null
              // 挂接连线（edge.pointId）：视觉上数据从总线连接点流向节点输入端（总线圆点 → 节点 in）
              let p1, p2
              if (e.pointId && to.type === 'bus') {
                const bw = to.w || NODE_W
                const pt = (to.points || []).find((p) => p.id === e.pointId)
                p1 = { x: to.x + (pt ? pt.x : 0.5) * bw, y: to.y }
                p2 = portIn(from)
              } else {
                p1 = portOut(from)
                p2 = portIn(to)
              }
              const mx = (p1.x + p2.x) / 2
              const selected = selectedEdgeId === e.id
              const etype = e.pointId ? 'data' : (e.type || 'data')
              const et = EDGE_TYPES[etype] || EDGE_TYPES.data
              return (
                <g
                  key={e.id}
                  data-edge-id={e.id}
                  className={'wf-edge-g' + (selected ? ' selected' : '')}
                  onClick={(ev) => onEdgeClick(ev, e.id)}
                >
                  <path className="wf-edge-hit" d={`M ${p1.x} ${p1.y} C ${mx} ${p1.y}, ${mx} ${p2.y}, ${p2.x} ${p2.y}`} />
                  <path className={'wf-edge' + (etype !== 'data' ? ' wf-edge-t-' + etype : '')} d={`M ${p1.x} ${p1.y} C ${mx} ${p1.y}, ${mx} ${p2.y}, ${p2.x} ${p2.y}`} />
                  <circle className="wf-edge-arrow" cx={p2.x} cy={p2.y} r="3.5" />
                  {!e.pointId && etype !== 'data' && (
                    <g className="wf-edge-badge" transform={`translate(${mx}, ${(p1.y + p2.y) / 2})`}>
                      <rect x="-15" y="-11" width="30" height="22" rx="11" />
                      <text x="0" y="4" text-anchor="middle">{et.icon}</text>
                    </g>
                  )}
                </g>
              )
            })}
            {conn && wf && (() => {
              const d = dragRef.current
              const from = wf.nodes.find((n) => n.id === d?.fromNodeId)
              if (!from) return null
              // 从总线连接点拖起：起点在连接点圆点（上/下缘）
              let p1
              if (d.pointId) {
                const bw = from.w || NODE_W
                const pt = (from.points || []).find((p) => p.id === d.pointId)
                p1 = { x: from.x + (pt ? pt.x : 0.5) * bw, y: d.side === 'bottom' ? from.y + (from.h || 150) : from.y }
              } else {
                p1 = portOut(from)
              }
              const mx = (p1.x + conn.x) / 2
              return <path className="wf-edge temp" d={`M ${p1.x} ${p1.y} C ${mx} ${p1.y}, ${mx} ${conn.y}, ${conn.x} ${conn.y}`} />
            })()}
          </svg>

          {wf?.nodes.map((n) => {
            const meta = NODE_META[n.type]
            const state = runStates[n.id]
            const isSel = selectedNodes.has(n.id)
            return (
              <div
                key={n.id}
                className={'wf-node' + (isSel ? ' selected' : '')}
                data-ctx-node={n.id}
                data-type={n.type}
                onDoubleClick={(e) => { if (n.type === 'tool' && !e.target.closest('textarea, input, select, button, .search-select')) openToolSource(n) }}
                style={{ left: n.x, top: n.y, width: n.w || NODE_W, ...(n.h ? { height: n.h } : {}), background: meta.color, ['--wf-fs']: Math.min(3.2, Math.max(0.85, Math.sqrt(((n.w || NODE_W) / NODE_W) * ((n.h || 150) / 150)))) }}
              >
                <div className="wf-node-head" data-drag-node={n.id}>
                  <span className="wf-node-icon">{n.type === 'custom' ? (n.icon || '🧩') : meta.icon}</span>
                  <span className="wf-node-title">{n.type === 'custom' ? (n.label || '自定义模块') : meta.name}</span>
                  {n.model && n.model.inherit === false && <span className="wf-model-badge" title="自定义模型配置（右键节点 → 模型配置）">⚙模型</span>}
                  {state && state.status === 'running' && <span className="wf-spinner" />}
                  {state && state.status === 'done' && <span className="wf-ok">✓</span>}
                  {state && state.status === 'error' && <span className="wf-err" title={state.error}>✕</span>}
                  <button className="wf-code-btn" title="逻辑代码（图↔代码互转）" onClick={(e) => { e.stopPropagation(); openNodeCode(n) }}>💻</button>
                  <button className="wf-del" onClick={() => removeNode(n.id)}>✕</button>
                </div>
                <div className="wf-node-body">
                  {n.type === 'input' && (
                    <>
                      <textarea
                        className="wf-textarea"
                        placeholder="输入初始内容…可用 [[区域名]]...[[/区域名]] 标记分区；链接工具/技能后，输入内容会由默认智能体加工处理"
                        value={n.text}
                        onChange={(e) => updateNode(n.id, { text: e.target.value })}
                      />
                      {/* 自定义输入：与智能体一样可内嵌工具/技能 */}
                      {renderNodeLinks(n)}
                    </>
                  )}
                  {n.type === 'skill' && (
                    <>
                      <SearchSelect
                        className="wf-agent-select"
                        items={skills.map((a) => ({ id: a.id, label: `${a.avatar} ${a.name}`, desc: a.description || a.id, icon: a.avatar || '🤖', keywords: `技能 ${a.id}` }))}
                        value={n.skillId || ''}
                        onChange={(id) => updateNode(n.id, { skillId: id })}
                        placeholder="🔍 搜索技能…"
                        empty="无匹配技能"
                      />
                      <textarea
                        className="wf-textarea prompt"
                        placeholder="附加指令（可选，会拼在上游输入之前）"
                        value={n.prompt}
                        onChange={(e) => updateNode(n.id, { prompt: e.target.value })}
                      />
                      <div className="wf-zones">
                        <input
                          className="wf-zones-input"
                          placeholder="可读区域（逗号分隔），如: 需求,设计"
                          value={Array.isArray(n.readZones) ? n.readZones.join(', ') : (n.readZones || '')}
                          onChange={(e) => updateNode(n.id, { readZones: e.target.value })}
                          title="通信总线：该技能可以读取的区域（[[区域名]]...[[/区域名]]）"
                        />
                        <input
                          className="wf-zones-input"
                          placeholder="可写区域（逗号分隔），如: 结果"
                          value={Array.isArray(n.writeZones) ? n.writeZones.join(', ') : (n.writeZones || '')}
                          onChange={(e) => updateNode(n.id, { writeZones: e.target.value })}
                          title="通信总线：该技能可以写入的区域（[[区域名]]...[[/区域名]]），留空=不限制"
                        />
                      </div>
                      {/* 内嵌记忆：工具、技能已改用独立节点 */}
                      {renderNodeLinks(n)}
                    </>
                  )}
                  {n.type === 'subagent' && (
                    <>
                      <SearchSelect
                        className="wf-agent-select"
                        items={[
                          ...agents.filter((w) => w.id !== wf.id).map((w) => ({ id: w.id, label: w.name, desc: `工作流 · ${w.nodeCount || 0} 个节点`, icon: '🕸', keywords: `子智能体 工作流 ${w.id}` })),
                          ...defs.map((d) => ({ id: d.id, label: d.name, desc: `智能体 · ${d.skillCount || 0} 个技能${d.model && d.model.inherit === false ? ' · 自定义模型' : ''}`, icon: '🤖', keywords: `智能体 ${d.id}` }))
                        ]}
                        value={n.subagentId || ''}
                        onChange={(id) => updateNode(n.id, { subagentId: id })}
                        placeholder="🔍 选择子智能体 / 智能体…"
                        empty="无匹配智能体"
                      />
                      <div className="wf-subflow-hint">
                        上游内容将作为输入灌入子智能体，子智能体最终输出作为本节点输出（可引用「智能体」栏的单智能体）
                      </div>
                    </>
                  )}
                  {n.type === 'bus' && (
                    <>
                      <div className="wf-subflow-hint wf-bus-hint">
                        数据从左到右：外部节点（技能/记忆）从端口拖线挂到连接点上，按连接点顺序处理
                      </div>
                      <div className="wf-bus-atts">
                        {(n.points || []).map((pt, i) => {
                          const att = attachedNodes(n.id, pt.id)
                          return (
                            <div key={pt.id} className="wf-bus-att">
                              <span className="wf-bus-att-no" title={`连接点 ${i + 1}（执行顺序从左到右）`}>{i + 1}</span>
                              <div className="wf-bus-att-main">
                                <div className={'wf-bus-att-skill-tag' + (att.length ? '' : ' empty')} title="从外部节点输出端口拖线挂到这里">
                                  {att.length
                                    ? att.map((a) => `${NODE_META[a.type]?.icon || ''} ${a.label || a.type}`).join('、')
                                    : '未挂接节点（拖线到本连接点）'}
                                </div>
                                <div className="wf-bus-att-zones">
                                  <input
                                    className="wf-zones-input"
                                    placeholder="📖 可读区域，如: 需求"
                                    value={pt.readZones || ''}
                                    onChange={(e) => patchPoint(n.id, pt.id, { readZones: e.target.value })}
                                    title="该连接点可读区域（[[区域名]]...[[/区域名]]），留空=不限制"
                                  />
                                  <input
                                    className="wf-zones-input"
                                    placeholder="✍️ 可写区域，如: 结果"
                                    value={pt.writeZones || ''}
                                    onChange={(e) => patchPoint(n.id, pt.id, { writeZones: e.target.value })}
                                    title="该连接点可写区域（[[区域名]]...[[/区域名]]），留空=不限制"
                                  />
                                </div>
                              </div>
                              <button className="wf-bus-att-del" title="移除连接点" onClick={() => removePoint(n.id, pt.id)}>✕</button>
                            </div>
                          )
                        })}
                        {(n.points || []).length === 0 && (
                          <div className="wf-mem-if-empty">未添加连接点（总线仅按自身区域权限透传）</div>
                        )}
                        <button className="wf-bus-att-add" title="新增连接点" onClick={() => addPoint(n.id)}>＋ 添加连接点</button>
                      </div>
                    </>
                  )}
                  {n.type === 'flow' && (
                    <>
                      <select
                        className="wf-flow-select"
                        value={n.flowType || 'merge'}
                        onChange={(e) => updateNode(n.id, { flowType: e.target.value })}
                      >
                        <option value="merge">🔀 汇聚 merge（合并上游）</option>
                        <option value="branch">⚖️ 分支 branch（条件分流）</option>
                        <option value="loop">🔁 循环 loop（重复输入）</option>
                      </select>
                      {n.flowType === 'loop' && (
                        <input
                          className="wf-zones-input"
                          type="number" min="1" max="20"
                          placeholder="循环次数"
                          value={n.maxLoops || 3}
                          onChange={(e) => updateNode(n.id, { maxLoops: parseInt(e.target.value, 10) || 1 })}
                        />
                      )}
                      <textarea
                        className="wf-textarea prompt"
                        placeholder={n.flowType === 'branch'
                          ? '分支说明：下游连线可设置条件（右键连线 → 分支条件）。\n语法：always / length > 100 / contains 关键词'
                          : n.flowType === 'loop'
                            ? '循环说明：把上游输入重复 N 次输出，供下游分轮处理'
                            : '汇聚说明：把多条上游合并为一份输出（等全部上游就绪）'}
                        value={n.prompt}
                        onChange={(e) => updateNode(n.id, { prompt: e.target.value })}
                      />
                    </>
                  )}
                  {n.type === 'memory' && (
                    <>
                      <SearchSelect
                        className="wf-agent-select wf-mem-arch"
                        items={[
                          { id: '', label: '（未指定记忆架构）', icon: '🧠' },
                          ...memoryList.map((m) => ({ id: m.name, label: m.title || m.name, desc: m.name, icon: '🧠', keywords: `记忆 ${m.name}` }))
                        ]}
                        value={n.memoryArch || ''}
                        onChange={(id) => updateNode(n.id, { memoryArch: id })}
                        placeholder="🧠 搜索记忆架构…"
                        empty="无匹配记忆架构"
                      />
                      <div className="wf-mem-hint">
                        📖 读取接口：把记忆内容读出作为本节点输出；✍️ 写入接口：把上游内容追加写入记忆
                      </div>
                      <div className="wf-mem-ifs">
                        <div className="wf-mem-if-group">
                          <div className="wf-mem-if-head">
                            <span>📖 读取接口</span>
                            <button className="wf-mem-if-add" onClick={() => openMemIf(n.id, 'read')} title="添加读取接口：运行时可把该记忆文件内容读出">＋ 添加</button>
                          </div>
                          {(n.reads || []).map((r) => (
                            <div key={r.id} className="wf-mem-if">
                              <span className="wf-mem-if-name" title={r.scope}>👁 {r.label}</span>
                              <code className="wf-mem-if-scope">{r.arch || '未指定'} / {r.scope}</code>
                              <button className="wf-mem-if-del" title="移除" onClick={() => removeMemIf(n.id, 'read', r.id)}>✕</button>
                            </div>
                          ))}
                          {(n.reads || []).length === 0 && <div className="wf-mem-if-empty">未配置（输出=空）</div>}
                        </div>
                        <div className="wf-mem-if-group">
                          <div className="wf-mem-if-head">
                            <span>✍️ 写入接口</span>
                            <button className="wf-mem-if-add" onClick={() => openMemIf(n.id, 'write')} title="添加写入接口：运行时把上游内容追加写入该记忆文件">＋ 添加</button>
                          </div>
                          {(n.writes || []).map((w) => (
                            <div key={w.id} className="wf-mem-if">
                              <span className="wf-mem-if-name" title={w.scope}>✎ {w.label}</span>
                              <code className="wf-mem-if-scope">{w.arch || '未指定'} / {w.scope}</code>
                              <button className="wf-mem-if-del" title="移除" onClick={() => removeMemIf(n.id, 'write', w.id)}>✕</button>
                            </div>
                          ))}
                          {(n.writes || []).length === 0 && <div className="wf-mem-if-empty">未配置（不写入）</div>}
                        </div>
                      </div>
                    </>
                  )}
                  {n.type === 'output' && (
                    <>
                      <div className="wf-output-preview">
                        {nodeOutputs[n.id] ? (
                          <pre>{nodeOutputs[n.id].slice(0, 600)}{nodeOutputs[n.id].length > 600 ? '…' : ''}</pre>
                        ) : (
                          <span className="wf-output-empty">上游结果将显示在这里</span>
                        )}
                      </div>
                      {/* 自定义输出：与智能体一样可内嵌工具/技能（加工上游结果） */}
                      {renderNodeLinks(n)}
                    </>
                  )}
                  {n.type === 'custom' && (
                    <>
                      <SearchSelect
                        className="wf-agent-select"
                        items={customNodes.map((m) => ({ id: m.id, label: `${m.icon || '🧩'} ${m.name}`, desc: m.desc || '', icon: m.icon || '🧩', keywords: `自定义 ${m.name}` }))}
                        value={n.customId || ''}
                        onChange={(id) => {
                          const m = customNodes.find((x) => x.id === id)
                          updateNode(n.id, { customId: id, code: m?.code || n.code, label: m?.name || n.label, icon: m?.icon || n.icon })
                        }}
                        placeholder="🔍 选择自定义模块…"
                        empty="暂无模块，请先在「管理自定义模块」创建"
                      />
                      <textarea
                        className="wf-textarea prompt wf-code-ta"
                        placeholder={'自定义代码（可修改，点 💻 可回读）：\ndef run(input_text):\n    return input_text'}
                        value={n.code || ''}
                        onChange={(e) => updateNode(n.id, { code: e.target.value })}
                      />
                    </>
                  )}
                  {n.type === 'tool' && (
                    <>
                      <select
                        className="wf-flow-select"
                        value={n.mode || 'mcp'}
                        onChange={(e) => updateNode(n.id, { mode: e.target.value })}
                      >
                        <option value="mcp">🔧 工具包 / 内置工具（供下游智能体调用）</option>
                        <option value="inline">🐍 内联 Python（直接处理输入）</option>
                      </select>
                      {n.mode === 'inline' ? (
                        <textarea
                          className="wf-textarea prompt wf-code-ta"
                          placeholder={'定义函数，接收上游输入、返回处理结果：\ndef run(input_text):\n    return input_text.upper()'}
                          value={n.code || ''}
                          onChange={(e) => updateNode(n.id, { code: e.target.value })}
                        />
                      ) : (
                        <>
                          <SearchSelect
                            className="wf-agent-select"
                            items={toolOptions.map((t) => ({ id: t.id, label: t.label, desc: t.desc || '', icon: '🔧', keywords: `工具 ${t.id}` }))}
                            value={n.toolId || ''}
                            onChange={(id) => updateNode(n.id, { toolId: id, manual: '' })}
                            placeholder="🔍 搜索工具（内置 + 工具包）…"
                            empty="无匹配工具"
                          />
                          <textarea
                            className="wf-textarea prompt"
                            placeholder="建议操作手册：告诉上游智能体这个工具节点有哪些工具、如何调用（可选）"
                            value={n.prompt || ''}
                            onChange={(e) => updateNode(n.id, { prompt: e.target.value })}
                          />
                          <div className="wf-tool-manual-row">
                            <button className="wf-manual-btn" title="拉取当前工具的操作手册（名称 / 用途 / 参数）" onClick={() => pullManual(n)}>📖 拉取操作手册</button>
                            {n.manual && <button className="wf-manual-btn danger" title="清空已拉取的操作手册" onClick={() => updateNode(n.id, { manual: '' })}>✕ 清空</button>}
                          </div>
                          {n.manual ? (
                            <textarea
                              className="wf-textarea manual"
                              placeholder="工具操作手册（可编辑，将注入上游智能体）"
                              value={n.manual}
                              onChange={(e) => updateNode(n.id, { manual: e.target.value })}
                            />
                          ) : null}
                        </>
                      )}
                    </>
                  )}
                </div>
                <span className="wf-port in" title="输入端口：从上游接入" />
                <span className="wf-port out" title="输出端口：拖到下一节点输入" onMouseDown={(e) => onConnectStart(e, n.id)} />
                {/* 通信总线连接点：上下边缘圆点，位置 = 连接点 x（从左到右执行顺序）；拖线到圆点=挂接节点，也可从圆点拖出 */}
                {(n.type === 'bus' && (n.points || []).length > 0) && (n.points || []).map((pt, i) => (
                  <React.Fragment key={pt.id}>
                    <span className="wf-bus-port top" style={{ left: `${Math.max(4, Math.min(96, (pt.x || 0) * 100))}%` }} title={`连接点 ${i + 1} · 读入口（拖线挂接/拖出连接节点）`} onMouseDown={(e) => onConnectStart(e, n.id, pt.id, 'top')} />
                    <span className="wf-bus-port bottom" style={{ left: `${Math.max(4, Math.min(96, (pt.x || 0) * 100))}%` }} title={`连接点 ${i + 1} · 写出口（拖线挂接/拖出连接节点）`} onMouseDown={(e) => onConnectStart(e, n.id, pt.id, 'bottom')} />
                  </React.Fragment>
                ))}
                {/* 所有节点均可拖拽缩放（总线保长条、记忆保大正方形，见 MIN_SIZE 下限） */}
                <span className="wf-resize" title="拖动缩放节点" onMouseDown={(e) => onResizeStart(e, n.id)} />
              </div>
            )
          })}

          {/* 左键框选矩形 */}
          {marquee && (
            <div
              className="wf-marquee"
              style={{
                left: Math.min(marquee.x1, marquee.x2),
                top: Math.min(marquee.y1, marquee.y2),
                width: Math.abs(marquee.x2 - marquee.x1),
                height: Math.abs(marquee.y2 - marquee.y1)
              }}
            />
          )}
        </div>

        {ctxMenu && wf && (() => {
          if (ctxMenu.type === 'node-create') {
            return (
              <div
                className="wf-ctxmenu"
                style={{ left: ctxMenu.x, top: ctxMenu.y }}
                onMouseDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.preventDefault()}
              >
                <div className="wf-ctxmenu-title">新建节点</div>
                <button className="wf-ctxmenu-item" onClick={() => addNodeAt('input', ctxMenu.wx, ctxMenu.wy)}>⌨️ 输入</button>
                <button className="wf-ctxmenu-item" onClick={() => addNodeAt('skill', ctxMenu.wx, ctxMenu.wy)}>🤖 技能</button>
                <button className="wf-ctxmenu-item" onClick={() => addNodeAt('tool', ctxMenu.wx, ctxMenu.wy)}>🔧 工具节点</button>
                <button className="wf-ctxmenu-item" onClick={() => addNodeAt('subagent', ctxMenu.wx, ctxMenu.wy)}>🔄 子智能体</button>
                <button className="wf-ctxmenu-item" onClick={() => addNodeAt('bus', ctxMenu.wx, ctxMenu.wy)}>🚌 通信总线</button>
                 <button className="wf-ctxmenu-item" onClick={() => addNodeAt('flow', ctxMenu.wx, ctxMenu.wy)}>🔀 控制流</button>
                <button className="wf-ctxmenu-item" onClick={() => addNodeAt('memory', ctxMenu.wx, ctxMenu.wy)}>🧠 记忆</button>
                <button className="wf-ctxmenu-item" onClick={() => addNodeAt('output', ctxMenu.wx, ctxMenu.wy)}>📤 输出</button>
                 {customNodes.length > 0 && (
                   <>
                     <div className="wf-ctxmenu-title">🧩 自定义模块</div>
                     {customNodes.map((m) => (
                       <button key={m.id} className="wf-ctxmenu-item" onClick={() => addCustomNode(m, ctxMenu.wx, ctxMenu.wy)}>{m.icon || '🧩'} {m.name}</button>
                     ))}
                   </>
                 )}
                 <button className="wf-ctxmenu-item" onClick={() => { setCtxMenu(null); setCustomEdit(null); setCustomModal(true) }}>🧩 管理自定义模块…</button>
              </div>
            )
          }
          if (ctxMenu.type === 'node') {
            const node = wf.nodes.find((n) => n.id === ctxMenu.nodeId)
            if (!node) return null
            const multi = selectedNodes.size > 1 && selectedNodes.has(node.id)
            return (
              <div
                className="wf-ctxmenu"
                style={{ left: ctxMenu.x, top: ctxMenu.y }}
                onMouseDown={(e) => e.stopPropagation()}
                onContextMenu={(e) => e.preventDefault()}
              >
                <div className="wf-ctxmenu-title">{NODE_META[node.type]?.icon} {node.label || node.type}</div>
                {node.type === 'skill' && node.skillId && (
                  <button className="wf-ctxmenu-item" onClick={() => { setCtxMenu(null); onEditSkill && onEditSkill(node.skillId) }}>
                    ✏ 编辑技能代码
                  </button>
                )}
                {node.type === 'tool' && (
                  <button className="wf-ctxmenu-item" onClick={() => { setCtxMenu(null); openToolSource(node) }}>
                    ✏ 编辑工具源码 / 手册
                  </button>
                )}
                {multi && (
                  <button className="wf-ctxmenu-item danger" onClick={deleteSelectedNodes}>🗑 删除选中 {selectedNodes.size} 个节点</button>
                )}
                <button className="wf-ctxmenu-item" onClick={() => { setCtxMenu(null); openModelConfig(node) }}>
                  🤖 模型配置{node.model && node.model.inherit === false ? '（自定义）' : '（继承上游）'}
                </button>
                <button className="wf-ctxmenu-item danger" onClick={() => removeNode(node.id)}>🗑 删除节点</button>
                <button className="wf-ctxmenu-item" onClick={() => removeNodeEdges(node.id)}>🔌 断开全部连线</button>
                <button className="wf-ctxmenu-item" onClick={() => setCtxMenu(null)}>取消</button>
              </div>
            )
          }
          const edge = wf.edges.find((x) => x.id === ctxMenu.edgeId)
          if (!edge) return null
          const from = wf.nodes.find((n) => n.id === edge.from)
          const to = wf.nodes.find((n) => n.id === edge.to)
          return (
            <div
              className="wf-ctxmenu"
              style={{ left: ctxMenu.x, top: ctxMenu.y }}
              onMouseDown={(e) => e.stopPropagation()}
              onContextMenu={(e) => e.preventDefault()}
            >
              <div className="wf-ctxmenu-title">
                {from?.label || '?'} → {to?.label || '?'}
              </div>
              <div className="wf-edge-type-title">连线类型（决定如何协作）</div>
              <div className="wf-edge-type-row">
                {Object.entries(EDGE_TYPES).map(([k, v]) => (
                  <button
                    key={k}
                    className={'wf-edge-type-btn' + ((edge.type || 'data') === k ? ' active' : '')}
                    title={v.hint}
                    onClick={() => setEdgeType(edge.id, k)}
                  >
                    {v.icon} {v.label}
                  </button>
                ))}
              </div>
              <div className="wf-ctxmenu-item hint">{(EDGE_TYPES[edge.type || 'data'] || EDGE_TYPES.data).hint}</div>
              {edge.type !== 'data' && (
                <>
                  <div className="wf-edge-type-title">分支条件（branch 分流用）</div>
                  <input
                    className="wf-edge-when"
                    placeholder="always / length > 100 / contains 关键词"
                    value={edge.when || ''}
                    onChange={(e) => setEdgeWhen(edge.id, e.target.value)}
                    onMouseDown={(e) => e.stopPropagation()}
                  />
                </>
              )}
              <button className="wf-ctxmenu-item danger" onClick={() => removeEdge(edge.id)}>🗑 删除连线</button>
              <button className="wf-ctxmenu-item" onClick={() => removeNodeEdges(from.id)}>🔌 断开「{from.label}」全部连线</button>
              <button className="wf-ctxmenu-item" onClick={() => removeNodeEdges(to.id)}>🔌 断开「{to.label}」全部连线</button>
              <button
                className="wf-ctxmenu-item"
                onClick={() => { setCtxMenu(null); onToast('属性面板待开发（将在通信总线版本中提供）', 'info') }}
              >
                ⚙ 属性（待开发）
              </button>
            </div>
          )
        })()}

        {/* 逻辑代码弹窗：图↔代码互转（代码为主、元注释回读） */}
        {codeModal && (() => {
          const cn = wf?.nodes.find((x) => x.id === codeModal.nodeId)
          if (!cn) return null
          return (
            <div className="modal-overlay" onClick={() => setCodeModal(null)}>
              <div className="modal code-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <h2>💻 逻辑代码 · {cn.label || '节点'}</h2>
                  <button className="icon-btn" onClick={() => setCodeModal(null)}>✕</button>
                </div>
                <div className="modal-body">
                  <div className="code-modal-hint">图形 = 代码的视图：保存后 `# 字段:` 元注释会回写到节点属性（代码为主，双向回读）</div>
                  <div className="code-editor native code-modal-editor">
                    <pre
                      className="code-highlight"
                      aria-hidden="true"
                      dangerouslySetInnerHTML={{
                        __html: hljs.highlight(codeText || '', { language: 'python' }).value + '\n'
                      }}
                    />
                    <textarea
                      className="code-input"
                      value={codeText}
                      onChange={(e) => setCodeText(e.target.value)}
                      spellCheck={false}
                      autoCapitalize="off"
                      autoComplete="off"
                      autoCorrect="off"
                      data-gramm={false}
                    />
                  </div>
                </div>
                <div className="modal-footer">
                  <button className="btn" onClick={() => setCodeModal(null)}>取消</button>
                  <button className="btn primary" onClick={() => saveNodeCode(cn)}>保存并回写</button>
                </div>
              </div>
            </div>
          )
        })()}

        {/* 节点模型配置弹窗：继承上游或自定义 baseUrl/apiKey/model */}
        {modelModal && wf && (() => {
          const mn = wf.nodes.find((x) => x.id === modelModal.nodeId)
          if (!mn) return null
          const d = modelModal.draft
          return (
            <div className="modal-overlay" onClick={() => setModelModal(null)}>
              <div className="modal model-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <h2>🤖 模型配置 · {mn.label || mn.type}</h2>
                  <button className="icon-btn" onClick={() => setModelModal(null)}>✕</button>
                </div>
                <div className="modal-body">
                  <div className="code-modal-hint">继承 = 跟随上游/全局模型的 URL 与 API Key；自定义 = 本节点用自己的模型配置（导出后不含密钥，运行前通过配置接口注入）</div>
                  <label className="model-inherit-row">
                    <input
                      type="checkbox"
                      checked={d.inherit}
                      onChange={(e) => patchModelDraft({ inherit: e.target.checked })}
                    />
                    继承上游智能体的模型（URL + API）
                  </label>
                  {!d.inherit && (
                    <div className="model-fields">
                      <div className="model-field">
                        <span className="model-field-label">Base URL</span>
                        <input
                          className="wf-edge-when"
                          style={{ margin: 0 }}
                          placeholder="https://api.deepseek.com/v1"
                          value={d.baseUrl}
                          onChange={(e) => patchModelDraft({ baseUrl: e.target.value })}
                        />
                      </div>
                      <div className="model-field">
                        <span className="model-field-label">API Key</span>
                        <input
                          className="wf-edge-when"
                          style={{ margin: 0 }}
                          type="password"
                          placeholder="sk-..."
                          value={d.apiKey}
                          onChange={(e) => patchModelDraft({ apiKey: e.target.value })}
                        />
                      </div>
                      <div className="model-field">
                        <span className="model-field-label">模型名</span>
                        <input
                          className="wf-edge-when"
                          style={{ margin: 0 }}
                          placeholder="deepseek-chat"
                          value={d.model}
                          onChange={(e) => patchModelDraft({ model: e.target.value })}
                        />
                      </div>
                      <div className="code-modal-hint">字段留空时回落上游对应的值（只覆盖填了的部分）</div>
                    </div>
                  )}
                </div>
                <div className="modal-footer">
                  <button className="btn" onClick={() => setModelModal(null)}>取消</button>
                  <button className="btn primary" onClick={() => saveModelConfig(mn)}>保存</button>
                </div>
              </div>
            </div>
          )
        })()}

        {/* 自定义模块管理弹窗 */}
        {customModal && (
          <div className="modal-overlay" onClick={() => setCustomModal(false)}>
            <div className="modal custom-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>🧩 自定义模块（自定义节点类型）</h2>
                <button className="icon-btn" onClick={() => setCustomModal(false)}>✕</button>
              </div>
              <div className="modal-body">
                <div className="custom-list">
                  {customNodes.map((m) => (
                    <div key={m.id} className="custom-item">
                      <span className="custom-item-name" onClick={() => setCustomEdit({ ...m })}>{m.icon || '🧩'} {m.name}</span>
                      <button className="custom-item-del" title="删除" onClick={() => deleteCustomModule(m.id)}>🗑</button>
                    </div>
                  ))}
                  {customNodes.length === 0 && <div className="mem-wb-empty">还没有自定义模块：点「＋ 新建模块」创建（Python 函数 def run(input_text)，接收上游输入返回处理结果）</div>}
                </div>
                {customEdit ? (
                  <div className="custom-edit">
                    <div className="custom-edit-row">
                      <input className="wf-edge-when" style={{ margin: 0, flex: 1 }} placeholder="模块名称（如：文本摘要）" value={customEdit.name || ''} onChange={(e) => setCustomEdit({ ...customEdit, name: e.target.value })} />
                      <input className="wf-edge-when" style={{ margin: 0, width: 64 }} placeholder="图标" value={customEdit.icon || ''} onChange={(e) => setCustomEdit({ ...customEdit, icon: e.target.value })} />
                    </div>
                    <textarea className="custom-editor" value={customEdit.code || ''} onChange={(e) => setCustomEdit({ ...customEdit, code: e.target.value })} spellCheck={false} />
                    <div className="custom-edit-row" style={{ marginTop: 8 }}>
                      <button className="btn" onClick={() => setCustomEdit(null)}>取消</button>
                      <button className="btn primary" onClick={saveCustomModule}>保存模块</button>
                    </div>
                  </div>
                ) : (
                  <button className="btn primary" onClick={() => setCustomEdit({ id: '', name: '', icon: '🧩', code: 'def run(input_text):\n    return input_text' })}>＋ 新建模块</button>
                )}
              </div>
              <div className="modal-footer">
                <button className="btn" onClick={() => setCustomModal(false)}>关闭</button>
              </div>
            </div>
          </div>
        )}

        {/* 模板库弹窗：一键生成多智能体画布 */}
        {templateModal && (
          <div className="modal-overlay" onClick={() => setTemplateModal(false)}>
            <div className="modal template-modal" onClick={(e) => e.stopPropagation()}>
              <div className="modal-header">
                <h2>🧩 模板库</h2>
                <button className="icon-btn" onClick={() => setTemplateModal(false)}>✕</button>
              </div>
              <div className="modal-body">
                <div className="template-grid">
                  {WF_TEMPLATES.map((t) => (
                    <div key={t.id} className="template-card" onClick={() => applyTemplate(t)}>
                      <div className="template-card-icon">{t.icon}</div>
                      <div className="template-card-name">{t.name}</div>
                      <div className="template-card-desc">{t.desc}</div>
                    </div>
                  ))}
                </div>
              </div>
              <div className="modal-footer">
                <button className="btn" onClick={() => setTemplateModal(false)}>取消</button>
              </div>
            </div>
          </div>
        )}

        {/* 缩放控件 */}
        <div className="wf-zoom-controls" onMouseDown={(e) => e.stopPropagation()} onContextMenu={(e) => e.preventDefault()}>
          <button className="wf-zoom-btn" onClick={() => zoomBy(1 / 1.2)} title="缩小">−</button>
          <span className="wf-zoom-value">{Math.round(v.zoom * 100)}%</span>
          <button className="wf-zoom-btn" onClick={() => zoomBy(1.2)} title="放大">＋</button>
          <button className="wf-zoom-btn" onClick={resetView} title="重置为 100%">⤾</button>
        </div>

        {/* 小地图 */}
        {mini && (
          <div
            className="wf-minimap"
            ref={mmRef}
            onMouseDown={onMiniDown}
            onContextMenu={(e) => e.preventDefault()}
          >
            <svg width={MINI_W} height={MINI_H}>
              {mini.nodes.map((n) => {
                const p = mini.toMm(n.x, n.y)
                const meta = NODE_META[n.type]
                return (
                  <rect
                    key={n.id}
                    x={p.x}
                    y={p.y}
                    width={Math.max(4, (n.w || NODE_W) * mini.s)}
                    height={Math.max(3, (n.h || 60) * mini.s)}
                    rx="2"
                    fill={meta.icon === '🤖' ? 'rgba(139,124,246,0.85)' : meta.icon === '⌨️' ? 'rgba(110,168,255,0.85)' : meta.icon === '🔄' ? 'rgba(250,170,60,0.9)' : 'rgba(56,214,196,0.85)'}
                  />
                )
              })}
              <rect
                className="wf-minimap-viewport"
                x={mini.viewRect.x}
                y={mini.viewRect.y}
                width={Math.max(6, mini.viewRect.w)}
                height={Math.max(4, mini.viewRect.h)}
              />
            </svg>
          </div>
        )}

        <div className="wf-hint">
          从节点右侧 <b>● 输出端口</b> 拖到下一节点左侧 <b>● 输入端口</b> 连线 · <b>左键拖拽空白</b>框选多个节点（可整体拖动，Shift 追加，Delete 删除选中） · <b>右键空白</b>新建节点（输入/技能/工具/子智能体/记忆/通信总线/输出） · <b>右键节点/连线</b>操作菜单 · <b>中键拖拽</b>平移 · <b>滚轮</b>缩放 · 右上<b>画布</b>可设尺寸 · 右下角<b>小地图</b>快速定位 · <b>Ctrl+S</b> 保存
        </div>
      </div>

      {/* 工具/技能链接弹窗 */}
      {linkModal && (() => {
        const linkNode = (wf?.nodes || []).find((n) => n.id === linkModal.nodeId)
        const linked = (arr) => (Array.isArray(arr) ? arr : [])
        if (linkModal.type === 'tools') {
          return (
            <div className="modal-overlay" onClick={() => setLinkModal(null)}>
              <div className="modal wf-link-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <div className="editor-title"><span>🔧 链接工具（本节点）</span></div>
                  <button className="icon-btn" onClick={() => setLinkModal(null)}>✕</button>
                </div>
                <div className="wf-link-body">
                  <input
                    className="input wf-link-search"
                    placeholder="🔍 搜索工具（名称 / 描述）…"
                    value={linkQ}
                    onChange={(e) => setLinkQ(e.target.value)}
                  />
                  {!toolCatalog ? <div className="export-status">加载工具列表…</div> : (
                    <>
                      <div className="wf-link-group-title">内置工具（工作区）</div>
                      <div className="wf-link-list">
                        {toolCatalog.builtin
                          .filter((t) => !linkQ.trim() || `${t.name} ${t.description}`.toLowerCase().includes(linkQ.trim().toLowerCase()))
                          .map((t) => (
                          <label key={t.name} className="wf-link-item">
                            <input
                              type="checkbox"
                              checked={linked(linkNode?.tools).includes(t.name)}
                              onChange={() => toggleNodeTool(linkNode.id, t.name)}
                            />
                            <span className="wf-link-name">{t.name}</span>
                            <span className="wf-link-desc">{t.description}</span>
                          </label>
                        ))}
                      </div>
                      <div className="wf-link-group-title">工具包工具</div>
                      {!toolCatalog.toolPacks || toolCatalog.toolPacks.length === 0 ? <div className="wf-link-empty">暂无工具包工具（可在「工具包」页创建）</div> : (
                      <div className="wf-link-list">
                        {toolCatalog.toolPacks
                          .filter((t) => !linkQ.trim() || `${t.name} ${t.description || ''}`.toLowerCase().includes(linkQ.trim().toLowerCase()))
                          .map((t) => (
                          <label key={t.name} className="wf-link-item">
                            <input
                              type="checkbox"
                              checked={linked(linkNode?.tools).includes('tool:' + t.name) || linked(linkNode?.tools).includes('mcp:' + t.name)}
                              onChange={() => toggleNodeTool(linkNode.id, 'tool:' + t.name)}
                            />
                            <span className="wf-link-name">tool:{t.name}</span>
                            <span className="wf-link-desc">{t.description || t.packId}</span>
                          </label>
                        ))}
                      </div>
                      )}
                    </>
                  )}
                </div>
                <div className="modal-footer">
                  <button className="btn primary" onClick={() => setLinkModal(null)}>完成</button>
                </div>
              </div>
            </div>
          )
        }
        if (linkModal.type === 'memories') {
          return (
            <div className="modal-overlay" onClick={() => setLinkModal(null)}>
              <div className="modal wf-link-modal" onClick={(e) => e.stopPropagation()}>
                <div className="modal-header">
                  <div className="editor-title"><span>🧠 链接记忆（本节点）</span></div>
                  <button className="icon-btn" onClick={() => setLinkModal(null)}>✕</button>
                </div>
                <div className="wf-link-body">
                  <input
                    className="input wf-link-search"
                    placeholder="🔍 搜索记忆架构…"
                    value={linkQ}
                    onChange={(e) => setLinkQ(e.target.value)}
                  />
                  <div className="wf-link-group-title">记忆架构（运行时获得 memory_* 工具 + 策略注入）</div>
                  {memoryList.length === 0 && <div className="wf-link-empty">还没有记忆架构，可在「记忆」页创建</div>}
                  <div className="wf-link-list">
                    {memoryList
                      .filter((m) => !linkQ.trim() || `${m.title || ''} ${m.name} ${m.desc || ''}`.toLowerCase().includes(linkQ.trim().toLowerCase()))
                      .map((m) => (
                        <label key={m.name} className="wf-link-item">
                          <input
                            type="checkbox"
                            checked={linked(linkNode?.memories).includes(m.name)}
                            onChange={() => toggleNodeMemory(linkNode.id, m.name)}
                          />
                          <span className="wf-link-name">🧠 {m.title || m.name}</span>
                          <span className="wf-link-desc">{m.desc || m.name}</span>
                        </label>
                      ))}
                  </div>
                  <div className="skill-card-desc">链接后该节点运行时获得该记忆架构的 memory_read / memory_write / memory_append / memory_search / memory_forget 工具，并注入其策略。</div>
                </div>
                <div className="modal-footer">
                  <button className="btn primary" onClick={() => setLinkModal(null)}>完成</button>
                </div>
              </div>
            </div>
          )
        }
      })()}

      {/* 记忆节点接口弹窗：添加 读取/写入 接口 */}
      {memIfModal && (
        <div className="modal-overlay" onClick={() => setMemIfModal(null)}>
          <div className="modal small" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <h2>{memIfModal.kind === 'read' ? '📖 添加读取接口' : '✍️ 添加写入接口'}</h2>
              <button className="icon-btn" onClick={() => setMemIfModal(null)}>✕</button>
            </div>
            <div className="modal-body">
              <label className="field">
                <span className="field-label">接口名称</span>
                <input
                  className="input"
                  value={memIfDraft.label}
                  onChange={(e) => setMemIfDraft((d) => ({ ...d, label: e.target.value }))}
                />
              </label>
              <label className="field">
                <span className="field-label">记忆架构（为空=使用节点顶部选择的记忆架构）</span>
                <SearchSelect
                  items={[
                    { id: '', label: '（使用节点记忆架构）', icon: '🧠' },
                    ...memoryList.map((m) => ({ id: m.name, label: m.title || m.name, desc: m.name, icon: '🧠', keywords: `记忆 ${m.name}` }))
                  ]}
                  value={memIfDraft.arch || ''}
                  onChange={(id) => setMemIfDraft((d) => ({ ...d, arch: id }))}
                  placeholder="🧠 搜索记忆架构…"
                  empty="无匹配记忆架构"
                />
              </label>
              <label className="field">
                <span className="field-label">目标文件 scope（facts / episodes / skills / bus.md / 任意路径）</span>
                <input
                  className="input"
                  list="wf-mem-scopes"
                  value={memIfDraft.scope}
                  onChange={(e) => setMemIfDraft((d) => ({ ...d, scope: e.target.value }))}
                  placeholder="facts"
                />
                <datalist id="wf-mem-scopes">
                  {['policy', 'facts', 'episodes', 'skills', 'ledger', 'bus.md', 'notes/待办.md'].map((s) => (
                    <option key={s} value={s} />
                  ))}
                </datalist>
              </label>
              <div className="wf-mem-if-tip">
                {memIfModal.kind === 'read'
                  ? '运行时把该记忆文件的内容读出，拼成本节点输出（供下游节点使用）。'
                  : '运行时把上游节点传入的内容追加写入该记忆文件（写操作会记入账本 ledger）。'}
              </div>
            </div>
            <div className="modal-footer">
              <button className="btn ghost" onClick={() => setMemIfModal(null)}>取消</button>
              <button className="btn primary" onClick={addMemIf}>添加</button>
            </div>
          </div>
        </div>
      )}

      {/* 导出为大型 Agent */}
      {ex && (
        <div className="modal-overlay" onClick={() => setEx(null)}>
          <div className="modal export-modal" onClick={(e) => e.stopPropagation()}>
            <div className="modal-header">
              <div className="editor-title"><span>📦 导出为大型 Agent</span></div>
              <button className="icon-btn" onClick={() => setEx(null)}>✕</button>
            </div>
            <div className="export-body">
              <label className="export-field">
                <span>Agent 名称</span>
                <input
                  className="input"
                  value={ex.name}
                  onChange={(e) => setEx((s) => ({ ...s, name: e.target.value }))}
                  placeholder="大型 Agent 名称"
                />
              </label>
              <label className="export-field">
                <span>简介（可选）</span>
                <input
                  className="input"
                  value={ex.desc}
                  onChange={(e) => setEx((s) => ({ ...s, desc: e.target.value }))}
                  placeholder="一句话描述这个 Agent 的用途"
                />
              </label>
              <label className="export-field">
                <span>导出形式（均自包含、脱离本软件独立运行）</span>
                <select
                  className="input"
                  value={ex.target}
                  onChange={(e) => setEx((s) => ({ ...s, target: e.target.value }))}
                >
                  <option value="all">全部（Python 库 import + API 服务 HTTP）</option>
                  <option value="py">仅 Python 库（外部软件 import 直接调用）</option>
                  <option value="api">仅 API 服务（启动 HTTP 服务调用）</option>
                </select>
              </label>
              {ex.busy && (
                <div className="export-status">正在生成大型 Agent 包…（复制内嵌 Python 运行时可能需要一点时间）</div>
              )}
              {ex.result && (
                <div className="export-result">
                  {ex.result.ok ? (
                    <div className="export-ok">✅ 导出成功，已生成到：<code>{ex.result.dir}</code></div>
                  ) : ex.result.canceled ? (
                    <div className="export-cancel">已取消选择目录</div>
                  ) : (
                    <div className="export-err">❌ 无法导出：{ex.result.errors?.join('；') || '未知错误'}</div>
                  )}
                  {ex.result.warnings && ex.result.warnings.length > 0 && (
                    <ul className="export-warnings">
                      {ex.result.warnings.map((w, i) => <li key={i}>⚠️ {w}</li>)}
                    </ul>
                  )}
                  {ex.result.ok && ex.result.token && (
                    <div className="export-ok">访问令牌：<code>{ex.result.token}</code>（在导出目录的「接入说明.md」中也有）</div>
                  )}
                  {ex.result.ok && !ex.exeBusy && !ex.exeResult && (
                    <div className="export-exe">
                      <button
                        className="btn ghost exe-btn"
                        onClick={async () => {
                          setEx((s) => ({ ...s, exeBusy: true, exeResult: null }))
                          try {
                            const r = await h.exporter.buildExe({ outDir: ex.result.dir, name: ex.name })
                            setEx((s) => ({ ...s, exeBusy: false, exeResult: r }))
                          } catch (e) {
                            setEx((s) => ({ ...s, exeBusy: false, exeResult: { ok: false, error: e.message || String(e) } }))
                          }
                        }}
                      >📦 打包为单文件 exe（免装 Python，双击即用）</button>
                    </div>
                  )}
                  {ex.exeBusy && (
                    <div className="export-status">正在打包单文件 exe…（PyInstaller，通常 1-3 分钟，请勿关闭窗口）</div>
                  )}
                  {ex.exeResult && (ex.exeResult.ok ? (
                    <div className="export-ok">✅ exe 已生成：<code>{ex.exeResult.exePath}</code>（{(ex.exeResult.size / 1024 / 1024).toFixed(1)} MB），双击即可运行</div>
                  ) : (
                    <div className="export-err">❌ exe 打包失败：{ex.exeResult.error}</div>
                  ))}
                </div>
              )}
            </div>
            <div className="modal-footer">
              <button className="btn ghost" onClick={() => setEx(null)}>关闭</button>
              <button
                className="btn primary"
                disabled={ex.busy}
                onClick={async () => {
                  setEx((s) => ({ ...s, busy: true }))
                  try {
                    const r = await h.exporter.run({ agentId: wf.id, name: ex.name, description: ex.desc, target: ex.target })
                    setEx((s) => ({ ...s, busy: false, result: r }))
                  } catch (e) {
                    setEx((s) => ({ ...s, busy: false, result: { ok: false, errors: [e.message || String(e)] } }))
                  }
                }}
              >开始导出</button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
