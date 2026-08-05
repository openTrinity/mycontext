#!/usr/bin/env node
/**
 * 门禁：钉钉的解析测试里必须存在**带真实信封**的 fixture。
 *
 * ## 为什么这条门禁必须存在
 *
 * 它对应一个真实发生过、且**所有其它门禁与 1191 个单测都放过**的故障：
 *
 * DWS 的 `-f json` 输出带一层信封 `{arguments, errorCode, errorMsg, result, success}`，
 * 真实数据在 `result` 下。而 `message-parse.ts` 在**根对象**上找
 * `conversationMessagesList` —— 于是恒返回 `{messages: [], itemCount: 0}`。
 *
 * 表现完全静默：看起来就是"这个时间窗没有新消息"，采集器照常记成功、
 * 水位照常前移。实测 **277 页原始响应 / 1688 条消息 → 落库 0 条**。
 *
 * 而测试全绿，因为**每一个 fixture 都是从 `conversationMessagesList` 直接开始的**
 * ——照着"我以为的形状"写的 fixture，测不出"真实形状不是这样"。
 *
 * ## 这条门禁断言什么
 *
 * 不是"某个文件必须存在"（那是代理指标，改个文件名就失效）。
 * 断言的是**不变式**：至少有一个 fixture 同时具备信封的两个键
 * （`success` + `result`），且解析器能从它里面解析出非空结果。
 *
 * 后者是关键 —— 只检查"文件里有 result 字样"挡不住"有一个带信封的 fixture
 * 但没有任何测试真的把它喂给解析器"。
 *
 * ## 为什么不写成一条普通单测
 *
 * 它**也**是单测（`tests/integration/ingest/real-envelope.test.ts`）。
 * 这条门禁多守一层：防止那个文件被删掉或被改成不带信封的形态。
 * 单测断言"解析对不对"，门禁断言"那条断言还在"。
 */
import { readdirSync, readFileSync, statSync } from "node:fs"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")

/** 递归收集 tests/ 下的 .ts 文件。 */
function collect(dir) {
  const out = []
  for (const entry of readdirSync(dir)) {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) {
      out.push(...collect(path))
    } else if (entry.endsWith(".ts")) {
      out.push(path)
    }
  }
  return out
}

const testsDir = join(root, "tests")
const files = collect(testsDir)

/**
 * 找带信封的 fixture：同一个文件里同时出现 `success:` 与 `result:`，
 * 且 `result` 里嵌着 `conversationMessagesList`。
 *
 * 用文本匹配而不是 import：这个脚本在 node 下跑（没有 TS 运行时），
 * 而 import TS fixture 需要 tsx —— 给门禁加一个运行时依赖不值得。
 * 真正的语义校验由那个单测负责（见文件头）。
 */
const envelopeFixtures = files.filter((path) => {
  const text = readFileSync(path, "utf8")
  return (
    text.includes("success:") &&
    text.includes("result:") &&
    text.includes("conversationMessagesList")
  )
})

if (envelopeFixtures.length === 0) {
  console.error(
    "✗ 没有找到任何**带真实信封**的钉钉 fixture。\n" +
      "\n" +
      "  DWS 的 JSON 输出形如 {arguments, result:{conversationMessagesList,...}, success}，\n" +
      "  数据在 `result` 下。只用「从 conversationMessagesList 直接开始」的 fixture\n" +
      "  测不出「解析器读错了字段位置」—— 那个 bug 曾让 277 页响应落库 0 条，\n" +
      "  且 1191 个单测全绿。\n" +
      "\n" +
      "  请保留 tests/fixtures/dingtalk-real-payloads.ts 里的 REAL_LIST_ALL_PAGE，\n" +
      "  并确保有测试把它整个喂给 parseMessageListPage。",
  )
  process.exit(1)
}

/** 断言存在一个测试把带信封的 fixture 喂给解析器。 */
const consumers = files.filter((path) => {
  const text = readFileSync(path, "utf8")
  return text.includes("parseMessageListPage") && text.includes("REAL_LIST_ALL_PAGE")
})

if (consumers.length === 0) {
  console.error(
    "✗ 有带信封的 fixture，但**没有任何测试把它喂给 parseMessageListPage**。\n" +
      "\n" +
      "  光有 fixture 不解析等于没有这条防线：那个故障的本质是\n" +
      "  「解析器在错误的层级找字段」，只有真的解析一次才会暴露。",
  )
  process.exit(1)
}

console.log(
  `✓ 真实信封 fixture 门禁通过（${envelopeFixtures.length} 个 fixture，${consumers.length} 个测试消费它）`,
)
