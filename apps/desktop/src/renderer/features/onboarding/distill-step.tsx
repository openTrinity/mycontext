/**
 * 引导第 4 步：蒸馏的阶段进度与结果。
 *
 * ## ★ 三个阶段是**真的**，百分比是假的
 *
 * `ForgeService.run` 严格顺序跑三个 Python 子进程：
 * `pull`（读语料）→ `build`（测量）→ `publish`（生成产物），
 * 超时上限分别是 10 / 15 / 2 分钟。所以"三步"不是修辞。
 *
 * 但**每个阶段内部的进度我们拿不到** —— `runStep` 只解析末尾那个 JSON blob。
 * 所以这一页显示的是「走到第几个阶段」而不是百分比：编一个百分比出来
 * 会在 90% 那里卡上一分钟，那比没有进度更糟。
 *
 * 阶段值来自 `forge.step`。那个字段在 IPC 契约里声明了很久却一直是 `null`
 * （主进程写死），本次把它接通了 —— 见 `distill.service.ts` 的 `runForgeStep`。
 *
 * ## ★ 任务计数那一整块已经删掉了（它是死代码）
 *
 * 原来这里有 50 行进度 UI，包括一个真的 `<div>` 进度条，条件是 `total > 0`。
 * 而 `DistillService.progress()` 在 `llmFacets !== true` 时把所有任务计数
 * **强制归零**，且 `llmFacets` 从来没有任何地方设置过 —— 于是 `total === 0`
 * 恒真，那一块**永远不渲染**。
 *
 * 留着它的代价不是几行死代码，而是它让人以为进度已经做过了：
 * 那正是"很塑料"这个反馈能存在两个版本的原因。要接回 LLM 抽取那半时，
 * 应当连着它的进度一起重新设计（那时的进度是"第 N / M 个任务"，
 * 与 forge 的阶段是两套语义）。
 *
 * ## "成功了"不等于"蒸出东西了"
 *
 * 语料 0 条也能"成功"，而那时产物是一份空画像。所以四个过程量一起报，
 * 并且 `asks === 0` 单独警示 —— 那一条是**失败**而不是「这个人没被问过」：
 * 决策层会整个退化成默认值，而风格层照常有数字，产物看起来是完整的。
 *
 * ## 进度靠推送而不是轮询
 *
 * 蒸馏是分钟级的过程。轮询要么太频要么太疏，
 * 而"看起来卡住"会让用户以为坏了然后关掉。
 */
import { useState, type ReactNode } from "react"
import { Button, cn } from "@mycontext/design"
import type { DistillProgressView, IngestSnapshot } from "@mycontext/ipc-contract"
import {
  useDistillProgress,
  useIngestProgress,
  useIngestSnapshot,
  useKlGraphOverview,
  useKlServerStatus,
  useResetDistill,
  useStartDistill,
} from "../../lib/queries.js"
import { useErrorText } from "../../lib/use-error-text.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { StepSection } from "./step-section.js"

export interface DistillStepProps {
  /** 用户在第 3 步选的时间范围（天）；null = 不限 */
  rangeDays: number | null
  /** 是否配了模型。没配时抽取型任务会失败 —— 要提前说 */
  modelConfigured: boolean
  /**
   * 主渠道连上了吗 —— 这一步**只对主渠道成立**。
   *
   * ## ★★ 为什么是"只对主渠道"而不是"哪个渠道都行"
   *
   * 整条蒸馏链从上到下都只认主渠道，不是漏了个参数：
   *
   * · `startup.ts` 的 `distill.attach(handle.db, …)` 传的是主库；
   * · `forge.run({ db: handle.db })` 同样；
   * · `forge.service.ts:249` 更直接：
   *   `new SelfIdentityRepository(input.db).get("dingtalk")` —— **渠道 id
   *   写死在里面**。
   *
   * 所以主渠道没连时这一步**不适用**（而不是"能跑但结果少"）。
   * 那时整块换成一句说明 —— 与 `persona-module` 选到只读渠道时的做法一致。
   *
   * ## ★ 为什么不自动跳过这一步
   *
   * 自动 skip 会**写库**（`onboarding_progress` 那一行），而那是替用户做决定；
   * 更要紧的是这是**唯一产出画像的一步**，静默跳过意味着用户可能永远不知道
   * 自己缺了画像。所以停在这里、说清原因、把「跳过这步」留给他自己点
   * （引导页的软门原则）。
   */
  corpusChannelConnected: boolean
}

/**
 * 三个阶段，顺序与 `ForgeService.run` 里的执行顺序一致。
 *
 * `id` 与 `forgeStatus.step` 的枚举逐字对应 —— 那是判断"走到哪了"的键，
 * 拼错的话当前阶段永远匹配不上（表现是三个都灰着），所以不能是自由文本。
 */
const FORGE_PHASES = [
  { id: "pull", labelKey: "distillStep.phasePull" },
  { id: "build", labelKey: "distillStep.phaseBuild" },
  { id: "publish", labelKey: "distillStep.phasePublish" },
] as const

