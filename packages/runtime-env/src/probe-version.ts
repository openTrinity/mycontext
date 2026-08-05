/**
 * 通用「跑 `<bin> --version` 读版本」探针。
 *
 * ## ★ 为什么单独一个文件、且刻意**不出现**那个 agent 二进制的名字
 *
 * `tests/unit/agent-runtime/spawn-wiring.test.ts` 用「文件里同时出现那个
 * agent 二进制的名字 + spawn 调用」当门禁，防止有人绕过 `buildOpencodeSpawn`
 * 起一个无鉴权的 agent 进程。这里要 `spawnSync` 一个二进制读版本 ——
 * 与 `python.ts` 同一处境（见那个文件头注释）。解法一致：这段代码只接收一个
 * `binPath`、不写出那个名字，于是门禁不会误伤；而调用方
 * （binaries.ts 的 `resolveUsableOpencode`）也不 spawn（它收探针作参数）。
 * 两边都干净。
 *
 * `--version` 这类只读命令不需要加固（它不起 server、不加载任何配置）。
 */
import { spawnSync } from "node:child_process"

/**
 * 单次尝试的超时。
 *
 * ## ★ 为什么是 30s 而不是原来的 5s（有实测，不是拍的）
 *
 * 那个 agent 二进制是 **132MB 的单文件**。macOS 首次执行它时要对全量做代码
 * 签名哈希校验（`codesign -dv` 显示 `hashes=33578`），而企业机上往往还挂着
 * 杀毒钩子（本机 `xattr` 有 `…edr.antivirus.cloudquery`）。同一台机器实测：
 *
 *   · **冷**启动（文件刚落盘、首次执行）：2384 / 2496 / 2530 / 3621 ms
 *   · **热**启动（页在缓存里）：            263 / 275 / 278 ms
 *
 * 也就是说 5s 恰好落在冷启动的**临界区**：平常够，赶上一次杀毒扫描就不够。
 * 而超时的后果不是"慢一点"，是 `spawnSync` 返回 `ETIMEDOUT`／`SIGTERM`、
 * stdout 空 —— 上层把它读成"版本读不出来"，于是**整个 agent 路径降级**，
 * UI 说"未检测到 opencode（或版本过低）"。真实故障：二进制 mtime 11:11:10
 * （prepare:bin 刚写进去），应用 11:11:54 启动，11:12:10 探测失败 ——
 * 那是这个文件有史以来第一次被执行。
 *
 * 30s 是"宁可启动慢一次，也不要错误降级"：这条路径**只在冷启动那一次**
 * 会花到秒级，之后都是 ~270ms。而它换掉的是一个需要**重启应用**才能恢复的
 * 假降级（上层缓存结果，见 persona-acp / search.service 的 `resolveOnce`）。
 * 仍然保留上限而不是无限等：真卡死的二进制不能拖住启动。
 */
export const PROBE_TIMEOUT_MS = 30_000

/**
 * 跑 `<binPath> --version`，返回原始 stdout（调用方负责解析）。
 *
 * 失败（起不来 / 超时 / 非零退出且无输出）返回 null。
 * stdout 空但 stderr 有内容时用 stderr —— 有些工具把版本打到 stderr。
 *
 * ★ 超时会**重试一次**。理由同样是实测的：首次被 SIGTERM 杀掉之后，
 * 已加载的页仍留在缓存里，紧接着重试只要 **266ms**（原始 3614ms）。
 * 也就是说超时那一次自己付了预热的代价，重试几乎是免费的 —— 不重试等于
 * 把预热的成果扔掉，然后向上报一个假的"版本读不出来"。
 *
 * @param timeoutMs 单次尝试的上限，缺省 `PROBE_TIMEOUT_MS`。
 *   **只为测试而参数化**：超时与重试的行为只能用真进程验证（mock 掉
 *   `spawnSync` 就等于只测我们自己的 if/else），而真等 2×30s 会让那个测试
 *   文件跑 90 秒。生产调用方一律不传。
 */
export function probeBinaryVersion(binPath: string, timeoutMs = PROBE_TIMEOUT_MS): string | null {
  const first = attempt(binPath, timeoutMs)
  if (first.output !== null) return first.output
  // 只对超时重试：`ENOENT`（文件不在）、非零退出这些重试也是同样结果。
  if (!first.timedOut) return null
  return attempt(binPath, timeoutMs).output
}

function attempt(binPath: string, timeoutMs: number): { output: string | null; timedOut: boolean } {
  try {
    const result = spawnSync(binPath, ["--version"], {
      encoding: "utf8",
      timeout: timeoutMs,
    })
    // Node 超时的表现：error.code === "ETIMEDOUT"，且 signal 为 SIGTERM。
    const timedOut =
      (result.error as NodeJS.ErrnoException | undefined)?.code === "ETIMEDOUT" ||
      result.signal !== null
    if (result.error !== undefined) return { output: null, timedOut }
    const out = (result.stdout || "").trim()
    if (out !== "") return { output: out, timedOut: false }
    const err = (result.stderr || "").trim()
    return { output: err === "" ? null : err, timedOut }
  } catch {
    return { output: null, timedOut: false }
  }
}
