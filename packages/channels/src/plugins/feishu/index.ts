/**
 * 飞书渠道骨架。
 *
 * 本阶段不实现，存在的意义是**验证契约对「实现方式完全不同的渠道」成立**：
 * 钉钉是 poll + self（CLI 拉取、本人身份），飞书是 push + bot（长连、机器人身份），
 * 两者在同一份 ChannelPlugin 契约下都能表达。
 *
 * 后续实现时只需替换 auth 的三个方法，契约与宿主逻辑不用改。
 */
import { AppError } from "@mycontext/kernel"
import type { ChannelPlugin } from "../../types.js"

const notImplemented = (): never => {
  throw new AppError("CHANNEL_UNSUPPORTED", "飞书渠道尚未开放", {
    messageKey: "errors:channel.unsupported",
  })
}

export function createFeishuPlugin(): ChannelPlugin {
  return {
    meta: {
      id: "feishu",
      labelKey: "channels:feishu.label",
      descriptionKey: "channels:feishu.description",
      available: false,
    },
    capabilities: {
      chatTypes: ["direct", "group"],
      ingest: ["push"],
      changeProbe: false,
      media: false,
      sendAs: ["bot"],
      domains: ["chat"],
    },
    auth: {
      describeStepKeys: () => [
        "channels:feishu.steps.createApp",
        "channels:feishu.steps.subscribe",
      ],
      status: () => Promise.resolve({ state: "unauthorized" as const }),
      login: () => Promise.resolve(notImplemented()),
    },
  }
}
