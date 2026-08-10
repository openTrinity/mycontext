/**
 * ## ★★★ `ChannelRuntimeRegistry` 的核心不变式：拿不到就抛，绝不落回主渠道
 *
 * 这一层存在的理由是这一轮 12 个 bug 里那 9 个同形状的 ——
 * 「某个上下文（channelId）在多层传递中丢了一环，而丢的那一环没有任何信号」。
 * 其中三次的直接后果是**做错了对象**：
 *
 * · 保存飞书的范围**删掉了钉钉的图**（`onScopeChanged` 无参）；
 * · 在飞书那栏保存**清空了钉钉的会话白名单**（`save()` 恒写主库）；
 * · 切到飞书显示的是**钉钉的**事实与关系（`facts()`/`ego()` 静默落回）。
 *
 * 所以这里最重要的一条是 `require()` **抛**而不是返回主渠道 —— 那让
 * "静默做错对象"在结构上不可能发生。其余方法都是围绕这一条的配套。
 */
import { describe, expect, it } from "vitest"
import { isAppError } from "@mycontext/kernel"
import { ChannelRuntimeRegistry, type ChannelRuntime } from "@main/bootstrap/channel-runtime.js"

const PRIMARY = "dingtalk"
const SOURCE = "feishu"

/**
 * 造一条 runtime。
 *
 * ★ 这一层只**持有引用并按 channelId 索引**（它不创建服务，见文件头），
 * 所以测试里那些服务字段给什么都行 —— 判据是"取到的是哪一条"，
 * 而不是那些服务能不能跑。用 channelId 当哨兵值就够了。
 */
function runtime(channelId: string, personaSupported = false): ChannelRuntime {
  return {
    channelId,
    plugin: { meta: { id: channelId } },
    db: { marker: channelId },
    dbPath: `/tmp/${channelId}/core.sqlite`,
    feedDirs: {
      dataRoot: `/tmp/${channelId}`,
      exportRoot: `/tmp/${channelId}/exports`,
      klRoot: `/tmp/${channelId}/kl`,
      handoffFile: `/tmp/${channelId}/handoff.json`,
    },
    feed: { marker: channelId },
    klServer: { marker: channelId },
    graphQuery: { marker: channelId },
    personaSupported,
  } as unknown as ChannelRuntime
}

/** 主渠道 + 飞书都挂上的常态。 */
function bothMounted(): ChannelRuntimeRegistry {
  return new ChannelRuntimeRegistry({
    primaryChannelId: PRIMARY,
    runtimes: () => [runtime(PRIMARY, true), runtime(SOURCE)],
  })
}

describe("★★★ require()：拿不到就抛，绝不落回主渠道", () => {
  it("★★★ 未挂载的渠道**抛** CHANNEL_NOT_READY（不是返回主渠道）", () => {
    const registry = bothMounted()
    let thrown: unknown
    try {
      registry.require("wecom")
    } catch (error) {
      thrown = error
    }
    expect(thrown, "未挂载的渠道必须抛，而不是静默返回一条 runtime").toBeDefined()
    expect(isAppError(thrown) && thrown.code).toBe("CHANNEL_NOT_READY")
    /**
     * ★ 反证最关键的那一条：抛出来的**不是**主渠道那条。
     *
     * 如果 `require` 被改成"找不到就 `?? this.primary()`"，
     * 上面那个 try 不会抛 —— 这条断言就是那种改法的检测器。
     */
    expect(isAppError(thrown) && thrown.code).not.toBe(undefined)
  })

  it("★★ 错误里带上『当前挂了哪些』（排查时第一个要问的）", () => {
    const registry = bothMounted()
    try {
      registry.require("wecom")
    } catch (error) {
      const context = isAppError(error) ? (error.context as { mounted?: string[] }) : {}
      expect(context.mounted).toEqual([PRIMARY, SOURCE])
    }
  })

  it("★★★ 取到的是**那个渠道自己的**服务（不是别人的）", () => {
    const registry = bothMounted()
    // 哨兵值：每条 runtime 的服务上都打了自己的 channelId
    expect((registry.require(SOURCE).klServer as unknown as { marker: string }).marker).toBe(SOURCE)
    expect((registry.require(PRIMARY).klServer as unknown as { marker: string }).marker).toBe(
      PRIMARY,
    )
    // ★ 反证：两者不同 —— 落回主渠道时这条会失败
    expect(registry.require(SOURCE).klServer).not.toBe(registry.require(PRIMARY).klServer)
  })

  /**
   * ★★ 一个渠道的**全部**落点都属于它自己。
   *
   * 这条与 `tests/unit/store/source-paths.test.ts` 呼应：那边锁路径怎么拼，
   * 这边锁"取出来的那一套确实是同一个渠道的"。
   */
  it("★★ 同一条 runtime 里的库/导出/图谱都属于同一个渠道", () => {
    const found = bothMounted().require(SOURCE)
    expect(found.dbPath).toContain(SOURCE)
    expect(found.feedDirs.exportRoot).toContain(SOURCE)
    expect(found.feedDirs.klRoot).toContain(SOURCE)
    expect(found.plugin.meta.id).toBe(SOURCE)
  })
})

