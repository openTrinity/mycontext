/**
 * 检索档位（只钉钉 / 只飞书 / 混合）的接线。
 *
 * ## 这一组锁的是三条"改了不报错、只是答错"的不变式
 *
 * 1. **默认档位逐字节不变** —— 那是零迁移的全部内容。默认档位换了 HOME 或
 *    开了 `isolateData`，所有存量会话的 `session/resume` 会各失败一次
 *    （降级重建 + 回灌历史），而用户只会看到"它忘了刚才说的话"。
 * 2. **每个档位连自己的 kl** —— 连错端口的表现是查到**另一个渠道**的知识，
 *    不报错。
 * 3. **档位过滤召回源** —— "只搜钉钉"的会话在降级路径上不该出现飞书的消息，
 *    而两条路径的结果在界面上长得一样，用户分辨不出这一轮走的是哪条。
 */
import { describe, expect, it } from "vitest"
import { buildOpencodeSpawn } from "@mycontext/agent-runtime"
import { agentHomeFor } from "../../../apps/desktop/src/main/services/agent-dirs.js"

const BASE = "/tmp/vault-x/agent-home"

describe("★★ agentHomeFor：默认档位必须映射到原目录", () => {
  /**
   * ★★ 这一条是零迁移的全部内容。
   *
   * 改成 `agent-home/search/dingtalk` 的话，所有存量会话的 session 存储
   * （`$XDG_DATA_HOME/opencode/opencode.db`）就换了位置 —— 每个会话各降级
   * 重建一次并回灌历史，而那不是"加档位"这件事该带来的代价。
   */
  it('★★ "dingtalk" → 原目录本身（不加任何后缀）', () => {
    expect(agentHomeFor(BASE, "dingtalk")).toBe(BASE)
  })

  it("其余档位各一个子目录，互不相同", () => {
    expect(agentHomeFor(BASE, "feishu")).toBe(`${BASE}/search/feishu`)
    expect(agentHomeFor(BASE, "all")).toBe(`${BASE}/search/all`)
    expect(agentHomeFor(BASE, "feishu")).not.toBe(agentHomeFor(BASE, "all"))
  })

  /**
   * ★ 数字分身自己一个 —— 与搜索的任何档位都不同。
   *
   * 改动前两者共用 `agentHome`，而实测两个 opencode 共用同一个 XDG 数据目录
   * 时**后起的那个直接起不来**（撞在 `CREATE TABLE workspace` 上）。
   * 现在没炸只是因为两条路径都懒启动、时序上还没撞上。
   */
  it('★ "persona" 与全部搜索档位都不同（否则两个 opencode 抢同一个 opencode.db）', () => {
    const persona = agentHomeFor(BASE, "persona")
    expect(persona).toBe(`${BASE}/persona`)
    for (const scope of ["dingtalk", "feishu", "all"]) {
      expect(persona).not.toBe(agentHomeFor(BASE, scope))
    }
  })
})

/**
 * `isolateData` 的 env 形状。
 *
 * 直接验 `buildOpencodeSpawn` 的产物而不是去调 SearchService：这里要锁的
 * 恰恰是**env 逐字节相同**，而那是 spawn 层的事实。
 */
