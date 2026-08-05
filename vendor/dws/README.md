# dws —— 钉钉渠道依赖的 CLI

本目录**不再存放二进制**。这里只说明「dws 从哪来」。

## 默认：开源版，随 npm 依赖分发

[`dingtalk-workspace-cli`][oss]（Apache-2.0）在 `package.json` 里精确钉版本，
`pnpm install` 之后 `pnpm prepare:bin` 会：

1. 从包内 `assets/dws-<platform>.tar.gz` 取当前平台的归档；
2. **解包前**按包内 `assets/checksums.txt` 校验 sha256（上游发布产物，与 GitHub
   Release 同一份）——校验失败是硬失败，不静默继续；
3. 解到 `.dws-cache/`（gitignore），再拷进 `apps/desktop/resources/bin/` 并
   `chmod 755` + 重签 + **真跑一次 `--version`**。

零配置。解析逻辑在 `scripts/lib/dws-resolver.mjs`，落地在 `scripts/prepare-bin.mjs`。

[oss]: https://github.com/open-dingtalk/dingtalk-workspace-cli

### 为什么走 npm 而不入 git

开源版二进制解开后 **61MB**（比闭源那份的 21MB 大三倍）。入 git 会让仓库随每次
升级线性膨胀，而"低频更新的单文件可接受"这个结论在这个体积与发版节奏下不成立。

走 npm 换来三件事：版本由 **lockfile** 管（升级在 diff 里可见）、pnpm 自动校验
tarball integrity、别人 clone 下来装完依赖就有了。

### ⚠️ 它的 postinstall 被刻意屏蔽

上游 `install.js` 会往**用户家目录**的 16 个 agent 目录（`~/.claude/skills`、
`~/.cursor/skills` …）写 skill，每个都先 `rmSync` 再覆盖，还写 `~/.dws/`。
一次 `pnpm install` 就删改开发者已有的编辑器配置 —— 对一个开源项目不可接受。

所以它**不在** `pnpm-workspace.yaml` 的 `onlyBuiltDependencies` 里（那里有长注释）。
代价是它不自解二进制，而那正合需要：我们自己从 `assets/` 解，与 opencode 同构。

## 内部：闭源版走 `MYCONTEXT_DWS_SOURCE`

闭源版**不随仓库分发**。内部同学自行安装后，把路径给进来即可 —— 它的优先级
**高于** npm 那份（"我明确指了一个"必须盖过默认）：

```bash
# 可以指到可执行文件本身，也可以指到它所在的目录
MYCONTEXT_DWS_SOURCE=~/path/to/dws pnpm prepare:bin
pnpm probe:dws        # 真跑一轮授权 + 身份 + 探针 + 采集，判据是数字
```

想换回开源版：不带这个变量重跑 `pnpm prepare:bin`。

写进 shell 配置（`~/.zshrc`）就不用每次带；`pnpm dev` 会自动跑 `prepare:bin`，
所以设了变量之后日常开发就一直是闭源版。

## 两版的差异（2026-08-04 实测）

闭源 v0.2.99 ↔ 开源 v1.0.56：

| 项 | 结论 |
| --- | --- |
| 白名单里的 29 条命令 | 两版都存在（`tests/unit/channels/cli-confirm.test.ts` 的清单两版都查过） |
| 我们传的全部 flag | 逐条对齐（`--start/--end/--cursor/--limit`、`--open-task-id`、`--nicks/--match-mode`、`--workspace`、`--node`、`--all` …） |
| 响应信封 | 两版同为 `{success, result}`；`result` 可能是对象也可能是数组 |
| `auth status` 字段 | 一致（`corp_id` / `refresh_expires_at` / `user_name` …） |
| 全局 flag | `-f json` / `-y` / `--no-browser` / `--device` 同名同义 |
| 事件目录 | ⚠️ 闭源 3 个 event_key，开源 **16 个**（开源更全） |
| 登录态刷新 | ⚠️ **不一致**，见下 |

### ⚠️ 开源版刷不动闭源版建立的旧登录态

