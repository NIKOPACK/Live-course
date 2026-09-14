# LiveCourse UI 设计规范 v1

> 目的：给"逐页整改"提供统一、可对照的标准，避免每页各自为政。
> 结论：**保留现有技术选型**（shadcn/ui + Tailwind v4 + Radix + lucide-react），
> 不引入新组件库；本规范是在现有基础上补齐颜色/字体/间距/动效/组件用法的
> 明确约定，并列出现状中偏离约定的地方，供逐页修正时对照。

---

## 1. 技术选型（维持不变）

| 层 | 选型 | 说明 |
| --- | --- | --- |
| 组件库 | shadcn/ui（`style: radix-vega`） | `components/ui/*`，33 个基础组件，已成体系 |
| 无样式交互层 | Radix UI | Dialog/Popover/Select/Tabs 等的可访问性基础 |
| 样式引擎 | Tailwind CSS v4（CSS 变量驱动的 `@theme`） | 不使用 `tailwind.config.*`，主题在 `app/globals.css` |
| 图标 | lucide-react | 唯一图标库，禁止再引入其他图标集（react-icons 等） |
| 字体 | Inter Variable（正文/UI）、Geist Mono（代码/等宽） | 见 §3 |
| 动效 | `tw-animate-css`（Tailwind 动效工具类） | 见 §6；`animate.css` 已引入但项目内 0 处使用，属遗留死依赖，逐页清理时顺手移除对应文件的残留引用 |

不引入 Ant Design / MUI / Chakra 等第二套体系——原因：现有组件已覆盖常见交互，混用会导致 token、圆角、动效两套标准打架，维护成本远高于收益。

---

## 2. 色板（沿用现有 CSS 变量，禁止硬编码颜色）

所有颜色一律使用语义 token（`bg-background`、`text-foreground`、`bg-primary`、`bg-muted` 等），**不允许**出现：
- `bg-white` / `text-black` / `bg-[#xxxxxx]` / `text-[#xxxxxx]` 这类脱离主题变量的写法（深色模式下必然出错）；
- 内联 `style={{ color: '#...' }}`。

| Token | 浅色 | 深色 | 用途 |
| --- | --- | --- | --- |
| `primary` | `#722ed1`（紫） | `#8b47ea` | 主行动点：主按钮、当前选中态、品牌强调 |
| `background` / `foreground` | 白 / 近黑 | 近黑 / 白 | 页面底色与主文字 |
| `card` / `popover` | 与 background 同层级 | 略浅一级 | 卡片、浮层容器 |
| `muted` / `muted-foreground` | 浅灰 | 深灰 | 次要背景、次要文字（说明文字、禁用态） |
| `accent` | 浅灰 | 深灰 | 悬浮/展开态背景 |
| `destructive` | 红 | 红（更亮） | 删除、报错、不可逆操作 |
| `border` / `input` / `ring` | 灰 | 半透明白 | 描边、输入框边框、焦点环 |
| `chart-1..5` | 蓝色渐变序列 | 同 | 图表专用，不用于 UI 装饰 |

**现状问题**：63 个组件文件存在硬编码颜色（`grep bg-white|text-black|bg-\[#` 命中），集中在 `components/edit/*`、`components/chat/*`、`app/page.tsx`、`app/generation-preview/*`。逐页整改时优先替换为 token。

---

## 3. 字体与排版

- 正文/UI：`Inter Variable`（`--font-sans`，通过 `@fontsource-variable/inter` 加载，覆盖多语言 unicode 子集，中/俄/越南语不掉字体）。
- 代码/等宽：`Geist Mono`（`--font-mono`）。
- **待清理**：`layout.tsx` 同时加载了 `GeistSans`（`--font-sans` 已被 Inter 覆盖，`GeistSans.variable` 成为死代码），逐页清理阶段建议移除该 import 以减小字体体积。

排版尺度（Tailwind 默认刻度，不新增自定义字号）：

| 用途 | class | 字重 |
| --- | --- | --- |
| 页面主标题 | `text-2xl` / `text-3xl` | `font-semibold` |
| 卡片/区块标题 | `text-lg` | `font-medium` |
| 正文 | `text-sm` | `font-normal` |
| 说明/辅助文字 | `text-xs`，`text-muted-foreground` | `font-normal` |
| 强调/数值 | 同级字号 | `font-medium` 或 `font-semibold` |

行高统一使用 Tailwind 默认（`leading-normal`/`leading-relaxed`），长段说明文字用 `leading-relaxed`。

---

## 4. 间距与布局栅格

