/**
 * 分层依赖规则的负例测试。
 *
 * 为什么必须有：`no-restricted-imports` 的 glob 写错（比如 `files` 的路径
 * 没匹配上、`group` 的模式漏了一个 `*`）与规则生效**外观完全相同** ——
 * lint 一样绿。而依赖图退化成图这件事，等到发现时再拆的成本是数量级的。
 *
 * 做法：用 ESLint 的 programmatic API 对**构造出来的**违规代码跑 lint。
 * 不依赖仓库里恰好存在一处违规 —— 那会在有人把它修掉时静默失去覆盖。
 */
import { resolve } from "node:path"
import { describe, expect, it } from "vitest"
import { ESLint } from "eslint"
import type { Linter } from "eslint"

const root = resolve(import.meta.dirname, "../..")

async function lintAs(pkgPath: string, code: string): Promise<Linter.LintMessage[]> {
  const eslint = new ESLint({ cwd: root })
  const [result] = await eslint.lintText(code, {
    filePath: resolve(root, pkgPath),
    warnIgnored: false,
  })
  return result?.messages ?? []
}

function importViolations(messages: Linter.LintMessage[]): Linter.LintMessage[] {
  return messages.filter((message) => message.ruleId === "no-restricted-imports")
}

describe("L0（kernel）是树根", () => {
  it("kernel import store → 报错", async () => {
    const messages = await lintAs(
      "packages/kernel/src/__lint_probe__.ts",
      'import { openStore } from "@mycontext/store"\nexport const x = openStore\n',
    )
    expect(importViolations(messages).length, JSON.stringify(messages)).toBeGreaterThan(0)
  })

  it("kernel import agent-runtime → 报错", async () => {
    const messages = await lintAs(
      "packages/kernel/src/__lint_probe__.ts",
      'import type { X } from "@mycontext/agent-runtime"\nexport type Y = X\n',
    )
    expect(importViolations(messages).length).toBeGreaterThan(0)
  })

  it("kernel import ipc-contract → 也报错（树根不依赖任何包）", async () => {
    const messages = await lintAs(
      "packages/kernel/src/__lint_probe__.ts",
      'import type { X } from "@mycontext/ipc-contract"\nexport type Y = X\n',
    )
    expect(importViolations(messages).length).toBeGreaterThan(0)
  })
})

describe("L1（契约层）只可依赖 kernel 与彼此", () => {
  it("ipc-contract import kernel → 允许（Result 等基础类型）", async () => {
    const messages = await lintAs(
      "packages/ipc-contract/src/__lint_probe__.ts",
      'import type { Result } from "@mycontext/kernel"\nexport type Y = Result<number>\n',
    )
    expect(importViolations(messages)).toEqual([])
  })

  it("i18n import ipc-contract → 允许（需要 Language 类型）", async () => {
    const messages = await lintAs(
      "packages/i18n/src/__lint_probe__.ts",
      'import type { Language } from "@mycontext/ipc-contract"\nexport type Y = Language\n',
    )
    expect(importViolations(messages)).toEqual([])
  })

  it("ipc-contract import store → 报错（不得依赖 L2）", async () => {
    const messages = await lintAs(
      "packages/ipc-contract/src/__lint_probe__.ts",
      'import type { X } from "@mycontext/store"\nexport type Y = X\n',
    )
    expect(importViolations(messages).length, JSON.stringify(messages)).toBeGreaterThan(0)
  })

  it("i18n import persona → 报错（不得依赖 L3）", async () => {
    const messages = await lintAs(
      "packages/i18n/src/__lint_probe__.ts",
      'import type { X } from "@mycontext/persona"\nexport type Y = X\n',
    )
    expect(importViolations(messages).length).toBeGreaterThan(0)
  })
})

describe("L2 不得依赖 L3", () => {
  it.each(["ingest", "retrieval", "agent-runtime", "distill", "persona", "knowledge-feed"])(
    "store import %s → 报错",
    async (l3) => {
      const messages = await lintAs(
        "packages/store/src/__lint_probe__.ts",
        `import type { X } from "@mycontext/${l3}"\nexport type Y = X\n`,
      )
      expect(importViolations(messages).length, `${l3} 未被拦住`).toBeGreaterThan(0)
    },
  )

  it("store import kernel → 允许（L2 可依赖 L1）", async () => {
    const messages = await lintAs(
      "packages/store/src/__lint_probe__.ts",
      'import { AppError } from "@mycontext/kernel"\nexport const x = AppError\n',
    )
    expect(importViolations(messages)).toEqual([])
  })
})

describe("persona 与 search 互不可见", () => {
  it("persona import apps/* → 报错", async () => {
    const messages = await lintAs(
      "packages/persona/src/__lint_probe__.ts",
      'import { x } from "../../../apps/desktop/src/main/index.js"\nexport const y = x\n',
    )
    expect(importViolations(messages).length, JSON.stringify(messages)).toBeGreaterThan(0)
  })

  it("persona import retrieval → 允许（共享的 L3 检索能力）", async () => {
    const messages = await lintAs(
      "packages/persona/src/__lint_probe__.ts",
      'import type { X } from "@mycontext/retrieval"\nexport type Y = X\n',
    )
    expect(importViolations(messages)).toEqual([])
  })
})

describe("packages/* 一律禁 electron（既有规则的回归）", () => {
  it.each(["kernel", "store", "persona", "channels"])("%s import electron → 报错", async (pkg) => {
    const messages = await lintAs(
      `packages/${pkg}/src/__lint_probe__.ts`,
      'import { app } from "electron"\nexport const x = app\n',
    )
    expect(importViolations(messages).length, `${pkg} 未被拦住`).toBeGreaterThan(0)
  })
})
