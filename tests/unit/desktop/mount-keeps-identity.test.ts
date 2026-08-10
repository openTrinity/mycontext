/**
 * `mountVault()` 的预卸载**不许清掉当前身份**。
 *
 * ## 这一条锁的是一个"两个正确的局部拼出一个错的整体"
 *
 * `mountVault` 第一步是幂等地 `await unmountVault()`（切身份与登录走同一条路，
 * 忘了先卸就是两套采集器同时跑）。而 `unmountVault` 最后会 `releaseVault()`，
 * 那里有 `activeIdentity.clear()`（卸载阶段退订要用旧身份，所以清必须在最后
 * —— 那个顺序本身是对的）。
 *
 * 两处各自都对，合起来是：启动恢复身份 → 挂载 → **自己把刚恢复的身份清掉**
 * → 再去读它 → 判成"没绑身份"。
 *
 * ## 实测证据（本机 2026-08-09 13:30:25）
 *
 * ```
 * 13:30:25.400  active identity restored {"channelId":"dingtalk@…"}
 * 13:30:25.521  vault has no bound channel identity; skipping data flows
 *               {"reason":"identity_unbound"}
 * 13:30:25.549  dwsProfileArgs → []（渠道命令不带 --profile）
 * ```
 *
 * 相隔 **121 毫秒**，而两条日志各自看都像正常状态。后果不是"少个字段"：
 * `dwsProfileArgs()` 恒空 → 每条渠道命令都被"还没绑定渠道身份"的守卫拦下
 * → **整条采集链路静默停摆**，界面上只是"一直没有新消息"。
 *
 * ★ 为什么当时很难定位：切一次渠道就"好了"。`switchTo()` 在 `await mount()`
 * **之后**有一句 `this.current = target`，自己把被清掉的补回来了；启动恢复
 * 这条路没有那一句。于是表现成"重启后不采，切下渠道就正常"——
 * 一个看起来像缓存问题的数据问题。
 *
 * ## 为什么是源码断言而不是行为断言
 *
 * 这个接缝（`unmountVault` / `releaseVault`）是 `bootstrapApp()` 里的闭包，
 * 要跑它得起真 Electron + 真 vault + 迁移 + python env。而判据本身很窄：
 * **那一次调用有没有带 `keepIdentity`**。所以这里直接读源码判它 ——
 * 换掉写法（比如改成对象参数、或把清身份移出 `releaseVault`）时这条会红，
 * 那时该做的是把判据跟着改到新形状上，而不是删掉它。
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const STARTUP = fileURLToPath(
  new URL("../../../apps/desktop/src/main/bootstrap/startup.ts", import.meta.url),
)

const source = readFileSync(STARTUP, "utf8")

/** `const mountVault = async (…) => { … }` 的函数体（到下一个顶层 `const ` 为止）。 */
function mountVaultBody(): string {
  const start = source.indexOf("const mountVault = async (")
  expect(start, "startup.ts 里找不到 mountVault —— 改名了就把这条判据跟着改").toBeGreaterThan(-1)
  const rest = source.slice(start + 1)
  const end = rest.indexOf("\n  const ")
  return end === -1 ? rest : rest.slice(0, end)
}

describe("mountVault 的预卸载不清身份", () => {
  it("★★ 预卸载显式带 keepIdentity（不带就是那个 121ms 的静默停摆）", () => {
    const body = mountVaultBody()
    // mountVault 里确实有那次预卸载（前提没变）
    expect(body).toMatch(/await unmountVault\(/)
    // ★ 核心判据：它必须带 keepIdentity
    expect(body, "mountVault 的预卸载必须传 keepIdentity，否则刚恢复的身份会被自己清掉").toMatch(
      /await unmountVault\(\{[^}]*keepIdentity:\s*true/,
    )
  })

  it("★ releaseVault 里的 clear 受 keepIdentity 约束（不是无条件清）", () => {
    // 找 releaseVault 那个闭包
    const start = source.indexOf("releaseVault: () => {")
    expect(start).toBeGreaterThan(-1)
    /**
     * ★ 先剥掉注释再判。
     *
     * 第一版这条误绿了：`keepIdentity` 这个词出现在**注释**里，正则照样命中。
     * 注释里写了不等于代码里做了 —— 而这个仓库最贵的 bug 就是"注释说得对、
     * 代码没做"。所以判据必须落在剥了注释的源码上。
     */
    const body = source
      .slice(start, source.indexOf("},", start))
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "")
    expect(body).toContain("activeIdentity.clear()")
    // ★ 判据：那一句前面有条件。无条件清就是回归到 bug 那一版
    expect(body, "clear() 必须被 keepIdentity 挡住，否则挂载前的预卸载又会清掉身份").toMatch(
      /keepIdentity[\s\S]*activeIdentity\.clear\(\)/,
    )
  })

  it("★ 登出仍然清（别把上面两条修成「永远不清」）", () => {
    // 默认值是"清" —— 只有显式传 true 才保留
    expect(source).toMatch(/keepIdentity\?:\s*boolean/)
    expect(source).toMatch(/options\.keepIdentity\s*!==\s*true/)
  })
})
