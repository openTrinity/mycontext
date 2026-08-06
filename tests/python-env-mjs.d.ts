/**
 * `scripts/lib/python-env.mjs` 的最小类型声明。
 *
 * ## 为什么需要它
 *
 * 这个模块是纯 JS 脚本（打包/启动阶段跑，不进 tsc 的 `-b` 工程），
 * 而 `tsconfig.base.json` 没开 `allowJs` —— 于是 `python-env-*.test.ts`
 * 里 `await import("…/python-env.mjs")` 会报 `TS7016：隐式 any`。
 *
 * 那两个测试是**故意**直接 import 这份 JS（见文件头注释：不想为测试再维护
 * 一份 TS 副本，两份实现迟早漂移），vitest 运行时能直接 import 它。
 * 缺的只是类型侧的声明，所以这里补一份把它标成 `any`：测试用的是运行时行为，
 * 类型精度对这两处没有意义。
 */
declare module "*/scripts/lib/python-env.mjs" {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const mod: any
  export = mod
}
