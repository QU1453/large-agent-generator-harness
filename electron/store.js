// 简单 JSON 持久化存储：设置 + 会话
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')

class JsonStore {
  constructor(filePath) {
    this.filePath = filePath
    this.data = null
  }

  load() {
    try {
      this.data = JSON.parse(fs.readFileSync(this.filePath, 'utf8'))
    } catch {
      this.data = {}
    }
    return this.data
  }

  save() {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
    const tmp = this.filePath + '.tmp'
    fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    fs.renameSync(tmp, this.filePath)
  }

  get(key, fallback = null) {
    return this.data && key in this.data ? this.data[key] : fallback
  }

  set(key, value) {
    if (!this.data) this.load()
    this.data[key] = value
    this.save()
  }
}

// ---------- 设置 ----------
function createSettingsStore(userDataDir) {
  const store = new JsonStore(path.join(userDataDir, 'settings.json'))
  store.load()
  return {
    getAll() {
      return store.data || {}
    },
    saveAll(obj) {
      store.data = obj || {}
      store.save()
    },
    get(key, fallback = null) {
      return store.get(key, fallback)
    },
    set(key, value) {
      store.set(key, value)
    }
  }
}

// ---------- 会话 ----------
function createSessionStore(userDataDir) {
  const dir = path.join(userDataDir, 'sessions')
  fs.mkdirSync(dir, { recursive: true })

  const fileOf = (id) => path.join(dir, `${id}.json`)
  const list = () => {
    const items = []
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const s = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'))
        items.push(s)
      } catch { /* 忽略损坏文件 */ }
    }
    return items.sort((a, b) => (b.updatedAt || 0) - (a.updatedAt || 0))
  }

  return {
    list,
    get(id) {
      try {
        return JSON.parse(fs.readFileSync(fileOf(id), 'utf8'))
      } catch {
        return null
      }
    },
    create({ title = '新会话', skillId = 'assistant', targetType = 'skill', targetId = null, model = '', sandboxId = null } = {}) {
      const now = Date.now()
      const session = {
        id: crypto.randomUUID(),
        title,
        skillId,
        targetType: targetType === 'agent' ? 'agent' : 'skill',
        targetId: targetId || (targetType === 'agent' ? null : skillId),
        model: model || '',
        sandboxId: sandboxId || null,
        createdAt: now,
        updatedAt: now,
        messages: []
      }
      this.save(session)
      return session
    },
    save(session) {
      session.updatedAt = Date.now()
      fs.writeFileSync(fileOf(session.id), JSON.stringify(session, null, 2), 'utf8')
    },
    rename(id, title) {
      const s = this.get(id)
      if (s) { s.title = title; this.save(s) }
      return s
    },
    setTarget(id, targetType, targetId) {
      const s = this.get(id)
      if (s) {
        s.targetType = targetType === 'agent' ? 'agent' : 'skill'
        s.targetId = targetId || null
        if (s.targetType === 'skill' && targetId) s.skillId = targetId
        this.save(s)
      }
      return s
    },
    setModel(id, model) {
      const s = this.get(id)
      if (s) { s.model = model || ''; this.save(s) }
      return s
    },
    setSandbox(id, sandboxId) {
      const s = this.get(id)
      if (s) { s.sandboxId = sandboxId || null; this.save(s) }
      return s
    },
    remove(id) {
      try { fs.unlinkSync(fileOf(id)) } catch { /* 忽略 */ }
    },
    clearAll() {
      for (const name of fs.readdirSync(dir)) {
        if (name.endsWith('.json')) {
          try { fs.unlinkSync(path.join(dir, name)) } catch { /* 忽略 */ }
        }
      }
    }
  }
}

module.exports = { JsonStore, createSettingsStore, createSessionStore }