export function DistillStep({
  rangeDays,
  modelConfigured,
  corpusChannelConnected,
}: DistillStepProps) {
  const { t } = useDynamicTranslation("onboarding")
  const errorText = useErrorText()
  const progress = useDistillProgress()
  const start = useStartDistill()
  const reset = useResetDistill()
  /** undefined = 本页还没发起；其余值是点击开始时的上一轮时间。 */
  const [runBaseline, setRunBaseline] = useState<number | null | undefined>(undefined)
  /**
   * 采集快照 —— 这一步要的是它的 `backfill` 那段。
   *
   * 走到第 4 步时账号一定已登录（第 1、2 步就是登录与授权），所以直接开着。
   * `useIngestProgress` 订阅主进程的推送：回溯每补完一天就更新一次，
   * 用户能看到"还差 N 天"在往下走 —— 轮询做不到这件事。
   */
  const ingest = useIngestSnapshot(true)
  useIngestProgress()

  const data: DistillProgressView | undefined = progress.data
  const forge = data?.forge
  const running = forge?.running === true
  const hasRun = forge !== undefined && forge.lastRunAt !== null
  const completedHere =
    runBaseline !== undefined &&
    forge?.lastRunAt !== null &&
    forge?.lastRunAt !== undefined &&
    forge.lastRunAt !== runBaseline

  /**
   * ★★★ 主渠道没连 → 整块换成一句说明，**不渲染下面那套进度与按钮**。
   *
   * ## 为什么是整块换掉，而不是加一条横幅
   *
   * 加横幅的话下面那些仍在（进度条、"已入库 1,724 条"、知识库计数、
   * 一个能点的「开始学习」）—— 我上一版就是那样，真机截图里同屏三句话
   * 互相打架：横幅说做不了、下面说有 1,724 条、按钮还能点。
   *
   * 这一步**不适用**于"主渠道没连"这个状态（整条蒸馏链只认主渠道，
   * 见 props 注释里那三处证据），所以正确的表达是"这一步现在不适用"，
   * 而不是"这一步能做但会差一点"。
   *
   * 与 `persona-module` 选到只读渠道时的做法一致（那里也是 early-return
   * 一整块居中说明）。
   *
   * ★ 底部的「跳过这步 / 上一步」不在这个组件里（在 `onboarding-view` 的
   * footer），所以这个 early-return **不影响**用户往下走 —— 软门保住了。
   */
  if (!corpusChannelConnected) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 px-8 py-12">
        <p className="typography-title-small-500 text-center text-[var(--text-base-primary)]">
          {t("distillStep.needPrimaryTitle")}
        </p>
        <p className="typography-body-small-400 max-w-md text-center text-[var(--text-base-tertiary)]">
          {t("distillStep.needPrimaryHint")}
        </p>
      </div>
    )
  }

  return (
    <div className="flex flex-col gap-[var(--gap-section-md)]">
      {/* 没配模型要提前说：不然用户会看到一堆 failed 才知道 */}
      {modelConfigured ? null : (
        <p className="typography-body-small-400 rounded-[var(--radius-md)] bg-[var(--bg-card-z0)] px-3 py-2 text-[var(--text-base-tertiary)]">
          {t("distillStep.noModel")}
        </p>
      )}

      {/*
        ★ 覆盖范围先说，因为它是"蒸出来的东西全不全"的**前提**。

        ## 为什么这一句必须有

        实时采集只覆盖最近 7 天（冷启动不能等半小时），用户选的 30/90/180 天
        由一条独立的回溯链慢慢补。补的过程要几十分钟到几小时 ——
        而在此期间"库里只有 10 天语料"是**正常的中间态**，不是坏了。

        没有这一句时它与"回溯根本没在跑"完全同形。实测那次困惑正是这样：
        用户选了 180 天，第 4 步显示「配对 210 组」「11 个活跃日」，
        而界面上没有任何地方说得清那 170 天去哪了。

        排在阶段条**之前**：读者的问题顺序是"要蒸哪些东西 → 蒸到哪一步了"。
      */}
      <CoverageNote
        rangeDays={rangeDays}
        backfill={ingest.data?.backfill}
        label={(key, vars) => t(`distillStep.${key}`, vars)}
      />

      {forge === undefined ? null : forge.available ? (
        <>
          <StepSection
            title={t("distillStep.phasesTitle")}
            hint={t("distillStep.phasesHint")}
            action={
              <span
                className={cn(
                  "typography-caption-400",
                  running ? "text-[var(--text-accent-normal)]" : "text-[var(--text-base-tertiary)]",
                )}
              >
                {running
                  ? t("distillStep.stateRunning")
                  : hasRun
                    ? forge.lastOk === true
                      ? t(completedHere ? "distillStep.stateDone" : "distillStep.statePreviousDone")
                      : t(
                          completedHere
                            ? "distillStep.stateFailed"
                            : "distillStep.statePreviousFailed",
                        )
                    : t("distillStep.stateIdle")}
              </span>
            }
          >
            <PhaseTrack
              current={forge.step}
              running={running}
              failedAt={forge.lastOk === false ? forge.failedStep : null}
              done={hasRun && forge.lastOk === true}
              labelOf={(key) => t(key)}
            />

            {/* 失败原因 / 语料不完整的说明。放在阶段条下面 —— 它解释的是那条 */}
            {forge.reason === null || forge.reason === "" ? null : (
              <p
                className={cn(
                  "typography-caption-400",
                  forge.lastOk === false
                    ? "text-[var(--status-error)]"
                    : "text-[var(--text-base-tertiary)]",
                )}
              >
                {forge.reason}
              </p>
            )}
          </StepSection>

          {/* 结果只在真的跑过之后才出现 —— 没跑过时一排 0 是噪音 */}
          {!hasRun ? null : (
            <StepSection
              title={t(
                completedHere ? "distillStep.resultTitle" : "distillStep.previousResultTitle",
              )}
            >
              <ResultGrid
                messages={forge.messages}
                turns={forge.turns}
                asks={forge.asks}
                files={forge.files}
                grade={forge.grade}
                labels={{
                  messages: t("distillStep.metricMessages"),
                  turns: t("distillStep.metricTurns"),
                  asks: t("distillStep.metricAsks"),
                  files: t("distillStep.metricFiles"),
                  grade: t("distillStep.metricGrade"),
                  gradeUnknown: t("distillStep.metricGradeUnknown"),
                  heroHint: t("distillStep.metricTurnsHint"),
                  gradeScale: t("distillStep.metricGradeScale"),
                  gradeMeaning: t("distillStep.metricGradeMeaning"),
                }}
              />
              {/*
                ★ `asks === 0` 单独警示。

                它是**失败**而不是「这个人没被问过」：一条 ask 都没挖到时
                决策层整个退化成默认值，而风格层照常有数字 —— 产物看起来
                是完整的。forge 为这种情况专门判 D，但没人会主动去看
                产物里的 fidelity.md。
              */}
              {forge.lastOk === true && forge.asks === 0 ? (
                <p className="typography-body-small-400 rounded-[var(--radius-md)] bg-[var(--status-fill-warning-container)] px-3 py-2 text-[var(--status-warning)]">
                  {t("distillStep.forgeNoAsks")}
                </p>
              ) : null}
            </StepSection>
          )}
        </>
      ) : (
        /* 引擎不可用要**最先**说，而且带可执行的原因 */
        <p className="typography-body-small-400 rounded-[var(--radius-md)] bg-[var(--status-fill-warning-container)] px-3 py-2 text-[var(--status-warning)]">
          {t("distillStep.forgeUnavailable", { reason: forge.unavailableReason ?? "" })}
        </p>
      )}

      {/*
        ★ 知识图谱（kl）也在这一屏说一句 —— 它此前在**整个界面上不存在**。

        ## 为什么必须说

        数字分身的回复由**两条**链路支撑，而它们回答的是不同的问题：
        · 蒸馏（上面那块）→ 「用什么**语气**说」；
        · 知识图谱 → 「**事实**是什么」（谁说过什么、什么时候、和谁相关）。

        实测过一条：小吴问「你最喜欢哪个歌手」，答出「卢广仲」靠的是图谱
        （那句话在 30 条上下文窗口之外，只有图谱搜得到）。

        而图谱是**启动时自动**建的（`startup.ts` 的 `autoBuild`，判据是
        有没有配 LLM key），没有任何界面。于是用户看第 4 步时会以为
        "蒸馏就是全部" —— 那正是"看不懂这一步在做什么"的一半原因。

        ## 只读不控

        这里**不给**「开始建图」按钮：建图要调 LLM 抽取 + embedding（花钱），
        而它已经在自动跑了。再给一个按钮会让用户以为需要自己管，
        且重复触发只是白花钱。要手动重建的入口在知识图谱页。
      */}
      <GraphSection />

      {start.error === null ? null : (
        <p className="typography-body-small-400 text-[var(--status-error)]">
          {errorText(start.error)}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button
          size="md"
          loading={running}
          /**
           * ★ 引擎不可用时禁掉。
           *
           * 不禁的话点了什么都不会发生（`ForgeService.run` 一开头就因为
           * 缺 Python 返回），而按钮看起来是好的 —— 用户会反复点。
           * 原因已经在上面写着了，所以这里只需要拦住动作。
           */
          /**
           * ★★ 渠道没连**不禁用**这个按钮 —— 我第一版禁了，那是错的。
           *
           * 蒸馏只读**本地库**（`DistillService` 全程不碰渠道 CLI，
           * 见它的 `start()`），所以已入库的聊天记录照样能学。真机实测那一刻
           * 库里有 1,724 条，而按钮是灰的、旁边写着"什么都学不到"——
           * 两句都不成立，用户看到的是一个自相矛盾的界面。
           *
           * 现在只给说明（"学不到新的"），要不要跑由用户定。
           */
          disabled={start.isPending || running || forge?.available === false}
          onClick={() => {
            setRunBaseline(forge?.lastRunAt ?? null)
            start.mutate({ days: rangeDays })
          }}
        >
          {t("distillStep.start")}
        </Button>
        {/* 「重来一遍」只在跑过之后才有意义 —— 没跑过时它与「开始」同义 */}
        {!hasRun ? null : (
          <Button
            size="md"
            variant="ghost"
            disabled={reset.isPending || running}
            onClick={() => reset.mutate()}
            title={t("distillStep.restartHint")}
          >
            {t("distillStep.restart")}
          </Button>
        )}
      </div>
    </div>
  )
}

/**
 * 阶段条：三段贯通轨道 + 圆点 + 阶段名。
 *
 * ## ★ 视觉刻意与顶部的四步引导条同源
 *
 * 两者表达的是同一件事（"一个有序过程走到哪了"），用两套视觉语言会让
 * 页面看起来是两个人做的。所以这里是同样的"贯通轨道 + 圆点"，
 * 只是尺寸小一号、圆点里不放数字（阶段名已经说清了顺序）。
 *
 * ## ★ 为什么没有百分比
 *
 * 阶段内部的进度拿不到（`runStep` 只解析末尾的 JSON）。一个卡在 66% 的
 * 进度条比"正在测量"更让人焦虑 —— 后者至少是真的。
 */
/**
 * 知识图谱（kl）的状态 —— 与蒸馏并列的**另一条**链路。
 *
 * ## ★ 两条链路必须都可见
 *
 * 数字分身回一条消息用到两样东西，而它们的来源完全不同：
 * · 蒸馏 → 语气（本地统计，不调模型）；
 * · 图谱 → 事实（调 LLM 抽实体与关系，花钱）。
 *
 * 图谱是启动时自动建的、没有任何界面。用户看第 4 步时会以为
 * "蒸馏就是全部"，而事实检索能不能用完全看图谱建没建 ——
 * 那是"这一步在做什么看不懂"的另一半。
 *
 * ## 三个数字，不是七个
 *
 * `klGraphOverview` 给了 entities/facts/edges/chunks/messages + 两个类型分布。
 * 这里只摆**实体 / 事实 / 关系** 三个：它们分别回答"认识多少人和系统"、
 * "记住多少条结论"、"它们之间有多少联系"。剩下的（切块数、类型分布）
 * 是排查用的，属于知识图谱页 —— 引导页摆七个数字就又变回一串数字了。
 *
 * ## 还没建时说"会自动建"，不给按钮
 *
 * 建图已经在自动跑（`startup.ts` 的 `autoBuild`）。给按钮会让用户
 * 以为需要自己管，重复触发只是白花钱（Phase B 每块都调 LLM）。
 */
function GraphSection() {
  const { t } = useDynamicTranslation("onboarding")
  /**
   * ★ `useKlServerStatus` 直接返回状态（不是 react-query 的结果对象）——
   * 它走的是事件订阅而不是轮询，所以没有 `.data`。null = 还没收到第一条。
   */
  const server = useKlServerStatus()
  const building = server?.building === true
  const overview = useKlGraphOverview(building)
  const data = overview.data

  return (
    <StepSection title={t("distillStep.graphTitle")} hint={t("distillStep.graphHint")}>
      {data === undefined ? null : data.available ? (
        <dl className="grid grid-cols-3 gap-2">
          <Metric label={t("distillStep.graphEntities")} value={data.entities} />
          <Metric label={t("distillStep.graphFacts")} value={data.facts} />
          <Metric label={t("distillStep.graphEdges")} value={data.edges} />
        </dl>
      ) : (
        /*
          ★ 还没建图时给的是"会自动建 / 为什么还没建"，而不是一排 0。
          一排 0 会被读成"建了但什么都没抽到"，那是一个**不同**的问题。
        */
        <p className="typography-body-small-400 rounded-[var(--radius-md)] bg-[var(--bg-card-z0)] px-3 py-2 text-[var(--text-base-tertiary)]">
          {building
            ? t("distillStep.graphBuilding")
            : t("distillStep.graphAbsent", { reason: data.reason ?? "" })}
        </p>
      )}
    </StepSection>
  )
}

function PhaseTrack({
  current,
  running,
  failedAt,
  done,
  labelOf,
}: {
  /** 正在跑的阶段；null = 没在跑 */
  current: "pull" | "build" | "publish" | null
  running: boolean
  /** 失败停在哪一步；null = 没失败 */
  failedAt: "pull" | "build" | "publish" | null
  /** 整轮成功跑完 */
  done: boolean
  labelOf: (key: string) => string
}) {
  const currentIndex = current === null ? -1 : FORGE_PHASES.findIndex((p) => p.id === current)
  const failedIndex = failedAt === null ? -1 : FORGE_PHASES.findIndex((p) => p.id === failedAt)

  /**
   * 每个阶段的视觉状态。
   *
   * 判据的优先级：**失败 > 完成 > 正在跑 > 走过 > 待运行**。
   * 顺序反了会让"失败停在 build"显示成"build 完成了"——
   * 因为那时 currentIndex 已经走到 build 了。
   */
  const stateOf = (index: number): "done" | "active" | "failed" | "pending" => {
    if (failedIndex >= 0) {
      if (index === failedIndex) return "failed"
      return index < failedIndex ? "done" : "pending"
    }
    if (done) return "done"
    if (!running) return "pending"
    if (index < currentIndex) return "done"
    if (index === currentIndex) return "active"
    return "pending"
  }

  /** 高亮轨道走到哪 —— 与 StepBar 同一套算法（按段而不是按点算）。 */
  const passed = FORGE_PHASES.reduce(
    (acc, _phase, index) => (stateOf(index) === "done" ? index + 1 : acc),
    0,
  )
  const segments = Math.max(FORGE_PHASES.length - 1, 1)
  const ratio = Math.min(passed, segments) / segments

  return (
    <ol className="relative flex w-full items-start">
      <span
        aria-hidden="true"
        className="absolute top-[9px] h-px bg-[var(--border-divider-light)]"
        style={{
          left: `calc(100% / ${FORGE_PHASES.length} / 2)`,
          right: `calc(100% / ${FORGE_PHASES.length} / 2)`,
        }}
      />
      <span
        aria-hidden="true"
        className="absolute top-[9px] h-px bg-[var(--text-accent-normal)] transition-[width] duration-500"
        style={{
          left: `calc(100% / ${FORGE_PHASES.length} / 2)`,
          width: `calc((100% - 100% / ${FORGE_PHASES.length}) * ${ratio})`,
        }}
      />
      {FORGE_PHASES.map((phase, index) => {
        const state = stateOf(index)
        return (
          <li key={phase.id} className="flex min-w-0 flex-1 flex-col items-center gap-1.5">
            <PhaseDot state={state} />
            <span
              className={cn(
                "typography-caption-400 max-w-full truncate transition-colors duration-200",
                state === "active"
                  ? "font-medium text-[var(--text-base-primary)]"
                  : state === "failed"
                    ? "text-[var(--status-error)]"
                    : state === "done"
                      ? "text-[var(--text-base-secondary)]"
                      : "text-[var(--text-base-tertiary)]",
              )}
            >
              {labelOf(phase.labelKey)}
            </span>
          </li>
        )
      })}
    </ol>
  )
}

/**
 * 阶段圆点。
 *
 * `active` 用**脉动**而不是旋转：旋转的 spinner 暗示"正在传输"，
 * 而这是本地计算。脉动读起来是"它还活着"，那正是这几分钟里
 * 用户唯一需要的信息。
 */
function PhaseDot({ state }: { state: "done" | "active" | "failed" | "pending" }) {
  const base =
    "relative flex size-[18px] shrink-0 items-center justify-center rounded-full transition-all duration-200"

  if (state === "done") {
    return (
      <span className={cn(base, "bg-[var(--status-success)]")}>
        <svg viewBox="0 0 16 16" className="size-3 text-[var(--theme-white-white-100)]" fill="none">
          <path
            d="M3.5 8.5l3 3 6-6.5"
            stroke="currentColor"
            strokeWidth={2.2}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </span>
    )
  }

  if (state === "failed") {
    return (
      <span className={cn(base, "bg-[var(--status-error)]")}>
        <span className="h-px w-2 bg-[var(--theme-white-white-100)]" />
      </span>
    )
  }

  if (state === "active") {
    return (
      <span
        className={cn(
          base,
          "animate-pulse bg-[var(--control-core-button-default)]",
          "ring-4 ring-[var(--control-core-button-default)]/20",
        )}
      >
        <span className="size-1.5 rounded-full bg-[var(--theme-white-white-100)]" />
      </span>
    )
  }

  return (
    <span
      className={cn(base, "border border-[var(--border-divider-light)] bg-[var(--bg-base-normal)]")}
    />
  )
}

/**
 * 结果：四个过程量 + 一个结论。
 *
 * ## ★ 覆盖度等级单独一块，不跟那四个数挤一行
 *
 * 原来五个数用 `·` 串成一行：「语料 60 条 · 配对 1552 组 · 挖出「问我」331 条
 * · 产物 11 个 · 覆盖度等级 A」。问题不是难看，是**等级被埋了** ——
 * 那四个是过程量（读了多少、算了多少），而等级是**结论**（这份画像有多可信）。
 * 同一行同一字号，用户扫过去只会看到一串数字。
 */
function ResultGrid({
  messages,
  turns,
  asks,
  files,
  grade,
  labels,
}: {
  messages: number
  turns: number
  asks: number
  files: number
  grade: string | null
  labels: {
    messages: string
    turns: string
    asks: string
    files: string
    grade: string
    gradeUnknown: string
    heroHint: string
    gradeScale: string
    gradeMeaning: string
  }
}) {
  return (
    <div className="flex flex-col gap-[var(--gap-component-md)]">
      {/*
        ★ 「配对」是**主数字**（hero），另外三个是支撑量。

        ## 为什么不是四个一样大的格子

        原来四个 `Metric` 同字号（14px）平铺，视觉权重完全相等 ——
        用户扫过去是"一串数字"，而这四个的重要性差很远：

        · **配对** = 「别人说什么 → 我怎么回」的上下文对。**它才是学语气的素材**：
          只看自己说过的话，不知道那句在回什么，语气就无从测量；
        · 语料 = 自己写过多少条（配对的**上界**，不是同一件事）；
        · 别人问我 = 决策层的**全部**证据（0 条时那一层整个是默认值）；
        · 产物 = 生成了几个文件（纯过程量，最不重要，但"0 个"意味着白跑）。

        一个 hero + 三个小格把这个次序**在视觉上**说出来。
        `title-large-600`（26px）是排版表里最大的那一档，
        而"每屏只有一个 hero"是它成立的前提 —— 所以等级那块不再用大号字。
      */}
      <div className="flex flex-col gap-1 rounded-[var(--radius-md)] bg-[var(--bg-card-z0)] px-4 py-3">
        <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
          {labels.turns}
        </span>
        <div className="flex items-baseline gap-2">
          {/*
            ★ 不加 `tabular-nums`：大号独立数字用比例字形。
            等宽会让每个数字都占 `0` 的宽度，`121` 这种在 26px 下看起来发散。
            （等宽只留给需要纵向对齐的数字列。）
          */}
          <span className="typography-title-large-600 text-[var(--text-base-primary)]">
            {formatCount(turns)}
          </span>
        </div>
        {/* hero 需要一句"它为什么重要" —— 否则大字号只是把一个黑话放大了 */}
        <span className="typography-caption-400 text-[var(--text-base-secondary)]">
          {labels.heroHint}
        </span>
      </div>

      <dl className="grid grid-cols-3 gap-2">
        <Metric label={labels.messages} value={messages} />
        {/* asks 为 0 时标警示色：它是决策层的**全部**证据 */}
        <Metric label={labels.asks} value={asks} warn={asks === 0} />
        <Metric label={labels.files} value={files} warn={files === 0} />
      </dl>

      {/*
        ★ 覆盖度：给**量表**，不是一个孤立的字母。

        原来只显示 `A` —— 而 A 相对什么、满分是什么、D 有多糟，界面上
        一个字都没说。一个没有量表的等级读者只能猜，而猜错的方向通常是
        "A 是不是意味着像我了"（它不是：那是覆盖率，不是相似度）。

        所以三样一起给：字母 + 四档量表（当前那档高亮）+ 一句它的含义。
      */}
      <div className="flex flex-col gap-2 rounded-[var(--radius-md)] bg-[var(--bg-card-z0)] px-4 py-3">
        <div className="flex items-center justify-between gap-3">
          <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {labels.grade}
          </span>
          {grade === null ? (
            <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
              {labels.gradeUnknown}
            </span>
          ) : (
            <GradeScale grade={grade} scaleLabel={labels.gradeScale} />
          )}
        </div>
        {grade === null ? null : (
          <span className="typography-caption-400 text-[var(--text-base-secondary)]">
            {labels.gradeMeaning}
          </span>
        )}
      </div>
    </div>
  )
}

/**
 * 四档覆盖度量表，当前那档实心。
 *
 * ## ★ 为什么是四个点而不是一个字母
 *
 * 「A」单独出现时读者无从判断它在什么范围里 —— 而 forge 的量表是
 * A–D 四档（`readGrade` 的正则就是 `[A-D]`）。画出全部四档并高亮当前那个，
 * 「离满分多远」变成一眼可见，不需要任何解释文字。
 *
 * ★ 不用颜色区分档位：A–D 是**顺序**量而不是状态量，用状态色
 * （绿/黄/红）会让它读起来像"报警"，而覆盖度低不是错误 ——
 * 那只是"这个账号的语料还不够多"。所以用填充与不填充表达。
 */
function GradeScale({ grade, scaleLabel }: { grade: string; scaleLabel: string }) {
  const steps = ["D", "C", "B", "A"] as const
  const index = steps.indexOf(grade as (typeof steps)[number])
  return (
    <div className="flex items-center gap-2" title={scaleLabel}>
      <div className="flex items-center gap-1" aria-hidden>
        {steps.map((step, position) => (
          <span
            key={step}
            className={cn(
              "size-1.5 rounded-full",
              // 未知等级（正则没匹配上）时全部空心 —— 不假装它是某一档
              index >= 0 && position <= index
                ? "bg-[var(--text-accent-normal)]"
                : "bg-[var(--border-medium)]",
            )}
          />
        ))}
      </div>
      <span className="typography-body-base-500 text-[var(--text-base-primary)]">
        {/* 「A / 满分 A」比孤立一个 A 多给了量表的上界 */}
        {scaleLabel.replace("{{grade}}", grade)}
      </span>
    </div>
  )
}

/**
 * 千位分隔。
 *
 * ★ 用 `toLocaleString` 而不是自己写正则：`1552` → `1,552`。
 * 四位数以上不分隔时读者要数位数，而这一屏最大的数就是四位起
 * （实测这台机器 1,913 条语料 / 1,552 组配对）。
 */
function formatCount(value: number): string {
  return value.toLocaleString()
}

function Metric({ label, value, warn }: { label: string; value: number; warn?: boolean }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-[var(--radius-md)] bg-[var(--bg-card-z0)] px-3 py-2">
      <dt className="typography-caption-400 text-[var(--text-base-tertiary)]">{label}</dt>
      <dd
        className={cn(
          "typography-body-base-500",
          warn === true ? "text-[var(--status-warning)]" : "text-[var(--text-base-primary)]",
        )}
      >
        {formatCount(value)}
      </dd>
    </div>
  )
}

