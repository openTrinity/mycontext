/**
 * 把**拓扑声明** + **运行时游标** + **上一轮结果**合成一张可展示的表。
 *
 * ## ★★★ 为什么需要这一层（而不是让状态页自己拼）
 *
 * 改动前快照里只有 FTS 一个消费者的 lag 和一个 `staleConsumers: string[]`。
 * 于是三件事在界面上**读不出来**：
 *
 * · `distill` 落后多少；
 * · `distill` 是不是正**被 graph-export 夹住**（依赖闸）—— 它与"蒸馏卡住了"
 *   在数字上完全同形（lag 都在涨、processed 都是 0），而出路相反；
 * · `graph-export` 在没起 kl 服务的部署里**压根没注册** —— 那时它既不 stale
 *   也没有 lag，界面无法区分"追平了"与"不存在"。
 *
 * 而这三件事的原料**早就有了**：`CONSUMERS` 那份声明、`consumer_cursors`
 * 那张表、`runCycle()` 的返回值（`ConsumerOutcome`，含 `waitingForUpstream`
 * 与 `absent`）。缺的只是把它们拼起来 —— 而 `runCycle` 的返回值原先
 * **只进了日志**。
 *
 * ## ★★ 为什么是纯函数
 *
 * 本仓库反复出现"两头都锁了、中间那根线是裸的"。把合成逻辑放在纯函数里，
 * 测试能直接打到每一个分支（absent / 在等上游 / stale / 落后多少），
 * 而不必造一个跑得起来的管线去间接观察。
 *
 * ★ 它**不读库**：游标行与上一轮结果都由调用方传进来。那样它既能被单测直接
 * 调用，也不会在快照那条已经很贵的路径上（9 个 COUNT(*)）再加查询。
 */
import type { ConsumerCursorRow } from "@mycontext/store"
import {
  CONSUMERS,
  DOMAINS,
  type ConsumerOutcome,
  type ConsumerSpec,
  type DataDomain,
  type DomainSpec,
} from "./topology.js"

/** 一个消费者的完整状态（声明 + 运行时）。 */
export interface ConsumerStatus {
  id: string
  purpose: string
  /** 空数组 = 消费全部域（FTS 就是全部） */
  domains: readonly DataDomain[]
  required: boolean
  dependsOn: readonly string[]
  ackedSeq: number
  lag: number
  waitingForUpstream: string | null
  absent: boolean
  /**
   * 这个消费者在**这套代码**里接线了吗（来自声明，不是运行时）。
   *
   * ★ 与 `absent`（这套**部署**里没注册）分开 —— 见契约里那段表格：
   * 前者的出路是"什么都不用做"，后者是"起服务"。
   */
  wiring: "wired" | "unwired"
  unwiredReason: string | null
  stale: boolean
  needsFullRebuild: boolean
  lastError: string | null
}

/** 一个域的状态（声明 + 水位）。 */
export interface DomainStatus {
  id: DataDomain
  purpose: string
  producedBy: "active" | "absent"
  absentReason: string | null
  head: number
}

export interface TopologyViewInput {
  /** changelog 全局水位（`ChangelogRepository.head()`） */
  head: number
  /**
   * 每个域的水位（`ChangelogRepository.headByDomain()`）；缺的域按 0。
   *
   * ★ 类型是 `Record<string, number>` 而不是 `Partial<Record<DataDomain, …>>`：
   * 那个方法返回的就是宽 Record（`domain` 是 TEXT 列，历史库里可能有
   * 我们现在不认识的值）。收窄成 DataDomain 就要在调用处写一次 `as`，
   * 而那会盖住"库里真有一个没声明的域"这个真实信号（CLAUDE.md §6）。
   * 这一层只按声明的域去查表，多出来的键自然被忽略。
   */
  domainHeads: Readonly<Record<string, number>>
  /** `consumer_cursors` 全量（`ConsumerCursorRepository.list()`） */
  cursors: readonly ConsumerCursorRow[]
  /** 心跳超期的消费者 id */
  staleIds: readonly string[]
  /**
   * 上一轮 `runCycle()` 的结果。可以为空（还没跑过一轮）。
   *
   * ★ 只从它取 `waitingForUpstream` —— 其余（lag / stale / 错误）都从游标读，
   * 那才是**持久**的真相。上一轮结果是内存里的，进程刚起时是空的，
   * 而那时游标里的进度仍然有效。若也从它取 lag，重启后界面会显示
   * "全部落后 0 条"，而那是假的。
   */
  lastCycle?: readonly ConsumerOutcome[]
  consumers?: readonly ConsumerSpec[]
  domains?: readonly DomainSpec[]
}

/**
 * 合成消费者状态表。
 *
 * ## ★★★ `absent` 的判据是「游标里没有这一行」
 *
 * 不是"上一轮没跑"。理由：`graph-export` 由 **kl 服务侧**推进，它不在
 * `runCycle` 的 runnables 里（那个 map 只有 vault 内的三个），所以
 * "上一轮没跑"对它**恒成立** —— 用那个当判据会让一个正常工作的外部消费者
 * 永远显示"不存在"。
 *
 * 而"注册过"这件事是持久的（`consumer_cursors` 里有行），且正是我们想问的：
 * 这套部署里有没有这个消费者。
 */