token 的加密密钥在 macOS Keychain（服务名 `dws-cli`）按系统用户存一份，
`DWS_CONFIG_DIR` **隔离不了它** —— 两份二进制看的是同一个 profile。

但**共享 ≠ 可直接复用**：实测开源版刷新闭源版留下的登录态时报
`invalidParameter.authCode.notFound`（上游称「旧版登录态」），要求重新
`dws auth login` 一次；而闭源版对同一个 profile 刷新正常。

对**新用户没有影响** —— onboarding 本来就要走一次授权。只有"从闭源切到开源"的
老 profile 需要重登。副作用：开源版刷新失败时会把 `profiles.json` 的 `status`
标成 `expired`（闭源版此后仍能正常工作，实测采集不受影响）。

### 事件订阅的两种参数表达

开源版 `event list` 里目标参数有两种表达，只认一种会**高估覆盖面**：
群类用 `required_params: ["group"]`，单聊/指定发送人类用
`constraints.require_one_of: [["user","open-dingtalk-id"]]`（`required_params` 为 null）。
`events.ts::audit` 两种都认 —— 否则 5 个必须逐会话订阅的 key 会被误判成全局，
状态页会把「事件通路正常」说成「所有单聊消息都秒级到」。

## DWS_CHANNEL：开源发布**不带**渠道号

渠道号（上游 `channelCode`，走 `x-dws-channel` 头）是**分发方标识**，不能随公开
仓库发出去。所以 `MYCONTEXT_DWS_CHANNEL` 的**缺省值是空**
（`packages/kernel/src/config.ts`），由分发方按需注入。

### 不配会怎样：完全可用

上游三处读它全部是 `if v != ""` 的守卫（`internal/app/runner.go`、
`internal/auth/oauth_helpers.go`），空值只是**不发那个请求头**，不是错误。
「空串」与「未设置」**等价**。

真正决定要不要渠道号的是**服务端对该组织的配置**（`classifyDenialReason`）：
只有 `channelScope == "specified"` 时空渠道号才被判 `channel_required`；
默认的 `all` 完全无所谓。

实测某组织（`channelScope=all`）在 `env -u DWS_CHANNEL` 下 11 条读命令全部成功，
数据量与设了渠道号时**逐项相同**。

★ 因此校验**不能**用 `min(1)`：那会让「没配渠道号」变成启动即 `CONFIG_INVALID`，
开源发布直接起不来。`tests/unit/config.test.ts` 有断言锁住。

### 被限定渠道的组织：终态错误，不是静默失效

`CHANNEL_REQUIRED` / `channel_not_allowed` / 「未获得该组织授权」已归类成
**`CHANNEL_NOT_ALLOWED`（终态、不可重试）**，UI 上有明确文案。

这条归类必须排在 `PERMISSION_REQUIRED` **之前**判 —— 上游原文含 `未授权` 子串，
归错会把用户引到宿主 UI 去点确认，而那里点一万次也没用。

## 升级开源版

改 `package.json` 里 `dingtalk-workspace-cli` 的版本 → `pnpm install` →
`pnpm prepare:bin` → **`pnpm probe:dws` 必须四段都有数字**。

★ 最后那一步不能省：命令与 flag 对得上**不足以**说明能用。响应信封或业务键
变了的表现是「解析出 0 条」而不是报错（仓库里真发生过：277 页原始响应、
1678 条消息、落库 0 条）。判据必须是**数字**。

## 关于 `workspace/`（已移除）

上游随包提供一份给 **AI agent 读的 dws 操作说明书**（`SKILL.md` +
`references/` + 脚本）。此前 3MB / 181 个文件跟着闭源二进制一起入 git，
现已移除，理由是**本仓库没有任何代码读它**：
electron-builder 显式 `!workspace/**` 排除、也没有一行 TS/JS 引用它。

需要参考时：开源版在 npm 包的 `assets/dws-skills.zip` 里（`mono/` 与 `multi/`
两种布局），闭源版在内部同学自己的安装目录里。

## 许可

开源版 Apache-2.0，版权归其发布方。闭源版不随本仓库分发。
