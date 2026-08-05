# cult/ui —— UI 设计备选库（**参考用，未接入构建**）

从 [cult-ui](https://github.com/nolly-studio/cult-ui) 整体拷入，作为优化现有 UI 体验时的**样式与交互参考**。
MIT 许可（见 `LICENSE.md`，版权归 Jordan-Gilliam）。

- 上游 commit：`3b855612fb524cb042cc91b65f0cd575057471cc`（2026-07-22）
- 内容：`components/` 82 个 cult 特色组件、`primitives/` 51 个 shadcn 基础件、`hooks/` 8 个、`lib/` 17 个

## ★ 它现在**不参与编译**，这是刻意的

`vendor/` 已被 eslint（`eslint.config.js` 的 `ignores`）与 prettier（`.prettierignore`）整目录排除，
根 `tsconfig.json` 也只 reference `packages/*` 与 `apps/*` —— 所以这份代码**不会被门禁扫到**。

这不是偷懒，是因为它**照原样跑不起来**（下面列了三类硬伤）。
把它直接塞进 `packages/design` 会让 `pnpm typecheck` 立刻红一片，
而"先让门禁绿"的压力会诱导我们去改上游代码 —— 那样下次同步就冲突。

**正确用法：按需**把某个组件**移植**进 `packages/design/src/components/`，移植时改掉下面那些不兼容处。
不要 `export` 整个目录，也不要从应用代码直接 import `vendor/`。

## 移植时必须改的三类东西

### 1. `next/*` —— 我们没有 Next.js

8 个组件用 `next/image`（`<Image>`），2 个用 `next-themes`。
Electron 渲染层里换成原生 `<img>`；主题走我们自己的 CSS 变量（`packages/design/src/styles/`），不要引 next-themes。

```
grep -rln "next/image\|next-themes" components/
```

### 2. `motion/react` → `framer-motion`

上游用的是 `motion`（framer-motion 的新包名），我们装的是 `framer-motion@12.43.0` ——
**同一个库、同一套 API**，只是 import 路径不同。32 个组件受影响：

```
- import { motion } from "motion/react"
+ import { motion } from "framer-motion"
```

要不要转而安装 `motion` 包：**先不装**。两个包同时在依赖里会让 bundle 里出现两份动画运行时，
而现有代码全都用 `framer-motion`。

### 3. 样式体系：Tailwind 语义色 → 我们的 CSS 变量

上游用 shadcn 的语义类（`bg-background` / `text-muted-foreground` / `border-border`），
而我们用显式 CSS 变量（`bg-[var(--bg-card-z1)]` / `text-[var(--text-base-tertiary)]`）。
**这一条是移植的主要工作量**，也是必须做的 —— 直接抄类名会得到透明背景与不可读的文字
（那些语义类在我们的 Tailwind 配置里压根不存在）。

对照关系大致是：

| 上游 | 我们 |
|---|---|
| `bg-background` | `bg-[var(--bg-base-normal)]` |
| `bg-card` | `bg-[var(--bg-card-z1)]` |
| `bg-muted` | `bg-[var(--bg-card-z0)]` |
| `text-foreground` | `text-[var(--text-base-primary)]` |
| `text-muted-foreground` | `text-[var(--text-base-tertiary)]` |
| `border-border` | `border-[var(--border-divider-light)]` |
| `text-primary` / `bg-primary` | `text-[var(--text-accent-normal)]` / `bg-[var(--control-core-button-default)]` |
| `text-destructive` | `text-[var(--status-error)]` |

★ **排版类不能照抄**：上游用 `text-sm font-medium` 这类原子类，而我们有一张
固定的排版表（`packages/design/src/styles/typography.css`，10 个组合类）+ 一个门禁
（`pnpm check:typography`）会拦下**凭空捏造的**排版类名。移植时把字号字重换成
`typography-body-small-400` 这样的既有类 —— 造一个"看起来合理"的名字会让那一行
**静默退回浏览器默认字号**且不报错。

### 4. 未安装的依赖（用到才装）

`components/` 里有一批依赖我们**没有**。移植到用它们的组件时才装，别为了让整个目录编译而全装：

| 依赖 | 谁用 | 备注 |
|---|---|---|
| `lucide-react` | 17 个 | 图标。我们现在是手写 SVG（`brand-icons/`），引入前先想清是否要两套图标体系 |
| `class-variance-authority` | 14 个 | variant 管理。我们现在用 `cn()` + 三元，规模不大时不必引 |
| `@radix-ui/react-use-controllable-state` | 8 个 | 受控/非受控切换的小工具，可以自己写 20 行代替 |
| `react-use-measure` | 6 个 | 量尺寸。注意我们已经有 `useSquircle` 在用 ResizeObserver |
| `@paper-design/shaders-react` | 5 个 | WebGL shader 背景（hero 类）。**重**，桌面端慎用 |
| `three` | 2 个 | 3D。同上 |
| `vaul` / `jotai` / `embla-carousel-autoplay` / `react-wrap-balancer` / `metal-fx` / `@hugeicons/*` | 各 1-2 个 | 单点依赖 |

## 值得优先看的组件（按我们的实际界面缺口）

这份清单是**挑选建议**，不是待办 —— 每一项都要先确认它比现状真的好：

- **引导/上手**：`onboarding.tsx`、`intro-disclosure.tsx` —— 我们四步引导刚重做过，可对照它的分步动效；
- **进度/状态**：`animated-number.tsx`、`timer.tsx`、`text-animate.tsx` —— 蒸馏那一屏的数字与阶段条可以更活；
- **卡片与容器**：`texture-card.tsx`、`minimal-card.tsx`、`cutout-card.tsx`、`shift-card.tsx`、`expandable-card.tsx` —— 我们现在只有一种 `bg-card-z1 + ring` 的卡；
- **面板/抽屉**：`floating-panel.tsx`、`side-panel.tsx`、`family-drawer.tsx`、`morph-surface.tsx` —— 设置页与详情面板；
- **按钮**：`texture-button.tsx`、`metal-button.tsx`、`neumorph-button.tsx`、`border-beam-button.tsx`、`glow-button.tsx` —— 主按钮的质感；
- **列表交互**：`sortable-list.tsx`、`direction-aware-tabs.tsx`、`toolbar-expandable.tsx` —— 会话列表与工具条；
- **标题**：`gradient-heading.tsx`、`pixel-heading-word.tsx` —— 品牌感；
- **背景**：`bg-animated-gradient.tsx`、`stripe-bg-guides.tsx`、`grid-beam.tsx`、`edge-blur.tsx` —— 登录页/引导页大留白处。

★ 桌面应用与营销站的取舍不同：`hero-*`、`shader-*`、`dither-*`、`three-d-carousel` 这些是
**落地页**语言（GPU 开销大、动效抢注意力）。我们的界面是长时间停留的工作台，
引入前要问的是"它让用户更快找到东西了吗"，而不是"它好看吗"。

## 同步上游

没有自动同步脚本（这是参考库，不是依赖）。要更新就重新拷一遍并更新本文顶部的 commit：

```bash
git clone --depth 1 https://github.com/nolly-studio/cult-ui.git /tmp/cultui
rm -rf vendor/cult-ui/{components,primitives,hooks,lib}
cp -R /tmp/cultui/apps/www/registry/default/ui/. vendor/cult-ui/components/
cp -R /tmp/cultui/apps/www/components/ui/.       vendor/cult-ui/primitives/
cp -R /tmp/cultui/apps/www/hooks/.               vendor/cult-ui/hooks/
cp -R /tmp/cultui/apps/www/lib/.                 vendor/cult-ui/lib/
```

已经移植进 `packages/design` 的组件**不会**被这个操作影响 —— 那是我们的代码了。
