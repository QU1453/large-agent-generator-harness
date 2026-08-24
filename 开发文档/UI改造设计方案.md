# Harness UI 改造设计方案（v4 · 纯视觉覆盖层）

> 设计目标：吸收 **VSCode / Trae / Claude** 三家审美，重构 Harness 的颜色、渐变与动效。
> 硬约束：**零功能改动、不动任何原有文件**——全部视觉改动收敛到一个新增覆盖层 `src/design-overlay-v4.css`，入口仅加一行 import，删除该行即可 100% 还原。

---

## 0. 背景

- 当前视觉（v3 覆盖层）：蓝石墨底色 + 蓝靛交互 + 暖橙🐱品牌。
- 用户反馈：**颜色不喜欢**；动画/渐变/动态可参考优秀产品。
- 本方案换用「**暖炭石底 + 靛紫光交互 + 陶土暖品牌**」的融合方向，与 v3 的蓝/橙完全区分。

## 1. 三家审美借鉴（取其精华）

| 来源 | 借鉴什么 | 落地位置 |
|---|---|---|
| **VSCode**（Dark Modern） | 深中性炭灰底、克制的 1px 边框、等宽元信息、清晰层级 | 全局底色/边框/`--mono` 元信息 |
| **Trae**（ByteDance AI IDE） | 蓝→紫 signature 渐变、交互态微光、玻璃感面板 | 主按钮/发送/激活态/Logo 渐变、blur 顶栏 |
| **Claude**（Anthropic） | 暖中性表面、陶土 clay 品牌色、衬线展示字 | 品牌高光/空状态/Logo 标题衬线字 |

**融合原则**：底色冷静（VSCode），交互发光（Trae），品牌温暖（Claude）。三层各司其职，不混用。

## 2. 色彩系统（token 表）

### 2.1 基调层 —— 暖炭石（VSCode 结构 × Claude 暖调）
| Token | v4 值 | 说明 |
|---|---|---|
| `--bg-0` | `#151517` | 应用底（比 v3 蓝底更中性、带一暖意） |
| `--bg-1` | `#1b1b1e` | 面板/画布 |
| `--bg-2` | `#212124` | 抬升面 |
| `--bg-3` | `#28282c` | 卡片/悬停面 |
| `--bg-4` | `#303034` | 激活面 |
| `--bg-5` | `#3c3c42` | 滚动条 |
| `--border` | `#2b2b30` | 常规边框 |
| `--border-2` | `#3b3b42` | 强调边框 |
| `--border-strong` | `#585863` | 悬停边框 |
| `--text` | `#eae8e3` | 主文字（暖白） |
| `--text-2` | `#aaa7a0` | 次文字 |
| `--text-3` | `#6e6b65` | 弱文字 |
| `--text-4` | `#4c4a45` | 更弱 |

### 2.2 交互层 —— 靛紫光（Trae）
| Token | v4 值 | 说明 |
|---|---|---|
| `--violet` | `#6f9bff` | 聚焦/选中/激活（Trae 亮蓝） |
| `--violet-2` | `#8f7bff` | 渐变末端（Trae 紫） |
| `--blue` | `#6f9bff` | 链接/代码高亮 |
| `--grad` | `linear-gradient(135deg, #5b8cff, #8f7bff 55%, #a78bfa)` | Trae signature 蓝→紫，主按钮/发送/Logo |
| `--grad-soft` | `linear-gradient(135deg, rgba(91,140,255,.16), rgba(143,123,255,.12))` | 激活底 |
| `--focus` | `0 0 0 3px rgba(111,155,255,.28)` | 焦点环 |

### 2.3 品牌层 —— 陶土暖（Claude）
| Token | v4 值 | 说明 |
|---|---|---|
| `--brand` | `#d98a5f` | 陶土（Claude clay 提亮一档，暗底可读） |
| `--brand-2` | `#c15f3c` | 深陶土 |
| `--brand-grad` | `linear-gradient(135deg, #e6a174, #c15f3c)` | 品牌渐变（空状态图标/用户气泡） |
| `--brand-glow` | `0 4px 16px rgba(193,95,60,.32)` | 品牌微光 |
| `--brand-text-grad` | `linear-gradient(90deg, #fff, #f0d3b8)` | 品牌标题字 |
| `--brand-aura` | `rgba(217,138,95,.06)` | 品牌氛围光晕 |