- 间距一律使用 Tailwind 刻度（`gap-1/1.5/2/3/4/6/8`……），不写任意 px 值。
- 组件内边距惯例：卡片 `p-4`~`p-6`，弹层 `p-4`，紧凑行 `p-2`~`p-3`。
- 页面级容器：内容主体最大宽度 `max-w-5xl`/`max-w-6xl` 居中（首页、生成预览类信息型页面）；课堂/编辑器类全屏工作台页面使用 flex/grid 占满视口，不设最大宽度。
- 圆角刻度（已在 `globals.css` 定义，直接用 `rounded-md/lg/xl/2xl`）：`--radius: 0.625rem` 为基准，卡片用 `rounded-lg/xl`，按钮/输入框用 `rounded-md`，头像/圆形用 `rounded-full`。

---

## 5. 组件使用约定

- **按钮**：任何可点击操作必须使用 `components/ui/button.tsx` 的 `Button`，禁止裸 `<button>`（现状 7 处需修正）。变体语义：
  - `default`：页面/弹层内唯一主行动
  - `outline` / `secondary`：次要操作
  - `ghost`：工具栏图标按钮、低干扰操作
  - `destructive`：删除/不可逆
  - `link`：跳转型文字操作
- **图标尺寸**：跟随按钮 size 走（`size-3`/`size-3.5`/`size-4`），不单独指定奇怪尺寸。
- **表单**：统一用 `Field`/`Input`/`Select`/`Textarea`/`Checkbox`/`Switch`，禁止裸 `<input>`/`<select>`。
- **弹层/浮层**：`Dialog`（阻断式确认/编辑）、`Popover`（轻量选择）、`DropdownMenu`（菜单）、`Tooltip`（提示），按语义选型，不要用 `Dialog` 代替 `Popover` 这种轻交互。
- **空状态/加载态/错误态**：目前分散在各页面各写一套（PBL、classroom、generation-preview 均有各自实现）。逐页整改时抽出统一的 `EmptyState`/`ErrorState` 展示模式（图标 + 一句话 + 可选操作按钮），视觉上对齐，不强制抽成单一组件（避免大范围重构风险），但视觉规格必须一致：图标 `size-8 text-muted-foreground`，标题 `text-sm font-medium`，说明 `text-xs text-muted-foreground`。

---

## 6. 动效规范

- 统一使用 `tw-animate-css` 提供的工具类（`animate-in`/`fade-in`/`zoom-in`/`slide-in-from-*`），配合 Radix 组件自带的 `data-[state=open/closed]` 动画钩子（shadcn 组件已内置，不需要每页重写）。
- 过渡时长：微交互（hover/focus）用 Tailwind 默认 `transition` ~150ms；弹层进出 200ms；页面级切换（课堂场景切换、编辑器面板展开）可到 250–300ms，避免更慢的动效影响操作效率。
- 缓动：默认 Tailwind `ease-in-out`；强调"弹出感"的少量场景可用 `ease-out`（进入）+ `ease-in`（退出）。
- 不再引入 `animate.css`（Animate.css 类名如 `animate__bounce`）新用法；现状 0 处使用，属可安全移除的遗留依赖。

---

## 7. 深色模式

- 每新增/修改一处样式，必须同时检查浅色和深色两套 token 是否都定义（现有 `:root` 与 `.dark` 两个块已覆盖全部语义 token，新增自定义色时同样要成对补充）。
- 图片/Logo 类资源如是深色单色图标，需要加入 `MONO_LOGO_PROVIDERS`（参考 `lib/ai/providers.ts`）以在深色模式下 `dark:invert`。

---

## 8. 已知偏离现状（作为逐页整改的检查清单来源）

| 问题 | 命中文件数 | 处理方式 |
| --- | --- | --- |
| 硬编码颜色（`bg-white`/`text-black`/`bg-[#..]`） | 63 | 页面改造时替换为语义 token |
| 裸 `<button>` 未走 `Button` 组件 | 7 | 替换为 `Button`（保留原有 variant/事件逻辑） |
| `animate.css` 死依赖 | 全局引入，0 处使用 | 待所有页面清理完成后统一移除 import |
| `GeistSans` 死引用（`--font-sans` 已被 Inter 覆盖） | `app/layout.tsx` | 同上，最后统一清理 |

---

## 9. 落地方式

不做"一次性全量重写"（风险太高，容易改坏课堂播放引擎、实时语音、编辑器等复杂交互）。按约定的"一页一页"节奏推进：

1. 你指定一个页面/模块；
2. 我对照本规范找出该页面的偏离点（颜色、组件、间距、动效等）；
3. 逐项修正并跑对应的测试/手动验证，避免破坏交互逻辑；
4. 全部页面走完一轮后，再统一清理 §8 中的全局遗留项（`animate.css`、`GeistSans`）。
