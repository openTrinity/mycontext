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

/**
 * 主渠道 id —— `perChannel` 缺失时（旧主进程）回落用。
 *
 * 与 `collection-scope-panel.tsx` 里那份同值：渲染层没有"渠道注册表"，
 * 而把它提成共享常量要跨 feature 目录引一个 barrel，收益不抵耦合。
 */
const PRIMARY_CHANNEL_ID = "dingtalk"

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

  /**
   * ★★ **每个渠道一张卡，按钮长在卡里** —— 不再有"顶层一套按钮"。
   *
   * ## 为什么必须这样，而不是"标题上写个渠道名"
   *
   * 改动前这一块是：上面列出「钉钉 就绪 8200 / 飞书 就绪 8201」两行状态，
   * 下面放**一个**「停止」和**一组**「建图 / 重建」。用户的原话是
   * 「这里的停止是停止谁，这里的重建是重建谁」—— 而这个问题**没有答案**
   * 可以从版面上读出来：那两行看起来是并列的两个东西，按钮却只有一套。
   *
   * 我上一轮试过"在分区标题里写当前渠道"（`知识图谱（kl）·飞书`）——
   * 那仍然是错的：标题在最上面，而按钮在下面紧贴着**两行渠道状态**。
   * 版面上离按钮最近的东西是那两行，人自然会以为按钮对它们都生效。
   * 用文字去解释一个错的布局，不如把布局改对。
   *
   * 现在：每个渠道是一张自包含的卡 —— 它的状态徽章、端口、失败原因、
   * 启停按钮、建图/重建按钮、建图进度，全都在同一张卡里。
   * "这个按钮管谁"由**它长在哪张卡里**回答，不需要任何文案。
   *
   * ★ 顶层不再有任何按钮。副作用是"点错渠道"这件事在结构上不可能发生 ——
   * 而它原来是可能的，且其中「重建」不可逆（删图重烧、几小时、出网烧 LLM）。
   *
   * ★ `channelId`（页面顶部那个 picker 选的）现在只用来**高亮**当前看的那张卡，
   * 不再决定按钮打给谁。两者解耦之后，picker 滚出视野也不影响判断。
   */
  const rows = status?.perChannel ?? []
  return (
    <Section title={t("status.sections.kl")}>
      <div className="flex flex-col gap-3">
        {/*
          ★ 出网提示是**整机**的一句话（两个渠道共用同一个远端网关），
          所以留在卡片外面 —— 放进每张卡会重复两遍同一件事。
        */}
        {status?.networkEgress === true && (
          <p className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {t("status.kl.egress")}：{t("status.kl.egressYes")}
          </p>
        )}

        {/*
          ★★ `perChannel` 缺失时回落成**主渠道**那张卡 —— 渠道 id 写死
          `PRIMARY_CHANNEL_ID`，**不能**用页面上选中的 `channelId`。

          ## 这一条修的是一张"编出来的卡"

          原来这里写的是 `channelId ?? PRIMARY_CHANNEL_ID` + 顶层的 port。
          而顶层那几个字段**永远是主渠道的**（见 `MultiKlServerService.status()`
          里 `...primary`）。于是 picker 选着飞书时，这个分支拼出一张
          「飞书 · 就绪 · 8200」的卡 —— 标签是飞书，数据是钉钉的。

          实测（用户截图 + 后端核对）：卡片写「飞书 8200 建图中 20%」，
          而 8200 是钉钉的 kl（1730 条消息、ingest=done），飞书在 8201
          且 ingest=idle 压根没在建。也就是那张卡上**每一个字段都属于另一个渠道**，
          而按钮打给谁完全不可知 —— 这正是"不报错、只是答错"里最坏的一种。

          `perChannel` 缺失只有一种成因：**旧主进程 + 新渲染层**（开发态热更时
          vite 只 reload 渲染层）。那时能确定的只有"顶层是主渠道"，
          所以标签也必须是主渠道 —— 宁可显示一张主渠道的卡，
          也不要把它伪装成用户选中的那个渠道。
        */}
        {(rows.length === 0
          ? [
              {
                channelId: PRIMARY_CHANNEL_ID,
                state: status?.state ?? "stopped",
                reason: status?.reason ?? null,
                port: status?.port ?? null,
                building: status?.building === true,
                buildProgress: status?.buildProgress ?? null,
                idle: false,
              },
            ]
          : rows
        ).map((row) => (
          <ChannelKlCard
            key={row.channelId}
            row={row}
            /** 页面顶部 picker 选中的那张卡描边 —— 只是视觉定位，不影响行为。 */
            highlighted={row.channelId === channelId}
          />
        ))}
      </div>
    </Section>
  )
}

