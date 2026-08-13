/**
 * 模型网关配置表单 —— 设置面板与 onboarding 第 2 步**共用**同一个组件。
 *
 * ## 为什么共用
 *
 * 两处改的是同一份配置（`RuntimeConfigService` 单一真源）。抄两份表单
 * 会在某天分叉：一处加了 KL 折叠区、另一处没有，而用户在两处看到的
 * 「同一个设置」长得不一样。共用组件从源头上避免这件事。
 *
 * ## ★★ 核心：一次「测试连接」同时解决三件事
 *
 * 首版这里是三个裸输入框 + 五六行说明小字，而它有一个**不说明就看不见**
 * 的问题：填错了不会当场报错 —— 模型名写错在几小时后的蒸馏/建图里表现为
 * `model_not_found`，密钥写错表现为 401，两者在界面上都**完全无声**。
 * 那正是本项目最怕的失效形态。
 *
 * `GET /v1/models` 一次请求同时给出：
 * ① 地址通不通、② 密钥对不对、③ **有哪些模型可选**。
 * 于是：
 * · 「配置正确吗」从"等几小时看有没有结论"变成"现在就有绿灯"；
 * · 模型名从**猜着填的输入框**变成**从列表里挑**（对齐本项目已有的
 *   `PersonaRuntimePanel` —— 那里的注释写着"给档位就是给建议"）。
 *
 * 探测前有内置推荐档位兜底，所以"还没测"时也不是空白。
 *
 * ## 用交互承载信息，而不是堆说明文字
 *
 * · 「配没配 key」→ `Tag`（状态圆点）。一个绿点比一句话快，且不占整行；
 * · 「地址/密钥对不对」→ 探测结果那一行（有颜色、有下一步动作）；
 * · 「有哪些模型」→ chips（选中态自解释，不需要"如 glm-5.2"这种提示）；
 * · 「KL 留空回退主配置」→ `Disclosure` 的 `hint` + placeholder **就是**
 *   会回退到的那个值（比一句「留空则…」直接）；
 * · 「KL 当前实际生效值」→ `Disclosure` 的 `summary`（收起时也可见）。
 *
 * ## 保存按钮的 dirty 态
 *
 * 没改任何东西时按钮 disabled。首版无论改没改都能点，点完还显示「已保存」
 * —— 那是**假反馈**：它让用户以为自己的某个改动生效了，而实际上什么都没提交。
 *
 * ## apiKey 的三态
 *
 * UI 不回显完整 key（Tag 只给后 4 位）。输入框空串 = **不改**（保留旧值），
 * 不是清空 —— placeholder 就写着这件事。
 *
 * ## 表单自己**不带**分区标题
 *
 * 两个调用方都已经有标题（设置页的 `Section` / onboarding 的页标题）。
 * 再挂一层就是同一件事说三四遍 —— 标题的责任留给容器。
 */
import { useState } from "react"
import { Button, Disclosure, Field, Input, Tag, cn } from "@mycontext/design"
import type {
  ModelProvider,
  RuntimeConfigProbe,
  RuntimeConfigView,
  SaveRuntimeConfigInput,
} from "@mycontext/ipc-contract"
import { useProbeRuntimeConfig, useRuntimeConfig, useSaveRuntimeConfig } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"

export interface ModelConfigFormProps {
  /** onboarding 里保存成功后回调（用于记 stepDone）。设置面板不传。 */
  onSaved?: () => void
  /** 保存按钮文案覆盖（onboarding 用「保存并继续」）。 */
  saveLabel?: string
}

/**
 * 还没探测时的推荐模型档位。
 *
 * ★ 给档位而不是空输入框（与 `PersonaRuntimePanel` 同一个判断：
 * "给档位就是给建议"）。这几个是本机网关实测能用的：`glm-5.2` 是默认
 * （openai + anthropic 双协议都支持，主 LLM 与知识库抽取可以共用一个）。
 *
 * 探测成功后**用真实列表替换**它 —— 兜底值的作用只是"别让第一眼是空的"。
 */
