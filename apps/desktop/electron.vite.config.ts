import { existsSync, readdirSync, readFileSync } from "node:fs"
import { createRequire } from "node:module"
import { dirname, resolve } from "node:path"
import react from "@vitejs/plugin-react"
import tailwindcss from "@tailwindcss/vite"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"

const root = import.meta.dirname
const repoRoot = resolve(root, "../..")

/**
 * 开发服务器端口：从仓库根的 .env 读 MYCONTEXT_DEV_PORT，真实环境变量优先。
 *
 * 这里必须自己解析 .env——vite 的 loadEnv 只认 VITE_ 前缀且作用于 renderer，
 * 而端口是构建期配置，需要在 defineConfig 求值时就拿到。
 * 与主进程共用一份 .env，避免两处配置漂移。
 */
function resolveDevPort(): number {
  const fromEnv = process.env["MYCONTEXT_DEV_PORT"]
  if (fromEnv !== undefined && fromEnv.trim() !== "") return Number.parseInt(fromEnv, 10)

  try {
    const content = readFileSync(resolve(repoRoot, ".env"), "utf8")
    for (const line of content.split(/\r?\n/)) {
      const trimmed = line.trim()
      if (trimmed === "" || trimmed.startsWith("#")) continue
      const separator = trimmed.indexOf("=")
      if (separator === -1) continue
      if (trimmed.slice(0, separator).trim() !== "MYCONTEXT_DEV_PORT") continue
      const value = trimmed
        .slice(separator + 1)
        .trim()
        .replace(/^["']|["']$/g, "")
      if (value !== "") return Number.parseInt(value, 10)
    }
  } catch {
    // .env 可选，缺失时用默认端口。
  }
  // 默认避开 5173：那是 Vite 全局默认值，本机同时跑多个 Vite 项目时必撞。
  return 5273
}

const devPort = resolveDevPort()

/**
 * 工作区包清单，**从文件系统推导而不是手写**。
 *
 * ## 为什么必须推导
 *
 * 这两份清单原先是手写的，只列了 M1c 时主进程用到的 5 个包。
 * 之后新增的 `ingest` / `retrieval` / `knowledge-feed` / `agent-runtime`
 * 没人想起来补，于是：
 *   ① 不在 exclude 里 → `externalizeDepsPlugin` 把它们**外置**；
 *   ② 产物里留下裸的 `import … from "@mycontext/ingest"`；
 *   ③ 运行时按 pnpm 软链找到 `packages/ingest/package.json` 的
 *      `"main": "./src/index.ts"`；
 *   ④ 那个 TS 文件里写的是 `export … from "./normalizer.js"`
 *      —— TS 的 NodeNext 写法，`.js` 在编译期指向 `.ts`。
 *      而这些包**没有预编译 dist**，磁盘上根本没有 `normalizer.js`
 *      → `ERR_MODULE_NOT_FOUND`，应用直接起不来。
 *
 * 关键是**所有单测与门禁全绿**：没有任何测试加载构建产物，
 * 于是 `pnpm verify` 通过而 `pnpm dev` 崩在启动阶段。
 * 手写清单必然会被漏，所以这里改成 `readdirSync` 推导 ——
 * 新增包不需要改这个文件，也就不存在"忘了改"。
 *
 * better-sqlite3 是 native 模块，必须保持外置（见下方 build.rollupOptions）。
 */
function discoverWorkspacePackages(): string[] {
  const packagesDir = resolve(repoRoot, "packages")
  return readdirSync(packagesDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => existsSync(resolve(packagesDir, name, "src/index.ts")))
    .sort()
}

const workspacePackageNames = discoverWorkspacePackages()

/**
 * 内联进产物的模块。
 *
 * 全部工作区包 + `zod`（后者不是工作区包，但主进程要用它校验 IPC 入参，
 * 外置会让打包后的产物依赖 node_modules 布局）。
 * 列了但没被 import 的包不产生任何影响 —— exclude 只是"别外置"。
 */
/**
 * ★ `tslib` 是**给 @antv 用的**，不是我们自己 import 的。
 *
 * `@antv/component`（G6 v5 → @antv/g6 → component 的传递依赖）在它的
 * ESM 产物里 `import { __decorate } from "tslib"`，但**没有把 tslib 写进
 * 自己的 dependencies**（实测它只声明了 g / util / scale / svg-path-parser）。
 *
 * 我们的 `.npmrc` 是 `hoist=false`（幽灵依赖必须在本机就暴露），所以那个
 * 未声明的 import 解析不到 —— 表现是 `Could not resolve "tslib"`，
 * 而后果是**整个渲染层白屏**（esbuild 直接失败，页面一个字都没有）。
 *
 * 所以在 `apps/desktop/package.json` 里显式声明 tslib：它是"替第三方补一个
 * 它忘了声明的依赖"，不是我们的直接依赖。**别当成没用的包删掉。**
 */
const bundledWorkspacePackages = [
  ...workspacePackageNames.map((name) => `@mycontext/${name}`),
  "zod",
]

const packageAliases = Object.fromEntries(
  workspacePackageNames.map((name) => [
    `@mycontext/${name}`,
    resolve(repoRoot, `packages/${name}/src/index.ts`),
  ]),
)

const define = {
  __APP_VERSION__: JSON.stringify(process.env.npm_package_version ?? "0.1.0"),
}

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspacePackages })],
    define,
    resolve: {
      alias: { ...packageAliases, "@main": resolve(root, "src/main") },
    },
    build: {
      rollupOptions: {
        external: ["better-sqlite3"],
        input: { index: resolve(root, "src/main/index.ts") },
      },
    },
  },
  preload: {
    // 与 main 用同一份推导出的清单：preload 目前只 import ipc-contract，
    // 但手写一份"只列当前用到的"就是 main 那个 bug 的复刻版。
    plugins: [externalizeDepsPlugin({ exclude: bundledWorkspacePackages })],
    define,
    resolve: { alias: packageAliases },
    build: {
      lib: { entry: resolve(root, "src/preload/index.ts"), formats: ["cjs"] },
      rollupOptions: { output: { entryFileNames: "index.cjs" } },
    },
  },
  renderer: {
    root: resolve(root, "src/renderer"),
    plugins: [react(), tailwindcss()],
    define,
    server: {
      port: devPort,
      // strictPort：端口被占时直接失败，而不是静默 +1。
      // 否则主进程按约定端口连不上 dev server，表现为窗口白屏，排查成本高。
      strictPort: true,
      open: false,
    },
    resolve: {
      // 不给 @mycontext/* 设别名：pnpm workspace 已把包软链到 node_modules，
      // 走包的 exports 解析；若给包名设了指向 index.ts 的别名，
      // "@mycontext/design/index.css" 这类子路径导入会被错误解析成 index.ts 下的子路径。
      alias: {
        "@renderer": resolve(root, "src/renderer"),
        /**
         * ★ `tslib` 是**替第三方补的**，不是我们自己 import 的。
         *
         * `@antv/component`（G6 v5 的传递依赖）在它的 ESM 产物里
         * `import { __decorate } from "tslib"`，却**没有把 tslib 写进自己的
         * dependencies**（实测它只声明了 g / util / scale / svg-path-parser）。
         *
         * 我们的 `.npmrc` 是 `hoist=false`（幽灵依赖必须在本机就暴露），
         * 所以那个未声明的 import 在**它自己的目录**下解析不到 ——
         * 表现是 esbuild 报 `Could not resolve "tslib"` × 52，
         * 而后果是**整个渲染层白屏**（页面一个字都没有）。
         *
         * 为什么用别名而不是 `public-hoist-pattern`：后者会让 pnpm
         * 整个重装 node_modules（几分钟且要交互确认），而这里要解决的
         * 只是"让 esbuild 找到一份 tslib"。别名把作用域限定在构建配置里，
         * 且指向的是我们在 package.json 里显式声明的那一份。
         *
         * ⚠️ 别把 `tslib` 从 `apps/desktop/package.json` 里删掉 ——
         * 它看起来"没被我们 import"，但删了这里就解析不到。
         */
        /**
         * 路径用 `createRequire` 解析而不是写死 `.pnpm/tslib@2.8.1/…` ——
         * 版本号一升级那条硬编码路径就会静默失效（又是白屏）。
         */
        tslib: dirname(createRequire(import.meta.url).resolve("tslib/package.json")),
      },
    },
    build: {
      rollupOptions: { input: resolve(root, "src/renderer/index.html") },
    },
  },
})
