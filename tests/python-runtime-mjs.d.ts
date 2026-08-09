/**
 * `scripts/lib/python-runtime.mjs` 的最小类型声明。
 *
 * ## 为什么需要它
 *
 * 与 `python-env-mjs.d.ts` 同一个理由：这是纯 JS 脚本（不进 tsc 的 `-b` 工程），
 * 而 `tsconfig.base.json` 没开 `allowJs` —— 直接 `await import()` 会报
 * `TS7016：隐式 any`。
 *
 * ## ★ 这一份**不**标成 any，而是写出真实签名
 *
 * 它只被一处 import：`tests/unit/python-resolve.test.ts` 里那条**防漂移**门禁
 * —— 比对本文件的 `bundledPythonExe()` 与 `packages/runtime-env/src/python.ts`
 * 里同名函数是否算出同一个路径（两份实现的理由见那边注释）。
 *
 * 标成 `any` 的话，「上游把返回值改成对象」这类改动在类型侧静默通过，
 * 而那条门禁的**全部价值**就是让两份实现的差异显形。所以这里把签名写死：
 * 形状变了先在 tsc 上红，而不是等运行时比较出一个看不懂的不相等。
 */
declare module "*/scripts/lib/python-runtime.mjs" {
  export function bundledPythonExe(repoRoot: string): string
  export function platformKey(): string
  export function pythonCacheDir(repoRoot: string): string
  export function hasBundledPython(repoRoot: string): boolean
  export const PYTHON_VERSION: string
  export const PYTHON_RELEASE: string
}
