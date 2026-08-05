/**
 * 「用自己的 dws」的路径配置。
 *
 * ## 这个文件锁住的核心不变量
 *
 * ① **保存前真跑一次** —— 这条链路的失效方式是"看起来一切正常"：文件在、
 *    有可执行位、签名 valid，只在真正 spawn 时被内核杀掉。而用户在 UI 上
 *    填路径比开发者跑脚本更容易填错（填成安装包 / 目录 / shell wrapper）。
 *    不验的代价是**症状跑到几百行之外**：onboarding 说「未检测到有效登录态」。
 * ② **兜底永远是随包那份** —— 用户换机器、卸了闭源包之后那条路径会失效，
 *    此时必须退回随包版，而不是让渠道整个不可用。
 * ③ **"设了但用不了"要能表达出来** —— 直接把路径清空会让用户以为自己没设过。
 */
import { describe, expect, it } from "vitest"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createLogger, ManualClock } from "@mycontext/kernel"
import { DwsSourceService } from "../../../apps/desktop/src/main/services/dws-source.service.js"

const NOW = 1_700_000_000_000
const BUNDLED = "/opt/app/resources/bin/dws-darwin-arm64"

/** 内存版 SettingsRepository（只用到 get/set/delete 三个方法）。 */
function fakeSettings() {
  const map = new Map<string, string>()
  return {
    get: (key: string) => map.get(key) ?? null,
    set: (key: string, value: string) => void map.set(key, value),
    delete: (key: string) => void map.delete(key),
    /** 测试自己看的：库里到底存了什么 */
    raw: map,
  }
}

function makeService(
  options: {
    probe?: (path: string) => string | null
    fallbackChannel?: string
    fallbackPath?: string
  } = {},
) {
  const settings = fakeSettings()
  const service = new DwsSourceService({
    settings: settings as never,
    clock: new ManualClock(NOW),
    logger: createLogger("test-dws-source", { level: "error" }),
    bundledPath: BUNDLED,
    fallbackChannel: options.fallbackChannel ?? "",
    fallbackPath: options.fallbackPath ?? "",
    // 缺省：任何路径都"能跑"，返回一个假版本号
    probeVersion: options.probe ?? (() => "dws version 9.9.9 (fake)"),
  })
  return { service, settings }
}

/** 造一个真实存在的文件（`statSync().isFile()` 要过）。 */
function realFile(name = "dws"): string {
  const dir = mkdtempSync(join(tmpdir(), "dws-source-"))
  const path = join(dir, name)
  writeFileSync(path, "#!/bin/sh\nexit 0\n")
  return path
}

describe("没设时用随包那份", () => {
  it("path() 为 null，视图报 bundled", () => {
    const { service } = makeService()
    expect(service.path()).toBeNull()
    const view = service.view()
    expect(view.configuredPath).toBeNull()
    expect(view.configuredMissing).toBe(false)
    expect(view.effectiveSource).toBe("bundled")
  })

  it("视图里的版本号来自**实际生效**那份（此时是随包）", () => {
    const seen: string[] = []
    const { service } = makeService({
      probe: (path) => {
        seen.push(path)
        return "dws version 1.0.0"
      },
    })
    expect(service.view().effectiveVersion).toBe("dws version 1.0.0")
    expect(seen).toEqual([BUNDLED])
  })
})

describe("保存路径", () => {
  it("存成功后 path() 返回它，视图报 custom", () => {
    const { service, settings } = makeService()
    const file = realFile()
    const view = service.save({ path: file })
    expect(view.configuredPath).toBe(file)
    expect(view.effectiveSource).toBe("custom")
    expect(view.configuredMissing).toBe(false)
    expect(service.path()).toBe(file)
    // 落的是应用级 app_settings 的一个 key
    expect(settings.raw.get("dws_source_path")).toBe(file)
  })

  it("★ 版本号改读**自备**那份（生效的是它）", () => {
    const file = realFile()
    const { service } = makeService({
      probe: (path) => (path === file ? "dws version 0.2.99" : "dws version 1.0.56"),
    })
    service.save({ path: file })
    expect(service.view().effectiveVersion).toBe("dws version 0.2.99")
  })

  it("null / 空串 = 清除，退回随包版", () => {
    const { service, settings } = makeService()
    service.save({ path: realFile() })
    for (const cleared of [null, "", "   "]) {
      service.save({ path: realFile() }) // 先设回来，确保每次都是"从有到无"
      expect(service.save({ path: cleared }).effectiveSource).toBe("bundled")
      expect(service.path()).toBeNull()
      expect(settings.raw.has("dws_source_path")).toBe(false)
    }
  })
})

