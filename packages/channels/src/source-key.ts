/**
 * 渠道**来源应用**的稳定短标识 —— 隔离键的第一段。
 *
 * ## ★★ 为什么四元组不够，而这一段能补上
 *
 * 隔离键原来是 `(accountId, channelId, corpId, userId)`。实测发现它分不开
 * 一个真实存在的情况：同一台机器上装了**两个不同来源**的渠道 CLI
 * （随包的开源版、用户自备的闭源版），而两者 `auth status` 返回的
 * `corp_id` 与 `user_id` **完全相同**（逐字段 sha256 比对，13 个字段全等）。
 *
 * 于是两个来源被判成同一个身份、共用一个 vault。而它们的**消息面不同**
 * （各自的服务端、各自的会话集合），混进一个库就是把两批语料蒸进同一份画像。
 *
 * ## ★ 为什么不用 `openDingTalkId` 分（我先试的那条路）
 *
 * 它确实能区分（实测同一会话里出现过 33 字符与 34 字符的不同值），但：
 *
 * ① **授权那一刻拿不到。** 四条路全验过 —— `auth status` 返回 10 个字段、
 *    `contact user get-self` 13 个、`contact user get` 14 个，都没有它；
 *    也没有 `userId → openDingTalkId` 的转换命令。它只出现在**消息**的
 *    `sender_external_id` 里，也就是要等采集出第一条自己发的消息之后。
 *    而 vault 必须在授权那一刻就定（要落盘、要挂库、onboarding 要写）。
 *
 * ② **可空列进主键 = 唯一性静默失效。** SQLite 里 `NULL != NULL`，
 *    实测两条该列为 NULL 的同键行都能插进去 —— 得到一个看起来加了约束、
 *    实际什么都不挡的键。那正是本项目最怕的形状。
 *
 * 而"用的是哪个二进制"在授权那一刻**就是已知的**（是我们自己拼的命令），
 * 永远非空，且不需要任何额外的网络调用。所以用它。
 *
 * ## ★ 为什么是路径的 hash 而不是路径本身
 *
 * 路径里有本机用户名（`/Users/<用户名>/...`）—— 那是身份信息，
 * 而这个值要进数据库、进日志、进目录名（`vaults/<id>/`）。
 * hash 之后既稳定又不泄漏（CLAUDE.md §1.1 明确"本机绝对路径"不许出现）。
 *
 * ★ 取前 8 位十六进制：32 位空间对"一台机器上装了几个 dws"这个量级
 * （现实里 1-3 个）碰撞概率可忽略，而短值让 vault 目录名still可读。
 */
import { createHash } from "node:crypto"

/**
 * 内置（随包）那份的来源键。**常量，不是 hash。**
 *
 * ★ 为什么内置那份要用一个固定字面量而不是它的路径 hash：
 * 随包二进制的绝对路径**会变** —— 开发态在仓库里、打包后在
 * `…/Contents/Resources/bin/`、换个安装位置又不同。拿它 hash 的话
 * 同一个身份在开发态与打包态会得到两个不同的 vault，
 * 表现是"打包版本里我的数据全没了"。
 *
 * 而"内置"这个**语义**是稳定的，所以直接钉一个字面量。
 */
export const BUILTIN_SOURCE_KEY = "builtin"

/**
 * 来源键：内置那份给 `BUILTIN_SOURCE_KEY`，用户自备那份给路径 hash。
 *
 * @param binOverride 用户自备可执行文件的绝对路径（`dwsBinOverride`）。
 *   `undefined` / 空串 = 没设，用的是随包那份。
 *
 * @example
 * ```ts
 * sourceKeyOf(undefined)                    // → "builtin"
 * sourceKeyOf("/opt/vendor-cli/dws")        // → "src-3f2a1b8c"（示例值）
 * ```
 */
export function sourceKeyOf(binOverride: string | undefined): string {
  if (binOverride === undefined || binOverride === "") return BUILTIN_SOURCE_KEY
  const digest = createHash("sha256").update(binOverride).digest("hex").slice(0, 8)
  return `src-${digest}`
}

/**
 * 分隔符。`@` 是刻意选的：
 * · 渠道 id 与 hash 都不含它（前者是小写字母、后者是十六进制），所以可逆；
 * · 它**不是** `--profile` 的分隔符（那是 `:`）—— 两处用同一个符号会让人
 *   把这个带作用域的值直接当 profile 传下去，而那必然 `not found`。
 */
const SOURCE_SEP = "@"

/**
 * 把渠道 id 与来源键拼成隔离键里用的那一段。
 *
 * ## ★★ 内置那份**不带后缀** —— 这是存量兼容，不是省事
 *
 * 已有的映射行（以及 `channel_self_identity`、`app_settings` 里记的
 * "上次用哪个身份"）里 `channel_id` 就是裸的 `"dingtalk"`。
 * 给内置也加后缀的话，那些行会**全部失配** —— 表现是"登录进去数据全没了、
 * 又让我重新授权一遍"，而磁盘上的库其实还在。
 *
 * 所以：内置 = 原样，自备 = 加后缀。存量都是内置那份（自备是后来才有的入口），
 * 于是升级后**零迁移**。
 *
 * @example
 * ```ts
 * scopedChannelId("dingtalk", "builtin")        // → "dingtalk"
 * scopedChannelId("dingtalk", "src-3f2a1b8c")   // → "dingtalk@src-3f2a1b8c"
 * ```
 */
export function scopedChannelId(channelId: string, sourceKey: string): string {
  if (sourceKey === BUILTIN_SOURCE_KEY) return channelId
  return `${channelId}${SOURCE_SEP}${sourceKey}`
}

/**
 * `scopedChannelId` 的逆 —— 把带作用域的值拆回「渠道」与「来源」。
 *
 * ★ 需要它的地方是**按渠道**做的判断：渠道插件的查表、界面上"这是钉钉
 * 还是飞书"的分组。那些地方要的是 `dingtalk`，而库里存的可能是
 * `dingtalk@src-…` —— 不拆就会查不到插件（表现是"这个身份的渠道不认识"）。
 *
 * @example
 * ```ts
 * parseScopedChannelId("dingtalk")
 * // → { channelId: "dingtalk", sourceKey: "builtin" }
 * parseScopedChannelId("dingtalk@src-3f2a1b8c")
 * // → { channelId: "dingtalk", sourceKey: "src-3f2a1b8c" }
 * ```
 */
export function parseScopedChannelId(value: string): {
  channelId: string
  sourceKey: string
} {
  const at = value.indexOf(SOURCE_SEP)
  if (at < 0) return { channelId: value, sourceKey: BUILTIN_SOURCE_KEY }
  return {
    channelId: value.slice(0, at),
    /**
     * 后半段为空（`"dingtalk@"`，手改过库或旧格式）时按内置处理 ——
     * 而不是得到一个空来源键。空键会让 `scopedChannelId` 再拼一次
     * 得到不同的值（`"dingtalk@"` → 拆出空 → 拼回 `"dingtalk"`），
     * 也就是往返不再幂等。
     */
    sourceKey: value.slice(at + SOURCE_SEP.length) || BUILTIN_SOURCE_KEY,
  }
}