### 2.4 信息层 —— 冷静青
| Token | v4 值 | 说明 |
|---|---|---|
| `--cyan` | `#3fd0c9` | 工具调用/连线/标签（微冷青绿） |
| `--cyan-2` | `#2ab3ab` | 深一档 |

### 2.5 语义 / 半径 / 阴影
- `--danger-text #ff9d9d` / `--success-text #7ee787` / `--warning-text #ffd28f`（原样保留）
- 圆角维持 v3（6/8/12/16/999）
- 阴影：`--shadow-1/2/3` 保留，模态/卡片叠暖黑 `rgba(0,0,0,.5+)`

## 3. 动效系统

- **基准时长**：交互 ≤ 0.22s；氛围循环 4–26s；全部尊重 `prefers-reduced-motion`。
- **缓动**：`--ease-out: cubic-bezier(.25,1,.5,1)`；入场 `--ease-spring: cubic-bezier(.34,1.3,.42,1)`。
- **只动画 GPU 属性**（transform/opacity/filter/box-shadow/background-position），不触发重排。

| # | 动效 | 目标元素 | 实现 |
|---|---|---|---|
| M1 | **渐变流动** | `.btn.primary` / `.btn.send` | `background-size:200%` + hover 移动 `background-position`（0.5s ease-out） |
| M2 | **高光扫过** | `.btn.primary` / `.btn.send` ::after | hover 时 45° 白色高光条从左上扫到右下（0.45s，一次） |
| M3 | **导航指示条滑入** | `.nav-item.active::before` / `.session-item.active::before` | 从 0 宽展开 + 透明度过渡（0.22s ease-out） |
| M4 | **卡片抬升 + 光边** | `.skill-card` / `.agent-card` / `.mem-card` | hover：`translateY(-2px)` + 边框渐变（`border-color` 过渡）+ 柔和阴影 |
| M5 | **面板入场** | `.panel` | 挂载时 `fade-slide-up`（opacity 0→1，translateY 8px→0，0.28s） |
| M6 | **消息气泡弹入** | `.msg-bubble` | 出现时 `scale(.98)→1 + opacity`（0.22s spring） |
| M7 | **Logo/空状态呼吸光** | `.logo-badge` / `.empty-logo` | 靛紫/陶土双色微光呼吸（4s 循环），底色换新渐变 |
| M8 | **顶栏氛围光晕漂移** | `.main::before` | 靛紫+陶土双 radial 光晕 26s 缓慢漂移 |
| M9 | **聊天顶部光晕** | `.chat-scroll` | 靛紫 radial 顶部光（换色） |
| M10 | **画布点阵** | `.wf-canvas` / `.mem-canvas` | 点阵换靛紫，尺寸 26px |
| M11 | **工具调用呼吸条** | `.tool-call` | 左侧青色状态条 3s 缓慢呼吸发光 |
| M12 | **加载 shimmer** | `.preview-loading` 等 | 渐变 shimmer（靛紫→透明 1.4s 循环） |
| M13 | **composer 聚焦环** | `.composer-box:focus-within` | 靛紫光环淡入（0.2s） |
| M14 | **滚动条** | `::-webkit-scrollbar-thumb` | 换炭灰 `--bg-5`，hover `--border-strong` |

## 4. 排版微调（不换字体文件，纯系统栈）

- 主字体保持 `--font`（Segoe UI Variable 优先，CJK 兜底）——VSCode 式干净。
- **展示衬线**（Claude 编辑感）：Logo 标题、空状态大标题用 `Constantia, Georgia, "Times New Roman", serif`，字重 600，字距 -0.5px。
- 元信息（时间戳/状态/会话 meta）继续用 `--mono`（Cascadia Code / JetBrains Mono 兜底），`tabular-nums`。
- 正文行高 1.75、composer 1.65 保持不变。