describe("★★ 拒绝的三种情况（都要给可操作的原因）", () => {
  it("相对路径 —— 相对谁？主进程的 cwd 不是用户以为的那个目录", () => {
    const { service } = makeService()
    expect(() => service.save({ path: "./dws" })).toThrow(/绝对路径/)
    expect(() => service.save({ path: "bin/dws" })).toThrow(/绝对路径/)
  })

  it("不是文件（填成目录 / 不存在）", () => {
    const { service } = makeService()
    expect(() => service.save({ path: "/tmp" })).toThrow(/不是一个文件/)
    expect(() => service.save({ path: "/definitely/not/here/dws" })).toThrow(/不是一个文件/)
  })

  /**
   * ★★ 这条是这个 service 的全部意义。
   *
   * 文件在、路径也对，但**跑不起来**（被内核 SIGKILL / 不是可执行文件 /
   * 是个安装包）。拒绝保存，让"填错路径"当场可见 —— 而不是存下去之后
   * 在 onboarding 里表现成「授权流程结束但未检测到有效登录态」。
   */
  it("★★ 文件存在但跑不出版本号 → 拒绝保存，且不落库", () => {
    const { service, settings } = makeService({ probe: () => null })
    const file = realFile()
    expect(() => service.save({ path: file })).toThrow(/跑不起来/)
    expect(service.path()).toBeNull()
    expect(settings.raw.has("dws_source_path")).toBe(false)
  })

  it("拒绝时抛 CONFIG_INVALID（UI 可按错误码翻译）", () => {
    const { service } = makeService({ probe: () => null })
    try {
      service.save({ path: realFile() })
      expect.unreachable("应该抛错")
    } catch (error) {
      expect((error as { code?: string }).code).toBe("CONFIG_INVALID")
    }
  })
})

/**
 * ★★ 兜底：设过的路径后来失效了（换机器 / 卸载了闭源包）。
 *
 * 必须**退回随包版**并且**说出来**。两件事都不能少：
 * · 不退回 → 渠道整个不可用，而用户不知道是路径的问题；
 * · 不说出来（直接清空 configuredPath）→ 用户以为自己没设过。
 */
describe("★★ 设了但文件不见了", () => {
  it("effectiveSource 退回 bundled，同时 configuredMissing 为真", () => {
    const { service, settings } = makeService()
    // 绕过 save 的校验，直接把一条失效路径塞进库（模拟换机器后的状态）
    settings.raw.set("dws_source_path", "/gone/dws")

    const view = service.view()
    expect(view.configuredPath).toBe("/gone/dws")
    expect(view.configuredMissing).toBe(true)
    expect(view.effectiveSource).toBe("bundled")
  })

  it("★ 此时版本号读的是随包那份（生效的是它）", () => {
    const seen: string[] = []
    const { service, settings } = makeService({
      probe: (path) => {
        seen.push(path)
        return "v-bundled"
      },
    })
    settings.raw.set("dws_source_path", "/gone/dws")
    expect(service.view().effectiveVersion).toBe("v-bundled")
    expect(seen).toEqual([BUNDLED])
  })
})

/**
 * ★★ 渠道号是**自有 dws 的附属项**，不是并列的独立开关。
 *
 * 渠道号（`DWS_CHANNEL`）绑定的是**分发方身份** —— 上游把它当 `channelCode`
 * 发给服务端，与那份二进制内置的 OAuth clientId 是配套的。把它用在随包的
 * 开源版上是**错的配对**：那份用自己的内置身份，配上别人的渠道号只会让
 * 服务端拒绝，而症状是授权阶段一个费解的错误。
 *
 * 所以「只在用了自有 dws 时才生效」是这一组的核心不变量。
 */
describe("★★ 渠道号从属于自有 dws", () => {
  it("没设路径时，用户填的渠道号**不生效**（回落默认层）", () => {
    const { service } = makeService()
    service.save({ channelCode: "some-channel" })
    // 存下来了（用户填过的东西不丢）
    expect(service.view().channelCode).toBe("some-channel")
    // 但不生效 —— 随包版必须用它自己的内置身份
    expect(service.channel()).toBe("")
    expect(service.view().channelActive).toBe(false)
  })

  it("设了可用的路径 → 同一个渠道号立即生效", () => {
    const { service } = makeService()
    service.save({ channelCode: "some-channel" })
    service.save({ path: realFile() })
    expect(service.channel()).toBe("some-channel")
    expect(service.view().channelActive).toBe(true)
  })

  it("★ 路径失效后渠道号自动停用（不跟着随包版走）", () => {
    const { service, settings } = makeService()
    service.save({ path: realFile() })
    service.save({ channelCode: "some-channel" })
    expect(service.channel()).toBe("some-channel")

    // 模拟换机器：路径还在库里，但文件不见了
    settings.raw.set("dws_source_path", "/gone/dws")
    expect(service.channel()).toBe("")
    expect(service.view().channelActive).toBe(false)
    // ★ 但仍然回显用户填过的值 —— 否则用户以为自己没填过
    expect(service.view().channelCode).toBe("some-channel")
  })

  it("★ 清掉路径后渠道号也不再生效", () => {
    const { service } = makeService()
    service.save({ path: realFile(), channelCode: "some-channel" })
    expect(service.channel()).toBe("some-channel")
    service.save({ path: null })
    expect(service.channel()).toBe("")
  })

  /**
   * ★ 默认层（`.env` / 环境变量）**不受**这条限制：那是分发方在部署时
   * 注入的，它自己知道配的是哪份二进制。
   */
  it("★ 默认层的渠道号不受「必须自有 dws」限制", () => {
    const { service } = makeService({ fallbackChannel: "from-env" })
    expect(service.channel()).toBe("from-env")
    expect(service.view().channelFromDefaults).toBe("from-env")
    // 用户没填 → 视图里 channelCode 为 null，UI 才能区分两个来源
    expect(service.view().channelCode).toBeNull()
  })

  it("用户填的覆盖默认层（且仅在自有 dws 生效时）", () => {
    const { service } = makeService({ fallbackChannel: "from-env" })
    service.save({ path: realFile(), channelCode: "from-user" })
    expect(service.channel()).toBe("from-user")
    service.save({ channelCode: null })
    expect(service.channel()).toBe("from-env")
  })
})