/**
 * 语料覆盖进度 —— 「选了 180 天但库里只有 10 天」这个中间态的出口。
 *
 * ## ★ 为什么这里现在有进度条了（一次判断的修正）
 *
 * 这个函数原来只有一句话，注释里写的理由是「进度条给的是百分之多少，
 * 而那个数不改变任何决定 —— 还差 170 天与还差 17 天在条上都是快满了」。
 *
 * 那个判断对**裸百分比**成立，但它漏了另一个信息需求：
 * **回溯到底还在不在动**。只报"还差 38 天"时那个数字每几分钟才变一次，
 * 于是"正在推进"与"卡住了"在界面上完全同形 —— 而这条链路真的活锁过
 * （窗宽固定 7 天而一窗的消息数超过单轮预算，见 `MAX_PAGES_PER_WINDOW`）。
 *
 * 所以现在给的不是一个裸百分比，而是三样**能看出在动**的东西：
 * · 正在拉的**时间区间**（`activeWindow`，每轮都在往左移）；
 * · 已采集的**条数**（单调增，几秒就变一次）；
 * · 覆盖占比（条形，回答"大概到哪了"）。
 *
 * 决定仍然只有一个（现在蒸还是等补完），所以那句"现在就学也可以"保留 ——
 * 进度条是补充**可观察性**，不是替代那个决定。
 *
 * ## 三种状态各说各的，不共用措辞
 *
 * · **正在补**：区间 + 条数 + 占比 + "现在学也可以"；
 * · **补完了**：一句确认（不再占三行）；
 * · **没选范围**：说清蒸的是"已采集到的全部" —— 那时没有"差多少"这回事。
 */