/**
 * 一个渠道的图谱卡：状态 + 启停 + 建图/重建 + 进度，全都只关于**这一个**渠道。
 *
 * ★ 每张卡自己持有 mutation（`useKlServerStart` 等）而不是从父层传下来：
 * 那样 `isPending` 是**这张卡**的 —— 点飞书的「建图」不会让钉钉那张卡的
 * 按钮也转圈。共享一个 mutation 时两张卡的 loading 态会一起亮，
 * 而那会让人以为两个渠道都在跑（正是这一块原来的老问题）。
 */
function ChannelKlCard({
  row,
  highlighted,
}: {
  row: NonNullable<KlServerStatus["perChannel"]>[number]
  highlighted: boolean
}) {
  const { t } = useDynamicTranslation("settings")
  const start = useKlServerStart()
  const stop = useKlServerStop()
  const build = useKlGraphBuild()

  const channel = t(`status.kl.channel.${row.channelId}`, { defaultValue: row.channelId })
  /**
   * ★ 只看**这个渠道**在不在建图。
   *
   * 顶层那个 `building` 是"任一渠道在建"—— 用它禁用按钮的话，钉钉建图期间
   * 飞书这张卡的按钮也是灰的。两个渠道是两个独立的 kl（各自进程、端口、
   * Qdrant writer），钉钉在跑压根不妨碍飞书建图。
   */
  const busy = build.isPending || row.building
  const percent = klBuildPercent(row.buildProgress ?? null)
  const buildResult = build.data
  /** `idle` 是"刻意没起"（还没采到语料），不是故障 —— 用中性色，见 schema 注释。 */
  const badgeStyle = row.idle ? KL_STATE_STYLE.stopped : KL_STATE_STYLE[row.state]

  return (
    <div
      className={`flex flex-col gap-3 radius-lg border p-4 ${
        highlighted
          ? "border-[var(--border-accent)] bg-[var(--bg-card-z1)]"
          : "border-[var(--border-light)]"
      }`}
      data-channel={row.channelId}
    >
      {/* —— 谁 + 什么状态 —— */}
      <div className="flex flex-wrap items-center gap-3">
        {/*
          ★ 渠道名是这张卡的**标题**，用 body-small + medium（13px）——
          它要比卡里的正文重一档，但不能与分区标题（title-small-500）打架。
        */}
        <span className="typography-body-small-400 font-medium text-[var(--text-base-primary)]">
          {channel}
        </span>
        <span
          className={`typography-caption-400 inline-flex items-center radius-sm px-2 py-0.5 ${badgeStyle}`}
        >
          {row.idle ? t("status.kl.channelIdle") : t(klServiceStateKey(row.state))}
        </span>
        {row.port !== null && (
          <span className="typography-caption-400 font-mono-token text-[var(--text-base-tertiary)]">
            {t("status.kl.port")} {row.port}
          </span>
        )}
      </div>

      {row.state === "failed" && row.reason !== null && (
        <p className="typography-body-small-400 text-[var(--status-error)]">{row.reason}</p>
      )}

      {/* —— 服务：启 / 停 / 重试 —— */}
      <div className="flex flex-wrap items-center gap-2">
        {/*
          ★ 建图期间**照常**给服务操作：服务没停（in-server ingest），
          停它是用户合法的选择（比如想中断这一轮）。
        */}
        {row.state === "ready" ? (
          <Button
            size="sm"
            variant="secondary"
            loading={stop.isPending}
            onClick={() => stop.mutate(row.channelId)}
          >
            {/* ★ 按钮上带渠道名：读到"停止 飞书"就不必再去别处确认打给谁 */}
            {t("status.kl.stopOn", { channel, defaultValue: `停止 {{channel}}` })}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            loading={start.isPending}
            onClick={() => start.mutate(row.channelId)}
          >
            {row.state === "failed"
              ? t("status.kl.retryOn", { channel, defaultValue: `重试 {{channel}}` })
              : t("status.kl.startOn", { channel, defaultValue: `启动 {{channel}}` })}
          </Button>
        )}
      </div>

      <div className="border-t border-[var(--border-divider-light)]" />

      {/* —— 图谱数据：建图 / 重建 —— */}
      <div className="flex flex-col gap-2">
        {/*
          ★ 卡内小标题仍用 `body-small-400 font-medium`（13px），**不用 caption**：
          它统辖的正文也是 13px，用 12px 会让标题比正文小（层次倒置）。
          门禁：`status-panel-hierarchy.test.tsx` 的那条 h3 断言。
        */}
        <h3 className="typography-body-small-400 font-medium text-[var(--text-base-secondary)]">
          {t("status.kl.dataTitle")}
        </h3>
        <div className="flex flex-wrap items-center gap-2">
          {/* 建图：增量（抽过的不重抽，第二次起很快）。 */}
          <Button
            size="sm"
            disabled={busy}
            title={t("status.kl.buildHint")}
            /**
             * ★ 渠道**来自这张卡自己**（`row.channelId`），不再取页面级的
             * `channelId` —— 后者可能是 null（还没选过），而那时会退化成
             * "不指定渠道 → 全建"。实测踩到过：点一次建图，日志里
             * `graph build started` 主渠道与飞书各来一条。
             */
            onClick={() => build.mutate({ fresh: false, channelId: row.channelId })}
          >
            {/*
              ★ 文案跟 `disabled` 用同一个 `busy`，不是 `build.isPending`：
              建图也可能是自动触发或上次启动就在跑的，那时按钮灰掉却仍写着
              「建图」—— 禁用的理由要写在按钮上。
            */}
            {busy ? t("status.kl.building") : t("status.kl.build")}
          </Button>
          {/*
            重建：清空重抽。不弹系统确认框（`window.confirm` 跳出应用视觉、
            不可样式化），代价写在下面那行小字里 —— 点之前就能读到，比弹窗更早。
          */}
          <Button
            size="sm"
            variant="secondary"
            disabled={busy}
            title={t("status.kl.rebuildHint")}
            /**
             * ★★ `fresh` 会**删图**。渠道同样取自这张卡 —— 打错渠道的后果是
             * 把另一个渠道那几万个 chunk 删了重烧（不可逆、几小时、出网）。
             */
            onClick={() => build.mutate({ fresh: true, channelId: row.channelId })}
          >
            {t("status.kl.rebuild")}
          </Button>
        </div>
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
            {/* 进度取自这张卡自己的 `row.buildProgress`，归属不可能错 */}
            {t("status.kl.buildProgressOn", {
              channel,
              percent,
              defaultValue: `{{channel}} 建图中 {{percent}}%`,
            })}
          </p>
        )}

        {buildResult !== undefined &&
          (buildResult.ok ? (
            <p className="typography-body-small-400 text-[var(--status-success)]">
              {t("status.kl.buildDone", {
                entities: buildResult.entities,
                facts: buildResult.facts,
                edges: buildResult.edges,
              })}
            </p>
          ) : (
            <p className="typography-body-small-400 text-[var(--status-error)]">
              {t("status.kl.buildFailed", { reason: buildResult.reason ?? "" })}
            </p>
          ))}
      </div>
    </div>
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
