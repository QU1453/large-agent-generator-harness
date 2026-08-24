// 生成应用图标 build/icon.png (512x512 RGBA)，纯 Node 实现（无第三方依赖）
// 设计「Large Agent Generator」：深空渐变圆角方块 + 极光光晕 + LAG 点阵字母 + 青色轨道环
const fs = require('fs')
const path = require('path')
const zlib = require('zlib')

const SIZE = 512
const CX = SIZE / 2
const CY = SIZE / 2

// ---------- 基础工具 ----------
function lerp(a, b, t) { return a + (b - a) * t }
function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v }
function smoothstep(e0, e1, x) {
  const t = clamp01((x - e0) / (e1 - e0))
  return t * t * (3 - 2 * t)
}

// 圆角矩形 SDF（负值在内部）
function roundedRectSDF(x, y, cx, cy, half, r) {
  const qx = Math.abs(x - cx) - (half - r)
  const qy = Math.abs(y - cy) - (half - r)
  const ox = Math.max(qx, 0)
  const oy = Math.max(qy, 0)
  return Math.hypot(ox, oy) + Math.min(Math.max(qx, qy), 0) - r
}

// ---------- 颜色与形状 ----------
const bgTop = [16, 13, 36]      // #100d24
const bgMid = [58, 26, 92]      // #3a1a5c
const bgBot = [10, 52, 74]      // #0a344a
const violet = [124, 108, 246]  // #7c6cf6
const cyan = [52, 211, 200]     // #34d3c8
const bolt = [255, 255, 255]

const HALF = SIZE / 2 - 26
const RADIUS = 132

// 闪电（512 画布坐标）→ 已替换为 LAG 点阵字母（见 FONT）
// LAG 点阵字体（5x7），Large Agent Generator 缩写
const FONT = {
  L: ['X....', 'X....', 'X....', 'X....', 'X....', 'X....', 'XXXXX'],
  A: ['.XXX.', 'X...X', 'X...X', 'XXXXX', 'X...X', 'X...X', 'X...X'],
  G: ['.XXX.', 'X...X', 'X....', 'X.XXX', 'X...X', 'X...X', '.XXX.']
}
const LETTERS = ['L', 'A', 'G']
const CELL = 20     // 字母点阵每格像素
const GAP = 14      // 字母间距
const FONT_W = 5 * CELL * 3 + GAP * 2
const FONT_H = 7 * CELL
const FX = (SIZE - FONT_W) / 2
const FY = (SIZE - FONT_H) / 2

const RING_R = 176     // 轨道环半径
const RING_T = 7       // 轨道环厚度
const RING_START = -30 // 起始角（度）
const RING_END = 130   // 结束角（度）

// ---------- 逐像素渲染 ----------
const pixels = Buffer.alloc(SIZE * SIZE * 4)

