// preload：通过 contextBridge 安全暴露主进程能力
const { contextBridge, ipcRenderer } = require('electron')

// 捕获渲染进程未处理错误 → console.error（主进程 console-message 会转发到 D 盘日志）
try {
  window.addEventListener('error', (e) => { console.error('[window-error]', e.message, (e.filename || '') + ':' + e.lineno) })
  window.addEventListener('unhandledrejection', (e) => { console.error('[unhandled-rejection]', e.reason && (e.reason.message || e.reason)) })
} catch {}

const on = (channel, fn) => {
  const listener = (_e, payload) => fn(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

contextBridge.exposeInMainWorld('harness', {
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    set: (patch) => ipcRenderer.invoke('settings:set', patch),
    pickWallpaper: () => ipcRenderer.invoke('settings:pick-wallpaper')
  },
  skills: {
    list: () => ipcRenderer.invoke('skills:list'),
    run: (id, rel) => ipcRenderer.invoke('skills:run', id, rel),
    create: (type) => ipcRenderer.invoke('skills:create', type),
    delete: (id) => ipcRenderer.invoke('skills:delete', id),
    deleteMany: (ids) => ipcRenderer.invoke('skills:delete-many', ids),
    read: (id) => ipcRenderer.invoke('skills:read', id),
    write: (id, content) => ipcRenderer.invoke('skills:write', id, content),
    files: (id) => ipcRenderer.invoke('skills:files', id),
    readFile: (id, rel) => ipcRenderer.invoke('skills:read-file', id, rel),
    writeFile: (id, rel, content) => ipcRenderer.invoke('skills:write-file', id, rel, content),
    createFile: (id, rel, content) => ipcRenderer.invoke('skills:create-file', id, rel, content),
    deleteFile: (id, rel) => ipcRenderer.invoke('skills:delete-file', id, rel),
    renameFile: (id, oldRel, newRel) => ipcRenderer.invoke('skills:rename-file', id, oldRel, newRel),
    setFileReadable: (id, rel, readable) => ipcRenderer.invoke('skills:set-file-readable', id, rel, readable),
    categories: () => ipcRenderer.invoke('skills:categories'),
    addCategory: (name) => ipcRenderer.invoke('skills:add-category', name),
    setCategory: (id, name) => ipcRenderer.invoke('skills:set-category', id, name),
    removeCategory: (name) => ipcRenderer.invoke('skills:remove-category', name)
  },
  customNodes: {
    list: () => ipcRenderer.invoke('custom-nodes:list'),
    save: (item) => ipcRenderer.invoke('custom-nodes:save', item),
    delete: (id) => ipcRenderer.invoke('custom-nodes:delete', id)
  },
  toolPacks: {
    list: () => ipcRenderer.invoke('toolpacks:list'),
    reload: () => ipcRenderer.invoke('toolpacks:reload'),
    create: (type) => ipcRenderer.invoke('toolpacks:create', type),
    delete: (id) => ipcRenderer.invoke('toolpacks:delete', id),
    deleteMany: (ids) => ipcRenderer.invoke('toolpacks:delete-many', ids),
    read: (id) => ipcRenderer.invoke('toolpacks:read', id),
    write: (id, content) => ipcRenderer.invoke('toolpacks:write', id, content),
    readFile: (file) => ipcRenderer.invoke('toolpacks:read-file', file),
    writeFile: (file, content) => ipcRenderer.invoke('toolpacks:write-file', file, content),
    runTool: (name, args) => ipcRenderer.invoke('toolpacks:run-tool', name, args),
    categories: () => ipcRenderer.invoke('toolpacks:categories'),
    addCategory: (name) => ipcRenderer.invoke('toolpacks:add-category', name),
    setCategory: (id, name) => ipcRenderer.invoke('toolpacks:set-category', id, name),
    removeCategory: (name) => ipcRenderer.invoke('toolpacks:remove-category', name)
  },
  extMcps: {
    list: () => ipcRenderer.invoke('extmcps:list'),
    add: (input) => ipcRenderer.invoke('extmcps:add', input),
    update: (id, patch) => ipcRenderer.invoke('extmcps:update', id, patch),
    delete: (id) => ipcRenderer.invoke('extmcps:delete', id),
    reload: () => ipcRenderer.invoke('extmcps:reload')
  },
  sessions: {
    list: () => ipcRenderer.invoke('sessions:list'),
    create: (opts) => ipcRenderer.invoke('sessions:create', opts),
    get: (id) => ipcRenderer.invoke('sessions:get', id),
    rename: (id, title) => ipcRenderer.invoke('sessions:rename', id, title),
    setTarget: (id, targetType, targetId) => ipcRenderer.invoke('sessions:setTarget', id, targetType, targetId),
    setModel: (id, model) => ipcRenderer.invoke('sessions:setModel', id, model),
    setSandbox: (id, sandboxId) => ipcRenderer.invoke('sessions:set-sandbox', id, sandboxId),
    setMemoryArch: (id, archName) => ipcRenderer.invoke('sessions:set-memory-arch', id, archName),
    delete: (id) => ipcRenderer.invoke('sessions:delete', id)
  },
  chat: {
    send: (payload) => ipcRenderer.invoke('chat:send', payload),
    stop: (sessionId) => ipcRenderer.invoke('chat:stop', sessionId),
    onToken: (fn) => on('chat:token', fn),
    onTool: (fn) => on('chat:tool', fn),
    onStatus: (fn) => on('chat:status', fn),
    onDone: (fn) => on('chat:done', fn),
    onError: (fn) => on('chat:error', fn)
  },
  workspace: {
    get: () => ipcRenderer.invoke('workspace:get'),
    read: (rel) => ipcRenderer.invoke('workspace:read', rel),
    write: (rel, content) => ipcRenderer.invoke('workspace:write', rel, content),
    mkdir: (rel) => ipcRenderer.invoke('workspace:mkdir', rel),
    rename: (oldRel, newRel) => ipcRenderer.invoke('workspace:rename', oldRel, newRel),
    delete: (rel) => ipcRenderer.invoke('workspace:delete', rel),
    openFile: (rel) => ipcRenderer.invoke('workspace:open-file', rel),
    sandboxes: () => ipcRenderer.invoke('workspace:sandboxes'),
    sandboxCreate: () => ipcRenderer.invoke('workspace:sandbox-create'),
    sandboxSelect: (id) => ipcRenderer.invoke('workspace:sandbox-select', id),
    sandboxDelete: (id) => ipcRenderer.invoke('workspace:sandbox-delete', id),
    sandboxSetSession: (id, sessionId) => ipcRenderer.invoke('workspace:sandbox-set-session', id, sessionId),
    sandboxSetRoot: (id) => ipcRenderer.invoke('workspace:sandbox-set-root', id),
    sandboxSetMemoryArch: (id, archName) => ipcRenderer.invoke('workspace:sandbox-set-memory-arch', id, archName),
    sandboxSetChat: (id, patch) => ipcRenderer.invoke('workspace:sandbox-set-chat', id, patch)
  },
  api: {
    status: () => ipcRenderer.invoke('api:status'),
    toggle: () => ipcRenderer.invoke('api:toggle')
  },
  agents: {
    list: () => ipcRenderer.invoke('agents:list'),
    create: () => ipcRenderer.invoke('agents:create'),
    get: (id) => ipcRenderer.invoke('agents:get', id),
    save: (ag) => ipcRenderer.invoke('agents:save', ag),
    delete: (id) => ipcRenderer.invoke('agents:delete', id),
    categories: () => ipcRenderer.invoke('agents:categories'),
    addCategory: (name) => ipcRenderer.invoke('agents:add-category', name),
    setCategory: (id, name) => ipcRenderer.invoke('agents:set-category', id, name),
    removeCategory: (name) => ipcRenderer.invoke('agents:remove-category', name),
    run: (id, inputs) => ipcRenderer.invoke('agent:run', id, inputs),
    stop: (runId) => ipcRenderer.invoke('agent:stop', runId),
    onStatus: (fn) => on('agent:status', fn),
    onOutput: (fn) => on('agent:output', fn),
    onDone: (fn) => on('agent:done', fn)
  },
  agdefs: {
    list: () => ipcRenderer.invoke('agdefs:list'),
    create: () => ipcRenderer.invoke('agdefs:create'),
    get: (id) => ipcRenderer.invoke('agdefs:get', id),
    save: (def) => ipcRenderer.invoke('agdefs:save', def),
    delete: (id) => ipcRenderer.invoke('agdefs:delete', id),
    categories: () => ipcRenderer.invoke('agdefs:categories'),
    addCategory: (name) => ipcRenderer.invoke('agdefs:add-category', name),
    setCategory: (id, name) => ipcRenderer.invoke('agdefs:set-category', id, name),
    removeCategory: (name) => ipcRenderer.invoke('agdefs:remove-category', name)
  },
  exporter: {
    run: (opts) => ipcRenderer.invoke('exporter:run', opts),
    buildExe: (opts) => ipcRenderer.invoke('exporter:build-exe', opts)
  },
  protocols: {
    list: () => ipcRenderer.invoke('protocols:list'),
    create: (name) => ipcRenderer.invoke('protocols:create', name),
    read: (name) => ipcRenderer.invoke('protocols:read', name),
    write: (name, content) => ipcRenderer.invoke('protocols:write', name, content),
    run: (name) => ipcRenderer.invoke('protocols:run', name),
    delete: (name) => ipcRenderer.invoke('protocols:delete', name),
    categories: () => ipcRenderer.invoke('protocols:categories'),
    addCategory: (name) => ipcRenderer.invoke('protocols:add-category', name),
    setCategory: (protoName, name) => ipcRenderer.invoke('protocols:set-category', protoName, name),
    removeCategory: (name) => ipcRenderer.invoke('protocols:remove-category', name)
  },
  memory: {
    list: () => ipcRenderer.invoke('memory:list'),
    create: (name, content) => ipcRenderer.invoke('memory:create', name, content),
    delete: (name) => ipcRenderer.invoke('memory:delete', name),
    categories: () => ipcRenderer.invoke('memory:categories'),
    addCategory: (name) => ipcRenderer.invoke('memory:add-category', name),
    setCategory: (memName, name) => ipcRenderer.invoke('memory:set-category', memName, name),
    removeCategory: (name) => ipcRenderer.invoke('memory:remove-category', name),
    // 记忆工作台
    files: (name) => ipcRenderer.invoke('memory:files', name),
    run: (name, rel) => ipcRenderer.invoke('memory:run', name, rel),
    readFile: (name, rel) => ipcRenderer.invoke('memory:read-file', name, rel),
    writeFile: (name, rel, content) => ipcRenderer.invoke('memory:write-file', name, rel, content),
    createFile: (name, rel, content) => ipcRenderer.invoke('memory:create-file', name, rel, content),
    deleteFile: (name, rel) => ipcRenderer.invoke('memory:delete-file', name, rel),
    renameFile: (name, oldRel, newRel) => ipcRenderer.invoke('memory:rename-file', name, oldRel, newRel),
    setProtected: (name, rel, on) => ipcRenderer.invoke('memory:set-protected', name, rel, on),
    organize: (name) => ipcRenderer.invoke('memory:organize', name),
    extract: (name, text) => ipcRenderer.invoke('memory:extract', name, text),
    resetLedger: (name) => ipcRenderer.invoke('memory:reset-ledger', name)
  },
  tools: {
    list: () => ipcRenderer.invoke('tools:list')
  },
  team: {
    status: () => ipcRenderer.invoke('team:status'),
    start: () => ipcRenderer.invoke('team:start'),
    stop: () => ipcRenderer.invoke('team:stop'),
    setName: (name) => ipcRenderer.invoke('team:set-name', name),
    state: () => ipcRenderer.invoke('team:state'),
    post: (text) => ipcRenderer.invoke('team:post', text),
    assets: () => ipcRenderer.invoke('team:assets'),
    download: (kind, name) => ipcRenderer.invoke('team:download', kind, name)
  },
  terminal: {
    start: (opts) => ipcRenderer.invoke('terminal:start', opts),
    send: (text) => ipcRenderer.invoke('terminal:send', text),
    stop: () => ipcRenderer.invoke('terminal:stop'),
    status: () => ipcRenderer.invoke('terminal:status'),
    onOutput: (fn) => on('terminal:output', fn)
  },
  platform: process.platform
})
