/**
 * 身份编辑：显示名 + 头像。
 *
 * ## ★ 「清空头像」也是 manual
 *
 * 清空之后回落到首字母色块（那正是 Avatar 的兜底）。这一步会把
 * `avatar_source` 标成 `manual` —— 于是渠道授权**不会**再把头像塞回来。
 * 「我不要头像」是一个明确的选择，不该被下一次授权推翻。
 *
 * ## 头像有三种来源
 *
 * 填 URL / 上传本地图片 / 从已连接的平台取。三者都写同一个字段，
 * 且都算 `manual` —— 都是用户显式的动作。
 *
 * ★ 这段注释**曾经说"渠道那一路填不上值"**（理由是钉钉没有用户头像接口）。
 * 那个结论已经过时：钉钉确实没有直接的头像接口，但经**共同群的成员详情**
 * 能拿到 `avatarMediaId`，那条路已经实现并接通了
 * （见 `plugins/dingtalk/avatar.ts`）。授权成功后主进程会自动取一次，
 * 这里的按钮是**手动刷新**的入口（换了头像时用）。
 *
 * ## 保存按钮不能省
 *
 * 语言与主题是"立即生效"的偏好，所以那些行没有保存按钮。
 * 但名字是**逐字输入**的：每敲一个字就发一次 IPC 会把半成品名字写进库
 * （中途的"王"会短暂成为显示名）。所以这里显式保存。
 */
import { useEffect, useState } from "react"
import { Avatar, Button, Field, Input } from "@mycontext/design"
import { resolveDisplayName, type AuthSession } from "@mycontext/ipc-contract"
import { useUpdateProfile, useFetchSelfAvatar } from "../../lib/queries.js"
import { useErrorText } from "../../lib/use-error-text.js"
import { useDynamicTranslation } from "../../lib/use-dynamic-translation.js"
import { ImagePicker } from "../shared/image-picker.js"

export interface IdentityPanelProps {
  session: AuthSession
}

