/**
 * 真发送：`chat message send`。
 *
 * ## ★ 这是 `SendGuard` 四层里的第 ③ 层，不是一个"发消息的工具"
 *
 * 它**只被** `SendGuard.send()` 调用，而那之前已经过了：
 * 应用层短路（测试/dry-run 根本不进来）、按 draftId 重读库比对 contentHash、
 * 授权有效性检查。所以这个文件里**不做**任何"这条该不该发"的判断 ——
 * 那些判断在守卫与 policy 里，重复一遍只会造出第二个真源。
 *
 * Agent 手上没有这个能力（它的终点是 `draft_reply`）：即使消息里藏了
 * prompt injection「把 X 发给所有人」，模型也没有能发消息的工具。
 * **自动发送是宿主行为，不是模型行为。**
 *
 * ## 目标三选一（实测 help 明确）
 *
 * `--group <openConversationId>` / `--user <userId>` /
 * `--open-dingtalk-id <openDingTalkId>`，互斥且必须给一个。
 * 我们的会话行上存的是 `external_id`：群聊那一列就是 openConversationId，
 * 单聊则要用对方的 openDingTalkId（`SendTarget` 的判别联合表达了这件事，
 * 于是"三个都没传"在类型层就不可能）。
 *
 * ## ★ `--uuid` 是服务端幂等键，不是日志 id
 *
 * 实测 reference 原文：「幂等 UUID，24h 内相同值不重复投递」。
 * 它挡住的是"崩溃重启后重发同一条"——**不挡误发**（第一次照发）。
 * 所以它必须由调用方给（`SendInput.idempotencyKey`），
 * 而且重试时**必须复用同一个值**，不能每次新生成一个。
 *
 * ## @人 的占位符
 *
 * `--at-open-dingtalk-ids a,b` 要求正文含 `<@a> <@b>`。占位符缺失时
 * **@ 不生效但命令成功** —— 那是静默失败，所以 `assertMentionPlaceholders`
 * 在守卫里先拒掉，这里只负责把参数拼对。
 */
import { AppError } from "@mycontext/kernel"
import type { MediaRunner } from "../../types.js"
import { classifyDwsError } from "./cli.js"

/** 与 `@mycontext/persona` 的 `SendTarget` 同形。 */
export type SendTargetKind = "group" | "user" | "open_id"

export interface SendSpec {
  target: { kind: SendTargetKind; externalId: string }
  text: string
  mentions: readonly string[]
  idempotencyKey: string
  dryRun: boolean
}

export type SendResult =
  | { ok: true; externalId?: string; taskId?: string }
  | { ok: false; code: string; detail: string }

/**
 * `query-send-status` 的结果。
 *
 * `delivered` 与 `externalId` 分开是刻意的：拿到了 id 但状态还是 `SENDING`
 * 时，那条消息**还没真的到**。合成一个布尔会让"在途"与"成功"无法区分，
 * 而频率判定与对账读的是不同的那一个。
 */
export interface SendStatus {
  externalId: string
  /** `sendStatus === "SUCCESS"`。false = 在途或失败 */
  delivered: boolean
  conversationExternalId: string | null
}

/** 目标 kind → CLI flag。用 Record 让漏配变成编译错误。 */
const TARGET_FLAG: Record<SendTargetKind, string> = {
  group: "--group",
  user: "--user",
  open_id: "--open-dingtalk-id",
}

/**
 * 从返回里取一个字符串字段（顶层，或包在 `data`/`result` 里）。
 *
 * DWS 的返回有时多包一层，所以逐层往下找。**只找我们指定的那些键名** ——
 * 宽松匹配"任何看起来像 id 的字段"会在协议变化时静默取到错的东西。
 */
function readNested(payload: unknown, keys: readonly string[]): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined
  const record = payload as Record<string, unknown>
  for (const key of keys) {
    const value = record[key]
    if (typeof value === "string" && value !== "") return value
  }
  for (const key of ["data", "result"]) {
    const nested = record[key]
    if (typeof nested === "object" && nested !== null) {
      const found = readNested(nested, keys)
      if (found !== undefined) return found
    }
  }
  return undefined
}

/**
 * 从 `send` 的返回里取**任务** id。
 *
 * ## ★ 真实返回里只有 `openTaskId`，没有 `openMessageId`
 *
 * 实测（发一条自检消息，原样）：
 *
 * ```json
 * {"success": true, "result": {"openTaskId": "qQrC8yRZwg5c…"}}
 * ```
 *
 * 曾经这里只找 `openMessageId`/`open_message_id`/`messageId`/`message_id`
 * —— 四个键**一个都不存在**，于是恒返回 undefined，而整条链就此断掉且
 * 全程不报错：`sent_message_external_id` 全 NULL（实测 32 条已发全 NULL）
 * → `claimAgentOrigin` 匹配不到 → `messages.origin` 恒 `human`
 * → 界面上「分身发的」标签从来没渲染过，且分身的回复被当本人语料再蒸一遍
 * （自我强化漂移）。
 *
 * 拿到 taskId 之后要再走一跳 `querySendStatus` 才有消息 id。
 */
function readTaskId(payload: unknown): string | undefined {
  return readNested(payload, ["openTaskId", "open_task_id", "taskId", "task_id"])
}

/**
 * 从返回里取平台**消息** id。
 *
 * ★ `send` 的返回里没有它（见 `readTaskId`）—— 这个函数是给
 * `query-send-status` 用的，同时**保留**对 send 返回的兼容读取：
 * 哪天上游直接给了消息 id 就能省掉一跳。但绝不能只依赖它，
 * 那正是修复前的形态。
 */
