/**
 * StatusPanel — 运行状态面板。
 *
 * ## ★ 两层：每次都看的摊开，排查才看的折叠
 *
 * 这一页原来平铺**六个**同级分区，全部同一档标题、全部展开。而它们被
 * 查看的频率差一个数量级：
 *
 * · **数据面**（采到了多少 / 卡在哪）—— 这一页存在的理由，每次都看；
 * · **知识图谱** —— 偶尔来点一次建图，要看服务是否就绪；
 * · 运行环境 / 数据目录 / 数据库 / 配置注入 —— **排查时**才看，
 *   四块加起来 16 个键值对 + 一张四列表格。
 *
 * 也就是说：为了看第一块，每次都要滚过后面四块；而六个同样粗的标题
 * 让人无法判断该看哪个。现在后四块收进 `Disclosure`（原生 `<details>`：
 * 键盘可达，Cmd+F 命中时浏览器会自动展开 —— 排查场景恰好靠搜索找键名），
 * 并各给一个收起时可见的 `summary`，"为看一个数字去展开"这件事不成立。
 *
 * ★ 数据面与 kl **不折叠**。反证过：六块全折叠之后打开这一页看到的是
 * 六个收起的标题行，而"采集在正常干活吗"要点一下才知道 ——
 * 那比原来更糟，原来至少第一屏就是它。
 */
import { useState } from "react"
import { Button, Disclosure } from "@mycontext/design"
import type { ConfigEntryView, KlServerStatus } from "@mycontext/ipc-contract"
import {
  useStatusReport,
  useKlServerStatus,
  useKlServerStart,
  useKlServerStop,
  useKlGraphBuild,
} from "../../lib/queries.js"
import { CollectionScopePanel } from "./collection-scope-panel.js"
import { DataPlanePanel } from "./data-plane-panel.js"
import { IngestIntervalsPanel } from "../settings/ingest-intervals-panel.js"
import { useErrorText } from "../../lib/use-error-text.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

/** 配置来源的 i18n key。三种来源都要有，缺一个界面上就是原样的 key。 */
const SOURCE_LABEL_KEY: Record<ConfigEntryView["source"], string> = {
  default: "status.config.sources.default",
  dotenv: "status.config.sources.dotenv",
  env: "status.config.sources.env",
}

const SOURCE_STYLE: Record<ConfigEntryView["source"], string> = {
  default: "bg-[var(--bg-card-z0)] text-[var(--text-base-tertiary)]",
  dotenv: "bg-[var(--status-fill-info-container)] text-[var(--status-link)]",
  env: "bg-[var(--status-fill-success-container)] text-[var(--status-success)]",
}