describe("渠道号的格式校验（只挡明显填错的）", () => {
  it.each(["has space", "带中文", "tab\there"])("拒绝 %j", (bad) => {
    const { service } = makeService()
    expect(() => service.save({ channelCode: bad })).toThrow(/格式/)
  })

  it("过长拒绝", () => {
    const { service } = makeService()
    expect(() => service.save({ channelCode: "a".repeat(201) })).toThrow(/格式/)
  })

  /**
   * ★ 不猜渠道号的具体形态：实测见过 40 位十六进制串，也有产品名式短串。
   * 收紧成某一种会把另一种拒掉，而那时用户完全没有出路。
   */
  it.each(["0123456789abcdef0123456789abcdef01234567", "SomeProduct", "a-b_c.1"])(
    "★ 放行各种真实形态 %j",
    (good) => {
      const { service } = makeService()
      expect(() => service.save({ channelCode: good })).not.toThrow()
      expect(service.view().channelCode).toBe(good)
    },
  )

  /** ★★ 两项独立：只改渠道号不该把路径顺手清掉（静默的数据丢失）。 */
  it("★★ 只传 channelCode 时路径不动", () => {
    const { service } = makeService()
    const file = realFile()
    service.save({ path: file })
    service.save({ channelCode: "x" })
    expect(service.path()).toBe(file)
  })

  it("★★ 只传 path 时渠道号不动", () => {
    const { service } = makeService()
    service.save({ path: realFile(), channelCode: "keep-me" })
    service.save({ path: realFile() })
    expect(service.view().channelCode).toBe("keep-me")
  })
})

/**
 * ★★ 三层解析：**UI 值 > `.env`/环境变量 > 随包那份**。
 *
 * 为什么 UI 优先：「最后一次显式操作」应该生效。用户在界面上改完却被一个
 * 几个月前写在 `.env` 里的值盖住，那是无从排查的。
 * 反过来，`.env` 那层存在的意义是 CI/脚本能不碰 UI 就切换。
 */
describe("★★ .env 层与 UI 层的优先级", () => {
  it(".env 配了路径 → 直接生效（不必碰 UI）", () => {
    const envPath = realFile()
    const { service } = makeService({ fallbackPath: envPath })
    expect(service.path()).toBe(envPath)
    // 但输入框回显的是"UI 上填的"（此时为空）——两个来源要能区分
    expect(service.view().configuredPath).toBeNull()
    expect(service.view().pathFromDefaults).toBe(envPath)
  })

  it("★ UI 值覆盖 .env", () => {
    const envPath = realFile()
    const uiPath = realFile()
    const { service } = makeService({ fallbackPath: envPath })
    service.save({ path: uiPath })
    expect(service.path()).toBe(uiPath)
  })

  it("★ UI 上清空 → 回落到 .env 那条（不是直接退到随包版）", () => {
    const envPath = realFile()
    const { service } = makeService({ fallbackPath: envPath })
    service.save({ path: realFile() })
    service.save({ path: null })
    expect(service.path()).toBe(envPath)
  })

  it("两层都空 → null（用随包那份）", () => {
    const { service } = makeService()
    expect(service.path()).toBeNull()
    expect(service.view().pathFromDefaults).toBeNull()
  })

  /**
   * ★ `.env` 指的路径也让渠道号生效 —— 判据是"有没有在用自有 dws"，
   * 而不是"这条路径从哪来"。
   */
  it("★ .env 指的自有 dws 同样让 UI 填的渠道号生效", () => {
    const { service } = makeService({ fallbackPath: realFile() })
    service.save({ channelCode: "ui-ch" })
    expect(service.channel()).toBe("ui-ch")
    expect(service.view().channelActive).toBe(true)
  })
})
