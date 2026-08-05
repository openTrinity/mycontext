# 第三方许可 —— `packages/design`

本包的运行时依赖里只有一类带**设计资产**的第三方内容：`@dicebear/*`
（形象生成，见 `src/components/persona-figure.tsx`）。
本文件是它们的许可记账。

> ## ★ 升级任何 `@dicebear/*` 时必须重读一遍各包的 `LICENSE`
>
> 这句话写在这里而不是靠人记。上游可以在小版本里换设计来源
> （素材换了 = 许可可能换了），而 `package.json` 的 `license` 字段
> **不足以判断** —— 见下面 `bottts` 那一条：它的字段写的是
> "See LICENSE file"，字段本身不含任何信息。
>
> 本包**不为许可加门禁**：许可只在依赖变动时才变，而依赖变动必然
> 经过 `package.json` 的 review。为一件一年变一次的事写一条门禁，
> 维护成本高于收益。代价是它依赖 review 时读到这一行 ——
> 所以这一段放在文件最前面。

## 为什么要分「代码」与「设计」两栏

每个 `@dicebear/*` 包的 `LICENSE` 原文就是这么分的（`# Design` / `# Code`
两节），而**两栏的许可往往不同**：代码一律是 MIT（Florian Körner），
设计则是 CC0 / CC BY 4.0 / 或作者自定的条款。

把它们合起来记成一句"DiceBear 是 MIT"会丢掉一件实义信息：
**其中两个包的设计要求署名**。

## 四种许可，只有一种有署名义务

| 许可                                 | 含义                           | 对我们的义务                                 |
| ------------------------------------ | ------------------------------ | -------------------------------------------- |
| MIT                                  | 保留版权与许可声明             | 本文件即为声明                               |
| CC0 1.0                              | 作者放弃权利（等同公有领域）   | **无署名义务**（本文件仍照抄来源，便于追溯） |
| **CC BY 4.0**                        | 允许商用与修改，**但要求署名** | **必须署名** —— 见下表加粗的两行             |
| Free for personal and commercial use | Bottts 作者自定                | 无强制署名，照抄来源                         |

四种都允许商业使用，所以**继续使用没有问题**；
需要做的只是把下面两个 CC BY 的署名保留住。

## 逐包记账（`9.4.2`，原文照抄）

| 包                        | 代码                       | 设计                                 | 设计来源 / 作者                                                                                                                          |
| ------------------------- | -------------------------- | ------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `@dicebear/core`          | MIT © 2024 Florian Körner | （无设计资产）                       | ——                                                                                                                                       |
| `@dicebear/notionists`    | MIT © 2024 Florian Körner | CC0 1.0                              | [Notionists](https://heyzoish.gumroad.com/l/notionists) / [Zoish](https://bio.link/heyzoish)                                             |
| `@dicebear/lorelei`       | MIT © 2024 Florian Körner | CC0 1.0                              | [Lorelei](https://www.figma.com/community/file/1198749693280469639) / [Lisa Wischofsky](https://www.instagram.com/lischi_art/)           |
| `@dicebear/thumbs`        | MIT © 2024 Florian Körner | CC0 1.0                              | [Thumbs](https://www.dicebear.com) / DiceBear                                                                                            |
| **`@dicebear/micah`**     | MIT © 2024 Florian Körner | **CC BY 4.0**                        | [Avatar Illustration System](https://www.figma.com/community/file/829741575478342595) / [Micah Lanier](https://dribbble.com/micahlanier) |
| **`@dicebear/fun-emoji`** | MIT © 2024 Florian Körner | **CC BY 4.0**                        | [Fun Emoji Set](https://www.figma.com/community/file/968125295144990435) / [Davis Uche](https://www.instagram.com/davedirect3/)          |
| `@dicebear/bottts`        | MIT © 2024 Florian Körner | Free for personal and commercial use | [Bottts](https://bottts.com/) / [Pablo Stanley](https://twitter.com/pablostanley)                                                        |

`@dicebear/bottts` 的 `package.json` 里 `license` 字段写的是
`"See LICENSE file"`（不是一个 SPDX 标识）—— 所以**任何靠 `license`
字段做自动扫描的工具在这个包上都拿不到结论**。这也是本文件存在的理由之一。

## 要署名的两条（可直接放进「关于」页或发行说明）

> **已兑现**：这两条已经显示在设置页的「关于」区
> （`apps/desktop/src/renderer/features/settings/settings-view.tsx`
> 的 `AboutSection`）。
> 在这里记一句是因为**本文件只存在于仓库里** —— 用户装到的是打包产物，
> 读不到它，所以"文本写好了"与"义务兑现了"是两件事。
> 改动那一段（或删掉那两个包）时请一并更新这里。

```
Micah avatar style — Avatar Illustration System by Micah Lanier,
licensed under CC BY 4.0.
https://www.figma.com/community/file/829741575478342595
https://creativecommons.org/licenses/by/4.0/

Fun Emoji avatar style — Fun Emoji Set by Davis Uche,
licensed under CC BY 4.0.
https://www.figma.com/community/file/968125295144990435
https://creativecommons.org/licenses/by/4.0/
```

## 一条与许可相关的实现约束

形象**必须离线生成**（`createAvatar` 本地调用），不得改用
`api.dicebear.com`。那条约束的主要理由是"没网就没脸"与隐私
（见 `persona-figure.tsx` 的文件头），但它顺带也简化了许可面：
我们分发的是**这些 npm 包**，而不是对一个第三方服务的调用。
