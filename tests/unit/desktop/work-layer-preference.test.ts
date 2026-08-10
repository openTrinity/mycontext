/**
 * 工作层开关的持久化位。
 *
 * ## ★ 为什么这一位值得一个独立的测试文件
 *
 * 它是**唯一一个打开就开始花钱**的偏好：开着的时候每轮蒸馏对四个维度各发一次
 * 请求、每次上万 token，而蒸馏跑在后台（6 小时一轮的定时器），界面上只有一行
 * "正在蒸馏"。也就是说这一位如果**朝错的方向**默认，后果是持续的、静默的计费。
 *
 * 语言、退出确认那两位的读值失败只会让界面显示得不对；这一位的读值失败会花钱。
 * 所以下面几条锁的都是同一个性质：**任何不确定都必须落到"关"**。
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { openStore, SettingsRepository } from "@mycontext/store"
import { PreferencesService, WORK_LAYER_SETTING } from "@main/services/preferences.service.js"

const NOW = "2026-08-07T00:00:00.000Z"
const dirs: string[] = []

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

function makeService() {
  const dir = mkdtempSync(join(tmpdir(), "mycontext-worklayer-"))
  dirs.push(dir)
  const handle = openStore({ path: join(dir, "control.sqlite") })
  const settings = new SettingsRepository(handle.db)
  const service = new PreferencesService(settings, () => new Date(NOW))
  return { service, settings, close: () => handle.close() }
}

describe("★★ 工作层开关：默认必须是关", () => {
  it("★★ 全新安装（没存过）→ 关", () => {
    const ctx = makeService()
    expect(ctx.service.workLayerEnabled(), "默认开着 = 用户没同意就开始计费").toBe(false)
    ctx.close()
  })

  /**
   * ★★ 脏值必须落到"关"，不能落到"开"。
   *
   * 这几个值都是真实会出现的：旧版本写的 `"1"`、手改坏的库、迁移写了空串。
   * 判据刻意是"只认字面的 `true`"而不是 `raw !== "false"` —— 后者会让上面
   * 任何一个脏值都变成"开",于是一次数据损坏的后果是**开始花钱**。
   */
  it.each([["1"], ["yes"], ["TRUE"], [""], ["{broken json"]])(
    "★★ 脏值 %j → 关（只认字面的 true）",
    (raw) => {
      const ctx = makeService()
      ctx.settings.set(WORK_LAYER_SETTING, raw, NOW)
      expect(ctx.service.workLayerEnabled(), `脏值 ${raw} 不该被当成"开"`).toBe(false)
      ctx.close()
    },
  )

  it("显式打开 → 开；再关 → 关（能来回改，不是单向阀）", () => {
    const ctx = makeService()
    ctx.service.setWorkLayerEnabled(true)
    expect(ctx.service.workLayerEnabled()).toBe(true)
    ctx.service.setWorkLayerEnabled(false)
    expect(ctx.service.workLayerEnabled()).toBe(false)
    ctx.close()
  })

  /**
   * 存的是字面量而不是 JSON / 0-1：`app_settings` 是 TEXT 列，而
   * `"true"` / `"false"` 与 `quitConfirmSuppressed` 那一位同形 ——
   * 两位偏好在库里长得一样，读的人不用记两套编码。
   */
  it("落库形态是字面的 true/false", () => {
    const ctx = makeService()
    ctx.service.setWorkLayerEnabled(true)
    expect(ctx.settings.get(WORK_LAYER_SETTING)).toBe("true")
    ctx.service.setWorkLayerEnabled(false)
    expect(ctx.settings.get(WORK_LAYER_SETTING)).toBe("false")
    ctx.close()
  })

  /**
   * ★ 与退出确认那一位互不干扰。
   *
   * 两位都存在同一张 `app_settings` 里，key 写错（复制粘贴时改漏）会让
   * "关掉工作层"顺手把退出确认也改了 —— 而那种串写在界面上极难发现。
   */
  it("★ 不串写：改工作层不影响退出确认", () => {
    const ctx = makeService()
    ctx.service.setQuitConfirmSuppressed(true)
    ctx.service.setWorkLayerEnabled(true)
    expect(ctx.service.quitConfirmSuppressed()).toBe(true)
    ctx.service.setWorkLayerEnabled(false)
    expect(ctx.service.quitConfirmSuppressed(), "被工作层开关串写了").toBe(true)
    ctx.close()
  })
})
