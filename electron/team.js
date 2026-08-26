// 团队协作仓库（WiFi 团队开发）：成员 / 在线心跳 / 频道消息 / 局域网 IP / AI 托管
// 存储：<userData>/team.json（人可读，最近 200 条频道消息）
// 在线判定：lastSeen 心跳，前端用 now - lastSeen > 8s 显示离线（MVP 轮询，无 SSE）
// AI 托管：频道消息以 "@ai " 开头 → 主机 assistant 生成回复写回频道（type:'ai'）
const fs = require('fs')
const path = require('path')
const os = require('os')
const crypto = require('crypto')

let file = null
let team = { enabled: false, name: '我的团队', members: {}, channel: [], assets: [] }
const MAX_CHANNEL = 200
// 消息 ts 必须严格递增（同一毫秒多条消息时手动 +1），否则增量拉取 ts > since 会丢消息
let lastTs = 0

function init(userDataDir) {
  file = path.join(userDataDir, 'team.json')
  if (fs.existsSync(file)) {
    try {
      const d = JSON.parse(fs.readFileSync(file, 'utf8'))
      team = {
        enabled: !!d.enabled,
        name: d.name || '我的团队',
        members: d.members || {},
        channel: Array.isArray(d.channel) ? d.channel.slice(-MAX_CHANNEL) : [],
        assets: Array.isArray(d.assets) ? d.assets.slice(-200) : []
      }
    } catch {
      team = { enabled: false, name: '我的团队', members: {}, channel: [], assets: [] }
    }
  }
}

function save() {
  if (!file) return
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = file + '.tmp'
  const data = JSON.stringify(team, null, 2)
  // Windows 上防杀软/沙箱瞬时占用导致 rename EPERM：写盘+改名各重试几次
  for (let i = 0; i < 4; i++) {
    try {
      fs.writeFileSync(tmp, data, 'utf8')
      fs.renameSync(tmp, file)
      return
    } catch (e) {
      if (i === 3 || !/EPERM|EBUSY/.test(e.code || '')) throw e
      const wait = 100 * (i + 1)
      const end = Date.now() + wait
      while (Date.now() < end) { /* 忙等 */ }
    }
  }
}

// 局域网 IPv4 地址（排除内部回环与虚拟网卡常见段）
function lanIps() {
  const out = []
  const ifs = os.networkInterfaces()
  for (const name of Object.keys(ifs)) {
    for (const it of ifs[name] || []) {
      if (it.family === 'IPv4' && !it.internal) {
        if (/^(10\.|127\.|169\.254\.)/.test(it.address)) continue // 内部/链路本地
        out.push(it.address)
      }
    }
  }
  // 兜底：优先 192.168/172.16 段
  return out.sort((a, b) => {
    const rank = (x) => (/^192\.168\./.test(x) ? 0 : /^172\.(1[6-9]|2\d|3[01])\./.test(x) ? 1 : 2)
    return rank(a) - rank(b)
  })
}

function setName(n) {
  team.name = String(n || '').trim() || '我的团队'
  save()
  return team.name
}

// 记录资产上传者（成员归属）：kind=agent/toolPack/skill/workflow，name=文件名或工作流 id
function addAsset(kind, name, owner) {
  const rec = { kind: String(kind || ''), name: String(name || ''), owner: String(owner || '成员'), ts: Date.now() }
  team.assets.push(rec)
  if (team.assets.length > 200) team.assets = team.assets.slice(-200)
  save()
  return rec
}

// 资产归属查询表：kind|name -> owner（name 去扩展名后匹配，兼容上传文件名与列表 id）
function assetOwners() {
  const map = {}
  for (const a of team.assets || []) {
    map[a.kind + '|' + a.name] = a.owner
  }
  return map
}

function getState() {
  return { name: team.name, members: team.members, channel: team.channel }
}

function join(name) {
  const clean = String(name || '').trim().slice(0, 20)
  if (!clean) throw new Error('昵称不能为空')
  // 同名复用（同一设备刷新不重复建号）
  for (const id of Object.keys(team.members)) {
    if (team.members[id].name === clean) {
      team.members[id].lastSeen = Date.now()
      save()
      return { memberId: id, name: clean }
    }
  }
  const memberId = 'm-' + crypto.randomBytes(6).toString('hex')
  team.members[memberId] = { name: clean, isHost: false, joinedAt: Date.now(), lastSeen: Date.now() }
  // 控制成员表大小（保留最近 20 个）
  const keys = Object.keys(team.members)
  if (keys.length > 20) {
    const sorted = keys.sort((a, b) => (team.members[b].lastSeen || 0) - (team.members[a].lastSeen || 0))
    for (const k of sorted.slice(20)) delete team.members[k]
  }
  save()
  return { memberId, name: clean }
}

function touch(memberId) {
  const m = team.members[memberId]
  if (m) { m.lastSeen = Date.now(); save() }
}

function leave(memberId) {
  const m = team.members[memberId]
  if (m) { m.lastSeen = 0; save() }
}

function push(type, name, text) {
  const ts = Math.max(Date.now(), lastTs + 1)
  lastTs = ts
  const msg = { id: 'msg-' + crypto.randomBytes(6).toString('hex'), type, name, text, ts }
  team.channel.push(msg)
  if (team.channel.length > MAX_CHANNEL) team.channel = team.channel.slice(-MAX_CHANNEL)
  save()
  return msg
}

// 普通文本消息（含 "@ai " 前缀时文本原样保留，由调用方决定是否托管）
function postText(text, name) {
  return push('text', name, String(text || ''))
}

// AI 托管：以 "@ai " 开头的文本去掉前缀交给 assistant 生成，回复写回频道（type:'ai'）
async function runAi(text, opts) {
  const prompt = String(text || '').replace(/^@ai\s*/i, '').trim()
  if (!prompt) return push('ai', 'AI', '⚠️ @ai 后请输入要交给智能体处理的内容')
  try {
    const chat = require('./chat')
    const skills = require('./skills')
    const agent = await skills.get('assistant')
    const session = { id: 'team-ai-' + crypto.randomBytes(4).toString('hex'), messages: [] }
    const settings = opts && opts.settings
    const result = await chat.runChat({
      skillId: 'assistant',
      settings,
      model: (settings && settings.model) || '',
      userMessage: prompt,
      historyMessages: [],
      session,
      toolContext: {},
      onToken: () => {},
      onTool: () => {},
      onStatus: () => {}
    })
    return push('ai', 'AI', result.content || '（无回复）')
  } catch (e) {
    return push('ai', 'AI', `⚠️ AI 回复失败：${e.message || String(e)}`)
  }
}

// 增量拉取：since = 上次最后一条消息 ts，只返回更新
function sinceChannel(since) {
  const s = Number(since) || 0
  const msgs = team.channel.filter((m) => m.ts > s)
  return { name: team.name, members: team.members, channel: msgs, now: Date.now() }
}

module.exports = { init, lanIps, setName, getState, join, touch, leave, postText, runAi, sinceChannel, addAsset, assetOwners, save }
