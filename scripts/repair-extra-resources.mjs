// 打包后校验 + 修复 extraResources（防 electron-builder 间歇性把部分文件写成全零字节）
// 用法：node scripts/repair-extra-resources.mjs [releaseDir]
// 对照 dev 源（runtime/python、electron/agents、electron/mcps）逐文件比对哈希，
// 缺失/损坏（含全零）则重新复制；最后用嵌入式 python 自检一次。
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'

const root = process.cwd()
const releaseDir = process.argv[2] ? path.resolve(process.argv[2]) : path.join(root, 'release', 'win-unpacked')
const md5 = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex')

// [源目录, 目标相对路径, 过滤正则]
const JOBS = [
  [path.join(root, 'runtime', 'python'), path.join('resources', 'python-runtime'), null],
  [path.join(root, 'electron', 'agents'), path.join('resources', 'builtin-agents'), /\.agent\.(js|py)$/],
  [path.join(root, 'electron', 'mcps'), path.join('resources', 'builtin-mcps'), /\.mcp\.(js|py)$/]
]

let fixed = 0
let total = 0
for (const [srcDir, relDest, filter] of JOBS) {
  if (!fs.existsSync(srcDir)) { console.warn(`[repair] 源目录不存在，跳过: ${srcDir}`); continue }
  const destDir = path.join(releaseDir, relDest)
  fs.mkdirSync(destDir, { recursive: true })
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const s = path.join(dir, entry.name)
      if (entry.isDirectory()) { walk(s); continue }
      if (filter && !filter.test(entry.name)) continue
      const rel = path.relative(srcDir, s)
      const d = path.join(destDir, rel)
      total++
      let bad = !fs.existsSync(d)
      if (!bad) {
        try { bad = md5(s) !== md5(d) } catch { bad = true }
      }
      if (bad) {
        fs.mkdirSync(path.dirname(d), { recursive: true })
        fs.copyFileSync(s, d)
        fixed++
        console.log(`[repair] 已修复: ${rel}`)
      }
    }
  }
  walk(srcDir)
}

// 自检：嵌入式 python 可用（stdlib + 常用内置模块）
const py = path.join(releaseDir, 'resources', 'python-runtime', 'python.exe')
let pyOk = false
if (fs.existsSync(py)) {
  try {
    execFileSync(py, ['-c', 'import sys,encodings,json,uuid,http.server,argparse,ssl;print(sys.version.split()[0])'], { timeout: 15000, encoding: 'utf8', windowsHide: true })
    pyOk = true
  } catch { pyOk = false }
}

console.log(`[repair] 检查 ${total} 个文件，修复 ${fixed} 个；python 自检 ${pyOk ? '通过' : '失败'}`)
process.exit(pyOk ? 0 : 1)
