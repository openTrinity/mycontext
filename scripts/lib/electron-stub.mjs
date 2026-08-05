/**
 * `electron` 的**桩** —— 只给纯 node 里跑的探针用。
 *
 * ## 为什么需要它
 *
 * `PersonaService` 经 `media.service.ts` 拉进 `import { dialog } from "electron"`。
 * 探针把 electron 标成 external 时，esbuild 保留那个**具名** import，
 * 而 electron 是 CJS —— 纯 node 里 `import { dialog }` 直接 SyntaxError，
 * 脚本连启动都做不到（不是运行到那一行才失败）。
 *
 * ## ★ 每个导出都会抛，而不是静默返回 undefined
 *
 * 桩的危险在于「探针以为自己验过了 electron 那条路」。抛错让"真的走到了
 * 这里"变成一次**响亮**的失败，而不是一个悄悄的 undefined 往下流 ——
 * 后者正是本项目反复出现的那类静默失效。
 *
 * 所以：探针跑绿**不代表** electron 相关的代码被验过，只代表它没被走到。
 */
const reject = (name) => () => {
  throw new Error(
    `探针里调用了 electron.${name} —— 这条路径本该不碰 electron。` +
      `要么改探针，要么这段逻辑需要真正的 Electron 环境（见 scripts/lib/electron-stub.mjs）。`,
  )
}

export const dialog = {
  showOpenDialog: reject("dialog.showOpenDialog"),
  showSaveDialog: reject("dialog.showSaveDialog"),
  showMessageBox: reject("dialog.showMessageBox"),
}

export const app = {
  getPath: reject("app.getPath"),
  getName: reject("app.getName"),
}

export const shell = { openPath: reject("shell.openPath") }

export default { dialog, app, shell }
