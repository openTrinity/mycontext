/**
 * SettingsView — 设置页。
 *
 * 布局对齐参考设计系统的设置页：左侧分类导航 + 右侧内容区，
 * 内容区带独立标题与滚动，分类切换不影响滚动位置。
 *
 * 本阶段只有「通用」「渠道」「关于」三个分类有内容；模型、数字人、数据等分类
 * 留到对应能力落地时再加——先放占位入口只会得到点了没反应的死链。
 */
import { Button, Switch, cn } from "@mycontext/design"
import { useState } from "react"
import type { ReactNode } from "react"
import { languageNames, LANGUAGES } from "@mycontext/i18n"
import type { LanguagePreference } from "@mycontext/ipc-contract"
import {
  useBootstrapState,
  useChannels,
  useSetLanguage,
  useSetQuitConfirmSuppressed,
  useSetWorkLayerEnabled,
  useStatusReport,
} from "../../lib/queries.js"
import { useErrorText } from "../../lib/use-error-text.js"
import {
  ACCENTS,
  useTheme,
  type AccentPreference,
  type ThemePreference,
} from "../../lib/use-theme.js"
import { ChannelAuthPanel } from "../channels/channel-auth-panel.js"
// ★ `IdentitySwitcher` 暂时下架（多渠道并存后它的语义不对了，
// 见下面渠道区那段注释）。组件本身保留，重写好之后再挂回来。
import { AdvancedAiPanel } from "./advanced-ai.js"
import { ModelConfigForm } from "./model-config-form.js"
import { IdentityPanel } from "./identity-panel.js"
import { OnboardingPanel } from "./onboarding-panel.js"
import { PersonaFigurePanel } from "./persona-figure-panel.js"
import { PersonaRuntimePanel } from "./persona-runtime-panel.js"
import {
  ChecklistIcon,
  GraphIcon,
  InfoIcon,
  PersonaIcon,
  PlugIcon,
  SlidersIcon,
  TuningIcon,
} from "../shell/icons.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { personaCapableChannels } from "../../lib/channel-capability.js"
import { ChannelPicker } from "../shell/channel-picker.js"
import { CollectionScopePanel } from "../shell/collection-scope-panel.js"
import { KlPanel } from "../shell/status-panel.js"
import { IngestIntervalsPanel } from "./ingest-intervals-panel.js"

type SectionId =
  | "general"
  | "model"
  | "channelAuth"
  | "channelCollect"
  | "channelGraph"
  | "persona"
  | "onboarding"
  | "about"

/**
 * 这一栏**受不受当前渠道管**。
 *
 * ## ★★ 为什么要有这个集合（用户明确要求的形状）
 *
 * 用户原话：「除了通用和关于的 tab，别的都要区分渠道」+「设置整体有个
 * 全局的地方记住现在的渠道」。
 *
 * 所以渠道选择器提到**弹窗级**（不再由每个分区各自持一份 state），
 * 而这个集合回答"当前这一栏要不要显示那个选择器、以及它的内容要不要
 * 跟着渠道走"。
 *
 * ★ 只列**不受**渠道管的两个，而不是列出受管的六个 —— 将来加一栏时
 * 默认落在"受渠道管"那一侧（那是这个应用的常态），忘了改这里不会
 * 让新栏悄悄变成全局的。
 */
const CHANNEL_FREE_SECTIONS = new Set<SectionId>(["general", "about"])

/**
 * 导航分组。
 *
 * 对齐参考实现：导航是**分组的**（每组有一个小标题），而不是一列平铺的项。
 * 分组让"这个设置属于哪一类"在扫视时就成立 —— 三项时收益还不明显，
 * 但设置项只会增加（模型 / 数字人 / 数据 / 快捷键…），
 * 平铺到十几项时再补分组要动布局。
 *
 * 标题与项名都存 key，渲染时才翻译 —— 模块级常量在 i18n 就绪前就求值了。
 */
interface NavItem {
  id: SectionId
  labelKey: string
  icon: ReactNode
}

/**
 * 导航分组 —— 按**受不受当前渠道管**分，而不是按功能相近度。
 *
 * ## ★★ 为什么这样分组（用户明确要求的形状）
 *
 * 用户原话：「除了通用和关于的 tab，别的都要区分渠道」、「现在的渠道
 * 一级 tab 不要了，他的二级子 tab 全变成一级 tab」、「数字分身不需要
 * 归类（现在有个数字分身下面有数字分身和引导流程），显然这都是归属于
 * 渠道的概念」。
 *
 * 于是分两组：
 *
 * · **应用**（`groups.app`）：通用 / 关于 —— 与渠道无关，改一次管全局；
 * · **当前渠道**（`groups.channel`）：授权 / 采集 / 图谱服务 / 模型 /
 *   数字分身 / 引导流程 —— 全部跟着弹窗顶部那个渠道选择器走。
 *
 * 这个分法本身就在回答"改这一项会影响什么"：第二组里任何一项的改动
 * 只作用于当前那个渠道。上一版按"应用 / 数字分身 / 其他"分，
 * 而那三个标签**不构成一个统一的判据** —— 用户看不出「模型」为什么
 * 与「通用」同组、而「数字分身」自己一组。
 *
 * ## ★ 不再有父子层级
 *
 * 「渠道」那个父项没了：它原来的三个子项升为一级。父项存在的唯一理由是
 * "把渠道相关的收在一起"，而现在**整个第二组**就是这件事，
 * 再套一层等于同一个信息说两遍。
 *
 * 标题与项名都存 key，渲染时才翻译 —— 模块级常量在 i18n 就绪前就求值了。
 */
