/**
 * agent 子进程（opencode）的三个目录，按 vault 给。
 *
 * ## ★ 为什么抽成一个类型而不是各服务各写三个字段
 *
 * 搜索与数字分身是**两条独立的 agent 路径**，但它们对"目录该怎么分"的
 * 要求完全一样。各写一份的话，改动只落在一边就会出现"搜索的 workspace
 * 按身份分了、数字分身的还在公共目录"—— 而那不报错，只是把
 * transcript 片段写进了别人的目录。
 *
 * 两者都在 attach 时收它（不在构造时），理由见 `MediaDirs`：
 * 构造时锁死的话，切身份后新会话仍落在上一个身份的目录里。
 */
export interface AgentDirs {
  /**
   * workspace 根（每个会话一个子目录：`search/<sid>`、`persona/<cid>`）。
   *
   * ★ 按 vault 分：里面有 `AGENTS.md` 与我们铺进去的 transcript 片段 ——
   * 也就是**聊天内容**，换个身份就不成立。
   */
  workspaceRoot: string
  /**
   * agent 子进程的隔离 HOME（`.config`、`.local/state`）。
   *
   * ★ 不给就会继承宿主 HOME，而 opencode 从 `$HOME/.claude/skills` 发现
   * skill —— 用户自己装的所有 skill 都会进 agent 的视野（实测泄漏 8 个，
   * 其中一个正是专门检测隔离失效的探针）。见 spawn-hardening 的
   * `applyHomeIsolation`。
   *
   * ★ 按 vault 分：opencode 的 session 锁与配置会随会话产生状态。
   * 但**包缓存不在这里**（见下一个字段）。
   */
  home: string
  /**
   * npm 包缓存（**应用级，跨身份共用**）。
   *
   * ★ 与 `home` 分开是一条实测出来的取舍：那里面是 registry 的只读镜像
   * （325 MB，key 全形如 `registry.npmjs.org/...`，逐项验过不含任何
   * 身份/会话字节）。按身份各拷一份 = 两个身份 650 MB、五个 1.6 GB，
   * 而且首次切身份要重新联网拉一遍包。
   *
   * npm 本来就有 `npm_config_cache` 这个正交旋钮 —— 用它把"缓存"从
   * "HOME"里拆出来，隔离与体积两个目标就都成立。
   */
  npmCache: string
}