## 5. 逐区域改造方案

### 5.1 侧栏
- Logo：`logo-badge` 换靛紫渐变 + 陶土微光呼吸；`logo-title` 用衬线 + `brand-text-grad`。
- 导航项：激活底 `--grad-soft`（靛紫）；左侧指示条 3px 靛紫渐变 + M3 滑入。
- 会话列表：激活项靛紫渐变底 + 左侧靛紫条；hover 抬升。

### 5.2 顶栏 / 工作区头部
- 顶栏保持 `backdrop-filter: blur(14px)` 玻璃感（Trae），底边 1px 靛紫微光。
- 工作区对话头部精简（上一轮已完成布局，本轮仅换色）。

### 5.3 会话与聊天
- AI 气泡：`bg-3→bg-2` 冷表面渐变 + 靛紫 1px 边框 + 内高光。
- 用户气泡：陶土暖渐变（`brand-grad` 低透明度）替代原橙。
- 工具调用：左侧青色条 + M11 呼吸；`trace-head code` 靛紫软底。
- 新消息弹入 M6。

### 5.4 卡片（技能/智能体/记忆/工具）
- M4 抬升 + 光边；hover 边框靛紫 0.4 透明度；`agent-code` 靛紫软底。
- 空状态：大图标换陶土渐变 + 呼吸光 + 衬线标题。

### 5.5 弹窗 / 编辑器
- 模态边框靛紫 0.22 透明度；`modal-header` 顶部渐变（bg-3→透明）。
- 代码编辑器保持 github-dark 高亮，边框换新。

### 5.6 画布（工作流 + 记忆）
- 底色 `--bg-1`；点阵 M10 换靛紫；选中节点靛紫光晕；marquee 虚线靛紫。
- 记忆画布节点卡：激活/连线换靛紫，协议按钮启用态靛紫渐变。

### 5.7 终端
- 面板底色 `--bg-1`，聚焦边框靛紫；输出配色沿用（语义色已覆盖）。

### 5.8 设置 / SearchSelect / 全局
- 输入聚焦靛紫环（M13 同款）；SearchSelect 下拉激活项靛紫底。
- `::selection` 靛紫 0.38；Toast 语义色沿用。

## 6. 无障碍与性能

- 文本对比度：`--text` 暖白 #eae8e3 对 #151517 ≈ 13.4:1；`--text-2` ≈ 7.1:1；`--text-3` ≈ 4.6:1 —— 均达标。
- 焦点可见：`:focus-visible` 统一靛紫环，键盘可达（沿用 v3 结构）。
- `prefers-reduced-motion: reduce` 下关闭本层全部动画（时长 0.01ms + 迭代 1 次）。
- 动效只用 transform/opacity/filter/box-shadow/background-position，不触发 Layout/Paint 抖动。
- 无新增字体/图片/网络请求，离线可用。

## 7. 实施与回滚

| 文件 | 动作 |
|---|---|
| `src/design-overlay-v4.css` | **新增**（本方案全部视觉） |
| `src/main.jsx` | 在 `design-overlay.css` 之后加一行 `import './design-overlay-v4.css'` |
| 其余任何文件 | **不动** |

回滚：删除 main.jsx 中 v4 的 import 行即可 100% 还原（v4 文件可留着备用或删除）。

## 8. 验证计划

1. `npm run build` 构建通过（无语法/打包错误）。
2. dev 冒烟 `node m-smoke.mjs` 30 项 ALL_OK（布局/交互断言不受样式影响）。
3. 打包版冒烟 `LAG_SMOKE_EXE=release exe node m-smoke.mjs` + `node f6-smoke.mjs` ALL_OK。
4. 手动核对：主按钮渐变流动、导航指示条滑入、卡片光边、空状态衬线标题、弹窗/画布新色。