function CoverageNote({
  rangeDays,
  backfill,
  label,
}: {
  rangeDays: number | null
  /**
   * `undefined` = 快照还没到。
   *
   * ★ 类型上它**不可空**，但这里仍然容忍 `null`：跨进程来的东西在
   * 旧版主进程 / 半截 payload 下真的可能是 null，而这一屏是引导流程 ——
   * 崩在这里等于把用户卡在引导里出不去。契约收紧了，渲染层仍然兜一手。
   */
  backfill: IngestSnapshot["backfill"] | null | undefined
  /** 已绑定 `distillStep.` 前缀的取词器 —— 免得每处都写一遍那个前缀 */
  label: (key: string, vars?: Record<string, number | string>) => string
}) {
  // 快照还没到：不占位。空框比晚 200ms 出现更显眼
  if (backfill === undefined || backfill === null) return null

  if (rangeDays === null) {
    return <Note tone="muted">{label("coverageUnset")}</Note>
  }

  /**
   * ★★ 一条消息都还没有 → **不能**说"已完成"。
   *
   * 这一条曾经不存在，而 `backfillCoverage` 对"库里没消息"也返回
   * `remainingMs: 0` —— 于是下面那个判零命中，界面对一个**采集完全失败**
   * 的库显示「选的 N 天已全部采集完成」。
   *
   * 实测踩到过：采集第一轮就撞 `SESSION_EXPIRED` 进 blocked 终态、
   * 游标 `status=failed`、`messages` 表空，而这里报"完成"、蒸馏跟着
   * 0 语料 / 覆盖度 D。用户看到的是"上来就说采集完成了，但没有数据"。
   *
   * 判据用快照的 `started` 而不是"消息数是否为 0"：前者与调度器的下界
   * 规则同源（见 `backfillCoverage`），后者是渲染层另算一份，两处会漂。
   *
   * ★ `=== false` 而不是 `!backfill.started`：开发态热更只 reload 渲染层、
   * 主进程还是旧的，那时快照里**没有这个键**（`undefined`）。用真值判会把
   * "旧主进程"也算成"还没采到"，于是引导页对一个采得好好的库报"还没采到"
   * —— 那与这条要修的 bug 正好对称地错。缺键时按老行为走下面的判零。
   */
  if (backfill.started === false) {
    return <Note tone="warning">{label("coverageNotStarted")}</Note>
  }

  /**
   * `remainingMs === 0` = 没有要补的（选的范围已在实时路覆盖内），或已补完。
   *
   * ★ 判据是**毫秒差**而不是天数：快照给的是 `remainingMs`
   * （见 `IngestSnapshot.backfill`），在这里换算成天只是为了显示 ——
   * 换算前先判零，免得 `Math.round` 把不到半天的残余抹成 0 而提前报"已完成"。
   */
  if (backfill.remainingMs <= 0) {
    return (
      <Note tone="muted">
        {typeof backfill.messages === "number"
          ? label("coverageDone", {
              selected: rangeDays,
              count: formatCount(backfill.messages),
            })
          : label("coverageDoneLegacy", { selected: rangeDays })}
      </Note>
    )
  }

  /**
   * 已覆盖多少天 = 从"库里最早那条"算到现在。
   *
   * 不用 `rangeDays - 剩余天数`：那个减法在两端都可能偏（回填的终点是
   * 实时路起点而不是 now），而"从最早那条算到今天"正是用户理解的
   * "我现在有多少历史"。`coveredFrom` 为 null（库里还没有消息）时算 0 天。
   */
  const covered =
    backfill.coveredFrom === null
      ? 0
      : Math.max(1, Math.round((Date.now() - backfill.coveredFrom) / 86_400_000))
  const remaining = Math.max(1, Math.round(backfill.remainingMs / 86_400_000))
  /**
   * 覆盖占比 = 已覆盖天数 / 选定天数。
   *
   * ★ clamp 到 [0.02, 1]：
   * · 下界 0.02 —— 刚开始时 0% 的条与"没在跑"看起来一样，留一点让它可见；
   * · 上界 1 —— `covered` 算的是"最早那条到今天"，而回填的终点是实时路
   *   的起点而不是 now，所以它可能略大于 `rangeDays`（那不是错，
   *   但一个超过 100% 的条会让人以为算错了）。
   */
  const ratio = Math.min(1, Math.max(0.02, covered / Math.max(1, rangeDays)))

  return (
    <Note tone="warning">
      <span className="flex flex-col gap-1.5">
        <span>{label("coverageBackfilling", { selected: rangeDays, covered, remaining })}</span>

        {/*
          进度条 + 两侧的数字。
          ★ `aria-*` 不是装饰：这一条是"还要等多久"的唯一出口，
          读屏用户同样需要它（而条形本身对他们完全不可见）。
        */}
        <span
          className="h-1 w-full overflow-hidden rounded-full bg-[var(--bg-card-z0)]"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(ratio * 100)}
          aria-label={label("coverageTitle")}
        >
          <span
            className="block h-full rounded-full bg-[var(--status-warning)] transition-[width] duration-500"
            style={{ width: `${String(Math.round(ratio * 100))}%` }}
          />
        </span>

        {/*
          ★★ 这一行是"看得出在动"的那一半（见函数头注释）。

          `activeWindow` 每轮往左移一个窗、`messages` 每几秒就涨 ——
          而上面那句话里的"还差 N 天"几分钟才变一次。少了这一行，
          「正在推进」与「卡住了」在界面上完全同形，而这条链路真的活锁过。

          `activeWindow` 为 null = 这一刻没有在跑的窗（两轮之间的间隙，
          或回填让位给了实时采集）。那时只报条数，**不**编一个区间出来。
        */}
        <span className="typography-caption-400 flex flex-wrap items-baseline gap-x-3 gap-y-0.5 opacity-80">
          {/*
            ★ 两个字段都判 undefined 再用。

            类型上它们都不可空，但这一屏是**引导流程** —— 崩在这里等于把
            用户卡在引导里出不去。而"新渲染层 + 旧主进程"在开发态热更下
            是常态（vite 只 reload 渲染层），那时旧快照里没有这两个键。
            与上面 `backfill` 自己容忍 null 是同一条纪律。
          */}
          {typeof backfill.messages === "number" ? (
            <span>{label("coverageCollected", { count: formatCount(backfill.messages) })}</span>
          ) : null}
          {backfill.activeWindow === null || backfill.activeWindow === undefined ? null : (
            <span>
              {label("coverageWindow", {
                from: formatDay(backfill.activeWindow.start),
                to: formatDay(backfill.activeWindow.end),
              })}
            </span>
          )}
        </span>
      </span>
    </Note>
  )
}

/**
 * unix ms → `M月D日`。
 *
 * 手写而不是 `toLocaleDateString()`：后者的格式跟随系统区域设置，
 * 于是同一个区间在不同机器上长得不一样，截图对不上、门禁也没法断言
 * （与 `formatCount` 不用 `toLocaleString` 同一个理由）。
 */
function formatDay(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getMonth() + 1)}月${String(d.getDate())}日`
}

/** 一行说明。`warning` 那档用底色 —— 它要求用户做一个决定。 */
function Note({ tone, children }: { tone: "muted" | "warning"; children: ReactNode }) {
  return (
    <p
      className={cn(
        "typography-body-small-400 rounded-[var(--radius-md)] px-3 py-2",
        tone === "warning"
          ? "bg-[var(--status-fill-warning-container)] text-[var(--status-warning)]"
          : "bg-[var(--bg-card-z0)] text-[var(--text-base-tertiary)]",
      )}
    >
      {children}
    </p>
  )
}
