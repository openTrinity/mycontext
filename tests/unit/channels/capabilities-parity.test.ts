/**
 * `sendAs` 是「数字分身能不能在这个渠道上跑」的判据 —— 锁住它的前提。
 *
 * ## 为什么这一条值得单独一组
 *
 * 渲染层原来七处各写一份 `channelId === "dingtalk"`。收拢成
 * `canRunPersona(channel)`（读 `capabilities.sendAs`）之后，那七份拷贝没了，
 * 但判据变成**依赖插件里那个值是对的**。
 *
 * 所以要有一条门禁盯住那个值本身：上游/同事把飞书的 `sendAs` 改成
 * `["self"]`（或把钉钉的清空）时，界面会**静默**变成"飞书也能跑分身"——
 * 而飞书的发送链路压根没接（`DataPlaneService.attach` 里非主渠道那个分支
 * 没挂 `personaSupervisor`），表现是点了自动回复什么都不发生。
 *
 * ★ 判据落在**插件的真实对象**上，不是抄一份常量来比 —— 抄的那份会跟着漂。
 */
import { describe, expect, it, vi } from "vitest"
import { createDingTalkPlugin, createFeishuPlugin } from "@mycontext/channels"
import type { Logger } from "@mycontext/kernel"
import type { ProcessRunner, RuntimeEnv } from "@mycontext/runtime-env"

const logger = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => logger,
} as unknown as Logger

/** 装配这两个插件只为读 `capabilities` —— 不起任何子进程。 */
const processes = { exec: vi.fn(), spawn: vi.fn() } as unknown as ProcessRunner

function dingtalk() {
  return createDingTalkPlugin({
    processes,
    logger,
    runtime: {
      dwsProfileArgs: () => [],
      hasPinnedIdentity: () => false,
      resolve: () => "/tmp/dws",
    } as unknown as RuntimeEnv,
    authRoot: () => "/tmp/auth",
  } as never)
}

function feishu() {
  return createFeishuPlugin({
    processes,
    logger,
    openExternal: () => Promise.resolve(),
    authRoot: () => "/tmp/auth-feishu",
    executable: "/tmp/lark-cli",
  })
}

describe("sendAs：数字分身判据的前提", () => {
  it("★★ 钉钉能以本人身份发消息（sendAs 含 self）", () => {
    expect(dingtalk().capabilities.sendAs).toContain("self")
  })

  /**
   * ★★★ 飞书**必须**是空的。
   *
   * `plugins/feishu/index.ts` 头注释第一行写着
   * `deliberately no persona/send` —— 这条门禁把那句注释变成一个会红的判据。
   *
   * 真要给飞书开发送能力时，改的**不是**这个值，而是先接上发送链路
   * （`DataPlaneService` 里挂 supervisor、`SendGuard` 的授权/频率闸），
   * 那时再来改这条测试。反过来（先改值）会让界面说能用而实际不发。
   */
  it("★★★ 飞书是只读接入（sendAs 为空 —— 它的发送链路压根没接）", () => {
    expect(feishu().capabilities.sendAs).toEqual([])
  })

  /**
   * ★ 顺带锁 `domains`：`canRunPersona` 不看它，但引导第 4 步的
   * 「资料源」勾选与它有关（飞书没有 minutes，勾了不会兑现）。
   */
  it("★ 飞书没有 minutes（会议）能力 —— 它的采集器没写", () => {
    expect(feishu().capabilities.domains).not.toContain("minutes")
    expect(dingtalk().capabilities.domains).toContain("minutes")
  })
})
