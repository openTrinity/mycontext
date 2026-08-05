/**
 * 仪表盘的**数字分身卡**。
 *
 * ## ★★ 这个文件里曾经还有一个 `SelfIdentityStrip`，它被删了
 *
 * 那一版的判断（本人身份与数字分身要分开）是对的，用户明确要求过
 * 「高鹏（真实身份）和小小周（数字身份）不用放在一起」。
 * 但拆开之后我把本人身份做成了页头右侧一条 ——
 * 而**侧栏底部本来就常驻着同一份**（`sidebar-user-button.tsx`：
 * 头像 + 高鹏 + 邮箱，一直可见）。
 *
 * 于是同一屏出现两个同名头像。读者会去找它们的区别，而其实没有区别 ——
 * 这正是「还是很怪，很割裂」里的一条。所以那条整个删掉：
 * **本人身份归侧栏**，这一页只讲分身。
 *
 * ## ★ 但删掉时有一样东西不能跟着丢
 *
 * 那条里的「身份待确认 —— 蒸馏会拒掉全部语料」。
 * 未确认时蒸馏会**静默**拒掉全部语料（历史上 9768 条全被守卫拒掉，
 * 而进度页显示"完成"）—— 那是必须被看见的状态。
 *
 * 它搬去了 `dashboard-module.tsx` 的 `ProblemLine`：那一页所有"哪里坏了"
 * 都长那个样子，它本来就该在那儿。而原来的条平时永远显示"本人身份已确认"
 * —— 一句恒亮的、永远不需要动作的话，那是噪音。
 * 现在**只有出事时才出现**，判据仍走 `readIdentityBar`（纯函数、有单测）。
 *
 * ## ★ 渠道筹码也不在这里了
 *
 * 「钉钉」是**整页的取值范围**，现在在 `AppHeader` 的 actions 槽里，
 * 与页面标题同级 —— 那是 `scope-chip.tsx` 自己写的定位。
 */
import { Button, PersonaFigure, cn } from "@mycontext/design"
import type { PersonaSnapshotView } from "@mycontext/ipc-contract"
import type { PersonaIdentity } from "../persona/persona-identity.js"
import { readIdentityBar, type PersonaCards } from "./dashboard-data.js"
import { StatTile } from "./primitives.js"

export interface PersonaCardProps {
  /** 数字分身的名字与形象（与草稿署名同源，见 persona-identity.ts） */
  persona: PersonaIdentity
  snapshot: PersonaSnapshotView | null
  cards: PersonaCards | null
  /** 「去起个名字」跳引导流程。不给则不显示那个按钮 */
  onConfigurePersona?: () => void
}

/**
 * 数字分身卡：形象 + 名字 + 运行状态 + 四个数。
 *
 * ## ★ 形象放大到 56px，且与名字/状态成一竖列
 *
 * 上一版是 32px 挤在箭头右边。而这一页的主角就是它 —— 用户来仪表盘
 * 是看"我的分身现在怎么样"，那个形象是这一页唯一的拟人锚点。
 * 32px 在一堆文字里读不出是一张脸（尤其 notionists 那种线稿风格）。
 *
 * ## ★ 四个数与它在同一张卡，中间一条分隔线
 *
 * 这一条从上一版保留：它们是同一个主语的两半（"它是谁" / "它在干什么"）。
 * 分成两块时会出现两处重复 ——「在盯着新消息」与「N 个会话可自动回」
 * 各写两遍（后者还是同一个 `autoReplyCount`）。
 *
 * ★ 而那四个数用凹槽（`StatTile` 的 `surface` 默认就是 `sunken`）。
 * 上一版它们与这张卡是**同一个色值**（都 `rgb(38,38,38)`，量过），
 * 于是四个框只靠 1px 描边浮在同色底上 —— "框里的框"。
 * 现在层级靠色阶，两套主题下都自动成立（见 `panel.tsx` 文件头）。
 *
 * ## ★★ 这张"卡"**没有框**了，理由记在这里
 *
 * 上一版它是 `Panel`（有底色 + 描边）。而这一页只有 5 个块，套上之后
 * 变成"框套框套框"（卡里还有四个数字块）—— 用户看到的是
 * 「上面为啥还要加框，好怪，能不能视觉简洁高级点」。
 *
 * 现在它是裸的 `<section>`：与主数字之间靠**间距**分开（`dashboard-module`
 * 里那条 hairline），内部靠那条 `border-t` 分「它是谁 / 它在干什么」。
 * 那条 `border-t` 因此**不能删** —— 去掉外框之后它是唯一的内部分界。
 *
 * ## ★ 分身还没起名字时给「去起个名字」，不是一行灰字
 *
 * 空状态给下一步动作 —— 与 `draft-inbox.tsx` 的空态同一个判断。
 * 一行「未配置」会让用户知道缺东西但不知道去哪补，而这一页没有任何
 * 通往引导流程的入口。
 */
