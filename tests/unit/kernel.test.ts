import { describe, expect, it } from "vitest"
import { parseEnvFile, redact, maskValue } from "@mycontext/kernel"

describe("parseEnvFile", () => {
  it("解析基础键值、跳过注释与空行", () => {
    const parsed = parseEnvFile(
      ["# 注释", "", "A=1", "B = two ", "  # 缩进注释", "C=three"].join("\n"),
    )
    expect(parsed).toEqual({ A: "1", B: "two", C: "three" })
  })

  it("剥离引号，并保留引号内的 # 字符", () => {
    const parsed = parseEnvFile(['A="value # not comment"', "B='single'"].join("\n"))
    expect(parsed["A"]).toBe("value # not comment")
    expect(parsed["B"]).toBe("single")
  })

  it("未加引号时剥离行尾注释", () => {
    expect(parseEnvFile("A=value # trailing")["A"]).toBe("value")
  })

  it("忽略没有等号或键为空的行", () => {
    expect(parseEnvFile(["NOEQUALS", "=novalue", "OK=1"].join("\n"))).toEqual({ OK: "1" })
  })

  it("支持 CRLF 换行", () => {
    expect(parseEnvFile("A=1\r\nB=2")).toEqual({ A: "1", B: "2" })
  })
})

describe("redact", () => {
  it("遮蔽敏感 key，保留有值/无值信息", () => {
    const output = redact({
      apiKey: "sk-1234567890abcdef",
      password: "",
      name: "mycontext",
    }) as Record<string, unknown>
    expect(output["apiKey"]).toBe("sk****ef")
    expect(output["password"]).toBe("[unset]")
    expect(output["name"]).toBe("mycontext")
  })

  it("递归处理嵌套结构与数组", () => {
    const output = redact({ outer: { token: "abcdefghijkl" }, list: [{ secret: "abcdefghij" }] })
    expect(JSON.stringify(output)).not.toContain("abcdefghijkl")
    expect(JSON.stringify(output)).not.toContain("abcdefghij")
  })

  it("Error 只保留 name 与 message", () => {
    expect(redact(new TypeError("boom"))).toEqual({ name: "TypeError", message: "boom" })
  })

  it("超过深度上限时截断，不无限递归", () => {
    type Nested = { next?: Nested }
    const root: Nested = {}
    let cursor = root
    for (let index = 0; index < 12; index += 1) {
      cursor.next = {}
      cursor = cursor.next
    }
    expect(JSON.stringify(redact(root))).toContain("depth-limit")
  })

  it("短值整体遮蔽，不泄漏首尾字符", () => {
    expect(maskValue("secret12")).toBe("****")
  })
})
