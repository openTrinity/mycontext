/**
 * 「文档空间白名单」的 picker —— 引导第 4 步与设置页的学习范围卡共用。
 *
 * ## ★★★ 为什么需要它（修 G6'）
 *
 * `DistillScope` 原来四个字段里两个是**聊天**概念，文档域没有任何分区
 * 白名单可读。于是用户只能"要么全部知识库、要么一个都不要" ——
 * 而知识库里可能有与工作无关的空间（个人笔记、他人共享），
 * 那些不该进画像语料。
 *
 * 而闸门**早就准备好了**：`admitByScope` 在文档那条路上已经传对了空间键
 * （`item.workspaceId ?? ""`），只是 `readDomainScope` 对 doc 行读的是
 * `conversationIds`（恒 undefined）→ 分区闸恒放行。也就是
 * "过滤能力在、白名单读不到"。
 *
 * ## ★★ 候选集只能从**已采到的文档**反推 —— 而这必须说出来
 *
 * 渠道契约里没有"列出全部知识库"这个能力（`ChannelDocuments` 只有
 * list / body / readableExtensions）。所以候选是"我们已经见过的那些"。
 *
 * 不说的话用户会以为"我的某个知识库不在列表里 = 你们漏读了"，
 * 而真相是"那个空间里的文档还没被列举到"。所以有那句 `derivedHint`。
 *
 * ## ★★★ 这里**不显示空间名字**，因为取不到
 *
 * `documents.workspace_id` 只是一个 external_id，而渠道不提供"查这个
 * 知识库叫什么"。编一个标题（比如拿第一篇文档的标题）会让用户以为
 * 那就是知识库名 —— 而它其实是里面某一篇文档的名字。
 *
 * 所以只显示 id（截断）+ 篇数。那不好看，但它诚实；而这个项目已经为
 * "编一个看起来对的值"吃过一次（仪表盘那句假的「才学了 0.0%」）。
 */
import { Button, Checkbox } from "@mycontext/design"
import { useDocumentSpaces } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export interface DocumentSpacePickerProps {
  /** 读哪个渠道的空间。`null` = 还没选渠道 → 整块不渲染。 */
  channelId: string | null
  /** 已勾选的空间 external_id。**空数组 = 不限**（见下）。 */
  value: readonly string[]
  onChange: (next: string[]) => void
}

/**
 * 空间 id 的显示形式。
 *
 * ★ 空串是**这个渠道的默认空间**（散落的云盘文件），不是"未知" ——
 * 那两者必须说不同的话，否则用户会以为有一批文档归属坏了。
 */
function labelOf(spaceExternalId: string, defaultLabel: string): string {
  if (spaceExternalId === "") return defaultLabel
  // ★ 截断：空间 id 是渠道给的长串，整条显示会把篇数挤出屏幕
  return spaceExternalId.length > 16 ? `${spaceExternalId.slice(0, 16)}…` : spaceExternalId
}

export function DocumentSpacePicker({ channelId, value, onChange }: DocumentSpacePickerProps) {
  const { t } = useDynamicTranslation("onboarding")
  const spaces = useDocumentSpaces(channelId ?? undefined, channelId !== null)

  /**
   * ★ `channelId` 为 null 时**不 return null**。
   *
   * 那正是 v2 §12.2 的 G9 那个坑：`ScopeCoverage` 对 null 直接返回 null，
   * 而"还没选过 picker"是常态 —— 结果整块覆盖面一个字都不渲染
   * （连"正在统计…"都没有），而 CDP 才抓到。
   *
   * 这里改成显示一句话：用户至少知道这一块存在、以及为什么是空的。
   */
  if (channelId === null) {
    return (
      <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
        {t("sourcesStep.spaces.noChannel", { defaultValue: "先选一个渠道，再挑要学的知识库。" })}
      </p>
    )
  }

  const items = spaces.data?.items ?? []
  const chosen = new Set(value)

  const toggle = (id: string): void => {
    onChange(chosen.has(id) ? value.filter((item) => item !== id) : [...value, id])
  }

  return (
    <div className="flex flex-col gap-2">
      {/*
        ★★★ 「一个都不勾 = 不限」必须说出来。

        判据在 `readDomainScope`：保存时空数组**不写** `scope.partitions`，
        而"这个键不存在"就是不设限。用户的直觉可能相反（以为不勾 = 不采），
        所以这一句与监听范围那侧的三个单选是同一类问题的两种解法 ——
        这里选项少（勾/不勾），一句话够；那里有三个意图，要三个单选。
      */}
      <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
        {t("sourcesStep.spaces.emptyMeaning", {
          defaultValue: "一个都不勾 = 全部知识库都学（勾了就只学勾中的那些）。",
        })}
      </p>
      {spaces.data?.derivedFromCollected === true ? (
        /**
         * ★★ 那个限制：候选来自**已采到的**文档，所以没采过的空间勾不到。
         * 不说的话用户会把"列表里没有"读成"我们漏读了"。
         */
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("sourcesStep.spaces.derivedHint", {
            defaultValue: "列表来自已采到的文档 —— 还没采过的知识库暂时不会出现在这里。",
          })}
        </p>
      ) : null}

      {spaces.isLoading ? (
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("sourcesStep.spaces.loading", { defaultValue: "正在统计…" })}
        </p>
      ) : items.length === 0 ? (
        /**
         * ★ 空列表说清**为什么**，而不是给一个空框：真相是"还没采到文档"，
         * 而那是一个用户能理解的状态（等一轮采集），不是坏了。
         */
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("sourcesStep.spaces.none", {
            defaultValue: "还没采到任何文档 —— 采过一轮之后这里会列出知识库。",
          })}
        </p>
      ) : (
        <>
          <ul className="flex flex-col gap-1">
            {items.map((item) => (
              <li key={item.spaceExternalId} className="flex items-center justify-between gap-2">
                <Checkbox
                  checked={chosen.has(item.spaceExternalId)}
                  onChange={() => toggle(item.spaceExternalId)}
                  label={labelOf(
                    item.spaceExternalId,
                    t("sourcesStep.spaces.defaultSpace", { defaultValue: "默认空间（云盘文件）" }),
                  )}
                />
                <span className="typography-caption-400 shrink-0 text-[var(--text-base-tertiary)]">
                  {t("sourcesStep.spaces.count", {
                    defaultValue: "{{count}} 篇",
                    count: item.documents,
                  })}
                </span>
              </li>
            ))}
          </ul>
          {value.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => onChange([])}>
              {t("sourcesStep.spaces.clear", { defaultValue: "取消全部（= 学全部知识库）" })}
            </Button>
          ) : null}
        </>
      )}
    </div>
  )
}