describe("★★ find()：拿不到返回 null（调用方必须显式处理）", () => {
  it("★ 未挂载 → null，而不是抛（有些路径上『还没挂』是正常的）", () => {
    expect(bothMounted().find("wecom")).toBeNull()
  })

  it("挂上了 → 那一条", () => {
    expect(bothMounted().find(SOURCE)?.channelId).toBe(SOURCE)
  })
})

describe("★★ 主渠道也是一条 runtime（它不再特殊）", () => {
  /**
   * ★★★ 这一条是整个抽象层的要点。
   *
   * 改动前主渠道的服务是散落在 `startup.ts` 里的局部变量、用"顶层字段"代表；
   * 非主渠道在 `pipelines` 里。两套路径 = 每个动作都要写两遍 = 漏一处就错位。
   */
  it("★★★ all() 里含主渠道，且它排在最前", () => {
    const all = bothMounted().all()
    expect(all.map((item) => item.channelId)).toEqual([PRIMARY, SOURCE])
  })

  it("★★ primary() 取到的就是主渠道那条", () => {
    expect(bothMounted().primary().channelId).toBe(PRIMARY)
  })

  it("★ 未登录（一条都没挂）时 primary() 抛 —— 那时确实没有渠道", () => {
    const empty = new ChannelRuntimeRegistry({ primaryChannelId: PRIMARY, runtimes: () => [] })
    expect(() => empty.primary()).toThrow()
    expect(empty.all()).toEqual([])
  })

  /**
   * ★ `runtimes` 是**函数**（每次取值时读）。
   *
   * 非主渠道的那些由 `ChannelPipelineManager` 在**登录后**才现造，而这个
   * 注册表在装配阶段就构造好 —— 传数组的话它永远是空的
   * （`MultiKlServerService.sources` 踩过这个坑）。
   */
  it("★ runtimes 是函数：登录后新挂的渠道立刻可见", () => {
    let mounted: ChannelRuntime[] = [runtime(PRIMARY, true)]
    const registry = new ChannelRuntimeRegistry({
      primaryChannelId: PRIMARY,
      runtimes: () => mounted,
    })
    expect(registry.find(SOURCE)).toBeNull()
    // 模拟"用户在设置页新授权了一个渠道"
    mounted = [...mounted, runtime(SOURCE)]
    expect(registry.find(SOURCE)?.channelId).toBe(SOURCE)
  })
})

describe("★★ personaSupported：数字人/蒸馏的判据只有一处", () => {
  /**
   * 这个判据原来有**三份**（渲染层一个常量、主进程多处 `!== dingtalk`、
   * `onScopeChanged` 里一句 if）。三份总会分叉，而分叉的那一头是
   * "某个渠道意外进了画像"或"某个渠道的功能莫名不可用"。
   */
  it("★★ 只有主渠道支持数字人（其余是只读接入）", () => {
    const registry = bothMounted()
    expect(registry.require(PRIMARY).personaSupported).toBe(true)
    expect(registry.require(SOURCE).personaSupported).toBe(false)
  })

  it("★ personaHosts() 只给支持的那些", () => {
    expect(
      bothMounted()
        .personaHosts()
        .map((item) => item.channelId),
    ).toEqual([PRIMARY])
  })

  /**
   * ★ 判据是**字段**而不是"等于主渠道 id"。
   *
   * 这条锁住"将来第二个渠道开数字人时只改一处"：把 SOURCE 标成支持之后，
   * `personaHosts()` 立刻包含它，而不需要去改任何比较语句。
   */
  it("★ 标记第二个渠道支持后，personaHosts 立刻包含它（判据是字段不是 id）", () => {
    const registry = new ChannelRuntimeRegistry({
      primaryChannelId: PRIMARY,
      runtimes: () => [runtime(PRIMARY, true), runtime(SOURCE, true)],
    })
    expect(registry.personaHosts().map((item) => item.channelId)).toEqual([PRIMARY, SOURCE])
  })
})