const SUGGESTED_MODELS = ["glm-5.2", "claude-sonnet-4-6", "qwen3.7-plus"] as const
const SUGGESTED_EMBED = ["text-embedding-v4"] as const

export function ModelConfigForm({ onSaved, saveLabel }: ModelConfigFormProps) {
  const { t } = useDynamicTranslation("settings")
  const config = useRuntimeConfig()
  const save = useSaveRuntimeConfig()
  const probe = useProbeRuntimeConfig()

  // 受控草稿：null = 未编辑（显示当前值）。apiKey 单独用空串草稿（不回显）。
  const [llmBaseUrl, setLlmBaseUrl] = useState<string | null>(null)
  const [modelMain, setModelMain] = useState<string | null>(null)
  const [embedModel, setEmbedModel] = useState<string | null>(null)
  const [apiKey, setApiKey] = useState("")
  /** 主模型协议草稿。null = 未编辑（用探测识别值或已存值）。 */
  const [mainProvider, setMainProvider] = useState<ModelProvider | null>(null)
  const [klBaseUrl, setKlBaseUrl] = useState<string | null>(null)
  const [klModel, setKlModel] = useState<string | null>(null)
  const [klApiKey, setKlApiKey] = useState("")
  /** 知识库协议草稿。null = 未编辑（用探测识别值或已存值）。 */
  const [klProvider, setKlProvider] = useState<ModelProvider | null>(null)
  /** 模型名手输模式（探测列表里没有想要的那个时） */
  const [customModel, setCustomModel] = useState(false)
  /**
   * 探测是**针对哪组凭据**跑的。
   *
   * ★ 防假反馈：探测成功给了绿灯后，用户又改了地址/密钥 —— 那条绿灯就
   * **不再代表当前输入**了（它测的是改之前那组）。而 `probe.data` 会一直留着。
   * 记下"探测时用的地址 + 有没有带 key"，当前草稿与之不一致时就不显示旧结果。
   * 这与本组件反对的"保存按钮假反馈"是同一条原则：结论必须对应当前状态。
   */
  const [probedAgainst, setProbedAgainst] = useState<{ baseUrl: string; withKey: boolean } | null>(
    null,
  )

  const current: RuntimeConfigView | undefined = config.data
  if (current === undefined) return null

  const baseUrlValue = llmBaseUrl ?? current.llmBaseUrl.value
  const modelValue = modelMain ?? current.modelMain.value
  const embedValue = embedModel ?? current.embedModel.value

  /**
   * 有没有未保存的改动。
   *
   * 没有就把保存按钮禁掉 —— 否则点一下会显示「已保存」而其实什么都没提交
   * （假反馈）。apiKey 的非空草稿也算改动（它的空串语义是"不改"）。
   */
  const dirty =
    llmBaseUrl !== null ||
    modelMain !== null ||
    mainProvider !== null ||
    embedModel !== null ||
    klBaseUrl !== null ||
    klModel !== null ||
    klProvider !== null ||
    apiKey !== "" ||
    klApiKey !== ""

  const submit = (): void => {
    const patch: SaveRuntimeConfigInput = {}
    if (llmBaseUrl !== null) patch.llmBaseUrl = llmBaseUrl
    if (modelMain !== null) patch.modelMain = modelMain
    if (mainProvider !== null) patch.mainProvider = mainProvider
    if (embedModel !== null) patch.embedModel = embedModel
    // 空串 = 不改（UI 不回显旧 key）
    if (apiKey !== "") patch.llmApiKey = apiKey
    if (klBaseUrl !== null) patch.klLlmBaseUrl = klBaseUrl
    if (klModel !== null) patch.klModelMain = klModel
    if (klApiKey !== "") patch.klLlmApiKey = klApiKey
    if (klProvider !== null) patch.klProvider = klProvider
    save.mutate(patch, {
      onSuccess: () => {
        // 草稿清空 → dirty 回到 false（保存后按钮自然禁掉）
        setApiKey("")
        setKlApiKey("")
        setLlmBaseUrl(null)
        setModelMain(null)
        setMainProvider(null)
        setEmbedModel(null)
        setKlBaseUrl(null)
        setKlModel(null)
        setKlProvider(null)
        onSaved?.()
      },
    })
  }

  /** 探测用**草稿值**：先测通再存才是自然顺序。 */
  const runProbe = (): void => {
    setProbedAgainst({ baseUrl: baseUrlValue, withKey: apiKey !== "" })
    probe.mutate({
      ...(baseUrlValue.trim() === "" ? {} : { baseUrl: baseUrlValue }),
      ...(apiKey === "" ? {} : { apiKey }),
    })
  }

  /**
   * 探测结果是否**仍对应当前输入**。
   *
   * 探完之后改了地址、或加/去了 key，旧结果就过期了 —— 这时不展示它，
   * 也不拿它的模型列表去覆盖推荐档位（否则会拿"上一次网关"的列表给"这一次地址"挑）。
   */
  const probeFresh =
    probedAgainst !== null &&
    probedAgainst.baseUrl === baseUrlValue &&
    probedAgainst.withKey === (apiKey !== "")

  const result: RuntimeConfigProbe | undefined = probeFresh ? probe.data : undefined
  /** 探到的列表优先；没探过用推荐档位。 */
  const modelOptions =
    result?.ok === true && result.models.length > 0
      ? result.models
      : (SUGGESTED_MODELS as readonly string[])
  const embedOptions =
    result?.ok === true && result.models.length > 0
      ? result.models.filter((id) => /embed/i.test(id))
      : (SUGGESTED_EMBED as readonly string[])

  /**
   * 某个**具体模型**支持哪些协议（读探测到的 `modelProviders`）。
   *
   * 探到该模型的 `supported_endpoint_types` 就用它；探不到（老网关不给、或
   * 没探过）回退到**网关级**支持集。这让"选了只支持 openai 的模型"时
   * anthropic chip 能标灰，而不是拿网关整体的支持集去糊每个模型。
   */
  const providersForModel = (model: string): readonly ModelProvider[] => {
    const per = result?.ok === true ? result.modelProviders[model] : undefined
    if (per !== undefined && per.length > 0) return per
    return result?.ok === true && result.providers.length > 0
      ? result.providers
      : (["openai", "anthropic"] as const)
  }

  /**
   * 某个模型的**推荐协议**：它支持 anthropic 就选 anthropic（claude 类走原生协议
   * 信息更全），否则 openai。这就是"从列表里选一个模型 → 自动选好它的协议"。
   */
  const preferredProviderFor = (model: string): ModelProvider =>
    providersForModel(model).includes("anthropic") ? "anthropic" : "openai"

  /**
   * 知识库那一路**实际会用**的协议：
   * 用户手动切的 > 新鲜探测下**所选 kl 模型**的推荐协议 > 已存值。
   *
   * ★ 从"网关级识别值"改成"按所选模型"：同一个网关里有的模型只支持 openai、
   * 有的两者都支持，拿网关级的一个值套所有模型是错的。用户手选仍然优先
   * （`klProvider !== null`），选模型时会把手选清掉（见 onPick），于是自动重算。
   */
  const klModelValue = klModel ?? current.klModelMain.value
  const effectiveKlProvider: ModelProvider =
    klProvider ??
    (result?.ok === true && klModelValue.trim() !== ""
      ? preferredProviderFor(klModelValue)
      : null) ??
    current.klEffective.provider

  /**
   * 主模型实际会用的协议：用户手动切的 > 新鲜探测下**所选主模型**的推荐协议 > 已存值。
   */
  const effectiveMainProvider: ModelProvider =
    mainProvider ??
    (result?.ok === true && modelValue.trim() !== "" ? preferredProviderFor(modelValue) : null) ??
    current.mainProvider.value

  /**
   * 探测识别到的网关**支持的协议集**（网关级，用于顶部 tag）。没探过（或探测没给
   * 协议信息）时两个都摆出来 —— 让用户仍能手选，只是没有"这个网关支持哪些"的确证。
   */
  const supportedProviders: readonly ModelProvider[] =
    result?.ok === true && result.providers.length > 0 ? result.providers : ["openai", "anthropic"]

  return (
    <div className="flex flex-col gap-[var(--gap-section-lg)]">
      <section className="flex flex-col gap-[var(--gap-section-sm)]">
        <Field label={t("model.provider.baseUrl")}>
          {(attributes) => (
            <Input
              {...attributes}
              value={baseUrlValue}
              onChange={(event) => setLlmBaseUrl(event.target.value)}
              placeholder="https://…"
            />
          )}
        </Field>

        {/* key 的状态跟在 label 右边（Tag），不再单独占一行描述 */}
        <div className="flex flex-col gap-[var(--gap-component-sm)]">
          <div className="flex items-center gap-2">
            <span className="typography-body-small-400 text-[var(--text-base-secondary)]">
              {t("model.provider.apiKey")}
            </span>
            <KeyTag field={current.llmApiKey} />
          </div>
          <Input
            type="password"
            aria-label={t("model.provider.apiKey")}
            value={apiKey}
            onChange={(event) => setApiKey(event.target.value)}
            placeholder={t("model.provider.apiKeyPlaceholder")}
          />
        </div>

        {/*
          ★ 测试连接。放在"地址 + 密钥"之后、"选模型"之前 —— 这个顺序
          就是操作顺序：填好凭证 → 测通 → 从探到的列表里挑模型。
        */}
        <div className="flex items-center gap-3">
          <Button size="sm" variant="secondary" disabled={probe.isPending} onClick={runProbe}>
            {probe.isPending ? t("model.probe.testing") : t("model.probe.test")}
          </Button>
          <ProbeResult result={result} failed={probeFresh && probe.isError} />
        </div>

        {/*
          模型选择：chips（探到的列表 / 推荐档位）+ 「其它」手输。
          选中态自己就说明了"现在用哪个"，不需要「如 glm-5.2」这类提示。
        */}
        <div className="flex flex-col gap-[var(--gap-component-sm)]">
          <div className="flex items-center gap-2">
            <span className="typography-body-small-400 text-[var(--text-base-secondary)]">
              {t("model.provider.modelMain")}
            </span>
            {result?.ok === true && result.models.length > 0 && (
              <Tag size="sm" status="accent">
                {t("model.probe.fromGateway", { count: result.models.length })}
              </Tag>
            )}
            {/* 探测识别到的网关**支持的协议集** —— 让用户看见这网关到底支持哪些 */}
            {result?.ok === true && result.providers.length > 0 && (
              <Tag size="sm" status="default">
                {t("model.probe.detectedProtocol", {
                  provider: result.providers.map((p) => t(`model.provider.${p}`)).join(" / "),
                })}
              </Tag>
            )}
          </div>
          <ChipPicker
            options={modelOptions}
            value={modelValue}
            onPick={(next) => {
              setModelMain(next)
              setCustomModel(false)
              // ★ 选了模型就把手动协议清掉 → effectiveMainProvider 自动取该模型的
              // 推荐协议（有 anthropic 选 anthropic）。用户之后仍可再手动切。
              setMainProvider(null)
            }}
            otherLabel={t("model.other")}
            custom={customModel || !modelOptions.includes(modelValue)}
            onCustom={() => setCustomModel(true)}
          />
          {(customModel || !modelOptions.includes(modelValue)) && (
            <Input
              aria-label={t("model.provider.modelMain")}
              value={modelValue}
              onChange={(event) => setModelMain(event.target.value)}
              placeholder="glm-5.2"
            />
          )}
          {/*
            ★ 探测成功、且当前模型名**不在**网关返回的列表里 → 明确警告。
            这正是本组件要防的那个静默失效：模型名对不上，几小时后的蒸馏/建图
            才以 `model_not_found` 报错，界面当下无声。既然刚探到了真实列表，
            就能当场指出"这个名字网关不认识"，把无声变成可见。
            只在 result.ok（真拿到列表）时判 —— 没探过不知道网关有什么，不妄断。
          */}
          {result?.ok === true &&
            result.models.length > 0 &&
            modelValue.trim() !== "" &&
            !result.models.includes(modelValue) && (
              <span className="typography-caption-400 text-[var(--status-warning)]">
                {t("model.probe.modelNotListed")}
              </span>
            )}
        </div>

        {/*
          ★ 主模型协议选择器 —— 现在可切（去掉了原来那句"不可切换"）。
          opencode 子进程按它选 @ai-sdk/anthropic / @ai-sdk/openai-compatible 内联
          provider，直连 LlmClient 按它走 /v1/messages / /v1/chat/completions。
          两个 chip 亮不亮由**所选模型**的 supported_endpoint_types 决定（不是网关整体）——
          选了只支持 openai 的模型时 anthropic chip 就标灰。
        */}
        <ProviderPicker
          label={t("model.provider.protocol")}
          hint={t("model.provider.mainProtocolHint")}
          value={effectiveMainProvider}
          supported={providersForModel(modelValue)}
          onPick={setMainProvider}
          openaiLabel={t("model.provider.openai")}
          anthropicLabel={t("model.provider.anthropic")}
          unsupportedLabel={t("model.provider.unsupported")}
        />

        <div className="flex flex-col gap-[var(--gap-component-sm)]">
          <span className="typography-body-small-400 text-[var(--text-base-secondary)]">
            {t("model.provider.embedModel")}
          </span>
          <ChipPicker
            options={
              embedOptions.length > 0 ? embedOptions : (SUGGESTED_EMBED as readonly string[])
            }
            value={embedValue}
            onPick={(next) => setEmbedModel(next)}
          />
        </div>
      </section>

      {/*
        KL 专用网关。
        · `hint` 说「留空 = 用上面的」—— 折叠标题下一行，正是帮人决定要不要展开；
        · `summary` 给当前**实际生效**值 —— 收起时也看得见，看个值不用先展开。
      */}
      <Disclosure
        title={t("model.kl.title")}
        hint={t("model.kl.hint")}
        summary={`${current.klEffective.model || "—"} · ${t(
          `model.provider.${current.klEffective.provider}`,
        )}`}
      >
        <div className="flex flex-col gap-[var(--gap-section-sm)]">
          <Field label={t("model.provider.baseUrl")}>
            {(attributes) => (
              <Input
                {...attributes}
                value={klBaseUrl ?? current.klLlmBaseUrl.value}
                onChange={(event) => setKlBaseUrl(event.target.value)}
                // placeholder 就是会回退到的那个值 —— 比一句「留空则…」更直接
                placeholder={baseUrlValue || "https://…"}
              />
            )}
          </Field>

          {/*
            ★ 协议选择器 —— 知识库那一路真能切协议（传给 kl 的 KL_LLM_PROVIDER）。
            两个 chip 亮不亮由**所选 kl 模型**的 supported_endpoint_types 决定，点击可覆盖。
            这就是「OpenAI 兼容网关被当 Anthropic 发 → 404」那个报错的用户侧修复。
          */}
          <ProviderPicker
            label={t("model.provider.protocol")}
            hint={t("model.kl.protocolHint")}
            value={effectiveKlProvider}
            supported={
              klModelValue.trim() !== "" ? providersForModel(klModelValue) : supportedProviders
            }
            onPick={setKlProvider}
            openaiLabel={t("model.provider.openai")}
            anthropicLabel={t("model.provider.anthropic")}
            unsupportedLabel={t("model.provider.unsupported")}
          />

          <div className="flex flex-col gap-[var(--gap-component-sm)]">
            <div className="flex items-center gap-2">
              <span className="typography-body-small-400 text-[var(--text-base-secondary)]">
                {t("model.provider.apiKey")}
              </span>
              <KeyTag field={current.klLlmApiKey} fallbackLabel={t("model.kl.inherited")} />
            </div>
            <Input
              type="password"
              aria-label={t("model.provider.apiKey")}
              value={klApiKey}
              onChange={(event) => setKlApiKey(event.target.value)}
              placeholder={t("model.provider.apiKeyPlaceholder")}
            />
          </div>

          <div className="flex flex-col gap-[var(--gap-component-sm)]">
            <span className="typography-body-small-400 text-[var(--text-base-secondary)]">
              {t("model.provider.modelMain")}
            </span>
            <ChipPicker
              options={modelOptions}
              value={klModel ?? current.klModelMain.value}
              onPick={(next) => {
                setKlModel(next)
                // ★ 选了 kl 模型就把手动协议清掉 → effectiveKlProvider 自动取该模型的
                // 推荐协议（有 anthropic 选 anthropic）。用户之后仍可再手动切。
                setKlProvider(null)
              }}
              // 空值 = 跟随主配置，所以这里多一个「跟随」档
              inheritLabel={t("model.kl.inherited")}
              onInherit={() => setKlModel("")}
            />
          </div>
        </div>
      </Disclosure>

      <div className="flex items-center gap-3">
        <Button size="sm" disabled={save.isPending || !dirty} onClick={submit}>
          {saveLabel ?? t("model.save")}
        </Button>
        {/* 只在**真的存过**之后显示，且改动后（dirty）就撤掉 —— 不给假反馈 */}
        {save.isSuccess && !dirty && (
          <Tag size="sm" status="success" showIndicator>
            {t("model.saved")}
          </Tag>
        )}
      </div>
    </div>
  )
}

