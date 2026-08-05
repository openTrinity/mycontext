import js from "@eslint/js"
import globals from "globals"
import tseslint from "typescript-eslint"
import reactHooks from "eslint-plugin-react-hooks"

/**
 * 分层依赖规则。
 *
 * 目标：让「依赖图是一棵树」这件事有强制手段，而不是靠人记。
 * 之前只有一条「packages/* 禁 electron」，层级完全无约束——
 * 那么 persona 会 import search、L2 会 import L3，最终依赖图退化成图，
 * 那时再拆的成本是数量级的。
 *
 * 层次（实际形状，与仓库现状一致）：
 *   L0 树根：kernel                          — 不依赖任何 @mycontext 包
 *   L1 契约层：ipc-contract / i18n           — 只可依赖 kernel（Result 等基础类型）
 *                                              与彼此（i18n 需要 ipc-contract 的 Language）
 *   L2 能力层：store / runtime-env / design / module-contract  — 只依赖 L0+L1
 *   L3 业务层：ingest / retrieval / agent-runtime / distill / persona /
 *              knowledge-feed / channels     — 可依赖 L0+L1+L2
 *
 * 两条铁律：① 不许反向（下层不 import 上层）；② 同层横向只允许显式白名单
 * （persona 与 search 互不可见 —— 一个模块的 injection 不该能看到另一个的数据）。
 *
 * 配一条会红的负例测试（tests/unit/eslint-layering.test.ts）：
 * 规则 glob 写错与规则生效**外观完全相同**，不测就等于没写。
 */
const L2_PACKAGES = ["store", "runtime-env", "design", "module-contract"]
const L3_PACKAGES = [
  "ingest",
  "retrieval",
  "agent-runtime",
  "distill",
  "persona",
  "knowledge-feed",
  "channels",
]

const layeringRules = [
  {
    // L0（kernel）：树根，不得依赖任何其它 @mycontext 包。
    files: ["packages/kernel/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: ["@mycontext/*"],
              message: "kernel 是依赖树的根，不得依赖任何其它包",
            },
          ],
          paths: [{ name: "electron", message: "packages/* 不得依赖 electron" }],
        },
      ],
    },
  },
  {
    // L1（契约层）：只可依赖 kernel 与彼此。
    files: ["packages/ipc-contract/**/*.ts", "packages/i18n/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [...L2_PACKAGES, ...L3_PACKAGES].map((name) => `@mycontext/${name}`),
              message: "L1（ipc-contract/i18n）只可依赖 kernel 与彼此，不得依赖 L2/L3",
            },
          ],
          paths: [{ name: "electron", message: "packages/* 不得依赖 electron" }],
        },
      ],
    },
  },
  {
    // L2：不得依赖 L3。
    files: [
      "packages/store/**/*.ts",
      "packages/runtime-env/**/*.ts",
      "packages/design/**/*.tsx",
      "packages/design/**/*.ts",
      "packages/module-contract/**/*.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: L3_PACKAGES.map((name) => `@mycontext/${name}`),
              message: "L2（store/runtime-env/design/module-contract）不得依赖 L3 业务包",
            },
          ],
          paths: [{ name: "electron", message: "packages/* 不得依赖 electron" }],
        },
      ],
    },
  },
  {
    // 数字人与搜索互不可见（两个 Agent 系统刻意完全独立）。
    files: ["packages/persona/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            { group: ["@mycontext/search*"], message: "persona 与 search 模块不得互相依赖" },
            { group: ["**/apps/**"], message: "packages/* 不得依赖 apps/*" },
          ],
          paths: [{ name: "electron", message: "packages/* 不得依赖 electron" }],
        },
      ],
    },
  },
]

export default tseslint.config(
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/out/**",
      "**/coverage/**",
      "**/.tsbuild/**",
      // 他人代码与二进制：不在我们的格式/规则管辖范围内。
      // 不排除的话 lint 会去解析算法团队的那份代码。
      "kl-graph/**",
      "vendor/**",
      // 打包用的 Python 产物（build-python-bundle.mjs 从 vendor/python 压平
      // 出来的，含 CPython 标准库 + 154 个第三方包）。与 `vendor/**` 同一个
      // 理由 —— 不排除的话 lint 会去解析别人的 .js（实测 3444 条报错）。
      "apps/*/resources/python/**",
      // 打包产物（.app 里含 Electron 自带的 .js + 上面那份 Python）。
      "apps/*/release/**",
    ],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ["**/*.{ts,tsx}"],
    languageOptions: {
      ecmaVersion: 2023,
      globals: { ...globals.node, ...globals.browser },
    },
    rules: {
      "@typescript-eslint/no-unused-vars": [
        "error",
        { argsIgnorePattern: "^_", varsIgnorePattern: "^_" },
      ],
      "@typescript-eslint/consistent-type-imports": "error",
      "no-console": ["error", { allow: ["error"] }],
    },
  },
  {
    files: ["apps/desktop/src/renderer/**/*.tsx"],
    plugins: { "react-hooks": reactHooks },
    rules: {
      "react-hooks/rules-of-hooks": "error",
      "react-hooks/exhaustive-deps": "warn",
    },
  },
  {
    // 领域包不得依赖 Electron：保证可在 Node / 测试中直接运行。
    files: ["packages/**/*.ts"],
    rules: {
      "no-restricted-imports": [
        "error",
        { paths: [{ name: "electron", message: "packages/* 不得依赖 electron" }] },
      ],
    },
  },
  ...layeringRules,
  {
    /**
     * 时间敏感逻辑禁用裸 `Date.now()`。
     *
     * 这些包里的 TTL（授权过期）、工作时间、频率上限、LRU 空闲回收、
     * 心跳超期、租约续租、dry-run 冻结时间全都依赖「现在几点」。
     * 不注入时钟的话，这些行为只能靠 `sleep` 测 —— 又慢又不稳，
     * 7 天心跳这种压根测不了。改为构造注入 `Clock`（@mycontext/kernel）。
     */
    files: [
      "packages/persona/**/*.ts",
      "packages/ingest/**/*.ts",
      "packages/knowledge-feed/**/*.ts",
      "packages/retrieval/**/*.ts",
      "packages/distill/**/*.ts",
    ],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: "CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message: "禁用裸 Date.now()：注入 @mycontext/kernel 的 Clock（否则时间相关行为无法测试）",
        },
        {
          selector: "NewExpression[callee.name='Date'][arguments.length=0]",
          message: "禁用无参 new Date()：注入 @mycontext/kernel 的 Clock",
        },
      ],
    },
  },
  {
    files: ["scripts/**/*.mjs", "*.mjs", "*.config.ts"],
    languageOptions: {
      ecmaVersion: 2023,
      sourceType: "module",
      globals: globals.node,
    },
    rules: { "no-console": "off" },
  },
)