export function buildConsumerStatuses(input: TopologyViewInput): readonly ConsumerStatus[] {
  const specs = input.consumers ?? CONSUMERS
  const cursorById = new Map(input.cursors.map((row) => [row.consumerId, row]))
  const stale = new Set(input.staleIds)
  const waitingById = new Map(
    (input.lastCycle ?? []).map((outcome) => [outcome.id, outcome.waitingForUpstream]),
  )

  return specs.map((spec) => {
    const cursor = cursorById.get(spec.id)
    const absent = cursor === undefined
    return {
      id: spec.id,
      purpose: spec.purpose,
      // `domains: null`（全部）在契约里表达成空数组 —— 见 contract 的注释
      domains: spec.domains ?? [],
      required: spec.required,
      dependsOn: spec.dependsOn,
      ackedSeq: cursor?.ackedSeq ?? 0,
      /**
       * ★ absent 时 lag 报 0 而不是 `head`：一个没注册的消费者"落后 8000 条"
       * 是一句没有意义的话（它压根不该追）。界面靠 `absent` 那个布尔说明
       * 情况，而不是靠一个大数字。
       */
      lag: absent ? 0 : Math.max(0, input.head - cursor.ackedSeq),
      waitingForUpstream: waitingById.get(spec.id) ?? null,
      absent,
      wiring: spec.wiring,
      unwiredReason: spec.unwiredReason ?? null,
      stale: stale.has(spec.id),
      needsFullRebuild: cursor?.needsFullRebuild ?? false,
      lastError: cursor?.lastError ?? null,
    }
  })
}

/**
 * 合成域状态表。
 *
 * ★ 入参**只要水位**，不要游标 —— 域的状态与消费者进度无关。
 * 第一版让它收整个 `TopologyViewInput`，于是调用方要传两个空数组占位
 * （`cursors: [], staleIds: []`），而那种"必填但无意义"的参数会诱导下一个人
 * 以为它们有用。
 *
 * ★ `head` 缺省 0 而不是 undefined：`domainHeads()` 只返回**确实有数据**的域
 * （与 GROUP BY 语义一致）。界面上"这个域还没有任何条目"就是 0，
 * 而"这个域没有生产者"由 `producedBy: 'absent'` 表达 —— 两件事不能混。
 *
 * ## ★★★ `legacy-only` 的域**整行不出**（修 G18）
 *
 * `contact` 永远不会有采集器（PII 命令不进白名单，CLAUDE.md §5）。
 * 给它一行的后果是界面上永久显示一个"通讯录 0 条、lag 0" ——
 * 而那读起来像坏了。`absentReason` 能解释"为什么空"，但它解释不了
 * "为什么这一行还在这里" —— 用户对一个永远不会变的行没有任何可做的事。
 *
 * ★ 过滤在**这一层**而不是在界面：界面有三处（状态页拓扑卡、
 * 引导的覆盖面、将来的诊断导出），各自过滤一次就会有一处忘掉。
 *
 * ## ★★ 渠道能力过滤（修 G17）
 *
 * `channelDomains` 给了的话，再过一道"这个渠道有没有这个能力" ——
 * 只连飞书的部署不该看到"听记 0 场"（它没有听记接口）。
 * 不给 = 不过滤（保留既有行为，单测与不关心渠道的调用方都走这条）。
 */
export function buildDomainStatuses(input: {
  domainHeads: Readonly<Record<string, number>>
  domains?: readonly DomainSpec[]
  /**
   * 当前这些渠道自述的域能力（并集）。`undefined` = 不按渠道过滤。
   *
   * ★ 收**并集**而不是单个渠道：状态页显示的是"这个 vault 的数据平面"，
   * 而一个 vault 可能挂着多个渠道（钉钉 + 飞书）。任一渠道有听记能力，
   * 听记那一行就该显示。
   */
  channelDomains?: readonly string[]
}): readonly DomainStatus[] {
  const capable = input.channelDomains === undefined ? null : new Set(input.channelDomains)
  return (input.domains ?? DOMAINS)
    .filter((domain) => {
      // 见上面那段 ★★★：仅为历史兼容保留的域不占界面
      if (domain.kind === "legacy-only") return false
      if (capable === null) return true
      /**
       * ★ 声明限了渠道时才按能力过滤。没限的域（chat / doc）无条件显示 ——
       * 那样"渠道还没授权"（capabilities 为空）不会让整块拓扑消失。
       */
      if (domain.channels === undefined) return true
      return capable.has(domain.id)
    })
    .map((domain) => ({
      id: domain.id,
      purpose: domain.purpose,
      producedBy: domain.producedBy,
      absentReason: domain.absentReason ?? null,
      head: input.domainHeads[domain.id] ?? 0,
    }))
}