/**
 * 「配没配 key」用一个 Tag 表达，不用一整行描述。
 *
 * 已配置显示后 4 位（够确认"是我那把 key"）；未配置是**中性灰**而非红色 ——
 * 没配 key 在 onboarding 里是正常的起始状态，一进来就看到红色
 * 会让人以为自己弄坏了什么。
 */
function KeyTag({
  field,
  fallbackLabel,
}: {
  field: RuntimeConfigView["llmApiKey"]
  fallbackLabel?: string
}) {
  const { t } = useDynamicTranslation("settings")
  if (field.configured) {
    return (
      <Tag size="sm" status="success" showIndicator>
        {field.tail === null ? t("model.keyOn") : t("model.keyTail", { tail: field.tail })}
      </Tag>
    )
  }
  return (
    <Tag size="sm" status="default">
      {fallbackLabel ?? t("model.keyOff")}
    </Tag>
  )
}

/**
 * 探测结果那一行。
 *
 * ★ 失败时给的是**可照做的下一步**，不是网关的英文报文：
 * 401 该去换密钥、DNS 失败该去查地址 —— 两者的动作完全不同，
 * 所以 reason 分类在主进程就做好了（见 RuntimeConfigService.probe）。
 * 原文放进 `title`（悬停可见），不怼到界面上。
 */
