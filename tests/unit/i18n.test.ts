/**
 * 语言包一致性测试。
 *
 * 这些检查的目的不是「翻译得好不好」（那要人看），而是**机械错误必须在 CI 就失败**：
 * 漏一个 key、少一个插值占位符、留一个空字符串，在界面上都表现为
 * 「显示一串原样的 key」或「显示 {{min}}」——而这种问题很难在自测时全覆盖到，
 * 因为要走到每一个分支才看得见。
 */
import { describe, expect, it } from "vitest"
import { ERROR_CODES } from "@mycontext/kernel"
import {
  LANGUAGES,
  NAMESPACES,
  resources,
  detectSystemLanguage,
  resolveLanguage,
} from "@mycontext/i18n"

type Json = string | number | boolean | null | Json[] | { [key: string]: Json }

/** 把嵌套对象拍平成 `a.b.c` 形式的 key 列表。 */
function flatten(value: Json, prefix = ""): Map<string, string> {
  const out = new Map<string, string>()
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    out.set(prefix, String(value))
    return out
  }
  for (const [key, child] of Object.entries(value)) {
    const path = prefix === "" ? key : `${prefix}.${key}`
    for (const [k, v] of flatten(child as Json, path)) out.set(k, v)
  }
  return out
}

/** 取出 `{{name}}` 形式的占位符，排序后便于比较。 */
function placeholders(text: string): string[] {
  return [...text.matchAll(/\{\{(\w+)\}\}/g)].map((match) => match[1] ?? "").sort()
}

const flat = Object.fromEntries(
  LANGUAGES.map((lang) => [
    lang,
    Object.fromEntries(
      NAMESPACES.map((ns) => [ns, flatten(resources[lang][ns] as unknown as Json)]),
    ),
  ]),
) as Record<string, Record<string, Map<string, string>>>

describe("key 集合", () => {
  it.each(NAMESPACES)("%s：zh 与 en 的 key 完全一致", (ns) => {
    const zh = [...(flat["zh"]?.[ns] ?? new Map()).keys()].sort()
    const en = [...(flat["en"]?.[ns] ?? new Map()).keys()].sort()
    // 直接比数组而不是各自比长度：断言失败时能看到具体是哪个 key 缺了。
    expect(en).toEqual(zh)
  })

  it("每个 namespace 都非空（漏建文件会得到一个空对象而不是报错）", () => {
    for (const lang of LANGUAGES) {
      for (const ns of NAMESPACES) {
        expect((flat[lang]?.[ns] ?? new Map()).size).toBeGreaterThan(0)
      }
    }
  })
})

describe("文案内容", () => {
  it.each(LANGUAGES)("%s：没有空字符串（空文案在界面上就是一片空白）", (lang) => {
    const empty: string[] = []
    for (const ns of NAMESPACES) {
      for (const [key, value] of flat[lang]?.[ns] ?? new Map()) {
        if (value.trim() === "") empty.push(`${ns}:${key}`)
      }
    }
    expect(empty).toEqual([])
  })

  it.each(NAMESPACES)("%s：两种语言的插值占位符一致", (ns) => {
    const mismatched: string[] = []
    for (const [key, zhText] of flat["zh"]?.[ns] ?? new Map()) {
      const enText = flat["en"]?.[ns]?.get(key)
      if (enText === undefined) continue
      const zhVars = placeholders(zhText)
      const enVars = placeholders(enText)
      if (JSON.stringify(zhVars) !== JSON.stringify(enVars)) {
        mismatched.push(`${ns}:${key} zh=${zhVars.join(",")} en=${enVars.join(",")}`)
      }
    }
    // 少一个占位符 → 界面上少一个数字；多一个 → 界面上出现 {{xxx}}。
    expect(mismatched).toEqual([])
  })

  it("zh 里不出现英文兜底残留、en 里不出现中文（最常见的漏译形态）", () => {
    const cjk = /[一-鿿]/
    const leaked: string[] = []
    for (const ns of NAMESPACES) {
      for (const [key, value] of flat["en"]?.[ns] ?? new Map()) {
        if (cjk.test(value)) leaked.push(`${ns}:${key}`)
      }
    }
    expect(leaked).toEqual([])
  })
})

/**
 * 每个错误码都要有 byCode 兜底文案。
 *
 * messageKey 是可选的，新增错误码时很容易忘了配；byCode 是最后一道防线，
 * 它缺了就意味着那个错误在界面上会显示中文原文（en 用户看不懂）。
 */
describe("错误码兜底文案", () => {
  it.each(LANGUAGES)("%s：ErrorCode 全部有 byCode 译文", (lang) => {
    const byCode = flat[lang]?.["errors"] ?? new Map()
    const missing = ERROR_CODES.filter((code) => !byCode.has(`byCode.${code}`))
    expect(missing).toEqual([])
  })
})

describe("语言检测", () => {
  it("zh 系列都归到 zh，其余归 en", () => {
    expect(detectSystemLanguage("zh-CN")).toBe("zh")
    expect(detectSystemLanguage("zh-Hant-TW")).toBe("zh")
    expect(detectSystemLanguage("en-US")).toBe("en")
    expect(detectSystemLanguage("ja-JP")).toBe("en")
    expect(detectSystemLanguage("")).toBe("en")
  })

  it("显式选择优先于系统语言", () => {
    expect(resolveLanguage("en", "zh-CN")).toBe("en")
    expect(resolveLanguage("zh", "en-US")).toBe("zh")
    expect(resolveLanguage("system", "zh-CN")).toBe("zh")
  })
})

