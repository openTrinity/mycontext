/**
 * 动态 key 的翻译 hook。
 *
 * `useTranslation().t` 的 key 是字面量联合类型——拼错 key 编译不过，这是好事。
 * 但有两类 key 天生是运行时字符串：
 *   - 主进程通过 IPC 传来的（`ChannelSummary.labelKey`、`AppError.messageKey`）
 *   - `Record<枚举, key>` 映射表里取出来的（状态标签、主题名、配置来源）
 *
 * 它们在编译期收窄不到字面量，所以在这里收口一次，而不是在几十个调用点各写一遍断言。
 * 正确性由别处保证：IPC 来的 key 由 i18n.test.ts 的「两语 key 集合一致」检查覆盖，
 * 映射表由 Record 必须穷举枚举值保证。
 *
 * namespace 仍是强类型（写错命名空间会编译不过），只有 key 放开。
 */
import { useTranslation } from "react-i18next"
import type { Namespace, TranslateDynamic } from "@mycontext/i18n"

export function useDynamicTranslation(namespace?: Namespace): {
  t: TranslateDynamic
  language: string
} {
  const { t, i18n } = useTranslation(namespace)
  return {
    t: (key, params) => t(key as never, { ...params }) as string,
    language: i18n.language,
  }
}
