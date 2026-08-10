/**
 * 「使用自有 dws」——让用户指定自己安装的那份 CLI。
 *
 * ## 为什么在授权卡片里，而不是设置页深处
 *
 * 需要换 dws 的人**只在一个时刻**需要它：授权走不通的时候。
 * 那时他正看着授权卡片，而不是在翻设置 —— 把入口放在这里，
 * 「授权失败」与「换一个 CLI 试试」在同一屏内。
 * 卡片本身 onboarding 与设置页共用，所以两处自动都有。
 *
 * ## 隐蔽程度：默认折叠，不进主流程文案
 *
 * 绝大多数用户用随包那份（开源版）就够了，不该在首次引导里看到一个
 * 「填路径」的输入框 —— 那会让人以为这是必填的一步。
 * 所以折叠起来，标题也刻意平淡（不写"闭源版"这类内部概念）。
 *
 * ## ★ 已经设了的时候**默认展开**
 *
 * 折叠是为了不打扰"不需要它的人"。而已经设过路径的人属于另一类：
 * 他要么在确认还生效、要么在排查问题 —— 那时把状态藏在折叠里
 * 恰好挡住了他要看的东西。同理，路径失效（`configuredMissing`）
 * 必须展开并显式提示，否则用户会以为自己没设过。
 */
import { useEffect, useState } from "react"
import { Button, Input, cn } from "@mycontext/design"
import { useDwsSource, useSaveDwsSource } from "../../lib/queries.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { useErrorText } from "../../lib/use-error-text.js"

