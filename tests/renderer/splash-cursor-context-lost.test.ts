/**
 * SplashCursor（空态流体背景）的 **context-lost 自愈** 门禁。
 *
 * ## ★★★ 这个文件守的是一个实测过的真实故障
 *
 * 症状：知识图谱空态那层流体的 canvas `gl.isContextLost() === true`，画面
 * 停在丢失前的最后一帧，Chromium 把它画成一个**碎图（😞）**。而 console 里
 * **一个错都没有** —— context lost 不抛 JS 异常，只让后续 GL 调用静默变
 * no-op。这正是 CLAUDE.md §4 说的那类静默降级。
 *
 * 触发路径（实测在真机上发生）：**建图占满 GPU** 时，Chromium 在 GPU 压力下
 * 主动回收 WebGL 上下文 —— 而空态流体恰好在"正在建图"时显示，两件事必然
 * 同时发生。原实现没有任何 context-lost 处理，丢失后永不自愈。
 *
 * ## ★ 为什么是"读源码断言"而不是渲染 / 探针
 *
 * WebGL2 在 jsdom 里起不来（`ego-graph-*.test.ts` 全是同一个理由）。而 CDP
 * 探针跑不进 CI（要先起应用、还要制造 GPU 压力才能触发丢失）。真正的
 * 修复验证是靠 CDP 手动做的（合成 lost/restored 事件，确认监听器在多轮循环
 * 后仍有效）。这里守的是那次修复**不被回退**：三个静态可判的不变量。
 *
 * ## 守的三件事（缺一件，自愈就断）
 *
 * ① 监听 `webglcontextlost` —— 没有它就永远停在碎图；
 * ② `lost` 里 `preventDefault()` —— **不 prevent 浏览器就不派发 restored**，
 *    那样即使 GPU 空了也永远收不到恢复信号；
 * ③ 监听 `webglcontextrestored` 并重新初始化 —— 这是"恢复"本身。
 */
import { describe, expect, it } from "vitest"
import { readFileSync } from "node:fs"
import { join } from "node:path"

const SPLASH = readFileSync(
  join(import.meta.dirname, "../../apps/desktop/src/renderer/features/graph/splash-cursor.tsx"),
  "utf8",
)

describe("SplashCursor：WebGL 上下文丢失后能自愈", () => {
  it("★★★ 监听 webglcontextlost（否则永久碎图）", () => {
    expect(SPLASH).toContain('addEventListener("webglcontextlost"')
  })

  it("★★★ 监听 webglcontextrestored（恢复的入口）", () => {
    expect(SPLASH).toContain('addEventListener("webglcontextrestored"')
  })

  it("★★★ lost 处理里调用 preventDefault（否则浏览器不派发 restored）", () => {
    /**
     * 判据：`onLost` 函数体里有 `preventDefault()`。这是整条自愈链的
     * 前置条件 —— 浏览器只在 lost 事件被 preventDefault 之后，才认为
     * "应用打算恢复"并在 GPU 空闲时派发 restored。漏了它，②③ 都白搭。
     */
    const lostFn = SPLASH.slice(SPLASH.indexOf("const onLost"), SPLASH.indexOf("const onRestored"))
    expect(lostFn).toContain("preventDefault()")
  })

  it("★★★ restored 后重新 boot（重建 GL 资源），而不是只记个标志", () => {
    /**
     * context restored 之后原来的 `gl` 对象与所有句柄（program/texture/fbo）
     * 都作废了 —— 只有整段重新初始化才能恢复。所以 `onRestored` 必须再调
     * 一次那个可重入的初始化函数（`boot`）。
     *
     * 反证：把 `onRestored` 改成只 `setState`（不 re-boot）→ 这条转红，
     * 而那正是"监听了但没真的重建"的形状（画面仍是碎图）。
     */
    const restoredFn = SPLASH.slice(
      SPLASH.indexOf("const onRestored"),
      SPLASH.indexOf('canvas.addEventListener("webglcontextlost"'),
    )
    expect(restoredFn).toContain("boot()")
  })

  it("★★ boot 是可重入的具名函数（重建整套 GL，而不是散在 effect 顶层）", () => {
    /**
     * 如果 GL 初始化散在 effect 顶层、只跑一次，restored 就无从"再来一遍"。
     * 把它包成 `const boot = () => …` 才能在 restored 时重复调用。
     */
    expect(SPLASH).toContain("const boot =")
  })

  it("★★ 只在最终卸载时 loseContext，不在每轮 boot 的 teardown 里", () => {
    /**
     * ## 为什么这一条要单独锁
     *
     * `boot` 的 teardown（停 raf + 解绑指针）里**不能** loseContext ——
     * restored 时会先 teardown 再 re-boot，若 teardown 里 loseContext，
     * 就会把刚恢复的上下文立刻又弄丢，陷入死循环。
     *
     * 判据：`loseContext` 只出现一次，且在**最终 return**（effect cleanup）里，
     * 那一段能读到 `removeEventListener("webglcontextlost"`。
     */
    const occurrences = SPLASH.split("loseContext()").length - 1
    expect(occurrences).toBe(1)
    // 那一次必须与"移除 context 监听"在同一段（= 最终卸载）
    const finalCleanup = SPLASH.slice(SPLASH.lastIndexOf('removeEventListener("webglcontextlost"'))
    expect(finalCleanup).toContain("loseContext()")
  })
})