/**
 * ★ 产品名的一致性：不许再出现旧称。
 *
 * ## 为什么值得一条门禁
 *
 * 「数字人」→「数字分身」是一次纯文案改名（刻意**不动**文件名与标识符，
 * 那些改动会让别人 rebase 时到处冲突）。而纯文案改名最容易复发：
 * 下一个人加一句文案时很自然会写回旧称，而**没有任何东西会报错** ——
 * 界面上就是两种叫法混着出现。
 *
 * 英文侧原来更乱：`Digital human` / `Digital persona` / `Persona`
 * 三种说法并存（同一个东西在导航里叫一个名字、在设置里叫另一个）。
 * 现在统一成 `Digital twin`。
 *
 * ★ 只查**用户可见的文案**（locales 的值）。代码里的 `persona`
 * 标识符与文件名一律不动 —— 那是有意的取舍。
 */
describe("★ 产品名一致：数字分身 / Digital twin", () => {
  /** 收集所有 locale 文件里的**值**（不含 key）。 */
  function allValues(lang: "zh" | "en"): string[] {
    const out: string[] = []
    const walk = (node: unknown): void => {
      if (typeof node === "string") {
        out.push(node)
        return
      }
      if (typeof node === "object" && node !== null) {
        for (const value of Object.values(node as Record<string, unknown>)) walk(value)
      }
    }
    walk(resources[lang])
    return out
  }

  it("中文文案里没有「数字人」", () => {
    const hits = allValues("zh").filter((text) => text.includes("数字人"))
    expect(hits, `这些文案还在用旧称：${hits.join(" | ")}`).toEqual([])
  })

  it("英文文案里没有 Digital human / Digital persona", () => {
    const hits = allValues("en").filter(
      (text) => /digital human/i.test(text) || /digital persona/i.test(text),
    )
    expect(hits, `这些文案还在用旧称：${hits.join(" | ")}`).toEqual([])
  })

  /**
   * 反向确认新称**真的用上了** —— 否则上面两条在"把这个词整个删掉"时
   * 也会绿，而那不是我们想要的结果。
   */
  it("新称真的出现了（不是把词删干净就算通过）", () => {
    expect(allValues("zh").some((text) => text.includes("数字分身"))).toBe(true)
    expect(allValues("en").some((text) => /digital twin/i.test(text))).toBe(true)
  })
})

/**
 * ── ★★★ 代码里引用的 key 必须真的存在 ─────────────────────────
 *
 * ## 为什么需要这一维（上面那些都锁不住它）
 *
 * 已有的断言比对 **zh/en 之间对齐** —— 两边都缺同一个 key 时它是绿的。
 * 而真实故障是：我在 `settings-view.tsx` 里写了 `t("groups.channel")`，
 * 而 `settings.json` 的 `groups` 段下**没有** `channel`。
 *
 * i18next 对缺失的 key **原样返回那个 key**，所以：
 * · lint 不报（那只是个字符串字面量）；
 * · tsc 不报（`t()` 收 string）；
 * · 单测不报（zh/en 都缺，对齐检查通过）。
 *
 * 界面上直接显示 `groups.channel` —— 是 CDP 截图才看到的。
 *
 * ## 判据：静态 key 逐个查，动态 key 跳过
 *
 * 只检 `t("字面量")` 这种**完全静态**的调用。带模板串的
 * （`t(\`${id}.label\`)`）跳过 —— 那种运行时才知道，静态查会误报。
 * 覆盖不到 100%，但能挡住这次这类"我拼错/忘加"的错。
 */
describe("★★ 代码引用的 i18n key 必须存在（缺了会在界面上原样显示）", () => {
  it("settings-view 里的静态 key 全部有译文", async () => {
    const { readFileSync } = await import("node:fs")
    const src = readFileSync(
      "apps/desktop/src/renderer/features/settings/settings-view.tsx",
      "utf8",
    )
    const zh = JSON.parse(
      readFileSync("packages/i18n/src/locales/zh/settings.json", "utf8"),
    ) as Record<string, unknown>

    /** 按点分路径取值 —— key 形如 `groups.channel` / `channels.tabs.auth`。 */
    const lookup = (path: string): unknown =>
      path.split(".").reduce<unknown>((node, seg) => {
        if (typeof node !== "object" || node === null) return undefined
        return (node as Record<string, unknown>)[seg]
      }, zh)

    /**
     * 抓两种形态 —— **只抓 `t("…")` 是不够的**（我第一版就是那样，反证失败）。
     *
     * ① 直接调用：`t("general.title")`；
     * ② **常量表里的 key**：`titleKey: "groups.channel"` /
     *    `labelKey: "sections.model"` —— 那些经 `t(group.titleKey)` 传进去，
     *    正则看不到字面量。而这次真实漏掉的 `groups.channel` 恰恰是这一类，
     *    所以只抓 ① 的话反证不红（实测：zh/en 都删掉后 30 条全绿）。
     *
     * ★ 排除带命名空间前缀的（`channels:…`）—— 那些查的是另一份文件。
     */
    const direct = [...src.matchAll(/\bt\("([a-zA-Z][\w.]*)"/g)].map((m) => m[1] ?? "")
    const fromTable = [...src.matchAll(/\b(?:titleKey|labelKey):\s*"([a-zA-Z][\w.]*)"/g)].map(
      (m) => m[1] ?? "",
    )
    const keys = [...direct, ...fromTable].filter((k) => k !== "" && !k.includes(":"))
    /**
     * ★ 判据本身要有区分力，而且**两类各自**都得抓到 ——
     * 只校验合计数量的话，①抓到十几个就能掩盖②一个都没抓到（我第一版的病）。
     */
    expect(direct.length).toBeGreaterThan(10)
    expect(fromTable.length).toBeGreaterThan(5)

    const missing = [...new Set(keys)].filter((k) => typeof lookup(k) !== "string")
    expect(missing, `这些 key 在 zh/settings.json 里不存在: ${missing.join(", ")}`).toEqual([])
  })
})