export function DwsSourceDisclosure() {
  const { t } = useDynamicTranslation("channels")
  const source = useDwsSource()
  const save = useSaveDwsSource()
  const view = source.data

  const configured = view?.configuredPath ?? null
  const missing = view?.configuredMissing ?? false
  /** 见文件头：设过的人默认展开，没设的人默认折叠。 */
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState("")
  const [channelDraft, setChannelDraft] = useState("")

  // 读到配置后同步一次：已设 → 展开并回填；未设 → 保持折叠。
  useEffect(() => {
    if (view === undefined) return
    if (view.configuredPath !== null) {
      setOpen(true)
      setDraft(view.configuredPath)
    }
    setChannelDraft(view.channelCode ?? "")
  }, [view])

  const errorText = useErrorText()
  const failure = save.error === null ? undefined : errorText(save.error)

  const submit = () => {
    const next = draft.trim()
    save.mutate({ path: next === "" ? null : next })
  }

  const submitChannel = () => {
    const next = channelDraft.trim()
    save.mutate({ channelCode: next === "" ? null : next })
  }

  /** 只在**非默认状态**下才在入口上标出来 —— 默认状态不该占视觉重量。 */
  const badge = missing
    ? t("dwsSource.badgeMissing")
    : configured !== null
      ? t("dwsSource.badgeCustom")
      : view?.pathFromDefaults != null
        ? t("dwsSource.badgeFromEnv")
        : null

  return (
    <div className="flex flex-col items-end">
      {/*
        ★ 入口做成**右下角一行小字下划线**，不是一张边框卡片。
        它是"绝大多数人不需要"的逃生阀 —— 给它一个卡片的视觉重量，
        会让人在首次引导里以为这是必经的一步（授权范围那三条才是主角）。
        非默认状态才附一个徽章，否则连徽章都不占位置。
      */}
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className={cn(
          "typography-caption-400 underline underline-offset-2",
          missing ? "text-[var(--status-warning)]" : "text-[var(--text-base-tertiary)]",
        )}
        aria-expanded={open}
        data-testid="dws-source-toggle"
      >
        {badge === null ? t("dwsSource.title") : `${t("dwsSource.title")}（${badge}）`}
      </button>

      {open ? (
        <div className="radius-md mt-2 flex w-full flex-col gap-2 border border-[var(--border-divider-light)] px-3 py-3">
          <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
            {t("dwsSource.description")}
          </p>

          {/*
            ★ `.env` 里配了就说出来：否则开发者在 .env 里写了路径、
            却看到输入框是空的，会以为配置丢了然后再填一遍。
            UI 值优先于它 —— 填了输入框就盖住这条。
          */}
          {view?.pathFromDefaults != null && configured === null ? (
            <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
              {t("dwsSource.fromEnv", { path: view.pathFromDefaults })}
            </p>
          ) : null}

          <div className="flex items-center gap-2">
            <Input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={t("dwsSource.placeholder")}
              spellCheck={false}
              data-testid="dws-source-input"
              onKeyDown={(event) => {
                if (event.key === "Enter") submit()
              }}
            />
            <Button
              variant="secondary"
              onClick={submit}
              disabled={save.isPending}
              data-testid="dws-source-save"
            >
              {save.isPending ? t("dwsSource.saving") : t("dwsSource.save")}
            </Button>
          </div>

          {/*
            ★ 路径失效要显式说：不然用户看到输入框里还有那条路径，
            会以为它在生效，而实际跑的是随包那份。
          */}
          {missing ? (
            <p
              role="alert"
              className="typography-body-small-400 radius-md bg-[var(--status-fill-warning-container)] px-3 py-2 text-[var(--status-warning)]"
            >
              {t("dwsSource.missing")}
            </p>
          ) : null}

          {failure !== undefined ? (
            <p
              role="alert"
              className="typography-body-small-400 radius-md bg-[var(--status-fill-error-container)] px-3 py-2 text-[var(--status-error)]"
            >
              {failure}
            </p>
          ) : null}

          {/*
            当前实际生效的版本号。这是"我到底在用哪个"唯一可信的答案 ——
            比回显路径有用：路径可能失效，而版本号来自真跑一次 `--version`。
          */}
          {view?.effectiveVersion != null ? (
            <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
              {t("dwsSource.effective", { version: view.effectiveVersion })}
            </p>
          ) : null}

          {/*
            渠道号是**自有 dws 的附属项**（与那份二进制内置的 OAuth 身份配套，
            见 service 文件头），所以缩进 + 更淡的说明：它比路径更少人需要填
            （只有组织限定了渠道范围才要），不该看起来和路径一样重要。

            ## ★★ 但**不能**用 `configured !== null` 把它整块藏掉

            原来这里是 `configured !== null ? … : null`，理由写的是"用在随包的
            开源版上是错的配对，所以没设路径时连入口都不给"。那条推理有个
            **顺序错误**：`configured` 是 `storedPath()`，也就是"用户在这个
            输入框里成功存过路径"。而一台新装的机器上它恒为 null ——
            于是渠道号框压根不渲染，用户没有任何地方能填它。

            实测（打包态 `~/Library/Application Support/MyContext` 的
            `app_settings` 里 `dws_source_path` / `dws_channel_code` 都不存在）：
            新装的包里这一块完全不出现，而**填渠道号本来就是内部同学装完包
            要做的第一件事**。这不是"少一个高级选项"，是那条路整个不通。

            更糟的是它让 `channelInactive` 那句文案**恒不可达**：能看到框时
            路径已经存过且验证过（`savePath` 会 spawn `--version`），
            `channelActive` 基本恒 true。也就是说"填了但不生效"这个真实状态
            唯一的出口被这个条件挡住了。

            所以现在**始终显示**，生不生效由 `channelActive` 说出来
            —— 那正是那个字段存在的理由（见 service 里它的注释）。
          */}
          <div className="mt-1 flex flex-col gap-2 border-l-2 border-[var(--border-divider-light)] pl-3">
            <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
              {t("dwsSource.channelDescription")}
            </p>
            <div className="flex items-center gap-2">
              <Input
                value={channelDraft}
                onChange={(event) => setChannelDraft(event.target.value)}
                placeholder={t("dwsSource.channelPlaceholder")}
                spellCheck={false}
                data-testid="dws-channel-input"
                onKeyDown={(event) => {
                  if (event.key === "Enter") submitChannel()
                }}
              />
              <Button
                variant="secondary"
                onClick={submitChannel}
                disabled={save.isPending}
                data-testid="dws-channel-save"
              >
                {t("dwsSource.save")}
              </Button>
            </div>
            {/*
              ★ 填了但没生效要说出来 —— 否则用户填完看不出任何变化，
              会以为保存失败了。两种成因（没设自有 dws / 设了但路径失效）
              都落在这一句上：文案说的是"当前用的是自带的 dws"，
              而那正是 `channelActive:false` 的充要条件（见 `channel()`）。
            */}
            {view?.channelCode != null && view.channelActive === false ? (
              <p className="typography-body-small-400 text-[var(--status-warning)]">
                {t("dwsSource.channelInactive")}
              </p>
            ) : null}
            {/* 默认层（.env / 环境变量）来的值：与"我填的"区分开 */}
            {view?.channelCode == null && view?.channelFromDefaults != null ? (
              <p className="typography-body-small-400 text-[var(--text-base-tertiary)]">
                {t("dwsSource.channelFromEnv")}
              </p>
            ) : null}
          </div>

          {configured !== null ? (
            <button
              type="button"
              onClick={() => {
                setDraft("")
                save.mutate({ path: null })
              }}
              className="typography-body-small-400 self-start text-[var(--text-base-tertiary)] underline"
              data-testid="dws-source-clear"
            >
              {t("dwsSource.clear")}
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