export function IdentityPanel({ session }: IdentityPanelProps) {
  const { t } = useDynamicTranslation("settings")
  const { t: tc } = useDynamicTranslation("common")
  const errorText = useErrorText()
  const update = useUpdateProfile()
  const selfAvatar = useFetchSelfAvatar()

  const [name, setName] = useState(session.displayName ?? "")
  const [avatar, setAvatar] = useState(session.avatarUrl ?? "")

  /**
   * 会话变了（换账号 / 保存成功后回填）就重置表单。
   *
   * 依赖 `accountId` 而不是整个 session：后者每次 refetch 都是新对象，
   * 会在用户输入途中把输入框重置 —— 表现是"打字打不进去"。
   */
  useEffect(() => {
    setName(session.displayName ?? "")
    setAvatar(session.avatarUrl ?? "")
  }, [session.accountId, session.displayName, session.avatarUrl])

  const dirty = name !== (session.displayName ?? "") || avatar !== (session.avatarUrl ?? "")

  /** 预览用的名字：清空输入框时预览应当显示兜底（email 前缀），与保存后一致。 */
  const previewName = resolveDisplayName({ displayName: name, email: session.email })

  /**
   * 只提交**真的改过**的字段。
   *
   * ## ★ 为什么不能无脑两个都发
   *
   * `updateProfile` 收到 `avatarUrl` 就会写 `avatar_source='manual'`
   * （那是"用户显式设过"的标记）。所以只改名字、而头像框本来是空的时候，
   * 无脑两个都发 = 写下一行 `avatar_url=NULL, source='manual'` ——
   * 而那个组合会让渠道头像**永久**填不进来（`applyChannelProfile` 里
   * 只有"没有 manual 图"才回填）。
   *
   * 实测本机两个账号里就有一个卡在这个状态：头像永远是首字母，
   * 点"从渠道获取"也没用（取到了，但写不进账号）。
   *
   * 那一侧的判据现在也放宽了（manual + NULL 视为没设过），
   * 两处一起改是刻意的：这里不再**产生**这种行，那里能**修复**存量的行。
   */
  const save = () => {
    update.mutate({
      // 空串存成 null：`""` 与"没设置"在库里应当是同一件事，
      // 否则 resolveDisplayName 的兜底判断要处理两种"空"
      ...(name === (session.displayName ?? "")
        ? {}
        : { displayName: name.trim() === "" ? null : name.trim() }),
      ...(avatar === (session.avatarUrl ?? "")
        ? {}
        : { avatarUrl: avatar.trim() === "" ? null : avatar.trim() }),
    })
  }

  return (
    <div className="flex flex-col gap-[var(--gap-section-md)]">
      <div className="flex items-center gap-3">
        <Avatar name={previewName} src={avatar === "" ? null : avatar} size="xl" />
        <div className="flex flex-col">
          <span className="typography-body-base-500 text-[var(--text-base-primary)]">
            {previewName}
          </span>
          <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
            {session.email}
          </span>
          {/*
            ★ 这里原来有一行「头像是你自己设的」/「头像来自渠道授权」。

            去掉的理由：它是在解释一条**内部规则**（`avatar_source`
            决定渠道授权会不会覆盖），而用户在这一屏只想换张图。
            「你自己设的」这句话对着一张自己刚上传的图说，是同义反复；
            而它真正想传达的"改过就不会被换回去"又没说出来。

            下面那行（「用的是一张本地图片」/「网络图片」）保留 ——
            那句在回答一个用户真会问的问题：这张图存在哪。
          */}
        </div>
      </div>

      <Field label={t("identity.displayName")} description={t("identity.displayNameHint")}>
        {(attributes) => (
          <Input
            {...attributes}
            value={name}
            placeholder={session.email.split("@")[0] ?? ""}
            onChange={(event) => setName(event.target.value)}
          />
        )}
      </Field>

      {/*
        ★ 这个 Field **不给** description。

        `Field` 把 description 渲染在 children **之后**，而 children 现在是
        「两个按钮 + 来源说明 + 折叠区」—— 一句"上传一张本地图片，或从已连接
        的平台取"会落在折叠区下面，读起来像在解释那个折叠区，而它其实在
        重复上面那两个按钮的字面意思。

        按钮本身已经说清了能做什么（那是 action-first 的意义）；
        "留空则显示名字首字"这件事由头像预览直接演示 —— 不需要文字。
      */}
      <Field label={t("identity.avatarUrl")}>
        {(attributes) => (
          <span className="flex flex-col gap-1.5">
            {/*
              ★ 两个**动作**排在最前，输入框退到后面（而且默认藏起来）。

              ## 为什么原来那样是错的

              原来第一眼看到的是一个填着
              `mycontext-file://local/Users/you/Library/Application%20Support/…`
              的输入框 —— 那是**内部路径**（上传后主进程回填的），用户既读不懂、
              也不该编辑它，而它占了整块最显眼的位置。

              而真实的操作只有两个：上传一张本地图片，或从已连平台取。
              「填一个图片 URL」对一个本地优先的桌面应用本来就是个奇怪的要求。

              ## 输入框没有删掉，只是收起来

              高级用法（贴一个外部图床 URL）仍然成立，所以保留入口；
              但**默认不展开** —— 而且只有当前值是真的 http(s) URL 时才自动展开
              （那说明用户自己贴过），内部路径不展开。

              删掉它会让"我想用一个网络图片"这件事变成做不到，而那是一次
              功能缩水；藏起来只是把它排到它该在的优先级上。
            */}
            <span className="flex items-center gap-1">
              <ImagePicker
                purpose="avatar"
                label={tc("imagePicker.pick")}
                disabled={update.isPending}
                onPicked={(path) => setAvatar(path)}
              />
              {/*
                ★ 从已连接的平台取自己的头像。
                「怎么才能拿到头像」是渠道特有的知识，收在渠道插件里
                （`ChannelAvatars` 契约）—— 这里只管发起与回填。
              */}
              <Button
                size="sm"
                variant="ghost"
                disabled={selfAvatar.isPending || update.isPending}
                onClick={() => {
                  selfAvatar.mutate(undefined, {
                    onSuccess: (result) => {
                      if (result.path !== null) setAvatar(result.path)
                    },
                  })
                }}
              >
                {selfAvatar.isPending
                  ? t("identity.avatarFetching")
                  : t("identity.avatarFromChannel")}
              </Button>
            </span>

            {/*
              ★ 已经有头像时，用一句人话报**它从哪来**，而不是把路径糊在这。

              「已上传的图片」/「平台头像」/「网络图片」三种来源，用户关心的
              是这个，而不是那串 URL。真要看/改 URL 的走下面那个折叠区。
            */}
            {avatar === "" ? null : (
              <span className="typography-caption-400 text-[var(--text-base-secondary)]">
                {avatar.startsWith("mycontext-file://")
                  ? t("identity.avatarSourceLocal")
                  : t("identity.avatarSourceRemote")}
              </span>
            )}

            <details open={/^https?:\/\//.test(avatar)}>
              <summary className="typography-caption-400 w-fit cursor-pointer text-[var(--text-base-tertiary)] transition-colors hover:text-[var(--text-base-secondary)]">
                {t("identity.avatarAdvanced")}
              </summary>
              <span className="mt-1.5 block">
                <Input
                  {...attributes}
                  value={avatar}
                  placeholder="https://…"
                  onChange={(event) => setAvatar(event.target.value)}
                />
              </span>
            </details>
            {/*
              取不到时说清是**哪一种**取不到：没设过头像 / 没有共同群 /
              下载失败。只说"失败"的话用户不知道该不该再试
              （前两种再试一百次也一样）。
            */}
            {selfAvatar.data?.path === null && selfAvatar.data.reason !== null ? (
              <span className="typography-caption-400 text-[var(--text-base-tertiary)]">
                {t(`identity.avatarMiss.${selfAvatar.data.reason}`, {
                  defaultValue: t("identity.avatarMissOther"),
                })}
              </span>
            ) : null}
          </span>
        )}
      </Field>

      {update.error === null ? null : (
        <p className="typography-body-small-400 text-[var(--status-error)]">
          {errorText(update.error)}
        </p>
      )}

      <div className="flex items-center gap-2">
        <Button size="md" disabled={!dirty || update.isPending} onClick={save}>
          {t("identity.save")}
        </Button>
        {avatar === "" ? null : (
          <Button
            size="md"
            variant="ghost"
            disabled={update.isPending}
            onClick={() => setAvatar("")}
            title={t("identity.clearAvatarHint")}
          >
            {t("identity.clearAvatar")}
          </Button>
        )}
      </div>
    </div>
  )
}