export function StatusPanel() {
  const { t } = useDynamicTranslation("settings")
  const { t: tc } = useDynamicTranslation()
  const errorText = useErrorText()
  /**
   * 这一页在看哪个渠道。`null` = 还没选过 → 由 `DataPlanePanel` 落到第一个。
   *
   * ★ 提到这一层而不是各块自己持有：数据面的数字与下面的建图按钮必须
   * 说同一个渠道 —— 见 `KlPanel` 那里的注释。
   */
  const [statusChannel, setStatusChannel] = useState<string | null>(null)

  const status = useStatusReport(true)

  if (status.isLoading) {
    return (
      <p className="typography-body-base-400 text-[var(--text-base-tertiary)]">
        {tc("app.loading")}
      </p>
    )
  }
  if (status.error !== null) {
    return (
      <div className="flex flex-col items-start gap-3">
        <p className="typography-body-base-400 text-[var(--status-error)]">
          {errorText(status.error)}
        </p>
        <Button size="sm" variant="secondary" onClick={() => void status.refetch()}>
          {tc("app.retry")}
        </Button>
      </div>
    )
  }
  const report = status.data
  if (report === undefined) return null

  return (
    <div className="flex flex-col gap-[var(--gap-section-xl)]">
      {/*
        ★ 数据面与 kl 摊开，后面四块折叠 —— 见文件头。
        数据面放最上面：这是本阶段最常被查看的一屏（"采到了多少 / 卡在哪"）。
      */}
      <DataPlanePanel
        enabled
        channelId={statusChannel}
        onChannelChange={setStatusChannel}
      />

      {/*
        采集频率：紧跟数据面 —— 用户看到"探针周期 10s"这个数字之后，
        下一步想做的就是改它。放到别的分区里等于让人去找。
      */}
      {/*
        ★★ 采集范围 —— 改动前这个入口**只在引导流程里**，而飞书压根没走过
        引导，于是它的范围从来没被设置过 → `readCollectionScope` 判"不设限"
        → **按全量采**（实测飞书库的 distill_sources 是 0 行）。
        那是隐私问题，不是"少个入口"。

        放在采集周期**之前**：先回答"采什么"，再回答"多久采一次"。
      */}
      <CollectionScopePanel channelId={statusChannel} />

      <IngestIntervalsPanel />

      {/*
        ★ 与数据面**共用同一个渠道选择** —— 这一页只有一个取值范围。
        两块各自一个选择器的话，用户会在"数据面选了飞书、建图按钮却在
        钉钉上"这种状态里点下去，而那一下是不可逆的（fresh 会删图）。
      */}
      <KlPanel channelId={statusChannel} />

      {/*
        ── 以下是**排查用**的四块 ────────────────────────────

        16 个键值对 + 一张四列表格。它们回答的是"我改的 .env 生效了吗"、
        "库在哪"这类问题 —— 而那些问题一年问不了几次，却每次都占掉
        这一页 80% 的高度。

        收起时各给一个 `summary`：版本号、迁移版本、配置条数 ——
        那几个恰好是"扫一眼就够"的信息，不需要为它们展开。
      */}
      <div className="flex flex-col gap-[var(--gap-component-md)]">
        <Disclosure
          title={t("status.sections.runtime")}
          // 版本号是这一块里唯一会被单独问起的值，收起时就给出来
          summary={`v${report.appVersion} · Electron ${report.electronVersion}`}
        >
          <Grid>
            <Item label={t("status.runtime.appVersion")} value={report.appVersion} />
            <Item label={t("status.runtime.electronVersion")} value={report.electronVersion} />
            <Item label={t("status.runtime.nodeVersion")} value={report.nodeVersion} />
            <Item label={t("status.runtime.platform")} value={report.platform} />
            <Item
              label={t("status.runtime.packaged")}
              value={t(
                report.packaged ? "status.runtime.packagedYes" : "status.runtime.packagedNo",
              )}
            />
            <Item
              label={t("status.runtime.dotenvLoaded")}
              // 读到了就直接显示路径：只显示「是」的话，改了 .env 没生效时
              // 分不清是没找到文件还是找到了别的那一个。
              value={report.dotenvPath ?? t("status.runtime.no")}
              mono={report.dotenvPath !== null}
            />
          </Grid>
        </Disclosure>

        <Disclosure title={t("status.sections.paths")}>
          <Grid single>
            <Item label={t("status.paths.userData")} value={report.paths.userData} mono />
            <Item label={t("status.paths.database")} value={report.paths.database} mono />
            <Item label={t("status.paths.vaults")} value={report.paths.vaults} mono />
            <Item label={t("status.paths.logs")} value={report.paths.logs} mono />
          </Grid>
        </Disclosure>

        <Disclosure
          title={t("status.sections.database", { version: report.database.appliedVersion })}
          summary={t("status.database.accountSummary", { accounts: report.database.accountCount })}
        >
          <Grid>
            <Item
              label={t("status.database.accountCount")}
              value={String(report.database.accountCount)}
            />
            <Item
              label={t("status.database.migrations")}
              value={report.database.migrations
                .map((migration) => `v${migration.version} ${migration.name}`)
                .join(", ")}
            />
          </Grid>
        </Disclosure>

        <Disclosure
          title={t("status.sections.config")}
          // 条数 + 有多少项被 .env/env 覆盖过 —— 那正是来这一块要查的事
          summary={t("status.config.summary", {
            total: report.config.length,
            overridden: report.config.filter((entry) => entry.source !== "default").length,
          })}
        >
          <div className="flex flex-col gap-[var(--gap-component-sm)]">
            <div className="overflow-hidden radius-lg border border-[var(--border-light)]">
              <table className="w-full border-collapse text-left">
                <thead>
                  <tr className="bg-[var(--bg-card-z0)]">
                    <Th>{t("status.config.key")}</Th>
                    <Th>{t("status.config.envName")}</Th>
                    <Th>{t("status.config.value")}</Th>
                    <Th>{t("status.config.source")}</Th>
                  </tr>
                </thead>
                <tbody>
                  {report.config.map((entry) => (
                    <tr key={entry.key} className="border-t border-[var(--border-divider-light)]">
                      <Td>{entry.key}</Td>
                      <Td mono>{entry.envName}</Td>
                      <Td mono>
                        {entry.sensitive ? (
                          <span
                            className={
                              entry.configured
                                ? "text-[var(--status-success)]"
                                : "text-[var(--text-base-tertiary)]"
                            }
                          >
                            {t(
                              entry.configured
                                ? "status.config.configured"
                                : "status.config.notConfigured",
                            )}
                          </span>
                        ) : entry.value === "" ? (
                          <span className="text-[var(--text-base-tertiary)]">
                            {t("status.config.empty")}
                          </span>
                        ) : (
                          entry.value
                        )}
                      </Td>
                      <Td>
                        <span
                          className={`typography-caption-400 inline-flex items-center radius-sm px-2 py-0.5 ${SOURCE_STYLE[entry.source]}`}
                        >
                          {t(SOURCE_LABEL_KEY[entry.source])}
                        </span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
              {t("status.config.note")}
            </p>
          </div>
        </Disclosure>
      </div>
    </div>
  )
}

/** 状态色徽章：ready 绿 / starting 蓝 / failed 红 / stopped 灰。 */
const KL_STATE_STYLE: Record<KlServerStatus["state"], string> = {
  ready: "bg-[var(--status-fill-success-container)] text-[var(--status-success)]",
  starting: "bg-[var(--status-fill-info-container)] text-[var(--status-link)]",
  failed: "bg-[var(--status-fill-error-container)] text-[var(--status-error)]",
  stopped: "bg-[var(--bg-card-z0)] text-[var(--text-base-tertiary)]",
}

/**
 * 建图进度：显示一个百分比。
 *
 * ## ★ 换算：kl 的 percent 是 **0–1 小数**
 *
 * `_set_progress("done", "", 1.0, ...)` —— 当成 0–100 直接显示的话整轮建图
 * 全程都是「0%」「1%」，看起来像卡死，而且不会有任何东西报错。所以必须 ×100。
 *
 * ## ★ 这个数字只有一部分是真的（知情地接受）
 *
 * 上游只有 Phase A 有真实回调；Phase B 的 LLM 抽取期间 percent **恒为 0.4**
 * （实测 20s 采样三次一动不动）。也就是它会在 40% 停很久 —— 那不是卡死。
 * 完整分析在 `klServerStatusSchema.buildProgress` 的注释里。
 *
 * 之所以仍然显示：反证过"什么都不显示"——那时建图期间界面上只有三个灰掉的
 * 按钮，没有任何东西说明"它在跑"，比一个会停顿的百分比更难懂（实测截图）。
 *
 * 另一处坑：`startedAt` 可能缺（新渲染层 + 旧主进程，热更时就是这样），
 * 所以这里**只用 percent**，不做任何时间减法 —— 那正是「已运行 NaN 分钟」
 * 的来源。
 */
export function klBuildPercent(progress: KlServerStatus["buildProgress"]): number | null {
  if (progress === null) return null
  // 0–1 小数 → 整数百分比。夹到 [0,100]：上游给脏值时不显示 -3% / 140%。
  const raw = Math.round(progress.percent * 100)
  if (!Number.isFinite(raw)) return 0
  return Math.min(100, Math.max(0, raw))
}

/**
 * 服务徽章该显示哪个状态 —— **只看服务自己的状态机**，与建图无关。
 *
 * ## ★ 为什么这值得一个函数 + 一条测试
 *
 * 原来是 `busy ? "建图占用中" : <服务状态>`，理由是"建图期间服务确实停着"。
 * 那对**旧实现**成立（建图先 stop server 再另起 ingest 进程）。上游改成
 * in-server `/ingest` 之后前提就没了：增量建图由 server 自己干，服务全程
 * `ready`、检索照常可用。
 *
 * 实测代价：`/health` ok、`/status` 是 `ready`、图里 29230 条消息，而 UI 说
 * 「建图占用中」—— **把一个能用的服务显示成不可用**，且一轮增量建图要跑
 * 几十分钟。这条锁住"别再把建图塞回服务徽章"。
 */
export function klServiceStateKey(state: KlServerStatus["state"]): string {
  return state === "ready"
    ? "status.kl.stateReady"
    : state === "starting"
      ? "status.kl.stateStarting"
      : state === "failed"
        ? "status.kl.stateFailed"
        : "status.kl.stateStopped"
}

/**
 * 知识图谱（kl）状态卡。
 *
 * ★ 服务与建图是**两个维度**，分两块显示，别混：
 * · 「图谱服务」= 子进程状态（stopped/starting/ready/failed），由状态机推。
 * · 「图谱数据」= 建图（in-server `POST /ingest`）。
 *
 * ## ★ 增量建图**不再**停服务（这段注释以前是错的）
 *
 * 原来这里写的是"建图要独占数据文件，会先把服务停掉再跑，所以建图期间服务
 * 状态就是 stopped"。那描述的是**旧实现**（另起一个 `python -m scripts.ingest`
 * 进程）。上游提供 in-server `/ingest` 之后，干活的就是 server 自己、复用同一个
 * Qdrant writer —— `rebuildGraph` 里现在只有 `fresh=true`（重建）才 stop。
 * 而自动建图与「建图」按钮走的都是 `fresh=false`。
 *
 * 实测代价：服务 `/health` ok、`/status` 是 `ready`、图里有 29230 条消息，
 * UI 却把服务徽章显示成「建图占用中」——**能用的东西被说成不可用**，
 * 而一轮增量建图要跑几十分钟。所以服务徽章只反映服务状态，
 * 建图忙不忙走它自己那一块（带 phase/percent，后端本来就在推）。
 */
function KlPanel({ channelId }: { channelId: string | null }) {
  const { t } = useDynamicTranslation("settings")
  const status = useKlServerStatus()
  const start = useKlServerStart()
  const stop = useKlServerStop()
  const build = useKlGraphBuild()

  /**
   * ★★ 服务状态按**选中的渠道**取 —— 顶层那个 `state` 是主渠道的。
   *
   * 不按渠道取的后果（实测）：选了飞书、而飞书的 kl 是 failed，界面上那个
   * 徽章却显示「就绪」（钉钉的），按钮也是「停止」而不是「重试」——
   * 于是**失败的那个渠道没有任何重试入口**（`failed` 之后不自动重起，
   * 那是刻意的，所以必须有入口）。
   */
  const row = (status?.perChannel ?? []).find((item) => item.channelId === channelId)
  const state = row?.state ?? status?.state ?? "stopped"
  /**
   * 数据动作是否在跑 —— 只用来**互斥禁用那三个按钮**（别同时建两次）。
   *
   * ★ 不再参与服务徽章：见文件内上面那段注释。
   */
  const busy = build.isPending || status?.building === true
  const percent = klBuildPercent(status?.buildProgress ?? null)
  const buildResult = build.data

  /**
   * 服务状态文案 —— **只看服务自己的状态机**（见 `klServiceStateKey`）。
   *
   * 建图期间服务照常提供检索（in-server ingest），所以这里不能被 `busy` 覆盖成
   * 「建图占用中」：那会把一个可用的服务显示成不可用。
   */
  const stateLabel = t(klServiceStateKey(state))
  /** 失败原因也按渠道取（顶层那个只是主渠道的）。 */
  const reason = row?.reason ?? status?.reason ?? null
  const badgeStyle = KL_STATE_STYLE[state]

  return (
    <Section title={t("status.sections.kl")}>
      <div className="flex flex-col gap-4 radius-lg border border-[var(--border-light)] p-4">
        {/* —— 图谱服务 —— */}
        <div className="flex flex-col gap-2">
          {/*
            ★ 分区内小标题用 `body-small-400 font-medium`（13px）而不是
            `caption-400`（12px）。原来是 caption —— 而它统辖的正文也是
            13px，也就是**标题比正文小**，层次是倒的。
            比正文重一档（font-medium）而不是更大：这是块内分节，
            用更大的字号会与上面那个 `title-small-500` 打架。
          */}
          <h3 className="typography-body-small-400 font-medium text-[var(--text-base-secondary)]">
            {t("status.kl.serverTitle")}
          </h3>
          <div className="flex items-center gap-3">
            <span
              className={`typography-caption-400 inline-flex items-center radius-sm px-2 py-0.5 ${badgeStyle}`}
            >
              {stateLabel}
            </span>
            {(row?.port ?? status?.port) !== null && (row?.port ?? status?.port) !== undefined && (
              <span className="typography-caption-400 font-mono-token text-[var(--text-base-tertiary)]">
                {t("status.kl.port")} {row?.port ?? status?.port}
              </span>
            )}
            {status?.networkEgress === true && (
              <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
                {t("status.kl.egress")}：{t("status.kl.egressYes")}
              </span>
            )}
          </div>

          {state === "failed" && reason !== null && (
            <p className="typography-body-small-400 text-[var(--status-error)]">{reason}</p>
          )}

          {/*
            ★★ 逐渠道摊开 —— 顶层那个徽章会**隐藏单渠道的失败**。

            顶层 `state` 取的是主渠道。于是另一个渠道的 kl 彻底 failed 时，
            这里仍然显示「运行中」——那一路整个坏掉而界面说一切正常，
            只能靠翻日志发现。而那正是本仓库最贵的那类 bug 的形状。

            ★ 只在**真有多个渠道**时渲染：单渠道时这一行与上面的徽章说的是
            同一件事，多显示一遍只是噪音。
          */}
          {(status?.perChannel ?? []).length > 1 && (
            <div className="flex flex-col gap-1">
              {(status?.perChannel ?? []).map((row) => (
                <div key={row.channelId} className="flex items-center gap-2">
                  <span className="typography-caption-400 min-w-16 text-[var(--text-base-tertiary)]">
                    {t(`status.kl.channel.${row.channelId}`, { defaultValue: row.channelId })}
                  </span>
                  <span
                    className={`typography-caption-400 inline-flex items-center radius-sm px-2 py-0.5 ${
                      /**
                       * ★ `idle`（还没采到消息 → 我们刻意没起它）用**中性**样式，
                       * 不是错误色。合成一个的话一次正常的降级看起来像故障，
                       * 而用户会去点「重试」—— 那什么也修不了。
                       */
                      row.idle ? KL_STATE_STYLE.stopped : KL_STATE_STYLE[row.state]
                    }`}
                  >
                    {row.idle ? t("status.kl.channelIdle") : t(klServiceStateKey(row.state))}
                  </span>
                  {row.port !== null && (
                    <span className="typography-caption-400 font-mono-token text-[var(--text-base-tertiary)]">
                      {row.port}
                    </span>
                  )}
                  {/* ★ 失败原因逐渠道给 —— 顶层那个 reason 只是主渠道的 */}
                  {row.state === "failed" && row.reason !== null && (
                    <span className="typography-caption-400 text-[var(--status-error)]">
                      {row.reason}
                    </span>
                  )}
                </div>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            {/*
              ★ 建图期间**照常**给服务操作 —— 服务没停（in-server ingest），
              停它是用户合法的选择（比如想中断这一轮）。原来这里 `busy ? null`
              把按钮整个藏掉，理由是"服务由数据流程收尾拉起"；那对旧实现成立
              （建图确实先 stop），现在只会让用户在几十分钟里没有任何可操作项。
            */}
            {/* ★ 三个按钮都带渠道 —— 见上面 `row` 的注释 */}
            {state === "ready" ? (
              <Button size="sm" variant="secondary" onClick={() => stop.mutate(channelId ?? undefined)}>
                {t("status.kl.stop")}
              </Button>
            ) : state === "failed" ? (
              <Button size="sm" variant="secondary" onClick={() => start.mutate(channelId ?? undefined)}>
                {t("status.kl.retry")}
              </Button>
            ) : (
              <Button size="sm" variant="secondary" onClick={() => start.mutate(channelId ?? undefined)}>
                {t("status.kl.start")}
              </Button>
            )}
          </div>
        </div>

        <div className="border-t border-[var(--border-divider-light)]" />

        {/* —— 图谱数据（建图 / 优化 / 重建）—— */}
        <div className="flex flex-col gap-2">
          <h3 className="typography-body-small-400 font-medium text-[var(--text-base-secondary)]">
            {t("status.kl.dataTitle")}
          </h3>
          {/*
            ★ 三个按钮各自的说明挂在**它描述的那个控件**上，不再排成三行灰字。

            ## 为什么原来那样是错的

            原来 `buildHint` 与 `optimizeHint` 是两个常驻的 `<p>`（加起来
            60 多字），而 `rebuildHint` **在 i18n 里存在却从未被渲染** ——
            也就是说三个动作里唯一**不可逆**的那个，反而是唯一没有说明的。

            这三句解释的都是"这个按钮会做什么"，属于**参考信息**：读一次
            就够，却每次打开状态页都占掉两行。与会话表头那次同一个判断
            （`reply-mode-controls.tsx` 的 autoWarn）—— 解释控件语义的话
            挂 `title`，描述当前状态的话留在版面上。

            ★ 重建那句**除了** title 还留在版面上：`window.confirm` 是在
            点下去**之后**才出现的，而用户需要在点之前就知道它与旁边那个
            「建图」差在哪（一个增量、一个清空重抽）。不可逆的动作，
            代价要写在按钮旁边。
          */}
          <div className="flex flex-wrap items-center gap-2">
            {/* 建图：增量（抽过的不重抽，第二次起很快）。 */}
            <Button
              size="sm"
              disabled={busy}
              title={t("status.kl.buildHint")}
              // ★ 带上渠道：不带的话在飞书那栏点「建图」会把钉钉的也建一遍
              onClick={() => build.mutate({ fresh: false, ...(channelId === null ? {} : { channelId }) })}
            >
              {/*
                ★ 文案跟 `disabled` 用**同一个** `busy`，不是 `build.isPending`。

                `isPending` 只在"这次 UI 会话里点过按钮"时为 true。而建图也可能是
                自动触发的、或在上一次应用启动时就开始跑的 —— 那时
                `status.building` 是 true、`isPending` 是 false，于是按钮灰掉却
                仍写着「建图」：两个按钮都点不动，界面上没有一句话说明为什么。
                实测撞到过（重启后 `/status` 是 `ingest.state=running`
                phase_a 0.2%，UI 一片死寂）。禁用的理由要写在按钮上。
              */}
              {busy ? t("status.kl.building") : t("status.kl.build")}
            </Button>
            {/*
              ★ 这里**曾经**有第三个按钮「优化图谱」,已删。

              它跑 `python -m scripts.improve`(补 SIMILAR_TO 边 + 消歧 + 社群)。
              而读 `kl-graph/kl_server.py` 发现:`/ingest` 的
              `run_improve` **默认就是 True**,建图内部已经跑完同一件事
              (就是进度里那个 `improve / communities + pagerank` 阶段)。

              也就是说这个按钮是**重复的** —— 更糟的是它为了独占数据文件会先
              `stop()` 掉 server,而那正是实测到的 `[Errno 32] Broken pipe` 与
              `Qdrant already accessed` 两次故障的来源。

              「优化」本来就是建图的一个内部阶段,不是用户需要理解的概念。
              服务端 `optimizeGraph()` 与它的 IPC 通道保留(诊断/将来可能要
              单独重跑),但**不在界面上暴露**。
            */}
            {/*
              重建：清空重抽。**不弹二次确认** —— 这是设置页里一个明确标着
              「重建」、旁边就写着代价的按钮，点它的人正是想要这个结果。
              而 `window.confirm` 是系统模态框（跳出应用视觉、不可样式化），
              为一个可预期的操作打断一次交互，收益不抵成本。
              代价说明留在按钮旁边那行小字里（点之前就能读到，比弹窗更早）。
            */}
            <Button
              size="sm"
              variant="secondary"
              disabled={busy}
              title={t("status.kl.rebuildHint")}
              /**
               * ★★ `fresh` 会**删图**。必须带渠道 —— 不带的话用户在飞书那栏
               * 点「重建」会把钉钉那 37826 个 chunk 一起删了重烧（约 3 小时、
               * 出网烧 LLM），而那是不可逆的。
               */
              onClick={() => build.mutate({ fresh: true, ...(channelId === null ? {} : { channelId }) })}
            >
              {t("status.kl.rebuild")}
            </Button>
          </div>
          {/*
            ★ 只留「重建」那一句在版面上 —— 三个动作里唯一不可逆的那个。
            另两句已经进了各自按钮的 title（见上）。
          */}
          <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("status.kl.rebuildHint")}
          </p>

          {/* 建图进度：只一行文字（不要进度条 —— 见 klBuildPercent 注释）。 */}
          {percent !== null && (
            <p
              className="typography-body-small-400 text-[var(--status-link)]"
              // 分钟级任务：让读屏软件在进度变化时播报
              aria-live="polite"
            >
              {t("status.kl.buildProgress", { percent })}
            </p>
          )}

          {buildResult !== undefined &&
            (buildResult.ok ? (
              <p className="typography-body-small-400 text-[var(--status-success)]">
                {/*
                  ★★ 报**净增**而不是绝对值 —— 与仪表盘那个「图谱详情」
                  popover 同源（都读这一轮的 `volume`）。

                  绝对值在增量建图下几乎不变（实测一轮总数从 660 涨到 695），
                  于是每次建完都显示一个差不多的大数字，看起来像"没跑"。
                  而净增（+35 / +75 / +1,359）才回答"这一轮干了什么"。

                  `volume` 缺席（老版本主进程 / 被打断）→ 退回绝对值：
                  少一点信息量好过显示一个空白回执。
                */}
                {t("status.kl.buildDone", {
                  entities: buildResult.volume?.entities ?? buildResult.entities,
                  facts: buildResult.volume?.facts ?? buildResult.facts,
                  edges: buildResult.volume?.edges ?? buildResult.edges,
                })}
              </p>
            ) : (
              <p className="typography-body-small-400 text-[var(--status-error)]">
                {t("status.kl.buildFailed", { reason: buildResult.reason ?? "" })}
              </p>
            ))}
        </div>
      </div>
    </Section>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="flex flex-col gap-[var(--gap-section-sm)]">
      <h2 className="typography-title-small-500 text-[var(--text-base-primary)]">{title}</h2>
      {children}
    </section>
  )
}

function Grid({ children, single = false }: { children: React.ReactNode; single?: boolean }) {
  return (
    <dl className={`grid gap-x-8 gap-y-3 ${single ? "grid-cols-1" : "grid-cols-1 sm:grid-cols-2"}`}>
      {children}
    </dl>
  )
}

function Item({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="typography-caption-400 text-[var(--text-base-tertiary)]">{label}</dt>
      <dd
        className={`typography-body-small-400 break-all text-[var(--text-base-primary)] ${mono ? "font-mono-token" : ""}`}
      >
        {value}
      </dd>
    </div>
  )
}

function Th({ children }: { children: React.ReactNode }) {
  return (
    <th className="typography-caption-400 px-3 py-2 font-medium text-[var(--text-base-secondary)]">
      {children}
    </th>
  )
}

function Td({ children, mono = false }: { children: React.ReactNode; mono?: boolean }) {
  return (
    <td
      className={`typography-body-small-400 break-all px-3 py-2 text-[var(--text-base-primary)] ${mono ? "font-mono-token" : ""}`}
    >
      {children}
    </td>
  )
}