for (let y = 0; y < SIZE; y++) {
  for (let x = 0; x < SIZE; x++) {
    const px = x + 0.5
    const py = y + 0.5

    const dRect = roundedRectSDF(px, py, CX, CY, HALF, RADIUS)
    const rectAlpha = smoothstep(1.2, -1.2, dRect)
    if (rectAlpha <= 0.004) continue

    // 背景：左上 → 中紫 → 右下青 的径向渐变
    const tY = py / SIZE
    let tB = smoothstep(0.25, 0.85, tY)
    const r1 = lerp(bgTop[0], bgMid[0], tY * 0.6)
    const g1 = lerp(bgTop[1], bgMid[1], tY * 0.6)
    const b1 = lerp(bgTop[2], bgMid[2], tY * 0.6)
    const r2 = lerp(r1, bgBot[0], tB)
    const g2 = lerp(g1, bgBot[1], tB)
    const b2 = lerp(b1, bgBot[2], tB)
    let r = r2, g = g2, b = b2

    // 极光光晕：中心偏下的紫色辉光 + 左上青色辉光
    const dGlow1 = Math.hypot(px - CX, py - (CY + 84))
    const g1Amt = smoothstep(250, 0, dGlow1) * 0.55
    r = lerp(r, violet[0], g1Amt * 0.9); g = lerp(g, violet[1], g1Amt * 0.8); b = lerp(b, violet[2], g1Amt * 0.7)

    const dGlow2 = Math.hypot(px - (CX - 130), py - (CY - 120))
    const g2Amt = smoothstep(220, 0, dGlow2) * 0.4
    r = lerp(r, cyan[0], g2Amt * 0.85); g = lerp(g, cyan[1], g2Amt * 0.7); b = lerp(b, cyan[2], g2Amt * 0.6)

    // 轨道环（弧形）：青色描边 + 微弱辉光
    const dCenter = Math.hypot(px - CX, py - CY)
    const ringBand = Math.abs(dCenter - RING_R)
    const ringEdge = smoothstep(RING_T + 2.5, RING_T - 2.5, ringBand)
    if (ringEdge > 0.01) {
      const angle = (Math.atan2(py - CY, px - CX) * 180) / Math.PI
      const aNorm = ((angle % 360) + 360) % 360
      const aStart = ((RING_START % 360) + 360) % 360 // 330°
      const aEnd = ((RING_END % 360) + 360) % 360     // 130°
      const inArc = aStart <= aEnd ? aNorm >= aStart && aNorm <= aEnd : aNorm >= aStart || aNorm <= aEnd
      if (inArc) {
        const glowAmt = smoothstep(14, 0, ringBand) * 0.35
        r = lerp(r, cyan[0], ringEdge * 0.75 + glowAmt)
        g = lerp(g, cyan[1], ringEdge * 0.75 + glowAmt)
        b = lerp(b, cyan[2], ringEdge * 0.75 + glowAmt)
        // 端点小圆点
        for (const deg of [RING_START, RING_END]) {
          const rad = (deg * Math.PI) / 180
          const ex = CX + RING_R * Math.cos(rad)
          const ey = CY + RING_R * Math.sin(rad)
          if (Math.hypot(px - ex, py - ey) < 5) {
            r = lerp(r, cyan[0], 0.9); g = lerp(g, cyan[1], 0.9); b = lerp(b, cyan[2], 0.9)
          }
        }
      }
    }

    // LAG 字母（Large Agent Generator）：白色主体 + 紫色辉光
    for (let k = 0; k < LETTERS.length; k++) {
      const glyph = FONT[LETTERS[k]]
      const gx0 = FX + k * (5 * CELL + GAP)
      for (let row = 0; row < 7; row++) {
        for (let col = 0; col < 5; col++) {
          if (glyph[row][col] !== 'X') continue
          const cx = gx0 + col * CELL + CELL / 2
          const cy = FY + row * CELL + CELL / 2
          const dCell = roundedRectSDF(px, py, cx, cy, CELL / 2 - 1, CELL * 0.24)
          const glow = smoothstep(9, 0, dCell) * 0.45
          r = lerp(r, violet[0], glow * 0.6); g = lerp(g, violet[1], glow * 0.6); b = lerp(b, violet[2], glow * 0.6)
          const alpha = smoothstep(1.5, -1.5, dCell)
          if (alpha > 0.01) {
            r = lerp(r, bolt[0], alpha)
            g = lerp(g, bolt[1], alpha)
            b = lerp(b, bolt[2], alpha)
          }
        }
      }
    }

    // 顶部高光（柔和光泽）
    const dSheen = Math.hypot(px - (CX - 110), py - (CY - 150))
    const sheen = smoothstep(230, 60, dSheen) * 0.09
    r += sheen * 255; g += sheen * 255; b += sheen * 255

    // 内部暗角（提升纵深）
    const vig = smoothstep(120, HALF - 20, dRect) * 0.25
    r *= 1 - vig; g *= 1 - vig; b *= 1 - vig

    const idx = (y * SIZE + x) * 4
    pixels[idx] = Math.round(clamp01(r / 255) * 255)
    pixels[idx + 1] = Math.round(clamp01(g / 255) * 255)
    pixels[idx + 2] = Math.round(clamp01(b / 255) * 255)
    pixels[idx + 3] = Math.round(255 * rectAlpha)
  }
}

// ---------- PNG 编码 ----------
function crc32(buf) {
  return zlib.crc32(buf) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

const ihdr = Buffer.alloc(13)
ihdr.writeUInt32BE(SIZE, 0)
ihdr.writeUInt32BE(SIZE, 4)
ihdr[8] = 8
ihdr[9] = 6 // RGBA
ihdr[10] = 0
ihdr[11] = 0
ihdr[12] = 0

const raw = Buffer.alloc(SIZE * (SIZE * 4 + 1))
for (let y = 0; y < SIZE; y++) {
  raw[y * (SIZE * 4 + 1)] = 0
  pixels.copy(raw, y * (SIZE * 4 + 1) + 1, y * SIZE * 4, (y + 1) * SIZE * 4)
}

const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  chunk('IHDR', ihdr),
  chunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
  chunk('IEND', Buffer.alloc(0))
])

const outDir = path.join(__dirname, '..', 'build')
fs.mkdirSync(outDir, { recursive: true })
const outPath = path.join(outDir, 'icon.png')

// 优先使用用户提供的品牌图（Large Agent Generator.png）：仅复制，不重绘、不缩放
const userIcon = path.join(__dirname, '..', 'Large Agent Generator.png')
if (fs.existsSync(userIcon)) {
  fs.copyFileSync(userIcon, outPath)
  const logoPath = path.join(__dirname, '..', 'src', 'assets', 'logo.png')
  fs.copyFileSync(userIcon, logoPath)
  console.log('图标已使用用户图片:', userIcon)
  process.exit(0)
}

fs.writeFileSync(outPath, png)
console.log('图标已生成:', outPath, `(${png.length} bytes)（未找到用户图片 Large Agent Generator.png，使用内置 LAG 点阵图标）`)