function ProbeResult({
  result,
  failed,
}: {
  result: RuntimeConfigProbe | undefined
  failed: boolean
}) {
  const { t } = useDynamicTranslation("settings")
  // IPC 本身失败（极少见）也要有话说，不能静默
  if (failed) {
    return (
      <Tag size="sm" status="error" showIndicator>
        {t("model.probe.reason.unreachable")}
      </Tag>
    )
  }
  if (result === undefined) return null
  if (result.ok) {
    return (
      <Tag size="sm" status="success" showIndicator>
        {t("model.probe.ok", { count: result.models.length })}
      </Tag>
    )
  }
  return (
    <span
      className="typography-caption-400 text-[var(--status-error)]"
      title={result.detail ?? undefined}
    >
      {t(`model.probe.reason.${result.reason ?? "unreachable"}`)}
    </span>
  )
}

/**
 * 协议选择器（openai / anthropic 两个 chip）。
 *
 * ★ 两个 chip 都**始终显示**，但网关探测确认不支持的那个标灰、点了给一行提示 ——
 * 而不是把它藏掉。藏掉的话用户会以为"这网关只有一个协议"，而这正是之前那个
 * 误导性 bug 的另一种形态。显示 + 标注既诚实又不挡手（没探过时两个都可点）。
 */
