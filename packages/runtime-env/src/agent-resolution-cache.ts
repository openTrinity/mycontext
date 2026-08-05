/**
 * agent 二进制「解析 + 版本闸」结果的缓存。
 *
 * ## ★ 为什么需要它：原来那份缓存把一次偶发失败变成了必须重启才能恢复
 *
 * 两个调用方（persona-acp / search.service）各自抄了一份同样的
 * `if (this.resolution === null) this.resolution = resolveUsable…()`。
 * 缓存本身是对的 —— 每轮都探一次版本要多 ~270ms，而结果在进程生命周期内
 * 不会变。**错的是它把失败也缓存了。**
 *
 * 真实故障：那个二进制 132MB，macOS 首次执行要全量校验签名（见
 * `probe-version.ts` 里的实测数字），冷启动 2.4–3.6s。探针原来 5s 超时、
 * 恰好落在临界区，于是**启动后第一次探测**超时 → 记成"版本读不出" →
 * 缓存住 → 之后二进制早就热了（270ms 就能读出来），这个进程却**再也不重试**。
 * 用户看到的是"未检测到 opencode"横幅一直挂着，重启应用才好。
 *
 * 所以规则是：**成功永久缓存，失败不缓存**（下次调用重新探）。
 * 探针那边也做了超时重试，两层配合 —— 这一层保证"即使真失败了，
 * 下一次用户点搜索时仍会再试一次"，而不是把一次抖动变成一整个 session 的降级。
 *
 * ## 为什么单独一个文件、且刻意**不出现**那个 agent 二进制的名字
 *
 * 与 `probe-version.ts` / `python.ts` 同一处境：
 * `tests/unit/agent-runtime/spawn-wiring.test.ts` 用「非注释行里同时出现那个
 * 名字 + spawn 调用」当门禁。这段代码只收一个 `RuntimeEnv` 与一个探针函数、
 * 自己不 spawn 也不写出那个名字，于是门禁不会误伤。
 */
import type { OpencodeResolution, OpencodeVersionProbe, RuntimeEnv } from "./binaries.js"

/**
 * 造一个带缓存的解析器。
 *
 * @param runtime 已装配好的 RuntimeEnv（调用方持有的那份）
 * @param probe   版本探针（本包的 `probeBinaryVersion`）
 * @returns 每次调用返回解析结果；**成功后**固定返回缓存值，失败则下次重试。
 */
export function createAgentResolver(
  runtime: Pick<RuntimeEnv, "resolveUsableOpencode">,
  probe: OpencodeVersionProbe,
): () => OpencodeResolution {
  let cached: OpencodeResolution | null = null
  return () => {
    // ★ 只缓存成功。失败不写 cached —— 见文件头注释里那个真实故障。
    if (cached !== null) return cached
    const result = runtime.resolveUsableOpencode(probe)
    if (result.ok) cached = result
    return result
  }
}