const NAV_GROUPS: readonly {
  titleKey: string
  items: readonly NavItem[]
}[] = [
  {
    titleKey: "groups.app",
    items: [
      { id: "general", labelKey: "sections.general", icon: <SlidersIcon /> },
      { id: "about", labelKey: "sections.about", icon: <InfoIcon /> },
    ],
  },
  {
    titleKey: "groups.channel",
    items: [
      { id: "channelAuth", labelKey: "channels.tabs.auth", icon: <PlugIcon /> },
      { id: "channelCollect", labelKey: "channels.tabs.collect", icon: <ChecklistIcon /> },
      { id: "channelGraph", labelKey: "channels.tabs.graph", icon: <GraphIcon /> },
      /**
       * ★ 「模型」进这一组是**导航上**的归属（它跟着渠道选择器走），
       * 但它的**存储仍是应用级** —— 那一页上写明了这一点。
       * 理由见 `ModelSection` 里那段注释：模型配置描述的是"用哪个 LLM 网关"，
       * 与"哪个 IM 渠道"无关，同一份配置同时服务两个渠道的蒸馏与建图。
       */
      { id: "model", labelKey: "sections.model", icon: <TuningIcon /> },
      { id: "persona", labelKey: "sections.persona", icon: <PersonaIcon /> },
      { id: "onboarding", labelKey: "sections.onboarding", icon: <ChecklistIcon /> },
    ],
  },
]

export interface SettingsViewProps {
  /**
   * 标题节点，渲染进**左导航列顶部**。
   *
   * 由弹窗传进来而不是这里写死：`aria-labelledby` 要指向它，
   * 而那个 id 属于弹窗（Dialog 需要它来建立无障碍关联）。
   */
  title?: ReactNode
}

