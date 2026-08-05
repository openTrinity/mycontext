/**
 * 高级 AI 配置（隐藏入口）。
 *
 * 需求原文：「隐藏的地方可以极客配置自己的 ai，harness & llm model」。
 * 入口是**关于页的版本号连点 5 次** —— 不进主导航（需求说的就是"隐藏"）。
 *
 * ## 为什么把「逃生阀」也放进来
 *
 * 极客的定义就是"你的抽象不够用时我要能绕过它"。给一个受控的原文注入口
 * （直接粘一份 harness 配置 JSON），比让他们去改我们的代码或猜环境变量名要好。
 *
 * ## ★ 一条硬约束
 *
 * 这一页的任何配置都**不影响发送门禁与自动回复策略**：
 * 配的是"用什么脑子"，不是"能不能动手"。
 * 换个模型不该让数字人绕过授权门或草稿模式 ——
 * 配套测试见 `tests/integration/persona/model-config-isolation.test.ts`（D 阶段）。
 */
import { useState } from "react"
import { Button, Field, Input, cn } from "@mycontext/design"
import { useAdvancedAiConfig, useSaveAdvancedAiConfig } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

/** 六个模型角色。每个角色可独立指定 model id。 */
const MODEL_ROLES = [
  "harness.search",
  "harness.persona",
  "distill.map",
  "distill.reduce",
  "scene.router",
  "embedding.local",
] as const

const HARNESS_OPTIONS = ["opencode-acp", "builtin-llm"] as const

export function AdvancedAiPanel() {
  const { t } = useDynamicTranslation("settings")
  const config = useAdvancedAiConfig()
  const save = useSaveAdvancedAiConfig()

  const [baseUrl, setBaseUrl] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState("")
  const [roles, setRoles] = useState<Record<string, string>>({})
  const [harness, setHarness] = useState<Record<string, string>>({})
  const [escapeHatch, setEscapeHatch] = useState<string | null>(null)
  const [escapeError, setEscapeError] = useState<string | null>(null)

  const current = config.data
  if (current === undefined) return null

  const effectiveBaseUrl = baseUrl ?? current.baseUrl
  const effectiveEscape = escapeHatch ?? current.rawConfigJson ?? ""

  const submit = (): void => {
    // 逃生阀先校验：格式错误则**不生效并显示原因**，而不是静默忽略
    // （静默忽略会让人以为配置生效了，然后花很久找"为什么没变"）。
    if (effectiveEscape.trim() !== "") {
      try {
        JSON.parse(effectiveEscape)
      } catch (error) {
        setEscapeError(error instanceof Error ? error.message : String(error))
        return
      }
    }
    setEscapeError(null)
    save.mutate({
      baseUrl: effectiveBaseUrl,
      // 空串表示"不改"：UI 只显示后 4 位，不回显完整 key
      apiKey: apiKey === "" ? null : apiKey,
      modelRoles: { ...current.modelRoles, ...roles },
      harness: { ...current.harness, ...harness },
      rawConfigJson: effectiveEscape.trim() === "" ? null : effectiveEscape,
    })
    setApiKey("")
  }

  return (
    <div className="flex flex-col gap-[var(--gap-section-lg)]">
      <p className="typography-body-small-400 rounded-[var(--radius-md)] bg-[var(--status-fill-warning-container)] px-3 py-2 text-[var(--status-warning)]">
        {t("advancedAi.warning")}
      </p>

      <Group title={t("advancedAi.provider.title")}>
        <Field label={t("advancedAi.provider.baseUrl")}>
          {(attributes) => (
            <Input
              {...attributes}
              value={effectiveBaseUrl}
              onChange={(event) => setBaseUrl(event.target.value)}
              placeholder="https://…/v1"
            />
          )}
        </Field>
        <Field
          label={t("advancedAi.provider.apiKey")}
          description={
            current.apiKeyTail === null
              ? t("advancedAi.provider.apiKeyEmpty")
              : t("advancedAi.provider.apiKeySet", { tail: current.apiKeyTail })
          }
        >
          {(attributes) => (
            <Input
              {...attributes}
              type="password"
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
              placeholder={t("advancedAi.provider.apiKeyPlaceholder")}
            />
          )}
        </Field>
      </Group>

      <Group title={t("advancedAi.roles.title")} description={t("advancedAi.roles.description")}>
        {MODEL_ROLES.map((role) => (
          <Field key={role} label={role}>
            {(attributes) => (
              <Input
                {...attributes}
                value={roles[role] ?? current.modelRoles[role] ?? ""}
                onChange={(event) => setRoles({ ...roles, [role]: event.target.value })}
                placeholder={t("advancedAi.roles.placeholder")}
              />
            )}
          </Field>
        ))}
      </Group>

      <Group
        title={t("advancedAi.harness.title")}
        description={t("advancedAi.harness.description")}
      >
        {(["search", "persona"] as const).map((module) => (
          <div key={module} className="flex items-center justify-between gap-3">
            <span className="typography-body-small-400 text-[var(--text-base-primary)]">
              {t(`advancedAi.harness.${module}`)}
            </span>
            <div className="inline-flex gap-0.5 rounded-[var(--radius-md)] bg-[var(--bg-card-z0)] p-0.5">
              {HARNESS_OPTIONS.map((option) => {
                const selected = (harness[module] ?? current.harness[module]) === option
                return (
                  <button
                    key={option}
                    type="button"
                    onClick={() => setHarness({ ...harness, [module]: option })}
                    className={cn(
                      "typography-caption-400 rounded-[var(--radius-sm)] px-2.5 py-1",
                      selected
                        ? "bg-[var(--bg-card-z1)] text-[var(--text-base-primary)]"
                        : "text-[var(--text-base-secondary)]",
                    )}
                  >
                    {option}
                  </button>
                )
              })}
            </div>
          </div>
        ))}
      </Group>

      <Group title={t("advancedAi.escape.title")} description={t("advancedAi.escape.description")}>
        <textarea
          value={effectiveEscape}
          onChange={(event) => setEscapeHatch(event.target.value)}
          rows={8}
          spellCheck={false}
          className="typography-caption-400 font-mono-token w-full rounded-[var(--radius-md)] bg-[var(--control-input-bg)] p-3 text-[var(--text-base-primary)] outline-none"
          placeholder='{ "provider": { … } }'
        />
        {escapeError !== null && (
          <p className="typography-caption-400 text-[var(--status-error)]">
            {t("advancedAi.escape.invalid", { detail: escapeError })}
          </p>
        )}
      </Group>

      <div className="flex items-center gap-3">
        <Button size="sm" disabled={save.isPending} onClick={submit}>
          {t("advancedAi.save")}
        </Button>
        {save.isSuccess && (
          <span className="typography-caption-400 text-[var(--status-success)]">
            {t("advancedAi.saved")}
          </span>
        )}
      </div>
    </div>
  )
}

function Group({
  title,
  description,
  children,
}: {
  title: string
  description?: string
  children: React.ReactNode
}) {
  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h3 className="typography-title-small-500 text-[var(--text-base-primary)]">{title}</h3>
        {description !== undefined && (
          <p className="typography-caption-400 text-[var(--text-base-tertiary)]">{description}</p>
        )}
      </div>
      {children}
    </section>
  )
}
