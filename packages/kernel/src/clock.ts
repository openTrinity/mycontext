/**
 * 可注入的时钟。
 *
 * 为什么需要一个专门的接缝：本项目里时间敏感逻辑密度很高 ——
 * 发送授权的 TTL 到期、工作时间判定、频率上限（10 分钟 ≤2 / 1 小时 ≤20）、
 * 会话 Agent 的 LRU 空闲回收、消费者心跳超期（7 天）、Outbox 租约
 * （60s TTL + 20s 续租）、试运行时「冻结时间」。
 *
 * 这些行为如果直接读 `Date.now()`，测试就只能靠 `sleep`：
 * 60 秒的租约还能勉强等，7 天的心跳**根本没法测**。而这些恰恰是
 * 「昨天还好好的，今天不工作了」这类最难排查的故障所在。
 *
 * 仓库里本来已有这个模式（`signJwt` 的 `nowMs?`、`ChannelHost` 的 `options.now?.()`），
 * 只是各处各写一遍。这里把它提到 kernel 统一：
 * 一个接口 + 一个默认实现 + 一个测试用的可控实现。
 *
 * 配套约束：`packages/{persona,ingest,knowledge-feed,retrieval,distill}` 里
 * 由 eslint 禁用裸 `Date.now()` 与无参 `new Date()`（见 eslint.config.mjs）。
 */

export interface Clock {
  /** 当前时间的 unix 毫秒。全库统一用 ms 整数，不传 Date 对象。 */
  now(): number
}

/** 生产用：直接读系统时钟。 */
export const systemClock: Clock = {
  now: () => Date.now(),
}

/**
 * 测试用：时间只在被明确推进时前进。
 *
 * 刻意不提供「自动流逝」模式：测试里时间自己会走，就等于测试结果依赖机器速度，
 * 那正是我们想消除的不确定性。
 */
export class ManualClock implements Clock {
  private current: number

  constructor(startMs = 0) {
    this.current = startMs
  }

  now(): number {
    return this.current
  }

  /** 前进指定毫秒；返回前进后的时间，便于链式断言。 */
  advance(ms: number): number {
    if (ms < 0) throw new Error("ManualClock.advance 不接受负数：时间不会倒流")
    this.current += ms
    return this.current
  }

  /** 直接跳到某个时刻（构造「授权已过期」这类场景时比累加更直观）。 */
  set(ms: number): void {
    this.current = ms
  }
}

/** 常用时间常量：避免各处重复写 `7 * 24 * 60 * 60 * 1000` 并算错一个零。 */
export const MS_PER_SECOND = 1000
export const MS_PER_MINUTE = 60 * MS_PER_SECOND
export const MS_PER_HOUR = 60 * MS_PER_MINUTE
export const MS_PER_DAY = 24 * MS_PER_HOUR
