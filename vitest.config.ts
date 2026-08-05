import { defineConfig } from "vitest/config"
import { createRequire } from "node:module"
import { resolve } from "node:path"

const root = import.meta.dirname

/** 解析锚点：`@dicebear/*` 装在 packages/design 下，不在仓库根（见下方 alias）。 */
const designRequire = createRequire(resolve(root, "packages/design/package.json"))

export default defineConfig({
  test: {
    // 默认 node 环境；需要 DOM 的测试用文件顶部的
    // `@vitest-environment jsdom` 注解单独切换（Vitest 4 已移除
    // environmentMatchGlobs，注解是官方推荐做法）。
    environment: "node",
    include: ["tests/**/*.test.ts", "tests/**/*.test.tsx"],
    reporters: ["default"],
    coverage: {
      provider: "v8",
      reporter: ["text", "html"],
      include: ["packages/*/src/**/*.ts", "packages/*/src/**/*.tsx"],
      // 产物与纯类型文件没有可执行语句，算进来只会稀释信号。
      exclude: ["**/index.ts", "**/*.d.ts", "**/types.ts", "**/migrations/**"],
      /**
       * 覆盖率下限**只**加在确定性模块上。
       *
       * 全局阈值会让人为了达标去测 getter 和 re-export，把"覆盖率"变成
       * "覆盖率游戏"。而下面这几个是纯函数/纯判定 —— 它们本来就该接近 100%，
       * 设线几乎零成本，且线一破必然是真的漏了分支。
       *
       * 含 IO / 子进程 / 模型的包刻意不设：硬指标会诱导写一堆无意义的 mock 测试。
       */
      thresholds: {
        "packages/persona/src/policy.ts": { lines: 95, functions: 95 },
        "packages/distill/src/reduce/merger.ts": { lines: 95, functions: 95 },
        "packages/retrieval/src/bigram.ts": { lines: 95, functions: 95 },
        "packages/retrieval/src/match-expr.ts": { lines: 95, functions: 95 },
        "packages/retrieval/src/quantize.ts": { lines: 95, functions: 95 },
        "packages/channels/src/plugins/dingtalk/parse.ts": { lines: 90, functions: 90 },
        "packages/agent-runtime/src/reducer.ts": { lines: 90, functions: 90 },
      },
    },
  },
  resolve: {
    alias: {
      "@mycontext/kernel": resolve(root, "packages/kernel/src/index.ts"),
      "@mycontext/ipc-contract": resolve(root, "packages/ipc-contract/src/index.ts"),
      "@mycontext/store": resolve(root, "packages/store/src/index.ts"),
      "@mycontext/runtime-env": resolve(root, "packages/runtime-env/src/index.ts"),
      "@mycontext/channels": resolve(root, "packages/channels/src/index.ts"),
      "@mycontext/design": resolve(root, "packages/design/src/index.ts"),
      "@mycontext/i18n": resolve(root, "packages/i18n/src/index.ts"),
      "@mycontext/retrieval": resolve(root, "packages/retrieval/src/index.ts"),
      "@mycontext/ingest": resolve(root, "packages/ingest/src/index.ts"),
      "@mycontext/knowledge-feed": resolve(root, "packages/knowledge-feed/src/index.ts"),
      "@mycontext/agent-runtime": resolve(root, "packages/agent-runtime/src/index.ts"),
      "@mycontext/distill": resolve(root, "packages/distill/src/index.ts"),
      "@mycontext/llm": resolve(root, "packages/llm/src/index.ts"),
      "@mycontext/persona": resolve(root, "packages/persona/src/index.ts"),
      "@main": resolve(root, "apps/desktop/src/main"),
      "@renderer": resolve(root, "apps/desktop/src/renderer"),
      /**
       * react-query 只装在 `apps/desktop` 下（它是渲染层的依赖，不是仓库根的）。
       * 从 `tests/` 里 import 渲染层组件时解析不到，报
       * `Failed to resolve import "@tanstack/react-query"` ——
       * 指到实装位置即可，不必为了测试把它提到根 package.json
       * （那会让"谁依赖它"这件事变得不真实）。
       */
      "@tanstack/react-query": resolve(
        root,
        "apps/desktop/node_modules/@tanstack/react-query/build/modern/index.js",
      ),
      /**
       * 同一个问题的另一个实例：`@dicebear/*` 只装在 `packages/design` 下。
       *
       * 从 `packages/design/src/**` 里 import 它们能解析（vite 按**引入文件**
       * 的位置找），但从 `tests/` 里**直接** import 不行。
       * 而 `figure-pinning.test.ts` 必须直接 import：它测的正是
       * DiceBear 自己的行为契约（pin 是否生效、`randomizeIds` 是否破坏确定性）
       * —— 那些是我们整个方案的地基假设，只能对着上游本体测。
       *
       * 用 `createRequire` 现算而不是写死 `.pnpm/@dicebear+core@9.4.2/…`：
       * 那个路径里带版本号与 peer hash，升级依赖就会失效，
       * 而失效的表现是"测试找不到包"而不是"路径过期了"。
       */
      ...Object.fromEntries(
        ["core", "notionists", "lorelei", "micah", "fun-emoji", "bottts", "thumbs"].map((name) => [
          `@dicebear/${name}`,
          designRequire.resolve(`@dicebear/${name}`),
        ]),
      ),
    },
  },
})