export function SettingsView({ title }: SettingsViewProps = {}) {
  const { t } = useDynamicTranslation("settings")
  const { t: tch } = useDynamicTranslation("channels")
  const [active, setActive] = useState<SectionId>("general")
  /**
   * ── ★★★ 弹窗级的「当前渠道」 ────────────────────────────────
   *
   * 用户原话：「设置整体有个全局的地方记住现在的渠道」、「设置除了通用和
   * 关于都要有个全局切换显示当前配置的渠道的地方」。
   *
   * ## 为什么必须提到这一层
   *
   * 上一版是**每个分区各自持一份** `pickedChannelId`（渠道区一份、
   * 数字分身区一份）。两个后果：
   * · 在「授权」里切到飞书、点进「数字分身」又变回钉钉 —— 用户以为自己
   *   切过了，而看到的是另一个渠道的设置；
   * · "现在配的是哪个渠道"没有单一真源，两份 state 必然分叉。
   *
   * 提到弹窗级之后它只有一份，所有受渠道管的分区都读它。
   *
   * ## ★ 默认落在哪
   *
   * "选过的 → 第一个已授权的 → 第一个可用的"。不默认注册表第一个
   * （那是钉钉），否则在只授权了飞书的机器上一进来就显示钉钉的空设置
   * —— 那个坑在引导页踩过一次（#88）。
   */
  const channels = useChannels()
  const channelList = channels.data ?? []
  const authorizedChannels = channelList.filter(
    (c) => c.available && c.status.state === "authorized",
  )
  const [pickedChannelId, setPickedChannelId] = useState<string | null>(null)
  const activeChannelId =
    pickedChannelId ?? authorizedChannels[0]?.id ?? channelList.find((c) => c.available)?.id ?? null
  /** 当前这一栏受渠道管吗 —— 决定顶部那个选择器要不要出现。见 `CHANNEL_FREE_SECTIONS`。 */
  const sectionUsesChannel = !CHANNEL_FREE_SECTIONS.has(active)

  return (
    /**
     * ★ `w-full` 不能少 —— 这是那片空白的**第二个**原因。
     *
     * 这个 div 是弹窗（960px）与双栏之间的一层。原来只有 `flex h-full`：
     * flex 容器在**主轴上按内容收缩**，于是它实测只有 703px，
     * 右边 257px 是弹窗的空底。加上左导航 240px，内容区就只剩 463px
     * —— 而 `max-w-[560px]` 那个限宽根本没机会生效（463 < 560）。
     *
     * 也就是说用户看到的空白是两层叠出来的：
     * ① 这一层没铺满（257px 空底）；
     * ② 内容被 `mx-auto max-w-[560px]` 居中（在 720px 假设下再空 112px）。
     * 只修 ② 的话空白会从 112px 变成 257px —— **更宽**。
     * 我第一版差点就那样收工，是实测量出 703 才发现的。
     */
    <div className="flex h-full min-h-0 w-full">
      {/*
        左侧导航列。
        240px + **侧栏底色** —— 对齐参考实现：导航列与内容区靠底色分区，
        而不是靠一根分隔线。底色分区在弹窗这种小尺寸容器里更清楚
        （1px 线在圆角容器里容易看起来像描边的一部分）。
      */}
      <nav
        className="flex w-[240px] shrink-0 flex-col gap-4 overflow-y-auto bg-[var(--bg-sidebar-normal)] px-3 py-4"
        aria-label={t("nav")}
      >
        {title === undefined ? null : <div className="px-2 pb-2">{title}</div>}
        {NAV_GROUPS.map((group) => (
          <div key={group.titleKey} className="flex flex-col gap-0.5">
            <div className="typography-caption-400 px-2 pb-1 text-[var(--text-base-tertiary)]">
              {t(group.titleKey)}
            </div>
            {group.items.map((section) => (
              <button
                key={section.id}
                type="button"
                aria-current={active === section.id ? "page" : undefined}
                onClick={() => setActive(section.id)}
                className={cn(
                  "flex h-8 cursor-pointer items-center gap-2 radius-lg px-2 text-left",
                  "typography-body-small-400 transition-colors duration-150",
                  // 与主侧栏同一套选中语言（中性加深底色）—— 同一屏里不该出现
                  // 两种「当前项」的表达方式。
                  active === section.id
                    ? "bg-[var(--overlay-on-container-selected)] text-[var(--text-base-primary)]"
                    : "text-[var(--text-base-secondary)] hover:bg-[var(--overlay-on-container-hover)] hover:text-[var(--text-base-primary)]",
                )}
              >
                <span className="flex size-4 shrink-0 items-center justify-center">
                  {section.icon}
                </span>
                <span className="min-w-0 truncate">
                  {/* 渠道那三项的 key 在 settings 命名空间下（channels.tabs.*） */}
                  {t(section.labelKey)}
                </span>
              </button>
            ))}
          </div>
        ))}
      </nav>

      {/*
        ★ 内容区：**不再**限宽居中。

        ## 原来是 `mx-auto max-w-[560px]`，两个毛病

        ① **滚动条与内容分离**：`overflow-y-auto` 在这个 720px 的容器上，
           而内容被压到 560px 并居中 —— 于是滚动条贴在 720px 的右缘、
           内容右边空出 112px（720 − 560 − 48 padding）。截图上量到的
           就是这个数：滚动条离弹窗右缘约 112px CSS，中间一片死白。
           用户的第一反应是"滚动条怎么不在最右边"，而那只是**症状**。

        ② **那个 560 已经过期**：它的原注释写「不限宽时内容区是 720−48」，
           也就是它是按**旧的 720px 弹窗**挑的。弹窗现在是 960px
           （见 settings-dialog.tsx 的 `min(960px, ...)`），
           而形象定制那一屏真的需要宽度 —— 色板 20 个色点、槽位 10 个标签，
           在 560px 里全都要换行，右边却还空着 112px。

        现在让内容铺满内容区，由**各面板自己**决定要不要限宽
        （身份表单那种长文本行仍该限宽，形象定制不该）。
        原注释担心的"控件靠右、中间一大片空白"是 `SettingRow` 的
        `justify-between` 造成的，那要在行组件里解决，不是靠掐整页的宽度
        —— 掐宽度会顺带把**不该窄**的面板也一起掐了。
      */}
      <div className="flex min-h-0 flex-1 flex-col bg-[var(--bg-base-normal)]">
        {/*
          ── ★★★ 全局的「当前渠道」条 ─────────────────────────────

          用户原话：「设置整体有个全局的地方记住现在的渠道，比如右上角还是
          你觉得有更好的地方你定」。

          ## 为什么放在**内容区顶部**而不是右上角

          右上角是弹窗的关闭按钮所在（`settings-dialog.tsx`），把渠道选择器
          塞在它旁边会让"关掉"和"换渠道"两个语义完全不同的控件挨在一起 ——
          误点的代价不对称（一个只是关窗，一个会换掉你正在看的整页配置）。

          而这里是**内容区的顶栏**：它在左侧导航之外、在页面标题之上，
          位置上就说明了"它管的是右边这一整页"。与仪表盘把渠道筹码放页头
          是同一个判断（那也是"这一页的取值范围"）。

          ## ★ 只在受渠道管的栏出现

          通用/关于是全局设置，给它们显示一个渠道选择器等于暗示"这一页也
          分渠道" —— 那是假的。见 `CHANNEL_FREE_SECTIONS`。

          ## ★ 只有一个渠道时退化成静态标识

          `ChannelPicker` 自己会退化（options 只剩一个时不给下拉），
          所以这里不必再判一次 —— 但仍然显示，因为"当前配的是哪个渠道"
          这个事实即使不可切换也该说出来。
        */}
        {sectionUsesChannel && activeChannelId !== null ? (
          <div className="flex shrink-0 items-center gap-2 border-b border-[var(--border-divider-light)] px-6 py-3">
            <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
              {t("channelScope.label")}
            </span>
            <ChannelPicker
              options={channelList
                .filter((c) => c.available)
                .map((c) => ({
                  id: c.id,
                  label: tch(`${c.id}.label`, { defaultValue: c.id }),
                  // 未授权的仍可选（授权页本来就是去授权的地方），但标出来
                  unsupported: c.status.state !== "authorized",
                }))}
              activeId={activeChannelId}
              onChange={setPickedChannelId}
              ariaLabel={t("channelScope.pickerLabel")}
              side="bottom"
            />
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <div className="w-full p-6">
            {active === "general" ? (
              <GeneralSection />
            ) : active === "model" ? (
              <ModelSection channelId={activeChannelId} />
            ) : active === "channelAuth" ||
              active === "channelCollect" ||
              active === "channelGraph" ? (
              /* ★ 三个叶子共用一个组件，差别只是进来时停在哪一面 */
              <ChannelsSection
                channelId={activeChannelId}
                tab={
                  active === "channelCollect"
                    ? "collect"
                    : active === "channelGraph"
                      ? "graph"
                      : "auth"
                }
                onTabChange={(next) =>
                  setActive(
                    next === "collect"
                      ? "channelCollect"
                      : next === "graph"
                        ? "channelGraph"
                        : "channelAuth",
                  )
                }
              />
            ) : active === "persona" ? (
              <PersonaSection channelId={activeChannelId} />
            ) : active === "onboarding" ? (
              <OnboardingSection channelId={activeChannelId} />
            ) : (
              <AboutSection />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function Section({
  title,
  description,
  children,
  wide = false,
}: {
  title: string
  description?: string
  children: ReactNode
  /**
   * 这一栏是否要**铺满**内容区。
   *
   * ## ★ 为什么由每栏自己决定，而不是整页掐一个宽度
   *
   * 整页掐宽度（原来的 `mx-auto max-w-[560px]`）会把两类完全不同的内容
   * 按同一个尺子裁：
   *
   * · **文字/表单**（语言、主题、身份、引导说明）→ 该窄。一行 60-80 字
   *   是可读性的上限，铺满 672px 之后眼睛要横扫，读着累；
   * · **网格类**（形象定制的 20 个色点、10 个槽位标签、13 个胡子缩略图）
   *   → 该宽。掐到 560px 之后它们全部换行，而右边还空着 112px。
   *
   * 所以 `wide` 只给网格类开。缺省 false —— 新加的栏默认是"文字型"，
   * 那是更常见也更安全的一侧（窄了只是留白，宽了会伤可读性）。
   */
  wide?: boolean
}) {
  return (
    <section
      className={[
        "flex flex-col gap-[var(--gap-section-lg)]",
        // 文字型限宽；网格型铺满。限宽时**不居中**（不用 mx-auto）——
        // 居中会让左侧也缩进，与左导航之间出现一道无来由的空隙。
        wide ? "" : "max-w-[560px]",
      ].join(" ")}
    >
      <div className="flex flex-col gap-1">
        <h2 className="typography-title-small-500 text-[var(--text-base-primary)]">{title}</h2>
        {description === undefined ? null : (
          <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
            {description}
          </p>
        )}
      </div>
      {children}
    </section>
  )
}

/**
 * 身份 + 语言 + 主题 + 引导。
 *
 * 身份放最前：那是"这是谁"的问题，而后面几项都是"怎么显示"。
 * 语言与主题是「立即生效」的偏好，因此那几行没有保存按钮；
 * 身份是逐字输入的，所以它自己有一个（见 IdentityPanel 的文件头）。
 */
function GeneralSection() {
  const { t } = useDynamicTranslation("settings")
  const { t: tc } = useDynamicTranslation()
  const bootstrap = useBootstrapState()
  const setLanguage = useSetLanguage()
  const setQuitConfirmSuppressed = useSetQuitConfirmSuppressed()
  const theme = useTheme()

  const current: LanguagePreference = bootstrap.data?.language ?? "system"

  const session = bootstrap.data?.session ?? null
  /**
   * 开关的语义：**开=会问**，与主进程存储位（`suppressed`=不问）**取反**。
   *
   * 存储位选 suppressed 而非 confirmEnabled：读值失败时的默认要是"会问"
   * （见 preferences.service 的 fallback）—— boolean 的默认 false 恰好对应
   * "不 suppressed" = "会问"，语义对齐；UI 上再翻一层给用户看。
   */
  const confirmEnabled = !(bootstrap.data?.quitConfirmSuppressed ?? false)

  return (
    <Section title={t("general.title")} description={t("general.description")}>
      {/* 未登录时不渲染身份块：那时没有账号可编辑（设置页在登录前也可能打开） */}
      {session === null ? null : <IdentityPanel session={session} />}

      <div className="flex flex-col gap-[var(--gap-section-sm)]">
        <Row label={t("general.language")} description={t("general.languageDescription")}>
          <SegmentedControl
            value={current}
            disabled={setLanguage.isPending}
            options={[
              { value: "system", label: tc("theme.system") },
              ...LANGUAGES.map((code) => ({ value: code, label: languageNames[code] })),
            ]}
            onChange={(value) => setLanguage.mutate(value as LanguagePreference)}
          />
        </Row>

        <Row label={t("general.theme")}>
          <SegmentedControl
            value={theme.preference}
            options={[
              { value: "system", label: tc("theme.system") },
              { value: "light", label: tc("theme.light") },
              { value: "dark", label: tc("theme.dark") },
            ]}
            onChange={(value) => theme.setPreference(value as ThemePreference)}
          />
        </Row>

        {/*
          主题色。与明暗是两个独立维度（见 use-theme.ts）——
          所以是两行而不是一个八选一的控件。
        */}
        <Row label={t("general.accent")} description={t("general.accentDescription")}>
          <AccentPicker value={theme.accent} onChange={theme.setAccent} />
        </Row>

        {/*
          退出前确认。开关的显式语义是"是否弹提示"，与内部存储的 `suppressed`
          取反（见组件里那行注释）。放通用页最后：这是一次点了就懒得再改的
          偏好，不该抢在语言/主题之前。
        */}
        <Row label={t("general.quitConfirm")} description={t("general.quitConfirmDescription")}>
          <Switch
            ariaLabel={t("general.quitConfirmToggle")}
            checked={confirmEnabled}
            disabled={setQuitConfirmSuppressed.isPending}
            onChange={(next) => setQuitConfirmSuppressed.mutate(!next)}
          />
        </Row>
      </div>
    </Section>
  )
}

/**
 * 数字人：管控层运行参数 + 自动发送白名单。
 *
 * 独立一栏而不是塞在「通用」里：这些是**运行时**参数（同时起几个 agent、
 * 一批带几条消息），与"界面怎么显示"完全是两类东西。
 */
/**
 * 数字分身 —— 形象与名字共用，运行参数按渠道分（见 `PersonaRuntimePanel`）。
 * 渠道由弹窗级那一份给，不自己持 state。
 */
function PersonaSection({ channelId }: { channelId: string | null }) {
  const { t } = useDynamicTranslation("settings")
  const bootstrap = useBootstrapState()
  const session = bootstrap.data?.session ?? null
  /**
   * ★★ 数字分身设置**按渠道** —— 用户要求「设置里的数字分身要能选渠道」。
   *
   * 判据走 `canRunPersona`（读 `capabilities.sendAs`）：只读接入的渠道
   * （飞书）标成「暂未支持」但**仍可选中** —— 藏起来的话"飞书连上了为什么
   * 这里没有它"是个没有答案的问题，选中后由下面那句话说清原因。
   * 与 `persona-header-controls.tsx` 那份是同一个范本、同一个判据来源。
   */
  const channels = useChannels()
  const list = channels.data ?? []
  const authorized = list.filter((c) => c.available && c.status.state === "authorized")
  const personaCapableIds = personaCapableChannels(list).map((c) => c.id)
  /**
   * ★★ 渠道用**弹窗级**那一份（`channelId`），不再自己 `useState`。
   *
   * 上一版这里持一份、渠道区持另一份，于是在「授权」里切到飞书、
   * 点进「数字分身」又变回钉钉 —— 两份 state 各自默认、必然分叉。
   * 用户明确要求"设置整体有个全局的地方记住现在的渠道"。
   *
   * `?? personaCapableIds[0] ?? authorized[0]?.id` 仍留着作**回落**：
   * 弹窗那份在渠道列表还没读到时是 `null`。
   */
  const activeChannelId = channelId ?? personaCapableIds[0] ?? authorized[0]?.id ?? null
  const activeSupportsPersona =
    activeChannelId !== null && personaCapableIds.includes(activeChannelId)

  return (
    <Section title={t("sections.persona")} description={t("persona.description")} wide>
      {/* 未登录时不渲染：这些设置存在 vault 的 dh_settings 里 */}
      {session === null ? (
        <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
          {t("onboarding.needsLogin")}
        </p>
      ) : (
        <>
          {activeSupportsPersona ? (
            /*
              形象放在运行参数**之前**：它是"这是谁"的问题，
              而运行参数是"它怎么工作"。与本文件里 IdentityPanel
              排在语言/主题之前是同一个判断。
              同样要在登录分支里 —— 数据存 vault，未登录时读出来是空数组，
              而"空数组"与"没配过"在 UI 上无法区分。
            */
            <>
              {/*
                ★ 形象与名字**不**带渠道（用户明确说可以复用）：那是"这个分身
                是谁"，与它在哪个渠道工作无关。而运行参数带渠道 —— 那是
                "它在这个渠道怎么工作"（工作时间、频率、并发）。
              */}
              <PersonaFigurePanel />
              <PersonaRuntimePanel
                {...(activeChannelId === null ? {} : { channelId: activeChannelId })}
              />
            </>
          ) : (
            /*
              ★ 选中的是只读接入的渠道 —— 说清"为什么这里是空的"，
              而不是显示一份属于**另一个渠道**的形象与运行参数
              （那正是这批多渠道重构在消除的那类错配）。
            */
            <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
              {t("persona.channelUnsupported")}
            </p>
          )}
        </>
      )}
    </Section>
  )
}

/**
 * 引导流程：四步状态 + 重走 + 重置蒸馏水位。
 *
 * 独立一栏而不是塞在「通用」里：它回答的是"我配到哪一步了"，
 * 而通用那页回答的是"界面怎么显示" —— 混在一起让两者都不好找。
 */
/** 引导流程 —— 进度按渠道看（渠道由弹窗级那一份给）。 */
function OnboardingSection({ channelId }: { channelId: string | null }) {
  const { t } = useDynamicTranslation("settings")
  const bootstrap = useBootstrapState()
  const session = bootstrap.data?.session ?? null

  return (
    <Section title={t("sections.onboarding")} description={t("onboarding.description")}>
      {/* 未登录时不渲染：进度存在 vault 里，那时查了只会拿到空数组 */}
      {session === null ? (
        <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
          {t("onboarding.needsLogin")}
        </p>
      ) : (
        <OnboardingPanel channelId={channelId} />
      )}
    </Section>
  )
}

/**
 * 主题色选择器：一排色点。
 *
 * ## 为什么是色点而不是 SegmentedControl 的文字选项
 *
 * 颜色是**自解释**的 —— 看到那个色点就知道选了会变成什么样，
 * 而"琥珀/紫/蓝"这些名字还要先在脑子里translate一次。
 * 每个点仍带 `aria-label`（读屏器需要名字，颜色对它不可见）。
 *
 * 色点的底色直接引用该主题的 `-50` 实色**字面量**而不是
 * `var(--brand-brand-50)`：后者会让四个点全部显示成**当前**主题色
 * （变量在同一个 :root 下只有一个值）—— 那样选择器就完全没有意义了。
 */
function AccentPicker({
  value,
  onChange,
}: {
  value: AccentPreference
  onChange: (next: AccentPreference) => void
}) {
  const { t } = useDynamicTranslation("settings")
  /**
   * 色块与 primitives.css 的各套 `-50` 保持一致。
   *
   * `Record<AccentPreference, …>` 让"加了主题色但忘了配色块"变成编译错误 ——
   * 漏了的话那个按钮是**透明的**，看起来像渲染坏了。
   */
  const SWATCH: Record<AccentPreference, string> = {
    // ★ blue 是默认，它渲染的是 :root 那一套（品牌墨蓝 -50），不是 #0d86ff
    blue: "#4076f0",
    amber: "#c98a0b",
    violet: "#7c5cf0",
  }

  return (
    <div className="flex items-center gap-2">
      {ACCENTS.map((accent) => {
        const label = t(`general.accents.${accent}`)
        const selected = value === accent
        return (
          <button
            key={accent}
            type="button"
            aria-label={label}
            aria-pressed={selected}
            title={label}
            onClick={() => onChange(accent)}
            className={cn(
              "size-6 shrink-0 cursor-pointer rounded-full transition-transform duration-150",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--border-focus)]",
              // 选中用**外圈**而不是打勾：勾会盖住颜色本身，而颜色正是被选的东西
              selected
                ? "ring-2 ring-[var(--text-base-primary)] ring-offset-2 ring-offset-[var(--bg-base-normal)]"
                : "hover:scale-110",
            )}
            style={{ backgroundColor: SWATCH[accent] }}
          />
        )
      })}
    </div>
  )
}

function Row({
  label,
  description,
  children,
}: {
  label: string
  description?: string
  children: ReactNode
}) {
  return (
    <div className="flex items-start justify-between gap-6 py-1">
      <div className="flex min-w-0 flex-col gap-0.5">
        <span className="typography-body-small-400 text-[var(--text-base-primary)]">{label}</span>
        {description === undefined ? null : (
          <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {description}
          </span>
        )}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
  )
}

/** 分段控件：选项少且互斥时比下拉更直观（一眼看到全部选项，一次点击完成）。 */
function SegmentedControl({
  value,
  options,
  onChange,
  disabled = false,
}: {
  value: string
  options: readonly { value: string; label: string }[]
  onChange: (value: string) => void
  disabled?: boolean
}) {
  return (
    <div className="inline-flex gap-0.5 radius-md bg-[var(--bg-card-z0)] p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          disabled={disabled}
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={cn(
            "typography-caption-400 cursor-pointer radius-sm px-2.5 py-1 transition-colors duration-200 ease-out",
            "disabled:cursor-not-allowed disabled:opacity-60",
            value === option.value
              ? "bg-[var(--bg-card-z1)] text-[var(--text-base-primary)] shadow-sm"
              : "text-[var(--text-base-secondary)] hover:text-[var(--text-base-primary)]",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

/**
 * 模型网关配置（用户可见）。
 *
 * 与隐藏的「高级 AI」面板共享底层真源（baseUrl/apiKey）——
 * 这里给普通用户改主网关 + 主模型 + embedding + KL 专用三项；
 * 高级面板留给极客改 harness / 角色映射 / 逃生阀。
 *
 * ★ 标题与说明由 `Section` 给，表单自己不带分区标题
 * （见 model-config-form.tsx 文件头）—— 否则同一件事说三遍。
 */
/**
 * 模型网关。
 *
 * ## ★★ 它在导航上归「当前渠道」组，但**存储是应用级**的
 *
 * 用户要求"除了通用和关于都要区分渠道"，所以它在侧栏里进了那一组、
 * 顶部也显示当前渠道。但这一页配的东西是 `llmBaseUrl` / `llmApiKey` /
 * `modelMain` / `embedModel` + KL 三项 —— 它们描述的是**用哪个 LLM 网关**，
 * 与"哪个 IM 渠道"没有关系：同一个网关同时给两个渠道的蒸馏与建图用
 * （实测：`RuntimeConfigService` 读的是控制库的 `SettingsRepository`，
 * 应用级单份）。
 *
 * 硬把存储也拆成按渠道会带来两个真问题：换渠道后模型突然显示"未配置"、
 * 以及同一个 key 要填两遍。所以这里**如实说明**这一点（页面上一行提示），
 * 而不是假装它分渠道 —— 那才是 §4 说的"报告事实"。
 */
function ModelSection({ channelId }: { channelId: string | null }) {
  const { t } = useDynamicTranslation("settings")
  return (
    <Section title={t("sections.model")} description={t("model.description")}>
      {/*
        ★★ 如实说明：这一页的配置是**应用级**的，不随上面那个渠道变。

        用户要求"除了通用和关于都要区分渠道"，导航上照做了（它在「当前渠道」
        那一组、顶部也显示渠道）。但配的东西是 LLM 网关的 base/key/模型名
        —— 与"哪个 IM 渠道"无关，同一个网关同时给两个渠道的蒸馏与建图用
        （`RuntimeConfigService` 读控制库的 `SettingsRepository`，应用级单份）。

        假装它分渠道的代价是真的：换渠道后模型突然显示"未配置"、同一个 key
        要填两遍。所以这里把事实写出来，而不是让用户自己发现（§4）。
      */}
      {channelId === null ? null : (
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("model.appWideNote")}
        </p>
      )}
      <ModelConfigForm />
      <WorkLayerRow />
    </Section>
  )
}

/**
 * 工作层抽取开关。
 *
 * ## 为什么放在「模型」这一栏
 *
 * 它是唯一一个**打开就开始花模型调用**的偏好，而这一栏是用户理解"钱花在
 * 哪"的地方（上面就是网关与模型名）。放在「通用」里会让一个有成本的开关
 * 混在语言/主题这类零成本偏好中间。
 *
 * ## 为什么成本提示是常显的，不是 tooltip
 *
 * 蒸馏在后台跑（6 小时一轮），开着之后**界面上不会再提醒**任何一次调用。
 * 也就是说这段文字是用户唯一一次看到成本的机会 —— 藏进 hover 等于没写。
 */
function WorkLayerRow() {
  const { t } = useDynamicTranslation("settings")
  const bootstrap = useBootstrapState()
  const setWorkLayer = useSetWorkLayerEnabled()
  /**
   * ★ 默认 false。读不出来（还没登录 / bootstrap 在飞）时显示"关"——
   * 与主进程 `workLayerEnabled()` 的回落一致（见那里的注释：一个读值失败
   * 就自动开始花钱的开关是不可接受的）。两处默认必须同向，否则 UI 会显示
   * "开"而后台其实没跑。
   */
  const enabled = bootstrap.data?.workLayerEnabled ?? false

  return (
    <div className="flex flex-col gap-[var(--gap-section-sm)]">
      <Row label={t("model.workLayer.title")} description={t("model.workLayer.description")}>
        <Switch
          ariaLabel={t("model.workLayer.toggle")}
          checked={enabled}
          disabled={setWorkLayer.isPending}
          onChange={(next) => setWorkLayer.mutate(next)}
        />
      </Row>
      <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
        {t("model.workLayer.cost")}
      </p>
      {enabled ? (
        <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {t("model.workLayer.note")}
        </p>
      ) : null}
    </div>
  )
}

/** 渠道设置里的二级 tab —— 用户要求「渠道」下分「授权 / 采集 / 图谱服务」。 */
type ChannelTab = "auth" | "collect" | "graph"

function ChannelsSection({
  /** 当前渠道 —— 由弹窗级那一份传入（见上面那段说明）。 */
  channelId,
  tab,
  onTabChange: _onTabChange,
}: {
  /** 当前渠道（弹窗级那一份）。`null` = 还没读到渠道列表。 */
  channelId: string | null
  /**
   * 当前看渠道的哪一面 —— **由侧栏决定**（受控）。
   *
   * ★ 用户明确不要页内 tab：层级只在侧栏表达一次。所以这里不再自己持
   * `useState`，而是把"我在哪"交给唯一的导航（`SettingsView` 的 `active`）。
   * 两处各存一份的话，侧栏与页内必然出现"说的不是同一件事"。
   */
  tab: ChannelTab
  /** 预留：页内若将来需要跳到另一面（目前不用，层级切换走侧栏）。 */
  onTabChange?: (next: ChannelTab) => void
}) {
  const { t } = useDynamicTranslation("settings")
  const { t: tc } = useDynamicTranslation()
  const errorText = useErrorText()
  const channels = useChannels()
  const list = channels.data ?? []
  /**
   * ★★ 渠道由**弹窗级**的那一份决定（`SettingsView` 的 `activeChannelId`），
   * 这里**不再自己持 state**。
   *
   * 上一版每个分区各持一份，于是在「授权」里切到飞书、点进「数字分身」
   * 又变回钉钉 —— 用户以为自己切过了，看到的却是另一个渠道的设置。
   * 用户明确要求"设置整体有个全局的地方记住现在的渠道"。
   *
   * 渠道选择器也搬到了弹窗的内容区顶栏（见 `SettingsView` 里那段），
   * 所以这一节里不再画一个 —— 同一个控件出现两次就有两份"我在哪"。
   */
  const selectable = list.filter((channel) => channel.available)
  const activeChannel = selectable.find((c) => c.id === channelId) ?? selectable[0]
  const authorized = activeChannel?.status.state === "authorized"

  return (
    <Section title={t("channels.title")} description={t("channels.description")} wide>
      {channels.isLoading ? (
        <p className="typography-body-base-400 text-[var(--text-base-tertiary)]">
          {t("channels.loading")}
        </p>
      ) : channels.error !== null ? (
        <div className="flex flex-col items-start gap-3">
          <p className="typography-body-base-400 text-[var(--status-error)]">
            {errorText(channels.error)}
          </p>
          <Button size="sm" variant="secondary" onClick={() => void channels.refetch()}>
            {tc("app.retry")}
          </Button>
        </div>
      ) : activeChannel === undefined ? (
        <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
          {t("channels.none")}
        </p>
      ) : (
        <div className="flex flex-col gap-4">
          {tab === "auth" ? (
            <>
              {/*
                ★ key 带 channel.id：切渠道时**重挂**授权面板，
                否则它内部的进度/设备码 state 会留在上一个渠道那一轮。
              */}
              <ChannelAuthPanel key={activeChannel.id} channel={activeChannel} variant="settings" />
              {/*
                ★★ 身份切换器**暂时下架**（`IdentitySwitcher` 保留，只是不挂）。

                它的语义在多渠道并存之后已经不对了：从 control v5 起一个 vault
                可以同时挂飞书与钉钉两个渠道的身份，而这一块把它们列成两个
                **可互相切换**的独立身份，还说「每个身份有自己独立的一份数据」
                —— 那是并存之前的模型。现在两者共用同一个 vault，"切换"到另一个
                渠道并不会换库，文案与行为直接矛盾。

                真正要做的是把它重写成「按**组织/人**切换」（同一渠道下的多个
                corpId 才是真的换库），而不是把渠道列进来 —— 那是独立一件事。
              */}
            </>
          ) : !authorized ? (
            /*
              ★ 没授权时后两个 tab 没有可配的东西 —— 说清出路（去「授权」那一栏），
              而不是显示一堆空面板让用户以为坏了。
            */
            <p className="typography-body-small-400 text-[var(--text-base-secondary)]">
              {t("channels.needsAuthFirst")}
            </p>
          ) : tab === "collect" ? (
            <>
              {/* ① 采什么 —— 按渠道 */}
              <CollectionScopePanel channelId={activeChannel.id} />
              {/* ② 多久采一次 —— **全局**，见本组件文件头那段 */}
              <IngestIntervalsPanel />
              <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
                {t("channelData.intervalsGlobalNote")}
              </p>
            </>
          ) : (
            /* ③ 图谱服务 —— 每渠道一张卡，channelId 只用来高亮（不可逆动作） */
            <KlPanel channelId={activeChannel.id} />
          )}
        </div>
      )}
    </Section>
  )
}

function AboutSection() {
  const { t } = useDynamicTranslation("settings")
  const status = useStatusReport(true)
  const report = status.data
  /**
   * 隐藏入口：版本号连点 5 次。
   *
   * 需求原文是「隐藏的地方可以极客配置自己的 ai」——
   * 所以刻意不进主导航。连点计数不做超时重置：
   * 这是个彩蛋式入口，「点了 5 次但太慢所以不算」只会让人以为坏了。
   */
  const [taps, setTaps] = useState(0)
  const unlocked = taps >= 5

  return (
    <Section title={t("about.title")}>
      <dl className="grid grid-cols-1 gap-x-8 gap-y-3 sm:grid-cols-2">
        <button
          type="button"
          onClick={() => setTaps((count) => count + 1)}
          className="cursor-default text-left"
          aria-label={t("about.appVersion")}
          data-testid="version-tap"
        >
          <Item label={t("about.appVersion")} value={report?.appVersion ?? "…"} />
        </button>
        <Item label={t("about.electronVersion")} value={report?.electronVersion ?? "…"} />
        <Item label="Node" value={report?.nodeVersion ?? "…"} />
        <Item label={t("about.platform")} value={report?.platform ?? "…"} />
      </dl>

      {/*
        ★ 这里原来有两段说明文字，都按要求去掉了：

        ① 「完整的运行状态…见侧边栏的『运行状态』」——
           侧栏那一项一直都在，指路的话不必写在这里。

        ② 形象素材的 CC BY 署名（micah / fun-emoji）。

        ★★ ②**是一项许可义务**，不只是致谢。`@dicebear/micah` 与
        `@dicebear/fun-emoji` 的设计是 CC BY 4.0（代码是 MIT，两栏不同），
        而 CC BY 要求署名。署名文本仍然留在 `packages/design/LICENSES.md`
        里，但那个文件只存在于**仓库**中 —— 用户装到的是打包产物，读不到它。

        也就是说：只要这两个风格还在用（`persona-figure.tsx` 里仍然
        import 着），产品里就缺一处署名。要合规又不想占版面，
        通常的做法是收进一个「开源许可」的折叠区/子页，而不是删掉。
        这一点我提出来过，删除是明确要求的结果。
      */}

      {unlocked && (
        <div className="mt-6 border-t border-[var(--border-divider-light)] pt-6">
          <h3 className="typography-title-small-500 mb-4 text-[var(--text-base-primary)]">
            {t("advancedAi.title")}
          </h3>
          <AdvancedAiPanel />
        </div>
      )}
    </Section>
  )
}

function Item({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="typography-caption-400 text-[var(--text-base-tertiary)]">{label}</dt>
      <dd className="typography-body-small-400 break-all text-[var(--text-base-primary)]">
        {value}
      </dd>
    </div>
  )
}
