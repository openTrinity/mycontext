#!/usr/bin/env node
/**
 * 把算法团队的上游改动合并进 `kl-graph/`，**保留他们的 commit 历史**。
 *
 * ## 为什么不再是 rsync
 *
 * 这个脚本原来是 `rsync -a --delete <上游>/ external/kl-graph/`：一次覆盖，
 * 上游的历史全部丢掉，我们这侧只留下"同步了一次"这一个 commit。
 * 那种形态下 `git log` / `git blame` 在那个目录里返回的是我们自己的同步提交，
 * 「这行代码为什么这样写」永远查不到。
 *
 * 现在 `kl-graph/` 里是上游 80 个真实 commit（作者/日期/message 都在），
 * 而 rsync 会**主动破坏**它：
 *
 * · 覆盖成上游的工作树之后，那些改动会以「我们改的一个大 commit」记下来，
 *   上游那些 commit 与我们这份的关系彻底断开（下次再同步就是又一个大 commit）；
 * · 上游若 revert 过某个改动，rsync 出来的是「删掉这些行」，
 *   而不是那次 revert —— 语义丢了；
 * · 我们这侧对 `kl-graph/` 的任何改动会被**静默覆盖**，
 *   而 merge 会把它变成一个能看见、能解决的冲突。
 *
 * 所以改成 `fetch` + `merge -X subtree=kl-graph`：上游的每个 commit 都原样进来。
 *
 * ## ★ 为什么是 `-X subtree=` 而不是别的
 *
 * 上游的路径是 `kl_server.py`，我们这里是 `kl-graph/kl_server.py`。
 * `-X subtree=kl-graph` 告诉 merge 策略「上游那棵树对应我这边的这个子目录」，
 * 于是它能正确地按文件配对。不给这个参数的话 merge 会把上游的文件当成
 * **新增在仓库根**（仓库根多出一份 kl_server.py，而 kl-graph/ 里那份没变）。
 *
 * ## 排除项去哪了
 *
 * rsync 时代要显式排除 `.git` / `data/` / `.venv/` / `.env`。现在不需要 ——
 * 那些本来就不在上游的 commit 里（他们自己的 .gitignore 排除了），
 * 而 merge 只搬 commit 里的东西。**这是从 rsync 换成 merge 顺带得到的**：
 * 排除规则不再是我们维护的一份清单（漏一条就把凭据拷进来），
 * 而是上游 .gitignore 的自然结果。
 *
 * 顺带修掉了一个真实的漏排除：rsync 的 `data/` 是**裸目录名**，
 * 于是 `kl_graph/data/` 这个**源码包**也被排掉了（3 个文件），
 * 而 `kl_graph/evaluation/agentic/*` 三处 import 它 —— 副本里那些 import 是断的。
 */
import { execFileSync } from "node:child_process"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import { join, resolve } from "node:path"

const root = resolve(import.meta.dirname, "..")

/** 子目录名。上游那棵树在我们这里对应它。 */
const PREFIX = "kl-graph"

const source = resolve(process.env["KL_GRAPH_SOURCE"] ?? join(homedir(), "gits", "kl-graph"))

if (!existsSync(source)) {
  console.error(
    [
      `未找到上游仓库：${source}`,
      "用 KL_GRAPH_SOURCE=<path> 指定，或把算法团队的仓库克隆到 ~/gits/kl-graph。",
    ].join("\n"),
  )
  process.exit(1)
}

/** 上游分支。默认 main —— 导入时用的就是它。 */
const branch = process.env["KL_GRAPH_BRANCH"] ?? "main"

/** 临时 remote：不留在 .git/config 里（每个人的上游路径不同，留下来只会串味）。 */
const REMOTE = "kl-graph-upstream"

function git(args, options = {}) {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    ...options,
  })
}

function dropRemote() {
  try {
    git(["remote", "remove", REMOTE], { stdio: "ignore" })
  } catch {
    // 本来就没有，正常
  }
}

/**
 * ★ 工作树必须干净。
 *
 * merge 会动工作树，而带着未提交改动去 merge 的失败形态很差：冲突与自己的
 * 改动混在一起，`git merge --abort` 也救不回来（它只还原 merge 那部分）。
 * 早退比事后解释便宜。
 */
const dirty = git(["status", "--porcelain", "--untracked-files=no"]).trim()
if (dirty !== "") {
  console.error(
    [
      "✗ 工作树有未提交改动，先提交或 stash 再同步。",
      "  （merge 会动工作树；混在一起之后 --abort 也还原不了你自己那部分）",
      "",
      dirty.split("\n").slice(0, 10).join("\n"),
    ].join("\n"),
  )
  process.exit(1)
}

dropRemote()
git(["remote", "add", REMOTE, source])

try {
  console.log(`从 ${source} 取 ${branch}…`)
  git(["fetch", REMOTE, branch], { stdio: "inherit" })

  const head = git(["rev-parse", `${REMOTE}/${branch}`]).trim()
  const subject = git(["log", "-1", "--format=%s", head]).trim()
  const date = git(["log", "-1", "--format=%cI", head]).trim()

  /**
   * 已经合过就早退 —— 否则 merge 会产出一个空的 merge commit，
   * 而"同步过但什么都没变"与"同步失败"在 git log 里长得一样。
   *
   * ★ `--is-ancestor` 靠**退出码**回答（0 是、1 不是），而 execFileSync 在
   * 非零时**抛异常**。所以必须 try/catch 而不是看返回值 —— 返回值恒为空串。
   */
  let alreadyMerged = false
  try {
    git(["merge-base", "--is-ancestor", head, "HEAD"], { stdio: "ignore" })
    alreadyMerged = true
  } catch {
    alreadyMerged = false
  }
  if (alreadyMerged) {
    console.log(`已是最新：${head.slice(0, 8)} ${subject}`)
    dropRemote()
    process.exit(0)
  }

  console.log(`合并 ${head.slice(0, 8)}（${date}）${subject}`)
  /**
   * `--no-commit`：让人先看一眼再提交。
   *
   * 上游动了 ingest 契约的话我们的导出器要跟着改，而那件事必须在**提交之前**
   * 被看到 —— 自动提交等于把"契约变了"这个信号埋掉。
   */
  git(["merge", "-X", `subtree=${PREFIX}`, "--no-commit", "--no-ff", `${REMOTE}/${branch}`], {
    stdio: "inherit",
  })

  console.log("")
  console.log("已合并进工作树（**还没提交**）。下一步：")
  console.log("  git status                             # 看合并进来了什么")
  console.log("  pnpm sync:kl-skill                    # skill 同步到打包资源目录")
  console.log("  pnpm check:kl-skill-sync              # 脱敏是否仍然对齐（见那个脚本）")
  console.log("  pnpm test tests/unit/knowledge-feed/  # 复验导出契约仍然对齐")
  console.log("  pnpm test:externals                   # ★ 不在 pnpm verify 里，必须显式跑")
  console.log("  git commit                            # 确认无误后提交这次合并")
} catch (error) {
  console.error(
    [
      "",
      "✗ 合并没走完（大概率是冲突）。",
      "  冲突意味着**我们改过上游的同一处** —— 逐个看 `git status`：",
      "  保留上游的逻辑，把我们的意图重新表达一次，然后 `git commit`。",
      "  想放弃：`git merge --abort`。",
      "",
      error instanceof Error ? error.message.slice(0, 200) : "",
    ].join("\n"),
  )
  process.exitCode = 1
} finally {
  // remote 只是搬运工具，无论成败都清掉
  dropRemote()
}