describe("★★ isolateData：默认关，且关掉时 env 与改动前逐字节相同", () => {
  const spawn = (options: { agentHome: string; isolateData?: boolean }) =>
    buildOpencodeSpawn({
      baseEnv: { HOME: "/Users/tester", PATH: "/usr/bin" },
      ...options,
    }).env

  it("★★ 不给 isolateData → XDG_DATA_HOME 指回**真实** HOME（resume 靠它）", () => {
    const env = spawn({ agentHome: BASE })
    expect(env["HOME"]).toBe(BASE)
    expect(env["XDG_CONFIG_HOME"]).toBe(`${BASE}/.config`)
    // ★ 这一条锁住 resume：session 存储必须留在原处
    expect(env["XDG_DATA_HOME"]).toBe("/Users/tester/.local/share")
    // 另两个压根不该出现（改动前没有它们）
    expect(env["XDG_STATE_HOME"]).toBeUndefined()
    expect(env["XDG_CACHE_HOME"]).toBeUndefined()
  })

  /**
   * ★ 逐 XDG 键比对，而不是整份 env `toEqual`：
   * `OPENCODE_SERVER_PASSWORD` 每次随机（那是刻意的），整份比会恒红。
   */
  it("显式 false 与不给完全一致（默认值不是一个偶然）", () => {
    const withFlag = spawn({ agentHome: BASE, isolateData: false })
    const without = spawn({ agentHome: BASE })
    for (const key of [
      "HOME",
      "XDG_CONFIG_HOME",
      "XDG_DATA_HOME",
      "XDG_STATE_HOME",
      "XDG_CACHE_HOME",
    ]) {
      expect(withFlag[key], key).toBe(without[key])
    }
  })

  it("★ true → 三个 XDG 全指进 agentHome（多进程并存必需）", () => {
    const env = spawn({ agentHome: `${BASE}/search/feishu`, isolateData: true })
    expect(env["XDG_DATA_HOME"]).toBe(`${BASE}/search/feishu/.local/share`)
    expect(env["XDG_STATE_HOME"]).toBe(`${BASE}/search/feishu/.local/state`)
    expect(env["XDG_CACHE_HOME"]).toBe(`${BASE}/search/feishu/.cache`)
  })

  /**
   * ★ 隔离时**不尊重**父进程已设的 XDG 值。
   *
   * 与 `isolateData:false` 那条相反，是刻意的：隔离的意义就是不共享，
   * 父进程设了什么都不该影响它。尊重父进程的话，一个在 shell 里
   * `export XDG_DATA_HOME=...` 过的开发者会看到两个 opencode 又撞回一起。
   */
  it("★ 隔离时覆盖父进程的 XDG_DATA_HOME（不共享才是隔离）", () => {
    const env = buildOpencodeSpawn({
      baseEnv: { HOME: "/Users/tester", XDG_DATA_HOME: "/custom/share" },
      agentHome: `${BASE}/search/all`,
      isolateData: true,
    }).env
    expect(env["XDG_DATA_HOME"]).toBe(`${BASE}/search/all/.local/share`)
  })

  it("不隔离时**尊重**父进程已设的值（那是改动前的行为）", () => {
    const env = buildOpencodeSpawn({
      baseEnv: { HOME: "/Users/tester", XDG_DATA_HOME: "/custom/share" },
      agentHome: BASE,
    }).env
    expect(env["XDG_DATA_HOME"]).toBe("/custom/share")
  })
})

/**
 * ★★ bash 白名单必须放行**前缀赋值**形态。
 *
 * `KL_SERVER_PORT=8201 kl ask ...` 与 `kl` / `kl *` **都匹配不到**
 * （模式是对整条命令串做 glob，而这条以变量赋值开头）。
 *
 * 漏了这一条的表现：混合档位下 agent 每次换端口查询都被拒，于是它退回
 * 只查默认端口那一个图 —— 一个"只搜了一个来源"的静默错答案。
 */
describe("★★ 多图检索的命令形态在白名单内", () => {
  /** 权限走 `OPENCODE_PERMISSION`（不是 CONFIG_CONTENT，那里放模型配置）。 */
  const bashRules = (): Record<string, string> => {
    const env = buildOpencodeSpawn({ baseEnv: {}, allowKlCommand: true }).env
    const permission = JSON.parse(env["OPENCODE_PERMISSION"] ?? "{}") as {
      bash?: Record<string, string>
    }
    return permission.bash ?? {}
  }

  it("★★ `KL_SERVER_PORT=<n> kl ...` 被放行（否则混合档位静默退化成单图）", () => {
    const rules = bashRules()
    expect(rules["KL_SERVER_PORT=* kl *"]).toBe("allow")
    expect(rules["KL_SERVER_PORT=* kl"]).toBe("allow")
  })

  it("裸 kl 仍然放行（原有行为不动）", () => {
    const rules = bashRules()
    expect(rules["kl"]).toBe("allow")
    expect(rules["kl *"]).toBe("allow")
  })

  /**
   * ★ 放行面必须窄到那一个变量名。
   *
   * `*=* kl *` 会让 agent 能设**任意**环境变量（`PATH` / `LD_PRELOAD` /
   * `DYLD_INSERT_LIBRARIES`…），那等于把 deny-all 整个拆掉。
   */
  it("★ 不放行任意变量赋值（那等于拆掉 deny-all）", () => {
    const rules = bashRules()
    expect(rules["*"]).toBe("deny")
    for (const pattern of Object.keys(rules)) {
      if (!pattern.includes("=")) continue
      expect(pattern.startsWith("KL_SERVER_PORT="), `过宽的赋值放行：${pattern}`).toBe(true)
    }
  })
})