function ProviderPicker({
  label,
  hint,
  value,
  supported,
  onPick,
  openaiLabel,
  anthropicLabel,
  unsupportedLabel,
}: {
  label: string
  hint: string
  value: ModelProvider
  /** 探测确认网关支持的协议集（没探过时传两个都在，等于不限制）。 */
  supported: readonly ModelProvider[]
  onPick: (next: ModelProvider) => void
  openaiLabel: string
  anthropicLabel: string
  /** 选了一个网关不支持的协议时的提示文案。 */
  unsupportedLabel: string
}) {
  const options: { id: ModelProvider; label: string }[] = [
    { id: "openai", label: openaiLabel },
    { id: "anthropic", label: anthropicLabel },
  ]
  // 当前选中的协议不在网关支持集里 → 给一行警告（与 modelNotListed 同一个防法）。
  const pickedUnsupported = supported.length > 0 && !supported.includes(value)
  return (
    <div className="flex flex-col gap-[var(--gap-component-sm)]">
      <span className="typography-body-small-400 text-[var(--text-base-secondary)]">{label}</span>
      <div className="flex flex-wrap gap-1.5">
        {options.map((option) => {
          const isSupported = supported.length === 0 || supported.includes(option.id)
          return (
            <Chip key={option.id} selected={value === option.id} onClick={() => onPick(option.id)}>
              {/* 网关明确不支持的那个：标一个「!」提示它没被验证过，但仍可点 */}
              {isSupported ? option.label : `${option.label} !`}
            </Chip>
          )
        })}
      </div>
      {pickedUnsupported ? (
        <span className="typography-caption-400 text-[var(--status-warning)]">
          {unsupportedLabel}
        </span>
      ) : (
        <span className="typography-caption-400 text-[var(--text-base-tertiary)]">{hint}</span>
      )}
    </div>
  )
}