export function PersonaCard({ persona, snapshot, cards, onConfigurePersona }: PersonaCardProps) {
  /**
   * ★ 判定走 `readIdentityBar`（纯函数、有单测），这里只管画。
   *
   * 那几个判定（分身有没有名字 / 身份三态）都是"看起来显然、写错了却
   * 静默"的那种 —— 见那个函数的文件注释。
   */
  const view = readIdentityBar({ channels: [], personaName: persona.name, selfConfirmed: true })
  const named = view.personaNamed

  return (
    /**
     * ★★ 分身与那四个数在**同一行**（用户：「小小周和下面的待我确认、
     * 可自动回复等应该放在一行也完全可以吧」）。
     *
     * 上一版是上下两段 + 一条 `border-t`。那个分界当时的理由是
     * "它是谁 / 它在干什么"，但那两半其实是**同一句话**：
     * 「小小周 在盯着新消息，有 0 条等我确认、7 个会话可自动回」。
     * 竖着摆让它占了两倍高度，而右边那一大片空白什么都没装。
     *
     * 并成一行之后那条 `border-t` 也就不需要了 —— 没有上下两半要分。
     *
     * `flex-wrap` + 数字块 `flex-1 basis-[150px]`：窄窗口时四个数
     * 自己换行，分身那一块不会被挤成一条竖线。
     */
    <section className="grid grid-cols-12 gap-6">
      {/*
        ── 它是谁：形象 + 名字 + 运行状态 ───────────────────

        ★★ `col-span-4` —— 这一块与外面那套 12 列栅格**共用同一条线**。

        上一版是 `flex flex-wrap` + 四个数字块 `flex-1 basis-[140px]`：
        于是分身块占"它内容需要的宽度"、卡片从剩余空间里分 —— 在真应用里
        量到卡片左缘 x=428，而上面那排清点数左缘 x=928、头像 x=64。
        三条互不重合的竖线，块与块之间那些"奇怪的空白"就是它们之间的残余
        （用户："你不觉得很不对齐吗，奇怪的空白很多"）。

        改成 12 列之后：分身块 4 列 + 四个卡片各 2 列（4 + 4×2 = 12），
        而外面那排清点数是六项各 2 列 —— 于是**段 2 的第 3 项与这里第 1 个
        卡片左缘对上**，上下两段互相锚定。

        窄屏：`col-span-12`（分身块独占一行），卡片降到 `col-span-6`
        （两行两列）—— 每一档都是 12 的整除数，换行后仍然对齐。
      */}
      <div className="col-span-12 flex min-w-0 items-center gap-4 lg:col-span-4">
        {named ? (
          <PersonaFigure
            seed={persona.figureSeed}
            {...(persona.figureStyle === undefined ? {} : { style: persona.figureStyle })}
            imageSrc={persona.figureImagePath ?? null}
            custom={persona.figureCustom}
            size={56}
            className="shrink-0 rounded-[var(--radius-lg)]"
          />
        ) : (
          // 没起名字时形象也还没定 —— 给一个中性占位而不是一张随机脸
          <span
            aria-hidden
            className="size-14 shrink-0 rounded-[var(--radius-lg)] bg-[var(--bg-card-z0)]"
          />
        )}

        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          {/*
            ★ 卡的标题是「我的数字分身」，而分身的**名字**是主行。
            上一版没有这个标题（身份卡里两个名字并排，靠箭头区分谁是谁），
            于是"小小周是什么"要靠猜。
          */}
          <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
            我的数字分身
          </span>
          <span className="typography-title-base-600 truncate text-[var(--text-base-primary)]">
            {named ? persona.name : "还没有数字分身"}
          </span>
          {/*
            ★ 状态点与这句话在**同一个 span 里**，不是外层的兄弟节点。
            第一版把它放在文字块外面，而外层是 `flex-1` —— 于是那个点
            被挤到整行最右端，离它要修饰的那句话有半屏远（截图自查时
            一眼就看出来了：一个孤零零的绿点悬在空白处）。
          */}
          <span className="typography-caption-400 flex min-w-0 items-center gap-1.5 text-[var(--text-base-tertiary)]">
            {named && snapshot !== null ? (
              <span
                aria-hidden
                className={cn(
                  "size-1.5 shrink-0 rounded-full",
                  snapshot.running ? "bg-[var(--status-success)]" : "bg-[var(--text-base-disable)]",
                )}
              />
            ) : null}
            <span className="truncate">
              {named
                ? snapshot === null
                  ? "读取中"
                  : snapshot.running
                    ? "在盯着新消息"
                    : "调度未运行"
                : "起个名字它才能在草稿上署名"}
            </span>
          </span>
        </div>

        {/* 空状态给**下一步**，不是一行灰字（见文件头） */}
        {named || onConfigurePersona === undefined ? null : (
          <Button size="sm" variant="secondary" onClick={onConfigurePersona}>
            去起个名字
          </Button>
        )}
      </div>

      {/*
        ── 它在干什么：四个数 ─────────────────────────────

        ★ 与左边那块并排，且**吃掉剩余宽度**（`flex-1`）——
        上一版它们在下面一整行、四等分整页宽，于是每个块里
        「0」那个数字周围有一大片空白。现在它们靠右铺开，
        与左边的分身身份读成一句话。
      */}
      {/*
        ── 它在干什么：四个数 ─────────────────────────────

        ★ 每个卡片 `col-span-2`（宽屏），与上面那排清点数**同宽同线**。
        上一版用 `flex-1 basis-[140px]` —— 那是"平分剩余宽度"，
        而剩余宽度取决于左边分身块占了多少，于是卡片的左缘随内容漂。

        ★ 「可自动回复」只在这里出现一次。上一版身份条里还写着
        「N 个会话可自动回」—— 同一个 `autoReplyCount`，一屏两种说法。
      */}
      {cards === null
        ? null
        : [
            {
              label: "待我确认",
              value: cards.pendingDrafts,
              hint: "草稿箱里等着审",
              tone: cards.pendingDrafts !== "0" ? ("warn" as const) : ("neutral" as const),
            },
            { label: "可自动回复", value: cards.autoReply, hint: "回复模式设成自动的会话" },
            { label: "正在排队", value: cards.pendingInbox, hint: "收到但还没处理" },
            { label: "常驻会话", value: cards.residents, hint: "当前 / 上限" },
          ].map((item) => (
            <div key={item.label} className="col-span-6 lg:col-span-2">
              <StatTile
                label={item.label}
                value={item.value}
                hint={item.hint}
                {...(item.tone === undefined ? {} : { tone: item.tone })}
              />
            </div>
          ))}
    </section>
  )
}