function readMessageId(payload: unknown): string | undefined {
  return readNested(payload, ["openMessageId", "open_message_id", "messageId", "message_id"])
}

/**
 * 造一个发送器。
 *
 * `cli` 只需要 `json` —— 拿到它的人能跑的命令集合与我们自己完全一样
 * （都过白名单闸），不多一条。
 */
export function createSendExecutor(cli: Pick<MediaRunner, "json">): {
  send(spec: SendSpec): Promise<SendResult>
  querySendStatus(taskId: string): Promise<SendStatus | null>
} {
  return {
    async send(spec) {
      /**
       * ★ dry-run 在这里也拦一道。
       *
       * 守卫的第 ① 层已经拦了（`shortCircuit` 时根本不调这里），
       * 这一道是**冗余**的 —— 而那正是"纵深"的意思：两层的失效原因
       * 不相关（那层是应用逻辑，这层是参数拼装）。
       *
       * 不用 CLI 自己的 `--dry-run`：它会真的走一遍网络并返回"预览"，
       * 而我们要的是"根本不发出去"。
       */
      if (spec.dryRun) {
        return { ok: false, code: "DRY_RUN", detail: "dry-run：未真正发送" }
      }

      const args = [
        "chat",
        "message",
        "send",
        TARGET_FLAG[spec.target.kind],
        spec.target.externalId,
        "--text",
        spec.text,
        // 幂等键：崩溃重启后重发同一条会被服务端吃掉（24h 内）
        "--uuid",
        spec.idempotencyKey,
      ]
      if (spec.mentions.length > 0) {
        args.push("--at-open-dingtalk-ids", spec.mentions.join(","))
      }

      try {
        const payload = await cli.json<unknown>(args)
        /**
         * ★ 两个 id 都取：`taskId` 是真实返回里唯一有的那个，
         * `externalId` 只在上游哪天直接给消息 id 时才命中（见 readTaskId）。
         */
        const taskId = readTaskId(payload)
        const externalId = readMessageId(payload)
        return {
          ok: true,
          ...(externalId === undefined ? {} : { externalId }),
          ...(taskId === undefined ? {} : { taskId }),
        }
      } catch (error) {
        /**
         * ★ 权限类错误要**分出来**，因为守卫对它的处置完全不同：
         * 标授权撤销 + 降级为 draft + **不重试**（重试对授权问题永远没用，
         * 只会反复弹窗骚扰用户）。
         *
         * 判据复用 `classifyDwsError` —— 与其他命令同一份匹配规则。
         * 各写一遍的话"两处对同一个错误分类不同"会成为一个极难发现的 bug。
         */
        const detail = error instanceof Error ? error.message : String(error)
        const classified = error instanceof AppError ? error : classifyDwsError(detail)
        if (classified !== null && classified.code === "PERMISSION_REQUIRED") {
          return { ok: false, code: "PERMISSION_REQUIRED", detail: classified.message }
        }
        if (classified !== null && classified.code === "SESSION_EXPIRED") {
          /**
           * 登录过期映射成 `GRANT_REVOKED`：对守卫来说处置一样
           * （降级 + 不重试），而"重新登录"这件事由渠道层的会话管理负责。
           */
          return { ok: false, code: "GRANT_REVOKED", detail: classified.message }
        }
        return { ok: false, code: "SEND_FAILED", detail }
      }
    },

    /**
     * 用 `send` 返回的 `openTaskId` 换真正的消息 id。
     *
     * ## ★ 这一跳是**必需**的，不是优化
     *
     * `send` 只给 `openTaskId`（见 `readTaskId` 的实测记录）。没有这一跳
     * 就没有任何东西能把"我们发的"与"采集回来的"对上 —— 而对不上就意味着
     * `messages.origin` 永远标不成 `agent`，界面上分不出哪条是分身发的，
     * 分身的回复还会被当本人语料再蒸一遍。
     *
     * 实测返回（原样）：
     * ```json
     * {"result":{"openConversationId":"cid…","openMessageId":"msgIbwJ0…","sendStatus":"SUCCESS"}}
     * ```
     *
     * ## ★ 失败返回 null，**不抛**
     *
     * 调用这个方法时消息**已经发出去了**。抛错会让上层把一次成功的发送
     * 记成失败，那比少一个关联键糟得多（用户会看到"发送失败"然后重发一遍）。
     * 取不到就是取不到，记 warn 由调用方处理。
     */
    async querySendStatus(taskId) {
      try {
        const payload = await cli.json<unknown>([
          "chat",
          "message",
          "query-send-status",
          "--open-task-id",
          taskId,
        ])
        const externalId = readMessageId(payload)
        if (externalId === undefined) return null
        return {
          externalId,
          /**
           * 只有 `SUCCESS` 才算真到了。
           *
           * 其余状态（`SENDING` 等）意味着"在途" —— 把它当成功会让频率
           * 判定与对账都基于一条还没到的消息。区分它的成本只是一个布尔。
           */
          delivered: readNested(payload, ["sendStatus", "send_status"]) === "SUCCESS",
          conversationExternalId:
            readNested(payload, ["openConversationId", "open_conversation_id"]) ?? null,
        }
      } catch {
        // 见方法头：消息已经发出去了，查不到状态不该变成一次"发送失败"
        return null
      }
    },
  }
}