/**
 * 档位选择器（chips）。
 *
 * 对齐 `PersonaRuntimePanel` 的 `LimitRow`：**给档位就是给建议**。
 * 空输入框会让用户去想"填什么合法"，而这里选中态本身就是答案。
 *
 * 列表可能很长（网关实测 68 个模型），所以 `flex-wrap` + 滚动上限。
 */
function ChipPicker({
  options,
  value,
  onPick,
  otherLabel,
  custom = false,
  onCustom,
  inheritLabel,
  onInherit,
}: {
  options: readonly string[]
  value: string
  onPick: (next: string) => void
  /** 传了才显示「其它」（切到手输） */
  otherLabel?: string
  custom?: boolean
  onCustom?: () => void
  /** 传了才显示「跟随主配置」档（KL 用，空值即继承） */
  inheritLabel?: string
  onInherit?: () => void
}) {
  return (
    <div className="flex max-h-[136px] flex-wrap gap-1.5 overflow-y-auto">
      {inheritLabel !== undefined && onInherit !== undefined && (
        <Chip selected={value === ""} onClick={onInherit}>
          {inheritLabel}
        </Chip>
      )}
      {options.map((option) => (
        <Chip key={option} selected={!custom && value === option} onClick={() => onPick(option)}>
          {option}
        </Chip>
      ))}
      {otherLabel !== undefined && onCustom !== undefined && (
        <Chip selected={custom} onClick={onCustom}>
          {otherLabel}
        </Chip>
      )}
    </div>
  )
}

function Chip({
  selected,
  onClick,
  children,
}: {
  selected: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        "typography-caption-400 cursor-pointer rounded-[var(--radius-sm)] px-2 py-1 transition-colors duration-150",
        "focus-visible:outline-none focus-visible:shadow-[var(--shadow-focus-ring)]",
        selected
          ? "bg-[var(--overlay-on-container-selected)] text-[var(--text-base-primary)]"
          : "text-[var(--text-base-secondary)] hover:bg-[var(--overlay-on-container-hover)] hover:text-[var(--text-base-primary)]",
      )}
    >
      {children}
    </button>
  )
}
